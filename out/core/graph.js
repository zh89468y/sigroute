"use strict";
/**
 * 信号路由图引擎
 *
 * 核心模型：Verilog 里一根信号的"生命周期"由三类边构成
 *   1. 端口等价边：模块内的端口名，在模块外部表现为父层的一个 net（常常改名）
 *   2. 实例连接边：父层 net -> 子模块端口
 *   3. 驱动边：assign / always / 子模块 output
 *
 * 遍历规则（这是保证不绕回、不爆炸的关键）：
 *   - "进入子模块"时只从端口往内部走（端口在内外部是同一个物理网络的两种名字）
 *   - "走出模块"时只通过被例化的位置回父层
 *   - 每个 (模块, 信号, 方向) 只展开一次，既防组合环也防树爆炸
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceSignal = traceSignal;
exports.resolveStartPoint = resolveStartPoint;
/** 取（或创建）框图节点 */
function gnode(ctx, moduleName) {
    let n = ctx.gNodeMap.get(moduleName);
    if (!n) {
        const mod = ctx.indexer.getModule(moduleName);
        n = {
            id: moduleName,
            moduleName,
            isStart: moduleName === ctx.startModule,
            inNets: [],
            outNets: [],
            hits: 0,
            hop: Number.POSITIVE_INFINITY,
            flags: [],
            file: mod?.file,
            line: mod?.headerLine,
            blackbox: !mod,
        };
        ctx.gNodeMap.set(moduleName, n);
    }
    n.hits++;
    return n;
}
/** 记录"to 是被 from 通过哪个实例例化出来的"（首个为主路径，其余一并保留） */
function noteInstance(ctx, from, to, instanceName) {
    if (!instanceName || from === to)
        return;
    const node = ctx.gNodeMap.get(to);
    if (!node)
        return;
    const list = node.instances ?? [];
    if (list.some((x) => x.container === from && x.instanceName === instanceName))
        return;
    if (list.length >= MAX_INSTANCES_PER_NODE)
        return;
    node.instances = [...list, { container: from, instanceName }];
    if (!node.container) {
        node.container = from;
        node.instanceName = instanceName;
    }
}
/** 单个节点最多记几组例化（同一模块被滥例化时保护内存） */
const MAX_INSTANCES_PER_NODE = 4;
/**
 * 记录一次跨模块跳转。
 * 这是框图数据的唯一来源 —— 直接出自遍历过程，而不是从结果树反推，
 * 保证框图与树视图表达的语义完全一致。
 */
function addEdge(ctx, from, to, fromNet, toNet, port, meta) {
    const id = `${from}\u0000${to}\u0000${fromNet}\u0000${toNet}`;
    if (!from || !to)
        return id;
    const src = gnode(ctx, from);
    if (!src.outNets.includes(fromNet))
        src.outNets.push(fromNet);
    if (from === to) {
        // 自环（信号在同一模块类型内绕回）：不进图，但把信号登记下来
        if (!src.inNets.includes(toNet))
            src.inNets.push(toNet);
        return id;
    }
    const dst = gnode(ctx, to);
    if (!dst.inNets.includes(toNet))
        dst.inNets.push(toNet);
    noteInstance(ctx, from, to, meta.instanceName);
    for (const f of meta.flags) {
        if (!src.flags.includes(f))
            src.flags.push(f);
        if (!dst.flags.includes(f))
            dst.flags.push(f);
    }
    if (ctx.gEdgeMap.has(id))
        return id;
    ctx.gEdgeMap.set(id, {
        id,
        from,
        to,
        fromNet,
        toNet,
        port,
        instanceName: meta.instanceName,
        renamed: fromNet !== toNet,
        hop: meta.hop,
        flags: [...meta.flags],
        file: meta.file,
        line: meta.line,
        offset: meta.offset,
        tooltip: meta.tooltip,
    });
    return id;
}
function buildGraph(ctx, signalName) {
    const edges = [...ctx.gEdgeMap.values()];
    const nodes = [...ctx.gNodeMap.values()];
    // 节点的跳数 = 与它相连的所有边中最近的跳数
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
        if (n.isStart)
            n.hop = 0;
    }
    for (const e of edges) {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (a && e.hop < a.hop)
            a.hop = e.hop;
        if (b && e.hop < b.hop)
            b.hop = e.hop;
    }
    for (const n of nodes) {
        if (!Number.isFinite(n.hop))
            n.hop = 0;
    }
    return {
        nodes,
        edges,
        startModule: ctx.startModule,
        signalName,
        stats: {
            nodes: ctx.gNodeMap.size,
            edges: edges.length,
            renames: edges.filter((e) => e.renamed).length,
        },
    };
}
/**
 * 每个节点的通用收尾：限制分支数，避免单个节点炸出上百个兄弟。
 *
 * 超限时不再只是丢一句提示，而是给一个**可点击**的"继续展开"节点：
 * 点一次该节点的分支上限放宽 4 倍（`ctx.expanded`），可以反复点。
 * 这样时钟/复位这类高扇出信号也能一层层看下去，而不是被硬截断。
 */
function capChildren(ctx, out, key) {
    const times = ctx.expanded.get(key) ?? 0;
    const cap = times > 0 ? ctx.maxChildren * Math.pow(4, times) : ctx.maxChildren;
    if (out.length <= cap)
        return out;
    const shown = out.slice(0, cap);
    const pending = out.length - cap;
    return [
        ...shown,
        {
            kind: 'note',
            label: `…另有 ${pending} 个分支未展开`,
            description: times > 0
                ? '点击继续展开（每点一次放宽 4 倍）'
                : '单个信号扇出过多，点击展开或调大 sigroute.maxChildren',
            tooltip: `该节点下共有 ${out.length} 个分支，当前显示前 ${cap} 个。\n` +
                '点击本行可以继续展开更多（不会重复解析，只是放宽这一层的显示上限）。',
            flags: ['more'],
            expandKey: key,
            pendingCount: pending,
            children: [],
        },
    ];
}
function outOfBudget(ctx) {
    return ctx.nodeCount >= ctx.maxNodes;
}
function budgetNode(ctx) {
    return {
        kind: 'note',
        label: '已达节点预算上限，链路在此截断',
        description: `当前上限 ${ctx.maxNodes} 个节点，可在设置中调大 sigroute.maxNodes`,
        flags: ['budget'],
        children: [],
    };
}
function fname(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
}
function dirOf(mod, net) {
    return mod.ports.find((p) => p.name === net)?.direction ?? null;
}
function portLine(mod, port) {
    return mod.ports.find((p) => p.name === port)?.line ?? mod.headerLine;
}
/** 端口名在模块文件中的精确偏移，用于跳转时高亮到具体标识符 */
function portOffset(mod, port) {
    return mod.ports.find((p) => p.name === port)?.offset;
}
/**
 * 网络在模块内的"声明位置"：端口用它自己的行，内部信号用它声明的那一行，
 * 都没有才退回模块头。
 *
 * 用途：给 terminal / constant / unconnected 这类"本身没有源文件位置"的节点
 * 找一个**点了有用的落点**（顶层端口 → 端口声明；常量 → 父层那一次连接；
 * 未找到驱动 → 这个信号的声明处）。没有位置 = 点了没反应，体验上就是"坏了"。
 */
function netLoc(mod, net) {
    const port = mod.ports.find((p) => p.name === net);
    if (port)
        return { file: mod.file, line: port.line, offset: port.offset };
    const sig = mod.signals.get(net);
    return {
        file: mod.file,
        line: sig?.line ?? mod.headerLine,
        offset: sig && sig.offset >= 0 ? sig.offset : undefined,
    };
}
/** "继续展开"的节点键：同一次遍历里唯一标识某个分支点 */
function upKey(mod, net, depth) {
    return `${mod.name}::${net}::up::${depth}`;
}
function downKey(mod, net, depth) {
    return `${mod.name}::${net}::down::${depth}`;
}
/**
 * 同一物理网络的其它名字（最多 limit 条）。
 * 这是"改名反查"在树上的体现：一眼看到这根线在别的模块里叫什么。
 */
function aliasTexts(ctx, moduleName, net, limit = 8) {
    const list = ctx.indexer.netAliases(moduleName, net, limit + 1);
    const texts = list
        .filter((a) => !(a.module === moduleName && a.net === net))
        .slice(0, limit)
        .map((a) => `${a.module}.${a.net}`);
    return texts.length > 0 ? texts : undefined;
}
/** 链路摘要：把"这跟信号到底穿过多少模块/改了几次名"摆在树的最上面 */
function summaryNode(ctx, startModule, net, dir) {
    const modules = ctx.modules.length;
    const s = ctx.stats;
    const dirText = dir === 'input' ? '输入端口' : dir === 'output' ? '输出端口' : dir === 'inout' ? 'inout 端口' : '内部信号';
    const bits = [`${modules} 个模块`, `改名 ${s.renames} 处`];
    if (s.blackboxes > 0)
        bits.push(`黑盒 ${s.blackboxes} 处`);
    if (s.uncertainties > 0)
        bits.push(`不确定 ${s.uncertainties} 处`);
    const modList = ctx.modules.slice(0, 14);
    const more = modules > modList.length ? ` 等 ${modules} 个` : '';
    const lines = [
        `起点：${startModule}.${net}（${dirText}）`,
        `经过模块：${modList.join(' → ')}${more}`,
        `改名：${s.renames} 处 ｜ 黑盒/IP：${s.blackboxes} 处 ｜ 不确定：${s.uncertainties} 处`,
        `节点数：${s.nodes} ｜ 最大跨模块层数：${s.maxDepthReached}`,
        '',
        '提示：视图标题栏可切换"只看跨模块"与"只看改名"，快速跳过模块内部的中间变量。',
    ];
    return {
        kind: 'note',
        label: '链路摘要',
        description: bits.join(' · '),
        tooltip: lines.join('\n'),
        flags: ['summary'],
        children: [],
    };
}
/** 解析连接的目标端口名：命名连接直接取，位置连接用子模块端口顺序回填 */
function resolveConnPort(indexer, instModuleType, conn) {
    if (conn.port)
        return conn.port;
    if (conn.portIndex === null)
        return null;
    const sub = indexer.getModule(instModuleType);
    return sub?.portOrder[conn.portIndex] ?? null;
}
function findConnForPort(indexer, instModuleType, conns, port) {
    return conns.find((c) => resolveConnPort(indexer, instModuleType, c) === port);
}
// ---------------------------------------------------------------------------
function traceSignal(indexer, mod, net, opts) {
    const ctx = {
        indexer,
        maxDepth: Math.max(1, opts.maxDepth),
        maxNodes: Math.max(50, opts.maxNodes ?? 600),
        maxChildren: Math.max(4, opts.maxChildren ?? 24),
        nodeCount: 0,
        visited: new Set(),
        stats: { nodes: 0, renames: 0, maxDepthReached: 0, blackboxes: 0, uncertainties: 0 },
        modules: [],
        moduleSeen: new Set(),
        expanded: new Map(Object.entries(opts.expanded ?? {})),
        gNodeMap: new Map(),
        gEdgeMap: new Map(),
        startModule: mod.name,
    };
    const dir = dirOf(mod, net);
    // 声明位置（端口声明行或内部信号声明行）—— 作为兜底与提示信息
    const rootPort = mod.ports.find((p) => p.name === net);
    const rootSig = mod.signals.get(net);
    const declOffset = rootPort?.offset ?? (rootSig && rootSig.offset >= 0 ? rootSig.offset : undefined);
    // 声明行：端口用端口行；内部信号用它的声明行（parser 已记录）；都没有才退回模块头
    const declLine = rootPort?.line ?? rootSig?.line ?? mod.headerLine;
    // 起点节点优先指向"发起追踪的地方"：用户是在那里看到这根信号的，
    // 点根节点就应该回到那里（声明位置写进悬停提示，不做默认跳转目标）。
    const startAt = opts.startAt;
    const rootFile = startAt?.file ?? mod.file;
    const rootLine = startAt ? Math.max(0, startAt.line) : declLine;
    const rootOffset = startAt ? startAt.offset : declOffset;
    const root = {
        kind: 'signal',
        label: net,
        description: `${mod.name} · ${fname(rootFile)}:${rootLine + 1}${dir ? ` · ${dir}` : ''}`,
        tooltip: `起点：模块 ${mod.name} 中的 ${net}${dir ? `（${dir} 端口）` : ''}\n` +
            (startAt ? '追踪发起位置（点击回到这里）\n' : '') +
            `声明位置：${fname(mod.file)}:${declLine + 1}`,
        file: rootFile,
        line: rootLine,
        offset: rootOffset,
        flags: [],
        children: [],
    };
    touch(ctx, mod.name);
    ctx.stats.nodes++;
    if (opts.direction === 'up' || opts.direction === 'both') {
        const ups = upNodes(ctx, mod, net, 1);
        root.children.push({
            kind: 'group',
            label: `上游 · 信号从哪来（${countLeaves(ups)}）`,
            flags: [],
            branch: 'up',
            children: ups,
        });
    }
    if (opts.direction === 'down' || opts.direction === 'both') {
        const downs = downNodes(ctx, mod, net, 1);
        root.children.push({
            kind: 'group',
            label: `下游 · 路由到哪（${countLeaves(downs)}）`,
            flags: [],
            branch: 'down',
            children: downs,
        });
    }
    ctx.stats.nodes = countLeaves(root.children) + 1;
    // 摘要节点放在最上面：先看全局规模，需要细节时再往下展开
    root.children.unshift(summaryNode(ctx, mod.name, net, dir));
    return {
        root,
        modules: ctx.modules,
        stats: ctx.stats,
        start: {
            moduleName: mod.name,
            netName: net,
            file: mod.file,
            line: mod.headerLine,
            direction: dir,
        },
        graph: buildGraph(ctx, net),
    };
}
function touch(ctx, moduleName) {
    if (!ctx.moduleSeen.has(moduleName)) {
        ctx.moduleSeen.add(moduleName);
        ctx.modules.push(moduleName);
    }
}
function countLeaves(nodes) {
    let n = 0;
    const walk = (list) => {
        for (const x of list) {
            n++;
            walk(x.children);
        }
    };
    walk(nodes);
    return n;
}
// ------------------------------------------------------------------ 上游
function upNodes(ctx, mod, net, depth) {
    const out = [];
    if (depth > ctx.maxDepth) {
        return [limitNode(net, depth)];
    }
    if (outOfBudget(ctx)) {
        return [budgetNode(ctx)];
    }
    ctx.nodeCount++;
    const key = `${mod.name}::${net}::up`;
    if (ctx.visited.has(key)) {
        return [
            {
                kind: 'note',
                label: `${net}（已在上方展开过）`,
                description: '链路成环或存在重复引用',
                flags: ['loop'],
                children: [],
            },
        ];
    }
    ctx.visited.add(key);
    ctx.stats.maxDepthReached = Math.max(ctx.stats.maxDepthReached, depth);
    const dir = dirOf(mod, net);
    // ---- 情形 A：net 是模块的输入端口（inout 同理）-> 源头在父层 ----
    if (dir === 'input' || dir === 'inout') {
        const sites = ctx.indexer.getInstantiations(mod.name);
        if (sites.length === 0) {
            const at = netLoc(mod, net);
            out.push({
                kind: 'terminal',
                label: '顶层输入端口',
                description: `${mod.name}.${net} — 由芯片外部/顶层测试平台提供`,
                tooltip: `本模块没有被任何模块例化，这根输入来自外部。\n声明位置：${fname(at.file)}:${at.line + 1}`,
                file: at.file,
                line: at.line,
                offset: at.offset,
                flags: [],
                children: [],
            });
        }
        else {
            if (sites.length > 1)
                ctx.stats.uncertainties++;
            for (const site of sites) {
                const conn = findConnForPort(ctx.indexer, mod.name, site.instance.connections, net);
                if (!conn)
                    continue;
                const parentMod = ctx.indexer.getModule(site.parentModule);
                const loc = `${fname(site.parentFile)}:${conn.line + 1}`;
                const viaText = `父实例 ${site.instance.instanceName}(${mod.name}) 的 .${net} 端口`;
                if (conn.kind === 'constant') {
                    out.push({
                        kind: 'constant',
                        label: conn.expr || '(常量)',
                        description: `${site.parentModule} · ${loc}`,
                        edgeText: viaText,
                        tooltip: '该端口在父层被接成常量，信号并非来自某个逻辑（点击跳到父层那一次连接）',
                        file: site.parentFile,
                        line: conn.line,
                        offset: conn.start,
                        flags: ['constant'],
                        children: [],
                    });
                    continue;
                }
                if (conn.kind === 'unconnected') {
                    out.push({
                        kind: 'unconnected',
                        label: '(未连接)',
                        description: `${site.parentModule} · ${loc}`,
                        edgeText: viaText,
                        tooltip: '该端口在父层没有接任何东西（点击跳到父层那一次连接）',
                        file: site.parentFile,
                        line: conn.line,
                        offset: conn.start,
                        flags: ['unconnected'],
                        children: [],
                    });
                    continue;
                }
                if (!parentMod || !conn.primaryNet)
                    continue;
                const flags = [];
                if (conn.primaryNet !== net)
                    flags.push('renamed');
                if (conn.kind === 'expression')
                    flags.push('partial');
                if (conn.bitSelect)
                    flags.push('bitselect');
                if (site.instance.inGenerate)
                    flags.push('generate');
                if (sites.length > 1)
                    flags.push('ambiguous');
                if (flags.includes('renamed'))
                    ctx.stats.renames++;
                if (flags.includes('partial'))
                    ctx.stats.uncertainties++;
                const edgeId = addEdge(ctx, parentMod.name, mod.name, conn.primaryNet, net, net, {
                    hop: depth,
                    file: site.parentFile,
                    line: conn.line,
                    offset: conn.start,
                    flags,
                    instanceName: site.instance.instanceName,
                    tooltip: `父实例 ${site.instance.instanceName} 的 .${net} 端口`,
                });
                const children = upNodes(ctx, parentMod, conn.primaryNet, depth + 1);
                out.push({
                    kind: 'signal',
                    label: conn.primaryNet + (conn.bitSelect ?? ''),
                    description: `${parentMod.name} · ${loc}${conn.bitSelect ? ` · 位选 ${conn.bitSelect}` : ''}`,
                    tooltip: conn.kind === 'expression' ? `表达式：${conn.expr}` : undefined,
                    edgeText: viaText,
                    file: site.parentFile,
                    line: conn.line,
                    offset: conn.netOffset ?? conn.start,
                    flags: [...flags, 'cross'],
                    graphNodeKey: parentMod.name,
                    graphEdgeId: edgeId,
                    aliases: aliasTexts(ctx, parentMod.name, conn.primaryNet),
                    children,
                });
            }
            if (out.length === 0) {
                out.push({
                    kind: 'note',
                    label: '父层未找到对应连接',
                    description: '可能因条件编译裁剪或端口列表不完整',
                    flags: ['partial'],
                    children: [],
                });
            }
        }
        return capChildren(ctx, out, upKey(mod, net, depth));
    }
    // ---- 情形 B：net 在模块内部 -> 在模块内找驱动 ----
    // B1：某个子实例的 output / inout 端口驱动了它
    for (const inst of mod.instances) {
        for (const conn of inst.connections) {
            if (!conn.nets.includes(net))
                continue;
            const pname = resolveConnPort(ctx.indexer, inst.moduleType, conn);
            if (!pname)
                continue;
            const sub = ctx.indexer.getModule(inst.moduleType);
            const sd = sub ? dirOf(sub, pname) : null;
            if (!sub) {
                // 模块未索引 -> 端口方向未知，不能断言它是驱动源。
                // 把它作为"疑似来源"列出，但必须让用户看出这是不确定的。
                ctx.stats.blackboxes++;
                ctx.stats.uncertainties++;
                out.push({
                    kind: 'blackbox',
                    label: `${inst.moduleType}.${pname}`,
                    description: `${mod.name} · ${fname(mod.file)}:${conn.line + 1}`,
                    edgeText: `实例 ${inst.instanceName} 的 .${pname}（方向未知）`,
                    tooltip: '该模块未纳入索引，无法判断此端口是输入还是输出。\n' +
                        '若它是输入端口，则这条边并不是真正的驱动源 —— 把对应 IP 的 stub 文件纳入索引可以消除此歧义。',
                    file: mod.file,
                    line: conn.line,
                    flags: ['partial'],
                    children: [],
                });
                continue;
            }
            if (sd !== 'output' && sd !== 'inout')
                continue;
            const flags = [];
            if (pname !== net)
                flags.push('renamed');
            if (inst.inGenerate)
                flags.push('generate');
            if (conn.kind === 'expression')
                flags.push('partial');
            if (flags.includes('renamed'))
                ctx.stats.renames++;
            const edgeId = addEdge(ctx, sub.name, mod.name, pname, net, pname, {
                hop: depth,
                file: mod.file,
                line: conn.line,
                offset: conn.start,
                flags,
                instanceName: inst.instanceName,
                tooltip: `实例 ${inst.instanceName}(${inst.moduleType}) 的 ${sd} 端口驱动本层信号`,
            });
            touch(ctx, sub.name);
            const children = upNodes(ctx, sub, pname, depth + 1);
            out.push({
                kind: 'signal',
                label: pname,
                description: `${sub.name} 内部 · ${fname(sub.file)}:${portLine(sub, pname) + 1}`,
                edgeText: `由 ${inst.instanceName}(${inst.moduleType}) 的 ${sd} 端口驱动`,
                file: sub.file,
                line: portLine(sub, pname),
                offset: portOffset(sub, pname),
                flags: [...flags, 'cross'],
                graphNodeKey: sub.name,
                graphEdgeId: edgeId,
                aliases: aliasTexts(ctx, sub.name, pname),
                children,
            });
        }
    }
    // B2：assign
    for (const a of mod.assigns) {
        if (!a.lhsNets.includes(net))
            continue;
        const rhs = a.rhsNets.filter((x) => x !== net);
        if (rhs.length === 0) {
            // 右侧没有"工程内可识别的信号"：常量（`wire x = 1'b0;`）、参数、宏或函数调用。
            // 这仍然是一条真实的驱动源 —— 报成"未找到驱动源"是错的。
            const off0 = a.lhsOffsets[a.lhsNets.indexOf(net)];
            out.push({
                kind: 'constant',
                label: a.inline ? '声明处初值/常量' : '常量赋值',
                description: `${mod.name} · ${fname(mod.file)}:${a.line + 1}`,
                edgeText: a.inline ? `声明处赋值 ${a.lhsText} = …` : `assign ${a.lhsText} = …`,
                tooltip: '该赋值的右侧没有本工程内可识别的信号 —— 可能是常量、参数、宏或函数调用。',
                file: mod.file,
                line: a.line,
                offset: off0 !== undefined && off0 >= 0 ? off0 : undefined,
                flags: ['constant'],
                children: [],
            });
            continue;
        }
        for (const rn of rhs) {
            const children = upNodes(ctx, mod, rn, depth + 1);
            const off = a.rhsOffsets[a.rhsNets.indexOf(rn)];
            out.push({
                kind: 'signal',
                label: rn,
                description: `${mod.name} · ${fname(mod.file)}:${a.line + 1}`,
                edgeText: a.inline ? `声明处赋值 ${a.lhsText} = …` : `assign ${a.lhsText} = …`,
                tooltip: a.inline
                    ? `该信号在声明处就带表达式/初值，位于第 ${a.line + 1} 行`
                    : undefined,
                file: mod.file,
                line: a.line,
                offset: off !== undefined && off >= 0 ? off : undefined,
                flags: rhs.length > 1 ? ['partial', 'intra'] : ['intra'],
                children,
            });
        }
    }
    // B3：always 块（语句级数据流）
    for (const ab of mod.alwaysBlocks) {
        if (!ab.lhsNets.includes(net))
            continue;
        const children = [];
        /**
         * 过程块内真正给 net 赋值的那条语句。
         * 点"always @(...) 过程块"这个节点时应该跳到**目标信号所在的那一行并选中它**，
         * 而不是只跳到 always 关键字上 —— 后者基本等于没定位。
         */
        let hitLine;
        let hitOffset;
        // 同一个信号常被写两次：复位分支的 `x <= 0;` + 数据通路的 `x <= i_wr_data;`。
        // 点击优先落到**有 RHS 来源**的那条（信息量大得多），全是常量赋值时才退回第一条。
        let anyLine;
        let anyOffset;
        for (const st of ab.statements) {
            if (!st.lhs.includes(net))
                continue;
            const li = st.lhs.indexOf(net);
            const off = li >= 0 && (st.lhsOffsets[li] ?? -1) >= 0 ? st.lhsOffsets[li] : undefined;
            if (typeof off === 'number') {
                if (anyOffset === undefined) {
                    anyOffset = off;
                    anyLine = st.line;
                }
                if (hitOffset === undefined && st.reads.length > 0) {
                    hitOffset = off;
                    hitLine = st.line;
                }
            }
            for (const rn of st.reads) {
                if (rn === net)
                    continue;
                const off = st.readOffsets[st.reads.indexOf(rn)];
                children.push({
                    kind: 'signal',
                    label: rn,
                    description: `${mod.name} · ${fname(mod.file)}:${st.line + 1}`,
                    edgeText: '过程块内参与运算',
                    file: mod.file,
                    line: st.line,
                    offset: off !== undefined && off >= 0 ? off : undefined,
                    flags: ['intra'],
                    children: upNodes(ctx, mod, rn, depth + 1),
                });
            }
        }
        const targetLine = hitLine ?? anyLine ?? ab.line;
        const located = targetLine !== ab.line;
        out.push({
            kind: 'always',
            label: ab.isSequential
                ? `always @(${ab.edgeNets.slice(0, 2).join(', ')}${ab.edgeNets.length > 2 ? ', …' : ''})`
                : 'always @(*)',
            description: `${mod.name} · ${fname(mod.file)}:${targetLine + 1}` +
                (located ? ` · 赋值给 ${net}` : ''),
            tooltip: `该信号在此过程块中被赋值。\n敏感信号：${ab.edgeNets.join(', ') || '(无)'}` +
                (located
                    ? `\n赋值语句：第 ${targetLine + 1} 行（点击会选中该信号）`
                    : `\n过程块起始：第 ${ab.line + 1} 行`),
            file: mod.file,
            line: targetLine,
            offset: hitOffset ?? anyOffset,
            flags: ['always'],
            children,
        });
    }
    if (out.length === 0) {
        const at = netLoc(mod, net);
        out.push({
            kind: 'terminal',
            label: '未找到驱动源',
            description: `${mod.name} 内 ${net} 没有已知的驱动`,
            tooltip: `可能原因：由原语/IP 驱动、由未解析的语法结构产生、或名称拼写不一致。\n` +
                `声明位置：${fname(at.file)}:${at.line + 1}`,
            file: at.file,
            line: at.line,
            offset: at.offset,
            flags: ['partial'],
            children: [],
        });
        ctx.stats.uncertainties++;
    }
    return capChildren(ctx, out, upKey(mod, net, depth));
}
// ------------------------------------------------------------------ 下游
function downNodes(ctx, mod, net, depth) {
    const out = [];
    if (depth > ctx.maxDepth) {
        return [limitNode(net, depth)];
    }
    if (outOfBudget(ctx)) {
        return [budgetNode(ctx)];
    }
    ctx.nodeCount++;
    const key = `${mod.name}::${net}::down`;
    if (ctx.visited.has(key)) {
        return [
            {
                kind: 'note',
                label: `${net}（已在上方展开过）`,
                description: '链路成环或存在重复引用',
                flags: ['loop'],
                children: [],
            },
        ];
    }
    ctx.visited.add(key);
    ctx.stats.maxDepthReached = Math.max(ctx.stats.maxDepthReached, depth);
    const dir = dirOf(mod, net);
    // ---- 情形 A：net 是模块的输出端口 -> 流向父层 ----
    if (dir === 'output' || dir === 'inout') {
        const sites = ctx.indexer.getInstantiations(mod.name);
        if (sites.length === 0) {
            const at = netLoc(mod, net);
            out.push({
                kind: 'terminal',
                label: '顶层输出端口',
                description: `${mod.name}.${net} — 输出到芯片外部/顶层`,
                tooltip: `本模块没有被任何模块例化，这根输出直接送到外部。\n声明位置：${fname(at.file)}:${at.line + 1}`,
                file: at.file,
                line: at.line,
                offset: at.offset,
                flags: [],
                children: [],
            });
        }
        else {
            if (sites.length > 1)
                ctx.stats.uncertainties++;
            for (const site of sites) {
                const conn = findConnForPort(ctx.indexer, site.instance.moduleType, site.instance.connections, net);
                if (!conn)
                    continue;
                const parentMod = ctx.indexer.getModule(site.parentModule);
                const loc = `${fname(site.parentFile)}:${conn.line + 1}`;
                const viaText = `父实例 ${site.instance.instanceName}(${mod.name}) 的 .${net} 端口`;
                if (conn.kind === 'unconnected') {
                    out.push({
                        kind: 'unconnected',
                        label: '(悬空)',
                        description: `${site.parentModule} · ${loc}`,
                        edgeText: viaText,
                        tooltip: '该输出端口在父层没有连接到任何网络（点击跳到父层那一次连接）',
                        file: site.parentFile,
                        line: conn.line,
                        offset: conn.start,
                        flags: ['unconnected'],
                        children: [],
                    });
                    continue;
                }
                if (!parentMod || !conn.primaryNet)
                    continue;
                const flags = [];
                if (conn.primaryNet !== net)
                    flags.push('renamed');
                if (conn.kind === 'expression')
                    flags.push('partial');
                if (conn.bitSelect)
                    flags.push('bitselect');
                if (sites.length > 1)
                    flags.push('ambiguous');
                if (flags.includes('renamed'))
                    ctx.stats.renames++;
                if (flags.includes('partial'))
                    ctx.stats.uncertainties++;
                const edgeId = addEdge(ctx, mod.name, parentMod.name, net, conn.primaryNet, net, {
                    hop: depth,
                    file: site.parentFile,
                    line: conn.line,
                    offset: conn.start,
                    flags,
                    instanceName: site.instance.instanceName,
                    tooltip: `父实例 ${site.instance.instanceName} 的 .${net} 端口`,
                });
                out.push({
                    kind: 'signal',
                    label: conn.primaryNet + (conn.bitSelect ?? ''),
                    description: `${parentMod.name} · ${loc}${conn.bitSelect ? ` · 位选 ${conn.bitSelect}` : ''}`,
                    tooltip: conn.kind === 'expression' ? `表达式：${conn.expr}` : undefined,
                    edgeText: viaText,
                    file: site.parentFile,
                    line: conn.line,
                    offset: conn.netOffset ?? conn.start,
                    flags: [...flags, 'cross'],
                    graphNodeKey: parentMod.name,
                    graphEdgeId: edgeId,
                    aliases: aliasTexts(ctx, parentMod.name, conn.primaryNet),
                    children: downNodes(ctx, parentMod, conn.primaryNet, depth + 1),
                });
            }
        }
    }
    // ---- 情形 B：模块内部的负载 ----
    for (const inst of mod.instances) {
        for (const conn of inst.connections) {
            if (!conn.nets.includes(net))
                continue;
            const pname = resolveConnPort(ctx.indexer, inst.moduleType, conn);
            if (!pname)
                continue;
            const sub = ctx.indexer.getModule(inst.moduleType);
            if (!sub) {
                ctx.stats.blackboxes++;
                out.push({
                    kind: 'blackbox',
                    label: `${inst.moduleType}.${pname}`,
                    description: `${mod.name} · ${fname(mod.file)}:${conn.line + 1}`,
                    edgeText: `送入实例 ${inst.instanceName} 的 .${pname}`,
                    tooltip: '该模块不在索引范围内（IP / 黑盒 / 未纳入扫描的目录）',
                    file: mod.file,
                    line: conn.line,
                    flags: ['partial'],
                    children: [],
                });
                continue;
            }
            const sd = dirOf(sub, pname);
            if (sd !== 'input' && sd !== 'inout')
                continue;
            const flags = [];
            if (pname !== net)
                flags.push('renamed');
            if (inst.inGenerate)
                flags.push('generate');
            if (conn.kind === 'expression')
                flags.push('partial');
            if (conn.bitSelect)
                flags.push('bitselect');
            if (flags.includes('renamed'))
                ctx.stats.renames++;
            if (flags.includes('partial'))
                ctx.stats.uncertainties++;
            const edgeId = addEdge(ctx, mod.name, sub.name, net, pname, pname, {
                hop: depth,
                file: mod.file,
                line: conn.line,
                offset: conn.start,
                flags,
                instanceName: inst.instanceName,
                tooltip: `实例 ${inst.instanceName}(${inst.moduleType}) 的 .${pname}`,
            });
            touch(ctx, sub.name);
            out.push({
                kind: 'signal',
                label: pname,
                description: `${sub.name} 内部 · ${fname(sub.file)}:${portLine(sub, pname) + 1}`,
                tooltip: conn.kind === 'expression' ? `父层连接：${conn.expr}` : undefined,
                edgeText: `流入 ${inst.instanceName}(${inst.moduleType}) 的 .${pname}${sd === 'inout' ? '（inout）' : ''}`,
                file: sub.file,
                line: portLine(sub, pname),
                offset: portOffset(sub, pname),
                flags: [...flags, 'cross'],
                graphNodeKey: sub.name,
                graphEdgeId: edgeId,
                aliases: aliasTexts(ctx, sub.name, pname),
                children: downNodes(ctx, sub, pname, depth + 1),
            });
        }
    }
    // assign 产生的下游
    for (const a of mod.assigns) {
        if (!a.rhsNets.includes(net))
            continue;
        const lhs = a.lhsNets.filter((x) => x !== net);
        for (const ln of lhs) {
            const off = a.lhsOffsets[a.lhsNets.indexOf(ln)];
            out.push({
                kind: 'signal',
                label: ln,
                description: `${mod.name} · ${fname(mod.file)}:${a.line + 1}`,
                edgeText: a.inline ? `声明处赋值 ${a.lhsText}` : `assign ${a.lhsText}`,
                tooltip: a.inline ? `该信号在此声明处被赋值（表达式/初值）` : undefined,
                file: mod.file,
                line: a.line,
                offset: off !== undefined && off >= 0 ? off : undefined,
                flags: lhs.length > 1 ? ['partial', 'intra'] : ['intra'],
                children: downNodes(ctx, mod, ln, depth + 1),
            });
        }
    }
    // 过程块内被读取（这是"信号被谁使用"最容易被漏掉的一环）
    for (const ab of mod.alwaysBlocks) {
        /**
         * 目标信号 -> 那条读取它的赋值语句（偏移 + 行号）。
         * 落点用**语句行**而不是 always 行：节点描述与 offset 指向同一行，
         * 点击才会精确落在 `r_hist_x <= net;` 这句话上。
         */
        const targets = new Map();
        for (const st of ab.statements) {
            if (!st.reads.includes(net))
                continue;
            st.lhs.forEach((l, i) => {
                if (l !== net && !targets.has(l))
                    targets.set(l, { offset: st.lhsOffsets[i] ?? -1, line: st.line });
            });
        }
        for (const [ln, at] of targets) {
            out.push({
                kind: 'signal',
                label: ln,
                description: `${mod.name} · ${fname(mod.file)}:${at.line + 1}`,
                edgeText: ab.isSequential ? '过程块（时序）内参与赋值' : '过程块（组合）内参与赋值',
                tooltip: `该信号在此过程块内参与赋值：第 ${at.line + 1} 行（点击会选中该语句的目标信号 ${ln}）`,
                file: mod.file,
                line: at.line,
                offset: at.offset >= 0 ? at.offset : undefined,
                flags: ['always', 'intra'],
                children: downNodes(ctx, mod, ln, depth + 1),
            });
        }
        // 仅在条件/索引里出现，没有直接赋值目标
        if (targets.size === 0 && ab.readNets.includes(net)) {
            // 条件 / 索引里的读取没有语句级记录，用解析阶段记下的位置，
            // 这样点这一行同样能灰底选中块内的这个信号（和"赋值给 xxx"一致）
            const ref = (ab.readRefs ?? []).find((r) => r.name === net);
            out.push({
                kind: 'always',
                label: ab.isSequential ? 'always @(…) 的条件逻辑' : 'always @(*) 的条件逻辑',
                description: `${mod.name} · ${fname(mod.file)}:${(ref?.line ?? ab.line) + 1}` +
                    ` · 条件/索引中的 ${net}`,
                edgeText: '过程块内作为条件/索引使用',
                tooltip: '该信号在此过程块中以条件 / 索引的形式参与运算。\n' +
                    (ref
                        ? `读取位置：第 ${ref.line + 1} 行（点击会选中该信号）`
                        : `过程块起始：第 ${ab.line + 1} 行`),
                file: mod.file,
                line: ref?.line ?? ab.line,
                offset: ref?.offset,
                flags: ['always'],
                children: [],
            });
        }
    }
    if (out.length === 0) {
        const at = netLoc(mod, net);
        out.push({
            kind: 'terminal',
            label: '无下游负载',
            description: `${mod.name} 内未发现使用 ${net} 的地方`,
            tooltip: `可能原因：只在该模块内被读取但未跨模块、或负载在未解析的语法结构中。\n` +
                `声明位置：${fname(at.file)}:${at.line + 1}`,
            file: at.file,
            line: at.line,
            offset: at.offset,
            flags: [],
            children: [],
        });
    }
    return capChildren(ctx, out, downKey(mod, net, depth));
}
function limitNode(net, depth) {
    return {
        kind: 'note',
        label: `${net}（已达深度上限 ${depth - 1} 层）`,
        description: '可在设置中调大 sigroute.maxDepth',
        flags: ['limit'],
        children: [],
    };
}
/**
 * 判断用户光标下的标识符应该以哪个模块为起点。
 * 关键场景：用户把光标放在例化语句的端口名上（如 .i_data(s_data) 里的 i_data），
 * 此时 i_data 不是当前模块的信号，而应该视为子模块的端口。
 */
function resolveStartPoint(indexer, mod, net) {
    const kind = indexer.lookupSignal(mod, net);
    if (kind !== 'unknown')
        return { module: mod, net };
    // 该名字不属于当前模块：尝试当作某个子实例的端口名
    const hits = [];
    for (const inst of mod.instances) {
        for (const conn of inst.connections) {
            const pname = resolveConnPort(indexer, inst.moduleType, conn);
            if (pname !== net)
                continue;
            const sub = indexer.getModule(inst.moduleType);
            if (sub)
                hits.push({ sub, instName: inst.instanceName });
        }
    }
    if (hits.length === 1) {
        return {
            module: hits[0].sub,
            net,
            note: `按子模块端口解析：${hits[0].instName} 的 .${net}`,
        };
    }
    if (hits.length > 1) {
        // 多个候选，取成员数最多的那个模块作为主解释
        let best = hits[0];
        for (const h of hits) {
            if (h.sub.instances.length > best.sub.instances.length)
                best = h;
        }
        return {
            module: best.sub,
            net,
            note: `该端口名在多个子实例中出现（${hits.length} 处），已选择 ${best.sub.name}`,
        };
    }
    // 该名字既不属于当前模块、也不是当前模块的端口名
    // -> 全局搜索谁声明了它（用户往往只知道信号名，不知道它属于哪个模块）
    const decls = indexer.findModulesDeclaring(net);
    if (decls.length === 1) {
        return {
            module: decls[0],
            net,
            note: `该名称不属于 ${mod.name}，已自动切换到声明它的模块 ${decls[0].name}`,
        };
    }
    if (decls.length > 1) {
        // 优先选当前模块的直接子模块，其次选层次最高（例化数最多）的
        const subNames = new Set(mod.instances.map((i) => i.moduleType));
        const preferred = decls.find((m) => subNames.has(m.name)) ??
            decls.reduce((a, b) => (a.instances.length >= b.instances.length ? a : b));
        const others = decls
            .filter((m) => m !== preferred)
            .map((m) => m.name)
            .slice(0, 5);
        return {
            module: preferred,
            net,
            note: `该名称在 ${decls.length} 个模块中出现，已选择 ${preferred.name}` +
                (others.length > 0 ? `（其他：${others.join('、')}${decls.length > 6 ? ' …' : ''}）` : ''),
        };
    }
    return { module: mod, net };
}
//# sourceMappingURL=graph.js.map