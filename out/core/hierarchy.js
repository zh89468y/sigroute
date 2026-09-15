"use strict";
/**
 * 信号层次路径
 *
 * 回答一个非常日常的问题：这根信号在层次树里的完整称呼是什么？
 *   例如 `top_fpga.u_a.u_b.s_data`
 *
 * 为什么需要：模块内部的信号名（`s_data`）在工程里可能有几十处同名，
 * 人类交流、写文档、定位问题时用的是"从顶层数下来的路径"。
 * 以前只能一层层手动往上跳（每次都要重新定位光标），现在一次给全。
 *
 * 歧义处理：同一个模块被多处例化时，向上会有多条路径 —— 全部列出（有上限），
 * 而不是随便挑一条装作唯一。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hierarchyPaths = hierarchyPaths;
exports.primaryPath = primaryPath;
/**
 * 求某（模块, 信号）在层次树中的全部路径。
 *
 * 实现要点：从当前模块出发，沿"谁例化了我"向上爬，直到没有被例化为止（顶层）。
 * 用的是模块级的例化反查，因此同一模块被多处例化时会自然分叉成多条路径。
 */
function hierarchyPaths(lookup, moduleName, net, opts = {}) {
    const maxPaths = Math.max(1, opts.maxPaths ?? 8);
    const maxDepth = Math.max(1, opts.maxDepth ?? 16);
    const climb = (name, depth, visited, budget) => {
        const mod = lookup.getModule(name);
        const base = {
            moduleName: name,
            file: mod?.file ?? '',
            line: mod?.headerLine ?? 0,
        };
        if (!mod || depth >= maxDepth || visited.has(name)) {
            return { paths: [{ text: name, steps: [base], partial: false }], truncated: false };
        }
        const sites = lookup.getInstantiations(name);
        if (sites.length === 0) {
            return { paths: [{ text: name, steps: [base], partial: false }], truncated: false };
        }
        const out = [];
        let truncated = false;
        for (const site of sites) {
            if (budget.left <= 0) {
                truncated = true;
                break;
            }
            if (visited.has(site.parentModule))
                continue;
            const nextVisited = new Set(visited);
            nextVisited.add(name);
            const parents = climb(site.parentModule, depth + 1, nextVisited, budget);
            if (parents.truncated)
                truncated = true;
            for (const p of parents.paths) {
                if (budget.left <= 0) {
                    truncated = true;
                    break;
                }
                budget.left--;
                out.push({
                    text: `${p.text}.${site.instance.instanceName}`,
                    steps: [
                        ...p.steps,
                        { moduleName: name, instanceName: site.instance.instanceName, file: mod.file, line: site.instance.line },
                    ],
                    partial: p.partial,
                });
            }
        }
        if (out.length === 0) {
            // 全是环或者全被预算砍掉：至少给出模块自身的路径
            return { paths: [{ text: name, steps: [base], partial: true }], truncated: true };
        }
        return { paths: out, truncated };
    };
    const budget = { left: maxPaths * 2 };
    const res = climb(moduleName, 0, new Set(), budget);
    const paths = res.paths.map((p) => ({
        text: p.text.endsWith(`.${net}`) ? p.text : `${p.text}.${net}`,
        steps: p.steps,
        partial: p.partial,
    }));
    // 去重（同一实例路径可能因为递归回溯被重复枚举）
    const seen = new Set();
    const unique = [];
    for (const p of paths) {
        if (seen.has(p.text))
            continue;
        seen.add(p.text);
        unique.push(p);
        if (unique.length >= maxPaths)
            break;
    }
    return unique;
}
/** 取最"像顶层"的那条路径，用于一行显示 */
function primaryPath(paths) {
    if (paths.length === 0)
        return undefined;
    // 层次越深越具体，优先展示最长的
    return paths.reduce((a, b) => (b.steps.length > a.steps.length ? b : a));
}
//# sourceMappingURL=hierarchy.js.map