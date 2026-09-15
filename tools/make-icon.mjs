/**
 * 生成插件图标（PNG）。
 *
 * 为什么用代码画而不是找素材：
 *   1. 零依赖、可复现，随时能调参重出
 *   2. 用有符号距离场（SDF）做抗锯齿，边缘干净
 *   3. 体积只有几 KB，不会把 vsix 撑大
 *
 * 图案语义：一根信号从左侧节点出发，拐过几道弯到达右侧节点
 *           —— 正是"信号穿越多个模块"的抽象。
 *
 * 用法：node tools/make-icon.mjs [尺寸，默认 256]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIZE = Number(process.argv[2] ?? 256);

// ---------------------------------------------------------------- SDF 图元

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const len2 = bax * bax + bay * bay;
  const h = len2 === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / len2));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** 折线：到任意一段的最小距离 */
function sdPolyline(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, sdSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return d;
}

// ---------------------------------------------------------------- 调色板
const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

const BG = hex('#151a24');      // 深蓝黑背景
const TRACE = hex('#3d9bff');   // 信号路径（VSCode 蓝）
const NODE_SRC = hex('#89d185'); // 源头节点（绿）
const NODE_DST = hex('#ffb454'); // 终点节点（橙）
const GLOW = hex('#3d9bff');

// ---------------------------------------------------------------- 构图（以 256 为基准，按比例缩放到 SIZE）
const S = SIZE / 256;

/** 信号路径：阶梯状上升，象征信号在层次间穿越 */
const PATH_PTS = [
  [58, 182],
  [98, 182],
  [98, 130],
  [150, 130],
  [150, 78],
  [198, 78],
];

const layers = [
  // 背景
  {
    sd: (x, y) => sdRoundRect(x, y, 128 * S, 128 * S, 118 * S, 118 * S, 46 * S),
    color: BG,
    alpha: 1,
  },
  // 路径外发光（让线条在深色背景上更"发光"）
  {
    sd: (x, y) => sdPolyline(x, y, PATH_PTS.map(([a, b]) => [a * S, b * S])) - 13 * S,
    color: GLOW,
    alpha: 0.16,
  },
  // 信号路径
  {
    sd: (x, y) => sdPolyline(x, y, PATH_PTS.map(([a, b]) => [a * S, b * S])) - 5.5 * S,
    color: TRACE,
    alpha: 1,
  },
  // 起点节点
  {
    sd: (x, y) => sdCircle(x, y, 58 * S, 182 * S, 15 * S),
    color: NODE_SRC,
    alpha: 1,
  },
  // 终点节点
  {
    sd: (x, y) => sdCircle(x, y, 198 * S, 78 * S, 15 * S),
    color: NODE_DST,
    alpha: 1,
  },
];

// ---------------------------------------------------------------- 光栅化（SDF + 覆盖率抗锯齿）
function render() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (const layer of layers) {
        const d = layer.sd(x + 0.5, y + 0.5) / S; // 转回 256 基准，抗锯齿宽度一致
        const cov = Math.max(0, Math.min(1, 0.5 - d));
        const sa = cov * layer.alpha;
        if (sa <= 0) continue;
        r = layer.color[0] * sa + r * (1 - sa);
        g = layer.color[1] * sa + g * (1 - sa);
        b = layer.color[2] * sa + b * (1 - sa);
        a = sa + a * (1 - sa);
      }

      const o = (y * SIZE + x) * 4;
      buf[o] = Math.round(r);
      buf[o + 1] = Math.round(g);
      buf[o + 2] = Math.round(b);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 输出
const png = encodePng(render(), SIZE, SIZE);
const out = path.join(here, '..', 'icon.png');
fs.writeFileSync(out, png);

console.log(`已生成图标：${out}`);
console.log(`  尺寸 : ${SIZE}x${SIZE}`);
console.log(`  大小 : ${(png.length / 1024).toFixed(1)} KB`);
