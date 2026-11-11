/**
 * 实时天气条（P1-14）：Open-Meteo 当前天气（无需 Key）。
 * 与「1991–2020 气候基线」明确分区：失败时提示回退基线，不编造数据。
 */
import { useEffect, useState } from 'react';
import type { WeatherResponse } from '@citylens/shared/schema';
import { getCityWeather } from '../../lib/api';

export function WeatherStrip({ cityId }: { cityId: string }) {
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setWeather(null);
    setFailed(false);
    void getCityWeather(cityId, controller.signal)
      .then(setWeather)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [cityId]);

  if (failed) {
    return (
      <p className="mt-6 border-t pt-4 text-[10px] leading-relaxed text-[var(--text-secondary)] hairline">
        实时天气暂不可用（Open-Meteo 连接失败）；「数说城市」卷展示的是 1991–2020 年气候基线，并非实时数据。
      </p>
    );
  }

  if (!weather) {
    return (
      <p className="mt-6 border-t pt-4 text-[10px] text-[var(--text-secondary)] hairline" aria-busy="true">
        实时天气读取中…
      </p>
    );
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4 hairline">
      <span className="text-[10px] tracking-[0.24em] text-[var(--text-secondary)]">实时天气</span>
      <span className="font-serif text-2xl leading-none">{weather.tempC}°C</span>
      <span className="text-xs text-[var(--text-secondary)]">{weather.weatherLabel}</span>
      <span className="mono text-[10px] text-[var(--text-secondary)]">
        风速 {weather.windKmh} km/h
      </span>
      <span className="mono text-[10px] text-[var(--text-secondary)]">
        更新于 {weather.observedAt.replace('T', ' ').slice(0, 16)}
      </span>
      <span className="text-[10px] text-[var(--text-secondary)]">
        来源：Open-Meteo（实时观测，区别于 1991–2020 气候基线）
      </span>
    </div>
  );
}
