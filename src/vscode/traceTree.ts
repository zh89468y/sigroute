import * as vscode from 'vscode';
import type { TraceNode, TraceResult } from '../core/graph';

const FLAG_LABEL: Record<string, string> = {
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

/**
 * 树视图过滤模式。
 *
 * 为什么需要：一根信号往下走时会带出大量"模块内部的中间变量"（intra 节点），
 * 真正的跨模块跳转被淹没在几十上百行里。
 *   cross   —— 只看跨模块跳跃 + 终点（最快抓住"穿越了谁"）
 *   renamed —— 只看改名点（排查"名字从哪变成现在的样子"）
 */
export type TraceFilter = 'all' | 'cross' | 'renamed';

export const FILTER_LABEL: Record<TraceFilter, string> = {
  all: '全部',
  cross: '只看跨模块',
  renamed: '只看改名',
};

export class TraceTreeProvider implements vscode.TreeDataProvider<TraceNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TraceNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private root: TraceNode | undefined;
  private result: TraceResult | undefined;
  private filter: TraceFilter = 'all';
  /** 过滤结果的记忆表：结果或过滤模式变化时整体失效 */
  private visibleCache = new WeakMap<TraceNode, TraceNode[]>();
  /** 可见父节点（过滤会提升层级，getParent 必须走这张表） */
  private visibleParents = new Map<TraceNode, TraceNode>();
  /** 用户点过"继续展开"的节点键 → 次数 */
  private readonly expandedKeys = new Map<string, number>();
  /** 点击"继续展开"时的回调（由扩展层重新跑一次追踪） */
  private expandHandler: ((key: string) => void) | undefined;

  get current(): TraceResult | undefined {
    return this.result;
  }

  get currentFilter(): TraceFilter {
    return this.filter;
  }

  get currentNode(): TraceNode | undefined {
    return this.root;
  }

  setExpandHandler(fn: ((key: string) => void) | undefined): void {
    this.expandHandler = fn;
  }

  /** 传给 traceSignal 的展开状态 */
  expandState(): Record<string, number> {
    return Object.fromEntries(this.expandedKeys);
  }

  /** 触发继续展开：次数 +1，然后请扩展层重新追踪 */
  expand(key: string): void {
    this.expandedKeys.set(key, (this.expandedKeys.get(key) ?? 0) + 1);
    this.expandHandler?.(key);
  }

  /** 换了一根信号时清空展开状态（上一根信号的键没有意义） */
  resetExpansion(): void {
    this.expandedKeys.clear();
  }

  setResult(result: TraceResult | undefined): void {
    this.result = result;
    this.root = result?.root;
    this.visibleCache = new WeakMap();
    this.visibleParents = new Map();
    this._onDidChangeTreeData.fire();
  }

  setFilter(filter: TraceFilter): void {
    if (this.filter === filter) return;
    this.filter = filter;
    this.visibleCache = new WeakMap();
    this.visibleParents = new Map();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TraceNode): vscode.TreeItem {
    const hasChildren = this.visible(element).length > 0;
    const isRoot = element === this.root;
    const expanded =
      element.kind === 'group' || element.flags.includes('summary') || isRoot ||
      (hasChildren && element.children.length === 1);

    const item = new vscode.TreeItem(
      element.label,
      hasChildren
        ? expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

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
    } else {
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

  getChildren(element?: TraceNode): TraceNode[] {
    if (!element) {
      if (!this.root) return [];
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
  getParent(element: TraceNode): TraceNode | undefined {
    return this.visibleParents.get(element) ?? findParent(this.root, element);
  }

  /** 当前过滤模式下可见的子节点（带记忆，避免每次展开都重算子树） */
  visible(node: TraceNode): TraceNode[] {
    if (node.children.length === 0) return [];
    if (this.filter === 'all') {
      for (const c of node.children) this.visibleParents.set(c, node);
      return node.children;
    }
    const cached = this.visibleCache.get(node);
    if (cached) return cached;

    const kept: TraceNode[] = [];
    this.collect(node, node.children, kept);

    const out =
      kept.length === 0
        ? [
            {
              kind: 'note' as const,
              label: `（当前为「${FILTER_LABEL[this.filter]}」，此处没有符合条件的分支）`,
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
  private collect(parent: TraceNode, list: TraceNode[], out: TraceNode[]): void {
    for (const c of list) {
      if (this.matches(c)) {
        this.visibleParents.set(c, parent);
        out.push(c);
      } else {
        this.collect(parent, c.children, out);
      }
    }
  }

  /** 节点本身是否符合当前过滤条件 */
  private matches(node: TraceNode): boolean {
    if (this.filter === 'all') return true;
    if (node.flags.includes('more')) return true; // "继续展开"入口永远保留
    if (this.filter === 'cross') {
      if (node.flags.includes('cross')) return true;
      if (node.kind === 'group' || node.kind === 'note') return true;
      return (
        node.kind === 'terminal' ||
        node.kind === 'constant' ||
        node.kind === 'unconnected' ||
        node.kind === 'blackbox'
      );
    }
    // renamed
    if (node.flags.includes('renamed')) return true;
    return node.kind === 'group' || node.kind === 'note';
  }

  // ---------------------------------------------------------------- 与框图联动

  /** 框图里点了某个模块方块 → 找到树里对应的节点 */
  findByGraphNode(moduleName: string): TraceNode | undefined {
    return this.find((n) => n.graphNodeKey === moduleName);
  }

  /** 框图里点了某条连线 → 找到树里对应的节点 */
  findByGraphEdge(edgeId: string): TraceNode | undefined {
    return this.find((n) => n.graphEdgeId === edgeId);
  }

  private find(pred: (n: TraceNode) => boolean): TraceNode | undefined {
    if (!this.root) return undefined;
    let hit: TraceNode | undefined;
    const walk = (n: TraceNode): void => {
      if (hit) return;
      if (n !== this.root && pred(n)) {
        hit = n;
        return;
      }
      for (const c of n.children) walk(c);
    };
    walk(this.root);
    return hit;
  }
}

function findParent(node: TraceNode | undefined, target: TraceNode): TraceNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c === target) return node;
    const found = findParent(c, target);
    if (found) return found;
  }
  return undefined;
}

function iconFor(node: TraceNode): vscode.ThemeIcon {
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

function buildTooltip(node: TraceNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;

  md.appendMarkdown(`**${escapeMd(node.label)}**\n\n`);
  if (node.edgeText) md.appendMarkdown(`关系：${escapeMd(node.edgeText)}\n\n`);
  if (node.description) md.appendMarkdown(`位置：\`${escapeMd(node.description)}\`\n\n`);
  if (node.tooltip) md.appendMarkdown(`${escapeMd(node.tooltip)}\n\n`);
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

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!]/g, (m) => `\\${m}`);
}
