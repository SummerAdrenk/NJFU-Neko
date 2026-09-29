// 功能需求：主人在游戏里发 “#需求 …”，记在 runtime/requests.json，Claude Code 模式下由后台的 Claude Code 处理
// （流程和约束见 CLAUDE.md 的“处理 #需求”一节）。
import fs from 'node:fs';
import path from 'node:path';

export const STATUS = { pending: '待处理', accepted: '处理中', done: '已完成', rejected: '不做', cancelled: '已撤销' };

export class RequestStore {
  constructor(file) {
    this.file = file;
    try {
      this.list = JSON.parse(fs.readFileSync(file, 'utf8')).requests ?? [];
    } catch {
      this.list = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({ requests: this.list }, null, 1)}\n`);
  }

  add(player, text) {
    const id = (this.list.at(-1)?.id ?? 0) + 1;
    const r = { id, player, text: String(text).slice(0, 500), status: 'pending', note: '', at: new Date().toISOString(), updated: null };
    this.list.push(r);
    this.save();
    return r;
  }

  get(id) {
    return this.list.find((r) => r.id === Number(id)) ?? null;
  }

  update(id, status, note = '') {
    const r = this.get(id);
    if (!r) throw new Error(`没有需求 #${id}`);
    if (!STATUS[status]) throw new Error(`状态只能是：${Object.keys(STATUS).join(' / ')}`);
    r.status = status;
    r.note = String(note).slice(0, 300);
    r.updated = new Date().toISOString();
    this.save();
    return r;
  }

  recent(n = 5, player = null) {
    return this.list.filter((r) => !player || r.player === player).slice(-n);
  }

  open() {
    return this.list.filter((r) => r.status === 'pending' || r.status === 'accepted');
  }
}
