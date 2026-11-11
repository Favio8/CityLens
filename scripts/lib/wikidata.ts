/** 构建期脚本共用的 Wikidata 访问与解析工具。 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'CityLens/0.1 (build-time data pipeline; local development)';
const libDir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(libDir, '../.cache/wikidata');
/** 设为 1 可强制重新联网查询，忽略本地缓存。 */
const REFRESH_CACHE = process.env.REFRESH_WIKIDATA === '1';

function cachePath(query: string): string {
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 24);
  return resolve(CACHE_DIR, `${hash}.json`);
}

export interface Binding {
  [key: string]: { value: string; type: string } | undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带磁盘缓存的 SPARQL 查询。
 * 查询结果按 query 哈希缓存到 scripts/.cache/wikidata，默认优先读缓存，
 * 这样断网或 Wikidata 限流时仍能离线重建；REFRESH_WIKIDATA=1 可强制刷新。
 * 失败时抛出真实错误（绝不伪造数据）。
 */
export async function sparql(
  query: string,
  retries = 2,
  timeoutMs = 60000,
): Promise<Binding[]> {
  const path = cachePath(query);
  if (!REFRESH_CACHE) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as { bindings: Binding[] };
      if (Array.isArray(cached.bindings)) return cached.bindings;
    } catch {
      /* 无缓存或缓存损坏，继续联网 */
    }
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(WIKIDATA_ENDPOINT, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/sparql-results+json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ query, format: 'json' }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { results: { bindings: Binding[] } };
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            endpoint: WIKIDATA_ENDPOINT,
            fetchedAt: new Date().toISOString(),
            queryPreview: query.replace(/\s+/g, ' ').slice(0, 160),
            bindings: json.results.bindings,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      return json.results.bindings;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(2000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Wikidata 查询失败：${(lastError as Error).message}`);
}

export function parsePoint(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const m = /Point\(([-\d.]+)\s+([-\d.]+)\)/.exec(value);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return [lng, lat];
}

export function qidFromUri(uri: string | undefined): string {
  if (!uri) return '';
  return uri.split('/').pop() ?? '';
}

/**
 * 解析 Wikibase 时间字符串，如 "-0202-01-01T00:00:00Z" → -202。
 * 返回 null 表示无法解析，调用方必须填“待考”。
 */
export function parseWikibaseYear(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^([+-]?)(\d+)-/.exec(value);
  if (!m) return null;
  const year = Number(m[2]);
  if (!Number.isFinite(year) || year === 0) return null;
  return m[1] === '-' ? -year : year;
}

export interface DictionaryCity {
  cityId: string;
  standardName: string;
  province: string;
  wikidataQid: string;
  adminLevel: string;
  pinyin: string;
  englishName: string;
  center: [number, number];
  summary: string;
  hotRank: number | null;
  aliases: Array<{ key: string; display: string; matchType: string; hint?: string }>;
}

export interface DictionaryFile {
  generatedAt: string;
  cities: DictionaryCity[];
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadDictionary(): DictionaryFile {
  return JSON.parse(
    readFileSync(resolve(here, '../../server/data/city_dictionary.json'), 'utf8'),
  ) as DictionaryFile;
}

/** 生成“位于该市行政范围内”的 1–3 跳 UNION 子句。 */
export function withinCity(entityVar: string, cityQid: string): string {
  return `{
    ${entityVar} wdt:P131 wd:${cityQid} .
  } UNION {
    ${entityVar} wdt:P131 ?d1 . ?d1 wdt:P131 wd:${cityQid} .
  } UNION {
    ${entityVar} wdt:P131 ?d1 . ?d1 wdt:P131 ?d2 . ?d2 wdt:P131 wd:${cityQid} .
  }`;
}

export function formatYear(year: number | null): string {
  if (year === null) return '待考';
  return year < 0 ? `公元前${Math.abs(year)}年` : `${year}年`;
}
