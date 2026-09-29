// PVP 决斗：玩家向猫娘发起对决。难度见 duelKits.js（简单 / 普通 / 困难Ⅰ～Ⅵ / 作弊Ⅰ～Ⅵ），招式见 duelTactics.js。
// 所有难度都锁 1 滴血——谁先被打到只剩 1 滴血谁输，谁都不会被打死（吃金苹果、图腾触发后的黄心没打掉之前不算输）。
// 装了面板模组 1.0.4+：模组拦住致命伤害（有图腾时让图腾触发），附近的爆炸不破坏方块，还能替双方保管背包、直接穿上临时装备。
// 没装：她收尾改用空手打，保证不会打死对方；装备发进背包，打完按标记收回；不用爆炸。
// 决斗场（duelArena.js）：默认在原地正上方现搭一个空中黑曜石平台（也可以设成家正上方，或者不用），两人传送上去打，
// 打完清场、拆掉，送回原来的位置。结束时不在线的（掉线了）记下来，等他上线再送回去；没拆掉的场地也记着，她路过时再拆。
import fs from 'node:fs';
import path from 'node:path';
import { makeMovements } from './createBot.js';
import { equipBestWeapon, findPlayer } from './helpers.js';
import { Fighter } from './combat.js';
import { giveKitLines } from './combatModes.js';
import { duelKit, duelLevel, parseDuelLevel } from './duelKits.js';
import { ARENA, arenaLoaded, arenaMode, arenaSeats, inArena, prepareArena, removeArena } from './duelArena.js';
import { absorption, DuelTactics } from './duelTactics.js';
import { usePotion } from './potions.js';
import { eatBest } from './survival.js';
import { DUEL_PENDING_FILE, RUNTIME } from '../paths.js';
import { getLog } from '../log.js';
import { sendPanel } from './ui.js';
import { abortError, sleep } from '../util.js';

const log = getLog('决斗');
const STATS_FILE = path.join(RUNTIME, 'duels.json');
const LOCK_HP = 1;
const WEAPON_DAMAGE = { netherite_sword: 8, diamond_sword: 7, iron_sword: 6, stone_sword: 5, golden_sword: 4, wooden_sword: 4, netherite_axe: 10, diamond_axe: 9, iron_axe: 9, stone_axe: 9, golden_axe: 7, wooden_axe: 7, mace: 6, trident: 9 };
const sameArena = (a, b) => Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
const BAR = 'njfu:duel';

// 一局最长几分钟：作弊档 30、其他 15（config.toml 的 [duel] 里改）
export function duelMinutes(level, cfg = {}) {
  return level.group === 'cheat' ? (cfg.cheat_time_limit_minutes ?? 30) : (cfg.time_limit_minutes ?? 15);
}

// 倒计时的文字 m:ss
export const clockText = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// 屏幕上方的倒计时（boss 血条，给对手看）：每秒更新；最后 1 分钟变红、屏幕中间提示一次，最后 10 秒大字倒数。
// 没装面板模组时（每条命令都会在管理员聊天栏里留灰字）不用血条和大字，只在聊天里报几次剩余时间
export class DuelClock {
  constructor(agent, player, level, limitMs) {
    this.agent = agent;
    this.player = player;
    this.level = level;
    this.end = Date.now() + limitMs;
    this.total = Math.round(limitMs / 1000);
    this.quiet = Boolean(agent.quietCommands);
    this.shown = null;
  }

  left() {
    return Math.max(0, Math.ceil((this.end - Date.now()) / 1000));
  }

  start() {
    if (!this.quiet) return;
    const a = this.agent;
    a.adminCommand(`bossbar remove ${BAR}`);
    a.adminCommand(`bossbar add ${BAR} ${JSON.stringify(`PVP 决斗 · ${this.level.name}`)}`);
    a.adminCommand(`bossbar set ${BAR} max ${this.total}`);
    a.adminCommand(`bossbar set ${BAR} color yellow`);
    a.adminCommand(`bossbar set ${BAR} players ${this.player}`);
    this.tick();
  }

  // 在决斗循环里随便调，自己按秒节流
  tick() {
    const left = this.left();
    if (left === this.shown) return;
    this.shown = left;
    const a = this.agent;
    if (!this.quiet) {
      if (left > 0 && (left % 300 === 0 || left === 60 || left === 10)) a.say(`决斗还剩 ${clockText(left)}，打不过可以发 #认输`);
      return;
    }
    const last = left <= 60;
    a.adminCommand(`bossbar set ${BAR} name ${JSON.stringify(`PVP 决斗 · ${this.level.name} · ${last ? '最后' : '剩余'} ${clockText(left)}`)}`);
    a.adminCommand(`bossbar set ${BAR} value ${left}`);
    if (last && !this.red) {
      this.red = true;
      a.adminCommand(`bossbar set ${BAR} color red`);
      a.adminCommand(`title ${this.player} times 5 50 10`);
      a.adminCommand(`title ${this.player} subtitle ${JSON.stringify({ text: '打不过可以发 #认输', color: 'gray' })}`);
      a.adminCommand(`title ${this.player} title ${JSON.stringify({ text: '最后 1 分钟！', color: 'red', bold: true })}`);
    }
    if (left <= 10 && left > 0) {
      if (left === 10) {
        a.adminCommand(`title ${this.player} times 0 25 5`);
        a.adminCommand(`title ${this.player} subtitle ""`);
      }
      a.adminCommand(`title ${this.player} title ${JSON.stringify({ text: String(left), color: 'red', bold: true })}`);
    }
  }

  stop() {
    if (this.quiet) this.agent.adminCommand(`bossbar remove ${BAR}`);
  }
}

function readPending() {
  try {
    return JSON.parse(fs.readFileSync(DUEL_PENDING_FILE, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

export class Duels {
  constructor(agent) {
    this.agent = agent;
    this.active = null;
    // 决斗结束时不在线、还没送回原处的玩家：{ 名字: { x, y, z, dim, arena, at } }
    this.returns = {};
    // 还没拆掉的决斗场（有人掉线在上面，或者当时区块没加载）
    this.staleArenas = [];
    try {
      this.stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    } catch {
      this.stats = {};
    }
  }

  save() {
    fs.mkdirSync(RUNTIME, { recursive: true });
    fs.writeFileSync(STATS_FILE, `${JSON.stringify(this.stats, null, 2)}\n`);
  }

  record(player, result) {
    const s = (this.stats[player] ??= { win: 0, lose: 0, draw: 0 });
    s[result] += 1;
    this.save();
    return s;
  }

  // 正在和他决斗；graceMs > 0 时刚结束的也算（收尾那一下余招不算打猫娘）
  isDueling(player, graceMs = 0) {
    if (this.active?.player === player) return true;
    return graceMs > 0 && this.last?.player === player && Date.now() - this.last.endedAt < graceMs;
  }

  statsText(player) {
    const s = this.stats[player];
    return s ? `${player} 对猫娘的战绩：${s.win} 胜 ${s.lose} 负 ${s.draw} 平` : `${player} 还没和猫娘决斗过`;
  }

  // 决斗要收尾的事（锁血、保管的背包、放下的方块、决斗场、原来的位置）记到磁盘：中途断线的话，重新上线时补上
  savePending() {
    const a = this.active;
    const data = a ? {
      player: a.player, bot: this.agent.bot?.username, locked: Boolean(a.locked), stashed: a.stashed ?? [], placed: [...(a.placed ?? []), ...(a.fluids ?? [])],
      arena: a.arena ?? null, returnTo: a.returnTo ?? null, at: Date.now(),
    } : {};
    data.returns = this.returns;
    data.stale = this.staleArenas;
    try {
      fs.mkdirSync(RUNTIME, { recursive: true });
      fs.writeFileSync(DUEL_PENDING_FILE, `${JSON.stringify(data)}\n`);
    } catch {
      // 记不下来也不影响决斗
    }
  }

  // 刚上线就悬在建筑上限上面（去搭决斗场时断线了）：马上给缓降、送回原处，免得掉下去
  rescueHover() {
    const agent = this.agent;
    const bot = agent.bot;
    if (!bot?.entity || bot.entity.position.y < ARENA.top || agent.identity.opLevel < 2) return;
    const back = readPending().returnTo?.[bot.username];
    agent.adminCommand(`effect give ${bot.username} minecraft:slow_falling 30 0 true`);
    if (back) agent.adminCommand(`execute in ${back.dim ?? 'minecraft:overworld'} run tp ${bot.username} ${back.x} ${back.y} ${back.z}`);
  }

  // 上线时：上次决斗没收完尾（断线了）就补上——解除锁血、把保管的背包还回去、送回原处、拆决斗场；
  // 还有决斗结束时不在线的玩家（等他上线再送回去）、没拆掉的决斗场（她路过时再拆）
  async recover() {
    const agent = this.agent;
    const bot = agent.bot;
    const p = readPending();
    this.returns = { ...(p.returns ?? {}), ...this.returns };
    for (const a of p.stale ?? []) this.keepStale(a, false);
    if (!bot.nekoDuelHooks) {
      bot.nekoDuelHooks = true;
      // 掉线的对手重新上线：他会出现在决斗场上，趁他还在加载时就送回去
      bot.on('playerJoined', (pl) => {
        if (!this.returns[pl.username]) return;
        setTimeout(() => {
          const r = this.returns[pl.username];
          if (!r || agent.bot !== bot || !agent.online) return;
          this.sendBack(pl.username, r);
          this.savePending();
          agent.say(`${pl.username} 回来啦～上次决斗打到一半你掉线了，送你回决斗前的地方`);
        }, 500);
      });
      const sweep = setInterval(() => this.sweepStale(bot).catch(() => {}), 20_000);
      bot.once('end', () => clearInterval(sweep));
    }
    if (agent.identity.opLevel < 2) return;
    if (p.player && !this.active) await this.finishInterrupted(p);
    // 等着送回去的人已经在线：还在决斗场上就送回去；已经自己走开了（或者记了超过 1 小时）就不管了
    for (const [who, r] of Object.entries(this.returns)) {
      if (!bot.players?.[who]) continue;
      const e = findPlayer(bot, who)?.entity;
      if (e && r.arena && inArena(r.arena, e.position)) this.sendBack(who, r);
      else if (e || Date.now() - (r.at ?? 0) > 3_600_000) delete this.returns[who];
    }
    this.savePending();
  }

  // 送回决斗前的位置；不在线的先记着，等他上线再送
  sendBack(who, pos, arena = pos?.arena ?? null) {
    const bot = this.agent.bot;
    if (!pos) return;
    if (who !== bot.username && !bot.players?.[who]) {
      this.returns[who] = { x: pos.x, y: pos.y, z: pos.z, dim: pos.dim, arena, at: Date.now() };
      return;
    }
    delete this.returns[who];
    this.agent.adminCommand(`execute in ${pos.dim ?? 'minecraft:overworld'} run tp ${who} ${pos.x} ${pos.y} ${pos.z}`);
  }

  keepStale(arena, save = true) {
    if (!arena || this.staleArenas.some((s) => sameArena(s, arena))) return;
    this.staleArenas.push({ x: arena.x, y: arena.y, z: arena.z, kind: arena.kind });
    if (save) this.savePending();
  }

  // 打完（或者补收尾时）：对手送回原处（不在线的记着，上线再送）；她带着缓降把场地拆掉，再回原处。
  // 有对手掉线时场地先留着（他上线会出现在场地上），拆不掉的也记着。onlyInside：只送还还站在场地上的人
  async closeArena(arena, returnTo, { onlyInside = false } = {}) {
    const agent = this.agent;
    const bot = agent.bot;
    let waiting = false;
    for (const [who, pos] of Object.entries(returnTo ?? {})) {
      if (who === bot.username) continue;
      const e = findPlayer(bot, who)?.entity;
      if (onlyInside && bot.players?.[who] && !(e && inArena(arena, e.position))) continue;
      this.sendBack(who, pos, arena);
      if (this.returns[who]) waiting = true;
    }
    agent.adminCommand(`effect give ${bot.username} minecraft:slow_falling 15 0 true`);
    await sleep(400);
    const removed = !waiting && await removeArena(agent, arena).catch(() => false);
    if (removed) this.staleArenas = this.staleArenas.filter((s) => !sameArena(s, arena));
    else this.keepStale(arena, false);
    const me = returnTo?.[bot.username];
    if (me && (!onlyInside || inArena(arena, bot.entity.position))) this.sendBack(bot.username, me);
    await sleep(800);
    agent.adminCommand(`effect clear ${bot.username} minecraft:slow_falling`);
  }

  // 没拆掉的决斗场：没人等着从上面送回去、那边的区块加载了、上面没人，就拆掉
  async sweepStale(bot) {
    const agent = this.agent;
    if (agent.bot !== bot || !agent.online || this.active || !this.staleArenas.length || agent.identity.opLevel < 2) return;
    for (const a of [...this.staleArenas]) {
      if (Object.values(this.returns).some((r) => sameArena(r.arena, a))) continue;
      if (!arenaLoaded(bot, a)) continue;
      if (Object.values(bot.entities).some((e) => e.type === 'player' && inArena(a, e.position))) continue;
      if (await removeArena(agent, a).catch(() => false)) {
        this.staleArenas = this.staleArenas.filter((s) => !sameArena(s, a));
        this.savePending();
        log.info(`拆掉了之前留下的决斗场（${a.x}, ${a.y}, ${a.z}）`);
      }
    }
  }

  // 补上中断的决斗的收尾
  async finishInterrupted(p) {
    const agent = this.agent;
    const bot = agent.bot;
    if (p.locked) agent.adminCommand(`njfu duel off ${p.player} ${p.bot ?? bot.username}`);
    agent.adminCommand(`bossbar remove ${BAR}`);
    for (const who of p.stashed ?? []) {
      await agent.chat.capture(async () => bot.chat(`/njfu stash restore ${who}`), 1200).catch(() => {});
    }
    if (p.arena) {
      await this.closeArena(p.arena, p.returnTo, { onlyInside: true });
    } else {
      this.clearArena(p.placed ?? []);
      // 搭决斗场时断线了（对手还没传送过去）：只把她自己送回去
      const me = p.returnTo?.[bot.username];
      if (me && bot.entity.position.y > ARENA.floorY - 10) this.sendBack(bot.username, me);
    }
    if ((p.stashed ?? []).length) {
      await bot.armorManager?.equipAll?.();
      await equipBestWeapon(bot);
    }
    agent.say(`刚才和 ${p.player} 的决斗断开了，装备都换回来了，东西原样还给你们了喵`);
    log.info(`补上了中断的决斗收尾（${p.player}）`);
    this.active = null;
  }

  surrender(player) {
    if (!this.isDueling(player)) return false;
    this.active.surrendered = true;
    return true;
  }

  // 开始决斗（作为一个长任务）。difficulty：难度 id 或中文名（easy / normal / hard…hard6 / cheat…cheat6，“困难Ⅲ”也行）；
  // ctx.arena：这一局在哪打（home / here / off，不填按设置，默认原地上空）
  start(player, difficulty = 'normal', ctx = {}) {
    const agent = this.agent;
    const bot = agent.bot;
    const cfg = agent.cfg.duel;
    if (!cfg.enabled) throw new Error('配置里关闭了决斗');
    const p = findPlayer(bot, player);
    if (!p?.entity) throw new Error(`${player} 离得太远或不在线，要站到我附近才能决斗`);
    if (this.active) throw new Error(`我正在和 ${this.active.player} 决斗`);
    if (agent.identity.opLevel < 2) throw new Error('决斗要临时发装备，需要管理员权限');
    const level = parseDuelLevel(difficulty) ?? duelLevel('normal');
    const mode = arenaMode(ctx.arena) ?? arenaMode(cfg.arena) ?? 'here';
    const username = p.username;
    return agent.tasks.run('duel', `和 ${username} 决斗（${level.name}）`, async (task) => {
      this.active = { player: username, surrendered: false, placed: [], fluids: [], stashed: [] };
      const njfu = agent.serverInfo?.njfuCommands ?? [];
      const locked = njfu.includes('duel');
      const stash = njfu.includes('stash');
      if (locked) {
        agent.adminCommand(`njfu duel on ${username} ${bot.username}`);
        this.active.locked = true;
      }
      this.savePending();
      const kit = duelKit(level, { fire: locked });
      const worn = { me: null, them: null };
      try {
        // 决斗场：先记下两人现在的位置（中途断线也能送回去），搭好了再传送上去
        const dim = `minecraft:${String(bot.game?.dimension ?? 'overworld').replace(/^minecraft:/, '')}`;
        const spot = (v) => ({ x: Number(v.x.toFixed(2)), y: Number(v.y.toFixed(2)), z: Number(v.z.toFixed(2)), dim });
        const them = (findPlayer(bot, username)?.entity ?? p.entity).position;
        this.active.returnTo = { [username]: spot(them), [bot.username]: spot(bot.entity.position) };
        this.savePending();
        const { arena, why } = await prepareArena(agent, {
          mode, fallback: them, back: this.active.returnTo[bot.username], signal: task.signal,
          onLift: () => agent.say(mode === 'home' ? '我先去家上空把决斗场搭好，马上叫你～' : '我先上去把决斗场搭好，马上叫你～'),
        });
        if (arena) {
          this.active.arena = arena;
          // 她没离开的话，对手的位置按传送前的最新位置记
          const now = findPlayer(bot, username)?.entity?.position;
          if (now) this.active.returnTo[username] = spot(now);
          this.savePending();
          const [s1, s2] = arenaSeats(arena);
          agent.adminCommand(`execute in minecraft:overworld run tp ${username} ${s1.x} ${s1.y} ${s1.z} ${s1.yaw} 0`);
          agent.adminCommand(`execute in minecraft:overworld run tp ${bot.username} ${s2.x} ${s2.y} ${s2.z} ${s2.yaw} 0`);
          agent.adminCommand(`effect clear ${bot.username} minecraft:slow_falling`);
          agent.say(`到决斗场啦：${arena.kind === 'home' ? '家' : '原地'}正上方 y=${arena.y} 的空中平台，四周有看不见的墙，掉不下去～打完拆掉、送你回来`);
          for (let i = 0; i < 80 && !findPlayer(bot, username)?.entity; i++) await sleep(100, task.signal);
          await sleep(1000, task.signal);
        } else {
          this.active.returnTo = null;
          this.savePending();
          if (why) agent.say(`${why}，就在这儿打吧`);
        }
        // 默认给对手也穿一套一样的；20 秒内回“不用”才不穿
        const how = stash ? '你身上的东西我先替你保管，打完原样还你' : '装备会放进你背包，你自己穿上，打完收回';
        const same = await agent.social.ask(username, `${level.name}：${level.summary}。也给你穿一套一样的（${how}）；不要的话 20 秒内回“不用”`, { timeoutMs: 20_000 });
        worn.me = await this.wearKit(bot.username, kit, stash);
        if (same !== false) {
          worn.them = await this.wearKit(username, kit, stash).catch((err) => {
            agent.say(`给你换装备没成功：${err.message}`);
            return null;
          });
          if (worn.them && !stash) {
            agent.say('装备放进你背包了，快穿上～10 秒后开始');
            await sleep(10_000, task.signal);
          }
        }
        return await this.fightLoop(task, username, level, cfg);
      } finally {
        // 断线了（收尾命令发不出去）：待办留在磁盘上，下次上线时由 recover() 补做
        const online = agent.online && agent.bot === bot;
        if (!online) {
          this.last = { player: username, endedAt: Date.now() };
          this.active = null;
          return; // eslint-disable-line no-unsafe-finally
        }
        if (worn.them) await this.takeOffKit(username, worn.them).catch(() => {});
        if (worn.me) await this.takeOffKit(bot.username, worn.me).catch(() => {});
        const a = this.active;
        if (a?.arena) await this.closeArena(a.arena, a.returnTo).catch((err) => log.warn(`拆决斗场出错：${err.message}`));
        else this.clearArena();
        if (this.active?.locked) agent.adminCommand(`njfu duel off ${username} ${bot.username}`);
        // 没装模组时她可能真的被打倒：算对方赢
        if (this.active?.died && !this.active.recorded) {
          const s = this.record(username, 'win');
          agent.say(`呜……我被打倒了，${username} 赢了！（战绩 ${s.win} 胜 ${s.lose} 负 ${s.draw} 平）`);
        }
        this.last = { player: username, endedAt: Date.now() };
        this.active = null;
        this.savePending();
        if (bot.usingHeldItem) bot.deactivateItem();
        bot.clearControlStates();
        bot.pathfinder.setGoal(null);
      }
    }, { waitMs: ctx.waitMs ?? 1000, by: ctx.by ?? null });
  }

  // 穿上临时装备。有保管功能：整个背包先交给模组保管，再把装备直接放进对应的格子；没有：发进背包（她自己的一件件穿上）。
  async wearKit(target, kit, stash) {
    const agent = this.agent;
    const bot = agent.bot;
    if (stash) {
      const replies = await agent.chat.capture(async () => bot.chat(`/njfu stash save ${target}`), 1500);
      const r = replies.map((t) => /\[NJFU-STASH\] (\S+) (\S+)/.exec(t)).find((m) => m && m[2] === target);
      if (r?.[1] !== 'saved') {
        throw new Error(r?.[1] === 'exists'
          ? `${target} 上次保管的东西还没还（在存档的 njfu_neko_stash 文件夹里），这次先不换装备`
          : `没能保管 ${target} 的背包，这次先不换装备`);
      }
      this.active?.stashed.push(target);
      this.savePending();
      for (const k of kit) {
        agent.adminCommand(`item replace entity ${target} ${k.slot} with ${k.item}`);
        await sleep(60);
      }
      await sleep(600);
      if (target === bot.username) bot.setQuickBarSlot(0);
      return 'stash';
    }
    if (target === bot.username) await giveKitLines(agent, kit.map((k) => k.item));
    else for (const k of kit) agent.adminCommand(`give ${target} ${k.item}`);
    return 'give';
  }

  // 脱下临时装备：保管的原样放回；没保管的按标记收回（她自己再穿回原来的盔甲）
  async takeOffKit(target, mode) {
    const agent = this.agent;
    const bot = agent.bot;
    if (mode === 'stash') {
      await agent.chat.capture(async () => bot.chat(`/njfu stash restore ${target}`), 1500);
    } else {
      agent.adminCommand(`clear ${target} *[custom_data~{neko_temp:1b}]`);
      await sleep(600);
    }
    if (target === bot.username) {
      await bot.armorManager?.equipAll?.();
      const shield = bot.inventory.items().find((i) => i.name === 'shield');
      if (shield && bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name !== 'shield') await bot.equip(shield, 'off-hand').catch(() => {});
      await equipBestWeapon(bot);
    }
  }

  // 没用决斗场时清场：放下的黑曜石、TNT、蜘蛛网、没收回来的水和岩浆（看一眼还是不是，免得清掉别人的方块）、没炸的末影水晶
  clearArena(placed = [...(this.active?.placed ?? []), ...(this.active?.fluids ?? [])]) {
    const agent = this.agent;
    const bot = agent.bot;
    for (const p of placed) {
      if (/^(obsidian|tnt|cobweb|water|lava)$/.test(bot.blockAt(p)?.name ?? '')) agent.adminCommand(`setblock ${p.x} ${p.y} ${p.z} air`);
      agent.adminCommand(`kill @e[type=minecraft:end_crystal,x=${p.x},y=${p.y},z=${p.z},distance=..3]`);
    }
  }

  async fightLoop(task, username, level, cfg) {
    const agent = this.agent;
    const bot = agent.bot;
    const say = (text) => agent.say(text);
    const healthKey = bot.registry.entitiesByName.player?.metadataKeys?.indexOf('health') ?? 9;
    const playerHealth = (e) => Number(e?.metadata?.[healthKey] ?? 20);
    // 只剩 1 滴血、黄心（吸收）也打没了才算输
    const down = (hp, extra) => hp <= LOCK_HP && extra <= 0;
    const locked = Boolean(this.active?.locked);
    const weapon = await equipBestWeapon(bot);
    // 最重的一击：武器伤害 + 锋利加成，再按暴击 ×1.5。没有模组锁血时，对方的血少于这个就改用空手打（一拳 1 点，打不死）
    const sharp = bot.heldItem?.enchants?.find?.((en) => /sharpness/.test(en.name))?.lvl ?? (level.weaponEnch ? 5 : 0);
    const maxHit = Math.ceil(((WEAPON_DAMAGE[weapon] ?? 1) + (sharp ? 0.5 * sharp + 0.5 : 0)) * 1.5) + 1;

    say(`${username} 向我发起了决斗！难度：${level.name}，打到只剩 1 滴血就停，谁都不会被打死`);
    if (level.potions) {
      say('我先喝点药水～');
      for (const kinds of [['strength'], ['swiftness'], ['fire_resistance']]) await usePotion(agent, kinds).catch(() => null);
      await equipBestWeapon(bot);
    }
    for (const n of ['3', '2', '1']) {
      await sleep(1000, task.signal);
      say(`${n}…`);
    }
    await sleep(800, task.signal);
    say('开打喵！');
    const minutes = duelMinutes(level, cfg);
    // 打不过随时可以认输：聊天栏里给对手一个按钮（装了面板模组点一下就生效）
    sendPanel(agent, username, [[
      { text: '打不过随时可以 ', color: 'gray' },
      agent.menuButtons
        ? { text: '[认输]', color: 'red', bold: true, run: '/njfu ui surrender', hover: '点一下认输，结束这局' }
        : { text: '[认输]', color: 'red', bold: true, suggest: '#认输', hover: '点一下填进聊天框，再按回车' },
      { text: `（这局最长 ${minutes} 分钟，屏幕上方有倒计时）`, color: 'gray' },
    ]]);

    const started = Date.now();
    const limitMs = minutes * 60_000;
    const clock = new DuelClock(agent, username, level, limitMs);
    const fighter = new Fighter(agent, task.signal);
    Object.assign(fighter.flags, { potions: level.potions, golden_apples: level.gapples > 0, totem: level.totems > 0, crits: level.tricks, shield: level.shield });
    const tactics = new DuelTactics(agent, fighter, level, { locked });
    this.active.placed = tactics.placed;
    this.active.fluids = fighter.placedFluids;
    tactics.onPlace = () => this.savePending();
    if (level.shield) await fighter.equipShield();
    // 和平时打玩家用同一套近身技巧（战斗模块的 pvpStep），难度决定用哪些；岩浆只在有模组锁血时用
    const style = {
      reach: level.tricks ? 3.0 : 2.6, interval: level.tricks ? 0 : 1100, strafe: level.tricks, crit: level.tricks, critChance: 0.7,
      shield: level.shield, axeBreak: level.axe, lava: level.fluids && locked,
    };
    // 空手收尾（没有模组锁血时）：不跳劈、不换斧子、不用岩浆
    const bare = { ...style, bare: true, crit: false, axeBreak: false, lava: false };
    let result = 'draw';
    bot.pathfinder.setMovements(makeMovements(bot));
    clock.start();
    // 打斗中自动进食别插进来（每次受伤都会去吃，一吃就被打断又重来）：饿了在打斗空当自己吃
    agent.fighting = (agent.fighting ?? 0) + 1;
    let lastLock = Date.now();
    let lastEat = 0;
    try {
      for (;;) {
        if (task.signal.aborted) throw abortError(task.signal);
        const e = findPlayer(bot, username)?.entity;
        if (!e) {
          result = 'draw';
          say(`${username} 跑掉了？那这局就算平手吧`);
          break;
        }
        if (this.active.surrendered) {
          result = 'lose_player';
          say(`${username} 认输啦！嘿嘿，我赢了喵～`);
          break;
        }
        if (down(playerHealth(e), absorption(bot, e))) {
          result = 'lose_player';
          say(`胜负已分！${username} 只剩 1 滴血了，我赢啦喵～`);
          break;
        }
        if (down(bot.health, absorption(bot, bot.entity))) {
          result = 'win_player';
          say(`呜……我只剩 1 滴血了，${username} 赢了！`);
          break;
        }
        if (Date.now() - started > limitMs) {
          result = 'draw';
          say('时间到！这局平手～');
          break;
        }
        clock.tick();
        // 模组的锁血 10 分钟后自动失效（程序断了也不会一直死不了）：打得久就定时续上
        if (locked && Date.now() - lastLock > 180_000) {
          lastLock = Date.now();
          agent.adminCommand(`njfu duel on ${username} ${bot.username}`);
        }
        // 饿了（≤14）又离对手够远（≥7 格）：抓空当吃一口
        if (bot.food <= 14 && Date.now() - lastEat > 5000 && e.position.distanceTo(bot.entity.position) >= 7) {
          lastEat = Date.now();
          if (await eatBest(bot).catch(() => null)) {
            await equipBestWeapon(bot);
            continue;
          }
        }
        const finishing = !locked && playerHealth(e) <= maxHit;
        if (!finishing && await tactics.step(e)) continue;
        await fighter.pvpStep(e, finishing ? bare : style);
      }
    } finally {
      agent.fighting -= 1;
      clock.stop();
    }
    bot.clearControlStates();
    this.active.recorded = true;

    const player = username;
    let text;
    if (result === 'lose_player') {
      const s = this.record(player, 'lose');
      text = `猫娘赢了（${player} 战绩 ${s.win} 胜 ${s.lose} 负 ${s.draw} 平）`;
    } else if (result === 'win_player') {
      const s = this.record(player, 'win');
      text = `${player} 赢了（战绩 ${s.win} 胜 ${s.lose} 负 ${s.draw} 平）`;
    } else {
      const s = this.record(player, 'draw');
      text = `平局（${player} 战绩 ${s.win} 胜 ${s.lose} 负 ${s.draw} 平）`;
    }
    agent.affection.change(player, 2, '和猫娘决斗', { kind: 'brain', owner: agent.chat.isOwner(player) });
    // 可能还在烧（岩浆、火焰附加、爆炸）：先给双方抗火，免得锁血解除后被烧死
    if (locked) {
      for (const target of [player, bot.username]) agent.adminCommand(`effect give ${target} minecraft:fire_resistance 10 0 true`);
    }
    if (cfg.heal_after) {
      for (const target of [player, bot.username]) {
        agent.adminCommand(`effect give ${target} minecraft:instant_health 1 2`);
        await sleep(300);
      }
      say('双方都回满血啦，下次再来～');
    } else if (bot.food < 20) {
      await eatBest(bot).catch(() => {});
    }
    return text;
  }
}
