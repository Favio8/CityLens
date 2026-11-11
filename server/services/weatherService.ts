/**
 * 实时天气服务（P1-14）：Open-Meteo current weather（无需 Key）。
 * - 10 分钟内存缓存 + 进程内单飞，避免重复请求；
 * - 失败返回 null，由前端回退到 1991–2020 气候基线，不编造数据；
 * - 与「气候基线」明确区分：本服务只提供实时观测。
 */
import type { Coord, WeatherResponse } from '../../shared/schema';

const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** WMO 天气代码中文对照（Open-Meteo weather_code）。 */
const WEATHER_LABELS: Array<{ max: number; label: string }> = [
  { max: 0, label: '晴' },
  { max: 1, label: '主要晴朗' },
  { max: 2, label: '多云' },
  { max: 3, label: '阴' },
  { max: 48, label: '雾' },
  { max: 57, label: '毛毛雨' },
  { max: 65, label: '雨' },
  { max: 67, label: '冻雨' },
  { max: 77, label: '雪' },
  { max: 82, label: '阵雨' },
  { max: 86, label: '阵雪' },
  { max: 99, label: '雷暴' },
];

export function weatherLabel(code: number): string {
  return WEATHER_LABELS.find((entry) => code <= entry.max)?.label ?? '待考';
}

interface CacheEntry {
  at: number;
  data: WeatherResponse | null;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<WeatherResponse | null>>();

interface OpenMeteoCurrent {
  current?: {
    time?: string;
    temperature_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
}

async function fetchCurrent(cityId: string, center: Coord): Promise<WeatherResponse | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${center[1]}&longitude=${center[0]}` +
    '&current=temperature_2m,weather_code,wind_speed_10m&timezone=Asia%2FShanghai';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = (await response.json()) as OpenMeteoCurrent;
    const current = payload.current;
    if (
      !current ||
      typeof current.temperature_2m !== 'number' ||
      typeof current.weather_code !== 'number'
    ) {
      return null;
    }
    return {
      cityId,
      observedAt: current.time ?? new Date().toISOString(),
      tempC: Math.round(current.temperature_2m * 10) / 10,
      weatherCode: current.weather_code,
      weatherLabel: weatherLabel(current.weather_code),
      windKmh: Math.round((current.wind_speed_10m ?? 0) * 10) / 10,
      source: 'open-meteo',
      isRealtime: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 读取实时天气；失败返回 null（不抛错，不伪造）。 */
export function getCityWeather(cityId: string, center: Coord): Promise<WeatherResponse | null> {
  const cached = cache.get(cityId);
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.data);
  const pending = inflight.get(cityId);
  if (pending) return pending;

  const task = fetchCurrent(cityId, center)
    .then((data) => {
      cache.set(cityId, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      inflight.delete(cityId);
    });
  inflight.set(cityId, task);
  return task;
}

/** 测试用：清空缓存。 */
export function resetWeatherCache(): void {
  cache.clear();
  inflight.clear();
}
