"use strict";
/**
 * `include 内联
 *
 * 动机：Xilinx 工程里大量使用 "把端口列表/参数/宏放在 .vh，再 include 进模块" 的写法，
 * 甚至把模块体拆成几个片段文件。原先 include 只用于收集宏，
 * 于是这些模块的端口解析会缺一块（端口方向、位宽、例化连接都对不上）。
 *
 * 本模块把 `include 的内容原地拼进文本再交给解析器，并**记录位置映射**：
 *   - 拼接后文本中，落在被替换区间之外的位置 → 精确映射回原文件偏移
 *   - 落在被替换区间之内（也就是来自 .vh 的内容）→ 统一折叠到 `include 指令行
 *
 * 折叠是刻意的取舍：端口列表写在 .vh 里时，"这个端口来自哪"最自然的答案是
 * "来自这个 include"，而不是 .vh 的第几行 —— 后者需要给每个数据结构都加上文件名，
 * 收益不足以支撑那一圈改动。折叠保证了**任何坐标都不会指向错误的文件**。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inlineIncludes = inlineIncludes;
exports.createOffsetMapper = createOffsetMapper;
exports.lineStarts = lineStarts;
exports.lineAt = lineAt;
exports.remapModulePositions = remapModulePositions;
const INCLUDE_LINE = /^[ \t]*`include[ \t]*["<]([^">\r\n]+)[">]/;
const HAS_MODULE = /(^|[^A-Za-z0-9_$])module([^A-Za-z0-9_$]|$)/;
/**
 * 把每一行的注释替换成等长空格（保持列偏移不变），
 * 这样正则匹配到的位置可以直接当作原始位置使用。
 */
function maskComments(line, inBlock) {
    let out = '';
    let i = 0;
    let block = inBlock;
    while (i < line.length) {
        if (block) {
            const close = line.indexOf('*/', i);
            if (close < 0) {
                out += ' '.repeat(line.length - i);
                i = line.length;
            }
            else {
                out += ' '.repeat(close + 2 - i);
                i = close + 2;
                block = false;
            }
            continue;
        }
        if (line[i] === '/' && line[i + 1] === '*') {
            out += '  ';
            i += 2;
            block = true;
            continue;
        }
        if (line[i] === '/' && line[i + 1] === '/') {
            out += ' '.repeat(line.length - i);
            i = line.length;
            continue;
        }
        out += line[i];
        i++;
    }
    return { mask: out, inBlock: block };
}
/**
 * 执行内联。没有可内联的内容时原样返回，且 `segments` 为空 ——
 * 调用方因此可以完全跳过位置重映射（零风险路径）。
 */
function inlineIncludes(text, file, opts) {
    const maxBytes = opts.maxBytes ?? 512 * 1024;
    const segments = [];
    const skipped = [];
    let out = '';
    let cursor = 0;
    let inBlock = false;
    let count = 0;
    let line = 0;
    let pos = 0;
    while (pos < text.length) {
        const nl = text.indexOf('\n', pos);
        const hasEol = nl >= 0;
        const lineEnd = hasEol ? nl : text.length;
        const contentEnd = hasEol && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
        const content = text.slice(pos, contentEnd);
        const eol = hasEol ? text.slice(contentEnd, lineEnd + 1) : '';
        const masked = maskComments(content, inBlock);
        inBlock = masked.inBlock;
        const m = INCLUDE_LINE.exec(masked.mask);
        let replaced = false;
        if (m) {
            const name = m[1].trim();
            const hit = opts.resolve(name, file);
            if (hit &&
                hit.text.length <= maxBytes &&
                !HAS_MODULE.test(hit.text) &&
                !/`include/.test(hit.text)) {
                const body = hit.text.replace(/[\r\n]+$/, '');
                out += text.slice(cursor, pos);
                const segStart = out.length;
                out += body;
                segments.push({
                    start: segStart,
                    end: out.length,
                    origStart: pos,
                    origEnd: pos + content.length,
                    origLine: line,
                    from: hit.file,
                });
                out += eol;
                cursor = lineEnd + (hasEol ? 1 : 0);
                count++;
                replaced = true;
            }
            else if (!hit) {
                skipped.push(`${name}（未找到）`);
            }
            else if (HAS_MODULE.test(hit.text)) {
                skipped.push(`${name}（内含 module 定义，不内联）`);
            }
            else if (/`include/.test(hit.text)) {
                skipped.push(`${name}（嵌套 include，不内联）`);
            }
            else {
                skipped.push(`${name}（文件过大，不内联）`);
            }
        }
        void replaced;
        if (!hasEol)
            break;
        pos = lineEnd + 1;
        line++;
    }
    if (count === 0)
        return { text, segments: [], count: 0, skipped };
    out += text.slice(cursor);
    return { text: out, segments, count, skipped };
}
/**
 * 构造"拼接后偏移 → 原文件偏移"的映射函数。
 * 段落数量很小（一个文件通常个位数），直接顺序扫描即可，无需二分。
 */
function createOffsetMapper(segments) {
    if (segments.length === 0)
        return (o) => o;
    return (offset) => {
        let shift = 0;
        for (const seg of segments) {
            if (offset < seg.start)
                break;
            if (offset < seg.end)
                return seg.origStart;
            shift += seg.end - seg.start - (seg.origEnd - seg.origStart);
        }
        return Math.max(0, offset - shift);
    };
}
/** 原文本的行首偏移表（配合 lineAt 使用） */
function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n')
            starts.push(i + 1);
    }
    return starts;
}
/** 由偏移求 0-based 行号 */
function lineAt(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    if (offset <= 0)
        return 0;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lo;
}
/**
 * 把解析结果里所有位置字段从"拼接文本坐标"搬回"原文件坐标"。
 * 只在确实发生了内联时调用 —— 未内联的文件完全不经过这条路径，
 * 因此不会影响原有的偏移精度（tools/verify.mjs --offsets 校验的就是这个）。
 */
function remapModulePositions(mod, mapOffset, starts) {
    /**
     * 注意：`starts` 是**原文件**的行首表，所以行号必须用映射后的偏移去查 ——
     * 用拼接文本坐标查会（在内联点之后）整体偏移。
     */
    const remap = (offset, line) => {
        if (typeof offset !== 'number' || offset < 0) {
            return { off: offset ?? -1, line: line ?? 0 };
        }
        const off = mapOffset(offset);
        return { off, line: lineAt(starts, off) };
    };
    for (const p of mod.ports) {
        const r = remap(p.offset, p.line);
        p.offset = r.off;
        p.line = r.line;
    }
    for (const inst of mod.instances) {
        const s = remap(inst.start, inst.line);
        inst.start = s.off;
        inst.line = s.line;
        inst.end = remap(inst.end, undefined).off;
        for (const c of inst.connections) {
            const cs = remap(c.start, c.line);
            c.start = cs.off;
            c.line = cs.line;
            c.end = remap(c.end, undefined).off;
            if (c.netOffset !== null)
                c.netOffset = remap(c.netOffset, undefined).off;
        }
    }
    for (const a of mod.assigns) {
        a.line = remap(a.lhsOffsets[0], a.line).line;
        a.lhsOffsets = a.lhsOffsets.map((o) => remap(o, undefined).off);
        a.rhsOffsets = a.rhsOffsets.map((o) => remap(o, undefined).off);
    }
    for (const ab of mod.alwaysBlocks) {
        const r = remap(ab.offset, ab.line);
        ab.offset = r.off;
        ab.line = r.line;
        for (const st of ab.statements) {
            st.line = remap(st.lhsOffsets[0] ?? st.readOffsets[0], st.line).line;
            st.lhsOffsets = st.lhsOffsets.map((o) => remap(o, undefined).off);
            st.readOffsets = st.readOffsets.map((o) => remap(o, undefined).off);
        }
    }
    for (const [, sig] of mod.signals) {
        if (sig.offset < 0)
            continue;
        const r = remap(sig.offset, sig.line);
        sig.offset = r.off;
        sig.line = r.line;
    }
    const ms = remap(mod.start, mod.headerLine);
    mod.start = ms.off;
    mod.headerLine = ms.line;
    const me = remap(mod.end, mod.endLine);
    mod.end = Math.max(mod.start, me.off);
    mod.endLine = me.line;
}
//# sourceMappingURL=inline.js.map