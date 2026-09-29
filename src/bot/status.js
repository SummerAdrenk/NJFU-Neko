// 汇总猫娘当前的状态，给大脑和命令行查看。
import { fmtPos, round1 } from '../util.js';
import { entityLabel, isHostile, summarizeItems } from './helpers.js';

const DIMENSIONS = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
const GAME_MODES = { survival: '生存', creative: '创造', adventure: '冒险', spectator: '旁观' };

function clockOf(timeOfDay) {
  const minutes = Math.floor(((timeOfDay + 6000) % 24000) * 0.06);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function snapshot(agent) {
  const bot = agent.bot;
  const task = agent.tasks.info();
  if (!agent.online || !bot?.entity) return { online: false, task, target: agent.target?.label ?? null };
  const pos = bot.entity.position;
  const dim = String(bot.game?.dimension ?? '').replace(/^minecraft:/, '');
  const slot = (dest) => bot.inventory.slots[bot.getEquipmentDestSlot(dest)]?.name ?? null;
  const players = Object.values(bot.players)
    .filter((p) => p.username !== bot.username)
    .map((p) => ({
      name: p.username,
      distance: p.entity ? round1(p.entity.position.distanceTo(pos)) : null,
      position: p.entity ? fmtPos(p.entity.position) : null,
      owner: agent.chat.isOwner(p.username),
    }));
  const nearby = new Map();
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || e.type === 'player' || !e.position) continue;
    const d = e.position.distanceTo(pos);
    if (d > 24) continue;
    const label = e.name === 'item' ? '掉落物' : entityLabel(e);
    const entry = nearby.get(label) ?? { name: label, count: 0, nearest: Infinity, hostile: isHostile(e) };
    entry.count += 1;
    entry.nearest = Math.min(entry.nearest, round1(d));
    nearby.set(label, entry);
  }
  let biome = null;
  try {
    biome = bot.blockAt(pos)?.biome?.name ?? null;
  } catch {
    biome = null;
  }
  return {
    online: true,
    server: agent.target?.label ?? null,
    serverVersion: agent.target?.serverVersion ?? null,
    username: bot.username,
    displayName: agent.cfg.identity.display_name,
    opLevel: agent.identity.opLevel,
    health: round1(bot.health),
    food: bot.food,
    saturation: round1(bot.foodSaturation ?? 0),
    xpLevel: bot.experience?.level ?? 0,
    position: fmtPos(pos),
    coords: { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) },
    dimension: DIMENSIONS[dim] ?? dim,
    biome,
    day: Math.floor((bot.time?.age ?? 0) / 24000) + 1,
    clock: clockOf(bot.time?.timeOfDay ?? 0),
    isDay: bot.time?.isDay ?? true,
    weather: bot.thunderState > 0 ? '雷雨' : bot.isRaining ? '下雨' : '晴',
    gameMode: GAME_MODES[bot.game?.gameMode] ?? bot.game?.gameMode,
    held: bot.heldItem?.name ?? null,
    offhand: slot('off-hand'),
    armor: ['head', 'torso', 'legs', 'feet'].map(slot).filter(Boolean),
    inventory: summarizeItems(bot.inventory.items()),
    freeSlots: bot.inventory.emptySlotCount(),
    players,
    entities: [...nearby.values()].sort((a, b) => a.nearest - b.nearest).slice(0, 12),
    task,
    lastDeath: agent.lastDeath ?? null,
  };
}

export function describeStatus(agent) {
  const s = snapshot(agent);
  if (!s.online) {
    return `未连接服务器${s.target ? `（目标 ${s.target}）` : ''}，正在等待重连。`;
  }
  const lines = [
    `生命 ${s.health}/20 · 饥饿 ${s.food}/20 · 经验 ${s.xpLevel} 级 · ${s.gameMode}模式 · 管理员权限 ${s.opLevel >= 2 ? `有（${s.opLevel} 级）` : '无'}`,
    `位置 ${s.position} · ${s.dimension}${s.biome ? ` · ${s.biome}` : ''} · 第 ${s.day} 天 ${s.clock}（${s.isDay ? '白天' : '夜晚'}）· ${s.weather}`,
    `手持 ${s.held ?? '空手'} · 副手 ${s.offhand ?? '空'} · 盔甲 ${s.armor.length ? s.armor.join(', ') : '无'}`,
    `背包（空 ${s.freeSlots} 格）：${s.inventory}`,
    `当前任务：${s.task ? `#${s.task.id} ${s.task.desc}（已进行 ${s.task.seconds} 秒）` : '无'}`,
    `在线玩家：${s.players.length ? s.players.map((p) => `${p.name}${p.owner ? '（主人）' : ''}${p.distance != null ? ` ${p.distance}格 ${p.position}` : ' 不在视野内'}`).join('；') : '只有你自己'}`,
    `附近 24 格：${s.entities.length ? s.entities.map((e) => `${e.name}${e.count > 1 ? `×${e.count}` : ''}${e.hostile ? '(敌对)' : ''} ${e.nearest}格`).join('，') : '没有生物'}`,
  ];
  if (s.lastDeath) lines.push(`上次死亡：${s.lastDeath.position}`);
  return lines.join('\n');
}
