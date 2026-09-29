// 决斗里的招式（在战斗模块 pvpStep 的近身打法之外），按难度开放：
//   剑斧切换、蜘蛛网、射箭、砸伤害药水、末影珍珠（追人、瞬移攻击、绕后、逃跑）、鞘翅（俯冲攻击、飞走回血）、
//   水桶灭火、换不死图腾、泼治疗药水、吃附魔金苹果、爆炸攻击（末影水晶、TNT）。
// 每一招都有冷却和失败保护：做不成就返回 false，交给普通近战。爆炸只在面板模组锁血、保护场地时用。
import { elytraTravel } from './movement.js';
import { throwPotionAt, usePotion } from './potions.js';
import { SNOWBALL, solveBallistic } from './ballistics.js';
import { bbox, eye, findInv, flat, holdItem, meta, overlaps, pearlAway, solid, towardUnit } from './combat.js';
import { isEmpty, Vec3 } from './helpers.js';
import { getLog } from '../log.js';
import { sleep } from '../util.js';

const log = getLog('决斗');
const UP = new Vec3(0, 1, 0);
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export const absorption = (bot, e) => Number(meta(bot, e, 'player_absorption') ?? 0);
const burning = (bot) => (Number(meta(bot, bot.entity, 'shared_flags') ?? 0) & 1) === 1;
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

export class DuelTactics {
  constructor(agent, fighter, level, { locked = false } = {}) {
    this.agent = agent;
    this.bot = agent.bot;
    this.f = fighter;
    this.level = level;
    this.locked = locked;
    this.placed = []; // 放下的方块（黑曜石、TNT、蜘蛛网），打完清掉
    this.next = {}; // 各招的冷却
    this.track = []; // 对手最近 1.5 秒的位置
    this.opener = true; // 冲上去的第一下用斧子
  }

  ready(name) {
    return Date.now() >= (this.next[name] ?? 0);
  }

  cool(name, ms) {
    this.next[name] = Date.now() + ms;
  }

  async safe(name, fn) {
    try {
      return Boolean(await fn());
    } catch (err) {
      if (this.f.signal?.aborted) throw err;
      log.debug(`${name}没成：${err.message}`);
      return false;
    }
  }

  // 每一步先看这些招（返回 true 表示这一步用了招），都不用就交给 pvpStep 近身打
  async step(target) {
    const now = Date.now();
    this.track.push({ t: now, pos: target.position.clone() });
    while (this.track.length > 1 && now - this.track[0].t > 1500) this.track.shift();
    const d = flat(this.bot.entity.position, target.position);
    await this.safe('换武器', () => this.weapon(d));
    return await this.safe('砍网', () => this.cutWeb())
      || await this.safe('灭火', () => this.extinguish())
      || await this.safe('保命', () => this.survive(target, d))
      || (this.level.boom && this.locked && (await this.safe('水晶', () => this.crystal(target, d)) || await this.safe('TNT', () => this.tnt(target, d))))
      || await this.safe('位移', () => this.mobility(target, d))
      || await this.safe('蜘蛛网', () => this.webTrap(target, d))
      || await this.safe('远程', () => this.ranged(target, d));
  }

  // 对手 ms 内几乎没动（在吃东西、举盾、卡在网里）
  still(target, ms = 1000) {
    const first = this.track[0];
    return Boolean(first) && Date.now() - first.t >= ms && first.pos.distanceTo(target.position) < 0.4;
  }

  // 对手正在冲过来
  approaching(target) {
    const first = this.track[0];
    const me = this.bot.entity.position;
    return Boolean(first) && flat(first.pos, me) - flat(target.position, me) > 0.6;
  }

  // 对手正对着我（他转身之前从背后打）
  facingMe(target) {
    const me = this.bot.entity.position;
    const look = new Vec3(-Math.sin(target.yaw ?? 0), 0, -Math.cos(target.yaw ?? 0));
    const to = towardUnit(target.position, me);
    return look.x * to.x + look.z * to.z > Math.cos((50 * Math.PI) / 180);
  }

  // 头顶开阔、有鞘翅和烟花：能飞
  canFly() {
    const bot = this.bot;
    if (!findInv(bot, /^elytra$/) && bot.inventory.slots[bot.getEquipmentDestSlot('torso')]?.name !== 'elytra') return false;
    if (bot.inventory.items().filter((i) => i.name === 'firework_rocket').reduce((s, i) => s + i.count, 0) < 2) return false;
    const head = bot.entity.position.floored();
    for (let y = 2; y <= 8; y++) if (!isEmpty(bot.blockAt(head.offset(0, y, 0)))) return false;
    return true;
  }

  // pos 附近能站的地面（上面两格是空的），返回脚下那格
  groundAt(pos) {
    const bot = this.bot;
    const x = Math.floor(pos.x);
    const z = Math.floor(pos.z);
    for (let y = Math.floor(pos.y) + 3; y >= Math.floor(pos.y) - 4; y--) {
      const g = bot.blockAt(new Vec3(x, y, z));
      if (solid(g) && isEmpty(bot.blockAt(new Vec3(x, y + 1, z))) && isEmpty(bot.blockAt(new Vec3(x, y + 2, z)))) return g.position;
    }
    return null;
  }

  // 放方块：最多等 1 秒（放不上就算了，不要卡住）
  async place(item, ground, pos) {
    const bot = this.bot;
    await holdItem(bot, item);
    await Promise.race([bot.placeBlock(bot.blockAt(ground), UP).catch(() => {}), sleep(1000)]);
    this.f.lastSwap = Date.now();
    this.onPlace?.();
    return bot.blockAt(pos);
  }

  // ── 剑斧切换：离得远时拿斧子蓄着，冲上去第一下重；打出第一下换剑（出手快、伤害稳）；拉开距离再换回斧子 ──
  async weapon(d) {
    if (!this.level.swap) return false;
    const bot = this.bot;
    const axe = findInv(bot, /_axe$/);
    const sword = findInv(bot, /_sword$/);
    if (!axe || !sword) return false;
    if (d > 7) this.opener = true;
    if (this.opener && /_axe$/.test(bot.heldItem?.name ?? '') && Date.now() - this.f.lastAttack < 300) this.opener = false;
    const want = this.opener ? axe : sword;
    if (bot.heldItem?.name === want.name) return false;
    await holdItem(bot, want);
    this.f.lastSwap = Date.now();
    return false;
  }

  // ── 自己被蜘蛛网黏住：用剑砍掉 ──
  async cutWeb() {
    const bot = this.bot;
    const feet = bot.entity.position.floored();
    const web = [bot.blockAt(feet), bot.blockAt(feet.offset(0, 1, 0))].find((b) => b?.name === 'cobweb');
    if (!web) return false;
    this.f.lower();
    const sword = findInv(bot, /_sword$/);
    if (sword) await holdItem(bot, sword);
    await bot.dig(web, true);
    this.f.lastSwap = Date.now();
    return true;
  }

  // ── 身上着火（被岩浆、火焰附加烫了）：脚下倒一桶水马上收回；有抗火就不管 ──
  async extinguish() {
    const bot = this.bot;
    if (!this.level.fluids || !burning(bot) || this.f.hasEffect('FireResistance') || !this.ready('water')) return false;
    const water = findInv(bot, /^water_bucket$/);
    const feet = bot.entity.position.floored();
    if (!water || !solid(bot.blockAt(feet.offset(0, -1, 0))) || !isEmpty(bot.blockAt(feet))) return false;
    this.cool('water', 3000);
    this.f.lower();
    this.f.stopMove();
    await holdItem(bot, water);
    await bot.lookAt(feet.offset(0.5, 0.05, 0.5), true);
    bot.activateItem();
    bot.deactivateItem();
    await this.f.wait(250);
    if (bot.blockAt(feet)?.name === 'water') {
      await bot.lookAt(feet.offset(0.5, 0.4, 0.5), true);
      bot.activateItem();
      bot.deactivateItem();
      await this.f.wait(150);
      if (bot.blockAt(feet)?.name === 'water') this.f.placedFluids.push(feet.clone());
    }
    this.f.lastSwap = Date.now();
    return true;
  }

  // ── 保命：图腾换到副手、血少泼治疗药水、黄心打完了吃附魔金苹果（太近就先拉开距离再吃） ──
  async survive(target, d) {
    const bot = this.bot;
    const lv = this.level;
    const hp = bot.health;
    if (lv.totems && hp <= 10 && bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name !== 'totem_of_undying') {
      const totem = findInv(bot, /^totem_of_undying$/);
      if (totem) {
        this.f.lower();
        await bot.equip(totem, 'off-hand');
        return true;
      }
    }
    if (lv.potions && hp <= 8 && this.ready('heal')) {
      this.cool('heal', 1500);
      if (await usePotion(this.agent, ['healing']).catch(() => null)) {
        this.f.lastSwap = Date.now();
        return true;
      }
    }
    if (lv.gapples && hp <= 12 && absorption(bot, bot.entity) <= 0 && this.ready('gapple') && findInv(bot, /^enchanted_golden_apple$/)) {
      if (d < 3.5 && hp <= 8 && await this.escape(target)) return true;
      this.cool('gapple', 5000);
      return this.f.consume(/^enchanted_golden_apple$/);
    }
    return false;
  }

  // ── 拉开距离：头顶开阔就用鞘翅飞走，作弊档扔珍珠逃开 ──
  async escape(target) {
    if (!this.ready('escape')) return false;
    const bot = this.bot;
    const me = bot.entity.position;
    const away = towardUnit(target.position, me);
    if (this.level.elytra && this.canFly()) {
      this.cool('escape', 15000);
      const dest = me.plus(away.scaled(35));
      this.agent.events.push('bot', { what: 'combat', detail: '用鞘翅飞走，拉开距离回血' });
      await elytraTravel(this.agent, { x: dest.x, z: dest.z }, this.f.signal).catch(() => {});
      await this.f.ensureWeapon();
      return true;
    }
    const pearl = this.level.pearls ? findInv(bot, /^ender_pearl$/) : null;
    if (pearl) {
      this.cool('escape', 10000);
      return pearlAway(this.agent, pearl, away, this.f.signal);
    }
    return false;
  }

  // ── 位移攻击：作弊档用珍珠追人、瞬移到他身上砍、绕到背后砍；困难档起用鞘翅俯冲砍 ──
  async mobility(target, d) {
    const lv = this.level;
    if (lv.pearls && this.ready('pearl') && d > 12 && d < 45) return this.pearlAt(target);
    if (lv.pearls && this.ready('pearl') && d >= 5 && d <= 10 && this.facingMe(target)) return this.pearlBehind(target);
    if (lv.elytra && this.ready('dive') && d >= 10 && d <= 30 && this.bot.health >= 10 && this.canFly()) return this.elytraDive(target);
    return false;
  }

  // 直接朝他扔珍珠：砸中就瞬移到他身上，落地马上砍
  async pearlAt(target) {
    const bot = this.bot;
    const pearl = findInv(bot, /^ender_pearl$/);
    if (!pearl) return false;
    const from = eye(bot).offset(0, -0.1, 0);
    const v = target.velocity ?? new Vec3(0, 0, 0);
    const lead = from.distanceTo(target.position) * 0.6;
    const sol = solveBallistic(from, target.position.offset(v.x * lead, 0.9, v.z * lead), SNOWBALL);
    if (!sol) return false;
    this.cool('pearl', 5000);
    return this.pearlStrike(pearl, sol, target, '末影珍珠瞬移到');
  }

  // 他正对着我：把珍珠扔到他身后两格，瞬移过去从背后砍
  async pearlBehind(target) {
    const bot = this.bot;
    const pearl = findInv(bot, /^ender_pearl$/);
    if (!pearl) return false;
    const ground = this.groundAt(target.position.plus(towardUnit(bot.entity.position, target.position).scaled(2)));
    if (!ground) return false;
    const sol = solveBallistic(eye(bot).offset(0, -0.1, 0), ground.offset(0.5, 1, 0.5), SNOWBALL);
    if (!sol) return false;
    this.cool('pearl', 7000);
    return this.pearlStrike(pearl, sol, target, '末影珍珠绕到背后打');
  }

  async pearlStrike(pearl, sol, target, what) {
    const bot = this.bot;
    this.f.lower();
    this.f.stopMove();
    this.f.manual();
    await holdItem(bot, pearl);
    await bot.look(sol.yaw, sol.pitch, true);
    bot.activateItem();
    bot.deactivateItem();
    const start = bot.entity.position.clone();
    const until = Date.now() + 3000;
    while (Date.now() < until && bot.entity.position.distanceTo(start) < 3) await this.f.wait(50);
    await this.f.ensureWeapon();
    if (bot.entity.position.distanceTo(start) < 3) return false;
    this.agent.events.push('bot', { what: 'combat', detail: `${what} ${target.username ?? target.name}` });
    await this.f.face(target);
    if (!(await this.f.critStrike(target, { force: true }))) this.f.hit(target);
    return true;
  }

  // 鞘翅俯冲：换上鞘翅，烟花冲高，再朝他俯冲，下落时出手（暴击）；落地换回胸甲
  async elytraDive(target) {
    const bot = this.bot;
    const elytra = findInv(bot, /^elytra$/);
    const rocket = findInv(bot, /^firework_rocket$/);
    if (!elytra || !rocket) return false;
    this.cool('dive', 25000);
    const torso = bot.getEquipmentDestSlot('torso');
    const chest = bot.inventory.slots[torso]?.name !== 'elytra' ? bot.inventory.slots[torso]?.name : null;
    this.f.lower();
    this.f.stopMove();
    this.f.manual();
    await bot.equip(elytra, 'torso');
    let hit = false;
    try {
      bot.setControlState('jump', true);
      await this.f.wait(120);
      bot.setControlState('jump', false);
      await this.f.wait(200);
      await bot.elytraFly();
      await bot.look(yawTo(bot.entity.position, target.position), 1.0, true);
      await holdItem(bot, rocket);
      bot.activateItem();
      bot.deactivateItem();
      await this.f.wait(900);
      await this.f.ensureWeapon();
      const until = Date.now() + 6000;
      while (Date.now() < until && !bot.entity.onGround) {
        const aim = target.position.offset(0, 1, 0);
        await bot.lookAt(aim, true);
        if (!hit && eye(bot).distanceTo(aim) <= 3.2) {
          this.f.hit(target);
          hit = true;
        }
        await this.f.wait(50);
      }
      if (hit) this.agent.events.push('bot', { what: 'combat', detail: `鞘翅俯冲砍 ${target.username ?? target.name}` });
      return true;
    } finally {
      bot.clearControlStates();
      const until = Date.now() + 3000;
      while (!bot.entity.onGround && Date.now() < until) await sleep(100);
      const c = chest ? bot.inventory.items().find((i) => i.name === chest) : null;
      if (c) await bot.equip(c, 'torso').catch(() => {});
      this.f.lastSwap = Date.now();
    }
  }

  // ── 蜘蛛网：他冲过来（2～4.5 格）时往他脚下放一张网，黏住他再打 ──
  async webTrap(target, d) {
    if (!this.level.web || !this.ready('web') || d < 2 || d > 4.5 || !this.approaching(target)) return false;
    const bot = this.bot;
    const web = findInv(bot, /^cobweb$/);
    const pos = target.position.floored();
    if (!web || !isEmpty(bot.blockAt(pos)) || !solid(bot.blockAt(pos.offset(0, -1, 0))) || pos.offset(0.5, 0, 0.5).distanceTo(eye(bot)) > 4.4) return false;
    this.cool('web', 8000);
    this.f.lower();
    const b = await this.place(web, pos.offset(0, -1, 0), pos);
    if (b?.name === 'cobweb') this.placed.push(pos.clone());
    await this.f.ensureWeapon();
    return b?.name === 'cobweb';
  }

  // ── 远程：3～6 格砸伤害药水；8 格以外射箭（作弊档先用药水箭） ──
  async ranged(target, d) {
    const bot = this.bot;
    if (this.level.potions && d >= 3 && d <= 6 && this.ready('throw')) {
      this.cool('throw', 4000);
      if (await throwPotionAt(this.agent, target, ['harming']).catch(() => null)) {
        this.f.lastSwap = Date.now();
        await this.f.ensureWeapon();
        return true;
      }
    }
    if (!this.level.bow || d < 8 || d > 40 || !findInv(bot, /^bow$/) || !findInv(bot, /arrow$/)) return false;
    await this.f.shoot(target);
    return true;
  }

  // ── 末影水晶：在他身边（离我远的那一侧）放黑曜石，放上水晶马上引爆（近就用手打，远就用弓射） ──
  async crystal(target, d) {
    const bot = this.bot;
    if (!this.ready('crystal') || d < 3 || d > 6) return false;
    const crystal = findInv(bot, /^end_crystal$/);
    if (!crystal) return false;
    const spot = this.crystalSpot(target);
    if (!spot) return false;
    this.cool('crystal', 2500);
    this.f.lower();
    this.f.stopMove();
    this.f.manual();
    let base = bot.blockAt(spot);
    if (!/^(obsidian|bedrock)$/.test(base?.name ?? '')) {
      const obsidian = findInv(bot, /^obsidian$/);
      if (!obsidian) return false;
      base = await this.place(obsidian, spot.offset(0, -1, 0), spot);
      if (base?.name !== 'obsidian') return false;
      this.placed.push(spot.clone());
    }
    await holdItem(bot, crystal);
    await bot.lookAt(spot.offset(0.5, 1, 0.5), true);
    await bot.activateBlock(base, UP);
    const where = spot.offset(0.5, 1, 0.5);
    let ent = null;
    for (let i = 0; i < 16 && !ent; i++) {
      await this.f.wait(50);
      ent = Object.values(bot.entities).find((e) => e.name === 'end_crystal' && e.position.distanceTo(where) < 1.5) ?? null;
    }
    if (!ent) return false;
    await this.detonate(ent);
    this.agent.events.push('bot', { what: 'combat', detail: `末影水晶炸 ${target.username ?? target.name}` });
    await this.f.ensureWeapon();
    return true;
  }

  crystalSpot(target) {
    const bot = this.bot;
    const me = bot.entity.position;
    const from = eye(bot);
    const feet = target.position.floored();
    let best = null;
    for (const [dx, dz] of NEIGHBORS) {
      const base = feet.offset(dx, 0, dz);
      const b = bot.blockAt(base);
      if (!(/^(obsidian|bedrock)$/.test(b?.name ?? '') || (isEmpty(b) && solid(bot.blockAt(base.offset(0, -1, 0)))))) continue;
      if (!isEmpty(bot.blockAt(base.offset(0, 1, 0))) || !isEmpty(bot.blockAt(base.offset(0, 2, 0)))) continue;
      const box = { minX: base.x, maxX: base.x + 1, minY: base.y + 1, maxY: base.y + 3, minZ: base.z, maxZ: base.z + 1 };
      if (Object.values(bot.entities).some((e) => e.position && e.name !== 'item' && overlaps(box, bbox(e)))) continue;
      const center = base.offset(0.5, 1, 0.5);
      const mine = center.distanceTo(me);
      if (center.distanceTo(from) > 4.4 || mine < 3) continue;
      const score = mine - center.distanceTo(target.position) * 2;
      if (!best || score > best.score) best = { base, score };
    }
    return best?.base ?? null;
  }

  // 引爆水晶：3 格内用手打，远一点用弓射
  async detonate(ent) {
    const bot = this.bot;
    const aim = ent.position.offset(0, 1, 0);
    if (eye(bot).distanceTo(aim) <= 3) {
      await bot.lookAt(aim, true);
      bot.attack(ent);
      return true;
    }
    const bow = findInv(bot, /^bow$/);
    if (!bow || !findInv(bot, /arrow$/)) return false;
    await holdItem(bot, bow);
    await bot.lookAt(aim, true);
    bot.activateItem();
    await this.f.wait(350);
    await bot.lookAt(aim.offset(0, 0.1, 0), true);
    bot.deactivateItem();
    this.f.lastSwap = Date.now();
    return true;
  }

  // ── TNT：他站着不动（吃东西、举盾、卡在网里）1 秒以上，在他脚边放 TNT 点着，然后退开 ──
  async tnt(target, d) {
    const bot = this.bot;
    if (!this.ready('tnt') || d < 2.5 || d > 4.5 || !this.still(target, 1000)) return false;
    const tnt = findInv(bot, /^tnt$/);
    const flint = findInv(bot, /^flint_and_steel$/);
    if (!tnt || !flint) return false;
    const me = bot.entity.position;
    const feet = target.position.floored();
    const spots = NEIGHBORS.map(([dx, dz]) => feet.offset(dx, 0, dz))
      .filter((p) => isEmpty(bot.blockAt(p)) && solid(bot.blockAt(p.offset(0, -1, 0))) && p.offset(0.5, 0, 0.5).distanceTo(eye(bot)) <= 4.4
        && p.offset(0.5, 0, 0.5).distanceTo(me) >= 2.5)
      .sort((a, b) => b.distanceTo(me) - a.distanceTo(me));
    if (!spots.length) return false;
    this.cool('tnt', 6000);
    this.f.lower();
    this.f.stopMove();
    this.f.manual();
    const block = await this.place(tnt, spots[0].offset(0, -1, 0), spots[0]);
    if (block?.name !== 'tnt') return false;
    this.placed.push(spots[0].clone());
    await holdItem(bot, flint);
    await bot.activateBlock(block);
    this.agent.events.push('bot', { what: 'combat', detail: `TNT 炸 ${target.username ?? target.name}` });
    await this.f.runFrom(target, 7, 2500).catch(() => {});
    await this.f.ensureWeapon();
    return true;
  }
}
