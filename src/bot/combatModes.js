// 战斗模式：普通 / 困难 / 极限（全部技巧都用）/ 作弊（极限 + 临时的顶级附魔装备）。
// config.toml 的 [combat] 里各个开关是“允许用”，模式决定“用不用”；两个都是才用。
import { getLog } from '../log.js';
import { sleep } from '../util.js';
import { equipBestWeapon } from './helpers.js';

const log = getLog('战斗');

const BASE = {
  crits: false, shield: true, boat_trap: false, bow: true, creeper_melee: false, potions: true, pillar: false, golden_apples: true,
  enchanted_apples: false, totem: true, water: false, lava: false, elytra: false, sweep: true, kite: true, retreat_bonus: 2,
};
export const MODES = {
  普通: { ...BASE },
  困难: { ...BASE, crits: true, boat_trap: true, creeper_melee: true, pillar: true, water: true, retreat_bonus: 0 },
  极限: {
    ...BASE, crits: true, boat_trap: true, creeper_melee: true, pillar: true, water: true, lava: true, elytra: true, enchanted_apples: true,
    retreat_bonus: -2,
  },
};
MODES.作弊 = { ...MODES.极限, cheat: true };
export const MODE_NAMES = Object.keys(MODES);
export const MODE_DESC = {
  普通: '会用盾牌、弓箭、药水和金苹果救急；不跳劈、不船困',
  困难: '跳劈、横扫、边打边退、船困怪、水桶冲开怪群、垫高躲怪、按引信打苦力怕',
  极限: '困难的全部 + 岩浆桶烫怪、鞘翅撤离、附魔金苹果，撤退线更低',
  作弊: '极限 + 临时的顶级附魔装备（下界合金或钻石套）、附魔金苹果、不死图腾、各种药水，切回来时收回',
};
const ALIASES = { normal: '普通', easy: '普通', hard: '困难', extreme: '极限', max: '极限', cheat: '作弊' };
export const normalizeMode = (m) => (MODES[m] ? m : ALIASES[String(m ?? '').toLowerCase()] ?? null);

// 当前生效的战斗开关
export function combatFlags(agent) {
  const c = agent.cfg.combat ?? {};
  const mode = normalizeMode(c.mode) ?? '困难';
  const preset = MODES[mode];
  const out = { mode };
  for (const [k, v] of Object.entries(preset)) out[k] = typeof v === 'boolean' ? v && c[k] !== false : v;
  // 日常索敌范围和模式无关：默认 64 格（#设置 索敌范围 可改）
  const r = Number(c.engage_radius);
  out.engage_radius = Number.isFinite(r) && r > 0 ? Math.min(96, Math.max(4, r)) : 64;
  return out;
}

// ── 作弊模式的临时装备 ──
// 物品带 custom_data {neko_temp:1b} 标记，退出作弊模式时用 /clear 按标记收回，再穿回原来的装备。
const TEMP = 'custom_data={neko_temp:1b}';
const TIERS = { 下界合金: 'netherite', 钻石: 'diamond', netherite: 'netherite', diamond: 'diamond' };
const ench = (map) => `enchantments={${Object.entries(map).map(([k, v]) => `"minecraft:${k}":${v}`).join(',')}}`;

function cheatKit(tier, { gapples = 4, totems = 2, potions = true, elytra = false } = {}) {
  const t = TIERS[tier] ?? 'netherite';
  const armor = { protection: 4, unbreaking: 3, mending: 1 };
  const kit = [
    [`${t}_helmet`, { ...armor, respiration: 3, aqua_affinity: 1 }, 1],
    [`${t}_chestplate`, armor, 1],
    [`${t}_leggings`, { ...armor, swift_sneak: 3 }, 1],
    [`${t}_boots`, { ...armor, feather_falling: 4, depth_strider: 3 }, 1],
    [`${t}_sword`, { sharpness: 5, looting: 3, fire_aspect: 2, sweeping_edge: 3, unbreaking: 3, mending: 1 }, 1],
    [`${t}_axe`, { sharpness: 5, efficiency: 5, unbreaking: 3, mending: 1 }, 1],
    ['bow', { power: 5, punch: 1, flame: 1, infinity: 1, unbreaking: 3 }, 1],
    ['shield', { unbreaking: 3, mending: 1 }, 1],
  ].map(([item, e, n]) => `${item}[${ench(e)},${TEMP}] ${n}`);
  kit.push(`arrow[${TEMP}] 64`, `golden_apple[${TEMP}] 16`, `cooked_beef[${TEMP}] 32`, `oak_boat[${TEMP}] 1`, `water_bucket[${TEMP}] 1`, `cobblestone[${TEMP}] 64`);
  if (gapples > 0) kit.push(`enchanted_golden_apple[${TEMP}] ${gapples}`);
  if (totems > 0) kit.push(`totem_of_undying[${TEMP}] ${totems}`);
  if (potions) {
    // 给自己喝的、给主人扔的（喷溅治疗/再生）、砸怪用的（喷溅伤害/中毒）
    for (const [form, p, n] of [['splash_potion', 'strong_healing', 4], ['splash_potion', 'strong_regeneration', 2], ['potion', 'strong_regeneration', 2],
      ['potion', 'strong_strength', 2], ['potion', 'long_fire_resistance', 2], ['splash_potion', 'strong_harming', 3], ['splash_potion', 'strong_poison', 2]]) {
      kit.push(`${form}[potion_contents={potion:"minecraft:${p}"},${TEMP}] ${n}`);
    }
  }
  if (elytra) kit.push(`elytra[${ench({ unbreaking: 3, mending: 1 })},${TEMP}] 1`, `firework_rocket[fireworks={flight_duration:3},${TEMP}] 64`);
  return kit;
}

export async function giveCheatKit(agent, opts = {}) {
  const bot = agent.bot;
  if (agent.identity.opLevel < 2) throw new Error('作弊模式要管理员权限（/give）');
  const free = bot.inventory.emptySlotCount();
  const kit = cheatKit(opts.tier ?? agent.cfg.combat?.cheat_tier, opts);
  if (free < kit.length) throw new Error(`背包空位不够（要 ${kit.length} 格，现在只有 ${free} 格），先帮我清一清背包吧`);
  // 第一条不用静默，用它的回显检查命令格式对不对
  const replies = await agent.chat.capture(async () => bot.chat(`/give ${bot.username} ${kit[0]}`), 1200);
  if (replies.some((r) => /Unknown|Expected|Invalid|Malformed|未知|错误|无效/i.test(r))) throw new Error(`发装备的命令被服务器拒绝了：${replies.join(' ')}`);
  for (const line of kit.slice(1)) {
    agent.adminCommand(`give ${bot.username} ${line}`);
    await sleep(120);
  }
  await sleep(800);
  await bot.armorManager?.equipAll?.();
  // 穿上临时盔甲（原来的盔甲会换回背包）
  for (const [dest, re] of [['head', /_helmet$/], ['torso', /_chestplate$/], ['legs', /_leggings$/], ['feet', /_boots$/]]) {
    const temp = bot.inventory.items().find((i) => re.test(i.name) && isTemp(i));
    if (temp) await bot.equip(temp, dest).catch(() => {});
  }
  const shield = bot.inventory.items().find((i) => i.name === 'shield' && isTemp(i));
  if (shield) await bot.equip(shield, 'off-hand').catch(() => {});
  await equipBestWeapon(bot);
  log.info(`作弊模式：发了 ${kit.length} 样临时装备`);
  return kit.length;
}

export function isTemp(item) {
  const data = item?.componentMap?.get?.('custom_data')?.data;
  return Boolean(data && JSON.stringify(data).includes('neko_temp'));
}

export async function removeCheatKit(agent) {
  const bot = agent.bot;
  if (agent.identity.opLevel < 2) return false;
  agent.adminCommand(`clear ${bot.username} *[custom_data~{neko_temp:1b}]`);
  await sleep(800);
  await bot.armorManager?.equipAll?.();
  const shield = bot.inventory.items().find((i) => i.name === 'shield');
  if (shield && bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name !== 'shield') await bot.equip(shield, 'off-hand').catch(() => {});
  await equipBestWeapon(bot);
  return true;
}
