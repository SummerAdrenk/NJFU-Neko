#!/usr/bin/env node
// 命令行控制猫娘：node src/cli.js <命令>（或 npm run ctl -- <命令>）。
import fs from 'node:fs';
import { CONTROL_FILE } from './paths.js';
import path from 'node:path';
import os from 'node:os';
import { formatEvent } from './format.js';
import { addSecret, redact } from './secrets.js';
import { LOG_DIR, ROOT, RUNTIME } from './paths.js';

const HELP = `NJFU智慧猫娘 · 命令行

用法：node src/cli.js <命令> [参数]

  status                      当前状态（生命、位置、背包、任务…）
  context                     给大脑看的完整情况（状态 + 最近聊天 + 最近行动 + 记忆）
  say <文字> [--to 玩家]       让猫娘说话（--to 为悄悄话）
  act <动作> [参数] [--wait 秒] 执行动作；参数写成 JSON 或 键=值，例如：
                                act goto x=100 y=64 z=-20
                                act collect_block block=oak_log count=10
                                act go_to_player player=Steve follow=true
  actions                     列出所有动作和参数
  cancel                      停止当前任务
  events [--since 序号] [--all] 查看最近的事件（--all 连动作记录一起显示）
  watch [--all]               持续输出新事件（Claude Code 模式用它接收聊天）
  eval <JS 代码>              在猫娘进程里执行 JS（可用 bot、agent、goals、Vec3、require）
  reconnect                   立即重新连接服务器
  logs [-n 行数] [-f]         查看日志（-f 持续跟踪新日志）
  report                      生成问题报告（日志、事件、配置，密钥已打码），反馈 bug 时附上
  stop                        让猫娘下线并退出进程
`;

function loadControl() {
  try {
    return JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
  } catch {
    return null;
  }
}

class NotRunning extends Error {}

async function call(method, path, body, { timeoutMs = 700_000 } = {}) {
  const control = loadControl();
  if (!control) throw new NotRunning('猫娘进程没有在运行（找不到 runtime/control.json），请先运行 npm start');
  let res;
  try {
    res = await fetch(`${control.url}${path}`, {
      method,
      headers: { 'x-neko-token': control.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new NotRunning(`连不上猫娘进程（${control.url}）：${err.cause?.code ?? err.message}`);
  }
  const text = await res.text();
  const data = (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
  if (!res.ok) throw new Error(typeof data === 'string' ? data : data.text ?? `HTTP ${res.status}`);
  return data;
}

function parseValue(v) {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

// 解析 --flag 值 形式的选项，返回 { flags, rest }。
function splitFlags(args, names) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : null;
    if (name && names.includes(name)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else flags[name] = true;
    } else rest.push(args[i]);
  }
  return { flags, rest };
}

function parseActArgs(parts) {
  if (!parts.length) return {};
  const joined = parts.join(' ').trim();
  if (joined.startsWith('{')) return JSON.parse(joined);
  const args = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new Error(`参数「${part}」格式不对，应写成 键=值`);
    args[part.slice(0, eq)] = parseValue(part.slice(eq + 1));
  }
  return args;
}

// watch 默认只输出需要处理的事件：叫猫娘的聊天、任务结束、重要状态变化。
function important(e) {
  if (e.type === 'chat') return e.addressed;
  if (e.type === 'task') return e.status === 'done' || e.status === 'failed';
  if (e.type === 'bot') return ['death', 'low_health', 'hungry_no_food', 'op', 'emergency_stop', 'gift', 'attacked', 'player_death', 'retreat', 'affection_level', 'ask_sleep'].includes(e.what);
  if (e.type === 'connection') return ['online', 'offline', 'kicked'].includes(e.state);
  return false;
}

async function watch(all) {
  let boot = null;
  let since = 0;
  let down = false;
  for (;;) {
    try {
      const data = await call('GET', `/events?since=${since}&wait=25000`, null, { timeoutMs: 40_000 });
      if (down) {
        console.log('[watch] 已重新连上猫娘进程');
        down = false;
      }
      if (data.boot !== boot) {
        // 第一次连接时不回放旧事件；进程重启后从头读新进程的事件。
        const first = boot === null;
        boot = data.boot;
        since = first ? data.seq : 0;
        if (first) continue;
      }
      for (const e of data.events) {
        since = Math.max(since, e.seq);
        if (all || important(e)) console.log(formatEvent(e));
      }
    } catch (err) {
      if (!down) {
        console.log(`[watch] ${err.message}；每 3 秒重试`);
        down = true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function latestLog() {
  if (!fs.existsSync(LOG_DIR)) return null;
  const files = fs.readdirSync(LOG_DIR).filter((f) => /^neko-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  return files.length ? path.join(LOG_DIR, files[files.length - 1]) : null;
}

function tailLines(file, n) {
  if (!file || !fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(-n);
}

async function followLog(n) {
  let file = latestLog();
  if (!file) throw new Error('还没有日志文件（先运行一次 npm start）');
  for (const line of tailLines(file, n)) console.log(line);
  let size = fs.statSync(file).size;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const now = latestLog();
    if (now !== file) {
      file = now;
      size = 0;
    }
    const stat = fs.statSync(file);
    if (stat.size > size) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(stat.size - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      process.stdout.write(buf.toString('utf8'));
      size = stat.size;
    }
  }
}

// 问题报告：把版本、配置（密钥打码）、日志、事件、ViaProxy 日志汇总成一个文本文件。
function makeReport() {
  const configFile = path.join(ROOT, 'config.toml');
  const configText = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '（没有 config.toml）';
  const key = /^\s*api_key\s*=\s*"([^"]*)"/m.exec(configText)?.[1];
  addSecret(key);
  addSecret(process.env.ANTHROPIC_API_KEY);
  addSecret(process.env.ANTHROPIC_AUTH_TOKEN);
  addSecret(loadControl()?.token);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const events = tailLines(path.join(LOG_DIR, 'events.jsonl'), 150).map((l) => {
    try {
      return formatEvent(JSON.parse(l));
    } catch {
      return l;
    }
  });
  const runtimeFiles = fs.existsSync(RUNTIME) ? fs.readdirSync(RUNTIME).join(', ') : '无';
  const sections = [
    `NJFU智慧猫娘 问题报告  ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `版本 ${pkg.version}；Node ${process.versions.node}；${os.type()} ${os.release()} ${os.arch()}`,
    `依赖：${Object.entries(pkg.dependencies).map(([k, v]) => `${k}@${v}`).join(', ')}`,
    `runtime 目录：${runtimeFiles}`,
    '\n===== config.toml（密钥已打码）=====\n' + configText.replace(/^(\s*api_key\s*=\s*)"[^"]+"/m, '$1"（已打码）"'),
    '\n===== 最近日志 =====\n' + tailLines(latestLog(), 400).join('\n'),
    '\n===== 最近事件 =====\n' + events.join('\n'),
    '\n===== ViaProxy 日志（最后部分）=====\n' + tailLines(path.join(LOG_DIR, 'viaproxy.log'), 80).join('\n'),
  ];
  const dir = path.join(RUNTIME, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `report-${stamp}.txt`);
  fs.writeFileSync(file, redact(sections.join('\n')));
  return file;
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      text += c;
    });
    process.stdin.on('end', () => resolve(text));
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'status':
      console.log(await call('GET', '/status'));
      return;
    case 'state':
      console.log(JSON.stringify(await call('GET', '/state'), null, 2));
      return;
    case 'context':
      console.log(await call('GET', '/context'));
      return;
    case 'say': {
      const { flags, rest } = splitFlags(args, ['to']);
      const text = rest.join(' ').trim();
      if (!text) throw new Error('要说什么？例如：say 你好呀');
      const r = await call('POST', '/say', { text, to: typeof flags.to === 'string' ? flags.to : undefined });
      console.log(r.text);
      return;
    }
    case 'act': {
      const { flags, rest } = splitFlags(args, ['wait']);
      const [action, ...params] = rest;
      if (!action) throw new Error('要执行哪个动作？用 actions 查看列表');
      const body = { action, args: parseActArgs(params), by: 'claude-code' };
      if (flags.wait !== undefined) body.wait = Number(flags.wait);
      const r = await call('POST', '/act', body);
      console.log(`${r.ok === false ? '✗ ' : ''}${r.text}`);
      if (r.ok === false) process.exitCode = 2;
      return;
    }
    case 'actions': {
      for (const a of await call('GET', '/actions')) {
        const params = Object.entries(a.params).map(([k, v]) => `${k}${a.required.includes(k) ? '' : '?'}:${v.enum ? v.enum.join('|') : v.type}`);
        console.log(`${a.name}(${params.join(', ')})\n    ${a.description}`);
      }
      return;
    }
    case 'cancel':
      console.log((await call('POST', '/cancel')).text);
      return;
    case 'events': {
      const { flags } = splitFlags(args, ['since', 'all']);
      const data = await call('GET', `/events?since=${Number(flags.since ?? 0)}`);
      const list = flags.all ? data.events : data.events.filter((e) => e.type !== 'action');
      for (const e of (flags.since ? list : list.slice(-40))) console.log(formatEvent(e));
      return;
    }
    case 'watch':
      await watch(args.includes('--all'));
      return;
    case 'eval': {
      const code = args[0] === '-' ? await readStdin() : args.join(' ');
      if (!code.trim()) throw new Error('要执行什么代码？');
      const r = await call('POST', '/eval', { code });
      console.log(r.text);
      if (r.ok === false) process.exitCode = 2;
      return;
    }
    case 'logs': {
      const { flags } = splitFlags(args, ['n', 'f']);
      const n = Number(flags.n ?? 60);
      if (flags.f) {
        await followLog(n);
        return;
      }
      const lines = tailLines(latestLog(), n);
      console.log(lines.length ? lines.join('\n') : '还没有日志');
      return;
    }
    case 'report': {
      const file = makeReport();
      console.log(`✓ 问题报告已生成：${file}\n  其中的 API Key 和令牌已经打码，可以放心发给别人帮你看`);
      return;
    }
    case 'reconnect':
      console.log((await call('POST', '/reconnect')).text);
      return;
    case 'stop':
      console.log((await call('POST', '/shutdown')).text);
      return;
    default:
      throw new Error(`不认识的命令「${command}」，用 help 查看用法`);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exitCode = err instanceof NotRunning ? 3 : 1;
});
