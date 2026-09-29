// 好感度：每个玩家一个 0～100 的分数，存在 runtime/affection.json。
// 来源：聊天互动、送礼、被夸或被骂（大脑判断）、被打。每天从聊天和大脑判断得到的加分有上限，防止刷好感。
import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = [
  { min: 0, name: '陌生', tone: '礼貌但有点拘谨' },
  { min: 20, name: '认识', tone: '友善自然' },
  { min: 40, name: '朋友', tone: '亲切活泼，会开玩笑' },
  { min: 60, name: '亲密', tone: '很黏人，会撒娇' },
  { min: 80, name: '挚爱', tone: '无比信任和依赖，满满的爱意' },
];

// 礼物价值：按物品名匹配，从上往下第一个命中的生效。
const GIFT_VALUES = [
  [/^(netherite_ingot|nether_star|elytra|totem_of_undying|enchanted_golden_apple|dragon_egg|beacon)$/, 15],
  [/^(diamond|emerald|golden_apple|heart_of_the_sea|music_disc_.*)$/, 8],
  [/^(cake|cookie|pumpkin_pie|sweet_berries|glow_berries|honey_bottle|golden_carrot)$/, 5],
  [/^(cod|salmon|tropical_fish|cooked_cod|cooked_salmon)$/, 6], // 猫娘最爱吃鱼
  [/(tulip|poppy|dandelion|orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|torchflower|pitcher_plant|pink_petals|wildflowers)$/, 4],
  [/^(string|feather|name_tag|lead|bell|amethyst_shard)$/, 3],
  [/^(bread|apple|cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|baked_potato|carrot|melon_slice)$/, 2],
  [/^(iron_ingot|gold_ingot|copper_ingot|coal|redstone|lapis_lazuli)$/, 2],
  [/^(rotten_flesh|poisonous_potato|spider_eye|dirt|cobblestone|gravel|stick)$/, 0],
];
const DEFAULT_GIFT = 1;

const today = () => new Date().toISOString().slice(0, 10);

export class Affection {
  constructor(file, { events, cfg }) {
    this.file = file;
    this.events = events;
    this.cfg = cfg;
    this.players = {};
    try {
      this.players = JSON.parse(fs.readFileSync(file, 'utf8')).players ?? {};
    } catch {
      this.players = {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({ players: this.players }, null, 2)}\n`);
  }

  entry(name, owner = false) {
    const key = String(name);
    if (!this.players[key]) {
      this.players[key] = { score: owner ? this.cfg.owner_start : this.cfg.start, day: today(), dailyGain: 0, giftGain: 0, lastChat: 0, history: [] };
    }
    const e = this.players[key];
    if (e.day !== today()) Object.assign(e, { day: today(), dailyGain: 0, giftGain: 0 });
    return e;
  }

  level(score) {
    return [...LEVELS].reverse().find((l) => score >= l.min);
  }

  get(name, owner = false) {
    const e = this.entry(name, owner);
    const lv = this.level(e.score);
    const next = LEVELS.find((l) => l.min > e.score);
    return { player: name, score: e.score, level: lv.name, tone: lv.tone, next: next ? { name: next.name, need: next.min - e.score } : null, history: e.history.slice(-5) };
  }

  // kind：chat（聊天）、brain（大脑判断的夸奖/责骂）、gift（礼物）、hurt（被打）、admin（手动调整）
  change(name, delta, reason, { kind = 'brain', owner = false } = {}) {
    if (!this.cfg.enabled) return this.get(name, owner);
    const e = this.entry(name, owner);
    let d = Math.round(Number(delta) || 0);
    if (d > 0 && (kind === 'chat' || kind === 'brain')) {
      d = Math.min(d, Math.max(0, this.cfg.daily_chat_cap - e.dailyGain));
      e.dailyGain += d;
    } else if (d > 0 && kind === 'gift') {
      d = Math.min(d, Math.max(0, this.cfg.daily_gift_cap - e.giftGain));
      e.giftGain += d;
    }
    const before = e.score;
    e.score = Math.max(0, Math.min(100, e.score + d));
    const applied = e.score - before;
    if (applied !== 0 || kind === 'admin') {
      e.history.push({ at: new Date().toISOString(), delta: applied, reason: String(reason).slice(0, 80) });
      if (e.history.length > 30) e.history.shift();
      const lv = this.level(e.score);
      this.events.push('affection', { player: name, delta: applied, score: e.score, level: lv.name, reason: String(reason).slice(0, 80), kind });
      if (this.level(before).name !== lv.name) this.events.push('bot', { what: 'affection_level', by: name, detail: `${this.level(before).name} → ${lv.name}` });
    }
    this.save();
    return { ...this.get(name, owner), applied };
  }

  // 每次和猫娘聊天：间隔 2 分钟以上才加 1 分。
  onChat(name, owner) {
    const e = this.entry(name, owner);
    if (Date.now() - (e.lastChat ?? 0) < 120_000) return null;
    e.lastChat = Date.now();
    return this.change(name, 1, '和猫娘聊天', { kind: 'chat', owner });
  }

  giftValue(itemName, count) {
    const value = GIFT_VALUES.find(([re]) => re.test(itemName))?.[1] ?? DEFAULT_GIFT;
    return Math.min(15, value * Math.min(3, Math.ceil(count / 4)));
  }

  all() {
    return Object.keys(this.players).map((name) => this.get(name)).sort((a, b) => b.score - a.score);
  }
}
