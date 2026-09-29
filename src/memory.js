// 长期记忆：几十条简短笔记（比如“主人的家在 (100, 70, 200)”），保存在 runtime/memory.json。
import fs from 'node:fs';
import path from 'node:path';

const MAX_NOTES = 60;
const MAX_LENGTH = 200;

export class MemoryStore {
  constructor(file) {
    this.file = file;
    this.notes = [];
    try {
      this.notes = JSON.parse(fs.readFileSync(file, 'utf8')).notes ?? [];
    } catch {
      this.notes = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({ notes: this.notes }, null, 2)}\n`);
  }

  list() {
    return this.notes;
  }

  add(text, by = null) {
    const note = String(text).trim().slice(0, MAX_LENGTH);
    if (!note) throw new Error('笔记是空的');
    if (this.notes.some((n) => n.text === note)) return '这条已经记过了';
    this.notes.push({ text: note, by, at: new Date().toISOString() });
    let dropped = '';
    if (this.notes.length > MAX_NOTES) dropped = `（记忆满了，忘掉了最早的一条：${this.notes.shift().text}）`;
    this.save();
    return `记住了：${note}${dropped}`;
  }

  // 有固定用途的笔记（例如“我的床在哪”），同一个 key 只保留最新一条。
  set(key, text) {
    const note = String(text).trim().slice(0, MAX_LENGTH);
    const existing = this.notes.find((n) => n.key === key);
    if (existing?.text === note) return;
    this.notes = this.notes.filter((n) => n.key !== key);
    this.notes.push({ key, text: note, by: null, at: new Date().toISOString() });
    this.save();
  }

  remove(keyword) {
    const k = String(keyword).trim();
    if (!k) throw new Error('要忘掉哪条？请给出关键词');
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => !n.text.includes(k));
    const removed = before - this.notes.length;
    if (removed) this.save();
    return removed ? `忘掉了 ${removed} 条包含「${k}」的笔记` : `没有包含「${k}」的笔记`;
  }
}
