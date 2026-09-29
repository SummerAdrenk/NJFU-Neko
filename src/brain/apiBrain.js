// 独立大脑：直接调用 Claude API。每次被叫醒（有人叫猫娘 / 后台任务结束 / 收到礼物…）就开一轮新的“小对话”，
// 把当下的状态、最近聊天和记忆放进第一条消息，让 Claude 用工具行动和说话。排队、限流等公共部分见 common.js。
import Anthropic from '@anthropic-ai/sdk';
import { runAction, toolDefinitions } from '../bot/actions.js';
import { buildContext } from './context.js';
import { apiRules, commandRules, PERSONA, QueuedBrain } from './common.js';
import { getLog } from '../log.js';
import { addSecret, mask } from '../secrets.js';
import { truncate } from '../util.js';

const log = getLog('大脑');

export class ApiBrain extends QueuedBrain {
  constructor(agent) {
    super(agent, agent.cfg.brain.api);

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
    this.systemText = `${PERSONA.trim()}\n${apiRules({ web: this.web })}${commandRules(agent.cfg.commands)}`;
  }

  describe() {
    return `大脑：Claude API（${this.cfg.model}，思考力度 ${this.cfg.effort}，认证来源：${this.keySource}${this.fallbacks ? '，拒绝时自动换备用模型' : ''}${this.web ? '，可查 Wiki/MC百科' : ''}）`;
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
      this.finishEpisode(rounds, started, usage, note);
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
