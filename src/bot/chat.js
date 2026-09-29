// 聊天：按数据包类型识别玩家发言 / 私聊 / 系统消息，判断是不是在叫猫娘。
import { getLog } from '../log.js';
import { componentText, truncate } from '../util.js';
import { createQuickCommands } from './quickCommands.js';

const log = getLog('聊天');

// 只包含这些词（去掉称呼和标点后）时直接急停，不必等大脑思考。
const STOP_WORDS = new Set(['停', '停下', '停止', '停一下', '别动', '站住', '不要动', '别跟了', 'stop', 'halt']);
// 有些服务器把玩家聊天当系统消息发来，这里只认最标准的原版格式。
const SYSTEM_CHAT = /^<([A-Za-z0-9_]{1,16})> (.+)$/;

export class ChatHub {
  constructor(agent) {
    this.agent = agent;
    this.lines = [];
    this.lastReplyTo = new Map();
    this.taps = new Set();
  }

  get cfg() {
    return this.agent.cfg.chat;
  }

  attach(bot) {
    bot._client.on('playerChat', (data) => {
      try {
        this.onPlayerChat(bot, data);
      } catch (err) {
        log.warn('处理聊天出错：', err.message);
      }
    });
    bot.on('messagestr', (text, position) => {
      if (position !== 'system') return;
      try {
        this.onSystem(bot, text);
      } catch (err) {
        log.warn('处理系统消息出错：', err.message);
      }
    });
  }

  onPlayerChat(bot, data) {
    const index = data.type?.chatType ?? data.type;
    const typeName = String(bot.registry.chatFormattingById?.[index]?.name ?? '').replace(/^minecraft:/, '');
    if (typeName.endsWith('_outgoing')) return;
    const from = Object.values(bot.players).find((p) => p.uuid === data.sender)?.username
      ?? componentText(data.senderName).trim();
    if (!from || from === bot.username) return;
    const text = String(data.plainMessage ?? componentText(data.formattedMessage)).trim();
    if (!text) return;
    let kind = 'public';
    if (typeName === 'msg_command_incoming') kind = 'whisper';
    else if (typeName.startsWith('team_msg')) kind = 'team';
    else if (typeName === 'emote_command') kind = 'emote';
    else if (typeName === 'say_command') kind = 'say';
    this.onPlayerMessage(bot, { from, text, kind });
  }

  onSystem(bot, raw) {
    const text = raw.trim();
    if (!text) return;
    // 面板模组发给猫娘的通知：有人右键了她（panel）或 Shift+右键（menu）
    const ui = /^\[NJFU-UI\] (panel|menu) ([A-Za-z0-9_]{1,16})$/.exec(text);
    if (ui) {
      this.agent.emit('panel', { action: ui[1], player: ui[2] });
      return;
    }
    for (const tap of this.taps) tap(text);
    if (this.agent.identity.isEcho(text)) return;
    const m = SYSTEM_CHAT.exec(text);
    if (m) {
      if (m[1] !== bot.username) this.onPlayerMessage(bot, { from: m[1], text: m[2], kind: 'public' });
      return;
    }
    const aboutMe = text.includes(bot.username) || text.includes(this.agent.cfg.identity.display_name);
    this.push({ from: null, text, kind: 'system' });
    this.agent.events.push('system', { text: truncate(text, 300), aboutMe });
    this.agent.emit('systemMessage', text);
  }

  isOwner(name) {
    const owners = this.cfg.owners;
    return owners.length === 0 || owners.some((o) => o.toLowerCase() === String(name).toLowerCase());
  }

  humansOnline(bot) {
    return Object.keys(bot.players).filter((name) => name !== bot.username);
  }

  isAddressed(bot, { from, text, kind }) {
    if (kind === 'whisper') return true;
    if (this.cfg.respond_to_all) return true;
    const lower = text.toLowerCase();
    if (this.cfg.triggers.some((t) => lower.includes(t.toLowerCase()))) return true;
    if (lower.includes(bot.username.toLowerCase())) return true;
    if (this.cfg.respond_when_alone && this.humansOnline(bot).length === 1) return true;
    const last = this.lastReplyTo.get(from);
    return Boolean(last && this.cfg.follow_up_seconds > 0 && Date.now() - last < this.cfg.follow_up_seconds * 1000);
  }

  isStopCommand(text) {
    let core = text.toLowerCase();
    for (const t of this.cfg.triggers) core = core.split(t.toLowerCase()).join('');
    core = core.replace(/[\s,，.。!！~～、:：;；?？喵]/g, '');
    return STOP_WORDS.has(core);
  }

  onPlayerMessage(bot, { from, text, kind }) {
    const agent = this.agent;
    const addressed = this.isAddressed(bot, { from, text, kind });
    const owner = this.isOwner(from);
    const msg = { from, text, kind, addressed, owner, t: Date.now() };
    this.push(msg);
    agent.events.push('chat', { from, text, kind, addressed, owner });
    // 1. 对猫娘提问的直接回答（例如“要不要一起睡”回“好”）
    if (agent.social?.handleReply(msg)) return;
    // 2. # 开头的快捷查询，不经过大脑
    if (text.trim().startsWith(this.cfg.command_prefix || '#')) {
      this.quick ??= createQuickCommands(agent);
      this.quick(msg).then((handled) => {
        if (!handled && addressed) agent.emit('addressed', msg);
      }).catch((err) => log.warn('快捷命令出错：', err.message));
      return;
    }
    if (!addressed) return;
    agent.affection?.onChat(from, owner);
    if (owner && this.isStopCommand(text)) {
      agent.emergencyStop(from, kind === 'whisper' ? from : null);
      return;
    }
    agent.emit('addressed', msg);
  }

  // 记录猫娘自己说的话，供大脑回顾对话。
  recordSelf(text, to) {
    this.push({ from: this.agent.cfg.identity.display_name, self: true, text, kind: to ? 'whisper' : 'public', to });
    if (to) this.lastReplyTo.set(to, Date.now());
    else for (const name of this.recentSpeakers(60_000)) this.lastReplyTo.set(name, Date.now());
  }

  recentSpeakers(ms) {
    const since = Date.now() - ms;
    return new Set(this.lines.filter((l) => l.t >= since && l.from && !l.self && l.kind !== 'system').map((l) => l.from));
  }

  push(entry) {
    this.lines.push({ t: Date.now(), ...entry });
    if (this.lines.length > 200) this.lines.shift();
  }

  recent(n) {
    return this.lines.slice(-n);
  }

  // 在 fn 执行后的 ms 毫秒内收集系统消息（用于拿到命令的回显）。
  async capture(fn, ms = 1500) {
    const got = [];
    const tap = (text) => got.push(text);
    this.taps.add(tap);
    try {
      await fn();
      await new Promise((resolve) => setTimeout(resolve, ms));
    } finally {
      this.taps.delete(tap);
    }
    return got;
  }
}
