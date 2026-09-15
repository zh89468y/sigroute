/**
 * Verilog / SystemVerilog 结构化解析器
 *
 * 目标：提取"连接拓扑"所需的最小信息集合
 *   - 模块的端口列表（方向 / 位宽 / 顺序）
 *   - 模块内的每一次例化及其端口连接
 *   - assign / always 的驱动关系
 *
 * 明确不做的事（避免陷入无底洞）：
 *   - 宏体展开、参数值传播、位宽推导、generate 展开、位级切片追踪
 *   这些交给未来的外部 elaborator 后端（Vivado / Verilator）。
 *   本解析器的输出会显式标注"不确定"，而不是编造精确结果。
 */

import { KEYWORDS, lex, isIdent, isPlainIdent, isPunct, TokType } from './lexer';
import type { Token } from './lexer';
import { createOffsetMapper, inlineIncludes, lineStarts, remapModulePositions } from './inline';
import type { IncludeResolveResult } from './inline';
import type {
  AlwaysBlock,
  AssignStmt,
  ConnKind,
  Connection,
  Instance,
  ModuleDecl,
  PortDecl,
  PortDirection,
  ProcStatement,
} from './types';

const DIRECTIONS = new Set(['input', 'output', 'inout']);

/** 声明关键字（会引导一个声明语句） */
const DECL_KEYWORDS = new Set([
  'wire', 'reg', 'logic', 'bit', 'byte', 'shortint', 'int', 'longint', 'integer',
  'real', 'realtime', 'time', 'shortreal', 'tri', 'tri0', 'tri1', 'triand', 'trior',
  'trireg', 'wand', 'wor', 'supply0', 'supply1', 'uwire',
  'parameter', 'localparam', 'genvar', 'event', 'typedef',
]);

/** 会被整体跳过的块 */
const SKIP_BLOCKS: Record<string, string> = {
  function: 'endfunction',
  task: 'endtask',
  specify: 'endspecify',
  table: 'endtable',
  class: 'endclass',
  covergroup: 'endgroup',
  property: 'endproperty',
  sequence: 'endsequence',
  clocking: 'endclocking',
  primitive: 'endprimitive',
};

const PROC_KEYWORDS = new Set(['always', 'always_comb', 'always_ff', 'always_latch', 'initial', 'final']);

export interface ParseOptions {
  defines: Set<string>;
  honorIfdef: boolean;
  maxInstancesPerModule: number;
  /**
   * `include 内联解析器。提供后，形如 `include "xx.vh"` 的内容会被原地拼进文本，
   * 这样"端口列表/模块体片段写在 .vh 里"的工程也能解析完整。
   * 不提供时行为与以前完全一致（零风险路径）。
   */
  includeResolver?: (name: string, fromFile: string) => IncludeResolveResult | null;
  /** 关闭内联（用户显式配置） */
  inlineIncludes?: boolean;
}

export interface ParseFileResult {
  modules: ModuleDecl[];
  warnings: string[];
  /** 实际被内联的 include 数量（用于统计/提示） */
  inlined?: number;
  /** 未能内联的 include（名称 + 原因） */
  skippedIncludes?: string[];
}

/** 声明为非信号对象的类型（参数、循环变量、genvar 等，参与运算但不是网络） */
const NON_SIGNAL_TYPES = new Set([
  'integer', 'genvar', 'real', 'realtime', 'time', 'shortreal', 'event',
]);

export function parseFile(text: string, file: string, opts: ParseOptions): ParseFileResult {
  // ---- `include 内联（可选）----
  // 只有在真的内联了内容时才走位置重映射，未内联的文件路径与以前完全一致。
  let source = text;
  let mapOffset: ((o: number) => number) | null = null;
  let starts: number[] | null = null;
  let inlined = 0;
  let skippedIncludes: string[] = [];

  if (opts.includeResolver && opts.inlineIncludes !== false) {
    const res = inlineIncludes(text, file, { resolve: opts.includeResolver });
    inlined = res.count;
    skippedIncludes = res.skipped;
    if (res.count > 0) {
      source = res.text;
      mapOffset = createOffsetMapper(res.segments);
      starts = lineStarts(text);
    }
  }

  const lexed = lex(source, { defines: opts.defines, honorIfdef: opts.honorIfdef });
  const toks = lexed.tokens.filter((t) => !t.inactive);
  const warnings: string[] = [];
  const modules: ModuleDecl[] = [];

  const p = new Parser(source, file, toks, opts, warnings);
  p.run(modules);

  for (const mod of modules) sanitizeModule(mod);

  if (mapOffset && starts) {
    const mapper = mapOffset;
    const lineTable = starts;
    for (const mod of modules) remapModulePositions(mod, mapper, lineTable);
  }

  return { modules, warnings, inlined, skippedIncludes };
}

/**
 * 剔除"不是信号"的名字。
 *
 * 必要性：`assign o_data[i*8+7 : i*8] = s_data[i];` 这类代码里，
 * 朴素地收集标识符会把循环变量 i 也当成信号，导致追踪链上出现
 * 大量无意义的 "i" 节点，既噪音又让结果树爆炸。
 *
 * 判据：只有"端口"或"声明为 wire/reg/logic/tri"的名字才算信号。
 * 判断不出来的一律丢弃 —— 宁可漏掉可疑边，也不要制造假链路。
 */
export function sanitizeModule(mod: ModuleDecl): void {
  const portNames = new Set(mod.ports.map((p) => p.name));
  const isSignal = (n: string): boolean => {
    if (portNames.has(n)) return true;
    const s = mod.signals.get(n);
    return !!s && (s.kind === 'wire' || s.kind === 'reg' || s.kind === 'logic' || s.kind === 'tri');
  };
  // ---- 先补全"隐式网络" ----
  // Verilog 允许隐式 wire：出现在端口连接里的未声明标识符会自动成为网络。
  // 最典型的写法是顶层把 A 模块的输出直连 B 模块的输入，中间那根线不写 wire 声明
  //（例如 top.v 里 map_mod.o_frame 直连 data_path.i_frame 用的 s_frame）。
  //
  // 若不先补进符号表，下面的过滤会把它们当成噪音删掉，
  // 结果是 conn.primaryNet 变成 null —— 追踪在模块边界处直接断掉。
  const addImplicit = (name: string | null | undefined, offset?: number, line?: number): void => {
    if (!name || portNames.has(name) || mod.signals.has(name)) return;
    mod.signals.set(name, {
      msb: null,
      lsb: null,
      kind: 'wire',
      offset: offset ?? -1,
      line,
      implicit: true,
    });
  };

  for (const inst of mod.instances) {
    for (const c of inst.connections) {
      // 只信任"纯网络名"连接：表达式/拼接里的标识符可能是循环变量或函数名，不能当信号
      if (c.kind === 'net') addImplicit(c.primaryNet, c.netOffset ?? undefined, c.line);
    }
  }
  for (const a of mod.assigns) {
    // assign 的左值必然是网络
    addImplicit(a.lhsNets[0], a.lhsOffsets[0] >= 0 ? a.lhsOffsets[0] : undefined, a.line);
  }

  const clean = (arr: string[]): string[] => arr.filter(isSignal);

  /** 同时过滤名字与偏移，保持两者一一对应 */
  const cleanRefs = (names: string[], offsets: number[]): { names: string[]; offsets: number[] } => {
    const n2: string[] = [];
    const o2: number[] = [];
    for (let i = 0; i < names.length; i++) {
      if (isSignal(names[i])) {
        n2.push(names[i]);
        o2.push(offsets[i] ?? -1);
      }
    }
    return { names: n2, offsets: o2 };
  };

  for (const a of mod.assigns) {
    const l = cleanRefs(a.lhsNets, a.lhsOffsets);
    a.lhsNets = l.names;
    a.lhsOffsets = l.offsets;
    const r = cleanRefs(a.rhsNets, a.rhsOffsets);
    a.rhsNets = r.names;
    a.rhsOffsets = r.offsets;
  }
  for (const ab of mod.alwaysBlocks) {
    ab.lhsNets = clean(ab.lhsNets);
    ab.readNets = clean(ab.readNets);
    for (const st of ab.statements) {
      const l = cleanRefs(st.lhs, st.lhsOffsets);
      st.lhs = l.names;
      st.lhsOffsets = l.offsets;
      const r = cleanRefs(st.reads, st.readOffsets);
      st.reads = r.names;
      st.readOffsets = r.offsets;
    }
  }
  for (const inst of mod.instances) {
    for (const c of inst.connections) {
      c.nets = clean(c.nets);
      if (c.primaryNet !== null && !isSignal(c.primaryNet)) {
        c.primaryNet = c.nets[0] ?? null;
      }
    }
  }
}

/** 单独暴露给索引用：先收集宏定义（第一遍扫描） */
export function collectMacros(text: string, defines: Set<string>): { includes: string[] } {
  const lexed = lex(text, { defines, honorIfdef: false });
  return { includes: lexed.includes };
}

class Parser {
  private i = 0;
  private readonly text: string;
  private readonly file: string;
  private readonly toks: Token[];
  private readonly opts: ParseOptions;
  private readonly warnings: string[];
  /** generate for 循环的层次名栈：把实例名还原成 `label[i].u_x` */
  private genStack: { label: string; loopVar: string; depth: number }[] = [];
  /** 刚扫过 `for (...)`，等它的 `begin : label` */
  private genPendingFor: string | null = null;
  /** generate 区域内的 begin/end 嵌套深度 */
  private genBeginDepth = 0;

  constructor(
    text: string,
    file: string,
    toks: Token[],
    opts: ParseOptions,
    warnings: string[],
  ) {
    this.text = text;
    this.file = file;
    this.toks = toks;
    this.opts = opts;
    this.warnings = warnings;
  }

  // ---------------------------------------------------------------- 基础工具

  private get n(): number {
    return this.toks.length;
  }

  private at(k = 0): Token | undefined {
    return this.toks[this.i + k];
  }

  private textOf(from: number, to: number): string {
    if (from < 0 || to < 0 || from >= this.n || to >= this.n || to < from) return '';
    return this.text.slice(this.toks[from].start, this.toks[to].end).trim();
  }

  /**
   * 跳过综合属性 (* ... *)。
   * 这在 Xilinx 工程里无处不在（(* mark_debug = "true" *) / (* keep = "true" *)），
   * 属性内部的名字会被误当成端口/信号名，必须整体跳过。
   * 若 k 处不是属性，原样返回 k。
   */
  private skipAttr(k: number): number {
    if (k < 0 || k >= this.n) return k;
    if (!isPunct(this.toks[k], '(') || !isPunct(this.toks[k + 1], '*')) return k;
    let j = k + 2;
    while (j < this.n - 1) {
      if (isPunct(this.toks[j], '*') && isPunct(this.toks[j + 1], ')')) return j + 2;
      j++;
    }
    return k;
  }

  /** 找到与 openIdx 处括号配对的索引 */
  private findMatch(openIdx: number, open: string, close: string): number {
    if (!isPunct(this.toks[openIdx], open)) return -1;
    let depth = 0;
    for (let k = openIdx; k < this.n; k++) {
      const t = this.toks[k];
      if (t.type !== TokType.Punct) continue;
      if (t.value === open) depth++;
      else if (t.value === close) {
        depth--;
        if (depth === 0) return k;
      }
    }
    return -1;
  }

  /** 找 top-level（括号深度 0）的下一个指定符号 */
  private findTopLevel(from: number, symbol: string, stopAt: string | null = null): number {
    let depth = 0;
    for (let k = from; k < this.n; k++) {
      const t = this.toks[k];
      if (t.type === TokType.Punct) {
        if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
        else if (t.value === ')' || t.value === ']' || t.value === '}') depth = Math.max(0, depth - 1);
        else if (depth === 0 && t.value === symbol) return k;
        else if (depth === 0 && stopAt && t.value === stopAt) return -1;
      } else if (depth === 0 && stopAt && t.value === stopAt) {
        return -1;
      }
    }
    return -1;
  }

  /** 读取 [msb:lsb] 范围，返回下标区间（不含括号） */
  private readRange(): { msb: string | null; lsb: string | null } {
    if (!isPunct(this.at(), '[')) return { msb: null, lsb: null };
    const close = this.findMatch(this.i, '[', ']');
    if (close < 0) return { msb: null, lsb: null };
    const parts: string[] = [];
    let cur = '';
    for (let k = this.i + 1; k < close; k++) {
      const t = this.toks[k];
      // 只在第一个冒号处切分（多维数组少见，这里贪心处理）。
      // 注意这里必须是 `!cur.includes(':')` —— 早先误写成 `!cur.includes('')`（恒为 false），
      // 结果 [7:0] 永远切不开，所有端口的 msb/lsb 都变成 "7:0" / null，位宽恒为 null。
      if (t.type === TokType.Punct && t.value === ':' && !cur.includes(':')) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += t.value;
    }
    parts.push(cur);
    this.i = close + 1;
    return { msb: parts[0]?.trim() ?? null, lsb: parts[1]?.trim() ?? null };
  }

  /** 收集标识符及其在文件中的字符偏移（偏移用于"点击后精确选中信号名"） */
  private collectIdentRefs(
    from: number,
    to: number,
    skip = new Set<string>(),
  ): { name: string; offset: number; line: number }[] {
    const out: { name: string; offset: number; line: number }[] = [];
    for (let k = from; k <= to && k < this.n; k++) {
      const t = this.toks[k];
      if (t.type === TokType.Ident && !KEYWORDS.has(t.value) && !skip.has(t.value)) {
        out.push({ name: t.value, offset: t.start, line: t.line });
      }
    }
    return out;
  }

  private collectIdents(from: number, to: number, skip = new Set<string>()): string[] {
    return this.collectIdentRefs(from, to, skip).map((r) => r.name);
  }

  // ---------------------------------------------------------------- 主流程

  run(out: ModuleDecl[]): void {
    while (this.i < this.n) {
      const t = this.at();
      if (!t) break;
      if (isIdent(t, 'module') || isIdent(t, 'macromodule')) {
        const mod = this.parseModule();
        if (mod) out.push(mod);
        continue;
      }
      if (isIdent(t, 'endmodule')) {
        // 游离的 endmodule，跳过
        this.i++;
        continue;
      }
      this.i++;
    }
  }

  private parseModule(): ModuleDecl | null {
    const startIdx = this.i;
    const headerLine = this.at()!.line;
    this.i++; // module

    // module automatic / module static
    while (isIdent(this.at(), 'automatic') || isIdent(this.at(), 'static')) this.i++;

    const nameTok = this.at();
    if (!isPlainIdent(nameTok)) {
      this.warnings.push(`第 ${headerLine + 1} 行：module 缺少合法模块名`);
      return null;
    }
    const name = nameTok.value;
    this.i++;

    // 参数列表 #( ... )
    if (isPunct(this.at(), '#')) {
      if (isPunct(this.at(1), '(')) {
        const close = this.findMatch(this.i + 1, '(', ')');
        if (close > 0) this.i = close + 1;
        else this.warnings.push(`模块 ${name}：参数列表括号不匹配`);
      } else {
        this.i++;
      }
    }

    const mod: ModuleDecl = {
      name,
      file: this.file,
      ports: [],
      portOrder: [],
      instances: [],
      assigns: [],
      alwaysBlocks: [],
      signals: new Map(),
      start: this.toks[startIdx].start,
      end: this.text.length,
      headerLine,
      endLine: headerLine,
      ansi: false,
      warnings: [],
    };

    // 端口列表
    if (isPunct(this.at(), '(')) {
      const close = this.findMatch(this.i, '(', ')');
      if (close < 0) {
        mod.warnings.push('端口列表括号不匹配，模块解析可能不完整');
        this.i++;
      } else {
        const res = this.parsePortList(this.i + 1, close - 1);
        mod.ports = res.ports;
        mod.ansi = res.ansi;
        this.i = close + 1;
      }
    }

    // 期望 ';'
    if (isPunct(this.at(), ';')) this.i++;
    else {
      // SystemVerilog 允许 `module foo;` 前有属性，这里宽松处理
    }

    mod.portOrder = mod.ports.map((p) => p.name);

    // 模块体
    this.parseModuleBody(mod);

    mod.endLine = this.toks[Math.max(0, this.i - 1)]?.line ?? mod.headerLine;
    mod.end = this.toks[Math.min(this.n - 1, this.i)]?.start ?? this.text.length;

    if (mod.instances.length > this.opts.maxInstancesPerModule) {
      mod.warnings.push(
        `模块 ${name} 解析出 ${mod.instances.length} 个例化，超过上限 ${this.opts.maxInstancesPerModule}，可能存在解析异常`,
      );
      mod.instances = mod.instances.slice(0, this.opts.maxInstancesPerModule);
    }

    return mod;
  }

  // ---------------------------------------------------------------- 端口列表

  private parsePortList(from: number, to: number): { ports: PortDecl[]; ansi: boolean } {
    const ports: PortDecl[] = [];
    let ansi = false;
    let curDir: PortDirection | null = null;
    let curMsb: string | null = null;
    let curLsb: string | null = null;
    let curReg = false;
    let idx = 0;

    let k = from;
    while (k <= to && k < this.n) {
      const t = this.toks[k];

      // 综合属性 (* ... *) 整体跳过
      if (isPunct(t, '(')) {
        const afterAttr = this.skipAttr(k);
        if (afterAttr > k) {
          k = afterAttr;
          continue;
        }
      }

      if (isPunct(t, ',') || isPunct(t, ';')) {
        k++;
        continue;
      }

      if (t.type === TokType.Ident && DIRECTIONS.has(t.value)) {
        ansi = true;
        curDir = t.value as PortDirection;
        curMsb = null;
        curLsb = null;
        curReg = false;
        k++;
        // 类型修饰
        while (k <= to) {
          const tt = this.toks[k];
          if (tt.type !== TokType.Ident) break;
          if (tt.value === 'reg' || tt.value === 'logic' || tt.value === 'bit') {
            curReg = true;
            k++;
          } else if (tt.value === 'wire' || tt.value === 'signed' || tt.value === 'unsigned' || tt.value === 'var') {
            k++;
          } else break;
        }
        // 范围
        if (isPunct(this.toks[k], '[')) {
          const save = this.i;
          this.i = k;
          const r = this.readRange();
          curMsb = r.msb;
          curLsb = r.lsb;
          k = this.i;
          this.i = save;
        }
        continue;
      }

      if (isPunct(t, '[')) {
        const save = this.i;
        this.i = k;
        const r = this.readRange();
        curMsb = r.msb;
        curLsb = r.lsb;
        k = this.i;
        this.i = save;
        continue;
      }

      if (t.type === TokType.Ident && !KEYWORDS.has(t.value)) {
        const pname = t.value;
        const line = t.line;
        k++;
        // 跳过数组维度 / 默认值
        while (k <= to) {
          if (isPunct(this.toks[k], '[')) {
            const c = this.findMatch(k, '[', ']');
            k = c < 0 ? k + 1 : c + 1;
          } else if (isPunct(this.toks[k], '=')) {
            const c = this.findTopLevel(k + 1, ',');
            k = c < 0 ? to + 1 : c;
          } else break;
        }
        ports.push({
          name: pname,
          direction: curDir,
          msb: curMsb,
          lsb: curLsb,
          width: calcWidth(curMsb, curLsb),
          isReg: curReg,
          index: idx++,
          line,
          offset: t.start,
        });
        continue;
      }

      k++;
    }

    return { ports, ansi };
  }

  // ---------------------------------------------------------------- 模块体

  private parseModuleBody(mod: ModuleDecl): void {
    let genDepth = 0;
    let guard = 0;
    this.genStack = [];
    this.genPendingFor = null;
    this.genBeginDepth = 0;

    while (this.i < this.n && guard++ < 5_000_000) {
      const t = this.at()!;

      if (isIdent(t, 'endmodule')) {
        this.i++;
        return;
      }

      // 综合属性 (* ... *) 整体跳过
      if (isPunct(t, '(')) {
        const afterAttr = this.skipAttr(this.i);
        if (afterAttr > this.i) {
          this.i = afterAttr;
          continue;
        }
      }

      // 整体跳过的块
      if (t.type === TokType.Ident && SKIP_BLOCKS[t.value]) {
        this.skipToKeyword(t.value, SKIP_BLOCKS[t.value]);
        continue;
      }

      // 过程块：整体跳过，并提取驱动信息
      if (t.type === TokType.Ident && PROC_KEYWORDS.has(t.value)) {
        this.parseProcBlock(mod);
        continue;
      }

      if (isIdent(t, 'assign')) {
        this.parseAssign(mod);
        continue;
      }

      if (isIdent(t, 'generate')) {
        genDepth++;
        this.i++;
        continue;
      }
      if (isIdent(t, 'endgenerate')) {
        genDepth = Math.max(0, genDepth - 1);
        this.i++;
        continue;
      }

      // generate 里的 for 循环：记下循环变量，配合后面的 `begin : label`
      // 把实例名还原成 `label[i].u_x` 这种真实层次名（比单纯的 "generate" 标记有用得多）
      if (isIdent(t, 'for') && genDepth > 0) {
        if (isPunct(this.at(1), '(')) {
          const close = this.findMatch(this.i + 1, '(', ')');
          if (close > 0) {
            const vars = this.collectIdents(this.i + 2, close - 1);
            this.genPendingFor = vars[0] ?? 'i';
            this.i = close + 1;
            continue;
          }
        }
        this.i++;
        continue;
      }

      if (isIdent(t, 'begin')) {
        this.genBeginDepth++;
        this.i++;
        if (this.genPendingFor !== null) {
          if (isPunct(this.at(), ':')) {
            const lb = this.at(1);
            if (lb && lb.type === TokType.Ident) {
              this.genStack.push({
                label: lb.value,
                loopVar: this.genPendingFor,
                depth: this.genBeginDepth,
              });
              this.i += 2;
            }
          }
          this.genPendingFor = null;
        }
        continue;
      }
      if (isIdent(t, 'end')) {
        this.genBeginDepth = Math.max(0, this.genBeginDepth - 1);
        while (this.genStack.length > 0 && this.genStack[this.genStack.length - 1].depth > this.genBeginDepth) {
          this.genStack.pop();
        }
        this.i++;
        continue;
      }

      // 声明
      if (t.type === TokType.Ident && (DIRECTIONS.has(t.value) || DECL_KEYWORDS.has(t.value))) {
        this.parseDecl(mod);
        continue;
      }

      // 例化
      if (isPlainIdent(t)) {
        if (this.tryParseInstance(mod, genDepth > 0)) continue;
      }

      this.i++;
    }
  }

  /**
   * 跳过 function / task / class 这类块（从起点关键字一直到配对结束关键字）。
   *
   * 这里踩过一个很隐蔽的坑：原来把**起点这个关键字自己**也算进了嵌套深度，
   * 于是"跳过 task"永远要多吞一层 —— 实际表现是**函数/任务之后的整个模块体被吃掉**
   * （例化、assign 全没了，看统计就像"这个模块是空的"）。
   * 真实案例：某 testbench 里第一个 task 之后 460 行的 DUT 例化全部消失。
   *
   * 现在：先跳过起点关键字，再按"同名关键字配对"计数；
   * 结束关键字缺失时**不越过模块边界**，免得把一个模块的错拖累到整个文件。
   */
  private skipToKeyword(startKeyword: string, endKeyword: string): void {
    let depth = 0;
    this.i++; // 跳过起点关键字本身
    while (this.i < this.n) {
      const t = this.at()!;
      if (t.type === TokType.Ident) {
        if (t.value === startKeyword) depth++;
        else if (t.value === endKeyword) {
          if (depth === 0) {
            this.i++;
            return;
          }
          depth--;
        } else if (depth === 0 && t.value === 'endmodule') {
          return; // 收尾关键字缺失：停在模块边界，交给外层正常收尾
        }
      }
      this.i++;
    }
  }

  /** 解析声明语句：wire/reg/input/... 支持多个名字 */
  private parseDecl(mod: ModuleDecl): void {
    // 声明前的属性
    for (;;) {
      const afterAttr = this.skipAttr(this.i);
      if (afterAttr === this.i) break;
      this.i = afterAttr;
    }

    let dir: PortDirection | null = null;
    let isReg = false;
    let isParam = false;
    let isNonSignal = false;

    const head = this.at();
    if (head && DIRECTION_SET.has(head.value)) {
      dir = head.value as PortDirection;
      this.i++;
    }

    while (this.i < this.n) {
      const t = this.at()!;
      if (t.type !== TokType.Ident) break;
      if (t.value === 'signed' || t.value === 'unsigned') {
        this.i++;
        continue;
      }
      if (t.value === 'reg' || t.value === 'logic' || t.value === 'bit') {
        isReg = true;
        this.i++;
        continue;
      }
      if (t.value === 'wire' || t.value === 'var' || t.value === 'tri') {
        this.i++;
        continue;
      }
      if (t.value === 'parameter' || t.value === 'localparam') {
        isParam = true;
        this.i++;
        continue;
      }
      if (NON_SIGNAL_TYPES.has(t.value)) {
        isNonSignal = true;
        this.i++;
        continue;
      }
      break;
    }

    let msb: string | null = null;
    let lsb: string | null = null;
    if (isPunct(this.at(), '[')) {
      const r = this.readRange();
      msb = r.msb;
      lsb = r.lsb;
    } else if (isPunct(this.at(), '#')) {
      // parameter #(...) 形式，跳过
      if (isPunct(this.at(1), '(')) {
        const c = this.findMatch(this.i + 1, '(', ')');
        if (c > 0) this.i = c + 1;
      }
    }

    // 名字列表
    let guard = 0;
    /** 最近声明的名字；随后若遇到 `=`，说明这是"声明即赋值" */
    let lastDecl: { name: string; offset: number; line: number } | null = null;
    while (this.i < this.n && guard++ < 100_000) {
      const t = this.at()!;
      if (isPunct(t, ';')) {
        this.i++;
        return;
      }
      if (isPunct(t, ',')) {
        this.i++;
        continue;
      }
      if (isPunct(t, '=')) {
        // 「声明即赋值」：`wire [7:0] x = expr;`、`output reg y = 0;`
        // 语义等价于 `assign x = expr;`。以前这里只是跳过初值，
        // 于是这类信号在下游溯源里"根本没被谁读取"、上游也"找不到驱动源"。
        this.i++;
        const rhsStart = this.i;
        const end = this.skipInitializer();
        const decl = lastDecl;
        if (decl) {
          const refs = this.collectIdentRefs(rhsStart, end - 1);
          mod.assigns.push({
            lhsText: decl.name,
            lhsNets: [decl.name],
            lhsOffsets: [decl.offset],
            rhsNets: refs.map((r) => r.name),
            rhsOffsets: refs.map((r) => r.offset),
            line: decl.line,
            inline: true,
          });
        }
        lastDecl = null;
        continue;
      }
      if (t.type === TokType.Ident && !KEYWORDS.has(t.value)) {
        const sname = t.value;
        this.i++;
        while (isPunct(this.at(), '[')) {
          const c = this.findMatch(this.i, '[', ']');
          this.i = c < 0 ? this.i + 1 : c + 1;
        }
        // 注意 line 必须一起记：内部信号的"声明在哪一行"是 Hover / 跳转 / AI 归纳位置的核心，
        // 只记 offset 会让下游退回模块头（实测：声明在 116 行的信号被报成模块头 :4）。
        if (isParam) {
          mod.signals.set(sname, { msb, lsb, kind: 'param', offset: t.start, line: t.line });
        } else if (isNonSignal) {
          mod.signals.set(sname, { msb, lsb, kind: 'other', offset: t.start, line: t.line });
        } else if (dir) {
          const p = mod.ports.find((pp) => pp.name === sname);
          if (p) {
            if (!p.direction) p.direction = dir;
            if (p.msb === null && msb !== null) {
              p.msb = msb;
              p.lsb = lsb;
              p.width = calcWidth(msb, lsb);
            }
            if (isReg) p.isReg = true;
          } else {
            // 端口列表之外的方向声明（可能来自端口列表已存在的重声明），忽略
          }
        } else {
          mod.signals.set(sname, { msb, lsb, kind: isReg ? 'reg' : 'wire', offset: t.start, line: t.line });
        }
        // 记住这个名字：紧接着的 `=` 是它的初值（parameter / 非信号类型不参与数据流）
        lastDecl = isParam || isNonSignal ? null : { name: sname, offset: t.start, line: t.line };
        continue;
      }
      // 其他 token（如属性、注释残留）
      if (isPunct(t, '(') || isPunct(t, '{')) {
        const c = this.findMatch(this.i, t.value, t.value === '(' ? ')' : '}');
        this.i = c < 0 ? this.i + 1 : c + 1;
        continue;
      }
      this.i++;
    }
  }

  /** 跳过声明的初值表达式；返回终止符（`,` 或 `;`）所在下标，便于回取初值区间 */
  private skipInitializer(): number {
    let depth = 0;
    while (this.i < this.n) {
      const t = this.at()!;
      if (t.type === TokType.Punct) {
        if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
        else if (t.value === ')' || t.value === ']' || t.value === '}') {
          if (depth === 0) return this.i;
          depth--;
        } else if (depth === 0 && (t.value === ',' || t.value === ';')) return this.i;
      }
      this.i++;
    }
    return this.i;
  }

  // ---------------------------------------------------------------- assign

  private parseAssign(mod: ModuleDecl): void {
    const line = this.at()!.line;
    this.i++; // assign
    const eq = this.findTopLevel(this.i, '=', ';');
    if (eq < 0) {
      const semi = this.findTopLevel(this.i, ';');
      this.i = semi < 0 ? this.n : semi + 1;
      return;
    }
    // 左值只取主信号：`assign o_data[i*8+7:i*8] = ...` 的 lhs 是 o_data，不是 i
    const lhsRefs = this.collectIdentRefs(this.i, eq - 1);
    const lhsText = this.textOf(this.i, eq - 1);
    const semi = this.findTopLevel(eq + 1, ';');
    const rhsEnd = semi < 0 ? this.n - 1 : semi - 1;
    const rhsRefs = this.collectIdentRefs(eq + 1, rhsEnd);
    mod.assigns.push({
      lhsText,
      lhsNets: lhsRefs.length > 0 ? [lhsRefs[0].name] : [],
      lhsOffsets: lhsRefs.length > 0 ? [lhsRefs[0].offset] : [],
      rhsNets: rhsRefs.map((r) => r.name),
      rhsOffsets: rhsRefs.map((r) => r.offset),
      line,
    });
    this.i = semi < 0 ? this.n : semi + 1;
  }

  // ---------------------------------------------------------------- always / initial

  private parseProcBlock(mod: ModuleDecl): void {
    const line = this.at()!.line;
    const offset = this.at()!.start;
    this.i++; // always / initial ...

    const edgeNets: string[] = [];
    let isSequential = false;

    // 敏感列表
    if (isPunct(this.at(), '@')) {
      this.i++;
      if (isPunct(this.at(), '(')) {
        const close = this.findMatch(this.i, '(', ')');
        if (close > 0) {
          for (let k = this.i + 1; k < close; k++) {
            const t = this.toks[k];
            if (isIdent(t, 'posedge') || isIdent(t, 'negedge')) isSequential = true;
            if (t.type === TokType.Ident && !KEYWORDS.has(t.value)) edgeNets.push(t.value);
          }
          this.i = close + 1;
        } else {
          this.i++;
        }
      } else if (isPunct(this.at(), '*')) {
        this.i++;
      }
      // @(*) 形式
      if (isPunct(this.at(), '(') && isPunct(this.at(1), '*') && isPunct(this.at(2), ')')) {
        this.i += 3;
      }
    }

    // 块体范围
    const bodyStart = this.i;
    const bodyEnd = this.skipBlockReturningEnd(this.i);
    const statements = this.scanStatements(bodyStart, bodyEnd - 1);

    const lhsSet = new Set<string>();
    for (const st of statements) {
      for (const l of st.lhs) lhsSet.add(l);
    }

    // 兜底：块内出现过的所有标识符（覆盖 if/case 条件、下标索引里的读取），
    // 同时记下每个名字第一次出现的位置 —— 供"点过程块节点跳到该信号"使用
    const readRefs: { name: string; offset: number; line: number }[] = [];
    const readSet = new Set<string>();
    for (const r of this.collectIdentRefs(bodyStart, bodyEnd - 1)) {
      if (lhsSet.has(r.name)) continue;
      if (readSet.has(r.name)) continue;
      readSet.add(r.name);
      readRefs.push(r);
    }

    mod.alwaysBlocks.push({
      offset,
      edgeNets,
      lhsNets: [...lhsSet],
      statements,
      readNets: [...readSet],
      readRefs,
      line,
      isSequential,
    });
    this.i = bodyEnd;
  }

  /**
   * 语句级数据流扫描：识别 `lhs <= reads;` / `lhs = reads;`
   * 只在括号深度为 0 的位置识别赋值符，
   * 避免把 `if (a <= b)` 这类比较误判成赋值。
   */
  private scanStatements(from: number, to: number): ProcStatement[] {
    const out: ProcStatement[] = [];
    let depth = 0;
    let k = from;

    while (k <= to && k < this.n) {
      const t = this.toks[k];
      if (t.type !== TokType.Punct) {
        k++;
        continue;
      }
      if (t.value === '(' || t.value === '[' || t.value === '{') {
        depth++;
        k++;
        continue;
      }
      if (t.value === ')' || t.value === ']' || t.value === '}') {
        depth = Math.max(0, depth - 1);
        k++;
        continue;
      }
      if (depth === 0 && (t.value === '<=' || t.value === '=')) {
        const lhsRef = this.leftIdent(k - 1, from);
        if (lhsRef) {
          let end = k + 1;
          let d2 = 0;
          while (end <= to && end < this.n) {
            const tt = this.toks[end];
            if (tt.type === TokType.Punct) {
              if (tt.value === '(' || tt.value === '[' || tt.value === '{') d2++;
              else if (tt.value === ')' || tt.value === ']' || tt.value === '}') d2 = Math.max(0, d2 - 1);
              else if (d2 === 0 && tt.value === ';') break;
            }
            end++;
          }
          const readRefs = this
            .collectIdentRefs(k + 1, Math.min(end - 1, to))
            .filter((x) => x.name !== lhsRef.name);
          out.push({
            lhs: [lhsRef.name],
            lhsOffsets: [lhsRef.offset],
            reads: readRefs.map((r) => r.name),
            readOffsets: readRefs.map((r) => r.offset),
            line: t.line,
          });
          k = end + 1;
          continue;
        }
      }
      k++;
    }
    return out;
  }

  /** 从 idx 向左找到最近的标识符（跳过 ] ) 等尾部结构） */
  private leftIdent(idx: number, stopAt: number): { name: string; offset: number } | null {
    let j = idx;
    while (j >= stopAt) {
      const t = this.toks[j];
      if (t.type === TokType.Punct) {
        if (t.value === ']') {
          let d = 0;
          while (j >= stopAt) {
            if (this.toks[j].value === ']') d++;
            else if (this.toks[j].value === '[') {
              d--;
              if (d === 0) break;
            }
            j--;
          }
          j--;
          continue;
        }
        if (t.value === ')') {
          // 跳过整个括号组（例如函数调用），继续向左
          let d = 0;
          while (j >= stopAt) {
            if (this.toks[j].value === ')') d++;
            else if (this.toks[j].value === '(') {
              d--;
              if (d === 0) break;
            }
            j--;
          }
          j--;
          continue;
        }
        return null;
      }
      if (t.type === TokType.Ident) {
        return KEYWORDS.has(t.value) ? null : { name: t.value, offset: t.start };
      }
      return null;
    }
    return null;
  }

  /**
   * 扫描一条**完整语句**，返回它结束后的下标。
   *
   * 用途：`always` / `initial` 的块体、`else` 的分支等 —— 它们可以是
   *   - 单条赋值（跳到 `;`）
   *   - `begin … end` / `fork … join*`
   *   - `if (…) stmt [else stmt]`
   *   - `case / casex / casez … endcase`（可嵌套）
   *   - `for` / `while` / `repeat` / `forever`（循环头 + 一条语句）
   *   - 延时 / 事件控制（`#5`、`@(posedge clk)`）
   *
   * 曾经的 bug：这里只按"找到第一个 `;`"收尾。而真实 RTL 里极为常见的写法是
   *   always @(posedge clk)
   *     if (!rst_n) begin … end
   *     else if (wr_en) case (addr) … endcase
   * —— `case` 直接充当 else 分支的语句体，没有 begin/end 包裹。旧逻辑会把块体
   * 截断到**复位分支里的第一个分号**，于是整个写寄存器块都没被收集，块内信号
   * 全部报"未找到驱动源"（例如 `7'h28 : o_interpl_num <= i_reg_wr_data;`）。
   */
  private skipBlockReturningEnd(from: number): number {
    return this.skipStatement(from);
  }

  private skipStatement(from: number): number {
    let k = from;
    if (k >= this.n) return k;
    const t = this.toks[k];

    if (isPunct(t, ';')) return k + 1; // 空语句
    if (isPunct(t, '#')) return this.skipStatement(this.skipOne(k + 1)); // #5 stmt / #(expr) stmt
    if (isPunct(t, '@')) return this.skipStatement(this.skipOne(k + 1)); // @(posedge clk) stmt

    if (t.type === TokType.Ident) {
      const v = t.value;
      if (v === 'begin' || v === 'fork') return this.skipBeginEnd(k);
      if (v === 'case' || v === 'casex' || v === 'casez') return this.skipCaseEnd(k);
      if (v === 'else') return this.skipStatement(k + 1);
      if (v === 'if') {
        k = this.skipOne(k + 1); // 跳过 (cond)
        k = this.skipStatement(k); // then 分支
        if (isIdent(this.toks[k], 'else')) k = this.skipStatement(k + 1); // else 分支
        return k;
      }
      if (v === 'for' || v === 'while' || v === 'repeat') {
        k = this.skipOne(k + 1); // 跳过循环头
        return this.skipStatement(k);
      }
      if (v === 'forever') return this.skipStatement(k + 1);
      if (v === 'unique' || v === 'unique0' || v === 'priority') return this.skipStatement(k + 1);
    }

    // 普通语句（赋值 / 任务调用 / …）：跳到括号深度归零的第一个 `;`
    let depth = 0;
    while (k < this.n) {
      const tt = this.toks[k];
      if (tt.type === TokType.Punct) {
        if (tt.value === '(' || tt.value === '[' || tt.value === '{') depth++;
        else if (tt.value === ')' || tt.value === ']' || tt.value === '}') depth = Math.max(0, depth - 1);
        else if (depth === 0 && tt.value === ';') return k + 1;
      }
      k++;
    }
    return k;
  }

  /** 跳过 `( … )` 到配对括号之后；不是括号就只前进一个 token（`#5`、`@clk` 的取值部分） */
  private skipOne(k: number): number {
    if (isPunct(this.toks[k], '(')) {
      const close = this.findMatch(k, '(', ')');
      return close > 0 ? close + 1 : k + 1;
    }
    return k + 1;
  }

  /** 从 `begin` / `fork` 跳到配对的 `end` / `join*` 之后 */
  private skipBeginEnd(from: number): number {
    let depth = 0;
    for (let k = from; k < this.n; k++) {
      const t = this.toks[k];
      if (t.type !== TokType.Ident) continue;
      if (t.value === 'begin' || t.value === 'fork') depth++;
      else if (t.value === 'end' || t.value === 'join' || t.value === 'join_any' || t.value === 'join_none') {
        depth--;
        if (depth <= 0) return k + 1;
      }
    }
    return this.n;
  }

  /** 从 `case` / `casex` / `casez` 跳到配对的 `endcase` 之后（支持嵌套） */
  private skipCaseEnd(from: number): number {
    let depth = 0;
    for (let k = from; k < this.n; k++) {
      const t = this.toks[k];
      if (t.type !== TokType.Ident) continue;
      if (t.value === 'case' || t.value === 'casex' || t.value === 'casez') depth++;
      else if (t.value === 'endcase') {
        depth--;
        if (depth <= 0) return k + 1;
      }
    }
    return this.n;
  }

  /** 粗略提取块内的赋值左值 */
  private scanLhs(from: number, to: number): string[] {
    const out = new Set<string>();
    for (let k = from; k <= to && k < this.n; k++) {
      const t = this.toks[k];
      if (t.type !== TokType.Punct) continue;
      if (t.value !== '<=' && t.value !== '=') continue;
      // 向左找最近的 Ident
      let j = k - 1;
      // 跳过 ] ) 等尾部
      while (j >= from && this.toks[j].type === TokType.Punct) {
        if (this.toks[j].value === ']') {
          // 跳过一整个 []
          let d = 0;
          while (j >= from) {
            if (this.toks[j].value === ']') d++;
            else if (this.toks[j].value === '[') {
              d--;
              if (d === 0) break;
            }
            j--;
          }
          j--;
          continue;
        }
        break;
      }
      const cand = this.toks[j];
      if (cand && cand.type === TokType.Ident && !KEYWORDS.has(cand.value)) {
        out.add(cand.value);
      }
    }
    return [...out];
  }

  // ---------------------------------------------------------------- 例化

  /** generate for 层次前缀，例如 `gen_ch[ch].`；不在循环内时为空串 */
  private genPrefix(): string {
    if (this.genStack.length === 0) return '';
    return `${this.genStack.map((g) => `${g.label}[${g.loopVar}]`).join('.')}.`;
  }

  private tryParseInstance(mod: ModuleDecl, inGenerate: boolean): boolean {
    const typeTok = this.at()!;
    const startIdx = this.i;
    let j = this.i + 1;

    // 参数覆盖 #( ... )
    let paramsText: string | null = null;
    if (isPunct(this.toks[j], '#')) {
      if (!isPunct(this.toks[j + 1], '(')) return false;
      const close = this.findMatch(j + 1, '(', ')');
      if (close < 0) return false;
      paramsText = this.textOf(j + 2, close - 1);
      j = close + 1;
    }

    // 实例名
    const nameTok = this.toks[j];
    if (!isPlainIdent(nameTok)) return false;
    // 排除 `Type Name` 后面跟的不是 '(' 的情况
    if (!isPunct(this.toks[j + 1], '(')) return false;

    const openParen = j + 1;
    const closeParen = this.findMatch(openParen, '(', ')');
    if (closeParen < 0) return false;

    // 连接列表后必须是 ';' —— 这是最强的防误报校验
    const after = this.toks[closeParen + 1];
    if (!isPunct(after, ';')) return false;

    const connections = this.parseConnections(openParen + 1, closeParen - 1);

    const inst: Instance = {
      moduleType: typeTok.value,
      instanceName: this.genPrefix() + nameTok.value,
      connections,
      line: typeTok.line,
      start: typeTok.start,
      end: this.toks[closeParen].end,
      inGenerate,
      paramsText,
    };
    mod.instances.push(inst);

    this.i = closeParen + 2; // 跳过 ')' 和 ';'
    if (this.i <= startIdx) this.i = startIdx + 1; // 安全护栏
    return true;
  }

  private parseConnections(from: number, to: number): Connection[] {
    const out: Connection[] = [];
    let k = from;
    let posIndex = 0;
    let guard = 0;

    while (k <= to && k < this.n && guard++ < 100_000) {
      const t = this.toks[k];

      if (isPunct(t, ',')) {
        // 空连接（位置连接中的空洞）
        k++;
        continue;
      }

      // 命名连接 .port ( expr )
      if (isPunct(t, '.')) {
        const nameTok = this.toks[k + 1];
        if (!isPlainIdent(nameTok)) {
          k++;
          continue;
        }
        if (!isPunct(this.toks[k + 2], '(')) {
          // 可能是 .* 或残缺
          k += 2;
          continue;
        }
        const close = this.findMatch(k + 2, '(', ')');
        if (close < 0 || close > to + 1) {
          k += 2;
          continue;
        }
        out.push(this.makeConnection(nameTok.value, null, k + 3, close - 1));
        k = close + 1;
        continue;
      }

      // 位置连接：读到下一个顶层逗号
      if (k <= to) {
        let end = k;
        let depth = 0;
        while (end <= to) {
          const tt = this.toks[end];
          if (tt.type === TokType.Punct) {
            if (tt.value === '(' || tt.value === '[' || tt.value === '{') depth++;
            else if (tt.value === ')' || tt.value === ']' || tt.value === '}') depth = Math.max(0, depth - 1);
            else if (depth === 0 && tt.value === ',') break;
          }
          end++;
        }
        out.push(this.makeConnection(null, posIndex++, k, Math.min(end - 1, to)));
        k = end + 1;
        continue;
      }

      k++;
    }

    return out;
  }

  private makeConnection(
    port: string | null,
    portIndex: number | null,
    from: number,
    to: number,
  ): Connection {
    if (from > to) {
      return {
        port,
        portIndex,
        expr: '',
        nets: [],
        primaryNet: null,
        bitSelect: null,
        kind: 'unconnected',
        line: this.toks[from]?.line ?? 0,
        start: this.toks[Math.min(from, this.n - 1)]?.start ?? 0,
        end: this.toks[Math.min(from, this.n - 1)]?.start ?? 0,
        netOffset: null,
      };
    }

    const expr = this.textOf(from, to);
    const line = this.toks[from].line;
    const start = this.toks[from].start;
    const end = this.toks[to].end;

    const nets: string[] = [];
    let firstIdentIdx = -1;
    let hasOperator = false;
    let hasConcat = false;
    let allConstant = true;

    for (let k = from; k <= to; k++) {
      const t = this.toks[k];
      if (t.type === TokType.Ident && !KEYWORDS.has(t.value)) {
        if (firstIdentIdx < 0) firstIdentIdx = k;
        nets.push(t.value);
        allConstant = false;
      } else if (t.type === TokType.Number) {
        // 仍是常量
      } else if (t.type === TokType.Punct) {
        if (t.value === '{') hasConcat = true;
        else if (t.value === '[' || t.value === ']' || t.value === ':') {
          // 位选，不算运算符
        } else {
          hasOperator = true;
        }
      }
    }

    let kind: ConnKind;
    if (nets.length === 0 && allConstant) kind = 'constant';
    else if (hasConcat || hasOperator) kind = 'expression';
    else if (nets.length === 1) kind = 'net';
    else kind = 'expression';

    // 位选
    let bitSelect: string | null = null;
    if (firstIdentIdx >= 0 && isPunct(this.toks[firstIdentIdx + 1], '[')) {
      const close = this.findMatch(firstIdentIdx + 1, '[', ']');
      if (close > 0 && close <= to) bitSelect = this.textOf(firstIdentIdx + 1, close);
    }

    return {
      port,
      portIndex,
      expr,
      nets,
      primaryNet: nets[0] ?? null,
      bitSelect,
      kind,
      line,
      start,
      end,
      netOffset: firstIdentIdx >= 0 ? this.toks[firstIdentIdx].start : null,
    };
  }
}

const DIRECTION_SET = DIRECTIONS;

/** 计算位宽：只有当 msb/lsb 都是纯数字时才能算出 */
export function calcWidth(msb: string | null, lsb: string | null): number | null {
  if (msb === null || lsb === null) return null;
  const a = Number(msb);
  const b = Number(lsb);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (!/^\d+$/.test(msb.trim()) || !/^\d+$/.test(lsb.trim())) return null;
  return Math.abs(a - b) + 1;
}
