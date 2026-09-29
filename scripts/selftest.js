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
check('菜单 按钮', menu.actions.length >= 10 && !JSON.stringify(menu).includes('/trigger'));
check('菜单 行动按钮填命令', menu.actions.some((a) => a.action.type === 'suggest_command' && a.action.command === '#过来'));

console.log(`${failed ? '✗' : '✓'} 自测：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`);
process.exit(failed ? 1 : 0);
