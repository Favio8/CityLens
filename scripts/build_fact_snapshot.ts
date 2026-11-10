/**
 * 构建期脚本：从 Wikidata 生成 6 座预置城市的事实快照。
 * 产物：server/data/fact_snapshot/<cityId>.json
 *
 * 只记录检索到的原始事实（名称、坐标、类型、生卒年、国保/禁出境身份），
 * 不做任何推测性补全；缺失字段在后续组装时填「待考」。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDictionary,
  parsePoint,
  parseWikibaseYear,
  qidFromUri,
  sleep,
  sparql,
  WIKIDATA_ENDPOINT,
  withinCity,
  type Binding,
} from './lib/wikidata';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, '../server/data/fact_snapshot');

const PRESETS = ['CN-610100', 'CN-330100', 'CN-510100', 'CN-110000', 'CN-320500', 'CN-410300'];

interface SnapshotLandmark {
  entityId: string;
  name: string;
  coordinates: [number, number];
  kind: string;
  heritageDesignations: string[];
  description: string | null;
  sitelinks: number | null;
}

interface SnapshotRelic {
  entityId: string;
  name: string;
  coordinates: [number, number] | null;
  inceptionYear: number | null;
  museumOrSite: string | null;
  location: string | null;
  designations: string[];
  description: string | null;
  sitelinks: number | null;
}

interface SnapshotFigure {
  entityId: string;
  name: string;
  birthYear: number | null;
  deathYear: number | null;
  relationType: 'native' | 'sojourner';
  evidence: { property: 'birthplace' | 'deathplace' | 'workplace'; value: string };
  sitelinks: number | null;
  description: string | null;
}

interface CitySnapshot {
  cityId: string;
  cityName: string;
  cityQid: string;
  center: [number, number];
  retrievedAt: string;
  sourceRef: {
    id: string;
    type: 'wikidata';
    title: string;
    url: string;
    retrievedAt: string;
  };
  landmarks: SnapshotLandmark[];
  relics: SnapshotRelic[];
  figures: SnapshotFigure[];
  failures: string[];
}

function label(row: Binding, key: string): string | null {
  const value = row[key]?.value;
  return value && value.trim() ? value.trim() : null;
}

function sitelinks(row: Binding): number | null {
  const n = Number(row.sl?.value);
  return Number.isFinite(n) ? n : null;
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
    const rows = await sparql(query);
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
    const rows = await sparql(query);
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
    native: { prop: 'P19', evidence: 'birthplace' as const, minSitelinks: 15, label: '籍贯' },
    death: { prop: 'P20', evidence: 'deathplace' as const, minSitelinks: 20, label: '卒地' },
    work: { prop: 'P937', evidence: 'workplace' as const, minSitelinks: 25, label: '任职/游历' },
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
    const rows = await sparql(query);
    const items: SnapshotFigure[] = [];
    for (const row of rows) {
      const entityId = qidFromUri(row.p?.value);
      const name = label(row, 'pLabel');
      const placeName = label(row, 'placeLabel');
      if (!entityId || !name) continue;
      const birthYear = parseWikibaseYear(row.birth?.value);
      // 一期只收录 1912 年前的历史人物，避免现代人物叙事风险
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

async function main(): Promise<void> {
  const dict = loadDictionary();
  const presets = PRESETS.map((id) => dict.cities.find((c) => c.cityId === id)).filter(
    (c): c is NonNullable<typeof c> => Boolean(c),
  );
  if (presets.length !== PRESETS.length) {
    throw new Error(`词典缺少预置城市：${PRESETS.filter((id) => !presets.some((c) => c.cityId === id))}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const summary: Array<{ cityId: string; landmarks: number; relics: number; figures: number; failures: number }> = [];

  for (const city of presets) {
    if (!city.wikidataQid) {
      console.error(`[snapshot] ${city.standardName} 缺少 Wikidata QID，跳过`);
      continue;
    }
    console.log(`[snapshot] ${city.standardName} (${city.wikidataQid}) 查询中…`);
    const retrievedAt = new Date().toISOString();
    const failures: string[] = [];

    const [attractions, relics, natives, deaths, workers] = [
      await fetchLandmarks(city.wikidataQid),
      await fetchRelics(city.wikidataQid),
      await fetchFigures(city.wikidataQid, 'native'),
      await fetchFigures(city.wikidataQid, 'death'),
      await fetchFigures(city.wikidataQid, 'work'),
    ];

    for (const part of [attractions, relics, natives, deaths, workers]) {
      if (part.error) failures.push(part.error);
    }

    // 国保/禁出境遗址本身也是可到访景点，合并去重（缺坐标的不伪造中心点）
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
      .sort((a, b) => (b.sitelinks ?? 0) - (a.sitelinks ?? 0))
      .slice(0, 120);

    const figureMap = new Map<string, SnapshotFigure>();
    for (const figure of [...natives.items, ...deaths.items, ...workers.items]) {
      if (!figureMap.has(figure.entityId)) figureMap.set(figure.entityId, figure);
    }
    const figures = [...figureMap.values()]
      .sort((a, b) => (b.sitelinks ?? 0) - (a.sitelinks ?? 0))
      .slice(0, 80);

    const snapshot: CitySnapshot = {
      cityId: city.cityId,
      cityName: city.standardName,
      cityQid: city.wikidataQid,
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

    const outPath = resolve(OUT_DIR, `${city.cityId}.json`);
    await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    summary.push({
      cityId: city.cityId,
      landmarks: landmarks.length,
      relics: relics.items.length,
      figures: figures.length,
      failures: failures.length,
    });
    console.log(
      `[snapshot] ${city.standardName}：景点 ${landmarks.length}，文物 ${relics.items.length}，人物 ${figures.length}，失败 ${failures.length}`,
    );
    if (failures.length > 0) failures.forEach((f) => console.warn(`  - ${f}`));
    await sleep(1200);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: 'Wikidata SPARQL',
    endpoint: WIKIDATA_ENDPOINT,
    license: 'CC0',
    summary,
  };
  await writeFile(resolve(OUT_DIR, '_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[snapshot] 完成 ${summary.length} 座城市`);
}

main().catch((error) => {
  console.error('[snapshot] 失败：', (error as Error).message);
  process.exit(1);
});
