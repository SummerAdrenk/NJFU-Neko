// 独立大脑（OpenAI 兼容接口）：GPT（OpenAI）、DeepSeek，以及通义千问、Kimi、智谱、本地 Ollama / LM Studio 这类
// 兼容 Chat Completions + 函数调用的服务。和 Claude API 大脑一样：每次被叫醒开一轮新的小对话，用工具行动和说话。
// 直接用 fetch 调接口，不需要额外安装 SDK。排队、限流等公共部分见 common.js。
import { runAction, toolDefinitions } from '../bot/actions.js';
import { buildContext } from './context.js';
import { apiRules, commandRules, PERSONA, QueuedBrain } from './common.js';
import { getLog } from '../log.js';
import { addSecret } from '../secrets.js';
import { sleep, truncate } from '../util.js';

const log = getLog('大脑');

// 服务商预设：默认接口地址、模型、放 Key 的环境变量。custom 要自己填地址和模型。
export const PROVIDERS = {
  openai: { name: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-5', env: 'OPENAI_API_KEY' },
  deepseek: { name: 'DeepSeek', base_url: 'https://api.deepseek.com', model: 'deepseek-chat', env: 'DEEPSEEK_API_KEY' },
  custom: { name: '兼容接口', base_url: '', model: '', env: 'OPENAI_API_KEY' },
};

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

export class HttpError extends Error {
  constructor(status, message, requestId) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

// 接口返回的错误说明（OpenAI / DeepSeek 都是 { error: { message } }）
function errorText(body) {
  try {
    const j = JSON.parse(body);
    return String(j?.error?.message ?? j?.message ?? body);
  } catch {
    return String(body).slice(0, 300);
  }
}

// Anthropic 格式的工具定义 → OpenAI 的函数定义
export function openAiTools(defs) {
  return defs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

export class OpenAiBrain extends QueuedBrain {
  #key;

  constructor(agent) {
    const cfg = agent.cfg.brain.openai ?? {};
    super(agent, cfg);
    const id = String(cfg.provider || 'openai').toLowerCase();
    this.preset = PROVIDERS[id] ?? PROVIDERS.custom;
    this.providerId = PROVIDERS[id] ? id : 'custom';
    this.baseURL = String(cfg.base_url || this.preset.base_url).trim().replace(/\/+$/, '');
    this.model = String(cfg.model || this.preset.model).trim();
    if (!this.baseURL) throw new Error('[brain.openai] 没有填 base_url（接口地址）');
    if (!this.model) throw new Error('[brain.openai] 没有填 model（模型名）');

    // 认证：配置文件里的 Key 优先，否则读环境变量（默认 OPENAI_API_KEY / DEEPSEEK_API_KEY）。本机的 Ollama 这类可以不要 Key。
    this.envName = String(cfg.api_key_env || this.preset.env);
    const fromConfig = String(cfg.api_key ?? '').trim();
    const key = fromConfig || String(process.env[this.envName] ?? '').trim();
    const local = LOCAL.test(this.baseURL);
    if (!key && !local) throw new Error(`没有找到 API Key：在 [brain.openai] 填 api_key，或者设置环境变量 ${this.envName}`);
    addSecret(key);
    this.keySource = fromConfig ? 'config.toml' : key ? `环境变量 ${this.envName}` : '无（本机接口）';
    if (!/^https:\/\//.test(this.baseURL) && !local) log.warn(`注意：接口地址 ${this.baseURL} 不是 https，API Key 会明文发出去`);
    if (this.providerId === 'custom') log.warn(`注意：API 请求（包括你的 API Key）会发送到 ${this.baseURL}，请确认它可信`);
    // 拿到 Key 后从配置对象和环境变量里抹掉（Key 只留在这个对象的私有字段里），其他模块（包括 eval、日志）读不到。
    this.#key = key;
    if (fromConfig) cfg.api_key = '（已隐藏）';
    delete process.env[this.envName];

    // OpenAI 的新模型用 max_completion_tokens，其他兼容接口大多用 max_tokens；不认的话出错时自动换
    this.tokenParam = /api\.openai\.com/.test(this.baseURL) ? 'max_completion_tokens' : 'max_tokens';
    // 思考力度（reasoning_effort）：只有 OpenAI 的推理模型认；不认的话出错时自动关掉
    this.effort = String(cfg.effort ?? '').trim() && this.providerId !== 'deepseek' ? String(cfg.effort).trim() : '';
    this.tools = openAiTools(toolDefinitions(false));
    this.systemText = `${PERSONA.trim()}\n${apiRules({ web: false })}${commandRules(agent.cfg.commands)}`;
  }

  describe() {
    return `大脑：${this.preset.name}（${this.model}${this.effort ? `，思考力度 ${this.effort}` : ''}，接口 ${this.baseURL}，认证来源：${this.keySource}）`;
  }

  // 调一次接口。限流、服务器出错、网络断了会等一下重试两次；模型不认某个参数就去掉它再试。
  async create(messages, signal) {
    const body = { model: this.model, messages, tools: this.tools, tool_choice: 'auto', [this.tokenParam]: Number(this.cfg.max_tokens ?? 8000) };
    if (this.effort) body.reasoning_effort = this.effort;
    let swapped = false;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.#key ? { Authorization: `Bearer ${this.#key}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(Number(this.cfg.timeout_seconds ?? 120) * 1000)]),
        });
      } catch (err) {
        if (signal.aborted || err?.name === 'TimeoutError') throw err;
        if (attempt < 2) {
          await sleep(1500 * (attempt + 1), signal);
          continue;
        }
        throw Object.assign(new Error(`连不上 ${this.preset.name} 接口：${err.cause?.code ?? err.message}`), { connection: true });
      }
      const requestId = res.headers.get('x-request-id') ?? res.headers.get('x-ds-trace-id') ?? null;
      const text = await res.text();
      if (res.ok) {
        const data = JSON.parse(text);
        data._request_id = requestId;
        return data;
      }
      const message = errorText(text);
      if (res.status === 400 || res.status === 422) {
        if (body.reasoning_effort && /reasoning_effort|reasoning/i.test(message)) {
          log.warn(`${this.model} 不支持思考力度参数，去掉后重试`);
          delete body.reasoning_effort;
          this.effort = '';
          continue;
        }
        // 只在接口明确说“不支持这个参数”时换一次（数值超范围之类的错误不换）
        const swap = this.tokenParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
        const named = new RegExp(`(^|[^a-z_])${this.tokenParam}([^a-z_]|$)`).test(message);
        if (!swapped && named && /unsupported|not supported|unrecognized|unknown|not allowed|not permitted/i.test(message)) {
          swapped = true;
          body[swap] = body[this.tokenParam];
          delete body[this.tokenParam];
          this.tokenParam = swap;
          continue;
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2 && !/insufficient|quota|balance/i.test(message)) {
        await sleep(2000 * (attempt + 1), signal);
        continue;
      }
      throw new HttpError(res.status, message, requestId);
    }
  }

  async episode(triggers) {
    const agent = this.agent;
    const requester = triggers[0].requester ?? null;
    const replyTo = triggers.find((t) => t.type === 'chat' && t.msg.kind === 'whisper')?.msg.from;
    const controller = new AbortController();
    this.current = controller;
    const messages = [
      { role: 'system', content: this.systemText },
      { role: 'user', content: buildContext(agent, { triggers, chatLines: this.cfg.recent_chat_lines ?? 20 }) },
    ];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let note = '';
    let rounds = 0;
    const started = Date.now();
    agent.events.push('brain', { what: 'episode_start', detail: `${requester?.name ?? '系统'}（${triggers.map((t) => t.type).join('、')}）` });

    try {
      while (rounds < (this.cfg.max_tool_rounds ?? 12)) {
        rounds += 1;
        const t0 = Date.now();
        if (agent.cfg.logging.log_api_payloads) log.fileOnly('debug', `请求：${JSON.stringify(messages.slice(1)).slice(0, 20000)}`);
        const data = await this.create(messages, controller.signal);
        const u = data.usage ?? {};
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
        usage.input += u.prompt_tokens ?? 0;
        usage.output += u.completion_tokens ?? 0;
        usage.cacheRead += cached;
        const choice = data.choices?.[0];
        if (!choice) throw new Error('接口没有返回内容');
        const msg = choice.message ?? {};
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c) => c?.function?.name) : [];
        log.info(`第 ${rounds} 轮：${choice.finish_reason}，${calls.length ? `工具 ${calls.map((c) => c.function.name).join(',')}，` : ''}${Date.now() - t0}ms，输入 ${u.prompt_tokens ?? 0}（缓存 ${cached}）输出 ${u.completion_tokens ?? 0}，请求 ${data._request_id ?? '?'}`);
        if (agent.cfg.logging.log_api_payloads) log.fileOnly('debug', `回复：${JSON.stringify(msg).slice(0, 20000)}`);
        // 原样保留助手这一步。DeepSeek 思考模式在同一轮工具调用里要把思考内容一起带回去
        messages.push({
          role: 'assistant',
          content: msg.content ?? '',
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(this.providerId === 'deepseek' && calls.length && msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
        });

        if (calls.length) {
          for (const call of calls) {
            let result;
            if (controller.signal.aborted) {
              result = { ok: false, text: '玩家让你停下了，这个动作没有执行' };
            } else {
              let input = null;
              try {
                input = JSON.parse(call.function.arguments || '{}');
              } catch {
                input = null;
              }
              result = input && typeof input === 'object'
                ? await runAction(agent, call.function.name, input, {
                  waitMs: 25_000,
                  by: { source: 'brain', name: requester?.name ?? null, owner: requester ? requester.owner !== false : false, requester },
                })
                : { ok: false, text: '参数不是合法的 JSON，请按工具说明重新调用' };
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: `${result.ok === false ? '【失败】' : ''}${result.text || (result.ok ? '完成' : '失败')}` });
          }
          if (controller.signal.aborted) break;
          continue;
        }

        note = String(msg.content ?? '').trim();
        if (choice.finish_reason === 'content_filter') {
          agent.events.push('brain', { what: 'refusal', detail: 'content_filter' });
          agent.say('这个我帮不上忙喵，换件事吧～', { to: replyTo });
        } else if (choice.finish_reason === 'length') {
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
    if (err?.name === 'AbortError' || this.current?.signal.aborted) return;
    const name = this.preset.name;
    const rid = err?.requestId ? `（请求 ${err.requestId}）` : '';
    let line = '我的脑袋卡了一下，再说一次好吗喵';
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      log.error(`${name} 接口认证失败${rid}：请检查 [brain.openai] 的 api_key 或环境变量 ${this.envName}`);
      line = '我连不上大脑（API 认证失败），请主人检查一下配置喵';
    } else if (err instanceof HttpError && (err.status === 402 || /insufficient|quota|balance/i.test(err.message))) {
      log.error(`${name} 账户余额或额度不足${rid}：${err.message}`);
      line = '大脑的账户没有余额了，请主人充值一下喵';
    } else if (err instanceof HttpError && err.status === 429) {
      log.warn(`${name} 接口限流了${rid}，稍后再试`);
      line = '想事情的人太多了，稍等一会儿再叫我喵';
    } else if (err instanceof HttpError && err.status === 404) {
      log.error(`${name} 接口找不到${rid}：请检查 [brain.openai] 的 base_url 和 model（${this.model}）：${err.message}`);
    } else if (err instanceof HttpError) {
      log.warn(`${name} 接口出错（HTTP ${err.status}）${rid}：${err.message}`);
    } else if (err?.connection) {
      log.warn(err.message);
      line = '网络好像断了，我暂时想不了事情喵';
    } else if (err?.name === 'TimeoutError') {
      log.warn(`${name} 接口太久没有回应`);
      line = '想得太久了，再说一次好吗喵';
    } else {
      log.error('大脑出错：', err);
    }
    agent.events.push('brain', { what: 'error', error: truncate(err?.message ?? String(err), 300) });
    agent.say(line, { to: replyTo });
  }
}
