// 不用大脑的查询：最近的结构、生物群系在哪（游戏自带的 /locate），史莱姆区块（按世界种子本地算，和游戏里的算法一样）。
// 结果附 Chunkbase 地图链接（只是给人看地图用；Chunkbase 没有公开接口，不去抓它的网页）。
// 快捷命令 #找、#史莱姆 用它；聊天里直接问“最近的海底神殿在哪”“这是不是史莱姆区块”也会先走这里，四种大脑模式都能用。
import { chunkbaseLink, worldSeed } from './actions.js';
import { sendPanel } from './ui.js';

// 中文叫法 → /locate 用的 ID（# 开头是标签：一类结构的好几种变体）
export const PLACES = [
  // 结构
  ['structure', '#village', ['村庄', '村子', '村落']],
  ['structure', 'monument', ['海底神殿', '海洋神殿', '海底遗迹神殿']],
  ['structure', 'mansion', ['林地府邸', '林地大厦', '府邸']],
  ['structure', 'stronghold', ['末地要塞', '要塞']],
  ['structure', 'desert_pyramid', ['沙漠神殿', '沙漠金字塔']],
  ['structure', 'jungle_pyramid', ['丛林神庙', '丛林神殿']],
  ['structure', 'swamp_hut', ['女巫小屋', '沼泽小屋', '女巫屋']],
  ['structure', 'igloo', ['雪屋', '冰屋']],
  ['structure', 'pillager_outpost', ['掠夺者前哨站', '前哨站']],
  ['structure', '#shipwreck', ['沉船']],
  ['structure', '#ocean_ruin', ['海底废墟', '海底遗迹']],
  ['structure', '#mineshaft', ['废弃矿井', '矿井']],
  ['structure', 'ancient_city', ['远古城市', '古城']],
  ['structure', 'trial_chambers', ['试炼密室', '试炼大厅']],
  ['structure', '#ruined_portal', ['废弃传送门', '破损传送门', '损坏的传送门']],
  ['structure', 'fortress', ['下界要塞', '地狱要塞']],
  ['structure', 'bastion_remnant', ['堡垒遗迹', '猪灵堡垒']],
  ['structure', 'end_city', ['末地城', '末影城']],
  ['structure', 'trail_ruins', ['小径废墟', '古迹废墟']],
  ['structure', 'buried_treasure', ['埋藏的宝藏', '埋藏宝藏', '藏宝点']],
  // 生物群系
  ['biome', 'cherry_grove', ['樱花树林', '樱花林', '樱花']],
  ['biome', 'mushroom_fields', ['蘑菇岛', '蘑菇平原']],
  ['biome', 'badlands', ['恶地', '平顶山', '荒地']],
  ['biome', 'ice_spikes', ['冰刺平原', '冰刺']],
  ['biome', 'bamboo_jungle', ['竹林']],
  ['biome', 'jungle', ['丛林']],
  ['biome', 'desert', ['沙漠']],
  ['biome', 'lush_caves', ['繁茂洞穴']],
  ['biome', 'dripstone_caves', ['溶洞', '滴水石洞穴']],
  ['biome', 'deep_dark', ['深暗之域']],
  ['biome', 'mangrove_swamp', ['红树林沼泽', '红树林']],
  ['biome', 'dark_forest', ['黑森林', '暗森林']],
  ['biome', 'pale_garden', ['苍白之园']],
  ['biome', 'flower_forest', ['繁花森林', '花林']],
  ['biome', 'sunflower_plains', ['向日葵平原']],
  ['biome', 'snowy_plains', ['雪原', '雪地']],
  ['biome', 'meadow', ['草甸']],
  ['biome', 'savanna', ['热带草原', '稀树草原']],
  ['biome', 'warm_ocean', ['暖水海洋', '珊瑚礁', '珊瑚']],
  ['biome', 'swamp', ['沼泽']],
  ['biome', 'ocean', ['海洋', '大海']],
].map(([kind, id, names]) => ({ kind, id, names, name: names[0] }));

// 话里提到的地方（叫法最长的优先：“下界要塞”不会被当成“要塞”，“竹林”不会被当成“丛林”）；也认英文 ID
export function matchPlace(text) {
  const t = String(text ?? '');
  const id = t.trim().toLowerCase().replace(/^#?(minecraft:)?/, '');
  const exact = PLACES.find((p) => p.id.replace('#', '') === id);
  if (exact) return exact;
  let best = null;
  for (const p of PLACES) {
    for (const n of p.names) {
      if (t.includes(n) && (!best || n.length > best.len)) best = { place: p, len: n.length };
    }
  }
  return best?.place ?? null;
}

// 标签找到的具体是哪种
const VARIANTS = {
  village_plains: '平原村庄', village_desert: '沙漠村庄', village_savanna: '热带草原村庄', village_snowy: '雪原村庄', village_taiga: '针叶林村庄',
  shipwreck_beached: '搁浅的', mineshaft_mesa: '恶地里的', ocean_ruin_cold: '冷水的', ocean_ruin_warm: '暖水的',
};

const ASK_WHERE = /(在哪|哪里|哪儿|哪有|有没有|坐标|位置|怎么走|怎么去|多远|哪边|方向)/;
// 要她做事的（带路、传送过去…）交给大脑
const DO_IT = /(带我|带路|领我|陪我|传送|tp|一起去|飞过去|走过去|去那)/i;

// 聊天里的话是不是在问这些（不用大脑直接答）：“最近的海底神殿在哪”“附近哪有樱花林”“这里是史莱姆区块吗”
export function builtinQuery(text) {
  const t = String(text ?? '');
  if (DO_IT.test(t)) return null;
  if (/史莱姆区块|史莱姆.{0,6}区块|slime\s*chunks?/i.test(t) || (/史莱姆/.test(t) && /(刷|生成|哪里有|哪有|哪儿有|在哪)/.test(t))) return { type: 'slime' };
  const place = matchPlace(t);
  if (place && ASK_WHERE.test(t)) return { type: 'locate', place };
  return null;
}

// 从 (px, pz) 看 (x, z) 在哪个方向（x 往东变大，z 往南变大）
export function direction(px, pz, x, z) {
  const deg = (Math.atan2(z - pz, x - px) * 180) / Math.PI;
  const names = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
  return names[((Math.round(deg / 45) % 8) + 8) % 8];
}

// ── 史莱姆区块：和 Java 版一模一样的算法（java.util.Random，int 乘法溢出照样截断） ──
const MASK48 = (1n << 48n) - 1n;
const MULT = 0x5DEECE66Dn;
const toLong = (int32) => BigInt.asIntN(64, BigInt(int32));

export function isSlimeChunk(seed, cx, cz) {
  const s = BigInt.asIntN(64, BigInt(seed)
    + toLong(Math.imul(Math.imul(cx, cx), 0x4c1906))
    + toLong(Math.imul(cx, 0x5ac0db))
    + BigInt.asIntN(64, toLong(Math.imul(cz, cz)) * 0x4307a7n)
    + toLong(Math.imul(cz, 0x5f24f))) ^ 0x3ad8025fn;
  // new Random(s).nextInt(10)
  let state = (BigInt.asUintN(64, s) ^ MULT) & MASK48;
  for (;;) {
    state = (state * MULT + 0xBn) & MASK48;
    const bits = Number(state >> 17n); // next(31)
    const val = bits % 10;
    if (bits - val + 9 < 2 ** 31) return val === 0;
  }
}

// 附近 radius 个区块以内的史莱姆区块，按离得远近排
export function slimeChunksNear(seed, x, z, radius = 4) {
  const cx0 = Math.floor(x / 16);
  const cz0 = Math.floor(z / 16);
  const out = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const cx = cx0 + dx;
      const cz = cz0 + dz;
      if (isSlimeChunk(seed, cx, cz)) out.push({ cx, cz, x: cx * 16, z: cz * 16, d: Math.hypot(cx * 16 + 8 - x, cz * 16 + 8 - z) });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

const PLAYER = /^[.\w]{1,16}$/;

// 玩家现在在哪（离得远看不到也能查）：{ x, y, z, dim }
async function playerSpot(agent, name) {
  const bot = agent.bot;
  const here = String(bot.game?.dimension ?? 'overworld').replace(/^minecraft:/, '');
  const e = bot.players?.[name]?.entity;
  if (e) return { x: e.position.x, y: e.position.y, z: e.position.z, dim: here };
  if (agent.identity.opLevel < 2 || !PLAYER.test(name)) return null;
  const ask = async (what, done) => (await agent.chat.capture(async () => bot.chat(`/data get entity ${name} ${what}`), 1500, (t) => done.test(t)).catch(() => [])).join(' ');
  const pos = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(await ask('Pos', /\[-?[\d.]+d,/));
  if (!pos) return null;
  const dim = /"minecraft:([a-z_]+)"/.exec(await ask('Dimension', /"minecraft:[a-z_]+"/))?.[1] ?? here;
  return { x: Number(pos[1]), y: Number(pos[2]), z: Number(pos[3]), dim };
}

const place = (p) => ({ text: p, color: 'aqua' });
const plain = (t) => ({ text: t, color: 'white' });
const gray = (t) => ({ text: t, color: 'gray' });
const mapLink = (url, label = '[打开地图]') => ({ text: label, color: 'aqua', underlined: true, url, hover: '在浏览器里打开 Chunkbase 地图' });

// 最近的 place 在哪：以玩家为中心 /locate（玩家名不像正常名字就以她自己为中心），返回聊天面板的几行
export async function locateFor(agent, player, target) {
  if (agent.identity.opLevel < 2) return [[gray('我还没有管理员权限，查不了（要用 /locate）。先给我 /op 吧喵')]];
  const id = target.id.startsWith('#') ? `#minecraft:${target.id.slice(1)}` : `minecraft:${target.id}`;
  const cmd = PLAYER.test(player) ? `execute as ${player} at ${player} run locate ${target.kind} ${id}` : `locate ${target.kind} ${id}`;
  const replies = await agent.chat.capture(async () => agent.bot.chat(`/${cmd}`), 10_000, (t) => /\[\s*-?\d+\s*,|Could not find|There is no/.test(t));
  const line = replies.find((r) => /\[\s*-?\d+\s*,/.test(r));
  if (!line) return [[gray(`附近没找到${target.name}（太远了，或者这个维度里没有）`)]];
  const m = /\[\s*(-?\d+)\s*,\s*(~|-?\d+)\s*,\s*(-?\d+)\s*\]/.exec(line);
  const [x, y, z] = [Number(m[1]), m[2], Number(m[3])];
  const kind = VARIANTS[/\(minecraft:([a-z_]+)\)/.exec(line)?.[1]];
  const me = PLAYER.test(player) ? await playerSpot(agent, player) : null;
  const far = Number(/\((\d+)[^)]*\)/.exec(line)?.[1] ?? (me ? Math.round(Math.hypot(x - me.x, z - me.z)) : NaN));
  const dir = me ? direction(me.x, me.z, x, z) : null;
  const link = await chunkbaseLink(agent, x, z, me?.dim).catch(() => null);
  return [
    [plain('离你最近的'), place(kind && !kind.endsWith('的') ? kind : `${kind ?? ''}${target.name}`), plain(` 在 X=${x}${y !== '~' ? ` Y=${y}` : ''} Z=${z}`)],
    [gray([dir && `${dir}方向`, Number.isFinite(far) && `大约 ${far} 格`].filter(Boolean).join('，')), ...(link ? [gray('  '), mapLink(link)] : [])],
  ];
}

// 史莱姆区块：玩家脚下这个区块是不是，附近还有哪些
export async function slimeFor(agent, player) {
  const seed = await worldSeed(agent);
  if (!seed) return [[gray('我不知道这个世界的种子（要有管理员权限用 /seed 查）。先给我 /op 吧喵')]];
  const me = await playerSpot(agent, player);
  if (!me) return [[gray('没查到你现在在哪')]];
  if (me.dim !== 'overworld') return [[gray('史莱姆区块只在主世界有')]];
  const cx = Math.floor(me.x / 16);
  const cz = Math.floor(me.z / 16);
  const here = isSlimeChunk(seed, cx, cz);
  const near = slimeChunksNear(seed, me.x, me.z, 4).filter((c) => !(c.cx === cx && c.cz === cz)).slice(0, 4);
  const link = `https://www.chunkbase.com/apps/slime-finder#seed=${seed}&platform=java&x=${Math.round(me.x)}&z=${Math.round(me.z)}&zoom=1`;
  return [
    [plain('你脚下这个区块（'), place(`X ${cx * 16}～${cx * 16 + 15}，Z ${cz * 16}～${cz * 16 + 15}`), plain(here ? '）是史莱姆区块！' : '）不是史莱姆区块')],
    ...(near.length
      ? [[gray('附近的：')], ...near.map((c) => [gray('  '), place(`X ${c.x}～${c.x + 15}，Z ${c.z}～${c.z + 15}`), gray(`（${direction(me.x, me.z, c.x + 8, c.z + 8)}边约 ${Math.round(c.d)} 格）`)])]
      : [[gray('附近 4 个区块以内没有别的史莱姆区块')]]),
    [gray('史莱姆在这些区块的 Y=40 以下刷（不看亮度）  '), mapLink(link, '[史莱姆区块地图]')],
  ];
}

// 聊天里直接问的：查完发面板给他
export async function answerBuiltin(agent, from, q) {
  const lines = q.type === 'slime' ? await slimeFor(agent, from) : await locateFor(agent, from, q.place);
  sendPanel(agent, from, lines);
}
