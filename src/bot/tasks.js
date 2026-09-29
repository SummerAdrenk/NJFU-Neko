// 长任务管理：同一时间只做一件“长事”（走路、挖矿、跟随、护卫……），新任务会替换旧任务。
import { sleep, truncate } from '../util.js';
import { describeError } from './helpers.js';

export function stopMotion(bot) {
  if (!bot) return;
  const attempts = [
    () => bot.pathfinder?.setGoal(null),
    () => bot.pathfinder?.stop(),
    () => bot.pvp?.forceStop(),
    () => bot.collectBlock?.cancelTask(),
    () => bot.targetDigBlock && bot.stopDigging(),
    () => bot.clearControlStates(),
    () => bot.currentWindow && bot.closeWindow(bot.currentWindow),
  ];
  for (const attempt of attempts) {
    try {
      const r = attempt();
      if (r?.catch) r.catch(() => {});
    } catch {
      // 某个插件没加载或已经停下
    }
  }
}

export class TaskManager {
  constructor(agent) {
    this.agent = agent;
    this.current = null;
    this.nextId = 1;
  }

  info() {
    const t = this.current;
    if (!t) return null;
    return { id: t.id, name: t.name, desc: t.desc, seconds: Math.round((Date.now() - t.startedAt) / 1000), by: t.by?.name ?? t.by?.source ?? null };
  }

  // 启动任务；waitMs 内结束就返回结果，否则返回“后台进行中”，结束时会发出 taskEnded 事件。
  async run(name, desc, fn, { waitMs = 60_000, by = null } = {}) {
    if (this.current) await this.cancel(`被新任务「${desc}」替换`);
    const controller = new AbortController();
    const task = { id: this.nextId++, name, desc, by, startedAt: Date.now(), controller, signal: controller.signal, status: 'running', detached: false };
    this.current = task;
    const events = this.agent.events;
    events.push('task', { id: task.id, name, desc, status: 'started', by: by?.name ?? by?.source ?? null });

    task.promise = (async () => fn(task))().then(
      (result) => {
        task.status = 'done';
        task.result = String(result ?? '完成');
      },
      (err) => {
        task.status = controller.signal.aborted ? 'cancelled' : 'failed';
        task.error = controller.signal.aborted ? String(controller.signal.reason ?? '已取消') : describeError(err);
      },
    ).finally(() => {
      if (this.current === task) this.current = null;
      events.push('task', {
        id: task.id, name, desc, status: task.status,
        ...(task.status === 'done' ? { result: truncate(task.result, 500) } : { error: truncate(task.error, 300) }),
        seconds: Math.round((Date.now() - task.startedAt) / 1000),
        by: by?.name ?? by?.source ?? null,
      });
      this.agent.emit('taskEnded', task);
    });

    const finished = await Promise.race([task.promise.then(() => true), sleep(waitMs).then(() => false)]);
    if (!finished) {
      task.detached = true;
      return { ok: true, running: true, text: `任务「${desc}」（#${task.id}）正在后台进行，结束时会收到通知。` };
    }
    if (task.status === 'done') return { ok: true, text: task.result };
    return { ok: false, text: task.status === 'cancelled' ? `任务被取消：${task.error}` : `任务失败：${task.error}` };
  }

  async cancel(reason = '已取消') {
    const task = this.current;
    if (task) task.controller.abort(reason);
    stopMotion(this.agent.bot);
    if (!task) return null;
    await Promise.race([task.promise, sleep(3000)]);
    return task;
  }
}
