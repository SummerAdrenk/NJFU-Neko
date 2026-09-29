// 动作与互动：表情动作（挥手、点头、跳舞、坐下…）、摸头、捡木棍、小游戏、日常反应（上线问候、死亡关心、进度祝贺）。
import { goals, makeMovements } from './createBot.js';
import { findPlayer } from './helpers.js';
import { isLookingAt } from './gaze.js';
import { getLog } from '../log.js';
import { sleep } from '../util.js';

const log = getLog('互动');
const FETCH_ITEMS = new Set(['stick', 'bone']);

// 需要管理员权限的特效（粒子、声音）。只在装了面板模组（能静默执行命令）时播放，
// 否则每个特效都会在管理员的聊天栏里多一条灰色提示。坐下/站起这类必须的动作照常执行。
async function effects(agent, commands, { required = false } = {}) {
  if (!agent.online || agent.identity.opLevel < 2) return;
  if (!required && (!agent.cfg.emotes.effects || !agent.quietCommands)) return;
  for (const c of commands) {
    agent.adminCommand(c);
    await sleep(60);
  }
}

export function createEmotes(agent) {
  const bot = () => agent.bot;
  const pos = () => {
    const p = bot().entity.position;
    return `${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}`;
  };
  const hearts = (n = 5) => effects(agent, [`/particle minecraft:heart ${pos().replace(/(\S+) (\S+) (\S+)/, (_, x, y, z) => `${x} ${(Number(y) + 2.1).toFixed(2)} ${z}`)} 0.4 0.3 0.4 0 ${n}`]);
  const meow = (kind = 'ambient') => effects(agent, [`/playsound minecraft:entity.cat.${kind} player @a ${pos()} 1 1.2`]);

  async function lookAtPlayer(name) {
    const e = findPlayer(bot(), name)?.entity;
    if (e) await bot().lookAt(e.position.offset(0, e.eyeHeight ?? 1.6, 0), true).catch(() => {});
  }
  const control = async (state, ms) => {
    bot().setControlState(state, true);
    await sleep(ms);
    bot().setControlState(state, false);
  };

  const library = {
    wave: { name: '挥手', run: async () => { for (let i = 0; i < 4; i++) { bot().swingArm('right'); await sleep(250); } } },
    nod: {
      name: '点头',
      run: async () => {
        const { yaw, pitch } = bot().entity;
        for (let i = 0; i < 2; i++) {
          await bot().look(yaw, pitch - 0.6, true);
          await sleep(180);
          await bot().look(yaw, pitch + 0.2, true);
          await sleep(180);
        }
        await bot().look(yaw, pitch, true);
      },
    },
    shake: {
      name: '摇头',
      run: async () => {
        const { yaw, pitch } = bot().entity;
        for (let i = 0; i < 3; i++) {
          await bot().look(yaw + 0.5, pitch, true);
          await sleep(150);
          await bot().look(yaw - 0.5, pitch, true);
          await sleep(150);
        }
        await bot().look(yaw, pitch, true);
      },
    },
    jump: { name: '跳一跳', run: async () => { for (let i = 0; i < 3; i++) { await control('jump', 350); await sleep(150); } } },
    crouch: { name: '蹲起', run: async () => { for (let i = 0; i < 4; i++) { await control('sneak', 200); await sleep(180); } } },
    spin: {
      name: '转圈',
      run: async () => {
        const start = bot().entity.yaw;
        for (let i = 1; i <= 16; i++) {
          await bot().look(start + (i * Math.PI) / 8, 0, true);
          await sleep(60);
        }
      },
    },
    dance: {
      name: '跳舞',
      run: async () => {
        meow('purreow');
        for (let round = 0; round < 3; round++) {
          await library.spin.run();
          await control('jump', 350);
          await library.crouch.run();
          bot().swingArm('right');
          bot().swingArm('left');
        }
        hearts(8);
      },
    },
    hearts: { name: '冒爱心', run: async () => { await hearts(8); } },
    meow: { name: '喵喵叫', run: async () => { await meow('ambient'); } },
    happy: { name: '开心', run: async () => { hearts(6); meow('purreow'); await library.jump.run(); } },
    sad: {
      name: '难过',
      run: async () => {
        meow('beg_for_food');
        const { yaw } = bot().entity;
        await bot().look(yaw, -0.9, true);
        await control('sneak', 1500);
      },
    },
    // 原版玩家没有坐下动作：召唤一个隐形盔甲架，用 /ride 让猫娘骑上去，看起来就是坐着的。
    sit: {
      name: '坐下',
      run: async () => {
        if (agent.identity.opLevel < 2) throw new Error('坐下需要管理员权限');
        const b = bot();
        const p = b.entity.position;
        await effects(agent, [
          `/summon minecraft:armor_stand ${p.x.toFixed(2)} ${(p.y - 1.6).toFixed(2)} ${p.z.toFixed(2)} {Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b,Silent:1b,Tags:["neko_seat"]}`,
          `/ride ${b.username} mount @e[type=minecraft:armor_stand,tag=neko_seat,limit=1,sort=nearest]`,
        ], { required: true });
        agent.seated = true;
      },
    },
    stand: {
      name: '站起来',
      run: async () => {
        agent.seated = false;
        await effects(agent, [`/ride ${bot().username} dismount`, '/kill @e[type=minecraft:armor_stand,tag=neko_seat]'], { required: true });
      },
    },
  };

  async function perform(name, target) {
    const emote = library[name];
    if (!emote) throw new Error(`没有「${name}」这个动作。可用：${Object.entries(library).map(([k, v]) => `${k}（${v.name}）`).join('、')}`);
    if (agent.seated && name !== 'stand' && name !== 'hearts' && name !== 'meow') await library.stand.run();
    if (target) await lookAtPlayer(target);
    await emote.run();
    return `做了动作：${emote.name}`;
  }

  return { library, perform, hearts, meow, lookAtPlayer };
}

// ── 被动互动：摸头、捡木棍、上线下线问候、死亡关心、进度祝贺、早晚提醒 ──

export function installInteractions(agent, bot) {
  const cfg = agent.cfg.emotes;
  const emotes = agent.emotes;
  const lastPet = new Map();
  let lastIdleEmote = Date.now();
  let lastTimeCheck = null;

  // 摸头：玩家蹲在猫娘身边 2.5 格内并看着她
  bot.on('entityCrouch', (entity) => {
    if (!cfg.interactions || entity.type !== 'player' || entity.username === bot.username || !agent.online) return;
    if (entity.position.distanceTo(bot.entity.position) > 2.5 || !isLookingAt(entity, bot.entity, 3)) return;
    const name = entity.username;
    if (Date.now() - (lastPet.get(name) ?? 0) < 20_000) return;
    lastPet.set(name, Date.now());
    const owner = agent.chat.isOwner(name);
    const r = agent.affection.change(name, 1, '摸了摸猫娘的头', { kind: 'chat', owner });
    agent.events.push('bot', { what: 'pet', by: name, detail: `好感 ${r.score}` });
    const lines = ['嘿嘿，好舒服喵～', '呼噜呼噜……', '再摸一下嘛喵～', '主人的手好温暖～', '蹭蹭～'];
    agent.say(lines[Math.floor(Math.random() * lines.length)]);
    emotes.lookAtPlayer(name).then(() => emotes.hearts(5)).then(() => emotes.meow('purr')).catch(() => {});
  });

  // 捡木棍游戏：玩家扔来的木棍/骨头，捡到后还给他
  agent.on('social', (ev) => {
    if (!cfg.interactions || ev.type !== 'gift' || !FETCH_ITEMS.has(ev.item)) return;
    setTimeout(async () => {
      try {
        const e = findPlayer(bot, ev.player)?.entity;
        if (!e || agent.tasks.current?.name !== 'companion' && agent.tasks.current) return;
        agent.say(['接住啦！再扔一次喵～', '叼回来啦！', '嘿嘿，我接得准吧～'][Math.floor(Math.random() * 3)]);
        bot.pathfinder.setMovements(makeMovements(bot));
        await Promise.race([bot.pathfinder.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2)).catch(() => {}), sleep(8000)]);
        const item = bot.inventory.items().find((i) => i.name === ev.item);
        if (item) {
          await bot.lookAt(e.position.offset(0, 1.2, 0), true);
          await bot.toss(item.type, null, 1);
        }
      } catch (err) {
        log.debug(`捡木棍失败：${err.message}`);
      }
    }, 300);
  });

  // 玩家上线 / 下线
  bot.on('playerJoined', (player) => {
    if (!cfg.greetings || !agent.online || player.username === bot.username) return;
    if (Date.now() - agent.onlineSince < 5000) return; // 自己刚上线时收到的是已有玩家列表
    const owner = agent.chat.isOwner(player.username) && agent.cfg.chat.owners.length;
    setTimeout(() => agent.say(owner ? `主人回来啦！欢迎回来喵～` : `欢迎 ${player.username}～`), 2500);
  });
  bot.on('playerLeft', (player) => {
    if (!cfg.greetings || !agent.online || player.username === bot.username) return;
    agent.say(`${player.username} 下线了，下次见喵～`);
  });

  // 系统消息：玩家死亡、获得进度
  agent.on('systemMessage', (text) => {
    if (!cfg.greetings) return;
    const adv = /^(?:\[[^\]]*\]\s*)?(\w{1,16}) has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]$/.exec(text);
    if (adv && adv[1] !== bot.username) {
      agent.say(`恭喜 ${adv[1]} 达成「${adv[2]}」！好厉害喵～`);
      emotes.hearts(6);
      return;
    }
    const players = Object.keys(bot.players).filter((n) => n !== bot.username);
    const dead = players.find((n) => text.startsWith(`${n} `) && / (was|died|drowned|blew up|burned|fell|hit the ground|starved|suffocated|froze|withered|went up in flames|walked into|tried to swim|experienced kinetic|discovered the floor)/.test(text));
    if (dead) {
      const e = findPlayer(bot, dead)?.entity;
      const where = e ? `(${Math.floor(e.position.x)}, ${Math.floor(e.position.y)}, ${Math.floor(e.position.z)})` : '';
      agent.say(`${dead}！你没事吧？！${where ? `我去 ${where} 帮你看着掉落物喵` : ''}`);
      agent.events.push('bot', { what: 'player_death', by: dead, detail: text });
      if (e && agent.chat.isOwner(dead) && cfg.guard_death_drops && (!agent.tasks.current || agent.tasks.current.name === 'companion')) {
        agent.runAction('goto', { x: e.position.x, y: e.position.y, z: e.position.z }, { waitMs: 0, by: { source: 'self' } }).catch(() => {});
      }
    }
  });

  // 早晚提醒 + 闲着时的小动作
  const timer = setInterval(() => {
    if (!agent.online || !bot.entity || bot.isSleeping) return;
    const tod = bot.time?.timeOfDay;
    if (cfg.greetings && tod != null && lastTimeCheck != null) {
      if (lastTimeCheck < 12300 && tod >= 12300 && tod < 13000) agent.say('天快黑了，要小心怪物哦喵～');
      if (lastTimeCheck > 23000 && tod < 1000) agent.say('早上好喵～新的一天开始啦！');
    }
    if (tod != null) lastTimeCheck = tod;
    const cur = agent.tasks.current;
    if (cfg.idle_emotes && (!cur || cur.name === 'companion') && !bot.pathfinder.isMoving() && Date.now() - lastIdleEmote > 45_000 && Math.random() < 0.15) {
      lastIdleEmote = Date.now();
      const pick = ['nod', 'jump', 'crouch', 'wave', 'spin'][Math.floor(Math.random() * 5)];
      emotes.library[pick].run().catch(() => {});
    }
  }, 5000);
  bot.once('end', () => clearInterval(timer));
}

// ── 聊天小游戏 ──

export function playMiniGame(agent, name, player, args) {
  if (name === 'rps') {
    const hands = ['石头', '剪刀', '布'];
    const mine = hands[Math.floor(Math.random() * 3)];
    const theirs = hands.find((h) => (args[0] ?? '').includes(h));
    if (!theirs) return [`要出什么？发「#猜拳 石头」「#猜拳 剪刀」或「#猜拳 布」`];
    const win = { 石头: '剪刀', 剪刀: '布', 布: '石头' };
    let result = '平手！再来一次喵';
    if (win[theirs] === mine) result = `${player} 赢了！呜呜～`;
    else if (win[mine] === theirs) {
      result = '我赢啦喵～';
      agent.emotes.library.happy.run().catch(() => {});
    }
    return [`你出${theirs}，我出${mine}……${result}`];
  }
  if (name === 'coin') return [`抛硬币……是${Math.random() < 0.5 ? '正面' : '反面'}！`];
  if (name === 'guess') {
    const games = (agent.guessGames ??= new Map());
    const n = Number(args[0]);
    let game = games.get(player);
    if (!game || !args.length) {
      game = { answer: 1 + Math.floor(Math.random() * 100), tries: 0 };
      games.set(player, game);
      if (!args.length) return ['我想好了一个 1～100 的数字，发「#猜数字 50」来猜吧喵～'];
    }
    if (!Number.isFinite(n)) return ['要发数字哦，比如「#猜数字 50」'];
    game.tries += 1;
    if (n === game.answer) {
      games.delete(player);
      agent.affection.change(player, 1, '陪猫娘玩猜数字', { kind: 'chat', owner: agent.chat.isOwner(player) });
      agent.emotes.library.happy.run().catch(() => {});
      return [`猜对啦！就是 ${n}，你用了 ${game.tries} 次喵～`];
    }
    return [n < game.answer ? `${n} 太小啦～` : `${n} 太大啦～`];
  }
  return null;
}
