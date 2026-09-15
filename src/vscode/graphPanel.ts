import * as vscode from 'vscode';
import type { SignalGraph } from '../core/graph';
import {
  computeHierarchyFrames,
  filterGraphByHops,
  layoutSignalGraph,
  mergeParallelEdges,
} from '../core/layout';
import { renderGraphHtml } from './graphHtml';

export type LayoutDirection = 'LR' | 'TD';

/** 面板 → 扩展层 的回调（双击定位树视图 / 从信号清单换一根信号继续看） */
export interface GraphPanelHandlers {
  revealTree?: (kind: 'node' | 'edge', id: string) => void;
  traceNet?: (net: string, moduleName: string) => void;
}

/**
 * 信号框图面板。
 *
 * 复用同一个面板：连续追踪多个信号时只更新内容，不反复弹新窗口。
 * 布局在扩展侧计算（core/layout.ts），前端只负责绘制与交互。
 */
export class SignalGraphPanel {
  private static current: SignalGraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private graph: SignalGraph;
  private direction: LayoutDirection;
  /**
   * 显示跳数：0 表示不裁剪（全部）。
   * 注意这是**面板内**的状态：用户在面板里调过之后，换一根信号继续看时保持不变 ——
   * 反复被重置回默认值会让人每次都要重新点一遍。
   */
  private hops: number;
  private handlers: GraphPanelHandlers = {};
  private ready = false;

  private constructor(
    panel: vscode.WebviewPanel,
    graph: SignalGraph,
    direction: LayoutDirection,
    hops: number,
    handlers: GraphPanelHandlers,
  ) {
    this.panel = panel;
    this.graph = graph;
    this.direction = direction;
    this.hops = hops;
    this.handlers = handlers;
    this.panel.title = `SigRoute 框图：${graph.signalName}`;
    this.panel.webview.html = renderGraphHtml(this.panel.webview, makeNonce());

    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(
      () => {
        SignalGraphPanel.current = undefined;
        while (this.disposables.length > 0) this.disposables.pop()?.dispose();
      },
      undefined,
      this.disposables,
    );
  }

  /** 打开或更新框图面板 */
  static show(
    extensionUri: vscode.Uri,
    graph: SignalGraph,
    direction: LayoutDirection,
    hops: number,
    handlers: GraphPanelHandlers = {},
  ): void {
    const existing = SignalGraphPanel.current;
    if (existing) {
      existing.update(graph, handlers);
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'sigrouteGraph',
      `SigRoute 框图：${graph.signalName}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    SignalGraphPanel.current = new SignalGraphPanel(panel, graph, direction, hops, handlers);
  }

  /** 当前面板是否已打开 */
  static isOpen(): boolean {
    return SignalGraphPanel.current !== undefined;
  }

  /**
   * 换一根信号：只替换图数据，保留用户在面板里选好的方向/跳数
   * （否则每追踪一次都要重新调一遍）。
   */
  private update(graph: SignalGraph, handlers: GraphPanelHandlers): void {
    this.graph = graph;
    this.handlers = handlers;
    this.panel.title = `SigRoute 框图：${graph.signalName}`;
    if (this.ready) this.render();
  }

  private render(): void {
    // 先在全图上分层（拿到每个节点距起点的跳数），再按跳数裁剪，
    // 最后对裁剪后的子图重新布局 —— 两次布局的图都很小，开销可忽略。
    // 合并同向并列连接 -> 按信号传播层数裁剪 -> 布局
    const merged = mergeParallelEdges(this.graph);
    const shown = filterGraphByHops(merged, this.hops <= 0 ? Infinity : this.hops);
    const layout = layoutSignalGraph(shown, { direction: this.direction });
    // 层次框跟着"当前显示的子图"算：跳数一变，兄弟关系也可能变
    const frames = computeHierarchyFrames(shown, layout);

    void this.panel.webview.postMessage({
      type: 'render',
      payload: {
        layout,
        graph: shown,
        frames,
        direction: this.direction,
        hops: this.hops,
        /** 未裁剪、未合并的原始规模，用于提示"还有多少被收起来了" */
        totalNodes: this.graph.nodes.length,
        totalEdges: this.graph.edges.length,
      },
    });
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.ready = true;
        this.render();
        break;

      case 'relayout':
        if (msg.direction === 'LR' || msg.direction === 'TD') {
          this.direction = msg.direction;
          this.render();
        }
        break;

      case 'hops': {
        const v = Number(msg.value);
        if (Number.isFinite(v) && v >= 0) {
          this.hops = v;
          this.render();
        }
        break;
      }

      case 'openNode': {
        const n = this.graph.nodes.find((x) => x.id === msg.id);
        if (!n) return;
        if (!n.file) {
          void vscode.window.showInformationMessage(
            `模块 ${n.moduleName} 不在索引范围内，无法跳转（属于 IP / 黑盒）。`,
          );
          return;
        }
        await vscode.commands.executeCommand(
          'sigroute.reveal',
          n.file,
          n.line ?? 0,
          undefined,
          n.moduleName,
        );
        break;
      }

      case 'openEdge': {
        const e = this.graph.edges.find((x) => x.id === msg.id);
        if (e?.file) {
          await vscode.commands.executeCommand(
            'sigroute.reveal',
            e.file,
            e.line ?? 0,
            e.offset,
            e.toNet || e.fromNet,
          );
        }
        break;
      }

      case 'revealTree': {
        const kind = msg.kind === 'edge' ? 'edge' : 'node';
        this.handlers.revealTree?.(kind, String(msg.id ?? ''));
        break;
      }

      case 'traceNet': {
        const net = String(msg.net ?? '');
        if (net) this.handlers.traceNet?.(net, String(msg.module ?? ''));
        break;
      }

      case 'exportSvg':
        await this.saveSvg(String(msg.svg ?? ''), String(msg.name ?? 'signal'));
        break;

      default:
        break;
    }
  }

  private async saveSvg(svg: string, name: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      title: '导出信号框图',
      defaultUri: vscode.Uri.file(`${name}_blockdiagram.svg`),
      filters: { SVG: ['svg'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(svg, 'utf8'));
    void vscode.window.showInformationMessage(
      `已导出框图：${uri.fsPath}（可直接插入文档或用浏览器打开）`,
    );
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
