"use strict";
/**
 * 脑图视图（资源管理器里的 Webview View）
 *
 * 与树视图并列的第二种读法：树视图逐条点开看细节，脑图一眼看形状。
 * 画法见 mindmapHtml.ts —— 竖向缩进（侧栏宽度有限，辐射式在这里不可用）。
 *
 * 注意：**脑图不走过滤**。过滤是树视图的局部功能，脑图永远展示完整链路，
 * 这样"脑图里点了过滤、切回树发现内容变少"的困惑不会发生。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MindmapViewProvider = void 0;
const mindmapHtml_1 = require("./mindmapHtml");
/** 节点预算：脑图超过这个规模就不好读了 */
const MAX_NODES = 900;
class MindmapViewProvider {
    constructor(tree, handlers) {
        this.disposables = [];
        this.tree = tree;
        this.handlers = handlers;
    }
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = (0, mindmapHtml_1.renderMindmapHtml)(view.webview, makeNonce());
        this.disposables.push(view.webview.onDidReceiveMessage((msg) => this.onMessage(msg)), view.onDidChangeVisibility(() => {
            if (view.visible)
                this.refresh();
        }), 
        // 视图被 when 子句隐藏时会被销毁，之后不能再往里 postMessage
        view.onDidDispose(() => {
            if (this.view === view)
                this.view = undefined;
        }));
        // 视图刚解析出来时可能还没有结果，先推一次空状态
        this.refresh();
    }
    /** 结果变化时调用（视图不在时静默忽略） */
    refresh() {
        const view = this.view;
        if (!view)
            return;
        try {
            void view.webview.postMessage(this.buildMessage())?.then(undefined, () => undefined);
        }
        catch {
            // 视图已销毁：等下次 resolveWebviewView
        }
    }
    onMessage(msg) {
        const m = msg;
        switch (m?.type) {
            case 'ready':
                this.refresh();
                break;
            case 'reveal':
                this.handlers.reveal(String(m.file ?? ''), Number(m.line ?? 0), typeof m.offset === 'number' ? m.offset : undefined, String(m.label ?? ''));
                break;
            case 'expand':
                this.handlers.expand(String(m.key ?? ''));
                break;
            case 'exportSvg':
                this.handlers.exportSvg(String(m.svg ?? ''), String(m.name ?? 'signal'));
                break;
            default:
                break;
        }
    }
    buildMessage() {
        const result = this.tree.current;
        if (!result) {
            return {
                type: 'render',
                payload: {
                    signalName: '',
                    stats: '还没有追踪结果',
                    mind: {
                        root: {
                            label: '把光标放在信号名上，按 Ctrl+T（或 Alt+Q）开始追踪',
                            kind: 'note',
                            flags: [],
                            renamed: false,
                            blackbox: false,
                            more: false,
                            isStart: true,
                            children: [],
                        },
                    },
                },
            };
        }
        const budget = { n: MAX_NODES };
        const rootMind = this.toMind(result.root, result.root, budget, false);
        const s = result.stats;
        const statsText = `${result.modules.length} 模块 · ${s.nodes} 节点` +
            (s.renames > 0 ? ` · 改名 ${s.renames}` : '') +
            (s.uncertainties > 0 ? ` · 不确定 ${s.uncertainties}` : '');
        return {
            type: 'render',
            payload: {
                signalName: result.start.netName,
                stats: statsText,
                mind: { root: rootMind },
            },
        };
    }
    toMind(node, root, budget, upstream) {
        const children = [];
        // 摘要节点不进脑图（工具栏已经在显示同样的事实）
        const source = node.children.filter((c) => !c.flags.includes('summary'));
        const childUpstream = node.branch === 'up' ? true : node.branch === 'down' ? false : upstream;
        for (const c of source) {
            if (budget.n <= 0)
                break;
            budget.n--;
            children.push(this.toMind(c, root, budget, childUpstream));
        }
        const moduleName = node.description ? node.description.split(' · ')[0] : undefined;
        return {
            label: node.label,
            sub: moduleName,
            kind: node.kind,
            edgeText: node.edgeText,
            description: node.description,
            tooltip: node.tooltip,
            flags: node.flags,
            file: node.file,
            line: node.line,
            offset: node.offset,
            renamed: node.flags.includes('renamed'),
            blackbox: node.kind === 'blackbox',
            more: !!node.expandKey,
            isStart: node === root,
            upstream,
            expandKey: node.expandKey,
            pendingCount: node.pendingCount,
            aliases: node.aliases,
            children,
        };
    }
    dispose() {
        while (this.disposables.length > 0)
            this.disposables.pop()?.dispose();
    }
}
exports.MindmapViewProvider = MindmapViewProvider;
MindmapViewProvider.viewType = 'sigrouteMindmap';
function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++)
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
//# sourceMappingURL=mindmapView.js.map