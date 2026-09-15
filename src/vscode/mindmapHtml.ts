/**
 * 脑图视图的前端资源（HTML + CSS + 内联 JS）
 *
 * 画法：**竖向缩进**（根在最上，逐层向下缩进）。
 *
 * 为什么不是"中间一个根、左右发散"的辐射式：
 * 这个视图住在资源管理器侧栏里（宽度通常只有两三百像素），
 * 辐射式需要横向空间，塞进去只会看到几个挤在一起的方块 —— 实测确实不可用。
 * 竖向布局把宽度让给文字、把长度交给纵向滚动，窄栏里才能真正读。
 *
 * 交互与树视图一致：点行跳源码、点开关折叠、悬停给完整信息（含别名/关系）。
 * 内联 JS 里不使用模板字符串，避免与 TS 模板字符串冲突。
 */

import type * as vscode from 'vscode';

export function renderMindmapHtml(webview: vscode.Webview, nonce: string): string {
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
    --c-black: var(--vscode-charts-yellow, #cca700);
    --hover: var(--vscode-list-hoverBackground, #2a2d2e);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
    font-size: 12px;
  }
  .app { display: flex; flex-direction: column; height: 100%; }
  .bar {
    display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
    padding: 4px 6px; border-bottom: 1px solid var(--line); flex: 0 0 auto;
  }
  .bar .sig { font-weight: 600; }
  .bar .stats { color: var(--dim); font-size: 11px; }
  .bar .sp { flex: 1 1 auto; }
  .bar button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: none; border-radius: 4px; padding: 2px 7px; cursor: pointer;
    font-size: 11px; font-family: inherit;
  }
  .bar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }

  .canvas { flex: 1 1 auto; overflow: auto; position: relative; }
  svg { display: block; }

  .row { cursor: pointer; }
  .row .hl { fill: transparent; }
  .row:hover .hl { fill: var(--hover); }
  .row text { user-select: none; pointer-events: none; }
  .row .lbl { font-size: 11.5px; fill: var(--fg); }
  .row .sub { font-size: 10px; fill: var(--dim); }
  .row .chev { fill: var(--dim); font-size: 10px; cursor: pointer; pointer-events: all; }
  .row .chev:hover { fill: var(--fg); }
  .row.up .lbl { fill: var(--c-up); }
  .row.down .lbl { fill: var(--c-down); }
  .row.start .lbl { fill: var(--c-start); font-weight: 700; }
  .row.rename .lbl { fill: var(--c-warn); font-weight: 700; }
  .row.blackbox .lbl { fill: var(--c-black); }
  .row.more .lbl { fill: var(--c-warn); }
  .row .dot { pointer-events: none; }

  .edge { fill: none; stroke: var(--line); stroke-width: 1.2; }
  .edge.up { stroke: var(--c-up); opacity: 0.7; }
  .edge.down { stroke: var(--c-down); opacity: 0.7; }
  .edge.rename { stroke: var(--c-warn); stroke-width: 1.9; }
  .edge.more { stroke: var(--c-warn); stroke-dasharray: 3 2; }

  .tip {
    position: fixed; pointer-events: none; z-index: 10;
    /* 侧栏很窄：宽度跟着视图走，否则会被"挤"到左边盖住信号本身 */
    max-width: min(320px, calc(100vw - 12px));
    padding: 6px 8px; border-radius: 5px;
    background: var(--vscode-editorHoverWidget-background, #252526);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    color: var(--vscode-editorHoverWidget-foreground, #ccc);
    box-shadow: 0 2px 10px rgba(0,0,0,.35);
    display: none; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }
</style>
</head>
<body>
<div class="app">
  <div class="bar">
    <span class="sig" id="sig">—</span>
    <span class="stats" id="stats"></span>
    <span class="sp"></span>
    <button id="resetView" title="回到默认：只展开直接关联的两层">默认</button>
    <button id="expandAll" title="展开所有折叠的分支">展开</button>
    <button id="collapseAll" title="只留下起点与上下游分组">折叠</button>
    <button id="btnSvg" title="导出为 SVG（可插入设计文档）">导出</button>
  </div>
  <div class="canvas" id="canvas">
    <svg id="svg" xmlns="http://www.w3.org/2000/svg">
      <g id="gE"></g>
      <g id="gN"></g>
    </svg>
  </div>
</div>
<div class="tip" id="tip"></div>

<script nonce="${nonce}">
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var vscode = acquireVsCodeApi();

  var canvas = document.getElementById('canvas');
  var svg = document.getElementById('svg');
  var gE = document.getElementById('gE');
  var gN = document.getElementById('gN');
  var tip = document.getElementById('tip');
  var sigEl = document.getElementById('sig');
  var statsEl = document.getElementById('stats');

  var ROW = 22;        // 行高
  var PADX = 8;
  var PADY = 6;
  var CHAR = 6.35;     // 等宽近似：一个字符占多少像素
  var MIN_INDENT = 9;
  var MAX_INDENT = 16;

  var state = null;
  var model = null;
  var rows = [];
  var seq = 0;
  var collapsed = {};

  function el(name, attrs, cls) {
    var e = document.createElementNS(NS, name);
    if (attrs) { for (var k in attrs) { e.setAttribute(k, attrs[k]); } }
    if (cls) { e.setAttribute('class', cls); }
    return e;
  }
  function truncate(s, n) {
    if (!s) { return ''; }
    return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '\\u2026' : s;
  }
  function textWidth(s) { return (s ? s.length : 0) * CHAR; }
  function charsFor(px) { return Math.floor(Math.max(0, px) / CHAR); }

  /**
   * 给节点编号 + 稳定的折叠键。
   *
   * 折叠状态必须用**结构性**的键（子节点下标路径）而不是遍历序号：
   * 点"继续展开"会让扩展层重新跑一次追踪、重建整棵树，
   * 用遍历序号的话用户手动折叠的位置会全部错位。
   */
  function assignKeys(node, key) {
    node.id = seq++;
    node._key = key;
    if (!node.children) { node.children = []; }
    for (var i = 0; i < node.children.length; i++) {
      assignKeys(node.children[i], key + '/' + i);
    }
  }

  /**
   * 默认折叠：与树视图一致的"先看两层"策略 ——
   * 起点 / 上下游分组 / 直接关联的那一层展开，再下一层先收起，
   * 需要时再手动点开（否则一屏几十行会把真正关心的几条淹掉）。
   * 只有一个子节点的链路自动展开，避免一路都是没有信息量的一次点击。
   */
  function defaultCollapse(node, depth) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      var kids = c.children ? c.children.length : 0;
      var keepOpen = depth < 2 || kids === 1;
      collapsed[c._key] = !keepOpen;
      defaultCollapse(c, depth + 1);
    }
  }

  /** 折叠状态下的最大深度（决定缩进宽度） */
  function maxDepth(node) {
    if (collapsed[node._key]) { return 0; }
    var best = 0;
    for (var i = 0; i < node.children.length; i++) {
      best = Math.max(best, 1 + maxDepth(node.children[i]));
    }
    return best;
  }

  /** 生成行表（DFS 顺序 = 视觉顺序） */
  function layout(indent) {
    rows = [];
    var walk = function (node, depth, parent) {
      node._x = PADX + depth * indent;
      node._y = PADY + rows.length * ROW;
      node._parent = parent;
      node._depth = depth;
      rows.push(node);
      if (collapsed[node._key]) { return; }
      for (var i = 0; i < node.children.length; i++) {
        walk(node.children[i], depth + 1, node);
      }
    };
    walk(model.root, 0, null);
    model.height = PADY * 2 + rows.length * ROW;
  }

  function draw(keepScroll) {
    var scrollTop = canvas.scrollTop;
    var viewW = canvas.clientWidth || 240;
    var depth = maxDepth(model.root);
    // 缩进随深度自适应：宁可小一点，也不要横向滚动条
    var indent = MAX_INDENT;
    if (depth > 0) {
      indent = Math.floor((viewW - 170) / depth);
      if (indent > MAX_INDENT) { indent = MAX_INDENT; }
      if (indent < MIN_INDENT) { indent = MIN_INDENT; }
    }
    layout(indent);
    var width = Math.max(viewW, PADX * 2 + indent * depth + 150);
    model.W = width;
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(model.height));

    gE.textContent = '';
    gN.textContent = '';
    rows.forEach(drawRow);

    if (!keepScroll) { canvas.scrollTop = 0; }
    else { canvas.scrollTop = scrollTop; }
  }

  function edgeCls(n) {
    var c = 'edge';
    if (n.more) { c += ' more'; }
    else if (n.renamed) { c += ' rename'; }
    else if (n.kind === 'signal') { c += n.upstream ? ' up' : ' down'; }
    return c;
  }

  function rowCls(n) {
    var c = 'row';
    if (n.more) { c += ' more'; }
    else if (n.renamed) { c += ' rename'; }
    else if (n.isStart) { c += ' start'; }
    else if (n.blackbox) { c += ' blackbox'; }
    else if (n.kind === 'signal') { c += n.upstream ? ' up' : ' down'; }
    return c;
  }

  function dotColor(n) {
    if (n.more) { return 'var(--c-warn)'; }
    if (n.renamed) { return 'var(--c-warn)'; }
    if (n.isStart) { return 'var(--c-start)'; }
    if (n.blackbox) { return 'var(--c-black)'; }
    if (n.kind === 'signal') { return n.upstream ? 'var(--c-up)' : 'var(--c-down)'; }
    if (n.kind === 'constant') { return 'var(--dim)'; }
    if (n.kind === 'unconnected') { return 'var(--c-warn)'; }
    return 'var(--dim)';
  }

  function drawRow(n) {
    var cy = n._y + ROW / 2;

    // ---- 连接线：父行中心 → 竖向走到本行 → 横向进本行 ----
    if (n._parent) {
      var px = n._parent._x + 3;
      var py = n._parent._y + ROW / 2;
      var d = 'M ' + px + ' ' + py
        + ' V ' + (cy - 5)
        + ' Q ' + px + ' ' + cy + ' ' + (px + 5) + ' ' + cy
        + ' H ' + (n._x + 1);
      gE.appendChild(el('path', { d: d }, edgeCls(n)));
    }

    // ---- 行本体 ----
    var g = el('g', null, rowCls(n));
    g.appendChild(el('rect', { x: 0, y: n._y, width: model.W, height: ROW, rx: 3 }, 'hl'));

    // 折叠开关（有子节点才画）
    var kids = n.children ? n.children.length : 0;
    if (kids > 0 || n.more) {
      var chev = el('text', { x: n._x, y: cy + 3.4, 'text-anchor': 'middle' }, 'chev');
      chev.textContent = n.more ? '+' : (collapsed[n._key] ? '\\u25b8' : '\\u25be');
      chev.addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggle(n);
      });
      g.appendChild(chev);
    }

    // 方向色点
    g.appendChild(el('circle', { cx: n._x + 14, cy: cy, r: 2.6, fill: dotColor(n), class: 'dot' }));

    // 文案
    var tx = n._x + 21;
    var room = model.W - tx - 12;
    if (n.more) {
      var t0 = el('text', { x: tx, y: cy + 4 }, 'lbl');
      t0.textContent = truncate(n.label, charsFor(room));
      g.appendChild(t0);
      g.addEventListener('click', function () { openNode(n); });
    } else {
      var keepRoom = n.sub ? Math.min(room * 0.62, 150) : room;
      var label = truncate(n.label, charsFor(keepRoom));
      var lbl = el('text', { x: tx, y: cy + 4 }, 'lbl');
      lbl.textContent = label;
      g.appendChild(lbl);

      var used = tx + textWidth(label) + 8;
      if (n.sub && model.W - used > 46) {
        var st = el('text', { x: used, y: cy + 4 }, 'sub');
        st.textContent = truncate(n.sub, charsFor(model.W - used - 8));
        g.appendChild(st);
        used += textWidth(st.textContent);
      }
      if (collapsed[n._key] && kids > 0 && model.W - used > 30) {
        var ct = el('text', { x: used + 4, y: cy + 4 }, 'sub');
        ct.textContent = '(+' + kids + ')';
        g.appendChild(ct);
      }

      g.addEventListener('click', function () { openNode(n); });
    }

    g.addEventListener('mousemove', function (ev) { showTip(ev, n); });
    g.addEventListener('mouseleave', hideTip);
    gN.appendChild(g);
  }

  function openNode(n) {
    if (n.more && n.expandKey) {
      vscode.postMessage({ type: 'expand', key: n.expandKey });
      return;
    }
    if (n.file && n.line !== undefined) {
      vscode.postMessage({ type: 'reveal', file: n.file, line: n.line, offset: n.offset, label: n.label });
    }
  }

  function toggle(n) {
    if (n.more) { openNode(n); return; }
    collapsed[n._key] = !collapsed[n._key];
    draw(true);
  }

  function allCollapsed(node, keepDepth, depth) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      collapsed[c._key] = keepDepth ? depth >= 1 : false;
      allCollapsed(c, keepDepth, depth + 1);
    }
  }

  // ---------------------------------------------------------------- 提示
  function showTip(ev, n) {
    var lines = [n.label];
    if (n.edgeText) { lines.push('关系: ' + n.edgeText); }
    if (n.description) { lines.push('位置: ' + n.description); }
    if (n.aliases && n.aliases.length) { lines.push('同网络别名: ' + n.aliases.join(', ')); }
    if (n.tooltip) { lines.push(n.tooltip); }
    if (n.pendingCount !== undefined) { lines.push('还有 ' + n.pendingCount + ' 个分支，点击本行展开'); }
    if (n.file) { lines.push('点击跳转到源码'); }
    tip.textContent = lines.filter(Boolean).join('\\n');
    tip.style.display = 'block';

    var vw = window.innerWidth || 320;
    var vh = window.innerHeight || 400;
    var w = tip.offsetWidth || 220;
    var h = tip.offsetHeight || 60;
    var gap = 12;
    var away = ROW / 2 + 6; // 竖向避让：不要压住当前悬停的这一行

    // 优先放在光标的右下方；右边放不下就贴着右边界，但**不会往左盖住信号行**
    var x = ev.clientX + gap;
    var y = ev.clientY + away;
    if (x + w > vw - 6) { x = Math.max(6, vw - w - 6); }
    if (y + h > vh - 6) { y = ev.clientY - away - h; } // 下方不够就翻到上方
    if (y < 4) { y = Math.max(4, Math.min(vh - h - 4, ev.clientY + away)); }
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }

  // ---------------------------------------------------------------- 渲染入口
  function render(payload) {
    var sameSignal = !!(state && payload.signalName && state.signalName === payload.signalName);
    state = payload;
    model = payload.mind;
    seq = 0;
    assignKeys(model.root, 'r');
    if (!sameSignal) {
      // 换了信号：回到"只看两层"的默认状态
      collapsed = {};
      defaultCollapse(model.root, 0);
    }
    // 同一根信号（点继续展开 / 重新追踪）保留用户手动折叠出来的形状
    sigEl.textContent = payload.signalName || '—';
    statsEl.textContent = payload.stats || '';
    draw(sameSignal);
  }

  document.getElementById('resetView').addEventListener('click', function () {
    if (!model) { return; }
    collapsed = {};
    defaultCollapse(model.root, 0);
    draw(false);
  });
  document.getElementById('expandAll').addEventListener('click', function () {
    if (!model) { return; }
    // 整表重建而不是逐个置 false：连根节点的折叠状态一起清掉
    collapsed = {};
    draw(true);
  });
  document.getElementById('collapseAll').addEventListener('click', function () {
    if (!model) { return; }
    collapsed = {};
    allCollapsed(model.root, true, 0);
    draw(true);
  });
  document.getElementById('btnSvg').addEventListener('click', exportSvg);

  function exportSvg() {
    if (!model) { return; }
    var clone = svg.cloneNode(true);
    var st = document.createElementNS(NS, 'style');
    st.textContent = [
      '.row .lbl{fill:#222;font:11.5px sans-serif}',
      '.row .sub{fill:#777;font:10px sans-serif}',
      '.row .chev{fill:#888;font:10px sans-serif}',
      '.row.start .lbl{fill:#0b6fc2;font-weight:700}',
      '.row.rename .lbl{fill:#d18616;font-weight:700}',
      '.row.up .lbl{fill:#2e8b57}',
      '.row.down .lbl{fill:#7a4bb5}',
      '.row.blackbox .lbl{fill:#b58900}',
      '.row.more .lbl{fill:#d18616}',
      '.edge{fill:none;stroke:#bbb;stroke-width:1.2}',
      '.edge.up{stroke:#2e8b57}',
      '.edge.down{stroke:#7a4bb5}',
      '.edge.rename{stroke:#d18616;stroke-width:1.9}',
      '.edge.more{stroke:#d18616;stroke-dasharray:3 2}'
    ].join('');
    clone.insertBefore(st, clone.firstChild);
    clone.setAttribute('width', String(model.W));
    clone.setAttribute('height', String(model.height));
    var txt = new XMLSerializer().serializeToString(clone);
    vscode.postMessage({ type: 'exportSvg', svg: txt, name: (state.signalName || 'signal') });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (!model) { return; }
    if (resizeTimer) { clearTimeout(resizeTimer); }
    resizeTimer = setTimeout(function () { draw(true); }, 120);
  });

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (msg && msg.type === 'render') { render(msg.payload); }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
