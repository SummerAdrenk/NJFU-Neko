// 准心对准猫娘：在对方屏幕下方的动作栏显示她的状态和背包；蹲下再看会私聊完整背包清单。
// 动作栏要用 /title 命令，需要 ui.quiet_admin_commands（关掉“管理员命令广播”）才不会刷屏；
// 没开的话只有“蹲下+看着她”时私聊一条（/tellraw 本身不会广播）。

import { sendChatInventory } from './inventoryView.js';

const PLAYER_EYE = 1.62;

function viewDirection(pitch, yaw) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

// 射线与轴对齐包围盒求交（slab 算法）。
function rayHitsBox(origin, dir, min, max, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(dir[axis]) < 1e-9) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return false;
      continue;
    }
    let t1 = (min[axis] - origin[axis]) / dir[axis];
    let t2 = (max[axis] - origin[axis]) / dir[axis];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

export function isLookingAt(viewer, target, maxDist) {
  const eye = viewer.position.offset(0, viewer.eyeHeight ?? PLAYER_EYE, 0);
  const dir = viewDirection(viewer.pitch, viewer.headYaw ?? viewer.yaw);
  const p = target.position;
  const pad = 0.15;
  return rayHitsBox(eye, dir, { x: p.x - 0.3 - pad, y: p.y - pad, z: p.z - 0.3 - pad }, { x: p.x + 0.3 + pad, y: p.y + 1.8 + pad, z: p.z + 0.3 + pad }, maxDist);
}

export function installGaze(agent, bot) {
  const ui = agent.cfg.ui;
  if (!ui.gaze) return;
  const lastBar = new Map();
  const lastFull = new Map();
  const itemText = (name) => ({ translate: `${bot.registry.blocksByName[name] ? 'block' : 'item'}.minecraft.${name}`, fallback: name });

  function topItems(limit) {
    const totals = new Map();
    for (const i of bot.inventory.items()) totals.set(i.name, (totals.get(i.name) ?? 0) + i.count);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  function actionBar(player) {
    const love = agent.affection.get(player, agent.chat.isOwner(player));
    const parts = ['', { text: `${agent.cfg.identity.display_name} `, color: agent.cfg.identity.name_color },
      { text: `生命 ${Math.round(bot.health)}  饥饿 ${bot.food}`, color: 'white' }];
    if (bot.heldItem) parts.push({ text: '  手持 ', color: 'gray' }, { ...itemText(bot.heldItem.name), color: 'yellow' });
    const items = topItems(4);
    if (items.length) {
      parts.push({ text: '  背包 ', color: 'gray' });
      items.forEach(([n, c], i) => parts.push({ ...itemText(n), color: 'white' }, { text: `×${c}${i < items.length - 1 ? ' ' : ''}`, color: 'white' }));
    }
    parts.push({ text: `  好感 ${love.score}（${love.level}）`, color: 'light_purple' });
    bot.chat(`/title ${player} actionbar ${JSON.stringify(parts)}`);
  }

  function fullInventory(player) {
    const tell = (component) => bot.chat(`/tellraw ${player} ${JSON.stringify(component)}`);
    const items = topItems(60);
    tell(['', { text: `${agent.cfg.identity.display_name} 的背包`, color: agent.cfg.identity.name_color },
      { text: `（生命 ${Math.round(bot.health)}/20 饥饿 ${bot.food}/20，空 ${bot.inventory.emptySlotCount()} 格）`, color: 'gray' }]);
    if (!items.length) {
      tell({ text: '  空空如也', color: 'gray' });
      return;
    }
    for (let i = 0; i < items.length; i += 6) {
      const row = [{ text: '  ', color: 'white' }];
      items.slice(i, i + 6).forEach(([n, c]) => row.push(itemText(n), { text: `×${c}   ` }));
      tell(row);
    }
  }

  const timer = setInterval(() => {
    if (!agent.online || !bot.entity || agent.identity.opLevel < 2) return;
    const now = Date.now();
    for (const p of Object.values(bot.players)) {
      const e = p.entity;
      if (!e || p.username === bot.username) continue;
      if (e.position.distanceTo(bot.entity.position) > ui.gaze_distance) continue;
      if (!isLookingAt(e, bot.entity, ui.gaze_distance)) continue;
      if (ui.quiet_admin_commands && now - (lastBar.get(p.username) ?? 0) > 1500) {
        lastBar.set(p.username, now);
        actionBar(p.username);
      }
      if (e.crouching && now - (lastFull.get(p.username) ?? 0) > 15_000) {
        lastFull.set(p.username, now);
        // 能用图标就在聊天栏画出背包格子，否则发文字清单
        if (!sendChatInventory(agent, p.username)) fullInventory(p.username);
      }
    }
  }, 300);
  bot.once('end', () => clearInterval(timer));
}
