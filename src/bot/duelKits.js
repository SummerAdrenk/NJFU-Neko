// PVP 决斗的难度和临时装备。所有难度都锁 1 滴血；装备都是临时的（带 neko_temp 标记，打完收回）。
// 每一档在上一档的基础上加东西；作弊档从头另起（下界合金），不继承困难档的金苹果、图腾。
//
// 招式开关：tricks 高级技巧（跳劈、走位、冲刺击退、举盾）；swap 剑斧智能切换；bow 远了射箭；web 蜘蛛网；
// elytra 鞘翅+烟花（追人、俯冲攻击、飞走回血）；fluids 水桶岩浆桶；potions 药水；gapples / totems 附魔金苹果、不死图腾；
// pearls 末影珍珠（追人、瞬移攻击、逃跑）；boom 爆炸攻击（末影水晶、TNT）。

const TEMP = 'custom_data={neko_temp:1b}';
const TOP_ARMOR = { protection: 4, unbreaking: 3, mending: 1 };
const PIECE = { helmet: { respiration: 3, aqua_affinity: 1 }, chestplate: {}, leggings: { swift_sneak: 3 }, boots: { feather_falling: 4, depth_strider: 3 } };
const TOP_SWORD = { sharpness: 5, fire_aspect: 2, sweeping_edge: 3, unbreaking: 3, mending: 1 };
const TOP_AXE = { sharpness: 5, efficiency: 5, unbreaking: 3, mending: 1 };
const TOP_BOW = { power: 5, punch: 2, flame: 1, infinity: 1, unbreaking: 3 };
const DURABLE = { unbreaking: 3, mending: 1 };

const BASE = {
  material: 'iron', axe: false, shield: false, bow: false, tricks: false, swap: false, web: false, elytra: false, fluids: false,
  armorEnch: false, weaponEnch: false, gapples: 0, totems: 0, potions: false, infinityBow: false, tippedArrows: false, pearls: false, boom: false,
};

// [id, 名字, 这一档的改动, 说明]；reset 表示从头另起，不继承上一档
const SPEC = [
  ['easy', '简单', { reset: true }, '铁套全身、铁剑，不用技巧'],
  ['normal', '普通', { reset: true, axe: true, shield: true, tricks: true, swap: true }, '铁套全身、铁剑+铁斧（看情况换着用）、盾牌，会用技巧'],
  ['hard', '困难', { reset: true, material: 'diamond', axe: true, shield: true, bow: true, tricks: true, swap: true, web: true, elytra: true },
    '钻石套全身、钻石剑+钻石斧、弓箭、盾牌、蜘蛛网、鞘翅+烟花，会用技巧'],
  ['hard2', '困难Ⅱ', { fluids: true }, '＋水桶、岩浆桶'],
  ['hard3', '困难Ⅲ', { armorEnch: true }, '＋盔甲顶级附魔'],
  ['hard4', '困难Ⅳ', { weaponEnch: true }, '＋武器顶级附魔'],
  ['hard5', '困难Ⅴ', { gapples: 3, totems: 1 }, '＋附魔金苹果×3、不死图腾×1'],
  ['hard6', '困难Ⅵ', { potions: true, gapples: 64, totems: 3 }, '＋药水、附魔金苹果×64、不死图腾×3'],
  ['cheat', '作弊', {
    reset: true, material: 'netherite', axe: true, shield: true, bow: true, infinityBow: true, tippedArrows: true, tricks: true, swap: true,
    web: true, elytra: true, fluids: true, potions: true, pearls: true,
  }, '下界合金套全身、剑+斧、无限弓和药水箭、盾牌、水桶岩浆桶、药水、蜘蛛网、鞘翅+烟花、末影珍珠'],
  ['cheat2', '作弊Ⅱ', { armorEnch: true }, '＋盔甲顶级附魔'],
  ['cheat3', '作弊Ⅲ', { weaponEnch: true }, '＋剑、斧、弓顶级附魔'],
  ['cheat4', '作弊Ⅳ', { gapples: 3, totems: 1 }, '＋附魔金苹果×3、不死图腾×1'],
  ['cheat5', '作弊Ⅴ', { gapples: 64, totems: 3 }, '＋附魔金苹果×64、不死图腾×3'],
  ['cheat6', '作弊Ⅵ', { boom: true }, '＋打火石、TNT×64、黑曜石、末影水晶（会用爆炸打你）'],
];

const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];
const GROUPS = { easy: '简单', normal: '普通', hard: '困难', cheat: '作弊' };

export const DUEL_LEVELS = (() => {
  const out = [];
  let prev = BASE;
  let descs = [];
  for (const [id, name, change, desc] of SPEC) {
    const { reset, ...rest } = change;
    if (reset) {
      prev = BASE;
      descs = [];
    }
    descs = [...descs, desc];
    const group = id.replace(/\d+$/, '');
    const tier = Number(/\d+$/.exec(id)?.[0] ?? 1);
    prev = { ...prev, ...rest, id, name, group, groupName: GROUPS[group], tier, roman: ROMAN[tier], desc, summary: descs.join('；') };
    out.push(prev);
  }
  return out;
})();

export const duelLevel = (id) => DUEL_LEVELS.find((l) => l.id === id) ?? null;

// “困难Ⅲ”“困难3”“困难III”“hard3”“作弊”…… → 难度
export function parseDuelLevel(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const direct = duelLevel(s.toLowerCase());
  if (direct) return direct;
  const m = /^(简单|普通|困难|作弊|easy|normal|hard|cheat)\s*(Ⅵ|Ⅴ|Ⅳ|Ⅲ|Ⅱ|Ⅰ|VI|IV|V|III|II|I|[1-6])?$/i.exec(s);
  if (!m) return null;
  const group = { 简单: 'easy', 普通: 'normal', 困难: 'hard', 作弊: 'cheat' }[m[1]] ?? m[1].toLowerCase();
  const t = m[2] ? m[2].toUpperCase() : '1';
  const tier = /^\d$/.test(t) ? Number(t) : ROMAN.indexOf(t) > 0 ? ROMAN.indexOf(t) : ['', 'I', 'II', 'III', 'IV', 'V', 'VI'].indexOf(t);
  return duelLevel(tier > 1 ? `${group}${tier}` : group);
}

const enchText = (map) => `enchantments={${Object.entries(map).map(([k, v]) => `"minecraft:${k}":${v}`).join(',')}}`;
const noFire = (e, fire) => {
  if (!e || fire) return e;
  const { fire_aspect: _fa, flame: _fl, ...rest } = e;
  return rest;
};

// 一整套临时装备：[{ slot, id, item }]。slot 是 /item replace 用的槽位（armor.head、weapon.offhand、hotbar.0、inventory.0…），
// item 是“物品[组件] 数量”（/give、/item replace 都能用）。fire=false 时去掉火焰附加、火矢（没有模组锁血时，免得烧死人）。
export function duelKit(level, { fire = true } = {}) {
  const m = level.material;
  const out = [];
  const add = (slot, id, { ench = null, count = 1, extra = [] } = {}) => {
    const comps = [...(ench && Object.keys(ench).length ? [enchText(ench)] : []), ...extra, TEMP];
    out.push({ slot, id, item: `${id}[${comps.join(',')}] ${count}` });
  };
  const armor = (piece) => (level.armorEnch ? { ...TOP_ARMOR, ...PIECE[piece] } : null);
  add('armor.head', `${m}_helmet`, { ench: armor('helmet') });
  add('armor.chest', `${m}_chestplate`, { ench: armor('chestplate') });
  add('armor.legs', `${m}_leggings`, { ench: armor('leggings') });
  add('armor.feet', `${m}_boots`, { ench: armor('boots') });
  if (level.shield) add('weapon.offhand', 'shield', { ench: level.armorEnch ? DURABLE : null });

  const bowEnch = level.weaponEnch ? noFire(TOP_BOW, fire) : level.infinityBow ? { infinity: 1 } : null;
  const hot = [[`${m}_sword`, { ench: level.weaponEnch ? noFire(TOP_SWORD, fire) : null }]];
  if (level.axe) hot.push([`${m}_axe`, { ench: level.weaponEnch ? TOP_AXE : null }]);
  if (level.bow) hot.push(['bow', { ench: bowEnch }]);
  if (level.fluids) hot.push(['water_bucket', {}], ['lava_bucket', {}]);
  if (level.gapples) hot.push(['enchanted_golden_apple', { count: level.gapples }]);
  if (level.pearls) hot.push(['ender_pearl', { count: 16 }]);
  if (level.web) hot.push(['cobweb', { count: 16 }]);
  if (level.boom) hot.push(['end_crystal', { count: 64 }], ['obsidian', { count: 64 }], ['tnt', { count: 64 }], ['flint_and_steel', {}]);
  hot.push(['cooked_beef', { count: 64 }]); // 所有难度都带一组熟牛排，打久了饿了能吃

  const inv = [];
  if (level.elytra) inv.push(['elytra', { ench: level.armorEnch ? DURABLE : null }], ['firework_rocket', { count: 64, extra: ['fireworks={flight_duration:3}'] }]);
  if (level.totems) inv.push(['totem_of_undying', { count: level.totems }]);
  // 药水箭放在普通箭前面：射箭时先用它
  if (level.tippedArrows) {
    inv.push(['tipped_arrow', { count: 32, extra: ['potion_contents={potion:"minecraft:strong_harming"}'] }]);
    inv.push(['tipped_arrow', { count: 16, extra: ['potion_contents={potion:"minecraft:strong_slowness"}'] }]);
  }
  if (level.bow) inv.push(['arrow', { count: bowEnch?.infinity ? 1 : 64 }]);
  if (level.potions) {
    for (const [form, p, n] of [['potion', 'strong_strength', 2], ['potion', 'strong_swiftness', 2], ['potion', 'long_fire_resistance', 2],
      ['splash_potion', 'strong_healing', 6], ['splash_potion', 'strong_harming', 4]]) {
      inv.push([form, { count: n, extra: [`potion_contents={potion:"minecraft:${p}"}`] }]);
    }
  }
  hot.slice(0, 9).forEach(([id, o], i) => add(`hotbar.${i}`, id, o));
  [...hot.slice(9), ...inv].forEach(([id, o], i) => add(`inventory.${i}`, id, o));
  return out;
}
