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
exports.TraceTreeProvider = exports.FILTER_LABEL = void 0;
const vscode = __importStar(require("vscode"));
const FLAG_LABEL = {
    renamed: '改名',
    bitselect: '位选',
    partial: '不完整',
    loop: '已展开',
    limit: '截断',
    constant: '常量',
    unconnected: '悬空',
    generate: 'generate',
    always: '过程块',
    intra: '模块内',
    budget: '超预算',
    cross: '跨模块',
    more: '可展开',
    ambiguous: '多路径',
};
exports.FILTER_LABEL = {
    all: '全部',
    cross: '只看跨模块',
    renamed: '只看改名',
};
class TraceTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.filter = 'all';
        /** 过滤结果的记忆表：结果或过滤模式变化时整体失效 */
        this.visibleCache = new WeakMap();
        /** 可见父节点（过滤会提升层级，getParent 必须走这张表） */
        this.visibleParents = new Map();
        /** 用户点过"继续展开"的节点键 → 次数 */
        this.expandedKeys = new Map();
    }
    get current() {
        return this.result;
    }
    get currentFilter() {
        return this.filter;
    }
    get currentNode() {
        return this.root;
    }
    setExpandHandler(fn) {
        this.expandHandler = fn;
    }
    /** 传给 traceSignal 的展开状态 */
    expandState() {
        return Object.fromEntries(this.expandedKeys);
    }
    /** 触发继续展开：次数 +1，然后请扩展层重新追踪 */
    expand(key) {
        this.expandedKeys.set(key, (this.expandedKeys.get(key) ?? 0) + 1);
        this.expandHandler?.(key);
    }
    /** 换了一根信号时清空展开状态（上一根信号的键没有意义） */
    resetExpansion() {
        this.expandedKeys.clear();
    }
    setResult(result) {
        this.result = result;
        this.root = result?.root;
        this.visibleCache = new WeakMap();
        this.visibleParents = new Map();
        this._onDidChangeTreeData.fire();
    }
    setFilter(filter) {
        if (this.filter === filter)
            return;
        this.filter = filter;
        this.visibleCache = new WeakMap();
        this.visibleParents = new Map();
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        const hasChildren = this.visible(element).length > 0;
        const isRoot = element === this.root;
        const expanded = element.kind === 'group' || element.flags.includes('summary') || isRoot ||
            (hasChildren && element.children.length === 1);
        const item = new vscode.TreeItem(element.label, hasChildren
            ? expanded
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        const badges = element.flags
            .filter((f) => f !== 'partial' || element.kind !== 'blackbox')
            // 'cross' 是过滤用的内部标记，不作为徽标展示（否则每行都是"跨模块"）
            .filter((f) => f !== 'cross' || element.flags.includes('renamed'))
            .map((f) => FLAG_LABEL[f] ?? f);
        const badgeText = badges.length > 0 ? `[${badges.join('·')}] ` : '';
        item.description = `${badgeText}${element.description ?? ''}`;
        item.iconPath = iconFor(element);
        item.tooltip = buildTooltip(element);
        if (element.expandKey) {
            item.contextValue = 'expandable';
            item.command = {
                command: 'sigroute.expandChildren',
                title: '继续展开',
                arguments: [element.expandKey],
            };
        }
        else {
            item.contextValue = element.flags.includes('renamed') ? 'renamedNode' : 'node';
            if (element.file !== undefined && element.line !== undefined) {
                item.command = {
                    command: 'sigroute.reveal',
                    title: '跳转到源代码',
                    // 带上 label：没有精确偏移时用它在该行内定位并选中标识符
                    arguments: [element.file, element.line, element.offset, element.label],
                };
            }
        }
        return item;
    }
    getChildren(element) {
        if (!element) {
            if (!this.root)
                return [];
            // 根节点本身也要过一遍过滤（比如"只看改名"而整棵树没有改名点）
            return [this.root];
        }
        return this.visible(element);
    }
    /**
     * 可见父节点。
     *
     * 过滤时会把"不符合条件但又夹在中间"的节点摘掉，让符合条件的后代**提升**到上一层 ——
     * 例如"只看改名"时，模块内部的中间变量会被跳过，直接看到下一个改名点。
     * 提升会让可见层级与真实层级不同，所以必须自己维护一份可见父节点表，
     * 否则 VSCode 的 `reveal()`（靠 getParent 往上走）会定位失败。
     */
    getParent(element) {
        return this.visibleParents.get(element) ?? findParent(this.root, element);
    }
    /** 当前过滤模式下可见的子节点（带记忆，避免每次展开都重算子树） */
    visible(node) {
        if (node.children.length === 0)
            return [];
        if (this.filter === 'all') {
            for (const c of node.children)
                this.visibleParents.set(c, node);
            return node.children;
        }
        const cached = this.visibleCache.get(node);
        if (cached)
            return cached;
        const kept = [];
        this.collect(node, node.children, kept);
        const out = kept.length === 0
            ? [
                {
                    kind: 'note',
                    label: `（当前为「${exports.FILTER_LABEL[this.filter]}」，此处没有符合条件的分支）`,
                    flags: [],
                    children: [],
                },
            ]
            : kept;
        this.visibleCache.set(node, out);
        return out;
    }
    /**
     * 递归收集符合条件的节点：不符合条件的节点本身不显示，
     * 但会继续往下找，把符合条件的后代挂到同一个可见父节点下。
     */
    collect(parent, list, out) {
        for (const c of list) {
            if (this.matches(c)) {
                this.visibleParents.set(c, parent);
                out.push(c);
            }
            else {
                this.collect(parent, c.children, out);
            }
        }
    }
    /** 节点本身是否符合当前过滤条件 */
    matches(node) {
        if (this.filter === 'all')
            return true;
        if (node.flags.includes('more'))
            return true; // "继续展开"入口永远保留
        if (this.filter === 'cross') {
            if (node.flags.includes('cross'))
                return true;
            if (node.kind === 'group' || node.kind === 'note')
                return true;
            return (node.kind === 'terminal' ||
                node.kind === 'constant' ||
                node.kind === 'unconnected' ||
                node.kind === 'blackbox');
        }
        // renamed
        if (node.flags.includes('renamed'))
            return true;
        return node.kind === 'group' || node.kind === 'note';
    }
    // ---------------------------------------------------------------- 与框图联动
    /** 框图里点了某个模块方块 → 找到树里对应的节点 */
    findByGraphNode(moduleName) {
        return this.find((n) => n.graphNodeKey === moduleName);
    }
    /** 框图里点了某条连线 → 找到树里对应的节点 */
    findByGraphEdge(edgeId) {
        return this.find((n) => n.graphEdgeId === edgeId);
    }
    find(pred) {
        if (!this.root)
            return undefined;
        let hit;
        const walk = (n) => {
            if (hit)
                return;
            if (n !== this.root && pred(n)) {
                hit = n;
                return;
            }
            for (const c of n.children)
                walk(c);
        };
        walk(this.root);
        return hit;
    }
}
exports.TraceTreeProvider = TraceTreeProvider;
function findParent(node, target) {
    if (!node)
        return undefined;
    for (const c of node.children) {
        if (c === target)
            return node;
        const found = findParent(c, target);
        if (found)
            return found;
    }
    return undefined;
}
function iconFor(node) {
    if (node.flags.includes('summary')) {
        return new vscode.ThemeIcon('list-flat', new vscode.ThemeColor('charts.blue'));
    }
    if (node.flags.includes('more')) {
        return new vscode.ThemeIcon('ellipsis', new vscode.ThemeColor('charts.orange'));
    }
    if (node.flags.includes('loop') || node.flags.includes('limit')) {
        return new vscode.ThemeIcon('ellipsis', new vscode.ThemeColor('descriptionForeground'));
    }
    if (node.flags.includes('partial') && node.kind !== 'blackbox') {
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    }
    switch (node.kind) {
        case 'group':
            return new vscode.ThemeIcon('list-tree');
        case 'signal':
            if (node.flags.includes('renamed')) {
                return new vscode.ThemeIcon('symbol-parameter', new vscode.ThemeColor('charts.orange'));
            }
            if (node.flags.includes('bitselect')) {
                return new vscode.ThemeIcon('symbol-ruler', new vscode.ThemeColor('charts.blue'));
            }
            return new vscode.ThemeIcon('symbol-variable', new vscode.ThemeColor('charts.blue'));
        case 'always':
            return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.purple'));
        case 'constant':
            return new vscode.ThemeIcon('symbol-constant', new vscode.ThemeColor('descriptionForeground'));
        case 'unconnected':
            return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('errorForeground'));
        case 'blackbox':
            return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.yellow'));
        case 'terminal':
            return new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.green'));
        case 'note':
        default:
            return new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'));
    }
}
function buildTooltip(node) {
    const md = new vscode.MarkdownString();
    md.supportHtml = false;
    md.appendMarkdown(`**${escapeMd(node.label)}**\n\n`);
    if (node.edgeText)
        md.appendMarkdown(`关系：${escapeMd(node.edgeText)}\n\n`);
    if (node.description)
        md.appendMarkdown(`位置：\`${escapeMd(node.description)}\`\n\n`);
    if (node.tooltip)
        md.appendMarkdown(`${escapeMd(node.tooltip)}\n\n`);
    if (node.aliases && node.aliases.length > 0) {
        md.appendMarkdown(`同网络别名：\`${node.aliases.map(escapeMd).join('`, `')}\`\n\n`);
    }
    if (node.pendingCount !== undefined) {
        md.appendMarkdown(`还有 ${node.pendingCount} 个分支未展开，点击本行继续\n\n`);
    }
    if (node.flags.length > 0) {
        const labels = node.flags.map((f) => FLAG_LABEL[f] ?? f).join('、');
        md.appendMarkdown(`标记：${labels}\n`);
    }
    if (node.file) {
        md.appendMarkdown(`\n[打开源文件](${vscode.Uri.file(node.file).toString()})`);
    }
    return md;
}
function escapeMd(s) {
    return s.replace(/[\\`*_{}[\]()#+\-.!]/g, (m) => `\\${m}`);
}
//# sourceMappingURL=traceTree.js.map