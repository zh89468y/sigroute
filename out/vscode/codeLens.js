"use strict";
/**
 * 模块头 CodeLens
 *
 * 用途：不选中任何信号也能进入分析 —— 每个 `module` 头上显示它的规模与两个入口：
 *   `12 端口 · 8 例化 · 被例化 3 次` → 追踪某个端口
 *   `模块信息`                      → 端口表 + 例化清单
 *
 * 刻意做得很轻：只读当前文档在索引里的模块记录，不做任何解析。
 */
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
exports.SigCodeLensProvider = void 0;
const vscode = __importStar(require("vscode"));
class SigCodeLensProvider {
    constructor(ctx) {
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChange.event;
        this.ctx = ctx;
    }
    /** 配置变更后刷新 */
    refresh() {
        this._onDidChange.fire();
    }
    provideCodeLenses(doc) {
        if (!vscode.workspace.getConfiguration('sigroute').get('codeLens', true))
            return [];
        if (!this.ctx.indexer.isBuilt) {
            void this.ctx.ensureIndex().then(() => this._onDidChange.fire(), () => undefined);
            return [];
        }
        const names = this.ctx.indexer.current.fileModules.get(doc.uri.fsPath.replace(/\\/g, '/'));
        if (!names || names.length === 0)
            return [];
        const out = [];
        for (const name of names) {
            for (const mod of this.ctx.indexer.getModules(name)) {
                if (mod.file !== doc.uri.fsPath.replace(/\\/g, '/'))
                    continue;
                const sites = this.ctx.indexer.getInstantiations(name).length;
                const range = new vscode.Range(mod.headerLine, 0, mod.headerLine, 0);
                const declared = this.ctx.indexer.isDeclOnly(name) ? '（仅声明，用于补齐黑盒方向）' : '';
                out.push(new vscode.CodeLens(range, {
                    title: `${mod.ports.length} 端口 · ${mod.instances.length} 例化 · 被例化 ${sites} 次${declared}`,
                    command: 'sigroute.tracePort',
                    arguments: [name],
                    tooltip: '选择一个端口开始追踪（上游 / 下游 / 框图）',
                }));
                out.push(new vscode.CodeLens(range, {
                    title: '模块信息',
                    command: 'sigroute.showModuleInfoFor',
                    arguments: [name],
                    tooltip: '端口表、例化清单、解析告警',
                }));
            }
        }
        return out;
    }
}
exports.SigCodeLensProvider = SigCodeLensProvider;
//# sourceMappingURL=codeLens.js.map