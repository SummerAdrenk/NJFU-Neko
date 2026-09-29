// PVP 决斗：玩家向猫娘发起对决。难度见 duelKits.js（简单 / 普通 / 困难Ⅰ～Ⅵ / 作弊Ⅰ～Ⅵ），招式见 duelTactics.js。
// 所有难度都锁 1 滴血——谁先被打到只剩 1 滴血谁输，谁都不会被打死（吃金苹果、图腾触发后的黄心没打掉之前不算输）。
// 装了面板模组 1.0.4+：模组拦住致命伤害（有图腾时让图腾触发），附近的爆炸不破坏方块，还能替双方保管背包、直接穿上临时装备。
// 没装：她收尾改用空手打，保证不会打死对方；装备发进背包，打完按标记收回；不用爆炸。
import fs from 'node:fs';
import path from 'node:path';
import { makeMovements } from './createBot.js';
import { equipBestWeapon, findPlayer } from './helpers.js';
import { Fighter } from './combat.js';
import { giveKitLines } from './combatModes.js';
import { duelKit, duelLevel, parseDuelLevel } from './duelKits.js';
import { absorption, DuelTactics } from './duelTactics.js';
import { usePotion } from './potions.js';
import { eatBest } from './survival.js';
import { DUEL_PENDING_FILE, RUNTIME } from '../paths.js';
import { getLog } from '../log.js';
import { abortError, sleep } from '../util.js';

const log = getLog('决斗');
const STATS_FILE = path.join(RUNTIME, 'duels.json');
const LOCK_HP = 1;
const WEAPON_DAMAGE = { netherite_sword: 8, diamond_sword: 7, iron_sword: 6, stone_sword: 5, golden_sword: 4, wooden_sword: 4, netherite_axe: 10, diamond_axe: 9, iron_axe: 9, stone_axe: 9, golden_axe: 7, wooden_axe: 7, mace: 6, trident: 9 };

export class Duels {
  constructor(agent) {
    this.agent = agent;
    this.active = null;
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

  // 决斗要收尾的事（锁血、保管的背包、放下的方块）记到磁盘：中途断线的话，重新上线时补上
  savePending() {
    const a = this.active;
    const data = a ? { player: a.player, bot: this.agent.bot?.username, locked: Boolean(a.locked), stashed: a.stashed ?? [], placed: a.placed ?? [], at: Date.now() } : {};
    try {
      fs.mkdirSync(RUNTIME, { recursive: true });
      fs.writeFileSync(DUEL_PENDING_FILE, `${JSON.stringify(data)}\n`);
    } catch {
      // 记不下来也不影响决斗
    }
  }

  // 上线时：上次决斗没收完尾（断线了）就补上——解除锁血、把保管的背包还回去、清掉放下的方块
  async recover() {
    const agent = this.agent;
    const bot = agent.bot;
    let p = null;
    try {
      p = JSON.parse(fs.readFileSync(DUEL_PENDING_FILE, 'utf8'));
    } catch {
      return;
    }
    if (!p?.player || this.active || agent.identity.opLevel < 2) return;
    if (p.locked) agent.adminCommand(`njfu duel off ${p.player} ${p.bot ?? bot.username}`);
    for (const who of p.stashed ?? []) {
      await agent.chat.capture(async () => bot.chat(`/njfu stash restore ${who}`), 1200).catch(() => {});
    }
    for (const b of p.placed ?? []) agent.adminCommand(`setblock ${b.x} ${b.y} ${b.z} air`);
    if ((p.stashed ?? []).length) {
      await bot.armorManager?.equipAll?.();
      await equipBestWeapon(bot);
    }
    agent.say(`刚才和 ${p.player} 的决斗断开了，装备都换回来了，东西原样还给你们了喵`);
    log.info(`补上了中断的决斗收尾（${p.player}）`);
    this.active = null;
    this.savePending();
  }

  surrender(player) {
    if (!this.isDueling(player)) return false;
    this.active.surrendered = true;
    return true;
  }

  // 开始决斗（作为一个长任务）。difficulty：难度 id 或中文名（easy / normal / hard…hard6 / cheat…cheat6，“困难Ⅲ”也行）
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
        const how = stash ? '你身上的东西我先替你保管，打完原样还你' : '装备会放进你背包，你自己穿上，打完收回';
        const same = await agent.social.ask(username, `${level.name}：${level.summary}。要不要给你也穿一套一样的？${how}（20 秒内回“好”或“不用”）`, { timeoutMs: 20_000 });
        worn.me = await this.wearKit(bot.username, kit, stash);
        if (same) {
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
        if (worn.them) await this.takeOffKit(username, worn.them).catch(() => {});
        if (worn.me) await this.takeOffKit(bot.username, worn.me).catch(() => {});
        this.clearArena();
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

  // 清场：放下的黑曜石、TNT、蜘蛛网、没收回来的水和岩浆、没炸的末影水晶
  clearArena() {
    const agent = this.agent;
    const bot = agent.bot;
    for (const p of this.active?.placed ?? []) {
      if (/^(obsidian|tnt|cobweb)$/.test(bot.blockAt(p)?.name ?? '')) agent.adminCommand(`setblock ${p.x} ${p.y} ${p.z} air`);
      agent.adminCommand(`kill @e[type=minecraft:end_crystal,x=${p.x},y=${p.y},z=${p.z},distance=..3]`);
    }
    for (const p of this.active?.fluids ?? []) {
      if (/^(water|lava)$/.test(bot.blockAt(p)?.name ?? '')) agent.adminCommand(`setblock ${p.x} ${p.y} ${p.z} air`);
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

    const started = Date.now();
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
      if (Date.now() - started > (cfg.time_limit_seconds ?? 180) * 1000) {
        result = 'draw';
        say('时间到！这局平手～');
        break;
      }
      const finishing = !locked && playerHealth(e) <= maxHit;
      if (!finishing && await tactics.step(e)) continue;
      await fighter.pvpStep(e, finishing ? bare : style);
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
