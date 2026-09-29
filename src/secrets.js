// 防泄漏：登记所有密钥，任何写进日志、事件、聊天、控制接口回复的文字都先经过 redact() 打码。

const secrets = new Set();

// Anthropic API Key、Bearer 令牌、形如 key=xxx 的赋值。
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(api[_-]?key|x-api-key|auth[_-]?token|access[_-]?token|x-neko-token)(["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
];

export function mask(value) {
  const s = String(value);
  if (s.length <= 12) return '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function addSecret(value) {
  if (value && String(value).length >= 8) secrets.add(String(value));
}

export function redact(input) {
  let text = typeof input === 'string' ? input : String(input);
  for (const secret of secrets) {
    if (text.includes(secret)) text = text.split(secret).join(mask(secret));
  }
  text = text.replace(PATTERNS[0], (m) => mask(m));
  text = text.replace(PATTERNS[1], (m) => `Bearer ${mask(m.slice(7))}`);
  text = text.replace(PATTERNS[2], (_, key, sep, value) => `${key}${sep}${mask(value)}`);
  return text;
}

// 深拷贝一个可序列化对象并打码其中所有字符串。
export function redactDeep(value) {
  return JSON.parse(redact(JSON.stringify(value)));
}

export function looksSecret(text) {
  const s = String(text);
  for (const secret of secrets) if (s.includes(secret)) return true;
  return /sk-ant-[A-Za-z0-9_-]{8,}/.test(s);
}

// 给子进程（ViaProxy）用的环境变量：去掉所有看起来像密钥的变量。
export function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/ANTHROPIC|API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}
