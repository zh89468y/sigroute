/**
 * 框图 Webview 的前端资源（HTML + CSS + 内联 JS）。
 *
 * 刻意手写 SVG 而不是引入 mermaid / dagre / elk：
 *   1. 零外部依赖 —— 无 CSP 麻烦、无体积负担、离线可用、打开即渲染
 *   2. 节点需要可点击跳转、边需要悬停高亮，第三方渲染库做这些反而更绕
 *   3. 布局已经在扩展侧算好（core/layout.ts），前端只负责画
 *
 * 注意：内联 JS 里一律不使用模板字符串，避免与 TS 模板字符串的插值语法冲突。
 */

import type * as vscode from 'vscode';

export function renderGraphHtml(webview: vscode.Webview, nonce: string): string {
  const csp = webview.cspSource;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${csp} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --line: var(--vscode-panel-border, #3c3c3c);
    --dim: var(--vscode-descriptionForeground, #9aa0a6);
    --c-start: var(--vscode-charts-blue, #3794ff);
    --c-up: var(--vscode-charts-green, #89d185);
    --c-down: var(--vscode-charts-purple, #b180d7);
    --c-warn: var(--vscode-charts-orange, #d18616);
    --c-bad: var(--vscode-charts-red, #f14c4c);
    --c-black: var(--vscode-charts-yellow, #cca700);
    --node-bg: var(--vscode-editorWidget-background, #252526);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
    font-size: 12px;
  }
  .app { display: flex; flex-direction: column; height: 100%; }

  .toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-bottom: 1px solid var(--line);
    flex: 0 0 auto; flex-wrap: wrap;
  }
  .toolbar .sig { font-weight: 600; font-size: 13px; }
  .toolbar .stats { color: var(--dim); }
  .toolbar .spacer { flex: 1 1 auto; }
  .toolbar button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer;
    font-size: 12px; font-family: inherit;
  }
  .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .toolbar button.on {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .toolbar .hops {
    display: inline-flex; align-items: center; gap: 3px;
    padding-left: 8px; border-left: 1px solid var(--line);
  }
  .toolbar .hops .lbl { color: var(--dim); margin-right: 2px; }
  .toolbar .hops button { padding: 4px 9px; min-width: 26px; }
  .toolbar .sep { width: 1px; height: 16px; background: var(--line); }

  .legend {
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    padding: 4px 10px; border-bottom: 1px solid var(--line);
    color: var(--dim); flex: 0 0 auto;
  }
  .chip { display: inline-flex; align-items: center; gap: 5px; }
  .dot { width: 10px; height: 10px; border-radius: 3px; border: 2px solid; }
  .dot.start { border-color: var(--c-start); background: color-mix(in srgb, var(--c-start) 22%, transparent); }
  .dot.up { border-color: var(--c-up); }
  .dot.down { border-color: var(--c-down); }
  .dot.rename { border-color: var(--c-warn); background: color-mix(in srgb, var(--c-warn) 25%, transparent); }
  .dot.black { border-color: var(--c-black); border-style: dashed; }
  .dot.frame { border-color: var(--line); border-style: dashed; }

  .main { flex: 1 1 auto; display: flex; min-height: 0; }
  .canvas { flex: 1 1 auto; position: relative; overflow: hidden; }
  svg { width: 100%; height: 100%; display: block; cursor: grab; }
  svg.dragging { cursor: grabbing; }

  .side {
    flex: 0 0 196px; border-left: 1px solid var(--line);
    display: none; flex-direction: column; min-height: 0;
  }
  .side.on { display: flex; }
  .side-head {
    padding: 5px 8px; border-bottom: 1px solid var(--line);
    color: var(--dim); display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
  }
  .side-head .sp2 { flex: 1 1 auto; }
  .side-head button {
    background: transparent; border: none; color: var(--dim); cursor: pointer; font-size: 13px;
  }
  .side-list { overflow: auto; flex: 1 1 auto; padding: 4px 0; }
  .sig-item {
    padding: 3px 8px; cursor: pointer; display: flex; gap: 6px; align-items: baseline;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  }
  .sig-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .sig-item .n { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sig-item .c { color: var(--dim); }
  .sig-item.rename .n { color: var(--c-warn); }
  .sig-item .dir { color: var(--dim); font-size: 10px; }

  .node rect {
    fill: var(--node-bg); stroke: var(--c-down); stroke-width: 1.6;
  }
  .node.start rect { stroke: var(--c-start); stroke-width: 3; }
  .node.up rect { stroke: var(--c-up); }
  .node.blackbox rect { stroke: var(--c-black); stroke-dasharray: 6 4; }
  .node.uncertain rect { stroke-dasharray: 3 3; }
  .node:hover rect { stroke-width: 3; filter: brightness(1.25); }
  .node { cursor: pointer; }
  .node text { pointer-events: none; user-select: none; }
  .node .ttl { fill: var(--fg); font-size: 12.5px; font-weight: 600; }
  .node .inst { fill: var(--c-start); font-size: 10px; opacity: 0.9; }
  .node .sub { fill: var(--dim); font-size: 10.5px; }
  .node .badge { fill: var(--c-start); font-size: 9.5px; font-weight: 700; }
  .node.dim { opacity: 0.18; }

  /* 层次框：圈出"同一个父模块里的兄弟实例" */
  .frame rect {
    fill: color-mix(in srgb, var(--c-start) 6%, transparent);
    stroke: var(--line); stroke-width: 1; stroke-dasharray: 5 4;
    /* 不吃鼠标事件：否则框内空白处会抢走拖拽与悬停 */
    pointer-events: none;
  }
  .frame .flabel {
    fill: var(--dim); font-size: 10px; font-weight: 600;
    paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round;
    user-select: none; pointer-events: none;
  }
  .frame.dim { opacity: 0.3; }
  .toolbar button.on2 {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }

  .edge .line {
    fill: none; stroke: var(--line); stroke-width: 1.8;
  }
  .edge.rename .line { stroke: var(--c-warn); stroke-width: 2.6; }
  .edge.back .line { stroke-dasharray: 6 4; }
  .edge .hit { fill: none; stroke: transparent; stroke-width: 16; pointer-events: stroke; cursor: pointer; }
  .edge:hover .line { stroke: var(--c-start); stroke-width: 3.4; }
  .edge.dim { opacity: 0.12; }
  .edge .elabel {
    fill: var(--fg); font-size: 10.5px; text-anchor: middle;
    paint-order: stroke; stroke: var(--bg); stroke-width: 3.5px; stroke-linejoin: round;
    pointer-events: none; user-select: none;
  }
  .edge.rename .elabel { fill: var(--c-warn); font-weight: 600; }

  .tip {
    position: absolute; pointer-events: none; z-index: 10;
    max-width: min(420px, calc(100% - 16px)); padding: 7px 9px; border-radius: 5px;
    background: var(--vscode-editorHoverWidget-background, #252526);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    color: var(--vscode-editorHoverWidget-foreground, #ccc);
    box-shadow: 0 2px 10px rgba(0,0,0,.35);
    display: none; line-height: 1.55; white-space: pre-wrap;
  }
  .tip b { color: var(--fg); }

  .empty {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--dim); text-align: center; padding: 24px; line-height: 1.8;
  }
</style>
</head>
<body>
<div class="app">
  <div class="toolbar">
    <span class="sig" id="sigName">—</span>
    <span class="stats" id="stats"></span>
    <span class="stats" id="clipped"></span>
    <span class="spacer"></span>
    <span class="hops">
      <span class="lbl">跳数</span>
      <button data-act="hops" data-hops="1" title="只看与信号直接相连的模块">1</button>
      <button data-act="hops" data-hops="2" title="往外看两层">2</button>
      <button data-act="hops" data-hops="3" title="往外看三层">3</button>
      <button data-act="hops" data-hops="0" title="不做裁剪，显示完整关联图">全部</button>
    </span>
    <span class="sep"></span>
    <button data-act="fit" title="缩放到适应窗口">适应</button>
    <button data-act="zoom-in" title="放大">+</button>
    <button data-act="zoom-out" title="缩小">−</button>
    <button data-act="lr" id="btnLR" title="横向布局：上游在左，下游在右">横向</button>
    <button data-act="td" id="btnTD" title="纵向布局：上游在上，下游在下">纵向</button>
    <button data-act="side" id="btnSide" title="显示/隐藏信号清单">信号清单</button>
    <button data-act="frames" id="btnFrames" class="on2"
            title="同一父模块下的兄弟实例用虚线框圈起来（体现包含关系与同层次）">层次框</button>
    <button data-act="svg" title="导出为 SVG 文件">导出 SVG</button>
  </div>

  <div class="legend">
    <span class="chip"><span class="dot start"></span>起点模块</span>
    <span class="chip"><span class="dot up"></span>上游（信号从这来）</span>
    <span class="chip"><span class="dot down"></span>下游（信号去这）</span>
    <span class="chip"><span class="dot rename"></span>此处改名</span>
    <span class="chip"><span class="dot black"></span>未索引 / IP 黑盒</span>
    <span class="chip"><span class="dot frame"></span>同一父模块下的兄弟实例（层次框）</span>
    <span class="chip">方块下方为真实例化名 · 点击跳源码 · 双击在树视图里定位</span>
  </div>

  <div class="main">
    <div class="canvas" id="canvas">
      <svg id="svg">
        <defs>
          <!--
            markerUnits="userSpaceOnUse"：箭头尺寸固定为 6 个用户单位，
            不再随线宽放大（重边/改名边线更粗，之前会把箭头一起撑大顶住方块）。
            用户单位随视图缩放，所以缩放时箭头与图形保持等比。
          -->
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
                  markerUnits="userSpaceOnUse" markerWidth="6" markerHeight="6"
                  orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path>
          </marker>
          <marker id="arrowWarn" viewBox="0 0 10 10" refX="9" refY="5"
                  markerUnits="userSpaceOnUse" markerWidth="6" markerHeight="6"
                  orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--c-warn)"></path>
          </marker>
        </defs>
        <g id="viewport">
          <g id="gFrames"></g>
          <g id="gEdges"></g>
          <g id="gNodes"></g>
        </g>
      </svg>
      <div class="tip" id="tip"></div>
    </div>
    <div class="side" id="side">
      <div class="side-head">
        <span>信号清单</span>
        <span id="sideCount"></span>
        <span class="sp2"></span>
        <button id="sideClose" title="收起">\\u00d7</button>
      </div>
      <div class="side-list" id="sideList"></div>
    </div>
  </div>
</div>

<script nonce="${nonce}">
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var vscode = acquireVsCodeApi();

  var svg = document.getElementById('svg');
  var viewport = document.getElementById('viewport');
  var gEdges = document.getElementById('gEdges');
  var gNodes = document.getElementById('gNodes');
  var gFrames = document.getElementById('gFrames');
  var framesOn = true;
  var tip = document.getElementById('tip');
  var statsEl = document.getElementById('stats');
  var sigEl = document.getElementById('sigName');
  var btnLR = document.getElementById('btnLR');
  var btnTD = document.getElementById('btnTD');

  var state = null;
  var view = { x: 0, y: 0, k: 1 };

  function el(name, attrs, cls) {
    var e = document.createElementNS(NS, name);
    if (attrs) { for (var k in attrs) { e.setAttribute(k, attrs[k]); } }
    if (cls) { e.setAttribute('class', cls); }
    return e;
  }

  function truncate(s, n) {
    if (!s) { return ''; }
    return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s;
  }

  function applyView() {
    viewport.setAttribute('transform',
      'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
  }

  function fit() {
    if (!state) { return; }
    var w = svg.clientWidth || 800;
    var h = svg.clientHeight || 600;
    var gw = state.layout.width;
    var gh = state.layout.height;
    var k = Math.min((w - 32) / gw, (h - 32) / gh);
    view.k = Math.max(0.12, Math.min(1.15, k));
    view.x = (w - gw * view.k) / 2;
    view.y = (h - gh * view.k) / 2;
    applyView();
  }

  function zoomAt(cx, cy, factor) {
    var k2 = Math.max(0.08, Math.min(4, view.k * factor));
    var r = k2 / view.k;
    view.x = cx - (cx - view.x) * r;
    view.y = cy - (cy - view.y) * r;
    view.k = k2;
    applyView();
  }

  // ---------------------------------------------------------------- 渲染
  function render(payload) {
    var sameSignal = !!(state && state.graph && payload.graph
      && state.graph.signalName === payload.graph.signalName);
    state = payload;
    gNodes.textContent = '';
    gEdges.textContent = '';
    gFrames.textContent = '';

    var g = payload.graph;
    var lay = payload.layout;

    var nodeById = {};
    g.nodes.forEach(function (n) { nodeById[n.id] = n; });
    var edgeById = {};
    g.edges.forEach(function (e) { edgeById[e.id] = e; });

    sigEl.textContent = g.signalName;
    var mergedNote = (payload.totalEdges && payload.totalEdges > g.stats.edges)
      ? '（原 ' + payload.totalEdges + ' 条，已合并同向连接）'
      : '';
    statsEl.textContent = g.stats.nodes + ' 个模块 · ' + g.stats.edges + ' 条连线 · '
      + g.stats.renames + ' 处改名' + mergedNote;

    btnLR.className = payload.direction === 'LR' ? 'on' : '';
    btnTD.className = payload.direction === 'TD' ? 'on' : '';

    var hopBtns = document.querySelectorAll('button[data-hops]');
    for (var hi = 0; hi < hopBtns.length; hi++) {
      var hv = Number(hopBtns[hi].dataset.hops);
      hopBtns[hi].className = (hv === Number(payload.hops)) ? 'on' : '';
    }
    var clipped = payload.totalNodes && payload.totalNodes > g.stats.nodes;
    var clippedEl = document.getElementById('clipped');
    if (clipped) {
      clippedEl.textContent = '（裁剪自 ' + payload.totalNodes + ' 个模块 / ' + payload.totalEdges + ' 条连线）';
    } else {
      clippedEl.textContent = '';
    }

    // ---- 层次框（最底层：圈出同一父模块下的兄弟实例）----
    renderFrames(payload.frames);

    // ---- 边（先画，压在节点下面）----
    lay.edges.forEach(function (le) {
      var meta = edgeById[le.id];
      if (!meta) { return; }
      var cls = 'edge' + (meta.renamed ? ' rename' : '') + (le.back ? ' back' : '');
      var ge = el('g', null, cls);
      ge.dataset.from = le.from;
      ge.dataset.to = le.to;

      var hit = el('path', { d: le.path }, 'hit');
      var line = el('path', { d: le.path, 'marker-end': meta.renamed ? 'url(#arrowWarn)' : 'url(#arrow)' }, 'line');
      ge.appendChild(hit);
      ge.appendChild(line);

      var lbl = meta.fromNet === meta.toNet
        ? meta.fromNet
        : (meta.fromNet + ' \\u2192 ' + meta.toNet);
      if (meta.count && meta.count > 1) { lbl += ' \\u00d7' + meta.count; }
      var t = el('text', { x: le.labelX, y: le.labelY - 4 }, 'elabel');
      t.textContent = truncate(lbl, 34);
      ge.appendChild(t);

      hit.addEventListener('mousemove', function (ev) { showEdgeTip(ev, meta); });
      hit.addEventListener('mouseleave', hideTip);
      hit.addEventListener('click', function () {
        single(function () { vscode.postMessage({ type: 'openEdge', id: meta.id }); });
      });
      hit.addEventListener('dblclick', function () {
        dbl(function () { vscode.postMessage({ type: 'revealTree', kind: 'edge', id: meta.id }); });
      });
      adjustMarker(line, meta);
      gEdges.appendChild(ge);
    });

    // ---- 节点 ----
    lay.nodes.forEach(function (ln) {
      var n = nodeById[ln.id];
      if (!n) { return; }

      var cls = 'node';
      if (n.isStart) { cls += ' start'; }
      else if (ln.column < 0) { cls += ' up'; }
      if (n.blackbox) { cls += ' blackbox'; }
      else if (n.flags && n.flags.indexOf('partial') >= 0) { cls += ' uncertain'; }

      var gn = el('g', null, cls);
      gn.dataset.id = n.id;

      var rect = el('rect', {
        x: ln.x, y: ln.y, width: ln.width, height: ln.height, rx: 9
      });
      gn.appendChild(rect);

      /**
       * 方块文字最多三行：模块名 / 真实例化名 / 进出信号。
       * 例化名这一行是关键 —— 框图节点是模块级的，只有写出"它是被哪个实例引进来的"，
       * 才谈得上"按实际例化调用"来看层次。
       */
      var textRows = [];
      textRows.push({ text: truncate(n.moduleName, 24), cls: 'ttl' });
      if (n.instanceName) {
        textRows.push({ text: '实例 ' + truncate(n.instanceName, 20), cls: 'inst' });
      }
      if (n.inNets.length || n.outNets.length) {
        var bits = [];
        if (n.inNets.length) { bits.push('\\u2190 ' + truncate(n.inNets.join(', '), 18)); }
        if (n.outNets.length) { bits.push('\\u2192 ' + truncate(n.outNets.join(', '), 18)); }
        textRows.push({ text: bits.join('   '), cls: 'sub' });
      }
      var spanY = (textRows.length - 1) * 12;
      var baseY = ln.y + ln.height / 2 - spanY / 2 + 4;
      textRows.forEach(function (row, ri) {
        var t = el('text', {
          x: ln.x + ln.width / 2, y: baseY + ri * 12, 'text-anchor': 'middle'
        }, row.cls);
        t.textContent = row.text;
        gn.appendChild(t);
      });

      if (n.isStart) {
        var b = el('text', { x: ln.x + 8, y: ln.y + 13 }, 'badge');
        b.textContent = '起点';
        gn.appendChild(b);
      }
      if (n.hits > 1) {
        var h = el('text', {
          x: ln.x + ln.width - 8, y: ln.y + 13, 'text-anchor': 'end'
        }, 'badge');
        h.textContent = '\\u00d7' + n.hits;
        gn.appendChild(h);
      }

      gn.addEventListener('mousemove', function (ev) { showNodeTip(ev, n); });
      gn.addEventListener('mouseleave', hideTip);
      gn.addEventListener('click', function () {
        single(function () { vscode.postMessage({ type: 'openNode', id: n.id }); });
      });
      gn.addEventListener('dblclick', function () {
        dbl(function () { vscode.postMessage({ type: 'revealTree', kind: 'node', id: n.id }); });
      });

      gn.addEventListener('mouseenter', function () { highlight(n.id); });
      gn.addEventListener('mouseleave', function () { highlight(null); });

      gNodes.appendChild(gn);
    });

    buildSide(payload);

    // 同一根信号（比如只是调整跳数）不要重置用户调好的视角
    if (!sameSignal) { fit(); }
  }

  /** 层次框：同一父模块下的兄弟实例 */
  function renderFrames(frames) {
    if (!frames || frames.length === 0) { return; }
    frames.forEach(function (f) {
      var g = el('g', null, 'frame');
      g.appendChild(el('rect', {
        x: f.x, y: f.y, width: f.width, height: f.height, rx: 8
      }));
      var names = f.instanceNames || [];
      var label = f.container + ' 内的同层实例：' + names.join(', ')
        + (names.length >= 6 ? ' …' : '');
      var t = el('text', { x: f.x + 8, y: f.y + 13 }, 'flabel');
      t.textContent = truncate(label, 52);
      g.appendChild(t);
      gFrames.appendChild(g);
    });
    gFrames.style.display = framesOn ? '' : 'none';
  }

  /**
   * 信号清单：链路上出现过的所有网络名，点击即以该信号为起点重新追踪。
   * 这是"图上看不全 → 换一根继续看"的最短路径。
   */
  function buildSide(payload) {
    var list = document.getElementById('sideList');
    var countEl = document.getElementById('sideCount');
    if (!list) { return; }
    list.textContent = '';

    var seen = {};
    var order = [];
    function bump(name, renamed) {
      if (!name) { return; }
      if (seen[name] === undefined) { seen[name] = { n: name, c: 0, renamed: false }; order.push(name); }
      seen[name].c++;
      if (renamed) { seen[name].renamed = true; }
    }
    var g = payload.graph;
    g.edges.forEach(function (e) {
      bump(e.fromNet, e.renamed);
      bump(e.toNet, e.renamed);
    });
    g.nodes.forEach(function (n) {
      (n.inNets || []).forEach(function (x) { bump(x, false); });
      (n.outNets || []).forEach(function (x) { bump(x, false); });
    });
    order.sort(function (a, b) { return seen[b].c - seen[a].c || a.localeCompare(b); });

    if (countEl) { countEl.textContent = '(' + order.length + ')'; }

    order.forEach(function (name) {
      var info = seen[name];
      var row = document.createElement('div');
      row.className = 'sig-item' + (info.renamed ? ' rename' : '');
      var nm = document.createElement('span');
      nm.className = 'n';
      nm.textContent = name;
      nm.title = name + (info.renamed ? '（在链路中发生过改名）' : '');
      var c = document.createElement('span');
      c.className = 'c';
      c.textContent = '\\u00d7' + info.c;
      row.appendChild(nm);
      row.appendChild(c);
      if (name !== g.signalName) {
        row.addEventListener('click', function () {
          vscode.postMessage({ type: 'traceNet', net: name, module: g.startModule });
        });
      } else {
        row.title = '当前追踪的信号';
      }
      list.appendChild(row);
    });
  }

  /** 改名边不能复用默认箭头颜色，单独加一个 marker */
  function adjustMarker(line, meta) {
    if (!meta.renamed) { return; }
    // 已经通过 marker-end=#arrowWarn 处理
  }

  // ---------------------------------------------------------------- 高亮
  function highlight(nodeId) {
    var nodeEls = gNodes.querySelectorAll('.node');
    var edgeEls = gEdges.querySelectorAll('.edge');
    if (!nodeId) {
      nodeEls.forEach(function (e) { e.classList.remove('dim'); });
      edgeEls.forEach(function (e) { e.classList.remove('dim'); });
      return;
    }
    nodeEls.forEach(function (e) {
      e.classList.toggle('dim', e.dataset.id !== nodeId);
    });
    edgeEls.forEach(function (e) {
      var on = (e.dataset.from === nodeId || e.dataset.to === nodeId);
      e.classList.toggle('dim', !on);
    });
  }

  // ---------------------------------------------------------------- 提示框
  function placeTip(ev) {
    var box = document.getElementById('canvas').getBoundingClientRect();
    var w = tip.offsetWidth || 240;
    var h = tip.offsetHeight || 80;
    var x = ev.clientX - box.left + 14;
    var y = ev.clientY - box.top + 14;
    if (x + w > box.width - 8) { x = Math.max(4, box.width - w - 8); }
    // 下方放不下就翻到光标上方，避免被裁掉或压住指针下的内容
    if (y + h > box.height - 8) { y = ev.clientY - box.top - h - 10; }
    if (y < 4) { y = 4; }
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function tipLines(rows) {
    tip.textContent = '';
    rows.forEach(function (r) {
      if (!r) { return; }
      var line = document.createElement('div');
      if (r.label) {
        var b = document.createElement('b');
        b.textContent = r.label;
        line.appendChild(b);
        if (r.value) { line.appendChild(document.createTextNode(' ' + r.value)); }
      } else {
        line.textContent = r;
      }
      tip.appendChild(line);
    });
  }

  function showNodeTip(ev, n) {
    var rows = [{ label: n.moduleName }];
    if (n.isStart) { rows.push('信号起点所在模块'); }
    if (n.instanceName) {
      rows.push({
        label: '例化调用:',
        value: n.instanceName + (n.container ? '   （在 ' + n.container + ' 中）' : ''),
      });
    }
    if (n.instances && n.instances.length > 1) {
      rows.push({
        label: '其它例化:',
        value: n.instances.slice(1).map(function (x) {
          return x.instanceName + '（在 ' + x.container + ' 中）';
        }).join('；'),
      });
    }
    if (n.blackbox) { rows.push('未纳入索引（IP / 黑盒），端口方向未知'); }
    if (n.inNets.length) { rows.push({ label: '流入:', value: n.inNets.join(', ') }); }
    if (n.outNets.length) { rows.push({ label: '流出:', value: n.outNets.join(', ') }); }
    if (n.hits > 1) { rows.push('该模块在链路中被经过 ' + n.hits + ' 次'); }
    if (n.file) { rows.push(n.file.replace(/\\\\/g, '/').split('/').slice(-1)[0] + (n.line !== undefined ? ':' + (n.line + 1) : '')); }
    tipLines(rows);
    tip.style.display = 'block';
    placeTip(ev);
  }

  function showEdgeTip(ev, meta) {
    var rows = [];
    rows.push(meta.renamed
      ? { label: '\\u26a0 此处改名:', value: meta.fromNet + ' \\u21d2 ' + meta.toNet }
      : { label: '信号:', value: meta.fromNet });
    rows.push({ label: '端口:', value: meta.port });
    if (meta.instanceName) { rows.push({ label: '经由实例:', value: meta.instanceName }); }
    rows.push({ label: '流向:', value: meta.from + ' \\u2192 ' + meta.to });
    if (meta.count && meta.count > 1) {
      rows.push({ label: '并列连接:', value: meta.count + ' 条' });
      if (meta.allNets && meta.allNets.length) {
        rows.push(meta.allNets.slice(0, 8).join(', ') + (meta.allNets.length > 8 ? ' \\u2026' : ''));
      }
    }
    if (meta.tooltip) { rows.push(meta.tooltip); }
    if (meta.file) {
      rows.push(meta.file.replace(/\\\\/g, '/').split('/').slice(-1)[0] + (meta.line !== undefined ? ':' + (meta.line + 1) : ''));
    }
    rows.push('点击可跳转到连接处');
    tipLines(rows);
    tip.style.display = 'block';
    placeTip(ev);
  }

  function hideTip() { tip.style.display = 'none'; }

  // ---------------------------------------------------------------- 交互
  /**
   * 单击与双击需要区分：单击跳源码，双击在树视图里定位。
   * 用一个小延迟实现，双击时把单击的动作取消掉。
   */
  var clickTimer = null;
  function single(fn) {
    if (clickTimer) { clearTimeout(clickTimer); }
    clickTimer = setTimeout(function () { clickTimer = null; fn(); }, 180);
  }
  function dbl(fn) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    fn();
  }

  function toggleSide(force) {
    var side = document.getElementById('side');
    var on = typeof force === 'boolean' ? force : !side.classList.contains('on');
    side.classList.toggle('on', on);
    var b = document.getElementById('btnSide');
    if (b) { b.className = on ? 'on' : ''; }
  }

  var dragging = false;
  var dragStart = null;

  svg.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0) { return; }
    dragging = true;
    dragStart = { x: ev.clientX - view.x, y: ev.clientY - view.y };
    svg.classList.add('dragging');
  });
  window.addEventListener('mousemove', function (ev) {
    if (!dragging) { return; }
    view.x = ev.clientX - dragStart.x;
    view.y = ev.clientY - dragStart.y;
    applyView();
  });
  window.addEventListener('mouseup', function () {
    dragging = false;
    svg.classList.remove('dragging');
  });

  svg.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var box = svg.getBoundingClientRect();
    var factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(ev.clientX - box.left, ev.clientY - box.top, factor);
  }, { passive: false });

  document.querySelector('.toolbar').addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('button') : null;
    if (!btn) { return; }
    var act = btn.dataset.act;
    if (act === 'hops') { vscode.postMessage({ type: 'hops', value: Number(btn.dataset.hops) }); }
    else if (act === 'fit') { fit(); }
    else if (act === 'zoom-in') { zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.2); }
    else if (act === 'zoom-out') { zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1 / 1.2); }
    else if (act === 'lr') { vscode.postMessage({ type: 'relayout', direction: 'LR' }); }
    else if (act === 'td') { vscode.postMessage({ type: 'relayout', direction: 'TD' }); }
    else if (act === 'side') { toggleSide(); }
    else if (act === 'frames') {
      framesOn = !framesOn;
      gFrames.style.display = framesOn ? '' : 'none';
      document.getElementById('btnFrames').className = framesOn ? 'on2' : '';
    }
    else if (act === 'svg') { exportSvg(); }
  });

  var sideClose = document.getElementById('sideClose');
  if (sideClose) { sideClose.addEventListener('click', function () { toggleSide(false); }); }

  function exportSvg() {
    if (!state) { return; }
    var clone = svg.cloneNode(true);
    // 内联必要的样式，保证导出的 SVG 单独打开也好看
    var st = document.createElementNS(NS, 'style');
    st.textContent = [
      '.node rect{fill:#ffffff;stroke:#888;stroke-width:1.6}',
      '.node.start rect{stroke:#0b6fc2;stroke-width:3}',
      '.node.up rect{stroke:#2e8b57}',
      '.node.blackbox rect{stroke:#b58900;stroke-dasharray:6 4}',
      '.node.uncertain rect{stroke-dasharray:3 3}',
      '.node .ttl{fill:#222;font:600 12.5px sans-serif}',
      '.node .sub{fill:#777;font:10.5px sans-serif}',
      '.node .badge{fill:#0b6fc2;font:700 9.5px sans-serif}',
      '.edge .line{fill:none;stroke:#999;stroke-width:1.8}',
      '.edge.rename .line{stroke:#d18616;stroke-width:2.6}',
      '.edge.back .line{stroke-dasharray:6 4}',
      '.edge .elabel{fill:#333;font:10.5px sans-serif;text-anchor:middle}',
      '.edge.rename .elabel{fill:#d18616;font-weight:600}',
      'text{font-family:sans-serif}'
    ].join('');
    clone.insertBefore(st, clone.firstChild);
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('width', String(state.layout.width));
    clone.setAttribute('height', String(state.layout.height));
    var vp = clone.querySelector('#viewport');
    if (vp) { vp.removeAttribute('transform'); }
    var txt = new XMLSerializer().serializeToString(clone);
    vscode.postMessage({ type: 'exportSvg', svg: txt, name: state.graph.signalName });
  }

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (msg.type === 'render') { render(msg.payload); }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
