// 日志：控制台 + 按天分文件的日志（runtime/logs/neko-YYYY-MM-DD.log），外加结构化事件流 events.jsonl。
// 所有输出都先经过 secrets.redact() 打码。
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { redact, redactDeep } from './secrets.js';
import { clock, describeEvent } from './format.js';

export { clock };

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const FILE_TAG = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
const CONSOLE_MARK = { debug: '· ', info: '', warn: '⚠ ', error: '✗ ' };
const pad = (n, w = 2) => String(n).padStart(w, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function stringify(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ?? a.message;
    return util.inspect(a, { depth: 4, breakLength: 160, maxArrayLength: 60 });
  }).join(' ');
}

class Logger {
  constructor() {
    this.consoleLevel = process.env.NEKO_DEBUG ? 'debug' : 'info';
    this.fileLevel = 'debug';
    this.keepDays = 14;
    this.dir = null;
    this.fd = null;
    this.day = null;
  }

  configure({ dir, consoleLevel, fileLevel, keepDays } = {}) {
    if (!process.env.NEKO_DEBUG && LEVELS[consoleLevel]) this.consoleLevel = consoleLevel;
    if (LEVELS[fileLevel]) this.fileLevel = fileLevel;
    if (Number(keepDays) > 0) this.keepDays = Number(keepDays);
    if (dir) {
      this.dir = dir;
      fs.mkdirSync(dir, { recursive: true });
      this.prune();
    }
  }

  get currentFile() {
    return this.dir ? path.join(this.dir, `neko-${dayOf(new Date())}.log`) : null;
  }

  // 删除超过保留天数的旧日志文件（只删本程序自己的 neko-日期.log）。
  prune() {
    const cutoff = Date.now() - this.keepDays * 86_400_000;
    for (const name of fs.readdirSync(this.dir)) {
      const m = /^neko-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
      if (m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() < cutoff) {
        fs.rmSync(path.join(this.dir, name), { force: true });
      }
    }
  }

  writeFile(line, now) {
    const day = dayOf(now);
    if (this.fd === null || this.day !== day) {
      if (this.fd !== null) fs.closeSync(this.fd);
      this.fd = fs.openSync(path.join(this.dir, `neko-${day}.log`), 'a');
      if (this.day && this.day !== day) this.prune();
      this.day = day;
    }
    fs.writeSync(this.fd, line);
  }

  write(level, category, args, { toConsole = true } = {}) {
    const rank = LEVELS[level];
    const toFile = this.dir && rank >= LEVELS[this.fileLevel];
    const show = toConsole && rank >= LEVELS[this.consoleLevel];
    if (!toFile && !show) return;
    const text = redact(stringify(args));
    const now = new Date();
    if (show) process.stdout.write(`[${clock(now)}] ${CONSOLE_MARK[level]}${category ? `[${category}] ` : ''}${text}\n`);
    if (toFile) {
      try {
        this.writeFile(`${dayOf(now)} ${clock(now)}.${pad(now.getMilliseconds(), 3)} ${FILE_TAG[level]} [${category || '-'}] ${text}\n`, now);
      } catch {
        // 写日志失败不影响运行
      }
    }
  }

  child(category) {
    return {
      debug: (...args) => this.write('debug', category, args),
      info: (...args) => this.write('info', category, args),
      warn: (...args) => this.write('warn', category, args),
      error: (...args) => this.write('error', category, args),
      fileOnly: (level, ...args) => this.write(level, category, args, { toConsole: false }),
    };
  }
}

export const logger = new Logger();
export const getLog = (category) => logger.child(category);
export const log = logger.child('');

const EVENT_CATEGORY = {
  chat: '聊天', said: '说话', task: '任务', action: '动作', system: '系统', connection: '连接',
  bot: '状态', brain: '大脑', affection: '好感', server: '服务器',
};

// 事件写进日志时的级别，以及是否同时显示在控制台。
function eventLevel(e) {
  switch (e.type) {
    case 'system': return ['debug', false];
    case 'action': return [e.ok ? 'info' : 'warn', Boolean(process.env.NEKO_DEBUG)];
    case 'task': return [e.status === 'failed' ? 'warn' : 'info', true];
    case 'connection': return [e.state === 'kicked' || e.state === 'error' ? 'warn' : 'info', false];
    case 'bot': return [['death', 'low_health', 'attacked'].includes(e.what) ? 'warn' : 'info', true];
    case 'brain': return [e.what === 'error' ? 'warn' : 'info', ['episode_end', 'error', 'refusal', 'fallback'].includes(e.what)];
    default: return ['info', true];
  }
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

// 结构化事件：内存里保留最近的事件供控制接口查询/长轮询，同时写入 events.jsonl 和日志。
export class EventLog extends EventEmitter {
  constructor(file, max = 2000) {
    super();
    this.setMaxListeners(0);
    this.file = file;
    this.max = max;
    this.buffer = [];
    this.seq = 0;
    this.boot = crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, file.replace(/\.jsonl$/, '.old.jsonl'));
    } catch {
      // 文件还不存在
    }
  }

  push(type, data = {}) {
    const event = redactDeep({ seq: ++this.seq, t: new Date().toISOString(), type, ...data });
    this.buffer.push(event);
    if (this.buffer.length > this.max) this.buffer.shift();
    try {
      fs.appendFileSync(this.file, `${JSON.stringify({ boot: this.boot, ...event })}\n`);
    } catch {
      // 写事件失败不影响运行
    }
    const [level, toConsole] = eventLevel(event);
    logger.write(level, EVENT_CATEGORY[type] ?? type, [describeEvent(event)], { toConsole });
    this.emit('event', event);
    return event;
  }

  since(seq, types) {
    return this.buffer.filter((e) => e.seq > seq && (!types || types.includes(e.type)));
  }

  // 有新事件就立即返回，否则最多等 ms 毫秒。
  wait(seq, ms, types) {
    const ready = this.since(seq, types);
    if (ready.length || ms <= 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.off('event', onEvent);
        resolve(this.since(seq, types));
      };
      const onEvent = (e) => {
        if (!types || types.includes(e.type)) setTimeout(finish, 50);
      };
      const timer = setTimeout(finish, ms);
      this.on('event', onEvent);
    });
  }
}
