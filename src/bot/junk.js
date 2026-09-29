// 自己扔垃圾：闲着陪主人、背包空位只剩 4 格以内时，把没用的东西扔掉（#设置 扔垃圾 可关）。
// 一定扔：腐肉、毒马铃薯、枯萎的灌木。超量才扔：圆石、泥土各留 64 个（被困住时垫脚用），种子留 16 个；
// 杂石（闪长岩、花岗岩、安山岩、凝灰岩、深板岩……）在已经有够用的垫脚方块时全扔。
// 比身上穿的差的盔甲、比同类最好的差的工具和武器扔掉。
// 不扔：别人送的礼物（12 小时内）、附魔或改过名的东西。扔出去的东西她不会再捡回来（见 social.isOwnDrop）。
import { itemKey } from './ui.js';
import { getLog } from '../log.js';
import { sleep } from '../util.js';

const log = getLog('背包');

const ALWAYS = new Set(['rotten_flesh', 'poisonous_potato', 'dead_bush']);
const STONES = new Set(['granite', 'diorite', 'andesite', 'tuff', 'calcite', 'cobbled_deepslate', 'deepslate', 'gravel', 'netherrack', 'dripstone_block']);
const KEEP = { cobblestone: 64, dirt: 64, wheat_seeds: 16, beetroot_seeds: 16, pumpkin_seeds: 8, melon_seeds: 8 };
// 从差到好（乌龟壳头盔另有用处，不参与比较）
const ARMOR_TIER = ['leather', 'copper', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const TOOL_TIER = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
const ARMOR = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
const GEAR = /^([a-z]+)_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$/;

const tierOf = (material, kind) => (ARMOR[kind] ? ARMOR_TIER : TOOL_TIER).indexOf(material);
const special = (item) => Boolean(item.enchants?.length || item.componentMap?.has?.('enchantments')
  || item.componentMap?.has?.('custom_name') || item.customName);

// 要扔的东西：[{ item, count }]。gifts：最近别人送的物品名（不扔）
export function junkPlan(bot, { gifts = new Set() } = {}) {
  const items = bot.inventory.items();
  const total = (name) => items.filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
  const scaffold = total('cobblestone') + total('dirt');
  const kept = new Map();
  const plan = [];
  for (const item of items) {
    if (gifts.has(item.name) || special(item)) continue;
    if (ALWAYS.has(item.name) || (STONES.has(item.name) && scaffold >= 64)) {
      plan.push({ item, count: item.count });
      continue;
    }
    if (KEEP[item.name] != null) {
      const room = Math.max(0, KEEP[item.name] - (kept.get(item.name) ?? 0));
      const keep = Math.min(room, item.count);
      kept.set(item.name, (kept.get(item.name) ?? 0) + keep);
      if (item.count > keep) plan.push({ item, count: item.count - keep });
      continue;
    }
    const m = GEAR.exec(item.name);
    if (!m || tierOf(m[1], m[2]) < 0) continue;
    const [, material, kind] = m;
    if (ARMOR[kind]) {
      // 身上穿着同一部位更好（或一样好）的盔甲：这件多余
      const worn = bot.inventory.slots[bot.getEquipmentDestSlot(ARMOR[kind])];
      const wm = worn ? GEAR.exec(worn.name) : null;
      if (wm && tierOf(wm[1], kind) >= tierOf(material, kind)) plan.push({ item, count: item.count });
    } else {
      // 背包里（或手上）有同类更好的工具、武器：这把多余
      const better = [...items, bot.heldItem].some((o) => {
        const om = o && o !== item ? GEAR.exec(o.name) : null;
        return om?.[2] === kind && tierOf(om[1], kind) > tierOf(material, kind);
      });
      if (better) plan.push({ item, count: item.count });
    }
  }
  return plan;
}

// 按计划扔掉，扔完在聊天里说一声（物品名按玩家客户端的语言显示）。返回扔了几种。
export async function tossJunk(agent) {
  const bot = agent.bot;
  const gifts = new Set((agent.giftLedger ?? []).filter((g) => Date.now() - g.t < 12 * 3_600_000).map((g) => g.item));
  const plan = junkPlan(bot, { gifts });
  if (!plan.length) return 0;
  const done = new Map();
  for (const { item, count } of plan) {
    try {
      if (count >= item.count) await bot.tossStack(item);
      else await bot.toss(item.type, null, count);
      done.set(item.name, (done.get(item.name) ?? 0) + count);
      await sleep(150);
    } catch (err) {
      log.debug(`扔 ${item.name} 失败：${err.message}`);
    }
  }
  if (!done.size) return 0;
  const list = [...done.entries()];
  const plain = list.map(([n, c]) => `${n}×${c}`).join('、');
  log.info(`扔掉了没用的东西：${plain}`);
  agent.events.push('bot', { what: 'toss_junk', detail: plain });
  if (agent.identity.opLevel >= 2) {
    const parts = ['', { text: '<' }, { text: agent.cfg.identity.display_name, color: 'light_purple' }, { text: '> 背包快满了，扔掉了没用的：' }];
    list.forEach(([n, c], i) => parts.push({ translate: itemKey(bot.registry, n), fallback: n, color: 'yellow' }, { text: `×${c}${i < list.length - 1 ? '、' : ''}` }));
    agent.identity.sendRaw('@a', parts, `背包快满了，扔掉了没用的：${plain}`);
  } else {
    agent.say(`背包快满了，扔掉了没用的：${plain}`);
  }
  return done.size;
}
