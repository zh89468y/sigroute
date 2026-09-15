"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalGraphPanel = void 0;
const vscode = __importStar(require("vscode"));
const layout_1 = require("../core/layout");
const graphHtml_1 = require("./graphHtml");
/**
 * 信号框图面板。
 *
 * 复用同一个面板：连续追踪多个信号时只更新内容，不反复弹新窗口。
 * 布局在扩展侧计算（core/layout.ts），前端只负责绘制与交互。
 */
class SignalGraphPanel {
    constructor(panel, graph, direction, hops, handlers) {
        this.disposables = [];
        this.handlers = {};
        this.ready = false;
        this.panel = panel;
        this.graph = graph;
        this.direction = direction;
        this.hops = hops;
        this.handlers = handlers;
        this.panel.title = `SigRoute 框图：${graph.signalName}`;
        this.panel.webview.html = (0, graphHtml_1.renderGraphHtml)(this.panel.webview, makeNonce());
        this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg), undefined, this.disposables);
        this.panel.onDidDispose(() => {
            SignalGraphPanel.current = undefined;
            while (this.disposables.length > 0)
                this.disposables.pop()?.dispose();
        }, undefined, this.disposables);
    }
    /** 打开或更新框图面板 */
    static show(extensionUri, graph, direction, hops, handlers = {}) {
        const existing = SignalGraphPanel.current;
        if (existing) {
            existing.update(graph, handlers);
            existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
            return;
        }
        const panel = vscode.window.createWebviewPanel('sigrouteGraph', `SigRoute 框图：${graph.signalName}`, vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
        });
        SignalGraphPanel.current = new SignalGraphPanel(panel, graph, direction, hops, handlers);
    }
    /** 当前面板是否已打开 */
    static isOpen() {
        return SignalGraphPanel.current !== undefined;
    }
    /**
     * 换一根信号：只替换图数据，保留用户在面板里选好的方向/跳数
     * （否则每追踪一次都要重新调一遍）。
     */
    update(graph, handlers) {
        this.graph = graph;
        this.handlers = handlers;
        this.panel.title = `SigRoute 框图：${graph.signalName}`;
        if (this.ready)
            this.render();
    }
    render() {
        // 先在全图上分层（拿到每个节点距起点的跳数），再按跳数裁剪，
        // 最后对裁剪后的子图重新布局 —— 两次布局的图都很小，开销可忽略。
        // 合并同向并列连接 -> 按信号传播层数裁剪 -> 布局
        const merged = (0, layout_1.mergeParallelEdges)(this.graph);
        const shown = (0, layout_1.filterGraphByHops)(merged, this.hops <= 0 ? Infinity : this.hops);
        const layout = (0, layout_1.layoutSignalGraph)(shown, { direction: this.direction });
        // 层次框跟着"当前显示的子图"算：跳数一变，兄弟关系也可能变
        const frames = (0, layout_1.computeHierarchyFrames)(shown, layout);
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
    async onMessage(msg) {
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
                if (!n)
                    return;
                if (!n.file) {
                    void vscode.window.showInformationMessage(`模块 ${n.moduleName} 不在索引范围内，无法跳转（属于 IP / 黑盒）。`);
                    return;
                }
                await vscode.commands.executeCommand('sigroute.reveal', n.file, n.line ?? 0, undefined, n.moduleName);
                break;
            }
            case 'openEdge': {
                const e = this.graph.edges.find((x) => x.id === msg.id);
                if (e?.file) {
                    await vscode.commands.executeCommand('sigroute.reveal', e.file, e.line ?? 0, e.offset, e.toNet || e.fromNet);
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
                if (net)
                    this.handlers.traceNet?.(net, String(msg.module ?? ''));
                break;
            }
            case 'exportSvg':
                await this.saveSvg(String(msg.svg ?? ''), String(msg.name ?? 'signal'));
                break;
            default:
                break;
        }
    }
    async saveSvg(svg, name) {
        const uri = await vscode.window.showSaveDialog({
            title: '导出信号框图',
            defaultUri: vscode.Uri.file(`${name}_blockdiagram.svg`),
            filters: { SVG: ['svg'] },
        });
        if (!uri)
            return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(svg, 'utf8'));
        void vscode.window.showInformationMessage(`已导出框图：${uri.fsPath}（可直接插入文档或用浏览器打开）`);
    }
}
exports.SignalGraphPanel = SignalGraphPanel;
function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++)
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
//# sourceMappingURL=graphPanel.js.map