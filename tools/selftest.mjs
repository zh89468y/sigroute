/**
 * SigRoute 自检（无依赖、不需要真实工程）
 *
 * 在临时目录里生成一个极小的 RTL 夹具，覆盖本次改动的关键行为：
 *   - `include 内联（端口列表写在 .vh 里）+ 位置重映射
 *   - 网络等价类（改名反查 / 别名）
 *   - 层次路径
 *   - generate for 的实例名还原
 *   - 追踪结果里的跨模块标记 / 链路摘要 / 可继续展开
 *   - 树视图过滤
 *   - 索引序列化往返（缓存）
 *
 * 用法：node tools/selftest.mjs
 * 依赖 Node >= 22.6（原生 type stripping）
 */

import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'src');
const vscodeStub = path.join(here, 'vscode-stub.mjs');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') {
      return { url: pathToFileURL(vscodeStub).href, shortCircuit: true };
    }
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : path.join(srcDir, '_');
      const cand = path.resolve(path.dirname(parent), `${specifier}.ts`);
      if (fs.existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { WorkspaceIndexer } = await import('../src/core/indexer.ts');
const { traceSignal } = await import('../src/core/graph.ts');
const { hierarchyPaths } = await import('../src/core/hierarchy.ts');
const { serializeIndex, deserializeIndex } = await import('../src/core/cache.ts');
const { layoutSignalGraph, filterGraphByHops, mergeParallelEdges, computeHierarchyFrames } =
  await import('../src/core/layout.ts');
const { TraceTreeProvider } = await import('../src/vscode/traceTree.ts');

// ---------------------------------------------------------------- 夹具

const FILES = {
  'defs.vh': [`// 只有宏，没有模块定义`, '`define SIGROUTE_TEST 1', ''].join('\n'),

  'ports.vh': [
    '  input  wire       clk,',
    '  input  wire [7:0] i_a,',
    '  output wire [7:0] o_b,',
    '',
  ].join('\n'),

  'child.v': [
    'module child (',
    '`include "ports.vh"',
    ');',
    '  assign o_b = i_a;',
    'endmodule',
    '',
  ].join('\n'),

  'mid.v': [
    'module mid (',
    '  input  wire       clk,',
    '  input  wire [7:0] i_p,',
    '  output wire [7:0] o_q',
    ');',
    '  assign o_q = i_p;',
    'endmodule',
    '',
  ].join('\n'),

  'leaf.v': ['module leaf (', '  input wire [7:0] i_d', ');', 'endmodule', ''].join('\n'),

  // taskfn.v：验证"函数 / 任务之后的例化不会被吞掉"（曾经被整段吃掉：
  // skipToKeyword 把起点关键字也算进嵌套深度，多吞一层直到文件末尾）
  'taskfn.v': [
    'module taskfn (',
    '  input  wire       i_clk,',
    '  input  wire [7:0] i_a,',
    '  output wire [7:0] o_b',
    ');',
    '  function [7:0] add1;',
    '    input [7:0] x;',
    '    begin add1 = x + 1; end',
    '  endfunction',
    '  task do_nothing;',
    '    begin end',
    '  endtask',
    '  wire [7:0] s_x = add1(i_a);',
    // 用一个别处没被例化的模块（proc），免得把 child 变成"被多处例化"而触发
    // 等价类的"汇聚端口不并"规则，干扰上面的别名断言
    '  proc u_proc (.i_clk(i_clk), .i_a(s_x), .i_b(1\'b0), .o_q(o_b));',
    'endmodule',
    '',
  ].join('\n'),

  // proc.v：过程块（验证"点过程块节点会选中块内的目标信号"）
  'proc.v': [
    'module proc (',
    '  input  wire       i_clk,',
    '  input  wire [7:0] i_a,',
    '  input  wire       i_b,',
    '  output reg  [7:0] o_q',
    ');',
    '  always @(posedge i_clk) begin',
    '    if (i_b) o_q <= i_a;',
    '    else o_q <= 8\'d0;',
    '  end',
    'endmodule',
    '',
  ].join('\n'),

  // regfile.v：always 体是 if / case 语句（没有 begin/end 包 case）。
  // 曾经的 bug：块体被截断到复位分支的第一个分号，于是 case 里的写寄存器语句
  // 整段没被收集 —— 真实工程里表现为"这些寄存器找不到驱动源"。
  'regfile.v': [
    'module regfile (',
    '  input  wire       i_clk,',
    '  input  wire       i_rst_n,',
    '  input  wire       i_wr_en,',
    '  input  wire [7:0] i_wr_data,',
    '  output reg  [7:0] o_num,',
    '  output reg        o_mode,',
    '  output reg  [7:0] o_mux',
    ');',
    '  wire [7:0] s_sel = i_wr_en ? i_wr_data : 8\'d0;',
    "  wire [7:0] s_const = 8'h5a;",
    '  always @(posedge i_clk)',
    '    if (!i_rst_n)',
    '      begin',
    "        o_num  <= 8'd0;",
    "        o_mode <= 1'b0;",
    '      end',
    '    else if (i_wr_en)',
    '      case (i_wr_data[3:0])',
    "        4'h1: o_num  <= i_wr_data;",
    "        4'h2: o_mode <= i_wr_data[0];",
    "        default: o_mode <= 1'b0;",
    '      endcase',
    '',
    '  always @(*)',
    '    case (i_wr_data[5:4])',
    "      2'd0: o_mux = i_wr_data;",
    "      default: o_mux = 8'hff;",
    '    endcase',
    '',
    // 最常见的写法：块体就是一条赋值（连 if 和 begin 都没有）
    '  reg r_plain;',
    '  always @(posedge i_clk)',
    '    r_plain <= i_wr_data[0];',
    'endmodule',
    '',
  ].join('\n'),

  // fan / fana / fanb / fanc / fand：
  //   fan  → fana + fanb（同一父模块下的同层兄弟，验证层次框）
  //   fana → fanc + fand（深层的分叉，验证"默认只展开两层"）
  'fana.v': [
    'module fana (',
    '  input wire [7:0] i_d',
    ');',
    '  fanc u_x (.i_d(i_d));',
    '  fand u_y (.i_d(i_d));',
    'endmodule',
    '',
  ].join('\n'),
  'fanb.v': ['module fanb (', '  input wire [7:0] i_d', ');', 'endmodule', ''].join('\n'),
  'fanc.v': ['module fanc (', '  input wire [7:0] i_d', ');', 'endmodule', ''].join('\n'),
  'fand.v': ['module fand (', '  input wire [7:0] i_d', ');', 'endmodule', ''].join('\n'),
  'fan.v': [
    'module fan (',
    '  input wire [7:0] i_d',
    ');',
    '  fana u_a (.i_d(i_d));',
    '  fanb u_b (.i_d(i_d));',
    'endmodule',
    '',
  ].join('\n'),

  'lanes.v': [
    'module lanes (',
    '  input wire [7:0] i_d',
    ');',
    '  generate',
    '    for (i = 0; i < 4; i = i + 1) begin : g_lane',
    '      leaf u_leaf (.i_d(i_d));',
    '    end',
    '  endgenerate',
    'endmodule',
    '',
  ].join('\n'),

  'top.v': [
    '`include "defs.vh"',
    'module top (',
    '  input  wire       clk,',
    '  input  wire [7:0] i_ext,',
    '  output wire [7:0] o_ext',
    ');',
    '  wire [7:0] s_mid;',
    '  child u_child (.clk(clk), .i_a(i_ext), .o_b(s_mid));',
    '  mid   u_mid   (.clk(clk), .i_p(s_mid), .o_q(o_ext));',
    '  lanes u_lanes (.i_d(s_mid));',
    // 下面 3 个负载是为了把 s_mid 的扇出顶到分支上限之上（引擎里 maxChildren 最小为 4）
    '  leaf  u_l1    (.i_d(s_mid));',
    '  leaf  u_l2    (.i_d(s_mid));',
    '  leaf  u_l3    (.i_d(s_mid));',
    '  fan   u_fan   (.i_d(s_mid));',
    'endmodule',
    '',
  ].join('\n'),
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigroute-selftest-'));
for (const [name, text] of Object.entries(FILES)) {
  fs.writeFileSync(path.join(root, name), text, 'utf8');
}

const provider = {
  async listFiles() {
    return fs
      .readdirSync(root)
      .filter((f) => /\.(v|sv|vh|svh)$/i.test(f))
      .map((f) => path.join(root, f).replace(/\\/g, '/'));
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
  async stat(p) {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
};

// ---------------------------------------------------------------- 断言

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? `  → ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

console.log('\n=== SigRoute 自检 ===\n');
console.log(`夹具目录: ${root}\n`);

const indexer = new WorkspaceIndexer();
indexer.setOptions({ honorIfdef: true, maxInstancesPerModule: 200, extraDefines: [], undefines: [], inlineIncludes: true });
await indexer.build(provider);
const idx = indexer.current;

// ---- 1. 索引与 include 内联 ----
console.log('[1] 索引与 `include 内联');
const child = indexer.getModule('child');
check('模块数 = 13', idx.modules.size === 13, `实际 ${idx.modules.size}`);
check(
  '内联了 2 处 include',
  indexer.buildStats.inlined === 2,
  `实际 ${indexer.buildStats.inlined}（skipped: ${indexer.buildStats.skippedIncludes.join('; ')}）`,
);
check('child 解析到 3 个端口', !!child && child.ports.length === 3, `实际 ${child?.ports.length}`);
check(
  'child 端口名正确',
  !!child && child.ports.map((p) => p.name).join(',') === 'clk,i_a,o_b',
  child?.ports.map((p) => p.name).join(','),
);
check(
  'child 端口方向正确',
  !!child && child.ports.map((p) => p.direction).join(',') === 'input,input,output',
  child?.ports.map((p) => p.direction).join(','),
);
check('child.i_a 位宽 = 8', !!child && child.ports[1].width === 8, String(child?.ports[1].width));
check(
  '来自 .vh 的端口位置折叠到 include 行（第 2 行）',
  !!child && child.ports[0].line === 1,
  `实际行 ${child ? child.ports[0].line + 1 : '?'}`,
);
check(
  'include 之后的位置仍然精确（assign 的偏移能在原文件里对上）',
  (() => {
    if (!child) return false;
    const src = fs.readFileSync(path.join(root, 'child.v'), 'utf8');
    const a = child.assigns[0];
    if (!a) return false;
    return src.slice(a.lhsOffsets[0], a.lhsOffsets[0] + 3) === 'o_b';
  })(),
  'assign 左值偏移未指向 o_b',
);

// ---- 2. 网络等价类 / 改名反查 ----
console.log('\n[2] 网络等价类（改名反查）');
const mid = indexer.getModule('mid');
const aliasesOfMidInput = indexer
  .netMembers('mid', 'i_p')
  .map((m) => `${m.module}.${m.net}`)
  .sort();
check(
  'mid.i_p 的等价类包含 top.s_mid / child.o_b / lanes.i_d',
  ['child.o_b', 'lanes.i_d', 'mid.i_p', 'top.s_mid'].every((x) => aliasesOfMidInput.includes(x)),
  aliasesOfMidInput.join(', '),
);
const extAliases = indexer.netMembers('child', 'i_a').map((m) => `${m.module}.${m.net}`).sort();
check(
  'child.i_a ⇄ top.i_ext（端口改名）',
  extAliases.includes('top.i_ext') && extAliases.length === 2,
  extAliases.join(', '),
);
check(
  'netAliases 会剔除自身',
  indexer.netAliases('child', 'i_a').every((m) => !(m.module === 'child' && m.net === 'i_a')),
);
check('mid 模块存在', !!mid);

// ---- 3. 层次路径 ----
console.log('\n[3] 层次路径');
const paths = hierarchyPaths(indexer, 'child', 'o_b', { maxPaths: 8 });
check(
  'child.o_b 的层次路径 = top.u_child.o_b',
  paths.some((p) => p.text === 'top.u_child.o_b'),
  paths.map((p) => p.text).join(' | '),
);
const deep = hierarchyPaths(indexer, 'leaf', 'i_d', { maxPaths: 8 });
check(
  'leaf.i_d 的路径穿过两层实例',
  deep.some((p) => p.text === 'top.u_lanes.g_lane[i].u_leaf.i_d'),
  deep.map((p) => p.text).join(' | '),
);

// ---- 4. generate for 实例名 ----
console.log('\n[4] generate for 实例名');
const lanes = indexer.getModule('lanes');
check(
  '实例名还原为 g_lane[i].u_leaf',
  !!lanes && lanes.instances[0]?.instanceName === 'g_lane[i].u_leaf',
  lanes?.instances[0]?.instanceName,
);

// ---- 5. 追踪：摘要 / 跨模块标记 / 可继续展开 ----
console.log('\n[5] 追踪结果');
const top = indexer.getModule('top');
const r1 = traceSignal(indexer, top, 's_mid', { direction: 'both', maxDepth: 10 });
const summary = r1.root.children.find((c) => c.flags.includes('summary'));
check('根节点下有链路摘要', !!summary, r1.root.children.map((c) => c.label).join(' | '));
check('统计里包含跨模块层数', r1.stats.maxDepthReached >= 1, String(r1.stats.maxDepthReached));

const walk = (n, fn) => {
  fn(n);
  n.children.forEach((c) => walk(c, fn));
};
const nodes = [];
walk(r1.root, (n) => nodes.push(n));
check('存在跨模块标记节点（cross）', nodes.some((n) => n.flags.includes('cross')));
check('跨模块节点带框图联动 key', nodes.some((n) => !!n.graphNodeKey && !!n.graphEdgeId));
check('跨模块节点带别名提示', nodes.some((n) => (n.aliases ?? []).length > 0));
check('框图节点 ≥ 3', r1.graph.nodes.length >= 3, String(r1.graph.nodes.length));
check('框图边 ≥ 2', r1.graph.edges.length >= 2, String(r1.graph.edges.length));

// ---- 可跳转节点必须有落点 ----
// 树视图与脑图都以 file + line 作为"能不能跳"的判据；terminal / constant / unconnected
// 这几类节点以前不带位置，点了没反应（用户实测反馈：点"顶层输入端口""常量"不跳转）。
const noTargetKinds = new Set(['group', 'note']); // 分组与说明节点本身不对应某一行代码
const missingTarget = [];
for (const [label, t] of [
  ['s_mid 双向', r1],
  ['i_ext 上游（顶层输入端口）', traceSignal(indexer, top, 'i_ext', { direction: 'up', maxDepth: 6 })],
  ['o_ext 下游（顶层输出端口）', traceSignal(indexer, top, 'o_ext', { direction: 'down', maxDepth: 6 })],
  ['proc.i_b 上游（常量）', traceSignal(indexer, indexer.getModule('proc'), 'i_b', { direction: 'up', maxDepth: 6 })],
]) {
  walk(t.root, (n) => {
    if (noTargetKinds.has(n.kind) || n.expandKey) return;
    if (n.file === undefined || n.line === undefined) missingTarget.push(`${label} / ${n.kind}:${n.label}`);
  });
}
check('所有可跳转节点都带落点（file+line）', missingTarget.length === 0, missingTarget.slice(0, 6).join(' | '));

{
  const termUp = traceSignal(indexer, top, 'i_ext', { direction: 'up', maxDepth: 4 });
  const terms = [];
  walk(termUp.root, (n) => {
    if (n.kind === 'terminal') terms.push(n);
  });
  check(
    '顶层输入端口节点指向端口声明行',
    terms.length > 0 && terms[0].file === top.file && terms[0].line === 3,
    terms.length > 0 ? `${String(terms[0].file).split(/[\\/]/).pop()}:${terms[0].line}` : '（没有 terminal 节点）',
  );

  const constUp = traceSignal(indexer, indexer.getModule('proc'), 'i_b', { direction: 'up', maxDepth: 4 });
  const consts = [];
  walk(constUp.root, (n) => {
    if (n.kind === 'constant') consts.push(n);
  });
  check(
    '常量节点指向父层那一次连接',
    consts.length > 0 && typeof consts[0].line === 'number' && /taskfn\.v$/.test(String(consts[0].file)),
    consts.length > 0 ? `${String(consts[0].file).split(/[\\/]/).pop()}:${consts[0].line}` : '（没有 constant 节点）',
  );
}

// ---- 真实例化信息（层次可视化的数据基础）----
const fanNode = r1.graph.nodes.find((n) => n.moduleName === 'fan');
check('框图节点带实例名', !!fanNode && fanNode.instanceName === 'u_fan', String(fanNode?.instanceName));
check('框图节点带父模块', !!fanNode && fanNode.container === 'top', String(fanNode?.container));
const leafNode = r1.graph.nodes.find((n) => n.moduleName === 'leaf');
check(
  '同一模块多处例化会记录多组例化信息',
  !!leafNode && (leafNode.instances ?? []).length >= 2,
  JSON.stringify(leafNode?.instances ?? []),
);
check(
  '框图边带经由实例',
  r1.graph.edges.some((e) => e.instanceName === 'u_fan'),
  String(r1.graph.edges.length),
);

// ---- 层次框（同层兄弟）----
{
  const shown2 = filterGraphByHops(mergeParallelEdges(r1.graph), 3);
  const lay2 = layoutSignalGraph(shown2, { direction: 'LR' });
  const frames = computeHierarchyFrames(shown2, lay2);
  const fanFrame = frames.find((f) => f.container === 'fan');
  check(
    '层次框圈出同一父模块下的同层实例',
    !!fanFrame && fanFrame.instanceNames.length >= 2,
    JSON.stringify(frames.map((f) => `${f.container}:${f.instanceNames.join('/')}`)),
  );
  check('层次框尺寸有效', frames.every((f) => f.width > 0 && f.height > 0));
}

// s_mid 有 5 个下游负载；maxChildren 的下限是 4，所以会出现"可展开"节点
const r2 = traceSignal(indexer, top, 's_mid', { direction: 'down', maxDepth: 10, maxChildren: 4 });
const moreNode = [];
walk(r2.root, (n) => {
  if (n.expandKey) moreNode.push(n);
});
check('分支超限时给出可展开节点', moreNode.length > 0, `maxChildren=4，找到 ${moreNode.length} 个`);
const key = moreNode[0]?.expandKey;
const pending0 = moreNode[0]?.pendingCount ?? 0;
const r3 = traceSignal(indexer, top, 's_mid', {
  direction: 'down',
  maxDepth: 10,
  maxChildren: 4,
  expanded: { [key]: 1 },
});
const afterExpand = [];
walk(r3.root, (n) => {
  if (n.expandKey && n.expandKey === key) afterExpand.push(n);
});
check(
  '继续展开后该分支放宽（未展开的分支数减少或消失）',
  afterExpand.length === 0 || (afterExpand[0].pendingCount ?? 0) < pending0,
  `展开前 pending=${pending0}，展开后 pending=${afterExpand[0]?.pendingCount ?? 0}`,
);

// ---- 过程块节点：点击应选中块内的目标信号 ----
{
  const proc = indexer.getModule('proc');
  const pr = traceSignal(indexer, proc, 'o_q', { direction: 'up', maxDepth: 6 });
  let alwaysNode;
  walk(pr.root, (n) => {
    if (!alwaysNode && n.flags.includes('always')) alwaysNode = n;
  });
  const src = fs.readFileSync(path.join(root, 'proc.v'), 'utf8');
  check('上游能找到过程块节点', !!alwaysNode, '没找到');
  check(
    '过程块节点带目标信号的偏移',
    !!alwaysNode &&
      typeof alwaysNode.offset === 'number' &&
      src.startsWith('o_q', alwaysNode.offset),
    alwaysNode ? `offset=${alwaysNode.offset} 实际 "${src.slice(alwaysNode.offset ?? 0, (alwaysNode.offset ?? 0) + 12)}"` : '',
  );
  const alwaysLine = proc.alwaysBlocks[0].line;
  check(
    '过程块节点定位到赋值语句行（不是 always 行）',
    !!alwaysNode && alwaysNode.line === alwaysLine + 1,
    `always 在 ${alwaysLine + 1} 行，节点落在 ${(alwaysNode?.line ?? 0) + 1} 行`,
  );

  // 条件/索引里出现的情况（i_b 只在 if 条件里被读取，没有任何赋值语句读它）
  const prCond = traceSignal(indexer, proc, 'i_b', { direction: 'down', maxDepth: 6 });
  let condNode;
  walk(prCond.root, (n) => {
    if (!condNode && n.flags.includes('always')) condNode = n;
  });
  check('下游能找到"条件逻辑"过程块节点', !!condNode, '没找到');
  check(
    '条件逻辑节点带该信号的偏移',
    !!condNode &&
      typeof condNode.offset === 'number' &&
      src.startsWith('i_b', condNode.offset),
    condNode ? `offset=${condNode.offset} 实际 "${src.slice(condNode.offset ?? 0, (condNode.offset ?? 0) + 12)}"` : '',
  );
  check(
    '条件逻辑节点定位到条件所在行（不是 always 行）',
    !!condNode && condNode.line === alwaysLine + 1,
    `always 在 ${alwaysLine + 1} 行，节点落在 ${(condNode?.line ?? 0) + 1} 行`,
  );
  check(
    '条件逻辑节点说明了是哪个信号',
    !!condNode && String(condNode.description ?? '').includes('条件/索引中的 i_b'),
    String(condNode?.description),
  );
}

// ---- always 体是 if / case 语句（曾被截断到复位分支的第一个分号）----
{
  const rf = indexer.getModule('regfile');
  const rsrc = fs.readFileSync(path.join(root, 'regfile.v'), 'utf8');
  const driverOf = (sig, dir) => {
    const t = traceSignal(indexer, rf, sig, { direction: dir, maxDepth: 6 });
    let hit;
    walk(t.root, (n) => {
      if (!hit && n.flags.includes('always')) hit = n;
    });
    return hit;
  };

  check(
    'always 体范围正确（三种写法都收到，没互相吞并）',
    !!rf && rf.alwaysBlocks.length === 3,
    `always 块数=${rf?.alwaysBlocks.length}`,
  );
  check(
    '写寄存器块的 lhsNets 覆盖 case 内所有被写信号',
    !!rf && ['o_num', 'o_mode'].every((s) => rf.alwaysBlocks[0].lhsNets.includes(s)),
    rf ? rf.alwaysBlocks[0].lhsNets.join(',') : '',
  );

  const numNode = driverOf('o_num', 'up');
  check('复位分支之后（case 内）的赋值也能找到驱动', !!numNode, '报"未找到驱动源"');
  check(
    '过程块节点带出 RHS 源信号（i_wr_data）',
    !!numNode && (numNode.children ?? []).some((c) => c.label === 'i_wr_data'),
    numNode ? (numNode.children ?? []).map((c) => c.label).join(',') : '',
  );
  check(
    '过程块节点落在 case 里那条赋值上',
    !!numNode && typeof numNode.offset === 'number' && rsrc.startsWith('o_num', numNode.offset),
    numNode ? `offset=${numNode.offset} 实际 "${rsrc.slice(numNode.offset ?? 0, (numNode.offset ?? 0) + 8)}"` : '',
  );
  // 复位分支也写了 o_num（`o_num <= 8'd0;`）。点击应落到**有 RHS 来源**的那条：
  // 这样节点行号与它带出的子节点（i_wr_data）在同一行，而不是把人带到复位赋值上。
  const caseLine = rsrc.split('\n').findIndex((l) => l.includes("4'h1: o_num"));
  check(
    '落点优先选"有 RHS 来源"的赋值（不是复位分支那条）',
    !!numNode && numNode.line === caseLine,
    `节点落在第 ${(numNode?.line ?? -1) + 1} 行，期望第 ${caseLine + 1} 行（复位那句在第 ${rsrc.split('\n').findIndex((l) => l.trim().startsWith('o_num')) + 1} 行）`,
  );
  check('case 其它分支的信号同样有驱动', !!driverOf('o_mode', 'up'), '没找到');
  const muxNode = driverOf('o_mux', 'up');
  check(
    'case 直接当 always 体（无 begin/end）也能识别',
    !!muxNode && typeof muxNode.offset === 'number' && rsrc.startsWith('o_mux', muxNode.offset),
    muxNode ? `offset=${muxNode.offset}` : '没找到',
  );

  // 下游：信号在过程块里作为赋值 RHS 被读取（`r_x <= net;`）
  const down = traceSignal(indexer, rf, 'i_wr_data', { direction: 'down', maxDepth: 6 });
  let numDown;
  walk(down.root, (n) => {
    if (!numDown && n.label === 'o_num' && n.flags.includes('intra')) numDown = n;
  });
  check('下游能找到"过程块内参与赋值"的目标信号', !!numDown, '没找到');
  check(
    '下游节点落在那条赋值语句行（不是 always 行）',
    !!numDown && numDown.line === caseLine && rsrc.startsWith('o_num', numDown.offset ?? -1),
    numDown ? `第 ${numDown.line + 1} 行 offset=${numDown.offset}` : '',
  );
  check(
    '下游节点说明是"过程块内参与赋值"',
    !!numDown && String(numDown.edgeText ?? '').includes('参与赋值'),
    String(numDown?.edgeText),
  );

  // 声明即赋值：`wire [7:0] s_sel = i_wr_en ? i_wr_data : 8'd0;`
  // 等价于一条 assign，两个方向都必须认；界面上要照实写成"声明处赋值"
  check(
    '声明即赋值被记为 assign（inline）',
    !!rf && rf.assigns.some((a) => a.inline === true && a.lhsNets.includes('s_sel')),
    rf ? rf.assigns.map((a) => `${a.lhsText}${a.inline ? '(inline)' : ''}`).join(',') : '',
  );
  const selUp = traceSignal(indexer, rf, 's_sel', { direction: 'up', maxDepth: 4 });
  let selSrc;
  walk(selUp.root, (n) => {
    if (!selSrc && n.label === 'i_wr_data') selSrc = n;
  });
  check('声明即赋值的上游：能追到表达式里的源信号', !!selSrc, '没找到 i_wr_data');
  const selDown = traceSignal(indexer, rf, 'i_wr_data', { direction: 'down', maxDepth: 4 });
  let selDst;
  walk(selDown.root, (n) => {
    if (!selDst && n.label === 's_sel') selDst = n;
  });
  check(
    '声明即赋值的下游：列出被它驱动的信号',
    !!selDst && /声明处赋值/.test(String(selDst.edgeText)),
    selDst ? String(selDst.edgeText) : '没找到',
  );

  // 常量/初值驱动的信号（`wire x = 8'h5a;`）不能报成"未找到驱动源"
  const constUp = traceSignal(indexer, rf, 's_const', { direction: 'up', maxDepth: 3 });
  let constNode;
  walk(constUp.root, (n) => {
    if (!constNode && n.kind === 'constant') constNode = n;
  });
  const csrcLine = rsrc.split('\n').findIndex((l) => l.includes('s_const ='));
  check(
    '常量/初值驱动不再误报"未找到驱动源"',
    !!constNode && constNode.line === csrcLine,
    constNode ? `第 ${constNode.line + 1} 行（期望第 ${csrcLine + 1} 行）` : '报成了未找到驱动源',
  );

  // 块体就是一条赋值：`always @(posedge clk) r_plain <= i_wr_data[0];`
  const plainLine = rsrc.split('\n').findIndex((l) => l.includes('r_plain <='));
  const plainUp = traceSignal(indexer, rf, 'r_plain', { direction: 'up', maxDepth: 4 });
  let plainNode;
  walk(plainUp.root, (n) => {
    if (!plainNode && n.flags.includes('always')) plainNode = n;
  });
  check(
    '单条赋值当块体（无 if / 无 begin）：上游能找到驱动',
    !!plainNode && plainNode.line === plainLine,
    plainNode ? `第 ${plainNode.line + 1} 行（期望第 ${plainLine + 1} 行）` : '报成了未找到驱动源',
  );
  const plainDown = traceSignal(indexer, rf, 'i_wr_data', { direction: 'down', maxDepth: 4 });
  let plainDst;
  walk(plainDown.root, (n) => {
    if (!plainDst && n.label === 'r_plain') plainDst = n;
  });
  check(
    '单条赋值当块体：下游也能列出目标信号',
    !!plainDst && plainDst.line === plainLine,
    plainDst ? `第 ${plainDst.line + 1} 行` : '没找到 r_plain',
  );
}

// ---- 起点跳转（根节点应回到"发起追踪的地方"）----
{
  const r = traceSignal(indexer, top, 's_mid', {
    direction: 'both',
    maxDepth: 10,
    startAt: { file: 'fake/where_i_clicked.v', line: 42, offset: 7 },
  });
  check(
    '根节点跳回发起追踪的位置',
    r.root.file === 'fake/where_i_clicked.v' && r.root.line === 42 && r.root.offset === 7,
    `${r.root.file}:${(r.root.line ?? 0) + 1}@${r.root.offset}`,
  );
  check(
    '声明位置仍写在悬停提示里',
    String(r.root.tooltip ?? '').includes('声明位置'),
    String(r.root.tooltip),
  );
  const noStart = traceSignal(indexer, top, 's_mid', { direction: 'both', maxDepth: 10 });
  check(
    '没有起点信息时回退到声明处',
    noStart.root.file === top.file,
    `${noStart.root.file} vs ${top.file}`,
  );
}

// ---- 6. 树视图过滤 ----
console.log('\n[6] 树视图过滤');
const tree = new TraceTreeProvider();
tree.setResult(r1);
const count = (node, acc = { n: 0 }) => {
  acc.n++;
  for (const c of tree.visible(node)) count(c, acc);
  return acc.n;
};
const allCount = count(r1.root);
tree.setFilter('cross');
const crossCount = count(r1.root);
const crossIntra = [];
walk(r1.root, (n) => {
  if (n.flags.includes('intra')) crossIntra.push(n);
});
tree.setFilter('all');
const visibleHasIntra = (() => {
  let hit = false;
  const visit = (n) => {
    for (const c of tree.visible(n)) {
      if (c.flags.includes('intra')) hit = true;
      visit(c);
    }
  };
  tree.setFilter('cross');
  visit(r1.root);
  tree.setFilter('all');
  return hit;
})();
check('夹具里确实存在模块内节点（intra）', crossIntra.length > 0, `intra 节点 ${crossIntra.length} 个`);
check('只看跨模块时节点数减少', crossCount < allCount, `全部 ${allCount} → 跨模块 ${crossCount}`);
check('只看跨模块时不再出现纯 intra 节点', !visibleHasIntra);
tree.setFilter('renamed');
const renamedCount = count(r1.root);
check('只看改名时结果非空且更少', renamedCount > 0 && renamedCount <= allCount, `改名过滤后 ${renamedCount}`);

// ---- 7. 索引序列化往返（缓存）----
console.log('\n[7] 索引缓存往返');
const roundTrip = deserializeIndex(JSON.parse(JSON.stringify(serializeIndex(idx))));
check('反序列化成功', !!roundTrip);
check('模块数一致', roundTrip?.modules.size === idx.modules.size, `${roundTrip?.modules.size} vs ${idx.modules.size}`);
const child2 = roundTrip?.modules.get('child')?.[0];
check('端口信息保留', !!child2 && child2.ports.length === 3, String(child2?.ports.length));
check('signals 仍是 Map', child2?.signals instanceof Map);
check(
  '缓存里带了 include 文件内容',
  indexer.cachedIncludeTexts.has(path.join(root, 'ports.vh').replace(/\\/g, '/')),
  [...indexer.cachedIncludeTexts.keys()].join(', '),
);

const fresh = new WorkspaceIndexer();
check('adopt 后可查询等价类', (() => {
  fresh.adopt(roundTrip, new Map(indexer.cachedIncludeTexts));
  return fresh.netMembers('mid', 'i_p').length >= 3;
})());
check('adopt 后顶层候选可用', fresh.current.topCandidates.includes('top'));
check(
  '缓存接管后的增量更新仍能内联 include',
  (() => {
    fresh.updateFile(path.join(root, 'child.v'), FILES['child.v']);
    return fresh.getModule('child')?.ports.length === 3;
  })(),
  String(fresh.getModule('child')?.ports.length),
);

// ---- 8. Webview 内联脚本语法 ----
// 这两个前端是手写 SVG + 内联 JS（一堆字符串），类型系统管不到它们；
// 这里用 new Function 编译一遍，能挡住绝大多数手误。
console.log('\n[8] Webview 内联脚本');
const { renderGraphHtml } = await import('../src/vscode/graphHtml.ts');
const { renderMindmapHtml } = await import('../src/vscode/mindmapHtml.ts');
const fakeWebview = { cspSource: 'vscode-webview://test' };
for (const [name, html] of [
  ['graphHtml', renderGraphHtml(fakeWebview, 'NONCE')],
  ['mindmapHtml', renderMindmapHtml(fakeWebview, 'NONCE')],
]) {
  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
  check(`${name} 内联脚本可编译`, !!m, '没找到 <script> 块');
  if (m) {
    let err = '';
    try {
      // 只编译不执行（acquireVsCodeApi 等浏览器 API 不会真的被调用）
      new Function(m[1]);
    } catch (e) {
      err = e.message;
    }
    check(`${name} 脚本语法正确`, err === '', err);
  }
}

// ---- 10. 悬停内容（可配置：显示哪些小节 / 每节条数 / 总行数）----
console.log('\n[9] 悬停速查内容（可配置）');
{
  const { describeSignal } = await import('../src/core/describe.ts');
  const { renderSignalHoverMarkdown } = await import('../src/core/hover.ts');

  const desc = describeSignal(indexer, child, 'o_b');
  const text = renderSignalHoverMarkdown(indexer, desc, 'o_b');
  const lines = text.split('\n');
  check('悬停包含声明小节', text.includes('声明于'), text.slice(0, 80));
  check('悬停包含驱动源/负载', text.includes('**驱动源**') && text.includes('**负载**'));
  check('悬停包含层次路径', text.includes('**层次路径**') && text.includes('top.u_child.o_b'));
  check('悬停包含同网络别名', text.includes('**同网络别名**') && text.includes('top.s_mid'));
  check('默认行数在预算内', lines.length <= 40, `${lines.length} 行`);

  const onlyDecl = renderSignalHoverMarkdown(indexer, desc, 'o_b', {
    sections: ['decl'],
    maxRefs: 12,
    maxLines: 40,
  });
  check('只保留 decl 时其它小节消失', !onlyDecl.includes('**驱动源**') && onlyDecl.includes('声明于'));

  const narrow = renderSignalHoverMarkdown(indexer, desc, 'o_b', {
    sections: ['decl', 'drivers', 'loads', 'parent', 'path', 'aliases'],
    maxRefs: 12,
    maxLines: 8,
  });
  check(
    'maxLines 生效并给出提示',
    narrow.split('\n').length <= 12 && narrow.includes('悬停行数上限'),
    `${narrow.split('\n').length} 行`,
  );

  // ---- decl 小节原样贴出声明源码（带注释与高亮）----
  const withSrc = renderSignalHoverMarkdown(
    indexer,
    desc,
    'o_b',
    {},
    '// 输出数据（8bit）\noutput wire [7:0] o_b,',
  );
  check(
    'decl 小节原样贴出声明源码（含注释）',
    withSrc.includes('```verilog') && withSrc.includes('// 输出数据（8bit）'),
    withSrc.slice(0, 120),
  );
  check(
    '声明源码用的是带语言标记的代码块',
    /```verilog[\s\S]*output wire \[7:0\] o_b,[\s\S]*```/.test(withSrc),
  );
  const noSrc = renderSignalHoverMarkdown(indexer, desc, 'o_b', { declSource: false }, 'ignored');
  check('declSource=false 时不贴源码', !noSrc.includes('```'));
  const tightSrc = renderSignalHoverMarkdown(indexer, desc, 'o_b', { maxLines: 5 }, 'a\nb\nc\nd');
  check('行数很紧时声明源码块仍然保留', tightSrc.includes('```verilog'), tightSrc.slice(0, 80));

  // s_mid 有 6 个直接负载，用它验证 maxRefs
  const midDesc = describeSignal(indexer, top, 's_mid');
  const twoRefs = renderSignalHoverMarkdown(indexer, midDesc, 's_mid', {
    sections: ['loads'],
    maxRefs: 2,
    maxLines: 60,
  });
  const items = twoRefs.split('\n').filter((l) => l.startsWith('- ') && !l.includes('另有'));
  check('maxRefs=2 时该节只列 2 条', items.length === 2, `${items.length} 条`);
  check(
    '被截断时提示可调大 maxRefs',
    twoRefs.includes('另有') && twoRefs.includes('sigroute.hover.maxRefs'),
    twoRefs.split('\n').filter((l) => l.includes('另有')).join(' '),
  );
}

// ---- 9. Webview 渲染冒烟测试 ----
// 两个前端都是"字符串里的 JS"，编译过了不代表跑起来不报错。
// 这里用一个最小 DOM 桩把它们真正执行一遍（含点击折叠、换信号等交互路径）。
console.log('\n[10] Webview 渲染冒烟');

function mkEl(tag) {
  const e = {
    tagName: tag,
    childNodes: [],
    attrs: {},
    listeners: {},
    text: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { e.attrs[k] = String(v); },
    getAttribute(k) { return e.attrs[k]; },
    removeAttribute() {},
    appendChild(c) { e.childNodes.push(c); return c; },
    insertBefore(c) { e.childNodes.unshift(c); return c; },
    addEventListener(t, fn) { (e.listeners[t] = e.listeners[t] || []).push(fn); },
    removeEventListener() {},
    cloneNode() { return mkEl(tag); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    clientWidth: 300,
    clientHeight: 420,
    offsetWidth: 120,
    offsetHeight: 40,
    scrollTop: 0,
    innerWidth: 320,
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 420 }; },
  };
  // textContent 赋空串必须清掉子节点 —— 前端就是靠这个重绘的，
  // 桩里不实现它，两次渲染的子节点会叠在一起（测出的行数就不对了）
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get() { return text; },
    set(v) {
      text = v === undefined || v === null ? '' : String(v);
      e.childNodes.length = 0;
    },
  });
  e.appendChild = (c) => {
    e.childNodes.push(c);
    return c;
  };
  return e;
}

/** 只用于导出 SVG 的桩（前端会 new 它） */
function FakeSerializer() {}
FakeSerializer.prototype.serializeToString = () => '<svg/>';

function makeDoc() {
  const cache = new Map();
  return {
    getElementById(id) {
      if (!cache.has(id)) cache.set(id, mkEl('div'));
      return cache.get(id);
    },
    createElement: (tag) => mkEl(tag),
    createElementNS: (_ns, tag) => mkEl(tag),
    querySelector: () => mkEl('div'),
    querySelectorAll: () => [],
    body: mkEl('body'),
  };
}

function runWebview(html, payload) {
  const code = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
  const doc = makeDoc();
  const win = { innerWidth: 320, innerHeight: 600, listeners: {} };
  win.addEventListener = (t, fn) => {
    (win.listeners[t] = win.listeners[t] || []).push(fn);
  };
  const posted = [];
  const api = () => ({ postMessage: (m) => posted.push(m), setState() {}, getState: () => undefined });
  const run = new Function(
    'acquireVsCodeApi',
    'document',
    'window',
    'XMLSerializer',
    // eslint-disable-next-line no-new-func
    code,
  );
  const err = (() => {
    try {
      run(api, doc, win, FakeSerializer);
      if (payload && win.listeners.message) {
        for (const fn of win.listeners.message) fn({ data: { type: 'render', payload } });
      }
      return '';
    } catch (e) {
      return e && e.message ? e.message : String(e);
    }
  })();
  return { err, doc, win, posted };
}

const countMind = (n) => 1 + (n.children || []).reduce((a, c) => a + countMind(c), 0);

/**
 * 脑图的默认展开行数：根 + 直接关联两层（再深先收起），
 * 单子节点链路自动展开（与树视图同一策略）。
 */
function expectedDefaultRows(node, depth) {
  const kids = node.children || [];
  let n = 1;
  const expanded = depth === 0 || depth <= 2 || kids.length === 1;
  if (expanded) for (const c of kids) n += expectedDefaultRows(c, depth + 1);
  return n;
}

// --- 脑图 ---
{
  const { MindmapViewProvider } = await import('../src/vscode/mindmapView.ts');
  const treeForMap = new TraceTreeProvider();
  treeForMap.setResult(r1);
  const provider = new MindmapViewProvider(treeForMap, {
    reveal() {},
    expand() {},
    exportSvg() {},
  });
  const msg = provider['buildMessage']();
  const html = renderMindmapHtml({ cspSource: 'vscode-webview://t' }, 'NONCE');
  // 注意：渲染会把布局信息写回 payload（_x/_y/_parent），之后就不能再 JSON 序列化了
  const payloadJson = JSON.stringify(msg.payload);
  const res = runWebview(html, msg.payload);

  check('脑图 render 不抛异常', res.err === '', res.err);
  const gN = res.doc.getElementById('gN');
  const totalRows = countMind(msg.payload.mind.root);
  const defaultRows = expectedDefaultRows(msg.payload.mind.root, 0);
  check(
    '脑图默认只展开两层',
    gN.childNodes.length === defaultRows,
    `渲染 ${gN.childNodes.length} 行 / 期望 ${defaultRows} 行`,
  );
  check('脑图默认不是全展开', defaultRows < totalRows, `默认 ${defaultRows} / 全部 ${totalRows}`);
  check('脑图带上了统计信息', String(msg.payload.stats).includes('模块'), msg.payload.stats);
  check('脑图节点带模块名（sub）', payloadJson.includes('"sub"'));
  check('脑图区分上下游颜色', payloadJson.includes('"upstream":true') && payloadJson.includes('"upstream":false'));

  // 点第一棵有子节点的行的折叠开关
  const target = gN.childNodes.find((row) =>
    row.childNodes.some((c) => c.attrs.class === 'chev' && (c.listeners.click || []).length > 0),
  );
  const chev = target && target.childNodes.find((c) => c.attrs.class === 'chev');
  const before = gN.childNodes.length;
  try {
    chev.listeners.click[0]({ stopPropagation() {} });
  } catch (e) {
    check('脑图折叠交互不抛异常', false, String(e.message ?? e));
  }
  check('脑图折叠后行数减少', gN.childNodes.length < before, `${before} → ${gN.childNodes.length}`);

  res.doc.getElementById('expandAll').listeners.click[0]();
  check(
    '脑图「展开」按钮显示全部',
    gN.childNodes.length === totalRows,
    `${gN.childNodes.length} vs ${totalRows}`,
  );
  res.doc.getElementById('resetView').listeners.click[0]();
  check(
    '脑图「默认」按钮回到两层',
    gN.childNodes.length === defaultRows,
    `${gN.childNodes.length} vs ${defaultRows}`,
  );

  // 导出：把当前 SVG 交给扩展层
  res.doc.getElementById('btnSvg').listeners.click[0]();
  check('脑图导出会发消息', res.posted.some((m) => m.type === 'exportSvg'));

  // 空状态（还没有追踪结果）也不能崩
  const emptyMsg = new MindmapViewProvider(new TraceTreeProvider(), {
    reveal() {},
    expand() {},
    exportSvg() {},
  })['buildMessage']();
  const emptyRes = runWebview(html, emptyMsg.payload);
  check('脑图空状态不抛异常', emptyRes.err === '', emptyRes.err);
}

// --- 框图 ---
{
  const treeForGraph = new TraceTreeProvider();
  treeForGraph.setResult(r1);
  const merged = mergeParallelEdges(r1.graph);
  const shown = filterGraphByHops(merged, 2);
  const payload = {
    layout: layoutSignalGraph(shown, { direction: 'LR' }),
    graph: shown,
    direction: 'LR',
    hops: 2,
    totalNodes: r1.graph.nodes.length,
    totalEdges: r1.graph.edges.length,
  };
  const res = runWebview(renderGraphHtml({ cspSource: 'vscode-webview://t' }, 'NONCE'), payload);
  check('框图 render 不抛异常', res.err === '', res.err);
  const gN2 = res.doc.getElementById('gNodes');
  check('框图节点已绘制', gN2.childNodes.length === shown.nodes.length, `${gN2.childNodes.length} vs ${shown.nodes.length}`);
  const sideList = res.doc.getElementById('sideList');
  check('框图信号清单已生成', sideList.childNodes.length > 0, String(sideList.childNodes.length));
}

// ---- 11. 定义跳转的落点 ----
// Ctrl+点击 必须落在标识符上：以前给的是「行首 + 零宽」的位置，
// 跳过去光标停在行首、也没有选中与闪烁，等于"到了这一行但没到这一处"。
console.log('\n[11] 定义跳转落点（行内列号）');
{
  const { identifierColumn } = await import('../src/vscode/providers.ts');
  const col = (text, name) => identifierColumn(text, name);
  check('端口声明行：定位到端口名', col('  input  wire [7:0] i_a,', 'i_a') === 20, `col=${col('  input  wire [7:0] i_a,', 'i_a')}`);
  check('模块头：定位到模块名', col('module child (', 'child') === 7, `col=${col('module child (', 'child')}`);
  check(
    '名字先出现在注释里时仍取声明处',
    col('  output wire o_b, // o_b 送给子模块', 'o_b') === 14,
    `col=${col('  output wire o_b, // o_b 送给子模块', 'o_b')}`,
  );
  check(
    '不把 i_a 命中进 i_a_wide（词边界）',
    col('  wire i_a_wide; assign o_x = i_a;', 'i_a') === 30,
    `col=${col('  wire i_a_wide; assign o_x = i_a;', 'i_a')}`,
  );
  check('行内找不到时退化为行首', col('endmodule', 'nope') === 0, `col=${col('endmodule', 'nope')}`);
}

// ---- 12. AI 接口层（tools/ai.mjs）与 MCP 服务 ----
// AI 读 RTL 靠的就是这几个操作：索引 → 搜索 → 速查/链路/别名/模块/上下文。
// 这一节用同一套夹具全部跑一遍，并把 MCP 服务真的拉起来走一遍 JSON-RPC。
console.log('\n[12] AI 接口层与 MCP 服务');
{
  const { createAiTools } = await import('./ai.mjs');
  const ai = createAiTools({ root });

  const idx = await ai.call('index', {});
  check(
    'AI index：报规模与顶层候选',
    idx.data.files >= 10 && idx.data.topCandidates.includes('top'),
    `files=${idx.data.files} tops=${idx.data.topCandidates.join(',')}`,
  );

  const search = await ai.call('search', { query: 's_mid' });
  check('AI search：找到 s_mid', search.data.total > 0 && search.text.includes('s_mid'), `total=${search.data.total}`);

  const desc = await ai.call('describe', { signal: 's_mid', module: 'top' });
  check('AI describe：声明行是 7（1 起）', desc.data.declaration.line === 7, `line=${desc.data.declaration.line}`);
  check(
    'AI describe：驱动源与负载都有',
    desc.data.drivers.length > 0 && desc.data.loads.length > 0,
    `${desc.data.drivers.length}/${desc.data.loads.length}`,
  );
  check(
    'AI describe：别名含 child.o_b（改名反查）',
    desc.data.aliases.some((a) => a.module === 'child' && a.net === 'o_b'),
    desc.data.aliases.map((a) => `${a.module}.${a.net}`).join(', '),
  );

  const trace = await ai.call('trace', { signal: 's_mid', module: 'top', direction: 'both', depth: 6 });
  check(
    'AI trace：链路摘要与经过模块',
    trace.text.includes('链路摘要') && trace.data.modules.includes('child') && trace.data.modules.includes('mid'),
    trace.data.modules.join(','),
  );
  check('AI trace：节点带文件:行', /top\.v:\d+/.test(trace.text), (trace.text.split('\n').find((l) => l.includes('top.v:')) ?? '').trim());
  const cross = await ai.call('trace', { signal: 's_mid', module: 'top', filter: 'cross', depth: 6 });
  check('AI trace：filter=cross 可用', cross.text.includes('链路摘要') && cross.data.tree.children.length > 0, String(cross.data.tree.children.length));

  const aliases = await ai.call('aliases', { signal: 's_mid', module: 'top' });
  check('AI aliases：列出等价类', aliases.data.total >= 2 && aliases.text.includes('child.o_b'), `total=${aliases.data.total}`);
  check(
    'AI 路径口径：工程内不标 [工程外]、且行号 1 起',
    !aliases.text.includes('[工程外]') && /child\.v:\d+/.test(aliases.text),
    aliases.text.split('\n').find((l) => l.includes('child.v')) ?? '',
  );

  const sub = await ai.call('search', { query: 'mid' });
  check(
    'AI search：默认包含匹配（mid 能搜到 s_mid/child 等）',
    sub.data.total > 0 && sub.data.mode === '包含' && !sub.text.includes('[工程外]'),
    `mode=${sub.data.mode} total=${sub.data.total}`,
  );
  const ci = await ai.call('search', { query: 'S_MID' });
  check(
    'AI search：大小写不一致时自动兜底',
    ci.data.total > 0 && String(ci.data.mode).includes('不区分'),
    `mode=${ci.data.mode} total=${ci.data.total}`,
  );

  const hier = await ai.call('hierarchy', { signal: 's_mid', module: 'top' });
  check('AI hierarchy：给出层次路径', hier.data.paths.length > 0 && hier.text.includes('top'), hier.text.split('\n')[1] ?? '');

  const modInfo = await ai.call('module', { module: 'top' });
  check(
    'AI module：端口与例化数正确',
    modInfo.data.ports.length === 3 && modInfo.data.instances.length === 7,
    `ports=${modInfo.data.ports.length} insts=${modInfo.data.instances.length}`,
  );

  const fnMod = await ai.call('module', { module: 'taskfn' });
  check(
    '函数/任务之后的例化不会被吞掉（曾整段丢失）',
    fnMod.data.ports.length === 3 && fnMod.data.instances.length === 1,
    `ports=${fnMod.data.ports.length} insts=${fnMod.data.instances.length}`,
  );

  const ctx = await ai.call('context', { file: 'top.v', line: 7 });
  check(
    'AI context：声明行落在信号上',
    ctx.data.module === 'top' && ctx.data.signal?.name === 's_mid',
    JSON.stringify({ m: ctx.data.module, s: ctx.data.signal?.name }),
  );
  const ctx2 = await ai.call('context', { file: 'top.v', line: 8 });
  check(
    'AI context：例化行给出例化名与连接',
    ctx2.data.instance?.instance === 'u_child' && ctx2.data.instance.connections.length === 3,
    JSON.stringify({ i: ctx2.data.instance?.instance, c: ctx2.data.instance?.connections.length }),
  );

  // 增量刷新：MCP 是长驻进程，改了代码后下一次调用必须看到新内容
  fs.writeFileSync(path.join(root, 'extra.v'), ['module extra (', '  input wire i_x', ');', 'endmodule', ''].join('\n'), 'utf8');
  const after = await ai.call('search', { query: 'extra' });
  check('AI 增量刷新：新建文件后立刻能搜到', after.data.total > 0, `total=${after.data.total}`);
  fs.rmSync(path.join(root, 'extra.v'), { force: true });

  // ---- MCP 协议冒烟：把服务拉起来，问三个问题（含一个通知，必须不回应） ----
  const { spawnSync } = await import('node:child_process');
  const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const input =
    [
      req(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      req(2, 'tools/list'),
      req(3, 'tools/call', { name: 'sigroute_describe', arguments: { signal: 's_mid', module: 'top' } }),
    ].join('\n') + '\n';
  const proc = spawnSync(process.execPath, [path.join(here, 'mcp.mjs'), '--root', root], {
    input,
    encoding: 'utf8',
    timeout: 120000,
  });
  let replied = [];
  let parseErr = '';
  try {
    replied = proc.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    parseErr = String(e && e.message ? e.message : e);
  }
  check('MCP：stdout 只有应答（通知不回应）', parseErr === '' && replied.length === 3, parseErr || `收到 ${replied.length} 条`);
  check(
    'MCP：initialize 回协议版本与 tools 能力',
    replied[0]?.result?.protocolVersion === '2024-11-05' && Boolean(replied[0]?.result?.capabilities?.tools),
    String(replied[0]?.result?.protocolVersion),
  );
  check('MCP：tools/list 列出 8 个工具', replied[1]?.result?.tools?.length === 8, `count=${replied[1]?.result?.tools?.length}`);
  check(
    'MCP：tools/call 返回可读文本',
    String(replied[2]?.result?.content?.[0]?.text ?? '').includes('s_mid'),
    String(replied[2]?.result?.content?.[0]?.text ?? '').split('\n')[0],
  );

  // ---- 多工程 / 跟随工作区：真的跟一个"客户端"握一遍手（服务端会反问 roots/list） ----
  const { spawn } = await import('node:child_process');
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sigroute-selftest-b-'));
  fs.writeFileSync(path.join(otherRoot, 'b.v'), 'module only_in_b (\n  input wire i_b\n);\nendmodule\n', 'utf8');

  const child = spawn(process.execPath, [path.join(here, 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const inbox = [];
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        inbox.push(JSON.parse(line));
      } catch {
        /* 非 JSON 行正常情况下不会出现，出现也直接忽略 */
      }
    }
  });
  // 用"收件箱 + 轮询"而不是等待队列：服务端可能一口气回两条
  // （initialize 应答 + roots/list 反问同一次 data 事件到达），等待队列会漏掉后一条。
  let consumed = 0;
  const nextMsg = async (ms = 20000) => {
    const t0 = Date.now();
    while (consumed >= inbox.length) {
      if (Date.now() - t0 > ms) throw new Error('等待 MCP 消息超时');
      await new Promise((r) => setTimeout(r, 5));
    }
    return inbox[consumed++];
  };
  const sendMsg = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const textOf = (m) => String(m?.result?.content?.[0]?.text ?? '');
  const eqPath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

  try {
    sendMsg({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'selftest' } },
    });
    const init = await nextMsg();
    check('MCP：initialize 成功（客户端声明 roots）', init.id === 1 && init.result?.protocolVersion === '2024-11-05', String(init.result?.protocolVersion));
    const rootsAsk = await nextMsg();
    check('MCP：服务端主动反问工作区根', rootsAsk.method === 'roots/list', String(rootsAsk.method ?? rootsAsk.id));

    sendMsg({ jsonrpc: '2.0', id: rootsAsk.id, result: { roots: [{ uri: pathToFileURL(root).href, name: 'fixture' }] } });
    sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });

    sendMsg({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sigroute_index', arguments: {} } });
    const idx = await nextMsg();
    const idxText = textOf(idx);
    const rootLine = /工程根\s*:\s*(.+)/.exec(idxText);
    check(
      'MCP：不带 root 也能查到客户端工作区（不绑死工程）',
      Boolean(rootLine) && eqPath(rootLine[1].trim(), root) && idxText.includes('文件'),
      `工程根=${rootLine ? rootLine[1].trim() : '（文本里没有）'}`,
    );
    check('MCP：index 会报出已索引的工程根', textOf(idx).includes('已索引的工程根'), textOf(idx).split('\n').slice(-2).join(' / '));

    sendMsg({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sigroute_search', arguments: { query: 'only_in_b' } } });
    const miss = await nextMsg();
    sendMsg({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sigroute_search', arguments: { query: 'only_in_b', root: otherRoot } } });
    const hit = await nextMsg();
    check('MCP：默认工程里搜不到另一个工程的模块', textOf(miss).includes('命中 0'), textOf(miss).split('\n')[0]);
    check('MCP：传 root= 即切到另一个工程', textOf(hit).includes('only_in_b') && !textOf(hit).includes('命中 0'), textOf(hit).split('\n')[0]);

    sendMsg({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    const list = await nextMsg();
    const all = list.result?.tools ?? [];
    check(
      'MCP：每个工具都带可选 root 参数',
      all.length === 8 && all.every((t) => t.inputSchema?.properties?.root),
      `带 root 的 ${all.filter((t) => t.inputSchema?.properties?.root).length}/${all.length}`,
    );
  } finally {
    child.kill();
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 收尾
console.log('');
if (failures.length > 0) {
  console.error(`自检失败：${failures.length} 项\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`自检通过：${pass} 项断言全部成立。\n`);
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结果 */
}
