import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCityWeather, resetWeatherCache, weatherLabel } from './weatherService';

afterEach(() => {
  vi.unstubAllGlobals();
  resetWeatherCache();
});

function stubFetch(payload: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      json: async () => payload,
    })),
  );
}

describe('weatherService', () => {
  it('成功时返回实时天气并标注来源', async () => {
    stubFetch({
      current: {
        time: '2026-11-11T08:00',
        temperature_2m: 12.34,
        weather_code: 3,
        wind_speed_10m: 4.56,
      },
    });
    const weather = await getCityWeather('CN-320300', [117.18, 34.26]);
    expect(weather).not.toBeNull();
    expect(weather?.tempC).toBe(12.3);
    expect(weather?.weatherLabel).toBe('阴');
    expect(weather?.windKmh).toBe(4.6);
    expect(weather?.source).toBe('open-meteo');
    expect(weather?.isRealtime).toBe(true);
  });

  it('接口失败返回 null（不伪造）', async () => {
    stubFetch({}, false);
    expect(await getCityWeather('CN-320300', [117.18, 34.26])).toBeNull();
  });

  it('字段缺失返回 null', async () => {
    stubFetch({ current: { time: '2026-11-11T08:00' } });
    expect(await getCityWeather('CN-320300', [117.18, 34.26])).toBeNull();
  });

  it('10 分钟内命中内存缓存，不重复请求', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        current: { time: '2026-11-11T08:00', temperature_2m: 10, weather_code: 0, wind_speed_10m: 1 },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await getCityWeather('CN-320300', [117.18, 34.26]);
    const second = await getCityWeather('CN-320300', [117.18, 34.26]);
    expect(first?.tempC).toBe(10);
    expect(second?.tempC).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('weatherLabel 覆盖主要 WMO 代码', () => {
    expect(weatherLabel(0)).toBe('晴');
    expect(weatherLabel(61)).toBe('雨');
    expect(weatherLabel(73)).toBe('雪');
    expect(weatherLabel(95)).toBe('雷暴');
    expect(weatherLabel(999)).toBe('待考');
  });
});
