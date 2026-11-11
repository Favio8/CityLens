/**
 * 「数说城市」基线数据加载器。
 * 数据由 scripts/build_stats_baseline.ts 生成，运行期只读本地文件，不联网。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceRef } from '../../shared/schema';
import { config } from '../config';

export interface StatsSeriesPoint {
  year: number;
  value: number | null;
}

export interface StatsMetric {
  unit: string;
  caliber: string;
  sourceRefs: string[];
  series: StatsSeriesPoint[];
}

export interface StatsClimate {
  period: string;
  station: string;
  sourceRefs: string[];
  monthly: Array<{ month: number; tempC: number | null; precipMm: number | null }>;
}

export interface CityStats {
  gdp: StatsMetric;
  pop: StatsMetric;
  climate: StatsClimate;
}

interface StatsSource {
  id: string;
  type: string;
  title: string;
  url?: string;
  retrievedAt: string;
}

interface StatsFile {
  generatedAt: string;
  note: string;
  sources: StatsSource[];
  cities: Record<string, CityStats>;
}

let fileCache: StatsFile | null | undefined;

function loadFile(): StatsFile | null {
  if (fileCache !== undefined) return fileCache;
  const path = resolve(config.dataDir, 'stats_baseline.json');
  if (!existsSync(path)) {
    console.warn('[statsBaseline] 缺少 stats_baseline.json，数说城市将暂缺');
    fileCache = null;
    return null;
  }
  try {
    fileCache = JSON.parse(readFileSync(path, 'utf8')) as StatsFile;
  } catch (error) {
    console.warn(`[statsBaseline] 读取失败：${(error as Error).message}`);
    fileCache = null;
  }
  return fileCache;
}

function toSourceRef(source: StatsSource): SourceRef {
  return {
    id: source.id,
    type: source.type as SourceRef['type'],
    title: source.title,
    ...(source.url ? { url: source.url } : {}),
    retrievedAt: source.retrievedAt,
  };
}

/** 返回某城的统计数据与它实际引用的来源；没有产物时返回 null。 */
export function getCityStats(cityId: string): { city: CityStats; sources: SourceRef[] } | null {
  const file = loadFile();
  const city = file?.cities[cityId];
  if (!file || !city) return null;
  const used = new Set([
    ...city.gdp.sourceRefs,
    ...city.pop.sourceRefs,
    ...city.climate.sourceRefs,
  ]);
  const sources = file.sources.filter((source) => used.has(source.id)).map(toSourceRef);
  return { city, sources };
}

/** 测试用：清空缓存。 */
export function resetStatsBaselineCache(): void {
  fileCache = undefined;
}
