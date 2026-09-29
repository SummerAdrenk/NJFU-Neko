// 猫娘能做的所有动作。每个动作 = 名字 + 说明 + 参数格式（JSON Schema）+ 实现。
// 独立大脑把它们当作 Claude 的工具；Claude Code 模式和命令行通过控制接口调用同一套动作。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goals, makeMovements } from './createBot.js';
import {
  countItem, describeError, findItem, findNearestBlock, findPlayer, fleeFrom, gotoGoal, gotoNear,
  nearestCreeper, nearestThreat, normalizeName, placeNearby, protectedReason, resolveBlockIds, resolveItem, summarizeItems, unknownName, Vec3,
} from './helpers.js';
import { canEngage, creeperPlan, fight } from './combat.js';
import { materialsFor, prepareMaterials } from './supply.js';
import { elytraTravel, pillarUp, ride, tame, usePortal, usePotion } from './movement.js';
import { describeStatus } from './status.js';
import { eatBest } from './survival.js';
import { accompanyLoop } from './companion.js';
import { buildBlocks, inspectArea, parseBlockSpec } from './build.js';
import { describeSchematic, findSchematic, forEachBlock, listSchematics, loadLitematic } from './schematic.js';
import { blockInfo, craftingPlan, describePlan, foodInfo, howToObtain, mobInfo, mustCollectManually } from '../knowledge/mcKnowledge.js';
import { wikiLookup } from '../knowledge/wiki.js';
import { abortable, abortError, clamp, fmtPos, sleep, truncate, withTimeout } from '../util.js';

const GUIDE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge', 'guides');

// ── 参数与格式小工具 ────────────────────────────────────────

const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const numType = (description) => ({ type: 'number', description });
const choice = (values, description) => ({ type: 'string', enum: values, description });

function num(value, name) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n)) throw new Error(`参数 ${name} 必须是数字`);
  return n;
}
const intIn = (value, lo, hi, fallback) => clamp(Math.floor(Number.isFinite(Number(value)) ? Number(value) : fallback), lo, hi);
const vecOf = (input) => new Vec3(num(input.x, 'x'), num(input.y, 'y'), num(input.z, 'z')).floored();
const distTo = (bot, pos) => bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));

function taskOpts(ctx, maxWait) {
  const waitMs = ctx.waitMs ?? 60_000;
  return { waitMs: maxWait ? Math.min(waitMs, maxWait) : waitMs, by: ctx.by ?? null };
}

function requirePlayerEntity(bot, name) {
  const player = findPlayer(bot, name);
  if (!player) throw new Error(`${name} 不在线`);
  if (!player.entity) throw new Error(`${player.username} 离得太远，看不到在哪（可以问坐标，或用 /tp 传送过去）`);
  return player;
}

// ── 观察 ────────────────────────────────────────────────────

const INTERESTING = /(_ore$|^ancient_debris$|_log$|^crafting_table$|^furnace$|^blast_furnace$|^smoker$|^chest$|^barrel$|^ender_chest$|_bed$|^spawner$|^nether_portal$|^end_portal_frame$|^enchanting_table$|^anvil$|^sugar_cane$|^pumpkin$|^melon$|^wheat$|^carrots$|^potatoes$|^bee_nest$|^obsidian$|^budding_amethyst$)/;

function scanOverview(agent) {
  const bot = agent.bot;
  const me = bot.entity.position;
  const groups = new Map();
  const collect = (ids, count) => {
    for (const p of bot.findBlocks({ matching: ids, maxDistance: 32, count })) {
      const block = bot.blockAt(p);
      if (!block) continue;
      const g = groups.get(block.name) ?? { count: 0, nearest: p, d: Infinity };
      g.count += 1;
      const d = p.distanceTo(me);
      if (d < g.d) Object.assign(g, { d, nearest: p });
      groups.set(block.name, g);
    }
  };
  collect(bot.registry.blocksArray.filter((b) => INTERESTING.test(b.name)).map((b) => b.id), 1500);
  collect(['water', 'lava'].map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id != null), 30);
  const found = [...groups.entries()].sort((a, b) => a[1].d - b[1].d)
    .map(([name, g]) => `${name}×${g.count}${g.count >= 30 && /water|lava/.test(name) ? '+' : ''}（最近 ${fmtPos(g.nearest)}，${Math.round(g.d)}格）`);
  const under = bot.blockAt(me.offset(0, -1, 0));
  const cursor = bot.blockAtCursor(6);
  return [
    `脚下：${under?.name ?? '未知'}`,
    `准星对着：${cursor ? `${cursor.name} ${fmtPos(cursor.position)}` : '无'}`,
    `附近 32 格：${found.length ? found.join('；') : '没有特别的方块'}`,
  ].join('\n');
}

function scanFor(agent, name) {
  const bot = agent.bot;
  const ids = resolveBlockIds(bot, name);
  if (!ids.length) throw unknownName(bot, name, 'blocks');
  const me = bot.entity.position;
  const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: 10 });
  if (!positions.length) return `64 格内没有找到 ${name}`;
  return positions.map((p) => `${bot.blockAt(p)?.name ?? name} ${fmtPos(p)}，${Math.round(p.distanceTo(me))}格`).join('\n');
}

// ── 移动 ────────────────────────────────────────────────────

// 传送到玩家身边（需要管理员权限）。
async function teleportTo(agent, username) {
  const bot = agent.bot;
  const replies = await agent.chat.capture(async () => agent.adminCommand(`tp ${bot.username} ${username}`), 900);
  agent.events.push('bot', { what: 'teleport', detail: `传送到 ${username} 身边` });
  // 静默执行时没有回显，就看自己是不是已经在对方身边
  const near = findPlayer(bot, username)?.entity?.position?.distanceTo(bot.entity.position) < 4;
  return near || replies.some((r) => /Teleported|传送/.test(r));
}

function comeToPlayer(agent, name, ctx) {
  const bot = agent.bot;
  const player = findPlayer(bot, name);
  if (!player) throw new Error(`${name} 不在线`);
  const username = player.username;
  const tpDist = Number(agent.cfg.behavior.teleport_distance ?? 0);
  const canTp = tpDist > 0 && agent.identity.opLevel >= 2;
  if (!player.entity && !canTp) throw new Error(`${username} 离得太远，看不到在哪（我没有管理员权限，没法传送）`);
  return agent.tasks.run('come', `去 ${username} 身边`, async (task) => {
    const e0 = findPlayer(bot, username)?.entity;
    if (canTp && (!e0 || e0.position.distanceTo(bot.entity.position) > tpDist)) {
      if (await teleportTo(agent, username)) return `传送到了 ${username} 身边`;
    }
    for (let i = 0; i < 4; i++) {
      const e = findPlayer(bot, username)?.entity;
      if (!e) throw new Error(`看不到 ${username} 了`);
      if (bot.entity.position.distanceTo(e.position) <= 3) break;
      await gotoGoal(agent, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), { signal: task.signal });
    }
    const e = findPlayer(bot, username)?.entity;
    if (e) await bot.lookAt(e.position.offset(0, e.height ?? 1.6, 0)).catch(() => {});
    return `已到 ${username} 身边`;
  }, taskOpts(ctx));
}

// 跟随：在玩家身边 2～4 格绕着走，顺手打靠近的怪、躲苦力怕，离太远就传送。
function followPlayer(agent, name, ctx) {
  const player = findPlayer(agent.bot, name);
  if (!player) throw new Error(`${name} 不在线`);
  return agent.tasks.run('follow', `跟随 ${player.username}`, (task) => accompanyLoop(agent, player.username, task, {
    minDist: 2, maxDist: 4, hover: true, loose: false,
  }), taskOpts(ctx, 1500));
}

// ── 采集 / 合成 / 熔炼 ─────────────────────────────────────

function collectBlocks(agent, { block, count }, ctx) {
  const bot = agent.bot;
  const ids = resolveBlockIds(bot, block);
  if (!ids.length) throw unknownName(bot, block, 'blocks');
  const want = intIn(count, 1, 256, 1);
  const needsTool = ids.map((id) => bot.registry.blocks[id]).find((def) => def?.harvestTools);
  if (needsTool && bot.game.gameMode !== 'creative' && !bot.inventory.items().some((i) => needsTool.harvestTools[i.type])) {
    const tools = Object.keys(needsTool.harvestTools).map((id) => bot.registry.items[id]?.name).filter(Boolean);
    throw new Error(`挖 ${needsTool.name} 需要合适的工具（${tools.slice(0, 4).join('、')} 之一），背包里没有`);
  }
  if (ids.every((id) => mustCollectManually(bot.registry.blocks[id]?.name ?? ''))) return collectManually(agent, ids, block, want, ctx);
  return agent.tasks.run('collect', `采集 ${block}×${want}`, (task) => collectCore(agent, ids, block, want, task.signal), taskOpts(ctx));
}

// 采集的核心步骤（备料时直接调用，不另起任务）。
export async function collectCore(agent, ids, block, want, signal) {
  const bot = agent.bot;
  const task = { signal };
  {
    let dug = 0;
    const onDig = (b) => {
      if (b && ids.includes(b.type)) dug += 1;
    };
    bot.on('diggingCompleted', onDig);
    const skipped = new Set();
    let problem = null;
    try {
      bot.pathfinder.setMovements(makeMovements(bot, { dig: true }));
      while (dug < want) {
        if (task.signal.aborted) throw abortError(task.signal);
        if (bot.inventory.emptySlotCount() === 0) {
          problem = '背包满了';
          break;
        }
        const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: 64 }).filter((p) => !skipped.has(p.toString()));
        if (!positions.length) break;
        const batch = positions.slice(0, Math.min(want - dug, 3)).map((p) => bot.blockAt(p)).filter(Boolean);
        try {
          await abortable(bot.collectBlock.collect(batch, { ignoreNoPath: true }), task.signal);
        } catch (err) {
          if (task.signal.aborted) throw abortError(task.signal);
          problem = describeError(err);
          for (const b of batch) skipped.add(b.position.toString());
          if (skipped.size >= 30) break;
        }
      }
    } finally {
      bot.off('diggingCompleted', onDig);
    }
    if (!dug) throw new Error(problem ? `一个也没采到：${problem}` : `附近 64 格内没有能挖到的 ${block}`);
    const note = dug < want ? `（目标 ${want} 个；${problem ?? '附近没有更多了'}）` : '';
    return `采集了 ${dug} 个 ${block}${note}。背包：${summarizeItems(bot.inventory.items(), 12)}`;
  }
}

// 农作物、花、火把这类方块：逐个走过去挖，农作物只收成熟的。
const MATURE_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3, cocoa: 2, sweet_berry_bush: 3 };

function collectManually(agent, ids, label, want, ctx) {
  return agent.tasks.run('collect', `采集 ${label}×${want}`, (task) => collectManuallyCore(agent, ids, label, want, task.signal), taskOpts(ctx));
}

export async function collectManuallyCore(agent, ids, label, want, signal) {
  const bot = agent.bot;
  const task = { signal };
  {
    let got = 0;
    const skipped = new Set();
    bot.pathfinder.setMovements(makeMovements(bot));
    while (got < want) {
      if (task.signal.aborted) throw abortError(task.signal);
      const pos = bot.findBlocks({
        matching: ids,
        useExtraInfo: (b) => MATURE_AGE[b.name] == null || Number(b.getProperties().age) >= MATURE_AGE[b.name],
        maxDistance: 48,
        count: 40,
      }).find((p) => !skipped.has(p.toString()));
      if (!pos) break;
      skipped.add(pos.toString());
      try {
        if (distTo(bot, pos) > 4.2) await gotoGoal(agent, new goals.GoalLookAtBlock(pos, bot.world), { signal: task.signal, timeoutMs: 60_000 });
        const target = bot.blockAt(pos);
        if (!target || !ids.includes(target.type)) continue;
        await abortable(bot.dig(target, true), task.signal);
        got += 1;
        await sleep(300, task.signal);
        const drops = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(pos) < 3);
        if (drops.length) await abortable(bot.collectBlock.collect(drops, { ignoreNoPath: true }), task.signal).catch(() => {});
      } catch (err) {
        if (task.signal.aborted) throw abortError(task.signal);
      }
    }
    if (!got) throw new Error(`附近 48 格内没有${MATURE_AGE[bot.registry.blocks[ids[0]]?.name] ? '成熟的' : ''} ${label}`);
    return `收了 ${got} 个 ${label}。背包：${summarizeItems(bot.inventory.items(), 12)}`;
  }
}

function maxCraftTimes(bot, recipe) {
  let max = Infinity;
  for (const d of recipe.delta) {
    if (d.count < 0) max = Math.min(max, Math.floor(bot.inventory.count(d.id, d.metadata) / -d.count));
  }
  return Number.isFinite(max) ? max : 1;
}

function missingText(bot, item, tableAvailable) {
  const all = bot.recipesAll(item.id, null, true);
  if (!all.length) return `${item.name} 没有合成配方（需要熔炼、交易或直接采集）`;
  let best = null;
  for (const recipe of all) {
    const missing = [];
    for (const d of recipe.delta) {
      if (d.count >= 0) continue;
      const have = bot.inventory.count(d.id, d.metadata);
      if (have + d.count < 0) missing.push(`${bot.registry.items[d.id]?.name ?? d.id}×${-d.count - have}`);
    }
    if (!best || missing.length < best.missing.length) best = { recipe, missing };
  }
  const needTable = best.recipe.requiresTable && !tableAvailable;
  if (!best.missing.length && needTable) return `合成 ${item.name} 需要工作台：附近 32 格没有，背包里也没有（4 个木板可以合成 crafting_table）`;
  return `材料不够合成 ${item.name}，还缺：${best.missing.join('、')}${needTable ? '；另外还需要工作台' : ''}`;
}

function craftItem(agent, { item, count }, ctx) {
  const bot = agent.bot;
  const it = resolveItem(bot, item);
  if (!it) throw unknownName(bot, item, 'items');
  const want = intIn(count, 1, 1000, 1);
  return agent.tasks.run('craft', `合成 ${it.name}×${want}`, (task) => craftCore(agent, it, want, task.signal), taskOpts(ctx));
}

// 合成的核心步骤：需要工作台时，附近没有就把背包里的放下（备料时直接调用）。
export async function craftCore(agent, it, want, signal) {
  const bot = agent.bot;
  const task = { signal };
  {
    let table = findNearestBlock(bot, ['crafting_table'], 32);
    const tableAvailable = Boolean(table || findItem(bot, 'crafting_table'));
    const recipes = bot.recipesFor(it.id, null, 1, tableAvailable ? true : null);
    if (!recipes.length) throw new Error(missingText(bot, it, tableAvailable));
    const recipe = recipes.find((r) => !r.requiresTable) ?? recipes[0];
    if (recipe.requiresTable && !table) table = await placeNearby(agent, 'crafting_table', task.signal);
    const per = recipe.result?.count ?? 1;
    const times = Math.min(Math.ceil(want / per), maxCraftTimes(bot, recipe));
    if (times < 1) throw new Error(missingText(bot, it, true));
    if (recipe.requiresTable && distTo(bot, table.position) > 4) await gotoNear(agent, table.position, 2, { signal: task.signal });
    await abortable(bot.craft(recipe, times, recipe.requiresTable ? table : null), task.signal);
    const made = times * per;
    return `合成了 ${made} 个 ${it.name}${made < want ? `（想要 ${want} 个，材料只够这些）` : ''}，背包里现在有 ${countItem(bot, it.name)} 个`;
  }
}

const FUELS = [['coal', 8], ['charcoal', 8], ['coal_block', 80], ['blaze_rod', 12], [/_planks$/, 1.5], [/_log$/, 1.5], [/_wood$/, 1.5], ['stick', 0.5], ['bamboo', 0.25]];

function pickFuel(bot, items, exclude) {
  for (const [pattern, per] of FUELS) {
    const item = bot.inventory.items().find((i) => i.name !== exclude && (typeof pattern === 'string' ? i.name === pattern : pattern.test(i.name)));
    if (item) return { item, count: Math.min(countItem(bot, item.name), Math.ceil(items / per)) };
  }
  return null;
}

function smeltItem(agent, { item, count }, ctx) {
  const bot = agent.bot;
  const input = findItem(bot, item);
  if (!input) throw new Error(`背包里没有 ${normalizeName(item)}`);
  const n = Math.min(intIn(count, 1, 1000, 1), countItem(bot, input.name));
  return agent.tasks.run('smelt', `熔炼 ${input.name}×${n}`, (task) => smeltCore(agent, input, n, task.signal), taskOpts(ctx));
}

// 熔炼的核心步骤（备料时直接调用）。
export async function smeltCore(agent, input, n, signal) {
  const bot = agent.bot;
  const task = { signal };
  const isFood = Boolean(bot.registry.foodsByName?.[input.name]) || /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon|potato|kelp)$/.test(input.name);
  const isOre = /^raw_|_ore$|ancient_debris/.test(input.name);
  {
    const kinds = ['furnace', ...(isFood ? ['smoker'] : []), ...(isOre ? ['blast_furnace'] : [])];
    let block = findNearestBlock(bot, kinds, 32);
    if (!block) {
      if (!findItem(bot, 'furnace')) throw new Error('附近 32 格没有熔炉，背包里也没有（8 个圆石可以合成 furnace）');
      block = await placeNearby(agent, 'furnace', task.signal);
    }
    if (distTo(bot, block.position) > 4) await gotoNear(agent, block.position, 2, { signal: task.signal });
    const furnace = await withTimeout(bot.openFurnace(bot.blockAt(block.position)), 10_000, '熔炉打不开');
    let got = 0;
    let outName = null;
    const takeOut = async () => {
      const out = furnace.outputItem();
      if (!out) return;
      await furnace.takeOutput();
      got += out.count;
      outName = out.name;
    };
    try {
      await takeOut();
      const current = furnace.inputItem();
      if (current && current.type !== input.type) throw new Error(`这个熔炉正在烧 ${current.name}，请等它烧完或换一个熔炉`);
      await furnace.putInput(input.type, null, n);
      if (!furnace.fuelItem()) {
        const fuel = pickFuel(bot, n, input.name);
        if (!fuel) throw new Error('背包里没有燃料（煤、木炭、木板、原木都可以）');
        await furnace.putFuel(fuel.item.type, null, fuel.count);
      }
      const deadline = Date.now() + n * 10_500 + 20_000;
      let lastProgress = Date.now();
      while (Date.now() < deadline) {
        await sleep(2000, task.signal);
        const before = got;
        await takeOut();
        if (got > before || furnace.progress > 0) lastProgress = Date.now();
        if (!furnace.inputItem()) {
          await sleep(500, task.signal);
          await takeOut();
          break;
        }
        if (Date.now() - lastProgress > 25_000) {
          throw new Error(`熔炉停了：可能燃料不够，或者 ${input.name} 不能在这里烧（已烧好 ${got} 个，剩下的还在熔炉里）`);
        }
      }
    } finally {
      furnace.close();
    }
    return got ? `烧好并取出了 ${got} 个 ${outName}` : '没有烧出东西';
  }
}

// ── 物品 ────────────────────────────────────────────────────

function giveItems(agent, { item, count, player }, ctx) {
  const bot = agent.bot;
  const it = findItem(bot, item);
  if (!it) throw new Error(`背包里没有 ${normalizeName(item)}`);
  const n = Math.min(intIn(count, 1, 2304, 1), countItem(bot, it.name));
  if (!player) {
    return bot.toss(it.type, null, n).then(() => `把 ${n} 个 ${it.name} 丢在了脚下`);
  }
  const { username } = requirePlayerEntity(bot, player);
  return agent.tasks.run('give', `把 ${it.name}×${n} 交给 ${username}`, async (task) => {
    let target = findPlayer(bot, username)?.entity;
    if (target && bot.entity.position.distanceTo(target.position) > 3) {
      await gotoGoal(agent, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), { signal: task.signal });
    }
    target = findPlayer(bot, username)?.entity;
    if (!target) throw new Error(`看不到 ${username} 了`);
    await bot.lookAt(target.position.offset(0, 1.2, 0), true);
    await bot.toss(it.type, null, n);
    return `把 ${n} 个 ${it.name} 扔给了 ${username}`;
  }, taskOpts(ctx));
}

const SLOT_NAMES = { hand: '主手', 'off-hand': '副手', head: '头部', torso: '胸部', legs: '腿部', feet: '脚部' };
function autoSlot(name) {
  if (/_helmet$|^carved_pumpkin$|_head$|_skull$/.test(name)) return 'head';
  if (/_chestplate$|^elytra$/.test(name)) return 'torso';
  if (/_leggings$/.test(name)) return 'legs';
  if (/_boots$/.test(name)) return 'feet';
  if (name === 'shield' || name === 'totem_of_undying') return 'off-hand';
  return 'hand';
}

// ── 战斗 ────────────────────────────────────────────────────

function attackTarget(agent, { target, count }, ctx) {
  const bot = agent.bot;
  const want = intIn(count, 1, 20, 1);
  const player = findPlayer(bot, target);
  if (player) {
    if (player.username === bot.username) throw new Error('不能攻击自己');
    if (ctx.by?.source === 'brain' && ctx.by.owner === false) throw new Error('只有主人能让我攻击玩家');
  }
  const mobName = normalizeName(target);
  // Boss（末影龙、凋灵）只在主人明确要求时打，打法见 combat.js；搜索范围更大、时间更长
  const boss = ['ender_dragon', 'wither'].includes(mobName);
  if (boss && ctx.by?.owner === false) throw new Error('打 Boss 要主人同意才行');
  let protectedCount = 0;
  const pick = () => {
    if (player) return findPlayer(bot, player.username)?.entity ?? null;
    let best = null;
    let bestDist = boss || mobName === 'end_crystal' ? 160 : 32;
    protectedCount = 0;
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || e.name !== mobName) continue;
      // 命名过的、在载具里的、在禁战区里的（多半是机器里的）不打
      if (protectedReason(agent, e)) {
        protectedCount += 1;
        continue;
      }
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bestDist) {
        best = e;
        bestDist = d;
      }
    }
    return best;
  };
  if (!pick()) {
    if (protectedCount) throw new Error(`附近的 ${mobName} 都是命名过的、坐在载具里或在禁战区里（可能是机器里的），我不打它们`);
    throw new Error(player ? `${player.username} 不在视野内` : `附近 32 格内没有 ${mobName}${bot.registry.entitiesByName?.[mobName] ? '' : '（生物 ID 可能写错了）'}`);
  }
  const label = player?.username ?? mobName;
  return agent.tasks.run('attack', `攻击 ${label}×${want}`, async (task) => {
    let kills = 0;
    while (kills < want) {
      const e = pick();
      if (!e) break;
      if (!(await fight(agent, e, task.signal, boss ? 20 * 60_000 : 60_000, { boss }))) break;
      kills += 1;
    }
    if (!kills) throw new Error('没打倒（目标跑掉了或够不着）');
    return `打倒了 ${kills} 个 ${label}${kills < want ? '（附近没有更多了）' : ''}`;
  }, taskOpts(ctx));
}

function guard(agent, { player }, ctx) {
  const bot = agent.bot;
  const username = player ? requirePlayerEntity(bot, player).username : null;
  const home = bot.entity.position.clone();
  return agent.tasks.run('guard', username ? `保护 ${username}` : `守卫 ${fmtPos(home)}`, async (task) => {
    let following = null;
    for (;;) {
      if (task.signal.aborted) throw abortError(task.signal);
      const center = username ? findPlayer(bot, username)?.entity?.position : home;
      // 苦力怕：有把握（有弓、或拿着武器且血量健康）就打，否则躲开
      const plan = creeperPlan(agent);
      const creeper = nearestCreeper(bot, plan === 'bow' ? 12 : 4);
      if (creeper && (plan === 'flee' || !canEngage(agent, creeper))) {
        await fleeFrom(agent, creeper, task.signal);
        following = null;
        continue;
      }
      if (center) {
        const assist = agent.assistTarget;
        agent.assistTarget = null;
        const mob = creeper ?? (assist?.isValid && canEngage(agent, assist) ? assist : null) ?? nearestThreat(agent, center, 16, canEngage);
        if (mob) {
          try {
            await fight(agent, mob, task.signal, 30_000);
          } catch (err) {
            if (task.signal.aborted) throw err;
          }
          following = null;
          await sleep(200, task.signal);
          continue;
        }
        const e = username ? findPlayer(bot, username)?.entity : null;
        if (e && following !== e) {
          bot.pathfinder.setMovements(makeMovements(bot));
          bot.pathfinder.setGoal(new goals.GoalFollow(e, 3), true);
          following = e;
        } else if (!username && bot.entity.position.distanceTo(home) > 3) {
          await gotoNear(agent, home, 1, { signal: task.signal }).catch((err) => {
            if (task.signal.aborted) throw err;
          });
        }
      }
      await sleep(500, task.signal);
    }
  }, taskOpts(ctx, 1500));
}

// ── 方块 ────────────────────────────────────────────────────

function digAt(agent, input, ctx) {
  const bot = agent.bot;
  const pos = vecOf(input);
  const block = bot.blockAt(pos);
  if (!block) throw new Error(`${fmtPos(pos)} 太远了，那里还没加载`);
  if (block.name.endsWith('air')) throw new Error(`${fmtPos(pos)} 是空的`);
  if (block.hardness == null || block.hardness < 0) throw new Error(`${block.name} 挖不动`);
  return agent.tasks.run('dig', `挖 ${block.name} ${fmtPos(pos)}`, async (task) => {
    if (distTo(bot, pos) > 4.2) await gotoGoal(agent, new goals.GoalLookAtBlock(pos, bot.world), { signal: task.signal });
    const target = bot.blockAt(pos);
    if (!target || target.name.endsWith('air')) return `${fmtPos(pos)} 已经空了`;
    await bot.tool.equipForBlock(target, {}).catch(() => {});
    const noDrop = bot.game.gameMode !== 'creative' && !target.canHarvest(bot.heldItem?.type);
    await abortable(bot.dig(target, true), task.signal);
    await sleep(400, task.signal);
    const drops = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(pos) < 4);
    if (drops.length) await abortable(bot.collectBlock.collect(drops, { ignoreNoPath: true }), task.signal).catch(() => {});
    return `挖掉了 ${target.name}${noDrop ? '（没有合适的工具，可能没有掉落物）' : ''}`;
  }, taskOpts(ctx));
}

function bedError(err) {
  const m = String(err?.message ?? err);
  if (/night|thunder/i.test(m)) return '现在不是晚上也不是雷雨天，睡不了';
  if (/monster/i.test(m)) return '附近有怪物，不能睡';
  if (/far/i.test(m)) return '离床太远了';
  if (/occupied/i.test(m)) return '床上已经有人了';
  return `睡不了：${m}`;
}

function useBlock(agent, input, ctx) {
  const bot = agent.bot;
  const pos = vecOf(input);
  const block = bot.blockAt(pos);
  if (!block || block.name.endsWith('air')) throw new Error(`${fmtPos(pos)} 什么都没有`);
  return agent.tasks.run('use', `使用 ${block.name} ${fmtPos(pos)}`, async (task) => {
    // 睡觉要离床 3 格以内（mineflayer 的限制），其他方块 4 格以内能够到就行
    const reach = bot.isABed(block) ? 2.2 : 4;
    if (distTo(bot, pos) > reach) await gotoNear(agent, pos, bot.isABed(block) ? 1 : 2, { signal: task.signal });
    const target = bot.blockAt(pos);
    if (bot.isABed(target)) {
      const rememberBed = () => {
        agent.homeBed = pos.clone();
        agent.memory.set('bed', `我的床（重生点）在 ${fmtPos(pos)}`);
      };
      try {
        await bot.sleep(target);
      } catch (err) {
        const reason = bedError(err);
        // 白天睡不了，但右键床仍然会把重生点设在这里（1.15 以后的规则）。
        if (/不是晚上/.test(reason)) {
          const replies = await agent.chat.capture(async () => bot.activateBlock(target), 1000);
          const set = replies.some((r) => /respawn|重生/i.test(r));
          rememberBed();
          return `${reason}，${set ? '不过已经把重生点设在这张床上了' : '已经右键过这张床（重生点应该设好了）'}`;
        }
        throw new Error(reason);
      }
      rememberBed();
      return '躺到床上睡觉了（重生点也设在这里了），天亮会自动起床';
    }
    await bot.activateBlock(target);
    await sleep(300, task.signal);
    if (bot.currentWindow) {
      bot.closeWindow(bot.currentWindow);
      return `${target.name} 是容器，已经关上了（存取东西请用 chest）`;
    }
    return `已使用 ${target.name}`;
  }, taskOpts(ctx, 45_000));
}

const KEEP_ON_DEPOSIT = /(_sword|_pickaxe|_axe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|^shield$|^bow$|^crossbow$|^trident$|^mace$|^elytra$|^totem_of_undying$|^fishing_rod$|^flint_and_steel$|^shears$)/;
const CHEST_ACTIONS = { list: '查看', deposit: '存入', withdraw: '取出' };

const CONTAINER = /chest|barrel|shulker_box|hopper|dispenser|dropper/;

// 走到容器旁打开它，执行 fn(win, block)，结束后记住容器内容并关闭。不开新任务，可以在别的任务里连续使用。
export async function withChest(agent, pos, signal, fn) {
  const bot = agent.bot;
  const block = bot.blockAt(pos);
  if (!block || !CONTAINER.test(block.name)) throw new Error(`${fmtPos(pos)} 不是箱子（是 ${block?.name ?? '未加载的区块'}）`);
  if (distTo(bot, pos) > 4) await gotoNear(agent, pos, 2, { signal });
  const win = await withTimeout(bot.openContainer(bot.blockAt(pos)), 10_000, '箱子打不开（可能被挡住了）');
  const dim = String(bot.game?.dimension ?? '').replace(/^minecraft:/, '');
  try {
    return await fn(win, block);
  } finally {
    try {
      agent.chestIndex.record(pos, block.name, win.containerItems(), dim);
    } catch {
      // 窗口已失效
    }
    win.close();
  }
}

function chestOp(agent, { action, x, y, z, item, count }, ctx) {
  const bot = agent.bot;
  const pos = vecOf({ x, y, z });
  const block = bot.blockAt(pos);
  if (!block || !CONTAINER.test(block.name)) throw new Error(`${fmtPos(pos)} 不是箱子（是 ${block?.name ?? '未加载的区块'}）`);
  if (!CHEST_ACTIONS[action]) throw new Error('action 只能是 list、deposit 或 withdraw');
  return agent.tasks.run('chest', `${CHEST_ACTIONS[action]} ${block.name} ${fmtPos(pos)}`, (task) => withChest(agent, pos, task.signal,
    (win, b) => chestWork(agent, win, b, { action, item, count })), taskOpts(ctx));
}

async function chestWork(agent, win, block, { action, item, count }) {
  const bot = agent.bot;
  if (action === 'list') return `${block.name} 里有：${summarizeItems(win.containerItems())}`;
  if (action === 'deposit') {
    if (!item || item === '*') {
      let n = 0;
      for (const i of bot.inventory.items()) {
        if (KEEP_ON_DEPOSIT.test(i.name) || bot.registry.foodsByName?.[i.name]) continue;
        await win.deposit(i.type, null, i.count);
        n += i.count;
      }
      return n ? `存进去 ${n} 个物品（工具、武器、盔甲和食物留在身上）` : '没有需要存的东西';
    }
    const it = resolveItem(bot, item);
    if (!it) throw unknownName(bot, item, 'items');
    const have = countItem(bot, it.name);
    if (!have) throw new Error(`身上没有 ${it.name}`);
    const n = count ? Math.min(intIn(count, 1, 99_999, have), have) : have;
    await win.deposit(it.id, null, n);
    return `存入了 ${n} 个 ${it.name}`;
  }
  if (!item) throw new Error('要取什么？请填 item');
  const it = resolveItem(bot, item);
  if (!it) throw unknownName(bot, item, 'items');
  const inside = win.containerItems().filter((i) => i.type === it.id).reduce((sum, i) => sum + i.count, 0);
  if (!inside) throw new Error(`箱子里没有 ${it.name}`);
  const n = count ? Math.min(intIn(count, 1, 99_999, inside), inside) : inside;
  await win.withdraw(it.id, null, n);
  return `取出了 ${n} 个 ${it.name}`;
}

// ── 命令 ────────────────────────────────────────────────────

// 命令本身以及 execute … run 后面的子命令（都去掉 / 和 minecraft: 前缀）。
export function commandHeads(cmd) {
  const tokens = cmd.trim().split(/\s+/);
  const heads = [tokens[0]];
  tokens.forEach((t, i) => {
    if (t.toLowerCase() === 'run' && tokens[i + 1]) heads.push(tokens[i + 1]);
  });
  return heads.map((h) => h.toLowerCase().replace(/^\//, '').replace(/^minecraft:/, ''));
}

export function deniedCommand(cmd, deny) {
  return commandHeads(cmd).find((h) => deny.includes(h)) ?? null;
}

// 命令分级：deny 永远不执行；anyone 任何人请求都能用；其余只替主人执行（confirm 里的要先和主人确认，由大脑遵守）。
export function commandPermission(agent, cmd, ctx) {
  const cfg = agent.cfg.commands;
  if (!cfg.allow) return '配置里关闭了执行命令';
  const denied = deniedCommand(cmd, cfg.deny);
  if (denied) return `「${denied}」命令被禁止执行`;
  const fromNonOwner = ctx.by?.source === 'brain' && ctx.by.owner === false;
  if (fromNonOwner && !commandHeads(cmd).every((h) => (cfg.anyone ?? []).includes(h))) return '这个命令我只替主人执行';
  return null;
}

async function runCommand(agent, command, ctx) {
  const cmd = String(command ?? '').trim().replace(/^\/+/, '');
  if (!cmd) throw new Error('命令是空的');
  if (/[\r\n]/.test(cmd)) throw new Error('命令里不能有换行');
  const refused = commandPermission(agent, cmd, ctx);
  if (refused) throw new Error(refused);
  const replies = await agent.chat.capture(async () => agent.bot.chat(`/${cmd}`), 1500);
  const note = agent.identity.opLevel < 2 ? '（注意：我现在没有管理员权限）' : '';
  return replies.length
    ? `服务器回复：${replies.map((r) => truncate(r, 200)).join(' | ')}${note}`
    : `命令已发送，服务器没有回复${note}`;
}

// ── 交给玩家 ─────────────────────────────────────────────

async function handToPlayer(agent, username, itemType, count, signal) {
  const bot = agent.bot;
  let target = findPlayer(bot, username)?.entity;
  if (target && bot.entity.position.distanceTo(target.position) > 3) {
    await gotoGoal(agent, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), { signal });
  }
  target = findPlayer(bot, username)?.entity;
  if (!target) throw new Error(`看不到 ${username} 了`);
  await bot.lookAt(target.position.offset(0, 1.2, 0), true);
  await bot.toss(itemType, null, count);
}

// ── 红石 / 建造 / 原理图 ─────────────────────────────────

// 默认亲手用材料建（先备料）；只有主人明确要求时才用 /setblock 命令建。
function chooseBuildMode(agent, requested, ctx) {
  if (requested !== 'command') return 'survival';
  if (agent.identity.opLevel < 2 || commandPermission(agent, 'setblock', ctx)) throw new Error('用命令建造需要管理员权限，并且只替主人执行');
  return 'command';
}

// 亲手建之前备料：背包够就直接建；不够但箱子里够就问主人；都不够或者主人不让拿，就自己采集合成。
async function buildWithMaterials(agent, list, how, task, ctx, onProgress) {
  let prep = '';
  if (how === 'survival') prep = await prepareMaterials(agent, materialsFor(agent.bot, list), task.signal, ctx);
  const result = await buildBlocks(agent, list, { mode: how, signal: task.signal, onProgress });
  return prep && prep !== '材料都在背包里' ? `${prep}；${result}` : result;
}

function buildAction(agent, { blocks, mode }, ctx) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('blocks 不能为空');
  if (blocks.length > 512) throw new Error('一次最多 512 个方块，请分批建造');
  const list = blocks.map((b, i) => {
    try {
      return { pos: new Vec3(num(b.x, 'x'), num(b.y, 'y'), num(b.z, 'z')).floored(), spec: parseBlockSpec(b.block) };
    } catch (err) {
      throw new Error(`第 ${i + 1} 个方块：${err.message}`);
    }
  });
  const how = chooseBuildMode(agent, mode, ctx);
  return agent.tasks.run('build', `建造 ${list.length} 个方块（${how === 'command' ? '命令精确放置' : '亲手放置'}）`,
    (task) => buildWithMaterials(agent, list, how, task, ctx), taskOpts(ctx));
}

async function schematicAction(agent, { action, name, x, y, z, mode }, ctx) {
  const dir = agent.cfg.mods.litematica_schematics;
  if (!dir) throw new Error('没有配置投影原理图文件夹（config.toml 的 mods.litematica_schematics）');
  if (action === 'list') {
    const all = listSchematics(dir).filter((s) => !name || s.name.includes(name));
    if (!all.length) return name ? `没有名字包含「${name}」的原理图` : '原理图文件夹是空的';
    return `共 ${all.length} 个：${all.slice(0, 50).map((s) => s.name).join('、')}${all.length > 50 ? ' 等' : ''}`;
  }
  if (!name) throw new Error('请填原理图名字（可以先用 list 看看有哪些）');
  const found = findSchematic(dir, name);
  if (!found) throw new Error(`找不到原理图「${name}」`);
  const schem = await loadLitematic(found.file);
  const info = describeSchematic(schem);
  if (action === 'info') return info.text;
  if (x == null || y == null || z == null) throw new Error('建造需要坐标 x、y、z（原理图的原点放在哪里）');
  const how = chooseBuildMode(agent, mode, ctx);
  const limit = Number(agent.cfg.mods.max_schematic_blocks ?? 20000);
  if (info.total > limit) throw new Error(`原理图有 ${info.total} 个方块，超过上限 ${limit}（可在 config.toml 的 mods.max_schematic_blocks 调整）`);
  const origin = new Vec3(num(x, 'x'), num(y, 'y'), num(z, 'z')).floored();
  const list = [];
  forEachBlock(schem, (p, spec) => list.push({ pos: origin.plus(p), spec }));
  return agent.tasks.run('schematic', `建造原理图「${found.name}」（${list.length} 个方块，${how === 'command' ? '命令' : '亲手'}）`,
    (task) => buildWithMaterials(agent, list, how, task, ctx,
      (done, total) => agent.events.push('bot', { what: 'progress', detail: `原理图「${found.name}」${done}/${total}` })), taskOpts(ctx));
}

// ── 查找结构 / 群系（/locate + Chunkbase 链接）──────────

async function chunkbaseLink(agent, x, z) {
  const bot = agent.bot;
  if (!agent.worldSeed && agent.identity.opLevel >= 2) {
    const replies = await agent.chat.capture(async () => bot.chat('/seed'), 1200);
    const m = replies.join(' ').match(/\[(-?\d+)\]/);
    if (m) agent.worldSeed = m[1];
  }
  if (!agent.worldSeed) return null;
  const ver = String(agent.target?.serverVersion ?? '').match(/(\d+)\.(\d+)/);
  const platform = agent.cfg.mods.chunkbase_platform || (ver ? `java_${ver[1]}_${ver[2]}` : 'java_1_21_5');
  const dim = { overworld: 'overworld', the_nether: 'nether', the_end: 'end' }[String(bot.game?.dimension ?? '').replace(/^minecraft:/, '')] ?? 'overworld';
  return `https://www.chunkbase.com/apps/seed-map#seed=${agent.worldSeed}&platform=${platform}&dimension=${dim}&x=${Math.round(x)}&z=${Math.round(z)}&zoom=0.5`;
}

async function locateAction(agent, { kind, target }, ctx) {
  const bot = agent.bot;
  let id = String(target ?? '').trim().toLowerCase().replace(/^minecraft:/, '');
  if (!id) throw new Error('要找什么？');
  id = id.startsWith('#') ? `#minecraft:${id.slice(1).replace(/^minecraft:/, '')}` : `minecraft:${id}`;
  const cmd = `locate ${kind} ${id}`;
  const refused = commandPermission(agent, cmd, ctx);
  if (refused) throw new Error(refused);
  if (agent.identity.opLevel < 2) throw new Error('查找结构需要管理员权限（/locate）');
  const replies = await agent.chat.capture(async () => bot.chat(`/${cmd}`), 5000);
  const line = replies.find((r) => /\[\s*-?\d+\s*,/.test(r));
  if (!line) return `没找到：${replies.map((r) => truncate(r, 160)).join(' | ') || '服务器没有回复（可能太远了）'}`;
  const m = /\[\s*(-?\d+)\s*,\s*(~|-?\d+)\s*,\s*(-?\d+)\s*\]/.exec(line);
  const [x, y, z] = [Number(m[1]), m[2], Number(m[3])];
  const dist = Math.round(Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z));
  const link = await chunkbaseLink(agent, x, z);
  return `${truncate(line, 200)}\n坐标 (${x}, ${y}, ${z})，水平距离约 ${dist} 格${link ? `\nChunkbase 地图（可以用 say 的 link 参数发给玩家）：${link}` : ''}`;
}

// ── 知识 ─────────────────────────────────────────────────

const GUIDES = { redstone_basics: '红石基础', redstone_circuits: '常用电路', redstone_repair: '红石排障', carpet: '地毯模组', building: '建造技巧' };

async function knowledgeAction(agent, { topic, query, count }) {
  const reg = agent.bot?.registry ?? agent.registry();
  const q = normalizeName(query);
  const unknown = () => new Error(`不认识「${query}」（请用英文 ID，例如 iron_pickaxe）`);
  const need = (value) => {
    if (value == null) throw unknown();
    return value;
  };
  switch (topic) {
    case 'obtain':
      return need(howToObtain(reg, q));
    case 'craft_plan': {
      need(reg.itemsByName[q]);
      const inv = {};
      for (const i of agent.bot?.inventory?.items() ?? []) inv[i.name] = (inv[i.name] ?? 0) + i.count;
      return describePlan(craftingPlan(reg, q, intIn(count, 1, 1000, 1), inv));
    }
    case 'block':
      return need(blockInfo(reg, q));
    case 'food':
      return foodInfo(reg, q) ?? `${q} 不是食物`;
    case 'mob':
      return need(mobInfo(reg, q));
    case 'wiki': {
      const r = await wikiLookup(query, { full: true, maxChars: 2500 });
      return r.title ? `【${r.title}】${r.url}\n${r.text}${r.others.length ? `\n相关词条：${r.others.join('、')}` : ''}` : r.text;
    }
    case 'guide': {
      const key = Object.keys(GUIDES).find((k) => k === q || GUIDES[k] === String(query).trim()) ?? q;
      const file = path.join(GUIDE_DIR, `${key}.md`);
      if (!fs.existsSync(file)) return `没有这本手册。可选：${Object.entries(GUIDES).map(([k, v]) => `${k}（${v}）`).join('、')}`;
      return fs.readFileSync(file, 'utf8');
    }
    default:
      throw new Error('topic 只能是 obtain、craft_plan、block、food、mob、wiki、guide');
  }
}

// ── 运送物资 ─────────────────────────────────────────────

const parsePos = (s) => {
  const m = /(-?\d+)\s*[,，\s]\s*(-?\d+)\s*[,，\s]\s*(-?\d+)/.exec(String(s ?? ''));
  return m ? new Vec3(Number(m[1]), Number(m[2]), Number(m[3])) : null;
};

// 背包还能装下多少个这种物品
function roomFor(bot, item) {
  const stack = item.stackSize ?? 64;
  const partial = bot.inventory.items().filter((i) => i.type === item.id).reduce((s, i) => s + Math.max(0, stack - i.count), 0);
  return bot.inventory.emptySlotCount() * stack + partial;
}

function transportAction(agent, { item, count, from, to }, ctx) {
  const bot = agent.bot;
  const it = resolveItem(bot, item);
  if (!it) throw unknownName(bot, item, 'items');
  const want = intIn(count, 1, 3456, 1);
  const dim = String(bot.game?.dimension ?? '').replace(/^minecraft:/, '');
  let sources;
  if (from) {
    const p = parsePos(from);
    if (!p) throw new Error('from 要写成 "x,y,z"');
    sources = [p];
  } else {
    sources = agent.chestIndex.find(it.name, bot.entity.position, dim).map((c) => new Vec3(c.x, c.y, c.z));
    if (!sources.length) throw new Error(`我不知道哪个箱子里有 ${it.name}（先让我打开看看那些箱子，或者告诉我箱子坐标）`);
  }
  const toPos = parsePos(to);
  const toPlayer = !toPos && to ? findPlayer(bot, String(to))?.username : null;
  if (!toPos && !toPlayer) throw new Error(to ? `${to} 不在线，也不是 "x,y,z" 坐标` : '要送到哪里？to 填 "x,y,z"（箱子）或玩家名');
  const label = toPlayer ?? fmtPos(toPos);
  return agent.tasks.run('transport', `运送 ${it.name}×${want} → ${label}`, async (task) => {
    let delivered = 0;
    let trips = 0;
    while (delivered < want && sources.length && trips < 12) {
      trips += 1;
      const need = Math.min(want - delivered, roomFor(bot, it));
      if (need <= 0) throw new Error('背包满了，装不下更多');
      const got = await withChest(agent, sources[0], task.signal, async (win) => {
        const inside = win.containerItems().filter((i) => i.type === it.id).reduce((s, i) => s + i.count, 0);
        const n = Math.min(inside, need);
        if (n > 0) await win.withdraw(it.id, null, n);
        return n;
      });
      if (got < need) sources.shift();
      if (!got) continue;
      if (toPos) await withChest(agent, toPos, task.signal, (win) => win.deposit(it.id, null, got));
      else await handToPlayer(agent, toPlayer, it.id, got, task.signal);
      delivered += got;
      agent.events.push('bot', { what: 'progress', detail: `运送 ${it.name} ${delivered}/${want}` });
    }
    if (!delivered) throw new Error(`没拿到 ${it.name}（箱子里可能已经没有了）`);
    return `运送完成：${delivered}/${want} 个 ${it.name} → ${label}，跑了 ${trips} 趟${delivered < want ? '（来源箱子里没有更多了）' : ''}`;
  }, taskOpts(ctx));
}

// ── 休闲活动：钓鱼、骑乘 ─────────────────────────────────

function activityAction(agent, { action, target, count }, ctx) {
  const bot = agent.bot;
  if (action === 'dismount') {
    if (!bot.vehicle) return '现在没有在骑乘';
    bot.dismount();
    return '下来了';
  }
  if (action === 'mount') {
    const name = normalizeName(target || 'boat');
    const me = bot.entity.position;
    const e = Object.values(bot.entities)
      .filter((x) => x !== bot.entity && x.name && (x.name === name || x.name.endsWith(`_${name}`) || (name === 'boat' && /boat|raft/.test(x.name))))
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!e || e.position.distanceTo(me) > 16) throw new Error(`附近 16 格内没有 ${name}`);
    return agent.tasks.run('mount', `骑上 ${e.name}`, async (task) => {
      if (e.position.distanceTo(bot.entity.position) > 2.5) await gotoGoal(agent, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), { signal: task.signal });
      bot.mount(e);
      await sleep(600, task.signal);
      return bot.vehicle ? `骑上了 ${e.name}` : `没骑上 ${e.name}（可能需要马鞍、还没驯服，或者已经坐满了）`;
    }, taskOpts(ctx));
  }
  if (action === 'fish') {
    const rod = findItem(bot, 'fishing_rod');
    if (!rod) throw new Error('背包里没有钓鱼竿（3 根木棍 + 2 根线可以合成）');
    const times = intIn(count, 1, 64, 5);
    return agent.tasks.run('fish', `钓鱼×${times}`, async (task) => {
      const water = bot.findBlock({
        matching: bot.registry.blocksByName.water.id,
        maxDistance: 20,
        useExtraInfo: (b) => ['air', 'cave_air'].includes(bot.blockAt(b.position.offset(0, 1, 0))?.name),
      });
      if (!water) throw new Error('附近 20 格没有露天的水面');
      if (distTo(bot, water.position) > 5) await gotoGoal(agent, new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 3), { signal: task.signal });
      await bot.equip(rod, 'hand');
      const before = summarizeItems(bot.inventory.items(), 60);
      let caught = 0;
      try {
        while (caught < times) {
          await bot.lookAt(water.position.offset(0.5, 0.8, 0.5), true);
          await abortable(withTimeout(bot.fish(), 60_000, '等了一分钟都没有鱼咬钩'), task.signal);
          caught += 1;
          await sleep(600, task.signal);
        }
      } finally {
        if (task.signal.aborted) bot.activateItem();
      }
      return `钓了 ${caught} 次。钓之前背包：${before}；现在：${summarizeItems(bot.inventory.items(), 60)}`;
    }, taskOpts(ctx));
  }
  throw new Error('action 只能是 fish、mount 或 dismount');
}

// ── 动作表 ──────────────────────────────────────────────────

export const ACTIONS = [
  {
    name: 'say',
    description: '在游戏聊天栏说话。玩家只能看到你用这个工具说出的话。填 to 就是只有对方能看到的悄悄话；填 link 会在末尾附一个可点击的网页链接（例如 locate 给出的 Chunkbase 地图）。',
    input_schema: schema({
      text: str('要说的话：简短口语化的中文，不用 Markdown 和表情符号'),
      to: str('悄悄话对象的玩家名；公开说话时不填'),
      link: str('附带的网页链接（https 开头）；没有时不填'),
    }, ['text']),
    run: async (agent, { text, to, link }) => {
      const url = typeof link === 'string' && /^https:\/\/\S+$/.test(link) ? link : undefined;
      const n = agent.say(String(text ?? ''), { to, link: url });
      return n ? `已说出（${n} 行）` : '没有可说的内容';
    },
  },
  {
    name: 'get_status',
    description: '查看自己的最新状态：生命、饥饿、位置、时间天气、手持和盔甲、背包、当前任务、在线玩家（含坐标）和附近生物。',
    input_schema: schema({}),
    run: async (agent) => describeStatus(agent),
  },
  {
    name: 'scan_area',
    description: '观察周围。不填 block：概览 32 格内值得注意的方块（矿石、原木、水、岩浆、工作台、熔炉、箱子、床等）的数量和最近坐标，以及脚下和准星对着的方块。填 block：列出这种方块最近的 10 个位置（最远 64 格）；可用泛称 log、ore、bed、planks。',
    input_schema: schema({ block: str('要找的方块英文 ID 或泛称，例如 iron_ore、oak_log、log、bed；概览时不填') }, []),
    run: async (agent, { block }) => (block ? scanFor(agent, block) : scanOverview(agent)),
  },
  {
    name: 'goto',
    description: '走到指定坐标（长任务）。不知道高度时可以不填 y。身上有便宜方块时会自己垫方块搭路、爬高。fly=true 且有鞘翅和烟花时飞过去（很远时推荐）。很远的地方主人同意的话也可以用 run_command 传送。',
    input_schema: schema({ x: numType('X 坐标'), y: numType('Y 坐标（高度），可不填'), z: numType('Z 坐标'), fly: { type: 'boolean', description: '用鞘翅飞，可不填' } }, ['x', 'z']),
    run: (agent, input, ctx) => {
      const x = num(input.x, 'x');
      const z = num(input.z, 'z');
      const y = input.y == null || input.y === '' ? null : num(input.y, 'y');
      const goal = y == null ? new goals.GoalXZ(x, z) : new goals.GoalNear(x, y, z, 1);
      const label = y == null ? `(${Math.floor(x)}, ?, ${Math.floor(z)})` : fmtPos({ x, y, z });
      return agent.tasks.run('goto', `前往 ${label}${input.fly ? '（飞过去）' : ''}`, async (task) => {
        let note = '';
        if (input.fly) {
          try {
            note = `${await elytraTravel(agent, { x, z }, task.signal)}，`;
          } catch (err) {
            if (task.signal.aborted) throw err;
            note = `飞不了（${err.message}），改成走路，`;
          }
        }
        await gotoGoal(agent, goal, { signal: task.signal, timeoutMs: 600_000 });
        return `${note}到达 ${fmtPos(agent.bot.entity.position)}`;
      }, taskOpts(ctx));
    },
  },
  {
    name: 'go_to_player',
    description: '去找玩家。follow=false：走到他身边就停；follow=true：一直跟着他（长任务，直到 stop 或有新任务），途中会顺手打靠近的怪物。',
    input_schema: schema({ player: str('玩家名'), follow: { type: 'boolean', description: '是否持续跟随' } }),
    run: (agent, { player, follow }, ctx) => (follow === true || follow === 'true'
      ? followPlayer(agent, String(player), ctx)
      : comeToPlayer(agent, String(player), ctx)),
  },
  {
    name: 'stop',
    description: '立刻停下当前任务（走路、采集、跟随、护卫、战斗等）。',
    input_schema: schema({}),
    run: async (agent) => {
      const task = await agent.tasks.cancel('被要求停下');
      return task ? `已停止：${task.desc}` : '现在没有进行中的任务';
    },
  },
  {
    name: 'collect_block',
    description: '采集方块（长任务）：自动找附近 64 格内的这种方块，挖掉并捡起掉落物，会自动换合适的工具。可用泛称 log（所有原木）、ore 等。挖石头、矿石需要背包里有镐。',
    input_schema: schema({ block: str('方块英文 ID，如 oak_log、stone、coal_ore、iron_ore、sand，或泛称 log'), count: int('要采集的数量（1～256）') }),
    run: (agent, input, ctx) => collectBlocks(agent, input, ctx),
  },
  {
    name: 'craft_item',
    description: '合成物品。需要 3×3 配方时使用 32 格内的工作台（没有但背包里有工作台就先放一个）。材料不够会告诉你缺什么，请先采集或合成材料（例如 原木→木板→木棍）。',
    input_schema: schema({ item: str('要合成的物品英文 ID，如 oak_planks、stick、crafting_table、wooden_pickaxe、torch、furnace'), count: int('想得到的数量') }),
    run: (agent, input, ctx) => craftItem(agent, input, ctx),
  },
  {
    name: 'smelt_item',
    description: '用熔炉烧背包里的东西（长任务，每个约 10 秒），例如 raw_iron→铁锭、sand→玻璃、beef→牛排。使用 32 格内的熔炉（没有但背包里有熔炉就先放一个），燃料自动从背包选（煤、木炭、木板、原木等）。',
    input_schema: schema({ item: str('要烧的物品英文 ID，如 raw_iron、raw_gold、sand、beef、cobblestone'), count: int('要烧的数量') }),
    run: (agent, input, ctx) => smeltItem(agent, input, ctx),
  },
  {
    name: 'give_items',
    description: '把背包里的物品交给玩家：走到他身边扔给他。不填 player 就是丢在自己脚下。',
    input_schema: schema({ item: str('物品英文 ID'), count: int('数量'), player: str('接收的玩家名；丢在地上时不填') }, ['item', 'count']),
    run: (agent, input, ctx) => giveItems(agent, input, ctx),
  },
  {
    name: 'equip_item',
    description: '手持或穿戴背包里的物品。slot：hand 主手（默认）、off-hand 副手、head、torso、legs、feet；盔甲不填 slot 会自动穿到对应位置。',
    input_schema: schema({ item: str('物品英文 ID'), slot: choice(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'], '装备位置，可不填') }, ['item']),
    run: async (agent, { item, slot }) => {
      const it = findItem(agent.bot, item);
      if (!it) throw new Error(`背包里没有 ${normalizeName(item)}`);
      const dest = SLOT_NAMES[slot] ? slot : autoSlot(it.name);
      await agent.bot.equip(it, dest);
      return `已把 ${it.name} 装备到${SLOT_NAMES[dest]}`;
    },
  },
  {
    name: 'eat',
    description: '吃背包里最好的食物（饱的时候吃不下）。',
    input_schema: schema({}),
    run: async (agent) => {
      const bot = agent.bot;
      if (bot.food >= 20) return '现在一点也不饿，吃不下';
      const ate = await eatBest(bot);
      return ate ? `吃了 ${ate}，饥饿值 ${bot.food}/20` : '背包里没有能吃的东西';
    },
  },
  {
    name: 'attack',
    description: '攻击（长任务）：target 填生物英文 ID（如 zombie、skeleton、cow）或玩家名，count 是要打倒的数量。会自动用战斗技巧：跳劈暴击、盾牌格挡、打不过的近战怪放船困住、苦力怕打了就跑或用弓、恶魂反弹火球、烈焰人用雪球。Boss：target=ender_dragon（先射水晶再砍头）、wither、end_crystal，只在主人明确要求时打。只在主人明确要求时攻击玩家。',
    input_schema: schema({ target: str('生物英文 ID 或玩家名'), count: int('要打倒几个（1～20）') }),
    run: (agent, input, ctx) => attackTarget(agent, input, ctx),
  },
  {
    name: 'guard',
    description: '护卫模式（长任务，直到 stop 或有新任务）：自动攻击靠近的敌对生物。填 player 就跟着保护这个玩家，不填就守在当前位置。',
    input_schema: schema({ player: str('要保护的玩家名；守在原地时不填') }, []),
    run: (agent, input, ctx) => guard(agent, input, ctx),
  },
  {
    name: 'ride',
    description: '坐船、坐矿车、骑马等（长任务）。target 填玩家名：坐到他坐的船/骆驼上（和他一起走）；填 boat、minecart、horse、camel、pig、strider、happy_ghast 等：坐最近的空着的那个。没驯服的马会把人甩下来，骑猪、炽足兽要先装鞍。',
    input_schema: schema({ target: str('玩家名，或 boat / minecart / horse / camel 等') }),
    run: (agent, input, ctx) => agent.tasks.run('ride', `乘坐 ${input.target}`, (task) => ride(agent, input, task.signal), taskOpts(ctx, 5000)),
  },
  {
    name: 'dismount',
    description: '从船、矿车、坐骑上下来。',
    input_schema: schema({}),
    run: async (agent) => {
      if (!agent.bot.vehicle) return '我没有坐在什么上面';
      agent.bot.dismount();
      return '下来了';
    },
  },
  {
    name: 'tame',
    description: '驯服动物（长任务）：狼（骨头）、猫和豹猫（生鳕鱼/生鲑鱼）、鹦鹉（种子）、马/驴/骡/羊驼（反复骑上去）。give_to 填玩家名时，驯服后把主人改成他（需要管理员权限）。',
    input_schema: schema({ animal: choice(['wolf', 'cat', 'ocelot', 'parrot', 'horse', 'donkey', 'mule', 'llama'], '要驯服的动物'), give_to: str('驯服后送给谁（玩家名），可不填') }, ['animal']),
    run: (agent, input, ctx) => agent.tasks.run('tame', `驯服 ${input.animal}`, (task) => tame(agent, input, task.signal), taskOpts(ctx)),
  },
  {
    name: 'use_portal',
    description: '走进附近 64 格内的传送门，去另一个维度（长任务）。kind=nether 下界传送门（默认），end 末地传送门。',
    input_schema: schema({ kind: choice(['nether', 'end'], '传送门种类，可不填') }, []),
    run: (agent, input, ctx) => agent.tasks.run('portal', '穿越传送门', (task) => usePortal(agent, task.signal, { kind: input.kind ?? 'nether' }), taskOpts(ctx)),
  },
  {
    name: 'pillar_up',
    description: '垫方块：原地往上搭几格柱子（用身上的泥土、圆石等便宜方块），躲怪物、上高处都能用。',
    input_schema: schema({ height: int('搭几格（1～20）') }),
    run: (agent, input, ctx) => agent.tasks.run('pillar', `垫方块往上 ${input.height} 格`, async (task) => {
      const n = await pillarUp(agent, intIn(input.height, 1, 20, 3), task.signal);
      return n ? `往上垫了 ${n} 格` : '垫不了（身上没有泥土、圆石这类方块，或者头顶有东西挡着）';
    }, taskOpts(ctx)),
  },
  {
    name: 'use_potion',
    description: '喝药水或对自己扔喷溅药水。effect 填效果：healing 治疗、regeneration 再生、fire_resistance 抗火、strength 力量、swiftness 速度、night_vision 夜视、water_breathing 水下呼吸、slow_falling 缓降、invisibility 隐身、leaping 跳跃、turtle_master 神龟。',
    input_schema: schema({ effect: str('药水效果英文名') }),
    run: async (agent, { effect }) => {
      const used = await usePotion(agent, [String(effect).toLowerCase()]);
      return used ? `用了药水：${used}` : `背包里没有 ${effect} 药水`;
    },
  },
  {
    name: 'inspect_area',
    description: '读取一个长方体区域内所有方块的完整状态（朝向 facing、延迟 delay、是否充能 powered、红石信号强度 power、活塞是否伸出等），用来看懂或排查红石机器。filter=redstone 只列红石相关方块。最多 12000 格。',
    input_schema: schema({
      x1: int('角 1 的 X'), y1: int('角 1 的 Y'), z1: int('角 1 的 Z'),
      x2: int('角 2 的 X'), y2: int('角 2 的 Y'), z2: int('角 2 的 Z'),
      filter: choice(['all', 'redstone'], '只看红石相关方块时填 redstone；可不填'),
    }, ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']),
    run: async (agent, input) => inspectArea(agent.bot,
      new Vec3(num(input.x1, 'x1'), num(input.y1, 'y1'), num(input.z1, 'z1')).floored(),
      new Vec3(num(input.x2, 'x2'), num(input.y2, 'y2'), num(input.z2, 'z2')).floored(),
      input.filter === 'redstone' ? 'redstone' : 'all'),
  },
  {
    name: 'build',
    description: '按方块状态建造一组方块（最多 512 个，长任务）。block 的写法和 /setblock 一样，例如 stone、repeater[facing=north,delay=2]、redstone_wall_torch[facing=east]、sticky_piston[facing=up]；红石线写 redstone_wire 会自动计算连接。默认亲手用材料建，会先备料：背包够就直接建；不够但记得的箱子里够，会先问主人要不要去拿；都不够或主人不让拿，就自己采集、合成（工作台、熔炉、镐子也会自己做）。mode=command 用 /setblock 精确放置，只在主人明确要求“用命令建”时用（需要管理员权限）。朝向含义见 knowledge 的 guide redstone_basics。',
    input_schema: schema({
      blocks: { type: 'array', description: '要放的方块', items: schema({ x: int('X'), y: int('Y'), z: int('Z'), block: str('方块状态，如 repeater[facing=north,delay=2]') }) },
      mode: choice(['auto', 'command', 'survival'], '建造方式，可不填'),
    }, ['blocks']),
    run: (agent, input, ctx) => buildAction(agent, input, ctx),
  },
  {
    name: 'dig_block',
    description: '挖掉指定坐标的一个方块并捡起掉落物（自动换合适的工具）。不要拆玩家的建筑，除非被要求。',
    input_schema: schema({ x: int('X'), y: int('Y'), z: int('Z') }),
    run: (agent, input, ctx) => digAt(agent, input, ctx),
  },
  {
    name: 'use_block',
    description: '右键使用指定坐标的方块：开关门、活板门、栅栏门，按按钮，拉拉杆；如果是床就上床睡觉（只有夜晚或雷雨天能睡）。存取箱子请用 chest。',
    input_schema: schema({ x: int('X'), y: int('Y'), z: int('Z') }),
    run: (agent, input, ctx) => useBlock(agent, input, ctx),
  },
  {
    name: 'chest',
    description: '存取容器（箱子、木桶、潜影盒等）。action=list 查看内容；deposit 存入（item 填 "*" 表示存入除工具、武器、盔甲、食物以外的全部物品）；withdraw 取出。不填 count 表示全部。',
    input_schema: schema({
      action: choice(['list', 'deposit', 'withdraw'], '操作'),
      x: int('X'),
      y: int('Y'),
      z: int('Z'),
      item: str('物品英文 ID；list 时不填'),
      count: int('数量；不填表示全部'),
    }, ['action', 'x', 'y', 'z']),
    run: (agent, input, ctx) => chestOp(agent, input, ctx),
  },
  {
    name: 'run_command',
    description: '以你的身份执行一条 / 命令（需要管理员权限），返回服务器的回复。只替主人执行；影响大的命令先和主人确认。',
    input_schema: schema({ command: str('命令，带不带开头的 / 都行，例如 time set day、give Steve bread 16、tp NJFU_Neko Steve') }),
    run: (agent, { command }, ctx) => runCommand(agent, command, ctx),
  },
  {
    name: 'memory',
    description: '长期记忆（重启后还在）。action=add 记下一条简短笔记（地点坐标、主人的喜好、约定等）；action=remove 删掉包含关键词 text 的笔记。笔记会出现在你每次看到的【记忆】里。',
    input_schema: schema({ action: choice(['add', 'remove'], '操作'), text: str('笔记内容，或要删除的关键词') }),
    offline: true,
    run: async (agent, { action, text }, ctx) => (action === 'remove'
      ? agent.memory.remove(text)
      : agent.memory.add(text, ctx.by?.name ?? null)),
  },
  {
    name: 'transport',
    description: '运送物资（长任务）：从箱子取出物品，送到另一个箱子或交给玩家，东西多会自动多跑几趟。from 不填时，从记得的箱子里找（打开过的箱子才会被记住）。',
    input_schema: schema({
      item: str('物品英文 ID'),
      count: int('数量'),
      from: str('来源箱子坐标 "x,y,z"；不填则从记得的箱子里找'),
      to: str('目的地：箱子坐标 "x,y,z"，或玩家名'),
    }, ['item', 'count', 'to']),
    run: (agent, input, ctx) => transportAction(agent, input, ctx),
  },
  {
    name: 'schematic',
    description: '使用投影（Litematica）原理图：action=list 列出原理图（name 可填关键词过滤）；info 看尺寸和材料清单；build 把原理图原点放在坐标 (x,y,z) 建出来（建之前先和主人确认位置）。默认亲手建并自动备料（同 build）；材料太多时建议 mode=command 用命令建（需要管理员权限，主人明确同意才行）。',
    input_schema: schema({
      action: choice(['list', 'info', 'build'], '操作'),
      name: str('原理图名字或关键词'),
      x: int('原点 X（build 时必填）'), y: int('原点 Y'), z: int('原点 Z'),
      mode: choice(['survival', 'command'], '建造方式：survival 亲手建（默认），command 用命令建'),
    }, ['action']),
    run: (agent, input, ctx) => schematicAction(agent, input, ctx),
  },
  {
    name: 'locate',
    description: '找最近的结构、生物群系或兴趣点（用 /locate，需要管理员权限），返回坐标、距离和 Chunkbase 地图链接。kind=structure 时 target 如 village_plains、ancient_city、trial_chambers、stronghold、mansion、monument，也可以用标签 #village；kind=biome 时如 cherry_grove、mushroom_fields。',
    input_schema: schema({ kind: choice(['structure', 'biome', 'poi'], '找什么'), target: str('ID 或 #标签') }),
    run: (agent, input, ctx) => locateAction(agent, input, ctx),
  },
  {
    name: 'knowledge',
    description: '查 Minecraft 知识。topic：obtain 怎么获得某物品；craft_plan 合成规划（结合背包算出从原材料到成品的每一步，count 为数量）；block / food / mob 方块、食物、生物资料；wiki 查 Minecraft 中文 Wiki；guide 读专题手册（query 填 redstone_basics 红石基础、redstone_circuits 常用电路、redstone_repair 红石排障、carpet 地毯模组、building 建造技巧）。不确定时先查再做。',
    input_schema: schema({
      topic: choice(['obtain', 'craft_plan', 'block', 'food', 'mob', 'wiki', 'guide'], '查什么'),
      query: str('物品/方块/生物的英文 ID，Wiki 关键词，或手册名'),
      count: int('craft_plan 时要做的数量，可不填'),
    }, ['topic', 'query']),
    offline: true,
    run: (agent, input) => knowledgeAction(agent, input),
  },
  {
    name: 'affection',
    description: '根据玩家的言行调整你对他的好感：被夸奖、被关心、一起完成事情时 +1～+3；被骂、被欺负时 −3～−10。同一件事只调一次；送礼和被打系统会自动算，不用你调。',
    input_schema: schema({ player: str('玩家名'), change: int('变化量（-10～5）'), reason: str('原因，简短') }),
    offline: true,
    run: async (agent, { player, change, reason }) => {
      const d = clamp(Math.round(Number(change) || 0), -10, 5);
      const r = agent.affection.change(String(player), d, String(reason || '大脑判断'), { kind: 'brain', owner: agent.chat.isOwner(player) });
      return `${player} 的好感 ${r.applied >= 0 ? '+' : ''}${r.applied} → ${r.score}（${r.level}）${r.applied !== d && d > 0 ? '（今天从聊天得到的好感已到上限）' : ''}`;
    },
  },
  {
    name: 'emote',
    description: '做动作表达情绪、和玩家互动：wave 挥手、nod 点头、shake 摇头、jump 跳一跳、crouch 蹲起、spin 转圈、dance 跳舞、hearts 头顶冒爱心、meow 喵喵叫、happy 开心、sad 难过、sit 坐下、stand 站起来。target 填玩家名会先看向他。说话时配合动作会更生动。',
    input_schema: schema({
      name: choice(['wave', 'nod', 'shake', 'jump', 'crouch', 'spin', 'dance', 'hearts', 'meow', 'happy', 'sad', 'sit', 'stand'], '动作'),
      target: str('先看向哪个玩家，可不填'),
    }, ['name']),
    run: async (agent, { name, target }) => agent.emotes.perform(name, target),
  },
  {
    name: 'activity',
    description: '休闲活动：fish 钓鱼（需要钓鱼竿，count 为钓几次）；mount 骑上附近的船、矿车、马、猪等（target 填 boat、minecart、horse、pig…）；dismount 下来。',
    input_schema: schema({
      action: choice(['fish', 'mount', 'dismount'], '做什么'),
      target: str('mount 时骑什么，可不填'),
      count: int('fish 时钓几次，可不填'),
    }, ['action']),
    run: (agent, input, ctx) => activityAction(agent, input, ctx),
  },
  {
    name: 'duel',
    description: 'PVP 决斗（娱乐切磋）。action=start 接受或发起决斗（difficulty：easy / normal / hard）；surrender 对方认输；stats 查战绩。默认“切磋”规则，打到只剩几颗心就停，不会真打死。',
    input_schema: schema({
      action: choice(['start', 'surrender', 'stats'], '操作'),
      player: str('对手的玩家名'),
      difficulty: choice(['easy', 'normal', 'hard'], '难度，可不填'),
    }, ['action', 'player']),
    run: async (agent, { action, player, difficulty }, ctx) => {
      if (action === 'stats') return agent.duels.statsText(String(player));
      if (action === 'surrender') return agent.duels.surrender(String(player)) ? '对方认输了' : '现在没有在和他决斗';
      return agent.duels.start(String(player), difficulty || 'normal', ctx);
    },
  },
];

const BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

export function toolDefinitions(strict) {
  return ACTIONS.map(({ name, description, input_schema: inputSchema }) => ({
    name, description, input_schema: inputSchema, ...(strict ? { strict: true } : {}),
  }));
}

export function listActions() {
  return ACTIONS.map(({ name, description, input_schema: s }) => ({ name, description, params: s.properties, required: s.required }));
}

// 执行一个动作，统一返回 { ok, text, running? }，并记录到事件日志。
export async function runAction(agent, name, input = {}, ctx = {}) {
  const def = BY_NAME.get(name);
  if (!def) return { ok: false, text: `没有「${name}」这个动作。可用：${ACTIONS.map((a) => a.name).join(', ')}` };
  const args = input && typeof input === 'object' ? input : {};
  const missing = def.input_schema.required.filter((key) => args[key] == null || args[key] === '');
  let result;
  if (missing.length) {
    result = { ok: false, text: `缺少参数：${missing.join(', ')}` };
  } else if (!def.offline && (!agent.online || !agent.bot?.entity)) {
    result = { ok: false, text: '现在没有连上服务器' };
  } else {
    try {
      const out = await def.run(agent, args, ctx);
      result = typeof out === 'string' ? { ok: true, text: out } : out;
    } catch (err) {
      result = { ok: false, text: describeError(err) };
    }
  }
  agent.events.push('action', {
    name, input: args, ok: result.ok !== false, running: Boolean(result.running),
    result: truncate(result.text ?? '', 400), by: ctx.by?.name ?? ctx.by?.source ?? null,
  });
  return result;
}
