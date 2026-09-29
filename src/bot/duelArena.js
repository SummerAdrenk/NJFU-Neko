// 决斗场：空中的黑曜石平台，100×100，每隔 6 行铺一整条哭泣黑曜石（自带亮光，整夜都亮，不刷怪），
// 四面用看不见的屏障墙围起来，一直砌到世界建筑上限（y=319），头顶不封：被击退也掉不下去，飞多高都行。
// 位置：决斗的地方正上方（默认）或家正上方，y=200 起。
// 每次开打前现搭、打完拆掉：一直留着的话，100×100 的平台会挡住下面的阳光，家里会变暗、白天也刷怪。
// 不覆盖任何方块：搭之前把整片地方（地板、四面墙的位置、里面一直到 y=319）扫一遍，全是空气才搭；
// 有东西就往上抬 30 格再看，还不行就不搭（就地打）。因为搭之前那里全是空气，拆的时候直接填回空气就是原样。
// fill 只能改已经加载的区块：离得远（或者不在主世界）时，她先带着缓降传送到建筑上限上面悬着，等那边的区块加载出来再搭。
import { Vec3 } from './helpers.js';
import { sleep } from '../util.js';

// half：地板从中心往两边各 50 格（100×100）；floorY：地板最低的高度；top：墙砌到的高度；rows：哭泣黑曜石每隔几行一条；
// above：比家（或决斗的地方）至少高多少；step：有东西挡着时每次往上抬多少；hoverY：她悬着等区块加载的高度（建筑上限以上）
export const ARENA = { half: 50, floorY: 200, top: 319, rows: 6, above: 40, step: 30, hoverY: 325 };
const OW = 'execute in minecraft:overworld run ';
const AIR = ['air', 'cave_air', 'void_air'];

// 决斗场设置的值（#设置 决斗场、#决斗 困难Ⅲ 家上空）→ here / home / off
export const ARENA_OPTIONS = { here: '原地上空', home: '家上空', off: '不用' };
export function arenaMode(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (/^(原地|原地上空|原地上方|就地|就地上空|就地上方|这里|这儿|这里上空|here)$/.test(s)) return 'here';
  if (/^(家|家上空|家上方|家正上方|home)$/.test(s)) return 'home';
  if (/^(不用|不要|就地打|原地打|关|off|none)$/.test(s)) return 'off';
  return null;
}

// 地板范围：x、z 都是 [中心-50, 中心+49]；墙在外面一圈
const minX = (a) => a.x - ARENA.half;
const maxX = (a) => a.x + ARENA.half - 1;
const minZ = (a) => a.z - ARENA.half;
const maxZ = (a) => a.z + ARENA.half - 1;

// 地板可以放在哪几个高度：比 base 高至少 40 格、不低于 y=200，每次往上 30 格，最高 y=289（上面至少留 30 格）
export function arenaHeights(baseY) {
  const first = Math.max(ARENA.floorY, Math.floor(baseY) + ARENA.above);
  return [0, 1, 2].map((i) => first + i * ARENA.step).filter((y) => y <= ARENA.top - 30);
}

// 两个座位：中心南北两边，相距 20 格，面对面（/tp 的朝向：0 朝南，180 朝北）。第一个给对手，第二个给她
export function arenaSeats(a) {
  return [
    { x: a.x + 0.5, y: a.y + 1, z: a.z - 9.5, yaw: 0 },
    { x: a.x + 0.5, y: a.y + 1, z: a.z + 10.5, yaw: 180 },
  ];
}

export function inArena(a, pos) {
  return pos.x >= minX(a) && pos.x < maxX(a) + 1 && pos.z >= minZ(a) && pos.z < maxZ(a) + 1 && pos.y >= a.y && pos.y <= ARENA.top + 10;
}

// 搭：先墙后地板，都只填空气的位置（replace air），万一哪里冒出个方块也不会被盖掉；哭泣黑曜石那几行先铺
function buildCommands(a) {
  const [x1, x2, z1, z2, y1, y2] = [minX(a) - 1, maxX(a) + 1, minZ(a) - 1, maxZ(a) + 1, a.y, ARENA.top];
  const cmds = [
    `${OW}fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z1} barrier replace air`,
    `${OW}fill ${x1} ${y1} ${z2} ${x2} ${y2} ${z2} barrier replace air`,
    `${OW}fill ${x1} ${y1} ${z1} ${x1} ${y2} ${z2} barrier replace air`,
    `${OW}fill ${x2} ${y1} ${z1} ${x2} ${y2} ${z2} barrier replace air`,
  ];
  for (let z = minZ(a) + 2; z <= maxZ(a); z += ARENA.rows) cmds.push(`${OW}fill ${minX(a)} ${a.y} ${z} ${maxX(a)} ${a.y} ${z} crying_obsidian replace air`);
  cmds.push(`${OW}fill ${minX(a)} ${a.y} ${minZ(a)} ${maxX(a)} ${a.y} ${maxZ(a)} obsidian replace air`);
  return cmds;
}

const inOverworld = (bot) => /overworld/.test(String(bot.game?.dimension ?? ''));

// 检查用的点：地板中心和四个角；四面墙的中间（离地板 2 格高）
function probes(a) {
  const floor = [[a.x, a.z], [minX(a), minZ(a)], [maxX(a), minZ(a)], [minX(a), maxZ(a)], [maxX(a), maxZ(a)]].map(([x, z]) => new Vec3(x, a.y, z));
  const wall = [[maxX(a) + 1, a.z], [minX(a) - 1, a.z], [a.x, maxZ(a) + 1], [a.x, minZ(a) - 1]].map(([x, z]) => new Vec3(x, a.y + 2, z));
  return { floor, wall };
}

// 这一片的区块她这边都加载出来了（看得见）
export function arenaLoaded(bot, a) {
  if (!inOverworld(bot)) return false;
  const { floor, wall } = probes(a);
  return [...floor, ...wall].every((p) => bot.blockAt(p, false) !== null);
}

export function arenaReady(bot, a) {
  if (!inOverworld(bot)) return false;
  const { floor, wall } = probes(a);
  return floor.every((p) => /obsidian/.test(bot.blockAt(p, false)?.name ?? '')) && wall.every((p) => bot.blockAt(p, false)?.name === 'barrier');
}

function airIds(bot) {
  return new Set(AIR.map((n) => bot.registry.blocksByName[n]?.defaultState).filter((id) => id != null));
}

// 这一片（地板加外面一圈墙的位置）从 fromY 到 y=319 最高的方块在多高：全是空气返回 -Infinity，区块没加载返回 null。
// 每扫一行让一下，别把别的事卡住
export async function highestBlock(bot, a, fromY, signal) {
  const air = airIds(bot);
  const at = new Vec3(0, 0, 0);
  const local = new Vec3(0, 0, 0);
  let top = -Infinity;
  for (let x = minX(a) - 1; x <= maxX(a) + 1; x++) {
    for (let z = minZ(a) - 1; z <= maxZ(a) + 1; z++) {
      at.set(x, fromY, z);
      const col = bot.world.getColumnAt(at);
      if (!col) return null;
      for (let y = ARENA.top; y >= fromY && y > top; y--) {
        local.set(x & 15, y, z & 15);
        if (!air.has(col.getBlockStateId(local))) {
          top = y;
          break;
        }
      }
    }
    await sleep(0, signal);
  }
  return top;
}

// 打完场地里（墙以内、地板以上）还有东西的那几层，合成每 3 层一段：[[y1, y2], …]；区块没加载返回 null
async function debrisSlabs(bot, a, signal) {
  const air = airIds(bot);
  const at = new Vec3(0, 0, 0);
  const layers = [];
  for (let y = a.y + 1; y <= ARENA.top; y++) {
    let found = false;
    for (let x = minX(a); x <= maxX(a) && !found; x++) {
      for (let z = minZ(a); z <= maxZ(a); z++) {
        at.set(x, y, z);
        if (!bot.world.getColumnAt(at)) return null;
        if (!air.has(bot.world.getBlockStateId(at))) {
          found = true;
          break;
        }
      }
    }
    if (found) layers.push(y);
    if (y % 8 === 0) await sleep(0, signal);
  }
  const slabs = [];
  for (const y of layers) {
    const last = slabs[slabs.length - 1];
    if (last && y - last[0] < 3) last[1] = y;
    else slabs.push([y, y]);
  }
  return slabs;
}

export async function buildArena(agent, a, { gap = 100, settle = 1500, signal } = {}) {
  for (const c of buildCommands(a)) {
    agent.adminCommand(c);
    if (gap) await sleep(gap, signal);
  }
  if (settle) await sleep(settle, signal);
}

// 拆：掉落物、箭、没炸的水晶和 TNT 先清掉（不然地板一拆全掉到下面去），再清场地里打斗留下的东西（蜘蛛网、水、岩浆、火、放的方块），
// 最后拆墙和地板。搭之前确认过这一片全是空气，所以直接填空气就是原样。返回拆干净了没有（区块没加载时拆不了）
export async function removeArena(agent, a, { gap = 80, settle = 800, signal } = {}) {
  const bot = agent.bot;
  const slabs = bot ? await debrisSlabs(bot, a, signal) : [];
  if (slabs === null) return false;
  const box = `x=${minX(a) - 1},y=${a.y - 1},z=${minZ(a) - 1},dx=${2 * ARENA.half + 2},dy=${ARENA.top - a.y + 2},dz=${2 * ARENA.half + 2}`;
  const [x1, x2, z1, z2, y1, y2] = [minX(a) - 1, maxX(a) + 1, minZ(a) - 1, maxZ(a) + 1, a.y, ARENA.top];
  const cmds = [
    ...['item', 'arrow', 'spectral_arrow', 'end_crystal', 'tnt', 'experience_orb'].map((t) => `${OW}kill @e[type=minecraft:${t},${box}]`),
    ...slabs.map(([s1, s2]) => `${OW}fill ${minX(a)} ${s1} ${minZ(a)} ${maxX(a)} ${s2} ${maxZ(a)} air`),
    `${OW}fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z1} air`,
    `${OW}fill ${x1} ${y1} ${z2} ${x2} ${y2} ${z2} air`,
    `${OW}fill ${x1} ${y1} ${z1} ${x1} ${y2} ${z2} air`,
    `${OW}fill ${x2} ${y1} ${z1} ${x2} ${y2} ${z2} air`,
    `${OW}fill ${minX(a)} ${a.y} ${minZ(a)} ${maxX(a)} ${a.y} ${maxZ(a)} air`,
  ];
  for (const c of cmds) {
    agent.adminCommand(c);
    if (gap) await sleep(gap, signal);
  }
  if (settle) await sleep(settle, signal);
  return !bot || !probes(a).floor.some((p) => /obsidian/.test(bot.blockAt(p, false)?.name ?? ''));
}

async function waitUntil(fn, ms, signal) {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await sleep(100, signal);
  }
}

// 悬在 spot 正上方、建筑上限以上（带缓降，每 1.5 秒拉回去一次），等那边的区块加载出来
function startHover(agent, spot) {
  const bot = agent.bot;
  const tp = () => agent.adminCommand(`${OW}tp ${bot.username} ${spot.x} ${ARENA.hoverY} ${spot.z}`);
  agent.adminCommand(`effect give ${bot.username} minecraft:slow_falling 60 0 true`);
  tp();
  const timer = setInterval(() => {
    if (agent.bot === bot && agent.online) tp();
  }, 1500);
  return { stop: () => clearInterval(timer) };
}

// 决斗前搭决斗场。mode：here 决斗的地方（fallback：对手的位置）正上方 / home 家正上方 / off 不用。
// 返回 { arena }（她可能还悬在上面，调用方接着把两人传送到座位上，再解除缓降）；
// 搭不了返回 { arena: null, why }（悬过的话已经送她回 back 了），off 返回 { arena: null, why: null }。
// 中途被打断（决斗取消）时：搭了一半的拆掉、悬着的送回去，再把中断往外抛
export async function prepareArena(agent, { mode = 'here', fallback = null, back = null, signal, onLift } = {}) {
  const bot = agent.bot;
  if (mode === 'off') return { arena: null, why: null };
  const ow = inOverworld(bot);
  const base = mode === 'home' ? (agent.homeBed ?? (ow ? fallback : null)) : (ow ? fallback : null);
  if (!base) return { arena: null, why: mode === 'here' ? '不在主世界，没法在这里上方搭决斗场' : '还不知道家在哪' };
  const where = mode === 'home' && agent.homeBed ? '家' : '这里';
  const heights = arenaHeights(base.y);
  if (!heights.length) return { arena: null, why: `${where}太高了，上面放不下决斗场` };
  const probe = { x: Math.floor(base.x), y: heights[0], z: Math.floor(base.z) };
  const near = ow && Math.hypot(bot.entity.position.x - probe.x, bot.entity.position.z - probe.z) <= 40;
  let hover = null;
  let started = null;
  let arena = null;
  let why = null;
  try {
    if (!near || !(await waitUntil(() => arenaLoaded(bot, probe), 3000, signal))) {
      onLift?.();
      hover = startHover(agent, arenaSeats(probe)[1]);
      if (!(await waitUntil(() => arenaLoaded(bot, probe), 20_000, signal))) why = `${where}那边的区块没加载出来`;
    }
    if (!why) {
      const top = await highestBlock(bot, probe, heights[0], signal);
      const y = top === null ? null : heights.find((h) => h > top);
      if (top === null) why = `${where}那边的区块没加载出来`;
      else if (y == null) why = `${where}正上方 y=${heights[0]}～${ARENA.top} 有别的方块（山或者建筑），搭了会盖住，这次不搭`;
      else {
        started = { x: probe.x, y, z: probe.z, kind: mode };
        await buildArena(agent, started, { signal });
        if (await waitUntil(() => arenaReady(bot, started), 3000, signal)) arena = started;
        else why = '决斗场没搭起来';
      }
    }
  } finally {
    hover?.stop();
    // 没搭成（或者被打断）：搭了一半的拆掉（刚扫过，那里原来全是空气）；悬着的送回去
    if (!arena && started) await removeArena(agent, started).catch(() => {});
    if (!arena && hover) {
      if (back) agent.adminCommand(`execute in ${back.dim} run tp ${bot.username} ${back.x} ${back.y} ${back.z}`);
      agent.adminCommand(`effect clear ${bot.username} minecraft:slow_falling`);
    }
  }
  return arena ? { arena } : { arena: null, why };
}
