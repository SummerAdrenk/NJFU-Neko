// 社交与陪伴反应：帮主人打怪、保护主人、有人睡觉时问要不要一起睡、识别礼物、被玩家打时降好感。
import { getLog } from '../log.js';
import { findPlayer, gotoNear, nearestThreat } from './helpers.js';
import { canEngage, fight, noteAttacker } from './combat.js';
import { combatFlags } from './combatModes.js';
import { bedError, runAction } from './actions.js';
import { abortError, sleep } from '../util.js';

const log = getLog('社交');

// 快速回答（去掉称呼后匹配开头）
const YES = /^(好|嗯|恩|要|去|睡|可以|行|来|一起|拿|用|当然|ok|okay|yes|sure|y$)/i;
const NO = /^(不|别|算了|no|nope|n$)/i;
// 主人直接叫她去睡：“睡觉”“去睡吧”“一起睡”
export const SLEEP_WORDS = /^(一起)?(去)?睡(觉|吧|觉吧|觉去|觉啦)?[了啦]?[喵～~!！。.]*$/;
// 这些任务期间可以顺手打架；做正事（采集、合成、运输…）时不打断。
const INTERRUPTIBLE = new Set(['companion', 'follow', 'guard', 'come']);
// 这些顺手做的事：有怪打人时直接换成去打怪
const PREEMPTIBLE = new Set(['survey', 'pickup']);

// 能不能睡（和原版一样：晚上 12542～23459 刻，或者雷雨天）
export function canSleepNow(bot) {
  const tod = bot.time?.timeOfDay ?? 0;
  return (tod >= 12542 && tod <= 23459) || bot.thunderState > 0;
}

export class Social {
  constructor(agent) {
    this.agent = agent;
    this.pending = null;
    this.askedSleep = new Map();
    this.lastHurtBy = new Map();
    this.drops = new Map();
    this.sleepWith = null; // 这一晚答应了陪谁睡：{ player, since }
  }

  attach(bot) {
    this.pending = null;
    this.drops.clear();
    // 答应了一起睡：被打醒、死了、被别的事打断，只要还是晚上、他还躺着，就自己回床上接着睡
    const sleepTimer = setInterval(() => this.safe(() => this.keepSleeping(bot)), 5000);
    bot.once('end', () => clearInterval(sleepTimer));
    bot.on('entityHurt', (entity, source) => this.safe(() => this.onHurt(bot, entity, source)));
    bot.on('entitySleep', (entity) => this.safe(() => this.onSleep(bot, entity)));
    bot.on('itemDrop', (entity) => this.safe(() => this.onItemDrop(bot, entity)));
    bot.on('playerCollect', (collector, collected) => this.safe(() => this.onCollect(bot, collector, collected)));
    bot.on('entityGone', (entity) => this.drops.delete(entity.id));
  }

  safe(fn) {
    try {
      const r = fn();
      if (r?.catch) r.catch((err) => log.debug(err.message));
    } catch (err) {
      log.debug(err.message);
    }
  }

  canJoinFight() {
    const cur = this.agent.tasks.current;
    return !cur || INTERRUPTIBLE.has(cur.name);
  }

  // 跟随/陪伴中就交给它们的循环处理；空闲时开一个短的战斗任务。
  engage(target, desc) {
    const agent = this.agent;
    const cur = agent.tasks.current;
    if (cur && INTERRUPTIBLE.has(cur.name)) {
      agent.assistTarget = target;
      return;
    }
    if (cur && !PREEMPTIBLE.has(cur.name)) return;
    agent.tasks.run('defend', desc, async (task) => {
      const won = await fight(agent, target, task.signal, 30_000);
      return won ? `打倒了 ${target.name}` : `${target.name} 跑掉了`;
    }, { waitMs: 0, by: { source: 'self' } }).catch(() => {});
  }

  onHurt(bot, entity, source) {
    const agent = this.agent;
    const cfg = agent.cfg.behavior;
    if (!entity || !agent.online) return;
    // 猫娘被玩家打
    if (entity === bot.entity) {
      if (source?.type === 'player' && source.username && source.username !== bot.username) {
        if (agent.duels?.isDueling(source.username, 5000)) return; // 决斗中、刚结束 5 秒内挨打是正常的
        const now = Date.now();
        if (now - (this.lastHurtBy.get(source.username) ?? 0) < 5000) return;
        this.lastHurtBy.set(source.username, now);
        const owner = agent.chat.isOwner(source.username);
        const r = agent.affection.change(source.username, -3, '打了猫娘', { kind: 'hurt', owner });
        agent.events.push('bot', { what: 'attacked', by: source.username, detail: `好感 ${r.applied} → ${r.score}` });
        agent.emit('social', { type: 'attacked', player: source.username, owner, affection: r });
      }
      return;
    }
    // 主人被怪打 → 记下仇恨，去保护主人
    if (entity.type === 'player' && entity.username && entity.username !== bot.username && agent.chat.isOwner(entity.username)) {
      if (source && source.type !== 'player') noteAttacker(agent, source, entity.username);
      if (cfg.protect_owner && source && canEngage(agent, source) && this.canJoinFight()
        && source.position.distanceTo(bot.entity.position) < combatFlags(agent).engage_radius) {
        log.info(`${source.name} 在打 ${entity.username}，去保护`);
        this.engage(source, `保护 ${entity.username}：${source.name}`);
      }
      return;
    }
    // 主人在打怪（近战或者射箭）→ 记下，过去帮忙（远处的有弓就射）
    if (source?.type === 'player' && source.username !== bot.username && agent.chat.isOwner(source.username)) {
      noteAttacker(agent, entity, 'owner_target');
      if (cfg.assist_owner && canEngage(agent, entity) && this.canJoinFight() && entity.position.distanceTo(bot.entity.position) < combatFlags(agent).engage_radius) {
        log.info(`${source.username} 在打 ${entity.name}，去帮忙`);
        this.engage(entity, `帮 ${source.username} 打 ${entity.name}`);
      }
    }
  }

  onSleep(bot, entity) {
    const agent = this.agent;
    if (entity.type !== 'player' || !entity.username || entity.username === bot.username || bot.isSleeping) return;
    if (!agent.cfg.behavior.ask_to_sleep || !canSleepNow(bot)) return;
    const name = entity.username;
    // 这一晚已经答应过了（比如他起来又躺下）：不用再问，直接去
    if (this.sleepWith?.player === name) {
      this.goSleep(name, { quiet: true }).catch(() => {});
      return;
    }
    if (Date.now() - (this.askedSleep.get(name) ?? 0) < 300_000) return;
    this.askedSleep.set(name, Date.now());
    const owner = agent.chat.isOwner(name);
    this.pending = { kind: 'sleep', player: name, expires: Date.now() + 120_000 };
    agent.events.push('bot', { what: 'ask_sleep', by: name });
    agent.say(`${owner && agent.cfg.chat.owners.length ? '主人' : name}要睡觉啦？我也去睡吗～（回“好”我就去）`);
  }

  // 问玩家一个“是/否”问题，等他在聊天里回答。返回 true（同意）/ false（拒绝）/ null（没回答）。
  ask(player, text, { timeoutMs = 90_000 } = {}) {
    const agent = this.agent;
    if (this.pending?.resolve) this.pending.resolve(null);
    return new Promise((resolve) => {
      const pending = { kind: 'ask', player, expires: Date.now() + timeoutMs, resolve };
      this.pending = pending;
      agent.events.push('bot', { what: 'question', by: player, detail: text });
      agent.say(text);
      setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        resolve(null);
      }, timeoutMs);
    });
  }

  // 聊天里对猫娘提问的回答（要不要一起睡、要不要去箱子拿材料……）。返回 true 表示已处理。
  handleReply(msg) {
    let text = msg.text.trim();
    for (const t of this.agent.cfg.chat.triggers) text = text.split(t).join('');
    text = text.replace(/^[\s,，.。!！~～]+/, '');
    // 主人直接说“睡觉”“去睡吧”：马上去，不用等大脑
    if (msg.owner && msg.addressed && SLEEP_WORDS.test(text)) {
      if (this.pending?.kind === 'sleep') this.pending = null;
      this.goSleep(msg.from).catch(() => {});
      return true;
    }
    const p = this.pending;
    if (!p || Date.now() > p.expires || p.player !== msg.from) return false;
    if (p.kind === 'ask' && (YES.test(text) || NO.test(text))) {
      this.pending = null;
      p.resolve(!NO.test(text));
      return true;
    }
    if (YES.test(text)) {
      this.pending = null;
      this.goSleep(msg.from).catch((err) => this.agent.say(`睡不了：${err.message}`, { to: msg.kind === 'whisper' ? msg.from : undefined }));
      return true;
    }
    if (NO.test(text)) {
      this.pending = null;
      this.agent.say('好的～那我在旁边守着你喵');
      runAction(this.agent, 'guard', { player: msg.from }, { waitMs: 0, by: { source: 'self', name: msg.from, owner: msg.owner } }).catch(() => {});
      return true;
    }
    return false;
  }

  // 和 player 一起睡：记下这一晚答应了他，然后开一个“睡觉”任务（见 sleepLoop）。
  async goSleep(player, { quiet = false } = {}) {
    const agent = this.agent;
    const bot = agent.bot;
    if (!canSleepNow(bot)) {
      if (!quiet) agent.say('现在还不能睡喵（要天黑或者打雷才行）');
      return;
    }
    this.sleepWith = { player, since: this.sleepWith?.player === player ? this.sleepWith.since : Date.now() };
    if (bot.isSleeping || agent.tasks.current?.name === 'sleep') return;
    if (!quiet) agent.say('好嘞，这就去睡～');
    await agent.tasks.run('sleep', `和 ${player} 一起睡觉`, (task) => this.sleepLoop(task, player), {
      waitMs: 0, by: { source: 'self', name: player, owner: agent.chat.isOwner(player) },
    });
  }

  // 睡到天亮：床边有怪（原版 8 格内有敌对生物就不让睡）先打掉；被打醒了就起来打，打完再回床上；天亮了结束。
  async sleepLoop(task, player) {
    const agent = this.agent;
    const bot = agent.bot;
    let refused = 0;
    while (canSleepNow(bot)) {
      if (task.signal.aborted) throw abortError(task.signal);
      if (bot.isSleeping) {
        await sleep(1000, task.signal);
        continue;
      }
      const bed = this.findBed(player);
      if (!bed) {
        agent.say('附近 32 格没有空床，睡不了喵');
        return '没有空床';
      }
      const mob = nearestThreat(agent, bed.position, 10, canEngage);
      if (mob) {
        await fight(agent, mob, task.signal, 30_000).catch((err) => {
          if (task.signal.aborted) throw err;
        });
        continue;
      }
      if (bot.entity.position.distanceTo(bed.position.offset(0.5, 0, 0.5)) > 2.2) {
        await gotoNear(agent, bed.position, 1, { signal: task.signal }).catch((err) => {
          if (task.signal.aborted) throw err;
        });
      }
      try {
        await bot.sleep(bot.blockAt(bed.position));
        agent.setHome(bed.position);
        refused = 0;
      } catch (err) {
        const reason = bedError(err);
        // 看不见的怪（墙后、地下）也会挡着不让睡：等一会儿再试；被怪打退、离床远了：走回去再试；一直不行就算了
        if (/怪物|太远/.test(reason) && ++refused < 12) {
          await sleep(/怪物/.test(reason) ? 2500 : 500, task.signal);
          continue;
        }
        if (/不是晚上/.test(reason)) break;
        agent.say(`睡不了喵：${reason.replace(/^睡不了：/, '')}`);
        return reason;
      }
    }
    return '天亮了';
  }

  findBed(player) {
    const agent = this.agent;
    const bot = agent.bot;
    const home = agent.homeBed ? bot.blockAt(agent.homeBed) : null;
    if (home && bot.isABed(home) && !home.getProperties().occupied) return home;
    const near = bot.players[player]?.entity?.position ?? bot.entity.position;
    return bot.findBlocks({ matching: (b) => bot.isABed(b), point: near, maxDistance: 32, count: 30 })
      .map((p) => bot.blockAt(p))
      .find((b) => b && !b.getProperties().occupied) ?? null;
  }

  // 他还躺着吗（看玩家的姿势是不是“睡觉”）
  isAsleep(bot, player) {
    const e = findPlayer(bot, player)?.entity;
    const idx = bot.registry.entitiesByName.player?.metadataKeys?.indexOf('pose') ?? -1;
    const pose = idx >= 0 ? e?.metadata?.[idx] : null;
    return pose === 2 || pose === 'sleeping';
  }

  keepSleeping(bot) {
    const agent = this.agent;
    const w = this.sleepWith;
    if (!w || !agent.online || !bot.entity) return;
    if (!canSleepNow(bot) || Date.now() - w.since > 15 * 60_000) {
      this.sleepWith = null;
      return;
    }
    const cur = agent.tasks.current;
    if (bot.isSleeping || agent.fighting || (cur && !['companion', 'pickup'].includes(cur.name))) return;
    if (!this.isAsleep(bot, w.player)) return;
    this.goSleep(w.player, { quiet: true }).catch(() => {});
  }

  onItemDrop(bot, entity) {
    if (this.drops.has(entity.id)) return;
    // 物品刚出现时离谁最近，就当是谁丢的（丢出的物品从玩家眼睛高度飞出）。
    let thrower = null;
    let best = 2.6;
    for (const p of Object.values(bot.players)) {
      if (!p.entity) continue;
      const d = p.entity.position.offset(0, 1.3, 0).distanceTo(entity.position);
      if (d < best) {
        best = d;
        thrower = p.username;
      }
    }
    this.drops.set(entity.id, { at: Date.now(), thrower });
  }

  onCollect(bot, collector, collected) {
    if (collector !== bot.entity) return;
    const info = this.drops.get(collected.id);
    this.drops.delete(collected.id);
    const item = collected.getDroppedItem?.();
    if (!item || !info?.thrower || info.thrower === bot.username || Date.now() - info.at > 60_000) return;
    const agent = this.agent;
    // 决斗里（和刚打完）捡到的东西是打斗掉的（砍蜘蛛网掉的线等），不算礼物
    if (agent.duels?.active || agent.duels?.isDueling(info.thrower, 30_000)) return;
    const owner = agent.chat.isOwner(info.thrower);
    const r = agent.affection.change(info.thrower, agent.affection.giftValue(item.name, item.count), `送了 ${item.name}×${item.count}`, { kind: 'gift', owner });
    agent.events.push('bot', { what: 'gift', by: info.thrower, detail: `${item.name}×${item.count}，好感 ${r.applied >= 0 ? '+' : ''}${r.applied} → ${r.score}` });
    agent.giftLedger ??= [];
    agent.giftLedger.push({ player: info.thrower, item: item.name, count: item.count, t: Date.now() });
    if (agent.giftLedger.length > 200) agent.giftLedger.splice(0, agent.giftLedger.length - 200);
    agent.emit('social', { type: 'gift', player: info.thrower, owner, item: item.name, count: item.count, affection: r });
  }

  // 猫娘自己丢出去的物品（交给玩家）不要再捡回来。
  isOwnDrop(entityId) {
    return this.drops.get(entityId)?.thrower === this.agent.bot?.username;
  }
}
