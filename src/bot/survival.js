// 生存本能：自动进食（掉血时吃满饱食度回血）、低血量/死亡提醒、空闲时自卫。
import { getLog } from '../log.js';
import { fmtPos } from '../util.js';
import { fleeFrom, nearestCreeper, nearestThreat } from './helpers.js';
import { canEngage, creeperPlan, fight } from './combat.js';

const log = getLog('生存');

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);
// 金苹果留着打架救命用，平时不吃
const RESERVED_FOOD = new Set(['golden_apple', 'enchanted_golden_apple']);

export function pickFood(bot, { allowBad = false } = {}) {
  const foods = bot.registry.foodsByName ?? {};
  let best = null;
  let bestScore = -1;
  for (const item of bot.inventory.items()) {
    const food = foods[item.name];
    if (!food || RESERVED_FOOD.has(item.name)) continue;
    if (BAD_FOOD.has(item.name) && !allowBad) continue;
    const score = (food.foodPoints ?? 0) + (food.saturation ?? 0);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

export async function eatBest(bot) {
  const food = pickFood(bot) ?? (bot.food <= 6 ? pickFood(bot, { allowBad: true }) : null);
  if (!food) return null;
  const previous = bot.heldItem;
  await bot.equip(food, 'hand');
  await bot.consume();
  if (previous && previous.name !== food.name) {
    const again = bot.inventory.items().find((i) => i.type === previous.type);
    if (again) await bot.equip(again, 'hand').catch(() => {});
  }
  return food.name;
}

// 要不要吃：饿了（≤14）就吃；受了伤但饱食度没满也吃——饱食度 18 以上才会自然回血，吃满回得最快。
export function wantsToEat(bot) {
  if (bot.food >= 20) return false;
  return bot.food <= 14 || bot.health < 20;
}

export function installSurvival(agent, bot) {
  const cfg = agent.cfg.behavior;
  let eating = false;
  let lastLowHealth = 0;
  let lastNoFood = 0;

  async function maybeEat() {
    if (!cfg.auto_eat || eating || !wantsToEat(bot) || bot.targetDigBlock || bot.pvp?.target || agent.fighting || bot.currentWindow) return;
    eating = true;
    try {
      const ate = await eatBest(bot);
      if (ate) log.debug(`自动进食：${ate}（生命 ${Math.round(bot.health)}，饥饿 ${bot.food}）`);
      else if (bot.food <= 12 && Date.now() - lastNoFood > 120_000) {
        lastNoFood = Date.now();
        agent.events.push('bot', { what: 'hungry_no_food', food: bot.food });
        agent.emit('hungry');
      }
    } catch {
      // 进食被打断（例如换了手持物品），下次再试
    } finally {
      eating = false;
    }
  }

  bot.on('health', () => {
    if (!agent.online || bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator') return;
    if (bot.health > 0 && bot.health <= 6 && Date.now() - lastLowHealth > 30_000) {
      lastLowHealth = Date.now();
      agent.events.push('bot', { what: 'low_health', health: Math.round(bot.health) });
    }
    maybeEat();
  });
  // 打完架、干完活之后补一口（health 事件只在数值变化时触发）
  const eatTimer = setInterval(() => {
    if (agent.online && bot.entity && !['creative', 'spectator'].includes(bot.game?.gameMode)) maybeEat();
  }, 5000);

  bot.on('death', () => {
    const pos = bot.entity?.position;
    agent.lastDeath = pos ? { position: fmtPos(pos), at: new Date().toISOString() } : null;
    agent.events.push('bot', { what: 'death', position: agent.lastDeath?.position });
    agent.tasks.cancel('猫娘死掉了').catch(() => {});
  });

  const runSelf = (name, desc, fn) => agent.tasks.run(name, desc, fn, { waitMs: 0, by: { source: 'self' } }).catch(() => {});

  // 被打时还手：伤害事件里带有攻击者（source）。跟随/陪伴/护卫的循环自己会处理身边的怪，这里只管空闲时。
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity || !cfg.self_defense || agent.fighting || bot.isSleeping) return;
    const cur = agent.tasks.current;
    if (cur && cur.name !== 'companion') return;
    if (source?.type === 'player') return; // 被玩家打由好感度系统处理，不还手
    const attacker = source && source !== bot.entity ? source : nearestThreat(agent, bot.entity.position, 6, canEngage);
    if (!attacker?.position) return;
    if (canEngage(agent, attacker)) {
      runSelf('defend', `自卫：${attacker.name}`, async (task) => {
        const won = await fight(agent, attacker, task.signal, 30_000);
        return won ? `打倒了 ${attacker.name}` : `${attacker.name} 跑掉了`;
      });
      return;
    }
    // 打不了的（命名过的、机器里的、没把握的苦力怕）：躲开
    if (attacker.position.distanceTo(bot.entity.position) > 8) return;
    runSelf('flee', `躲开 ${attacker.name}`, async (task) => {
      await fleeFrom(agent, attacker, task.signal);
      return `躲开了 ${attacker.name}`;
    });
  });

  // 空闲或陪伴时注意苦力怕：有弓在 10 格内就射，能近战就打了就跑，否则靠近到 4 格就躲开。
  const watchCreepers = setInterval(() => {
    const cur = agent.tasks.current;
    if (!agent.online || !cfg.self_defense || agent.fighting || (cur && cur.name !== 'companion') || bot.isSleeping) return;
    const plan = creeperPlan(agent);
    const creeper = nearestCreeper(bot, plan === 'bow' ? 10 : 4);
    if (!creeper) return;
    if (plan !== 'flee' && canEngage(agent, creeper)) {
      runSelf('defend', '对付苦力怕', async (task) => ((await fight(agent, creeper, task.signal, 30_000)) ? '打倒了苦力怕' : '苦力怕跑掉了'));
      return;
    }
    runSelf('flee', '躲开苦力怕', async (task) => {
      await fleeFrom(agent, creeper, task.signal);
      return '躲开了苦力怕';
    });
  }, 500);
  bot.once('end', () => {
    clearInterval(watchCreepers);
    clearInterval(eatTimer);
  });
}
