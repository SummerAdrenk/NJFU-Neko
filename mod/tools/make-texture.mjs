// 生成面板背景贴图（原版界面风格：浅灰底、立体边框、凹陷的物品格、黑色的人物框）。
// 用法：node mod/tools/make-texture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../../src/png.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'assets', 'njfu_neko_panel', 'textures', 'gui', 'panel.png');
const W = 256;
const H = 256;
const PANEL_W = 176;
const PANEL_H = 256;
const data = Buffer.alloc(W * H * 4);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const BLACK = hex('#000000');
const WHITE = hex('#FFFFFF');
const FACE = hex('#C6C6C6');
const SHADE = hex('#555555');
const SLOT_DARK = hex('#373737');
const SLOT_FILL = hex('#8B8B8B');

function px(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  data[i] = c[0];
  data[i + 1] = c[1];
  data[i + 2] = c[2];
  data[i + 3] = c[3];
}
function rect(x, y, w, h, c) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(i, j, c);
}

// 面板：黑色外框（圆角）、左上白色高光、右下灰色阴影
rect(0, 0, PANEL_W, PANEL_H, FACE);
rect(2, 0, PANEL_W - 4, 1, BLACK);
rect(2, PANEL_H - 1, PANEL_W - 4, 1, BLACK);
rect(0, 2, 1, PANEL_H - 4, BLACK);
rect(PANEL_W - 1, 2, 1, PANEL_H - 4, BLACK);
px(1, 1, BLACK);
px(PANEL_W - 2, 1, BLACK);
px(1, PANEL_H - 2, BLACK);
px(PANEL_W - 2, PANEL_H - 2, BLACK);
for (const [x, y] of [[0, 0], [1, 0], [0, 1], [PANEL_W - 1, 0], [PANEL_W - 2, 0], [PANEL_W - 1, 1], [0, PANEL_H - 1], [1, PANEL_H - 1], [0, PANEL_H - 2],
  [PANEL_W - 1, PANEL_H - 1], [PANEL_W - 2, PANEL_H - 1], [PANEL_W - 1, PANEL_H - 2]]) px(x, y, [0, 0, 0, 0]);
rect(2, 1, PANEL_W - 4, 2, WHITE);
rect(1, 2, 2, PANEL_H - 5, WHITE);
rect(3, PANEL_H - 3, PANEL_W - 5, 2, SHADE);
rect(PANEL_W - 3, 3, 2, PANEL_H - 5, SHADE);
px(2, 2, WHITE);
px(PANEL_W - 3, PANEL_H - 3, SHADE);

// 凹陷的格子：左上深、右下白
function inset(x, y, w, h, fill) {
  rect(x, y, w, h, fill);
  rect(x, y, w - 1, 1, SLOT_DARK);
  rect(x, y, 1, h - 1, SLOT_DARK);
  rect(x + 1, y + h - 1, w - 1, 1, WHITE);
  rect(x + w - 1, y + 1, 1, h - 1, WHITE);
}
const slot = (x, y) => inset(x - 1, y - 1, 18, 18, SLOT_FILL);

// 盔甲 4 格、副手、人物框
for (let i = 0; i < 4; i++) slot(8, 8 + i * 18);
slot(77, 62);
inset(25, 7, 51, 72, BLACK);
// 猫娘的背包 3 行 + 快捷栏
for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) slot(8 + c * 18, 84 + r * 18);
for (let c = 0; c < 9; c++) slot(8 + c * 18, 142);
// 分隔线
rect(7, 161, PANEL_W - 14, 1, SHADE);
rect(7, 162, PANEL_W - 14, 1, WHITE);
// 自己的背包 3 行 + 快捷栏
for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) slot(8 + c * 18, 174 + r * 18);
for (let c = 0; c < 9; c++) slot(8 + c * 18, 232);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePNG({ width: W, height: H, data }));
console.log(`✓ ${OUT}`);
