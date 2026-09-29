// 贴图索引：读取客户端 jar 里的贴图文件清单，决定某个物品在聊天/对话框里该用哪张图（文本组件的 atlas 精灵）。
// 1.21.9 起文本支持 {"object":"atlas","atlas":…,"sprite":…}；26.x 物品贴图在 minecraft:items 图集，方块贴图在 minecraft:blocks 图集。
import fs from 'node:fs';
import path from 'node:path';
import { getLog } from '../log.js';

const log = getLog('贴图');

// 只读 zip 的中央目录（文件名列表），不解压内容。
function listZipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 70_000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是 zip/jar 文件');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const names = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

// 没配置 ui.client_jar 时，从投影原理图目录推断（版本隔离时 schematics 在 versions/版本名/ 下）。
function guessJar(cfg) {
  if (cfg.ui.client_jar) return cfg.ui.client_jar;
  const dir = cfg.mods.litematica_schematics;
  if (!dir) return null;
  const versionDir = path.dirname(dir);
  const jar = path.join(versionDir, `${path.basename(versionDir)}.jar`);
  return fs.existsSync(jar) ? jar : null;
}

// 方块物品找不到同名贴图时的替代：台阶/楼梯/墙等用原材料贴图，功能方块用正面或侧面。
function blockCandidates(name) {
  const out = [name, `${name}_front`, `${name}_side`, `${name}_top`];
  const base = name.replace(/_(slab|stairs|wall|fence|fence_gate|pressure_plate|button|door|trapdoor|sign|hanging_sign)$/, '');
  if (base !== name) out.push(base, `${base}s`, `${base}_planks`, `${base}_block`);
  if (name.endsWith('_wood')) out.push(name.replace(/_wood$/, '_log'));
  if (name.endsWith('_hyphae')) out.push(name.replace(/_hyphae$/, '_stem'));
  return out;
}

export class TextureIndex {
  constructor(cfg) {
    this.items = new Set();
    this.blocks = new Set();
    this.gui = new Set();
    this.ready = false;
    const jar = guessJar(cfg);
    if (!jar) return;
    try {
      for (const name of listZipEntries(jar)) {
        let m = /^assets\/minecraft\/textures\/item\/([a-z0-9_]+)\.png$/.exec(name);
        if (m) {
          this.items.add(m[1]);
          continue;
        }
        m = /^assets\/minecraft\/textures\/block\/([a-z0-9_]+)\.png$/.exec(name);
        if (m) {
          this.blocks.add(m[1]);
          continue;
        }
        m = /^assets\/minecraft\/textures\/gui\/sprites\/([a-z0-9_/]+)\.png$/.exec(name);
        if (m) this.gui.add(m[1]);
      }
      this.ready = this.items.size > 0;
      log.info(`读取了客户端贴图清单：物品 ${this.items.size}、方块 ${this.blocks.size}、界面 ${this.gui.size}（${jar}）`);
    } catch (err) {
      log.warn(`读取客户端 jar 失败（${jar}）：${err.message}，背包里的物品将以文字显示`);
    }
  }

  // 物品图标的文本组件；找不到贴图时返回 null（调用方改用文字）。
  itemSprite(name, fallback) {
    if (!this.ready) return null;
    const fb = fallback ? { fallback: { text: fallback } } : {};
    if (this.items.has(name)) return { object: 'atlas', atlas: 'minecraft:items', sprite: `minecraft:item/${name}`, ...fb };
    const block = blockCandidates(name).find((c) => this.blocks.has(c));
    if (block) return { object: 'atlas', atlas: 'minecraft:blocks', sprite: `minecraft:block/${block}`, ...fb };
    return null;
  }

  guiSprite(path, fallback) {
    if (!this.ready || !this.gui.has(path)) return fallback ? { text: fallback } : null;
    return { object: 'atlas', atlas: 'minecraft:gui', sprite: `minecraft:${path}`, ...(fallback ? { fallback: { text: fallback } } : {}) };
  }
}
