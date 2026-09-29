import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { ROOT } from './paths.js';

export const EXAMPLE_FILE = path.join(ROOT, 'config.example.toml');
export const CONFIG_FILE = process.env.NEKO_CONFIG
  ? path.resolve(process.env.NEKO_CONFIG)
  : path.join(ROOT, 'config.toml');

const BRAIN_MODES = { api: 'api', anthropic: 'api', 'claude-code': 'claude-code', claudecode: 'claude-code', none: 'none', off: 'none' };

function readToml(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return parse(text);
  } catch (err) {
    throw new Error(`配置文件格式有误：${file}\n${err.message}`);
  }
}

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? merge(base[key], value) : value;
  }
  return out;
}

// 读取 config.toml（缺省项用模板里的默认值补齐），并应用环境变量覆盖。
export function loadConfig() {
  const defaults = readToml(EXAMPLE_FILE);
  const exists = fs.existsSync(CONFIG_FILE);
  const cfg = merge(defaults, exists ? readToml(CONFIG_FILE) : {});

  const env = process.env;
  if (env.NEKO_HOST) cfg.server.host = env.NEKO_HOST;
  if (env.NEKO_PORT) cfg.server.port = Number(env.NEKO_PORT);
  if (env.NEKO_USERNAME) cfg.account.username = env.NEKO_USERNAME;
  if (env.NEKO_BRAIN) cfg.brain.mode = env.NEKO_BRAIN;
  if (env.NEKO_JAVA) cfg.viaproxy.java = env.NEKO_JAVA;

  const mode = BRAIN_MODES[String(cfg.brain.mode).toLowerCase()];
  if (!mode) throw new Error(`brain.mode 只能是 "api"、"claude-code" 或 "none"，现在是 "${cfg.brain.mode}"`);
  cfg.brain.mode = mode;

  cfg.server.port = Number(cfg.server.port);
  cfg.viaproxy.jar = path.resolve(ROOT, cfg.viaproxy.jar);
  cfg.chat.triggers = (cfg.chat.triggers ?? []).map(String).filter(Boolean);
  cfg.chat.owners = (cfg.chat.owners ?? []).map(String).filter(Boolean);
  cfg.commands.deny = (cfg.commands.deny ?? []).map((c) => String(c).toLowerCase().replace(/^\//, ''));

  const warnings = [];
  if (!exists) warnings.push(`没有找到 ${path.basename(CONFIG_FILE)}，暂时使用默认配置（运行 npm run setup 生成）`);
  if (cfg.account.auth === 'offline' && !/^[A-Za-z0-9_]{3,16}$/.test(cfg.account.username)) {
    warnings.push(`登录名「${cfg.account.username}」不合法：只能用 3～16 个英文字母、数字或下划线，服务器会拒绝`);
  }
  cfg.file = CONFIG_FILE;
  cfg.warnings = warnings;
  return cfg;
}
