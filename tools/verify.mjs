/**
 * SigRoute 解析器验证脚本 —— 直接在真实的 FPGA 工程上跑，量化准确率。
 *
 * 用法：
 *   node tools/verify.mjs [工程根目录] [选项]
 *
 * 选项：
 *   --scope <子目录>      只扫描指定子目录（例如 --scope src 只看自研代码）
 *   --modules             打印模块清单（按例化数排序）
 *   --unresolved          打印未匹配到定义的模块名 TOP N
 *   --trace <信号名>       追踪指定信号并打印链路树
 *   --module <模块名>      指定追踪起点模块
 *   --mermaid <信号名>     输出 Mermaid 图
 *   --json                以 JSON 输出统计结果（便于脚本化对比）
 *
 * 依赖 Node >= 22.6（原生 type stripping），不需要 npm install、不需要编译。
 */

import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 让 Node 解析无扩展名的相对 import
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'src');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : path.join(srcDir, '_');
      const cand = path.resolve(path.dirname(parent), `${specifier}.ts`);
      if (fs.existsSync(cand)) {
        return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { WorkspaceIndexer } = await import('../src/core/indexer.ts');
const { traceSignal, resolveStartPoint } = await import('../src/core/graph.ts');

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const positionals = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    continue;
  }
  positionals.push(argv[i]);
}

const PROJECT_ROOT = path.resolve(positionals[0] ?? path.resolve(here, '..', '..'));
const SCOPE = getFlag('scope');
const SCAN_ROOT = SCOPE ? path.join(PROJECT_ROOT, SCOPE) : PROJECT_ROOT;

// ---------------------------------------------------------------- 文件提供者（Node 版）
const SKIP_DIR = /(^|[\\/])(node_modules|\.git|\.vscode)([\\/]|$)|\.(cache|sim|runs|hw|ip_user_files|gen|rpt|jou|log)([\\/]|$)/i;

const provider = {
  async listFiles() {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 12) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || SKIP_DIR.test(p + path.sep)) continue;
          walk(p, depth + 1);
        } else if (/\.(v|sv|vh|svh)$/i.test(e.name) && !/_sim_netlist\.v$/i.test(e.name)) {
          // 与插件默认配置一致：保留 IP 的 *_stub.v（端口方向来源），排除仿真网表
          out.push(p.replace(/\\/g, '/'));
        }
      }
    };
    walk(SCAN_ROOT, 0);
    return out;
  },
  async readFile(p) {
    return fs.readFileSync(p, 'utf8');
  },
  async exists(p) {
    return fs.existsSync(p);
  },
  async resolveInclude(fromFile, includeName) {
    const cand = path.join(path.dirname(fromFile), includeName);
    return fs.existsSync(cand) ? cand : null;
  },
};

// ---------------------------------------------------------------- 主流程
if (!hasFlag('json')) {
  console.log(`\n=== SigRoute 解析器验证 ===`);
  console.log(`工程根目录: ${PROJECT_ROOT}`);
  console.log(`扫描范围  : ${SCAN_ROOT}\n`);
}

const splitList = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const indexer = new WorkspaceIndexer();
indexer.setOptions({
  honorIfdef: !hasFlag('no-ifdef'),
  maxInstancesPerModule: 500,
  extraDefines: splitList(getFlag('defines')),
  undefines: splitList(getFlag('undefines')),
});

const t0 = Date.now();
await indexer.build(provider);
const idx = indexer.current;
const s = idx.stats;
const buildMs = Date.now() - t0;

// ---------- 准确率量化 ----------
let totalConn = 0;
let namedConn = 0;
let positionalConn = 0;
let resolvedPort = 0;
let portNotFound = 0;
let emptyConn = 0;
let constConn = 0;
let exprConn = 0;
let netConn = 0;

let instTotal = 0;
let instResolved = 0;
const unresolvedModuleNames = new Map();
/** 只在"已知模块内部"统计连接，避免黑盒污染准确率 */
const portMissSamples = [];

for (const [, mods] of idx.modules) {
  for (const mod of mods) {
    for (const inst of mod.instances) {
      instTotal++;
      const sub = indexer.getModule(inst.moduleType);
      if (!sub) {
        unresolvedModuleNames.set(inst.moduleType, (unresolvedModuleNames.get(inst.moduleType) ?? 0) + 1);
        continue;
      }
      instResolved++;
      for (const c of inst.connections) {
        totalConn++;
        if (c.kind === 'unconnected') emptyConn++;
        else if (c.kind === 'constant') constConn++;
        else if (c.kind === 'net') netConn++;
        else exprConn++;

        if (c.port !== null) {
          namedConn++;
          if (sub.ports.some((p) => p.name === c.port)) resolvedPort++;
          else {
            portNotFound++;
            if (portMissSamples.length < 15) {
              portMissSamples.push(`${mod.name}.${inst.instanceName}(${inst.moduleType}).${c.port}  @ ${path.basename(mod.file)}:${c.line + 1}`);
            }
          }
        } else {
          positionalConn++;
        }
      }
    }
  }
}

const stats = {
  files: s.fileCount,
  modules: s.moduleCount,
  instances: s.instanceCount,
  buildMs,
  instTotal,
  instResolved,
  instResolvedPct: pctNum(instResolved, instTotal),
  connTotal: totalConn,
  namedConn,
  namedPct: pctNum(namedConn, totalConn),
  positionalConn,
  positionalPct: pctNum(positionalConn, totalConn),
  portResolvedPct: pctNum(resolvedPort, namedConn),
  portNotFound,
  netConn,
  exprConn,
  constConn,
  emptyConn,
  sourceModulePct: pctNum(netConn + exprConn + constConn > 0 ? netConn : 0, totalConn),
};

if (hasFlag('json')) {
  console.log(JSON.stringify(stats, null, 2));
} else {
  console.log(`【索引】`);
  console.log(`  文件        : ${stats.files}`);
  console.log(`  模块        : ${stats.modules}`);
  console.log(`  例化        : ${stats.instances}`);
  console.log(`  宏定义      : ${idx.defines.size}`);
  console.log(`  耗时        : ${buildMs}ms`);
  console.log(`  顶层候选    : ${idx.topCandidates.length} 个`);

  console.log(`\n【例化解析】`);
  console.log(`  例化总数                : ${instTotal}`);
  console.log(`  能匹配到模块定义        : ${instResolved}  (${stats.instResolvedPct}%)`);
  console.log(`  未匹配（IP/黑盒/未纳入）: ${instTotal - instResolved}  (${pctNum(instTotal - instResolved, instTotal)}%)`);

  console.log(`\n【端口连接解析】（分母 = 子模块已定位的连接）`);
  console.log(`  连接总数                : ${totalConn}`);
  console.log(`  命名连接 .port(expr)    : ${namedConn}  (${stats.namedPct}%)`);
  console.log(`  位置连接                : ${positionalConn}  (${stats.positionalPct}%)`);
  console.log(`  端口名能在子模块中找到  : ${resolvedPort}/${namedConn}  (${stats.portResolvedPct}%)  <-- 解析准确率核心指标`);

  console.log(`\n【连接类型分布】`);
  console.log(`  纯网络 net              : ${netConn}  (${pctNum(netConn, totalConn)}%)`);
  console.log(`  表达式/拼接             : ${exprConn}  (${pctNum(exprConn, totalConn)}%)`);
  console.log(`  常量                    : ${constConn}  (${pctNum(constConn, totalConn)}%)`);
  console.log(`  空连接（悬空）          : ${emptyConn}  (${pctNum(emptyConn, totalConn)}%)`);

  if (portMissSamples.length > 0) {
    console.log(`\n【端口名未命中样例】`);
    for (const x of portMissSamples) console.log(`  ${x}`);
  }
}

if (hasFlag('macros')) {
  const list = [...idx.defines].sort();
  console.log(`\n【识别到的编译宏】共 ${list.length} 个`);
  for (const m of list) console.log(`  ${m}`);
  if (idx.includes.size > 0) {
    console.log(`\n【\`include 的文件】`);
    for (const i of idx.includes) console.log(`  ${i}`);
  }
}

if (hasFlag('unresolved')) {
  console.log(`\n【未匹配到定义的模块名 TOP25】`);
  const sorted = [...unresolvedModuleNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [name, cnt] of sorted) console.log(`  ${String(cnt).padStart(5)}  ${name}`);
}

if (hasFlag('modules')) {
  console.log(`\n【模块清单（按例化数排序，前 40）】`);
  const list = [];
  for (const [name, mods] of idx.modules) {
    list.push([name, mods.length, mods[0].ports.length, mods[0].instances.length]);
  }
  list.sort((a, b) => b[3] - a[3]);
  for (const [name, dup, ports, insts] of list.slice(0, 40)) {
    console.log(
      `  ${name.padEnd(32)} 端口${String(ports).padStart(4)}  例化${String(insts).padStart(4)}${dup > 1 ? `  (${dup} 处定义)` : ''}`,
    );
  }
}

// ---------- 追踪 ----------
const traceNet = getFlag('trace') ?? getFlag('mermaid') ?? getFlag('graph');
if (traceNet) {
  const moduleName = getFlag('module');
  let mod;
  if (moduleName) {
    mod = indexer.getModule(moduleName);
    if (!mod) {
      console.error(`\n找不到模块 ${moduleName}`);
      process.exit(1);
    }
  } else {
    mod = pickStartModule(indexer, idx);
  }
  if (!mod) {
    console.error('\n无法确定起点模块，请用 --module 指定');
    process.exit(1);
  }

  const sp = resolveStartPoint(indexer, mod, traceNet);
  const t1 = Date.now();
  const result = traceSignal(indexer, sp.module, sp.net, { direction: 'both', maxDepth: 30 });
  const cost = Date.now() - t1;

  console.log(`\n【追踪 ${traceNet}】起点 ${sp.module.name}${sp.note ? ` (${sp.note})` : ''}  耗时 ${cost}ms`);
  console.log(
    `  节点 ${result.stats.nodes} · 模块 ${result.modules.length} · 改名 ${result.stats.renames} · 黑盒 ${result.stats.blackboxes} · 不确定 ${result.stats.uncertainties}`,
  );

  // 层次路径（从顶层数下来这根信号怎么称呼）
  const { hierarchyPaths } = await import('../src/core/hierarchy.ts');
  const paths = hierarchyPaths(indexer, sp.module.name, sp.net, { maxPaths: 6 });
  if (paths.length > 0) {
    console.log(`  层次路径（${paths.length} 条${paths.length > 1 ? '，同一模块被多处例化' : ''}）:`);
    for (const p of paths) console.log(`    ${p.text}${p.partial ? '   (可能不完整)' : ''}`);
  }

  if (hasFlag('graph')) {
    const { layoutSignalGraph, filterGraphByHops, mergeParallelEdges } = await import('../src/core/layout.ts');
    const dir = hasFlag('td') ? 'TD' : 'LR';
    const hopsArg = getFlag('hops');
    const hops = hopsArg !== undefined ? Number(hopsArg) : 0;

    const merged = hasFlag('no-merge') ? result.graph : mergeParallelEdges(result.graph);
    const shown = filterGraphByHops(merged, hops);
    printGraph(shown, layoutSignalGraph(shown, { direction: dir }));

    if (shown !== merged || merged !== result.graph) {
      const notes = [];
      if (shown !== merged) notes.push(`按 ${hops} 跳裁剪`);
      if (merged !== result.graph) notes.push(`合并了同向并列连接`);
      console.log(
        `  （${notes.join('；')}；原始共 ${result.graph.nodes.length} 个模块 / ${result.graph.edges.length} 条连线）`,
      );
      console.log('');
    }
  } else if (hasFlag('mermaid')) {
    const { toMermaid } = await import('../src/vscode/export.ts');
    console.log(`\n${toMermaid(result)}`);
  } else {
    console.log('');
    printTree(result.root, '');
  }

  if (hasFlag('offsets')) {
    verifyOffsets(result);
  }

  if (hasFlag('describe')) {
    const { describeSignal } = await import('../src/core/describe.ts');
    const d = describeSignal(indexer, sp.module, sp.net);
    printDescribe(d);
  }
}

// ---------------------------------------------------------------- 速查（Hover 内容）
function printDescribe(d) {
  const declBits = [];
  if (d.decl.direction) declBits.push(d.decl.direction);
  else if (d.decl.signalKind) declBits.push(d.decl.signalKind);
  if (d.decl.range) declBits.push(d.decl.range);
  if (d.decl.width) declBits.push(`${d.decl.width} bit`);

  console.log('');
  console.log(`【速查 ${d.name}】 ${declBits.join(' ')}`);
  if (d.decl.kind === 'submodule-port') {
    console.log(`  声明: 模块 ${d.decl.subModule} 的端口（实例 ${d.decl.instanceName}） @ ${d.decl.file}:${(d.decl.line ?? 0) + 1}`);
  } else if (d.decl.kind !== 'unknown') {
    console.log(
      `  声明: ${d.moduleName} 中的 ${d.decl.kind === 'port' ? '端口' : '内部信号'} @ ${d.decl.file}:${(d.decl.line ?? 0) + 1}`,
    );
  } else {
    console.log(`  声明: 未找到`);
  }

  const inner = (list) => list.filter((r) => r.kind !== 'parent-conn');
  const outer = (list) => list.filter((r) => r.kind === 'parent-conn');

  const show = (title, list) => {
    if (list.length === 0) return;
    console.log(`  ${title} (${list.length}):`);
    for (const r of list) {
      console.log(`    - ${r.text}${r.detail ? '  — ' + r.detail : ''}  @ ${path.basename(r.file)}:${r.line + 1}`);
    }
  };

  show('驱动源', inner(d.drivers));
  show('负载', inner(d.loads));
  show('上级模块连接（可跳出本模块）', outer([...d.drivers, ...d.loads]));

  if (d.aliases && d.aliases.length > 0) {
    console.log(`  同网络别名 (${d.aliases.length}) —— 同一根线在别处叫什么:`);
    for (const a of d.aliases.slice(0, 12)) {
      console.log(`    - ${a.module}.${a.net}   ${a.direction ?? a.kind}${a.instances > 1 ? `   (该模块例化 ${a.instances} 次)` : ''}`);
    }
    if (d.aliases.length > 12) console.log(`    …另有 ${d.aliases.length - 12} 个`);
  }
  console.log('');
}

// ---------------------------------------------------------------- 跳转位置校验
/**
 * 校验"点击树节点后能否精确选中信号名"。
 * 树节点带 file/line/offset 三个定位信息，其中 offset 应当正好指向标识符首字符；
 * 若偏差，跳转会选中错误的词。
 */
function verifyOffsets(result) {
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) {
      try { cache.set(f, fs.readFileSync(f, 'utf8')); } catch { cache.set(f, ''); }
    }
    return cache.get(f);
  };
  const nameOf = (label) => {
    const t = String(label).trim();
    return (/^([A-Za-z_][A-Za-z0-9_$]*)/.exec(t) ?? [])[1];
  };

  const lineIndexOf = (text, name) => {
    const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
    let from = 0;
    for (;;) {
      const i = text.indexOf(name, from);
      if (i < 0) return -1;
      const b = i > 0 ? text[i - 1] : '';
      const a = i + name.length < text.length ? text[i + name.length] : '';
      if (!isWord(b) && !isWord(a)) return i;
      from = i + 1;
    }
  };

  let signalNodes = 0;
  let withOffset = 0;
  let hit = 0;
  let fallbackTried = 0;
  let fallbackOk = 0;
  const bad = [];
  const fallbackBad = [];

  const walk = (n) => {
    if (n.kind === 'signal') {
      signalNodes++;
      const name = nameOf(n.label);
      if (!n.file || !name) {
        n.children.forEach(walk);
        return;
      }
      if (typeof n.offset === 'number') {
        withOffset++;
        const slice = read(n.file).slice(n.offset, n.offset + 48);
        if (slice.startsWith(name)) hit++;
        else {
          bad.push({
            label: n.label,
            loc: `${path.basename(n.file)}:${(n.line ?? 0) + 1}`,
            got: slice.slice(0, 40).replace(/\n/g, '\\n'),
          });
        }
      } else if (typeof n.line === 'number') {
        // 模拟 revealLocation 的行内查找兜底
        fallbackTried++;
        const lineText = (read(n.file).split(/\r?\n/)[n.line] ?? '');
        if (lineIndexOf(lineText, name) >= 0) fallbackOk++;
        else {
          fallbackBad.push({
            label: n.label,
            loc: `${path.basename(n.file)}:${n.line + 1}`,
            line: lineText.trim().slice(0, 56),
          });
        }
      }
    }
    n.children.forEach(walk);
  };
  walk(result.root);

  const pct = withOffset ? ((hit / withOffset) * 100).toFixed(1) : '0';
  const fbPct = fallbackTried ? ((fallbackOk / fallbackTried) * 100).toFixed(1) : '0';

  console.log('');
  console.log('【跳转位置校验】signal 类型的树节点');
  console.log(`  节点总数    : ${signalNodes}`);
  console.log(`  精确偏移    : ${withOffset}  命中 ${hit}  (${pct}%)   <-- 命中才能正好选中信号名`);
  console.log(`  行内查找兜底: ${fallbackTried}  命中 ${fallbackOk}  (${fbPct}%)`);
  if (bad.length > 0) {
    console.log(`  偏移偏差 ${bad.length} 处，样例：`);
    for (const b of bad.slice(0, 10)) {
      console.log(`    ✗ ${b.label}  @ ${b.loc}   实际内容 "${b.got}"`);
    }
  }
  if (fallbackBad.length > 0) {
    console.log(`  兜底失败 ${fallbackBad.length} 处，样例：`);
    for (const b of fallbackBad.slice(0, 10)) {
      console.log(`    ✗ ${b.label}  @ ${b.loc}   行内容 "${b.line}"`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------- 框图（ASCII）
function printGraph(g, lay) {
  const W = 24;
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const hopInfo = g.nodes.map((n) => `${n.moduleName}:h${n.hop}`).join(' ');
  const byCol = new Map();
  for (const n of lay.nodes) {
    if (!byCol.has(n.column)) byCol.set(n.column, []);
    byCol.get(n.column).push(n);
  }
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  const maxRows = Math.max(...cols.map((c) => byCol.get(c).length));

  console.log('');
  console.log(`【框图】${g.stats.nodes} 个模块 · ${g.stats.edges} 条连线 · ${g.stats.renames} 处改名`);
  if (process.env.SIGROUTE_DEBUG) {
    console.log(`  hop: ${hopInfo}`);
  }

  const header = cols.map((c) => {
    const tag = c === 0 ? '起点' : c < 0 ? `上游${-c}` : `下游${c}`;
    return center(`[${tag}]`, W);
  });
  console.log('');
  console.log('  ' + header.join('   '));
  console.log('  ' + cols.map(() => '-'.repeat(W)).join('   '));

  for (let r = 0; r < maxRows; r++) {
    const cells = cols.map((c) => {
      const node = byCol.get(c)[r];
      if (!node) return [' '.repeat(W), ' '.repeat(W), ' '.repeat(W)];
      const meta = nodeById.get(node.id);
      const mark = meta.isStart ? ' *' : meta.blackbox ? ' ?' : '';
      return [
        '┌' + '─'.repeat(W - 2) + '┐',
        '│' + center(trunc(meta.moduleName, W - 4) + mark, W - 2) + '│',
        '└' + '─'.repeat(W - 2) + '┘',
      ];
    });
    for (let line = 0; line < 3; line++) {
      console.log('  ' + cells.map((c) => c[line]).join('   '));
    }
  }

  console.log('');
  console.log('  连线（信号流向）：');
  for (const e of g.edges) {
    const flag = e.renamed ? '  [改名]' : '';
    const cnt = e.count > 1 ? `  ×${e.count}` : '';
    const loc = e.file ? `   @ ${path.basename(e.file)}:${(e.line ?? 0) + 1}` : '';
    const arrow = e.renamed ? '==>' : '-->';
    console.log(
      `    ${e.from.padEnd(22)} ${arrow} ${e.to.padEnd(22)} ${e.fromNet}${e.renamed ? ' => ' + e.toNet : ''}${cnt}${flag}${loc}`,
    );
  }
  console.log('');
}

function center(s, w) {
  if (s.length >= w) return s.slice(0, w);
  const left = Math.floor((w - s.length) / 2);
  return ' '.repeat(left) + s + ' '.repeat(w - s.length - left);
}

function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------- 工具
function pctNum(a, b) {
  if (!b) return 0;
  return Number(((a / b) * 100).toFixed(1));
}

function pickStartModule(indexer, idx) {
  // 优先挑"看起来是设计顶层"的模块：位于工程 src 下、有例化、名字以 top 开头
  const candidates = idx.topCandidates
    .map((n) => indexer.getModule(n))
    .filter((m) => m && m.instances.length > 0);
  const preferred = candidates.find((m) => /^top[_-]/i.test(m.name) && !/fpga\.srcs|\.gen|ip_user_files/i.test(m.file));
  if (preferred) return preferred;
  return candidates.find((m) => !/\.srcs|\.gen|ip_user_files/i.test(m.file)) ?? candidates[0];
}

function printTree(node, prefix, depth = 0) {
  const marker = node.flags.length ? ` [${node.flags.join(',')}]` : '';
  const desc = node.description ? `  — ${node.description}` : '';
  const edge = node.edgeText ? `  ⟵ ${node.edgeText}` : '';
  console.log(`${prefix}${node.label}${edge}${desc}${marker}`);
  node.children.forEach((c, i) => {
    const last = i === node.children.length - 1;
    printTree(c, `${prefix}${last ? '   ' : '│  '}`, depth + 1);
  });
}
