// 各种技能共用的小工具：名称解析、寻路、放置、敌我判断、背包统计。
import vec3 from 'vec3';
import { goals, makeMovements } from './createBot.js';
import { abortable, abortError, sleep, withTimeout } from '../util.js';

export const { Vec3 } = vec3;

// ── 名称解析 ────────────────────────────────────────────────

export const normalizeName = (name) => String(name ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');

// 这些泛称会匹配所有同类方块，例如 log → oak_log、birch_log……
const GROUPS = { log: '_log', logs: '_log', wood: '_log', planks: '_planks', ore: '_ore', ores: '_ore', leaves: '_leaves', wool: '_wool', bed: '_bed', beds: '_bed', sapling: '_sapling', flower: '_tulip' };

export function resolveBlockIds(bot, name) {
  const n = normalizeName(name);
  const byName = bot.registry.blocksByName;
  const ids = new Set();
  const add = (key) => {
    if (byName[key]) ids.add(byName[key].id);
  };
  add(n);
  add(`deepslate_${n}`);
  if (n === 'stone') add('cobblestone');
  const suffix = GROUPS[n] ?? (ids.size ? null : `_${n}`);
  if (suffix) {
    for (const block of bot.registry.blocksArray) {
      if (block.name.endsWith(suffix) && !block.name.startsWith('potted_') && !block.name.startsWith('stripped_')) ids.add(block.id);
    }
  }
  return [...ids];
}

export function resolveItem(bot, name) {
  const n = normalizeName(name);
  return bot.registry.itemsByName[n] ?? null;
}

export function suggestNames(bot, name, kind = 'items') {
  const n = normalizeName(name);
  const pool = kind === 'blocks' ? bot.registry.blocksArray : bot.registry.itemsArray;
  const hits = pool.map((x) => x.name).filter((x) => x.includes(n) || (n.length > 3 && n.includes(x)));
  return hits.slice(0, 6);
}

export function unknownName(bot, name, kind) {
  const hints = suggestNames(bot, name, kind);
  const what = kind === 'blocks' ? '方块' : '物品';
  return new Error(`不认识${what}「${name}」${hints.length ? `，你是不是想说：${hints.join('、')}` : '（请用英文 ID，例如 oak_log）'}`);
}

// ── 背包 ────────────────────────────────────────────────────

export function countItem(bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0);
}

export function findItem(bot, name) {
  const n = normalizeName(name);
  return bot.inventory.items().find((i) => i.name === n) ?? null;
}

export function summarizeItems(items, limit = 40) {
  const totals = new Map();
  for (const item of items) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  const list = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`);
  if (!list.length) return '空';
  return list.length > limit ? `${list.slice(0, limit).join(', ')} 等 ${list.length} 种` : list.join(', ');
}

// ── 世界查询 ────────────────────────────────────────────────

export function findPlayer(bot, name) {
  const key = Object.keys(bot.players).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key ? bot.players[key] : null;
}

export function findNearestBlock(bot, names, maxDistance = 32) {
  const ids = names.flatMap((n) => resolveBlockIds(bot, n));
  if (!ids.length) return null;
  return bot.findBlock({ matching: ids, maxDistance });
}

const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'parched', 'creeper', 'spider', 'cave_spider',
  'witch', 'slime', 'magma_cube', 'phantom', 'blaze', 'ghast', 'wither_skeleton', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
  'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite', 'hoglin', 'zoglin', 'piglin_brute', 'breeze', 'illusioner']);
// 这些不主动招惹：中立生物、打不动的（嘎枝要先拆它的心脏）、Boss（只在主人明确要求时打）。
const NEVER_FIGHT = new Set(['warden', 'ender_dragon', 'wither', 'enderman', 'zombified_piglin', 'piglin', 'creaking']);
// 这些不能贴身打：苦力怕会爆炸（要躲开），飞在天上的够不着。
const NO_MELEE = new Set(['creeper', 'ghast', 'phantom', 'happy_ghast']);

export function isHostile(entity) {
  if (!entity?.name || NEVER_FIGHT.has(entity.name)) return false;
  return HOSTILE.has(entity.name) || entity.type === 'hostile';
}

export const canMelee = (entity) => isHostile(entity) && !NO_MELEE.has(entity.name);

// 生物是否挂了命名牌（custom_name 元数据存在）。
export function isNamed(bot, entity) {
  const keys = bot.registry.entitiesByName[entity?.name]?.metadataKeys;
  const index = keys ? keys.indexOf('custom_name') : 2;
  const value = entity?.metadata?.[index];
  return value != null && value !== false && value !== '';
}

function inZone(pos, zone) {
  const [x1, y1, z1, x2, y2, z2] = zone;
  return pos.x >= Math.min(x1, x2) && pos.x <= Math.max(x1, x2) + 1
    && pos.y >= Math.min(y1, y2) && pos.y <= Math.max(y1, y2) + 1
    && pos.z >= Math.min(z1, z2) && pos.z <= Math.max(z1, z2) + 1;
}

// 船和矿车（坐在里面的生物多半是机器里的）。
export const isVehicleItemEntity = (entity) => /(^|_)(boat|raft|minecart)$/.test(entity?.name ?? '');

// 不该打的生物：命名过的、坐在船或矿车里的、在禁战区里的（刷怪塔、农场等机器里的生物）。
// 骑在别的生物身上的（蜘蛛骑士、鸡骑士、骷髅马骑士、劫掠兽骑手……）照打；猫娘自己放船困住的也照打。
export function protectedReason(agent, entity) {
  const cfg = agent.cfg.behavior;
  if (cfg.never_attack_named && isNamed(agent.bot, entity)) return '挂了命名牌';
  const v = entity.vehicle;
  if (v && isVehicleItemEntity(v) && !agent.myBoats?.has(v.id)) return '坐在船或矿车里（可能是机器里的生物）';
  const zones = cfg.no_attack_zones ?? [];
  if (zones.some((z) => Array.isArray(z) && z.length === 6 && inZone(entity.position, z))) return '在禁战区里';
  return null;
}

// 生物还活着吗（死掉后倒地动画的那一秒里实体还在，但生命已经是 0）
export function isAliveEntity(bot, entity) {
  if (!entity || entity.isValid === false) return false;
  const keys = bot.registry.entitiesByName[entity.name]?.metadataKeys;
  const i = keys ? keys.indexOf('health') : -1;
  const h = i >= 0 ? entity.metadata?.[i] : undefined;
  return typeof h !== 'number' || h > 0;
}

// 可以主动去打的敌对生物：能近战、没被保护、还活着。
export const isThreat = (agent, entity) => canMelee(entity) && isAliveEntity(agent.bot, entity) && !protectedReason(agent, entity);

export function nearestThreat(agent, center, radius, test = isThreat) {
  const bot = agent.bot;
  let best = null;
  let bestDist = radius;
  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity || !test(agent, entity)) continue;
    const d = entity.position.distanceTo(center);
    if (d <= bestDist) {
      best = entity;
      bestDist = d;
    }
  }
  return best && preferRider(agent, best, test);
}

// 骑乘组合先打骑手（骑手往往是输出，比如蜘蛛背上的骷髅）。
export function preferRider(agent, entity, test = isThreat) {
  const rider = (entity.passengers ?? []).find((p) => p !== agent.bot.entity && test(agent, p));
  return rider ?? entity;
}

// 最近的可以近战的敌对生物（默认排除苦力怕等）。
export function nearestHostile(bot, center, radius, { meleeOnly = true } = {}) {
  let best = null;
  let bestDist = radius;
  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity || !(meleeOnly ? canMelee(entity) : isHostile(entity))) continue;
    const d = entity.position.distanceTo(center);
    if (d <= bestDist) {
      best = entity;
      bestDist = d;
    }
  }
  return best;
}

export function nearestCreeper(bot, radius) {
  let best = null;
  let bestDist = radius;
  for (const entity of Object.values(bot.entities)) {
    if (entity.name !== 'creeper' || !isAliveEntity(bot, entity)) continue;
    const d = entity.position.distanceTo(bot.entity.position);
    if (d <= bestDist) {
      best = entity;
      bestDist = d;
    }
  }
  return best;
}

// 远离某个实体（比如快爆炸的苦力怕），跑到 distance 格以外或超时为止。
export async function fleeFrom(agent, entity, signal, { distance = 9, timeoutMs = 6000 } = {}) {
  const bot = agent.bot;
  bot.pathfinder.setMovements(makeMovements(bot));
  bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(entity, distance)), true);
  const until = Date.now() + timeoutMs;
  try {
    while (entity.isValid && Date.now() < until && entity.position.distanceTo(bot.entity.position) < distance) {
      await sleep(200, signal);
    }
  } finally {
    bot.pathfinder.setGoal(null);
  }
}

export function entityLabel(entity) {
  return entity.username ?? entity.name ?? entity.displayName ?? '未知';
}

// ── 移动 ────────────────────────────────────────────────────

const PATH_ERRORS = {
  NoPath: '找不到能走过去的路',
  Timeout: '路线太复杂，没规划出来',
  GoalChanged: '行动被新的指令打断了',
  PathStopped: '行动被打断了',
};

export function describeError(err) {
  if (!err) return '未知错误';
  if (err.name === 'AbortError') return err.message || '已取消';
  if (PATH_ERRORS[err.name]) return PATH_ERRORS[err.name];
  return err.message || String(err);
}

export async function gotoGoal(agent, goal, { dig, signal, timeoutMs = 180_000 } = {}) {
  const bot = agent.bot;
  bot.pathfinder.setMovements(makeMovements(bot, { dig: dig ?? agent.cfg.behavior.dig_while_pathing }));
  try {
    await abortable(withTimeout(bot.pathfinder.goto(goal), timeoutMs, '走了太久还没到'), signal);
  } catch (err) {
    bot.pathfinder.setGoal(null);
    if (signal?.aborted) throw abortError(signal);
    const wrapped = new Error(describeError(err));
    wrapped.name = err.name;
    throw wrapped;
  }
}

export function gotoNear(agent, pos, range, opts) {
  return gotoGoal(agent, new goals.GoalNear(pos.x, pos.y, pos.z, range), opts);
}

// ── 放置 ────────────────────────────────────────────────────

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

export const isEmpty = (block) => !block || block.boundingBox === 'empty';

// 在 target 处放置背包里的 item（需要旁边有实心方块可依附）。
export async function placeAt(agent, target, item, signal) {
  const bot = agent.bot;
  const pos = target.floored();
  const here = bot.blockAt(pos);
  if (!isEmpty(here)) throw new Error(`${pos} 已经有 ${here.name} 了`);
  let reference = null;
  let face = null;
  for (const dir of FACES) {
    const block = bot.blockAt(pos.plus(dir));
    if (block && block.boundingBox === 'block') {
      reference = block;
      face = dir.scaled(-1);
      break;
    }
  }
  if (!reference) throw new Error('那个位置旁边没有能依附的实心方块');
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
    await gotoNear(agent, pos, 3, { signal });
  }
  const feet = bot.entity.position.floored();
  if (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)) {
    await gotoGoal(agent, new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1.5)), { signal, timeoutMs: 15_000 });
  }
  await bot.equip(item, 'hand');
  await bot.placeBlock(reference, face);
  return bot.blockAt(pos);
}

// 在猫娘身边找块空地放下物品（工作台、熔炉等）。
export async function placeNearby(agent, itemName, signal) {
  const bot = agent.bot;
  const item = findItem(bot, itemName);
  if (!item) throw new Error(`背包里没有 ${itemName}`);
  const feet = bot.entity.position.floored();
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  for (const dy of [0, 1, -1]) {
    for (const [dx, dz] of offsets) {
      const pos = feet.offset(dx, dy, dz);
      const below = bot.blockAt(pos.offset(0, -1, 0));
      if (isEmpty(bot.blockAt(pos)) && isEmpty(bot.blockAt(pos.offset(0, 1, 0))) && below?.boundingBox === 'block') {
        try {
          return await placeAt(agent, pos, item, signal);
        } catch {
          // 换个位置再试
        }
      }
    }
  }
  throw new Error(`身边找不到能放 ${itemName} 的空地`);
}

// ── 战斗（具体打法见 combat.js）────────────────────────────

const WEAPON_RANK = ['netherite_sword', 'diamond_sword', 'netherite_axe', 'iron_sword', 'diamond_axe', 'stone_sword', 'iron_axe', 'golden_sword',
  'wooden_sword', 'stone_axe', 'golden_axe', 'wooden_axe', 'netherite_spear', 'diamond_spear', 'iron_spear', 'copper_spear', 'stone_spear',
  'golden_spear', 'wooden_spear', 'mace', 'trident'];

// 耐久还剩多少（没有耐久的东西返回 Infinity）；快坏了 = 剩不到 4%（至少 8 点）
export function durabilityLeft(item) {
  const max = item?.maxDurability;
  if (!max) return Infinity;
  return max - (item.durabilityUsed ?? 0);
}
export const isWorn = (item) => durabilityLeft(item) < Math.max(8, (item?.maxDurability ?? 0) * 0.04);

// 拿上最好的武器；同一种挑耐久多的，快坏的先放着（实在没别的才用）
export async function equipBestWeapon(bot) {
  let fallback = null;
  for (const name of WEAPON_RANK) {
    const item = bot.inventory.items().filter((i) => i.name === name).sort((a, b) => durabilityLeft(b) - durabilityLeft(a))[0];
    if (!item) continue;
    if (isWorn(item)) {
      fallback ??= item;
      continue;
    }
    if (bot.heldItem?.slot !== item.slot) await bot.equip(item, 'hand').catch(() => {});
    return name;
  }
  if (!fallback) return null;
  if (bot.heldItem?.slot !== fallback.slot) await bot.equip(fallback, 'hand').catch(() => {});
  return fallback.name;
}

export class LowHealthError extends Error {
  constructor() {
    super('血量太低，先撤退了');
    this.name = 'LowHealth';
  }
}
