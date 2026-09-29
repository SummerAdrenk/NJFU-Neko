// 猫娘本体：负责连接（必要时经 ViaProxy）、断线重连，并把身份、聊天、生存、任务等模块装到机器人上。
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';
import mc from 'minecraft-protocol';
import mineflayer from 'mineflayer';
import { createBot, makeMovements } from './bot/createBot.js';
import { installFabricHandshake } from './bot/fabricHandshake.js';
import { Identity } from './bot/identity.js';
import { ChatHub } from './bot/chat.js';
import { installSurvival } from './bot/survival.js';
import { TaskManager } from './bot/tasks.js';
import { ServerInfo } from './bot/serverInfo.js';
import { Social } from './bot/social.js';
import { installCompanion } from './bot/companion.js';
import { installGaze } from './bot/gaze.js';
import { Duels } from './bot/duel.js';
import { createEmotes, installInteractions } from './bot/emotes.js';
import { TextureIndex } from './bot/textures.js';
import { runAction } from './bot/actions.js';
import { MemoryStore } from './memory.js';
import { Affection } from './affection.js';
import { ChestIndex } from './chestIndex.js';
import { startViaProxy } from './proxy/viaproxy.js';
import { AFFECTION_FILE, CHESTS_FILE, MEMORY_FILE } from './paths.js';
import { getLog } from './log.js';
import { componentText, fmtPos, sleep, withTimeout } from './util.js';

const log = getLog('连接');

const DIMENSIONS = { overworld: '主世界', the_nether: '下界', the_end: '末地' };

function supportedByMineflayer(version) {
  try {
    const data = mcDataLoader(version);
    return Boolean(data)
      && data.version['>='](mineflayer.oldestSupportedVersion)
      && data.version['<='](mineflayer.latestSupportedVersion);
  } catch {
    return false;
  }
}

// 根据服务器协议号找一个 mineflayer 能直接使用的版本；找不到返回 null。
export function pickDirectVersion(protocol) {
  const candidates = mcDataLoader.postNettyVersionsByProtocolVersion?.pc?.[protocol] ?? [];
  return candidates.map((v) => v.minecraftVersion).find(supportedByMineflayer) ?? null;
}

function describeNetError(err) {
  const codes = {
    ECONNREFUSED: '连接被拒绝（服务器没开，或端口不对）',
    ECONNRESET: '连接被重置',
    ETIMEDOUT: '连接超时',
    ENOTFOUND: '找不到这个地址',
    EHOSTUNREACH: '网络不通',
  };
  return codes[err?.code] ?? err?.message ?? String(err);
}

export class Agent extends EventEmitter {
  constructor(cfg, events) {
    super();
    this.setMaxListeners(0);
    this.cfg = cfg;
    this.events = events;
    this.bot = null;
    this.online = false;
    this.stopping = false;
    this.target = null;
    this.proxy = null;
    this.lastDeath = null;
    this.baseDelay = Math.max(3, Number(cfg.behavior.reconnect_delay_seconds) || 15) * 1000;
    this.retryDelay = this.baseDelay;
    this.identity = new Identity(this);
    this.chat = new ChatHub(this);
    this.tasks = new TaskManager(this);
    this.memory = new MemoryStore(MEMORY_FILE);
    this.affection = new Affection(AFFECTION_FILE, { events, cfg: cfg.affection });
    this.chestIndex = new ChestIndex(CHESTS_FILE);
    this.serverInfo = new ServerInfo(this);
    this.social = new Social(this);
    this.duels = new Duels(this);
    this.emotes = createEmotes(this);
    this.textures = new TextureIndex(cfg);
    this.onlineSince = 0;
    this.seated = false;
    this.homeBed = null;
    this.assistTarget = null;
    this.worldSeed = null;
    this.gameruleStyle = 'snake';
  }

  say(text, opts) {
    if (!this.online) return 0;
    return this.identity.say(text, opts);
  }

  runAction(name, input, ctx) {
    return runAction(this, name, input, ctx);
  }

  // 游戏数据：在线时用服务器的，离线时用客户端协议版本的 minecraft-data。
  registry() {
    return this.bot?.registry ?? (this._registry ??= mcDataLoader(this.cfg.viaproxy.client_version));
  }

  // 管理员命令广播（其他管理员聊天栏里灰色的 [NJFU_Neko: …]）。新版规则名是 log_admin_commands，旧版是 logAdminCommands。
  async adminBroadcast(value) {
    if (!this.online || this.identity.opLevel < 2) return null;
    const rule = this.gameruleStyle === 'camel' ? 'logAdminCommands' : 'log_admin_commands';
    const replies = await this.chat.capture(async () => this.bot.chat(`/gamerule ${rule}${value == null ? '' : ` ${value}`}`), 700);
    if (this.gameruleStyle === 'snake' && replies.some((r) => /Unknown|Incorrect|Expected|未知/i.test(r))) {
      this.gameruleStyle = 'camel';
      return this.adminBroadcast(value);
    }
    return replies.join(' ');
  }

  // 批量执行命令时临时关掉管理员命令广播，免得刷屏，结束后恢复原状。
  async withQuietCommands(enabled, fn) {
    if (!enabled || this.cfg.ui.quiet_admin_commands || this.identity.opLevel < 2) return fn();
    const before = await this.adminBroadcast(null);
    const wasOn = !/false/i.test(before ?? '');
    if (wasOn) await this.adminBroadcast(false);
    try {
      return await fn();
    } finally {
      if (wasOn && this.online) await this.adminBroadcast(true);
    }
  }

  emergencyStop(from, whisperTo) {
    this.emit('interrupt', from);
    this.tasks.cancel(`${from} 让我停下`).catch(() => {});
    this.events.push('bot', { what: 'emergency_stop', by: from });
    this.say('好，停下啦喵', { to: whisperTo ?? undefined });
  }

  async resolveTarget() {
    const { host, port } = this.cfg.server;
    const vp = this.cfg.viaproxy;
    if (vp.mode === 'always') return this.viaTarget(host, port, '未知（强制使用 ViaProxy）');
    let info;
    try {
      info = await withTimeout(mc.ping({ host, port }), 8000, '连接超时');
    } catch (err) {
      throw new Error(`连不上服务器 ${host}:${port}：${describeNetError(err)}。局域网世界请确认已“对局域网开放”，并且端口和 config.toml 一致`);
    }
    const name = info?.version?.name ?? '未知版本';
    const protocol = info?.version?.protocol;
    const configured = String(this.cfg.server.version ?? 'auto');
    const direct = configured !== 'auto' ? configured : pickDirectVersion(protocol);
    if (direct) return { host, port, version: direct, label: `${host}:${port}`, serverVersion: name, via: false };
    if (vp.mode === 'never') throw new Error(`服务器版本 ${name}（协议 ${protocol}）mineflayer 还不支持，而 viaproxy.mode 是 "never"`);
    return this.viaTarget(host, port, name);
  }

  async viaTarget(host, port, serverVersion) {
    const key = `${host}:${port}`;
    if (!this.proxy?.alive || this.proxy.targetKey !== key) {
      this.proxy?.stop();
      log.info(`服务器版本 ${serverVersion} 需要协议转换，正在启动 ViaProxy…`);
      const vp = this.cfg.viaproxy;
      this.proxy = await startViaProxy({
        java: vp.java,
        jar: vp.jar,
        bindPort: vp.bind_port,
        targetHost: host,
        targetPort: port,
        authMethod: vp.auth_method,
      });
      log.info(`✓ ViaProxy 已就绪：127.0.0.1:${this.proxy.port} → ${key}`);
    }
    return {
      host: this.proxy.host,
      port: this.proxy.port,
      version: this.cfg.viaproxy.client_version,
      label: `${key}（经 ViaProxy）`,
      serverVersion,
      via: true,
    };
  }

  async connect() {
    clearTimeout(this.reconnectTimer);
    if (this.stopping) return;
    const { host, port } = this.cfg.server;
    this.events.push('connection', { state: 'connecting', server: `${host}:${port}` });
    let target;
    try {
      target = await this.resolveTarget();
    } catch (err) {
      log.warn(err.message);
      this.events.push('connection', { state: 'error', detail: err.message });
      this.scheduleReconnect(false);
      return;
    }
    this.target = target;
    log.info(`正在以 ${this.cfg.account.username} 的身份连接 ${target.label}（服务器 ${target.serverVersion}，客户端协议 ${target.version}）…`);

    const bot = createBot(this.cfg, target);
    this.bot = bot;
    if (this.cfg.compat.fabric_handshake) {
      installFabricHandshake(bot._client, (detail) => {
        log.info(detail);
        this.events.push('connection', { state: 'handshake', detail });
      });
    }
    this.identity.attach(bot);
    this.chat.attach(bot);
    this.serverInfo.attach(bot);
    this.social.attach(bot);
    installSurvival(this, bot);
    installCompanion(this, bot);
    installGaze(this, bot);
    installInteractions(this, bot);

    let spawned = false;
    bot.on('spawn', () => {
      if (spawned) {
        this.events.push('bot', { what: 'respawn', position: fmtPos(bot.entity.position) });
        return;
      }
      spawned = true;
      this.onSpawn(bot);
    });
    bot.on('kicked', (reason) => {
      const text = componentText(reason) || String(reason);
      log.warn(`被服务器踢出：${text}`);
      this.events.push('connection', { state: 'kicked', detail: text });
    });
    bot.on('error', (err) => {
      log.warn(`连接出错：${describeNetError(err)}`);
      this.events.push('connection', { state: 'error', detail: describeNetError(err) });
    });
    bot.once('end', (reason) => this.onEnd(bot, reason, spawned));
  }

  onSpawn(bot) {
    this.online = true;
    this.onlineSince = Date.now();
    this.seated = false;
    this.retryDelay = this.baseDelay;
    bot.pathfinder.setMovements(makeMovements(bot));
    const dim = String(bot.game?.dimension ?? '').replace(/^minecraft:/, '');
    const where = `${fmtPos(bot.entity.position)} ${DIMENSIONS[dim] ?? dim}`;
    log.info(`✓ 已进入世界：${where}`);
    this.events.push('connection', { state: 'online', server: this.target?.label, serverVersion: this.target?.serverVersion, position: where });
    this.emit('online');
  }

  onEnd(bot, reason, wasOnline) {
    if (this.bot !== bot) return;
    this.online = false;
    this.tasks.cancel('连接断开').catch(() => {});
    log.warn(`已断开连接${reason ? `（${reason}）` : ''}`);
    this.events.push('connection', { state: 'offline', detail: String(reason ?? '') });
    this.emit('offline');
    this.scheduleReconnect(wasOnline);
  }

  scheduleReconnect(wasOnline) {
    if (this.stopping || !this.cfg.behavior.reconnect) return;
    const delay = wasOnline ? this.baseDelay : this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 120_000);
    log.info(`${Math.round(delay / 1000)} 秒后重新连接…`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // 立即重连（例如在命令行里执行 neko reconnect）。
  async reconnect() {
    clearTimeout(this.reconnectTimer);
    this.retryDelay = this.baseDelay;
    if (this.bot) {
      const old = this.bot;
      this.bot = null;
      this.online = false;
      try {
        old.quit('重新连接');
      } catch {
        // 已经断开
      }
    }
    await this.connect();
  }

  async shutdown(reason = '关闭') {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    await this.tasks.cancel(reason).catch(() => {});
    if (this.bot && this.online) {
      try {
        this.bot.quit(reason);
      } catch {
        // 已经断开
      }
      await sleep(500);
    }
    this.proxy?.stop();
  }
}
