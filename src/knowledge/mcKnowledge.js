// Minecraft 游戏知识：基于 minecraft-data 的合成规划、物品来源、方块/物品/食物/生物资料。
// 合成规划和物品来源的思路参考了 mindcraft（https://github.com/mindcraft-bots/mindcraft ，MIT 许可，
// 见 THIRD_PARTY_NOTICES.md），这里按新版本物品名重写，并输出中文说明。

// 这些是“原材料”，规划合成时不再往下拆（否则会出现 铁锭←铁块←铁锭 这种循环）。
const BASE_ITEMS = new Set([
  'coal', 'charcoal', 'diamond', 'emerald', 'redstone', 'lapis_lazuli', 'quartz', 'amethyst_shard', 'netherite_scrap',
  'raw_iron', 'raw_gold', 'raw_copper', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'netherite_ingot',
  'iron_nugget', 'gold_nugget', 'wheat', 'bone_meal', 'dried_kelp', 'slime_ball', 'honey_bottle', 'snowball', 'clay_ball',
  'glowstone_dust', 'blaze_powder', 'string', 'leather', 'paper', 'sugar', 'melon_slice',
]);

// 熔炼：产物 ← 可以烧的原料
const SMELT_FROM = {
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  netherite_scrap: ['ancient_debris'],
  glass: ['sand', 'red_sand'],
  stone: ['cobblestone'],
  smooth_stone: ['stone'],
  deepslate: ['cobbled_deepslate'],
  brick: ['clay_ball'],
  terracotta: ['clay'],
  nether_brick: ['netherrack'],
  charcoal: ['任意原木或木头'],
  cooked_beef: ['beef'],
  cooked_porkchop: ['porkchop'],
  cooked_chicken: ['chicken'],
  cooked_mutton: ['mutton'],
  cooked_rabbit: ['rabbit'],
  cooked_cod: ['cod'],
  cooked_salmon: ['salmon'],
  baked_potato: ['potato'],
  dried_kelp: ['kelp'],
  green_dye: ['cactus'],
  lime_dye: ['sea_pickle'],
  sponge: ['wet_sponge'],
  popped_chorus_fruit: ['chorus_fruit'],
  smooth_sandstone: ['sandstone'],
  smooth_quartz: ['quartz_block'],
  cracked_stone_bricks: ['stone_bricks'],
};

// 生物掉落（常见的）
const MOB_DROPS = {
  beef: ['cow', 'mooshroom'], leather: ['cow', 'mooshroom', 'horse', 'llama'], porkchop: ['pig', 'hoglin'],
  chicken: ['chicken'], feather: ['chicken'], egg: ['chicken（会自己下蛋）'], mutton: ['sheep'], white_wool: ['sheep（用剪刀剪毛更多）'],
  rabbit: ['rabbit'], rabbit_hide: ['rabbit'], rabbit_foot: ['rabbit'], cod: ['cod'], salmon: ['salmon'],
  ink_sac: ['squid'], glow_ink_sac: ['glow_squid'], string: ['spider', 'cave_spider'], spider_eye: ['spider', 'cave_spider', 'witch'],
  bone: ['skeleton', 'stray', 'bogged', 'wither_skeleton'], arrow: ['skeleton', 'stray', 'bogged'], gunpowder: ['creeper', 'ghast', 'witch'],
  rotten_flesh: ['zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin'], ender_pearl: ['enderman'], blaze_rod: ['blaze'],
  breeze_rod: ['breeze'], slime_ball: ['slime'], magma_cream: ['magma_cube'], ghast_tear: ['ghast'], phantom_membrane: ['phantom'],
  prismarine_shard: ['guardian', 'elder_guardian'], prismarine_crystals: ['guardian'], shulker_shell: ['shulker'], nether_star: ['wither'],
  wither_skeleton_skull: ['wither_skeleton'], totem_of_undying: ['evoker'], trident: ['drowned（少数手持三叉戟的）'],
  nautilus_shell: ['drowned（少数）'], iron_ingot: ['iron_golem'], glowstone_dust: ['witch'], sugar: ['witch'],
  armadillo_scute: ['armadillo（用刷子刷）'], honeycomb: ['bee_nest / beehive（用剪刀）'],
};

// 采集时 collectblock 插件处理不好、需要手动挖的方块（农作物、花、火把、按钮等）。
export function mustCollectManually(blockName) {
  const exact = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa', 'sugar_cane', 'kelp', 'short_grass', 'fern', 'tall_grass',
    'bamboo', 'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lilac', 'wither_rose',
    'lily_of_the_valley', 'lever', 'redstone_wire', 'lantern', 'sweet_berry_bush'];
  const partial = ['sapling', 'torch', 'button', 'carpet', 'pressure_plate', 'mushroom', 'tulip', 'bush', 'vines', 'fern'];
  return exact.includes(blockName) || partial.some((p) => blockName.includes(p));
}

const nameOf = (registry, id) => registry.items[id]?.name ?? registry.blocks[id]?.name ?? String(id);

// 一个配方一次需要的材料 { 物品名: 数量 }
function ingredientsOf(registry, recipe) {
  const list = recipe.ingredients ?? (recipe.inShape ? recipe.inShape.flat() : []);
  const counts = {};
  for (const entry of list) {
    const id = typeof entry === 'object' && entry !== null ? entry.id : entry;
    if (id == null || id < 0) continue;
    const name = nameOf(registry, id);
    counts[name] = (counts[name] ?? 0) + (typeof entry === 'object' && entry?.count ? entry.count : 1);
  }
  return counts;
}

const COMMON = ['oak_planks', 'oak_log', 'cobblestone', 'stick', 'coal', 'iron_ingot'];

// 物品的所有合成配方，优先选背包里已有材料多的、材料常见的。
export function craftingRecipes(registry, itemName, inventory = {}) {
  const item = registry.itemsByName[itemName];
  if (!item || !registry.recipes?.[item.id]) return [];
  const recipes = registry.recipes[item.id].map((r) => ({
    ingredients: ingredientsOf(registry, r),
    count: r.result?.count ?? 1,
    needsTable: Boolean(r.inShape && (r.inShape.length > 2 || r.inShape.some((row) => row.length > 2))),
  }));
  const score = (r) => Object.entries(r.ingredients).reduce((s, [n, c]) => s + Math.min(inventory[n] ?? 0, c) * 10 + (COMMON.includes(n) ? c : 0), 0);
  return recipes.sort((a, b) => score(b) - score(a));
}

// 递归生成合成计划：考虑背包已有物品和合成剩余，返回需要的原材料和步骤。
export function craftingPlan(registry, target, count = 1, inventory = {}) {
  if (!registry.itemsByName[target]) return null;
  const inv = { ...inventory };
  const leftovers = {};
  const required = {};
  const steps = [];
  const visiting = new Set();

  function need(item, amount) {
    const fromLeft = Math.min(leftovers[item] ?? 0, amount);
    leftovers[item] = (leftovers[item] ?? 0) - fromLeft;
    let rest = amount - fromLeft;
    const fromInv = Math.min(inv[item] ?? 0, rest);
    inv[item] = (inv[item] ?? 0) - fromInv;
    rest -= fromInv;
    if (rest <= 0) return;
    const recipe = BASE_ITEMS.has(item) || visiting.has(item) ? null : craftingRecipes(registry, item, inv)[0];
    if (!recipe) {
      required[item] = (required[item] ?? 0) + rest;
      return;
    }
    visiting.add(item);
    const batches = Math.ceil(rest / recipe.count);
    const produced = batches * recipe.count;
    if (produced > rest) leftovers[item] = (leftovers[item] ?? 0) + (produced - rest);
    for (const [name, c] of Object.entries(recipe.ingredients)) need(name, c * batches);
    visiting.delete(item);
    steps.push({ item, produced, batches, ingredients: Object.fromEntries(Object.entries(recipe.ingredients).map(([n, c]) => [n, c * batches])), needsTable: recipe.needsTable });
  }

  need(target, count);
  // 同一种东西分几次合成时合并成一步（保持第一次出现的顺序）。
  const merged = [];
  for (const s of steps) {
    const same = merged.find((m) => m.item === s.item);
    if (!same) {
      merged.push({ ...s, ingredients: { ...s.ingredients } });
      continue;
    }
    same.produced += s.produced;
    same.batches += s.batches;
    for (const [n, c] of Object.entries(s.ingredients)) same.ingredients[n] = (same.ingredients[n] ?? 0) + c;
  }
  return { target, count, required, steps: merged };
}

export function describePlan(plan) {
  if (!plan) return '没有这个物品';
  if (!plan.steps.length && !Object.keys(plan.required).length) return `背包里已经有 ${plan.count} 个 ${plan.target} 了`;
  if (!plan.steps.length) return `${plan.target} 不能合成，需要直接获得（采集、熔炼、击杀或交易）`;
  const lines = [`合成 ${plan.count} 个 ${plan.target} 的计划（已扣除背包里现有的）：`];
  const req = Object.entries(plan.required);
  lines.push(req.length ? `还需要准备：${req.map(([n, c]) => `${n}×${c}`).join('、')}` : '材料都够了');
  plan.steps.forEach((s, i) => {
    lines.push(`${i + 1}. 合成 ${s.item}×${s.produced} ← ${Object.entries(s.ingredients).map(([n, c]) => `${n}×${c}`).join(' + ')}${s.needsTable ? '（需要工作台）' : ''}`);
  });
  return lines.join('\n');
}

// 怎么获得一个物品：合成 / 熔炼 / 挖方块 / 打生物。
export function howToObtain(registry, itemName) {
  const item = registry.itemsByName[itemName];
  if (!item) return null;
  const lines = [`${itemName}（最多堆叠 ${item.stackSize}${item.maxDurability ? `，耐久 ${item.maxDurability}` : ''}）的获取方式：`];
  const recipes = craftingRecipes(registry, itemName);
  if (recipes.length) {
    const r = recipes[0];
    lines.push(`- 合成：${Object.entries(r.ingredients).map(([n, c]) => `${n}×${c}`).join(' + ')} → ${r.count} 个${r.needsTable ? '（需要工作台）' : ''}${recipes.length > 1 ? `（还有 ${recipes.length - 1} 种配方）` : ''}`);
  }
  if (SMELT_FROM[itemName]) lines.push(`- 熔炼：${SMELT_FROM[itemName].join(' / ')}`);
  const blocks = registry.blocksArray.filter((b) => b.drops?.includes(item.id) && b.name !== itemName).map((b) => b.name);
  const self = registry.blocksByName[itemName];
  if (self?.drops?.includes(item.id)) blocks.unshift(itemName);
  if (blocks.length) {
    const tool = blockToolText(registry, registry.blocksByName[blocks[0]]);
    lines.push(`- 挖掘：${blocks.slice(0, 6).join('、')}${blocks.length > 6 ? ' 等' : ''}${tool ? `（${tool}）` : ''}`);
  }
  if (MOB_DROPS[itemName]) lines.push(`- 生物掉落：${MOB_DROPS[itemName].join('、')}`);
  if (lines.length === 1) lines.push('- 没有找到常规来源（可能要通过交易、钓鱼、宝箱或特殊方式获得，可以查 Wiki）');
  return lines.join('\n');
}

function blockToolText(registry, block) {
  if (!block) return null;
  if (!block.harvestTools) return block.diggable === false ? '挖不动' : '空手也能挖';
  const tools = Object.keys(block.harvestTools).map((id) => registry.items[id]?.name).filter(Boolean);
  const lowest = tools.find((t) => t.startsWith('wooden_')) ?? tools.find((t) => t.startsWith('stone_')) ?? tools.find((t) => t.startsWith('iron_')) ?? tools[0];
  return `至少需要 ${lowest}`;
}

export function blockInfo(registry, name) {
  const b = registry.blocksByName[name];
  if (!b) return null;
  const drops = (b.drops ?? []).map((id) => nameOf(registry, id));
  return [
    `方块 ${b.name}：硬度 ${b.hardness ?? '无法破坏'}，爆炸抗性 ${b.resistance ?? '?'}，${blockToolText(registry, b)}`,
    `掉落：${drops.length ? drops.join('、') : '无（或需要精准采集）'}；${b.transparent ? '透明' : '不透明'}${b.emitLight ? `，发光 ${b.emitLight}` : ''}；最多堆叠 ${b.stackSize}`,
  ].join('\n');
}

export function foodInfo(registry, name) {
  const f = registry.foodsByName?.[name];
  if (!f) return null;
  return `食物 ${name}：恢复 ${f.foodPoints} 点饥饿值，饱和度 ${f.saturation}`;
}

export function mobInfo(registry, name) {
  const e = registry.entitiesByName[name];
  if (!e) return null;
  const drops = Object.entries(MOB_DROPS).filter(([, mobs]) => mobs.some((m) => m.startsWith(name))).map(([item]) => item);
  return `生物 ${name}：类别 ${e.category ?? e.type}，大小 ${e.width}×${e.height}${drops.length ? `，常见掉落 ${drops.join('、')}` : ''}`;
}
