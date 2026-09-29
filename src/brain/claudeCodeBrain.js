// Claude Code 模式：
// - 开着 Claude Code 会话、它在监听（`node src/cli.js watch`）时：猫娘进程自己不思考，只把事件写进事件流，
//   由那个会话用 `neko say / act` 回应（见 CLAUDE.md）。
// - 没人监听时（比如直接 npm start）：自己调用本机的命令行版 Claude Code（claude -p，用你登录的 Claude 账号）想一轮。
//   这一轮的 Claude 只有猫娘的动作工具（和 API 模式同一套，经 mcpServer.js 转给控制接口），碰不到电脑上的文件和命令；
//   替谁做事就按谁的权限（不是主人的玩家，让她执行只替主人做的命令会被拒绝）。
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLog } from '../log.js';
import { RUNTIME } from '../paths.js';
import { truncate } from '../util.js';
import { buildContext } from './context.js';
import { apiRules, commandRules, PERSONA, QueuedBrain } from './common.js';

const log = getLog('大脑');
const MCP_SERVER = fileURLToPath(new URL('./mcpServer.js', import.meta.url));
const NOTICE_EVERY = 10 * 60_000;

// Claude Code 会话在监听吗（watch 挂着长轮询；两次轮询之间的空档算 8 秒）
export function watcherAttached(agent) {
  const w = agent.watching;
  return Boolean(w && (w.count > 0 || Date.now() - w.last < 8000));
}

const byVersionDesc = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
};

// 找命令行版 Claude Code：配置里写的 → PATH → 官方安装位置 → Claude 桌面版自带的（取最新版本）→ npm 全局安装的
export function findClaudeCli(configured = '', env = process.env) {
  const win = process.platform === 'win32';
  const home = os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const list = [];
  if (configured) list.push(configured);
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of win ? ['claude.exe', 'claude.cmd'] : ['claude']) list.push(path.join(dir, name));
  }
  list.push(path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude'));
  const bundled = win ? path.join(appData, 'Claude', 'claude-code') : path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    for (const v of fs.readdirSync(bundled).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort(byVersionDesc)) {
      list.push(path.join(bundled, v, win ? 'claude.exe' : 'claude'));
    }
  } catch {
    // 没装桌面版
  }
  if (win) list.push(path.join(appData, 'npm', 'claude.cmd'));
  else list.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  return list.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

// npm 装的是 claude.cmd，不能直接启动：优先用 node 跑它的 cli.js，找不到再经过 cmd.exe
export function cliCommand(cli) {
  if (!/\.(cmd|bat)$/i.test(cli)) return { cmd: cli, pre: [], shell: false };
  const js = path.join(path.dirname(cli), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (fs.existsSync(js)) return { cmd: process.execPath, pre: [js], shell: false };
  return { cmd: `"${cli}"`, pre: [], shell: true };
}
const quoteForCmd = (a) => (a === '' || /[\s"&|<>^()%!,;]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

// 命令行 claude -p 的参数：只给 neko 这一个 MCP 服务器的工具，别的工具（读写文件、执行命令）一律没有
export function headlessArgs(cfg, files) {
  const args = [
    '-p', '--output-format', 'json',
    '--max-turns', String(cfg.max_turns ?? 12),
    '--tools', '',
    '--mcp-config', files.mcp, '--strict-mcp-config',
    '--allowedTools', 'mcp__neko',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt-file', files.system,
  ];
  if (cfg.model) args.push('--model', String(cfg.model));
  if (cfg.effort) args.push('--effort', String(cfg.effort));
  return args;
}

// 失败原因 → 给玩家的话和控制台提示
export function explainFailure(text, cli) {
  const t = String(text ?? '');
  if (/not logged in|\/login|invalid api key|authenticat|oauth|credential/i.test(t)) {
    return {
      kind: 'login',
      say: '我的大脑（Claude Code）还没登录，请主人在电脑上登录一下喵',
      console: `命令行版 Claude Code 还没登录。在终端运行一次：\n  "${cli}" auth login\n用你的 Claude 账号在浏览器里登录（只需一次），之后没开 Claude Code 时猫娘也能自己回话。`,
    };
  }
  if (/usage limit|rate.?limit|\b429\b|overloaded|\b529\b|quota/i.test(t)) {
    return { kind: 'limit', say: '想事情的人太多了（Claude 用量到上限了），过一会儿再叫我喵', console: `Claude 用量到上限或服务繁忙：${truncate(t, 200)}` };
  }
  return { kind: 'error', say: '我的脑袋卡了一下，再说一次好吗喵', console: `命令行 Claude Code 出错：${truncate(t, 300)}` };
}

export class ClaudeCodeBrain extends QueuedBrain {
  constructor(agent) {
    super(agent, { max_episodes_per_hour: 60, max_auto_steps: 6, ...(agent.cfg.brain.claude_code ?? {}) });
    agent.brainRuns = new Map();
    this.cli = undefined;
    this.notices = new Map();
    this.dir = path.join(RUNTIME, 'brain');
    // claude 在一个空目录里运行：不会读到本项目的 CLAUDE.md（那是写给 Claude Code 会话的）
    this.cwd = path.join(os.tmpdir(), 'njfu-neko-brain');
  }

  get headless() {
    return this.cfg.headless !== false;
  }

  describe() {
    return this.headless
      ? '大脑：Claude Code 模式（开着 Claude Code 会话时由它接管；没开时自己调用命令行版 Claude Code 回话）'
      : '大脑：Claude Code 模式（在本项目目录打开 Claude Code，让它按 CLAUDE.md 接管猫娘）';
  }

  start() {
    super.start();
    if (this.headless) this.checkCli().catch(() => {});
  }

  cliPath() {
    if (this.cli === undefined) this.cli = findClaudeCli(String(this.cfg.cli ?? '').trim());
    return this.cli;
  }

  // 启动时看一眼：命令行 Claude Code 在不在、登录了没有（auth status 不花钱）
  async checkCli() {
    const cli = this.cliPath();
    if (!cli) {
      log.warn('没找到命令行版 Claude Code（claude）：没开 Claude Code 会话时猫娘没法自己回话（# 快捷命令、找结构、史莱姆区块照常能用）。安装方法见 README 的「Claude Code 模式」。');
      return;
    }
    const { cmd, pre, shell } = cliCommand(cli);
    const status = await new Promise((resolve) => {
      execFile(cmd, [...pre, 'auth', 'status'], { timeout: 20_000, windowsHide: true, shell, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } }, (err, stdout) => {
        try {
          resolve(JSON.parse(String(stdout)));
        } catch {
          resolve(null);
        }
      });
    });
    if (status?.loggedIn === false) log.warn(explainFailure('not logged in', cli).console);
    else if (status?.loggedIn) log.info(`没开 Claude Code 会话时，由命令行版 Claude Code 回话：${cli}`);
  }

  enqueue(trigger) {
    if (watcherAttached(this.agent)) {
      if (trigger.type === 'chat') log.info(`[交给 Claude Code 会话] ${trigger.msg.from}：${trigger.msg.text}`);
      return;
    }
    if (!this.headless) {
      if (trigger.type === 'chat') {
        log.info(`[等待 Claude Code 回应] ${trigger.msg.from}：${trigger.msg.text}`);
        this.notify('offline', '我的大脑（Claude Code）现在不在线，主人打开 Claude Code 就能跟我聊啦；# 开头的快捷命令照常能用喵', trigger);
      }
      return;
    }
    super.enqueue(trigger);
  }

  // 同一类提示 10 分钟内只说一次
  notify(kind, text, trigger) {
    if (Date.now() - (this.notices.get(kind) ?? 0) < NOTICE_EVERY) return;
    this.notices.set(kind, Date.now());
    const to = trigger?.type === 'chat' && trigger.msg.kind === 'whisper' ? trigger.msg.from : undefined;
    if (this.agent.online) this.agent.say(text, { to });
  }

  writeFiles(run) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.cwd, { recursive: true });
    const system = path.join(this.dir, 'system.md');
    const mcp = path.join(this.dir, 'mcp.json');
    fs.writeFileSync(system, `${PERSONA.trim()}\n${apiRules()}${commandRules(this.agent.cfg.commands)}
## 这一轮
- 主人现在没开着 Claude Code 会话，是猫娘程序直接叫醒你的。你只有 neko 的工具（名字是 mcp__neko__ 加上面说的 say、go_to_player 等），没有别的工具。
- 回应完这次叫醒你的事就结束；长任务开始后这一轮就可以结束，任务结束时会再叫醒你。
`);
    fs.writeFileSync(mcp, `${JSON.stringify({
      mcpServers: { neko: { type: 'stdio', command: process.execPath, args: [MCP_SERVER], env: { NEKO_RUN: run } } },
    }, null, 2)}\n`);
    return { system, mcp };
  }

  runCli(cli, args, prompt) {
    const { cmd, pre, shell } = cliCommand(cli);
    const timeoutMs = Math.max(30, Number(this.cfg.timeout_seconds ?? 180)) * 1000;
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, shell ? [...pre, ...args].map(quoteForCmd) : [...pre, ...args], {
        cwd: this.cwd, shell, windowsHide: true, env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      });
      let stdout = '';
      let stderr = '';
      let why = null;
      const timer = setTimeout(() => {
        why = 'timeout';
        child.kill();
      }, timeoutMs);
      this.current = {
        abort: () => {
          why = 'aborted';
          child.kill();
        },
      };
      child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
      child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (why) return reject(Object.assign(new Error(why === 'timeout' ? `超过 ${timeoutMs / 1000} 秒没想完` : '被叫停了'), { why }));
        const line = stdout.trim().split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
        try {
          return resolve(JSON.parse(line));
        } catch {
          return reject(new Error(truncate(stderr.trim() || stdout.trim() || `退出码 ${code}`, 400)));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  async episode(triggers) {
    const agent = this.agent;
    const first = triggers[0];
    const requester = first.requester ?? null;
    const cli = this.cliPath();
    if (!cli) {
      this.notify('missing', '我的大脑（Claude Code）现在不在，主人打开 Claude Code 就能跟我聊啦；# 开头的快捷命令照常能用喵', first);
      return;
    }
    const run = crypto.randomBytes(12).toString('hex');
    agent.brainRuns.set(run, { source: 'brain', name: requester?.name ?? null, owner: requester ? requester.owner !== false : false, requester });
    const started = Date.now();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let rounds = 0;
    let note = '';
    agent.events.push('brain', { what: 'episode_start', detail: `${requester?.name ?? '系统'}（${triggers.map((t) => t.type).join('、')}，命令行 Claude Code）` });
    try {
      const prompt = buildContext(agent, { triggers, chatLines: this.cfg.recent_chat_lines ?? 20 });
      const out = await this.runCli(cli, headlessArgs(this.cfg, this.writeFiles(run)), prompt);
      const u = out.usage ?? {};
      usage.input = u.input_tokens ?? 0;
      usage.output = u.output_tokens ?? 0;
      usage.cacheRead = u.cache_read_input_tokens ?? 0;
      usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      rounds = out.num_turns ?? 0;
      if (out.subtype === 'error_max_turns') {
        log.info('命令行 Claude Code：这一轮的工具调用次数到上限了');
      } else if (out.is_error) {
        const f = explainFailure(out.result ?? out.subtype, cli);
        (f.kind === 'error' ? log.warn : log.error)(f.console);
        this.notify(f.kind, f.say, first);
        agent.events.push('brain', { what: 'error', error: truncate(out.result ?? out.subtype ?? '', 300) });
      } else {
        note = String(out.result ?? '').trim();
        log.info(`命令行 Claude Code 想完了：${rounds} 轮，${((Date.now() - started) / 1000).toFixed(1)} 秒，输入 ${usage.input}（缓存读 ${usage.cacheRead}）输出 ${usage.output}`);
      }
    } catch (err) {
      if (err.why === 'aborted') return;
      const missing = err.code === 'ENOENT';
      const f = missing
        ? { kind: 'missing', say: '我的大脑（Claude Code）现在不在，主人打开 Claude Code 就能跟我聊啦', console: `启动不了命令行 Claude Code：${cli}` }
        : explainFailure(err.message, cli);
      if (missing) this.cli = undefined;
      log.warn(f.console);
      this.notify(f.kind, f.say, first);
      agent.events.push('brain', { what: 'error', error: truncate(err.message, 300) });
    } finally {
      agent.brainRuns.delete(run);
      this.finishEpisode(rounds, started, usage, note);
    }
  }
}

export class NoBrain {
  start() {
    log.info('大脑：关闭（只挂机，不回话）');
  }
}
