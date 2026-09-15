import * as vscode from 'vscode';
import {
  CACHE_VERSION,
  deserializeIndex,
  optionsFingerprint,
  sameFileSet,
  serializeIndex,
} from './core/cache';
import type { FileStamp, IndexCacheFile } from './core/cache';
import { describeSignal, locText } from './core/describe';
import type { SignalRef } from './core/describe';
import { hierarchyPaths } from './core/hierarchy';
import { traceSignal, resolveStartPoint } from './core/graph';
import type { TraceDirection, TraceNode } from './core/graph';
import { WorkspaceIndexer } from './core/indexer';
import type { ModuleDecl } from './core/types';
import { SigCodeLensProvider } from './vscode/codeLens';
import { toMarkdown, toMermaid } from './vscode/export';
import { VscodeFileProvider } from './vscode/fsProvider';
import { SignalGraphPanel } from './vscode/graphPanel';
import type { GraphPanelHandlers, LayoutDirection } from './vscode/graphPanel';
import { MindmapViewProvider } from './vscode/mindmapView';
import {
  SigDefinitionProvider,
  SigDocumentHighlightProvider,
  SigHoverProvider,
  SigReferenceProvider,
  VERILOG_SELECTOR,
  wordAt as identAt,
} from './vscode/providers';
import { TraceTreeProvider } from './vscode/traceTree';
import type { TraceFilter } from './vscode/traceTree';

let indexer: WorkspaceIndexer;
let treeProvider: TraceTreeProvider;
let treeView: vscode.TreeView<any> | undefined;
/**
 * 树视图是否处于"活动"状态。
 * 视图的 when 子句一旦为假，VSCode 会销毁 TreeView —— 切回来必须重新 createTreeView，
 * 否则资源管理器里会是一片空白（这是 VSCode 视图机制的一个已知坑）。
 */
let treeViewMode: 'tree' | 'mindmap' = 'tree';
let mindmap: MindmapViewProvider;
let codeLens: SigCodeLensProvider;
let statusBar: vscode.StatusBarItem;
let indexPromise: Promise<void> | null = null;
let extensionCtx: vscode.ExtensionContext;
/** 最近一次追踪的参数：用于"继续展开"时按同样的条件重跑 */
let lastTrace:
  | {
      moduleName: string;
      net: string;
      direction: TraceDirection;
      openGraph: boolean;
      startAt?: { file: string; line: number; offset?: number };
    }
  | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionCtx = context;
  indexer = new WorkspaceIndexer();
  treeProvider = new TraceTreeProvider();

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'sigroute.rebuildIndex';
  updateStatus();

  // 视图模式：树视图 / 脑图 二选一（用 when 子句切换，面板位置不变）
  const savedMode = context.globalState.get<string>('sigroute.viewMode', 'tree');
  const mode = savedMode === 'mindmap' ? 'mindmap' : 'tree';
  treeViewMode = mode;
  if (mode === 'tree') ensureTreeView();
  void vscode.commands.executeCommand('setContext', 'sigroute.viewMode', mode);
  void vscode.commands.executeCommand('setContext', 'sigroute.filter', 'all');
  void vscode.commands.executeCommand('setContext', 'sigroute.hasResult', false);

  mindmap = new MindmapViewProvider(treeProvider, {
    reveal: (file, line, offset, label) => void revealLocation(file, line, offset, label),
    expand: (key) => treeProvider.expand(key),
    exportSvg: (svg, name) => void saveSvg(svg, name),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MindmapViewProvider.viewType, mindmap),
    mindmap,
  );

  // 视图模式：树视图 / 脑图 二选一（用 when 子句切换，面板位置不变）
  void vscode.commands.executeCommand('setContext', 'sigroute.filter', 'all');
  void vscode.commands.executeCommand('setContext', 'sigroute.hasResult', false);

  treeProvider.setExpandHandler(() => void rerunTrace());

  const reg = (id: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  reg('sigroute.traceBoth', () => doTrace('both'));
  reg('sigroute.traceDown', () => doTrace('down'));
  reg('sigroute.traceUp', () => doTrace('up'));
  reg('sigroute.traceGraph', () => doTrace('both', true));
  reg('sigroute.showGraph', () => showGraph());
  reg('sigroute.gotoParentConn', () => gotoParentConn());
  reg('sigroute.traceAt', (file: string, offset: number, name: string) =>
    traceFromHover(file, offset, name),
  );
  reg('sigroute.traceFromName', () => traceFromName());
  reg('sigroute.tracePort', (moduleName: string) => traceFromPort(String(moduleName)));
  reg('sigroute.rebuildIndex', () => rebuildIndex(true));
  reg('sigroute.exportMermaid', () => exportMermaid());
  reg('sigroute.exportMarkdown', () => exportMarkdown());
  reg('sigroute.showModuleInfo', () => showModuleInfo());
  reg('sigroute.showModuleInfoFor', (moduleName: string) => showModuleInfo(String(moduleName)));
  reg('sigroute.reveal', (file: string, line: number, offset?: number) =>
    revealLocation(file, line, offset),
  );

  // ---- 新增：层次路径 / 别名 / 过滤 / 展开 / 视图切换 ----
  reg('sigroute.copyPath', (text?: string) => copyHierarchyPath(text ? String(text) : undefined));
  reg('sigroute.findAliases', () => findAliases());
  reg('sigroute.expandChildren', (key: string) => treeProvider.expand(String(key)));
  reg('sigroute.cycleFilter', () => cycleFilter());
  reg('sigroute.filterSet', (value: string) => applyFilter(normalizeFilter(value)));
  reg('sigroute.toggleViewMode', () => toggleViewMode());
  reg('sigroute.directGoto', () => configureDirectGoto());

  // 保存时增量更新索引（只重解析该文件）
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isVerilogDoc(doc)) return;
      if (indexer.current.stats.fileCount === 0) return; // 尚未索引
      indexer.updateFile(doc.uri.fsPath, doc.getText());
      updateStatus();
    }),
    // 文件被删除/改名后，索引里的旧记录会让追踪指向不存在的行
    vscode.workspace.onDidDeleteFiles((e) => {
      if (indexer.current.stats.fileCount === 0) return;
      for (const f of e.files) {
        if (f.scheme === 'file') indexer.removeFile(f.fsPath);
      }
      updateStatus();
    }),
  );

  // ---- 编辑器内能力 ----
  // 全部是只读查询：悬停 / 跳定义 / 找引用都不会触碰面板里正在追踪的主信号，
  // 这样可以在盯一根信号的同时随手查看其它信号。
  const providerCtx = { indexer, ensureIndex };
  codeLens = new SigCodeLensProvider(providerCtx);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(VERILOG_SELECTOR, new SigHoverProvider(providerCtx)),
    vscode.languages.registerDefinitionProvider(
      VERILOG_SELECTOR,
      new SigDefinitionProvider(providerCtx),
    ),
    vscode.languages.registerReferenceProvider(
      VERILOG_SELECTOR,
      new SigReferenceProvider(providerCtx),
    ),
    vscode.languages.registerDocumentHighlightProvider(
      VERILOG_SELECTOR,
      new SigDocumentHighlightProvider(),
    ),
    vscode.languages.registerCodeLensProvider(VERILOG_SELECTOR, codeLens),
  );

  // 后台预热索引：让第一次悬停就是毫秒级响应
  const warmTimer = setTimeout(() => {
    void ensureIndex().catch(() => undefined);
  }, 1200);
  context.subscriptions.push({ dispose: () => clearTimeout(warmTimer) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('sigroute')) return;
      codeLens.refresh();
      // 只有影响"解析结果"的配置才需要重建索引；
      // 悬停 / 框图 / 导出这类显示项改了不该打扰用户重建。
      const needsRebuild = INDEX_AFFECTING.some((k) => e.affectsConfiguration(`sigroute.${k}`));
      if (!needsRebuild) return;
      indexPromise = null;
      vscode.window
        .showInformationMessage('SigRoute 索引相关配置已变更，需要重建索引。', '立即重建')
        .then((pick) => {
          if (pick === '立即重建') void rebuildIndex(true);
        });
    }),
  );

  context.subscriptions.push(statusBar);
}

export function deactivate(): void {
  // 无长期资源需要释放
}

// ------------------------------------------------------------------ 视图模式

async function toggleViewMode(): Promise<void> {
  const cur = extensionCtx.globalState.get<string>('sigroute.viewMode', 'tree');
  const next = cur === 'mindmap' ? 'tree' : 'mindmap';
  await extensionCtx.globalState.update('sigroute.viewMode', next);
  await vscode.commands.executeCommand('setContext', 'sigroute.viewMode', next);

  if (next === 'mindmap') {
    treeViewMode = 'mindmap';
    mindmap.refresh();
  } else {
    // 视图容器重建需要一点时间，之后再创建 TreeView（否则拿不到视图）
    setTimeout(() => {
      ensureTreeView();
      void vscode.commands.executeCommand('sigrouteTrace.focus').then(undefined, () => undefined);
    }, 220);
  }

  vscode.window.setStatusBarMessage(
    next === 'mindmap'
      ? 'SigRoute：已切换到脑图视图（再点一次切回树视图）'
      : 'SigRoute：已切换到树视图（再点一次切回脑图）',
    4000,
  );
}

// ------------------------------------------------------------------ 定义跳转策略

/**
 * 「多处定义时直接跳」开关 —— 写的是 VSCode 自己的设置。
 *
 * 为什么需要它：
 *   工程里通常还装着别的 Verilog 扩展（它们同样注册了 DefinitionProvider），
 *   VSCode 会把多家的结果合并，只要结果多于 1 个就按"多处定义"处理，
 *   默认策略（editor.gotoLocation.multipleDefinitions = peek）是弹预览候选窗。
 *   单个结果时它本来就直接跳（源码里 peek 分支要求 references.length > 1），
 *   所以"先出来一个预览窗"不是插件多返回了候选，而是合并后的数量问题 ——
 *   唯一能让 Ctrl+点击 一步到位的途径就是把这个策略改成 goto。
 *
 * 改的是全局设置（影响所有语言），所以：先弹一次确认，写完的通知里可一键恢复。
 */
async function configureDirectGoto(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('editor');
  const key = 'gotoLocation.multipleDefinitions';
  const cur = cfg.get<string>(key, 'peek');

  if (cur === 'goto') {
    const pick = await vscode.window.showInformationMessage(
      'SigRoute：Ctrl+点击 / F12 已经是直接跳转（editor.gotoLocation.multipleDefinitions = goto）。',
      '恢复为预览列表',
    );
    if (pick === '恢复为预览列表') {
      await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage('已恢复：多处定义时仍弹预览列表。');
    }
    return;
  }

  const ok = await vscode.window.showWarningMessage(
    '当有多个「转到定义」提供者时（本工程里还装着别的 Verilog 扩展），' +
      'VSCode 默认弹出候选预览窗而不是直接跳过去。改成直接跳转到第一个结果吗？\n\n' +
      '这会修改 VSCode 全局设置 editor.gotoLocation.multipleDefinitions = goto（影响所有语言），之后可随时恢复。',
    { modal: true },
    '改为直接跳转',
  );
  if (ok !== '改为直接跳转') return;

  await cfg.update(key, 'goto', vscode.ConfigurationTarget.Global);
  const undo = await vscode.window.showInformationMessage(
    '已改为直接跳转：Ctrl+点击 / F12 会一步跳到第一个定义，不再弹候选列表。',
    '恢复为预览列表',
  );
  if (undo === '恢复为预览列表') {
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('已恢复：多处定义时仍弹预览列表。');
  }
}

/** 确保树视图存在（视图模式切换后需要重建） */
function ensureTreeView(): void {
  if (treeView && treeViewMode === 'tree') return;
  const prev = treeView;
  treeViewMode = 'tree';
  try {
    prev?.dispose();
  } catch {
    // 已经随视图容器销毁，忽略
  }
  treeView = vscode.window.createTreeView('sigrouteTrace', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  extensionCtx.subscriptions.push(treeView);
  updateTreeChrome();
}

// ------------------------------------------------------------------ 过滤

function normalizeFilter(v: string): TraceFilter {
  return v === 'cross' || v === 'renamed' ? v : 'all';
}

function applyFilter(filter: TraceFilter): void {
  // 只影响树视图：脑图永远展示完整链路（两者职责不同，不共享状态）
  treeProvider.setFilter(filter);
  void vscode.commands.executeCommand('setContext', 'sigroute.filter', filter);
  updateTreeChrome();
}

function cycleFilter(): void {
  const cur = treeProvider.currentFilter;
  const next: TraceFilter = cur === 'all' ? 'cross' : cur === 'cross' ? 'renamed' : 'all';
  applyFilter(next);
  const text =
    next === 'all'
      ? 'SigRoute：显示全部节点'
      : next === 'cross'
        ? 'SigRoute：只看跨模块跳转（隐藏模块内部的中间变量）'
        : 'SigRoute：只看改名点';
  vscode.window.setStatusBarMessage(text, 4000);
}

/** 树视图标题栏的副标题与空状态提示 */
function updateTreeChrome(): void {
  const view = treeView;
  if (!view) return;
  const result = treeProvider.current;
  const filter = treeProvider.currentFilter;

  try {
    if (!result) {
      view.message = '把光标放在信号名上，按 Ctrl+T（或 Alt+Q）开始追踪。';
      view.description = undefined;
      return;
    }

    const shown = countVisible(treeProvider.currentNode, (n) => treeProvider.visible(n));
    const bits: string[] = [];
    if (filter !== 'all') bits.push(filter === 'cross' ? '只看跨模块' : '只看改名');
    bits.push(`${shown} 个节点`);
    view.description = bits.join(' · ');
    view.message =
      filter !== 'all' && shown <= 1
        ? '当前过滤条件下没有内容，点击标题栏的过滤按钮切换回「全部」。'
        : undefined;
  } catch {
    // 视图已被销毁（视图模式切走了）：下次 ensureTreeView 时再刷新
  }
}

function countVisible(node: TraceNode | undefined, childrenOf: (n: TraceNode) => TraceNode[]): number {
  if (!node) return 0;
  let n = 1;
  for (const c of childrenOf(node)) n += countVisible(c, childrenOf);
  return n;
}

// ------------------------------------------------------------------ 索引

interface IndexerConfig {
  includeGlobs: string[];
  excludeGlobs: string[];
  auxGlobs: string[];
  honorIfdef: boolean;
  inlineIncludes: boolean;
  maxInstancesPerModule: number;
  defines: string[];
  undefines: string[];
  useCache: boolean;
}

/** 改了这些配置会影响解析结果（需要重建索引）；其余都是显示项 */
const INDEX_AFFECTING = [
  'includeGlobs',
  'excludeGlobs',
  'defines',
  'undefines',
  'honorIfdef',
  'maxInstancesPerModule',
  'inlineIncludes',
  'blackboxSources',
];

function readConfig(): IndexerConfig {
  const cfg = vscode.workspace.getConfiguration('sigroute');
  return {
    includeGlobs: cfg.get<string[]>('includeGlobs', ['**/*.v', '**/*.sv', '**/*.vh', '**/*.svh']),
    excludeGlobs: cfg.get<string[]>('excludeGlobs', [
      '**/node_modules/**',
      '**/.git/**',
      '**/*.cache/**',
      '**/*.sim/**',
      '**/*.runs/**',
      '**/*.hw/**',
      '**/*.ip_user_files/**',
      '**/sigroute/**',
    ]),
    auxGlobs: cfg.get<string[]>('blackboxSources', ['**/*.veo', '**/*.vho']),
    honorIfdef: cfg.get<boolean>('honorIfdef', true),
    inlineIncludes: cfg.get<boolean>('inlineIncludes', true),
    maxInstancesPerModule: cfg.get<number>('maxInstancesPerModule', 200),
    defines: cfg.get<string[]>('defines', []),
    undefines: cfg.get<string[]>('undefines', []),
    useCache: cfg.get<boolean>('indexCache', true),
  };
}

function getGlobs(c: IndexerConfig = readConfig()): {
  include: string[];
  exclude: string[];
  aux: string[];
} {
  return { include: c.includeGlobs, exclude: c.excludeGlobs, aux: c.auxGlobs };
}

async function buildIndex(): Promise<void> {
  const c = readConfig();
  indexer.setOptions({
    honorIfdef: c.honorIfdef,
    maxInstancesPerModule: c.maxInstancesPerModule,
    extraDefines: c.defines,
    undefines: c.undefines,
    inlineIncludes: c.inlineIncludes,
  });

  const provider = new VscodeFileProvider(() => getGlobs(c));

  // ---- 1) 尝试接管磁盘缓存（指纹完全一致时跳过解析）----
  if (c.useCache) {
    const restored = await tryLoadCache(provider, c);
    if (restored) {
      updateStatus();
      const s = indexer.current.stats;
      vscode.window.setStatusBarMessage(
        `SigRoute: 索引缓存命中（${s.moduleCount} 个模块 / ${s.instanceCount} 个例化，跳过解析）`,
        5000,
      );
      updateTreeChrome();
      return;
    }
  }

  // ---- 2) 全量解析 ----
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'SigRoute 建立索引' },
    async (progress) => {
      await indexer.build(provider, (message, increment) => {
        progress.report({ message, increment });
      });
    },
  );

  updateStatus();
  const s = indexer.current.stats;
  const b = indexer.buildStats;
  const extra = [
    b.inlined > 0 ? `内联 ${b.inlined} 处 include` : '',
    b.declOnlyModules > 0 ? `补全 ${b.declOnlyModules} 个 IP 端口` : '',
  ].filter(Boolean);
  vscode.window.setStatusBarMessage(
    `SigRoute: 已索引 ${s.moduleCount} 个模块 / ${s.instanceCount} 个例化（${s.parseMs}ms）` +
      (extra.length > 0 ? `｜${extra.join('｜')}` : ''),
    6000,
  );

  if (c.useCache) void saveCache(provider, c).catch(() => undefined);
  updateTreeChrome();
}

// ---- 索引缓存 ----

function cacheFileUri(): vscode.Uri {
  const base = extensionCtx.storageUri ?? extensionCtx.globalStorageUri;
  return vscode.Uri.joinPath(base, 'sigroute-index.json');
}

/** 影响解析结果的配置指纹（缓存命中判据） */
function fingerprintOf(c: IndexerConfig): string {
  return optionsFingerprint({
    honorIfdef: c.honorIfdef,
    inlineIncludes: c.inlineIncludes,
    maxInstancesPerModule: c.maxInstancesPerModule,
    extraDefines: c.defines,
    undefines: c.undefines,
  });
}

async function stampFiles(
  provider: VscodeFileProvider,
  files: string[],
): Promise<FileStamp[] | null> {
  if (!provider.stat) return null;
  const out: FileStamp[] = [];
  const BATCH = 64;
  for (let i = 0; i < files.length; i += BATCH) {
    const slice = files.slice(i, i + BATCH);
    const stats = await Promise.all(slice.map((f) => provider.stat!(f)));
    for (let k = 0; k < slice.length; k++) {
      const s = stats[k];
      if (!s) return null; // 有文件读不到就不敢用缓存
      out.push({ path: slice[k].replace(/\\/g, '/'), mtimeMs: s.mtimeMs, size: s.size });
    }
  }
  return out;
}

async function tryLoadCache(
  provider: VscodeFileProvider,
  c: IndexerConfig,
): Promise<boolean> {
  try {
    const uri = cacheFileUri();
    let buf: Uint8Array;
    try {
      buf = await vscode.workspace.fs.readFile(uri);
    } catch {
      return false;
    }
    const raw = JSON.parse(Buffer.from(buf).toString('utf8')) as IndexCacheFile;
    if (!raw || raw.version !== CACHE_VERSION) return false;
    if (raw.options !== fingerprintOf(c)) return false;

    const files = (await provider.listFiles()).map((f) => f.replace(/\\/g, '/'));
    const stamps = await stampFiles(provider, files);
    if (!stamps || !sameFileSet(raw.files ?? [], stamps)) return false;

    const index = deserializeIndex(raw.index);
    if (!index) return false;
    // 恢复 include 上下文，保证缓存命中后的增量更新仍能内联 include
    indexer.adopt(index, new Map(Object.entries(raw.includeTexts ?? {})));
    return true;
  } catch {
    return false;
  }
}

async function saveCache(provider: VscodeFileProvider, c: IndexerConfig): Promise<void> {
  const files = (await provider.listFiles()).map((f) => f.replace(/\\/g, '/'));
  const stamps = await stampFiles(provider, files);
  if (!stamps) return;
  const payload: IndexCacheFile = {
    version: CACHE_VERSION,
    options: fingerprintOf(c),
    files: stamps,
    includeTexts: Object.fromEntries(indexer.cachedIncludeTexts),
    index: serializeIndex(indexer.current),
  };
  const text = JSON.stringify(payload);
  await vscode.workspace.fs.writeFile(cacheFileUri(), Buffer.from(text, 'utf8'));
}

function ensureIndex(): Promise<void> {
  if (!indexPromise) indexPromise = buildIndex();
  return indexPromise;
}

async function rebuildIndex(showMessage: boolean): Promise<void> {
  indexPromise = null;
  await ensureIndex();
  if (showMessage) {
    const s = indexer.current.stats;
    const b = indexer.buildStats;
    const detail = [
      b.inlined > 0 ? `内联 include ${b.inlined} 处` : '',
      b.declOnlyModules > 0 ? `IP 声明补全 ${b.declOnlyModules} 个` : '',
      b.skippedIncludes.length > 0 ? `${b.skippedIncludes.length} 处 include 未内联` : '',
    ].filter(Boolean);
    void vscode.window.showInformationMessage(
      `SigRoute 索引完成：${s.fileCount} 个文件、${s.moduleCount} 个模块、${s.instanceCount} 个例化，耗时 ${s.parseMs}ms。` +
        (detail.length > 0 ? ` ${detail.join('，')}。` : ''),
    );
  }
  treeProvider.resetExpansion();
  void rerunTrace();
}

function updateStatus(): void {
  const s = indexer.current.stats;
  if (s.fileCount === 0) {
    statusBar.text = '$(circuit-board) SigRoute';
    statusBar.tooltip = '点击建立索引';
  } else {
    statusBar.text = `$(circuit-board) ${s.moduleCount} 模块`;
    const nets = indexer.netClasses.stats();
    statusBar.tooltip = new vscode.MarkdownString(
      `**SigRoute 索引**\n\n- 文件：${s.fileCount}\n- 模块：${s.moduleCount}\n- 例化：${s.instanceCount}\n- 网络等价类：${nets.classes}（其中 ${nets.aliasedNets} 个网络有别名）\n- 耗时：${s.parseMs}ms\n\n点击重建索引`,
    );
  }
  statusBar.show();
}

// ------------------------------------------------------------------ 追踪

/**
 * 追踪核心流程：从（模块, 信号）出发，产出结果并推送到树 / 框图 / 脑图。
 * 面板内容只在明确请求追踪时才改变 —— 悬停、跳定义等只读操作不会走到这里。
 */
async function runTrace(
  startModule: ModuleDecl,
  net: string,
  direction: TraceDirection,
  openGraph: boolean,
  startAt?: { file: string; line: number; offset?: number },
): Promise<void> {
  const sp = resolveStartPoint(indexer, startModule, net);
  const cfg = vscode.workspace.getConfiguration('sigroute');

  // 换了信号就清空"继续展开"的历史（旧的键对新信号没有意义）
  const changed =
    !lastTrace ||
    lastTrace.moduleName !== sp.module.name ||
    lastTrace.net !== sp.net ||
    lastTrace.direction !== direction;
  if (changed) treeProvider.resetExpansion();
  lastTrace = { moduleName: sp.module.name, net: sp.net, direction, openGraph, startAt };

  const result = traceSignal(indexer, sp.module, sp.net, {
    direction,
    maxDepth: cfg.get<number>('maxDepth', 30),
    maxNodes: cfg.get<number>('maxNodes', 600),
    maxChildren: cfg.get<number>('maxChildren', 24),
    expanded: treeProvider.expandState(),
    startAt,
  });
  treeProvider.setResult(result);
  void vscode.commands.executeCommand('setContext', 'sigroute.hasResult', true);
  updateTreeChrome();

  if (openGraph || cfg.get<boolean>('autoShowGraph', false)) {
    SignalGraphPanel.show(
      extensionCtx.extensionUri,
      result.graph,
      graphDirection(),
      graphHops(),
      graphHandlers(),
    );
  }

  await focusResultView();
  mindmap.refresh();

  const scope = direction === 'both' ? '上游+下游' : direction === 'up' ? '上游' : '下游';
  vscode.window.setStatusBarMessage(
    `SigRoute: ${net}（${scope}）—— ${result.stats.nodes} 个节点，${result.modules.length} 个模块，` +
      `${result.stats.renames} 处改名${result.stats.uncertainties > 0 ? `，${result.stats.uncertainties} 处不确定` : ''}` +
      (sp.note ? ` ｜ ${sp.note}` : ''),
    8000,
  );
}

/** 把结果推到眼前：当前是树视图还是脑图 */
async function focusResultView(): Promise<void> {
  const mode = extensionCtx.globalState.get<string>('sigroute.viewMode', 'tree');
  if (mode === 'mindmap') {
    mindmap.refresh();
    await vscode.commands
      .executeCommand('sigrouteMindmap.focus')
      .then(undefined, () => undefined);
    return;
  }
  ensureTreeView();
  await vscode.commands.executeCommand('sigrouteTrace.focus').then(undefined, () => undefined);
}

/** 用与上次相同的条件重新追踪（"继续展开"、重建索引后刷新用） */
async function rerunTrace(): Promise<void> {
  if (!lastTrace) return;
  const mod = indexer.getModule(lastTrace.moduleName);
  if (!mod) return;
  await runTrace(mod, lastTrace.net, lastTrace.direction, lastTrace.openGraph, lastTrace.startAt);
}

/** 框图（Webview）与树视图的联动 */
function graphHandlers(): GraphPanelHandlers {
  return {
    revealTree: (kind, id) => {
      const doReveal = (): void => {
        let node = kind === 'node' ? treeProvider.findByGraphNode(id) : treeProvider.findByGraphEdge(id);
        if (!node && treeProvider.currentFilter !== 'all') {
          // 被过滤掉了：先切回"全部"再定位，比直接报错有用
          applyFilter('all');
          node = kind === 'node' ? treeProvider.findByGraphNode(id) : treeProvider.findByGraphEdge(id);
        }
        if (!node) {
          vscode.window.setStatusBarMessage(
            `SigRoute: 树视图里没有 ${id} 对应的节点（链路可能已被跳数裁剪）`,
            4000,
          );
          return;
        }
        try {
          void treeView
            ?.reveal(node, { focus: true, select: true, expand: true })
            .then(undefined, () => undefined);
        } catch {
          vscode.window.setStatusBarMessage('SigRoute: 无法在树视图中定位（视图未就绪）', 4000);
        }
      };

      if (treeViewMode !== 'tree') {
        // 树视图被脑图替换掉了：切回树视图再定位（"在树中定位"的前提是树视图在）
        void extensionCtx.globalState.update('sigroute.viewMode', 'tree');
        void vscode.commands.executeCommand('setContext', 'sigroute.viewMode', 'tree');
        setTimeout(() => {
          ensureTreeView();
          doReveal();
        }, 260);
        return;
      }
      doReveal();
    },
    traceNet: (net, moduleName) => {
      const mod = (moduleName ? indexer.getModule(moduleName) : undefined) ?? undefined;
      if (!mod) return;
      // 从框图上的那条连线取位置：这样根节点也会跳回"我刚点的那根线"
      const edge = treeProvider.current?.graph.edges.find(
        (e) => e.file && (e.fromNet === net || e.toNet === net),
      );
      const startAt = edge?.file
        ? { file: edge.file, line: edge.line ?? 0, offset: edge.offset }
        : undefined;
      void runTrace(mod, net, 'both', false, startAt);
    },
  };
}

async function saveSvg(svg: string, name: string): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    title: '导出信号框图',
    defaultUri: vscode.Uri.file(`${name}_blockdiagram.svg`),
    filters: { SVG: ['svg'] },
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(svg, 'utf8'));
  void vscode.window.showInformationMessage(`已导出：${uri.fsPath}`);
}

/** 定位某个文件偏移处的模块（模块外时退化为文件里唯一的模块） */
function moduleAtLocation(file: string, offset: number): ModuleDecl | undefined {
  let mod = indexer.findModuleAt(file, offset);
  if (!mod) {
    const names = indexer.current.fileModules.get(file.replace(/\\/g, '/')) ?? [];
    if (names.length === 1) mod = indexer.getModule(names[0]);
  }
  return mod;
}

async function doTrace(direction: TraceDirection, openGraph = false): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('请先打开一个 Verilog 源文件。');
    return;
  }
  const doc = editor.document;
  if (!isVerilogDoc(doc)) {
    void vscode.window.showWarningMessage('SigRoute 只支持 Verilog / SystemVerilog 源文件。');
    return;
  }

  const target = identAt(doc, editor.selection.active);
  if (!target) {
    void vscode.window.showWarningMessage('请把光标放在一个信号名上再执行追踪。');
    return;
  }

  await ensureIndex();

  const offset = doc.offsetAt(editor.selection.active);
  const mod = moduleAtLocation(doc.uri.fsPath, offset);
  if (!mod) {
    void vscode.window.showWarningMessage(
      `未能在 ${doc.uri.path.split('/').pop()} 中定位模块（光标可能位于模块之外）。`,
    );
    return;
  }

  // 记住"用户在哪里发起的追踪"：根节点会跳回这里，而不是信号的声明处
  await runTrace(mod, target.name, direction, openGraph, {
    file: doc.uri.fsPath,
    line: editor.selection.active.line,
    offset,
  });
}

/**
 * 从 Hover 链接发起的追踪（悬停中点击才触发）。
 * 与普通悬停的区别：这是用户明确要求切换追踪目标，所以会更新面板。
 */
async function traceFromHover(
  file: string,
  offset: number,
  name: string,
  openGraph = false,
): Promise<void> {
  await ensureIndex();
  const mod = moduleAtLocation(file, offset);
  if (!mod) {
    void vscode.window.showWarningMessage(`无法在 ${file} 中定位模块。`);
    return;
  }
  // 悬停链接只带偏移：换算出所在行，好让根节点能跳回这处引用
  let line = 0;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    line = doc.positionAt(offset).line;
  } catch {
    // 读不到就用 0，revealLocation 会靠 offset 精确定位
  }
  await runTrace(mod, name, 'both', openGraph, { file, line, offset });
}

/**
 * 跳到"模块外"的连接处：当前信号是端口时，找到上级模块例化本模块、
 * 连接该端口的位置。多处例化时弹出选择。
 */
async function gotoParentConn(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isVerilogDoc(editor.document)) {
    void vscode.window.showWarningMessage('请先打开一个 Verilog 源文件并把光标放在端口名上。');
    return;
  }
  const doc = editor.document;
  const target = identAt(doc, editor.selection.active);
  if (!target) {
    void vscode.window.showWarningMessage('请把光标放在一个端口名上。');
    return;
  }

  await ensureIndex();
  const mod = moduleAtLocation(doc.uri.fsPath, doc.offsetAt(editor.selection.active));
  if (!mod) {
    void vscode.window.showWarningMessage('光标不在任何模块内。');
    return;
  }

  const desc = describeSignal(indexer, mod, target.name);
  const outer = dedupe([...desc.drivers, ...desc.loads].filter((r) => r.kind === 'parent-conn'));

  if (outer.length === 0) {
    const why = desc.decl.kind === 'unknown'
      ? `找不到 ${target.name} 的声明`
      : desc.decl.kind === 'port'
        ? `${mod.name}.${target.name} 没有被任何模块例化`
        : `${target.name} 是模块内部信号，不跨越模块边界`;
    void vscode.window.showInformationMessage(`无法跳出模块：${why}。`);
    return;
  }

  if (outer.length === 1) {
    await revealLocation(outer[0].file, outer[0].line, outer[0].offset, target.name);
    return;
  }

  const pick = await vscode.window.showQuickPick(
    outer.map((r) => ({
      label: r.text || '(未连接)',
      description: r.detail ?? '',
      detail: `${locText(r.file, r.line)}`,
      ref: r,
    })),
    { title: `${target.name} 在 ${outer.length} 处被连接，选择要跳转的位置` },
  );
  if (!pick) return;
  await revealLocation(pick.ref.file, pick.ref.line, pick.ref.offset, target.name);
}

function dedupe(refs: SignalRef[]): SignalRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.file}:${r.line}:${r.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------------------------ 层次路径 / 别名

/** 复制信号的完整层次路径（不给参数时从光标处取） */
async function copyHierarchyPath(text?: string): Promise<void> {
  if (text) {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage(`SigRoute: 已复制 ${text}`, 4000);
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || !isVerilogDoc(editor.document)) {
    void vscode.window.showWarningMessage('请先打开一个 Verilog 源文件并把光标放在信号名上。');
    return;
  }
  const doc = editor.document;
  const target = identAt(doc, editor.selection.active);
  if (!target) {
    void vscode.window.showWarningMessage('请把光标放在一个信号名上。');
    return;
  }
  await ensureIndex();
  const mod = moduleAtLocation(doc.uri.fsPath, doc.offsetAt(editor.selection.active));
  if (!mod) {
    void vscode.window.showWarningMessage('光标不在任何模块内。');
    return;
  }

  const paths = hierarchyPaths(indexer, mod.name, target.name, { maxPaths: 12 });
  if (paths.length === 0) {
    void vscode.window.showWarningMessage(`无法为 ${target.name} 生成层次路径。`);
    return;
  }
  if (paths.length === 1) {
    await vscode.env.clipboard.writeText(paths[0].text);
    void vscode.window.showInformationMessage(`已复制层次路径：${paths[0].text}`);
    return;
  }

  const pick = await vscode.window.showQuickPick(
    paths.map((p) => ({
      label: p.text,
      description: `${p.steps.length - 1} 层${p.partial ? ' · 可能不完整' : ''}`,
      detail: p.steps
        .slice(0, 6)
        .map((s) => s.moduleName)
        .join(' → '),
      path: p,
    })),
    { title: `${target.name} 有 ${paths.length} 条可能的层次路径（同一模块被多处例化）` },
  );
  if (!pick) return;
  await vscode.env.clipboard.writeText(pick.path.text);
  void vscode.window.showInformationMessage(`已复制层次路径：${pick.path.text}`);
}

/** 列出同一物理网络的全部别名（改名点的反向查询） */
async function findAliases(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isVerilogDoc(editor.document)) {
    void vscode.window.showWarningMessage('请先打开一个 Verilog 源文件并把光标放在信号名上。');
    return;
  }
  const doc = editor.document;
  const target = identAt(doc, editor.selection.active);
  if (!target) {
    void vscode.window.showWarningMessage('请把光标放在一个信号名上。');
    return;
  }
  await ensureIndex();
  const mod = moduleAtLocation(doc.uri.fsPath, doc.offsetAt(editor.selection.active));
  if (!mod) {
    void vscode.window.showWarningMessage('光标不在任何模块内。');
    return;
  }

  const members = indexer.netMembers(mod.name, target.name);
  if (members.length <= 1) {
    void vscode.window.showInformationMessage(
      `${target.name} 没有发现改名：在索引范围内它只出现在 ${mod.name}（可能是黑盒 IP 的另一侧，或端口未连接）。`,
    );
    return;
  }

  const pick = await vscode.window.showQuickPick(
    members.map((m) => {
      const targetMod = indexer.getModule(m.module);
      const port = targetMod?.ports.find((p) => p.name === m.net);
      const sig = targetMod?.signals.get(m.net);
      const line = port?.line ?? sig?.line ?? targetMod?.headerLine ?? 0;
      const where = targetMod ? locText(targetMod.file, line) : '';
      return {
        label: `${m.module}.${m.net}`,
        description: `${m.direction ?? m.kind}${m.instances > 1 ? ` · 该模块被例化 ${m.instances} 次` : ''}`,
        detail: where,
        member: m,
        file: targetMod?.file,
        line,
        offset: port?.offset ?? (sig && sig.offset >= 0 ? sig.offset : undefined),
      };
    }),
    {
      title: `${target.name} 的同一物理网络共 ${members.length} 个名字（选择跳转）`,
      placeHolder: '这些名字指的是同一根线：改名点就是它们之间的端口连接',
    },
  );
  if (!pick || !pick.file) return;
  await revealLocation(pick.file, pick.line, pick.offset, pick.member.net);
}

// ------------------------------------------------------------------ 端口追踪

async function traceFromPort(moduleName: string): Promise<void> {
  await ensureIndex();
  const mod = indexer.getModule(moduleName);
  if (!mod) {
    void vscode.window.showWarningMessage(`找不到模块 ${moduleName}。`);
    return;
  }
  if (mod.ports.length === 0) {
    void vscode.window.showInformationMessage(`模块 ${moduleName} 没有解析到端口。`);
    return;
  }

  const pick = await vscode.window.showQuickPick(
    mod.ports.map((p) => ({
      label: p.name,
      description: `${p.direction ?? '?'}${p.msb !== null && p.lsb !== null ? ` [${p.msb}:${p.lsb}]` : ''}${p.width !== null ? ` · ${p.width} bit` : ''}`,
      detail: locText(mod.file, p.line),
      port: p,
    })),
    {
      title: `追踪 ${moduleName} 的哪个端口`,
      placeHolder: '输入端口名过滤',
      matchOnDescription: true,
    },
  );
  if (!pick) return;
  await runTrace(mod, pick.port.name, 'both', false, {
    file: mod.file,
    line: pick.port.line,
    offset: pick.port.offset,
  });
}

function graphDirection(): LayoutDirection {
  const v = vscode.workspace.getConfiguration('sigroute').get<string>('graphDirection', 'LR');
  return v === 'TD' ? 'TD' : 'LR';
}

/** 框图默认跳数：0 = 全部 */
function graphHops(): number {
  const v = vscode.workspace.getConfiguration('sigroute').get<number>('graphHops', 1);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

/** 为最近一次追踪结果打开框图 */
function showGraph(): void {
  const result = treeProvider.current;
  if (!result) {
    void vscode.window.showWarningMessage('请先执行一次信号追踪，再打开框图。');
    return;
  }
  if (result.graph.nodes.length <= 1) {
    void vscode.window.showWarningMessage(
      `信号 ${result.start.netName} 没有跨模块连接，无法生成框图（可查看树视图了解模块内情况）。`,
    );
    return;
  }
  SignalGraphPanel.show(
    extensionCtx.extensionUri,
    result.graph,
    graphDirection(),
    graphHops(),
    graphHandlers(),
  );
}

async function traceFromName(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const maxDepth = vscode.workspace.getConfiguration('sigroute').get<number>('maxDepth', 30);
  await ensureIndex();

  const startModule = editor
    ? indexer.findModuleAt(
        editor.document.uri.fsPath,
        editor.document.offsetAt(editor.selection.active),
      )
    : undefined;

  const seed = editor
    ? identAt(editor.document, editor.selection.active)?.name ?? ''
    : '';

  const name = await vscode.window.showInputBox({
    title: '按信号名追踪',
    prompt: startModule
      ? `从模块 ${startModule.name} 开始追踪；不属于该模块的名字会自动定位到声明它的模块`
      : '输入信号名（将从顶层模块开始追踪）',
    value: seed,
    placeHolder: '例如：s_data',
  });
  if (!name) return;

  let start = startModule;
  if (!start) {
    const tops = indexer.current.topCandidates;
    if (tops.length === 0) {
      void vscode.window.showWarningMessage(`工程中没有找到顶层模块，无法定位信号 ${name}。`);
      return;
    }
    if (tops.length === 1) {
      start = indexer.getModule(tops[0]);
    } else {
      const pick = await vscode.window.showQuickPick(tops, {
        title: `信号 ${name} 的起点模块`,
        placeHolder: '选择一个顶层模块作为追踪起点',
      });
      if (!pick) return;
      start = indexer.getModule(pick);
    }
  }
  if (!start) return;

  const sp = resolveStartPoint(indexer, start, name);
  const cfg = vscode.workspace.getConfiguration('sigroute');

  // 手输的名字如果就是光标下那个词，根节点同样跳回这里
  let startAt: { file: string; line: number; offset?: number } | undefined;
  if (editor) {
    const cur = identAt(editor.document, editor.selection.active);
    if (cur && cur.name === sp.net) {
      startAt = {
        file: editor.document.uri.fsPath,
        line: editor.selection.active.line,
        offset: editor.document.offsetAt(editor.selection.active),
      };
    }
  }

  const result = traceSignal(indexer, sp.module, sp.net, {
    direction: 'both',
    maxDepth,
    maxNodes: cfg.get<number>('maxNodes', 600),
    maxChildren: cfg.get<number>('maxChildren', 24),
    expanded: treeProvider.expandState(),
    startAt,
  });
  lastTrace = {
    moduleName: sp.module.name,
    net: sp.net,
    direction: 'both',
    openGraph: false,
    startAt,
  };
  treeProvider.setResult(result);
  void vscode.commands.executeCommand('setContext', 'sigroute.hasResult', true);
  updateTreeChrome();
  mindmap.refresh();
  await focusResultView();
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_$]*/;

let flashDecoration: vscode.TextEditorDecorationType | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 跳转到源码并「选中」目标标识符。
 *
 * 关键点：必须用非空 Selection（选中一段文本）才会有灰底/主题色高亮。
 * 早先用 `new Selection(pos, pos)` 只是把光标移过去，视觉上什么都看不出。
 */
async function revealLocation(
  file: string,
  line: number,
  offset?: number,
  label?: string,
): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const range = resolveRevealRange(doc, line, offset, label);

    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    flashRange(editor, range);
  } catch (err) {
    void vscode.window.showErrorMessage(`无法打开 ${file}：${(err as Error).message}`);
  }
}

/** 短暂闪烁一下，便于在密集代码里一眼定位（选区的灰底在小屏/深色主题下不够显眼） */
function flashRange(editor: vscode.TextEditor, range: vscode.Range): void {
  if (!flashDecoration) {
    flashDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      outline: '1px solid',
      outlineColor: new vscode.ThemeColor('editor.findMatchBorder'),
    });
  }
  editor.setDecorations(flashDecoration, [range]);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (flashDecoration) editor.setDecorations(flashDecoration, []);
  }, 1200);
}

/**
 * 把（行号, 字符偏移, 标签）解析成一个「标识符范围」。
 * 优先用解析阶段记录的精确偏移；拿不到时退化为在行内按名字查找。
 */
function resolveRevealRange(
  doc: vscode.TextDocument,
  line: number,
  offset?: number,
  label?: string,
): vscode.Range {
  // 1) 精确偏移：从该位置扩展出完整标识符
  if (typeof offset === 'number' && offset >= 0 && offset <= doc.getText().length) {
    const pos = doc.positionAt(offset);
    const word = doc.getWordRangeAtPosition(pos, IDENT_RE);
    if (word) return word;
    return new vscode.Range(pos, pos);
  }

  // 2) 退化为按行：在行内找到同名的标识符
  const ln = Math.max(0, Math.min(line, doc.lineCount - 1));
  const name = label ? plainName(label) : undefined;
  if (name) {
    const text = doc.lineAt(ln).text;
    const idx = indexOfIdentifier(text, name);
    if (idx >= 0) return new vscode.Range(ln, idx, ln, idx + name.length);
  }
  return new vscode.Range(ln, 0, ln, 0);
}

/** 从节点标签里取出纯信号名（剥掉位选、`模块.端口`、箭头等附加文字） */
function plainName(label: string): string | undefined {
  const m = /([A-Za-z_][A-Za-z0-9_$]*)\s*$/.exec(label.trim());
  const head = /^([A-Za-z_][A-Za-z0-9_$]*)/.exec(label.trim());
  // `mod.port` 取 port；`s_data[7:0]` 取 s_data
  return (m ?? head)?.[1];
}

/** 行内按「整词」查找，避免 sig 命中 sig_dup */
function indexOfIdentifier(text: string, name: string): number {
  const isWord = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  let from = 0;
  for (;;) {
    const idx = text.indexOf(name, from);
    if (idx < 0) return -1;
    const before = idx > 0 ? text[idx - 1] : '';
    const after = idx + name.length < text.length ? text[idx + name.length] : '';
    if (!isWord(before) && !isWord(after)) return idx;
    from = idx + 1;
  }
}

// ------------------------------------------------------------------ 导出

async function exportMermaid(): Promise<void> {
  const result = treeProvider.current;
  if (!result) {
    void vscode.window.showWarningMessage('请先执行一次信号追踪，再导出。');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('sigroute');
  const text = toMermaid(result, { direction: cfg.get<'LR' | 'TD'>('mermaidDirection', 'LR') });

  await vscode.env.clipboard.writeText(text);
  const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.showInformationMessage(
    'Mermaid 图已复制到剪贴板，可粘贴到 mermaid.live、Typora 或 Markdown 预览中查看。',
  );
}

async function exportMarkdown(): Promise<void> {
  const result = treeProvider.current;
  if (!result) {
    void vscode.window.showWarningMessage('请先执行一次信号追踪，再导出。');
    return;
  }
  const text = toMarkdown(result);

  const target = await vscode.window.showQuickPick(
    [
      { label: '$(clippy) 复制到剪贴板', value: 'clipboard' as const },
      { label: '$(file-add) 在新文档中打开', value: 'document' as const },
      { label: '$(save) 保存为文件…', value: 'save' as const },
    ],
    { title: `导出路由报告：${result.start.netName}` },
  );
  if (!target) return;

  if (target.value === 'clipboard') {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('路由报告已复制到剪贴板。');
    return;
  }
  if (target.value === 'document') {
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    title: '保存信号路由报告',
    defaultUri: vscode.Uri.file(`${result.start.netName}_route.md`),
    filters: { Markdown: ['md'] },
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  void vscode.window.showInformationMessage(`已保存：${uri.fsPath}`);
}

// ------------------------------------------------------------------ 模块信息

async function showModuleInfo(moduleName?: string): Promise<void> {
  await ensureIndex();

  let mod: ModuleDecl | undefined;
  if (moduleName) {
    mod = indexer.getModule(moduleName);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    mod = indexer.findModuleAt(doc.uri.fsPath, doc.offsetAt(editor.selection.active));
  }
  if (!mod) {
    void vscode.window.showWarningMessage('找不到对应的模块（把光标放在模块内，或从 CodeLens 打开）。');
    return;
  }

  const sites = indexer.getInstantiations(mod.name);
  const lines: string[] = [];
  lines.push(`# 模块信息：${mod.name}`);
  lines.push('');
  lines.push(`- 文件：\`${mod.file}\``);
  lines.push(`- 行号：${mod.headerLine + 1} ~ ${mod.endLine + 1}`);
  lines.push(`- 端口数：${mod.ports.length}`);
  lines.push(`- 例化子模块：${mod.instances.length}`);
  lines.push(`- 被例化次数：${sites.length}`);
  lines.push(`- 端口列表风格：${mod.ansi ? 'ANSI (声明式)' : '传统式'}`);
  if (mod.declOnly) lines.push('- 来源：IP 例化模板（仅用于补齐端口方向）');
  lines.push('');
  lines.push('## 端口');
  lines.push('');
  lines.push('| # | 名称 | 方向 | 位宽 | 范围 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const p of mod.ports) {
    lines.push(
      `| ${p.index + 1} | \`${p.name}\` | ${p.direction ?? '?'} | ${p.width ?? '?'} | ${p.msb !== null && p.lsb !== null ? `[${p.msb}:${p.lsb}]` : '-'} |`,
    );
  }
  lines.push('');
  lines.push('## 例化的子模块');
  lines.push('');
  lines.push('| 实例名 | 模块类型 | 连接数 | 位置 | 是否已索引 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const inst of mod.instances) {
    const indexed = indexer.hasModule(inst.moduleType)
      ? indexer.isDeclOnly(inst.moduleType)
        ? '仅声明'
        : '是'
      : '**否（IP/黑盒）**';
    lines.push(
      `| \`${inst.instanceName}\` | \`${inst.moduleType}\` | ${inst.connections.length} | ${inst.line + 1}${inst.inGenerate ? ' (generate)' : ''} | ${indexed} |`,
    );
  }
  lines.push('');
  lines.push('## 被例化位置');
  lines.push('');
  if (sites.length === 0) {
    lines.push('未被例化（可能是顶层模块）。');
  } else {
    for (const s of sites) {
      lines.push(
        `- \`${s.parentModule}\` 中的 \`${s.instance.instanceName}\` — ${s.parentFile.split(/[\\/]/).pop()}:${s.instance.line + 1}`,
      );
    }
  }
  if (mod.warnings.length > 0) {
    lines.push('');
    lines.push('## 解析告警');
    lines.push('');
    for (const w of mod.warnings) lines.push(`- ${w}`);
  }

  const outDoc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(outDoc, { preview: true });
}

// ------------------------------------------------------------------ 工具

function isVerilogDoc(doc: vscode.TextDocument): boolean {
  const ids = ['verilog', 'systemverilog', 'verilog-hdl'];
  if (ids.includes(doc.languageId)) return true;
  return /\.(v|sv|vh|svh)$/i.test(doc.fileName);
}
