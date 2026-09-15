"use strict";
/**
 * 索引持久化
 *
 * 动机：每次打开 VSCode（或重载窗口）都要重新解析几百上千个文件 ——
 * 实测 551 文件约 1 秒，工程再大就是好几秒的等待。
 * 索引本身是纯数据，把它连同"文件指纹"一起落盘，下次启动只要指纹没变就直接接管。
 *
 * 缓存键 = 解析器版本 + 影响解析的配置 + 全部文件的 (路径, mtime, size)。
 * 任何一项对不上就退回全量重建 —— 缓存永远不能比重新解析更"旧"。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CACHE_VERSION = void 0;
exports.serializeIndex = serializeIndex;
exports.deserializeIndex = deserializeIndex;
exports.optionsFingerprint = optionsFingerprint;
exports.sameFileSet = sameFileSet;
/**
 * 解析结果结构发生变化时必须 +1，否则会读到旧结构。
 * v3：AlwaysBlock 增加 readRefs（块内标识符的位置）。
 * v4：always/initial 体按整条语句收尾（if/else、case 直接当语句体不再被截断）；
 *     声明初值 `wire x = expr;` 计入数据流（AssignStmt.inline）。
 */
exports.CACHE_VERSION = 4;
/** Map / Set 感知的结构化编码（索引里大量使用 Map） */
function encode(v) {
    if (v instanceof Map) {
        return { __map: [...v.entries()].map(([k, val]) => [k, encode(val)]) };
    }
    if (v instanceof Set) {
        return { __set: [...v].map((x) => encode(x)) };
    }
    if (Array.isArray(v))
        return v.map(encode);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v))
            out[k] = encode(val);
        return out;
    }
    return v;
}
function decode(v) {
    if (Array.isArray(v))
        return v.map(decode);
    if (v && typeof v === 'object') {
        const o = v;
        if (Array.isArray(o.__map)) {
            const m = new Map();
            for (const pair of o.__map)
                m.set(pair[0], decode(pair[1]));
            return m;
        }
        if (Array.isArray(o.__set)) {
            const s = new Set();
            for (const x of o.__set)
                s.add(decode(x));
            return s;
        }
        const out = {};
        for (const [k, val] of Object.entries(o))
            out[k] = decode(val);
        return out;
    }
    return v;
}
function serializeIndex(index) {
    return encode(index);
}
function deserializeIndex(data) {
    try {
        const idx = decode(data);
        if (!idx || !(idx.modules instanceof Map) || !(idx.fileModules instanceof Map))
            return null;
        if (!(idx.instantiations instanceof Map))
            return null;
        if (!Array.isArray(idx.topCandidates))
            return null;
        if (!idx.stats || typeof idx.stats.fileCount !== 'number')
            return null;
        return idx;
    }
    catch {
        return null;
    }
}
/** 配置指纹：任何影响解析结果的配置都必须参与 */
function optionsFingerprint(opts) {
    return JSON.stringify([
        opts.honorIfdef,
        opts.inlineIncludes,
        opts.maxInstancesPerModule,
        [...opts.extraDefines].sort(),
        [...opts.undefines].sort(),
    ]);
}
/** 文件指纹是否与缓存完全一致（数量、路径、时间戳、大小） */
function sameFileSet(cached, current) {
    if (cached.length !== current.length)
        return false;
    const map = new Map(cached.map((f) => [f.path, f]));
    for (const c of current) {
        const old = map.get(c.path);
        if (!old)
            return false;
        if (old.size !== c.size)
            return false;
        // 时间戳用毫秒比较，容差 1ms 规避文件系统精度差异
        if (Math.abs(old.mtimeMs - c.mtimeMs) > 1)
            return false;
    }
    return true;
}
//# sourceMappingURL=cache.js.map