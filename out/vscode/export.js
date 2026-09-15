"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toMermaid = toMermaid;
exports.toMarkdown = toMarkdown;
function fname(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
}
function sanitize(s) {
    return s.replace(/"/g, "'").replace(/[<>]/g, '');
}
/** 把追踪结果转成 Mermaid 流程图 */
function toMermaid(result, opts = {}) {
    const maxNodes = opts.maxNodes ?? 200;
    const dir = opts.direction ?? 'LR';
    const out = [`flowchart ${dir}`];
    const classAssign = { renamed: [], blackbox: [], constant: [], warn: [] };
    const idOf = new Map();
    let count = 0;
    let truncated = 0;
    const ensure = (n) => {
        const existing = idOf.get(n);
        if (existing)
            return existing;
        if (count >= maxNodes) {
            truncated++;
            return null;
        }
        const id = `n${count++}`;
        idOf.set(n, id);
        const sub = n.description ? `<br/><i>${sanitize(n.description)}</i>` : '';
        out.push(`  ${id}["${sanitize(n.label)}${sub}"]`);
        if (n.flags.includes('renamed'))
            classAssign.renamed.push(id);
        else if (n.kind === 'blackbox')
            classAssign.blackbox.push(id);
        else if (n.kind === 'constant')
            classAssign.constant.push(id);
        else if (n.flags.includes('partial') || n.flags.includes('limit'))
            classAssign.warn.push(id);
        return id;
    };
    const walk = (n, parentId) => {
        const id = ensure(n);
        if (id === null)
            return;
        if (parentId) {
            const label = n.edgeText ? sanitize(n.edgeText) : '';
            out.push(`  ${parentId} -->|"${label}"| ${id}`);
        }
        for (const c of n.children)
            walk(c, id);
    };
    walk(result.root, null);
    out.push('');
    out.push('  classDef renamed fill:#fff4d6,stroke:#e0a800,stroke-width:2px;');
    out.push('  classDef blackbox fill:#ffe3e3,stroke:#dc3545,stroke-dasharray:5 5;');
    out.push('  classDef constant fill:#eef0f2,stroke:#6c757d,stroke-dasharray:2 2;');
    out.push('  classDef warn fill:#fdf0d5,stroke:#c98a00,stroke-dasharray:3 3;');
    for (const [cls, ids] of Object.entries(classAssign)) {
        if (ids.length > 0)
            out.push(`  class ${ids.join(',')} ${cls};`);
    }
    if (truncated > 0) {
        out.push('');
        out.push(`  %% 为了保持可读性，省略了 ${truncated} 个节点（可用 sigroute.maxDepth 或导出 Markdown 查看完整链路）`);
    }
    return out.join('\n');
}
/** 把追踪结果转成 Markdown 报告 */
function toMarkdown(result) {
    const { start, stats, modules, root } = result;
    const md = [];
    md.push(`# 信号路由报告：\`${start.netName}\``);
    md.push('');
    md.push(`| 项目 | 值 |`);
    md.push(`| --- | --- |`);
    md.push(`| 起点模块 | \`${start.moduleName}\` |`);
    md.push(`| 端口方向 | ${start.direction ?? '内部信号'} |`);
    md.push(`| 声明位置 | \`${fname(start.file)}:${start.line + 1}\` |`);
    md.push(`| 经过模块数 | ${modules.length} |`);
    md.push(`| 链路节点数 | ${stats.nodes} |`);
    md.push(`| 跨模块改名 | ${stats.renames} 处 |`);
    md.push(`| 黑盒 / IP | ${stats.blackboxes} 处 |`);
    md.push(`| 不确定点 | ${stats.uncertainties} 处 |`);
    md.push(`| 最大追踪深度 | ${stats.maxDepthReached} 层 |`);
    md.push('');
    md.push(`## 经过的模块`);
    md.push('');
    md.push(modules.map((m) => `\`${m}\``).join(' → '));
    md.push('');
    const FLAG_MARK = {
        renamed: '🔶 **改名**',
        bitselect: '✂ 位选',
        partial: '⚠ 不完整',
        loop: '↺ 已展开',
        limit: '… 截断',
        constant: '▪ 常量',
        unconnected: '⊘ 悬空',
        generate: '⚙ generate',
        always: '⏱ 过程块',
        intra: '· 模块内',
        budget: '… 超预算',
        ambiguous: '❓ 多路径',
    };
    const render = (n, depth, isLast, prefix) => {
        const indent = '  '.repeat(depth);
        const mark = n.flags.map((f) => FLAG_MARK[f]).filter(Boolean).join(' ');
        const loc = n.description ? ` — \`${n.description}\`` : '';
        const edge = n.edgeText && depth > 0 ? ` ⟵ _${n.edgeText}_` : '';
        md.push(`${indent}- **${n.label}**${edge}${loc}${mark ? `  ${mark}` : ''}`);
        n.children.forEach((c, i) => render(c, depth + 1, i === n.children.length - 1, prefix));
    };
    md.push(`## 完整链路`);
    md.push('');
    md.push(`- **${root.label}** — \`${root.description ?? ''}\``);
    for (const group of root.children) {
        md.push('');
        md.push(`### ${group.label}`);
        md.push('');
        group.children.forEach((c) => render(c, 0, false, ''));
    }
    md.push('');
    md.push(`---`);
    md.push('');
    md.push(`> 由 SigRoute 静态分析生成。标注为"不完整/黑盒"的位置是静态分析无法确定的部分，`);
    md.push(`> 精确结果需要 RTL elaboration（Vivado / Verilator）后端支持。`);
    md.push('');
    return md.join('\n');
}
//# sourceMappingURL=export.js.map