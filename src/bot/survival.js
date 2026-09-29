// 生存本能：自动进食、低血量/死亡提醒、空闲时自卫。
import { getLog } from '../log.js';
import { fmtPos } from '../util.js';
import { fight, fleeFrom, isThreat, nearestCreeper, nearestThreat } from './helpers.js';

const log = getLog('生存');

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);

export function pickFood(bot, { allowBad = false } = {}) {
  const foods = bot.registry.foodsByName ?? {};
  let best = null;
  let bestScore = -1;
  for (const item of bot.inventory.items()) {
    const food = foods[item.name];
    if (!food) continue;
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

export function installSurvival(agent, bot) {
  const cfg = agent.cfg.behavior;
  let eating = false;
  let lastLowHealth = 0;
  let lastNoFood = 0;

  bot.on('health', async () => {
    if (!agent.online || bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator') return;
    const now = Date.now();
    if (bot.health > 0 && bot.health <= 6 && now - lastLowHealth > 30_000) {
      lastLowHealth = now;
      agent.events.push('bot', { what: 'low_health', health: Math.round(bot.health) });
    }
    if (!cfg.auto_eat || eating || bot.food > 14 || bot.targetDigBlock || bot.pvp?.target) return;
    eating = true;
    try {
      const ate = await eatBest(bot);
      if (ate) log.debug(`自动进食：${ate}`);
      else if (bot.food <= 6 && now - lastNoFood > 120_000) {
        lastNoFood = now;
        agent.events.push('bot', { what: 'hungry_no_food', food: bot.food });
      }
    } catch {
      // 进食被打断（例如换了手持物品），下次再试
    } finally {
      eating = false;
    }
  });

  bot.on('death', () => {
    const pos = bot.entity?.position;
    agent.lastDeath = pos ? { position: fmtPos(pos), at: new Date().toISOString() } : null;
    agent.events.push('bot', { what: 'death', position: agent.lastDeath?.position });
    agent.tasks.cancel('猫娘死掉了').catch(() => {});
  });

  // 被打时还手：伤害事件里带有攻击者（source）。跟随/陪伴/护卫的循环自己会处理身边的怪，这里只管空闲时。
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity || !cfg.self_defense || bot.pvp?.target || bot.isSleeping) return;
    const cur = agent.tasks.current;
    if (cur && cur.name !== 'companion') return;
    if (source?.type === 'player') return; // 被玩家打由好感度系统处理，不还手
    const attacker = source && source !== bot.entity ? source : nearestThreat(agent, bot.entity.position, 6);
    if (!attacker) return;
    const runSelf = (name, desc, fn) => agent.tasks.run(name, desc, fn, { waitMs: 0, by: { source: 'self' } }).catch(() => {});
    // 苦力怕不能贴身打（会被炸死）；命名过的、机器里的生物不打，也先躲开。
    if (attacker.name === 'creeper' || !isThreat(agent, attacker)) {
      if (!attacker.position || attacker.position.distanceTo(bot.entity.position) > 8) return;
      runSelf('flee', `躲开 ${attacker.name}`, async (task) => {
        await fleeFrom(agent, attacker, task.signal);
        return `躲开了 ${attacker.name}`;
      });
      return;
    }
    runSelf('defend', `自卫：${attacker.name}`, async (task) => {
      const won = await fight(agent, attacker, task.signal, 25_000);
      return won ? `打倒了 ${attacker.name}` : `${attacker.name} 跑掉了`;
    });
  });

  // 空闲或陪伴时苦力怕靠得太近就主动躲开（不等被炸）。
  const watchCreepers = setInterval(() => {
    const cur = agent.tasks.current;
    if (!agent.online || !cfg.self_defense || (cur && cur.name !== 'companion') || bot.isSleeping) return;
    const creeper = nearestCreeper(bot, 4);
    if (!creeper) return;
    agent.tasks.run('flee', '躲开苦力怕', async (task) => {
      await fleeFrom(agent, creeper, task.signal);
      return '躲开了苦力怕';
    }, { waitMs: 0, by: { source: 'self' } }).catch(() => {});
  }, 500);
  bot.once('end', () => clearInterval(watchCreepers));
}
