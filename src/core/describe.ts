/**
 * 信号速查（1 跳分析）
 *
 * 与 traceSignal 的根本区别：
 *   - traceSignal 递归展开整条链路，用于「主视图」（树 / 框图面板）
 *   - describeSignal 只回答"这是什么、谁驱动它、它驱动谁"，不递归
 *
 * 为什么必须分开：Hover / 定义跳转 / 查找引用是高频、毫秒级的操作，
 * 而且**绝对不能触碰面板里正在追踪的主信号**。
 * 开发者可以在保持主信号上下文的同时，随手悬停查看任意其它信号。
 */

import type { WorkspaceIndexer } from './indexer';
import type { NetMember } from './nets';
import type { Connection, ModuleDecl, PortDirection } from './types';

export type RefKind =
  | 'instance-input'
  | 'instance-output'
  | 'assign-lhs'
  | 'assign-rhs'
  | 'proc-lhs'
  | 'proc-read'
  | 'parent-conn';

export interface SignalRef {
  kind: RefKind;
  /** 主要显示文本 */
  text: string;
  /** 补充说明（位宽、位置等） */
  detail?: string;
  file: string;
  line: number;
  /** 文件内字符偏移，用于精确跳转 */
  offset?: number;
}

export interface SignalDecl {
  kind: 'port' | 'signal' | 'submodule-port' | 'unknown';
  direction?: PortDirection;
  /** wire / reg / logic / param / other */
  signalKind?: string;
  width: number | null;
  /** 范围原文，例如 [63:0] */
  range: string | null;
  file?: string;
  line?: number;
  offset?: number;
  /** kind === 'submodule-port' 时有效 */
  subModule?: string;
  instanceName?: string;
}

export interface SignalDescription {
  name: string;
  moduleName: string;
  decl: SignalDecl;
  drivers: SignalRef[];
  loads: SignalRef[];
  /** 该模块被例化的次数（当被查信号是端口时，说明它有多少个层次上的"实例"） */
  instantiationCount: number;
  /** 该名字是否根本不在当前模块里 */
  notInModule: boolean;
  /**
   * 同一物理网络在其它模块里的名字（"这根线在别处叫什么"）。
   * 名字没改过时为空数组。
   */
  aliases: NetMember[];
}

/**
 * 单节最多收集多少条引用。
 *
 * 这里是"数据上限"，不是"显示上限" —— 显示条数由 sigroute.hover.maxRefs 决定
 * （悬停渲染时再切一次）。留一个比默认显示值宽的上限，用户调大设置才有意义；
 * 同时仍是一个有限值，避免高扇出信号把结果撑爆。
 */
const MAX_REFS = 60;

function fname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 解析连接的目标端口名：命名连接直接取，位置连接用子模块端口顺序回填 */
function connPort(indexer: WorkspaceIndexer, instType: string, c: Connection): string | null {
  if (c.port) return c.port;
  if (c.portIndex === null) return null;
  return indexer.getModule(instType)?.portOrder[c.portIndex] ?? null;
}

export function describeSignal(
  indexer: WorkspaceIndexer,
  mod: ModuleDecl,
  net: string,
): SignalDescription {
  const drivers: SignalRef[] = [];
  const loads: SignalRef[] = [];

  // ---------------------------------------------------------------- 声明
  let decl: SignalDecl = { kind: 'unknown', width: null, range: null };
  let dir: PortDirection | null = null;

  const port = mod.ports.find((p) => p.name === net);
  if (port) {
    dir = port.direction;
    decl = {
      kind: 'port',
      direction: port.direction ?? undefined,
      width: port.width,
      range: port.msb !== null && port.lsb !== null ? `[${port.msb}:${port.lsb}]` : null,
      file: mod.file,
      line: port.line,
      offset: port.offset,
      signalKind: port.isReg ? 'reg' : 'wire',
    };
  } else {
    const sig = mod.signals.get(net);
    if (sig) {
      decl = {
        kind: 'signal',
        signalKind: sig.kind,
        width: sig.msb !== null && sig.lsb !== null ? widthOf(sig.msb, sig.lsb) : null,
        range: sig.msb !== null && sig.lsb !== null ? `[${sig.msb}:${sig.lsb}]` : null,
        file: mod.file,
        // 声明行：普通信号就是它的声明行；隐式网络取"首次出现处"（types.ts 里保证）。
        // 这里以前写死 undefined，导致内部信号在悬停里没有位置、Ctrl+点击也拿不到定义。
        line: sig.line,
        offset: sig.offset >= 0 ? sig.offset : undefined,
      };
    }
  }

  const notInModule = decl.kind === 'unknown';

  // 该名字不在当前模块里：很可能是用户悬停在例化的端口名上（.i_data(...)）
  if (notInModule) {
    const sub = findSubmodulePort(indexer, mod, net);
    if (sub) {
      decl = {
        kind: 'submodule-port',
        direction: sub.direction,
        width: sub.width,
        range: sub.range,
        file: sub.file,
        line: sub.line,
        offset: sub.offset,
        subModule: sub.moduleName,
        instanceName: sub.instanceName,
      };
    }
  }

  // ---------------------------------------------------------------- 驱动源
  // 1) 子实例的 output / inout 端口
  for (const inst of mod.instances) {
    for (const c of inst.connections) {
      if (!c.nets.includes(net)) continue;
      const pname = connPort(indexer, inst.moduleType, c);
      if (!pname) continue;
      const d = portDir(indexer, inst.moduleType, pname);
      if (d !== 'output' && d !== 'inout') continue;
      drivers.push({
        kind: 'instance-output',
        text: `${inst.instanceName}.${pname}`,
        detail: `${inst.moduleType} 的 ${d} 端口`,
        file: mod.file,
        line: c.line,
        offset: c.netOffset ?? c.start,
      });
    }
  }

  // 2) assign 左值
  for (const a of mod.assigns) {
    if (!a.lhsNets.includes(net)) continue;
    const rhs = a.rhsNets.join(', ');
    drivers.push({
      kind: 'assign-lhs',
      text: `assign ${a.lhsText}`,
      detail: rhs ? `= ${trunc(rhs, 60)}` : undefined,
      file: mod.file,
      line: a.line,
      offset: a.lhsOffsets[0] >= 0 ? a.lhsOffsets[0] : undefined,
    });
  }

  // 3) 过程块内赋值
  for (const ab of mod.alwaysBlocks) {
    if (!ab.lhsNets.includes(net)) continue;
    const sens = ab.edgeNets.slice(0, 3).join(', ');
    drivers.push({
      kind: 'proc-lhs',
      text: ab.isSequential ? `always @(${sens}${ab.edgeNets.length > 3 ? ', …' : ''})` : 'always @(*)',
      detail: '过程块内赋值',
      file: mod.file,
      line: ab.line,
    });
  }

  // 4) 若自身是 input 端口 —— 驱动来自父层
  if (dir === 'input' || dir === 'inout') {
    for (const site of indexer.getInstantiations(mod.name)) {
      const c = site.instance.connections.find(
        (x) => connPort(indexer, site.instance.moduleType, x) === net,
      );
      if (!c) continue;
      const from = c.primaryNet ?? c.expr;
      drivers.push({
        kind: 'parent-conn',
        text: from || '(常量/表达式)',
        detail: `父模块 ${site.parentModule} 中 ${site.instance.instanceName} 的 .${net} 端口`,
        file: site.parentFile,
        line: c.line,
        offset: c.netOffset ?? c.start,
      });
    }
  }

  // ---------------------------------------------------------------- 负载
  // 1) 流入子实例的 input / inout 端口
  for (const inst of mod.instances) {
    for (const c of inst.connections) {
      if (!c.nets.includes(net)) continue;
      const pname = connPort(indexer, inst.moduleType, c);
      if (!pname) continue;
      const d = portDir(indexer, inst.moduleType, pname);
      if (d !== 'input' && d !== 'inout') continue;
      const renamed = pname !== net ? `  → ${pname}` : '';
      loads.push({
        kind: 'instance-input',
        text: `${inst.instanceName}.${pname}`,
        detail: `${inst.moduleType} 的 ${d} 端口${renamed}`,
        file: mod.file,
        line: c.line,
        offset: c.netOffset ?? c.start,
      });
    }
  }

  // 2) assign 右值（被这个信号驱动的其它信号）
  for (const a of mod.assigns) {
    if (!a.rhsNets.includes(net)) continue;
    if (a.lhsNets.length === 0) continue;
    loads.push({
      kind: 'assign-rhs',
      text: `assign ${a.lhsText}`,
      detail: '在右值中被使用',
      file: mod.file,
      line: a.line,
      offset: a.lhsOffsets[0] >= 0 ? a.lhsOffsets[0] : undefined,
    });
  }

  // 3) 过程块内被读取
  for (const ab of mod.alwaysBlocks) {
    let hit = false;
    for (const st of ab.statements) {
      if (st.reads.includes(net)) hit = true;
    }
    if (!hit && !ab.readNets.includes(net)) continue;
    const sens = ab.edgeNets.slice(0, 3).join(', ');
    loads.push({
      kind: 'proc-read',
      text: ab.isSequential ? `always @(${sens}${ab.edgeNets.length > 3 ? ', …' : ''})` : 'always @(*)',
      detail: '过程块内被读取',
      file: mod.file,
      line: ab.line,
    });
  }

  // 4) 若自身是 output 端口 —— 负载在父层
  if (dir === 'output' || dir === 'inout') {
    for (const site of indexer.getInstantiations(mod.name)) {
      const c = site.instance.connections.find(
        (x) => connPort(indexer, site.instance.moduleType, x) === net,
      );
      if (!c) continue;
      const to = c.primaryNet ?? c.expr;
      loads.push({
        kind: 'parent-conn',
        text: to || '(悬空)',
        detail: `父模块 ${site.parentModule} 中 ${site.instance.instanceName} 的 .${net} 端口`,
        file: site.parentFile,
        line: c.line,
        offset: c.netOffset ?? c.start,
      });
    }
  }

  return {
    name: net,
    moduleName: mod.name,
    decl,
    drivers: drivers.slice(0, MAX_REFS),
    loads: loads.slice(0, MAX_REFS),
    instantiationCount: indexer.getInstantiations(mod.name).length,
    notInModule,
    aliases: indexer
      .netMembers(mod.name, net)
      .filter((m) => !(m.module === mod.name && m.net === net)),
  };
}

// ------------------------------------------------------------------ 辅助

function portDir(indexer: WorkspaceIndexer, moduleType: string, portName: string): PortDirection | null {
  return indexer.getModule(moduleType)?.ports.find((p) => p.name === portName)?.direction ?? null;
}

function widthOf(msb: string, lsb: string): number | null {
  if (!/^\d+$/.test(msb.trim()) || !/^\d+$/.test(lsb.trim())) return null;
  return Math.abs(Number(msb) - Number(lsb)) + 1;
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 当前模块里是否有个子实例的端口叫这个名字（用户悬停在 .port 上时的场景） */
function findSubmodulePort(
  indexer: WorkspaceIndexer,
  mod: ModuleDecl,
  net: string,
): {
  moduleName: string;
  instanceName: string;
  direction?: PortDirection;
  width: number | null;
  range: string | null;
  file: string;
  line: number;
  offset: number;
} | null {
  for (const inst of mod.instances) {
    for (const c of inst.connections) {
      const pname = connPort(indexer, inst.moduleType, c);
      if (pname !== net) continue;
      const sub = indexer.getModule(inst.moduleType);
      const p = sub?.ports.find((x) => x.name === net);
      if (!sub || !p) continue;
      return {
        moduleName: sub.name,
        instanceName: inst.instanceName,
        direction: p.direction ?? undefined,
        width: p.width,
        range: p.msb !== null && p.lsb !== null ? `[${p.msb}:${p.lsb}]` : null,
        file: sub.file,
        line: p.line,
        offset: p.offset,
      };
    }
  }
  return null;
}

/** 模块定义位置（供"跳到模块定义"用） */
export function moduleLocation(
  indexer: WorkspaceIndexer,
  moduleName: string,
): { file: string; line: number } | null {
  const mod = indexer.getModule(moduleName);
  if (!mod) return null;
  return { file: mod.file, line: mod.headerLine };
}

/** 格式化：文件:行 */
export function locText(file: string, line: number): string {
  return `${fname(file)}:${line + 1}`;
}
