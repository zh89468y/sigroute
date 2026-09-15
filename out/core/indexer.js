"use strict";
/**
 * 工作区索引器
 *
 * 刻意与 VSCode API 解耦（通过 FileProvider 抽象），这样可以：
 *   1. 用纯 Node 脚本对真实工程跑批，量化解析准确率
 *   2. 将来换成 ripgrep / 语言服务器后端而不动上层逻辑
 *
 * 索引产物：
 *   - 模块表 / 文件→模块 / 模块→例化点反查（跨模块追踪的基础）
 *   - 网络等价类（"同一根线在不同模块里叫什么"，即改名反查）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceIndexer = void 0;
exports.emptyIndex = emptyIndex;
exports.normalizePath = normalizePath;
exports.looksNonTextual = looksNonTextual;
const parser_1 = require("./parser");
const nets_1 = require("./nets");
class WorkspaceIndexer {
    constructor() {
        this.index = emptyIndex();
        this.options = {
            honorIfdef: true,
            maxInstancesPerModule: 200,
            extraDefines: [],
            undefines: [],
            inlineIncludes: true,
        };
        /** 文件名 -> 该文件的原始文本（用于 `include 解析与增量更新） */
        this.fileText = new Map();
        /** include 名（小写 basename） -> 文件与内容，用于 O(1) 解析 */
        this.includeIndex = new Map();
        /** 文件 -> 该文件里的模块例化出的模块类型集合（增量维护例化反查表用） */
        this.instByFile = new Map();
        /** 文件 -> 该文件贡献的例化数量（增量维护统计用） */
        this.instCountByFile = new Map();
        /** 网络等价类 */
        this.nets = (0, nets_1.emptyNetClasses)();
        this.lastBuild = { inlined: 0, skippedIncludes: [], declOnlyModules: 0 };
        /**
         * 被 `include 引用的文件内容（体积小、数量少）。
         * 单独留一份是为了让索引缓存接管之后，后续"保存时增量更新"仍然能内联 include ——
         * 否则缓存命中后的第一次保存会悄悄退化成"不内联"。
         */
        this.includeTexts = new Map();
    }
    get current() {
        return this.index;
    }
    get buildStats() {
        return this.lastBuild;
    }
    get netClasses() {
        return this.nets;
    }
    setOptions(opts) {
        this.options = { ...this.options, ...opts };
    }
    // ------------------------------------------------------------------ 构建
    async build(provider, report) {
        const t0 = Date.now();
        report?.('扫描源文件…');
        let files = await provider.listFiles();
        files = [...new Set(files.map(normalizePath))];
        // ---------- 第一遍：收集宏定义与 include ----------
        // 目的：让 `ifdef 判定有依据。注意这里 honorIfdef=false，
        // 意味着条件分支内的 `define 也会被收集（偏宽松，宁多勿漏）。
        const defines = new Set(this.options.extraDefines);
        const includes = new Set();
        const texts = new Map();
        /** 没能当文本解析的文件（加密 / 二进制 / 读取失败）—— 必须报出来，别让人以为代码有问题 */
        const skipped = [];
        const readAll = async (list, onOne) => {
            const BATCH = 32;
            for (let i = 0; i < list.length; i += BATCH) {
                const slice = list.slice(i, i + BATCH);
                await Promise.all(slice.map(async (f) => {
                    try {
                        const text = await provider.readFile(f);
                        const why = looksNonTextual(text);
                        if (why) {
                            skipped.push({ file: f, reason: why });
                            return;
                        }
                        texts.set(f, text);
                        onOne?.(f);
                    }
                    catch {
                        skipped.push({ file: f, reason: '读取失败' });
                    }
                }));
            }
        };
        await readAll(files, (f) => {
            const text = texts.get(f);
            if (text === undefined)
                return;
            const res = (0, parser_1.collectMacros)(text, defines);
            for (const inc of res.includes)
                includes.add(inc);
        });
        // include 寻址表：先用已扫到的文件建 basename 索引（避免 O(includes × files) 的串行探测）
        this.rebuildIncludeIndex(texts);
        // 把 `include 的文件也纳入索引（.h / .vh 里常有宏和定义）
        const includeFiles = await this.resolveIncludes(provider, files, includes);
        await readAll(includeFiles, (f) => {
            const text = texts.get(f);
            if (text === undefined)
                return;
            (0, parser_1.collectMacros)(text, defines);
        });
        this.rebuildIncludeIndex(texts);
        this.includeTexts.clear();
        for (const f of includeFiles) {
            const text = texts.get(f);
            if (text !== undefined)
                this.includeTexts.set(normalizePath(f), text);
        }
        for (const u of this.options.undefines)
            defines.delete(u);
        report?.(`已收集 ${defines.size} 个宏定义`, 15);
        // ---------- 第二遍：解析所有文件 ----------
        const allFiles = [...new Set([...files, ...includeFiles])];
        const modules = new Map();
        const fileModules = new Map();
        const instantiations = new Map();
        let instanceCount = 0;
        let inlined = 0;
        const skippedIncludes = new Set();
        const parseOpts = {
            defines: new Set(defines),
            honorIfdef: this.options.honorIfdef,
            maxInstancesPerModule: this.options.maxInstancesPerModule,
            inlineIncludes: this.options.inlineIncludes,
            includeResolver: this.makeIncludeResolver(),
        };
        let processed = 0;
        const BATCH = 24;
        for (let i = 0; i < allFiles.length; i += BATCH) {
            const slice = allFiles.slice(i, i + BATCH);
            const results = await Promise.all(slice.map(async (f) => {
                const text = texts.get(f);
                if (text === undefined)
                    return null;
                this.fileText.set(f, text);
                try {
                    return (0, parser_1.parseFile)(text, f, parseOpts);
                }
                catch (err) {
                    return {
                        modules: [],
                        warnings: [`解析失败：${err.message}`],
                    };
                }
            }));
            for (let k = 0; k < slice.length; k++) {
                const res = results[k];
                if (!res)
                    continue;
                const f = slice[k];
                const names = [];
                const types = new Set();
                let fileInstances = 0;
                for (const mod of res.modules) {
                    if (!modules.has(mod.name))
                        modules.set(mod.name, []);
                    modules.get(mod.name).push(mod);
                    names.push(mod.name);
                    for (const inst of mod.instances) {
                        if (!instantiations.has(inst.moduleType))
                            instantiations.set(inst.moduleType, []);
                        instantiations.get(inst.moduleType).push({
                            parentModule: mod.name,
                            parentFile: mod.file,
                            instance: inst,
                        });
                        types.add(inst.moduleType);
                        instanceCount++;
                        fileInstances++;
                    }
                }
                if (names.length > 0)
                    fileModules.set(f, names);
                if (types.size > 0)
                    this.instByFile.set(f, types);
                if (fileInstances > 0)
                    this.instCountByFile.set(f, fileInstances);
                inlined += res.inlined ?? 0;
                for (const s of res.skippedIncludes ?? []) {
                    if (skippedIncludes.size < 20)
                        skippedIncludes.add(s);
                }
            }
            processed += slice.length;
            report?.(`解析 ${processed}/${allFiles.length} 个文件`, (slice.length / allFiles.length) * 80);
        }
        // ---------- 辅助声明文件（IP 例化模板）----------
        const declOnlyModules = await this.addDeclOnlyModules(modules, provider);
        const topCandidates = this.computeTopCandidates(modules, instantiations);
        this.index = {
            modules,
            fileModules,
            instantiations,
            defines,
            includes,
            topCandidates,
            skipped,
            stats: {
                fileCount: allFiles.length,
                moduleCount: modules.size,
                instanceCount,
                parseMs: Date.now() - t0,
            },
        };
        this.rebuildNets();
        this.lastBuild = {
            inlined,
            skippedIncludes: [...skippedIncludes],
            declOnlyModules,
        };
        report?.(`索引完成：${modules.size} 个模块 / ${instanceCount} 个例化`, 5);
        return this.index;
    }
    /**
     * 辅助声明文件：IP 的 .veo / .vho 例化模板里通常带有端口方向声明。
     * 只补"工程里没有定义"的模块名，且标记 declOnly —— 永不覆盖真实实现。
     */
    async addDeclOnlyModules(modules, provider) {
        if (!provider.listAuxFiles)
            return 0;
        let auxFiles = [];
        try {
            auxFiles = [...new Set((await provider.listAuxFiles()).map(normalizePath))];
        }
        catch {
            return 0;
        }
        if (auxFiles.length === 0)
            return 0;
        let added = 0;
        for (const f of auxFiles) {
            let text;
            try {
                text = await provider.readFile(f);
            }
            catch {
                continue;
            }
            let parsed;
            try {
                parsed = (0, parser_1.parseFile)(text, f, {
                    defines: new Set(this.index.defines),
                    honorIfdef: this.options.honorIfdef,
                    maxInstancesPerModule: this.options.maxInstancesPerModule,
                    inlineIncludes: false,
                });
            }
            catch {
                continue;
            }
            for (const mod of parsed.modules) {
                if (modules.has(mod.name))
                    continue;
                if (mod.ports.length === 0)
                    continue;
                // 只保留端口信息：不参与例化反查、不构成网络等价类
                mod.declOnly = true;
                mod.instances = [];
                mod.assigns = [];
                mod.alwaysBlocks = [];
                modules.set(mod.name, [mod]);
                added++;
            }
        }
        return added;
    }
    /** include 名 → 文件，O(1) 查表（同名文件取第一个扫到的） */
    rebuildIncludeIndex(texts) {
        for (const [p, t] of texts) {
            const base = p.split('/').pop()?.toLowerCase();
            if (!base)
                continue;
            if (!this.includeIndex.has(base))
                this.includeIndex.set(base, { file: p, text: t });
        }
    }
    /** 供解析器内联 `include 使用 */
    makeIncludeResolver() {
        return (name, fromFile) => {
            const dir = normalizePath(fromFile).replace(/\/[^/]*$/, '/');
            const direct = normalizePath(dir + name);
            const dt = this.fileText.get(direct);
            if (dt !== undefined)
                return { file: direct, text: dt };
            const base = name.split('/').pop()?.toLowerCase();
            if (!base)
                return null;
            return this.includeIndex.get(base) ?? null;
        };
    }
    computeTopCandidates(modules, instantiations) {
        const out = [];
        for (const [name, list] of modules) {
            if (instantiations.has(name))
                continue;
            // 只用于声明方向的辅助文件不算顶层候选
            if (list.length > 0 && list.every((m) => m.declOnly))
                continue;
            out.push(name);
        }
        out.sort();
        return out;
    }
    async resolveIncludes(provider, files, includes) {
        const out = new Set();
        const missing = [];
        for (const inc of includes) {
            const base = inc.split(/[\\/]/).pop()?.toLowerCase();
            const hit = base ? this.includeIndex.get(base) : undefined;
            if (hit)
                out.add(normalizePath(hit.file));
            else
                missing.push(inc);
        }
        // 少数 include 指向没被扫到的目录：退回逐个探测（数量通常很少）
        if (missing.length > 0 && provider.resolveInclude && provider.exists) {
            for (const inc of missing) {
                for (const f of files.slice(0, 200)) {
                    const resolved = await provider.resolveInclude(f, inc);
                    if (resolved && (await provider.exists(resolved))) {
                        out.add(normalizePath(resolved));
                        break;
                    }
                }
            }
        }
        return [...out];
    }
    // ------------------------------------------------------------------ 增量
    /** 撤掉某个文件贡献的模块定义与例化记录 */
    dropFileRecords(f) {
        const oldNames = this.index.fileModules.get(f) ?? [];
        for (const name of oldNames) {
            const list = this.index.modules.get(name);
            if (!list)
                continue;
            const kept = list.filter((m) => m.file !== f);
            if (kept.length === 0)
                this.index.modules.delete(name);
            else
                this.index.modules.set(name, kept);
        }
        this.index.fileModules.delete(f);
        const types = this.instByFile.get(f);
        if (types) {
            for (const t of types) {
                const list = this.index.instantiations.get(t);
                if (!list)
                    continue;
                const kept = list.filter((s) => normalizePath(s.parentFile) !== f);
                if (kept.length === 0)
                    this.index.instantiations.delete(t);
                else
                    this.index.instantiations.set(t, kept);
            }
            this.instByFile.delete(f);
        }
        const cnt = this.instCountByFile.get(f) ?? 0;
        if (cnt > 0) {
            this.index.stats.instanceCount = Math.max(0, this.index.stats.instanceCount - cnt);
            this.instCountByFile.delete(f);
        }
    }
    /** 把某个模块的例化登记进反查表 */
    addModuleInstances(mod, f) {
        if (mod.instances.length === 0)
            return;
        let types = this.instByFile.get(f);
        if (!types) {
            types = new Set();
            this.instByFile.set(f, types);
        }
        for (const inst of mod.instances) {
            if (!this.index.instantiations.has(inst.moduleType)) {
                this.index.instantiations.set(inst.moduleType, []);
            }
            this.index.instantiations.get(inst.moduleType).push({
                parentModule: mod.name,
                parentFile: mod.file,
                instance: inst,
            });
            types.add(inst.moduleType);
        }
        this.instCountByFile.set(f, (this.instCountByFile.get(f) ?? 0) + mod.instances.length);
        this.index.stats.instanceCount += mod.instances.length;
    }
    /**
     * 文件变更时局部重建：只重解析该文件，并增量更新它贡献的例化记录。
     * （原先每次都全量重建例化表 —— 工程一大，每次保存都要遍历所有模块。）
     */
    updateFile(file, text) {
        const f = normalizePath(file);
        this.fileText.set(f, text);
        this.dropFileRecords(f);
        let parsed;
        try {
            parsed = (0, parser_1.parseFile)(text, f, {
                defines: new Set(this.index.defines),
                honorIfdef: this.options.honorIfdef,
                maxInstancesPerModule: this.options.maxInstancesPerModule,
                inlineIncludes: this.options.inlineIncludes,
                includeResolver: this.makeIncludeResolver(),
            });
        }
        catch {
            this.rebuildTopCandidates();
            return;
        }
        const names = [];
        for (const mod of parsed.modules) {
            if (!this.index.modules.has(mod.name))
                this.index.modules.set(mod.name, []);
            this.index.modules.get(mod.name).push(mod);
            names.push(mod.name);
            this.addModuleInstances(mod, f);
        }
        if (names.length > 0)
            this.index.fileModules.set(f, names);
        this.rebuildTopCandidates();
        this.rebuildNets();
    }
    removeFile(file) {
        const f = normalizePath(file);
        this.dropFileRecords(f);
        this.fileText.delete(f);
        this.rebuildTopCandidates();
        this.rebuildNets();
    }
    /** 顶层候选 = 没有被任何模块例化的模块（O(模块数)，代价可忽略） */
    rebuildTopCandidates() {
        this.index.topCandidates = this.computeTopCandidates(this.index.modules, this.index.instantiations);
    }
    /** 重建网络等价类（O(例化数)，通常几毫秒） */
    rebuildNets() {
        this.nets = (0, nets_1.buildNetClasses)(this.index, this);
    }
    // ------------------------------------------------------------------ 缓存
    /**
     * 直接接管一份已构建好的索引（来自磁盘缓存）。
     * 只重建派生数据（网络等价类），不做任何解析。
     */
    adopt(index, fileText) {
        this.index = index;
        if (fileText) {
            for (const [k, v] of fileText)
                this.includeTexts.set(normalizePath(k), v);
        }
        if (this.includeTexts.size > 0)
            this.rebuildIncludeIndex(this.includeTexts);
        this.instByFile.clear();
        this.instCountByFile.clear();
        for (const list of index.modules.values()) {
            for (const mod of list) {
                if (mod.declOnly)
                    continue;
                for (const inst of mod.instances) {
                    let types = this.instByFile.get(normalizePath(mod.file));
                    if (!types) {
                        types = new Set();
                        this.instByFile.set(normalizePath(mod.file), types);
                    }
                    types.add(inst.moduleType);
                }
            }
        }
        if (fileText) {
            for (const [k, v] of fileText)
                this.fileText.set(normalizePath(k), v);
        }
        this.rebuildTopCandidates();
        this.rebuildNets();
    }
    /** 供缓存使用：当前索引是否可用 */
    get isBuilt() {
        return this.index.stats.fileCount > 0;
    }
    /** 供缓存使用：被 include 的文件内容（恢复后增量更新仍能内联） */
    get cachedIncludeTexts() {
        return this.includeTexts;
    }
    // ------------------------------------------------------------------ 查询
    /** 取模块定义；同名多份时优先返回"更像真实定义"的那份（例化数最多） */
    getModule(name) {
        const list = this.index.modules.get(name);
        if (!list || list.length === 0)
            return undefined;
        if (list.length === 1)
            return list[0];
        let best;
        for (const m of list) {
            if (m.declOnly)
                continue;
            if (!best || m.instances.length > best.instances.length)
                best = m;
        }
        return best ?? list[0];
    }
    getModules(name) {
        return this.index.modules.get(name) ?? [];
    }
    hasModule(name) {
        return this.index.modules.has(name);
    }
    /** 该模块是否只有"声明"（IP 例化模板） */
    isDeclOnly(name) {
        const list = this.index.modules.get(name);
        return !!list && list.length > 0 && list.every((m) => m.declOnly);
    }
    getInstantiations(name) {
        return this.index.instantiations.get(name) ?? [];
    }
    getPort(mod, portName) {
        return mod.ports.find((p) => p.name === portName);
    }
    /** 同一物理网络的其它名字（改名反查） */
    netAliases(moduleName, net, limit = 12) {
        return this.nets.otherAliases(moduleName, net, limit);
    }
    /** 该网络所属等价类里的全部成员（含自身） */
    netMembers(moduleName, net) {
        return this.nets.aliasesOf(moduleName, net);
    }
    /** 光标字符偏移落在哪个模块内 */
    findModuleAt(file, offset) {
        const f = normalizePath(file);
        const names = this.index.fileModules.get(f);
        if (!names)
            return undefined;
        let best;
        for (const n of names) {
            for (const m of this.getModules(n)) {
                if (m.file !== f)
                    continue;
                if (offset >= m.start && offset <= m.end) {
                    if (!best || m.end - m.start < best.end - best.start)
                        best = m;
                }
            }
        }
        return best;
    }
    /**
     * 全局查找"声明了某个名字"的模块（作为端口或内部信号）。
     * 用于用户只给了信号名、但起点模块判断错误时的自动纠正。
     */
    findModulesDeclaring(netName) {
        const out = [];
        for (const list of this.index.modules.values()) {
            for (const m of list) {
                if (m.declOnly)
                    continue;
                if (m.ports.some((p) => p.name === netName) || m.signals.has(netName)) {
                    out.push(m);
                    break;
                }
            }
        }
        return out;
    }
    /** 某个网络名是否可能对应模块内声明的信号 */
    lookupSignal(mod, netName) {
        if (mod.ports.some((p) => p.name === netName))
            return 'port';
        if (mod.signals.has(netName))
            return 'signal';
        return 'unknown';
    }
    /** 调试用：模块的端口位宽摘要 */
    describePort(mod, portName) {
        const p = this.getPort(mod, portName);
        if (!p)
            return '';
        const dir = p.direction ?? '?';
        let w = '';
        if (p.msb !== null && p.lsb !== null)
            w = ` [${p.msb}:${p.lsb}]`;
        const width = (0, parser_1.calcWidth)(p.msb, p.lsb);
        return `${dir}${w}${width !== null ? ` (${width}bit)` : ''}`;
    }
}
exports.WorkspaceIndexer = WorkspaceIndexer;
function emptyIndex() {
    return {
        modules: new Map(),
        fileModules: new Map(),
        instantiations: new Map(),
        defines: new Set(),
        includes: new Set(),
        topCandidates: [],
        stats: { fileCount: 0, moduleCount: 0, instanceCount: 0, parseMs: 0 },
    };
}
function normalizePath(p) {
    return p.replace(/\\/g, '/');
}
/**
 * 这个文件能不能当 Verilog 文本解析？返回 null 表示"能"，否则返回不能的原因。
 *
 * 必要性：有些工程把仿真模型 / 加密 IP 直接放成 `.v`，内容是二进制或加密串。
 * 硬当文本解析的后果很隐蔽 —— 解析器会从乱码里"碰巧"认出 module 字样，
 * 产出一个「端口 0 · 子例化 0」的空模块，看起来像代码有问题，其实是文件不可读。
 * （实测反馈里就有这么一条，查了半天才发现是二进制文件。）
 */
function looksNonTextual(text) {
    const n = Math.min(text.length, 4096);
    if (n === 0)
        return null;
    let ctrl = 0;
    let wide = 0;
    for (let i = 0; i < n; i++) {
        const c = text.charCodeAt(i);
        if (c === 0)
            return '含 NUL 字节（二进制文件）';
        if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12)
            ctrl++;
        else if (c >= 0x2000)
            wide++;
    }
    if (ctrl / n > 0.02)
        return `控制字符过多（${Math.round((ctrl / n) * 100)}%）`;
    if (wide / n > 0.3)
        return `非 ASCII 字符过多（${Math.round((wide / n) * 100)}%，疑似加密或二进制）`;
    return null;
}
//# sourceMappingURL=indexer.js.map