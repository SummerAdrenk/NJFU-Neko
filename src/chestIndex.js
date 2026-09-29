// 箱子记忆：猫娘打开过的容器里有什么，存在 runtime/chests.json，用来“去箱子里拿东西”和“运送物资”。
import fs from 'node:fs';
import path from 'node:path';

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

export class ChestIndex {
  constructor(file) {
    this.file = file;
    this.chests = {};
    try {
      this.chests = JSON.parse(fs.readFileSync(file, 'utf8')).chests ?? {};
    } catch {
      this.chests = {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({ chests: this.chests }, null, 1)}\n`);
  }

  record(pos, blockName, items, dimension) {
    const totals = {};
    for (const i of items) totals[i.name] = (totals[i.name] ?? 0) + i.count;
    this.chests[key(pos)] = { block: blockName, dimension, items: totals, at: new Date().toISOString() };
    this.save();
  }

  forget(pos) {
    delete this.chests[key(pos)];
    this.save();
  }

  // 找存有某物品的箱子（按距离排序）。match 可以是物品名或判断函数。
  find(match, near, dimension) {
    const test = typeof match === 'function' ? match : (name) => name === match;
    const out = [];
    for (const [k, c] of Object.entries(this.chests)) {
      if (dimension && c.dimension && c.dimension !== dimension) continue;
      const [x, y, z] = k.split(',').map(Number);
      for (const [name, count] of Object.entries(c.items)) {
        if (test(name)) out.push({ x, y, z, name, count, block: c.block, distance: near ? Math.hypot(x - near.x, y - near.y, z - near.z) : 0 });
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  describe(near, limit = 8) {
    const entries = Object.entries(this.chests).map(([k, c]) => {
      const [x, y, z] = k.split(',').map(Number);
      return { k, c, d: near ? Math.hypot(x - near.x, y - near.y, z - near.z) : 0 };
    }).sort((a, b) => a.d - b.d).slice(0, limit);
    if (!entries.length) return '（还没有打开过箱子）';
    return entries.map(({ k, c, d }) => {
      const items = Object.entries(c.items).sort((a, b) => b[1] - a[1]);
      const text = items.length ? items.slice(0, 8).map(([n, v]) => `${n}×${v}`).join(', ') + (items.length > 8 ? ` 等 ${items.length} 种` : '') : '空';
      return `(${k}) ${c.block}${near ? ` ${Math.round(d)}格` : ''}：${text}`;
    }).join('\n');
  }
}
