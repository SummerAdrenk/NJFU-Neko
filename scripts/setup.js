#!/usr/bin/env node
// 一键准备。start.bat 每次启动前都会运行它，都准备好了一秒就跳过；也可以单独运行 npm run setup。
//   1. 检查 Node.js 版本
//   2. 安装依赖：node_modules 还没有，或者换了新版本的压缩包（package-lock.json 变了）时重新安装；
//      连不上 npm 官方源时自动换国内镜像（npmmirror）重试
//   3. 找 Java 17+（ViaProxy 要用）：配置里的、环境变量、PATH、常见安装目录、Minecraft 启动器自带的；
//      找到了写进 config.toml，找不到时问要不要用 winget 安装
//   4. 没有 ViaProxy 就从 GitHub 下载（加 --update 时检查新版本）
//   5. 没有 config.toml 就一问一答生成（服务器、主人、大脑）
// 只用 Node 自带的模块：这时候依赖可能还没装。
// 用法：node scripts/setup.js [--update] [--no-wizard]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viaDir = path.join(root, 'runtime', 'viaproxy');
const jarPath = path.join(viaDir, 'ViaProxy.jar');
const versionFile = path.join(viaDir, 'version.txt');
const configPath = path.join(root, 'config.toml');
const templatePath = path.join(root, 'config.example.toml');
const stampPath = path.join(root, 'node_modules', '.neko-install-stamp');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
const UPDATE = args.includes('--update') || args.includes('--force');
const WIZARD = !args.includes('--no-wizard') && process.stdin.isTTY;
const NPM_MIRROR = 'https://registry.npmmirror.com';
const JAVA_MIN = 17;

const ok = (text) => console.log(`✓ ${text}`);
const warn = (text) => console.log(`! ${text}`);

// ── config.toml 的小工具（模板带注释，只改需要的那一行） ──

const toToml = (v) => (Array.isArray(v) ? `[${v.map(toToml).join(', ')}]` : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v)));

// 把 [section] 里的 key 改成 value（只改这一段里的第一个 key，别的段里同名的不动）
export function setTomlValue(text, section, key, value) {
  const lines = text.split('\n');
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\[[^\]]+\]$/.test(t)) {
      inSection = t === `[${section}]`;
      continue;
    }
    if (inSection && new RegExp(`^${key}\\s*=`).test(t)) {
      lines[i] = `${key} = ${toToml(value)}`;
      return lines.join('\n');
    }
  }
  throw new Error(`配置模板里找不到 [${section}] ${key}`);
}

export function getTomlValue(text, section, key) {
  let inSection = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\[[^\]]+\]$/.test(t)) {
      inSection = t === `[${section}]`;
      continue;
    }
    const m = inSection ? new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(t) : null;
    if (m) return m[1];
  }
  return null;
}

// ── 1. Node.js ──

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node.js ${process.versions.node} 太旧了，需要 20 或更高版本：到 https://nodejs.org/zh-cn 下载“长期支持版”安装`);
  ok(`Node.js ${process.versions.node}`);
}

// ── 2. 依赖 ──

function runNpm(extra = []) {
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...extra], { cwd: root, stdio: 'inherit', shell: win });
  return r.status === 0;
}

function installDeps() {
  const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
  const hash = crypto.createHash('sha1').update(lock).digest('hex');
  const stamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
  if (stamp === hash && fs.existsSync(path.join(root, 'node_modules', 'mineflayer'))) {
    ok('依赖已安装');
    return;
  }
  console.log('↓ 安装依赖（第一次要一两分钟）…');
  if (!runNpm()) {
    warn(`连不上 npm 官方源，换国内镜像 ${NPM_MIRROR} 再试一次…`);
    if (!runNpm([`--registry=${NPM_MIRROR}`])) throw new Error('依赖没装上：请检查网络，或者稍后重新双击 start.bat');
  }
  fs.writeFileSync(stampPath, `${hash}\n`);
  ok('依赖安装完成');
}

// ── 3. Java ──

export function javaMajor(javaCmd) {
  const r = spawnSync(javaCmd, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (r.error) return null;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`);
  if (!m) return null;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

// 在 dir 下面（最多往下 depth 层）找 bin/java(.exe)
function findJavaUnder(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const exe = path.join(dir, 'bin', win ? 'java.exe' : 'java');
  if (fs.existsSync(exe)) out.push(exe);
  for (const e of entries) if (e.isDirectory() && e.name !== 'bin') findJavaUnder(path.join(dir, e.name), depth - 1, out);
}

function javaCandidates(configured) {
  const list = [];
  if (process.env.NEKO_JAVA) list.push(process.env.NEKO_JAVA);
  if (configured && configured !== 'java') list.push(configured);
  if (process.env.JAVA_HOME) list.push(path.join(process.env.JAVA_HOME, 'bin', win ? 'java.exe' : 'java'));
  list.push('java');
  if (win) {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const appdata = process.env.APPDATA ?? '';
    const local = process.env.LOCALAPPDATA ?? '';
    // 各家 Java 的安装目录（jdk-21、jre-17… 就在下一层）
    for (const n of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru']) findJavaUnder(path.join(pf, n), 2, list);
    // Minecraft 启动器自带的 Java（大多数玩家电脑上都有）：runtime/java-runtime-xxx/windows-x64/java-runtime-xxx/bin
    for (const r of [path.join(appdata, '.minecraft', 'runtime'), path.join(local, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'), path.join(pf86, 'Minecraft Launcher', 'runtime')]) {
      findJavaUnder(r, 4, list);
    }
  }
  return [...new Set(list)];
}

function askYes(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [Y/n] `, (a) => {
      rl.close();
      resolve(!/^n/i.test(a.trim()));
    });
  });
}

async function ensureJava() {
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  const configured = text ? getTomlValue(text, 'viaproxy', 'java') : null;
  let found = null;
  for (const c of javaCandidates(configured)) {
    const v = javaMajor(c);
    if (v && v >= JAVA_MIN) {
      found = { cmd: c, version: v };
      break;
    }
  }
  if (!found && win && spawnSync('where', ['winget'], { windowsHide: true }).status === 0) {
    warn(`没找到 Java ${JAVA_MIN} 以上的版本（ViaProxy 转换新版本服务器的协议要用）。`);
    if (await askYes('  要现在用 winget 自动安装 Eclipse Temurin 21（免费的 Java）吗？')) {
      spawnSync('winget', ['install', '-e', '--id', 'EclipseAdoptium.Temurin.21.JRE', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit' });
      for (const c of javaCandidates(configured)) {
        const v = javaMajor(c);
        if (v && v >= JAVA_MIN) {
          found = { cmd: c, version: v };
          break;
        }
      }
    }
  }
  if (!found) {
    warn(`找不到 Java ${JAVA_MIN}+。连 mineflayer 直接支持的服务器（1.21.x 以前）不影响；连 26.x 这类新版本要先装 Java：`);
    warn('  到 https://adoptium.net/zh-CN/ 下载 Temurin 21 安装，装好后重新双击 start.bat');
    return null;
  }
  ok(`Java ${found.version}（${found.cmd}）`);
  // 找到的不是配置里写的：写进 config.toml，免得每次都找
  if (text && found.cmd !== 'java' && found.cmd !== configured) {
    fs.writeFileSync(configPath, setTomlValue(text, 'viaproxy', 'java', found.cmd.replace(/\\/g, '/')));
  }
  return found;
}

// ── 4. ViaProxy ──

async function downloadViaProxy() {
  if (!UPDATE && fs.existsSync(jarPath)) {
    ok(`ViaProxy ${fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : ''}`.trim());
    return;
  }
  const headers = { 'User-Agent': 'njfu-neko-setup', Accept: 'application/vnd.github+json' };
  const res = await fetch('https://api.github.com/repos/ViaVersion/ViaProxy/releases/latest', { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GitHub API 请求失败：HTTP ${res.status}`);
  const release = await res.json();
  const asset = release.assets.find((a) => /^ViaProxy-[\d.]+\.jar$/.test(a.name));
  if (!asset) throw new Error(`最新版本 ${release.tag_name} 里没有找到 ViaProxy 的 jar 文件`);
  const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  if (current === release.tag_name && fs.existsSync(jarPath)) {
    ok(`ViaProxy ${current} 已是最新`);
    return;
  }
  console.log(`↓ 下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）…`);
  fs.mkdirSync(viaDir, { recursive: true });
  const tmp = `${jarPath}.part`;
  const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'njfu-neko-setup' }, signal: AbortSignal.timeout(600_000) });
  if (!dl.ok || !dl.body) throw new Error(`下载失败：HTTP ${dl.status}`);
  await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(tmp));
  const size = fs.statSync(tmp).size;
  if (size !== asset.size) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`文件大小不符（${size} ≠ ${asset.size}），请重试`);
  }
  fs.renameSync(tmp, jarPath);
  fs.writeFileSync(versionFile, `${release.tag_name}\n`);
  ok(`ViaProxy ${release.tag_name}`);
}

async function ensureViaProxy() {
  try {
    await downloadViaProxy();
  } catch (err) {
    warn(`ViaProxy 没下载成功：${err.message}`);
    warn('  连 26.x 这类新版本服务器才需要它。可以稍后重试，或者手动下载：');
    warn('  https://github.com/ViaVersion/ViaProxy/releases 下载最新的 ViaProxy-x.x.x.jar，');
    warn(`  改名成 ViaProxy.jar 放到 ${path.relative(root, viaDir)}${path.sep}`);
  }
}

// ── 5. 第一次运行：一问一答生成 config.toml ──

function prompt(rl, question, fallback = '') {
  return new Promise((resolve) => rl.question(`${question}${fallback ? ` [${fallback}]` : ''}：`, (a) => resolve(a.trim() || fallback)));
}

// 输入密钥时不在屏幕上显示
function promptSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted || /[\r\n]/.test(s)) process.stdout.write(muted ? '\n' : s);
    };
    rl.question(`${question}：`, (a) => {
      rl.close();
      resolve(a.trim());
    });
    muted = true;
  });
}

export function applyAnswers(template, a) {
  let t = template;
  t = setTomlValue(t, 'server', 'host', a.host);
  t = setTomlValue(t, 'server', 'port', a.port);
  t = setTomlValue(t, 'chat', 'owners', a.owners);
  t = setTomlValue(t, 'brain', 'mode', a.mode);
  if (a.mode === 'api' && a.key) t = setTomlValue(t, 'brain.api', 'api_key', a.key);
  if (a.mode === 'openai') {
    t = setTomlValue(t, 'brain.openai', 'provider', a.provider);
    if (a.key) t = setTomlValue(t, 'brain.openai', 'api_key', a.key);
    if (a.baseUrl) t = setTomlValue(t, 'brain.openai', 'base_url', a.baseUrl);
    if (a.model) t = setTomlValue(t, 'brain.openai', 'model', a.model);
  }
  return t;
}

async function wizard() {
  console.log('\n第一次运行，回答几个问题就能用（直接回车用方括号里的默认值，以后都能在 config.toml 里改）：\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = {};
  a.host = await prompt(rl, '1. 服务器地址（自己开的局域网世界填 127.0.0.1）', '127.0.0.1');
  for (;;) {
    const p = Number(await prompt(rl, '2. 端口（局域网开放时游戏里会显示，例如 25565）', '25565'));
    if (Number.isInteger(p) && p > 0 && p < 65536) {
      a.port = p;
      break;
    }
    console.log('   端口要填 1～65535 的数字');
  }
  const owners = await prompt(rl, '3. 你的游戏名（她的主人；几个人就用逗号隔开，不填＝所有人都是主人）');
  a.owners = owners.split(/[,，\s]+/).filter(Boolean);
  console.log('4. 选她的大脑（能听懂闲聊、接临时的活；不接大脑也能用快捷命令和自动行为）：');
  console.log('   1) Claude API        她自己思考，需要 Anthropic 的 API Key，按用量付费');
  console.log('   2) GPT / DeepSeek 等  她自己思考，需要对应服务商的 API Key，按用量付费');
  console.log('   3) Claude Code       由你开着的 Claude Code 会话当大脑，不要密钥（用 Claude 订阅）');
  console.log('   4) 先不接大脑');
  const choice = await prompt(rl, '   选哪个', '4');
  a.mode = { 1: 'api', 2: 'openai', 3: 'claude-code' }[choice] ?? 'none';
  if (a.mode === 'openai') {
    const p = await prompt(rl, '   服务商：1) OpenAI（GPT）2) DeepSeek 3) 其他（通义千问、Kimi、本地 Ollama 等）', '2');
    a.provider = { 1: 'openai', 3: 'custom' }[p] ?? 'deepseek';
    if (a.provider === 'custom') {
      a.baseUrl = await prompt(rl, '   接口地址（base_url，例如 http://127.0.0.1:11434/v1）');
      a.model = await prompt(rl, '   模型名（例如 qwen-plus、llama3.1）');
    }
  }
  rl.close();
  if (a.mode === 'api' || a.mode === 'openai') {
    const env = a.mode === 'api' ? 'ANTHROPIC_API_KEY' : a.provider === 'openai' ? 'OPENAI_API_KEY' : a.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : null;
    const later = env ? `不填＝稍后用环境变量 ${env}` : '本机模型可以不填';
    a.key = await promptSecret(`   API Key（输入时不显示；${later}）`);
  }
  fs.writeFileSync(configPath, applyAnswers(fs.readFileSync(templatePath, 'utf8'), a));
  ok('已生成 config.toml（更多设置用记事本打开它，每一项都有中文注释）');
  if (a.mode === 'claude-code') console.log('  Claude Code 模式：在这个文件夹里打开 Claude Code，对它说“按 CLAUDE.md 启动猫娘并接管”（见 README）');
}

async function ensureConfig() {
  if (fs.existsSync(configPath)) {
    ok('config.toml');
    return;
  }
  if (WIZARD) {
    await wizard();
    return;
  }
  fs.copyFileSync(templatePath, configPath);
  ok('已生成 config.toml（用记事本打开，按注释修改服务器端口、大脑模式等）');
}

async function main() {
  console.log('NJFU智慧猫娘 · 检查环境\n');
  checkNode();
  installDeps();
  await ensureConfig();
  await ensureJava();
  await ensureViaProxy();
  fs.mkdirSync(path.join(root, 'runtime', 'logs'), { recursive: true });
  console.log('\n准备完成。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  });
}
