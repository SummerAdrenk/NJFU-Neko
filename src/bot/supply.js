// 备料：建造前先算清楚要哪些材料——
//   1. 背包里够 → 直接开工；
//   2. 背包不够，但记得的箱子里够 → 先问主人要不要去箱子拿；
//   3. 都不够，或者主人不让拿 → 自己去采集、熔炼、合成（需要工作台、熔炉、镐子就先做出来）。
import { craftingPlan } from '../knowledge/mcKnowledge.js';
import { collectCore, collectManuallyCore, craftCore, handToPlayer, smeltCore, withChest } from './actions.js';
import { itemForBlock } from './build.js';
import { countItem, findNearestBlock, findPlayer, resolveBlockIds, Vec3 } from './helpers.js';
import { getLog } from '../log.js';
import { abortError } from '../util.js';

const log = getLog('备料');

// 这些东西没法用放方块的方式备料（水、岩浆要桶，火要打火石）——建造时跳过，最后提醒一下。
const NOT_PLACEABLE = new Set(['water_bucket', 'lava_bucket', 'powder_snow_bucket', 'flint_and_steel', 'air', 'cave_air', 'void_air']);

export function inventoryCounts(bot) {
  const counts = {};
  for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] ?? 0) + it.count;
  return counts;
}

// 一批方块需要的材料 { 物品: 数量 }。已经放好的不算；门、床只算一次；双层台阶算两个。
export function materialsFor(bot, blocks) {
  const needs = new Map();
  for (const b of blocks) {
    const { name, props } = b.spec;
    const current = bot.blockAt?.(b.pos);
    if (current && current.name === name) continue;
    if (props.half === 'upper' && /_door$|tall|sunflower|lilac|rose_bush|peony|large_fern|pitcher_plant|small_dripleaf/.test(name)) continue;
    if (props.part === 'head' && /_bed$/.test(name)) continue;
    if (name === 'piston_head' || name === 'moving_piston') continue;
    const item = itemForBlock(name);
    if (NOT_PLACEABLE.has(item) || !bot.registry.itemsByName[item]) continue;
    const n = props.type === 'double' && /_slab$/.test(name) ? 2 : 1;
    needs.set(item, (needs.get(item) ?? 0) + n);
  }
  return needs;
}

// 缺多少、记得的箱子里能补多少。
export function shortage(agent, needs) {
  const bot = agent.bot;
  const missing = [];
  const fromChests = [];
  const uncovered = [];
  for (const [name, need] of needs) {
    const lack = need - countItem(bot, name);
    if (lack <= 0) continue;
    missing.push([name, lack]);
    let rest = lack;
    for (const c of agent.chestIndex.find((n) => n === name, bot.entity.position).filter((x) => x.distance < 96)) {
      if (rest <= 0) break;
      const take = Math.min(rest, c.count);
      fromChests.push({ name, take, x: c.x, y: c.y, z: c.z });
      rest -= take;
    }
    if (rest > 0) uncovered.push([name, rest]);
  }
  return { missing, fromChests, uncovered };
}

export const listText = (list) => list.slice(0, 8).map(([n, c]) => `${n}×${c}`).join('、') + (list.length > 8 ? ` 等 ${list.length} 种` : '');

// 找谁问：下命令的人（是主人的话），否则在线的主人。
function whomToAsk(agent, ctx) {
  const bot = agent.bot;
  const name = ctx?.by?.name;
  if (name && findPlayer(bot, name) && agent.chat.isOwner(name)) return findPlayer(bot, name).username;
  return Object.keys(bot.players).find((n) => n !== bot.username && agent.chat.isOwner(n)) ?? null;
}

async function withdrawFromChests(agent, plan, signal) {
  const bot = agent.bot;
  const byChest = new Map();
  for (const p of plan) {
    const key = `${p.x},${p.y},${p.z}`;
    if (!byChest.has(key)) byChest.set(key, []);
    byChest.get(key).push(p);
  }
  for (const [key, items] of byChest) {
    const [x, y, z] = key.split(',').map(Number);
    await withChest(agent, new Vec3(x, y, z), signal, async (chest) => {
      for (const it of items) {
        const id = bot.registry.itemsByName[it.name]?.id;
        const have = chest.containerItems().filter((i) => i.name === it.name).reduce((s, i) => s + i.count, 0);
        const n = Math.min(it.take, have);
        if (id != null && n > 0) await chest.withdraw(id, null, n);
      }
    });
  }
}

// ── 自己弄材料 ──

// 从哪些方块能挖到这个物品（优先常见的）。
const DUG_FROM = {
  cobblestone: ['stone', 'cobblestone'], cobbled_deepslate: ['deepslate', 'cobbled_deepslate'], dirt: ['dirt', 'grass_block', 'coarse_dirt'],
  coal: ['coal_ore', 'deepslate_coal_ore'], raw_iron: ['iron_ore', 'deepslate_iron_ore'], raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore'], redstone: ['redstone_ore', 'deepslate_redstone_ore'], lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'], emerald: ['emerald_ore', 'deepslate_emerald_ore'], quartz: ['nether_quartz_ore'],
  clay_ball: ['clay'], flint: ['gravel'], glowstone_dust: ['glowstone'], snowball: ['snow_block', 'snow'], wheat_seeds: ['short_grass', 'tall_grass'],
  sugar_cane: ['sugar_cane'], bamboo: ['bamboo'], kelp: ['kelp', 'kelp_plant'], cactus: ['cactus'], pumpkin: ['pumpkin'], melon_slice: ['melon'],
};
const SMELTS = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone', smooth_stone: 'stone',
  brick: 'clay_ball', charcoal: 'oak_log', deepslate: 'cobbled_deepslate', nether_brick: 'netherrack', terracotta: 'clay', smooth_sandstone: 'sandstone',
};

function sourceBlocks(registry, name) {
  if (DUG_FROM[name]) return DUG_FROM[name].filter((b) => registry.blocksByName[b]);
  const item = registry.itemsByName[name];
  if (!item) return [];
  // 方块本身掉落自己（木头、沙子、石头类……）
  return registry.blocksArray.filter((b) => b.drops?.includes(item.id) && !/_ore$|infested|spawner|budding/.test(b.name)).map((b) => b.name).slice(0, 6);
}

const TOOL_TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];

// 挖某种方块需要的最便宜的工具（没有要求就返回 null）。
function toolFor(bot, blockName) {
  const def = bot.registry.blocksByName[blockName];
  if (!def?.harvestTools) return null;
  const names = Object.keys(def.harvestTools).map((id) => bot.registry.items[id]?.name).filter(Boolean);
  if (names.some((n) => countItem(bot, n) > 0)) return null;
  return names.sort((a, b) => TOOL_TIERS.findIndex((t) => a.startsWith(t)) - TOOL_TIERS.findIndex((t) => b.startsWith(t)))[0];
}

async function ensureStation(agent, name, signal, depth, notes) {
  const bot = agent.bot;
  if (findNearestBlock(bot, [name], 32) || countItem(bot, name) > 0) return;
  await gather(agent, name, 1, signal, depth + 1, notes);
}

// 把背包里的 name 凑到 count 个：能合成就先备原料再合成，能熔炼就烧，能挖就去挖。
export async function gather(agent, name, count, signal, depth = 0, notes = []) {
  const bot = agent.bot;
  if (signal?.aborted) throw abortError(signal);
  if (countItem(bot, name) >= count) return;
  if (depth > 7) throw new Error(`${name} 的材料链太长，我弄不过来`);
  const lack = () => count - countItem(bot, name);

  // 原木：附近有什么木头就砍什么（合成木板时会自动用手上有的木种）
  if (/_log$/.test(name)) {
    const logs = resolveBlockIds(bot, 'log');
    const have = bot.inventory.items().filter((i) => /_log$/.test(i.name)).reduce((s, i) => s + i.count, 0);
    if (have >= count) return;
    notes.push(`砍原木×${count - have}`);
    await collectCore(agent, logs, '原木', count - have, signal);
    return;
  }

  // 合成
  let plan = craftingPlan(bot.registry, name, lack(), inventoryCounts(bot));
  if (plan?.steps.length) {
    for (const [raw, n] of Object.entries(plan.required)) {
      await gather(agent, raw, countItem(bot, raw) + n, signal, depth + 1, notes);
    }
    // 原料到手后重新规划（砍到的木头种类可能和一开始想的不一样）
    plan = craftingPlan(bot.registry, name, lack(), inventoryCounts(bot));
    for (const step of plan?.steps ?? []) {
      if (step.needsTable) await ensureStation(agent, 'crafting_table', signal, depth, notes);
      const it = bot.registry.itemsByName[step.item];
      notes.push(`合成 ${step.item}×${step.produced}`);
      await craftCore(agent, it, step.produced, signal);
    }
    if (countItem(bot, name) < count) throw new Error(`合成 ${name} 失败（材料可能还差一点）`);
    return;
  }

  // 熔炼
  if (SMELTS[name]) {
    const input = SMELTS[name];
    await gather(agent, input, countItem(bot, input) + lack(), signal, depth + 1, notes);
    await ensureStation(agent, 'furnace', signal, depth, notes);
    const hasFuel = bot.inventory.items().some((i) => /^(coal|charcoal|coal_block)$|_planks$|_log$/.test(i.name));
    if (!hasFuel) await gather(agent, 'oak_log', Math.ceil(lack() / 1.5), signal, depth + 1, notes);
    notes.push(`熔炼 ${input}→${name}×${lack()}`);
    await smeltCore(agent, bot.inventory.items().find((i) => i.name === input), lack(), signal);
    return;
  }

  // 挖方块
  const blocks = sourceBlocks(bot.registry, name);
  if (blocks.length) {
    const tool = toolFor(bot, blocks[0]);
    if (tool) await gather(agent, tool, 1, signal, depth + 1, notes);
    const ids = blocks.flatMap((b) => resolveBlockIds(bot, b));
    notes.push(`采集 ${name}×${lack()}`);
    const manual = blocks.every((b) => /grass|fern|sugar_cane|bamboo|kelp|cactus|flower|tulip/.test(b));
    if (manual) await collectManuallyCore(agent, ids, name, lack(), signal);
    else await collectCore(agent, ids, name, lack(), signal);
    return;
  }
  throw new Error(`不知道怎么弄到 ${name}（可能要打怪、交易或钓鱼），需要主人帮忙准备`);
}

// 建造前的备料流程。返回 { text: 给玩家看的说明, withdrawn: 从箱子拿了什么 }；实在弄不到会抛出错误。
export async function prepareMaterials(agent, needs, signal, ctx) {
  const bot = agent.bot;
  const { missing, fromChests, uncovered } = shortage(agent, needs);
  const withdrawn = [];
  if (!missing.length) return { text: '材料都在背包里', withdrawn };
  let tookFromChests = false;
  if (fromChests.length && !uncovered.length) {
    const asker = whomToAsk(agent, ctx);
    const where = [...new Set(fromChests.map((c) => `(${c.x}, ${c.y}, ${c.z})`))].slice(0, 3).join('、');
    const answer = asker
      ? await agent.social.ask(asker, `我身上的材料不够（缺 ${listText(missing)}），箱子 ${where} 里有。要我去拿吗？（回“好”或“不用”）`)
      : null;
    if (answer) {
      log.info(`从箱子拿材料：${listText(fromChests.map((c) => [c.name, c.take]))}`);
      await withdrawFromChests(agent, fromChests, signal);
      withdrawn.push(...fromChests);
      tookFromChests = true;
    } else if (answer === false) agent.say('好，那我自己去弄材料喵');
    else if (asker) agent.say('没等到回答，那我自己去弄材料吧');
  }
  const still = shortage(agent, needs).missing;
  if (!still.length) return { text: tookFromChests ? '从箱子里拿齐了材料' : '材料齐了', withdrawn };
  const total = still.reduce((s, [, c]) => s + c, 0);
  if (total > 640) throw new Error(`还缺太多材料（${listText(still)}，共 ${total} 个），我一个人弄不过来——先准备一些，或者让我用命令建`);
  agent.say(`还缺 ${listText(still)}，我去采集和合成（需要工作台、熔炉、工具也会自己做）`);
  const notes = [];
  for (const [name, lack] of still) {
    await gather(agent, name, countItem(bot, name) + lack, signal, 0, notes);
  }
  return { text: `自己准备了材料：${notes.slice(0, 10).join('，')}${notes.length > 10 ? ' 等' : ''}`, withdrawn };
}

// 把东西存进某个箱子。返回存进去的数量。
async function depositTo(agent, pos, name, count, signal) {
  const bot = agent.bot;
  const id = bot.registry.itemsByName[name]?.id;
  if (id == null) return 0;
  let done = 0;
  await withChest(agent, pos, signal, async (chest) => {
    const n = Math.min(count, countItem(bot, name));
    if (n > 0) {
      await chest.deposit(id, null, n);
      done = n;
    }
  });
  return done;
}

// 没用完的材料放回去：
//   1. 从箱子拿的 → 放回原来的箱子；
//   2. 别人给的（活开始前 10 分钟内和干活时收到的）→ 还给他（他不在附近就放进箱子）；
//   3. 自己采的 → 放进附近存着同样东西的箱子（没有就先留着）。
// before：开工前背包里各物品的数量。返回说明列表。
export async function returnLeftovers(agent, needs, before, withdrawn, since, signal) {
  const bot = agent.bot;
  const notes = [];
  const gifts = (agent.giftLedger ?? []).filter((g) => g.t >= since && g.count > 0);
  for (const [name] of needs) {
    const giftedBefore = gifts.filter((g) => g.item === name && g.t < since + 10 * 60_000).reduce((s, g) => s + g.count, 0);
    let extra = countItem(bot, name) - Math.max(0, (before[name] ?? 0) - giftedBefore);
    if (extra <= 0) continue;
    for (const w of withdrawn.filter((x) => x.name === name)) {
      if (extra <= 0) break;
      const n = await depositTo(agent, new Vec3(w.x, w.y, w.z), name, Math.min(extra, w.take), signal).catch(() => 0);
      if (n) {
        extra -= n;
        notes.push(`${name}×${n} 放回了箱子 (${w.x}, ${w.y}, ${w.z})`);
      }
    }
    for (const g of gifts.filter((x) => x.item === name)) {
      if (extra <= 0) break;
      const n = Math.min(extra, g.count);
      const p = findPlayer(bot, g.player)?.entity;
      const item = bot.inventory.items().find((i) => i.name === name);
      if (!p || !item || p.position.distanceTo(bot.entity.position) > 64) continue;
      await handToPlayer(agent, g.player, item.type, n, signal).catch(() => {});
      g.count -= n;
      extra -= n;
      notes.push(`${name}×${n} 还给了 ${g.player}`);
    }
    if (extra > 0) {
      const home = agent.chestIndex.find(name, bot.entity.position).filter((c) => c.distance < 48)[0];
      if (home) {
        const n = await depositTo(agent, new Vec3(home.x, home.y, home.z), name, extra, signal).catch(() => 0);
        if (n) notes.push(`${name}×${n} 放进了箱子 (${home.x}, ${home.y}, ${home.z})`);
      } else notes.push(`${name}×${extra} 我先收着`);
    }
  }
  return notes;
}
