// 给“没开 Claude Code 时自己回话”用的 MCP 服务器（stdio，由 claude -p 启动）：
// 把猫娘的动作（和 API 模式同一套工具）转给本机控制接口。那一轮的 Claude 只有这些工具，碰不到电脑上的文件和命令。
// 环境变量 NEKO_RUN 是这一轮的编号，控制接口据此认出是替谁做事（不是主人的话，按非主人的权限来）。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CONTROL_FILE } from '../paths.js';

// 调本机控制接口（地址和令牌每次从 runtime/control.json 读，猫娘重启过也能接上）
export function controlClient(file = process.env.NEKO_CONTROL_FILE || CONTROL_FILE, run = process.env.NEKO_RUN ?? '') {
  return async (method, route, body) => {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    const res = await fetch(`${info.url}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-neko-token': info.token, 'x-neko-run': run },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
    return res.json();
  };
}

export function createHandlers(control) {
  let tools = null;
  return {
    initialize: (params) => ({
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'neko', version: '1.0.0' },
    }),
    ping: () => ({}),
    'tools/list': async () => {
      tools ??= await control('GET', '/tools');
      return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) };
    },
    'tools/call': async (params) => {
      const r = await control('POST', '/act', { action: params?.name, args: params?.arguments ?? {}, wait: 25 });
      return { content: [{ type: 'text', text: r.text || (r.ok === false ? '失败' : '完成') }], ...(r.ok === false ? { isError: true } : {}) };
    },
  };
}

// 一行一条 JSON-RPC 消息；通知（没有 id，例如 notifications/initialized）不用回
export function serve(input, output, handlers) {
  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  readline.createInterface({ input }).on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.id === undefined || msg.id === null) return;
    const handler = handlers[msg.method];
    if (!handler) {
      send({ id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } });
      return;
    }
    try {
      send({ id: msg.id, result: await handler(msg.params) });
    } catch (err) {
      send({ id: msg.id, error: { code: -32000, message: `连不上猫娘：${err?.message ?? err}` } });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve(process.stdin, process.stdout, createHandlers(controlClient()));
}
