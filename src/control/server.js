// 本机控制接口（只监听 127.0.0.1，并要求随机令牌）：命令行 neko 和 Claude Code 模式都通过它操作猫娘。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import util from 'node:util';
import { createRequire } from 'node:module';
import { CONTROL_FILE } from '../paths.js';
import { getLog } from '../log.js';
import { addSecret, redact } from '../secrets.js';
import { listActions, runAction, toolDefinitions } from '../bot/actions.js';
import { describeStatus, snapshot } from '../bot/status.js';
import { goals } from '../bot/createBot.js';
import { Vec3 } from '../bot/helpers.js';
import { buildContext } from '../brain/context.js';
import { withTimeout } from '../util.js';
import { STATUS } from '../requests.js';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const requireFromHere = createRequire(import.meta.url);
const MAX_BODY = 1024 * 1024;
const log = getLog('控制');

function send(res, status, body) {
  // 回复内容同样打码，防止通过控制接口（包括 eval）读出密钥。
  const text = redact(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求太大'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// 谁在操作：带 x-neko-run 的是“自己回话”那一轮（claude -p 经 MCP 发来的），按那一轮替谁做事来算权限（那一轮结束了就不认）；
// 不带的是本机的命令行 / Claude Code 会话（主人自己）。
export function requestBy(agent, headers, body) {
  const run = String(headers['x-neko-run'] ?? '');
  if (!run) return { source: 'control', name: body.by ?? 'control' };
  return agent.brainRuns?.get(run) ?? null;
}

export async function startControlServer(agent, { brain, brainMode }) {
  const cfg = agent.cfg.control;
  const token = crypto.randomBytes(24).toString('hex');
  addSecret(token);
  let port = Number(cfg.port);
  // 有没有 Claude Code 会话在监听（watch 一直挂着 /events 长轮询）：Claude Code 模式据此决定要不要自己调用命令行回话
  agent.watching = { count: 0, last: 0 };

  const routes = {
    'GET /health': () => ({ ok: true, boot: agent.events.boot, online: agent.online, username: agent.cfg.account.username, brain: brainMode }),
    'GET /state': () => ({ ...snapshot(agent), brain: brainMode, usage: brain?.usage ?? null }),
    'GET /status': () => describeStatus(agent),
    'GET /context': () => buildContext(agent),
    'GET /actions': () => listActions(),
    'GET /tools': () => toolDefinitions(false),
    'GET /events': async (url) => {
      const since = Number(url.searchParams.get('since') ?? 0);
      const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 60_000);
      const types = url.searchParams.get('types')?.split(',').filter(Boolean);
      if (wait > 0) agent.watching.count += 1;
      try {
        const events = await agent.events.wait(since, wait, types);
        return { boot: agent.events.boot, seq: agent.events.seq, events };
      } finally {
        if (wait > 0) {
          agent.watching.count -= 1;
          agent.watching.last = Date.now();
        }
      }
    },
    'POST /say': async (url, body) => {
      if (!agent.online) return { ok: false, text: '现在没有连上服务器' };
      const n = agent.say(String(body.text ?? ''), { to: body.to || undefined });
      return { ok: n > 0, text: n ? `已说出（${n} 行）` : '没有可说的内容' };
    },
    'POST /act': async (url, body, req) => {
      const by = requestBy(agent, req.headers, body);
      if (!by) return { ok: false, text: '这一轮已经结束了' };
      return runAction(agent, String(body.action ?? ''), body.args ?? {}, {
        waitMs: Math.min(Number(body.wait ?? 60), 600) * 1000,
        by,
      });
    },
    'POST /cancel': async () => {
      const task = await agent.tasks.cancel('被控制台取消');
      return { ok: true, text: task ? `已停止：${task.desc}` : '没有进行中的任务' };
    },
    'POST /reconnect': async () => {
      agent.reconnect().catch(() => {});
      return { ok: true, text: '正在重新连接' };
    },
    'POST /eval': async (url, body) => {
      if (!cfg.allow_eval) return { ok: false, text: '配置里关闭了 eval（control.allow_eval）' };
      log.info(`执行 eval：${String(body.code ?? '').slice(0, 500)}`);
      const fn = new AsyncFunction('bot', 'agent', 'goals', 'Vec3', 'require', String(body.code ?? ''));
      const value = await withTimeout(fn(agent.bot, agent, goals, Vec3, requireFromHere), 30_000, '执行超过 30 秒');
      const text = typeof value === 'string' ? value : util.inspect(value, { depth: 3, maxArrayLength: 60, breakLength: 120 });
      return { ok: true, text };
    },
    'GET /requests': (url) => (url.searchParams.get('all') ? agent.requests.list : agent.requests.open())
      .map((r) => ({ ...r, statusText: STATUS[r.status] })),
    'POST /request': async (url, body) => {
      const r = agent.requests.update(body.id, String(body.status ?? ''), body.note ?? '');
      agent.events.push('bot', { what: 'feature_request', by: r.player, detail: `#${r.id} ${STATUS[r.status]}${r.note ? `：${r.note}` : ''}` });
      if (agent.online) agent.say(`需求 #${r.id}「${r.text.slice(0, 30)}」${STATUS[r.status]}${r.note ? `：${r.note}` : ''}`, { to: r.player });
      return { ok: true, text: `需求 #${r.id} → ${STATUS[r.status]}` };
    },
    'POST /shutdown': async () => {
      setTimeout(() => process.emit('SIGTERM'), 100);
      return { ok: true, text: '猫娘下线中' };
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      // 浏览器发来的跨站请求一律拒绝，防止网页借本机接口操控猫娘。
      if (req.headers.origin) return send(res, 403, { ok: false, text: '不接受浏览器请求' });
      const host = String(req.headers.host ?? '');
      if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
        return send(res, 403, { ok: false, text: 'Host 不正确' });
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { ok: false, text: '没有这个接口' });
      if (url.pathname !== '/health' && !sameToken(req.headers['x-neko-token'], token)) {
        return send(res, 401, { ok: false, text: '令牌不对（见 runtime/control.json）' });
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (url.pathname !== '/events' && url.pathname !== '/health') {
        log.fileOnly('debug', `${req.method} ${url.pathname}${req.method === 'POST' ? ` ${JSON.stringify(body).slice(0, 300)}` : ''}`);
      }
      send(res, 200, await handler(url, body, req));
    } catch (err) {
      log.warn(`处理 ${req.method} ${req.url} 出错：`, err);
      send(res, 500, { ok: false, text: err?.message ?? String(err) });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;

  for (;;) {
    try {
      await listen(server, port, cfg.host);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || port - cfg.port >= 10) throw err;
      port += 1;
    }
  }

  const info = { url: `http://${cfg.host}:${port}`, port, token, pid: process.pid, boot: agent.events.boot };
  fs.writeFileSync(CONTROL_FILE, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  process.once('exit', () => {
    try {
      if (JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8')).pid === process.pid) fs.rmSync(CONTROL_FILE, { force: true });
    } catch {
      // 文件已被删除
    }
  });
  log.info(`控制接口：${info.url}（令牌保存在 runtime/control.json）`);
  return { server, port, close: () => server.close() };
}
