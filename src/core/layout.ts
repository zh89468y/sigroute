/**
 * 框图布局（纯计算，无外部依赖）
 *
 * 设计要点：
 *   1. 以"起点模块"为第 0 列，沿数据流方向向两侧 BFS 分层
 *      - 上游模块依次落在 -1 / -2 / … 列（越左越靠近信号的源头）
 *      - 下游模块依次落在 +1 / +2 / … 列（越右越靠近信号的尽头）
 *      这直接对应开发者"从哪来 → 穿越 → 到哪去"的阅读顺序。
 *   2. 同列内用重心法（barycenter）迭代排序，减少连线交叉。
 *   3. 三次贝塞尔连边；回边（指向更左侧）自动从上方绕行。
 *
 * 相比标准 Sugiyama 简单得多，但对"一根信号的主干路径"这类近线性的图，效果等价。
 */

import type { SignalGraph, SignalGraphEdge } from './graph';

export interface LayoutOptions {
  direction: 'LR' | 'TD';
  nodeWidth: number;
  nodeHeight: number;
  colGap: number;
  rowGap: number;
  padding: number;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 列号：0 = 起点模块，负数 = 上游，正数 = 下游 */
  column: number;
  row: number;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /** SVG path 的 d 属性 */
  path: string;
  label: string;
  labelX: number;
  labelY: number;
  /** 是否为回边（指向左侧/上方） */
  back: boolean;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  columns: number;
}

const DEFAULTS: LayoutOptions = {
  direction: 'LR',
  nodeWidth: 196,
  nodeHeight: 64,
  colGap: 92,
  rowGap: 24,
  padding: 32,
};

/**
 * 合并同一对模块之间的多条连接。
 *
 * 多通道设计里，`compress_4ch → data_path` 这类连接会有 4~8 条
 * （每个通道一条），逐条画出来只会把图糊掉。合并成一条并标注条数，
 * 信息不丢，图面清晰。
 */
export function mergeParallelEdges(graph: SignalGraph): SignalGraph {
  const map = new Map<string, SignalGraphEdge>();
  let mergedAny = false;

  for (const e of graph.edges) {
    const key = `${e.from}\u0000${e.to}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...e, count: 1, allNets: [e.fromNet] });
      continue;
    }
    mergedAny = true;
    cur.count = (cur.count ?? 1) + 1;
    cur.allNets = [...(cur.allNets ?? []), e.fromNet];
    if (e.renamed && !cur.renamed) {
      // 关键：改用名的那条作为代表边。
      // 否则会出现 "i_peak1_data => i_peak1_data [改名]" 这种自相矛盾的标签 ——
      // 同一模块被多次例化时，只要有一条改名，整对模块的连线就应当被标为改名。
      cur.renamed = true;
      cur.fromNet = e.fromNet;
      cur.toNet = e.toNet;
      cur.port = e.port;
      cur.file = e.file;
      cur.line = e.line;
      cur.offset = e.offset;
      cur.tooltip = e.tooltip;
      if (!cur.flags.includes('renamed')) cur.flags.push('renamed');
    }
  }

  if (!mergedAny) return graph;

  const edges = [...map.values()];
  return {
    nodes: graph.nodes,
    edges,
    startModule: graph.startModule,
    signalName: graph.signalName,
    stats: {
      nodes: graph.stats.nodes,
      edges: edges.length,
      renames: edges.filter((e) => e.renamed).length,
    },
  };
}

/**
 * 按"距起点模块的跳数"裁剪图。
 *
 * 这是"简易框图"的关键：一根数据总线往下扩散后会牵出整个处理树
 * （实测某信号可带出 31 个模块 / 271 条连线），直接画出来反而看不清。
 * 默认只看近距离关联的模块，"穿越了谁"通过逐层加深来探索。
 *
 * @param maxHops 允许的最大跳数；<=0 或非有限值表示不裁剪
 */
export function filterGraphByHops(graph: SignalGraph, maxHops: number): SignalGraph {
  if (!Number.isFinite(maxHops) || maxHops <= 0) return graph;

  const edges = graph.edges.filter((e) => (e.hop || 1) <= maxHops);
  if (edges.length === graph.edges.length) return graph;

  const keep = new Set<string>([graph.startModule]);
  for (const e of edges) {
    keep.add(e.from);
    keep.add(e.to);
  }
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  return {
    nodes,
    edges,
    startModule: graph.startModule,
    signalName: graph.signalName,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      renames: edges.filter((e) => e.renamed).length,
    },
  };
}

/**
 * 层次框：把"同一个父模块里的兄弟实例"圈在一起。
 *
 * 为什么需要：框图的节点是模块级的，看起来全是平铺的方块 ——
 * 但实际上 `data_path` 里可能同时例化了 4 个 `compress_4ch`，
 * 它们是同一层的兄弟；而 `data_path → fifo` 这一步是跨层次。
 * 有了层次框，"包含关系"和"同层次"才在图上直接看得出来。
 *
 * 画框的条件刻意收得很紧：只有当同一父模块下的兄弟**在同一列且行相邻**时才画，
 * 否则矩形会横跨其它节点、反而更乱（那种情况退回用悬停提示说明）。
 */
export interface HierarchyFrame {
  /** 父模块（容器）名 */
  container: string;
  /** 框内节点 id（按行号排序） */
  members: string[];
  /** 框内各实例的实例名（真实例化调用） */
  instanceNames: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeHierarchyFrames(
  graph: SignalGraph,
  layout: LayoutResult,
  padding = 12,
): HierarchyFrame[] {
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));

  /**
   * 按（父模块, 列）分桶：
   *   - 同一个父模块 + 同一列 = 图面上挨着的一排兄弟
   *   - 上游与下游分处不同列，自然分成两个框，不会拉出一个横跨整图的大矩形
   * 一个节点可以同时属于多个桶（同一模块被多处例化时）。
   */
  interface Item {
    id: string;
    instanceName: string;
    row: number;
  }
  const buckets = new Map<string, { container: string; column: number; items: Item[] }>();

  for (const n of graph.nodes) {
    if (n.isStart) continue;
    const pairs =
      n.instances && n.instances.length > 0
        ? n.instances
        : n.container && n.instanceName
          ? [{ container: n.container, instanceName: n.instanceName }]
          : [];
    if (pairs.length === 0) continue;
    const p = pos.get(n.id);
    if (!p) continue;

    for (const pair of pairs) {
      const key = `${pair.container}\u0000${p.column}`;
      const bucket = buckets.get(key) ?? { container: pair.container, column: p.column, items: [] };
      bucket.items.push({ id: n.id, instanceName: pair.instanceName, row: p.row });
      buckets.set(key, bucket);
    }
  }

  const out: HierarchyFrame[] = [];
  for (const bucket of buckets.values()) {
    // 只有 1 个实例时不画框（单个方块不需要再套一圈）
    if (bucket.items.length < 2) continue;

    const rows = [...new Set(bucket.items.map((i) => i.row))].sort((a, b) => a - b);
    let contiguous = true;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i] !== rows[i - 1] + 1) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue; // 中间夹着别的节点，框出来反而更乱

    const ids = [...new Set(bucket.items.map((i) => i.id))];
    const boxes = ids.map((id) => pos.get(id)).filter((b): b is LayoutNode => !!b);
    if (boxes.length === 0) continue;

    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));

    const instanceNames = [...new Set(bucket.items.map((i) => i.instanceName))].slice(0, 6);
    const orderedIds = [...ids].sort((a, b) => (pos.get(a)?.row ?? 0) - (pos.get(b)?.row ?? 0));

    out.push({
      container: bucket.container,
      members: orderedIds,
      instanceNames,
      x: x - padding,
      y: y - padding,
      width: right - x + padding * 2,
      height: bottom - y + padding * 2,
    });
  }
  return out;
}

export function layoutSignalGraph(
  graph: SignalGraph,
  options: Partial<LayoutOptions> = {},
): LayoutResult {
  const o: LayoutOptions = { ...DEFAULTS, ...options };
  const isLR = o.direction === 'LR';

  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const cols = new Map<string, number>();

  const next = new Map<string, string[]>();
  const prev = new Map<string, string[]>();
  for (const id of ids) {
    next.set(id, []);
    prev.set(id, []);
  }
  for (const e of graph.edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    next.get(e.from)!.push(e.to);
    prev.get(e.to)!.push(e.from);
  }

  // ---------------------------------------------------------------- 1. 分层
  const order: string[] = [];
  const startId = idSet.has(graph.startModule) ? graph.startModule : ids[0];
  if (startId !== undefined) {
    cols.set(startId, 0);
    order.push(startId);
  }

  const bfs = (adj: Map<string, string[]>, step: number): void => {
    if (startId === undefined) return;
    const seen = new Set<string>([startId]);
    const queue: string[] = [startId];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const base = cols.get(cur) ?? 0;
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb) || cols.has(nb)) continue;
        seen.add(nb);
        cols.set(nb, base + step);
        order.push(nb);
        queue.push(nb);
      }
    }
  };

  bfs(next, 1);
  bfs(prev, -1);

  // 未连通的节点统一放在起点列
  for (const id of ids) {
    if (!cols.has(id)) {
      cols.set(id, 0);
      order.push(id);
    }
  }

  // ---------------------------------------------------------------- 2. 同列排序
  const byCol = new Map<number, string[]>();
  for (const id of order) {
    const c = cols.get(id)!;
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c)!.push(id);
  }
  const colKeys = [...byCol.keys()].sort((a, b) => a - b);

  const snapshotRow = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const c of colKeys) {
      byCol.get(c)!.forEach((id, i) => m.set(id, i));
    }
    return m;
  };

  for (let iter = 0; iter < 4; iter++) {
    // 从左到右：按上游邻居的平均行号排序
    const p1 = snapshotRow();
    for (const c of colKeys) {
      const list = byCol.get(c)!;
      const bary = new Map<string, number>();
      list.forEach((id, i) => {
        const ps = (prev.get(id) ?? []).filter((p) => p1.has(p));
        bary.set(id, ps.length === 0 ? i : ps.reduce((a, p) => a + p1.get(p)!, 0) / ps.length);
      });
      list.sort((a, b) => bary.get(a)! - bary.get(b)!);
    }
    // 从右到左：按下游邻居的平均行号排序
    const p2 = snapshotRow();
    for (const c of [...colKeys].reverse()) {
      const list = byCol.get(c)!;
      const bary = new Map<string, number>();
      list.forEach((id, i) => {
        const ns = (next.get(id) ?? []).filter((p) => p2.has(p));
        bary.set(id, ns.length === 0 ? i : ns.reduce((a, p) => a + p2.get(p)!, 0) / ns.length);
      });
      list.sort((a, b) => bary.get(a)! - bary.get(b)!);
    }
  }

  // ---------------------------------------------------------------- 3. 坐标
  const minCol = colKeys.length > 0 ? colKeys[0] : 0;
  const pos = new Map<string, LayoutNode>();
  const nodes: LayoutNode[] = [];

  for (const c of colKeys) {
    const list = byCol.get(c)!;
    list.forEach((id, row) => {
      const lane = c - minCol;
      const x = isLR
        ? o.padding + lane * (o.nodeWidth + o.colGap)
        : o.padding + row * (o.nodeWidth + o.colGap);
      const y = isLR
        ? o.padding + row * (o.nodeHeight + o.rowGap)
        : o.padding + lane * (o.nodeHeight + o.rowGap);
      const n: LayoutNode = {
        id,
        x,
        y,
        width: o.nodeWidth,
        height: o.nodeHeight,
        column: c,
        row,
      };
      nodes.push(n);
      pos.set(id, n);
    });
  }

  // ---------------------------------------------------------------- 4. 连边
  const edges: LayoutEdge[] = [];
  for (const e of graph.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const label = e.fromNet === e.toNet ? e.fromNet : `${e.fromNet} → ${e.toNet}`;

    /**
     * 箭头尖端不要顶到方块上：目标端留出 GAP。
     * 不留这个间隙时，箭头（marker）会压住方块边框与模块名，缩放后尤其明显。
     */
    const GAP = 5;

    if (isLR) {
      const sx = a.x + a.width;
      const sy = a.y + a.height / 2;
      const tx = b.x - GAP;
      const ty = b.y + b.height / 2;
      const back = tx <= sx + 4;
      if (back) {
        // 回边：从上方绕行，避免穿过节点
        const lift = Math.max(o.padding - 14, Math.min(a.y, b.y) - o.rowGap - 18);
        edges.push({
          id: e.id,
          from: e.from,
          to: e.to,
          path: `M ${sx} ${sy} C ${sx + 56} ${lift}, ${tx - 56} ${lift}, ${tx} ${ty}`,
          label,
          labelX: (sx + tx) / 2,
          labelY: lift - 6,
          back: true,
        });
      } else {
        const dx = Math.max(40, (tx - sx) * 0.45);
        edges.push({
          id: e.id,
          from: e.from,
          to: e.to,
          path: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
          label,
          labelX: (sx + 3 * (sx + dx) + 3 * (tx - dx) + tx) / 8,
          labelY: (4 * sy + 4 * ty) / 8,
          back: false,
        });
      }
    } else {
      const sx = a.x + a.width / 2;
      const sy = a.y + a.height;
      const tx = b.x + b.width / 2;
      const ty = b.y - GAP;
      const back = ty <= sy + 4;
      if (back) {
        const lift = Math.max(o.padding - 14, Math.min(a.x, b.x) - o.colGap - 18);
        edges.push({
          id: e.id,
          from: e.from,
          to: e.to,
          path: `M ${sx} ${sy} C ${lift} ${sy + 56}, ${lift} ${ty - 56}, ${tx} ${ty}`,
          label,
          labelX: lift - 6,
          labelY: (sy + ty) / 2,
          back: true,
        });
      } else {
        const dy = Math.max(40, (ty - sy) * 0.45);
        edges.push({
          id: e.id,
          from: e.from,
          to: e.to,
          path: `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`,
          label,
          labelX: (sx + tx) / 2,
          labelY: (sy + 3 * (sy + dy) + 3 * (ty - dy) + ty) / 8,
          back: false,
        });
      }
    }
  }

  // ---------------------------------------------------------------- 5. 画布尺寸
  let width = 0;
  let height = 0;
  for (const n of nodes) {
    width = Math.max(width, n.x + n.width);
    height = Math.max(height, n.y + n.height);
  }
  for (const e of edges) {
    // 回边可能伸到上边界之外
    width = Math.max(width, e.labelX + 40);
    height = Math.max(height, e.labelY + 20);
  }

  return {
    nodes,
    edges,
    width: width + o.padding,
    height: height + o.padding,
    columns: colKeys.length,
  };
}
