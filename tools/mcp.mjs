/**
 * SigRoute MCP 服务（stdio，零依赖）
 *
 * 干什么用：把 tools/ai.mjs 里那套"跨模块信号链路"能力挂到 AI agent 上。
 *   AI 读 RTL 时最贵的是这几个问题 —— 这根信号从哪来、到哪去、穿过了谁、在哪儿改了名。
 *   有了它，agent 不用 grep 十几个文件再自己拼链路，一次工具调用就能拿到准确结论
 *   （路径、行号、改名点、等价类都和 VSCode 插件里显示的完全一致，因为共用 src/core）。
 *
 * 为什么不引 @modelcontextprotocol/sdk：
 *   这个仓库的规矩是零依赖、不 npm install 也能跑。MCP 的 stdio 形态本质就是
 *   "一行一个 JSON-RPC 2.0 消息"，自己实现比拉一棵依赖树更稳、更好审计。
 *
 * 用法（客户端配置样例，Windows 路径照抄即可）：
 *   {
 *     "mcpServers": {
 *       "sigroute": {
 *         "command": "node",
 *         "args": ["<仓库路径>/tools/mcp.mjs", "--root", "<你的 RTL 工程目录>"]
 *       }
 *     }
 *   }
 *   把上面这段直接打出来：node tools/mcp.mjs --print-config --root <工程目录>
 *
 * 参数：--root <目录>（也可用环境变量 SIGROUTE_ROOT，默认当前目录）
 *       --scope <子目录> / --defines a,b / --undefines a,b / --no-ifdef
 *
 * 约定：行号一律 1 起，路径相对工程根。stdout 只走 JSON-RPC，日志一律走 stderr。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolRegistry } from './ai.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 支持的协议版本（客户端报哪个就回哪个，认不出就回最保守的那个） */
const KNOWN_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const FALLBACK_PROTOCOL = '2024-11-05';

function parseArgv(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-ifdef') flags.honorIfdef = false;
    else if (a === '--print-config') flags.printConfig = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[key] = val;
    }
  }
  return flags;
}

const flags = parseArgv(process.argv.slice(2));

const USAGE = `SigRoute MCP 服务（stdio）

用法：
  node tools/mcp.mjs                        作为 MCP 服务启动：默认跟随客户端打开的工作区（MCP roots）
  node tools/mcp.mjs --root <RTL 工程目录>   同上，并把它作为默认工程根（不指定也能用）
  node tools/mcp.mjs --print-config          打印客户端配置片段
  node tools/mcp.mjs --help                  看这页

多工程：本服务**不绑定**某一个工程 ——
  · 默认根 = 客户端声明的工作区（问不到时退回 --root / 当前目录）；
  · 任何一次工具调用都可以再传 root=<工程根> 切到别的工程；
  · 各工程各自建索引，LRU 保留最近 4 个，切换不会反复重建。

参数：--scope <子目录> / --defines a,b / --undefines a,b / --no-ifdef
环境：SIGROUTE_ROOT 可代替 --root
`;

if (flags.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// --root 是"默认根"，不是"唯一根"：省略时会跟随客户端声明的工作区（MCP roots），
// 每次工具调用也都可以再传 root=<工程根> 临时切工程。
const explicitRoot = flags.root ?? process.env.SIGROUTE_ROOT;
const root = explicitRoot ? path.resolve(explicitRoot) : null;
if (root && !fs.existsSync(root)) {
  process.stderr.write(`SigRoute MCP: 工程目录不存在: ${root}\n`);
  process.exit(1);
}

if (flags.printConfig) {
  const cfg = {
    mcpServers: {
      sigroute: {
        command: 'node',
        args: [path.join(here, 'mcp.mjs').replace(/\\/g, '/'), '--root', (root ?? process.cwd()).replace(/\\/g, '/')],
      },
    },
  };
  process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
  process.exit(0);
}

let version = '0.0.0';
try {
  version = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version ?? version;
} catch {
  /* 读不到就用占位版本，不影响功能 */
}

const registry = createToolRegistry({
  root: root ?? undefined,
  roots: root ? [root] : [],
  fallbackRoot: process.cwd(),
  scope: flags.scope,
  honorIfdef: flags.honorIfdef,
  defines: typeof flags.defines === 'string' ? flags.defines.split(',').map((s) => s.trim()).filter(Boolean) : [],
  undefines: typeof flags.undefines === 'string' ? flags.undefines.split(',').map((s) => s.trim()).filter(Boolean) : [],
});

const log = (...a) => process.stderr.write(`[sigroute-mcp] ${a.join(' ')}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** 服务端 → 客户端的请求（目前只用来问工作区根：roots/list） */
let reqSeq = 0;
const pending = new Map();
function request(method, params) {
  const id = `sigroute-${++reqSeq}`;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
  });
}

/**
 * 跟随客户端的工作区：MCP 客户端（IDE）会在 initialize 里声明 roots 能力，
 * 允许服务端反问"你打开了哪些工作区"。拿到之后：
 *   - 第一个作为默认工程根（这就是"不绑定具体工程"的正解）；
 *   - 全部记下来，index 会报出来，AI 也能用 root= 显式切换。
 */
async function fetchRoots(why) {
  try {
    const res = await request('roots/list', {});
    const list = (res?.roots ?? [])
      .map((r) => {
        if (typeof r?.uri !== 'string') return null;
        try {
          return r.uri.startsWith('file:') ? fileURLToPath(r.uri) : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (list.length > 0) {
      const roots = registry.setRoots(list);
      log(`跟随客户端工作区(${why}): ${roots.join(', ')}`);
      warm(`工作区 ${why}`);
    } else {
      log(`客户端未声明工作区根(${why})：用 --root 或调用时传 root=`);
    }
  } catch (err) {
    log(`roots/list 失败(${why}): ${err && err.message ? err.message : err}`);
  }
}

/** 预热索引：第一次工具调用就能毫秒级返回 */
function warm(why) {
  void registry.call('index', {}).then(
    () => log(`索引就绪(${why})`),
    (err) => log(`索引预热失败(${why}): ${err && err.message ? err.message : err}`),
  );
}

const writeResult = (id, result, protocol) => {
  const msg = { jsonrpc: '2.0', id, result };
  send(msg);
  return msg;
};
const sendError = (id, code, message, data) => {
  send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });
};

/** 已协商的协议版本（决定要不要给 structuredContent） */
let protocol = FALLBACK_PROTOCOL;
let initialized = false;

async function handle(msg) {
  // 客户端对我们发出去的请求（roots/list 等）的响应：没有 method、带 id 与 result/error
  if (msg && typeof msg.method !== 'string' && msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? '客户端返回错误'));
      else p.resolve(msg.result);
    }
    return undefined;
  }

  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      protocol = KNOWN_PROTOCOLS.includes(asked) ? asked : FALLBACK_PROTOCOL;
      initialized = true;
      log(`initialize: client=${params?.clientInfo?.name ?? '?'} protocol=${asked ?? '?'} → ${protocol}`);
      const reply = writeResult(
        id,
        {
          protocolVersion: protocol,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sigroute', version },
          instructions:
            'SigRoute 提供 RTL 工程的跨模块信号追踪：search 找名字 → describe 看一跳 → trace 看整条链路 → aliases 反查改名 → module 看模块接口。' +
            '行号均为 1 起，路径相对工程根。' +
            '本服务可同时服务多个工程：默认用客户端声明的工作区根，任何工具都可以再传 root=<工程根> 切到别的工程。',
        },
        protocol,
      );
      // 客户端声明了 roots 能力 → 跟随它打开的工作区（不把服务绑死在某一个工程上）
      if (params?.capabilities?.roots) void fetchRoots('initialize');
      return reply;
    }

    case 'notifications/roots/list_changed':
      void fetchRoots('工作区变化');
      return undefined;

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return undefined; // 通知一律不回应

    case 'ping':
      return isNotification ? undefined : writeResult(id, {}, protocol);

    case 'tools/list':
      return writeResult(id, { tools: registry.specs() }, protocol);

    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const t0 = Date.now();
      try {
        const res = await registry.call(name, args);
        const ms = Date.now() - t0;
        log(`${name} ok ${ms}ms`);
        const result = { content: [{ type: 'text', text: res.text }] };
        if (protocol >= '2025-06-18') result.structuredContent = res.data;
        return writeResult(id, result, protocol);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        log(`${name} 失败: ${message}`);
        return writeResult(
          id,
          { content: [{ type: 'text', text: `错误: ${message}` }], isError: true },
          protocol,
        );
      }
    }

    default:
      if (isNotification) return undefined;
      return sendError(id, -32601, `不支持的方法: ${method}`);
  }
}

// ---------------------------------------------------------------- stdio 主循环

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      sendError(null, -32700, `JSON 解析失败: ${err.message}`);
      continue;
    }
    void handle(msg).catch((err) => {
      const id = msg && msg.id !== undefined ? msg.id : null;
      if (id !== null) sendError(id, -32603, `内部错误: ${err && err.message ? err.message : err}`);
    });
  }
});
process.stdin.on('end', () => {
  log('stdin 关闭，退出');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(
  `启动: ${root ? `默认工程根=${root}` : '未指定 --root，将跟随客户端工作区（MCP roots）或由调用方传 root='}` +
    `${flags.scope ? ` scope=${flags.scope}` : ''}`,
);
if (root) warm('启动');
if (!root) {
  // 没给 --root 也没等到客户端工作区时，至少让 cwd 兜底可用（有些客户端就是这么启动服务的）
  setTimeout(() => {
    if (registry.roots.length === 0) {
      log(`客户端没声明工作区，退回当前目录作默认根: ${process.cwd()}`);
      warm('cwd 兜底');
    }
  }, 3000).unref?.();
}
