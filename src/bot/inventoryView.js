// 可视化背包：弹出对话框窗口（1.21.6+ 的 /dialog），或者在聊天栏里画出图标格子。
import { itemKey, modernText } from './ui.js';
import { getLog } from '../log.js';

const log = getLog('界面');

const ARMOR_SLOTS = [['head', 'helmet'], ['torso', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']];

// 对话框需要 1.21.6+；文本里的贴图需要 1.21.9+。
function serverAtLeast(agent, minor, patch) {
  const v = String(agent.target?.serverVersion ?? '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!v) return false;
  const [major, mi, pa] = [Number(v[1]), Number(v[2]), Number(v[3] ?? 0)];
  return major > 1 || mi > minor || (mi === minor && pa >= patch);
}
export const supportsDialog = (agent) => serverAtLeast(agent, 21, 6);
const supportsSprites = (agent) => serverAtLeast(agent, 21, 9) && agent.textures?.ready;

function hoverItem(agent, item) {
  return modernText(agent)
    ? { hover_event: { action: 'show_item', id: `minecraft:${item.name}`, count: item.count } }
    : { hoverEvent: { action: 'show_item', contents: { id: `minecraft:${item.name}`, count: item.count } } };
}

// 格子里的一格：有物品就是物品图标（悬停显示物品说明），没有就是原版的空格子底图。
function cell(agent, item) {
  const tex = agent.textures;
  if (!item) return tex.guiSprite('container/slot', '□') ?? { text: '□', color: 'dark_gray' };
  const sprite = tex.itemSprite(item.name, item.name) ?? { text: '■', color: 'white' };
  return { ...sprite, ...hoverItem(agent, item) };
}

function heartsRow(agent, value, full, half, empty) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const v = value - i * 2;
    out.push(agent.textures.guiSprite(v >= 2 ? full : v >= 1 ? half : empty, v >= 2 ? '■' : v >= 1 ? '▪' : '□'));
  }
  return out;
}

function inventoryRows(agent) {
  const slots = agent.bot.inventory.slots;
  const rows = [];
  for (const start of [9, 18, 27, 36]) {
    rows.push(Array.from({ length: 9 }, (_, i) => cell(agent, slots[start + i])));
  }
  return rows;
}

function totals(bot) {
  const map = new Map();
  for (const i of bot.inventory.items()) {
    const t = map.get(i.name) ?? { name: i.name, count: 0 };
    t.count += i.count;
    map.set(i.name, t);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// 弹出对话框：状态、装备、4×9 格子、物品详情列表、操作按钮。
export function showInventoryDialog(agent, player) {
  const bot = agent.bot;
  const sprites = supportsSprites(agent);
  const slot = (dest) => bot.inventory.slots[bot.getEquipmentDestSlot(dest)];
  const body = [];
  const message = (contents, width = 300) => body.push({ type: 'minecraft:plain_message', width, contents: ['', ...contents] });

  if (sprites) {
    message([...heartsRow(agent, bot.health, 'hud/heart/full', 'hud/heart/half', 'hud/heart/container'), { text: '  ' },
      ...heartsRow(agent, bot.food, 'hud/food_full', 'hud/food_half', 'hud/food_empty')]);
  }
  message([{ text: `生命 ${Math.round(bot.health)}/20  饥饿 ${bot.food}/20  经验 ${bot.experience?.level ?? 0} 级  空 ${bot.inventory.emptySlotCount()} 格`, color: 'gray' }]);

  const gear = [...ARMOR_SLOTS.map(([dest]) => slot(dest)), bot.heldItem, slot('off-hand')];
  if (sprites) {
    message([{ text: '装备 ', color: 'gray' },
      ...ARMOR_SLOTS.map(([dest, icon]) => (slot(dest) ? cell(agent, slot(dest)) : agent.textures.guiSprite(`container/slot/${icon}`, '□'))),
      { text: '   手持 ', color: 'gray' }, cell(agent, bot.heldItem), { text: ' 副手 ', color: 'gray' }, cell(agent, slot('off-hand'))]);
    for (const [i, row] of inventoryRows(agent).entries()) {
      if (i === 3) message([{ text: ' ' }], 300); // 快捷栏和背包之间空一行，和游戏里一样
      message(row, 300);
    }
  } else if (gear.some(Boolean)) {
    message([{ text: '装备：', color: 'gray' }, { text: gear.filter(Boolean).map((g) => g.name).join('、') }]);
  }

  const list = totals(bot);
  if (!list.length) message([{ text: '背包是空的喵', color: 'gray' }]);
  for (const t of list.slice(0, 36)) {
    body.push({
      type: 'minecraft:item',
      item: { id: `minecraft:${t.name}`, count: Math.min(t.count, 99) },
      description: { contents: ['', { translate: itemKey(bot.registry, t.name), fallback: t.name }, { text: `  ×${t.count}`, color: 'yellow' }], width: 200 },
      show_decorations: true,
      show_tooltip: true,
    });
  }

  const button = (label, suggest, tooltip) => ({ label, tooltip, action: { type: 'suggest_command', command: suggest } });
  const dialog = {
    type: 'minecraft:multi_action',
    title: { text: `${agent.cfg.identity.display_name} 的背包`, color: 'light_purple' },
    body,
    actions: [
      button('叫她过来', '#过来', '走到你身边'),
      button('让她跟着我', '#跟着', '一直跟着你'),
      button('看状态', '#状态', '生命、位置、在做什么'),
      button('查看好感', '#好感', '她对你的好感度'),
    ],
    columns: 2,
    exit_action: { label: '关闭' },
    pause: false,
    after_action: 'close',
  };
  const command = `/dialog show ${player} ${JSON.stringify(dialog)}`;
  log.fileOnly('debug', `背包窗口 ${command.length} 字符，${list.length} 种物品`);
  agent.bot.chat(command);
}

// 聊天栏里的图标格子（准心对准并蹲下时用，不打断玩家操作）。
export function chatInventoryLines(agent) {
  if (!supportsSprites(agent)) return null;
  const bot = agent.bot;
  const title = ['', { text: `${agent.cfg.identity.display_name} 的背包 `, color: 'light_purple' },
    { text: `(生命 ${Math.round(bot.health)} 饥饿 ${bot.food}，悬停图标看详情)`, color: 'gray' }];
  return [title, ...inventoryRows(agent).map((row) => ['', { text: ' ' }, ...row])];
}

export function sendChatInventory(agent, player) {
  const lines = chatInventoryLines(agent);
  if (!lines) return false;
  for (const component of lines) agent.identity.sendRaw(player, component, '背包格子');
  return true;
}
