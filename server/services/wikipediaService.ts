/**
 * 维基百科城市条目读取：只取摘要与正文纯文本，作为叙事与检索的上下文。
 * 所有内容都保留原始页面 URL，写入档案来源。
 *
 * 国内网络访问 zh.wikipedia.org 通常需要代理；这里读取 HTTPS_PROXY/HTTP_PROXY，
 * 有代理时通过 undici ProxyAgent 直连，避免依赖 Node 启动参数。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export interface WikipediaCityInfo {
  title: string;
  url: string;
  summary: string;
  extract: string;
}

const API_BASE = 'https://zh.wikipedia.org';
const HEADERS = {
  'User-Agent': 'CityLens/0.1 (local research; contact: local)',
  Accept: 'application/json',
};
const PROXY_URL = process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim() || '';
const DISPATCHER = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

interface SummaryPayload {
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

async function getJson<T>(url: string, timeoutMs = 15000): Promise<T | null> {
  try {
    const response = await undiciFetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
      ...(DISPATCHER ? { dispatcher: DISPATCHER } : {}),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function searchTitle(cityName: string, province: string): Promise<string | null> {
  const query = `${cityName} ${province}`.trim();
  const url =
    `${API_BASE}/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=` +
    encodeURIComponent(query);
  const payload = await getJson<{ query?: { search?: Array<{ title?: string }> } }>(url);
  const hits = payload?.query?.search ?? [];
  const exact = hits.find((hit) => hit.title === cityName);
  return exact?.title ?? hits[0]?.title ?? null;
}

async function fetchExtract(title: string): Promise<string> {
  const url =
    `${API_BASE}/w/api.php?action=query&format=json&explaintext=1&redirects=1&prop=extracts&titles=` +
    encodeURIComponent(title);
  const payload = await getJson<{
    query?: { pages?: Record<string, { extract?: string }> };
  }>(url);
  const pages = payload?.query?.pages ?? {};
  for (const page of Object.values(pages)) {
    if (page.extract?.trim()) return page.extract.trim().slice(0, 8000);
  }
  return '';
}

export async function fetchWikipediaCity(
  cityName: string,
  province: string,
): Promise<WikipediaCityInfo | null> {
  for (const title of [cityName, await searchTitle(cityName, province)]) {
    if (!title) continue;
    const summary = await getJson<SummaryPayload>(
      `${API_BASE}/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    );
    if (!summary?.extract?.trim()) continue;
    const extract = await fetchExtract(summary.title ?? title);
    return {
      title: summary.title ?? title,
      url:
        summary.content_urls?.desktop?.page ??
        `${API_BASE}/wiki/${encodeURIComponent(title)}`,
      summary: summary.extract.trim(),
      extract,
    };
  }
  return null;
}

interface CategoryPayload {
  query?: { categorymembers?: Array<{ title?: string }> };
}

interface PagePropsPayload {
  query?: {
    pages?: Record<string, { title?: string; pageprops?: { wikibase_item?: string } }>;
  };
}

/** 读取「XX市人 / XX人」分类成员；用于补充本地 Wikidata 未覆盖的历史人物。 */
export async function fetchWikipediaCategoryTitles(cityName: string): Promise<string[]> {
  for (const category of [`${cityName}市人`, `${cityName}人`]) {
    const payload = await getJson<CategoryPayload>(
      `${API_BASE}/w/api.php?action=query&list=categorymembers&format=json&cmlimit=100&cmtitle=` +
        encodeURIComponent(`Category:${category}`),
    );
    const titles = (payload?.query?.categorymembers ?? [])
      .map((item) => item.title?.trim() ?? '')
      .filter(Boolean);
    if (titles.length > 0) return titles;
  }
  return [];
}

/** 把中文维基条目标题解析为 Wikidata QID，每批 50 条。 */
export async function resolveWikibaseItems(titles: string[]): Promise<string[]> {
  const qids: string[] = [];
  for (let index = 0; index < titles.length; index += 50) {
    const batch = titles.slice(index, index + 50);
    const payload = await getJson<PagePropsPayload>(
      `${API_BASE}/w/api.php?action=query&format=json&prop=pageprops&ppprop=wikibase_item&titles=` +
        encodeURIComponent(batch.join('|')),
    );
    for (const page of Object.values(payload?.query?.pages ?? {})) {
      const qid = page.pageprops?.wikibase_item;
      if (qid && /^Q\d+$/.test(qid)) qids.push(qid);
    }
  }
  return [...new Set(qids)];
}
