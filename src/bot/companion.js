// 自主行为：没有任务时也像个玩家一样活动——陪在主人身边绕着走、看着主人、捡掉落物、
// 缺装备/缺吃的时去箱子里拿；离得太远就传送过去。
import { goals, makeMovements } from './createBot.js';
import {
  countItem, findNearestBlock, findPlayer, fleeFrom, isAliveEntity, nearestCreeper, nearestThreat, protectedReason, summarizeItems,
} from './helpers.js';
import { chestPartner, smeltCore, withChest } from './actions.js';
import { canEngage, creeperPlan, fight, outnumbered, pickTarget, retreatFromCrowd } from './combat.js';
import { pickFood } from './survival.js';
import { freeSeat, isPortalNear, mountEntity, usePortal } from './movement.js';
import { getLog } from '../log.js';
import { abortError, sleep } from '../util.js';

const log = getLog('自主');

const ARMOR_SLOTS = { head: /_helmet$/, torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/ };
const TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'turtle', 'leather', 'stone', 'wooden'];
const tierOf = (name) => {
  const i = TIERS.findIndex((t) => name.startsWith(`${t}_`));
  return i < 0 ? TIERS.length : i;
};

// 跟随 / 陪伴的共用循环。
//   minDist/maxDist：保持的距离；hover：主人站着不动时在他身边绕圈走动；loose：主人不见太久就结束。
export async function accompanyLoop(agent, username, task, { minDist = 2, maxDist = 4, hover = true, loose = false } = {}) {
  const bot = agent.bot;
  const cfg = agent.cfg.behavior;
  let lostSince = null;
  let lastTp = 0;
  let nextHover = Date.now() + 4000;
  let following = null;
  let lastSeen = null;
  for (;;) {
    if (task.signal.aborted) throw abortError(task.signal);
    const player = findPlayer(bot, username);
    if (!player) {
      if (loose) return `${username} 下线了`;
      throw new Error(`${username} 下线了`);
    }
    const e = player.entity;
    if (e) lastSeen = { pos: e.position.clone(), t: Date.now() };

    // 0. 坐船 / 坐骑：主人还在同一条船上就一起坐着；主人下去了我也下去。主人坐进有空位的船或骆驼，就一起坐上去
    if (bot.vehicle) {
      if (e && e.vehicle === bot.vehicle) {
        await sleep(500, task.signal);
        continue;
      }
      bot.dismount();
      await sleep(400, task.signal);
    } else if (e?.vehicle && freeSeat(e.vehicle) && /(boat|raft)$|^(camel|camel_husk|happy_ghast)$/.test(e.vehicle.name)
      && e.position.distanceTo(bot.entity.position) < 8) {
      bot.pathfinder.setGoal(null);
      following = null;
      await mountEntity(agent, e.vehicle, task.signal).catch(() => {});
      continue;
    }

    // 1. 危险处理：苦力怕（有把握就打，没把握就躲），打主人在打的 / 在打主人的怪，打靠近的怪
    const plan = creeperPlan(agent);
    const creeper = nearestCreeper(bot, plan === 'bow' ? 10 : 4);
    if (creeper && (plan === 'flee' || !canEngage(agent, creeper))) {
      await fleeFrom(agent, creeper, task.signal);
      following = null;
      continue;
    }
    // 怪太多（尸潮之类）而且已经受伤：先撤，不硬拼
    if (outnumbered(agent) && bot.health < 16) {
      following = null;
      await retreatFromCrowd(agent, task.signal).catch((err) => {
        if (task.signal.aborted) throw err;
      });
      await sleep(200, task.signal);
      continue;
    }
    const assist = agent.assistTarget;
    agent.assistTarget = null;
    const threat = creeper ?? (assist?.isValid && canEngage(agent, assist) ? assist : null) ?? pickTarget(agent, username);
    if (threat) {
      try {
        await fight(agent, threat, task.signal, 60_000);
      } catch (err) {
        if (task.signal.aborted) throw err;
      }
      following = null;
      await sleep(200, task.signal);
      continue;
    }

    // 2. 太远或看不见：有管理员权限就传送过去
    const dist = e ? e.position.distanceTo(bot.entity.position) : Infinity;
    const tpDist = Number(cfg.teleport_distance ?? 0);
    if (tpDist > 0 && dist > tpDist && agent.identity.opLevel >= 2 && Date.now() - lastTp > 15_000) {
      lastTp = Date.now();
      bot.pathfinder.setGoal(null);
      following = null;
      agent.adminCommand(`tp ${bot.username} ${username}`);
      agent.events.push('bot', { what: 'teleport', detail: `离 ${username} 太远，传送过去` });
      await sleep(1000, task.signal);
      continue;
    }
    // 主人刚从传送门那里消失：没有管理员权限传送的话，就跟着走传送门
    if (!e && lastSeen && Date.now() - lastSeen.t < 20_000 && agent.identity.opLevel < 2) {
      const kind = isPortalNear(bot, lastSeen.pos, 3);
      if (kind) {
        lastSeen = null;
        following = null;
        agent.say('等等我，我也过去喵～');
        try {
          await usePortal(agent, task.signal, { kind });
        } catch (err) {
          if (task.signal.aborted) throw err;
        }
        continue;
      }
    }
    if (!e) {
      lostSince ??= Date.now();
      if (loose && Date.now() - lostSince > 60_000) return `看不到 ${username} 了`;
      if (!loose && Date.now() - lostSince > 60_000) throw new Error(`跟丢了 ${username}`);
      await sleep(1000, task.signal);
      continue;
    }
    lostSince = null;

    // 3. 保持距离：远了就跟上，近了就停下；主人不动时在旁边绕着走
    if (dist > maxDist) {
      if (following !== e) {
        bot.pathfinder.setMovements(makeMovements(bot, { dig: cfg.dig_while_pathing }));
        bot.pathfinder.setGoal(new goals.GoalFollow(e, minDist), true);
        following = e;
      }
    } else if (following && dist <= minDist + 0.6) {
      bot.pathfinder.setGoal(null);
      following = null;
    } else if (hover && !following && !bot.pathfinder.isMoving() && Date.now() > nextHover) {
      nextHover = Date.now() + 5000 + Math.random() * 7000;
      const angle = Math.random() * Math.PI * 2;
      const r = minDist + Math.random() * Math.max(0.5, maxDist - minDist);
      const p = e.position;
      bot.pathfinder.setMovements(makeMovements(bot));
      bot.pathfinder.setGoal(new goals.GoalNear(p.x + Math.cos(angle) * r, p.y, p.z + Math.sin(angle) * r, 1));
    }
    if (!bot.pathfinder.isMoving() && Date.now() > (agent.lookLockUntil ?? 0)) {
      bot.lookAt(e.position.offset(0, e.eyeHeight ?? 1.6, 0)).catch(() => {});
    }
    await sleep(400, task.signal);
  }
}

// 打猎（主人同意后）：牛、猪、羊、鸡、兔子，每种附近至少留两只，不打命名的和小的；捡起掉落，有熔炉就烤熟。
const FOOD_ANIMALS = { cow: 'beef', mooshroom: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' };

export async function hunt(agent, signal, want = 3) {
  const bot = agent.bot;
  const babyOf = (e) => {
    const keys = bot.registry.entitiesByName[e.name]?.metadataKeys ?? [];
    return e.metadata?.[keys.indexOf('baby')] === true;
  };
  let got = 0;
  for (let i = 0; i < want; i++) {
    if (signal?.aborted) throw abortError(signal);
    const counts = {};
    for (const e of Object.values(bot.entities)) if (FOOD_ANIMALS[e.name] && isAliveEntity(bot, e)) counts[e.name] = (counts[e.name] ?? 0) + 1;
    const target = Object.values(bot.entities)
      .filter((e) => FOOD_ANIMALS[e.name] && isAliveEntity(bot, e) && !babyOf(e) && counts[e.name] > 2 && !protectedReason(agent, e)
        && e.position.distanceTo(bot.entity.position) < 40)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!target) break;
    const where = target.position.clone();
    if (await fight(agent, target, signal, 25_000)) got += 1;
    await sleep(600, signal);
    const drops = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(where) < 5);
    if (drops.length) await bot.collectBlock.collect(drops, { ignoreNoPath: true }).catch(() => {});
  }
  // 附近有熔炉就把生肉烤熟
  const raw = bot.inventory.items().find((i) => Object.values(FOOD_ANIMALS).includes(i.name));
  if (raw && findNearestBlock(bot, ['furnace', 'smoker'], 24)) await smeltCore(agent, raw, raw.count, signal).catch(() => {});
  return got ? `打了 ${got} 只动物，找到吃的了` : '附近没有能打的动物（每种至少留两只，不打小的和命名的）';
}

// 陪伴对象：在线的主人（主人名单为空时就是离得最近的玩家）。
function companionTarget(agent) {
  const bot = agent.bot;
  const me = bot.entity.position;
  let best = null;
  let bestDist = Infinity;
  for (const p of Object.values(bot.players)) {
    if (p.username === bot.username || !agent.chat.isOwner(p.username)) continue;
    const d = p.entity ? p.entity.position.distanceTo(me) : 1e6;
    if (d < bestDist) {
      best = p.username;
      bestDist = d;
    }
  }
  return best;
}

export function installCompanion(agent, bot) {
  const cfg = agent.cfg.behavior;
  let idleSince = Date.now();
  let lastGear = 0;
  let lastAskFood = 0;
  let busy = false;

  // 翻箱子：附近 48 格里没打开过（或者 20 分钟没看过）的箱子，打开看一眼记下来（只看不拿）；大箱子两半只开一次
  async function surveyChests(limit = 8) {
    const ids = ['chest', 'trapped_chest', 'barrel'].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x != null);
    const stale = (p) => {
      const t = agent.chestIndex.seenAt(p);
      return !t || Date.now() - Date.parse(t) > 20 * 60_000;
    };
    const seen = new Set();
    const spots = [];
    for (const p of bot.findBlocks({ matching: ids, maxDistance: 48, count: 512 })) {
      if (spots.length >= limit) break;
      if (seen.has(p.toString()) || !stale(p)) continue;
      seen.add(p.toString());
      const partner = chestPartner(bot, p);
      if (partner) seen.add(partner.toString());
      spots.push(p);
    }
    if (!spots.length) return false;
    await agent.tasks.run('survey', `翻看附近的 ${spots.length} 个箱子`, async (task) => {
      for (const p of spots) {
        try {
          await withChest(agent, p, task.signal, async () => {});
        } catch (err) {
          if (task.signal.aborted) throw err;
        }
      }
      return '记下了附近箱子里有什么';
    }, { waitMs: 0, by: { source: 'self' } });
    return true;
  }

  // 饿了没吃的：先去记得的箱子拿（gearUp）→ 翻附近没看过的箱子 → 问主人能不能去打猎
  let lastHuntAsk = 0;
  let lastSurvey = 0;
  async function seekFood() {
    if (pickFood(bot) || bot.food > 14) return false;
    if (cfg.use_chests && Date.now() - lastSurvey > 120_000) {
      lastSurvey = Date.now();
      if (await surveyChests(8)) return true;
    }
    if (bot.food > 12 || Date.now() - lastHuntAsk < 10 * 60_000) return false;
    const owner = companionTarget(agent);
    if (!owner) return false;
    lastHuntAsk = Date.now();
    const ok = await agent.social.ask(owner, '我饿了，身上和箱子里都没有吃的……可以去附近打几只动物吗？（回“好”或“不行”）');
    if (!ok) {
      if (ok === false) agent.say('好吧，那我忍一忍，主人记得给我点吃的喵');
      return false;
    }
    agent.tasks.run('hunt', '打猎找吃的', (task) => hunt(agent, task.signal), { waitMs: 0, by: { source: 'self', name: owner, owner: true } }).catch(() => {});
    return true;
  }

  const triedItems = new Map();
  async function pickupNearby() {
    const me = bot.entity.position;
    const item = Object.values(bot.entities).find((e) => e.name === 'item' && e.position.distanceTo(me) < 5
      && !agent.social.isOwnDrop(e.id) && (triedItems.get(e.id) ?? 0) < 2
      && !Object.values(bot.players).some((p) => p.entity && p.username !== bot.username && p.entity.position.distanceTo(e.position) < 1.5));
    if (!item || bot.inventory.emptySlotCount() === 0) return false;
    triedItems.set(item.id, (triedItems.get(item.id) ?? 0) + 1);
    if (triedItems.size > 200) triedItems.clear();
    await agent.tasks.run('pickup', '捡东西', async (task) => {
      bot.pathfinder.setMovements(makeMovements(bot));
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5)).catch(() => {}),
        sleep(6000, task.signal),
      ]);
      return '捡起了掉落物';
    }, { waitMs: 0, by: { source: 'self' } });
    return true;
  }

  // 缺盔甲 / 武器 / 食物时，到记得的箱子里拿。
  async function gearUp() {
    const want = [];
    for (const [slot, re] of Object.entries(ARMOR_SLOTS)) {
      const worn = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
      const best = agent.chestIndex.find((n) => re.test(n), bot.entity.position)
        .filter((c) => c.distance < 48)
        .sort((a, b) => tierOf(a.name) - tierOf(b.name))[0];
      if (best && (!worn || tierOf(best.name) < tierOf(worn.name))) want.push({ ...best, take: 1 });
    }
    const hasWeapon = bot.inventory.items().some((i) => /_sword$|_axe$/.test(i.name));
    if (!hasWeapon) {
      const w = agent.chestIndex.find((n) => /_sword$/.test(n), bot.entity.position).filter((c) => c.distance < 48)
        .sort((a, b) => tierOf(a.name) - tierOf(b.name))[0];
      if (w) want.push({ ...w, take: 1 });
    }
    // 打架用的：盾牌、弓和箭、一条船（困怪用）
    const has = (re) => bot.inventory.items().some((i) => re.test(i.name))
      || re.test(bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name ?? '');
    const nearest = (re) => agent.chestIndex.find((n) => re.test(n), bot.entity.position).filter((c) => c.distance < 48)[0];
    for (const [re, take] of [[/^shield$/, 1], [/^bow$/, 1], [/^arrow$/, 32], [/^oak_boat$|_boat$/, 1]]) {
      if (has(re) || (re.source === '^arrow$' && !has(/^bow$/) && !want.some((w) => w.name === 'bow'))) continue;
      const found = nearest(re);
      if (found) want.push({ ...found, take: Math.min(take, found.count) });
    }
    if (!pickFood(bot)) {
      const f = agent.chestIndex.find((n) => Boolean(bot.registry.foodsByName?.[n]) && !/rotten|spider_eye|poisonous|pufferfish/.test(n), bot.entity.position)
        .filter((c) => c.distance < 48)[0];
      if (f) want.push({ ...f, take: Math.min(16, f.count) });
      else if (bot.food <= 12 && Date.now() - lastAskFood > 300_000) {
        lastAskFood = Date.now();
        const owner = companionTarget(agent);
        if (owner) agent.say('主人……我肚子饿了，可是身上没有吃的，能给我一点吗喵？', { to: owner });
      }
    }
    if (!want.length) return false;
    const chest = want[0];
    const items = want.filter((w) => w.x === chest.x && w.y === chest.y && w.z === chest.z);
    await agent.tasks.run('gear', `去箱子拿 ${items.map((i) => i.name).join('、')}`, async (task) => {
      const got = [];
      for (const it of items) {
        const r = await agent.runAction('chest', { action: 'withdraw', x: it.x, y: it.y, z: it.z, item: it.name, count: it.take }, { waitMs: 60_000, by: { source: 'self' } });
        if (task.signal.aborted) throw abortError(task.signal);
        if (r.ok) got.push(`${it.name}×${it.take}`);
      }
      await bot.armorManager?.equipAll?.();
      if (got.length) agent.say(`我从箱子里拿了 ${got.join('、')}，这下安心多了喵`);
      return got.length ? `拿到了 ${got.join('、')}` : '什么都没拿到';
    }, { waitMs: 0, by: { source: 'self' } });
    return true;
  }

  function calm() {
    const me = bot.entity.position;
    if (nearestThreat(agent, me, 10, canEngage)) return false;
    const owner = companionTarget(agent);
    const e = owner ? findPlayer(bot, owner)?.entity : null;
    return !e || e.position.distanceTo(me) < 12;
  }

  async function tick() {
    if (!agent.online || !bot.entity || bot.isSleeping || busy) {
      idleSince = Date.now();
      return;
    }
    const cur = agent.tasks.current;
    if (cur && cur.name !== 'companion') {
      idleSince = Date.now();
      return;
    }
    const idleMs = Date.now() - idleSince;
    if (idleMs < 3000) return;
    // 陪伴中也会顺手捡东西、去箱子拿装备，但身边有怪或主人走远时不分心
    if (cur && (agent.fighting || !calm())) return;
    busy = true;
    try {
      if (cfg.pickup_items && await pickupNearby()) return;
      if (cfg.use_chests && Date.now() - lastGear > 60_000) {
        lastGear = Date.now();
        if (await gearUp()) return;
      }
      if (cfg.auto_eat && await seekFood()) return;
      // 平时也顺手翻翻附近没看过的箱子（每 3 分钟一轮，一轮最多 8 个），缺东西时知道去哪拿
      if (cfg.use_chests && cfg.survey_chests !== false && Date.now() - lastSurvey > 180_000) {
        lastSurvey = Date.now();
        if (await surveyChests(8)) return;
      }
      if (cfg.companion && !cur) {
        const owner = companionTarget(agent);
        if (owner) {
          agent.tasks.run('companion', `陪着 ${owner}`, (task) => accompanyLoop(agent, owner, task, {
            minDist: 3, maxDist: 7, hover: true, loose: true,
          }), { waitMs: 0, by: { source: 'self' } }).catch(() => {});
        }
      }
    } catch (err) {
      log.debug(`自主行为出错：${err.message}`);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => tick(), 1000);
  bot.once('end', () => clearInterval(timer));
  log.debug(`自主行为已启动（陪伴 ${cfg.companion ? '开' : '关'}，捡东西 ${cfg.pickup_items ? '开' : '关'}，用箱子 ${cfg.use_chests ? '开' : '关'}）`);
  return { summarize: () => summarizeItems(bot.inventory.items()), countItem: (n) => countItem(bot, n) };
}
