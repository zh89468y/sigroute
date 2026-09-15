/**
 * 无依赖语法自检：用 Node 直接加载所有插件源码。
 *
 * 用途：在没有 npm install / 没有 tsc 的环境下，快速确认代码没有语法错误、
 *       模块依赖没有断链。注意它只做"加载"，不做类型检查。
 *
 * 用法：node tools/check.mjs
 */

import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
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
      if (fs.existsSync(cand)) {
        return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const files = [
  'core/types.ts',
  'core/lexer.ts',
  'core/parser.ts',
  'core/inline.ts',
  'core/nets.ts',
  'core/hierarchy.ts',
  'core/cache.ts',
  'core/indexer.ts',
  'core/graph.ts',
  'core/layout.ts',
  'core/describe.ts',
  'core/hover.ts',
  'vscode/export.ts',
  'vscode/fsProvider.ts',
  'vscode/traceTree.ts',
  'vscode/graphHtml.ts',
  'vscode/graphPanel.ts',
  'vscode/mindmapHtml.ts',
  'vscode/mindmapView.ts',
  'vscode/codeLens.ts',
  'vscode/providers.ts',
  'extension.ts',
];

let failed = 0;
console.log('\n=== SigRoute 源码自检 ===\n');

for (const f of files) {
  const full = path.join(srcDir, f);
  if (!fs.existsSync(full)) {
    console.log(`SKIP  ${f}  (文件不存在)`);
    continue;
  }
  try {
    await import(pathToFileURL(full).href);
    console.log(`OK    ${f}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${f}`);
    console.log(`      ${err.message}`);
    if (err.stack) {
      const line = err.stack.split('\n').slice(0, 4).join('\n      ');
      console.log(`      ${line}`);
    }
  }
}

console.log('');
if (failed > 0) {
  console.error(`自检失败：${failed} 个文件无法加载。\n`);
  process.exit(1);
}
console.log('自检通过：全部模块加载正常。\n');
