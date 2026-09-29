// 身份与说话：管理员权限检测、队伍前缀、用中文名在聊天栏说话。
import { getLog } from '../log.js';
import { looksSecret, redact } from '../secrets.js';
import { sleep, splitLines } from '../util.js';
import { toComponent } from './ui.js';

const log = getLog('身份');

const PLAYER_NAME = /^[.\w]{1,16}$/;

export class Identity {
  constructor(agent) {
    this.agent = agent;
    this.opLevel = 0;
    this.queue = [];
    this.pumping = false;
    this.askedForOp = false;
  }

  get cfg() {
    return this.agent.cfg.identity;
  }

  attach(bot) {
    this.opLevel = 0;
    this.queue.length = 0;
    let selfId = null;
    bot._client.on('login', (packet) => {
      selfId = packet.entityId;
    });
    // 服务器用实体状态 24～28 告知本玩家的权限等级 0～4。
    bot._client.on('entity_status', (packet) => {
      if (packet.entityId !== (bot.entity?.id ?? selfId)) return;
      if (packet.entityStatus < 24 || packet.entityStatus > 28) return;
      const before = this.opLevel;
      this.opLevel = packet.entityStatus - 24;
      if (this.opLevel === before) return;
      this.agent.events.push('bot', { what: 'op', level: this.opLevel });
      if (this.opLevel >= 2 && before < 2 && this.agent.online) {
        log.info(`已获得管理员权限（等级 ${this.opLevel}）`);
        this.setupTeam(bot).catch(() => {});
      }
    });
    bot.once('spawn', () => {
      setTimeout(() => this.onJoined(bot).catch((err) => log.warn('入场设置失败：', err.message)), 2500);
    });
  }

  async onJoined(bot) {
    if (this.agent.bot !== bot || !this.agent.online) return;
    if (this.opLevel >= 2) {
      // 配置允许时关掉“管理员命令广播”，否则猫娘的每条命令都会在管理员聊天栏里提示一遍
      if (this.agent.cfg.ui.quiet_admin_commands) await this.agent.adminBroadcast(false);
      await this.setupTeam(bot);
    }
    if (this.cfg.greeting) this.say(this.cfg.greeting);
    if (this.opLevel < 2 && this.cfg.ask_for_op && !this.askedForOp) {
      this.askedForOp = true;
      this.say(`我还没有管理员权限喵～主人可以输入 /op ${bot.username} 给我权限，这样我能帮上更多忙`);
    }
  }

  async setupTeam(bot) {
    const { setup_team: enabled, team_name: team, display_name: name, name_color: color } = this.cfg;
    if (!enabled || this.opLevel < 2 || !/^[\w.+-]{1,16}$/.test(team)) return;
    const current = bot.teamMap?.[bot.username];
    if (current?.team === team) return;
    const prefix = JSON.stringify({ text: `[${name}] `, color });
    const commands = [
      `/team add ${team}`,
      `/team modify ${team} prefix ${prefix}`,
      `/team modify ${team} color ${color}`,
      `/team join ${team} ${bot.username}`,
    ];
    await this.agent.withQuietCommands(true, async () => {
      for (const command of commands) {
        bot.chat(command);
        await sleep(250);
      }
    });
  }

  canTellraw() {
    return this.cfg.speak_with_tellraw && this.opLevel >= 2;
  }

  // 猫娘自己用 /tellraw 说的话会以系统消息的形式回显，据此忽略。
  isEcho(text) {
    const name = this.cfg.display_name;
    return text.startsWith(`<${name}> `) || text.startsWith(`${name} 悄悄对你说：`);
  }

  say(text, { to, link } = {}) {
    if (looksSecret(text)) {
      log.warn('拦截了一句疑似包含密钥的发言，已打码');
      text = redact(text);
    }
    const lines = splitLines(text, this.agent.cfg.chat.max_line_length);
    if (!lines.length) return 0;
    const target = to && PLAYER_NAME.test(to) ? to : null;
    lines.forEach((line, i) => this.queue.push({ line, to: target, link: i === lines.length - 1 ? link : undefined }));
    this.agent.chat.recordSelf(lines.join(' '), target);
    this.agent.events.push('said', { text: lines.join('\n'), to: target });
    this.pump();
    return lines.length;
  }

  // 直接发一条 tellraw 组件（面板用），和说话共用一个队列，保证顺序和发送间隔。
  sendRaw(target, component, plain) {
    this.queue.push({ raw: component, to: PLAYER_NAME.test(target) ? target : '@a' });
    this.agent.events.push('said', { text: `［面板］${plain ?? ''}`, to: target });
    this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const bot = this.agent.bot;
        if (!bot || !this.agent.online) {
          this.queue.length = 0;
          break;
        }
        const { line, to, link, raw } = this.queue.shift();
        try {
          if (raw) bot.chat(`/tellraw ${to} ${JSON.stringify(raw)}`);
          else this.send(bot, line, to, link);
        } catch (err) {
          log.warn('发送聊天失败：', err.message);
        }
        await sleep(350);
      }
    } finally {
      this.pumping = false;
    }
  }

  // 可点击的网页链接
  linkComponent(url) {
    return toComponent(this.agent, { text: ' [点这里打开]', color: 'aqua', underlined: true, url, hover: url });
  }

  send(bot, line, to, link) {
    const { display_name: name, name_color: color } = this.cfg;
    if (this.canTellraw()) {
      const component = to
        ? ['', { text: `${name} 悄悄对你说：`, color: 'gray', italic: true }, { text: line, color: 'gray', italic: true }]
        : ['', { text: '<' }, { text: name, color }, { text: `> ${line}` }];
      if (link) component.push(this.linkComponent(link));
      bot.chat(`/tellraw ${to ?? '@a'} ${JSON.stringify(component)}`);
    } else if (to) {
      bot.whisper(to, link ? `${line} ${link}` : line);
    } else {
      bot.chat(link ? `${line} ${link}` : line);
    }
  }
}
