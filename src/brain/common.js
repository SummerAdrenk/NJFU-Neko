// 独立大脑（Claude API、OpenAI 兼容接口）的公共部分：人设和规则、被叫醒的各种事件、排队（同一个人连着说的几句合并成一轮）、
// 每小时次数上限。具体怎么调模型由子类的 episode() 决定。
import fs from 'node:fs';
import { getLog } from '../log.js';
import { truncate } from '../util.js';

const log = getLog('大脑');
export const PERSONA = fs.readFileSync(new URL('./persona.md', import.meta.url), 'utf8');

export function apiRules({ web = false } = {}) {
  return `
## 你怎样和世界互动（重要）
- 每次被叫醒，你会收到：【这次叫醒你的】（谁说了什么、哪个后台任务结束了、谁送了你礼物……）、【你的状态】、【你对他们的好感】、【服务器】、【最近聊天】、【最近行动】、【记得的箱子】、【记忆】。
- 玩家只能看到你用 say 工具说出的话。你在工具之外写的文字玩家看不到，只会作为“给自己的备注”出现在以后的【最近行动】里。
- 想说话就调用 say；要做事就调用对应的工具。常见顺序：先 say 一句回应，再调用行动工具，最后根据结果再 say。
- 工具返回“正在后台进行”表示任务还在做；这一轮就可以结束了，任务结束时你会被再次叫醒。
- 同一时间只能做一件长任务，新的长任务会替换旧的。
- 如果消息不是对你说的、或者不需要回应，可以什么都不说直接结束。
- 不会做或不确定时，先用 knowledge 查资料（配方、来源、Wiki、手册）${web ? '；可以联网时也能用 web_search / web_fetch 查 Minecraft Wiki 和 MC百科' : ''}。
- 这一轮结束时，用一句话写下给自己的备注（例如接下来的打算），不要写给玩家看的话。`;
}

export function commandRules(cfg) {
  return `\n## 本服务器的命令规则\n- 任何玩家请求都能用：${cfg.anyone.join('、') || '无'}\n- 执行前先和主人确认：${cfg.confirm.join('、') || '无'}\n- 永远不执行：${cfg.deny.join('、')}`;
}

export class QueuedBrain {
  constructor(agent, cfg) {
    this.agent = agent;
    this.cfg = cfg;
    this.queue = [];
    this.busy = false;
    this.autoSteps = 0;
    this.history = [];
    this.current = null;
    this.lastComplaint = 0;
    this.lastSocial = new Map();
    this.usage = { episodes: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  // 启动时在控制台显示的一句说明
  describe() {
    return '大脑';
  }

  start() {
    const agent = this.agent;
    agent.on('addressed', (msg) => this.enqueue({ type: 'chat', msg, requester: { name: msg.from, owner: msg.owner } }));
    agent.on('taskEnded', (task) => {
      if (task.detached && task.by?.source === 'brain' && (task.status === 'done' || task.status === 'failed')) {
        this.enqueue({ type: 'task', task, requester: task.by.requester ?? null });
      }
    });
    agent.on('social', (ev) => {
      // 同一个人 20 秒内的社交事件只叫醒一次，避免连续送礼时刷屏
      const key = `${ev.type}:${ev.player}`;
      if (Date.now() - (this.lastSocial.get(key) ?? 0) < 20_000) return;
      this.lastSocial.set(key, Date.now());
      const text = ev.type === 'gift'
        ? `${ev.player} 送给你 ${ev.item}×${ev.count}（好感 ${ev.affection.applied >= 0 ? '+' : ''}${ev.affection.applied}，现在 ${ev.affection.score}·${ev.affection.level}）`
        : `${ev.player} 打了你一下（好感 ${ev.affection.applied}，现在 ${ev.affection.score}·${ev.affection.level}）`;
      this.enqueue({ type: 'event', text, requester: { name: ev.player, owner: ev.owner } });
    });
    agent.on('interrupt', (from) => {
      this.queue = this.queue.filter((t) => t.requester?.name !== from);
      this.current?.abort('玩家让我停下');
    });
    log.info(this.describe());
  }

  enqueue(trigger) {
    if (trigger.type === 'chat') {
      this.autoSteps = 0;
    } else if (trigger.type === 'task' && ++this.autoSteps > (this.cfg.max_auto_steps ?? 8)) {
      log.warn('后台任务连续自动续做次数太多，先停下等玩家说话');
      return;
    }
    this.queue.push(trigger);
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const first = this.queue.shift();
        const batch = [first];
        // 同一个人连续说的几句话合并成一轮处理。
        for (let i = 0; i < this.queue.length;) {
          if (this.queue[i].requester?.name === first.requester?.name) batch.push(...this.queue.splice(i, 1));
          else i += 1;
        }
        if (!this.agent.online) continue;
        if (!this.allowEpisode()) {
          if (Date.now() - this.lastComplaint > 600_000) {
            this.lastComplaint = Date.now();
            this.agent.say('我今天说了好多话，脑袋有点累，过一会儿再聊喵～');
          }
          continue;
        }
        await this.episode(batch);
      }
    } finally {
      this.busy = false;
    }
  }

  allowEpisode() {
    const hourAgo = Date.now() - 3_600_000;
    this.history = this.history.filter((t) => t > hourAgo);
    if (this.history.length >= (this.cfg.max_episodes_per_hour ?? 120)) return false;
    this.history.push(Date.now());
    return true;
  }

  // 一轮思考：子类实现
  async episode() {
    throw new Error('episode() 没有实现');
  }

  // 一轮结束：累计用量，记一条事件
  finishEpisode(rounds, started, usage, note) {
    this.current = null;
    this.usage.episodes += 1;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) this.usage[key] += usage[key];
    this.agent.events.push('brain', {
      what: 'episode_end',
      detail: `${rounds} 轮，${((Date.now() - started) / 1000).toFixed(1)} 秒，输入 ${usage.input} 输出 ${usage.output} 缓存读 ${usage.cacheRead}`,
      note: truncate(note, 300),
    });
  }
}
