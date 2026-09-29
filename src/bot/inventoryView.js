// 可视化界面：弹出对话框窗口（1.21.6+ 的 /dialog）——背包、状态、功能菜单；也能在聊天栏画出背包图标格子。
// 装了面板模组时：右键猫娘直接打开她的人物面板（能拿能放），Shift+右键打开这里的功能菜单，弹窗也不会留下灰色提示；
// 菜单按钮通过模组的 /njfu ui <按钮> 转告猫娘，点一下就生效（对话框按钮只能执行命令，不能替玩家发聊天）。
import { itemKey, modernText } from './ui.js';
import { snapshot } from './status.js';
import { combatFlags } from './combatModes.js';
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
const sep = () => ({ text: '  ·  ', color: 'dark_gray' });
const key = (text) => ({ text, color: 'white' });

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

// 护甲值（和游戏里护甲栏一样，满 20）：按身上盔甲的材质算
const ARMOR_POINTS = {
  leather: [1, 3, 2, 1], copper: [2, 4, 3, 1], chainmail: [2, 5, 4, 1], iron: [2, 6, 5, 2], golden: [2, 5, 3, 1], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3],
};
export function armorPoints(bot) {
  let total = 0;
  ARMOR_SLOTS.forEach(([dest, piece], i) => {
    const name = bot.inventory.slots[bot.getEquipmentDestSlot(dest)]?.name ?? '';
    if (name === 'turtle_helmet') total += 2;
    const m = new RegExp(`^([a-z]+)_${piece}$`).exec(name);
    if (m && ARMOR_POINTS[m[1]]) total += ARMOR_POINTS[m[1]][i];
  });
  return Math.min(20, total);
}

// 物品名按玩家客户端的语言显示（中文客户端就是中文）
const itemName = (agent, item, empty) => (item ? { translate: itemKey(agent.bot.registry, item.name), fallback: item.name } : { text: empty });

// 数值一行：生命 · 护甲 · 饱食度 · 经验（亮色，模糊背景上也看得清）
function statsLine(agent) {
  const bot = agent.bot;
  return [
    key('生命 '), { text: `${Math.round(bot.health)}/20`, color: 'red' }, sep(),
    key('护甲 '), { text: String(armorPoints(bot)), color: 'aqua' }, sep(),
    key('饱食度 '), { text: `${bot.food}/20`, color: 'gold' }, sep(),
    key('经验 '), { text: `${bot.experience?.level ?? 0} 级`, color: 'green' },
  ];
}

// 顶部：和游戏里一样的爱心、鸡腿（能显示贴图时），下面一行是数值
function statusHeader(agent) {
  const bot = agent.bot;
  const parts = [];
  if (supportsSprites(agent)) {
    parts.push(...iconRow(agent, bot.health, 'hud/heart/full', 'hud/heart/half', 'hud/heart/container'), { text: '     ' },
      ...iconRow(agent, bot.food, 'hud/food_full', 'hud/food_half', 'hud/food_empty'), br());
  }
  parts.push(...statsLine(agent));
  return message(parts);
}

// 装备：一排图标（盔甲四件、主手、副手，悬停看详情），下面一行写出手里拿的是什么
function equipment(agent) {
  const bot = agent.bot;
  const slot = (dest) => bot.inventory.slots[bot.getEquipmentDestSlot(dest)];
  const held = bot.heldItem;
  const off = slot('off-hand');
  const parts = [];
  if (supportsSprites(agent)) {
    parts.push(key('盔甲 '));
    for (const [dest, icon] of ARMOR_SLOTS) parts.push(cell(agent, slot(dest), `container/slot/${icon}`));
    parts.push(key('    主手 '), cell(agent, held, 'container/slot/sword'), key('    副手 '), cell(agent, off, 'container/slot/shield'), br());
  } else {
    const worn = ARMOR_SLOTS.map(([dest]) => slot(dest)).filter(Boolean);
    parts.push(key('盔甲 '));
    if (!worn.length) parts.push({ text: '无', color: 'gray' });
    worn.forEach((item, i) => parts.push({ ...itemName(agent, item), color: 'aqua' }, ...(i < worn.length - 1 ? [key('、')] : [])));
    parts.push(br());
  }
  parts.push(key('手持 '), { ...itemName(agent, held, '空手'), color: 'yellow' }, sep(), key('副手 '), { ...itemName(agent, off, '空'), color: 'yellow' });
  return message(parts);
}

// 背包页：状态 → 装备 + 4×9 格子（一整块，排列和游戏背包一致）→ 物品清单（带数量和耐久）
export function inventoryDialog(agent) {
  const bot = agent.bot;
  const body = [statusHeader(agent), equipment(agent)];
  if (supportsSprites(agent)) {
    const grid = [];
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
  body.push(message([key(list.length ? `共 ${list.length} 种物品，空 ${bot.inventory.emptySlotCount()} 格：` : '背包是空的喵')]));
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

// 状态页：生命/护甲/饱食度 → 装备 → 位置、时间、在做什么、战斗模式、好感（每行前面一个小图标）
export function statusDialog(agent, player) {
  const s = snapshot(agent);
  const love = agent.affection.get(player, agent.chat.isOwner(player));
  const tex = agent.textures;
  const sprites = supportsSprites(agent);
  const icon = (item, fallback) => (sprites ? tex.itemSprite(item, fallback) : null) ?? { text: fallback, color: 'white' };
  const heart = sprites ? tex.guiSprite('hud/heart/full', '♥') : { text: '♥', color: 'red' };
  const line = (ic, label, values) => [ic, key(` ${label}  `), ...values, br()];
  const task = s.task ? s.task.desc : '没事做，陪着大家';
  return {
    type: 'minecraft:notice',
    title: { text: `${agent.cfg.identity.display_name} 的状态`, color: 'light_purple' },
    body: [
      statusHeader(agent),
      equipment(agent),
      message([
        ...line(icon('compass_00', '◎'), '位置', [{ text: s.position, color: 'aqua' }, key(`  ${s.dimension}`)]),
        ...line(icon('clock_00', '◷'), '时间', [key(`第 ${s.day} 天 ${s.clock}（${s.isDay ? '白天' : '夜晚'}）· ${s.weather}`)]),
        ...line(icon('writable_book', '✎'), '正在', [{ text: task.length > 26 ? `${task.slice(0, 25)}…` : task, color: 'yellow' }]),
        ...line(icon('iron_sword', '⚔'), '战斗模式', [{ text: combatFlags(agent).mode, color: 'gold' }]),
        ...line(heart, '对你的好感', [{ text: `${love.score}/100（${love.level}）`, color: 'light_purple' }]),
      ]),
    ],
    action: { label: '关闭', width: 150 },
    pause: false,
  };
}

// 功能菜单的行动按钮：键是面板模组 /njfu ui 用的按钮名，text 是对应的快捷命令（没装模组时退回私聊命令）
export const MENU_ACTIONS = {
  help: { label: '使用帮助', text: '#帮助', tip: '在聊天栏显示使用说明' },
  come: { label: '叫她过来', text: '#过来', tip: '走到你身边', owner: true },
  follow: { label: '跟着我', text: '#跟着', tip: '一直跟着你，离远了会传送', owner: true },
  stop: { label: '停下', text: '#停', tip: '停下手上的事', owner: true },
  home: { label: '回家', text: '#回家', tip: '回到她的床边', owner: true },
  sit: { label: '坐下', text: '#坐下', tip: '原地坐下，陪在这里' },
  stand: { label: '站起来', text: '#起来', tip: '站起来' },
  duel_easy: { label: '简单', text: '#决斗 简单', tip: '不走位、不跳劈、不举盾，出手慢' },
  duel_normal: { label: '普通', text: '#决斗 普通', tip: '左右走位、举盾，会用斧子破你的盾；不跳劈' },
  duel_hard: { label: '困难', text: '#决斗 困难', tip: '走位、跳劈暴击、举盾、斧子破盾' },
  duel_cheat: { label: '作弊', text: '#决斗 作弊', tip: '困难的打法，再临时换上一套顶级附魔装备（打完收回）' },
  pet: { label: '摸摸头', text: '#摸头', tip: '摸摸她的头，好感 +1' },
  hug: { label: '抱抱', text: '#抱抱', tip: '她会跑过来抱你，好感 +1' },
  dance: { label: '跳支舞', text: '#跳舞', tip: '转圈、蹦跳、冒爱心' },
};

const button = (label, action, tooltip, width = 100) => ({ label, ...(tooltip ? { tooltip } : {}), action, width });

// 菜单按钮的动作：装了面板模组 1.0.2+ 用 /njfu ui 转告（点一下就生效）；没装就私聊快捷命令（原版会先弹确认窗口）
function menuButton(agent, id) {
  const a = MENU_ACTIONS[id];
  if (agent.menuButtons) return button(a.label, { type: 'run_command', command: `/njfu ui ${id}` }, a.tip);
  return button(a.label, { type: 'run_command', command: `/tell ${agent.bot.username} ${a.text}` },
    `${a.tip}（没装面板模组：点完在确认窗口里选「复制到聊天屏幕」，再按回车）`);
}

// PVP 决斗：先选难度
export function duelDialog(agent) {
  const lethal = Boolean(agent.cfg.duel?.lethal);
  return {
    type: 'minecraft:multi_action',
    title: { text: 'PVP 决斗', color: 'light_purple' },
    body: [message([
      key('选个难度，倒计时后开打'), br(),
      { text: lethal ? '现在是真打：打到有一方倒下（困难还会用岩浆桶）' : '切磋：打到只剩几颗心就停，不会真的打死', color: 'yellow' },
    ])],
    actions: ['duel_easy', 'duel_normal', 'duel_hard', 'duel_cheat'].map((id) => menuButton(agent, id)),
    columns: 2,
    exit_action: { label: '算了', width: 150 },
    pause: false,
  };
}

// 功能菜单：3 列、每行 3 个按钮，内容少一点，免得窗口太高要滚动（界面缩放大时也放得下）。
// 装了面板模组 1.0.2+：按钮点一下就生效；没装：会弹原版的确认窗口，选「复制到聊天屏幕」再按回车。
export function menuDialog(agent, player) {
  const bot = agent.bot;
  const owner = agent.chat.isOwner(player);
  const love = agent.affection.get(player, owner);
  const act = (id) => (id === 'duel'
    ? button('PVP 决斗', { type: 'show_dialog', dialog: duelDialog(agent) }, '先选难度，倒计时后开打')
    : menuButton(agent, id));
  const order = ['come', 'follow', 'stop', 'home', agent.seated ? 'stand' : 'sit', 'duel', 'pet', 'hug', 'dance'];
  const actions = [
    agent.menuButtons
      ? button('查看背包', { type: 'run_command', command: '/njfu ui panel' }, '打开她的人物面板，能直接拿放东西（离得远时弹背包窗口）')
      : button('查看背包', { type: 'show_dialog', dialog: inventoryDialog(agent) }, '看看她背包里有什么'),
    button('查看状态', { type: 'show_dialog', dialog: statusDialog(agent, player) }, '生命、装备、位置、正在做什么'),
    act('help'),
    ...order.filter((id) => owner || !MENU_ACTIONS[id]?.owner).map(act),
  ];
  const task = agent.tasks.info()?.desc ?? '没事做，陪着大家';
  return {
    type: 'minecraft:multi_action',
    title: { text: agent.cfg.identity.display_name, color: 'light_purple' },
    body: [message([
      key('生命 '), { text: `${Math.round(bot.health)}/20`, color: 'red' }, sep(),
      key('饱食度 '), { text: `${bot.food}/20`, color: 'gold' }, sep(),
      key('对你的好感 '), { text: `${love.score}（${love.level}）`, color: 'light_purple' }, br(),
      key('正在：'), { text: task.length > 24 ? `${task.slice(0, 23)}…` : task, color: 'yellow' },
    ])],
    actions,
    columns: 3,
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
    { text: `(生命 ${Math.round(bot.health)} 饱食度 ${bot.food}，悬停图标看详情)`, color: 'gray' }], '背包格子');
  const slots = bot.inventory.slots;
  for (const start of [9, 18, 27, 36]) {
    agent.identity.sendRaw(player, ['', { text: ' ' }, ...Array.from({ length: 9 }, (_, i) => cell(agent, slots[start + i]))], '背包格子');
  }
  return true;
}
