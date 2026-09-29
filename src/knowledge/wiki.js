// 查询 Minecraft 中文 Wiki（zh.minecraft.wiki）的官方 MediaWiki 接口：先搜索词条，再取正文摘要。
// 只使用 api.php（Wiki 提供给程序用的接口），带缓存和请求间隔，不做网页抓取。
import { getLog } from '../log.js';

const log = getLog('知识');
const API = 'https://zh.minecraft.wiki/api.php';
const HEADERS = { 'User-Agent': 'NJFU-Neko/0.1 (Minecraft companion bot; https://github.com/)' };
const cache = new Map();
let lastRequest = 0;

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  if (cache.has(url)) return cache.get(url);
  const wait = 500 - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Wiki 返回 HTTP ${res.status}`);
  const data = await res.json();
  cache.set(url, data);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

// 返回 { title, url, text }；text 为摘要（full=true 时为更长的正文，最多 maxChars 字）。
export async function wikiLookup(query, { full = false, maxChars = 1800 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('要查什么？');
  const search = await api({ action: 'query', list: 'search', srsearch: q, srlimit: '5', srnamespace: '0' });
  const hits = search?.query?.search ?? [];
  if (!hits.length) return { title: null, url: null, text: `Wiki 上没有找到「${q}」`, others: [] };
  const title = hits[0].title;
  const page = await api({
    action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: title,
    ...(full ? { exchars: String(Math.min(maxChars, 12000)) } : { exintro: '1' }),
  });
  const extract = page?.query?.pages?.[0]?.extract?.trim() ?? '';
  const text = extract.length > maxChars ? `${extract.slice(0, maxChars)}…` : extract;
  log.fileOnly('info', `查询 Wiki「${q}」→ ${title}（${text.length} 字）`);
  return {
    title,
    url: `https://zh.minecraft.wiki/w/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    text: text || '（这个词条没有文字摘要）',
    others: hits.slice(1).map((h) => h.title),
  };
}
