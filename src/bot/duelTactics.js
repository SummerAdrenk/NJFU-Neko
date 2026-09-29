// 决斗里的招式（在战斗模块 pvpStep 的近身打法之外），按难度开放：
//   剑斧切换、蜘蛛网、射箭、砸伤害药水、末影珍珠（追人、瞬移攻击、绕后、逃跑）、鞘翅（俯冲攻击、飞走回血）、
//   水桶灭火、换不死图腾、泼治疗药水、吃附魔金苹果、爆炸攻击（末影水晶、TNT）。
// 每一招都有冷却和失败保护：做不成就返回 false，交给普通近战。爆炸只在面板模组锁血、保护场地时用，
// 而且远远地射爆（打法见下面“爆炸”一节）；他放的水晶、点的 TNT 也会躲、会垒黑曜石挡。
import { startGliding } from './createBot.js';
import { elytraTravel } from './movement.js';
import { throwPotionAt, usePotion } from './potions.js';
import { ARROW, SNOWBALL, solveBallistic } from './ballistics.js';
import { bbox, eye, findInv, flat, holdItem, meta, overlaps, pearlAway, solid, towardUnit } from './combat.js';
import { fleeFrom, isEmpty, Vec3 } from './helpers.js';
import { getLog } from '../log.js';
import { sleep } from '../util.js';

const log = getLog('决斗');
const UP = new Vec3(0, 1, 0);
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export const absorption = (bot, e) => Number(meta(bot, e, 'player_absorption') ?? 0);
const CRYSTAL = 6; // 末影水晶的爆炸威力（TNT 是 4）

// 原版爆炸对人的伤害（中间没东西挡着）：power 威力，d 爆炸中心到脚的距离；gear：盔甲值、韧性、保护附魔点数
export function blastDamage(power, d, { armor = 20, toughness = 12, epf = 16 } = {}) {
  const r = power * 2;
  if (d >= r) return 0;
  const impact = 1 - d / r;
  let dmg = ((impact * impact + impact) / 2) * 7 * r + 1;
  const g = Math.min(20, Math.max(armor * 0.2, armor - dmg / (2 + toughness / 4)));
  dmg *= 1 - g / 25;
  return dmg * (1 - Math.min(20, epf) * 0.04);
}

// 这一档的盔甲（对手默认也穿同一套）：下界合金 20/12、钻石 20/8、铁 15/0；顶级附魔 = 4 件保护 IV = 16 点
export function kitArmor(level) {
  const [armor, toughness] = { netherite: [20, 12], diamond: [20, 8], iron: [15, 0] }[level.material] ?? [15, 0];
  return { armor, toughness, epf: level.armorEnch ? 16 : 0 };
}
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
    this.gear = kitArmor(level); // 估算爆炸伤害用
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
      || (this.level.boom && await this.safe('躲爆炸', () => this.dodgeBlast(target)))
      || await this.safe('保命', () => this.survive(target, d))
      || (this.level.boom && this.locked && await this.safe('爆炸', () => this.explosives(target, d)))
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
      await startGliding(bot);
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

  // ── 蜘蛛网：他冲过来（2～4.5 格）时往他脚下放一张网，黏住他再打；force：不管他是不是冲过来（放水晶、TNT 之前先黏住） ──
  async webTrap(target, d, { force = false } = {}) {
    if (!this.level.web || !this.ready('web') || d < 2 || d > 4.5 || (!force && !this.approaching(target))) return false;
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

  // ── 爆炸（作弊Ⅵ）──────────────────────────────────────────────
  // 原版的爆炸伤害：离爆炸中心越近越疼（水晶威力 6，12 格外没伤害；TNT 威力 4，8 格外没伤害），
  // 爆炸和人之间有方块挡着（射线被挡住）就几乎不疼。贴着水晶（3 格内）用手打爆，自己也挨 13 点左右（下界合金保护 IV），
  // 两三下就把自己炸没了。所以：
  //   水晶：先用网把他黏住，在他身边（离我远的那一侧）放水晶，马上往反方向扔珍珠（没有就跑）拉开，再用弓射爆；
  //         射之前算一下两边各挨多少，他挨得多、我挨得少才射。他放的水晶也一样：他站在旁边、我离得远就射。
  //   TNT：只在他被网黏住、或者站着不动时用（引信 4 秒，能跑的人早跑了）：放在他身边点着，马上拉开，爆之前不靠近。
  //   躲：身边有点着的 TNT 就跑远；有水晶离我近、他又够得着（他一打我就挨大的）：在我和水晶之间垒两格高的黑曜石挡住，垒不了就跑。

  entities(name) {
    return Object.values(this.bot.entities).filter((e) => e.name === name && e.isValid !== false && e.position);
  }

  // 他的脚或者身子卡在蜘蛛网里
  webbed(target) {
    const feet = target.position.floored();
    return [feet, feet.offset(0, 1, 0)].some((p) => this.bot.blockAt(p)?.name === 'cobweb');
  }

  canShoot() {
    return Boolean(findInv(this.bot, /^bow$/) && findInv(this.bot, /arrow$/));
  }

  // 两点之间没有方块挡着
  clear(from, to) {
    const dist = from.distanceTo(to);
    return dist < 0.1 || !this.bot.world.raycast(from, to.minus(from).normalize(), dist);
  }

  // 这颗水晶的爆炸打不到我：从水晶到我脚、腰、头的射线都被方块挡住了
  shielded(pos) {
    const me = this.bot.entity.position;
    const from = pos.offset(0, 0.1, 0);
    return [0.3, 1.0, 1.6].every((h) => !this.clear(from, me.offset(0, h, 0)));
  }

  // 这颗水晶现在炸值不值：他挨得多（≥6 点，是我的 3 倍以上），我挨得少（≤4 点，挨完还剩 8 点以上）
  worth(crystal, target) {
    const mine = this.shielded(crystal.position) ? 1 : blastDamage(CRYSTAL, crystal.position.distanceTo(this.bot.entity.position), this.gear);
    const his = blastDamage(CRYSTAL, crystal.position.distanceTo(target.position), this.gear);
    return his >= 6 && his >= mine * 3 && mine <= 4 && this.bot.health - mine >= 8;
  }

  // ── 躲爆炸 ──
  async dodgeBlast(target) {
    const me = this.bot.entity.position;
    const tnt = this.entities('tnt').find((e) => e.position.distanceTo(me) < 7.5);
    if (tnt) return this.getAway(tnt.position, 8.5, 3000);
    // 他够得着（4.5 格内）、离我近到会伤到我（估算 ≥4 点）、中间又没挡着的水晶
    const hot = this.entities('end_crystal')
      .filter((c) => c.position.distanceTo(target.position) <= 4.5)
      .map((c) => ({ c, dmg: blastDamage(CRYSTAL, c.position.distanceTo(me), this.gear) }))
      .filter((x) => x.dmg >= 4 && !this.shielded(x.c.position))
      .sort((a, b) => b.dmg - a.dmg)[0];
    if (!hot) return false;
    if (this.ready('shield') && await this.shieldFrom(hot.c.position)) return true;
    return this.getAway(hot.c.position, 7.5, 2000);
  }

  // 挡爆炸：在我身边朝水晶那一格垒两格高的黑曜石
  async shieldFrom(pos) {
    const bot = this.bot;
    const obsidian = findInv(bot, /^obsidian$/);
    if (!obsidian) return false;
    const me = bot.entity.position;
    const dir = towardUnit(me, pos);
    const feet = me.floored();
    const cell = me.offset(dir.x * 1.3, 0, dir.z * 1.3).floored();
    if (cell.x === feet.x && cell.z === feet.z) return false;
    if (!isEmpty(bot.blockAt(cell)) || !isEmpty(bot.blockAt(cell.offset(0, 1, 0))) || !solid(bot.blockAt(cell.offset(0, -1, 0)))) return false;
    const box = { minX: cell.x, maxX: cell.x + 1, minY: cell.y, maxY: cell.y + 2, minZ: cell.z, maxZ: cell.z + 1 };
    if (Object.values(bot.entities).some((e) => e.position && e.name !== 'item' && overlaps(box, bbox(e)))) return false;
    this.cool('shield', 2500);
    this.f.lower();
    this.f.stopMove();
    this.f.manual();
    const low = await this.place(obsidian, cell.offset(0, -1, 0), cell);
    if (low?.name !== 'obsidian') return false;
    this.placed.push(cell.clone());
    const high = await this.place(obsidian, cell, cell.offset(0, 1, 0));
    if (high?.name === 'obsidian') this.placed.push(cell.offset(0, 1, 0));
    this.agent.events.push('bot', { what: 'combat', detail: '垒黑曜石挡住末影水晶的爆炸' });
    await this.f.ensureWeapon();
    return true;
  }

  async getAway(pos, distance, ms) {
    this.f.lower();
    this.f.manual();
    this.f.stopMove();
    await fleeFrom(this.agent, { position: pos, isValid: true }, this.f.signal, { distance, timeoutMs: ms });
    return true;
  }

  // 放完水晶（点着 TNT）马上拉开：有珍珠就往反方向扔（一下 12～18 格），没有就跑
  async backOff(pos) {
    const bot = this.bot;
    const away = towardUnit(pos, bot.entity.position);
    const pearl = this.level.pearls ? findInv(bot, /^ender_pearl$/) : null;
    if (pearl && this.ready('pearlBack')) {
      this.cool('pearlBack', 5000);
      this.f.lower();
      this.f.stopMove();
      this.f.manual();
      if (await pearlAway(this.agent, pearl, away, this.f.signal, '扔末影珍珠拉开距离').catch(() => false)) return true;
    }
    return this.getAway(pos, 8, 2500);
  }

  // ── 爆炸攻击（模组锁血时）：先射已经放好的水晶；他没被黏住就先下网；黏住了再放水晶（放不了就 TNT） ──
  async explosives(target, d) {
    if (await this.shootCrystal(target)) return true;
    if (this.bot.health < 12) return false;
    if (!this.webbed(target) && !this.still(target, 1000)) return this.webTrap(target, d, { force: true });
    return await this.plantCrystal(target, d) || await this.tnt(target, d);
  }

  async plantCrystal(target, d) {
    const bot = this.bot;
    if (!this.ready('crystal') || d < 2.5 || d > 4.5 || !this.canShoot()) return false;
    const crystal = findInv(bot, /^end_crystal$/);
    if (!crystal) return false;
    const spot = this.crystalSpot(target);
    if (!spot) return false;
    this.cool('crystal', 4000);
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
      ent = this.entities('end_crystal').find((e) => e.position.distanceTo(where) < 1.5) ?? null;
    }
    this.f.lastSwap = Date.now();
    if (!ent) return false;
    this.agent.events.push('bot', { what: 'combat', detail: `在 ${target.username ?? target.name} 身边放了末影水晶，拉开再射爆` });
    await this.backOff(ent.position);
    await this.shootCrystal(target, ent);
    await this.f.ensureWeapon();
    return true;
  }

  // 放水晶的地方：他脚边一圈、离我远的那一侧、我够得着（放的时候离我至少 3 格）。
  // 地上就是黑曜石（决斗场的地板）就直接放在地上，不然先在他脚边垫一块黑曜石
  crystalSpot(target) {
    const bot = this.bot;
    const me = bot.entity.position;
    const from = eye(bot);
    const feet = target.position.floored();
    let best = null;
    for (const [dx, dz] of NEIGHBORS) {
      for (const base of [feet.offset(dx, -1, dz), feet.offset(dx, 0, dz)]) {
        const b = bot.blockAt(base);
        const ready = /^(obsidian|bedrock)$/.test(b?.name ?? '');
        if (!ready && !(isEmpty(b) && solid(bot.blockAt(base.offset(0, -1, 0))))) continue;
        if (!isEmpty(bot.blockAt(base.offset(0, 1, 0))) || !isEmpty(bot.blockAt(base.offset(0, 2, 0)))) continue;
        const box = { minX: base.x, maxX: base.x + 1, minY: base.y + 1, maxY: base.y + 3, minZ: base.z, maxZ: base.z + 1 };
        if (Object.values(bot.entities).some((e) => e.position && e.name !== 'item' && overlaps(box, bbox(e)))) continue;
        const center = base.offset(0.5, 1, 0.5);
        const mine = center.distanceTo(me);
        if (center.distanceTo(from) > 4.4 || mine < 3) continue;
        const score = mine - center.distanceTo(target.position) * 2 + (ready ? 1 : 0);
        if (!best || score > best.score) best = { base, score };
        break;
      }
    }
    return best?.base ?? null;
  }

  // 射爆水晶（我放的、他放的都算）：值得炸（见 worth）、看得见才射；拉弓时一直盯着，他走开了、我靠太近了就不射
  async shootCrystal(target, only = null) {
    const bot = this.bot;
    if (!this.canShoot()) return false;
    const aim = (c) => c.position.offset(0, 1, 0);
    const pick = (only ? [only] : this.entities('end_crystal'))
      .filter((c) => c.isValid !== false && this.worth(c, target) && this.clear(eye(bot), aim(c)))
      .sort((a, b) => a.position.distanceTo(target.position) - b.position.distanceTo(target.position))[0];
    if (!pick) return false;
    this.f.lower();
    this.f.stopMove();
    this.f.manual();
    await holdItem(bot, findInv(bot, /^bow$/));
    bot.activateItem();
    let released = false;
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 1050) {
        await this.f.wait(50);
        if (pick.isValid === false || !this.worth(pick, target)) return true;
        const sol = solveBallistic(eye(bot).offset(0, -0.1, 0), aim(pick), ARROW);
        if (sol) await bot.look(sol.yaw, sol.pitch, true);
      }
      await this.f.wait(60);
      bot.deactivateItem();
      released = true;
    } finally {
      if (!released) {
        await this.f.ensureWeapon().catch(() => {});
        bot.deactivateItem();
      }
      this.f.lastSwap = Date.now();
    }
    for (let i = 0; i < 12 && pick.isValid !== false; i++) await this.f.wait(50);
    if (pick.isValid === false) this.agent.events.push('bot', { what: 'combat', detail: `射爆末影水晶炸 ${target.username ?? target.name}` });
    await this.f.ensureWeapon();
    return true;
  }

  // ── TNT：只在他被网黏住、或者站着不动 1 秒以上时用：放在他身边点着，马上拉开（珍珠或跑），爆之前不靠近（见 dodgeBlast） ──
  async tnt(target, d) {
    const bot = this.bot;
    if (!this.ready('tnt') || d < 2.5 || d > 4.5) return false;
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
    this.cool('tnt', 8000);
    this.f.lower();
    this.f.stopMove();
    this.f.manual();
    const block = await this.place(tnt, spots[0].offset(0, -1, 0), spots[0]);
    if (block?.name !== 'tnt') return false;
    this.placed.push(spots[0].clone());
    await holdItem(bot, flint);
    await bot.activateBlock(block);
    this.agent.events.push('bot', { what: 'combat', detail: `在 ${target.username ?? target.name} 身边点了 TNT` });
    await this.backOff(spots[0].offset(0.5, 0, 0.5));
    await this.f.ensureWeapon();
    return true;
  }
}
