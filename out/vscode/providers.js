"use strict";
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
exports.SigDocumentHighlightProvider = exports.SigReferenceProvider = exports.SigDefinitionProvider = exports.SigHoverProvider = exports.VERILOG_SELECTOR = void 0;
exports.wordAt = wordAt;
exports.readHoverOptions = readHoverOptions;
exports.identifierColumn = identifierColumn;
const vscode = __importStar(require("vscode"));
const describe_1 = require("../core/describe");
const hover_1 = require("../core/hover");
const lexer_1 = require("../core/lexer");
const fsProvider_1 = require("./fsProvider");
exports.VERILOG_SELECTOR = [
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
/** 取出光标下的标识符（排除数字字面量尾巴与宏名） */
function wordAt(doc, position) {
    const range = doc.getWordRangeAtPosition(position, IDENT_RE);
    if (!range)
        return undefined;
    const name = doc.getText(range);
    if (!name || /^\d/.test(name))
        return undefined;
    const line = doc.lineAt(range.start.line).text;
    const before = range.start.character > 0 ? line[range.start.character - 1] : '';
    if (before === "'" || before === '`')
        return undefined;
    return { name, range };
}
async function resolveTarget(ctx, doc, position) {
    const w = wordAt(doc, position);
    if (!w)
        return undefined;
    await ctx.ensureIndex();
    const mod = ctx.indexer.findModuleAt(doc.uri.fsPath, doc.offsetAt(position));
    if (!mod)
        return undefined;
    return { name: w.name, range: w.range, module: mod };
}
// ------------------------------------------------------------------ 悬停配置
function clamp(v, lo, hi) {
    if (!Number.isFinite(v))
        return lo;
    return Math.min(hi, Math.max(lo, Math.round(v)));
}
/** 读取 sigroute.hover.* 设置 */
function readHoverOptions() {
    const cfg = vscode.workspace.getConfiguration('sigroute');
    const raw = cfg.get('hover.sections', [...hover_1.DEFAULT_HOVER_OPTIONS.sections]);
    const sections = [];
    for (const x of raw) {
        // 兼容用户把枚举写成 "hover.sections" 全文的情况
        const key = String(x).replace(/^sigroute\.hover\./, '').trim();
        if ((0, hover_1.isHoverSection)(key) && !sections.includes(key))
            sections.push(key);
    }
    return {
        sections: sections.length > 0 ? sections : [...hover_1.DEFAULT_HOVER_OPTIONS.sections],
        maxRefs: clamp(cfg.get('hover.maxRefs', hover_1.DEFAULT_HOVER_OPTIONS.maxRefs), 1, 100),
        maxLines: clamp(cfg.get('hover.maxLines', hover_1.DEFAULT_HOVER_OPTIONS.maxLines), 4, 500),
        declSource: cfg.get('hover.declSource', hover_1.DEFAULT_HOVER_OPTIONS.declSource),
    };
}
const DECL_CACHE_MAX = 8;
const declLineCache = new Map();
function rememberLines(key, entry) {
    declLineCache.delete(key);
    declLineCache.set(key, entry);
    while (declLineCache.size > DECL_CACHE_MAX) {
        const oldest = declLineCache.keys().next().value;
        if (oldest === undefined)
            break;
        declLineCache.delete(oldest);
    }
}
async function linesOfFile(file) {
    const key = file.replace(/\\/g, '/');
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && (0, fsProvider_1.samePath)(d.uri.fsPath, file));
    if (open) {
        const hit = declLineCache.get(key);
        if (hit && hit.version === open.version)
            return hit.lines;
        const lines = open.getText().split(/\r?\n/);
        rememberLines(key, { version: open.version, lines });
        return lines;
    }
    const cached = declLineCache.get(key);
    if (cached)
        return cached.lines;
    try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
        const lines = Buffer.from(data).toString('utf8').split(/\r?\n/);
        rememberLines(key, { lines });
        return lines;
    }
    catch {
        return undefined;
    }
}
/** 只有注释的行（把声明上方的注释块一起带出来） */
function isCommentOnly(s) {
    const t = s.trim();
    if (t === '')
        return false;
    return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}
/**
 * 取声明处的源码片段：声明所在行 + 上方紧邻的注释行（最多 3 行）。
 * 这样在悬停里看到的就是"原封不动的源码"，包括注释与语法高亮。
 */
async function declSourceFor(decl) {
    if (!decl.file || decl.line === undefined || decl.line < 0)
        return undefined;
    const lines = await linesOfFile(decl.file);
    if (!lines || decl.line >= lines.length)
        return undefined;
    const out = [];
    let i = decl.line - 1;
    let comments = 0;
    while (i >= 0 && comments < 3) {
        if (!isCommentOnly(lines[i]))
            break;
        out.unshift(lines[i]);
        comments++;
        i--;
    }
    out.push(lines[decl.line]);
    return out.join('\n');
}
// ------------------------------------------------------------------ Hover
class SigHoverProvider {
    constructor(ctx) {
        this.ctx = ctx;
    }
    async provideHover(doc, position) {
        const cfg = vscode.workspace.getConfiguration('sigroute');
        if (!cfg.get('hover.enabled', true))
            return undefined;
        const target = await resolveTarget(this.ctx, doc, position);
        if (!target)
            return undefined;
        const { name, module: mod, range } = target;
        // 信号优先，其次当作模块名
        const desc = (0, describe_1.describeSignal)(this.ctx.indexer, mod, name);
        const isSignal = !desc.notInModule || desc.decl.kind === 'submodule-port';
        const md = new vscode.MarkdownString();
        md.supportHtml = false;
        // 允许 Hover 中的命令链接被点击（只开放白名单命令）
        md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
        if (isSignal) {
            const opts = readHoverOptions();
            // 声明那一行的原文（含上方注释），在 decl 小节里原样展示
            const src = opts.declSource ? await declSourceFor(desc.decl) : undefined;
            md.appendMarkdown((0, hover_1.renderSignalHoverMarkdown)(this.ctx.indexer, desc, name, opts, src));
        }
        else if (this.ctx.indexer.hasModule(name)) {
            renderModuleHover(md, this.ctx.indexer, name);
        }
        else {
            return undefined;
        }
        return new vscode.Hover(md, range);
    }
}
exports.SigHoverProvider = SigHoverProvider;
function renderModuleHover(md, indexer, name) {
    const mod = indexer.getModule(name);
    if (!mod)
        return;
    const sites = indexer.getInstantiations(name);
    const blackboxIn = mod.instances.filter((i) => !indexer.hasModule(i.moduleType)).length;
    md.appendMarkdown(`**\`${name}\`**  \`module\`\n\n`);
    md.appendMarkdown(`- 端口 ${mod.ports.length} · 子模块例化 ${mod.instances.length}` +
        (blackboxIn > 0 ? `（其中 ${blackboxIn} 个未索引）` : '') +
        `\n`);
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
function identifierColumn(lineText, name) {
    if (!lineText || !name)
        return 0;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(^|[^A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`).exec(lineText);
    if (m)
        return m.index + (m[1] ? m[1].length : 0);
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
async function toDefinitionLink(file, line, name) {
    if (!file || line === undefined || line < 0)
        return null;
    const lines = await linesOfFile(file);
    const text = lines && line < lines.length ? lines[line] : '';
    const col = identifierColumn(text, name);
    return {
        targetUri: vscode.Uri.file(file),
        targetRange: new vscode.Range(line, 0, line, Math.max(text.length, col + name.length)),
        targetSelectionRange: new vscode.Range(line, col, line, col + name.length),
    };
}
class SigDefinitionProvider {
    constructor(ctx) {
        this.ctx = ctx;
    }
    async provideDefinition(doc, position) {
        const target = await resolveTarget(this.ctx, doc, position);
        if (!target)
            return undefined;
        const { name, module: mod } = target;
        const desc = (0, describe_1.describeSignal)(this.ctx.indexer, mod, name);
        const decl = await toDefinitionLink(desc.decl.file, desc.decl.line, name);
        if (decl)
            return [decl];
        // 不是信号：当作模块名处理（例化处的模块名 → 模块定义的 module 头）
        const m = (0, describe_1.moduleLocation)(this.ctx.indexer, name);
        if (m) {
            const link = await toDefinitionLink(m.file, m.line, name);
            if (link)
                return [link];
        }
        return undefined;
    }
}
exports.SigDefinitionProvider = SigDefinitionProvider;
function toLocation(file, line, offset) {
    if (!file || line === undefined)
        return null;
    return new vscode.Location(vscode.Uri.file(file), new vscode.Position(line, 0));
}
// ------------------------------------------------------------------ 查找引用
class SigReferenceProvider {
    constructor(ctx) {
        this.ctx = ctx;
    }
    async provideReferences(doc, position, context) {
        const target = await resolveTarget(this.ctx, doc, position);
        if (!target)
            return [];
        const { name, module: mod } = target;
        const desc = (0, describe_1.describeSignal)(this.ctx.indexer, mod, name);
        const out = [];
        if (context.includeDeclaration) {
            const decl = toLocation(desc.decl.file, desc.decl.line, desc.decl.offset);
            if (decl)
                out.push(decl);
        }
        for (const r of [...desc.drivers, ...desc.loads]) {
            out.push(new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(r.line, 0)));
        }
        // ---- 跨模块：同一物理网络在其它模块里的使用点 ----
        // 信号一旦改名，只查本模块等于只看到一半；这里把等价类里其它名字的使用点也找出来。
        const CROSS_LIMIT = 80;
        for (const a of desc.aliases) {
            if (out.length >= CROSS_LIMIT)
                break;
            if (a.module === mod.name)
                continue;
            const m = this.ctx.indexer.getModule(a.module);
            if (!m)
                continue;
            const other = (0, describe_1.describeSignal)(this.ctx.indexer, m, a.net);
            for (const r of [...other.drivers, ...other.loads]) {
                // parent-conn 与本地结果重复（都是例化处），跳过
                if (r.kind === 'parent-conn')
                    continue;
                out.push(new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(r.line, 0)));
                if (out.length >= CROSS_LIMIT)
                    break;
            }
        }
        // 去重（同文件同一行可能出现多次）
        const seen = new Set();
        return out.filter((l) => {
            const k = `${l.uri.fsPath}:${l.range.start.line}`;
            if (seen.has(k))
                return false;
            seen.add(k);
            return true;
        });
    }
}
exports.SigReferenceProvider = SigReferenceProvider;
const HIGHLIGHT_CACHE_MAX = 8;
const identCache = new Map();
function identsOf(doc) {
    const key = doc.uri.toString();
    const hit = identCache.get(key);
    if (hit && hit.version === doc.version) {
        // LRU：命中后挪到末尾
        identCache.delete(key);
        identCache.set(key, hit);
        return hit;
    }
    // 用词法分析器而不是正则：能天然排除注释与字符串里的同名文本
    const lexed = (0, lexer_1.lex)(doc.getText(), { defines: new Set(), honorIfdef: false });
    const entry = {
        version: doc.version,
        idents: [],
    };
    for (const t of lexed.tokens) {
        if (t.type !== lexer_1.TokType.Ident)
            continue;
        entry.idents.push({ value: t.value, start: t.start, end: t.end });
    }
    identCache.set(key, entry);
    while (identCache.size > HIGHLIGHT_CACHE_MAX) {
        const oldest = identCache.keys().next().value;
        if (oldest === undefined)
            break;
        identCache.delete(oldest);
    }
    return entry;
}
class SigDocumentHighlightProvider {
    provideDocumentHighlights(doc, position) {
        const w = wordAt(doc, position);
        if (!w)
            return [];
        const entry = identsOf(doc);
        const out = [];
        for (const t of entry.idents) {
            if (t.value !== w.name)
                continue;
            const start = doc.positionAt(t.start);
            const end = doc.positionAt(t.end);
            out.push(new vscode.DocumentHighlight(new vscode.Range(start, end)));
            if (out.length >= 400)
                break; // 极端情况下保护 UI
        }
        return out;
    }
}
exports.SigDocumentHighlightProvider = SigDocumentHighlightProvider;
//# sourceMappingURL=providers.js.map