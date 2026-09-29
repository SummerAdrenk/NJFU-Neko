// 红石与建造：读取区域内方块的完整状态（用于排查红石机器），按方块状态建造。
// 建造有两种方式：
//   command  用 /setblock 精确放置（需要管理员权限和命令许可），朝向、延迟等状态完全准确；
//   survival 用背包里的材料亲手放置，会按朝向规则调整视角，放完后校验朝向。
import { goals } from './createBot.js';
import { findItem, gotoGoal, isEmpty, Vec3 } from './helpers.js';
import { abortError, fmtPos, sleep } from '../util.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const REDSTONE = /redstone|repeater|comparator|observer|piston|lever|button|pressure_plate|hopper|dropper|dispenser|note_block|target|daylight_detector|tripwire|lectern|sculk_sensor|trapped_chest|rail|_door|trapdoor|fence_gate|lamp|tnt|bell|copper_bulb|crafter|slime_block|honey_block|jukebox|chiseled_bookshelf|comparator|lightning_rod/;

// 旧版原理图里的方块名 → 新名字
const RENAMED = { grass: 'short_grass', grass_path: 'dirt_path', sign: 'oak_sign', wall_sign: 'oak_wall_sign', chain: 'iron_chain' };

// 放置某方块需要的物品
const ITEM_FOR = {
  redstone_wire: 'redstone', wall_torch: 'torch', redstone_wall_torch: 'redstone_torch', soul_wall_torch: 'soul_torch',
  tripwire: 'string', water: 'water_bucket', lava: 'lava_bucket', powder_snow: 'powder_snow_bucket', fire: 'flint_and_steel',
  bamboo_sapling: 'bamboo', sweet_berry_bush: 'sweet_berries', cocoa: 'cocoa_beans', carrots: 'carrot', potatoes: 'potato',
  beetroots: 'beetroot_seeds', wheat: 'wheat_seeds', melon_stem: 'melon_seeds', pumpkin_stem: 'pumpkin_seeds', big_dripleaf_stem: 'big_dripleaf',
};
export function itemForBlock(name) {
  if (ITEM_FOR[name]) return ITEM_FOR[name];
  if (/_wall_sign$/.test(name)) return name.replace('_wall_sign', '_sign');
  if (/_wall_hanging_sign$/.test(name)) return name.replace('_wall_hanging_sign', '_hanging_sign');
  if (/_wall_banner$/.test(name)) return name.replace('_wall_banner', '_banner');
  if (/_wall_(head|skull)$/.test(name)) return name.replace('_wall_', '_');
  if (/^potted_/.test(name)) return 'flower_pot';
  return name;
}

// "minecraft:repeater[facing=north,delay=2]" → { name: 'repeater', props: { facing: 'north', delay: '2' } }
export function parseBlockSpec(spec) {
  const m = /^\s*(?:minecraft:)?([a-z0-9_]+)\s*(?:\[([^\]]*)\])?\s*$/.exec(String(spec).toLowerCase());
  if (!m) throw new Error(`方块写法不对：${spec}（例如 repeater[facing=north,delay=2]）`);
  const props = {};
  for (const pair of (m[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k && v != null) props[k] = v;
  }
  return { name: RENAMED[m[1]] ?? m[1], props };
}

export const specText = ({ name, props }) => {
  const entries = Object.entries(props ?? {});
  return entries.length ? `${name}[${entries.map(([k, v]) => `${k}=${v}`).join(',')}]` : name;
};

// ── 读取区域 ─────────────────────────────────────────────

export function inspectArea(bot, a, b, filter = 'all') {
  const min = new Vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
  const max = new Vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
  const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
  if (volume > 12_000) throw new Error(`区域太大（${volume} 格），一次最多 12000 格，请分块查看`);
  const lines = [];
  const counts = new Map();
  let unloaded = 0;
  for (let y = min.y; y <= max.y; y++) {
    for (let z = min.z; z <= max.z; z++) {
      for (let x = min.x; x <= max.x; x++) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) {
          unloaded += 1;
          continue;
        }
        if (AIR.has(block.name)) continue;
        if (filter === 'redstone' && !REDSTONE.test(block.name)) continue;
        counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
        if (lines.length < 400) lines.push(`(${x},${y},${z}) ${specText({ name: block.name, props: block.getProperties() })}`);
      }
    }
  }
  const summary = [...counts.entries()].sort((p, q) => q[1] - p[1]).map(([n, c]) => `${n}×${c}`).join(', ');
  const head = `区域 ${fmtPos(min)} ~ ${fmtPos(max)}：${filter === 'redstone' ? '红石相关' : '非空气'}方块 ${[...counts.values()].reduce((s, c) => s + c, 0)} 个${unloaded ? `（${unloaded} 格未加载）` : ''}`;
  return [head, `统计：${summary || '无'}`, ...lines, lines.length >= 400 ? '……（只列出前 400 个，请缩小范围）' : ''].filter(Boolean).join('\n');
}

// ── 红石线自动连接（命令模式下 /setblock 不会自动计算连接）──

const DIRS = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const OPPOSITE = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' };
const POWER_COMPONENTS = /^(redstone_torch|redstone_wall_torch|lever|.*_button|.*_pressure_plate|redstone_block|target|daylight_detector|trapped_chest|tripwire_hook|lectern|sculk_sensor|calibrated_sculk_sensor|redstone_wire)$/;

function connectsTo(neighbor, dir) {
  if (!neighbor) return false;
  const { name, props } = neighbor;
  if (POWER_COMPONENTS.test(name)) return true;
  // 中继器/比较器只在输入输出方向连接；侦测器只在背面（输出面）连接
  if (name === 'repeater' || name === 'comparator') return ['north', 'south'].includes(dir) === ['north', 'south'].includes(props.facing);
  if (name === 'observer') return props.facing === dir;
  return false;
}

const solid = (b) => b && !AIR.has(b.name) && !/glass|slab|stairs|leaves|redstone|torch|repeater|comparator|rail|carpet|button|lever|pressure_plate|fence|wall|pane|bars|ladder|door|trapdoor|hopper|piston_head/.test(b.name);

function wireState(get, pos) {
  const sides = {};
  const above = get(pos.offset(0, 1, 0));
  for (const [dir, [dx, , dz]] of Object.entries(DIRS)) {
    const n = pos.offset(dx, 0, dz);
    const nb = get(n);
    if (connectsTo(nb, dir)) sides[dir] = 'side';
    else if (!solid(above) && get(n.offset(0, 1, 0))?.name === 'redstone_wire' && solid(nb)) sides[dir] = 'up';
    else if (!solid(nb) && get(n.offset(0, -1, 0))?.name === 'redstone_wire') sides[dir] = 'side';
    else sides[dir] = 'none';
  }
  const connected = Object.keys(DIRS).filter((d) => sides[d] !== 'none');
  if (connected.length === 0) for (const d of Object.keys(DIRS)) sides[d] = 'side'; // 孤立的红石粉：十字形
  if (connected.length === 1) sides[OPPOSITE[connected[0]]] = 'side'; // 只连一边：延伸成直线
  return sides;
}

// ── 生存模式放置：按朝向规则调整视角 ────────────────────

const YAW = { north: 0, south: Math.PI, west: Math.PI / 2, east: -Math.PI / 2 };
const FACE_VEC = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };

// 返回放置时需要看向的方向（null 表示朝向无所谓/由点击面决定）
function lookDirFor(name, facing) {
  if (!facing) return null;
  if (/^(repeater|comparator|furnace|blast_furnace|smoker|chest|trapped_chest|lectern|.*_bed|loom|stonecutter|beehive|bee_nest|carved_pumpkin|jack_o_lantern|ender_chest|anvil|chipped_anvil|damaged_anvil)$/.test(name)) return OPPOSITE[facing];
  if (/^(piston|sticky_piston|dispenser|dropper|barrel|crafter)$/.test(name)) return OPPOSITE[facing];
  if (/^observer$|_stairs$|_door$|_fence_gate$/.test(name)) return facing;
  return null;
}

async function placeOriented(agent, pos, spec, item, signal) {
  const bot = agent.bot;
  const facing = spec.props.facing;
  let reference = null;
  let face = null;
  // 墙上的火把/告示牌等依附在 facing 反方向的墙上；漏斗朝向由点击的面决定
  if (facing && (/wall_/.test(spec.name) || spec.name === 'hopper' || spec.name === 'lightning_rod' || spec.name === 'end_rod')) {
    const into = spec.name === 'hopper' ? facing : OPPOSITE[facing];
    const [dx, dy, dz] = FACE_VEC[into];
    const ref = bot.blockAt(pos.offset(dx, dy, dz));
    if (ref && ref.boundingBox === 'block') {
      reference = ref;
      face = new Vec3(-dx, -dy, -dz);
    }
  }
  if (!reference) {
    for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const ref = bot.blockAt(pos.offset(dx, dy, dz));
      if (ref && ref.boundingBox === 'block') {
        reference = ref;
        face = new Vec3(-dx, -dy, -dz);
        break;
      }
    }
  }
  if (!reference) throw new Error('旁边没有能依附的方块');
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
    await gotoGoal(agent, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { signal, timeoutMs: 60_000 });
  }
  const feet = bot.entity.position.floored();
  if (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)) {
    await gotoGoal(agent, new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1.5)), { signal, timeoutMs: 15_000 });
  }
  await bot.equip(item, 'hand');
  const look = lookDirFor(spec.name, facing);
  if (look) {
    const pitch = look === 'up' ? Math.PI / 2 : look === 'down' ? -Math.PI / 2 : 0;
    await bot.look(YAW[look] ?? bot.entity.yaw, pitch, true);
    await bot._placeBlockWithOptions(reference, face, { forceLook: 'ignore' });
  } else {
    await bot.placeBlock(reference, face);
  }
}

// ── 建造 ─────────────────────────────────────────────────

// blocks: [{ pos: Vec3, spec: {name, props} }]；返回结果说明。
export async function buildBlocks(agent, blocks, { mode, signal, onProgress } = {}) {
  const bot = agent.bot;
  if (!blocks.length) return '没有要放的方块';
  const planned = new Map(blocks.map((b) => [b.pos.toString(), b.spec]));
  const worldGet = (p) => {
    const s = planned.get(p.toString());
    if (s) return s;
    const b = bot.blockAt(p);
    return b ? { name: b.name, props: b.getProperties() } : null;
  };
  // 先放实心方块，再放依附类/红石元件，红石线最后；同类按高度从下往上
  const rank = (s) => (s.name === 'redstone_wire' ? 3 : /torch|button|lever|pressure_plate|repeater|comparator|rail|carpet|sign|banner|ladder|vine|lantern|door|trapdoor/.test(s.name) ? 2 : 1);
  const order = [...blocks].sort((p, q) => rank(p.spec) - rank(q.spec) || p.pos.y - q.pos.y);

  if (mode === 'command') {
    let done = 0;
    const failures = [];
    for (const b of order) {
      if (signal?.aborted) throw abortError(signal);
      const spec = b.spec.name === 'redstone_wire' && !['north', 'south', 'east', 'west'].some((d) => b.spec.props[d])
        ? { name: 'redstone_wire', props: { ...wireState(worldGet, b.pos), ...b.spec.props } }
        : b.spec;
      const replies = await agent.chat.capture(async () => bot.chat(`/setblock ${b.pos.x} ${b.pos.y} ${b.pos.z} minecraft:${specText(spec)} replace`), done % 25 === 24 ? 250 : 40);
      const bad = replies.find((r) => /Could not|Unknown|Incorrect|Invalid|Expected|无法|未知|错误/i.test(r));
      if (bad) failures.push(`${fmtPos(b.pos)} ${specText(spec)}：${bad}`);
      done += 1;
      if (onProgress && done % 200 === 0) onProgress(done, order.length);
    }
    return `用命令放置了 ${done - failures.length}/${order.length} 个方块${failures.length ? `；${failures.length} 个失败：${failures.slice(0, 5).join('；')}` : ''}`;
  }

  // 生存模式
  const missing = new Map();
  const wrong = [];
  let placed = 0;
  for (const b of order) {
    if (signal?.aborted) throw abortError(signal);
    const current = bot.blockAt(b.pos);
    if (current && current.name === b.spec.name) continue;
    if (current && !isEmpty(current) && !['water', 'lava'].includes(current.name)) {
      wrong.push(`${fmtPos(b.pos)} 已经有 ${current.name}`);
      continue;
    }
    const itemName = itemForBlock(b.spec.name);
    const item = findItem(bot, itemName);
    if (!item) {
      missing.set(itemName, (missing.get(itemName) ?? 0) + 1);
      continue;
    }
    try {
      await placeOriented(agent, b.pos, b.spec, item, signal);
      placed += 1;
      const now = bot.blockAt(b.pos);
      if (b.spec.props.facing && now?.getProperties().facing && now.getProperties().facing !== b.spec.props.facing) {
        wrong.push(`${fmtPos(b.pos)} ${b.spec.name} 朝向是 ${now.getProperties().facing}，应为 ${b.spec.props.facing}`);
      }
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      wrong.push(`${fmtPos(b.pos)} ${b.spec.name}：${err.message}`);
    }
    await sleep(120, signal);
  }
  const parts = [`亲手放置了 ${placed}/${order.length} 个方块`];
  if (missing.size) parts.push(`缺材料：${[...missing.entries()].map(([n, c]) => `${n}×${c}`).join('、')}`);
  if (wrong.length) parts.push(`问题：${wrong.slice(0, 6).join('；')}${wrong.length > 6 ? ` 等 ${wrong.length} 处` : ''}`);
  return parts.join('；');
}
