// 识别服务器：品牌（fabric / paper / vanilla…）、装了哪些模组、有哪些非原版命令。
// 线索来自：频道注册（minecraft:register、c:register）、命令树、标签和注册表里的命名空间。
import mcDataLoader from 'minecraft-data';
import { getLog } from '../log.js';

const log = getLog('服务器');

// 已知模组：命名空间 → 名称、类型（server 服务端有功能 / client 纯客户端 / lib 前置库）、猫娘能怎么用。
const KNOWN_MODS = {
  fabric: { name: 'Fabric API', kind: 'lib' },
  'fabric-api': { name: 'Fabric API', kind: 'lib' },
  c: { name: 'Fabric 通用标签', kind: 'lib', hidden: true },
  carpet: { name: 'Carpet（地毯）', kind: 'server', use: '/player 召唤和操控假人、/counter 漏斗计数、/log 订阅日志（tps、mobcaps）、/spawn 刷怪统计、/info block 查方块、/distance 测距、/draw 画几何体、/script 运行脚本；规则用 /carpet 查看和修改（需要管理员）' },
  'carpet-extra': { name: 'Carpet Extra', kind: 'server', use: '更多 /carpet 规则' },
  carpetextra: { name: 'Carpet Extra', kind: 'server', use: '更多 /carpet 规则' },
  'carpet-tis-addition': { name: 'Carpet TIS Addition', kind: 'server', use: '/lifetime /raycount /manipulate /info 等调试命令' },
  carpettisaddition: { name: 'Carpet TIS Addition', kind: 'server', use: '/lifetime /raycount /manipulate 等调试命令' },
  gca: { name: 'Gugle Carpet Addition', kind: 'server', use: '增强 Carpet 假人（假人背包、假人自动操作等）' },
  'gugle-carpet-addition': { name: 'Gugle Carpet Addition', kind: 'server', use: '增强 Carpet 假人（假人背包、假人自动操作等）' },
  servux: { name: 'Servux', kind: 'server', use: '给投影、MiniHUD 提供服务端数据' },
  syncmatica: { name: 'Syncmatica', kind: 'server', use: '在多人服务器里共享投影' },
  litematica: { name: '投影 Litematica', kind: 'client', use: '界面在玩家客户端；猫娘可以读取 schematics 文件夹里的 .litematic 原理图并照着建' },
  minihud: { name: 'MiniHUD', kind: 'client' },
  tweakeroo: { name: 'Tweakeroo', kind: 'client' },
  tweakermore: { name: 'TweakerMore', kind: 'client' },
  itemscroller: { name: 'Item Scroller', kind: 'client' },
  malilib: { name: 'MaLiLib', kind: 'lib' },
  jade: { name: 'Jade', kind: 'client', use: '准心信息显示在玩家客户端' },
  xaerominimap: { name: 'Xaero 小地图', kind: 'client', use: '可以把坐标报给玩家让他在地图上标记' },
  xaeroworldmap: { name: 'Xaero 世界地图', kind: 'client' },
  appleskin: { name: 'AppleSkin', kind: 'client' },
  inventoryprofilesnext: { name: 'Inventory Profiles Next', kind: 'client' },
  ipnext: { name: 'Inventory Profiles Next', kind: 'client' },
  quickshulker: { name: 'Quick Shulker', kind: 'server', use: '手持潜影盒右键直接打开' },
  mcwifipnp: { name: 'mcwifipnp（局域网增强）', kind: 'server' },
  placeholder_api: { name: 'Placeholder API', kind: 'lib' },
  'placeholder-api': { name: 'Placeholder API', kind: 'lib' },
  voicechat: { name: 'Simple Voice Chat', kind: 'server' },
  worldedit: { name: 'WorldEdit（创世神）', kind: 'server', use: '//wand //set //replace 等（需要权限）' },
  luckperms: { name: 'LuckPerms', kind: 'server' },
  essentials: { name: 'EssentialsX', kind: 'server', use: '/home /spawn /tpa 等' },
  create: { name: '机械动力 Create', kind: 'content', use: '新方块猫娘看不懂' },
};

const EXTRA_VANILLA = ['dialog', 'fetchprofile', 'version', 'stopwatch', 'test', 'rotate', 'waypoint', 'swing', 'transfer', 'teleport', 'experience', 'enchant', 'ride', 'damage'];
// vv / viaproxy 是协议转换代理自己的频道，不算服务器的模组
const SKIP_NAMESPACES = new Set(['minecraft', 'brigadier', 'realms', 'java', 'bukkit', 'vv', 'viaversion', 'viaproxy', 'viabackwards']);

function vanillaCommands(version) {
  try {
    const names = mcDataLoader(version)?.commands?.root?.children?.map((c) => c.name) ?? [];
    return new Set([...names, ...EXTRA_VANILLA]);
  } catch {
    return new Set(EXTRA_VANILLA);
  }
}

function readVarInt(buf, pos) {
  let value = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [value, pos];
    shift += 7;
    if (shift > 35) throw new Error('VarInt 太长');
  }
}

function readString(buf, pos) {
  const [len, p] = readVarInt(buf, pos);
  return [buf.toString('utf8', p, p + len), p + len];
}

export class ServerInfo {
  constructor(agent) {
    this.agent = agent;
    this.reset();
  }

  reset() {
    this.brand = null;
    this.channels = new Set();
    this.namespaces = new Map();
    this.modCommands = [];
    this.allCommands = [];
    this.njfuCommands = [];
  }

  note(namespace, source) {
    const ns = String(namespace).toLowerCase();
    if (!ns || SKIP_NAMESPACES.has(ns)) return;
    if (!this.namespaces.has(ns)) this.namespaces.set(ns, new Set());
    this.namespaces.get(ns).add(source);
  }

  attach(bot) {
    this.reset();
    const client = bot._client;
    const vanilla = vanillaCommands(bot.version);
    client.on('custom_payload', (packet) => {
      try {
        this.onPayload(packet);
      } catch (err) {
        log.debug(`解析 ${packet.channel} 失败：${err.message}`);
      }
    });
    client.on('declare_commands', (packet) => {
      try {
        this.onCommands(packet, vanilla);
      } catch (err) {
        log.debug(`解析命令树失败：${err.message}`);
      }
    });
    client.on('tags', (packet) => {
      for (const group of packet.tags ?? []) {
        for (const tag of group.tags ?? []) this.note(String(tag.tagName).split(':')[0], 'tag');
      }
    });
    client.on('registry_data', (packet) => {
      for (const entry of packet.entries ?? []) this.note(String(entry.key).split(':')[0], 'registry');
    });
    bot.once('spawn', () => setTimeout(() => this.report(), 4000));
  }

  onPayload({ channel, data }) {
    this.note(channel.split(':')[0], 'channel');
    if (channel === 'minecraft:brand') {
      // 去掉 § 格式代码；经过 ViaProxy 时品牌会变成 “ViaProxy (…) -> fabric (26.2)”，只保留真实服务器那部分
      const raw = readString(data, 0)[0].replace(/§./g, '');
      this.brand = raw.includes('->') ? raw.split('->').pop().trim() : raw;
    } else if (channel === 'minecraft:register') {
      for (const name of data.toString('utf8').split('\0').filter(Boolean)) {
        this.channels.add(name);
        this.note(name.split(':')[0], 'channel');
      }
    } else if (channel === 'c:register') {
      let pos = readVarInt(data, 0)[1];
      pos = readString(data, pos)[1];
      let count;
      [count, pos] = readVarInt(data, pos);
      for (let i = 0; i < count; i++) {
        let name;
        [name, pos] = readString(data, pos);
        this.channels.add(name);
        this.note(name.split(':')[0], 'channel');
      }
    }
  }

  onCommands(packet, vanilla) {
    const root = packet.nodes?.[packet.rootIndex];
    const names = (root?.children ?? [])
      .map((i) => packet.nodes[i]?.extraNodeData?.name)
      .filter(Boolean);
    this.allCommands = names.sort();
    const njfu = (root?.children ?? []).map((i) => packet.nodes[i]).find((n) => n?.extraNodeData?.name === 'njfu');
    this.njfuCommands = (njfu?.children ?? []).map((i) => packet.nodes[i]?.extraNodeData?.name).filter(Boolean);
    this.modCommands = names.filter((n) => !vanilla.has(n) && !n.includes(':')).sort();
    for (const n of names) if (n.includes(':')) this.note(n.split(':')[0], 'command');
    log.fileOnly('debug', `可用命令 ${names.length} 个，非原版：${this.modCommands.join(' ') || '无'}`);
  }

  mods() {
    const list = [];
    const seen = new Set();
    for (const [ns, sources] of this.namespaces) {
      const known = KNOWN_MODS[ns];
      if (known?.hidden) continue;
      const name = known?.name ?? ns;
      if (seen.has(name)) continue;
      seen.add(name);
      list.push({ id: ns, name, kind: known?.kind ?? 'unknown', use: known?.use ?? null, sources: [...sources] });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  report() {
    const mods = this.mods();
    const detail = `${this.brand ?? '未知'}；模组 ${mods.length} 个：${mods.map((m) => m.name).join('、') || '无'}；非原版命令：${this.modCommands.map((c) => `/${c}`).join(' ') || '无'}`;
    this.agent.events.push('server', { detail, brand: this.brand, mods: mods.map((m) => m.id), commands: this.modCommands });
  }

  // 给大脑看的简要说明。
  describe() {
    const mods = this.mods();
    const kinds = { server: '服务端功能', client: '客户端界面', lib: '前置库', content: '内容模组', unknown: '未知' };
    const lines = [`服务器类型：${this.brand ?? '未知'}（${this.agent.target?.serverVersion ?? '未知版本'}）`];
    if (mods.length) {
      lines.push('检测到的模组：');
      for (const m of mods.filter((x) => x.kind !== 'lib')) lines.push(`- ${m.name}【${kinds[m.kind]}】${m.use ? `：${m.use}` : ''}`);
    } else {
      lines.push('没有检测到模组（原版服务器，或模组没有暴露痕迹）');
    }
    if (this.modCommands.length) lines.push(`非原版命令：${this.modCommands.map((c) => `/${c}`).join(' ')}`);
    return lines.join('\n');
  }
}
