/**
 * 一键生成可分发安装的 vsix。
 *
 * 做两件事：
 *   1. 编译（tsc）
 *   2. 用 vsce 打包 dist/sigroute-<version>.vsix
 *
 * 用法：node tools/build-dist.mjs
 *
 * vsce 的定位顺序：本地 node_modules → npx 缓存（避免每次重新下载）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
process.chdir(root);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const vsixName = `sigroute-${version}.vsix`;

const log = (m) => console.log(`  ${m}`);
const step = (m) => console.log(`\n[${m}]`);

/**
 * Windows 上 npm / vsce 实际都是 .cmd，必须过 shell 才能执行。
 * 用「整串命令」而不是「shell + 参数数组」，可以避开 Node 的 DEP0190 警告。
 */
function run(cmd, args) {
  const quot = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
  const line = [cmd, ...args].map(quot).join(' ');
  const r = spawnSync(line, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`\n命令失败：${line}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 1. 编译
step('编译');
run('npm', ['run', 'compile']);

// ---------------------------------------------------------------- 2. 定位 vsce
step('定位 vsce');
function findVsce() {
  const exts = process.platform === 'win32' ? ['.cmd', '.ps1', ''] : [''];
  const candidates = [];

  // 本地 node_modules
  for (const e of exts) {
    candidates.push(path.join(root, 'node_modules', '.bin', `vsce${e}`));
  }

  // npx 缓存（_npx/<hash>/node_modules/.bin/vsce）
  const npxRoot = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.HOME || '', '.npm'),
    'npm-cache',
    '_npx',
  );
  if (fs.existsSync(npxRoot)) {
    for (const hash of fs.readdirSync(npxRoot)) {
      for (const e of exts) {
        candidates.push(path.join(npxRoot, hash, 'node_modules', '.bin', `vsce${e}`));
      }
    }
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const vsce = findVsce();
if (!vsce) {
  console.error(
    '\n找不到 vsce。请先执行一次：\n  npx @vscode/vsce package\n之后会缓存下来，本脚本即可直接复用。',
  );
  process.exit(1);
}
log(`vsce: ${vsce}`);

// ---------------------------------------------------------------- 3. 打包 vsix
step('打包 vsix');
fs.mkdirSync('dist', { recursive: true });
const vsixPath = path.join('dist', vsixName);
// 先清掉上一轮的产物，否则它们会被 vsce 当成源码一起打进 vsix（套娃）
fs.rmSync(vsixPath, { force: true });
run(vsce, ['package', '--out', vsixPath]);

const vsixSize = fs.statSync(vsixPath).size;
log(`${vsixName}  ${(vsixSize / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------- 4. 结果
console.log(`
完成：${vsixPath}   (${(vsixSize / 1024).toFixed(1)} KB)

把 ${vsixName} 拷到目标电脑即可安装（无需任何其它文件）：
  · VS Code → 扩展面板 (Ctrl+Shift+X) → 右上角 "..." → 从 VSIX 安装
  · 或直接双击 ${vsixName}（若 .vsix 已关联 VS Code）
  · 或命令行   code --install-extension ${vsixName}
`);
