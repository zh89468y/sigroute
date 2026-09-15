/**
 * SigRoute 的 AI 接口层（无依赖、Node 直跑）
 *
 * 为什么要有这一层：
 *   AI 读 RTL 最费 token 的从来不是"看懂一行代码"，而是**跨文件的那几个问题** ——
 *   这根信号从哪来、到哪去、穿过了谁、在哪儿改了名。这些答案索引里本来就有，
 *   但以前只有 VSCode 插件内部拿得到（悬停 / 树 / 框图）。
 *   这里把同一份 src/core 能力开放出来，AI 一次调用就能拿到结论，
 *   而不是 grep 十几个文件、再自己拼链路（还拼不准）。
 *
 * 两种用法（同一份实现）：
 *   命令行：node tools/ai.mjs <操作> [参数]            （任何能跑 shell 的 agent）
 *   MCP   ：node tools/mcp.mjs --root <工程目录>       （CodeBuddy / Claude Code / Cursor…）
 *
 * 与插件的关系：共用 src/core 的解析器、索引与追踪引擎 —— 路径、改名点、
 * 网络等价类的结论与插件里显示的完全一致，不存在"两套解析对不上"的问题。
 *
 * 约定（全层统一，别记错）：
 *   - 行号一律 **1 起**（与编辑器、与 AI 读取工具一致）；源码内部是 0 起，这里是换算后的值。
 *   - 路径一律**相对工程根**、正斜杠，便于直接粘贴进 read_file / grep。
 *
 * 跑哪一份代码：优先 `out/`（编译产物），没有或明显过期时回退 `src/`（见 pickRuntime）。
 *   - 跑 out/：纯 JS，不需要 npm install、不需要编译，Node 版本要求很低；
 *   - 跑 src/：需要 Node >= 22.6 的原生 type stripping（开发中改了源码还没编译时的兜底）。
 */

import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 跑哪一份代码

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const srcDir = path.join(pkgRoot, 'src');
const outDir = path.join(pkgRoot, 'out');

/**
 * 优先用编译产物 out/，理由有两条：
 *   1) 插件里真正跑的也是它 —— 结论一致性不打折；
 *   2) 它是纯 JS，不需要 Node 的类型剥离，所以"只有 out/ 没有 src/"的场景
 *      （例如从 vsix 装进来的扩展目录里直接调 tools/mcp.mjs）也能跑。
 * src/ 只在没有 out/、或 out/ 明显比 src/ 旧（改了源码还没编译）时兜底。
 * 想强制指定：环境变量 SIGROUTE_AI_RUNTIME=src|out。
 */
function pickRuntime() {
  const forced = process.env.SIGROUTE_AI_RUNTIME;
  if (forced === 'src' || forced === 'out') return forced;
  const coreOut = path.join(outDir, 'core');
  const coreSrc = path.join(srcDir, 'core');
  if (!fs.existsSync(coreOut)) return 'src';
  const newest = (dir, re) => {
    let m = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!re.test(f)) continue;
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > m) m = st.mtimeMs;
    }
    return m;
  };
  const srcNewest = fs.existsSync(coreSrc) ? newest(coreSrc, /\.ts$/) : 0;
  const outNewest = newest(coreOut, /\.js$/);
  // 留 1s 容差：编译紧跟在源码保存之后时，两者 mtime 会非常接近
  return srcNewest > outNewest + 1000 ? 'src' : 'out';
}

const runtime = pickRuntime();
const ext = runtime === 'out' ? 'js' : 'ts';

if (runtime === 'src') {
  // 只有走源码时才需要"无扩展名 import → .ts"的解析钩子（以及类型剥离）
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
  process.stderr.write('[sigroute-ai] out/ 不存在或比 src/ 旧，改用源码运行（需要 Node >= 22.6）\n');
}

const base = runtime === 'out' ? '../out' : '../src';
const { WorkspaceIndexer } = await import(`${base}/core/indexer.${ext}`);
const { traceSignal, resolveStartPoint } = await import(`${base}/core/graph.${ext}`);
const { describeSignal } = await import(`${base}/core/describe.${ext}`);
const { hierarchyPaths } = await import(`${base}/core/hierarchy.${ext}`);

// ---------------------------------------------------------------- 通用工具

/**
 * 与插件默认配置一致的扫描范围：排除生成目录，保留 IP 的 *_stub.v（端口方向的唯一依据）。
 *
 * 注意第二条：Vivado 的生成目录点号在中间（`proj.sim/`、`proj.runs/`、`proj.ip_user_files/`），
 * 不能写成"以点开头的段"。这里与 tools/verify.mjs 保持一致。
 */
const SKIP_DIR =
  /(^|[\\/])(node_modules|\.git|\.vscode)([\\/]|$)|\.(cache|sim|runs|hw|ip_user_files|gen|rpt|jou|log|Xil)([\\/]|$)/i;
const SRC_FILE = /\.(v|sv|vh|svh)$/i;
const AUX_FILE = /\.(veo|vho)$/i;

/** 节点标记 → 中文说明（与树视图的徽标同义，这里用纯文本，方便 AI 读） */
const FLAG_LABEL = {
  renamed: '改名',
  bitselect: '位选',
  partial: '不完整',
  loop: '已展开过',
  limit: '深度上限',
  constant: '常量',
  unconnected: '悬空',
  generate: 'generate 块',
  always: '过程块',
  intra: '模块内',
  budget: '预算截断',
  cross: '跨模块',
  more: '被收起',
  summary: '摘要',
};

const REF_KIND = {
  'instance-input': '子模块输入',
  'instance-output': '子模块输出',
  'assign-lhs': 'assign 左值',
  'assign-rhs': 'assign 右值',
  'proc-lhs': '过程块赋值',
  'proc-read': '过程块读取',
  'parent-conn': '上级连接',
};

const DIR_LABEL = { input: 'input', output: 'output', inout: 'inout' };

function wildcardToRe(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** Node 版文件提供者（与 tools/verify.mjs 同一套规则） */
function makeProvider(root, scope) {
  const scanRoot = scope ? path.resolve(root, scope) : root;
  return {
    async listFiles() {
      const out = [];
      const walk = (dir, depth) => {
        if (depth > 14) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name.startsWith('.') || SKIP_DIR.test(`${p}${path.sep}`)) continue;
            walk(p, depth + 1);
          } else if (SRC_FILE.test(e.name) && !/_sim_netlist\.v$/i.test(e.name)) {
            out.push(p.replace(/\\/g, '/'));
          }
        }
      };
      walk(scanRoot, 0);
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
    async listAuxFiles() {
      const out = [];
      const walk = (dir, depth) => {
        if (depth > 14) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name.startsWith('.') || SKIP_DIR.test(`${p}${path.sep}`)) continue;
            walk(p, depth + 1);
          } else if (AUX_FILE.test(e.name)) {
            out.push(p.replace(/\\/g, '/'));
          }
        }
      };
      walk(scanRoot, 0);
      return out;
    },
    async stat(p) {
      try {
        const st = fs.statSync(p);
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------- AI 接口层

/**
 * 建一套工具。所有操作都是 async，返回 `{ data, text }`：
 *   data —— 结构化结果（JSON 模式 / MCP structuredContent 用）
 *   text —— 给人 / 给 AI 读的紧凑文本（默认输出）
 */
export function createAiTools(options = {}) {
  const root = path.resolve(options.root ?? process.env.SIGROUTE_ROOT ?? process.cwd());
  const scope = options.scope;
  const provider = makeProvider(root, scope);
  const indexer = new WorkspaceIndexer();
  indexer.setOptions({
    honorIfdef: options.honorIfdef !== false,
    maxInstancesPerModule: options.maxInstancesPerModule ?? 2000,
    extraDefines: options.defines ?? [],
    undefines: options.undefines ?? [],
    inlineIncludes: options.inlineIncludes !== false,
  });

  /** 建索引时的文件指纹：用于长驻进程（MCP）判断该刷新哪些文件 */
  let stamps = new Map();
  let buildPromise = null;
  let buildMs = 0;
  let lastStats = null;

  // ------------------------------------------------------------ 索引与刷新

  async function readAll(files) {
    const next = new Map();
    for (const f of files) {
      const st = await provider.stat(f);
      if (st) next.set(f, st);
    }
    return next;
  }

  async function ensureIndex(force = false) {
    if (indexer.isBuilt && !force) return;
    if (buildPromise) return buildPromise;
    buildPromise = (async () => {
      const files = await provider.listFiles();
      stamps = await readAll(files);
      const t0 = Date.now();
      await indexer.build(provider);
      buildMs = Date.now() - t0;
      lastStats = indexer.current.stats;
    })();
    try {
      await buildPromise;
    } finally {
      buildPromise = null;
    }
  }

  /**
   * 长驻进程的增量刷新：AI 会边改代码边问问题，索引必须跟着走。
   * 每次调用都扫一遍目录 + 取一次 stat（几百个文件只要几毫秒），
   * 只对变动的文件做局部重建；文件增删则整体重建（保证 instantiations / topCandidates 正确）。
   */
  async function syncToDisk() {
    if (!indexer.isBuilt) return { rebuilt: false, changed: 0 };
    const files = await provider.listFiles();
    const next = await readAll(files);
    const sameSet = files.length === stamps.size && files.every((f) => stamps.has(f));
    if (!sameSet) {
      await ensureIndex(true);
      return { rebuilt: true, changed: files.length };
    }
    let changed = 0;
    for (const [f, st] of next) {
      const old = stamps.get(f);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
      try {
        indexer.updateFile(f, fs.readFileSync(f, 'utf8'));
        changed++;
      } catch {
        await ensureIndex(true);
        return { rebuilt: true, changed: files.length };
      }
    }
    stamps = next;
    return { rebuilt: false, changed };
  }

  // ------------------------------------------------------------ 渲染小工具

  /**
   * 路径口径：工程根内 → 相对路径（正斜杠）；工程根外 → **显式标注**，绝不裸奔绝对路径。
   *
   * 实测教训：绝对路径混在相对路径里时，AI 会以为是本工程内的路径，照着去打开就踩空
   * （索引在 I:\，输出里冒出 E:\ 的路径，AI 直接抄走去 read_file）。
   */
  const rel = (p) => {
    if (!p) return '?';
    const r = path.relative(root, p).replace(/\\/g, '/');
    if (r === '') return '.';
    if (r.startsWith('..') || path.isAbsolute(r)) return `[工程外] ${String(p).replace(/\\/g, '/')}`;
    return r;
  };
  /** 该路径是否在当前工程根内（context 用来区分"没索引"与"不在模块体内"） */
  const inRoot = (p) => {
    const r = path.relative(root, p);
    return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
  };
  /** 位置文本：`文件:行`，行号 1 起 */
  const loc = (file, line) => `${rel(file)}:${line === undefined || line === null ? '?' : line + 1}`;
  const flagText = (flags) => {
    const out = [];
    for (const f of flags ?? []) {
      if (f === 'cross' || f === 'intra') continue; // 每行都标等于没标，链路本身看得出来
      const t = FLAG_LABEL[f];
      if (t && !out.includes(t)) out.push(t);
    }
    return out.length > 0 ? `[${out.join('·')}] ` : '';
  };
  const dirOf = (d) => (d ? DIR_LABEL[d] ?? d : '未知方向');
  const rangeOf = (msb, lsb) => (msb !== null && lsb !== null ? `[${msb}:${lsb}]` : '');

  // ------------------------------------------------------------ 目标解析

  /**
   * 把（信号名 [+ 模块名]）解析成确定的一个（模块, 网络）。
   *
   * 信号名在工程里几乎不唯一（`data`、`i_data` 遍地都是），所以：
   *   - 指定了 module → 就用它（名字是子模块端口时交给 resolveStartPoint 处理）
   *   - 没指定 → 按"端口定义优先、被例化次数多优先、路径靠前"挑一个，
   *     并把**全部候选**一起返回，让 AI 自己决定要不要换一个（消歧必须可见）
   */
  function resolveTarget(name, moduleName) {
    const candidates = [];
    const push = (mod, why) => {
      if (!mod) return;
      if (candidates.some((c) => c.module === mod.name && c.file === mod.file)) return;
      candidates.push({
        module: mod.name,
        file: mod.file,
        why,
        ports: mod.ports.length,
        instances: mod.instances.length,
        instantiated: indexer.getInstantiations(mod.name).length,
      });
    };

    if (moduleName) {
      const mod = indexer.getModule(moduleName);
      if (!mod) {
        const names = allModuleNames().filter((n) => n.toLowerCase() === moduleName.toLowerCase());
        throw new Error(
          `找不到模块 ${moduleName}` + (names.length > 0 ? `（是不是想写 ${names.join(' / ')}？）` : ''),
        );
      }
      push(mod, '指定模块');
    } else {
      for (const mod of indexer.findModulesDeclaring(name)) {
        push(mod, mod.ports.some((p) => p.name === name) ? '端口定义' : '内部信号声明');
      }
      // 也可能是"某个模块端口在父层例化时的连接名" —— 退一步在顶层候选里找
      if (candidates.length === 0) {
        for (const top of indexer.current.topCandidates) {
          const mod = indexer.getModule(top);
          if (!mod) continue;
          for (const inst of mod.instances) {
            if (inst.connections.some((c) => c.primaryNet === name || c.port === name)) {
              push(mod, '顶层例化中出现的名字');
              break;
            }
          }
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error(
        `找不到信号 ${name}。先用 search("${name}*") 确认名字；` +
          `若它只出现在例化端口上，请用 module=<所在模块> 指定范围。`,
      );
    }

    const rank = (c) => (c.why === '端口定义' || c.why === '指定模块' ? 0 : 1);
    candidates.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        b.instantiated - a.instantiated ||
        b.ports - a.ports ||
        a.file.localeCompare(b.file),
    );
    const mod = indexer.getModule(candidates[0].module) ?? indexer.findModulesDeclaring(name)[0];
    if (!mod) throw new Error(`内部错误: 无法取到模块 ${candidates[0].module}`);
    const start = resolveStartPoint(indexer, mod, name);
    return { start, candidates, picked: candidates[0] };
  }

  function allModuleNames() {
    return [...indexer.current.modules.keys()];
  }

  // ------------------------------------------------------------ 操作：索引

  async function opIndex(args = {}) {
    await ensureIndex(Boolean(args.force));
    const idx = indexer.current;
    const st = idx.stats;
    const data = {
      root,
      runtime, // out = 编译产物（与插件同一份）；src = 源码回退
      scope: scope ?? null,
      files: st.fileCount,
      modules: st.moduleCount,
      instances: st.instanceCount,
      parseMs: st.parseMs,
      buildMs,
      topCandidates: idx.topCandidates,
      defines: [...idx.defines],
      includes: [...idx.includes],
    };
    // 顶层候选是按"没人例化它"筛出来的，工程里往往有一大堆 IP 包装与 testbench；
    // 文本里只列最有分量的几个（按子例化数排），把完整清单留给 JSON。
    // 顶层候选是按"没人例化它"筛出来的，工程里往往有一大堆 IP 包装、testbench 和叶子模块。
    // 经验：**有子例化的候选才可能是真正的顶层**，所以先按子例化数排序并只列这些。
    const topsRanked = [...idx.topCandidates]
      .map((n) => ({ name: n, instances: indexer.getModule(n)?.instances.length ?? 0 }))
      .sort((a, b) => b.instances - a.instances || a.name.localeCompare(b.name));
    const topsReal = topsRanked.filter((t) => t.instances > 0);
    const topShow = (topsReal.length > 0 ? topsReal : topsRanked)
      .slice(0, 12)
      .map((t) => `${t.name}(${t.instances})`);
    const macros = [...idx.defines];
    data.topCandidates = topsRanked.map((t) => t.name);
    data.topCandidatesDetail = topsRanked;
    data.topCandidatesWithInstances = topsReal.length;

    const lines = [
      `SigRoute 索引（行号 1 起，路径相对工程根）`,
      `  工程根 : ${root}${scope ? `  (scope=${scope})` : ''}`,
      `  规模   : ${st.fileCount} 文件 · ${st.moduleCount} 模块 · ${st.instanceCount} 例化 · 解析 ${st.parseMs} ms`,
      `  顶层候选: 共 ${topsRanked.length} 个（其中 ${topsReal.length} 个有子例化，更可能是真正的顶层）`,
      `  按子例化数排序前几位: ${topShow.join(', ') || '（没有：可能是纯 IP 库）'}${topsRanked.length > topShow.length ? ' …' : ''}`,
      macros.length > 0 ? `  已识别宏: ${macros.slice(0, 8).join(', ')}${macros.length > 8 ? ` …（共 ${macros.length} 个）` : ''}` : '',
    ];
    const skipped = idx.skipped ?? [];
    if (skipped.length > 0) {
      // 加密/二进制文件被跳过时必须说出来：否则调用方会以为"这个模块就是空的"
      lines.push(
        `  跳过 ${skipped.length} 个非文本文件（加密/二进制，未参与索引）: ` +
          skipped
            .slice(0, 5)
            .map((s) => `${rel(s.file)}（${s.reason}）`)
            .join('、') +
          (skipped.length > 5 ? ` …另有 ${skipped.length - 5} 个` : ''),
      );
    }
    lines.push(`  下一步 : search(名字) → describe(信号) → trace(信号, direction=both)`);
    return { data, text: lines.filter(Boolean).join('\n') };
  }

  // ------------------------------------------------------------ 操作：搜索

  async function opSearch(args = {}) {
    await ensureIndex();
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error('search 需要 query（支持 * 与 ? 通配）');
    const kind = args.kind ?? 'any';
    const limit = Math.min(Math.max(Number(args.limit ?? 30), 1), 200);
    // 匹配语义（AI 最容易踩的坑）：
    //   带 * / ?  → 按通配式整体匹配；
    //   否则      → **包含匹配**（`rd_time` 能搜到 `o_rd_time`），
    //               并且先区分大小写、0 命中时再退回不区分大小写（避免直接给出"命中 0"的死胡同）。
    const isPattern = /[*?]/.test(query);
    let mode = isPattern ? '通配' : '包含';
    let re = isPattern ? wildcardToRe(query) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const scan = (rx) => {
      const mods = [];
      const ports = [];
      const sigs = [];
      if (kind === 'any' || kind === 'module') {
        for (const [name, decls] of indexer.current.modules) {
          if (!rx.test(name)) continue;
          const mod = decls[0];
          mods.push({
            name,
            file: rel(mod.file),
            line: mod.headerLine + 1,
            ports: mod.ports.length,
            instances: mod.instances.length,
            instantiated: indexer.getInstantiations(name).length,
            definitions: decls.length,
            declOnly: indexer.isDeclOnly(name),
          });
        }
      }
      if (kind === 'any' || kind === 'port' || kind === 'signal') {
        for (const [name, decls] of indexer.current.modules) {
          for (const mod of decls) {
            for (const p of mod.ports) {
              if (!rx.test(p.name)) continue;
              ports.push({
                module: name,
                name: p.name,
                direction: p.direction,
                range: rangeOf(p.msb, p.lsb),
                width: p.width,
                file: rel(p.file ?? mod.file),
                line: p.line + 1,
              });
            }
            for (const [sigName, s] of mod.signals) {
              if (!rx.test(sigName)) continue;
              sigs.push({
                module: name,
                name: sigName,
                kind: s.kind,
                range: rangeOf(s.msb, s.lsb),
                line: (s.line ?? mod.headerLine) + 1,
                file: rel(mod.file),
                implicit: Boolean(s.implicit),
              });
            }
          }
        }
      }
      return { mods, ports, sigs };
    };

    let hit = scan(re);
    if (!isPattern && hit.mods.length + hit.ports.length + hit.sigs.length === 0) {
      // 大小写写错也算"没找到"太容易让 AI 走进死胡同：不区分大小写再扫一遍
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      hit = scan(rx);
      if (hit.mods.length + hit.ports.length + hit.sigs.length > 0) mode = '包含·不区分大小写';
    }
    const { mods, ports, sigs } = hit;

    const total = mods.length + ports.length + sigs.length;
    const shown = { mods: mods.slice(0, limit), ports: ports.slice(0, limit), sigs: sigs.slice(0, limit) };
    const data = { query, kind, mode, total, modules: mods.slice(0, limit), ports: ports.slice(0, limit), signals: sigs.slice(0, limit) };

    const lines = [`搜索 "${query}"（kind=${kind}, ${mode}匹配）→ 命中 ${total} 处${total > limit ? `，显示前 ${limit}` : ''}`];
    if (shown.mods.length > 0) {
      lines.push('', `模块 (${mods.length})`);
      for (const m of shown.mods) {
        lines.push(
          `  ${m.name.padEnd(24)} ${m.file}:${m.line}  端口 ${m.ports} · 子例化 ${m.instances} · 被例化 ${m.instantiated}` +
            (m.definitions > 1 ? ` · 同名定义 ${m.definitions} 处` : '') +
            (m.declOnly ? ' · 仅声明（无实现）' : ''),
        );
      }
    }
    if (shown.ports.length > 0) {
      lines.push('', `端口 (${ports.length})`);
      for (const p of shown.ports) {
        lines.push(`  ${`${p.module}.${p.name}`.padEnd(40)} ${dirOf(p.direction)} ${p.range}`.trimEnd() + `  ${p.file}:${p.line}`);
      }
    }
    if (shown.sigs.length > 0) {
      lines.push('', `内部信号 (${sigs.length})`);
      for (const s of shown.sigs) {
        lines.push(
          `  ${`${s.module}.${s.name}`.padEnd(40)} ${s.kind} ${s.range}`.trimEnd() +
            `${s.implicit ? '（隐式 wire）' : ''}  ${s.file}:${s.line}`,
        );
      }
    }
    if (total === 0) {
      lines.push('', `（没有匹配。本次是「${mode}」匹配：可以再试更短的片段（如 rd_time）、通配式（*rd_time*），或换 kind）`);
    }
    else lines.push('', '（describe / trace 时传 module= 可消歧）');
    return { data, text: lines.join('\n') };
  }

  // ------------------------------------------------------------ 操作：速查 / 别名 / 层次

  const refLine = (r) =>
    `  ${(REF_KIND[r.kind] ?? r.kind).padEnd(12)} ${loc(r.file, r.line)}  ${r.text}${r.detail ? `  ${r.detail}` : ''}`;

  async function opDescribe(args = {}) {
    await ensureIndex();
    const name = String(args.signal ?? '').trim();
    if (!name) throw new Error('describe 需要 signal');
    const { start, candidates } = resolveTarget(name, args.module);
    const mod = start.module;
    const desc = describeSignal(indexer, mod, name);
    const paths = hierarchyPaths(indexer, mod.name, name, { maxPaths: 6 });

    const declDir = desc.decl.direction ? dirOf(desc.decl.direction) : desc.decl.kind;
    const data = {
      signal: name,
      module: mod.name,
      note: start.note ?? null,
      declaration: {
        kind: desc.decl.kind,
        direction: desc.decl.direction ?? null,
        width: desc.decl.width,
        range: desc.decl.range,
        file: desc.decl.file ? rel(desc.decl.file) : null,
        line: desc.decl.line !== undefined ? desc.decl.line + 1 : null,
      },
      drivers: desc.drivers.map((r) => ({ ...r, file: rel(r.file), line: r.line + 1 })),
      loads: desc.loads.map((r) => ({ ...r, file: rel(r.file), line: r.line + 1 })),
      aliases: desc.aliases,
      hierarchy: paths.map((p) => p.text),
      instantiationCount: desc.instantiationCount,
      candidates: candidates.slice(0, 6),
    };

    const lines = [
      `信号 ${name} @ ${mod.name}   ${declDir} ${desc.decl.range ?? ''}${desc.decl.width !== null ? ` (${desc.decl.width} 位)` : ''}`.trimEnd(),
      `声明: ${loc(desc.decl.file, desc.decl.line)}${start.note ? `   （${start.note}）` : ''}`,
    ];
    const section = (title, arr) => {
      if (arr.length === 0) return;
      lines.push(`${title} (${arr.length}):`);
      for (const r of arr.slice(0, 12)) lines.push(refLine(r));
      if (arr.length > 12) lines.push(`  …另有 ${arr.length - 12} 条`);
    };
    section('驱动源', desc.drivers);
    section('负载', desc.loads);
    if (desc.aliases.length > 0) {
      lines.push(`同网络别名 (${desc.aliases.length}):`);
      for (const a of desc.aliases.slice(0, 12)) {
        lines.push(`  ${`${a.module}.${a.net}`.padEnd(40)} ${dirOf(a.direction)}  ${a.kind}  例化 ${a.instances} 次`);
      }
    }
    if (paths.length > 0) {
      lines.push(`层次路径 (${paths.length}${paths.some((p) => p.partial) ? '，含裁剪' : ''}):`);
      for (const p of paths) lines.push(`  ${p.text}${p.partial ? '  (partial)' : ''}`);
    }
    if (candidates.length > 1) {
      lines.push(
        `注意: 名字在 ${candidates.length} 个模块里都有 —— 本次取 ${mod.name}；其它候选: ` +
          candidates
            .slice(1, 5)
            .map((c) => `${c.module}(${c.why})`)
            .join(', '),
      );
    }
    return { data, text: lines.join('\n') };
  }

  async function opAliases(args = {}) {
    await ensureIndex();
    const name = String(args.signal ?? '').trim();
    if (!name) throw new Error('aliases 需要 signal');
    const { start, candidates } = resolveTarget(name, args.module);
    const members = indexer.netMembers(start.module.name, name);
    const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);

    const data = {
      signal: name,
      module: start.module.name,
      total: members.length,
      members: members.map((m) => {
        const mod = indexer.getModule(m.module);
        const port = mod?.ports.find((p) => p.name === m.net);
        const sig = mod?.signals.get(m.net);
        return {
          ...m,
          file: mod ? rel(mod.file) : null,
          line: port ? port.line + 1 : sig?.line !== undefined ? sig.line + 1 : null,
          range: port ? rangeOf(port.msb, port.lsb) : sig ? rangeOf(sig.msb, sig.lsb) : '',
        };
      }),
    };
    const lines = [`同一物理网络的全部名字（共 ${data.total} 个，含起点 ${name}）`];
    for (const m of data.members.slice(0, limit)) {
      const here = m.module === start.module.name && m.net === name ? ' ← 起点' : '';
      lines.push(
        `  ${`${m.module}.${m.net}`.padEnd(42)} ${dirOf(m.direction)} ${m.kind}  ${m.range}  ` +
          `${m.file ?? '?'}${m.line !== null ? `:${m.line}` : ''}  该模块例化 ${m.instances} 次${here}`,
      );
    }
    if (data.total > limit) lines.push(`  …另有 ${data.total - limit} 个`);
    lines.push('', '（顺着这些名字读下去，改名点就是"父层网络 ≡ 子模块端口"的那次连接）');
    return { data, text: lines.join('\n') };
  }

  async function opHierarchy(args = {}) {
    await ensureIndex();
    const name = String(args.signal ?? '').trim();
    if (!name) throw new Error('hierarchy 需要 signal');
    const { start } = resolveTarget(name, args.module);
    const maxPaths = Math.min(Math.max(Number(args.maxPaths ?? 12), 1), 64);
    const paths = hierarchyPaths(indexer, start.module.name, name, { maxPaths });
    const data = {
      signal: name,
      module: start.module.name,
      paths: paths.map((p) => ({
        text: p.text,
        partial: p.partial,
        steps: p.steps.map((s) => ({ moduleName: s.moduleName, file: rel(s.file), line: s.line + 1 })),
      })),
    };
    const lines = [`${start.module.name}.${name} 的层次路径（${paths.length} 条${paths.some((p) => p.partial) ? '，含裁剪' : ''}）`];
    for (const p of paths) lines.push(`  ${p.text}${p.partial ? '  (partial)' : ''}`);
    if (paths.length === 0) lines.push('  （这是顶层模块，或层次链成环/过深）');
    return { data, text: lines.join('\n') };
  }

  // ------------------------------------------------------------ 操作：模块

  async function opModule(args = {}) {
    await ensureIndex();
    const name = String(args.module ?? '').trim();
    if (!name) throw new Error('module 需要 module 名');
    const mod = indexer.getModule(name);
    const defs = indexer.getModules(name);
    if (!mod) {
      const guess = allModuleNames().filter((n) => n.toLowerCase().includes(name.toLowerCase()));
      // 名字没找到时，顺手告诉它"是不是那个非文本文件里的模块"——不然很容易被当成 bug 查半天
      const skippedHit = (indexer.current.skipped ?? []).filter((s) =>
        path.basename(s.file).toLowerCase().includes(name.toLowerCase()),
      );
      const hints = [
        guess.length > 0 ? `相近的模块：${guess.slice(0, 8).join(', ')}` : '',
        skippedHit.length > 0 ? ` ${skippedHit.map((s) => `${rel(s.file)}（${s.reason}）`).join('、')} 未能解析` : '',
      ].filter(Boolean);
      throw new Error(`找不到模块 ${name}${hints.length > 0 ? `（${hints.join('；')}）` : ''}`);
    }
    const sites = indexer.getInstantiations(name);
    const unresolved = mod.instances.filter((i) => !indexer.hasModule(i.moduleType));

    const data = {
      module: name,
      file: rel(mod.file),
      line: mod.headerLine + 1,
      definitions: defs.map((d) => ({ file: rel(d.file), line: d.headerLine + 1 })),
      declOnly: indexer.isDeclOnly(name),
      ports: mod.ports.map((p) => ({
        name: p.name,
        direction: p.direction,
        range: rangeOf(p.msb, p.lsb),
        width: p.width,
        line: p.line + 1,
      })),
      instances: mod.instances.map((i) => ({
        type: i.moduleType,
        instance: i.instanceName,
        line: i.line + 1,
        resolved: indexer.hasModule(i.moduleType),
        connections: i.connections.length,
      })),
      instantiatedBy: sites.map((s) => ({
        parent: s.parentModule,
        file: rel(s.parentFile),
        line: s.instance.line + 1,
        instance: s.instance.instanceName,
      })),
    };

    const lines = [
      `模块 ${name}  ${loc(mod.file, mod.headerLine)}${defs.length > 1 ? `（同名定义 ${defs.length} 处：${defs.map((d) => loc(d.file, d.headerLine)).join(', ')}）` : ''}`,
    ];
    if (indexer.isDeclOnly(name)) lines.push('注意: 只有声明没有实现（黑盒/IP），端口方向靠声明或例化模板推断');
    lines.push(`端口 ${mod.ports.length}:`);
    for (const p of mod.ports) {
      lines.push(`  ${p.name.padEnd(28)} ${dirOf(p.direction).padEnd(7)} ${rangeOf(p.msb, p.lsb).padEnd(10)} ${loc(mod.file, p.line)}`);
    }
    lines.push(`子例化 ${mod.instances.length}${unresolved.length > 0 ? `（其中 ${unresolved.length} 个未索引：${unresolved.slice(0, 6).map((i) => i.moduleType).join(', ')}）` : ''}:`);
    for (const i of mod.instances) {
      lines.push(
        `  ${i.instanceName.padEnd(24)} : ${i.moduleType.padEnd(28)} ${loc(mod.file, i.line)}` +
          `${indexer.hasModule(i.moduleType) ? '' : '  [未索引/黑盒]'}${i.inGenerate ? '  [generate]' : ''}`,
      );
    }
    lines.push(`被例化 ${sites.length} 次:`);
    for (const s of sites) {
      lines.push(`  ${s.instance.instanceName.padEnd(24)} in ${s.parentModule.padEnd(24)} ${loc(s.parentFile, s.instance.line)}`);
    }
    if (sites.length === 0 && indexer.current.topCandidates.includes(name)) lines.push('  （没有被任何模块例化 → 顶层候选）');
    return { data, text: lines.join('\n') };
  }

  // ------------------------------------------------------------ 操作：上下文（读代码第一入口）

  async function opContext(args = {}) {
    await ensureIndex();
    const fileArg = String(args.file ?? '').trim();
    if (!fileArg) throw new Error('context 需要 file');
    const lineArg = Number(args.line);
    if (!Number.isFinite(lineArg) || lineArg < 1) throw new Error('context 需要 line（1 起）');
    const abs = path.isAbsolute(fileArg) ? fileArg : path.resolve(root, fileArg);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${rel(abs)}（路径相对工程根）`);
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    const line0 = Math.min(Math.max(lineArg - 1, 0), Math.max(lines.length - 1, 0));
    const col = Math.max(0, Math.min(Number(args.column ?? 0), 0));
    let offset = 0;
    for (let i = 0; i < line0; i++) offset += lines[i].length + 1;
    offset += col;

    const mod = indexer.findModuleAt(abs.replace(/\\/g, '/'), offset);
    const lineText = lines[line0] ?? '';

    // 这一行的所有标识符，按"信息量"挑一个：本行开始的例化 > 行内信号（离给定列最近）> 模块/例化名 > 第一个词
    const words = [...lineText.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)].map((m) => ({ word: m[0], col: m.index }));
    const near0 = (w) => Math.abs(w.col - col);
    const instOnLine = mod ? mod.instances.find((i) => i.line === line0) : undefined;
    const signalPick = mod
      ? words.filter((w) => indexer.lookupSignal(mod, w.word) !== 'unknown').sort((a, b) => near0(a) - near0(b))[0]
      : undefined;
    const modulePick = words
      .filter(
        (w) =>
          (mod && mod.instances.some((i) => i.instanceName === w.word || i.moduleType === w.word)) ||
          indexer.hasModule(w.word),
      )
      .sort((a, b) => near0(a) - near0(b))[0];
    const word = (instOnLine ? instOnLine.instanceName : signalPick?.word ?? modulePick?.word ?? words[0]?.word) ?? null;

    const out = [`文件 ${rel(abs)}:${line0 + 1}`, `  该行: ${lineText.trim() || '（空行）'}`];
    const data = {
      file: rel(abs),
      line: line0 + 1,
      text: lineText,
      module: mod ? mod.name : null,
      signal: null,
    };

    if (!mod) {
      // 两种"没有模块"要分开说：文件压根不在索引范围里，和文件在范围里但这一行不属于任何模块
      out.push(
        inRoot(abs)
          ? '  （这一行不在任何模块体内 —— 可能是文件头注释、`include 或宏定义）'
          : '  （该文件不在已索引的工程根内：只读了文本、没有语义；把 root 指到它所属的工程根再问一次）',
      );
      const modsInFile = indexer.current.fileModules.get(abs.replace(/\\/g, '/')) ?? [];
      if (modsInFile.length > 0) out.push(`  本文件定义的模块: ${modsInFile.join(', ')}`);
      return { data, text: out.join('\n') };
    }

    out.push(`  所在模块: ${mod.name}  ${loc(mod.file, mod.headerLine)}  （端口 ${mod.ports.length} · 子例化 ${mod.instances.length}）`);

    const instHere = word
      ? mod.instances.find((i) => i.line === line0 || i.instanceName === word || i.moduleType === word)
      : undefined;

    if (word && indexer.lookupSignal(mod, word) !== 'unknown') {
      out.push('', `光标下的名字: ${word}（信号）`);
      try {
        const { start } = resolveTarget(word, mod.name);
        const desc = describeSignal(indexer, start.module, word);
        const dir = desc.decl.direction ? dirOf(desc.decl.direction) : desc.decl.kind;
        data.signal = {
          name: word,
          module: start.module.name,
          declaration: {
            kind: desc.decl.kind,
            direction: desc.decl.direction ?? null,
            range: desc.decl.range,
            file: desc.decl.file ? rel(desc.decl.file) : null,
            line: desc.decl.line !== undefined ? desc.decl.line + 1 : null,
          },
          drivers: desc.drivers.length,
          loads: desc.loads.length,
          aliases: desc.aliases.map((a) => `${a.module}.${a.net}`),
        };
        out.push(
          `  ${dir} ${desc.decl.range ?? ''}${desc.decl.width !== null ? ` (${desc.decl.width} 位)` : ''}  声明 ${loc(desc.decl.file, desc.decl.line)}`.trimEnd(),
        );
        out.push(`  驱动源 ${desc.drivers.length} · 负载 ${desc.loads.length} · 别名 ${desc.aliases.length}`);
        for (const r of desc.drivers.slice(0, 6)) out.push(refLine(r));
        for (const r of desc.loads.slice(0, 6)) out.push(refLine(r));
        if (desc.aliases.length > 0) {
          out.push(`  同网络别名: ${desc.aliases.map((a) => `${a.module}.${a.net}(${dirOf(a.direction)})`).join(', ')}`);
        }
        out.push('  （需要整条链路就对它跑 trace）');
      } catch (err) {
        out.push(`  （按信号解析失败：${err.message}）`);
      }
    } else if (instHere) {
      // 例化名 / 子模块类型名：给出这条例化的端口连接，省掉"再读一遍那一行"
      out.push('', `光标下的名字: ${word}（例化）`);
      out.push(`  ${instHere.instanceName} : ${instHere.moduleType}  例化于 ${loc(mod.file, instHere.line)}${instHere.inGenerate ? '  [generate]' : ''}`);
      data.instance = {
        instance: instHere.instanceName,
        type: instHere.moduleType,
        line: instHere.line + 1,
        resolved: indexer.hasModule(instHere.moduleType),
        connections: instHere.connections.map((c) => ({ port: c.port, expr: c.expr, kind: c.kind })),
      };
      for (const c of instHere.connections.slice(0, 16)) {
        out.push(`  .${c.port ?? `[${c.portIndex}]`}(${c.expr})${c.kind !== 'net' ? `  [${c.kind}]` : ''}`);
      }
    } else if (word && indexer.hasModule(word)) {
      out.push('', `光标下的名字是模块: ${word} —— 用 module 工具看它的端口与例化`);
    }

    const near = [];
    for (const p of mod.ports) {
      if (Math.abs(p.line - line0) <= 60) near.push({ line: p.line + 1, name: p.name, what: `${dirOf(p.direction)} ${rangeOf(p.msb, p.lsb)}`.trim() });
    }
    for (const [sn, s] of mod.signals) {
      const l = s.line ?? mod.headerLine;
      if (Math.abs(l - line0) <= 60) near.push({ line: l + 1, name: sn, what: `${s.kind} ${rangeOf(s.msb, s.lsb)}`.trim() });
    }
    near.sort((a, b) => a.line - b.line);
    if (near.length > 0) {
      out.push('', `附近声明（±60 行，共 ${near.length} 条）:`);
      for (const n of near.slice(0, 12)) out.push(`  ${String(n.line).padStart(5)}  ${n.name.padEnd(28)} ${n.what}`);
      if (near.length > 12) out.push(`  …另有 ${near.length - 12} 条（要查具体某个名字用 search / describe 更省）`);
    }
    return { data, text: out.join('\n') };
  }

  // ------------------------------------------------------------ 操作：追踪

  function renderTree(node, filter, depth = 0, lines = []) {
    const keep = (n) => {
      if (filter === 'all') return true;
      if (filter === 'renamed') return n.flags.includes('renamed') || n.kind === 'group' || n.kind === 'note' || n.flags.includes('summary');
      if (n.flags.includes('cross')) return true;
      if (n.kind === 'group' || n.kind === 'note') return true;
      return ['terminal', 'constant', 'unconnected', 'blackbox'].includes(n.kind);
    };
    // 节点的 description 里常常已经写着"文件:行"（插件树视图就是这么显示的），
    // 别再重复贴一遍：AI 读的时候省 token，人读的时候也更清爽。
    const inDesc = node.file
      ? String(node.description ?? '').includes(`${path.basename(node.file)}:${(node.line ?? 0) + 1}`)
      : false;
    const loc0 = node.file && node.line !== undefined && !inDesc ? `  ${loc(node.file, node.line)}` : '';
    // edgeText 里常常已经带了这个节点自己的名字（`assign s_pos_wr_en_mux` + label `s_pos_wr_en_mux`），
    // 直接拼会得到 "assign X X" 这种重复；把尾部同名收成 `…`（`assign … X`）更好读。
    let edge = node.edgeText ?? '';
    if (edge && node.label && edge.endsWith(node.label)) {
      edge = `${edge.slice(0, -node.label.length).trimEnd()} …`;
    }
    const pad = '  '.repeat(depth);
    lines.push(
      `${pad}${depth === 0 ? '' : '- '}${flagText(node.flags)}${edge ? `${edge} ` : ''}${node.label}` +
        `${node.description ? `  ${node.description}` : ''}${loc0}`,
    );
    // 过滤时把不符合条件的中间节点整条跳过、只把它的可见子节点**提升**到当前层级。
    // 注意：不能渲染被跳过的节点本身（否则它会以"同级"的样子出现，层级看起来就乱了，
    // 而且 filter=cross 说好的"跳过模块内中间变量"也会失效）。
    const promote = (parent, level) => {
      for (const c of parent.children) {
        if (filter === 'all' || keep(c)) renderTree(c, filter, level + 1, lines);
        else promote(c, level);
      }
    };
    promote(node, depth);
    return lines;
  }

  async function opTrace(args = {}) {
    await ensureIndex();
    const name = String(args.signal ?? '').trim();
    if (!name) throw new Error('trace 需要 signal');
    const direction = ['up', 'down', 'both'].includes(args.direction) ? args.direction : 'both';
    const depth = Math.min(Math.max(Number(args.depth ?? 12), 1), 60);
    const filter = ['all', 'cross', 'renamed'].includes(args.filter) ? args.filter : 'all';
    const { start, candidates } = resolveTarget(name, args.module);
    const t0 = Date.now();
    const result = traceSignal(indexer, start.module, name, {
      direction,
      maxDepth: depth,
      maxNodes: Number(args.maxNodes ?? 4000),
      maxChildren: Number(args.maxChildren ?? 60),
    });
    const ms = Date.now() - t0;
    // 输出上限：链路一展开很容易上百行，AI 读起来又贵又抓不住重点 —— 截断并明确告诉它怎么收窄
    const limit = Math.min(Math.max(Number(args.limit ?? 200), 20), 2000);
    const all = renderTree(result.root, filter);
    const tree = all.length > limit ? all.slice(0, limit) : all;
    const over = all.length > limit;

    const header = [
      `追踪 ${name} @ ${start.module.name}（direction=${direction}, depth<=${depth}, filter=${filter}${over ? `, limit=${limit}` : ''}）${start.note ? ` — ${start.note}` : ''}`,
      `链路摘要: 模块 ${result.modules.length} · 改名 ${result.stats.renames} · 黑盒 ${result.stats.blackboxes} · 不确定 ${result.stats.uncertainties} · 最大跨模块层数 ${result.stats.maxDepthReached} · 节点 ${result.stats.nodes}${over ? ` · 输出 ${limit}/${all.length} 行` : ''}`,
      `经过模块: ${result.modules.join(' → ') || start.module.name}`,
      '',
    ];
    const graphLines = [];
    if (args.graph) {
      const g = result.graph;
      graphLines.push('', `模块级拓扑（${g.stats.nodes} 节点 / ${g.stats.edges} 边 / 改名 ${g.stats.renames}）:`);
      for (const n of g.nodes) {
        graphLines.push(
          `  [${n.isStart ? '起点' : `跳数 ${n.hop}`}] ${n.moduleName.padEnd(28)} 流入 ${n.inNets.join(',') || '-'} 流出 ${n.outNets.join(',') || '-'}`,
        );
      }
      for (const e of g.edges) {
        graphLines.push(`  ${e.from} --${e.fromNet}${e.renamed ? ' ⇄ ' : ' → '}${e.toNet}--> ${e.to}${e.instanceName ? `  (经由 ${e.instanceName})` : ''}`);
      }
    }

    const data = {
      signal: name,
      module: start.module.name,
      direction,
      depth,
      filter,
      ms,
      stats: result.stats,
      modules: result.modules,
      start: { ...result.start, file: rel(result.start.file), line: result.start.line + 1 },
      candidates: candidates.slice(0, 6),
      tree: filterTreeData(result.root, filter),
      graph: args.graph
        ? {
            nodes: result.graph.nodes.map((n) => ({ id: n.id, hop: n.hop, isStart: n.isStart, inNets: n.inNets, outNets: n.outNets, hits: n.hits })),
            edges: result.graph.edges.map((e) => ({ from: e.from, to: e.to, fromNet: e.fromNet, toNet: e.toNet, port: e.port, instance: e.instanceName ?? null, renamed: e.renamed })),
          }
        : undefined,
    };
    const tail = over
      ? [`（链路共 ${all.length} 行，这里只给前 ${limit} 行：用 filter=cross|renamed 或更小的 depth 收窄，需要看全就传 limit=${all.length}）`]
      : [];
    return { data, text: [...header, ...tree, ...tail, ...graphLines].join('\n') };
  }

  /** JSON 模式下的链路：保留结构，行号换算成 1 起，路径相对工程根 */
  function filterTreeData(node, filter) {
    const keep = (n) => {
      if (filter === 'all') return true;
      if (filter === 'renamed') return n.flags.includes('renamed') || n.kind === 'group' || n.kind === 'note' || n.flags.includes('summary');
      if (n.flags.includes('cross')) return true;
      if (n.kind === 'group' || n.kind === 'note') return true;
      return ['terminal', 'constant', 'unconnected', 'blackbox'].includes(n.kind);
    };
    const children = [];
    for (const c of node.children) {
      if (filter === 'all' || keep(c)) children.push(filterTreeData(c, filter));
      else children.push(...filterTreeData(c, filter).children);
    }
    return {
      label: node.label,
      kind: node.kind,
      description: node.description ?? null,
      flags: node.flags,
      file: node.file ? rel(node.file) : null,
      line: node.line !== undefined ? node.line + 1 : null,
      aliases: node.aliases ?? [],
      pending: node.pendingCount ?? null,
      children,
    };
  }

  // ------------------------------------------------------------ 汇总

  const OPS = {
    index: opIndex,
    search: opSearch,
    describe: opDescribe,
    trace: opTrace,
    aliases: opAliases,
    hierarchy: opHierarchy,
    module: opModule,
    context: opContext,
  };

  /** 给 MCP 用的工具声明（description 是 AI 决定要不要调用的依据，写具体） */
  const SPECS = [
    {
      name: 'sigroute_index',
      description:
        '建立/刷新 RTL 工程索引，返回规模（文件/模块/例化）、顶层模块候选与已识别宏。其它工具都会自动保证索引最新并做增量刷新，一般不必显式调用；想强制重建时用 force=true。',
      inputSchema: { type: 'object', properties: { force: { type: 'boolean', description: '强制重建（默认 false，仅在索引明显过期时用）' } }, additionalProperties: false },
    },
    {
      name: 'sigroute_search',
      description:
        '按名字搜索模块 / 端口 / 内部信号，返回位置（文件:行）、方向/位宽、例化规模。默认**包含匹配**（rd_time 能搜到 o_rd_time）；查询里带 * 或 ? 时按通配式整体匹配；大小写不一致会自动再试一次（不区分大小写）。用它把模糊记忆里的名字变成精确入参，再交给 describe / trace。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '名字片段或通配式，如 rd_time、s_dma*、*fifo*、data_path' },
          kind: { type: 'string', enum: ['any', 'module', 'port', 'signal'], description: '限定种类，默认 any' },
          limit: { type: 'number', description: '每类最多返回多少条，默认 30' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'sigroute_describe',
      description:
        '一根信号的一跳速查：声明（方向/位宽/精确位置）、驱动源、负载、上级模块连接、层次路径、同网络别名。想快速搞清"这是什么、谁在驱动它"时优先用这个（比 trace 便宜得多）。',
      inputSchema: {
        type: 'object',
        properties: {
          signal: { type: 'string', description: '信号或端口名' },
          module: { type: 'string', description: '该名字所在或所在上下文的模块；名字不唯一必填（先 search 确认）' },
        },
        required: ['signal'],
        additionalProperties: false,
      },
    },
    {
      name: 'sigroute_trace',
      description:
        '追踪一根信号的上游/下游跨模块链路：经过哪些模块、在哪儿改名、位选/表达式/黑盒等不确定点，返回缩进链路树 + 链路摘要 + 位置（文件:行）。读 RTL 想回答"这根信号从哪来、到哪去、穿过谁"时用它。',
      inputSchema: {
        type: 'object',
        properties: {
          signal: { type: 'string', description: '信号或端口名' },
          module: { type: 'string', description: '起点模块（名字不唯一时必填）' },
          direction: { type: 'string', enum: ['up', 'down', 'both'], description: '上游 / 下游 / 双向，默认 both' },
          depth: { type: 'number', description: '最大跨模块层数，默认 12' },
          filter: { type: 'string', enum: ['all', 'cross', 'renamed'], description: 'all=全部；cross=只看跨模块（跳过模块内中间变量，省 token）；renamed=只看改名点' },
          limit: { type: 'number', description: '输出链路行数上限，默认 200（链路很长时会被截断并提示怎么收窄）' },
          graph: { type: 'boolean', description: '额外返回模块级拓扑（节点/边），默认 false' },
        },
        required: ['signal'],
        additionalProperties: false,
      },
    },
    {
      name: 'sigroute_aliases',
      description:
        '同一根物理网络的全部名字（改名反查）：它在别的模块里叫什么、什么方向、在哪一行、该模块被例化几次。跨模块顺链路读代码时最有用 —— 名字变了但线是同一根。',
      inputSchema: {
        type: 'object',
        properties: {
          signal: { type: 'string', description: '已知的某个名字' },
          module: { type: 'string', description: '该名字所在模块（不唯一时必填）' },
          limit: { type: 'number', description: '最多列出多少个名字，默认 20' },
        },
        required: ['signal'],
        additionalProperties: false,
      },
    },
    {
      name: 'sigroute_hierarchy',
      description:
        '该信号在层次树里的完整路径（形如 top.u_a.u_b.s_data）。同一模块被多处例化时列出全部候选 —— 写文档、定位实例、解释"这个信号到底属于哪个实例"时用。',
      inputSchema: {
        type: 'object',
        properties: {
          signal: { type: 'string', description: '信号或端口名' },
          module: { type: 'string', description: '起点模块（不唯一时必填）' },
          maxPaths: { type: 'number', description: '最多返回几条路径，默认 12' },
        },
        required: ['signal'],
        additionalProperties: false,
      },
    },
    {
      name: 'sigroute_module',
      description:
        '模块速查：端口表（方向/位宽/行号）、子模块例化（含未索引的黑盒）、被哪些模块在何处例化、是否只有声明。读一个没见过的模块先调它，比读整个文件省 token。',
      inputSchema: {
        type: 'object',
        properties: { module: { type: 'string', description: '模块名' } },
        required: ['module'],
        additionalProperties: false,
      },
    },
    {
      name: 'sigroute_context',
      description:
        '给一个文件 + 行号（1 起），返回"一页纸"上下文：所在模块、该处光标下的信号（声明/驱动源/负载/别名）、附近 ±60 行的声明清单。读陌生代码、或从 grep/报错信息定位到某一行时的第一入口。',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '文件路径（相对工程根或绝对）' },
          line: { type: 'number', description: '行号（1 起）' },
          column: { type: 'number', description: '列号（0 起，可选）' },
        },
        required: ['file', 'line'],
        additionalProperties: false,
      },
    },
  ];

  async function call(name, args = {}, opts = {}) {
    const op = OPS[name.replace(/^sigroute_/, '')];
    if (!op) throw new Error(`未知操作: ${name}`);
    const sync = await syncToDisk().catch(() => ({ rebuilt: false, changed: 0 }));
    const res = await op(args ?? {});
    if (opts.json) return { ...res, data: { ...res.data, refreshed: sync } };
    return res;
  }

  return { root, call, ops: OPS, specs: SPECS, indexer, ensureIndex, syncToDisk };
}

// ---------------------------------------------------------------- 多工程注册表

/** 每个工具都多一个可选的 root：一个服务同时服务多个工程 */
const ROOT_PROP = {
  root: {
    type: 'string',
    description:
      '工程根目录。一个服务可以同时服务多个工程：用它指定本次查哪个（省略则用客户端声明的第一个工作区根）',
  },
};

/**
 * 多工程注册表。
 *
 * 为什么需要：MCP 服务是长驻进程，配置里写死一个 `--root` 就等于"只能服务一个工程" ——
 * 换工程要么改配置重启，要么干瞪眼（这是实测反馈里的第一条）。现在：
 *   - 默认根来自**客户端声明的 MCP roots**（见 tools/mcp.mjs）→ 跟随 IDE 打开的工作区；
 *   - 任何一次调用都可以带 `root=<工程根>` 临时切到别的工程；
 *   - 每个根一份独立索引（LRU 保留最近 4 个），切换工程不会反复重建。
 */
export function createToolRegistry(options = {}) {
  const CACHE_MAX = 4;
  const cache = new Map();
  const initial = [];
  if (options.root) initial.push(path.resolve(options.root));
  for (const r of options.roots ?? []) initial.push(path.resolve(r));
  let roots = [...new Set(initial)];
  let baseSpecs = null;

  const knownRoots = () => {
    const all = [...roots];
    for (const k of cache.keys()) if (!all.includes(k)) all.push(k);
    return all;
  };

  function toolsFor(root) {
    let t = cache.get(root);
    if (!t) {
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      t = createAiTools({ ...options, root });
    }
    cache.delete(root);
    cache.set(root, t);
    return t;
  }

  /** 客户端声明的工作区根（MCP roots）进来时调用 */
  function setRoots(list) {
    const next = [...new Set((list ?? []).filter(Boolean).map((r) => path.resolve(r)))];
    if (next.length > 0) roots = next;
    return [...roots];
  }

  /** 工具声明的清单（统一补上可选的 root 参数） */
  function specs() {
    if (!baseSpecs) {
      const fallback = roots[0] ?? options.fallbackRoot ?? process.cwd();
      baseSpecs = toolsFor(fallback).specs.map((s) => ({
        ...s,
        inputSchema: {
          ...s.inputSchema,
          properties: { ...(s.inputSchema.properties ?? {}), ...ROOT_PROP },
        },
      }));
    }
    return baseSpecs;
  }

  async function call(name, args = {}, opts = {}) {
    const asked = typeof args.root === 'string' && args.root.trim() !== '' ? args.root.trim() : null;
    let root;
    if (asked) {
      root = path.resolve(asked);
      if (!roots.includes(root)) roots.push(root);
    } else {
      root = roots[0] ?? options.fallbackRoot ?? process.cwd();
    }
    const rest = { ...args };
    delete rest.root;
    const res = await toolsFor(root).call(name, rest, opts);
    if (/^(sigroute_)?index$/.test(String(name))) {
      const all = knownRoots();
      res.data.knownRoots = all;
      res.data.root = root;
      res.text += `\n  已索引的工程根(${all.length}): ${all.join(', ')}`;
      res.text += `\n  换工程不用重启服务：任何工具传 root=<工程根> 即可（省略则用第一个）。`;
    }
    return res;
  }

  return {
    call,
    specs,
    setRoots,
    knownRoots,
    get roots() {
      return [...roots];
    },
  };
}

// ---------------------------------------------------------------- 命令行

const USAGE = `SigRoute AI 接口（行号 1 起，路径相对工程根）

用法：node tools/ai.mjs <操作> [参数] [--root <工程目录>] [--json]

操作：
  index                                 建索引，报规模与顶层候选
  search <名字或通配>                    搜索模块/端口/信号（支持 * ?）
  describe <信号> [--module <模块>]      一跳速查：声明/驱动源/负载/别名/层次路径
  trace <信号> [--module <模块>] [--direction up|down|both] [--depth N]
               [--filter all|cross|renamed] [--graph]    跨模块链路树
  aliases <信号> [--module <模块>]       同一物理网络的其它名字（改名反查）
  hierarchy <信号> [--module <模块>]     完整层次路径 top.u_a.u_b.sig
  module <模块名>                        端口表 / 子例化 / 被例化位置
  context --file <文件> --line <行>      某一行的"一页纸"上下文

全局参数：
  --root <目录>     工程根目录（默认当前目录，或环境变量 SIGROUTE_ROOT）
  --scope <子目录>   只索引该子目录
  --defines a,b     额外认为已定义的宏
  --undefines a,b   强制视为未定义的宏
  --no-ifdef        不裁剪 \`ifdef 分支（全部分支都索引）
  --json            输出 JSON（默认输出给 AI 读的紧凑文本）

例：
  node tools/ai.mjs trace s_data --module data_path --filter cross
  node tools/ai.mjs context --file src/data_path.v --line 245
`;

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--no-ifdef') flags.honorIfdef = false;
    else if (a === '--graph') flags.graph = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[key] = val;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseArgv(process.argv.slice(2));
  if (positional.length === 0 || flags.help) {
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return;
  }
  const [op, ...rest] = positional;
  const tools = createAiTools({
    root: flags.root ?? process.env.SIGROUTE_ROOT,
    scope: flags.scope,
    honorIfdef: flags.honorIfdef,
    defines: typeof flags.defines === 'string' ? flags.defines.split(',').map((s) => s.trim()).filter(Boolean) : [],
    undefines: typeof flags.undefines === 'string' ? flags.undefines.split(',').map((s) => s.trim()).filter(Boolean) : [],
  });

  const args = {};
  if (rest[0] !== undefined) {
    if (op === 'module') args.module = rest[0];
    else args.signal = rest[0];
  }
  for (const key of ['module', 'direction', 'depth', 'filter', 'limit', 'maxPaths', 'file', 'line', 'column', 'query', 'kind', 'scope']) {
    if (flags[key] !== undefined && flags[key] !== true) args[key] = flags[key];
  }
  if (op === 'search' && rest[0] !== undefined) args.query = rest[0];
  if (flags.graph) args.graph = true;
  if (flags.force) args.force = true;

  try {
    const res = await tools.call(op, args, { json: Boolean(flags.json) });
    // eslint-disable-next-line no-console
    console.log(flags.json ? JSON.stringify(res.data, null, 2) : res.text);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`错误: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
