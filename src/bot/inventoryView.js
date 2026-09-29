// 可视化界面：弹出对话框窗口（1.21.6+ 的 /dialog）——背包、状态、功能菜单；也能在聊天栏画出背包图标格子。
// 装了面板模组时：右键猫娘直接打开她的人物面板（能拿能放），Shift+右键打开这里的功能菜单，弹窗也不会留下灰色提示。
import { itemKey, modernText } from './ui.js';
import { snapshot } from './status.js';
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
function cell(agent, item, emptySprite = 'container/slot') {
  const tex = agent.textures;
  if (!item) return tex.guiSprite(emptySprite, '□') ?? { text: '□', color: 'dark_gray' };
  const sprite = tex.itemSprite(item.name, item.name) ?? { text: '■', color: 'white' };
  return { ...sprite, ...hoverItem(agent, item) };
}

function iconRow(agent, value, full, half, empty) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const v = value - i * 2;
    out.push(agent.textures.guiSprite(v >= 2 ? full : v >= 1 ? half : empty, v >= 2 ? '■' : v >= 1 ? '▪' : '□'));
  }
  return out;
}

const br = (n = 1) => ({ text: '\n'.repeat(n) });

function totals(bot) {
  const map = new Map();
  for (const i of bot.inventory.items()) {
    const t = map.get(i.name) ?? { name: i.name, count: 0 };
    t.count += i.count;
    map.set(i.name, t);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

const message = (contents, width = 320) => ({ type: 'minecraft:plain_message', width, contents: ['', ...contents] });

// 顶部：爱心、鸡腿和数值
function statusHeader(agent) {
  const bot = agent.bot;
  const parts = [];
  if (supportsSprites(agent)) {
    parts.push(...iconRow(agent, bot.health, 'hud/heart/full', 'hud/heart/half', 'hud/heart/container'), { text: '   ' },
      ...iconRow(agent, bot.food, 'hud/food_full', 'hud/food_half', 'hud/food_empty'), br());
  }
  parts.push({ text: `生命 ${Math.round(bot.health)}/20 · 饥饿 ${bot.food}/20 · 经验 ${bot.experience?.level ?? 0} 级`, color: 'gray' });
  return message(parts);
}

function button(label, action, tooltip) {
  return { label, ...(tooltip ? { tooltip } : {}), action, width: 150 };
}
// 行动按钮：把快捷命令填进聊天框，按回车发送（对话框按钮不能直接替玩家发聊天，这样也不会有任何命令提示）
const quick = (command) => ({ type: 'suggest_command', command });

// 背包页：状态 → 装备 + 4×9 格子（一整块，排列和游戏背包一致）→ 物品清单（带数量和耐久）
export function inventoryDialog(agent) {
  const bot = agent.bot;
  const slot = (dest) => bot.inventory.slots[bot.getEquipmentDestSlot(dest)];
  const body = [statusHeader(agent)];
  if (supportsSprites(agent)) {
    const grid = [{ text: '装备 ', color: 'gray' }];
    for (const [dest, icon] of ARMOR_SLOTS) grid.push(cell(agent, slot(dest), `container/slot/${icon}`));
    grid.push({ text: '  手持 ', color: 'gray' }, cell(agent, bot.heldItem), { text: '  副手 ', color: 'gray' }, cell(agent, slot('off-hand'), 'container/slot/shield'), br(2));
    const slots = bot.inventory.slots;
    for (const start of [9, 18, 27]) {
      for (let i = 0; i < 9; i++) grid.push(cell(agent, slots[start + i]));
      grid.push(br());
    }
    grid.push(br());
    for (let i = 0; i < 9; i++) grid.push(cell(agent, slots[36 + i]));
    body.push(message(grid));
  }
  const list = totals(bot);
  body.push(message([{ text: list.length ? `共 ${list.length} 种物品，空 ${bot.inventory.emptySlotCount()} 格：` : '背包是空的喵', color: 'gray' }]));
  for (const t of list.slice(0, 30)) {
    body.push({
      type: 'minecraft:item',
      item: { id: `minecraft:${t.name}`, count: Math.min(t.count, 99) },
      description: { contents: ['', { translate: itemKey(bot.registry, t.name), fallback: t.name }, { text: `  ×${t.count}`, color: 'yellow' }], width: 220 },
      show_decorations: true,
      show_tooltip: true,
    });
  }
  return {
    type: 'minecraft:notice',
    title: { text: `${agent.cfg.identity.display_name} 的背包`, color: 'light_purple' },
    body,
    action: { label: '关闭', width: 150 },
    pause: false,
  };
}

export function statusDialog(agent, player) {
  const s = snapshot(agent);
  const love = agent.affection.get(player, agent.chat.isOwner(player));
  const line = (k, v, color = 'white') => [{ text: `${k}  `, color: 'gray' }, { text: String(v), color }, br()];
  return {
    type: 'minecraft:notice',
    title: { text: `${agent.cfg.identity.display_name} 的状态`, color: 'light_purple' },
    body: [
      statusHeader(agent),
      message([
        ...line('位置', `${s.position} ${s.dimension}`, 'aqua'),
        ...line('时间', `第 ${s.day} 天 ${s.clock}（${s.isDay ? '白天' : '夜晚'}）· ${s.weather}`),
        ...line('手持', s.held ?? '空手', 'yellow'),
        ...line('盔甲', s.armor.length ? s.armor.join('、') : '无'),
        ...line('正在', s.task ? s.task.desc : '没事做，陪着大家', 'yellow'),
        ...line('对你的好感', `${love.score}/100（${love.level}）`, 'light_purple'),
      ]),
    ],
    action: { label: '关闭', width: 150 },
    pause: false,
  };
}

// 功能菜单：查看类按钮直接打开对应页面；行动类按钮把快捷命令填进聊天框，按回车就发出去。
export function menuDialog(agent, player) {
  const owner = agent.chat.isOwner(player);
  const love = agent.affection.get(player, owner);
  const tip = (text) => `${text}（点一下，再按回车）`;
  const actions = [
    button('查看背包', { type: 'show_dialog', dialog: inventoryDialog(agent) }, agent.quietCommands ? '右键她可以直接打开人物面板，拿放东西' : '看看她背包里有什么'),
    button('查看状态', { type: 'show_dialog', dialog: statusDialog(agent, player) }, '生命、位置、正在做什么'),
    button('摸摸头', quick('#摸头'), tip('好感 +1')),
    button('跳支舞', quick('#跳舞'), tip('跳舞')),
    button('叫她过来', quick('#过来'), tip('走到你身边')),
    button('跟着我', quick('#跟着'), tip('离远了会自动传送')),
    button('停下', quick('#停'), tip('停下手上的事')),
    button('回家', quick('#回家'), tip('回到她的床边')),
    button('坐下', quick('#坐下'), tip('坐下')),
    button('站起来', quick('#起来'), tip('站起来')),
    button('PVP 决斗', quick('#决斗'), tip('切磋，不会真打死')),
    button('使用帮助', quick('#帮助'), tip('在聊天栏显示帮助')),
  ];
  return {
    type: 'minecraft:multi_action',
    title: { text: agent.cfg.identity.display_name, color: 'light_purple' },
    body: [
      statusHeader(agent),
      message([{ text: `对你的好感：${love.score}（${love.level}）`, color: 'light_purple' }, br(), { text: '想让她做什么？', color: 'gray' }]),
    ],
    actions,
    columns: 2,
    exit_action: { label: '关闭', width: 150 },
    pause: false,
  };
}

export function showDialog(agent, player, dialog) {
  const command = `dialog show ${player} ${JSON.stringify(dialog)}`;
  log.fileOnly('debug', `弹出窗口「${dialog.title?.text}」给 ${player}（${command.length} 字符${agent.quietCommands ? '，静默' : ''}）`);
  agent.adminCommand(command);
}

export const showInventoryDialog = (agent, player) => showDialog(agent, player, inventoryDialog(agent));
export const showMenuDialog = (agent, player) => showDialog(agent, player, menuDialog(agent, player));

// 聊天栏里的图标格子（准心对准并蹲下时用，不打断玩家操作）。
export function sendChatInventory(agent, player) {
  if (!supportsSprites(agent)) return false;
  const bot = agent.bot;
  agent.identity.sendRaw(player, ['', { text: `${agent.cfg.identity.display_name} 的背包 `, color: 'light_purple' },
    { text: `(生命 ${Math.round(bot.health)} 饥饿 ${bot.food}，悬停图标看详情)`, color: 'gray' }], '背包格子');
  const slots = bot.inventory.slots;
  for (const start of [9, 18, 27, 36]) {
    agent.identity.sendRaw(player, ['', { text: ' ' }, ...Array.from({ length: 9 }, (_, i) => cell(agent, slots[start + i]))], '背包格子');
  }
  return true;
}
