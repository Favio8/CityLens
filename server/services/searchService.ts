/**
 * 联网检索服务（Tavily）。
 *
 * 定位：只负责「发现线索」——返回标题、URL、摘要与可选综述；
 * 任何进入档案的事实仍须经本地校验或官方页面逐字核验。
 * 结果按查询哈希落盘缓存，避免同一城市重复消耗额度。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config';
import { getActiveSearchConfig } from './searchSettings';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number | null;
}

export interface SearchOptions {
  maxResults?: number;
  includeDomains?: string[];
  includeAnswer?: boolean;
  searchDepth?: 'basic' | 'advanced';
}

export interface SearchResponse {
  query: string;
  answer: string | null;
  results: SearchResult[];
  cached: boolean;
}

interface CacheEntry {
  query: string;
  answer: string | null;
  results: SearchResult[];
  fetchedAt: string;
}

const CACHE_DIR = resolve(config.dataDir, 'search_cache');
const USAGE_FILE = resolve(config.dataDir, 'search_usage.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const negativeCache = new Map<string, number>();

function cacheKey(query: string, options: SearchOptions): string {
  return createHash('sha1')
    .update(JSON.stringify([query, options.includeDomains ?? [], options.searchDepth ?? 'basic']))
    .digest('hex');
}

function readCache(key: string): CacheEntry | null {
  const path = resolve(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
    if (Date.now() - Date.parse(entry.fetchedAt) > TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(key: string, entry: CacheEntry): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(resolve(CACHE_DIR, `${key}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 每日额度保护：只统计真正发出的请求。 */
export function searchUsage(): { date: string; count: number; limit: number } {
  try {
    const usage = JSON.parse(readFileSync(USAGE_FILE, 'utf8')) as { date?: string; count?: number };
    if (usage.date === today()) {
      return { date: usage.date, count: usage.count ?? 0, limit: getActiveSearchConfig().dailyLimit };
    }
  } catch {
    /* 无记录 */
  }
  return { date: today(), count: 0, limit: getActiveSearchConfig().dailyLimit };
}

function bumpUsage(): boolean {
  const usage = searchUsage();
  if (usage.count >= usage.limit) return false;
  try {
    mkdirSync(resolve(USAGE_FILE, '..'), { recursive: true });
    writeFileSync(
      USAGE_FILE,
      `${JSON.stringify({ date: usage.date, count: usage.count + 1 }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* 统计失败不阻塞检索 */
  }
  return true;
}

function sanitizeResults(payload: unknown): SearchResult[] {
  const list = (payload as { results?: unknown }).results;
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const url = typeof record.url === 'string' ? record.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) return [];
      return [
        {
          title: typeof record.title === 'string' ? record.title.trim() : url,
          url,
          content:
            typeof record.content === 'string'
              ? record.content.trim()
              : typeof record.snippet === 'string'
                ? record.snippet.trim()
                : '',
          score: typeof record.score === 'number' ? record.score : null,
        },
      ];
    })
    .slice(0, 12);
}

/** 联网检索；未配置 Key、超限或失败时返回空结果，绝不阻断生成。 */
export async function searchWeb(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const trimmed = query.trim();
  const active = getActiveSearchConfig();
  if (!trimmed || !active.apiKey) {
    return { query: trimmed, answer: null, results: [], cached: false };
  }
  const key = cacheKey(trimmed, options);
  const cached = readCache(key);
  if (cached) {
    return { query: trimmed, answer: cached.answer, results: cached.results, cached: true };
  }
  const negativeUntil = negativeCache.get(key) ?? 0;
  if (negativeUntil > Date.now()) {
    return { query: trimmed, answer: null, results: [], cached: false };
  }
  if (!bumpUsage()) {
    console.warn('[search] 今日检索额度已用尽，跳过联网检索');
    return { query: trimmed, answer: null, results: [], cached: false };
  }

  try {
    const response = await fetch(`${config.search.baseUrl}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${active.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: trimmed,
        max_results: Math.min(options.maxResults ?? 6, 10),
        search_depth: options.searchDepth ?? 'basic',
        include_answer: options.includeAnswer ?? false,
        ...(options.includeDomains && options.includeDomains.length > 0
          ? { include_domains: options.includeDomains }
          : {}),
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      negativeCache.set(key, Date.now() + NEGATIVE_TTL_MS);
      console.warn(`[search] Tavily 返回 ${response.status}，本查询 10 分钟内不再重试`);
      return { query: trimmed, answer: null, results: [], cached: false };
    }
    const payload = (await response.json()) as { answer?: unknown };
    const entry: CacheEntry = {
      query: trimmed,
      answer: typeof payload.answer === 'string' ? payload.answer.trim() : null,
      results: sanitizeResults(payload),
      fetchedAt: new Date().toISOString(),
    };
    writeCache(key, entry);
    return { query: trimmed, answer: entry.answer, results: entry.results, cached: false };
  } catch (error) {
    negativeCache.set(key, Date.now() + NEGATIVE_TTL_MS);
    console.warn(`[search] 检索失败：${(error as Error).message}`);
    return { query: trimmed, answer: null, results: [], cached: false };
  }
}

/** 测试用：清空内存负缓存。 */
export function resetSearchCache(): void {
  negativeCache.clear();
}

function decodeBody(buffer: ArrayBuffer, contentType: string | null): string {
  const head = new TextDecoder('utf-8').decode(buffer.slice(0, 4096));
  const charset =
    /charset=([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

const ALLOWED_PAGE_HOSTS = [
  '.gov.cn',
  'wikipedia.org',
  '.wikisource.org',
  '.gushiwen.cn',
  '.so.gushiwen.cn',
];

function isAllowedPage(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return false;
  }
  return ALLOWED_PAGE_HOSTS.some((suffix) => host.endsWith(suffix));
}

/** 抓取允许站点的标题与正文纯文本，用于统计公报与诗词原文核验。 */
export async function fetchPageDocument(
  url: string,
  timeoutMs = 20000,
): Promise<{ title: string; text: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isAllowedPage(parsed)) return null;
  try {
    const response = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'CityLens/0.1 (local research; contact: local)' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) return null;
    // 重定向后的最终地址也必须仍在允许列表内。
    try {
      if (!isAllowedPage(new URL(response.url))) return null;
    } catch {
      return null;
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 4 * 1024 * 1024) return null;
    const html = decodeBody(buffer, response.headers.get('content-type'));
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300_000);
    return {
      title: title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      text,
    };
  } catch {
    return null;
  }
}

/** 只要正文时使用；标题核验请用 fetchPageDocument。 */
export async function fetchPageText(url: string, timeoutMs = 20000): Promise<string | null> {
  const document = await fetchPageDocument(url, timeoutMs);
  return document?.text ?? null;
}
