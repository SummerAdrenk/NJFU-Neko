// 战斗：索敌（被激怒的、正在打人的、主人射过的怪优先，范围随战斗模式变化）、蓄满再出手、跳劈（暴击）、
// 群怪时横扫和边打边退、冲刺击退、盾牌格挡、不死图腾、战斗间隙吃东西、药水（给自己 / 给主人 / 砸怪）、
// 用船困住打不过的怪、水桶冲开怪群、岩浆桶烫怪（极限模式）、鞘翅撤离（极限模式）、弓箭 / 雪球，
// 以及苦力怕（按引信进度出手和撤离）、末影人、恶魂、烈焰人、幻翼、凋灵、末影龙等的专门打法。
import { goals, makeMovements } from './createBot.js';
import {
  canMelee, durabilityLeft, equipBestWeapon, findPlayer, fleeFrom, gotoGoal, isAliveEntity, isEmpty, isHostile, isVehicleItemEntity, isWorn,
  LowHealthError, nearestThreat, preferRider, protectedReason, Vec3,
} from './helpers.js';
import { ARROW, SNOWBALL, solveBallistic } from './ballistics.js';
import { combatFlags } from './combatModes.js';
import { elytraTravel, pillarUp } from './movement.js';
import { ALLY_KINDS, offensiveKindsFor, throwPotionAt, usePotion } from './potions.js';
import { getLog } from '../log.js';
import { abortError, sleep } from '../util.js';

export { solveBallistic };

const log = getLog('战斗');
const REACH = 3.0;

// ── 基础数据 ────────────────────────────────────────────────

export function meta(bot, entity, key) {
  const keys = bot.registry.entitiesByName[entity?.name]?.metadataKeys;
  const i = keys ? keys.indexOf(key) : -1;
  return i >= 0 ? entity.metadata?.[i] : undefined;
}

// 攻击冷却（毫秒）：蓄满再打伤害最高，也才能暴击和横扫。
export function cooldownMs(item) {
  const n = item?.name ?? '';
  if (!n) return 250;
  if (n.endsWith('_sword')) return 625;
  if (n.endsWith('_axe')) return /^(wooden|stone)_/.test(n) ? 1250 : n.startsWith('iron_') ? 1112 : 1000;
  if (n.endsWith('_spear')) return 1000;
  if (n === 'trident') return 910;
  if (n === 'mace') return 1667;
  if (n.endsWith('_pickaxe')) return 834;
  if (n.endsWith('_shovel')) return 1000;
  if (n.endsWith('_hoe')) return 500;
  return 250;
}

const isSword = (item) => /_sword$/.test(item?.name ?? '');
export const isMeleeWeapon = (item) => /_(sword|axe|spear)$|^(mace|trident)$/.test(item?.name ?? '');
const eye = (bot) => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const healthOf = (bot, e) => {
  const h = meta(bot, e, 'health');
  return typeof h === 'number' ? h : null;
};
const alive = (bot, e) => Boolean(e) && e.isValid !== false && (healthOf(bot, e) ?? 1) > 0;
const findInv = (bot, re) => bot.inventory.items().find((i) => re.test(i.name));
const hasArrows = (bot) => Boolean(findInv(bot, /^(arrow|spectral_arrow|tipped_arrow)$/));
export const hasBow = (bot) => Boolean(findInv(bot, /^bow$/)) && hasArrows(bot);
const boatItem = (bot) => findInv(bot, /_(boat|raft)$/);
const inNether = (bot) => /nether/.test(String(bot.game?.dimension ?? ''));
const centroid = (list) => list.reduce((acc, e) => acc.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / list.length);

function bbox(e) {
  const w = (e.width ?? 0.6) / 2;
  const h = e.height ?? 1.8;
  const p = e.position;
  return { minX: p.x - w, maxX: p.x + w, minY: p.y, maxY: p.y + h, minZ: p.z - w, maxZ: p.z + w };
}
const overlaps = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ;

// 眼睛到目标碰撞箱最近点的距离（原版近战距离 3 格就是这么算的）。
export function reachTo(bot, e) {
  const o = eye(bot);
  const b = bbox(e);
  const cx = Math.max(b.minX, Math.min(o.x, b.maxX));
  const cy = Math.max(b.minY, Math.min(o.y, b.maxY));
  const cz = Math.max(b.minZ, Math.min(o.z, b.maxZ));
  return Math.hypot(o.x - cx, o.y - cy, o.z - cz);
}

function towardUnit(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const n = Math.hypot(dx, dz) || 1;
  return new Vec3(dx / n, 0, dz / n);
}

const FLYERS = new Set(['ghast', 'blaze', 'phantom', 'ender_dragon', 'wither', 'vex', 'bee', 'bat', 'breeze', 'allay', 'parrot']);

function estimateVelocity(samples) {
  if (samples.length < 3) return new Vec3(0, 0, 0);
  const a = samples[Math.max(0, samples.length - 8)];
  const b = samples[samples.length - 1];
  const ticks = (b.t - a.t) / 50;
  return ticks > 0 ? b.p.minus(a.p).scaled(1 / ticks) : new Vec3(0, 0, 0);
}

function aimAt(bot, target, samples, aimY, projectile) {
  const from = eye(bot).offset(0, -0.1, 0);
  const v = estimateVelocity(samples);
  const h = (target.height ?? 1.8) * aimY;
  const vy = FLYERS.has(target.name) ? v.y : 0;
  let point = target.position.offset(0, h, 0);
  let sol = null;
  for (let i = 0; i < 3; i++) {
    sol = solveBallistic(from, point, projectile);
    if (!sol) return null;
    const lead = Math.min(sol.ticks, 60);
    point = target.position.offset(v.x * lead, h + vy * lead, v.z * lead);
  }
  return sol;
}

// ── 威胁感知 ────────────────────────────────────────────────

const PROJECTILES = new Set(['arrow', 'spectral_arrow', 'trident', 'fireball', 'small_fireball', 'wither_skull', 'shulker_bullet',
  'wind_charge', 'breeze_wind_charge', 'dragon_fireball', 'llama_spit']);
const GRAVITY_PROJECTILES = new Set(['arrow', 'spectral_arrow', 'trident', 'llama_spit']);

// 正朝自己飞来、horizonTicks 刻内会擦到身边的弹射物（箭、火球、凋灵之首……）。
export function incomingProjectile(bot, horizonTicks = 12) {
  const me = bot.entity.position.offset(0, 1.0, 0);
  let best = null;
  for (const e of Object.values(bot.entities)) {
    if (!PROJECTILES.has(e.name) || !e.velocity || !e.position) continue;
    if (GRAVITY_PROJECTILES.has(e.name) && meta(bot, e, 'in_ground')) continue;
    if (e.position.distanceTo(me) > 40) continue;
    let p = e.position.clone();
    let v = e.velocity.clone();
    if (Math.hypot(v.x, v.y, v.z) < 0.05) continue;
    for (let t = 1; t <= horizonTicks; t++) {
      p = p.plus(v);
      if (GRAVITY_PROJECTILES.has(e.name)) v = new Vec3(v.x * 0.99, v.y * 0.99 - 0.05, v.z * 0.99);
      if (p.distanceTo(me) < 1.6) {
        if (!best || t < best.t) best = { entity: e, t, position: e.position };
        break;
      }
    }
  }
  return best;
}

function facingMe(bot, e, maxDeg = 35) {
  const yaw = e.headYaw ?? e.yaw;
  if (yaw == null) return true;
  const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const to = towardUnit(e.position, bot.entity.position);
  return dir.x * to.x + dir.z * to.z > Math.cos((maxDeg * Math.PI) / 180);
}

// 正在瞄准自己的远程怪（骷髅拉弓、掠夺者上弩、恶魂和烈焰人蓄力）。
export function aimingAtMe(bot, maxDist = 24) {
  for (const e of Object.values(bot.entities)) {
    if (!e.position || e === bot.entity) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d > maxDist || d < 2.5) continue;
    let aiming = false;
    if (['skeleton', 'stray', 'bogged', 'parched', 'illusioner', 'drowned'].includes(e.name)) {
      const flags = meta(bot, e, 'living_entity_flags');
      aiming = typeof flags === 'number' && (flags & 1) === 1;
    } else if (e.name === 'pillager') aiming = meta(bot, e, 'is_charging_crossbow') === true;
    else if (e.name === 'ghast') aiming = meta(bot, e, 'is_charging') === true;
    else if (e.name === 'blaze') aiming = (Number(meta(bot, e, 'flags') ?? 0) & 1) === 1;
    if (aiming && facingMe(bot, e)) return { entity: e, position: e.position.offset(0, (e.height ?? 1.8) * 0.8, 0) };
  }
  return null;
}

// ── 仇恨记录：谁打了我 / 主人（被激怒的中立生物要还手，打过人的怪优先处理）──

export function noteAttacker(agent, attacker, victim = null) {
  if (attacker?.id == null) return;
  agent.recentAttackers ??= new Map();
  agent.recentAttackers.set(attacker.id, { t: Date.now(), victim });
  if (agent.recentAttackers.size > 200) {
    const cutoff = Date.now() - 60_000;
    for (const [k, v] of agent.recentAttackers) if (v.t < cutoff) agent.recentAttackers.delete(k);
  }
}

export function recentlyAttacked(agent, e, ms = 20_000) {
  const r = agent.recentAttackers?.get(e?.id);
  return Boolean(r && Date.now() - r.t < ms);
}

// 中立生物平时不招惹，但已经被激怒（末影人发狂）或正在打人的时候要处理掉。
const RETALIATE = new Set(['enderman', 'zombified_piglin', 'piglin', 'wolf', 'bee', 'polar_bear', 'llama', 'trader_llama', 'panda', 'goat']);

export function provoked(agent, e) {
  if (!e?.name || !RETALIATE.has(e.name) || !isAliveEntity(agent.bot, e) || protectedReason(agent, e)) return false;
  if (e.name === 'enderman' && meta(agent.bot, e, 'creepy') === true) return true;
  return recentlyAttacked(agent, e);
}

// ── 该不该打 ────────────────────────────────────────────────

const NO_BOAT = new Set(['creeper', 'skeleton', 'stray', 'bogged', 'parched', 'pillager', 'illusioner', 'evoker', 'witch', 'blaze', 'ghast',
  'phantom', 'vex', 'breeze', 'guardian', 'elder_guardian', 'shulker', 'slime', 'magma_cube', 'warden', 'wither', 'ender_dragon', 'player']);

export function fitsBoat(bot, e) {
  const width = bot.registry.entitiesByName[e.name]?.width ?? e.width ?? 9;
  return width < 1.375 && !NO_BOAT.has(e.name);
}

// 苦力怕怎么处理：有弓就射，拿着近战武器且血量健康就按引信进度打了就跑，否则躲开。
export function creeperPlan(agent) {
  const bot = agent.bot;
  const f = combatFlags(agent);
  if (f.bow && hasBow(bot)) return 'bow';
  if (f.creeper_melee && bot.health >= 12 && bot.inventory.items().some(isMeleeWeapon)) return 'melee';
  return 'flee';
}

// 自动防御时可以主动去打的：敌对（或者被激怒的中立生物）、活着、没被保护，而且有对应的打法。
export function canEngage(agent, e) {
  if (provoked(agent, e)) return true;
  if (!e?.name || !isHostile(e) || !isAliveEntity(agent.bot, e) || protectedReason(agent, e)) return false;
  if (e.name === 'creeper') return creeperPlan(agent) !== 'flee';
  if (e.name === 'ghast') return hasBow(agent.bot);
  if (e.name === 'phantom') return true;
  return canMelee(e);
}

export const nearestEngageable = (agent, center, radius) => nearestThreat(agent, center, radius, canEngage);

// 身边能近战的敌人（活着、没被保护的）
export function meleeHostiles(agent, radius, exclude = null) {
  const bot = agent.bot;
  const me = bot.entity.position;
  return Object.values(bot.entities).filter((e) => e !== bot.entity && e !== exclude && e.position && (canMelee(e) || provoked(agent, e))
    && isAliveEntity(bot, e) && !protectedReason(agent, e) && e.position.distanceTo(me) < radius);
}

// 被怪群围住：8 格内 3 只以上近战怪
export const outnumbered = (agent, radius = 8) => meleeHostiles(agent, radius).length >= 3;

export function ownerEntity(agent, maxDist = 64) {
  const bot = agent.bot;
  return Object.values(bot.players).find((p) => p.username !== bot.username && p.entity && agent.chat.isOwner(p.username)
    && p.entity.position.distanceTo(bot.entity.position) < maxDist)?.entity ?? null;
}

// 看不看得见（中间没有方块挡着）
function canSee(bot, e) {
  try {
    const from = eye(bot);
    const to = e.position.offset(0, (e.height ?? 1.8) * 0.6, 0);
    const dir = to.minus(from);
    const dist = dir.norm();
    if (dist < 1.5) return true;
    const hit = bot.world.raycast(from, dir.normalize(), dist);
    return !hit || hit.position.offset(0.5, 0.5, 0.5).distanceTo(from) >= dist - 0.8;
  } catch {
    return true;
  }
}

// 索敌：从身边和主人身边的怪里挑最该打的。日常范围 64 格（#设置 索敌范围 可改，和战斗模式无关）；
// 看不见的（墙后、地底下）只处理 6 格内的；走不过去的（追了一阵没进展）1 分钟内不再选。
// 优先级：打过人的 > 被激怒的 > 正在追人的 > 靠近主人的苦力怕 > 远程怪 > 近的。
export function pickTarget(agent, ownerName = null) {
  const bot = agent.bot;
  const f = combatFlags(agent);
  const me = bot.entity.position;
  const owner = ownerName ? findPlayer(bot, ownerName)?.entity : ownerEntity(agent);
  let best = null;
  let bestScore = -Infinity;
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position || !canEngage(agent, e)) continue;
    const dMe = e.position.distanceTo(me);
    const dOwner = owner ? e.position.distanceTo(owner.position) : Infinity;
    const near = Math.min(dMe, dOwner);
    const angry = provoked(agent, e);
    const hitSomeone = recentlyAttacked(agent, e);
    const aggressive = (Number(meta(bot, e, 'mob_flags') ?? 0) & 4) !== 0;
    if (near > f.engage_radius || Math.abs(e.position.y - me.y) > 24) continue;
    if ((agent.unreachable?.get(e.id) ?? 0) > Date.now()) continue;
    if (!angry && !hitSomeone && near > 6 && !canSee(bot, e)) continue;
    let score = -near;
    if (hitSomeone) score += 12;
    if (angry) score += 8;
    if (aggressive) score += 4;
    if (e.name === 'creeper') score += dOwner < 6 || dMe < 5 ? 10 : -4;
    if (/^(skeleton|stray|bogged|parched|pillager|witch|blaze|evoker)$/.test(e.name)) score += 3;
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best ? preferRider(agent, best, canEngage) : null;
}

// 从怪群里撤出来：极限模式有鞘翅和烟花就飞走；否则主人离怪群比我远就往主人那边跑，不然背对怪群跑开（僵尸追不上疾跑）。
export async function retreatFromCrowd(agent, signal, ms = 9000) {
  const bot = agent.bot;
  const crowd = meleeHostiles(agent, 14);
  if (!crowd.length) return;
  const center = centroid(crowd);
  const me = bot.entity.position;
  const owner = ownerEntity(agent);
  const f = combatFlags(agent);
  const away = new Vec3(me.x - center.x, 0, me.z - center.z);
  const n = Math.hypot(away.x, away.z) || 1;
  if (f.elytra && bot.health <= 8 && (bot.inventory.items().some((i) => i.name === 'elytra') || bot.inventory.slots[bot.getEquipmentDestSlot('torso')]?.name === 'elytra')
    && bot.inventory.items().filter((i) => i.name === 'firework_rocket').reduce((s, i) => s + i.count, 0) >= 3) {
    const dest = owner && owner.position.distanceTo(center) > 12 ? owner.position : me.plus(away.scaled(45 / n));
    try {
      await elytraTravel(agent, { x: dest.x, z: dest.z }, signal);
      agent.events.push('bot', { what: 'combat', detail: '被怪群围住，用鞘翅飞走了' });
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  // 末影珍珠：往怪群的反方向（或主人那边）扔，落地就传送过去（会掉 2.5 颗心，血太少不用）
  const pearl = f.pearls && bot.health > 7 ? bot.inventory.items().find((i) => i.name === 'ender_pearl') : null;
  if (pearl && await pearlAway(agent, pearl, owner && owner.position.distanceTo(center) > 12 ? towardUnit(me, owner.position) : new Vec3(away.x / n, 0, away.z / n), signal)) return;
  const goal = owner && owner.position.distanceTo(center) > me.distanceTo(center) + 3
    ? new goals.GoalFollow(owner, 2)
    : new goals.GoalXZ(me.x + (away.x / n) * 18, me.z + (away.z / n) * 18);
  bot.pathfinder.setMovements(makeMovements(bot));
  bot.pathfinder.setGoal(goal, true);
  const until = Date.now() + ms;
  try {
    while (Date.now() < until && meleeHostiles(agent, 6).length > 0) await sleep(200, signal);
  } finally {
    bot.pathfinder.setGoal(null);
  }
}

// 扔末影珍珠逃到 dir 方向 12～20 格外的一块安全地面上。成功传送返回 true。
async function pearlAway(agent, pearl, dir, signal) {
  const bot = agent.bot;
  const me = bot.entity.position;
  for (const dist of [18, 15, 12]) {
    const p = me.plus(dir.scaled(dist));
    for (let y = Math.floor(p.y) + 6; y >= Math.floor(p.y) - 8; y--) {
      const ground = bot.blockAt(new Vec3(Math.floor(p.x), y, Math.floor(p.z)));
      const above = bot.blockAt(new Vec3(Math.floor(p.x), y + 1, Math.floor(p.z)));
      const above2 = bot.blockAt(new Vec3(Math.floor(p.x), y + 2, Math.floor(p.z)));
      if (!ground || !solid(ground)) continue;
      if (DANGER.test(ground.name) || solid(above) || solid(above2) || /water|lava/.test(`${above?.name}`)) break;
      const landing = ground.position.offset(0.5, 1, 0.5);
      const sol = solveBallistic(eye(bot).offset(0, -0.1, 0), landing, SNOWBALL);
      if (!sol) break;
      await holdItem(bot, pearl);
      await bot.look(sol.yaw, sol.pitch, true);
      bot.activateItem();
      bot.deactivateItem();
      const start = bot.entity.position.clone();
      const until = Date.now() + 3500;
      while (Date.now() < until && bot.entity.position.distanceTo(start) < 6) await sleep(100, signal);
      await equipBestWeapon(bot);
      if (bot.entity.position.distanceTo(start) >= 6) {
        agent.events.push('bot', { what: 'combat', detail: '扔末影珍珠逃出了怪群' });
        return true;
      }
      return false;
    }
  }
  return false;
}

// 各种怪的近战参数：spacing 保持的距离；boat 优先放船困住；boatWhenWeak 打不过时才放船；
// ranged 远程怪（冲过去，边走边左右晃）；axe 拿斧子的（会打掉盾牌，不靠盾牌硬扛）；water 打不过时躲进水里。
const TACTICS = {
  default: { spacing: 2.4 },
  zombie: { spacing: 2.5, boatWhenWeak: true },
  husk: { spacing: 2.5, boatWhenWeak: true },
  drowned: { spacing: 2.5, boatWhenWeak: true },
  zombie_villager: { spacing: 2.5, boatWhenWeak: true },
  skeleton: { spacing: 1.8, ranged: true },
  stray: { spacing: 1.8, ranged: true },
  bogged: { spacing: 1.8, ranged: true },
  parched: { spacing: 1.8, ranged: true },
  pillager: { spacing: 1.8, ranged: true },
  illusioner: { spacing: 1.8, ranged: true },
  spider: { spacing: 2.4 },
  cave_spider: { spacing: 2.3, boatWhenWeak: true },
  enderman: { spacing: 2.6, boat: true, water: true },
  wither_skeleton: { spacing: 2.7, boat: true },
  vindicator: { spacing: 2.8, boat: true, axe: true },
  piglin_brute: { spacing: 2.8, boat: true, axe: true },
  piglin: { spacing: 2.5, boatWhenWeak: true },
  zombified_piglin: { spacing: 2.5, boatWhenWeak: true },
  witch: { spacing: 2.0 },
  evoker: { spacing: 2.0 },
  vex: { spacing: 2.2 },
  slime: { spacing: 2.3 },
  magma_cube: { spacing: 2.3 },
  hoglin: { spacing: 2.8 },
  zoglin: { spacing: 2.8 },
  ravager: { spacing: 3.0 },
  silverfish: { spacing: 2.0 },
  endermite: { spacing: 2.0 },
  breeze: { spacing: 2.2 },
  player: { spacing: 2.6 },
};

// 横扫会误伤旁边的：玩家、村民、宠物、动物、中立生物、命名生物、盔甲架……
function isBystander(agent, e, target) {
  if (e === target || e === agent.bot.entity || !e.position) return false;
  if (e.type === 'player') return true;
  if (e.name === 'armor_stand' || e.name === 'mannequin') return true;
  if (!['hostile', 'mob', 'animal', 'passive', 'water_creature', 'ambient', 'living'].includes(e.type)) return false;
  return (!isHostile(e) && !provoked(agent, e)) || Boolean(protectedReason(agent, e));
}

function sweepZone(target) {
  const zone = bbox(target);
  zone.minX -= 1;
  zone.maxX += 1;
  zone.minZ -= 1;
  zone.maxZ += 1;
  zone.minY -= 0.25;
  zone.maxY += 0.25;
  return zone;
}

export function sweepRisk(agent, target) {
  const bot = agent.bot;
  const zone = sweepZone(target);
  return Object.values(bot.entities).some((e) => isBystander(agent, e, target) && overlaps(zone, bbox(e))
    && e.position.distanceTo(bot.entity.position) < 3.3);
}

// 目标旁边挤着的其他怪（横扫能一起砍到的）
function clusterAround(agent, target) {
  const bot = agent.bot;
  const zone = sweepZone(target);
  return meleeHostiles(agent, 4, target).filter((e) => overlaps(zone, bbox(e)) && e.position.distanceTo(bot.entity.position) < 3.3).length;
}

// ── 走位安全：不退下悬崖、不走进岩浆火焰 ────────────────────

const DANGER = /lava|fire|magma_block|cactus|sweet_berry_bush|campfire|powder_snow|wither_rose|pointed_dripstone/;
const FLAMMABLE = /log|planks|wool|leaves|carpet|hay_block|bookshelf|_wood$|fence|stairs|door|scaffolding|vine|short_grass|tall_grass|fern|flower|tulip|bush|tnt|_bed$|banner|sign|lectern|composter|beehive|bee_nest|target|kelp_block|crafting_table|chest|barrel|campfire|loom/;
const solid = (b) => b && b.boundingBox === 'block';

export function safeStep(bot, dir) {
  const p = bot.entity.position.plus(dir.scaled(0.9));
  const feet = bot.blockAt(p.floored());
  const head = bot.blockAt(p.offset(0, 1, 0).floored());
  if (!feet || !head || solid(feet) || solid(head) || DANGER.test(feet.name) || DANGER.test(head.name)) return false;
  for (let dy = 1; dy <= 3; dy++) {
    const b = bot.blockAt(p.offset(0, -dy, 0).floored());
    if (!b || DANGER.test(b.name)) return false;
    if (solid(b) || b.name === 'water') return dy <= 2;
  }
  return false;
}

// 找放船、倒水的地面：spot 所在格或下面一格是实心方块，上面有空间。
function groundUnder(bot, spot) {
  const f = spot.floored();
  for (const dy of [-1, 0, -2]) {
    const g = f.offset(0, dy, 0);
    const ground = bot.blockAt(g);
    const above = bot.blockAt(g.offset(0, 1, 0));
    const above2 = bot.blockAt(g.offset(0, 2, 0));
    if (solid(ground) && !solid(above) && !solid(above2) && !DANGER.test(ground.name) && !/hopper|chest|barrel/.test(ground.name)) return g;
  }
  return null;
}

// 倒岩浆的地方周围 2 格内不能有会烧起来的东西，主人不能在旁边
function lavaSafe(agent, pos) {
  const bot = agent.bot;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (b && FLAMMABLE.test(b.name)) return false;
      }
    }
  }
  const owner = ownerEntity(agent);
  if (owner && owner.position.distanceTo(pos) < 6) return false;
  return bot.entity.position.distanceTo(pos.offset(0.5, 0, 0.5)) >= 2.5;
}

function waitForBoat(bot, near, ms) {
  return new Promise((resolve) => {
    const onSpawn = (e) => {
      if (isVehicleItemEntity(e) && /(boat|raft)$/.test(e.name) && e.position.distanceTo(near) < 3) done(e);
    };
    const timer = setTimeout(() => done(null), ms);
    function done(value) {
      clearTimeout(timer);
      bot.off('entitySpawn', onSpawn);
      resolve(value);
    }
    bot.on('entitySpawn', onSpawn);
  });
}

// 末影龙头部的大致位置（龙的朝向和身体是反的，头在“身后” 6.5 格）。
function dragonHead(dragon, flip = false) {
  const s = flip ? -1 : 1;
  return dragon.position.offset(Math.sin(dragon.yaw ?? 0) * 6.5 * s, 0, Math.cos(dragon.yaw ?? 0) * 6.5 * s);
}

// 平时的普通食物（不含金苹果和坏食物）
function bestFood(bot) {
  const foods = bot.registry.foodsByName ?? {};
  const bad = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chorus_fruit|suspicious_stew|chicken|golden_apple|enchanted_golden_apple)$/;
  return bot.inventory.items().filter((i) => foods[i.name] && !bad.test(i.name))
    .sort((a, b) => (foods[b.name].foodPoints + foods[b.name].saturation) - (foods[a.name].foodPoints + foods[a.name].saturation))[0] ?? null;
}

async function holdItem(bot, item) {
  if (bot.heldItem?.type === item.type) return;
  const hotbar = bot.inventory.slots.slice(36, 45).findIndex((s) => s?.type === item.type);
  if (hotbar >= 0) bot.setQuickBarSlot(hotbar);
  else await bot.equip(item, 'hand');
}

// ── 战斗者 ──────────────────────────────────────────────────

export class Fighter {
  constructor(agent, signal, { boss = false } = {}) {
    this.agent = agent;
    this.bot = agent.bot;
    this.signal = signal;
    this.flags = combatFlags(agent);
    this.boss = boss;
    this.lastAttack = 0;
    this.lastSwap = Date.now();
    this.shieldUp = false;
    this.pathTarget = null;
    this.boatTried = new Set();
    this.boats = new Set();
    this.placedFluids = [];
    this.stats = { hits: 0, crits: 0, sweeps: 0, shots: 0, blocks: 0, potions: 0 };
    agent.myBoats ??= new Set();
  }

  check() {
    if (this.signal?.aborted) throw abortError(this.signal);
  }

  wait(ms) {
    return sleep(ms, this.signal);
  }

  // ── 出手时机 ──
  msUntilReady() {
    return cooldownMs(this.bot.heldItem) + 40 - (Date.now() - Math.max(this.lastAttack, this.lastSwap));
  }

  ready() {
    return this.msUntilReady() <= 0;
  }

  async equip() {
    await this.ensureWeapon();
    await this.equipShield();
  }

  async ensureWeapon() {
    if (isMeleeWeapon(this.bot.heldItem) && !isWorn(this.bot.heldItem)) return true;
    const before = this.bot.heldItem?.name;
    const w = await equipBestWeapon(this.bot);
    if (this.bot.heldItem?.name !== before) this.lastSwap = Date.now();
    return Boolean(w);
  }

  async equipShield() {
    if (!this.flags.shield) return;
    const bot = this.bot;
    const off = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name;
    if (off === 'shield' || off === 'totem_of_undying') return;
    const s = findInv(bot, /^shield$/);
    if (s) await bot.equip(s, 'off-hand').catch(() => {});
  }

  // 血少时把不死图腾换到副手（盾牌先收起来）；打 Boss 时一直拿着
  async ensureTotem() {
    if (!this.flags.totem) return false;
    const bot = this.bot;
    if (bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === 'totem_of_undying') return true;
    if (bot.health > 10 && !this.boss) return false;
    const totem = findInv(bot, /^totem_of_undying$/);
    if (!totem) return false;
    this.lower();
    await bot.equip(totem, 'off-hand').catch(() => {});
    log.info('血少了，把不死图腾拿到副手');
    return true;
  }

  // ── 盾牌 ──
  canBlock() {
    const bot = this.bot;
    return this.flags.shield && !bot.vehicle && Date.now() > (this.agent.shieldCooldownUntil ?? 0)
      && bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === 'shield';
  }

  // 举盾（要举起 0.25 秒后才开始格挡，所以要提前举），正对着威胁来的方向。
  raise(toward) {
    if (!this.canBlock()) return false;
    if (toward) this.bot.lookAt(toward, true).catch(() => {});
    if (!this.shieldUp) {
      this.bot.activateItem(true);
      this.shieldUp = true;
      this.stats.blocks += 1;
    }
    return true;
  }

  lower() {
    if (!this.shieldUp) return;
    this.bot.deactivateItem();
    this.shieldUp = false;
  }

  // ── 移动 ──
  stopMove() {
    for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) this.bot.setControlState(c, false);
  }

  follow(target, range) {
    const bot = this.bot;
    if (this.pathTarget === target) return;
    this.stopMove();
    bot.pathfinder.setMovements(makeMovements(bot));
    bot.pathfinder.setGoal(new goals.GoalFollow(target, range), true);
    this.pathTarget = target;
  }

  manual() {
    if (!this.pathTarget) return;
    this.bot.pathfinder.setGoal(null);
    this.pathTarget = null;
  }

  async face(target, yOffset) {
    const h = target.height ?? 1.8;
    await this.bot.lookAt(target.position.offset(0, yOffset ?? Math.min(h * 0.85, 1.6), 0), true);
  }

  // 保持距离：远了往前，近了后退；ranged 时左右晃着走躲箭。
  steer(target, spacing, { strafe = false } = {}) {
    const bot = this.bot;
    const d = flat(bot.entity.position, target.position);
    const toward = towardUnit(bot.entity.position, target.position);
    const fwd = d > spacing + 0.25 && safeStep(bot, toward);
    const back = !fwd && d < spacing - 0.5 && safeStep(bot, toward.scaled(-1));
    bot.setControlState('forward', fwd);
    bot.setControlState('back', back);
    bot.setControlState('sprint', fwd && d > spacing + 1.2);
    if (strafe && d > 3) {
      if (Date.now() > (this.nextStrafe ?? 0)) {
        this.strafeLeft = !this.strafeLeft;
        this.nextStrafe = Date.now() + 500 + Math.random() * 500;
      }
      const side = new Vec3(toward.z, 0, -toward.x).scaled(this.strafeLeft ? 1 : -1);
      const ok = safeStep(bot, side);
      bot.setControlState('left', ok && this.strafeLeft);
      bot.setControlState('right', ok && !this.strafeLeft);
    } else {
      bot.setControlState('left', false);
      bot.setControlState('right', false);
    }
    return d;
  }

  // 面朝目标往后退一小段（边打边退，别让怪群围上来）
  async backOff(from, ms = 350) {
    const bot = this.bot;
    if (!safeStep(bot, towardUnit(from, bot.entity.position))) return;
    bot.setControlState('forward', false);
    bot.setControlState('back', true);
    await this.wait(ms);
    bot.setControlState('back', false);
  }

  async runFrom(e, distance = 8, ms = 2500) {
    this.lower();
    this.manual();
    this.stopMove();
    await fleeFrom(this.agent, e, this.signal, { distance, timeoutMs: ms });
    return flat(e.position, this.bot.entity.position) >= distance - 1;
  }

  // ── 出手 ──
  hit(target) {
    this.lower();
    this.bot.attack(target);
    this.lastAttack = Date.now();
    this.stats.hits += 1;
  }

  canCrit() {
    const e = this.bot.entity;
    return this.flags.crits && e.onGround && !e.isInWater && !e.isInLava && !this.bot.vehicle;
  }

  // 跳劈：起跳 → 等到开始下落 → 出手。下落中出手 = 暴击（伤害 ×1.5），而且不会横扫误伤旁边的人。
  async critStrike(target) {
    const bot = this.bot;
    if (!this.canCrit()) return false;
    this.lower();
    bot.setControlState('sprint', false); // 疾跑中出手不算暴击
    bot.setControlState('jump', true);
    const t0 = Date.now();
    let falling = false;
    try {
      const retreatAt = Number(this.agent.cfg.behavior.retreat_health ?? 8);
      while (Date.now() - t0 < 800) {
        await this.wait(25);
        if (bot.health <= retreatAt) return false;
        if (Date.now() - t0 > 120) bot.setControlState('jump', false);
        if (!bot.entity.onGround && bot.entity.velocity.y < -0.04) {
          falling = true;
          break;
        }
        if (Date.now() - t0 > 250 && bot.entity.onGround) break;
      }
    } finally {
      bot.setControlState('jump', false);
    }
    if (!falling || !alive(bot, target)) return false;
    await this.face(target);
    if (reachTo(bot, target) > REACH) return false;
    this.hit(target);
    this.stats.crits += 1;
    return true;
  }

  // 冲刺击退：出手瞬间处于疾跑状态，把怪推远（打苦力怕用）。
  async sprintHit(target) {
    const bot = this.bot;
    await this.face(target);
    bot.setControlState('sprint', false);
    bot.setControlState('sprint', true); // 重新发“开始疾跑”，服务器才认
    this.hit(target);
    bot.setControlState('sprint', false);
  }

  // ── 保命 ──
  async consume(re) {
    const bot = this.bot;
    const item = findInv(bot, re);
    if (!item) return false;
    this.lower();
    this.manual();
    this.stopMove();
    try {
      await bot.equip(item, 'hand');
      await bot.consume();
      return true;
    } catch {
      return false;
    } finally {
      this.lastSwap = Date.now();
      await this.ensureWeapon();
    }
  }

  // 打斗间隙（身边 6 格没有近战怪、没有飞来的东西）吃口饭回血
  async snack() {
    const bot = this.bot;
    if (bot.food >= 20 || bot.health >= 18 || this.meleeCrowd(6) > 0 || incomingProjectile(bot, 20)) return false;
    const food = bestFood(bot);
    if (!food) return false;
    this.lower();
    this.manual();
    this.stopMove();
    try {
      await holdItem(bot, food);
      await bot.consume();
      return true;
    } catch {
      return false;
    } finally {
      this.lastSwap = Date.now();
      await this.ensureWeapon();
    }
  }

  hasEffect(name) {
    const id = this.bot.registry.effectsByName?.[name]?.id;
    return id != null && Boolean(this.bot.entity.effects?.[id]);
  }

  meleeCrowd(radius) {
    return meleeHostiles(this.agent, radius).length;
  }

  // 给自己用药水（放下盾牌、停下脚步，用完换回武器）
  async potion(kinds) {
    if (!this.flags.potions) return false;
    this.lower();
    this.manual();
    this.stopMove();
    try {
      const used = await usePotion(this.agent, kinds);
      if (used) {
        this.stats.potions += 1;
        log.info(`用了药水：${used}`);
      }
      return Boolean(used);
    } catch {
      return false;
    } finally {
      this.lastSwap = Date.now();
      await this.ensureWeapon();
    }
  }

  // 往怪堆里砸伤害类喷溅药水（亡灵用治疗药水）。离自己和主人都要够远，免得溅到自己人。
  async potionAtCrowd(target) {
    if (!this.flags.potions || Date.now() < (this.nextThrow ?? 0)) return false;
    const bot = this.bot;
    const d = bot.entity.position.distanceTo(target.position);
    const owner = ownerEntity(this.agent);
    if (d < 4.2 || d > 6.2 || (owner && owner.position.distanceTo(target.position) < 4.5)) return false;
    if (meleeHostiles(this.agent, 12).length < 3 && !this.boss) return false;
    this.lower();
    const used = await throwPotionAt(this.agent, target, offensiveKindsFor(target)).catch(() => null);
    if (!used) return false;
    this.nextThrow = Date.now() + 2500;
    this.stats.potions += 1;
    this.lastSwap = Date.now();
    await this.ensureWeapon();
    return true;
  }

  // 被围住又打不过：原地垫方块搭柱子躲上去（僵尸之类够不着），在上面接着打或射箭，血回来再下去。
  async pillar() {
    if (!this.flags.pillar || this.perched) return false;
    this.lower();
    this.manual();
    this.stopMove();
    const n = await pillarUp(this.agent, 3, this.signal).catch(() => 0);
    if (n < 2) return false;
    this.perched = true;
    this.agent.events.push('bot', { what: 'combat', detail: `被围住了，垫了 ${n} 格方块躲上去` });
    await this.ensureWeapon();
    return true;
  }

  async emergency(target) {
    const bot = this.bot;
    if (!['survival', 'adventure'].includes(bot.game?.gameMode)) return;
    await this.ensureTotem();
    const retreatAt = Math.max(0, Number(this.agent.cfg.behavior.retreat_health ?? 8) + (this.flags.retreat_bonus ?? 0));
    const burning = (Number(meta(bot, bot.entity, 'shared_flags') ?? 0) & 1) === 1;
    if (burning && bot.health <= 14 && !this.hasEffect('FireResistance') && await this.potion(['fire_resistance'])) return;
    if (this.hasEffect('Wither') && bot.health <= 12 && await this.consume(/^milk_bucket$/)) return;
    if (bot.health <= Math.max(retreatAt, 8)) {
      if (await this.potion(['healing', 'regeneration', 'turtle_master'])) return;
      if (this.flags.golden_apples) {
        const apples = this.boss || this.flags.enchanted_apples ? /^(enchanted_)?golden_apple$/ : /^golden_apple$/;
        if (await this.consume(apples)) return;
      }
      if (this.meleeCrowd(4) >= 2 && await this.pillar()) return;
    }
    if (bot.health < 16 && await this.snack()) return;
    const crowd = meleeHostiles(this.agent, 5, target).length + 1;
    if (!this.perched && !this.boss && crowd >= 3 && bot.health <= 14) {
      // 被围住又开始掉血：水桶冲开 → 垫方块躲上去 → 撤
      if (await this.waterWall()) return;
      if (await this.pillar()) return;
      this.lower();
      this.stopMove();
      this.manual();
      await retreatFromCrowd(this.agent, this.signal);
      this.agent.events.push('bot', { what: 'retreat', health: Math.round(bot.health), detail: `被 ${crowd} 只怪围住，先撤` });
      throw new LowHealthError();
    }
    const limit = this.boss ? Math.min(retreatAt, 5) : retreatAt;
    if (limit > 0 && bot.health <= limit && !this.perched) {
      this.lower();
      this.stopMove();
      this.manual();
      if (meleeHostiles(this.agent, 10).length > 1) await retreatFromCrowd(this.agent, this.signal);
      else await fleeFrom(this.agent, target, this.signal, { distance: 14, timeoutMs: 8000 });
      this.agent.events.push('bot', { what: 'retreat', health: Math.round(bot.health), detail: `从 ${target.name ?? target.username} 身边撤退` });
      throw new LowHealthError();
    }
  }

  // 身边有正在膨胀的苦力怕（不是当前目标）就先跑开。
  async dodgeCreepers(target) {
    const bot = this.bot;
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'creeper' || e === target || !alive(bot, e)) continue;
      if (flat(e.position, bot.entity.position) < 7 && (meta(bot, e, 'swell_dir') > 0 || meta(bot, e, 'is_ignited') === true)) {
        await this.runFrom(e, 8);
        return true;
      }
    }
    return false;
  }

  // 有飞来的箭/火球、或远程怪在瞄准自己时举盾。
  blockIfThreatened() {
    const threat = incomingProjectile(this.bot) ?? aimingAtMe(this.bot);
    if (!threat || this.msUntilReady() < 120) return false;
    return this.raise(threat.position.offset(0, 1, 0));
  }

  // ── 水桶、岩浆桶 ──

  // 水桶冲开怪群：在自己和怪群之间倒一桶水，水流把怪往外推（下界不行）。打完把水收回来。
  async waterWall() {
    const bot = this.bot;
    if (!this.flags.water || inNether(bot) || Date.now() < (this.nextWater ?? 0)) return false;
    const bucket = findInv(bot, /^water_bucket$/);
    const crowd = meleeHostiles(this.agent, 8);
    if (!bucket || crowd.length < 3) return false;
    const me = bot.entity.position;
    const ground = groundUnder(bot, me.plus(towardUnit(me, centroid(crowd)).scaled(1.6)));
    if (!ground) return false;
    this.nextWater = Date.now() + 15_000;
    this.lower();
    this.manual();
    this.stopMove();
    await holdItem(bot, bucket);
    await bot.lookAt(new Vec3(ground.x + 0.5, ground.y + 1, ground.z + 0.5), true);
    await this.wait(60);
    bot.activateItem();
    bot.deactivateItem();
    this.placedFluids.push(ground.offset(0, 1, 0));
    this.agent.events.push('bot', { what: 'combat', detail: '倒水把怪群冲开' });
    this.lastSwap = Date.now();
    await this.ensureWeapon();
    return true;
  }

  // 岩浆桶烫怪（极限模式）：目标 3～4.3 格远、周围没有会烧的东西、主人不在旁边时，倒在它脚下，然后退开。
  async lavaStrike(target) {
    const bot = this.bot;
    if (!this.flags.lava || Date.now() < (this.nextLava ?? 0) || /^(blaze|magma_cube|ghast|strider|wither|wither_skeleton|ender_dragon)$/.test(target.name)) return false;
    const lava = findInv(bot, /^lava_bucket$/);
    if (!lava) return false;
    const d = bot.entity.position.distanceTo(target.position);
    if (d < 3 || d > 4.3) return false;
    const feet = target.position.floored();
    const ground = bot.blockAt(feet.offset(0, -1, 0));
    if (!solid(ground) || !isEmpty(bot.blockAt(feet)) || !lavaSafe(this.agent, feet)) return false;
    this.nextLava = Date.now() + 8000;
    this.lower();
    this.manual();
    this.stopMove();
    await holdItem(bot, lava);
    await bot.lookAt(new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5), true);
    await this.wait(60);
    bot.activateItem();
    bot.deactivateItem();
    this.placedFluids.push(feet.clone());
    this.agent.events.push('bot', { what: 'combat', detail: `往 ${target.name} 脚下倒了岩浆` });
    await this.backOff(target.position, 500);
    this.lastSwap = Date.now();
    await this.ensureWeapon();
    return true;
  }

  // 打完把插在地上的箭捡回来（骷髅射的捡不起来，走过去也没关系）
  async collectArrows() {
    const bot = this.bot;
    if (!this.stats.shots) return;
    const arrows = Object.values(bot.entities)
      .filter((e) => /^(arrow|spectral_arrow)$/.test(e.name ?? '') && meta(bot, e, 'in_ground') === true && e.position.distanceTo(bot.entity.position) < 24)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      .slice(0, 8);
    for (const a of arrows) {
      if (!a.isValid || meleeHostiles(this.agent, 8).length) break;
      await gotoGoal(this.agent, new goals.GoalNear(a.position.x, a.position.y, a.position.z, 0.8), { timeoutMs: 5000 }).catch(() => {});
      await sleep(150);
    }
  }

  // 打完把倒出去的水和岩浆收回来（只收源头方块）
  async collectFluids() {
    const bot = this.bot;
    for (const pos of this.placedFluids.splice(0)) {
      const b = bot.blockAt(pos);
      if (!b || !/^(water|lava)$/.test(b.name) || Number(b.getProperties?.().level ?? 0) !== 0) continue;
      const bucket = findInv(bot, /^bucket$/);
      if (!bucket) break;
      try {
        if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
          await gotoGoal(this.agent, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeoutMs: 8000 });
        }
        await holdItem(bot, bucket);
        await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
        await sleep(80);
        bot.activateItem();
        bot.deactivateItem();
        await sleep(300);
      } catch (err) {
        log.debug(`收水/岩浆失败：${err.message}`);
      }
    }
  }

  // ── 远程 ──
  async shoot(target, { aimY = 0.5 } = {}) {
    const bot = this.bot;
    const bow = findInv(bot, /^bow$/);
    if (!bow || !hasArrows(bot) || !this.flags.bow) return false;
    this.lower();
    this.manual();
    this.stopMove();
    if (bot.heldItem?.name !== 'bow') {
      await bot.equip(bow, 'hand');
      this.lastSwap = Date.now();
    }
    bot.activateItem();
    const samples = [];
    let aim = null;
    let released = false;
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 1150) {
        await this.wait(50);
        if (!alive(bot, target)) break;
        samples.push({ t: Date.now(), p: target.position.clone() });
        aim = aimAt(bot, target, samples, aimY, ARROW);
        if (aim) await bot.look(aim.yaw, aim.pitch, true);
      }
      if (aim && alive(bot, target)) {
        await this.wait(60); // 等视角同步到服务器再松手
        bot.deactivateItem();
        released = true;
        this.stats.shots += 1;
      }
    } finally {
      if (!released) {
        // 没瞄准就不放箭：换手上的东西来取消拉弓
        await this.ensureWeapon().catch(() => {});
        bot.deactivateItem();
      }
    }
    return released;
  }

  async throwAt(target, itemName) {
    const bot = this.bot;
    const item = findInv(bot, new RegExp(`^${itemName}$`));
    if (!item) return false;
    this.lower();
    if (bot.heldItem?.name !== itemName) {
      await bot.equip(item, 'hand');
      this.lastSwap = Date.now();
    }
    const sol = solveBallistic(eye(bot).offset(0, -0.1, 0), target.position.offset(0, (target.height ?? 1.8) / 2, 0), SNOWBALL);
    if (!sol) return false;
    await bot.look(sol.yaw, sol.pitch, true);
    bot.activateItem(); // 扔东西的数据包自带视角，方向就是刚算好的
    bot.deactivateItem();
    this.stats.shots += 1;
    return true;
  }

  // ── 船困怪 ──
  shouldBoat(target, t) {
    const bot = this.bot;
    if (!this.flags.boat_trap || this.boatTried.has(target.id) || target.vehicle || !boatItem(bot) || !fitsBoat(bot, target)) return false;
    if (t.boat) return true;
    const weak = bot.health <= 12 || !bot.inventory.items().some(isMeleeWeapon) || this.meleeCrowd(8) >= 2;
    return Boolean(t.boatWhenWeak) && weak;
  }

  // 在自己和怪之间放一条船，怪走进船里就动不了（末影人在船里也不能瞬移），然后站在它够不着的距离打。
  async boatTrap(target) {
    const bot = this.bot;
    this.boatTried.add(target.id);
    const item = boatItem(bot);
    const me = bot.entity.position;
    const d = flat(me, target.position);
    if (!item || d < 2.6 || d > 10) return false;
    const ground = groundUnder(bot, me.plus(towardUnit(me, target.position).scaled(1.9)));
    if (!ground) return false;
    this.lower();
    this.manual();
    this.stopMove();
    try {
      await bot.equip(item, 'hand');
      this.lastSwap = Date.now();
      const spot = new Vec3(ground.x + 0.5, ground.y + 1, ground.z + 0.5);
      await bot.lookAt(spot, true);
      const spawned = waitForBoat(bot, spot, 1500);
      bot.activateItem();
      bot.deactivateItem();
      const boat = await spawned;
      if (!boat) return false;
      this.agent.myBoats.add(boat.id);
      this.boats.add(boat.id);
      this.agent.events.push('bot', { what: 'combat', detail: `放船困 ${target.name}` });
      // 退着走，让船挡在中间，等怪走进去
      const until = Date.now() + 7000;
      while (Date.now() < until && alive(bot, target) && !target.vehicle) {
        this.check();
        await this.face(target);
        const dd = flat(bot.entity.position, target.position);
        bot.setControlState('back', dd < 3.6 && safeStep(bot, towardUnit(target.position, bot.entity.position)));
        if (dd < 1.6) break;
        await this.wait(50);
      }
      bot.setControlState('back', false);
      const trapped = target.vehicle?.id === boat.id;
      if (trapped) log.info(`${target.name} 被船困住了`);
      return trapped;
    } finally {
      await this.ensureWeapon();
    }
  }

  // 打完把自己放的船敲掉捡回来（船里还有生物的不动）。
  async collectBoats() {
    const bot = this.bot;
    for (const id of [...this.boats]) {
      this.boats.delete(id);
      const boat = bot.entities[id];
      if (!boat) {
        this.agent.myBoats.delete(id);
        continue;
      }
      if (boat.passengers?.length) continue;
      try {
        if (flat(bot.entity.position, boat.position) > 2.8) {
          await gotoGoal(this.agent, new goals.GoalNear(boat.position.x, boat.position.y, boat.position.z, 2), { timeoutMs: 8000 });
        }
        const where = boat.position.clone();
        for (let i = 0; i < 6 && boat.isValid; i++) {
          await bot.lookAt(boat.position.offset(0, 0.3, 0), true);
          bot.attack(boat);
          await sleep(250);
        }
        this.agent.myBoats.delete(id);
        await sleep(300);
        const drop = Object.values(bot.entities).find((e) => e.name === 'item' && e.position.distanceTo(where) < 4
          && /(boat|raft)$/.test(e.getDroppedItem?.()?.name ?? ''));
        if (drop) await gotoGoal(this.agent, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5), { timeoutMs: 5000 }).catch(() => {});
      } catch (err) {
        log.debug(`收船失败：${err.message}`);
      }
    }
  }

  // ── 通用近战 ──
  shouldGuard(target, d) {
    if (d > 3.6 || this.msUntilReady() < 350) return false;
    const heavy = cooldownMs(this.bot.heldItem) >= 800;
    return heavy || this.bot.health < 14 || this.meleeCrowd(3.5) >= 2;
  }

  async retreatToWater() {
    const bot = this.bot;
    const water = bot.findBlock({ matching: (b) => b.name === 'water', maxDistance: 12 });
    if (!water) return false;
    this.lower();
    this.manual();
    this.stopMove();
    await gotoGoal(this.agent, new goals.GoalBlock(water.position.x, water.position.y, water.position.z), { signal: this.signal, timeoutMs: 8000 }).catch(() => {});
    return Boolean(bot.entity.isInWater);
  }

  // 近身时的一步：面朝目标、保持距离、该挡就挡、该打就打（群怪时优先横扫，打完往后退一步）。
  async step(target, t, { trapped = false } = {}) {
    const bot = this.bot;
    await this.face(target);
    const d = this.steer(target, trapped ? 2.5 : t.spacing, { strafe: t.ranged && !trapped });
    if (!trapped && this.blockIfThreatened()) {
      await this.wait(50);
      return;
    }
    const crowd = this.meleeCrowd(4);
    const kite = async () => {
      if (this.flags.kite && crowd >= 2) await this.backOff(target.position, 300);
    };
    if (this.ready()) {
      const reach = reachTo(bot, target);
      const cluster = clusterAround(this.agent, target);
      if (this.flags.sweep && isSword(bot.heldItem) && cluster >= 1 && reach <= REACH && bot.entity.onGround && !sweepRisk(this.agent, target)) {
        // 目标旁边还挤着别的怪：站稳平砍，横扫一次砍到好几只
        bot.setControlState('sprint', false);
        this.hit(target);
        this.stats.sweeps += 1;
        await kite();
        return;
      }
      if (reach <= REACH + 0.5 && await this.critStrike(target)) {
        await kite();
        return;
      }
      if (reach <= REACH && !(isSword(bot.heldItem) && sweepRisk(this.agent, target))) {
        this.hit(target);
        await kite();
        return;
      }
    } else if (!t.axe && !trapped && this.shouldGuard(target, d)) {
      this.raise(target.position.offset(0, Math.min((target.height ?? 1.8) * 0.8, 1.5), 0));
    } else this.lower();
    await this.wait(50);
  }

  async melee(target, until, t = TACTICS.default, { trapped = false } = {}) {
    const bot = this.bot;
    let best = Infinity;
    let bestAt = Date.now();
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      if (await this.dodgeCreepers(target)) continue;
      if (t.water && bot.health <= 10 && await this.retreatToWater()) return false;
      const d = flat(bot.entity.position, target.position);
      const dy = target.position.y - bot.entity.position.y;
      if (d > 80) return false;
      if (this.perched) {
        // 在柱子上：够得着就打，有弓就射，血回来了或者怪少了再下去
        await this.face(target);
        if (this.ready() && reachTo(bot, target) <= REACH) {
          this.hit(target);
          continue;
        }
        if (hasBow(bot) && d > 1.5) {
          await this.shoot(target);
          continue;
        }
        if (bot.health >= 16 || this.meleeCrowd(5) < 2) this.perched = false;
        await this.wait(100);
        continue;
      }
      // 怪堆就在前面：先砸药水，再试岩浆
      if (!trapped && (await this.potionAtCrowd(target) || await this.lavaStrike(target))) continue;
      // 远了：远程怪或者正冲过来的，有弓先射几箭；否则用寻路靠近（能绕开障碍）
      if (d > 10 && this.flags.bow && hasBow(bot) && !trapped && target.name !== 'enderman') {
        await this.shoot(target);
        continue;
      }
      if (d > 5 || Math.abs(dy) > 2.5) {
        // 追了 12 秒没靠近（隔着河、悬崖、墙）：放弃，1 分钟内不再选它
        if (d < best - 1.5) {
          best = d;
          bestAt = Date.now();
        } else if (Date.now() - bestAt > 12_000) {
          this.agent.unreachable ??= new Map();
          this.agent.unreachable.set(target.id, Date.now() + 60_000);
          log.debug(`${target.name} 走不过去，先不管它`);
          return false;
        }
        if (!(t.ranged && bot.health < 14 && this.blockIfThreatened())) this.lower();
        this.follow(target, Math.max(1, (trapped ? 2.5 : t.spacing) - 0.5));
        await this.wait(100);
        continue;
      }
      this.manual();
      await this.step(target, t, { trapped });
    }
    return !alive(bot, target);
  }

  // ── 专门打法 ──

  // 苦力怕：估算它的引信（膨胀时每刻 +1，到 30 刻爆炸；离开 7 格或看不见时往回减），据此决定：
  //   时间还够 → 冲刺击退再砍一刀（击退能把它推开）；快来不及了 → 立刻跑出 7 格；跑不掉 → 举盾正对它挡爆炸。
  //   有弓就在 5 格外射；没膨胀时在它还不会膨胀的 3～3.5 格出手，打完退开。
  async creeper(target, until) {
    const bot = this.bot;
    let fuse = 0;
    let last = Date.now();
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      const now = Date.now();
      const ticks = (now - last) / 50;
      last = now;
      const swelling = meta(bot, target, 'swell_dir') > 0 || meta(bot, target, 'is_ignited') === true;
      fuse = Math.max(0, Math.min(30, fuse + (swelling ? ticks : -ticks)));
      const d = flat(bot.entity.position, target.position);
      if (d > 40) return false;
      const plan = creeperPlan(this.agent);
      const left = 30 - fuse;
      const escape = Math.max(0, (7.5 - d) / 0.28); // 疾跑跑出 7 格要的刻数
      if (swelling && (plan === 'flee' || left < escape + 6)) {
        const ok = await this.runFrom(target, 8, Math.max(800, left * 50 + 600));
        if (!ok && flat(bot.entity.position, target.position) < 5 && this.raise(target.position.offset(0, 1, 0))) {
          const t0 = Date.now();
          while (Date.now() - t0 < Math.max(600, left * 50 + 400) && alive(bot, target)) {
            await this.face(target, 1);
            await this.wait(50);
          }
          this.lower();
        }
        continue;
      }
      if (plan === 'bow' && d >= 5 && d <= 30) {
        await this.shoot(target);
        continue;
      }
      if (plan === 'flee' || (plan === 'bow' && d < 5 && !bot.inventory.items().some(isMeleeWeapon))) {
        if (d < 6) await this.runFrom(target, 10, 3000);
        return false;
      }
      await this.ensureWeapon();
      if (d > 6) {
        this.follow(target, 3.5);
        await this.wait(100);
        continue;
      }
      this.manual();
      await this.face(target);
      const inReach = reachTo(bot, target) <= REACH + 0.1;
      const safeToHit = !swelling ? d >= 2.9 : left > escape + 12;
      if (this.ready() && inReach && safeToHit) {
        this.stopMove();
        await this.sprintHit(target);
        await this.backOff(target.position, 400);
        continue;
      }
      // 没准备好就退到 3.2～3.5 格等着，准备好了再往前凑
      const toward = towardUnit(bot.entity.position, target.position);
      bot.setControlState('forward', this.ready() && d > 3.45 && safeStep(bot, toward));
      bot.setControlState('back', (!this.ready() || d < 3.05) && safeStep(bot, toward.scaled(-1)));
      bot.setControlState('sprint', false);
      await this.wait(50);
    }
    return !alive(bot, target);
  }

  // 末影人：被激怒后会瞬移到它的目标身边打人。近身就跳劈、举盾；它瞬移走了不丢目标——
  // 它在找主人就守在主人旁边，在找我就原地等它回来；不生气又走远了才放弃。有船先船困（船里不能瞬移），血少躲进水里。不用弓箭（会躲开）。
  async enderman(target, until) {
    const bot = this.bot;
    const t = TACTICS.enderman;
    let lostSince = null;
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      const d = target.isValid ? bot.entity.position.distanceTo(target.position) : Infinity;
      if (d > 64) {
        lostSince ??= Date.now();
        if (Date.now() - lostSince > 8000) return false;
        await this.wait(200);
        continue;
      }
      lostSince = null;
      if (bot.health <= 10 && await this.retreatToWater()) return false;
      if (d < 9 && this.shouldBoat(target, t) && await this.boatTrap(target)) return this.melee(target, until, t, { trapped: true });
      if (d <= 5.5 && Math.abs(target.position.y - bot.entity.position.y) < 2.5) {
        this.manual();
        await this.step(target, t);
        continue;
      }
      if (!provoked(this.agent, target) && d > 16) return false;
      const owner = ownerEntity(this.agent);
      if (owner && owner.position.distanceTo(target.position) < d - 2 && owner.position.distanceTo(bot.entity.position) > 3) this.follow(owner, 2);
      else if (d < 24) this.follow(target, 2);
      else {
        this.manual();
        this.stopMove();
        await this.face(target);
      }
      if (d < 7 && this.msUntilReady() > 150) this.raise(target.position.offset(0, 2.2, 0));
      else this.lower();
      await this.wait(100);
    }
    return !alive(bot, target);
  }

  // 恶魂：飞来的火球看着恶魂打回去（反弹的火球一下就能打死它）；有弓就射；火球躲不开就举盾。
  async ghast(target, until) {
    const bot = this.bot;
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      const d = bot.entity.position.distanceTo(target.position);
      if (d > 90) return false;
      const fb = Object.values(bot.entities).find((e) => e.name === 'fireball' && e.position.distanceTo(bot.entity.position) < 10);
      if (fb) {
        this.manual();
        this.stopMove();
        await bot.lookAt(target.position.offset(0, 2, 0), true);
        if (reachTo(bot, fb) <= REACH + 0.3) {
          this.lower();
          await this.ensureWeapon();
          bot.attack(fb);
          this.lastAttack = Date.now();
          this.stats.hits += 1;
          log.debug('反弹火球');
          await this.wait(150);
          continue;
        }
        if (fb.position.distanceTo(bot.entity.position) < 5 && this.canBlock()) this.raise(fb.position);
        await this.wait(25);
        continue;
      }
      this.lower();
      if (hasBow(bot) && d <= 50) {
        await this.shoot(target);
        continue;
      }
      if (reachTo(bot, target) <= REACH && this.ready()) {
        await this.ensureWeapon();
        this.hit(target);
        continue;
      }
      if (meta(bot, target, 'is_charging')) await bot.lookAt(target.position.offset(0, 2, 0), true);
      await this.wait(100);
    }
    return !alive(bot, target);
  }

  // 烈焰人、旋风人等会飞的：雪球（烈焰人怕雪球）> 弓箭 > 贴近了跳劈；它蓄力时举盾。
  async flyer(target, until) {
    const bot = this.bot;
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      const d = bot.entity.position.distanceTo(target.position);
      if (d > 40) return false;
      if (target.name === 'blaze' && d >= 2.5 && d <= 18 && findInv(bot, /^snowball$/)) {
        await this.throwAt(target, 'snowball');
        await this.wait(250);
        continue;
      }
      if (hasBow(bot) && d >= 5 && d <= 40 && reachTo(bot, target) > REACH) {
        await this.shoot(target);
        continue;
      }
      await this.ensureWeapon();
      if (reachTo(bot, target) <= REACH + 0.5 && this.ready()) {
        if (!(await this.critStrike(target)) && reachTo(bot, target) <= REACH) this.hit(target);
        continue;
      }
      if (!this.blockIfThreatened()) this.lower();
      if (Math.abs(target.position.y - bot.entity.position.y) < 3) this.follow(target, 2);
      await this.wait(80);
    }
    return !alive(bot, target);
  }

  // 幻翼：有弓就射；没有就等它俯冲到身边时出手，冲过来时举盾。
  async phantom(target, until) {
    const bot = this.bot;
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      const d = bot.entity.position.distanceTo(target.position);
      if (d > 48) return false;
      if (hasBow(bot) && d >= 7 && d <= 35) {
        await this.shoot(target);
        continue;
      }
      await this.ensureWeapon();
      await this.face(target, 0.25);
      if (reachTo(bot, target) <= REACH && this.ready()) {
        this.hit(target);
        continue;
      }
      if (d < 8 && this.msUntilReady() > 150) this.raise(target.position);
      else this.lower();
      await this.wait(40);
    }
    return !alive(bot, target);
  }

  // 末影水晶：只能远程打（近身打会被炸）。
  async crystal(target, until) {
    let shots = 0;
    while (Date.now() < until && alive(this.bot, target) && shots < 5) {
      this.check();
      if (!(await this.shoot(target, { aimY: 0.5 }))) throw new Error('打末影水晶需要弓和箭（近身打会被炸）');
      shots += 1;
      await this.wait(500);
    }
    return !alive(this.bot, target);
  }

  // 凋灵：刚召唤出来蓄力时离远（会大爆炸）；血量一半以上时用弓（一半以下箭会被弹开），之后等它飞低时跳劈；
  // 凋灵之首飞来时举盾；中了凋零效果喝牛奶，血少了吃金苹果。
  async wither(target, until) {
    const bot = this.bot;
    const maxHp = 300;
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      const d = bot.entity.position.distanceTo(target.position);
      if (Number(meta(bot, target, 'inv') ?? 0) > 0) {
        if (d < 12) await this.runFrom(target, 14, 3000);
        else await this.wait(200);
        continue;
      }
      const skull = incomingProjectile(bot, 16);
      if (skull && this.msUntilReady() > 100 && this.raise(skull.position)) {
        await this.wait(50);
        continue;
      }
      this.lower();
      const armored = (healthOf(bot, target) ?? maxHp) <= maxHp / 2;
      if (!armored && hasBow(bot) && d >= 5 && d <= 40) {
        await this.shoot(target, { aimY: 0.6 });
        continue;
      }
      await this.ensureWeapon();
      if (reachTo(bot, target) <= REACH + 0.5 && this.ready()) {
        if (!(await this.critStrike(target)) && reachTo(bot, target) <= REACH) this.hit(target);
        continue;
      }
      if (flat(bot.entity.position, target.position) > 3) this.follow(target, 2);
      await this.wait(60);
    }
    return !alive(bot, target);
  }

  async avoidBreath() {
    const bot = this.bot;
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'area_effect_cloud') continue;
      const r = Number(meta(bot, e, 'radius') ?? 3);
      if (flat(e.position, bot.entity.position) < r + 1 && Math.abs(e.position.y - bot.entity.position.y) < 2) {
        await this.runFrom(e, r + 3, 2000);
        return true;
      }
    }
    return false;
  }

  async wearPumpkin() {
    const bot = this.bot;
    const pumpkin = findInv(bot, /^carved_pumpkin$/);
    const current = bot.inventory.slots[bot.getEquipmentDestSlot('head')];
    if (!pumpkin || current?.name === 'carved_pumpkin') return;
    this.savedHelmet = current?.name ?? null;
    await bot.equip(pumpkin, 'head').catch(() => {});
  }

  async restoreHelmet() {
    if (this.savedHelmet === undefined) return;
    const bot = this.bot;
    const helmet = this.savedHelmet ? findInv(bot, new RegExp(`^${this.savedHelmet}$`)) : null;
    if (helmet) await bot.equip(helmet, 'head').catch(() => {});
    else await bot.unequip('head').catch(() => {});
  }

  // 末影龙：戴南瓜头防末影人；先用弓打掉水晶（最多每个射 4 箭，打不到的多半有铁栏杆罩着）；
  // 龙落在传送门上时去砍头（跳劈），飞着时射箭；躲开龙息。
  async dragon(target, until) {
    const bot = this.bot;
    await this.wearPumpkin();
    try {
      const tries = new Map();
      while (hasBow(bot) && Date.now() < until) {
        this.check();
        const crystals = Object.values(bot.entities)
          .filter((e) => e.name === 'end_crystal' && (tries.get(e.id) ?? 0) < 4 && e.position.distanceTo(bot.entity.position) < 160)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
        if (!crystals.length) break;
        const c = crystals[0];
        await this.emergency(target);
        if (await this.avoidBreath()) continue;
        const dc = c.position.distanceTo(bot.entity.position);
        if (dc > 60) {
          await gotoGoal(this.agent, new goals.GoalNear(c.position.x, bot.entity.position.y, c.position.z, 40), { signal: this.signal, timeoutMs: 20_000 }).catch(() => {});
          tries.set(c.id, (tries.get(c.id) ?? 0) + 1);
          continue;
        }
        await this.shoot(c);
        tries.set(c.id, (tries.get(c.id) ?? 0) + 1);
        await this.wait(400);
      }
      let flip = false;
      let lastHp = healthOf(bot, target);
      let misses = 0;
      while (Date.now() < until) {
        this.check();
        if (!alive(bot, target) || meta(bot, target, 'phase') === 9) return true;
        await this.emergency(target);
        if (await this.avoidBreath()) continue;
        const phase = meta(bot, target, 'phase');
        if ([3, 5, 6, 7].includes(phase)) {
          const head = dragonHead(target, flip);
          if (flat(bot.entity.position, head) > 2.5) {
            await gotoGoal(this.agent, new goals.GoalNear(head.x, head.y, head.z, 2), { signal: this.signal, timeoutMs: 6000 }).catch(() => {});
            continue;
          }
          this.manual();
          await bot.lookAt(head.offset(0, 0.5, 0), true);
          await this.ensureWeapon();
          if (this.ready()) {
            const part = { id: target.id + 1, name: 'ender_dragon_part', position: head, width: 1, height: 1, isValid: true };
            if (!(await this.critStrike(part))) this.hit(part);
            await this.wait(300);
            const hp = healthOf(bot, target);
            if (hp != null && lastHp != null && hp >= lastHp) misses += 1;
            else misses = 0;
            lastHp = hp;
            if (misses >= 3) {
              flip = !flip; // 头的位置估错了，换另一边
              misses = 0;
            }
          }
          await this.wait(50);
          continue;
        }
        if (hasBow(bot) && bot.entity.position.distanceTo(target.position) <= 45) {
          await this.shoot(target, { aimY: 0.4 });
          continue;
        }
        const portal = new Vec3(0, bot.entity.position.y, 0);
        if (String(bot.game?.dimension ?? '').includes('end') && flat(bot.entity.position, portal) > 16) {
          await gotoGoal(this.agent, new goals.GoalNear(0, bot.entity.position.y, 0, 10), { signal: this.signal, timeoutMs: 15_000 }).catch(() => {});
        }
        await this.wait(200);
      }
      return !alive(bot, target);
    } finally {
      await this.restoreHelmet();
    }
  }

  async run(target, until) {
    const name = target.name;
    if (name === 'ender_dragon') return this.dragon(target, until);
    if (name === 'wither') return this.wither(target, until);
    if (name === 'end_crystal') return this.crystal(target, until);
    if (name === 'creeper') return this.creeper(target, until);
    if (name === 'enderman') return this.enderman(target, until);
    if (name === 'ghast') return this.ghast(target, until);
    if (name === 'phantom') return this.phantom(target, until);
    if (name === 'blaze' || name === 'breeze' || name === 'vex') return this.flyer(target, until);
    const t = TACTICS[target.type === 'player' ? 'player' : name] ?? TACTICS.default;
    if (this.shouldBoat(target, t) && await this.boatTrap(target)) return this.melee(target, until, t, { trapped: true });
    return this.melee(target, until, t);
  }
}

// 打一个目标直到它倒下 / 跑远 / 超时。血量过低时撤退并抛出 LowHealthError。返回是否打倒。
export async function fight(agent, target, signal, timeoutMs = 45_000, opts = {}) {
  const f = new Fighter(agent, signal, opts);
  agent.fighting = (agent.fighting ?? 0) + 1;
  try {
    await f.equip();
    const won = await f.run(target, Date.now() + timeoutMs);
    const { hits, crits, sweeps, shots, blocks, potions } = f.stats;
    if (hits + shots + potions) {
      log.debug(`${target.name ?? target.username}：出手 ${hits} 次（暴击 ${crits}、横扫 ${sweeps}），射击 ${shots} 次，举盾 ${blocks} 次，药水 ${potions} 瓶（${f.flags.mode}模式）`);
    }
    return won;
  } finally {
    agent.fighting -= 1;
    f.lower();
    f.stopMove();
    f.manual();
    if (!signal?.aborted) {
      await f.collectBoats().catch(() => {});
      await f.collectFluids().catch(() => {});
      await f.collectArrows().catch(() => {});
    }
    await sleep(50);
  }
}

// ── 平时的本能：举盾挡箭、图腾换回盾牌、着火倒水、溺水上浮、主人血少时往他身上扔治疗药水 ──

const CALM_TASKS = new Set(['companion', 'follow', 'come', 'guard', 'goto', 'pickup']);

export function installCombatSense(agent, bot) {
  agent.myBoats ??= new Set();
  let blocking = false;
  let holdUntil = 0;
  let lastAllyPotion = 0;
  let lastFireWater = 0;
  let lastFight = 0;
  const lower = () => {
    if (!blocking) return;
    bot.deactivateItem();
    blocking = false;
  };
  bot._client.on('set_cooldown', (p) => {
    const group = String(p.cooldownGroup ?? '');
    if (/shield/.test(group) || (p.itemID != null && p.itemID === bot.registry.itemsByName.shield?.id)) {
      agent.shieldCooldownUntil = Date.now() + Number(p.cooldownTicks ?? 0) * 50;
      if (p.cooldownTicks > 0) agent.events.push('bot', { what: 'combat', detail: `盾牌被斧头打掉了，${Math.round(p.cooldownTicks / 20)} 秒后才能再举` });
    }
  });
  const busy = () => bot.usingHeldItem || bot.currentWindow || bot.targetDigBlock;
  const slowTimer = setInterval(async () => {
    try {
      if (!agent.online || !bot.entity || bot.isSleeping) return;
      if (agent.fighting) lastFight = Date.now();
      const f = combatFlags(agent);
      const off = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
      // 打完 10 秒、血回来了：副手的图腾换回盾牌
      if (off?.name === 'totem_of_undying' && !agent.fighting && Date.now() - lastFight > 10_000 && bot.health >= 16 && !busy()) {
        const shield = bot.inventory.items().find((i) => i.name === 'shield');
        if (shield) await bot.equip(shield, 'off-hand').catch(() => {});
      }
      // 盔甲快坏了：身上有同类的就换上，没有就提醒一次
      if (!agent.fighting && Date.now() - (agent.lastArmorCheck ?? 0) > 10_000 && !busy()) {
        agent.lastArmorCheck = Date.now();
        for (const [dest, re, label] of [['head', /_helmet$/, '头盔'], ['torso', /_chestplate$/, '胸甲'], ['legs', /_leggings$/, '护腿'], ['feet', /_boots$/, '靴子']]) {
          const cur = bot.inventory.slots[bot.getEquipmentDestSlot(dest)];
          if (!cur || !isWorn(cur)) continue;
          const spare = bot.inventory.items().filter((i) => re.test(i.name) && !isWorn(i)).sort((a, b) => durabilityLeft(b) - durabilityLeft(a))[0];
          if (spare) {
            await bot.equip(spare, dest).catch(() => {});
            agent.events.push('bot', { what: 'combat', detail: `${cur.name} 快坏了，换上了 ${spare.name}` });
          } else {
            agent.wornWarned ??= new Set();
            if (!agent.wornWarned.has(cur.name)) {
              agent.wornWarned.add(cur.name);
              agent.say(`我的${label}（${cur.name}）快坏了，只剩 ${durabilityLeft(cur)} 点耐久，主人有空帮我修一修或者换一件喵`);
            }
          }
        }
      }
      // 溺水：氧气不多了就往上游
      if (bot.entity.isInWater && (bot.oxygenLevel ?? 20) < 8) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 900);
      }
      // 着火又没有抗火：倒一桶水在脚下灭火，再收回来（下界不行）
      const burning = (Number(meta(bot, bot.entity, 'shared_flags') ?? 0) & 1) === 1;
      const water = bot.inventory.items().find((i) => i.name === 'water_bucket');
      if (burning && water && !agent.fighting && !bot.entity.isInWater && !inNether(bot) && Date.now() - lastFireWater > 5000 && !busy()) {
        lastFireWater = Date.now();
        await holdItem(bot, water);
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
        bot.activateItem();
        bot.deactivateItem();
        await sleep(700);
        const src = bot.findBlock({ matching: (b) => b.name === 'water' && Number(b.getProperties?.().level ?? 0) === 0, maxDistance: 3 });
        const bucket = bot.inventory.items().find((i) => i.name === 'bucket');
        if (src && bucket) {
          await holdItem(bot, bucket);
          await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true);
          await sleep(60);
          bot.activateItem();
          bot.deactivateItem();
        }
      }
      // 主人血少：往他身上扔喷溅治疗 / 再生药水；主人着火：扔抗火
      if (f.potions && Date.now() - lastAllyPotion > 8000 && !busy()) {
        const owner = ownerEntity(agent, 6);
        if (owner) {
          const hp = healthOf(bot, owner);
          const ownerBurning = (Number(meta(bot, owner, 'shared_flags') ?? 0) & 1) === 1;
          const kinds = hp != null && hp <= 8 ? ['healing', 'regeneration'] : ownerBurning ? ['fire_resistance'] : null;
          if (kinds) {
            const used = await throwPotionAt(agent, owner, kinds.filter((k) => ALLY_KINDS.includes(k))).catch(() => null);
            if (used) {
              lastAllyPotion = Date.now();
              agent.events.push('bot', { what: 'combat', detail: `给主人扔了 ${used} 药水` });
              await equipBestWeapon(bot);
            }
          }
        }
      }
    } catch {
      // 数据不全时跳过这一轮
    }
  }, 1000);
  const timer = setInterval(() => {
    try {
      if (!agent.online || !bot.entity || agent.fighting || bot.isSleeping || !combatFlags(agent).shield) {
        if (!agent.fighting) lower();
        else blocking = false;
        return;
      }
      if ((bot.usingHeldItem && !blocking) || bot.currentWindow || bot.targetDigBlock) return;
      const cur = agent.tasks.current;
      const off = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
      if ((cur && !CALM_TASKS.has(cur.name)) || off?.name !== 'shield' || Date.now() < (agent.shieldCooldownUntil ?? 0)) {
        lower();
        return;
      }
      const threat = incomingProjectile(bot, 14) ?? aimingAtMe(bot);
      if (threat) {
        agent.lookLockUntil = Date.now() + 800;
        bot.lookAt(threat.position.offset(0, 1, 0), true).catch(() => {});
        if (!blocking) {
          bot.activateItem(true);
          blocking = true;
        }
        holdUntil = Date.now() + 700;
      } else if (blocking && Date.now() > holdUntil) lower();
    } catch {
      // 实体数据不全时跳过这一轮
    }
  }, 100);
  bot.once('end', () => {
    clearInterval(timer);
    clearInterval(slowTimer);
  });
}
