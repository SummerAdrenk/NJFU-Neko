// 游戏里的 #设置：主人可以直接开关一部分行为，保存在 runtime/overrides.json（优先于 config.toml）。
// 只开放不影响安全的选项：命令权限、主人名单、控制接口、密钥等只能在 config.toml 里改。
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME } from './paths.js';

export const OVERRIDES_FILE = path.join(RUNTIME, 'overrides.json');

export const SETTINGS = [
  { key: '陪伴', path: 'behavior.companion', type: 'bool', desc: '没事时陪在主人身边' },
  { key: '捡东西', path: 'behavior.pickup_items', type: 'bool', desc: '自动捡身边的掉落物' },
  { key: '用箱子', path: 'behavior.use_chests', type: 'bool', desc: '缺装备、吃的时去记得的箱子拿' },
  { key: '翻箱子', path: 'behavior.survey_chests', type: 'bool', desc: '闲着时翻看附近没看过的箱子（只看不拿）' },
  { key: '自动吃', path: 'behavior.auto_eat', type: 'bool', desc: '饿了、受伤时自己吃东西' },
  { key: '自卫', path: 'behavior.self_defense', type: 'bool', desc: '被怪打会还手' },
  { key: '帮忙打怪', path: 'behavior.assist_owner', type: 'bool', desc: '主人打怪时过去帮忙' },
  { key: '保护主人', path: 'behavior.protect_owner', type: 'bool', desc: '主人被怪打时去保护' },
  { key: '问睡觉', path: 'behavior.ask_to_sleep', type: 'bool', desc: '有人上床时问要不要一起睡' },
  { key: '垫方块', path: 'behavior.scaffold', type: 'bool', desc: '走路时搭桥、垫高' },
  { key: '防摔', path: 'behavior.fall_safety', type: 'bool', desc: '落地水、鞘翅、落地船' },
  { key: '传送距离', path: 'behavior.teleport_distance', type: 'int', min: 0, max: 256, desc: '离主人多远就传送过去（0 关闭）' },
  { key: '撤退血量', path: 'behavior.retreat_health', type: 'int', min: 0, max: 19, desc: '血量低于这个值就撤退' },
  { key: '跳劈', path: 'combat.crits', type: 'bool', desc: '跳起来下落时出手打暴击' },
  { key: '盾牌', path: 'combat.shield', type: 'bool', desc: '用盾牌格挡' },
  { key: '船困怪', path: 'combat.boat_trap', type: 'bool', desc: '放船困住打不过的近战怪' },
  { key: '弓箭', path: 'combat.bow', type: 'bool', desc: '用弓箭' },
  { key: '近战苦力怕', path: 'combat.creeper_melee', type: 'bool', desc: '拿着武器时对苦力怕打了就跑' },
  { key: '药水', path: 'combat.potions', type: 'bool', desc: '血少、着火时用药水' },
  { key: '垫高躲怪', path: 'combat.pillar', type: 'bool', desc: '被围住时搭柱子躲上去' },
  { key: '问候', path: 'emotes.greetings', type: 'bool', desc: '上线下线问候、早晚提醒' },
  { key: '小动作', path: 'emotes.idle_emotes', type: 'bool', desc: '闲着时做点小动作' },
  { key: '互动', path: 'emotes.interactions', type: 'bool', desc: '摸头、捡木棍等互动' },
  { key: '特效', path: 'emotes.effects', type: 'bool', desc: '爱心粒子、猫叫声（需要面板模组）' },
  { key: '回应所有人', path: 'chat.respond_to_all', type: 'bool', desc: '回应所有人的每一句话' },
  { key: '接话秒数', path: 'chat.follow_up_seconds', type: 'int', min: 0, max: 600, desc: '回复某人后多少秒内他的话也算对她说' },
  { key: '决斗', path: 'duel.enabled', type: 'bool', desc: '允许 PVP 决斗' },
];

const getPath = (obj, p) => p.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, p, value) {
  const keys = p.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

export const settingValue = (cfg, s) => getPath(cfg, s.path);
export const findSetting = (name) => SETTINGS.find((s) => s.key === name || s.path === name || s.path.split('.').pop() === name) ?? null;

export function parseValue(s, raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (s.type === 'bool') {
    if (['开', '打开', '开启', 'on', 'true', '是', '1', '要'].includes(v)) return true;
    if (['关', '关闭', 'off', 'false', '否', '0', '不要'].includes(v)) return false;
    throw new Error(`「${s.key}」只能设成 开 或 关`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < s.min || n > s.max) throw new Error(`「${s.key}」要填 ${s.min}～${s.max} 的整数`);
  return n;
}

function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// 启动时把游戏里改过的设置盖到配置上（只认白名单里的项）。返回应用了几项。
export function applyOverrides(cfg) {
  const saved = readOverrides();
  let n = 0;
  for (const s of SETTINGS) {
    if (!(s.path in saved)) continue;
    try {
      setPath(cfg, s.path, parseValue(s, saved[s.path]));
      n += 1;
    } catch {
      // 文件被手改坏的项忽略
    }
  }
  return n;
}

export function saveOverride(cfg, s, value) {
  const saved = readOverrides();
  saved[s.path] = value;
  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, `${JSON.stringify(saved, null, 2)}\n`);
  setPath(cfg, s.path, value);
}

// 清掉游戏里改过的设置，恢复成 fresh（重新读取的 config.toml）里的值
export function resetOverrides(cfg, fresh) {
  const saved = readOverrides();
  for (const s of SETTINGS) if (s.path in saved) setPath(cfg, s.path, getPath(fresh, s.path));
  fs.rmSync(OVERRIDES_FILE, { force: true });
  return Object.keys(saved).length;
}
