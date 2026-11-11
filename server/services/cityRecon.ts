/**
 * 城市侦察：新城市首次生成前，按需汇总公开来源。
 *
 * 数据来源：
 * - 维基百科摘要与正文（叙事上下文）
 * - Wikidata 城市实体（人口历史、面积）
 * - Tavily 联网检索（发现线索；只作上下文与页面定位）
 * - Open-Meteo ERA5（任意城市气候基线）
 * - 官方统计公报页面（GDP / 常住人口，逐字提取，提取不到保持 null）
 *
 * 所有结果写入 server/data/recon/<cityId>.json，后续生成直接复用。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceRef, SourceType } from '../../shared/schema';
import { config } from '../config';
import type { CityBrief } from '../db/cityRepo';
import { cityQid } from './cityFactSnapshot';
import { fetchClimateMonthly, type ClimateMonth } from './climateService';
import { fetchPageDocument, searchWeb, type SearchResult } from './searchService';
import { fetchWikidataCityFacts, type WikidataCityFacts } from './wikidataEntityService';
import { fetchWikipediaCity, type WikipediaCityInfo } from './wikipediaService';

export interface ReconStat {
  year: number;
  value: number;
  url: string;
  evidence: string;
}

export interface ReconSearch {
  query: string;
  answer: string | null;
  results: SearchResult[];
}

export interface CityRecon {
  cityId: string;
  cityName: string;
  generatedAt: string;
  wikipedia: WikipediaCityInfo | null;
  wikidata: WikidataCityFacts | null;
  searches: ReconSearch[];
  stats: {
    gdp: ReconStat | null;
    pop: ReconStat | null;
    attempts: string[];
  };
  climate: { period: string; station: string; monthly: ClimateMonth[] } | null;
  sources: SourceRef[];
}

interface ReconFile extends CityRecon {
  version: 1;
}

const RECON_DIR = resolve(config.dataDir, 'recon');
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const memory = new Map<string, CityRecon>();
const inflight = new Map<string, Promise<CityRecon | null>>();
const failedAt = new Map<string, number>();
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

function sourceId(prefix: string, key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 10);
  return `S-${prefix}-${hash}`;
}

function source(
  id: string,
  type: SourceType,
  title: string,
  url: string | undefined,
  retrievedAt: string,
): SourceRef {
  return { id, type, title, ...(url ? { url } : {}), retrievedAt };
}

function isGovUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.gov.cn');
  } catch {
    return false;
  }
}

function evidenceAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  return text.slice(start, Math.min(text.length, index + length + 60)).replace(/\s+/g, ' ').trim();
}

/** 从官方页面正文提取 GDP / 常住人口；只接受上下文明确的数字。 */
export function extractStatsFromText(
  text: string,
  url: string,
  yearOverride?: number,
): {
  gdp: ReconStat | null;
  pop: ReconStat | null;
} {
  const flat = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
  const yearMatch = /20(2[0-9])年/.exec(flat);
  const year = yearMatch ? Number(`20${yearMatch[1]}`) : 0;
  const fallbackYear = new Date().getFullYear();
  const statYear =
    yearOverride && yearOverride >= 2021 && yearOverride <= fallbackYear
      ? yearOverride
      : year >= 2021 && year <= fallbackYear
        ? year
        : fallbackYear;

  const gdpMatch = /(?:地区生产总值|GDP)[^。；]{0,60}?([0-9]{4,6}(?:\.[0-9]{1,2})?)\s*亿元/.exec(flat);
  const popMatch = /(?:年末)?常住人口[^。；]{0,60}?([0-9]{1,4}(?:\.[0-9]{1,2})?)\s*万人/.exec(flat);

  const gdpValue = gdpMatch ? Number(gdpMatch[1]) : NaN;
  const popValue = popMatch ? Number(popMatch[1]) : NaN;

  return {
    gdp:
      Number.isFinite(gdpValue) && gdpValue >= 100 && gdpValue <= 100000
        ? {
            year: statYear,
            value: gdpValue,
            url,
            evidence: evidenceAround(flat, gdpMatch!.index, gdpMatch![0].length),
          }
        : null,
    pop:
      Number.isFinite(popValue) && popValue >= 10 && popValue <= 4000
        ? {
            year: statYear,
            value: popValue,
            url,
            evidence: evidenceAround(flat, popMatch!.index, popMatch![0].length),
          }
        : null,
  };
}

function pickStatYear(result: SearchResult): number {
  const match = /20(2[0-9])年/.exec(`${result.title} ${result.content}`);
  return match ? Number(`20${match[1]}`) : new Date().getFullYear();
}

/** 只接受以本城为主体的统计公报，排除区县、街道公报。 */
export function isCityLevelBulletin(title: string, cityName: string): boolean {
  const flat = title.replace(/\s+/g, '');
  if (!flat.includes(cityName)) return false;
  if (!/统计公报|国民经济和社会发展/.test(flat)) return false;
  const district = new RegExp(`${cityName}市?[\\u4e00-\\u9fa5]{1,4}(区|县)`);
  return !district.test(flat);
}

async function extractStats(
  results: SearchResult[],
  cityName: string,
): Promise<{
  gdp: ReconStat | null;
  pop: ReconStat | null;
  attempts: string[];
}> {
  const attempts: string[] = [];
  const govPages = results
    .filter((result) => isGovUrl(result.url) && !/\.pdf($|\?)/i.test(result.url))
    .slice(0, 6);
  const documents = await Promise.all(
    govPages.map(async (page) => ({
      page,
      document: await fetchPageDocument(page.url),
    })),
  );
  let gdp: ReconStat | null = null;
  let pop: ReconStat | null = null;

  for (const { page, document } of documents) {
    if (!document) continue;
    attempts.push(page.url);
    if (!isCityLevelBulletin(document.title, cityName)) continue;
    const year = pickStatYear({ ...page, title: document.title });
    const parsed = extractStatsFromText(document.text, page.url, year);
    if (!gdp && parsed.gdp) gdp = parsed.gdp;
    if (!pop && parsed.pop) pop = parsed.pop;
    if (gdp && pop) break;
  }
  return { gdp, pop, attempts };
}

function buildSources(recon: Omit<CityRecon, 'sources'>, retrievedAt: string): SourceRef[] {
  const sources: SourceRef[] = [
    source(
      `S-RECON-${recon.cityId}`,
      'web_search',
      `CityLens 城市侦察记录 · ${recon.cityName}`,
      undefined,
      retrievedAt,
    ),
  ];
  if (recon.wikipedia) {
    sources.push(
      source(
        sourceId('WP', recon.wikipedia.url),
        'wikipedia',
        `维基百科 · ${recon.wikipedia.title}`,
        recon.wikipedia.url,
        retrievedAt,
      ),
    );
  }
  if (recon.wikidata) {
    sources.push(
      source(
        sourceId('WD', recon.wikidata.qid),
        'wikidata',
        `Wikidata 城市实体 · ${recon.cityName}（${recon.wikidata.qid}）`,
        `https://www.wikidata.org/wiki/${recon.wikidata.qid}`,
        retrievedAt,
      ),
    );
  }
  if (recon.climate) {
    sources.push(
      source(
        sourceId('CLIMATE', recon.cityId),
        'local_snapshot',
        `Open-Meteo ERA5 ${recon.climate.period} · ${recon.cityName}`,
        'https://archive-api.open-meteo.com/v1/archive',
        retrievedAt,
      ),
    );
  }
  if (recon.stats.gdp) {
    sources.push(
      source(
        sourceId('STAT', recon.stats.gdp.url),
        'gov_stat',
        `${recon.cityName} ${recon.stats.gdp.year} 年统计公报（GDP）`,
        recon.stats.gdp.url,
        retrievedAt,
      ),
    );
  }
  if (recon.stats.pop && recon.stats.pop.url !== recon.stats.gdp?.url) {
    sources.push(
      source(
        sourceId('STAT', recon.stats.pop.url),
        'gov_stat',
        `${recon.cityName} ${recon.stats.pop.year} 年统计公报（常住人口）`,
        recon.stats.pop.url,
        retrievedAt,
      ),
    );
  }
  for (const search of recon.searches) {
    for (const result of search.results.slice(0, 3)) {
      if (sources.some((item) => item.url === result.url)) continue;
      sources.push(
        source(
          sourceId('WEB', result.url),
          'web_search',
          result.title,
          result.url,
          retrievedAt,
        ),
      );
    }
  }
  return sources;
}

function readCache(cityId: string): CityRecon | null {
  const cached = memory.get(cityId);
  if (cached) return cached;
  const path = resolve(RECON_DIR, `${cityId}.json`);
  if (!existsSync(path)) return null;
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as ReconFile;
    if (Date.now() - Date.parse(file.generatedAt) > TTL_MS) return null;
    memory.set(cityId, file);
    return file;
  } catch {
    return null;
  }
}

async function buildRecon(city: CityBrief): Promise<CityRecon> {
  const retrievedAt = new Date().toISOString();
  const qid = cityQid(city.cityId);
  const generalQuery = `${city.standardName} 历史 文化 非遗 美食 方言`;
  const statsQuery = `${city.standardName} 2025年 国民经济和社会发展统计公报 地区生产总值 常住人口`;

  const [wikipedia, wikidata, general, statsSearch, climate] = await Promise.all([
    fetchWikipediaCity(city.standardName, city.province),
    qid ? fetchWikidataCityFacts(qid) : Promise.resolve(null),
    searchWeb(generalQuery, { maxResults: 6, includeAnswer: true, searchDepth: 'advanced' }),
    searchWeb(statsQuery, { maxResults: 8, includeAnswer: false, searchDepth: 'advanced' }),
    fetchClimateMonthly(city.cityId, city.center),
  ]);

  const stats = await extractStats(statsSearch.results, city.standardName);
  const base: Omit<CityRecon, 'sources'> = {
    cityId: city.cityId,
    cityName: city.standardName,
    generatedAt: retrievedAt,
    wikipedia,
    wikidata,
    searches: [general, statsSearch].filter((item) => item.results.length > 0),
    stats,
    climate: climate
      ? {
          period: '1991–2020',
          station: 'ERA5 再分析（城市中心格点）',
          monthly: climate,
        }
      : null,
  };
  return { ...base, sources: buildSources(base, retrievedAt) };
}

/** 读取（或按需构建）城市侦察结果；失败时返回 null，不阻断生成。 */
export async function loadCityRecon(city: CityBrief): Promise<CityRecon | null> {
  const cached = readCache(city.cityId);
  if (cached) return cached;
  const failed = failedAt.get(city.cityId) ?? 0;
  if (failed > Date.now()) return null;
  const pending = inflight.get(city.cityId);
  if (pending) return pending;

  const task = buildRecon(city)
    .then((recon) => {
      memory.set(city.cityId, recon);
      mkdirSync(RECON_DIR, { recursive: true });
      const file: ReconFile = { version: 1, ...recon };
      writeFileSync(resolve(RECON_DIR, `${city.cityId}.json`), `${JSON.stringify(file, null, 2)}\n`);
      return recon;
    })
    .catch((error: unknown) => {
      failedAt.set(city.cityId, Date.now() + NEGATIVE_TTL_MS);
      console.warn(`[recon] ${city.standardName} 侦察失败：${(error as Error).message}`);
      return null;
    })
    .finally(() => {
      inflight.delete(city.cityId);
    });
  inflight.set(city.cityId, task);
  return task;
}

/** 测试用：清空内存缓存。 */
export function resetCityReconCache(): void {
  memory.clear();
  inflight.clear();
  failedAt.clear();
}
