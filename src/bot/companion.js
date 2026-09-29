// 自主行为：没有任务时也像个玩家一样活动——陪在主人身边绕着走、看着主人、捡掉落物、
// 缺装备/缺吃的时去箱子里拿；离得太远就传送过去。
import { goals, makeMovements } from './createBot.js';
import {
  countItem, findPlayer, fleeFrom, nearestCreeper, nearestThreat, summarizeItems,
} from './helpers.js';
import { canEngage, creeperPlan, fight } from './combat.js';
import { pickFood } from './survival.js';
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
  for (;;) {
    if (task.signal.aborted) throw abortError(task.signal);
    const player = findPlayer(bot, username);
    if (!player) {
      if (loose) return `${username} 下线了`;
      throw new Error(`${username} 下线了`);
    }
    const e = player.entity;

    // 1. 危险处理：苦力怕（有把握就打，没把握就躲），打主人在打的 / 在打主人的怪，打靠近的怪
    const plan = creeperPlan(agent);
    const creeper = nearestCreeper(bot, plan === 'bow' ? 10 : 4);
    if (creeper && (plan === 'flee' || !canEngage(agent, creeper))) {
      await fleeFrom(agent, creeper, task.signal);
      following = null;
      continue;
    }
    const assist = agent.assistTarget;
    agent.assistTarget = null;
    const threat = creeper ?? (assist?.isValid && canEngage(agent, assist) ? assist : null) ?? nearestThreat(agent, bot.entity.position, 4, canEngage);
    if (threat) {
      try {
        await fight(agent, threat, task.signal, 30_000);
      } catch (err) {
        if (task.signal.aborted) throw err;
      }
      following = null;
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
