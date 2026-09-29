// 聊天栏快捷命令：玩家发 “#状态”“#背包”“#帮助” 等，猫娘立刻回复（面板样式），不经过大脑、不消耗 API。
import { snapshot } from './status.js';
import { runAction } from './actions.js';
import { playMiniGame } from './emotes.js';
import { bar, cmd, dot, gap, label, sendPanel, title, value } from './ui.js';
import { sendChatInventory, showInventoryDialog, showMenuDialog, supportsDialog } from './inventoryView.js';
import { findSetting, parseValue, resetOverrides, saveOverride, SETTINGS, settingValue } from '../settings.js';
import { STATUS } from '../requests.js';
import { loadConfig } from '../config.js';
import { combatFlags, giveCheatKit, MODE_DESC, MODE_NAMES, normalizeMode, removeCheatKit } from './combatModes.js';

const ask = (text) => ({ text, color: 'white', suggest: text, hover: '点击填入聊天框，改一改再发送' });
const topic = (name) => ({ text: `[${name}]`, color: 'gold', suggest: name === '决斗' ? '#帮助 决斗' : `#${name}`, hover: `查看「${name}」的说明` });

// #帮助 [主题]：每一页是若干行，每行由若干段组成（见 ui.js）。
const HELP = {
  '': [
    title('NJFU智慧猫娘 · 使用说明'),
    [label('叫我：'), value('聊天里带上 '), value('「猫娘」', 'yellow'), value(' 就行，私聊我也可以')],
    [label('例如：'), ask('猫娘过来'), dot, ask('猫娘去砍 20 个木头'), dot, ask('猫娘附近哪有村庄')],
    [label('面板：'), value('右键我', 'yellow'), label(' 打开我的背包（能拿能放），'), value('Shift+右键', 'yellow'), label(' 打开功能菜单（要装面板模组）；也可以发 '), cmd('#菜单', '弹出功能菜单')],
    [label('快捷：'), cmd('#状态', '我的生命、位置、在做什么'), gap, cmd('#背包', '我背包里的东西'), gap, cmd('#好感', '我对你的好感度'), gap, cmd('#任务', '我正在做的事')],
    [label('　　　'), cmd('#过来', '走到你身边'), gap, cmd('#跟着', '一直跟着你（离远了会传送）'), gap, cmd('#停', '停下手上的事'), gap, cmd('#回家', '回到我的床边')],
    [label('更多：'), topic('互动'), gap, topic('游戏'), gap, topic('决斗'), gap, topic('战斗'), gap, topic('移动'), gap, topic('干活'), gap, topic('红石'), gap, topic('其他')],
  ],
  互动: [
    title('互动'),
    [cmd('#摸头'), gap, cmd('#抱抱'), gap, cmd('#挥手'), gap, cmd('#跳舞'), gap, cmd('#转圈'), gap, cmd('#喵')],
    [cmd('#坐下'), gap, cmd('#起来'), gap, cmd('#睡觉', '天黑了一起去睡（床边有怪会先打掉）')],
    [label('蹲在我旁边看着我 = '), value('摸头', 'yellow')],
    [label('右键我 = '), value('打开我的背包面板', 'yellow'), label('　Shift+右键 = '), value('功能菜单', 'yellow'), label('（要装面板模组）')],
    [label('扔木棍或骨头给我 = '), value('我会叼回来还给你', 'yellow')],
    [label('送我礼物（鱼、花、蛋糕…）会加好感，'), cmd('#好感', '查看好感度'), label(' 查看')],
  ],
  游戏: [
    title('小游戏'),
    [cmd('#猜拳 石头', '也可以出剪刀、布'), gap, cmd('#抛硬币'), gap, cmd('#猜数字', '我想一个 1～100 的数，你来猜')],
    [label('也可以叫我一起：'), ask('猫娘去钓鱼'), dot, ask('猫娘坐船'), dot, ask('猫娘骑马')],
  ],
  决斗: [
    title('PVP 决斗'),
    [cmd('#决斗', '先选难度'), gap, cmd('#决斗 简单'), gap, cmd('#决斗 普通'), gap, cmd('#决斗 困难', '我会走位、跳劈、用盾'), gap, cmd('#决斗 作弊', '我临时换上顶级附魔装备')],
    [label('倒计时后开打，'), value('强制锁 1 滴血', 'yellow'), label('：打到只剩 1 滴血就停，谁都不会被打死')],
    [cmd('#认输'), gap, cmd('#战绩', '你对我的胜负记录')],
  ],
  战斗: [
    title('战斗（她会自己用这些技巧）'),
    [label('近战：'), value('跳劈暴击、蓄满再打、保持距离、身边有人时不横扫', 'white')],
    [label('岩浆：'), value('困难以上：开打前先用岩浆桶把够得着的怪都烫一遍（放下马上收回），群怪也一只只烫过去，再砍', 'white')],
    [label('盾牌：'), value('箭和火球飞来、骷髅拉弓、苦力怕要炸时举盾，出手前放下', 'white')],
    [label('困怪：'), value('打不过的近战怪（卫道士、凋灵骷髅、末影人…）放船困住再打，不打船，打完收船', 'white')],
    [label('专门打法：'), value('苦力怕打了就跑或用弓，恶魂反弹火球，烈焰人用雪球，幻翼等俯冲', 'white')],
    [label('骑乘怪：'), value('蜘蛛骑士、鸡骑士等先打骑手；船和矿车里的怪不打（多半是机器）', 'white')],
    [label('保命：'), value('半血喝药水、吃金苹果，图腾换到副手，打斗间隙吃东西，着火倒水；只剩 1 滴血才撤（#设置 撤退血量）', 'white')],
    [label('药水：'), value('给自己喝，给你扔治疗/再生（你血少时），往怪堆砸伤害药水（亡灵用治疗药水）', 'white')],
    [label('模式：'), cmd('#战斗模式', '普通 / 困难 / 极限 / 作弊（临时顶级装备）'), label('（点一下查看现在的模式和说明）')],
    [label('Boss：'), ask('猫娘去打末影龙'), dot, ask('猫娘打凋灵'), label('（要主人同意）')],
  ],
  移动: [
    title('移动与出行'),
    [label('放方块：'), value('平时走路不放；被困住走不出去才垫方块脱困，盖房子、打架时照常；'), ask('猫娘往上垫 5 格')],
    [label('防摔：'), value('从高处掉下来会落地前倒水、用鞘翅滑翔或放船坐进去')],
    [label('飞行：'), ask('猫娘飞到 1000,80,-500'), label('（要有鞘翅和烟花）')],
    [label('传送门：'), ask('猫娘去下界'), dot, value('你穿过传送门时她会跟过来')],
    [label('坐骑：'), ask('猫娘上我的船'), dot, ask('猫娘坐矿车'), dot, ask('猫娘骑马'), label('（你坐船时她会自己坐上来）')],
    [label('驯服：'), ask('猫娘驯服一只狼送给我'), dot, ask('猫娘驯服那匹马')],
  ],
  干活: [
    title('干活（直接用中文吩咐我）'),
    [label('采集：'), ask('猫娘去挖 32 个圆石'), dot, ask('猫娘收一下小麦')],
    [label('合成：'), ask('猫娘做一把铁镐'), dot, ask('猫娘做 16 个火把')],
    [label('熔炼：'), ask('猫娘把铁矿烧成铁锭')],
    [label('运送：'), ask('猫娘把钻石运给我'), dot, ask('猫娘把铁锭运到 10,64,5 的箱子')],
    [label('护卫：'), ask('猫娘保护我'), dot, ask('猫娘守在这里'), label('　随时 '), cmd('#停')],
    [label('建造：'), value('先备料：背包够直接建；箱子里有会先问你要不要拿；都没有就自己采集合成（工作台也自己做）')],
  ],
  红石: [
    title('红石与建造'),
    [label('排障：'), ask('猫娘看看 1,64,1 到 10,70,10 的机器哪里坏了')],
    [label('原理图：'), ask('猫娘列出原理图'), dot, ask('猫娘把「原理图名」建在 0,64,0')],
    [label('查资料：她会查 Minecraft Wiki、合成配方、物品来源')],
  ],
  其他: [
    title('其他'),
    [label('找结构：'), ask('猫娘最近的远古城市在哪'), label('（会附 Chunkbase 地图）')],
    [label('记事：'), ask('猫娘记住我家在 100,64,200'), gap, cmd('#记忆', '看我记住的事（主人）')],
    [label('睡觉：天黑有人躺床时我会问要不要一起睡，回「好」就去')],
    [label('许愿：'), cmd('#需求 学会钓鱼', '想让我学会的新本事、想改的地方（主人）'), gap, cmd('#需求', '看看需求处理得怎么样了')],
    [label('开关：'), cmd('#设置', '在游戏里直接开关我的各种行为（主人）')],
  ],
};

export function createQuickCommands(agent) {
  const prefix = agent.cfg.chat.command_prefix || '#';
  const act = (name, input, player, waitMs = 0) => runAction(agent, name, input, { waitMs, by: { source: 'quick', name: player.name, owner: player.owner } });
  const emote = (name) => async (player) => {
    const r = await act('emote', { name, target: player.name }, player, 20_000);
    return r.ok ? [] : [r.text];
  };

  const commands = [
    { names: ['帮助', 'help', '?', '？', '说明'], run: (player, args) => ({ panel: HELP[args[0] ?? ''] ?? HELP[''] }) },
    // 直接发分类名也能看对应的说明（#决斗 是开始决斗，说明用 #帮助 决斗）
    { names: ['互动', '游戏', '小游戏', '战斗', '移动', '干活', '红石', '其他'], run: (player, args, name) => ({ panel: HELP[name === '小游戏' ? '游戏' : name] }) },
    {
      names: ['菜单', 'menu'],
      run: (player) => {
        if (agent.identity.opLevel < 2 || !supportsDialog(agent)) return ['弹出菜单需要管理员权限（服务器 1.21.6 以上）喵，先发 #帮助 看看吧'];
        showMenuDialog(agent, player.name);
        return [];
      },
    },
    {
      names: ['状态', 'status', '状况'],
      run: (player) => {
        const s = snapshot(agent);
        if (!s.online) return ['我现在不在线喵'];
        const love = agent.affection.get(player.name, player.owner);
        return {
          panel: [
            title(`${agent.cfg.identity.display_name} 的状态`),
            [label('生命 '), value(`${s.health}/20`, 'red'), gap, label('饥饿 '), value(`${s.food}/20`, 'gold'), gap, label('经验 '), value(`${s.xpLevel} 级`, 'green'), gap, label(s.gameMode ?? '')],
            [label('位置 '), value(s.position, 'aqua'), label(` ${s.dimension}`), dot, label(`第 ${s.day} 天 ${s.clock}`)],
            [label('手持 '), s.held ? { item: s.held, color: 'yellow' } : value('空手'), dot, label('盔甲 '), ...(s.armor.length ? s.armor.flatMap((a, i) => [{ item: a, color: 'white' }, ...(i < s.armor.length - 1 ? [label('、')] : [])]) : [value('无')])],
            [label('正在 '), value(s.task ? s.task.desc : '没事做，陪着大家', 'yellow')],
            [label('对你的好感 '), value(`${love.score}`, 'light_purple'), label(`（${love.level}）`), gap, ...bar(love.score)],
          ],
        };
      },
    },
    {
      names: ['背包', 'inv', 'bag', '物品'],
      run: (player) => {
        const bot = agent.bot;
        // 能弹窗时打开可视化背包窗口；否则在聊天栏画图标格子；再不行就用文字面板
        if (agent.cfg.ui.inventory_dialog && agent.identity.opLevel >= 2 && supportsDialog(agent)) {
          showInventoryDialog(agent, player.name);
          return [];
        }
        if (agent.identity.opLevel >= 2 && sendChatInventory(agent, player.name)) return [];
        const totals = new Map();
        for (const i of bot.inventory.items()) totals.set(i.name, (totals.get(i.name) ?? 0) + i.count);
        if (!totals.size) return ['背包是空的喵'];
        const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]);
        const lines = [title(`背包（空 ${bot.inventory.emptySlotCount()} 格）`)];
        for (let i = 0; i < entries.length && lines.length < 12; i += 4) {
          const row = [];
          entries.slice(i, i + 4).forEach(([n, c]) => row.push({ item: n, color: 'white', hover: n }, value(`×${c}`, 'yellow'), gap));
          lines.push(row);
        }
        return { panel: lines };
      },
    },
    {
      names: ['好感', 'love', '好感度'],
      run: (player, args) => {
        if (args[0] && ['全部', 'all'].includes(args[0]) && player.owner) {
          const all = agent.affection.all();
          if (!all.length) return ['还没有记录'];
          return { panel: [title('大家的好感度'), ...all.slice(0, 10).map((a) => [value(a.player, 'aqua'), gap, value(`${a.score}`, 'light_purple'), label(`（${a.level}）`), gap, ...bar(a.score)])] };
        }
        const love = agent.affection.get(player.name, player.owner);
        const lines = [
          title(`${player.name} 的好感度`),
          [value(`${love.score}`, 'light_purple', true), label('/100 '), value(`【${love.level}】`, 'yellow'), gap, ...bar(love.score)],
        ];
        if (love.next) lines.push([label(`再加 ${love.next.need} 点就到「${love.next.name}」啦`)]);
        if (love.history.length) lines.push([label('最近：'), value(love.history.slice(-3).map((h) => `${h.reason} ${h.delta >= 0 ? '+' : ''}${h.delta}`).join('，'))]);
        return { panel: lines };
      },
    },
    {
      names: ['任务', 'task'],
      run: () => {
        const t = agent.tasks.info();
        return [t ? `正在：${t.desc}（${t.seconds} 秒了）` : '现在没有任务'];
      },
    },
    {
      names: ['停', '停下', 'stop'],
      owner: true,
      run: async () => {
        const t = await agent.tasks.cancel('被 #停 叫停');
        return [t ? `好，停下了：${t.desc}` : '我本来就闲着喵'];
      },
    },
    {
      names: ['过来', 'come'],
      owner: true,
      run: async (player) => {
        const r = await act('go_to_player', { player: player.name, follow: false }, player);
        return [r.ok ? '来啦～' : r.text];
      },
    },
    {
      names: ['跟着', '跟随', 'follow'],
      owner: true,
      run: async (player) => {
        const r = await act('go_to_player', { player: player.name, follow: true }, player);
        return [r.ok ? '好，我跟着你～（发 #停 让我停下）' : r.text];
      },
    },
    {
      names: ['回家', 'home'],
      owner: true,
      run: async (player) => {
        if (!agent.homeBed) return ['我还不知道家在哪……先让我在床上睡一次吧'];
        const { x, y, z } = agent.homeBed;
        const r = await act('goto', { x, y, z }, player);
        return [r.ok ? '好，回家啦～' : r.text];
      },
    },
    {
      names: ['记忆', 'memory'],
      owner: true,
      run: () => {
        const notes = agent.memory.list();
        if (!notes.length) return ['还没有记住什么'];
        return { panel: [title('我记住的事'), ...notes.slice(-10).map((n, i) => [label(`${i + 1}. `), value(n.text)])] };
      },
    },
    // 互动
    { names: ['摸头', '摸摸'], run: async (player) => { agent.affection.change(player.name, 1, '摸了摸猫娘的头', { kind: 'chat', owner: player.owner }); await act('emote', { name: 'happy', target: player.name }, player, 20_000); return ['呼噜呼噜……好舒服喵～']; } },
    { names: ['抱抱', 'hug'], run: async (player) => { agent.affection.change(player.name, 1, '抱了抱猫娘', { kind: 'chat', owner: player.owner }); await act('go_to_player', { player: player.name, follow: false }, player, 15_000); await act('emote', { name: 'hearts', target: player.name }, player, 5000); return ['抱抱～（蹭蹭）']; } },
    { names: ['挥手', 'wave'], run: emote('wave') },
    { names: ['跳舞', 'dance'], run: async (player) => [...await emote('dance')(player), '跳得好看吗喵～'] },
    { names: ['转圈', 'spin'], run: emote('spin') },
    { names: ['喵', 'meow', '喵喵'], run: async (player) => [...await emote('meow')(player), '喵～'] },
    { names: ['坐下', 'sit'], run: async (player) => [...await emote('sit')(player), '好，坐下了～'] },
    {
      names: ['睡觉', '睡', 'sleep'],
      run: async (player) => {
        await agent.social.goSleep(player.name);
        return [];
      },
    },
    { names: ['起来', '站起来', 'stand'], run: emote('stand') },
    // 功能需求：主人许愿，后台的 Claude Code 按 CLAUDE.md 的约束来做
    {
      names: ['需求', '许愿', 'request'],
      owner: true,
      run: (player, args) => {
        const text = args.join(' ').trim();
        if (!text) {
          const list = agent.requests.recent(5);
          if (!list.length) return ['还没有需求。发「#需求 想让我学会的东西」就行，比如：#需求 学会钓鱼'];
          const color = (st) => ({ done: 'green', rejected: 'red', cancelled: 'gray' }[st] ?? 'yellow');
          return {
            panel: [title('功能需求'), ...list.map((r) => [value(`#${r.id} `, 'aqua'), value(r.text.slice(0, 36)), gap,
              value(`【${STATUS[r.status]}】`, color(r.status)), ...(r.note ? [label(` ${r.note.slice(0, 30)}`)] : [])])],
          };
        }
        const cancel = /^(撤销|取消)\s*#?(\d+)$/.exec(text);
        if (cancel) {
          const r = agent.requests.get(cancel[2]);
          if (!r) return [`没有需求 #${cancel[2]}`];
          if (!['pending', 'accepted'].includes(r.status)) return [`需求 #${r.id} 已经${STATUS[r.status]}了`];
          agent.requests.update(r.id, 'cancelled');
          return [`好，需求 #${r.id} 撤销了`];
        }
        const r = agent.requests.add(player.name, text);
        agent.events.push('bot', { what: 'feature_request', by: player.name, detail: `#${r.id} ${r.text}` });
        const how = agent.cfg.brain.mode === 'claude-code'
          ? '我的“大脑”会在后台看看能不能做，做好了告诉你喵'
          : '这个要在电脑上用 Claude Code 模式处理，先帮你记下来了';
        return [`收到～需求 #${r.id} 记下来了：${r.text.slice(0, 40)}。${how}`];
      },
    },
    // 战斗模式：普通 / 困难 / 极限 / 作弊（临时发顶级附魔装备，切回来时收回）
    {
      names: ['战斗模式', 'combat', 'mode'],
      owner: true,
      run: async (player, args) => {
        const now = combatFlags(agent).mode;
        if (!args.length) {
          return {
            panel: [
              title(`战斗模式（现在：${now}）`),
              ...MODE_NAMES.map((m) => [cmd(`#战斗模式 ${m}`, MODE_DESC[m]), label(`  ${MODE_DESC[m]}`)]),
              [label('作弊模式可以加：'), cmd('#战斗模式 作弊 钻石', '钻石套（默认下界合金套）'), label('  '), cmd('#战斗模式 作弊 下界合金 图腾3 金苹果6 鞘翅', '自己定数量，加鞘翅和烟花')],
            ],
          };
        }
        const mode = normalizeMode(args[0]);
        if (!mode) return [`模式只有：${MODE_NAMES.join('、')}`];
        const c = agent.cfg.combat;
        const opt = (re, def) => {
          const hit = args.map((a) => re.exec(a)).find(Boolean);
          return hit ? Number(hit[1]) : def;
        };
        const tier = args.includes('钻石') ? '钻石' : args.includes('下界合金') ? '下界合金' : (c.cheat_tier ?? '下界合金');
        if (now === '作弊' && mode !== '作弊') await removeCheatKit(agent);
        saveOverride(agent.cfg, findSetting('战斗模式'), mode);
        agent.events.push('bot', { what: 'setting', by: player.name, detail: `战斗模式 → ${mode}` });
        if (mode !== '作弊') return [`战斗模式改成「${mode}」了：${MODE_DESC[mode]}${now === '作弊' ? '。临时装备已经收回，换回我自己的装备了' : ''}`];
        saveOverride(agent.cfg, findSetting('作弊装备'), tier);
        if (now === '作弊') await removeCheatKit(agent);
        const n = await giveCheatKit(agent, {
          tier,
          totems: args.includes('不要图腾') ? 0 : opt(/^图腾(\d+)$/, Number(c.cheat_totems ?? 2)),
          gapples: args.includes('不要金苹果') ? 0 : opt(/^金苹果(\d+)$/, Number(c.cheat_gapples ?? 4)),
          potions: !args.includes('不要药水') && c.cheat_potions !== false,
          elytra: args.includes('鞘翅') || c.cheat_elytra === true,
        });
        return [`切换到作弊模式：拿到 ${n} 样临时的顶级附魔装备（${tier}套），切回别的模式时会收回来喵`];
      },
    },
    // 游戏里直接改设置（只开放不影响安全的行为开关）
    {
      names: ['设置', 'set', 'settings'],
      owner: true,
      run: (player, args) => {
        const show = (s, v) => (s.type === 'bool' ? (v ? '开' : '关') : String(v));
        if (!args.length) {
          const lines = [title('设置（点一下填入聊天框，后面写 开 / 关 或数字）')];
          const cells = SETTINGS.filter((s) => !s.hidden).map((s) => {
            const v = settingValue(agent.cfg, s);
            return [cmd(`#设置 ${s.key}`, s.desc), label(' '), value(show(s, v), s.type === 'bool' ? (v ? 'green' : 'red') : 'aqua')];
          });
          for (let i = 0; i < cells.length; i += 3) lines.push(cells.slice(i, i + 3).flatMap((c, j) => [...c, ...(j < 2 ? [gap] : [])]));
          lines.push([label('全部恢复成 config.toml 里的样子：'), cmd('#设置 重置')]);
          return { panel: lines };
        }
        if (['重置', 'reset'].includes(args[0])) {
          const n = resetOverrides(agent.cfg, loadConfig());
          if (agent.bot) agent.bot.nekoScaffold = agent.cfg.behavior.scaffold !== false;
          return [n ? `好，恢复了 ${n} 项设置` : '本来就没改过设置'];
        }
        const s = findSetting(args[0]);
        if (!s) return [`没有「${args[0]}」这个设置，发 #设置 看看有哪些`];
        if (args.length < 2) return [`${s.key}：${show(s, settingValue(agent.cfg, s))}（${s.desc}）`];
        const v = parseValue(s, args[1]);
        saveOverride(agent.cfg, s, v);
        if (s.path === 'behavior.scaffold' && agent.bot) agent.bot.nekoScaffold = v;
        agent.events.push('bot', { what: 'setting', by: player.name, detail: `${s.key} → ${show(s, v)}` });
        return [`好，${s.key} 改成 ${show(s, v)} 了喵`];
      },
    },
    // 小游戏
    { names: ['猜拳', 'rps'], run: (player, args) => playMiniGame(agent, 'rps', player.name, args) },
    { names: ['抛硬币', '硬币', 'coin'], run: (player) => playMiniGame(agent, 'coin', player.name, []) },
    { names: ['猜数字', 'guess'], run: (player, args) => playMiniGame(agent, 'guess', player.name, args) },
    // 决斗
    {
      names: ['决斗', 'pk', 'PK', 'duel'],
      run: async (player, args) => {
        // 没说难度：先让玩家选
        if (!args.length) {
          return {
            panel: [
              title('PVP 决斗：选个难度（点一下，再按回车）'),
              [cmd('#决斗 简单', '不走位、不跳劈、不举盾，出手慢'), gap, cmd('#决斗 普通', '左右走位、举盾，会用斧子破你的盾'), gap,
                cmd('#决斗 困难', '走位、跳劈暴击、举盾、斧子破盾'), gap, cmd('#决斗 作弊', '困难的打法，再临时换上一套顶级附魔装备（打完收回）')],
              [label('打到只剩 1 滴血就停，谁都不会被打死。'), cmd('#认输'), label(' 随时认输，'), cmd('#战绩'), label(' 看胜负')],
            ],
          };
        }
        const level = { 简单: 'easy', 普通: 'normal', 困难: 'hard', 作弊: 'cheat', easy: 'easy', normal: 'normal', hard: 'hard', cheat: 'cheat' }[args[0]];
        if (!level) return ['难度只有：简单、普通、困难、作弊（比如 #决斗 困难）'];
        const r = await act('duel', { action: 'start', player: player.name, difficulty: level }, player, 500);
        return r.ok ? [] : [r.text];
      },
    },
    { names: ['认输', '投降', 'surrender'], run: (player) => [agent.duels.surrender(player.name) ? '嘿嘿，那就是我赢啦～' : '我们现在没在决斗呀'] },
    { names: ['战绩'], run: (player) => [agent.duels.statsText(player.name)] },
  ];

  // 返回 true 表示这句话是快捷命令并且已经处理。
  return async function handle(msg) {
    const text = msg.text.trim();
    if (!text.startsWith(prefix)) return false;
    const [name, ...args] = text.slice(prefix.length).trim().split(/\s+/);
    const command = commands.find((c) => c.names.includes(name) || c.names.includes(name.toLowerCase()));
    if (!command) return false;
    const player = { name: msg.from, owner: msg.owner };
    let out;
    if (command.owner && !msg.owner) out = ['这个只有主人能用喵'];
    else if (!agent.online) return true;
    else {
      try {
        out = await command.run(player, args, name);
      } catch (err) {
        out = [`出错了：${err.message}`];
      }
    }
    agent.events.push('bot', { what: 'quick_command', by: msg.from, detail: text });
    if (out?.panel) sendPanel(agent, msg.from, out.panel);
    else for (const line of out ?? []) agent.say(line, { to: msg.from });
    return true;
  };
}
