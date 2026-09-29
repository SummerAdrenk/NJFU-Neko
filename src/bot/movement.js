// 移动与生存技能：垫方块（往上搭柱子）、落地水 / 落地船 / 鞘翅滑翔（防摔）、鞘翅长途飞行、
// 穿越传送门、坐船 / 矿车 / 骑马、驯服动物。药水见 potions.js。
import { goals, makeMovements } from './createBot.js';
import { countItem, findNearestBlock, findPlayer, gotoGoal, gotoNear, Vec3 } from './helpers.js';
import { getLog } from '../log.js';
import { abortError, sleep } from '../util.js';

const log = getLog('移动');

// 可以随手垫的便宜方块
export const SCAFFOLD = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff|blackstone|end_stone|stone|deepslate|mud|basalt|calcite)$/;
export const scaffoldItem = (bot) => bot.inventory.items().find((i) => SCAFFOLD.test(i.name)) ?? null;
const solid = (b) => b && b.boundingBox === 'block';
const DIMENSIONS = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
const dimName = (bot) => {
  const d = String(bot.game?.dimension ?? '').replace(/^minecraft:/, '');
  return DIMENSIONS[d] ?? d;
};

async function holdInHand(bot, item) {
  if (!item) return false;
  if (bot.heldItem?.type === item.type) return true;
  const hotbar = bot.inventory.slots.slice(36, 45).findIndex((s) => s?.type === item.type);
  if (hotbar >= 0) {
    bot.setQuickBarSlot(hotbar);
    return true;
  }
  await bot.equip(item, 'hand');
  return true;
}

// ── 垫方块：原地往上搭柱子（跳起来，在脚下放方块）──
export async function pillarUp(agent, n, signal) {
  const bot = agent.bot;
  let done = 0;
  for (let i = 0; i < n; i++) {
    if (signal?.aborted) throw abortError(signal);
    const block = scaffoldItem(bot);
    if (!block || solid(bot.blockAt(bot.entity.position.offset(0, 2.2, 0)))) break;
    const base = bot.blockAt(bot.entity.position.offset(0, -0.5, 0).floored());
    if (!solid(base)) break;
    await holdInHand(bot, block);
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    const y0 = bot.entity.position.y;
    bot.setControlState('jump', true);
    const t0 = Date.now();
    while (bot.entity.position.y < y0 + 1.05 && Date.now() - t0 < 1000) await sleep(20, signal);
    bot.setControlState('jump', false);
    try {
      await bot.placeBlock(base, new Vec3(0, 1, 0));
      done += 1;
    } catch (err) {
      log.debug(`垫方块失败：${err.message}`);
      break;
    }
    await sleep(200, signal);
  }
  return done;
}

// ── 防摔：落地水（优先，下界不行）/ 鞘翅滑翔 / 落地船 ──
function groundBelow(bot, maxDepth = 48) {
  const p = bot.entity.position;
  for (let dy = 0; dy <= maxDepth; dy++) {
    const b = bot.blockAt(new Vec3(p.x, Math.floor(p.y) - dy, p.z));
    if (!b) return null;
    if (b.name === 'water' || b.name === 'bubble_column') return { y: b.position.y + 1, water: true, block: b };
    if (/cobweb|slime_block|hay_block|honey_block|powder_snow|_bed$/.test(b.name)) return { y: b.position.y + 1, soft: true, block: b };
    if (solid(b)) return { y: b.position.y + 1, block: b };
  }
  return null;
}

export function installFallSafety(agent, bot) {
  let apex = null;
  let busy = false;
  let lastClutch = 0;
  const cfg = () => agent.cfg.behavior;
  bot.on('physicsTick', () => {
    if (busy || !agent.online || !bot.entity || cfg().fall_safety === false) return;
    const e = bot.entity;
    if (['creative', 'spectator'].includes(bot.game?.gameMode) || e.onGround || e.isInWater || e.isInLava || bot.vehicle || e.elytraFlying) {
      apex = null;
      return;
    }
    if (apex == null || e.position.y > apex) apex = e.position.y;
    if (e.velocity.y > -0.4 || Date.now() - lastClutch < 3000) return;
    const ground = groundBelow(bot);
    if (!ground || ground.water || ground.soft) return;
    const total = apex - ground.y;
    const left = e.position.y - ground.y;
    if (total < 6 || left > 14) return;
    busy = true;
    clutch(ground, left).catch((err) => log.debug(`防摔失败：${err.message}`)).finally(() => {
      busy = false;
      lastClutch = Date.now();
    });
  });

  async function waitUntilHeight(ground, height, ms = 3000) {
    const t0 = Date.now();
    while (bot.entity.position.y - ground.y > height && !bot.entity.onGround && Date.now() - t0 < ms) await sleep(10);
  }

  async function clutch(ground, left) {
    const nether = /nether/.test(String(bot.game?.dimension ?? ''));
    const water = !nether && bot.inventory.items().find((i) => i.name === 'water_bucket');
    const elytraOn = bot.inventory.slots[bot.getEquipmentDestSlot('torso')]?.name === 'elytra';
    const boat = bot.inventory.items().find((i) => /_(boat|raft)$/.test(i.name));
    if (water) {
      await holdInHand(bot, water);
      await waitUntilHeight(ground, 2.6);
      if (bot.entity.onGround) return;
      await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      bot.activateItem(); // 视角朝下倒水，落进水里不摔伤
      bot.deactivateItem();
      agent.events.push('bot', { what: 'clutch', detail: `落地水（从 ${Math.round(left + (bot.entity.position.y - ground.y))} 格高处落下）` });
      const t0 = Date.now();
      while (!bot.entity.onGround && !bot.entity.isInWater && Date.now() - t0 < 3000) await sleep(20);
      await sleep(400);
      // 把水收回来
      const src = bot.findBlock({ matching: (b) => b.name === 'water' && b.getProperties?.().level === 0, maxDistance: 3 });
      const bucket = bot.inventory.items().find((i) => i.name === 'bucket');
      if (src && bucket) {
        await holdInHand(bot, bucket);
        await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true);
        await sleep(60);
        bot.activateItem();
        bot.deactivateItem();
      }
      return;
    }
    if (elytraOn && left > 5) {
      await bot.elytraFly().catch(() => {});
      await bot.look(bot.entity.yaw, -0.15, true); // 稍微抬头滑翔
      agent.events.push('bot', { what: 'clutch', detail: '鞘翅滑翔防摔' });
      const t0 = Date.now();
      while (!bot.entity.onGround && !bot.entity.isInWater && Date.now() - t0 < 20_000) await sleep(50);
      return;
    }
    if (boat) {
      await holdInHand(bot, boat);
      await waitUntilHeight(ground, 3.2);
      if (bot.entity.onGround) return;
      const spawned = new Promise((resolve) => {
        const onSpawn = (en) => {
          if (/(boat|raft)$/.test(en.name ?? '') && en.position.distanceTo(bot.entity.position) < 5) {
            bot.off('entitySpawn', onSpawn);
            resolve(en);
          }
        };
        bot.on('entitySpawn', onSpawn);
        setTimeout(() => {
          bot.off('entitySpawn', onSpawn);
          resolve(null);
        }, 600);
      });
      await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      bot.activateItem();
      bot.deactivateItem();
      const en = await spawned;
      if (en) bot.mount(en); // 坐进船里会清掉下落距离
      agent.events.push('bot', { what: 'clutch', detail: '落地船' });
      await sleep(800);
      if (bot.vehicle) {
        bot.dismount();
        await sleep(300);
        for (let i = 0; i < 6 && en?.isValid; i++) {
          bot.attack(en);
          await sleep(250);
        }
      }
    }
  }
}

// ── 传送门 ──
export async function usePortal(agent, signal, { kind = 'nether' } = {}) {
  const bot = agent.bot;
  const block = findNearestBlock(bot, [kind === 'end' ? 'end_portal' : 'nether_portal'], 64);
  if (!block) throw new Error(`附近 64 格没有${kind === 'end' ? '末地' : '下界'}传送门`);
  const from = dimName(bot);
  const changed = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 25_000);
    bot.once('respawn', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  const p = block.position;
  await gotoGoal(agent, new goals.GoalBlock(p.x, p.y, p.z), { signal, timeoutMs: 60_000 }).catch(async () => {
    await gotoNear(agent, p, 0.5, { signal, timeoutMs: 20_000 });
  });
  if (!(await changed)) throw new Error('在传送门里站了好一会儿也没传送（传送门可能坏了）');
  await sleep(2500, signal);
  return `从${from}穿过传送门，到了${dimName(bot)}`;
}

// ── 坐船 / 矿车 / 骑马 ──
const RIDEABLE = /(boat|raft|minecart)$|^(horse|donkey|mule|skeleton_horse|zombie_horse|camel|camel_husk|llama|trader_llama|pig|strider|happy_ghast|nautilus)$/;
const SEATS = (e) => (/(boat|raft)$/.test(e.name) && !/chest/.test(e.name) ? 2 : /^(camel|camel_husk)$/.test(e.name) ? 2 : /^happy_ghast$/.test(e.name) ? 4 : 1);
export const freeSeat = (e) => (e.passengers?.length ?? 0) < SEATS(e);

export async function mountEntity(agent, e, signal) {
  const bot = agent.bot;
  if (e.position.distanceTo(bot.entity.position) > 2.5) await gotoGoal(agent, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 1.5), { signal, timeoutMs: 30_000 });
  const mounted = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 2500);
    bot.once('mount', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  bot.mount(e);
  return mounted;
}

export async function ride(agent, { target }, signal) {
  const bot = agent.bot;
  const player = findPlayer(bot, target ?? '');
  let e;
  if (player) {
    e = player.entity?.vehicle;
    if (!e) throw new Error(`${player.username} 没有坐在船、矿车或坐骑上`);
    if (!freeSeat(e)) throw new Error(`${player.username} 的${e.name}已经坐满了`);
  } else {
    const want = String(target ?? 'boat').toLowerCase();
    const match = (n) => (want === 'boat' ? /(boat|raft)$/.test(n) : want === 'minecart' ? /minecart$/.test(n) : n === want);
    e = Object.values(bot.entities)
      .filter((x) => x.name && RIDEABLE.test(x.name) && match(x.name) && freeSeat(x) && x.position.distanceTo(bot.entity.position) < 32)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!e) throw new Error(`附近 32 格没有空着的 ${want}`);
  }
  if (!(await mountEntity(agent, e, signal))) throw new Error(`没坐上 ${e.name}（没驯服的马会把我甩下来，骑猪要先装鞍）`);
  return `坐上了 ${e.name}${player ? `，跟 ${player.username} 一起` : ''}`;
}

// ── 驯服 ──
const TAME_FOOD = {
  wolf: /^bone$/, cat: /^(cod|salmon)$/, ocelot: /^(cod|salmon)$/,
  parrot: /^(wheat_seeds|melon_seeds|pumpkin_seeds|beetroot_seeds|torchflower_seeds|pitcher_pod)$/,
};
const RIDE_TAME = /^(horse|donkey|mule|llama|trader_llama)$/;

function meta(bot, e, key) {
  const keys = bot.registry.entitiesByName[e?.name]?.metadataKeys;
  const i = keys ? keys.indexOf(key) : -1;
  return i >= 0 ? e.metadata?.[i] : undefined;
}

export function isTamed(bot, e) {
  if (e.name === 'ocelot') return meta(bot, e, 'trusting') === true;
  const flags = Number(meta(bot, e, 'flags') ?? 0);
  if (RIDE_TAME.test(e.name)) return (flags & 0x02) !== 0;
  return (flags & 0x04) !== 0 || Boolean(meta(bot, e, 'owneruuid'));
}

export async function tame(agent, { animal, give_to: giveTo }, signal) {
  const bot = agent.bot;
  const name = String(animal ?? '').toLowerCase();
  if (!TAME_FOOD[name] && !RIDE_TAME.test(name)) throw new Error(`${name} 不能驯服（可以驯服：狼、猫、豹猫、鹦鹉、马、驴、骡、羊驼）`);
  const e = Object.values(bot.entities)
    .filter((x) => x.name === name && !isTamed(bot, x) && !meta(bot, x, 'baby') && x.position.distanceTo(bot.entity.position) < 32)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  if (!e) throw new Error(`附近 32 格没有没驯服的 ${name}`);
  let tries = 0;
  if (TAME_FOOD[name]) {
    while (!isTamed(bot, e) && e.isValid && tries < 24) {
      if (signal?.aborted) throw abortError(signal);
      const food = bot.inventory.items().find((i) => TAME_FOOD[name].test(i.name));
      if (!food) throw new Error(`喂 ${name} 的东西用完了（${TAME_FOOD[name].source.replace(/[\^$()]/g, '').split('|').join('、')}），还没驯服`);
      if (e.position.distanceTo(bot.entity.position) > 2.5) {
        bot.pathfinder.setMovements(makeMovements(bot));
        await gotoGoal(agent, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 1.5), { signal, timeoutMs: 20_000 }).catch(() => {});
      }
      await holdInHand(bot, food);
      await bot.lookAt(e.position.offset(0, (e.height ?? 0.8) / 2, 0), true);
      bot.activateEntity(e);
      tries += 1;
      await sleep(700, signal);
    }
  } else {
    while (!isTamed(bot, e) && e.isValid && tries < 15) {
      if (signal?.aborted) throw abortError(signal);
      await mountEntity(agent, e, signal);
      tries += 1;
      const t0 = Date.now();
      while (bot.vehicle && !isTamed(bot, e) && Date.now() - t0 < 6000) await sleep(200, signal);
      if (bot.vehicle) bot.dismount();
      await sleep(600, signal);
    }
  }
  if (!isTamed(bot, e)) throw new Error(`试了 ${tries} 次还没驯服 ${name}`);
  let note = '';
  if (giveTo && agent.identity.opLevel >= 2 && findPlayer(bot, giveTo) && e.uuid) {
    agent.adminCommand(`data modify entity ${e.uuid} Owner set from entity ${findPlayer(bot, giveTo).username} UUID`);
    note = `，主人改成了 ${giveTo}`;
  }
  return `驯服了一只 ${name}（试了 ${tries} 次${note}）`;
}

// ── 鞘翅长途飞行（需要穿着或带着鞘翅，外加烟花火箭）──
export async function elytraTravel(agent, target, signal) {
  const bot = agent.bot;
  const torso = bot.getEquipmentDestSlot('torso');
  const elytra = bot.inventory.slots[torso]?.name === 'elytra' ? bot.inventory.slots[torso] : bot.inventory.items().find((i) => i.name === 'elytra');
  if (!elytra) throw new Error('没有鞘翅');
  if (countItem(bot, 'firework_rocket') < 3) throw new Error('烟花火箭不够（至少要 3 个）');
  const before = bot.inventory.slots[torso]?.name !== 'elytra' ? bot.inventory.slots[torso]?.name ?? null : null;
  if (bot.inventory.slots[torso]?.name !== 'elytra') await bot.equip(elytra, 'torso');
  const rocket = () => bot.inventory.items().find((i) => i.name === 'firework_rocket');
  const boost = async () => {
    const r = rocket();
    if (!r) return false;
    await holdInHand(bot, r);
    bot.activateItem();
    bot.deactivateItem();
    return true;
  };
  const horiz = () => Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z);
  const yawTo = () => Math.atan2(-(target.x - bot.entity.position.x), -(target.z - bot.entity.position.z));
  try {
    // 起飞：跳起来，在空中展开鞘翅，放烟花往上冲
    bot.setControlState('jump', true);
    await sleep(120, signal);
    bot.setControlState('jump', false);
    await sleep(250, signal);
    await bot.elytraFly();
    await bot.look(yawTo(), 0.6, true);
    await boost();
    const cruise = Math.max(bot.entity.position.y + 25, 100);
    let lastBoost = Date.now();
    const t0 = Date.now();
    while (horiz() > 40 && Date.now() - t0 < 5 * 60_000) {
      if (signal?.aborted) throw abortError(signal);
      if (!bot.entity.elytraFlying) throw new Error('飞行中断了（撞到东西或者落地了）');
      if (bot.health < 10) throw new Error('血量太低，先停下');
      const climbing = bot.entity.position.y < cruise;
      await bot.look(yawTo(), climbing ? 0.5 : 0.05, true);
      const speed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z);
      if ((speed < 1.0 || climbing) && Date.now() - lastBoost > 1500) {
        if (!(await boost())) break;
        lastBoost = Date.now();
      }
      await sleep(100, signal);
    }
    // 下降：朝目标俯冲，快到地面时抬头减速
    const t1 = Date.now();
    while (bot.entity.elytraFlying && !bot.entity.onGround && Date.now() - t1 < 60_000) {
      if (signal?.aborted) throw abortError(signal);
      const g = groundBelow(bot, 128);
      const h = g ? bot.entity.position.y - g.y : 99;
      await bot.look(yawTo(), h < 6 ? 0.2 : -0.35, true);
      await sleep(80, signal);
    }
  } finally {
    bot.clearControlStates();
    if (before) {
      const chest = bot.inventory.items().find((i) => i.name === before);
      if (chest && bot.entity.onGround) await bot.equip(chest, 'torso').catch(() => {});
    }
  }
  return `飞到了目标附近（还差 ${Math.round(horiz())} 格）`;
}

export const isPortalNear = (bot, pos, r = 3) => {
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (b && (b.name === 'nether_portal' || b.name === 'end_portal')) return b.name === 'end_portal' ? 'end' : 'nether';
      }
    }
  }
  return null;
};

