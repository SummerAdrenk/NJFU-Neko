// 组装“这一刻的世界”给大脑看：触发原因、状态、服务器与模组、对方的好感、最近聊天、最近行动、箱子、记忆。
import { clock } from '../log.js';
import { describeStatus } from '../bot/status.js';
import { truncate } from '../util.js';

const VERBS = { public: '说', whisper: '悄悄对你说', team: '在队伍频道说', emote: '做了个动作', say: '广播' };
const TASK_STATUS = { done: '完成', failed: '失败', cancelled: '取消' };

export function formatChatLine(line) {
  const time = clock(new Date(line.t));
  if (line.kind === 'system') return `[${time}] （系统）${line.text}`;
  if (line.self) return `[${time}] 你${line.to ? `悄悄对 ${line.to} 说` : '说'}：${line.text}`;
  return `[${time}] ${line.from}${line.owner ? '（主人）' : ''}${VERBS[line.kind] ?? '说'}：${line.text}`;
}

export function formatTrigger(agent, trigger) {
  if (trigger.type === 'chat') {
    const m = trigger.msg;
    const love = agent.affection.get(m.from, m.owner);
    const who = `${m.from}（${m.owner ? '主人' : '不是主人'}，好感 ${love.score}·${love.level}）`;
    const hint = m.kind === 'whisper' ? '（这是私聊：回复时用 say 的 to 参数悄悄回复）' : '';
    return `[${clock(new Date(m.t))}] ${who}${VERBS[m.kind] ?? '说'}：${m.text}${hint}`;
  }
  if (trigger.type === 'task') {
    const t = trigger.task;
    return t.status === 'done'
      ? `后台任务 #${t.id}「${t.desc}」已完成：${t.result}`
      : `后台任务 #${t.id}「${t.desc}」失败了：${t.error}`;
  }
  return `[${clock()}] ${trigger.text ?? ''}`;
}

export function recentActions(agent, n) {
  return agent.events.buffer
    .filter((e) => e.type === 'action' || (e.type === 'task' && e.status !== 'started') || (e.type === 'brain' && e.what === 'episode_end' && e.note))
    .slice(-n)
    .map((e) => {
      const time = clock(new Date(e.t));
      if (e.type === 'action') {
        return `[${time}] ${e.name} ${truncate(JSON.stringify(e.input ?? {}), 80)} → ${e.ok ? '' : '失败：'}${truncate(e.result ?? '', 120)}`;
      }
      if (e.type === 'task') return `[${time}] 任务 #${e.id}「${e.desc}」${TASK_STATUS[e.status] ?? e.status}：${truncate(e.result ?? e.error ?? '', 120)}`;
      return `[${time}] 你给自己的备注：${truncate(e.note, 150)}`;
    });
}

export function buildContext(agent, { triggers = [], chatLines = 20, actionLines = 12 } = {}) {
  const sections = [];
  if (triggers.length) sections.push(`【这次叫醒你的】\n${triggers.map((t) => formatTrigger(agent, t)).join('\n')}`);
  sections.push(`【你的状态】\n${describeStatus(agent)}`);
  const people = [...new Set(triggers.map((t) => t.requester?.name).filter(Boolean))];
  if (people.length) {
    sections.push(`【你对他们的好感】\n${people.map((name) => {
      const love = agent.affection.get(name, agent.chat.isOwner(name));
      return `${name}：${love.score}/100（${love.level}）——说话语气：${love.tone}`;
    }).join('\n')}`);
  }
  if (agent.online) sections.push(`【服务器】\n${agent.serverInfo.describe()}`);
  const chat = agent.chat.recent(chatLines).map(formatChatLine);
  sections.push(`【最近聊天】（从旧到新）\n${chat.join('\n') || '（暂无）'}`);
  const actions = recentActions(agent, actionLines);
  sections.push(`【最近行动】（从旧到新）\n${actions.join('\n') || '（暂无）'}`);
  if (agent.online) sections.push(`【记得的箱子】（按距离）\n${agent.chestIndex.describe(agent.bot.entity.position, 6)}`);
  const notes = agent.memory.list();
  sections.push(`【记忆】\n${notes.map((note, i) => `${i + 1}. ${note.text}`).join('\n') || '（暂无）'}`);
  sections.push(`【现实时间】${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  return sections.join('\n\n');
}
