#!/usr/bin/env node
// 把一张皮肤图片做成资源包，让离线登录的猫娘显示成这张皮肤。
//
// 原理：离线玩家没有正版皮肤，游戏按玩家 UUID 从 18 张默认皮肤（9 个角色 × 粗/细手臂）里挑一张。
// 算出猫娘被分到哪一张，用资源包替换那张图就行了——不需要装任何模组。
// 注意：只有启用了这个资源包的玩家能看到；默认皮肤恰好相同的其他离线玩家也会变成这个样子。
//
// 用法：node scripts/skin-pack.js [皮肤.png] [--out 资源包目录] [--name 登录名] [--uuid UUID] [--model slim|wide]
//   --model 指定这张皮肤原本是细手臂（slim）还是粗手臂（wide），不填则自动判断。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from '../src/png.js';
import { loadConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SKIN = path.join(root, 'assets', 'skins', 'neko-maid.png');
const PACK_NAME = 'NJFU猫娘皮肤';
const NAMES = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

export function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// 与游戏里 DefaultPlayerSkin.get(uuid) 相同：Math.floorMod(uuid.hashCode(), 18)。
export function defaultSkinOf(uuid) {
  const hex = uuid.replace(/-/g, '');
  const hilo = BigInt(`0x${hex.slice(0, 16)}`) ^ BigInt(`0x${hex.slice(16)}`);
  const hash = Number(BigInt.asIntN(32, (hilo >> 32n) ^ hilo));
  const slot = ((hash % 18) + 18) % 18;
  return { slot, model: slot < 9 ? 'slim' : 'wide', name: NAMES[slot % 9] };
}

// ── 皮肤图像处理 ─────────────────────────────────────────

const index = (img, x, y) => (y * img.width + x) * 4;

function crop(img, x, y, w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let j = 0; j < h; j++) img.data.copy(px, j * w * 4, index(img, x, y + j), index(img, x + w, y + j));
  return { w, h, px };
}

function paste(img, x, y, face) {
  for (let j = 0; j < face.h; j++) face.px.copy(img.data, index(img, x, y + j), j * face.w * 4, (j + 1) * face.w * 4);
}

function clear(img, x, y, w, h) {
  for (let j = 0; j < h; j++) img.data.fill(0, index(img, x, y + j), index(img, x + w, y + j));
}

function flipX(face) {
  const out = { w: face.w, h: face.h, px: Buffer.alloc(face.px.length) };
  for (let j = 0; j < face.h; j++) {
    for (let i = 0; i < face.w; i++) face.px.copy(out.px, (j * face.w + (face.w - 1 - i)) * 4, (j * face.w + i) * 4, (j * face.w + i + 1) * 4);
  }
  return out;
}

// 改变面的宽度：变宽时复制中间一列，变窄时去掉中间一列。
function resizeWidth(face, to) {
  if (face.w === to) return face;
  const cols = [...Array(face.w).keys()];
  if (to > face.w) cols.splice(1, 0, 1);
  else cols.splice(1, 1);
  const out = { w: to, h: face.h, px: Buffer.alloc(to * face.h * 4) };
  for (let j = 0; j < face.h; j++) {
    cols.forEach((c, i) => face.px.copy(out.px, (j * to + i) * 4, (j * face.w + c) * 4, (j * face.w + c + 1) * 4));
  }
  return out;
}

// 手臂（宽 w、深 4、高 12）在贴图上的各个面。
function readLimb(img, u, v, w) {
  return {
    top: crop(img, u + 4, v, w, 4),
    bottom: crop(img, u + 4 + w, v, w, 4),
    right: crop(img, u, v + 4, 4, 12),
    front: crop(img, u + 4, v + 4, w, 12),
    left: crop(img, u + 4 + w, v + 4, 4, 12),
    back: crop(img, u + 8 + w, v + 4, w, 12),
  };
}

function writeLimb(img, u, v, w, f) {
  clear(img, u, v, 16, 16);
  paste(img, u + 4, v, f.top);
  paste(img, u + 4 + w, v, f.bottom);
  paste(img, u, v + 4, f.right);
  paste(img, u + 4, v + 4, f.front);
  paste(img, u + 4 + w, v + 4, f.left);
  paste(img, u + 8 + w, v + 4, f.back);
}

const ARMS = [[40, 16], [40, 32], [32, 48], [48, 48]];

// 细手臂皮肤在手臂贴图右侧留有空白列；粗手臂皮肤这里是实心的。
// 按不透明像素的比例判断，能容忍个别杂点。
function isSlim(img) {
  let opaque = 0;
  let total = 0;
  for (let y = 20; y < 32; y++) {
    for (const x of [54, 55]) {
      total += 1;
      if (img.data[index(img, x, y) + 3] > 0) opaque += 1;
    }
  }
  for (let y = 52; y < 64; y++) {
    for (const x of [46, 47]) {
      total += 1;
      if (img.data[index(img, x, y) + 3] > 0) opaque += 1;
    }
  }
  return opaque < total / 2;
}

function convertArms(img, from, to) {
  for (const [u, v] of ARMS) {
    const f = readLimb(img, u, v, from);
    for (const key of Object.keys(f)) if (['top', 'bottom', 'front', 'back'].includes(key)) f[key] = resizeWidth(f[key], to);
    writeLimb(img, u, v, to, f);
  }
}

// 老式 64×32 皮肤：左手左脚由右手右脚镜像得到。
function upgradeLegacy(img) {
  const out = { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4) };
  img.data.copy(out.data, 0, 0, 64 * 32 * 4);
  const mirrorLimb = (fromU, fromV, toU, toV) => {
    const f = readLimb(out, fromU, fromV, 4);
    writeLimb(out, toU, toV, 4, {
      top: flipX(f.top), bottom: flipX(f.bottom), right: flipX(f.left), front: flipX(f.front), left: flipX(f.right), back: flipX(f.back),
    });
  };
  mirrorLimb(0, 16, 16, 48);
  mirrorLimb(40, 16, 32, 48);
  return out;
}

function faceIcon(img) {
  const scale = 16;
  const icon = { width: 128, height: 128, data: Buffer.alloc(128 * 128 * 4) };
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const hat = index(img, 40 + x, 8 + y);
      const base = index(img, 8 + x, 8 + y);
      const src = img.data[hat + 3] > 0 ? hat : base;
      for (let j = 0; j < scale; j++) {
        for (let i = 0; i < scale; i++) img.data.copy(icon.data, ((y * scale + j) * 128 + x * scale + i) * 4, src, src + 4);
      }
    }
  }
  return icon;
}

// ── 主流程 ────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { skin: null, out: null, name: null, uuid: null, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--uuid') opts.uuid = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else opts.skin = a;
  }
  if (opts.model && !['slim', 'wide'].includes(opts.model)) throw new Error('--model 只能是 slim（细手臂）或 wide（粗手臂）');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let name = opts.name;
  if (!name) {
    try {
      name = loadConfig().account.username;
    } catch {
      name = 'NJFU_Neko';
    }
  }
  const uuid = opts.uuid ?? offlineUuid(name);
  const target = defaultSkinOf(uuid);
  const skinFile = path.resolve(opts.skin ?? DEFAULT_SKIN);
  let img = decodePNG(fs.readFileSync(skinFile));
  if (img.width === 64 && img.height === 32) {
    img = upgradeLegacy(img);
    console.log('· 老式 64×32 皮肤，已转换为 64×64');
  }
  if (img.width !== 64 || img.height !== 64) throw new Error(`皮肤必须是 64×64 像素，这张是 ${img.width}×${img.height}`);

  const slim = opts.model ? opts.model === 'slim' : isSlim(img);
  if (slim && target.model === 'wide') {
    convertArms(img, 3, 4);
    console.log('· 这张是细手臂皮肤，而猫娘用的是粗手臂模型，已自动把手臂加宽');
  } else if (!slim && target.model === 'slim') {
    convertArms(img, 4, 3);
    console.log('· 这张是粗手臂皮肤，而猫娘用的是细手臂模型，已自动把手臂变窄');
  }

  const outDir = path.resolve(opts.out ?? path.join(root, 'runtime', 'skin-pack'));
  const packDir = path.join(outDir, PACK_NAME);
  const texDir = path.join(packDir, 'assets', 'minecraft', 'textures', 'entity', 'player', target.model);
  fs.mkdirSync(texDir, { recursive: true });
  // 清掉上次生成的其他槽位贴图，避免登录名改了以后残留。
  for (const model of ['slim', 'wide']) {
    const dir = path.join(packDir, 'assets', 'minecraft', 'textures', 'entity', 'player', model);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (model !== target.model || f !== `${target.name}.png`) fs.rmSync(path.join(dir, f));
  }
  fs.writeFileSync(path.join(texDir, `${target.name}.png`), encodePNG(img));
  fs.writeFileSync(path.join(packDir, 'pack.png'), encodePNG(faceIcon(img)));
  fs.writeFileSync(path.join(packDir, 'pack.mcmeta'), `${JSON.stringify({
    pack: { min_format: 88, max_format: 999, description: `${name} 的猫娘皮肤（替换默认皮肤 ${target.model}/${target.name}）` },
  }, null, 2)}\n`);

  console.log(`✓ 登录名 ${name}（UUID ${uuid}）→ 默认皮肤 ${target.model}/${target.name}`);
  console.log(`✓ 资源包已生成：${packDir}`);
  if (!opts.out) console.log('  把整个文件夹复制到游戏的 resourcepacks 目录，或加 --out 直接指定该目录');
  console.log('  然后在游戏里：选项 → 资源包 → 把「NJFU猫娘皮肤」移到右边（已选）→ 完成');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
