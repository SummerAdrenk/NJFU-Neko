// 事件的一行文字描述：日志文件、命令行 watch/events 共用。

const pad = (n) => String(n).padStart(2, '0');
export function clock(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const TASK_STATUS = { started: '开始', done: '完成', failed: '失败', cancelled: '取消' };
const BOT_WHAT = {
  death: '猫娘死亡', respawn: '已重生', low_health: '血量低', hungry_no_food: '饿了但没有吃的',
  op: '权限变化', emergency_stop: '急停', attacked: '被玩家攻击', gift: '收到礼物', pet: '被摸头',
  quick_command: '快捷命令', teleport: '传送', progress: '进度', player_death: '玩家死亡', ask_sleep: '问要不要一起睡',
  retreat: '撤退', affection_level: '好感等级变化', feature_request: '功能需求', setting: '设置变更', question: '提问',
  clutch: '防摔', combat: '战斗', panel_open: '打开面板', menu_open: '打开菜单', menu_button: '菜单按钮', toss_junk: '扔垃圾',
};
const CONNECTION = { connecting: '连接中', online: '已上线', offline: '已断开', kicked: '被踢出', error: '出错', handshake: '握手' };
const BRAIN = { episode_start: '开始思考', episode_end: '思考结束', round: '一轮', refusal: '拒绝', fallback: '换备用模型', error: '出错', max_tokens: '回复太长被截断' };

export function describeEvent(e) {
  switch (e.type) {
    case 'chat':
      return `${e.kind === 'whisper' ? '私聊' : '聊天'} ${e.from}${e.owner ? '(主人)' : ''}${e.addressed ? ' → 猫娘' : ''}：${e.text}`;
    case 'said':
      return `猫娘${e.to ? ` 悄悄对 ${e.to}` : ''}说：${String(e.text).replace(/\n/g, ' / ')}`;
    case 'task':
      return `任务#${e.id} ${TASK_STATUS[e.status] ?? e.status}：${e.desc}${e.result ? ` → ${e.result}` : ''}${e.error ? ` → ${e.error}` : ''}`;
    case 'bot':
      return `${BOT_WHAT[e.what] ?? e.what}${e.level != null ? ` 等级 ${e.level}` : ''}${e.health != null ? ` 生命 ${e.health}` : ''}${e.position ? ` ${e.position}` : ''}${e.by ? `（${e.by}）` : ''}${e.detail ? `：${e.detail}` : ''}`;
    case 'connection':
      return `连接 ${CONNECTION[e.state] ?? e.state}${e.detail ? `：${e.detail}` : ''}${e.position ? ` ${e.position}` : ''}`;
    case 'system':
      return `系统消息：${e.text}`;
    case 'action':
      return `动作 ${e.name} ${JSON.stringify(e.input ?? {})} → ${e.ok ? (e.running ? '后台进行中 ' : '') : '失败 '}${e.result ?? ''}`;
    case 'brain':
      return `大脑 ${BRAIN[e.what] ?? e.what}${e.detail ? `：${e.detail}` : ''}${e.note ? `：${e.note}` : ''}${e.error ? `：${e.error}` : ''}`;
    case 'affection':
      return `好感 ${e.player} ${e.delta >= 0 ? '+' : ''}${e.delta} → ${e.score}（${e.level}）：${e.reason}`;
    case 'server':
      return `服务器信息：${e.detail}`;
    default:
      return `${e.type} ${JSON.stringify(e)}`;
  }
}

export function formatEvent(e) {
  return `[#${e.seq} ${clock(new Date(e.t))}] ${describeEvent(e)}`;
}
