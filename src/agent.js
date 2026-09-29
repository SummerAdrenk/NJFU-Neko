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
import { installCombatSense } from './bot/combat.js';
import { installFallSafety } from './bot/movement.js';
import { Duels } from './bot/duel.js';
import { createEmotes, installInteractions } from './bot/emotes.js';
import { TextureIndex } from './bot/textures.js';
import { runAction } from './bot/actions.js';
import { findPlayer, Vec3 } from './bot/helpers.js';
import { MENU_ACTIONS, showInventoryDialog, showMenuDialog, supportsDialog } from './bot/inventoryView.js';
import { MemoryStore } from './memory.js';
import { Affection } from './affection.js';
import { ChestIndex } from './chestIndex.js';
import { startViaProxy } from './proxy/viaproxy.js';
import fs from 'node:fs';
import { AFFECTION_FILE, BOATS_FILE, CHESTS_FILE, HOME_FILE, MEMORY_FILE, REQUESTS_FILE } from './paths.js';
import { RequestStore } from './requests.js';
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
    this.requests = new RequestStore(REQUESTS_FILE);
    this.serverInfo = new ServerInfo(this);
    this.social = new Social(this);
    this.duels = new Duels(this);
    this.emotes = createEmotes(this);
    this.textures = new TextureIndex(cfg);
    this.onlineSince = 0;
    this.seated = false;
    this.homeBed = null;
    try {
      const h = JSON.parse(fs.readFileSync(HOME_FILE, 'utf8'));
      if (Number.isFinite(h.x)) this.homeBed = new Vec3(h.x, h.y, h.z);
    } catch {
      // 还没有家
    }
    this.assistTarget = null;
    this.worldSeed = null;
    // 自己放的船（困怪用）：记在 runtime/boats.json，重启后也认得；船的编号变了（世界重开）就按位置认
    try {
      this.boatSpots = JSON.parse(fs.readFileSync(BOATS_FILE, 'utf8')).filter((b) => Date.now() - b.at < 86_400_000);
    } catch {
      this.boatSpots = [];
    }
    this.myBoats = new Set(this.boatSpots.map((b) => b.id));
    this.on('panel', (ev) => this.onPanel(ev));
  }

  rememberBoat(boat) {
    this.myBoats.add(boat.id);
    const { x, y, z } = boat.position;
    this.boatSpots = [...this.boatSpots.filter((b) => b.id !== boat.id), { id: boat.id, x, y, z, at: Date.now() }];
    this.saveBoats();
  }

  forgetBoat(id) {
    this.myBoats.delete(id);
    this.boatSpots = this.boatSpots.filter((b) => b.id !== id);
    this.saveBoats();
  }

  saveBoats() {
    try {
      fs.writeFileSync(BOATS_FILE, `${JSON.stringify(this.boatSpots)}\n`);
    } catch {
      // 写不了就只记在内存里
    }
  }

  // 记住家（睡过的床）的位置，重启后也记得
  setHome(pos) {
    this.homeBed = pos.clone();
    try {
      fs.writeFileSync(HOME_FILE, `${JSON.stringify({ x: pos.x, y: pos.y, z: pos.z, at: new Date().toISOString() })}\n`);
    } catch {
      // 写不了就只记在内存里
    }
  }

  say(text, opts) {
    if (!this.online) return 0;
    return this.identity.say(text, opts);
  }

  // 面板模组的通知：有人右键了她（模组已经打开了人物面板）、Shift+右键（要功能菜单）、点了菜单按钮（do）。
  onPanel({ action, player, what }) {
    if (!this.online || !this.bot?.entity) return;
    if (action === 'do') {
      this.onMenuButton(player, what);
      return;
    }
    this.events.push('bot', { what: action === 'menu' ? 'menu_open' : 'panel_open', by: player });
    const e = findPlayer(this.bot, player)?.entity;
    if (e && Date.now() > (this.lookLockUntil ?? 0)) this.bot.lookAt(e.position.offset(0, e.eyeHeight ?? 1.6, 0)).catch(() => {});
    if (action !== 'menu') return;
    if (this.identity.opLevel >= 2 && supportsDialog(this)) showMenuDialog(this, player);
    else this.say('我还没有管理员权限，弹不出菜单喵……发 #帮助 看看我能做什么吧', { to: player });
  }

  // 功能菜单的按钮：当成这个玩家发了对应的快捷命令（bag = 离她太远开不了人物面板，改成弹背包窗口）
  onMenuButton(player, what) {
    this.events.push('bot', { what: 'menu_button', by: player, detail: what });
    if (what === 'bag') {
      if (this.identity.opLevel >= 2 && supportsDialog(this)) showInventoryDialog(this, player);
      return;
    }
    const button = MENU_ACTIONS[what];
    if (button) this.chat.runQuick(player, button.text);
  }

  runAction(name, input, ctx) {
    return runAction(this, name, input, ctx);
  }

  // 游戏数据：在线时用服务器的，离线时用客户端协议版本的 minecraft-data。
  registry() {
    return this.bot?.registry ?? (this._registry ??= mcDataLoader(this.cfg.viaproxy.client_version));
  }

  // 装了面板模组（mod/ 目录）时，服务器会给猫娘一个 /njfu quiet 命令：用它执行管理员命令就不会在其他管理员的聊天栏里
  // 留下灰色的 [NJFU_Neko: …] 提示。没装时只能照常执行（原版的广播只能靠关掉 send_command_feedback 来避免，那会影响所有人）。
  get quietCommands() {
    return this.serverInfo.njfuCommands.includes('quiet');
  }

  // 面板模组 1.0.2 起有 /njfu ui：功能菜单的按钮点一下就生效
  get menuButtons() {
    return this.serverInfo.njfuCommands.includes('ui');
  }

  adminCommand(command) {
    const c = String(command).trim().replace(/^\/+/, '');
    this.bot.chat(this.quietCommands ? `/njfu quiet ${c}` : `/${c}`);
  }

  // 兼容旧调用：批量执行命令。静默与否由 adminCommand 决定，这里直接执行。
  async withQuietCommands(enabled, fn) {
    return fn();
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
    installCombatSense(this, bot);
    installFallSafety(this, bot);
    installInteractions(this, bot);

    let spawned = false;
    // 登录超时：连上了却一直进不了世界（握手卡住）就断开重连，不然会一直卡着
    const loginTimer = setTimeout(() => {
      if (spawned || this.bot !== bot) return;
      log.warn('连上服务器 60 秒还没进入世界（握手卡住了），断开重连');
      this.events.push('connection', { state: 'error', detail: '登录超时，重连' });
      bot.end('登录超时');
    }, 60_000);
    bot.once('end', () => clearTimeout(loginTimer));
    bot.on('spawn', () => {
      if (spawned) {
        this.events.push('bot', { what: 'respawn', position: fmtPos(bot.entity.position) });
        return;
      }
      spawned = true;
      clearTimeout(loginTimer);
      this.onSpawn(bot);
    });
    bot.on('kicked', (reason) => {
      const text = componentText(reason) || (typeof reason === 'string' ? reason : JSON.stringify(reason));
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
