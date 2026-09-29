#!/usr/bin/env node
// 入口：读配置 → 配置日志 → 启动大脑和控制接口 → 连接服务器。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { applyOverrides } from './settings.js';
import { EventLog, getLog, logger } from './log.js';
import { CONTROL_FILE, EVENTS_FILE, LOG_DIR, ROOT } from './paths.js';
import { Agent } from './agent.js';
import { startControlServer } from './control/server.js';
import { ApiBrain } from './brain/apiBrain.js';
import { OpenAiBrain } from './brain/openaiBrain.js';
import { ClaudeCodeBrain, NoBrain } from './brain/claudeCodeBrain.js';

const log = getLog('启动');
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function createBrain(agent) {
  const mode = agent.cfg.brain.mode;
  if (mode === 'claude-code') return new ClaudeCodeBrain(agent);
  if (mode === 'api') {
    try {
      return new ApiBrain(agent);
    } catch (err) {
      log.error(`Claude API 大脑启动失败：${err.message}`);
      log.error('请在 config.toml 的 [brain.api] 填写 api_key，或设置环境变量 ANTHROPIC_API_KEY；现在先以“只挂机”模式运行');
    }
  }
  if (mode === 'openai') {
    try {
      return new OpenAiBrain(agent);
    } catch (err) {
      log.error(`OpenAI 兼容接口大脑启动失败：${err.message}`);
      log.error('请检查 config.toml 的 [brain.openai]（服务商、地址、模型、Key）；现在先以“只挂机”模式运行');
    }
  }
  return new NoBrain();
}

// 防泄漏检查：config.toml 里写了 API Key，却被 git 跟踪（可能会被提交上传）。
function checkSecretsNotTracked(cfg) {
  if (!String(cfg.brain.api?.api_key ?? '').trim() && !String(cfg.brain.openai?.api_key ?? '').trim()) return;
  const r = spawnSync('git', ['ls-files', '--error-unmatch', path.relative(ROOT, cfg.file)], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status === 0) {
    log.warn('⚠ config.toml 里有 API Key，而且它被 git 跟踪了，提交时会把 Key 一起上传！请执行：git rm --cached config.toml');
  }
}

// 已经有一个猫娘在跑（它的控制接口还能访问）：返回它的信息。两个同时跑会用同一个名字登录，
// 一个连上就把另一个挤下线，还会互相把对方的 ViaProxy 当成残留进程杀掉，每十几秒掉一次线
export async function runningInstance() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (!info?.url || info.pid === process.pid) return null;
  try {
    const res = await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? info : null;
  } catch {
    return null;
  }
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
  logger.configure({ dir: LOG_DIR, consoleLevel: cfg.logging.console_level, fileLevel: cfg.logging.file_level, keepDays: cfg.logging.keep_days });
  console.log(`\n  NJFU智慧猫娘 v${version}\n`);
  logger.write('info', '启动', [`NJFU智慧猫娘 v${version}，Node ${process.versions.node}，${process.platform}，配置 ${cfg.file}`], { toConsole: false });
  log.info(`日志文件：${path.relative(ROOT, logger.currentFile)}（出问题时可以运行 npm run ctl -- report 生成问题报告）`);
  for (const warning of cfg.warnings) log.warn(warning);
  const overridden = applyOverrides(cfg);
  if (overridden) log.info(`应用了游戏里 #设置 改过的 ${overridden} 项设置（runtime/overrides.json）`);
  checkSecretsNotTracked(cfg);

  const other = await runningInstance();
  if (other) {
    log.warn(`猫娘已经在运行了（进程 ${other.pid}，${other.url}），这次不再启动第二个。`);
    log.warn('要重启她：先运行 npm run ctl -- stop 让她下线，再重新启动。');
    process.exit(0);
  }

  const events = new EventLog(EVENTS_FILE);
  const agent = new Agent(cfg, events);
  const brain = createBrain(agent);
  brain.start();

  if (cfg.control.enabled) {
    await startControlServer(agent, { brain, brainMode: cfg.brain.mode });
  } else if (cfg.brain.mode === 'claude-code') {
    log.warn('Claude Code 模式需要控制接口，请把 config.toml 的 control.enabled 改为 true');
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`猫娘下线中…（${signal}）`);
    await agent.shutdown('下线').catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('unhandledRejection', (err) => log.warn('未处理的异步错误：', err));
  process.on('uncaughtException', (err) => log.error('未捕获的错误：', err));

  await agent.connect();
}

main();
