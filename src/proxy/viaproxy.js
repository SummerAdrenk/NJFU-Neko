// 启动 / 管理 ViaProxy：把机器人使用的旧协议（如 26.1）翻译成服务器的新协议（如 26.2）。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { LOG_DIR, ROOT, RUNTIME, TMP_DIR } from '../paths.js';
import { getLog } from '../log.js';
import { childEnv } from '../secrets.js';
import { sleep } from '../util.js';

const log = getLog('代理');

const PID_FILE = path.join(RUNTIME, 'viaproxy.pid');
// 写进 java 命令行的标记，用来确认残留进程确实是本项目启动的 ViaProxy。
const MARKER = `-Dnjfu.neko.root=${ROOT}`;

function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// “java” 可能只是个转发程序（例如 Windows 上 Oracle 的 javapath\java.exe），它会再启动真正的 java，
// 结束转发程序并不会结束 ViaProxy。所以先问出真正的 java.home，直接启动真正的 java。
const resolvedJava = new Map();
function resolveJava(java) {
  if (resolvedJava.has(java)) return resolvedJava.get(java);
  let exe = java;
  const r = spawnSync(java, ['-XshowSettings:properties', '-version'], { encoding: 'utf8', windowsHide: true });
  const home = /java\.home = (.+)/.exec(`${r.stderr ?? ''}${r.stdout ?? ''}`)?.[1]?.trim();
  if (home) {
    const candidate = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(candidate)) exe = candidate;
  }
  resolvedJava.set(java, exe);
  return exe;
}

// 找出命令行里带本项目标记的 ViaProxy 进程（上次异常退出时留下的）。
function findOurProxies() {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" | Where-Object { $_.CommandLine -like '*ViaProxy*' -and $_.CommandLine -like '*${MARKER}*' } | ForEach-Object { $_.ProcessId }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    return (r.stdout ?? '').split(/\s+/).map(Number).filter((n) => n > 0);
  }
  const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').filter((l) => l.includes('ViaProxy') && l.includes(MARKER)).map((l) => Number(l.trim().split(/\s+/)[0])).filter((n) => n > 0);
}

// 结束进程及其子进程。
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(pid);
    } catch {
      // 已经退出
    }
  }
}

function killStale() {
  for (const pid of findOurProxies()) {
    killTree(pid);
    log.info(`已结束上次残留的 ViaProxy 进程（PID ${pid}）`);
  }
  fs.rmSync(PID_FILE, { force: true });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

export async function startViaProxy({ java, jar, bindPort, targetHost, targetPort, targetVersion, authMethod }) {
  if (!fs.existsSync(jar)) throw new Error(`找不到 ${path.relative(ROOT, jar)}，请先运行 npm run setup`);
  killStale();

  let port = bindPort;
  while (!(await portFree(port))) {
    if (port - bindPort >= 20) throw new Error(`端口 ${bindPort}～${port} 都被占用了，请修改 viaproxy.bind_port`);
    port += 1;
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const args = [
    // Windows 上 Java 的 Unix 域套接字临时目录路径过长会启动失败，指定一个短路径。
    `-Djdk.net.unixdomain.tmpdir=${TMP_DIR}`,
    MARKER,
    '-jar', path.basename(jar), 'cli',
    '--target-address', `${targetHost}:${targetPort}`,
    '--bind-address', `127.0.0.1:${port}`,
    '--auth-method', authMethod || 'NONE',
  ];
  if (targetVersion) args.push('--target-version', targetVersion);

  const logFile = fs.createWriteStream(path.join(LOG_DIR, 'viaproxy.log'), { flags: 'w' });
  const javaExe = resolveJava(java);
  log.info(`启动 ViaProxy：${javaExe} ${args.join(' ')}`);
  // 子进程拿到的环境变量里去掉了 API Key 等密钥。
  const child = spawn(javaExe, args, { cwd: path.dirname(jar), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }));

  let exited = null;
  const recent = [];
  const onData = (chunk) => {
    const text = stripAnsi(chunk.toString('utf8'));
    logFile.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      recent.push(line.trim());
      if (recent.length > 8) recent.shift();
      if (/\/(WARN|ERROR)\]/.test(line)) log.fileOnly('warn', `ViaProxy：${line.trim()}`);
      else if (/Connected|Disconnect|kick|Failed|Exception/i.test(line)) log.fileOnly('debug', `ViaProxy：${line.trim()}`);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('exit', (code, signal) => {
    exited = code ?? -1;
    logFile.end();
    fs.rmSync(PID_FILE, { force: true });
    log.info(`ViaProxy 已退出（退出码 ${code ?? '无'}${signal ? `，信号 ${signal}` : ''}）`);
  });

  const spawnError = new Promise((_, reject) => child.once('error', (err) => {
    exited = -1;
    reject(err.code === 'ENOENT'
      ? new Error(`找不到 Java（${java}）。请安装 Java 17 以上，或在 config.toml 的 viaproxy.java 填写 java.exe 的完整路径`)
      : err);
  }));
  const ready = (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (exited !== null) {
        throw new Error(`ViaProxy 启动失败（退出码 ${exited}）：${recent.slice(-3).join(' | ')}\n详见 runtime/logs/viaproxy.log`);
      }
      if (await canConnect(port)) return;
      await sleep(300);
    }
    throw new Error('ViaProxy 60 秒内没有启动完成，详见 runtime/logs/viaproxy.log');
  })();

  // 两个 promise 只用第一个结果，另一个的迟到拒绝不应变成未处理的异常。
  ready.catch(() => {});
  spawnError.catch(() => {});
  try {
    await Promise.race([ready, spawnError]);
  } catch (err) {
    killTree(child.pid);
    throw err;
  }

  const handle = {
    port,
    host: '127.0.0.1',
    targetKey: `${targetHost}:${targetPort}`,
    get alive() {
      return exited === null;
    },
    stop() {
      if (exited === null && child.pid) killTree(child.pid);
    },
  };
  process.once('exit', () => handle.stop());
  return handle;
}
