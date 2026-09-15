"use strict";
/**
 * 网络等价类（并查集）
 *
 * 解决的问题：Verilog 里"同一根物理网络"在不同模块里叫不同名字 ——
 *   父层 `s_data` 接到子模块的 `i_data` 端口，在子模块内部就叫 `i_data`；
 *   再往下一层可能又变成 `s_data_in`。静态文本搜索永远找不到这种"改名链路"。
 *
 * 做法：把每一次例化连接（父层网络 ≡ 子模块端口）作为一条等价边并起来，
 * 于是所有名字被划入同一个等价类 —— 也就是"同一个物理网络的全部别名"。
 *
 * 这是"改名反查 / 跨模块查找引用 / 别名提示"的统一底座。
 * 注意：粒度与整个插件一致 —— 按模块类型合并，不展开实例路径。
 * 同一模块被多处例化时，其内部网络只会出现在一个等价类里（与"多路径"标记的语义相符）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetClasses = void 0;
exports.emptyNetClasses = emptyNetClasses;
exports.buildNetClasses = buildNetClasses;
function key(moduleName, net) {
    return `${moduleName}\u0000${net}`;
}
const SEP = '\u0000';
/** 网络等价类集合：查询"这根信号在别处叫什么" */
class NetClasses {
    constructor(parent, members, truncated = false, hubPorts = 0) {
        this.parent = new Map();
        this.members = new Map();
        this.parent = parent;
        this.members = members;
        this.truncated = truncated;
        this.hubPorts = hubPorts;
    }
    get classCount() {
        return this.members.size;
    }
    /** 该网络所属等价类的 id（未登记时返回 undefined） */
    classIdOf(moduleName, net) {
        const k = key(moduleName, net);
        const root = this.parent.get(k);
        return root;
    }
    /**
     * 同一物理网络的全部别名（含自身）。
     * 找不到时返回只含自身的数组 —— 调用方不需要判空。
     */
    aliasesOf(moduleName, net) {
        const root = this.parent.get(key(moduleName, net));
        if (!root) {
            return [{ module: moduleName, net, kind: 'signal', direction: null, instances: 0 }];
        }
        return this.members.get(root) ?? [];
    }
    /** 除自身之外的别名，按"端口优先、模块名"排序 */
    otherAliases(moduleName, net, limit = 12) {
        const all = this.aliasesOf(moduleName, net);
        const rest = all.filter((m) => !(m.module === moduleName && m.net === net));
        rest.sort((a, b) => {
            if ((a.kind === 'port') !== (b.kind === 'port'))
                return a.kind === 'port' ? -1 : 1;
            return a.module.localeCompare(b.module);
        });
        return rest.slice(0, limit);
    }
    /** 统计信息（用于状态栏/诊断） */
    stats() {
        let nets = 0;
        let aliased = 0;
        for (const list of this.members.values()) {
            nets += list.length;
            if (list.length > 1)
                aliased += list.length;
        }
        return { classes: this.members.size, nets, aliasedNets: aliased, hubPorts: this.hubPorts };
    }
}
exports.NetClasses = NetClasses;
/** 空实现：索引尚未构建时使用 */
function emptyNetClasses() {
    return new NetClasses(new Map(), new Map());
}
/**
 * 构建网络等价类。
 *
 * 只使用"纯网络连接"（`conn.kind === 'net'`）：表达式/拼接里的名字不构成
 * 等价关系（`{a, b}` 接过去并不是把 a 和端口等同起来），宁可漏也不并错。
 */
function buildNetClasses(index, lookup, opts = {}) {
    const maxMembers = opts.maxMembersPerClass ?? 200;
    const parent = new Map();
    const find = (x) => {
        let r = x;
        let guard = 0;
        while (parent.get(r) !== undefined && parent.get(r) !== r && guard++ < 10_000)
            r = parent.get(r);
        // 路径压缩
        let cur = x;
        while (parent.get(cur) !== undefined && parent.get(cur) !== cur) {
            const nx = parent.get(cur);
            parent.set(cur, r);
            cur = nx;
        }
        return r;
    };
    const union = (a, b) => {
        if (!parent.has(a))
            parent.set(a, a);
        if (!parent.has(b))
            parent.set(b, b);
        const ra = find(a);
        const rb = find(b);
        if (ra === rb)
            return;
        // 让 id 字典序小者当根，保证结果稳定（便于对比与缓存）
        if (ra < rb)
            parent.set(rb, ra);
        else
            parent.set(ra, rb);
    };
    let truncated = false;
    // ---- 第一步：收集候选等价边，并统计"子端口 ← 哪些父层网络" ----
    const edges = [];
    const childFathers = new Map();
    for (const list of index.modules.values()) {
        for (const mod of list) {
            if (mod.declOnly)
                continue; // 声明文件只提供端口方向，不构成真实连接
            for (const inst of mod.instances) {
                const sub = lookup.getModule(inst.moduleType);
                if (!sub || sub.declOnly)
                    continue;
                const subPorts = new Set(sub.ports.map((p) => p.name));
                for (const conn of inst.connections) {
                    if (conn.kind !== 'net' || !conn.primaryNet)
                        continue;
                    const port = conn.port ?? (conn.portIndex !== null ? sub.portOrder[conn.portIndex] ?? null : null);
                    if (!port || !subPorts.has(port))
                        continue;
                    const father = key(mod.name, conn.primaryNet);
                    const child = key(sub.name, port);
                    edges.push({ father, child });
                    let set = childFathers.get(child);
                    if (!set) {
                        set = new Set();
                        childFathers.set(child, set);
                    }
                    set.add(father);
                }
            }
        }
    }
    /**
     * ---- 第二步：只并"唯一对应"的边 ----
     *
     * 同一个子端口如果被**不同的父层网络**连过（典型：被多处例化的 RAM / FIFO 叶子，
     * 比如 `xpm_dpram_simple.dina` 被好几个模块各接一根不同的总线），那么"父层网络 ≡
     * 该子端口"这个等价关系就不再成立 —— 穿过它会把互不相干的网络粘成一个类。
     * 实测：某 96 位总线因此拿到 64 个"别名"，其中大半是别的通道的总线。
     *
     * 按本文件的原则（宁可漏也不并错）直接跳过这类边：别名少几个可以接受，
     * 给出一条错误的"同一根线"会把人带到别的电路上去。
     */
    let hubPorts = 0;
    for (const set of childFathers.values())
        if (set.size > 1)
            hubPorts++;
    for (const e of edges) {
        if ((childFathers.get(e.child)?.size ?? 1) > 1)
            continue;
        union(e.father, e.child);
    }
    // ---- 归集成员 ----
    const members = new Map();
    const seen = new Map();
    const addMember = (k) => {
        const sep = k.indexOf(SEP);
        if (sep < 0)
            return;
        const moduleName = k.slice(0, sep);
        const net = k.slice(sep + 1);
        const root = find(k);
        let list = members.get(root);
        if (!list) {
            list = [];
            members.set(root, list);
            seen.set(root, new Set());
        }
        const dedupKey = `${moduleName}${SEP}${net}`;
        if (seen.get(root).has(dedupKey))
            return;
        seen.get(root).add(dedupKey);
        if (list.length >= maxMembers) {
            truncated = true;
            return;
        }
        const mod = lookup.getModule(moduleName);
        const port = mod?.ports.find((p) => p.name === net);
        list.push({
            module: moduleName,
            net,
            kind: port ? 'port' : 'signal',
            direction: port?.direction ?? null,
            instances: mod ? index.instantiations.get(mod.name)?.length ?? 0 : 0,
        });
    };
    for (const k of parent.keys())
        addMember(k);
    // 单例成员（出现过但没有任何连接）也要登记，这样 aliasesOf 至少能返回自身
    for (const list of members.values()) {
        list.sort((a, b) => {
            if ((a.kind === 'port') !== (b.kind === 'port'))
                return a.kind === 'port' ? -1 : 1;
            return a.module.localeCompare(b.module);
        });
    }
    return new NetClasses(parent, members, truncated, hubPorts);
}
//# sourceMappingURL=nets.js.map