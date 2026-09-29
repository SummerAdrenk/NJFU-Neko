export function abortError(signal) {
  const reason = signal?.reason;
  const err = new Error(typeof reason === 'string' ? reason : reason?.message ?? '已取消');
  err.name = 'AbortError';
  return err;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function withTimeout(promise, ms, message = '超时') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.name = 'Timeout';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// promise 在 signal 取消时立刻拒绝（原 promise 仍会在后台结束）。
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function truncate(value, n) {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const fmtPos = (p) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;

export const round1 = (n) => Math.round(n * 10) / 10;

// 把 Minecraft 文本组件（JSON 字符串或对象）拍平成纯文本。
export function componentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s.startsWith('{') && !s.startsWith('[') && !s.startsWith('"')) return value;
    try {
      return componentText(JSON.parse(s));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(componentText).join('');
  if (typeof value === 'object') {
    let out = '';
    if (typeof value.text === 'string') out += value.text;
    else if (value.text != null) out += componentText(value.text);
    if (value.translate) {
      const args = (value.with ?? []).map(componentText);
      out += args.length ? `${value.translate}(${args.join(', ')})` : value.translate;
    }
    if (value[''] != null) out += componentText(value['']);
    if (Array.isArray(value.extra)) out += value.extra.map(componentText).join('');
    return out;
  }
  return String(value);
}

// 去掉会被服务器判为非法的字符（§、控制字符），压缩空白。
export function sanitizeChat(text) {
  return String(text)
    .replace(/§/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 把一段话切成不超过 max 个字符的行，尽量在标点处断开。
export function splitLines(text, max) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let rest = sanitizeChat(raw);
    while (rest.length > max) {
      let cut = -1;
      for (let i = max; i > max * 0.5; i--) {
        if ('。！？!?；;，,、 ～~）)'.includes(rest[i - 1])) {
          cut = i;
          break;
        }
      }
      if (cut < 0) cut = max;
      lines.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) lines.push(rest);
  }
  return lines;
}
