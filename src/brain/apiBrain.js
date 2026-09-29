// 独立大脑：直接调用 Claude API。每次被叫醒（有人叫猫娘 / 后台任务结束 / 收到礼物…）就开一轮新的“小对话”，
// 把当下的状态、最近聊天和记忆放进第一条消息，让 Claude 用工具行动和说话。
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { runAction, toolDefinitions } from '../bot/actions.js';
import { buildContext } from './context.js';
import { getLog } from '../log.js';
import { addSecret, mask } from '../secrets.js';
import { truncate } from '../util.js';

const log = getLog('大脑');
const PERSONA = fs.readFileSync(new URL('./persona.md', import.meta.url), 'utf8');

const API_RULES = `
## 你怎样和世界互动（重要）
- 每次被叫醒，你会收到：【这次叫醒你的】（谁说了什么、哪个后台任务结束了、谁送了你礼物……）、【你的状态】、【你对他们的好感】、【服务器】、【最近聊天】、【最近行动】、【记得的箱子】、【记忆】。
- 玩家只能看到你用 say 工具说出的话。你在工具之外写的文字玩家看不到，只会作为“给自己的备注”出现在以后的【最近行动】里。
- 想说话就调用 say；要做事就调用对应的工具。常见顺序：先 say 一句回应，再调用行动工具，最后根据结果再 say。
- 工具返回“正在后台进行”表示任务还在做；这一轮就可以结束了，任务结束时你会被再次叫醒。
- 同一时间只能做一件长任务，新的长任务会替换旧的。
- 如果消息不是对你说的、或者不需要回应，可以什么都不说直接结束。
- 不会做或不确定时，先用 knowledge 查资料（配方、来源、Wiki、手册）；可以联网时也能用 web_search / web_fetch 查 Minecraft Wiki 和 MC百科。
- 这一轮结束时，用一句话写下给自己的备注（例如接下来的打算），不要写给玩家看的话。`;

function commandRules(cfg) {
  return `\n## 本服务器的命令规则\n- 任何玩家请求都能用：${cfg.anyone.join('、') || '无'}\n- 执行前先和主人确认：${cfg.confirm.join('、') || '无'}\n- 永远不执行：${cfg.deny.join('、')}`;
}

export class ApiBrain {
  constructor(agent) {
    this.agent = agent;
    this.cfg = agent.cfg.brain.api;
    this.systemText = `${PERSONA.trim()}\n${API_RULES}${commandRules(agent.cfg.commands)}`;

    // 认证：配置文件里的 Key 优先，否则交给 SDK 读环境变量或 ant auth login 的登录凭据。
    const key = String(this.cfg.api_key ?? '').trim();
    for (const secret of [key, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN]) addSecret(secret);
    if (key && !key.startsWith('sk-ant-')) log.warn(`config.toml 里的 api_key（${mask(key)}）看起来不像 Anthropic 的 API Key，请检查`);
    const baseURL = String(this.cfg.base_url ?? '').trim();
    if (baseURL && !/^https:\/\/api\.anthropic\.com\/?$/.test(baseURL)) {
      log.warn(`注意：API 请求（包括你的 API Key）会发送到第三方地址 ${baseURL}，请确认它可信`);
    }
    this.keySource = key ? 'config.toml' : process.env.ANTHROPIC_API_KEY ? '环境变量 ANTHROPIC_API_KEY' : process.env.ANTHROPIC_AUTH_TOKEN ? '环境变量 ANTHROPIC_AUTH_TOKEN' : 'ant 登录凭据';
    const options = { maxRetries: 2 };
    if (key) options.apiKey = key;
    if (baseURL) options.baseURL = baseURL;
    this.client = new Anthropic(options);
    // 客户端已经拿到密钥：从配置对象和环境变量里抹掉，其他模块（包括 eval、日志）再也读不到。
    if (key) this.cfg.api_key = '（已隐藏）';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    this.strict = this.cfg.strict_tools !== false;
    this.fallbacks = this.cfg.fallbacks !== false;
    this.web = this.cfg.web_search !== false;
    this.queue = [];
    this.busy = false;
    this.autoSteps = 0;
    this.history = [];
    this.current = null;
    this.lastComplaint = 0;
    this.lastSocial = new Map();
    this.usage = { episodes: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
    log.info(`大脑：Claude API（${this.cfg.model}，思考力度 ${this.cfg.effort}，认证来源：${this.keySource}${this.fallbacks ? '，拒绝时自动换备用模型' : ''}${this.web ? '，可查 Wiki/MC百科' : ''}）`);
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

  tools() {
    const tools = toolDefinitions(this.strict);
    if (this.web) {
      const domains = this.cfg.web_domains ?? [];
      tools.push(
        { type: 'web_search_20260209', name: 'web_search', max_uses: 3, ...(domains.length ? { allowed_domains: domains } : {}) },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, ...(domains.length ? { allowed_domains: domains } : {}) },
      );
    }
    return tools;
  }

  async create(params, signal) {
    for (;;) {
      const request = {
        ...params,
        model: this.cfg.model,
        max_tokens: this.cfg.max_tokens,
        output_config: { effort: this.cfg.effort },
        cache_control: { type: 'ephemeral' },
        tools: this.tools(),
      };
      if (this.agent.cfg.logging.log_api_payloads) log.fileOnly('debug', `请求：${JSON.stringify(request.messages).slice(0, 20000)}`);
      try {
        if (this.fallbacks) {
          return await this.client.beta.messages.create(
            { ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
            { signal },
          );
        }
        return await this.client.messages.create(request, { signal });
      } catch (err) {
        // 有些代理/中转不支持严格工具、联网工具或服务端备用模型：逐项关闭后重试（只在一轮对话的第一次请求时）。
        if (err instanceof Anthropic.BadRequestError && params.messages.length === 1 && (this.strict || this.web || this.fallbacks)) {
          const off = this.strict ? 'strict' : this.web ? 'web' : 'fallbacks';
          if (off === 'strict') this.strict = false;
          else if (off === 'web') this.web = false;
          else this.fallbacks = false;
          log.warn(`API 拒绝了请求（${err.message}），关闭 ${{ strict: '严格工具模式', web: '联网查询', fallbacks: '备用模型' }[off]} 后重试`);
          continue;
        }
        throw err;
      }
    }
  }

  async episode(triggers) {
    const agent = this.agent;
    const requester = triggers[0].requester ?? null;
    const replyTo = triggers.find((t) => t.type === 'chat' && t.msg.kind === 'whisper')?.msg.from;
    const controller = new AbortController();
    this.current = controller;
    const system = [{ type: 'text', text: this.systemText, cache_control: { type: 'ephemeral' } }];
    const messages = [{
      role: 'user',
      content: buildContext(agent, { triggers, chatLines: this.cfg.recent_chat_lines ?? 20 }),
    }];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let note = '';
    let rounds = 0;
    const started = Date.now();
    agent.events.push('brain', { what: 'episode_start', detail: `${requester?.name ?? '系统'}（${triggers.map((t) => t.type).join('、')}）` });

    try {
      while (rounds < (this.cfg.max_tool_rounds ?? 12)) {
        rounds += 1;
        const t0 = Date.now();
        const response = await this.create({ system, messages }, controller.signal);
        const u = response.usage ?? {};
        usage.input += u.input_tokens ?? 0;
        usage.output += u.output_tokens ?? 0;
        usage.cacheRead += u.cache_read_input_tokens ?? 0;
        usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
        const toolNames = response.content.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use').map((b) => b.name);
        log.info(`第 ${rounds} 轮：${response.stop_reason}，${toolNames.length ? `工具 ${toolNames.join(',')}，` : ''}${Date.now() - t0}ms，输入 ${u.input_tokens ?? 0}（缓存读 ${u.cache_read_input_tokens ?? 0} 写 ${u.cache_creation_input_tokens ?? 0}）输出 ${u.output_tokens ?? 0}，请求 ${response._request_id ?? '?'}`);
        if (agent.cfg.logging.log_api_payloads) log.fileOnly('debug', `回复：${JSON.stringify(response.content).slice(0, 20000)}`);
        // 完整保留助手回复（包括思考块和备用模型的切换块），之后只追加不修改。
        messages.push({ role: 'assistant', content: response.content });
        for (const block of response.content) {
          if (block.type === 'fallback') agent.events.push('brain', { what: 'fallback', detail: `${block.from?.model} → ${block.to?.model}` });
        }

        if (response.stop_reason === 'tool_use') {
          const results = [];
          for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            if (controller.signal.aborted) {
              results.push({ type: 'tool_result', tool_use_id: block.id, content: '玩家让你停下了，这个动作没有执行', is_error: true });
              continue;
            }
            const result = await runAction(agent, block.name, block.input, {
              waitMs: 25_000,
              by: { source: 'brain', name: requester?.name ?? null, owner: requester ? requester.owner !== false : false, requester },
            });
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.text || (result.ok ? '完成' : '失败'),
              ...(result.ok === false ? { is_error: true } : {}),
            });
          }
          messages.push({ role: 'user', content: results });
          if (controller.signal.aborted) break;
          continue;
        }
        if (response.stop_reason === 'pause_turn') continue;

        note = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (response.stop_reason === 'refusal') {
          agent.events.push('brain', { what: 'refusal', detail: response.stop_details?.category ?? null });
          agent.say('这个我帮不上忙喵，换件事吧～', { to: replyTo });
        } else if (response.stop_reason === 'max_tokens') {
          agent.events.push('brain', { what: 'max_tokens' });
        }
        break;
      }
    } catch (err) {
      this.onError(err, replyTo);
    } finally {
      this.current = null;
      this.usage.episodes += 1;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) this.usage[key] += usage[key];
      agent.events.push('brain', {
        what: 'episode_end',
        detail: `${rounds} 轮，${((Date.now() - started) / 1000).toFixed(1)} 秒，输入 ${usage.input} 输出 ${usage.output} 缓存读 ${usage.cacheRead}`,
        note: truncate(note, 300),
      });
    }
  }

  onError(err, replyTo) {
    const agent = this.agent;
    if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') return;
    let line = '我的脑袋卡了一下，再说一次好吗喵';
    const rid = err?.requestID ? `（请求 ${err.requestID}）` : '';
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      log.error(`Claude API 认证失败${rid}：请检查 config.toml 的 brain.api.api_key、环境变量 ANTHROPIC_API_KEY 或 ant auth login`);
      line = '我连不上大脑（API 认证失败），请主人检查一下配置喵';
    } else if (err instanceof Anthropic.RateLimitError) {
      log.warn(`Claude API 限流了${rid}，稍后再试`);
      line = '想事情的人太多了，稍等一会儿再叫我喵';
    } else if (err instanceof Anthropic.APIConnectionError) {
      log.warn(`连不上 Claude API：${err.message}`);
      line = '网络好像断了，我暂时想不了事情喵';
    } else if (err instanceof Anthropic.APIError) {
      log.warn(`Claude API 出错（HTTP ${err.status ?? '?'}）${rid}：${err.message}`);
    } else {
      log.error('大脑出错：', err);
    }
    agent.events.push('brain', { what: 'error', error: truncate(err?.message ?? String(err), 300) });
    agent.say(line, { to: replyTo });
  }
}
