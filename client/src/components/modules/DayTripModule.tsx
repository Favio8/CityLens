/**
 * 「如果只有一天」一日路线（P2-20）：
 * 从档案景点 / 文物中选取有坐标点位，按上午 / 下午 / 晚上分组；
 * 地图画连接线并标注「示意路线，非导航」；不订票、不承诺营业时间。
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import type { Coord, DayTrip, DayTripSlot } from '@citylens/shared/schema';
import type { CityMapPoint } from './CityMap';
import { PendingTag } from '../ui/Tags';
import { getDayTrip } from '../../lib/api';

/** 地图依赖较重，进入视口时再加载，避免拖慢首屏。 */
const CityMap = lazy(() =>
  import('./CityMap').then((module) => ({ default: module.CityMap })),
);

const SLOT_LABELS: Record<DayTripSlot, string> = {
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
};

const SLOT_ORDER: DayTripSlot[] = ['morning', 'afternoon', 'evening'];

export function DayTripModule({
  cityId,
  cityName,
  center,
}: {
  cityId: string;
  cityName: string;
  center: Coord;
}) {
  const [trip, setTrip] = useState<DayTrip | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setTrip(null);
    setFailed(false);
    void getDayTrip(cityId, controller.signal)
      .then(setTrip)
      .catch((error: unknown) => {
        if ((error as Error).name !== 'AbortError') setFailed(true);
      });
    return () => controller.abort();
  }, [cityId]);

  if (failed) {
    return (
      <div className="surface-card rounded-md p-8">
        <PendingTag label="路线未能生成" />
        <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
          该城尚未成卷或点位不足，暂无法排出一日路线。
        </p>
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="surface-card h-[280px] animate-pulse rounded-md md:h-[420px]" aria-busy="true">
        <span className="sr-only">路线排布中</span>
      </div>
    );
  }

  const points: CityMapPoint[] = trip.stops.map((stop, index) => ({
    id: `${index}-${stop.name}`,
    name: stop.name,
    coordinates: stop.coordinates,
    kindLabel: `${SLOT_LABELS[stop.slot]} · ${stop.category}`,
  }));
  const route = trip.stops.map((stop) => stop.coordinates);

  return (
    <div className="grid gap-6 lg:grid-cols-[45%_55%]">
      <div className="space-y-4">
        {trip.degraded ? (
          <p className="rounded-sm border border-dashed p-3 text-[11px] leading-relaxed text-[var(--text-secondary)] hairline">
            可定位点位不足 4 个，已按实际数量编排；其余点位坐标待考。
          </p>
        ) : null}
        {SLOT_ORDER.map((slot) => {
          const stops = trip.stops.filter((stop) => stop.slot === slot);
          if (stops.length === 0) return null;
          return (
            <div key={slot} className="surface-card rounded-md p-5">
              <p className="eyebrow">{SLOT_LABELS[slot]}</p>
              <ol className="mt-3 space-y-2.5">
                {stops.map((stop, index) => (
                  <li key={`${slot}-${stop.name}`} className="text-xs leading-relaxed">
                    <span className="font-serif text-sm">{stop.name}</span>
                    <span className="ml-2 text-[10px] text-[var(--text-secondary)]">
                      {stop.category} · 第 {index + 1} 站
                    </span>
                    <span className="mt-0.5 block text-[10px] text-[var(--text-secondary)]">
                      营业时间：待考 · 不提供订票
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
        <p className="text-[10px] leading-relaxed text-[var(--text-secondary)]">{trip.notice}</p>
      </div>
      <Suspense
        fallback={
          <div className="surface-card h-[280px] animate-pulse rounded-md md:h-[420px]" aria-busy="true">
            <span className="sr-only">地图加载中</span>
          </div>
        }
      >
        <CityMap
          cityId={cityId}
          cityName={cityName}
          center={center}
          points={points}
          scope="daytrip"
          route={route}
          ariaLabel={`${cityName}一日路线示意图`}
        />
      </Suspense>
    </div>
  );
}
