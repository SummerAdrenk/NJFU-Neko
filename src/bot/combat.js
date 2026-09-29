// 战斗技巧：蓄满再出手、跳劈（暴击）、冲刺击退、走位保持距离、盾牌格挡、用船困住打不过的怪、弓箭 / 雪球，
// 以及苦力怕、恶魂、烈焰人、幻翼、末影人、凋灵骷髅、凋灵、末影龙等的专门打法。
import { goals, makeMovements } from './createBot.js';
import {
  canMelee, equipBestWeapon, fleeFrom, gotoGoal, isAliveEntity, isHostile, isVehicleItemEntity, LowHealthError, nearestThreat, protectedReason, Vec3,
} from './helpers.js';
import { pillarUp, usePotion } from './movement.js';
import { getLog } from '../log.js';
import { abortError, sleep } from '../util.js';

const log = getLog('战斗');

const REACH = 3.0;
const ARROW = { speed: 3.0, gravity: 0.05, drag: 0.99, dragFirst: false };
const SNOWBALL = { speed: 1.5, gravity: 0.03, drag: 0.99, dragFirst: true };

// ── 基础数据 ────────────────────────────────────────────────

export function meta(bot, entity, key) {
  const keys = bot.registry.entitiesByName[entity?.name]?.metadataKeys;
  const i = keys ? keys.indexOf(key) : -1;
  return i >= 0 ? entity.metadata?.[i] : undefined;
}

// 攻击冷却（毫秒）：蓄满再打伤害最高，也才能暴击。
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

// ── 弹道：算出射中目标需要的角度（箭：先移动再减速再下坠；雪球：先下坠减速再移动）──

export function solveBallistic(from, to, { speed, gravity, drag, dragFirst }, maxTicks = 240) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dy = to.y - from.y;
  const horiz = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  if (horiz < 0.05) return { yaw, pitch: dy >= 0 ? Math.PI / 2 - 0.01 : -Math.PI / 2 + 0.01, ticks: Math.abs(dy) / speed };
  const heightAt = (pitch) => {
    let vh = speed * Math.cos(pitch);
    let vy = speed * Math.sin(pitch);
    let h = 0;
    let y = 0;
    for (let t = 0; t < maxTicks; t++) {
      if (dragFirst) {
        vy = (vy - gravity) * drag;
        vh *= drag;
      }
      const nh = h + vh;
      const ny = y + vy;
      if (nh >= horiz) {
        const f = (horiz - h) / vh;
        return { y: y + (ny - y) * f, ticks: t + f };
      }
      h = nh;
      y = ny;
      if (!dragFirst) {
        vh *= drag;
        vy = vy * drag - gravity;
      }
      if (vh < 1e-3) return null;
    }
    return null;
  };
  // 从低往高扫描角度，找到第一个“正好打到目标高度”的低弹道，再二分细化。
  let prev = null;
  for (let deg = -80; deg <= 80; deg += 1) {
    const p = (deg * Math.PI) / 180;
    const r = heightAt(p);
    const err = r ? r.y - dy : null;
    if (err !== null && prev?.err != null && prev.err < 0 && err >= 0) {
      let lo = prev.p;
      let hi = p;
      let best = r;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const rm = heightAt(mid);
        if (rm && rm.y - dy >= 0) {
          hi = mid;
          best = rm;
        } else lo = mid;
      }
      return { yaw, pitch: hi, ticks: best.ticks };
    }
    prev = { p, err };
  }
  return null;
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

// ── 该不该打 ────────────────────────────────────────────────

const NO_BOAT = new Set(['creeper', 'skeleton', 'stray', 'bogged', 'parched', 'pillager', 'illusioner', 'evoker', 'witch', 'blaze', 'ghast',
  'phantom', 'vex', 'breeze', 'guardian', 'elder_guardian', 'shulker', 'slime', 'magma_cube', 'warden', 'wither', 'ender_dragon', 'player']);

export function fitsBoat(bot, e) {
  const width = bot.registry.entitiesByName[e.name]?.width ?? e.width ?? 9;
  return width < 1.375 && !NO_BOAT.has(e.name);
}

// 苦力怕怎么处理：有弓就射，拿着近战武器且血量健康就“打了就跑”，否则躲开。
export function creeperPlan(agent) {
  const bot = agent.bot;
  const c = agent.cfg.combat ?? {};
  if (c.bow !== false && hasBow(bot)) return 'bow';
  if (c.creeper_melee !== false && bot.health >= 12 && bot.inventory.items().some(isMeleeWeapon)) return 'melee';
  return 'flee';
}

// 中立生物平时不招惹，但已经被激怒、正在打我的时候要还手（末影人会瞬移，躲是躲不掉的）。
const RETALIATE = new Set(['enderman', 'zombified_piglin', 'piglin', 'wolf', 'bee', 'polar_bear', 'llama', 'trader_llama', 'panda', 'goat']);

export function provoked(agent, e) {
  if (!e?.name || !RETALIATE.has(e.name) || !isAliveEntity(agent.bot, e) || protectedReason(agent, e)) return false;
  if (e.name === 'enderman' && meta(agent.bot, e, 'creepy') === true) return true;
  const t = agent.attackedBy?.get(e.id);
  return Boolean(t && Date.now() - t < 20_000);
}

// 自动防御时可以主动去打的：敌对（或者被激怒来打我的中立生物）、没被保护，而且有对应的打法。
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
  return Object.values(bot.entities).filter((e) => e !== bot.entity && e !== exclude && canMelee(e) && isAliveEntity(bot, e)
    && !protectedReason(agent, e) && e.position.distanceTo(me) < radius);
}

// 被怪群围住：8 格内 3 只以上近战怪
export const outnumbered = (agent, radius = 8) => meleeHostiles(agent, radius).length >= 3;

// 从怪群里撤出来：主人离怪群比我远就往主人那边跑，否则背对怪群跑开（僵尸追不上疾跑）。
export async function retreatFromCrowd(agent, signal, ms = 9000) {
  const bot = agent.bot;
  const crowd = meleeHostiles(agent, 14);
  if (!crowd.length) return;
  const center = crowd.reduce((acc, e) => acc.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / crowd.length);
  const me = bot.entity.position;
  const owner = Object.values(bot.players).find((p) => p.username !== bot.username && p.entity && agent.chat.isOwner(p.username)
    && p.entity.position.distanceTo(me) < 64)?.entity;
  let goal;
  if (owner && owner.position.distanceTo(center) > me.distanceTo(center) + 3) goal = new goals.GoalFollow(owner, 2);
  else {
    const away = new Vec3(me.x - center.x, 0, me.z - center.z);
    const n = Math.hypot(away.x, away.z) || 1;
    goal = new goals.GoalXZ(me.x + (away.x / n) * 18, me.z + (away.z / n) * 18);
  }
  bot.pathfinder.setMovements(makeMovements(bot));
  bot.pathfinder.setGoal(goal, true);
  const until = Date.now() + ms;
  try {
    while (Date.now() < until && meleeHostiles(agent, 6).length > 0) await sleep(200, signal);
  } finally {
    bot.pathfinder.setGoal(null);
  }
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
  enderman: { spacing: 2.7, boat: true, water: true },
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
  return !isHostile(e) || Boolean(protectedReason(agent, e));
}

export function sweepRisk(agent, target) {
  const bot = agent.bot;
  const zone = bbox(target);
  zone.minX -= 1;
  zone.maxX += 1;
  zone.minZ -= 1;
  zone.maxZ += 1;
  zone.minY -= 0.25;
  zone.maxY += 0.25;
  return Object.values(bot.entities).some((e) => isBystander(agent, e, target) && overlaps(zone, bbox(e))
    && e.position.distanceTo(bot.entity.position) < 3.3);
}

// ── 走位安全：不退下悬崖、不走进岩浆火焰 ────────────────────

const DANGER = /lava|fire|magma_block|cactus|sweet_berry_bush|campfire|powder_snow|wither_rose|pointed_dripstone/;
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

// 找放船的地面：spot 所在格或下面一格是实心方块，上面有空间。
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

// ── 战斗者 ──────────────────────────────────────────────────

export class Fighter {
  constructor(agent, signal, { boss = false } = {}) {
    this.agent = agent;
    this.bot = agent.bot;
    this.signal = signal;
    this.cfg = agent.cfg.combat ?? {};
    this.boss = boss;
    this.lastAttack = 0;
    this.lastSwap = Date.now();
    this.shieldUp = false;
    this.pathTarget = null;
    this.boatTried = new Set();
    this.boats = new Set();
    this.stats = { hits: 0, crits: 0, shots: 0, blocks: 0 };
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
    if (isMeleeWeapon(this.bot.heldItem)) return true;
    const before = this.bot.heldItem?.name;
    const w = await equipBestWeapon(this.bot);
    if (this.bot.heldItem?.name !== before) this.lastSwap = Date.now();
    return Boolean(w);
  }

  async equipShield() {
    if (this.cfg.shield === false) return;
    const bot = this.bot;
    if (bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === 'shield') return;
    const s = findInv(bot, /^shield$/);
    if (s) await bot.equip(s, 'off-hand').catch(() => {});
  }

  // ── 盾牌 ──
  canBlock() {
    const bot = this.bot;
    return this.cfg.shield !== false && !bot.vehicle && Date.now() > (this.agent.shieldCooldownUntil ?? 0)
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
    return this.cfg.crits !== false && e.onGround && !e.isInWater && !e.isInLava && !this.bot.vehicle;
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

  hasEffect(name) {
    const id = this.bot.registry.effectsByName?.[name]?.id;
    return id != null && Boolean(this.bot.entity.effects?.[id]);
  }

  meleeCrowd(radius) {
    const me = this.bot.entity.position;
    return Object.values(this.bot.entities).filter((e) => e !== this.bot.entity && canMelee(e) && e.position.distanceTo(me) < radius).length;
  }

  // 喝药水 / 扔喷溅药水（放下盾牌、停下脚步，用完换回武器）
  async potion(kinds) {
    if (this.cfg.potions === false) return false;
    this.lower();
    this.manual();
    this.stopMove();
    try {
      const used = await usePotion(this.agent, kinds);
      if (used) log.info(`用了药水：${used}`);
      return Boolean(used);
    } catch {
      return false;
    } finally {
      this.lastSwap = Date.now();
      await this.ensureWeapon();
    }
  }

  // 被围住又打不过：原地垫方块搭柱子躲上去（僵尸之类够不着），在上面接着打或射箭，血回来再下去。
  async pillar() {
    if (this.cfg.pillar === false || this.perched) return false;
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
    const retreatAt = Number(this.agent.cfg.behavior.retreat_health ?? 8);
    const burning = (Number(meta(bot, bot.entity, 'shared_flags') ?? 0) & 1) === 1;
    if (burning && bot.health <= 14 && !this.hasEffect('FireResistance') && await this.potion(['fire_resistance'])) return;
    if (this.hasEffect('Wither') && bot.health <= 12 && await this.consume(/^milk_bucket$/)) return;
    if (bot.health <= Math.max(retreatAt, 8)) {
      if (await this.potion(['healing', 'regeneration', 'turtle_master'])) return;
      if (this.cfg.golden_apples !== false && await this.consume(this.boss ? /^(enchanted_)?golden_apple$/ : /^golden_apple$/)) return;
      if (this.meleeCrowd(4) >= 2 && await this.pillar()) return;
    }
    const crowd = meleeHostiles(this.agent, 5, target).length + 1;
    if (!this.perched && !this.boss && crowd >= 3 && bot.health <= 14) {
      // 被围住又开始掉血：先垫方块躲上去，垫不了就撤
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
      if (e.name !== 'creeper' || e === target) continue;
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

  // ── 远程 ──
  async shoot(target, { aimY = 0.5 } = {}) {
    const bot = this.bot;
    const bow = findInv(bot, /^bow$/);
    if (!bow || !hasArrows(bot) || this.cfg.bow === false) return false;
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
    if (this.cfg.boat_trap === false || this.boatTried.has(target.id) || target.vehicle || !boatItem(bot) || !fitsBoat(bot, target)) return false;
    if (t.boat) return true;
    const crowd = Object.values(bot.entities).filter((e) => e !== target && canMelee(e) && e.position.distanceTo(bot.entity.position) < 8).length;
    const weak = bot.health <= 12 || !bot.inventory.items().some(isMeleeWeapon) || crowd >= 1;
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
    const crowd = Object.values(this.bot.entities).filter((e) => e !== target && canMelee(e) && e.position.distanceTo(this.bot.entity.position) < 3.5).length;
    return heavy || this.bot.health < 14 || crowd >= 1;
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

  async melee(target, until, t = TACTICS.default, { trapped = false } = {}) {
    const bot = this.bot;
    const spacing = trapped ? 2.5 : t.spacing;
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      if (await this.dodgeCreepers(target)) continue;
      if (t.water && bot.health <= 10 && await this.retreatToWater()) return false;
      const d = flat(bot.entity.position, target.position);
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
      const dy = target.position.y - bot.entity.position.y;
      if (d > 32) return false;
      if (d > 5 || Math.abs(dy) > 2.5) {
        // 远了用寻路靠近（能绕开障碍）；远程怪在瞄准时举盾顶上去
        if (!(t.ranged && bot.health < 14 && this.blockIfThreatened())) this.lower();
        this.follow(target, Math.max(1, spacing - 0.5));
        await this.wait(100);
        continue;
      }
      this.manual();
      await this.face(target);
      this.steer(target, spacing, { strafe: t.ranged && !trapped });
      if (!trapped && this.blockIfThreatened()) {
        await this.wait(50);
        continue;
      }
      if (this.ready()) {
        if (reachTo(bot, target) <= REACH + 0.5 && await this.critStrike(target)) continue;
        if (reachTo(bot, target) <= REACH && !(isSword(bot.heldItem) && sweepRisk(this.agent, target))) {
          this.hit(target);
          continue;
        }
      } else if (!t.axe && !trapped && this.shouldGuard(target, d)) {
        this.raise(target.position.offset(0, Math.min((target.height ?? 1.8) * 0.8, 1.5), 0));
      } else this.lower();
      await this.wait(50);
    }
    return !alive(bot, target);
  }

  // ── 专门打法 ──

  // 苦力怕：有弓先射；近战就“打了就跑”——站在它还不会膨胀的 3 格外冲刺击退，再退开；
  // 一旦开始膨胀立刻跑远（它膨胀时不会追），跑不掉就举盾正对它挡爆炸。
  async creeper(target, until) {
    const bot = this.bot;
    while (Date.now() < until) {
      this.check();
      if (!alive(bot, target)) return true;
      await this.emergency(target);
      const d = flat(bot.entity.position, target.position);
      if (d > 32) return false;
      const swelling = meta(bot, target, 'swell_dir') > 0 || meta(bot, target, 'is_ignited') === true;
      if (swelling) {
        if (d < 7.5) {
          const ok = await this.runFrom(target, 8, 2000);
          if (!ok && flat(bot.entity.position, target.position) < 5 && this.raise(target.position.offset(0, 1, 0))) {
            const t0 = Date.now();
            while (Date.now() - t0 < 2000 && alive(bot, target)) {
              await this.face(target, 1);
              await this.wait(50);
            }
            this.lower();
          }
        } else await this.wait(100);
        continue;
      }
      const plan = creeperPlan(this.agent);
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
      const toward = towardUnit(bot.entity.position, target.position);
      bot.setControlState('forward', d > 3.45 && safeStep(bot, toward));
      bot.setControlState('back', d < 3.05 && safeStep(bot, toward.scaled(-1)));
      bot.setControlState('sprint', false);
      if (d >= 3.0 && d <= 3.5 && this.ready() && reachTo(bot, target) <= REACH + 0.15) {
        this.stopMove();
        await this.sprintHit(target);
        if (safeStep(bot, towardUnit(target.position, bot.entity.position))) {
          bot.setControlState('back', true);
          await this.wait(350);
          bot.setControlState('back', false);
        }
        continue;
      }
      await this.wait(50);
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
    const { hits, crits, shots, blocks } = f.stats;
    if (hits + shots) log.debug(`${target.name ?? target.username}：出手 ${hits} 次（暴击 ${crits}），射击 ${shots} 次，举盾 ${blocks} 次`);
    return won;
  } finally {
    agent.fighting -= 1;
    f.lower();
    f.stopMove();
    f.manual();
    if (!signal?.aborted) await f.collectBoats().catch(() => {});
    await sleep(50);
  }
}

// ── 平时的防御本能：看到飞来的箭 / 火球、有远程怪在瞄准自己时举盾；记录盾牌被斧头打掉的冷却 ──

const CALM_TASKS = new Set(['companion', 'follow', 'come', 'guard', 'goto', 'pickup']);

export function installCombatSense(agent, bot) {
  agent.myBoats ??= new Set();
  let blocking = false;
  let holdUntil = 0;
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
  const timer = setInterval(() => {
    try {
      if (!agent.online || !bot.entity || agent.fighting || bot.isSleeping || agent.cfg.combat?.shield === false) {
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
  bot.once('end', () => clearInterval(timer));
}
