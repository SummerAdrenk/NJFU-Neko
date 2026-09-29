// 读取投影（Litematica）的 .litematic 原理图：列出文件、统计材料、换算成世界坐标交给建造工具。
import fs from 'node:fs';
import path from 'node:path';
import nbt from 'prismarine-nbt';
import { parseBlockSpec, itemForBlock } from './build.js';
import { Vec3 } from './helpers.js';

const AIR = new Set(['air', 'cave_air', 'void_air', 'structure_void']);

export function listSchematics(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d, depth) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.litematic')) out.push({ name: path.relative(dir, full).replace(/\\/g, '/').replace(/\.litematic$/, ''), file: full, size: fs.statSync(full).size });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

// 按名字找原理图：完全匹配优先，其次是包含关系。
export function findSchematic(dir, name) {
  const all = listSchematics(dir);
  const q = String(name).replace(/\.litematic$/, '').trim();
  return all.find((s) => s.name === q) ?? all.find((s) => path.basename(s.name) === q) ?? all.find((s) => s.name.includes(q)) ?? null;
}

const toBig = (pair) => BigInt.asUintN(64, (BigInt(pair[0]) << 32n) | (BigInt(pair[1]) & 0xffffffffn));

// 投影的紧凑位数组（一个值可能跨两个 long）
function readPacked(longs, index, bits) {
  const startBit = BigInt(index * bits);
  const startLong = Number(startBit >> 6n);
  const offset = startBit & 63n;
  const mask = (1n << BigInt(bits)) - 1n;
  let value = longs[startLong] >> offset;
  const endLong = Number((startBit + BigInt(bits) - 1n) >> 6n);
  if (endLong !== startLong) value |= longs[endLong] << (64n - offset);
  return Number(value & mask);
}

export async function loadLitematic(file) {
  const { parsed } = await nbt.parse(fs.readFileSync(file));
  const root = nbt.simplify(parsed);
  const regions = [];
  for (const [name, r] of Object.entries(root.Regions ?? {})) {
    const size = { x: r.Size.x, y: r.Size.y, z: r.Size.z };
    const abs = { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) };
    // 尺寸为负表示向负方向延伸，换算出最小角
    const min = {
      x: r.Position.x + (size.x < 0 ? size.x + 1 : 0),
      y: r.Position.y + (size.y < 0 ? size.y + 1 : 0),
      z: r.Position.z + (size.z < 0 ? size.z + 1 : 0),
    };
    const palette = r.BlockStatePalette.map((p) => parseBlockSpec(`${p.Name}${p.Properties ? `[${Object.entries(p.Properties).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}`));
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const longs = r.BlockStates.map(toBig);
    regions.push({ name, min, size: abs, palette, bits, longs });
  }
  const meta = root.Metadata ?? {};
  return { file, name: meta.Name ?? path.basename(file, '.litematic'), author: meta.Author ?? '未知', dataVersion: root.MinecraftDataVersion, regions };
}

// 遍历原理图里所有非空气方块：回调参数为相对原理图原点的坐标和方块。
export function forEachBlock(schem, fn) {
  for (const r of schem.regions) {
    const { x: sx, y: sy, z: sz } = r.size;
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) {
          const spec = r.palette[readPacked(r.longs, (y * sz + z) * sx + x, r.bits)];
          if (!spec || AIR.has(spec.name)) continue;
          fn(new Vec3(r.min.x + x, r.min.y + y, r.min.z + z), spec);
        }
      }
    }
  }
}

export function describeSchematic(schem) {
  const counts = new Map();
  let total = 0;
  let min = null;
  let max = null;
  forEachBlock(schem, (p, spec) => {
    total += 1;
    const item = itemForBlock(spec.name);
    counts.set(item, (counts.get(item) ?? 0) + 1);
    min = min ? new Vec3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z)) : p.clone();
    max = max ? new Vec3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z)) : p.clone();
  });
  const size = min ? `${max.x - min.x + 1}×${max.y - min.y + 1}×${max.z - min.z + 1}` : '0';
  const materials = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`);
  return {
    total,
    text: [
      `原理图「${schem.name}」作者 ${schem.author}，${schem.regions.length} 个区域，大小 ${size}，共 ${total} 个方块`,
      `材料：${materials.slice(0, 30).join('、')}${materials.length > 30 ? ` 等 ${materials.length} 种` : ''}`,
    ].join('\n'),
  };
}
