#!/usr/bin/env node
// 一次性准备：检查 Java、下载 ViaProxy、生成 config.toml。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viaDir = path.join(root, 'runtime', 'viaproxy');
const jarPath = path.join(viaDir, 'ViaProxy.jar');
const versionFile = path.join(viaDir, 'version.txt');
const configPath = path.join(root, 'config.toml');
const force = process.argv.includes('--force');

// 已有 config.toml 时，用里面配置的 java 路径做检查。
function configuredJava() {
  try {
    const m = /^\s*java\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(configPath, 'utf8'));
    return m?.[1];
  } catch {
    return null;
  }
}

function javaMajor(javaCmd) {
  const r = spawnSync(javaCmd, ['-version'], { encoding: 'utf8' });
  if (r.error) return null;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`);
  if (!m) return null;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

async function downloadViaProxy() {
  const headers = { 'User-Agent': 'njfu-neko-setup', Accept: 'application/vnd.github+json' };
  const res = await fetch('https://api.github.com/repos/ViaVersion/ViaProxy/releases/latest', { headers });
  if (!res.ok) throw new Error(`GitHub API 请求失败：HTTP ${res.status}`);
  const release = await res.json();
  const asset = release.assets.find((a) => /^ViaProxy-[\d.]+\.jar$/.test(a.name));
  if (!asset) throw new Error(`最新版本 ${release.tag_name} 里没有找到 ViaProxy 的 jar 文件`);

  const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  if (!force && current === release.tag_name && fs.existsSync(jarPath)) {
    console.log(`✓ ViaProxy ${current} 已是最新`);
    return;
  }

  console.log(`↓ 下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）...`);
  fs.mkdirSync(viaDir, { recursive: true });
  const tmp = `${jarPath}.part`;
  const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'njfu-neko-setup' } });
  if (!dl.ok || !dl.body) throw new Error(`下载失败：HTTP ${dl.status}`);
  await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(tmp));
  const size = fs.statSync(tmp).size;
  if (size !== asset.size) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`文件大小不符（${size} ≠ ${asset.size}），已删除，请重试`);
  }
  fs.renameSync(tmp, jarPath);
  fs.writeFileSync(versionFile, `${release.tag_name}\n`);
  console.log(`✓ ViaProxy ${release.tag_name} → ${path.relative(root, jarPath)}`);
}

async function main() {
  console.log('NJFU智慧猫娘 · 安装准备\n');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`${nodeMajor >= 20 ? '✓' : '✗'} Node.js ${process.versions.node}${nodeMajor >= 20 ? '' : '（需要 20 或更高版本）'}`);

  const java = process.env.NEKO_JAVA || configuredJava() || 'java';
  const jv = javaMajor(java);
  if (jv === null) console.log('✗ 找不到 Java。ViaProxy 需要 Java 17 或更高版本；装好后可用环境变量 NEKO_JAVA 指定 java.exe 路径');
  else console.log(`${jv >= 17 ? '✓' : '✗'} Java ${jv}${jv >= 17 ? '' : '（ViaProxy 需要 17 或更高版本）'}`);

  await downloadViaProxy();

  if (!fs.existsSync(configPath)) {
    fs.copyFileSync(path.join(root, 'config.example.toml'), configPath);
    console.log('✓ 已生成 config.toml（用记事本打开，按注释修改服务器地址、大脑模式等）');
  } else {
    console.log('✓ config.toml 已存在，保持不变');
  }
  fs.mkdirSync(path.join(root, 'runtime', 'logs'), { recursive: true });
  console.log('\n准备完成。运行 npm start（或双击 start.bat）启动。');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
