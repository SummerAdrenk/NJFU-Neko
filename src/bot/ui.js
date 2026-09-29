// 聊天栏“小面板”：用 /tellraw 发带颜色、可点击、可悬停提示的多行文字；没有管理员权限时退化成普通私聊。
//
// 一行 = 若干段，每段：{ text, color, bold, italic, suggest: '点击后填入聊天框的文字', url, hover: '悬停提示', item: '物品ID' }

// 1.21.5 起文本组件的点击/悬停字段改名（click_event / hover_event），之前是 clickEvent / hoverEvent。
export function modernText(agent) {
  const v = String(agent.target?.serverVersion ?? '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!v) return true;
  const [major, minor, patch] = [Number(v[1]), Number(v[2]), Number(v[3] ?? 0)];
  return major > 1 || minor > 21 || (minor === 21 && patch >= 5);
}

export function itemKey(registry, name) {
  return `${registry?.blocksByName?.[name] ? 'block' : 'item'}.minecraft.${name}`;
}

export function toComponent(agent, seg) {
  if (typeof seg === 'string') return { text: seg };
  const modern = modernText(agent);
  const c = seg.item
    ? { translate: itemKey(agent.bot?.registry, seg.item), fallback: seg.item }
    : { text: String(seg.text ?? '') };
  for (const key of ['color', 'bold', 'italic', 'underlined']) if (seg[key] != null) c[key] = seg[key];
  if (seg.suggest) {
    Object.assign(c, modern
      ? { click_event: { action: 'suggest_command', command: seg.suggest } }
      : { clickEvent: { action: 'suggest_command', value: seg.suggest } });
  } else if (seg.url) {
    Object.assign(c, modern
      ? { click_event: { action: 'open_url', url: seg.url } }
      : { clickEvent: { action: 'open_url', value: seg.url } });
  }
  if (seg.hover) {
    Object.assign(c, modern
      ? { hover_event: { action: 'show_text', value: seg.hover } }
      : { hoverEvent: { action: 'show_text', contents: seg.hover } });
  }
  return c;
}

export const plainText = (line) => (Array.isArray(line) ? line : [line])
  .map((s) => (typeof s === 'string' ? s : s.item ?? s.text ?? '')).join('');

// 发一个面板给某个玩家。
export function sendPanel(agent, player, lines) {
  if (!agent.online) return;
  if (!agent.identity.canTellraw()) {
    for (const line of lines) agent.say(plainText(line), { to: player });
    return;
  }
  for (const line of lines) {
    const segs = Array.isArray(line) ? line : [line];
    agent.identity.sendRaw(player, ['', ...segs.map((s) => toComponent(agent, s))], plainText(line));
  }
}

// ── 常用样式 ──
export const title = (text) => [
  { text: '━━━━ ', color: 'dark_gray' },
  { text, color: 'light_purple', bold: true },
  { text: ' ━━━━', color: 'dark_gray' },
];
export const cmd = (command, hover) => ({ text: command, color: 'aqua', suggest: command, hover: hover ? `${hover}\n（点击填入聊天框）` : '点击填入聊天框' });
export const gap = { text: '  ' };
export const dot = { text: ' · ', color: 'dark_gray' };
export const label = (text) => ({ text, color: 'gray' });
export const value = (text, color = 'white') => ({ text: String(text), color });
export function bar(score, width = 10) {
  const filled = Math.round((score / 100) * width);
  return [{ text: '■'.repeat(filled), color: 'light_purple' }, { text: '■'.repeat(width - filled), color: 'dark_gray' }];
}
