/**
 * 编辑器内能力：Hover / 定义跳转 / 查找引用 / 同文档高亮
 *
 * 设计约束（来自实际使用场景）：
 *   面板里正在追踪的主信号必须**保持不动**。
 *   开发者在盯一根信号的同时，会随手悬停看看别的信号是干什么的，
 *   这时绝不能把面板切走。所以这一层完全是只读查询，不写任何状态。
 *
 * 悬停内容的拼装逻辑在 core/hover.ts（纯字符串、可测），
 * 这里只负责：取光标下的名字 → 拿描述 → 按配置渲染 → 包成 MarkdownString。
 */

import * as vscode from 'vscode';
import { describeSignal, moduleLocation } from '../core/describe';
import type { SignalDescription } from '../core/describe';
import { DEFAULT_HOVER_OPTIONS, isHoverSection, renderSignalHoverMarkdown } from '../core/hover';
import type { HoverOptions, HoverSection } from '../core/hover';
import type { WorkspaceIndexer } from '../core/indexer';
import { lex, TokType } from '../core/lexer';
import type { ModuleDecl } from '../core/types';
import { samePath } from './fsProvider';

export const VERILOG_SELECTOR: vscode.DocumentSelector = [
  { language: 'verilog' },
  { language: 'systemverilog' },
  { language: 'verilog-hdl' },
  { pattern: '**/*.{v,sv,vh,svh}' },
];

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_$]*/;

/** 允许在 Hover 里点击执行的命令（不开放任意命令，避免安全问题） */
const TRUSTED_COMMANDS = [
  'sigroute.reveal',
  'sigroute.gotoParentConn',
  'sigroute.traceAt',
  'sigroute.copyPath',
  'sigroute.findAliases',
];

export interface ProviderContext {
  indexer: WorkspaceIndexer;
  ensureIndex: () => Promise<void>;
}

interface CursorTarget {
  name: string;
  range: vscode.Range;
  module: ModuleDecl;
}

/** 取出光标下的标识符（排除数字字面量尾巴与宏名） */
export function wordAt(
  doc: vscode.TextDocument,
  position: vscode.Position,
): { name: string; range: vscode.Range } | undefined {
  const range = doc.getWordRangeAtPosition(position, IDENT_RE);
  if (!range) return undefined;
  const name = doc.getText(range);
  if (!name || /^\d/.test(name)) return undefined;
  const line = doc.lineAt(range.start.line).text;
  const before = range.start.character > 0 ? line[range.start.character - 1] : '';
  if (before === "'" || before === '`') return undefined;
  return { name, range };
}

async function resolveTarget(
  ctx: ProviderContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<CursorTarget | undefined> {
  const w = wordAt(doc, position);
  if (!w) return undefined;
  await ctx.ensureIndex();
  const mod = ctx.indexer.findModuleAt(doc.uri.fsPath, doc.offsetAt(position));
  if (!mod) return undefined;
  return { name: w.name, range: w.range, module: mod };
}

// ------------------------------------------------------------------ 悬停配置

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** 读取 sigroute.hover.* 设置 */
export function readHoverOptions(): HoverOptions {
  const cfg = vscode.workspace.getConfiguration('sigroute');
  const raw = cfg.get<string[]>('hover.sections', [...DEFAULT_HOVER_OPTIONS.sections]);
  const sections: HoverSection[] = [];
  for (const x of raw) {
    // 兼容用户把枚举写成 "hover.sections" 全文的情况
    const key = String(x).replace(/^sigroute\.hover\./, '').trim();
    if (isHoverSection(key) && !sections.includes(key)) sections.push(key);
  }
  return {
    sections: sections.length > 0 ? sections : [...DEFAULT_HOVER_OPTIONS.sections],
    maxRefs: clamp(cfg.get<number>('hover.maxRefs', DEFAULT_HOVER_OPTIONS.maxRefs), 1, 100),
    maxLines: clamp(cfg.get<number>('hover.maxLines', DEFAULT_HOVER_OPTIONS.maxLines), 4, 500),
    declSource: cfg.get<boolean>('hover.declSource', DEFAULT_HOVER_OPTIONS.declSource),
  };
}

// ------------------------------------------------------------------ 声明源码

/**
 * 声明行原文的读取与缓存。
 *
 * 悬停是高频操作，这里必须便宜：
 *   - 已经打开的文档直接取内存文本（还能反映未保存的修改），按 version 校验；
 *   - 磁盘文件读一次缓存下来（LRU，最多 8 个文件）。
 */
interface LineCacheEntry {
  version?: number;
  lines: string[];
}

const DECL_CACHE_MAX = 8;
const declLineCache = new Map<string, LineCacheEntry>();

function rememberLines(key: string, entry: LineCacheEntry): void {
  declLineCache.delete(key);
  declLineCache.set(key, entry);
  while (declLineCache.size > DECL_CACHE_MAX) {
    const oldest = declLineCache.keys().next().value;
    if (oldest === undefined) break;
    declLineCache.delete(oldest);
  }
}

async function linesOfFile(file: string): Promise<string[] | undefined> {
  const key = file.replace(/\\/g, '/');
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, file),
  );
  if (open) {
    const hit = declLineCache.get(key);
    if (hit && hit.version === open.version) return hit.lines;
    const lines = open.getText().split(/\r?\n/);
    rememberLines(key, { version: open.version, lines });
    return lines;
  }

  const cached = declLineCache.get(key);
  if (cached) return cached.lines;

  try {
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    const lines = Buffer.from(data).toString('utf8').split(/\r?\n/);
    rememberLines(key, { lines });
    return lines;
  } catch {
    return undefined;
  }
}

/** 只有注释的行（把声明上方的注释块一起带出来） */
function isCommentOnly(s: string): boolean {
  const t = s.trim();
  if (t === '') return false;
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

/**
 * 取声明处的源码片段：声明所在行 + 上方紧邻的注释行（最多 3 行）。
 * 这样在悬停里看到的就是"原封不动的源码"，包括注释与语法高亮。
 */
async function declSourceFor(decl: { file?: string; line?: number }): Promise<string | undefined> {
  if (!decl.file || decl.line === undefined || decl.line < 0) return undefined;
  const lines = await linesOfFile(decl.file);
  if (!lines || decl.line >= lines.length) return undefined;

  const out: string[] = [];
  let i = decl.line - 1;
  let comments = 0;
  while (i >= 0 && comments < 3) {
    if (!isCommentOnly(lines[i])) break;
    out.unshift(lines[i]);
    comments++;
    i--;
  }
  out.push(lines[decl.line]);
  return out.join('\n');
}

// ------------------------------------------------------------------ Hover

export class SigHoverProvider implements vscode.HoverProvider {
  private readonly ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.ctx = ctx;
  }

  async provideHover(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const cfg = vscode.workspace.getConfiguration('sigroute');
    if (!cfg.get<boolean>('hover.enabled', true)) return undefined;

    const target = await resolveTarget(this.ctx, doc, position);
    if (!target) return undefined;

    const { name, module: mod, range } = target;

    // 信号优先，其次当作模块名
    const desc = describeSignal(this.ctx.indexer, mod, name);
    const isSignal = !desc.notInModule || desc.decl.kind === 'submodule-port';

    const md = new vscode.MarkdownString();
    md.supportHtml = false;
    // 允许 Hover 中的命令链接被点击（只开放白名单命令）
    md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };

    if (isSignal) {
      const opts = readHoverOptions();
      // 声明那一行的原文（含上方注释），在 decl 小节里原样展示
      const src = opts.declSource ? await declSourceFor(desc.decl) : undefined;
      md.appendMarkdown(renderSignalHoverMarkdown(this.ctx.indexer, desc, name, opts, src));
    } else if (this.ctx.indexer.hasModule(name)) {
      renderModuleHover(md, this.ctx.indexer, name);
    } else {
      return undefined;
    }

    return new vscode.Hover(md, range);
  }
}

function renderModuleHover(md: vscode.MarkdownString, indexer: WorkspaceIndexer, name: string): void {
  const mod = indexer.getModule(name);
  if (!mod) return;
  const sites = indexer.getInstantiations(name);
  const blackboxIn = mod.instances.filter((i) => !indexer.hasModule(i.moduleType)).length;

  md.appendMarkdown(`**\`${name}\`**  \`module\`\n\n`);
  md.appendMarkdown(
    `- 端口 ${mod.ports.length} · 子模块例化 ${mod.instances.length}` +
      (blackboxIn > 0 ? `（其中 ${blackboxIn} 个未索引）` : '') +
      `\n`,
  );
  md.appendMarkdown(`- 被例化 ${sites.length} 次\n`);
  md.appendMarkdown(`- \`${mod.file}\`\n`);
}

// ------------------------------------------------------------------ 定义

/**
 * 在一行源码里定位标识符的列号。
 *
 * 声明记录里存的是「文件内字符偏移」，而跳转需要「行 + 列」：偏移跨行累加得猜
 * \n 还是 \r\n，差一格就落偏；而声明行（端口 / 信号 / 模块头）上标识符只出现一次，
 * 所以在行内按词边界查找更稳，也不依赖把整个文档读进来。
 *
 * 末尾两处的 `(?![A-Za-z0-9_$])` 防止把 `i_a` 匹配到 `i_a_bus` 里面去。
 */
export function identifierColumn(lineText: string, name: string): number {
  if (!lineText || !name) return 0;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|[^A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`).exec(lineText);
  if (m) return m.index + (m[1] ? m[1].length : 0);
  const i = lineText.indexOf(name);
  return i >= 0 ? i : 0;
}

/**
 * 定义目标包成 LocationLink。
 *
 * 不用 Location 的原因：Location 只有一个 range，跳过去光标停在 range 起点、
 * 闪烁高亮也盖在同一个 range 上；给「行首、零宽」的位置就等于"跳到了这一行但没有选中"。
 * LocationLink 的 targetSelectionRange 会被 VSCode 用作折叠后的选区 + 闪烁高亮范围
 * （见 gotoSymbol 的 _openReference），所以这里给标识符本身的精确范围。
 */
async function toDefinitionLink(
  file: string | undefined,
  line: number | undefined,
  name: string,
): Promise<vscode.LocationLink | null> {
  if (!file || line === undefined || line < 0) return null;
  const lines = await linesOfFile(file);
  const text = lines && line < lines.length ? lines[line] : '';
  const col = identifierColumn(text, name);
  return {
    targetUri: vscode.Uri.file(file),
    targetRange: new vscode.Range(line, 0, line, Math.max(text.length, col + name.length)),
    targetSelectionRange: new vscode.Range(line, col, line, col + name.length),
  };
}

export class SigDefinitionProvider implements vscode.DefinitionProvider {
  private readonly ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.ctx = ctx;
  }

  async provideDefinition(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.LocationLink[] | undefined> {
    const target = await resolveTarget(this.ctx, doc, position);
    if (!target) return undefined;
    const { name, module: mod } = target;

    const desc = describeSignal(this.ctx.indexer, mod, name);
    const decl = await toDefinitionLink(desc.decl.file, desc.decl.line, name);
    if (decl) return [decl];

    // 不是信号：当作模块名处理（例化处的模块名 → 模块定义的 module 头）
    const m = moduleLocation(this.ctx.indexer, name);
    if (m) {
      const link = await toDefinitionLink(m.file, m.line, name);
      if (link) return [link];
    }
    return undefined;
  }
}

function toLocation(
  file: string | undefined,
  line: number | undefined,
  offset?: number,
): vscode.Location | null {
  if (!file || line === undefined) return null;
  return new vscode.Location(vscode.Uri.file(file), new vscode.Position(line, 0));
}

// ------------------------------------------------------------------ 查找引用

export class SigReferenceProvider implements vscode.ReferenceProvider {
  private readonly ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.ctx = ctx;
  }

  async provideReferences(
    doc: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
  ): Promise<vscode.Location[]> {
    const target = await resolveTarget(this.ctx, doc, position);
    if (!target) return [];
    const { name, module: mod } = target;

    const desc = describeSignal(this.ctx.indexer, mod, name);
    const out: vscode.Location[] = [];

    if (context.includeDeclaration) {
      const decl = toLocation(desc.decl.file, desc.decl.line, desc.decl.offset);
      if (decl) out.push(decl);
    }
    for (const r of [...desc.drivers, ...desc.loads]) {
      out.push(new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(r.line, 0)));
    }

    // ---- 跨模块：同一物理网络在其它模块里的使用点 ----
    // 信号一旦改名，只查本模块等于只看到一半；这里把等价类里其它名字的使用点也找出来。
    const CROSS_LIMIT = 80;
    for (const a of desc.aliases) {
      if (out.length >= CROSS_LIMIT) break;
      if (a.module === mod.name) continue;
      const m = this.ctx.indexer.getModule(a.module);
      if (!m) continue;
      const other = describeSignal(this.ctx.indexer, m, a.net);
      for (const r of [...other.drivers, ...other.loads]) {
        // parent-conn 与本地结果重复（都是例化处），跳过
        if (r.kind === 'parent-conn') continue;
        out.push(new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(r.line, 0)));
        if (out.length >= CROSS_LIMIT) break;
      }
    }

    // 去重（同文件同一行可能出现多次）
    const seen = new Set<string>();
    return out.filter((l) => {
      const k = `${l.uri.fsPath}:${l.range.start.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}

// ------------------------------------------------------------------ 同文档高亮

/**
 * 标识符位置缓存。
 *
 * 背景：这个 provider 在**每一次光标移动**时都会被调用，
 * 而它原先每次都对整个文件跑一遍词法分析 —— 几千行的文件就足以让光标发涩。
 * 词法结果只跟"文档内容"有关，所以按 (uri, version) 缓存，版本变了才重算。
 */
interface IdentCacheEntry {
  version: number;
  /** 只保留标识符的位置与名字，体积远小于完整 token 列表 */
  idents: { value: string; start: number; end: number }[];
}

const HIGHLIGHT_CACHE_MAX = 8;
const identCache = new Map<string, IdentCacheEntry>();

function identsOf(doc: vscode.TextDocument): IdentCacheEntry {
  const key = doc.uri.toString();
  const hit = identCache.get(key);
  if (hit && hit.version === doc.version) {
    // LRU：命中后挪到末尾
    identCache.delete(key);
    identCache.set(key, hit);
    return hit;
  }

  // 用词法分析器而不是正则：能天然排除注释与字符串里的同名文本
  const lexed = lex(doc.getText(), { defines: new Set<string>(), honorIfdef: false });
  const entry: IdentCacheEntry = {
    version: doc.version,
    idents: [],
  };
  for (const t of lexed.tokens) {
    if (t.type !== TokType.Ident) continue;
    entry.idents.push({ value: t.value, start: t.start, end: t.end });
  }

  identCache.set(key, entry);
  while (identCache.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = identCache.keys().next().value;
    if (oldest === undefined) break;
    identCache.delete(oldest);
  }
  return entry;
}

export class SigDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
  provideDocumentHighlights(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.DocumentHighlight[] {
    const w = wordAt(doc, position);
    if (!w) return [];

    const entry = identsOf(doc);
    const out: vscode.DocumentHighlight[] = [];
    for (const t of entry.idents) {
      if (t.value !== w.name) continue;
      const start = doc.positionAt(t.start);
      const end = doc.positionAt(t.end);
      out.push(new vscode.DocumentHighlight(new vscode.Range(start, end)));
      if (out.length >= 400) break; // 极端情况下保护 UI
    }
    return out;
  }
}
