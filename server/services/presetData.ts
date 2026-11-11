/**
 * 构建期数据产物的只读加载器（PRD 3.2 阶段 0/1）。
 * 运行期只读本地文件，不联网；文件缺失时返回 null 并记录一次告警，绝不伪造数据。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Coord, SourceRef } from '../../shared/schema';
import { config } from '../config';

/** 本地朝代年表的来源登记（供预置档案与真实生成共用）。 */
export const DYNASTY_SOURCE: SourceRef = {
  id: 'S-DYNASTY',
  type: 'preset_manual',
  title: '本地朝代年表（构建期整理，待复核）',
  retrievedAt: '2026-11-10T00:00:00.000Z',
};

export interface SnapshotLandmark {
  entityId: string;
  name: string;
  coordinates: Coord | null;
  kind: string | null;
  heritageDesignations: string[];
  description: string | null;
  sitelinks: number;
}

export interface SnapshotRelic {
  entityId: string;
  name: string;
  coordinates: Coord | null;
  inceptionYear: number | null;
  museumOrSite: string | null;
  location: string | null;
  designations: string[];
  description: string | null;
  sitelinks: number;
}

export interface SnapshotFigure {
  entityId: string;
  name: string;
  birthYear: number | null;
  deathYear: number | null;
  relationType: 'native' | 'sojourner';
  evidence: { property: string; value: string };
  sitelinks: number;
  description: string | null;
}

export interface FactSnapshot {
  cityId: string;
  cityName: string;
  cityQid: string | null;
  center: Coord;
  retrievedAt: string;
  sourceRef: { id: string; type: string; title: string; url?: string; retrievedAt: string };
  landmarks: SnapshotLandmark[];
  relics: SnapshotRelic[];
  figures: SnapshotFigure[];
  failures: string[];
}

export interface RegistryRelic {
  registryId: string;
  cityId: string;
  cityName: string;
  name: string;
  era: string;
  museumOrSite: string;
  protectionLevel: string;
  findSpot: string;
  coordinates: Coord | null;
  description: string | null;
  sourceRefs: string[];
}

export interface RelicsRegistry {
  generatedAt: string;
  stats: { relics: number };
  sources: Array<{ id: string; type: string; title: string; url?: string; retrievedAt: string }>;
  relics: RegistryRelic[];
}

export interface RelicImageRecord {
  registryId: string;
  cityId: string;
  name: string;
  qid: string;
  path: string;
  credit: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
  fetchedAt: string;
}

export interface RelicImages {
  generatedAt: string;
  source: string;
  licenseNote: string;
  stats: { requested: number; downloaded: number; reused: number; skipped: number };
  records: RelicImageRecord[];
  skipped: Array<{ registryId: string; name: string; reason: string }>;
}

export interface GazetteerEntry {
  name: string;
  coordinates: Coord;
  cityId: string;
  kind: 'city_center' | 'landmark' | 'relic' | string;
  entityId?: string | null;
  sourceRef: string;
}

export interface Gazetteer {
  generatedAt: string;
  entries: GazetteerEntry[];
}

export interface CorpusPoem {
  poemId: string;
  title: string;
  author: string;
  dynasty: string;
  lines: string[];
  linesTraditional: string[];
  sourceUrl: string;
  matchedCities: string[];
  seedFor: string[];
  matchScore: number;
}

export interface PoetryCorpus {
  generatedAt: string;
  source: { repo: string; license: string; note: string };
  stats: { filesProcessed: number; poems: number; byCity: Record<string, number> };
  failures: string[];
  poems: CorpusPoem[];
}

export interface Dynasty {
  name: string;
  startYear: number;
  endYear: number | null;
  note?: string;
}

export interface DynastyTable {
  source: string;
  verification: string;
  dynasties: Dynasty[];
}

const warns = new Set<string>();

function loadJson<T>(fileName: string): T | null {
  const path = resolve(config.dataDir, fileName);
  if (!existsSync(path)) {
    if (!warns.has(fileName)) {
      warns.add(fileName);
      console.warn(`[presetData] 缺少数据产物 ${fileName}，相关校验将不可用（请运行构建期脚本）`);
    }
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const snapshotCache = new Map<string, FactSnapshot | null>();
let relicsCache: RelicsRegistry | null | undefined;
let relicImagesCache: RelicImages | null | undefined;
let gazetteerCache: Gazetteer | null | undefined;
let poetryCache: PoetryCorpus | null | undefined;
let dynastyCache: DynastyTable | null | undefined;

export function getFactSnapshot(cityId: string): FactSnapshot | null {
  if (snapshotCache.has(cityId)) return snapshotCache.get(cityId) ?? null;
  const data = loadJson<FactSnapshot>(`fact_snapshot/${cityId}.json`);
  snapshotCache.set(cityId, data);
  return data;
}

/** 运行时按需生成快照后写回缓存，避免同一进程反复读空文件。 */
export function setFactSnapshot(cityId: string, snapshot: FactSnapshot): void {
  snapshotCache.set(cityId, snapshot);
}

export function getRelicsRegistry(): RelicsRegistry | null {
  if (relicsCache === undefined) relicsCache = loadJson<RelicsRegistry>('relics_registry.json');
  return relicsCache;
}

export function getRelicImages(): RelicImages | null {
  if (relicImagesCache === undefined) {
    relicImagesCache = loadJson<RelicImages>('relic_images.json');
  }
  return relicImagesCache;
}

export function getGazetteer(): Gazetteer | null {
  if (gazetteerCache === undefined) gazetteerCache = loadJson<Gazetteer>('place_gazetteer.json');
  return gazetteerCache;
}

export function getPoetryCorpus(): PoetryCorpus | null {
  if (poetryCache === undefined) poetryCache = loadJson<PoetryCorpus>('verified_poetry_corpus.json');
  return poetryCache;
}

export function getDynasties(): DynastyTable | null {
  if (dynastyCache === undefined) dynastyCache = loadJson<DynastyTable>('dynasties.json');
  return dynastyCache;
}

/** 测试用：清空缓存，避免跨用例污染。 */
export function resetPresetDataCache(): void {
  snapshotCache.clear();
  relicsCache = undefined;
  relicImagesCache = undefined;
  gazetteerCache = undefined;
  poetryCache = undefined;
  dynastyCache = undefined;
}
