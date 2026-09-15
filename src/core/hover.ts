/**
 * 悬停速查的内容渲染（纯字符串，不依赖 vscode）
 *
 * 抽到 core 里的原因：
 *   1. 内容要不要显示、显示多少，完全由配置决定 —— 这部分是纯逻辑，应该可测；
 *   2. providers.ts 只负责把它包成 MarkdownString，不再混着拼 Markdown。
 *
 * 配置语义（对应 sigroute.hover.*）：
 *   sections —— 显示哪些小节，顺序即显示顺序
 *   maxRefs  —— 每一节最多列几条
 *   maxLines —— 整个信息框的行数上限，超了按节截断并给出提示
 */

import { locText } from './describe';
import type { SignalDescription, SignalRef } from './describe';
import { hierarchyPaths, primaryPath } from './hierarchy';
import type { WorkspaceIndexer } from './indexer';

/** 可显示的小节（顺序即默认显示顺序） */
export const HOVER_SECTIONS = ['decl', 'drivers', 'loads', 'parent', 'path', 'aliases'] as const;
export type HoverSection = (typeof HOVER_SECTIONS)[number];

export const HOVER_SECTION_LABEL: Record<HoverSection, string> = {
  decl: '声明（模块 / 位置）',
  drivers: '驱动源（在哪个模块产生）',
  loads: '负载（流向哪个模块）',
  parent: '上级模块连接（跳出本模块的接口）',
  path: '层次路径',
  aliases: '同网络别名（改名反查）',
};

export interface HoverOptions {
  sections: HoverSection[];
  maxRefs: number;
  maxLines: number;
  /** 在 decl 小节里原样贴出声明所在的源码（含高亮与注释） */
  declSource: boolean;
}

export const DEFAULT_HOVER_OPTIONS: HoverOptions = {
  sections: [...HOVER_SECTIONS],
  maxRefs: 12,
  maxLines: 40,
  declSource: true,
};

export function isHoverSection(v: string): v is HoverSection {
  return (HOVER_SECTIONS as readonly string[]).includes(v);
}

// ------------------------------------------------------------------ 小工具

/** 生成一个可点击的命令链接 */
function cmdLink(command: string, args: unknown[], label: string): string {
  const q = encodeURIComponent(JSON.stringify(args));
  return `[${label}](command:${command}?${q})`;
}

/** 位置文本 → 可点击跳转链接 */
function locLink(file: string, line: number, offset: number | undefined, name: string): string {
  return cmdLink('sigroute.reveal', [file, line, offset, name], escapeLinkText(locText(file, line)));
}

/** Markdown 链接文字里的 [ ] ( ) \ 必须转义，否则链接会断裂 */
function escapeLinkText(s: string): string {
  return s.replace(/([\\[\]()])/g, '\\$1');
}

function safeCode(s: string): string {
  return String(s).replace(/`/g, "'");
}

function plainNameOf(s: string): string | undefined {
  const t = String(s).trim();
  const tail = /([A-Za-z_][A-Za-z0-9_$]*)\s*$/.exec(t);
  const head = /^([A-Za-z_][A-Za-z0-9_$]*)/.exec(t);
  return (tail ?? head)?.[1];
}

function dedupeRefs(refs: SignalRef[]): SignalRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.file}:${r.line}:${r.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function declBadge(d: SignalDescription): string {
  const bits: string[] = [];
  if (d.decl.direction) bits.push(d.decl.direction);
  else if (d.decl.signalKind && d.decl.kind === 'signal') bits.push(d.decl.signalKind);
  if (d.decl.range) bits.push(d.decl.range);
  if (d.decl.width !== null && d.decl.width !== undefined) bits.push(`${d.decl.width} bit`);
  return bits.length > 0 ? `  \`${bits.join(' ')}\`` : '';
}

/** 别名在源码里的位置（端口声明 / 内部信号声明 / 模块头） */
function aliasLoc(
  indexer: WorkspaceIndexer,
  moduleName: string,
  net: string,
): { file?: string; line?: number; offset?: number } {
  const mod = indexer.getModule(moduleName);
  if (!mod) return {};
  const p = mod.ports.find((x) => x.name === net);
  if (p) return { file: mod.file, line: p.line, offset: p.offset };
  const s = mod.signals.get(net);
  if (s) return { file: mod.file, line: s.line, offset: s.offset >= 0 ? s.offset : undefined };
  return { file: mod.file, line: mod.headerLine };
}

/** 代码块的语言标记：尽量让编辑器用对高亮规则 */
function fenceLang(file: string | undefined): string {
  return file && /\.(sv|svh)$/i.test(file) ? 'systemverilog' : 'verilog';
}

/** 过长的行截断，避免一屏都是横向滚动 */
function clipLine(s: string, max = 200): string {
  const t = s.replace(/\s+$/, '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 把源码片段包成带语言标记的代码块（编辑器会做语法高亮） */
function codeBlock(source: string, file: string | undefined): string {
  const body = source
    .split('\n')
    .map((l) => clipLine(l))
    .join('\n');
  return '```' + fenceLang(file) + '\n' + body + '\n```\n\n';
}

/** 一节引用列表（驱动源 / 负载 / 上级连接） */
function refSection(
  title: string,
  hint: string,
  refs: SignalRef[],
  fallbackName: string,
  maxRefs: number,
  emptyNote: string,
): string {
  const shown = refs.slice(0, maxRefs);
  const lines: string[] = [`**${title}** (${refs.length}) — ${hint}\n`];
  if (refs.length === 0) {
    lines.push(`${emptyNote}\n`);
    return lines.join('\n');
  }
  for (const r of shown) {
    const link = locLink(r.file, r.line, r.offset, plainNameOf(r.text) ?? fallbackName);
    const detail = r.detail ? ` — ${r.detail}` : '';
    lines.push(`- \`${safeCode(r.text)}\`${detail} · ${link}`);
  }
  if (refs.length > shown.length) {
    lines.push(`- _…另有 ${refs.length - shown.length} 条（调大 sigroute.hover.maxRefs 可看更多）_`);
  }
  return `${lines.join('\n')}\n\n`;
}

// ------------------------------------------------------------------ 主渲染

/**
 * 渲染信号的悬停内容。
 *
 * 行数预算按"节"扣减：某一节放不下就整体不显示，并在末尾给一句提示 ——
 * 这样信息框不会出现"半截图"式的残缺。
 */
export function renderSignalHoverMarkdown(
  indexer: WorkspaceIndexer,
  d: SignalDescription,
  name: string,
  opts: Partial<HoverOptions> = {},
  /** 声明处的原始源码（含上方紧邻的注释行），由调用方读取后传进来 */
  declSource?: string,
): string {
  const sections =
    opts.sections && opts.sections.length > 0 ? opts.sections : DEFAULT_HOVER_OPTIONS.sections;
  const maxRefs = Math.max(1, opts.maxRefs ?? DEFAULT_HOVER_OPTIONS.maxRefs);
  const maxLines = Math.max(4, opts.maxLines ?? DEFAULT_HOVER_OPTIONS.maxLines);

  const out: string[] = [];
  let used = 0;
  let truncated = false;

  /** 按行数预算追加一段（放不下返回 false） */
  const push = (text: string): boolean => {
    const cost = text.split('\n').length;
    if (used + cost > maxLines) {
      truncated = true;
      return false;
    }
    out.push(text);
    used += cost;
    return true;
  };

  // 标题永远显示：没有它，信息框就没有主语
  out.push(`**\`${safeCode(d.name)}\`**${declBadge(d)}\n\n`);
  used += 3;

  if (d.decl.kind === 'unknown') {
    push(`未在模块 \`${d.moduleName}\` 中找到该名字的声明。\n`);
    return out.join('');
  }

  const innerDrivers = d.drivers.filter((r) => r.kind !== 'parent-conn');
  const innerLoads = d.loads.filter((r) => r.kind !== 'parent-conn');
  const outer = dedupeRefs([...d.drivers, ...d.loads].filter((r) => r.kind === 'parent-conn'));

  for (const section of sections) {
    if (truncated) break;
    switch (section) {
      case 'decl': {
        const declLink =
          d.decl.file && d.decl.line !== undefined
            ? locLink(d.decl.file, d.decl.line, d.decl.offset, name)
            : '';
        if (d.decl.kind === 'submodule-port') {
          push(
            `模块 \`${d.decl.subModule}\` 的端口（实例 \`${d.decl.instanceName}\`）` +
              (declLink ? ` · 声明于 ${declLink}` : '') +
              `\n\n`,
          );
        } else {
          push(
            `\`${d.moduleName}\` 中的 ${d.decl.kind === 'port' ? '端口' : '内部信号'}` +
              (declLink ? ` · 声明于 ${declLink}` : '') +
              `\n\n`,
          );
        }
        // 声明那一行原样贴出来（连同上方的注释）：带语法高亮，所见即源码。
        // 这一块不计入"放不下就整节不显示"的判断 —— 它是信息框的主体信息。
        if (opts.declSource !== false && declSource && declSource.trim() !== '') {
          const block = codeBlock(declSource, d.decl.file);
          out.push(block);
          used += block.split('\n').length;
        }
        break;
      }

      case 'drivers':
        push(
          refSection('驱动源', '在哪个模块产生', innerDrivers, name, maxRefs, '_未发现直接驱动源_'),
        );
        break;

      case 'loads':
        push(refSection('负载', '流向哪个模块', innerLoads, name, maxRefs, '_未发现直接负载_'));
        break;

      case 'parent':
        if (outer.length > 0) {
          push(refSection('上级模块连接', '跳出本模块的接口', outer, name, maxRefs, '_无_'));
        }
        break;

      case 'path': {
        const paths = hierarchyPaths(indexer, d.moduleName, name, { maxPaths: Math.min(maxRefs, 6) });
        const prim = primaryPath(paths);
        if (!prim) break;
        const extra = paths.length > 1 ? `（共 ${paths.length} 条可能的层次路径）` : '';
        const lines: string[] = [`**层次路径** ${extra}`];
        lines.push(`- \`${safeCode(prim.text)}\` · ${cmdLink('sigroute.copyPath', [prim.text], '复制')}`);
        for (const p of paths.filter((x) => x.text !== prim.text).slice(0, 2)) {
          lines.push(`- \`${safeCode(p.text)}\` · ${cmdLink('sigroute.copyPath', [p.text], '复制')}`);
        }
        push(`${lines.join('\n')}\n\n`);
        break;
      }

      case 'aliases': {
        if (d.aliases.length === 0) break;
        const lines: string[] = [`**同网络别名** (${d.aliases.length}) — 这根线在别处叫什么`];
        for (const a of d.aliases.slice(0, maxRefs)) {
          const loc = aliasLoc(indexer, a.module, a.net);
          const dirText = a.direction ? ` \`${a.direction}\`` : '';
          const link =
            loc.file && loc.line !== undefined
              ? ` · ${locLink(loc.file, loc.line, loc.offset, a.net)}`
              : '';
          lines.push(`- \`${safeCode(`${a.module}.${a.net}`)}\`${dirText}${link}`);
        }
        if (d.aliases.length > maxRefs) {
          lines.push(`- _…另有 ${d.aliases.length - maxRefs} 条（调大 sigroute.hover.maxRefs 可看更多）_`);
        }
        push(`${lines.join('\n')}\n\n`);
        break;
      }

      default:
        break;
    }
  }

  if (
    sections.includes('drivers') &&
    sections.includes('loads') &&
    innerDrivers.length === 0 &&
    innerLoads.length === 0 &&
    outer.length === 0
  ) {
    push(`_未发现直接的驱动或负载（可能声明不完整或属于 IP 内部）_\n\n`);
  }

  if (truncated) {
    push(`_…（已达悬停行数上限 ${maxLines} 行，可在设置 sigroute.hover.maxLines 调整）_\n`);
  }

  return out.join('');
}
