// PVP 决斗：玩家向猫娘发起对决。默认“切磋”规则——把对方打到只剩几颗心就停手，不会真的打死。
import fs from 'node:fs';
import path from 'node:path';
import { makeMovements } from './createBot.js';
import { equipBestWeapon, findPlayer } from './helpers.js';
import { Fighter } from './combat.js';
import { combatFlags, giveCheatKit, removeCheatKit } from './combatModes.js';
import { eatBest } from './survival.js';
import { RUNTIME } from '../paths.js';
import { abortError, sleep } from '../util.js';

const STATS_FILE = path.join(RUNTIME, 'duels.json');
const WEAPON_DAMAGE = { netherite_sword: 8, diamond_sword: 7, iron_sword: 6, stone_sword: 5, golden_sword: 4, wooden_sword: 4, netherite_axe: 10, diamond_axe: 9, iron_axe: 9, stone_axe: 9, golden_axe: 7, wooden_axe: 7, mace: 6, trident: 9 };
const LEVELS = {
  easy: { name: '简单', interval: 1100, strafe: false, crit: false, shield: false, axeBreak: false, lava: false, reach: 2.6 },
  normal: { name: '普通', interval: 0, strafe: true, crit: false, shield: true, axeBreak: true, lava: false, reach: 3.0 },
  hard: { name: '困难', interval: 0, strafe: true, crit: true, shield: true, axeBreak: true, lava: true, reach: 3.0 },
  // 作弊：困难的打法 + 临时换上一套顶级附魔装备，打完收回
  cheat: { name: '作弊', interval: 0, strafe: true, crit: true, shield: true, axeBreak: true, lava: true, reach: 3.0, cheat: true },
};


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

  surrender(player) {
    if (!this.isDueling(player)) return false;
    this.active.surrendered = true;
    return true;
  }

  // 开始决斗（作为一个长任务）。difficulty：easy / normal / hard
  start(player, difficulty = 'normal', ctx = {}) {
    const agent = this.agent;
    const bot = agent.bot;
    const cfg = agent.cfg.duel;
    if (!cfg.enabled) throw new Error('配置里关闭了决斗');
    const p = findPlayer(bot, player);
    if (!p?.entity) throw new Error(`${player} 离得太远或不在线，要站到我附近才能决斗`);
    if (this.active) throw new Error(`我正在和 ${this.active.player} 决斗`);
    const level = LEVELS[difficulty] ?? LEVELS.normal;
    const username = p.username;
    return agent.tasks.run('duel', `和 ${username} 决斗（${level.name}）`, async (task) => {
      this.active = { player: username, surrendered: false };
      let kit = false;
      try {
        // 作弊难度：发一套临时的顶级附魔装备（本来就在作弊模式就不用再发）；切磋时剑上不带火焰附加
        if (level.cheat && combatFlags(agent).mode !== '作弊') {
          if (agent.identity.opLevel < 2) throw new Error('作弊难度要管理员权限（发临时装备）');
          await giveCheatKit(agent, { tier: agent.cfg.combat?.cheat_tier, duel: true, fire: Boolean(cfg.lethal) });
          kit = true;
        }
        return await this.fightLoop(task, username, level, cfg);
      } finally {
        if (kit) await removeCheatKit(agent).catch(() => {});
        this.last = { player: username, endedAt: Date.now() };
        this.active = null;
        if (bot.usingHeldItem) bot.deactivateItem();
        bot.clearControlStates();
        bot.pathfinder.setGoal(null);
      }
    }, { waitMs: ctx.waitMs ?? 1000, by: ctx.by ?? null });
  }

  async fightLoop(task, username, level, cfg) {
    const agent = this.agent;
    const bot = agent.bot;
    const say = (text) => agent.say(text);
    const healthKey = bot.registry.entitiesByName.player?.metadataKeys?.indexOf('health') ?? 9;
    const playerHealth = (e) => Number(e?.metadata?.[healthKey] ?? 20);
    const weapon = await equipBestWeapon(bot);
    await bot.armorManager?.equipAll?.();
    // 最重的一击：武器伤害 + 锋利加成，再按暴击 ×1.5；切磋时对方血量低于这个就停，保证不会一下打死
    const sharp = bot.heldItem?.enchants?.find?.((en) => /sharpness/.test(en.name))?.lvl ?? (level.cheat ? 5 : 0);
    const maxHit = Math.ceil(((WEAPON_DAMAGE[weapon] ?? 1) + (sharp ? 0.5 * sharp + 0.5 : 0)) * 1.5) + 1;
    const mercy = cfg.lethal ? 0 : Math.max(Number(cfg.mercy_health ?? 6), maxHit);

    say(`${username} 向我发起了决斗！难度：${level.name}，${cfg.lethal ? '真打' : '切磋（打到只剩几颗心就停）'}`);
    for (const n of ['3', '2', '1']) {
      await sleep(1000, task.signal);
      say(`${n}…`);
    }
    await sleep(800, task.signal);
    say('开打喵！');

    const started = Date.now();
    const fighter = new Fighter(agent, task.signal);
    await fighter.equipShield();
    // 和平时打玩家用同一套技巧（战斗模块的 pvpStep），难度决定用哪些；岩浆只在“真打”的决斗里用
    const style = {
      reach: level.reach, interval: level.interval, strafe: level.strafe, crit: level.crit, shield: level.shield,
      axeBreak: level.axeBreak, lava: level.lava && Boolean(cfg.lethal),
    };
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
      if (!cfg.lethal && playerHealth(e) <= mercy) {
        result = 'lose_player';
        say(`胜负已分！${username} 只剩 ${Math.ceil(playerHealth(e) / 2)} 颗心了，我赢啦喵～`);
        break;
      }
      if (bot.health <= Number(cfg.surrender_health ?? 4)) {
        result = 'win_player';
        say(`呜……我打不过了，${username} 赢了！`);
        break;
      }
      if (Date.now() - started > (cfg.time_limit_seconds ?? 180) * 1000) {
        result = 'draw';
        say('时间到！这局平手～');
        break;
      }
      await fighter.pvpStep(e, style);
    }
    bot.clearControlStates();

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
    if (cfg.heal_after && agent.identity.opLevel >= 2) {
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
