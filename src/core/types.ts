/**
 * SigRoute 核心数据模型
 * 设计原则：解析结果必须"可解释、可追溯"，任何不确定的地方都显式标注，
 * 而不是假装精确 —— 因为静态分析永远不可能 100% 还原 elaborated 网表。
 */

export type PortDirection = 'input' | 'output' | 'inout';

/** 端口声明 */
export interface PortDecl {
  name: string;
  direction: PortDirection | null;
  /** 范围原文，如 ["7", "0"] 或 ["WIDTH-1", "0"] */
  msb: string | null;
  lsb: string | null;
  /** 能静态算出位宽时给出数字，否则 null */
  width: number | null;
  isReg: boolean;
  /** 在端口列表中的序号（用于位置端口连接回填） */
  index: number;
  /** 声明所在行（0-based） */
  line: number;
  /** 端口名在文件中的字符偏移，用于跳转时精确选中 */
  offset: number;
  /**
   * 端口声明实际所在的文件。
   * 只在 `include 内联时可能与模块所在文件不同 —— 端口列表写在 .vh 里时，
   * 默认把跳转落在 `include 指令处（即模块文件内），此时本字段为 undefined。
   */
  file?: string;
}

/** 端口连接的种类 —— 这是判定信号流的关键 */
export type ConnKind =
  | 'net'         // 纯网络名，可能带位选：.i_data(s_data[7:0])
  | 'constant'    // 常量：.i_rst(1'd0)
  | 'expression'  // 表达式/拼接：.o(~a), .o({a,b})
  | 'unconnected';// 空连接：.touch_cs( )

/** 一次端口连接 */
export interface Connection {
  /** 命名连接时的端口名；位置连接时为 null */
  port: string | null;
  /** 位置连接时的序号 */
  portIndex: number | null;
  /** 连接表达式原文 */
  expr: string;
  /** 表达式中引用到的网络名（主信号在前） */
  nets: string[];
  /** 主信号名（nets[0]），表达式/常量时可能为 null */
  primaryNet: string | null;
  /** 位选原文，如 "[7:0]" */
  bitSelect: string | null;
  kind: ConnKind;
  line: number;
  /** 表达式在源文件中的字符区间 */
  start: number;
  end: number;
  /**
   * 主信号名在源文件中的字符偏移。
   * 与 start 的区别：连接写成 `~s_pll_lock[0]` 时 start 指向 `~`，
   * 而 netOffset 指向 s_pll_lock —— 跳转要高亮的是后者。
   */
  netOffset: number | null;
}

/** 例化 */
export interface Instance {
  /** 子模块类型名 */
  moduleType: string;
  instanceName: string;
  connections: Connection[];
  line: number;
  start: number;
  end: number;
  /** 是否位于 generate / ifdef 块内（标记不确定实例名） */
  inGenerate: boolean;
  /** 参数覆盖原文（仅记录，不做值传播） */
  paramsText: string | null;
}

/** 连续赋值 assign */
export interface AssignStmt {
  lhsText: string;
  lhsNets: string[];
  rhsNets: string[];
  /** 与 lhsNets 一一对应：每个左值在文件中的字符偏移 */
  lhsOffsets: number[];
  /** 与 rhsNets 一一对应：每个右值在文件中的字符偏移 */
  rhsOffsets: number[];
  line: number;
  /**
   * 来自"声明即赋值"：`wire [7:0] x = expr;` / `output reg y = 0;`
   * 语义上等价于 `assign x = expr;`，但原文里没有 assign 关键字 ——
   * 界面上要照实说成"声明处赋值"，不能写成 assign。
   */
  inline?: boolean;
}

/** 过程块内的一条赋值语句：`lhs <= ... reads ...;` */
export interface ProcStatement {
  /** 左值信号（可能多个，例如 a,b = c 的罕见写法） */
  lhs: string[];
  /** 右值中读取到的信号 */
  reads: string[];
  /** 与 lhs 一一对应的字符偏移 */
  lhsOffsets: number[];
  /** 与 reads 一一对应的字符偏移 */
  readOffsets: number[];
  line: number;
}

/**
 * 模块内的 always / initial 块。
 * 语句级信息是必要的：大量信号的"下游"其实只出现在过程块内部，
 * 只看端口连接会得出"无下游负载"的错误结论。
 */
export interface AlwaysBlock {
  /** 关键字（always / initial…）在文件中的字符偏移 */
  offset: number;
  /** posedge/negedge 敏感信号 */
  edgeNets: string[];
  /** 该块内被赋值的信号 */
  lhsNets: string[];
  /** 语句级数据流 */
  statements: ProcStatement[];
  /** 块内出现过的所有信号（含 if/case 条件），作为兜底 */
  readNets: string[];
  /**
   * 块内出现过的标识符及其位置（每个名字只记第一次）。
   *
   * 为什么需要：条件 / 索引里的读取（`if (s_ena)`、`mem[i]`）不会进入语句级数据流，
   * 只有名字没有位置。而"点过程块节点"要跳到并选中那个信号，就必须有真实偏移。
   */
  readRefs: { name: string; offset: number; line: number }[];
  line: number;
  isSequential: boolean;
}

/** 模块声明 */
export interface ModuleDecl {
  name: string;
  /** 绝对路径 */
  file: string;
  ports: PortDecl[];
  /** 端口名按声明顺序排列（位置连接回填用） */
  portOrder: string[];
  instances: Instance[];
  assigns: AssignStmt[];
  alwaysBlocks: AlwaysBlock[];
  /** 模块体内声明的内部信号名 -> 位宽 / 种类 / 声明处偏移 */
  signals: Map<
    string,
    {
      msb: string | null;
      lsb: string | null;
      kind: string;
      offset: number;
      /** 声明所在行；隐式网络没有声明行，取首次出现处 */
      line?: number;
      /** 是否为"隐式 wire"（未声明，由端口连接自动创建） */
      implicit?: boolean;
    }
  >;
  /** 模块起始/结束字符偏移（用于判断光标落在哪个模块） */
  start: number;
  end: number;
  headerLine: number;
  endLine: number;
  /** 是否使用 ANSI 风格端口列表 */
  ansi: boolean;
  /**
   * 仅"声明用途"的模块定义：来自 IP 的 .veo / .vho / 例化模板等辅助文件。
   * 它只用来补齐端口方向（消除"方向未知"黑盒），不参与例化反查与顶层判定，
   * 也不会覆盖工程里真正的实现。
   */
  declOnly?: boolean;
  /** 解析过程中的告警（不阻塞使用，但会展示给用户） */
  warnings: string[];
}

/** 整个工作区的索引 */
export interface WorkspaceIndex {
  /** 模块名 -> 所有同名定义（Verilog 允许同名？实际上不允许，但工程里可能有多个副本文件） */
  modules: Map<string, ModuleDecl[]>;
  /** 文件绝对路径 -> 该文件定义的模块名 */
  fileModules: Map<string, string[]>;
  /** 被例化的模块名 -> 例化点列表 */
  instantiations: Map<string, InstantiationSite[]>;
  /** 已识别的宏 */
  defines: Set<string>;
  /** `include 引用的文件名 */
  includes: Set<string>;
  /** 顶层模块候选（未被任何模块例化） */
  topCandidates: string[];
  /** 扫描到但没能当文本解析的文件（加密 / 二进制 / 读取失败），供 UI 与 AI 提示 */
  skipped?: { file: string; reason: string }[];
  /** 统计信息 */
  stats: {
    fileCount: number;
    moduleCount: number;
    instanceCount: number;
    parseMs: number;
  };
}

/** 某模块被例化的位置 */
export interface InstantiationSite {
  /** 父模块名 */
  parentModule: string;
  parentFile: string;
  instance: Instance;
}
