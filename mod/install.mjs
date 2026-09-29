#!/usr/bin/env node
// 把编译好的面板模组装进游戏的 mods 文件夹：旧版本先移到 runtime/trash（不直接删），再放新版本。
// 游戏开着时旧文件被占用、换不了，要先关掉游戏。
// 用法：node mod/install.mjs --game "<.minecraft>/versions/<版本名>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf('--game');
const game = i >= 0 ? args[i + 1] : process.env.NEKO_GAME_DIR;
if (!game) {
  console.error('请用 --game 指定游戏版本目录，例如：node mod/install.mjs --game "D:/Game/.minecraft/versions/26.2-Fabric 0.19.5"');
  process.exit(1);
}
const mods = [path.join(game, 'mods'), path.resolve(game, '..', '..', 'mods')].find((d) => fs.existsSync(d));
if (!mods) {
  console.error(`找不到 mods 文件夹：${game}`);
  process.exit(1);
}
const dist = path.join(HERE, 'dist');
const builds = fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => /^njfu-neko-panel-.*\.jar$/.test(f)) : [];
// 按版本号挑最新的（clone 下来的文件修改时间都一样，不能按时间挑）
const version = (f) => (/-(\d+)\.(\d+)\.(\d+)\.jar$/.exec(f) ?? []).slice(1).map(Number);
const newer = (a, b) => {
  const [x, y] = [version(a), version(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};
const latest = builds.sort(newer).map((f) => path.join(dist, f))[0];
if (!latest) {
  console.error('mod/dist 里还没有编译好的模组，先运行 npm run build-mod');
  process.exit(1);
}
const name = path.basename(latest);
const trash = path.join(HERE, '..', 'runtime', 'trash');
fs.mkdirSync(trash, { recursive: true });
for (const old of fs.readdirSync(mods).filter((f) => /^njfu-neko-panel-.*\.jar$/.test(f))) {
  const from = path.join(mods, old);
  try {
    fs.copyFileSync(from, path.join(trash, `${Date.now()}-${old}`));
    fs.unlinkSync(from);
    console.log(`旧版 ${old} 已移到 runtime/trash`);
  } catch (err) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
      console.error(`游戏还开着，${old} 被占用换不了：请先关掉游戏，再运行一次`);
      process.exit(2);
    }
    throw err;
  }
}
fs.copyFileSync(latest, path.join(mods, name));
console.log(`✓ 已装好 ${name}，重新打开游戏就生效`);
