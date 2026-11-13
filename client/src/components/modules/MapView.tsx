/**
 * 景点地图（PRD 4.5 / 3.3 / AC-05 / AC-06）。
 * 地图本体由 CityMap 提供；本组件负责分类筛选、清单与卡片双向联动。
 */
import { useEffect, useMemo, useState } from 'react';
import type { Landmark, SourceRef } from '@citylens/shared/schema';
import { focusMap } from '../../lib/mapFocus';
import { COORD_SOURCE_LABELS } from '../../lib/labels';
import { SourceBadge } from '../ui/SourceBadge';
import type { CityMapPoint } from './CityMap';
import { DeferredCityMap } from './DeferredCityMap';

const CATEGORY_LABELS = { must_visit: '必游', hidden_gem: '秘境' } as const;

interface MapViewProps {
  cityId: string;
  cityName: string;
  center: [number, number];
  landmarks: Landmark[];
  sources: SourceRef[];
}

export function MapView({ cityId, cityName, center, landmarks, sources }: MapViewProps) {
  const [filter, setFilter] = useState<'all' | 'must_visit' | 'hidden_gem'>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const visible = useMemo(
    () => landmarks.filter((item) => filter === 'all' || item.category === filter),
    [landmarks, filter],
  );

  const points = useMemo<CityMapPoint[]>(
    () =>
      visible.flatMap((landmark) =>
        landmark.coordinates
          ? [
              {
                id: landmark.entityRef,
                name: landmark.name,
                coordinates: landmark.coordinates,
                kindLabel: CATEGORY_LABELS[landmark.category],
              },
            ]
          : [],
      ),
    [visible],
  );

  useEffect(() => {
    if (!selected) return;
    document
      .getElementById(`landmark-card-${selected}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selected]);

  const focusLandmark = (landmark: Landmark): void => {
    setSelected(landmark.entityRef);
    if (landmark.coordinates) {
      focusMap({
        scope: 'landmarks',
        lng: landmark.coordinates[0],
        lat: landmark.coordinates[1],
        label: landmark.name,
        scroll: false,
      });
    } else {
      // 无坐标条目：地图复位到城市中心（PRD AC-06「全域印记」）
      focusMap({ scope: 'landmarks', reset: true, scroll: false });
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(['all', 'must_visit', 'hidden_gem'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`border px-3 py-1.5 text-[10px] tracking-[0.16em] transition-colors hairline ${
                filter === key
                  ? 'border-[var(--city-primary)] bg-[var(--city-primary)] text-[var(--bg-canvas)]'
                  : 'hover:border-[var(--city-primary)]'
              }`}
              aria-pressed={filter === key}
            >
              {key === 'all' ? '全部' : key === 'must_visit' ? '必游' : '秘境'}
            </button>
          ))}
        </div>
        <span className="mono text-[10px] tracking-[0.14em] text-[var(--text-secondary)]">
          WGS84 · 本地地名库
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:items-start">
        <ul className="order-2 max-h-[420px] space-y-2 overflow-y-auto pr-1 lg:order-1 lg:max-h-[calc(100vh-180px)]">
          {visible.map((landmark) => (
            <li
              key={landmark.entityRef}
              id={`landmark-card-${landmark.entityRef}`}
              className={`scroll-mt-24 rounded-sm border p-3 transition-colors hairline ${
                selected === landmark.entityRef
                  ? 'border-[var(--city-primary)] bg-[var(--city-primary)]/5'
                  : 'hover:bg-[var(--city-primary)]/5'
              }`}
            >
              <button
                type="button"
                onClick={() => focusLandmark(landmark)}
                className="block w-full text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-serif text-sm tracking-[0.08em]">{landmark.name}</span>
                  <span
                    className={`border px-1.5 py-0.5 text-[9px] tracking-[0.14em] ${
                      landmark.category === 'must_visit'
                        ? 'border-[var(--city-primary)] text-[var(--city-primary)]'
                        : 'text-[var(--text-secondary)] hairline'
                    }`}
                  >
                    {CATEGORY_LABELS[landmark.category]}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {landmark.reason}
                </p>
              </button>
              <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-[var(--text-secondary)]">
                <span className="mono">
                  {landmark.coordinates
                    ? `${landmark.coordinates[1].toFixed(3)}, ${landmark.coordinates[0].toFixed(3)}`
                    : '全域印记'}
                </span>
                <span>{landmark.coordinates ? COORD_SOURCE_LABELS[landmark.coordSource] : '坐标待考'}</span>
                <SourceBadge sourceRefs={landmark.sourceRefs} sources={sources} />
              </div>
              {landmark.bestSeason !== '待考' ? (
                <p className="mt-1 text-[9px] text-[var(--text-secondary)]">
                  最佳时节 · {landmark.bestSeason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="order-1 lg:order-2 lg:sticky lg:top-24">
          <DeferredCityMap
            cityId={cityId}
            cityName={cityName}
            center={center}
            points={points}
            scope="landmarks"
            selectedId={selected}
            onSelect={setSelected}
            heightClass="h-[280px] w-full md:h-[420px] lg:h-[min(600px,calc(100vh-140px))]"
            ariaLabel={`${cityName}景点地图`}
          />
        </div>
      </div>
    </div>
  );
}
