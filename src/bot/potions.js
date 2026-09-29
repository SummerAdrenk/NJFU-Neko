// 药水：分清是给自己用、给队友用、还是对怪物用。
//   给自己：喝药水，或者对自己脚下扔喷溅药水。
//   给队友：往他身上扔喷溅（或滞留）药水——治疗、再生、抗火、力量、速度。
//   对怪物：往怪堆里扔伤害、中毒、虚弱、缓慢。亡灵生物反过来：治疗伤害它们、伤害反而给它们回血，中毒和再生对它们没用。
import { SPLASH_POTION, solveBallistic } from './ballistics.js';

// 药水 ID（注册表顺序，1.21 起未变）
const POTIONS = ['water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision', 'invisibility', 'long_invisibility', 'leaping', 'long_leaping',
  'strong_leaping', 'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness', 'strong_swiftness', 'slowness', 'long_slowness',
  'strong_slowness', 'turtle_master', 'long_turtle_master', 'strong_turtle_master', 'water_breathing', 'long_water_breathing', 'healing',
  'strong_healing', 'harming', 'strong_harming', 'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration',
  'strong_regeneration', 'strength', 'long_strength', 'strong_strength', 'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested'];

export const UNDEAD = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin', 'zoglin', 'skeleton', 'stray', 'bogged', 'parched',
  'wither_skeleton', 'wither', 'phantom', 'skeleton_horse', 'zombie_horse', 'zombie_nautilus', 'camel_husk']);

export const ALLY_KINDS = ['healing', 'regeneration', 'fire_resistance', 'strength', 'swiftness'];

// 对某个生物有伤害/削弱作用的药水（亡灵反过来用治疗）
export function offensiveKindsFor(entity) {
  return UNDEAD.has(entity?.name) ? ['healing', 'weakness', 'slowness'] : ['harming', 'poison', 'weakness', 'slowness'];
}

export function potionType(item) {
  const data = item?.componentMap?.get?.('potion_contents')?.data;
  const id = data?.potionId ?? data?.potion ?? data?.potion_id;
  if (typeof id === 'number') return POTIONS[id] ?? null;
  if (typeof id === 'string') return id.replace(/^minecraft:/, '');
  return null;
}

const baseKind = (t) => String(t ?? '').replace(/^(long|strong)_/, '');

// kinds：想要的效果（自动包含 long_ / strong_ 版本）；form：'drink' 只找能喝的，'throw' 只找喷溅/滞留的
export function findPotion(bot, kinds, { form = null } = {}) {
  const ok = (i) => (form === 'drink' ? i.name === 'potion' : form === 'throw' ? /^(splash|lingering)_potion$/.test(i.name) : /potion$/.test(i.name));
  const items = bot.inventory.items().filter((i) => ok(i) && kinds.includes(baseKind(potionType(i))));
  // 优先强效的
  return items.sort((a, b) => Number(potionType(b)?.startsWith('strong_')) - Number(potionType(a)?.startsWith('strong_')))[0] ?? null;
}

export function listPotions(bot) {
  const out = {};
  for (const i of bot.inventory.items().filter((x) => /potion$/.test(x.name))) {
    const key = `${i.name === 'potion' ? '' : i.name === 'splash_potion' ? '喷溅' : '滞留'}${potionType(i) ?? '未知'}`;
    out[key] = (out[key] ?? 0) + i.count;
  }
  return out;
}

async function holdInHand(bot, item) {
  if (bot.heldItem?.type === item.type && bot.heldItem?.slot === item.slot) return;
  const hotbar = item.slot >= 36 && item.slot <= 44 ? item.slot - 36 : -1;
  if (hotbar >= 0) bot.setQuickBarSlot(hotbar);
  else await bot.equip(item, 'hand');
}

// 给自己用：能扔的就对脚下扔（快），否则喝。返回用掉的药水名，没有返回 null。
export async function usePotion(agent, kinds) {
  const bot = agent.bot;
  const splash = findPotion(bot, kinds, { form: 'throw' });
  if (splash) {
    await holdInHand(bot, splash);
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    bot.activateItem();
    bot.deactivateItem();
    return potionType(splash);
  }
  const drink = findPotion(bot, kinds, { form: 'drink' });
  if (!drink) return null;
  await holdInHand(bot, drink);
  await bot.consume();
  return potionType(drink);
}

// 往目标（队友或者怪物）身上扔喷溅/滞留药水。药水扔得很近（出手速度慢），超过约 6 格就扔不到。返回用掉的药水名或 null。
export async function throwPotionAt(agent, target, kinds) {
  const bot = agent.bot;
  const item = findPotion(bot, kinds, { form: 'throw' });
  if (!item || !target?.position) return null;
  const from = bot.entity.position.offset(0, (bot.entity.eyeHeight ?? 1.62) - 0.1, 0);
  const to = target.position.offset(0, 0.3, 0);
  if (from.distanceTo(to) > 7) return null;
  const sol = solveBallistic(from, to, SPLASH_POTION);
  if (!sol) return null;
  await holdInHand(bot, item);
  await bot.look(sol.yaw, sol.pitch, true);
  bot.activateItem(); // 扔东西的数据包自带视角
  bot.deactivateItem();
  return potionType(item);
}
