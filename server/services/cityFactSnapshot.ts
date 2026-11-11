/**
 * 非预置城市的按需 Wikidata 事实快照。
 *
 * - 生成时若本城没有本地快照，实时查询 Wikidata（5 个 SPARQL 查询并行），
 *   结果写入 server/data/fact_snapshot/<cityId>.json，后续生成直接复用；
 * - 查询失败或全部为空时返回 null，不伪造数据，让模块按 NO_FACTS 降级；
 * - 产物与构建期快照同构，供景点、文物、人物三个模块共用。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatYear,
  loadDictionary,
  parsePoint,
  parseWikibaseYear,
  qidFromUri,
  sparql,
  WIKIDATA_ENDPOINT,
  withinCity,
  type Binding,
} from '../../scripts/lib/wikidata';
import { config } from '../config';
import type { CityBrief } from '../db/cityRepo';
import {
  getFactSnapshot,
  setFactSnapshot,
  type FactSnapshot,
  type RegistryRelic,
  type SnapshotFigure,
  type SnapshotLandmark,
  type SnapshotRelic,
} from './presetData';
import { fetchPersonFacts } from './wikidataEntityService';
import { fetchWikipediaCategoryTitles, resolveWikibaseItems } from './wikipediaService';

/** 运行时单条 SPARQL 查询上限；5 条并行，最坏约 15s。 */
const RUNTIME_TIMEOUT_MS = 15000;
/** 查询失败后的负缓存，避免同一城市在 10 分钟内反复打 Wikidata。 */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

const inflight = new Map<string, Promise<FactSnapshot | null>>();
const failedAt = new Map<string, number>();
let qidCache: Map<string, string> | null = null;

/** 词典中的 Wikidata QID；没有 QID 或格式不合法时返回 null。 */
export function cityQid(cityId: string): string | null {
  if (!qidCache) {
    try {
      qidCache = new Map(loadDictionary().cities.map((city) => [city.cityId, city.wikidataQid]));
    } catch {
      qidCache = new Map();
    }
  }
  const qid = qidCache.get(cityId);
  return qid && /^Q\d+$/.test(qid) ? qid : null;
}

function label(row: Binding, key: string): string | null {
  const value = row[key]?.value;
  return value && value.trim() ? value.trim() : null;
}

function sitelinks(row: Binding): number {
  const value = Number(row.sl?.value);
  return Number.isFinite(value) ? value : 0;
}

async function fetchLandmarks(
  cityQid: string,
): Promise<{ items: SnapshotLandmark[]; error?: string }> {
  const query = `SELECT DISTINCT ?item ?itemLabel ?coord ?typeLabel ?desc ?sl ?designationLabel WHERE {
    ?item wdt:P625 ?coord ; wdt:P31 ?type .
    VALUES ?type { wd:Q570116 wd:Q33506 wd:Q44539 wd:Q839954 wd:Q23413 }
    ${withinCity('?item', cityQid)}
    OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "zh-hans") }
    OPTIONAL { ?item wikibase:sitelinks ?sl }
    OPTIONAL { ?item wdt:P1435 ?designation }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
  } LIMIT 300`;
  try {
    const rows = await sparql(query, 0, RUNTIME_TIMEOUT_MS);
    const items: SnapshotLandmark[] = [];
    for (const row of rows) {
      const entityId = qidFromUri(row.item?.value);
      const name = label(row, 'itemLabel');
      const coordinates = parsePoint(row.coord?.value);
      if (!entityId || !name || !coordinates) continue;
      items.push({
        entityId,
        name,
        coordinates,
        kind: label(row, 'typeLabel') ?? '待考',
        heritageDesignations: row.designationLabel?.value ? [row.designationLabel.value] : [],
        description: label(row, 'desc'),
        sitelinks: sitelinks(row),
      });
    }
    return { items };
  } catch (error) {
    return { items: [], error: `景点查询失败：${(error as Error).message}` };
  }
}

async function fetchRelics(
  cityQid: string,
): Promise<{ items: SnapshotRelic[]; error?: string }> {
  const query = `SELECT DISTINCT ?item ?itemLabel ?coord ?inception ?start ?collectionLabel ?locationLabel ?designationLabel ?desc ?sl WHERE {
    ?item wdt:P1435 ?designation ; wdt:P625 ?coord .
    VALUES ?designation { wd:Q1188574 wd:Q11155976 }
    ${withinCity('?item', cityQid)}
    OPTIONAL { ?item wdt:P571 ?inception }
    OPTIONAL { ?item wdt:P580 ?start }
    OPTIONAL { ?item wdt:P195 ?collection }
    OPTIONAL { ?item wdt:P276 ?location }
    OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "zh-hans") }
    OPTIONAL { ?item wikibase:sitelinks ?sl }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
  } LIMIT 200`;
  try {
    const rows = await sparql(query, 0, RUNTIME_TIMEOUT_MS);
    const map = new Map<string, SnapshotRelic>();
    for (const row of rows) {
      const entityId = qidFromUri(row.item?.value);
      const name = label(row, 'itemLabel');
      if (!entityId || !name) continue;
      const designation = label(row, 'designationLabel');
      const existing = map.get(entityId);
      if (existing) {
        if (designation && !existing.designations.includes(designation)) {
          existing.designations.push(designation);
        }
        continue;
      }
      map.set(entityId, {
        entityId,
        name,
        coordinates: parsePoint(row.coord?.value),
        inceptionYear:
          parseWikibaseYear(row.inception?.value) ?? parseWikibaseYear(row.start?.value),
        museumOrSite: label(row, 'collectionLabel'),
        location: label(row, 'locationLabel'),
        designations: designation ? [designation] : [],
        description: label(row, 'desc'),
        sitelinks: sitelinks(row),
      });
    }
    return { items: [...map.values()] };
  } catch (error) {
    return { items: [], error: `文物查询失败：${(error as Error).message}` };
  }
}

async function fetchFigures(
  cityQid: string,
  mode: 'native' | 'death' | 'work',
): Promise<{ items: SnapshotFigure[]; error?: string }> {
  const modeConfig = {
    native: { prop: 'P19', evidence: 'birthplace', minSitelinks: 15, label: '籍贯' },
    death: { prop: 'P20', evidence: 'deathplace', minSitelinks: 20, label: '卒地' },
    work: { prop: 'P937', evidence: 'workplace', minSitelinks: 25, label: '任职/游历' },
  }[mode];
  const relationType = mode === 'native' ? 'native' : 'sojourner';
  const query = `SELECT DISTINCT ?p ?pLabel ?birth ?death ?sl ?desc ?placeLabel WHERE {
    ?p wdt:P31 wd:Q5 ; wdt:${modeConfig.prop} ?place ; wikibase:sitelinks ?sl .
    FILTER(?sl >= ${modeConfig.minSitelinks})
    ${withinCity('?place', cityQid)}
    OPTIONAL { ?p wdt:P569 ?birth }
    OPTIONAL { ?p wdt:P570 ?death }
    OPTIONAL { ?p schema:description ?desc FILTER(LANG(?desc) = "zh-hans") }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
  } LIMIT 200`;
  try {
    const rows = await sparql(query, 0, RUNTIME_TIMEOUT_MS);
    const items: SnapshotFigure[] = [];
    for (const row of rows) {
      const entityId = qidFromUri(row.p?.value);
      const name = label(row, 'pLabel');
      const placeName = label(row, 'placeLabel');
      if (!entityId || !name) continue;
      const birthYear = parseWikibaseYear(row.birth?.value);
      // 与构建期口径一致：只收录 1912 年前的历史人物。
      if (birthYear === null || birthYear >= 1912) continue;
      items.push({
        entityId,
        name,
        birthYear,
        deathYear: parseWikibaseYear(row.death?.value),
        relationType,
        evidence: { property: modeConfig.evidence, value: placeName ?? '待考' },
        sitelinks: sitelinks(row),
        description: label(row, 'desc'),
      });
    }
    return { items };
  } catch (error) {
    return { items: [], error: `${modeConfig.label}人物查询失败：${(error as Error).message}` };
  }
}

/** 维基百科「XX市人」分类补充：覆盖 Wikidata 缺 P19/P20 的历史人物。 */
async function fetchCategoryFigures(
  city: CityBrief,
): Promise<{ items: SnapshotFigure[]; error?: string }> {
  try {
    const titles = await fetchWikipediaCategoryTitles(city.standardName);
    if (titles.length === 0) return { items: [] };
    const qids = await resolveWikibaseItems(titles);
    if (qids.length === 0) return { items: [] };
    const facts = await fetchPersonFacts(qids);
    const items = facts
      .filter(
        (fact) =>
          fact.birthYear !== null && fact.birthYear < 1912 && fact.sitelinks >= 3,
      )
      .sort((a, b) => b.sitelinks - a.sitelinks)
      .map((fact) => ({
        entityId: fact.qid,
        name: fact.label,
        birthYear: fact.birthYear as number,
        deathYear: fact.deathYear,
        relationType: 'native' as const,
        evidence: {
          property: 'position',
          value: `${city.standardName}市人（维基百科分类）`,
        },
        sitelinks: fact.sitelinks,
        description: fact.description,
      }));
    return { items };
  } catch (error) {
    return { items: [], error: `维基百科人物分类补充失败：${(error as Error).message}` };
  }
}

async function buildSnapshot(city: CityBrief, cityQid: string): Promise<FactSnapshot | null> {
  const retrievedAt = new Date().toISOString();
  const [attractions, relics, natives, deaths, workers, categoryFigures] = await Promise.all([
    fetchLandmarks(cityQid),
    fetchRelics(cityQid),
    fetchFigures(cityQid, 'native'),
    fetchFigures(cityQid, 'death'),
    fetchFigures(cityQid, 'work'),
    fetchCategoryFigures(city),
  ]);

  const failures: string[] = [];
  for (const part of [attractions, relics, natives, deaths, workers, categoryFigures]) {
    if (part.error) failures.push(part.error);
  }

  // 国保/禁出境遗址本身也是可到访景点，合并去重（缺坐标的不伪造中心点）。
  const heritageLandmarks: SnapshotLandmark[] = relics.items
    .filter((relic): relic is SnapshotRelic & { coordinates: [number, number] } =>
      Boolean(relic.coordinates),
    )
    .map((relic) => ({
      entityId: relic.entityId,
      name: relic.name,
      coordinates: relic.coordinates,
      kind: relic.designations.join('、') || '文物保护单位',
      heritageDesignations: relic.designations,
      description: relic.description,
      sitelinks: relic.sitelinks,
    }));

  const landmarkMap = new Map<string, SnapshotLandmark>();
  for (const item of [...attractions.items, ...heritageLandmarks]) {
    const existing = landmarkMap.get(item.entityId);
    if (!existing) {
      landmarkMap.set(item.entityId, item);
      continue;
    }
    landmarkMap.set(item.entityId, {
      ...existing,
      kind: existing.kind === '待考' ? item.kind : existing.kind,
      heritageDesignations: [
        ...new Set([...existing.heritageDesignations, ...item.heritageDesignations]),
      ],
    });
  }
  const landmarks = [...landmarkMap.values()]
    .sort((a, b) => b.sitelinks - a.sitelinks)
    .slice(0, 120);

  const figureMap = new Map<string, SnapshotFigure>();
  for (const figure of [
    ...natives.items,
    ...deaths.items,
    ...workers.items,
    ...categoryFigures.items,
  ]) {
    if (!figureMap.has(figure.entityId)) figureMap.set(figure.entityId, figure);
  }
  const figures = [...figureMap.values()]
    .sort((a, b) => b.sitelinks - a.sitelinks)
    .slice(0, 80);

  if (landmarks.length === 0 && relics.items.length === 0 && figures.length === 0) {
    return null;
  }

  const snapshot: FactSnapshot = {
    cityId: city.cityId,
    cityName: city.standardName,
    cityQid,
    center: city.center,
    retrievedAt,
    sourceRef: {
      id: `S-WD-${city.cityId}`,
      type: 'wikidata',
      title: `Wikidata 事实快照 · ${city.standardName}`,
      url: WIKIDATA_ENDPOINT,
      retrievedAt,
    },
    landmarks,
    relics: relics.items,
    figures,
    failures,
  };

  try {
    const dir = resolve(config.dataDir, 'fact_snapshot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, `${city.cityId}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8',
    );
    setFactSnapshot(city.cityId, snapshot);
    console.log(
      `[citylens] 已生成 ${city.standardName} 的 Wikidata 快照：景点 ${landmarks.length}、文物 ${relics.items.length}、人物 ${figures.length}`,
    );
  } catch (error) {
    console.warn(`[citylens] 写入 ${city.standardName} 快照失败：${(error as Error).message}`);
  }
  return snapshot;
}

/**
 * 读取或按需构建本城事实快照。
 * 已有本地快照时同步返回；否则联网构建，失败返回 null（模块按 NO_FACTS 降级）。
 */
export function loadCitySnapshot(city: CityBrief): Promise<FactSnapshot | null> {
  const existing = getFactSnapshot(city.cityId);
  if (existing) return Promise.resolve(existing);

  const failed = failedAt.get(city.cityId);
  if (failed !== undefined && Date.now() - failed < NEGATIVE_TTL_MS) {
    return Promise.resolve(null);
  }

  const pending = inflight.get(city.cityId);
  if (pending) return pending;

  const qid = cityQid(city.cityId);
  if (!qid) {
    failedAt.set(city.cityId, Date.now());
    return Promise.resolve(null);
  }

  const task = buildSnapshot(city, qid)
    .then((snapshot) => {
      if (snapshot) failedAt.delete(city.cityId);
      else failedAt.set(city.cityId, Date.now());
      return snapshot;
    })
    .catch((error: unknown) => {
      failedAt.set(city.cityId, Date.now());
      console.warn(
        `[citylens] 构建 ${city.standardName} 的 Wikidata 快照失败：${(error as Error).message}`,
      );
      return null;
    })
    .finally(() => {
      inflight.delete(city.cityId);
    });
  inflight.set(city.cityId, task);
  return task;
}

/**
 * 人工校正：上游 Wikidata 属性错误（如 Q806929 半坡遗址的 P276 误标为「和田市」）。
 * 只把明显与坐标/本城矛盾的上游值改为「待考」，绝不填入无法核验的替代值。
 */
const MUSEUM_OVERRIDES: Record<string, string> = {
  'CN-610100:Q806929': '待考',
};

/** 把快照中的文物映射为文物名录条目，供非预置城市复用同一套生成逻辑。 */
export function snapshotToRegistry(snapshot: FactSnapshot): RegistryRelic[] {
  return snapshot.relics
    .filter((relic) => Boolean(relic.name))
    .map((relic) => ({
      registryId: `${snapshot.cityId}:${relic.entityId}`,
      cityId: snapshot.cityId,
      cityName: snapshot.cityName,
      name: relic.name,
      era: relic.inceptionYear === null ? '待考' : formatYear(relic.inceptionYear),
      museumOrSite:
        MUSEUM_OVERRIDES[`${snapshot.cityId}:${relic.entityId}`] ??
        relic.museumOrSite ??
        relic.location ??
        '待考',
      protectionLevel: relic.designations.length ? relic.designations.join('、') : '待考',
      findSpot: '待考',
      coordinates: relic.coordinates,
      description: relic.description,
      sourceRefs: [snapshot.sourceRef.id],
    }));
}

/** 测试用：清空按需快照的内存状态。 */
export function resetCityFactSnapshotCache(): void {
  inflight.clear();
  failedAt.clear();
  qidCache = null;
}
