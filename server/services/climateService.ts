/**
 * 任意城市的气候基线：Open-Meteo ERA5 1991–2020 日值聚合为月均温与月降水。
 * 运行期按城市缓存，避免重复请求；失败返回 null，不估算。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config';

export interface ClimateMonth {
  month: number;
  tempC: number | null;
  precipMm: number | null;
}

interface ClimateCache {
  cityId: string;
  center: [number, number];
  fetchedAt: string;
  monthly: ClimateMonth[];
}

interface ClimatePayload {
  daily?: {
    time?: string[];
    temperature_2m_mean?: Array<number | null>;
    precipitation_sum?: Array<number | null>;
  };
}

const CACHE_DIR = resolve(config.dataDir, 'climate');
const TTL_MS = 180 * 24 * 60 * 60 * 1000;
const inflight = new Map<string, Promise<ClimateMonth[] | null>>();
const failedAt = new Map<string, number>();
const NEGATIVE_TTL_MS = 30 * 60 * 1000;

function readCache(cityId: string, center: [number, number]): ClimateMonth[] | null {
  const path = resolve(CACHE_DIR, `${cityId}.json`);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as ClimateCache;
    if (entry.center[0] !== center[0] || entry.center[1] !== center[1]) return null;
    if (Date.now() - Date.parse(entry.fetchedAt) > TTL_MS) return null;
    return entry.monthly.length === 12 ? entry.monthly : null;
  } catch {
    return null;
  }
}

function aggregate(payload: ClimatePayload): ClimateMonth[] {
  const daily = payload.daily ?? {};
  const dates = daily.time ?? [];
  const temps = daily.temperature_2m_mean ?? [];
  const precs = daily.precipitation_sum ?? [];
  const buckets = new Map<
    number,
    { tempSum: number; tempDays: number; precipSum: number; years: Set<number> }
  >();
  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    if (!date) continue;
    const month = Number(date.slice(5, 7));
    if (!month) continue;
    const bucket =
      buckets.get(month) ?? { tempSum: 0, tempDays: 0, precipSum: 0, years: new Set() };
    const temp = temps[i];
    const precip = precs[i];
    if (typeof temp === 'number' && Number.isFinite(temp)) {
      bucket.tempSum += temp;
      bucket.tempDays += 1;
    }
    if (typeof precip === 'number' && Number.isFinite(precip)) {
      bucket.precipSum += precip;
    }
    bucket.years.add(Number(date.slice(0, 4)));
    buckets.set(month, bucket);
  }
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const bucket = buckets.get(month);
    if (!bucket) return { month, tempC: null, precipMm: null };
    return {
      month,
      tempC: bucket.tempDays > 0 ? Math.round((bucket.tempSum / bucket.tempDays) * 10) / 10 : null,
      precipMm:
        bucket.years.size > 0 ? Math.round((bucket.precipSum / bucket.years.size) * 10) / 10 : null,
    };
  });
}

async function requestClimate(center: [number, number]): Promise<ClimateMonth[] | null> {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${center[1]}&longitude=${center[0]}` +
    '&start_date=1991-01-01&end_date=2020-12-31&daily=temperature_2m_mean,precipitation_sum&timezone=Asia%2FShanghai';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (response.ok) return aggregate((await response.json()) as ClimatePayload);
      if (response.status !== 429) return null;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15000 * (attempt + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

export async function fetchClimateMonthly(
  cityId: string,
  center: [number, number],
): Promise<ClimateMonth[] | null> {
  const cached = readCache(cityId, center);
  if (cached) return cached;
  const failed = failedAt.get(cityId) ?? 0;
  if (failed > Date.now()) return null;
  const pending = inflight.get(cityId);
  if (pending) return pending;

  const task = requestClimate(center)
    .then((monthly) => {
      if (!monthly) {
        failedAt.set(cityId, Date.now() + NEGATIVE_TTL_MS);
        return null;
      }
      mkdirSync(CACHE_DIR, { recursive: true });
      const entry: ClimateCache = {
        cityId,
        center,
        fetchedAt: new Date().toISOString(),
        monthly,
      };
      writeFileSync(resolve(CACHE_DIR, `${cityId}.json`), `${JSON.stringify(entry, null, 2)}\n`);
      return monthly;
    })
    .catch(() => {
      failedAt.set(cityId, Date.now() + NEGATIVE_TTL_MS);
      return null;
    })
    .finally(() => {
      inflight.delete(cityId);
    });
  inflight.set(cityId, task);
  return task;
}

/** 测试用：清空内存状态。 */
export function resetClimateCache(): void {
  inflight.clear();
  failedAt.clear();
}
