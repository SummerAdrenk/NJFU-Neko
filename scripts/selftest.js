#!/usr/bin/env node
// 自测：不连服务器，检查各模块能加载、关键的纯逻辑算得对。改完代码、重启猫娘之前先跑：npm test
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mcDataLoader from 'minecraft-data';
import vec3 from 'vec3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Vec3 } = vec3;
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`);
  }
}

// 1. 语法检查 + 全部模块能加载
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
};
walk(path.join(ROOT, 'src'));
walk(path.join(ROOT, 'scripts'));
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    check(`语法 ${path.relative(ROOT, f)}`, true);
  } catch (err) {
    check(`语法 ${path.relative(ROOT, f)}`, false, String(err.stderr ?? err.message).split('\n').slice(0, 3).join(' '));
  }
}
for (const f of files.filter((x) => x.includes(`${path.sep}src${path.sep}`) && !x.endsWith('index.js') && !x.endsWith('cli.js'))) {
  try {
    await import(`file://${f.replace(/\\/g, '/')}`);
    check(`加载 ${path.relative(ROOT, f)}`, true);
  } catch (err) {
    check(`加载 ${path.relative(ROOT, f)}`, false, err.message);
  }
}

const combat = await import('../src/bot/combat.js');
const helpers = await import('../src/bot/helpers.js');
const { loadConfig } = await import('../src/config.js');
const cfg = loadConfig();
const registry = mcDataLoader(cfg.viaproxy.client_version);

// 2. 弹道：解出来的角度模拟一遍，确实落在目标附近
function simulate(from, sol, { speed, gravity, drag, dragFirst }, horiz) {
  let vh = speed * Math.cos(sol.pitch);
  let vy = speed * Math.sin(sol.pitch);
  let h = 0;
  let y = from.y;
  for (let t = 0; t < 400; t++) {
    if (dragFirst) {
      vy = (vy - gravity) * drag;
      vh *= drag;
    }
    if (h + vh >= horiz) return y + vy * ((horiz - h) / vh);
    h += vh;
    y += vy;
    if (!dragFirst) {
      vh *= drag;
      vy = vy * drag - gravity;
    }
  }
  return NaN;
}
const ARROW = { speed: 3, gravity: 0.05, drag: 0.99, dragFirst: false };
for (const [dx, dy] of [[10, 0], [30, 0], [45, 12], [20, -8], [60, 40]]) {
  const from = new Vec3(0, 64, 0);
  const to = new Vec3(dx, 64 + dy, 0);
  const sol = combat.solveBallistic(from, to, ARROW);
  const hit = sol ? simulate(from, sol, ARROW, dx) : NaN;
  check(`弹道 ${dx} 格外高 ${dy}`, sol && Math.abs(hit - to.y) < 0.2 && sol.pitch < Math.PI / 3, sol ? `落点高度 ${hit?.toFixed(2)}` : '无解');
}
check('弹道 朝向', Math.abs(combat.solveBallistic(new Vec3(0, 0, 0), new Vec3(0, 0, -10), ARROW).yaw) < 1e-9, '正北应为 yaw 0');

// 3. 攻击冷却
check('冷却 剑', combat.cooldownMs({ name: 'diamond_sword' }) === 625);
check('冷却 石斧', combat.cooldownMs({ name: 'stone_axe' }) === 1250);
check('冷却 空手', combat.cooldownMs(null) === 250);

// 4. 放船判定、骑乘判定
const fakeBot = { registry, entities: {}, entity: { position: new Vec3(0, 64, 0) } };
const ent = (name, extra = {}) => ({ name, type: registry.entitiesByName[name]?.type, position: new Vec3(3, 64, 0), metadata: [], passengers: [], ...extra });
check('船 僵尸能困', combat.fitsBoat(fakeBot, ent('zombie')));
check('船 蜘蛛太宽', !combat.fitsBoat(fakeBot, ent('spider')));
check('船 苦力怕不困', !combat.fitsBoat(fakeBot, ent('creeper')));
const agent = { bot: fakeBot, cfg, myBoats: new Set([99]) };
const boat = ent('oak_boat', { id: 7 });
const ourBoat = ent('oak_boat', { id: 99 });
const spider = ent('spider', { id: 8 });
check('骑乘 船里的怪不打', Boolean(helpers.protectedReason(agent, ent('zombie', { vehicle: boat }))));
check('骑乘 自己放的船里的照打', !helpers.protectedReason(agent, ent('zombie', { vehicle: ourBoat })));
check('骑乘 蜘蛛骑士照打', !helpers.protectedReason(agent, ent('skeleton', { vehicle: spider })));
const rider = ent('skeleton', { id: 9, vehicle: spider });
spider.passengers = [rider];
check('骑乘 先打骑手', helpers.preferRider(agent, spider) === rider);
// 死掉的怪（生命 0，还在播倒地动画）不能再当目标，否则陪伴循环会对着尸体空转卡死进程
const healthIndex = registry.entitiesByName.zombie.metadataKeys.indexOf('health');
const deadZombie = ent('zombie', { id: 11, metadata: Object.assign([], { [healthIndex]: 0 }) });
const liveZombie = ent('zombie', { id: 12, metadata: Object.assign([], { [healthIndex]: 20 }) });
check('死怪 不算威胁', !helpers.isThreat(agent, deadZombie) && helpers.isThreat(agent, liveZombie));
const angryEnderman = ent('enderman', { id: 13 });
check('中立 平时不打末影人', !combat.canEngage({ ...agent, recentAttackers: new Map() }, angryEnderman));
check('中立 被打了还手', combat.canEngage({ ...agent, recentAttackers: new Map([[13, { t: Date.now(), victim: 'self' }]]) }, angryEnderman));
check('死怪 不去打', !combat.canEngage({ ...agent, bot: { ...fakeBot, health: 20, inventory: { items: () => [] } } }, deadZombie));

// 5. 面板模组相关：菜单按钮不再用 /trigger，命令会走 /njfu quiet
const view = await import('../src/bot/inventoryView.js');
const fakeAgent = {
  cfg,
  online: true,
  bot: {
    ...fakeBot, username: 'NJFU_Neko', players: {}, health: 20, food: 20, experience: { level: 3 }, game: { dimension: 'minecraft:overworld', gameMode: 'survival' },
    time: { age: 24000, timeOfDay: 1000, isDay: true }, inventory: { items: () => [], slots: [], emptySlotCount: () => 36 },
    getEquipmentDestSlot: () => 5, heldItem: null, blockAt: () => null,
  },
  tasks: { info: () => null }, identity: { opLevel: 4 },
  textures: { ready: false }, target: { serverVersion: '26.2' }, quietCommands: true,
  chat: { isOwner: () => true }, affection: { get: () => ({ score: 50, level: '朋友' }) },
};
const menu = view.menuDialog(fakeAgent, 'Steve');
check('菜单 按钮（3 列）', menu.actions.length === 12 && menu.columns === 3 && !JSON.stringify(menu).includes('/trigger'));
check('菜单 没装模组：私聊快捷命令', menu.actions.some((a) => a.action.type === 'run_command' && a.action.command === '/tell NJFU_Neko #过来'));
const modMenu = view.menuDialog({ ...fakeAgent, menuButtons: true }, 'Steve');
check('菜单 装了模组：/njfu ui', modMenu.actions.some((a) => a.action.command === '/njfu ui come') && modMenu.actions.some((a) => a.action.command === '/njfu ui panel'));
const guestMenu = view.menuDialog({ ...fakeAgent, chat: { isOwner: () => false } }, 'Alex');
check('菜单 非主人没有主人专用按钮', !JSON.stringify(guestMenu).includes('#过来') && JSON.stringify(guestMenu).includes('#摸头'));
check('菜单 坐着时换成站起来', JSON.stringify(view.menuDialog({ ...fakeAgent, seated: true }, 'Steve')).includes('#起来'));
check('菜单 按钮都对应快捷命令', Object.values(view.MENU_ACTIONS).every((a) => a.text.startsWith('#') && a.label && a.tip));
const duelBtn = modMenu.actions.find((a) => a.label === 'PVP 决斗');
const duelTop = duelBtn?.action.dialog;
const cheatTier = duelTop?.actions.find((a) => a.label === '作弊 ▸')?.action.dialog;
check('菜单 决斗两层：简单 普通 困难▸ 作弊▸，还有决斗场▸', duelBtn?.action.type === 'show_dialog' && duelTop.actions.length === 5
  && duelTop.actions.some((a) => a.action.command === '/njfu ui duel_easy'));
const arenaPick = duelTop?.actions.find((a) => a.label.startsWith('决斗场：'))?.action.dialog;
check('菜单 决斗场：原地上空（默认）/ 家上空 / 不用，选完回到决斗菜单',
  duelTop.actions[4].label === '决斗场：原地上空 ▸' && arenaPick?.actions.map((a) => a.action.command).join() === '/njfu ui arena_here,/njfu ui arena_home,/njfu ui arena_off'
  && view.MENU_ACTIONS.arena_home.text === '#设置 决斗场 家上空' && arenaPick.exit_action.action?.command === '/njfu ui duel_menu');
check('菜单 作弊档Ⅰ～Ⅵ', cheatTier?.actions.length === 6 && cheatTier.actions.some((a) => a.action.command === '/njfu ui duel_cheat6')
  && cheatTier.exit_action.action?.command === '/njfu ui duel_menu');
const kits = await import('../src/bot/duelKits.js');
const kitIds = (id, o) => kits.duelKit(kits.duelLevel(id), o).map((k) => k.id);
check('决斗 十四档难度', kits.DUEL_LEVELS.length === 14 && kits.DUEL_LEVELS.filter((l) => l.group === 'cheat').length === 6);
check('决斗 简单：铁套+铁剑+一组熟牛排', kitIds('easy').join(',') === 'iron_helmet,iron_chestplate,iron_leggings,iron_boots,iron_sword,cooked_beef');
check('决斗 所有难度都带熟牛排', kits.DUEL_LEVELS.every((l) => kitIds(l.id).includes('cooked_beef')));
check('决斗 普通：加铁斧、盾牌', ['iron_axe', 'shield'].every((i) => kitIds('normal').includes(i)));
check('决斗 困难：钻石、弓箭、蜘蛛网、鞘翅烟花', ['diamond_sword', 'bow', 'arrow', 'cobweb', 'elytra', 'firework_rocket'].every((i) => kitIds('hard').includes(i)) && !kitIds('hard').includes('ender_pearl'));
check('决斗 困难Ⅵ：金苹果×64、图腾×3、药水', kits.duelKit(kits.duelLevel('hard6')).some((k) => k.item.startsWith('enchanted_golden_apple[') && k.item.endsWith(' 64'))
  && kits.duelKit(kits.duelLevel('hard6')).some((k) => k.item.startsWith('totem_of_undying[') && k.item.endsWith(' 3')) && kitIds('hard6').includes('splash_potion'));
check('决斗 作弊：下界合金、珍珠、药水箭、无限弓', ['netherite_sword', 'ender_pearl', 'tipped_arrow', 'water_bucket', 'lava_bucket'].every((i) => kitIds('cheat').includes(i))
  && kits.duelKit(kits.duelLevel('cheat')).find((k) => k.id === 'bow').item.includes('infinity') && !kitIds('cheat').includes('enchanted_golden_apple'));
check('决斗 作弊Ⅵ：水晶、黑曜石、TNT、打火石', ['end_crystal', 'obsidian', 'tnt', 'flint_and_steel'].every((i) => kitIds('cheat6').includes(i)));
check('决斗 顶级附魔（没锁血时不带火焰附加）', kits.duelKit(kits.duelLevel('hard4')).find((k) => k.id === 'diamond_sword').item.includes('sharpness')
  && !kits.duelKit(kits.duelLevel('hard4'), { fire: false }).find((k) => k.id === 'diamond_sword').item.includes('fire_aspect'));
check('决斗 难度名', ['困难Ⅲ', '困难3', '困难 III', 'hard3'].every((t) => kits.parseDuelLevel(t.replace(' ', ''))?.id === 'hard3') && kits.parseDuelLevel('作弊')?.id === 'cheat'
  && kits.parseDuelLevel('普通2') === null);
const armorBot = {
  inventory: { slots: { 5: { name: 'diamond_helmet' }, 6: { name: 'diamond_chestplate' }, 7: { name: 'diamond_leggings' }, 8: { name: 'diamond_boots' } } },
  getEquipmentDestSlot: (d) => ({ head: 5, torso: 6, legs: 7, feet: 8 })[d],
};
check('状态 护甲值（全套钻石 20）', view.armorPoints(armorBot) === 20);
const swordAgent = { ...fakeAgent, bot: { ...fakeAgent.bot, heldItem: { name: 'diamond_sword', count: 1 } } };
check('状态 物品名按客户端语言显示', JSON.stringify(view.statusDialog(swordAgent, 'Steve')).includes('"translate":"item.minecraft.diamond_sword"'));

// 5b. 战斗模式、药水、索敌
const modes = await import('../src/bot/combatModes.js');
const potionsMod = await import('../src/bot/potions.js');
const ballistics = await import('../src/bot/ballistics.js');
const flagsFor = (mode, extra = {}) => modes.combatFlags({ cfg: { ...cfg, combat: { ...cfg.combat, mode, ...extra } } });
check('模式 普通不跳劈', !flagsFor('普通').crits && flagsFor('困难').crits);
check('模式 困难以上用岩浆', flagsFor('困难').lava && flagsFor('极限').lava && !flagsFor('普通').lava);
check('撤退 困难、极限 1 滴血，普通 3 滴血', combat.retreatHealth({ cfg }, flagsFor('困难')) === 1
  && combat.retreatHealth({ cfg }, flagsFor('普通')) === 3 && combat.retreatHealth({ cfg }, flagsFor('极限')) === 1);
check('撤退 配置成 0 就不撤', combat.retreatHealth({ cfg: { ...cfg, behavior: { ...cfg.behavior, retreat_health: 0 } } }, flagsFor('困难')) === 0);
const socialMod = await import('../src/bot/social.js');
check('睡觉 口令', ['睡觉', '去睡觉', '睡吧', '一起睡', '睡觉啦～'].every((t) => socialMod.SLEEP_WORDS.test(t)) && !socialMod.SLEEP_WORDS.test('你睡觉了吗'));
check('睡觉 时间', socialMod.canSleepNow({ time: { timeOfDay: 13000 } }) && !socialMod.canSleepNow({ time: { timeOfDay: 23692 } }) && socialMod.canSleepNow({ time: { timeOfDay: 6000 }, thunderState: 1 }));
const fireIdx = registry.entitiesByName.zombie.metadataKeys.indexOf('shared_flags');
check('岩浆 能烫僵尸', combat.canBurn(fakeBot, ent('zombie')));
check('岩浆 不烫不怕火的、末影人、女巫', !combat.canBurn(fakeBot, ent('blaze')) && !combat.canBurn(fakeBot, ent('enderman')) && !combat.canBurn(fakeBot, ent('witch')));
check('岩浆 已经在烧的不再烫', fireIdx >= 0 && !combat.canBurn(fakeBot, ent('zombie', { metadata: Object.assign([], { [fireIdx]: 1 }) })));
check('模式 开关能关掉', !flagsFor('极限', { lava: false }).lava);
check('模式 作弊', flagsFor('作弊').cheat === true && flagsFor('cheat').mode === '作弊');
check('作弊装备 盔甲盾牌发一件穿一件（不占空位）', modes.kitSlotsNeeded(['diamond_helmet[x] 1', 'shield[x] 1', 'diamond_sword[x] 1']) === 2);
check('药水 亡灵用治疗', potionsMod.offensiveKindsFor({ name: 'zombie' }).includes('healing') && !potionsMod.offensiveKindsFor({ name: 'zombie' }).includes('harming'));
check('药水 普通怪用伤害', potionsMod.offensiveKindsFor({ name: 'spider' }).includes('harming'));
const ps = ballistics.solveBallistic(new Vec3(0, 65.5, 0), new Vec3(4, 64, 0), ballistics.SPLASH_POTION);
check('药水 弹道（出手比视线高 20°）', ps && Math.abs((ps.launch - ps.pitch) - (20 * Math.PI) / 180) < 1e-6);
const creepyIdx = registry.entitiesByName.enderman.metadataKeys.indexOf('creepy');
const em = ent('enderman', { id: 21, position: new Vec3(15, 64, 0), metadata: Object.assign([], { [creepyIdx]: true }) });
const calmZombie = ent('zombie', { id: 22, position: new Vec3(70, 64, 0) });
const pickAgent = {
  cfg, chat: { isOwner: () => true }, recentAttackers: new Map(), myBoats: new Set(),
  bot: { ...fakeBot, entities: { 21: em, 22: calmZombie }, players: {}, username: 'NJFU_Neko', health: 20, inventory: { items: () => [] } },
};
check('索敌 远处发狂的末影人也会去打', combat.pickTarget(pickAgent)?.id === 21);
pickAgent.bot.entities = { 22: calmZombie };
check('索敌 70 格外的僵尸不去', combat.pickTarget(pickAgent) === null);
calmZombie.position = new Vec3(40, 64, 0);
check('索敌 40 格的也不去（默认 32 格）', combat.pickTarget(pickAgent) === null);
calmZombie.position = new Vec3(25, 64, 0);
check('索敌 32 格内看得见的僵尸会去打', combat.pickTarget(pickAgent)?.id === 22);
pickAgent.retreatUntil = Date.now() + 10_000;
pickAgent.bot.health = 3;
check('索敌 刚撤下来血少时先不找怪', combat.pickTarget(pickAgent) === null);
pickAgent.retreatUntil = 0;
pickAgent.bot.health = 20;
check('索敌 默认 32 格、和模式无关', flagsFor('普通').engage_radius === 32 && flagsFor('极限').engage_radius === 32);
check('索敌 末影龙、凋灵这类不受限', modes.LONG_RANGE.ender_dragon > 100 && modes.LONG_RANGE.wither > 32);
check('索敌 范围可以改', modes.combatFlags({ cfg: { ...cfg, combat: { ...cfg.combat, engage_radius: 40 } } }).engage_radius === 40);
pickAgent.unreachable = new Map([[22, Date.now() + 60_000]]);
check('索敌 走不过去的先不选', combat.pickTarget(pickAgent) === null);

const actionsMod = await import('../src/bot/actions.js');
const chestBot = { blockAt: () => ({ name: 'chest', getProperties: () => ({ type: 'left', facing: 'north' }) }) };
check('大箱子 另一半位置', actionsMod.chestPartner(chestBot, new Vec3(0, 64, 0))?.equals(new Vec3(1, 64, 0)));

const flagsIdx = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags');
const blocker = { name: 'player', metadata: Object.assign([], { [flagsIdx]: 3 }), equipment: [{ name: 'diamond_sword' }, { name: 'shield' }] };
const swinger = { name: 'player', metadata: Object.assign([], { [flagsIdx]: 0 }), equipment: [{ name: 'diamond_sword' }, { name: 'shield' }] };
check('决斗 看得出对方在举盾', combat.playerBlocking(fakeBot, blocker) && !combat.playerBlocking(fakeBot, swinger));

// 6. #设置 与 #需求
const settings = await import('../src/settings.js');
const companion = settings.findSetting('陪伴');
check('设置 找得到', companion?.path === 'behavior.companion');
check('设置 开关', settings.parseValue(companion, '开') === true && settings.parseValue(companion, '关') === false);
let badValue = false;
try {
  settings.parseValue(settings.findSetting('撤退血量'), '99');
} catch {
  badValue = true;
}
check('设置 数值范围', badValue);
check('设置 不开放危险项', !settings.SETTINGS.some((s) => /owners|commands|control|api_key|allow_eval|deny/.test(s.path)));
const { RequestStore } = await import('../src/requests.js');
const tmp = path.join(ROOT, 'runtime', 'tmp', `selftest-requests-${process.pid}.json`);
const store = new RequestStore(tmp);
const req = store.add('Steve', '学会钓鱼');
store.update(req.id, 'done', '好了');
check('需求 记录', store.get(req.id)?.status === 'done' && store.open().length === 0);
fs.rmSync(tmp, { force: true });

const { Duels } = await import('../src/bot/duel.js');
const duels = new Duels({ cfg: {} });
duels.last = { player: 'Steve', endedAt: Date.now() };
check('决斗 刚结束时的余招不扣好感', duels.isDueling('Steve', 5000) && !duels.isDueling('Steve') && !duels.isDueling('Alex', 5000));

const { Social } = await import('../src/bot/social.js');
const giftSocial = Object.create(Social.prototype);
giftSocial.drops = new Map();
const giftBot = { players: { Steve: { username: 'Steve', entity: { position: new Vec3(0.5, 64, 0.5) } } } };
giftSocial.onItemDrop(giftBot, { id: 1, position: new Vec3(0.6, 65.32, 0.7) });
giftSocial.onItemDrop(giftBot, { id: 2, position: new Vec3(1.2, 64.1, 0.5) });
check('礼物：玩家自己丢出的才算，身边怪物掉的东西不算', giftSocial.drops.get(1)?.thrower === 'Steve' && giftSocial.drops.get(2)?.thrower === null);

const { Agent } = await import('../src/agent.js');
const fakeAgentConn = Object.create(Agent.prototype);
let opened = 0;
Object.assign(fakeAgentConn, { stopping: false, connecting: false, botAlive: true, openConnection: async () => { opened += 1; } });
await fakeAgentConn.connect();
fakeAgentConn.botAlive = false;
fakeAgentConn.connecting = true;
await fakeAgentConn.connect();
fakeAgentConn.connecting = false;
await fakeAgentConn.connect();
check('重连：已经在线或者正在连时不再开第二个连接（多开会把正在用的 ViaProxy 杀掉，自己把自己踢下线）', opened === 1);

const duelModSpec = await import('../src/bot/duel.js');
const where = duelModSpec.parseWhere('Steve has the following entity data: [1537.12d, 68.0d, -34.39d]',
  'Steve has the following entity data: "minecraft:the_nether"', 'Steve has the following entity data: 1');
check('观战：查到玩家的位置、维度、游戏模式', where?.x === 1537.12 && where.y === 68 && where.z === -34.39 && where.dim === 'minecraft:the_nether' && where.mode === 'creative');
const specCmds = [];
const specDuels = new Duels({ cfg: {}, bot: { username: 'NJFU_Neko', players: { Steve: {}, Alex: {} } }, identity: { opLevel: 4 }, adminCommand: (c) => specCmds.push(c), say: () => {} });
specDuels.savePending = () => {};
specDuels.whereIs = async () => ({ x: 1, y: 64, z: 2, dim: 'minecraft:overworld', mode: 'survival' });
specDuels.active = { player: 'Steve', arena: { x: 100, y: 200, z: 100 } };
const specErr = await specDuels.spectate('Steve');
const specOk = await specDuels.spectate('Alex');
const specCmdsIn = [...specCmds];
specCmds.length = 0;
const backErr = specDuels.unspectate('Alex');
check('观战：对手自己不能观战；别人切成旁观者、传送到场地上空；#不看了 送回原处、换回原来的模式',
  specErr && specOk === null && specCmdsIn.includes('gamemode spectator Alex') && specCmdsIn.some((c) => c.startsWith('execute in minecraft:overworld run tp Alex 100.5 218 79.5'))
  && backErr === null && specCmds.includes('execute in minecraft:overworld run tp Alex 1 64 2') && specCmds.includes('gamemode survival Alex'));

const setupMod = await import('../scripts/setup.js');
const { parse: parseToml } = await import('smol-toml');
const template = fs.readFileSync(new URL('../config.example.toml', import.meta.url), 'utf8');
const wizardCfg = parseToml(setupMod.applyAnswers(template, {
  host: '127.0.0.1', port: 59010, owners: ['Summer_Adrenk', '小明'], mode: 'openai', provider: 'custom', key: 'sk-test"quote', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen',
}));
check('第一次运行的问答：只改对应段里的那一行（战斗、ViaProxy 里同名的 mode 不动），生成的配置能正常读',
  wizardCfg.server.port === 59010 && wizardCfg.chat.owners.join() === 'Summer_Adrenk,小明' && wizardCfg.brain.mode === 'openai'
  && wizardCfg.brain.openai.provider === 'custom' && wizardCfg.brain.openai.api_key === 'sk-test"quote' && wizardCfg.brain.openai.base_url === 'http://127.0.0.1:11434/v1'
  && wizardCfg.combat.mode === parseToml(template).combat.mode && wizardCfg.viaproxy.mode === 'auto');
check('找 Java 时读配置里写的路径', setupMod.getTomlValue(setupMod.setTomlValue(template, 'viaproxy', 'java', 'D:/Code/Java/bin/java.exe'), 'viaproxy', 'java') === 'D:/Code/Java/bin/java.exe');

const junk = await import('../src/bot/junk.js');
const junkBot = {
  inventory: {
    items: () => [{ name: 'rotten_flesh', count: 5 }, { name: 'diorite', count: 30 }, { name: 'cobblestone', count: 64 }, { name: 'leather_helmet', count: 1 },
      { name: 'wooden_pickaxe', count: 1 }, { name: 'diamond_pickaxe', count: 1 }, { name: 'wheat_seeds', count: 40 }, { name: 'diamond', count: 3 }],
    slots: { 5: { name: 'diamond_helmet' } },
  },
  getEquipmentDestSlot: (d) => ({ head: 5, torso: 6, legs: 7, feet: 8 })[d],
  heldItem: null,
};
const junkNames = junk.junkPlan(junkBot).map((p) => `${p.item.name}:${p.count}`).sort().join(',');
check('扔垃圾 该扔的', junkNames === 'diorite:30,leather_helmet:1,rotten_flesh:5,wheat_seeds:24,wooden_pickaxe:1');
check('扔垃圾 不扔礼物', !junk.junkPlan(junkBot, { gifts: new Set(['leather_helmet']) }).some((p) => p.item.name === 'leather_helmet'));
const tempHelmet = { name: 'leather_helmet', count: 1, components: [{ type: 'custom_data', data: { type: 'compound', value: { neko_temp: { type: 'byte', value: 1 } } } }] };
const junkBot2 = { ...junkBot, inventory: { ...junkBot.inventory, items: () => [tempHelmet, { name: 'diamond', count: 3 }] } };
check('扔垃圾 不扔决斗的临时装备（扔出去会被人捡走）', !junk.junkPlan(junkBot2).some((p) => p.item === tempHelmet));
const sweepCmds = [];
const sweeper = new Duels({ cfg: {}, bot: { username: 'NJFU_Neko' }, adminCommand: (c) => sweepCmds.push(c) });
sweeper.sweepTemp('Steve');
sweeper.sweepTemp('NJFU_Neko');
check('决斗 收掉玩家身上漏网的临时装备（不动她自己的）', sweepCmds.length === 1 && sweepCmds[0] === 'clear Steve *[custom_data~{neko_temp:1b}]');
sweepCmds.length = 0;
sweeper.lockDuel(true, ['Steve', 'NJFU_Neko']);
sweeper.lockDuel(false, ['Steve', 'NJFU_Neko']);
check('决斗锁 每人一条命令（/njfu duel on 一次只认一个名字，写两个整条失败）',
  sweepCmds.join('|') === 'njfu duel on Steve|njfu duel on NJFU_Neko|njfu duel off Steve|njfu duel off NJFU_Neko');
const duelSrc = fs.readFileSync(new URL('../src/bot/duel.js', import.meta.url), 'utf8');
check('决斗锁 代码里没有一条命令写两个名字的', !/njfu duel (on|off) \$\{[^}]+\} \$\{/.test(duelSrc));

const createBotMod = await import('../src/bot/createBot.js');
check('鞘翅 展开的动作名（新版本 start_fall_flying，不能用 mineflayer 的旧名字）', createBotMod.fallFlyingAction(registry) === 'start_fall_flying');
const enchItem = { get enchants() { return { enchantments: [{ id: registry.enchantmentsByName.sharpness.id, level: 5 }] }; } };
createBotMod.normalizeEnchants({ registry }, enchItem);
check('附魔 整理成 mineflayer 能用的列表（带附魔的工具才能挖东西）', Array.isArray(enchItem.enchants) && enchItem.enchants[0].name === 'sharpness' && enchItem.enchants[0].lvl === 5);

const { bedError } = await import('../src/bot/actions.js');
check('睡觉 mineflayer 的英文报错翻成中文（被打退够不着床时会走回去再试）',
  bedError(new Error('cant click the bed')) === '离床太远了，够不着' && bedError(new Error("there's only half bed")) === '床只剩半张');

const tactics = await import('../src/bot/duelTactics.js');
const nether = tactics.kitArmor(kits.duelLevel('cheat6'));
const crystalAt = (d) => tactics.blastDamage(6, d, nether);
check('爆炸伤害（原版公式，下界合金保护 IV）：贴着水晶 3 格用手打自己挨十几点，8 格外只挨两三点，他在水晶旁边挨二十来点',
  nether.armor === 20 && nether.toughness === 12 && nether.epf === 16
  && crystalAt(3) > 10 && crystalAt(3) < 16 && crystalAt(8) < 3 && crystalAt(1.2) > 18 && tactics.blastDamage(4, 8, nether) === 0);
const fakeTacticsBot = (blocked) => ({
  entity: { position: new Vec3(0.5, 201, 0.5) }, health: 20, entities: {},
  world: { raycast: () => (blocked ? { name: 'obsidian' } : null) },
});
const tFar = new tactics.DuelTactics({ bot: fakeTacticsBot(false), events: { push() {} } }, {}, kits.duelLevel('cheat6'));
const him = { position: new Vec3(11.5, 201, 0.5) };
check('水晶：他在旁边、我在 10 格外才射；他在旁边但我也只隔 2 格就不射',
  tFar.worth({ position: new Vec3(10.5, 201, 0.5) }, him) && !tFar.worth({ position: new Vec3(2.5, 201, 0.5) }, { position: new Vec3(3.5, 201, 0.5) }));
const tWall = new tactics.DuelTactics({ bot: fakeTacticsBot(true), events: { push() {} } }, {}, kits.duelLevel('cheat6'));
check('水晶：我和水晶之间垒了方块（射线都被挡住）就算安全', tWall.shielded(new Vec3(2.5, 201, 0.5)) && !tFar.shielded(new Vec3(2.5, 201, 0.5)));

const duelMod = await import('../src/bot/duel.js');
check('决斗时长：默认 15 分钟，作弊档 30 分钟',
  duelMod.duelMinutes(kits.duelLevel('easy'), {}) === 15 && duelMod.duelMinutes(kits.duelLevel('hard6'), {}) === 15
  && duelMod.duelMinutes(kits.duelLevel('cheat3'), {}) === 30 && duelMod.duelMinutes(kits.duelLevel('normal'), { time_limit_minutes: 5 }) === 5);
check('决斗倒计时的文字', duelMod.clockText(899) === '14:59' && duelMod.clockText(60) === '1:00' && duelMod.clockText(9) === '0:09');
const clockCmds = [];
const clock = new duelMod.DuelClock({ quietCommands: true, adminCommand: (c) => clockCmds.push(c), say: () => {} }, 'Steve', kits.duelLevel('hard5'), 900_000);
clock.start();
check('决斗倒计时：屏幕上方的血条只给对手看，总长 900 秒',
  clockCmds.includes('bossbar set njfu:duel max 900') && clockCmds.includes('bossbar set njfu:duel players Steve')
  && clockCmds.some((c) => c.startsWith('bossbar set njfu:duel name ') && c.includes('剩余 15:00')));
clockCmds.length = 0;
clock.end = Date.now() + 59_500;
clock.tick();
check('决斗倒计时：最后 1 分钟变红，屏幕中间提示', clockCmds.includes('bossbar set njfu:duel color red') && clockCmds.some((c) => c.startsWith('title Steve title ') && c.includes('最后 1 分钟')));
clockCmds.length = 0;
clock.end = Date.now() + 9_500;
clock.tick();
clock.stop();
check('决斗倒计时：最后 10 秒大字倒数，结束收掉血条', clockCmds.some((c) => c.startsWith('title Steve title ') && c.includes('"text":"10"')) && clockCmds.includes('bossbar remove njfu:duel'));
const uiMod = await import('../src/bot/ui.js');
const runBtn = uiMod.toComponent({ target: { serverVersion: '26.2' } }, { text: '[认输]', run: '/njfu ui surrender' });
check('聊天按钮：点一下直接执行命令（认输）', runBtn.click_event?.action === 'run_command' && runBtn.click_event.command === '/njfu ui surrender' && view.MENU_ACTIONS.surrender?.text === '#认输');

const arenaMod = await import('../src/bot/duelArena.js');
const arenaAt = { x: 1498, y: 200, z: -25 };
// 假的世界：只有 blocks 里写了的位置有方块（1 = 石头），别的都是空气
const blocks = new Map();
const stateAt = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? 0;
const fakeArenaBot = {
  registry: { blocksByName: { air: { defaultState: 0 }, cave_air: { defaultState: 900 }, void_air: { defaultState: 901 } } },
  game: { dimension: 'overworld' },
  world: {
    getColumnAt: (v) => {
      const [x, z] = [v.x, v.z];
      return { getBlockStateId: (l) => stateAt(x, l.y, z) };
    },
    getBlockStateId: (v) => stateAt(v.x, v.y, v.z),
  },
  blockAt: (v) => ({ name: stateAt(v.x, v.y, v.z) ? 'stone' : 'air' }),
};
const arenaCmds = [];
const arenaAgent = { bot: fakeArenaBot, adminCommand: (c) => arenaCmds.push(c.replace(/^execute in minecraft:overworld run /, '')) };
const fillVolume = (c) => {
  const n = c.split(' ').slice(1, 7).map(Number);
  return (Math.abs(n[3] - n[0]) + 1) * (Math.abs(n[4] - n[1]) + 1) * (Math.abs(n[5] - n[2]) + 1);
};
check('决斗场 默认原地上空，名字和 #设置 里的选项一致',
  arenaMod.arenaMode(/^arena = "(.+)"$/m.exec(fs.readFileSync(new URL('../config.example.toml', import.meta.url), 'utf8'))?.[1]) === 'here'
  && JSON.stringify(Object.values(arenaMod.ARENA_OPTIONS).sort()) === JSON.stringify([...settings.findSetting('决斗场').options].sort()));
check('决斗场 #决斗 后面的位置词', arenaMod.arenaMode('原地上空') === 'here' && arenaMod.arenaMode('家上空') === 'home' && arenaMod.arenaMode('不用') === 'off' && arenaMod.arenaMode('困难Ⅲ') === null);
check('决斗场 高度：y=200 起，比脚下高 40 格，有东西挡着每次抬 30 格，最高 289',
  JSON.stringify(arenaMod.arenaHeights(68)) === '[200,230,260]' && JSON.stringify(arenaMod.arenaHeights(180)) === '[220,250,280]' && arenaMod.arenaHeights(250).length === 0);
check('决斗场 上面全是空气', (await arenaMod.highestBlock(fakeArenaBot, arenaAt, 200)) === -Infinity);
blocks.set('1548,250,-25', 1); // 墙的位置上有东西（比如别人的空中建筑）
blocks.set('1560,290,-25', 1); // 场地外面的不算
const top1 = await arenaMod.highestBlock(fakeArenaBot, arenaAt, 200);
blocks.set('1500,275,-20', 1); // 场地正中间更高的地方也有
const top2 = await arenaMod.highestBlock(fakeArenaBot, arenaAt, 200);
check('决斗场 搭之前扫一遍：有方块就往上抬，抬不上去就不搭',
  top1 === 250 && arenaMod.arenaHeights(68).find((h) => h > top1) === 260 && top2 === 275 && arenaMod.arenaHeights(68).find((h) => h > top2) === undefined);
blocks.clear();
await arenaMod.buildArena(arenaAgent, arenaAt, { gap: 0, settle: 0 });
check('决斗场 搭的时候只填空气的位置（replace air），每条 fill 不超过 32768 格',
  arenaCmds.length > 0 && arenaCmds.every((c) => c.endsWith(' replace air') && fillVolume(c) <= 32768));
check('决斗场 100×100 地板、屏障墙到 y=319',
  arenaCmds.includes('fill 1448 200 -75 1547 200 24 obsidian replace air') && arenaCmds.some((c) => c.includes(' 319 ') && c.includes('barrier')));
arenaCmds.length = 0;
blocks.set('1500,201,-20', 1).set('1501,203,-20', 1).set('1520,240,0', 1); // 打完留下的东西
await arenaMod.removeArena(arenaAgent, arenaAt, { gap: 0, settle: 0 });
check('决斗场 拆：先清掉落物，再清有东西的那几层，最后拆墙和地板',
  arenaCmds[0].startsWith('kill @e[type=minecraft:item,') && arenaCmds.includes('fill 1448 201 -75 1547 203 24 air') && arenaCmds.includes('fill 1448 240 -75 1547 240 24 air')
  && !arenaCmds.some((c) => c.includes(' 204 ') && c.startsWith('fill 1448 204')) && arenaCmds[arenaCmds.length - 1] === 'fill 1448 200 -75 1547 200 24 air'
  && arenaCmds.filter((c) => c.includes(' 319 ') && c.endsWith(' air')).length === 4 && arenaCmds.every((c) => !c.startsWith('fill') || fillVolume(c) <= 32768));
blocks.clear();
const seats = arenaMod.arenaSeats(arenaAt);
check('决斗场 两个座位相距 20 格、面对面，都在场地里',
  Math.abs(seats[0].z - seats[1].z) === 20 && seats[0].yaw === 0 && seats[1].yaw === 180 && seats.every((st) => arenaMod.inArena(arenaAt, st)) && !arenaMod.inArena(arenaAt, { x: 1498, y: 150, z: -25 }));

// 7. 面板模组通知、OpenAI 兼容接口、打码
const chatMod = await import('../src/bot/chat.js');
check('面板通知 菜单按钮', JSON.stringify(chatMod.parseUiNotice('[NJFU-UI] do Steve pet')) === JSON.stringify({ action: 'do', player: 'Steve', what: 'pet' }));
check('面板通知 右键和伪造', chatMod.parseUiNotice('[NJFU-UI] menu Steve')?.action === 'menu' && chatMod.parseUiNotice('<Steve> [NJFU-UI] do Steve stop') === null);
const { ServerInfo } = await import('../src/bot/serverInfo.js');
const si = new ServerInfo({});
si.onCommands({ rootIndex: 0, nodes: [{ children: [1, 4] }, { extraNodeData: { name: 'njfu' }, children: [2, 3] }, { extraNodeData: { name: 'quiet' } },
  { extraNodeData: { name: 'ui' } }, { extraNodeData: { name: 'tp' } }] }, new Set(['tp']));
check('面板模组 识别子命令', si.njfuCommands.includes('quiet') && si.njfuCommands.includes('ui'));

const oa = await import('../src/brain/openaiBrain.js');
const fn = oa.openAiTools([{ name: 'say', description: '说话', input_schema: { type: 'object', properties: {} } }])[0];
check('OpenAI 工具格式', fn.type === 'function' && fn.function.name === 'say' && fn.function.parameters.type === 'object');
check('OpenAI 服务商预设', oa.PROVIDERS.deepseek.base_url === 'https://api.deepseek.com' && oa.PROVIDERS.openai.env === 'OPENAI_API_KEY');
const brainAgent = {
  cfg: { brain: { openai: { provider: 'custom', base_url: 'http://localhost:9/v1', model: 'test-model', max_tokens: 1000 } }, commands: cfg.commands, logging: {} },
  on() {}, events: { push() {} },
};
const oaBrain = new oa.OpenAiBrain(brainAgent);
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
  if (sent.length === 1) {
    return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }), { status: 400 });
  }
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '好' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200 });
};
try {
  const reply = await oaBrain.create([{ role: 'user', content: 'hi' }], new AbortController().signal);
  check('OpenAI 请求格式', sent[0].url === 'http://localhost:9/v1/chat/completions' && sent[0].body.model === 'test-model' && sent[0].body.tools.length > 10
    && sent[0].body.tool_choice === 'auto' && sent[0].body.max_tokens === 1000 && !sent[0].auth);
  check('OpenAI 不认的参数自动换', sent.length === 2 && sent[1].body.max_completion_tokens === 1000 && !('max_tokens' in sent[1].body) && reply.choices[0].message.content === '好');
} finally {
  globalThis.fetch = realFetch;
}
const secretsMod = await import('../src/secrets.js');
check('打码 OpenAI / DeepSeek 的 Key', !secretsMod.redact('用 sk-proj-AbCdEfGhIjKlMnOpQrStUv123456 调用').includes('AbCdEfGhIjKlMnOpQrStUv')
  && !secretsMod.redact('sk-0123456789abcdef0123456789abcdef').includes('0123456789abcdef0123'));

console.log(`${failed ? '✗' : '✓'} 自测：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`);
process.exit(failed ? 1 : 0);
