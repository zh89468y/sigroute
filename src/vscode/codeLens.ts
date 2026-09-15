/**
 * 模块头 CodeLens
 *
 * 用途：不选中任何信号也能进入分析 —— 每个 `module` 头上显示它的规模与两个入口：
 *   `12 端口 · 8 例化 · 被例化 3 次` → 追踪某个端口
 *   `模块信息`                      → 端口表 + 例化清单
 *
 * 刻意做得很轻：只读当前文档在索引里的模块记录，不做任何解析。
 */

import * as vscode from 'vscode';
import type { ProviderContext } from './providers';

export class SigCodeLensProvider implements vscode.CodeLensProvider {
  private readonly ctx: ProviderContext;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(ctx: ProviderContext) {
    this.ctx = ctx;
  }

  /** 配置变更后刷新 */
  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('sigroute').get<boolean>('codeLens', true)) return [];
    if (!this.ctx.indexer.isBuilt) {
      void this.ctx.ensureIndex().then(() => this._onDidChange.fire(), () => undefined);
      return [];
    }

    const names = this.ctx.indexer.current.fileModules.get(doc.uri.fsPath.replace(/\\/g, '/'));
    if (!names || names.length === 0) return [];

    const out: vscode.CodeLens[] = [];
    for (const name of names) {
      for (const mod of this.ctx.indexer.getModules(name)) {
        if (mod.file !== doc.uri.fsPath.replace(/\\/g, '/')) continue;
        const sites = this.ctx.indexer.getInstantiations(name).length;
        const range = new vscode.Range(mod.headerLine, 0, mod.headerLine, 0);
        const declared = this.ctx.indexer.isDeclOnly(name) ? '（仅声明，用于补齐黑盒方向）' : '';
        out.push(
          new vscode.CodeLens(range, {
            title: `${mod.ports.length} 端口 · ${mod.instances.length} 例化 · 被例化 ${sites} 次${declared}`,
            command: 'sigroute.tracePort',
            arguments: [name],
            tooltip: '选择一个端口开始追踪（上游 / 下游 / 框图）',
          }),
        );
        out.push(
          new vscode.CodeLens(range, {
            title: '模块信息',
            command: 'sigroute.showModuleInfoFor',
            arguments: [name],
            tooltip: '端口表、例化清单、解析告警',
          }),
        );
      }
    }
    return out;
  }
}
