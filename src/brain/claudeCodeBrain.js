// Claude Code 模式：猫娘进程本身不思考，只把“有人叫猫娘”等事件写进事件流；
// 由 Claude Code 会话通过 `neko watch` 收到通知，再用 `neko say / act` 回应（见 CLAUDE.md）。
import { getLog } from '../log.js';

const log = getLog('大脑');

export class ClaudeCodeBrain {
  constructor(agent) {
    this.agent = agent;
  }

  start() {
    this.agent.on('addressed', (msg) => {
      log.info(`[等待 Claude Code 回应] ${msg.from}：${msg.text}`);
    });
    log.info('大脑：Claude Code 模式（在本项目目录打开 Claude Code，让它按 CLAUDE.md 接管猫娘）');
  }
}

export class NoBrain {
  start() {
    log.info('大脑：关闭（只挂机，不回话）');
  }
}
