/** 04 文物重器：博物馆标签式卡片 + 内嵌坐标地图（AC-06）。 */
import { useEffect, useMemo, useState } from 'react';
import type { Relic, SourceRef } from '@citylens/shared/schema';
import { focusMap } from '../../lib/mapFocus';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { PendingTag, VerificationTag } from '../ui/Tags';
import { CityMap, type CityMapPoint } from './CityMap';

export function RelicsModule({
  cityId,
  cityName,
  center,
  data,
  sources,
}: {
  cityId: string;
  cityName: string;
  center: [number, number];
  data: Relic[];
  sources: SourceRef[];
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const points = useMemo<CityMapPoint[]>(
    () =>
      data.flatMap((relic) =>
        relic.coordinates
          ? [
              {
                id: relic.registryId,
                name: relic.name,
                coordinates: relic.coordinates,
                kindLabel: relic.era,
              },
            ]
          : [],
      ),
    [data],
  );

  useEffect(() => {
    if (!selected) return;
    document
      .getElementById(`relic-card-${selected}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selected]);

  return (
    <div>
      {points.length > 0 ? (
        <div className="mb-6">
          <p className="mb-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            文物与遗址坐标统一为 WGS84。点击卡片「图上寻迹」定位；点击地图标记回到对应卡片。
          </p>
          <CityMap
            cityId={cityId}
            cityName={cityName}
            center={center}
            points={points}
            scope="relics"
            selectedId={selected}
            onSelect={setSelected}
            heightClass="h-[240px] md:h-[320px]"
            ariaLabel={`${cityName}文物地图`}
          />
        </div>
      ) : (
        <p className="mb-6 text-xs leading-relaxed text-[var(--text-secondary)]">
          本城文物暂无可核验坐标，未绘制地图点位；条目不臆测位置。
        </p>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {data.map((relic, index) => (
          <Reveal as="article" key={relic.registryId} delay={index * 0.05}>
            <div
              id={`relic-card-${relic.registryId}`}
              className={`group relative flex h-full scroll-mt-24 flex-col overflow-hidden rounded-md border p-6 transition-colors hairline ${
                selected === relic.registryId
                  ? 'border-[var(--city-primary)] bg-[var(--city-primary)]/5'
                  : 'hover:border-[var(--city-primary)]'
              }`}
              style={{ background: selected === relic.registryId ? undefined : 'var(--bg-surface)' }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute -right-2 -top-6 select-none font-serif text-[86px] leading-none text-[var(--city-primary)] opacity-[0.06] transition-opacity duration-500 group-hover:opacity-[0.12]"
              >
                {relic.era.slice(0, 1)}
              </span>

              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="mono text-[9px] tracking-[0.16em] text-[var(--text-secondary)]">
                    {relic.registryId}
                  </span>
                  <h3 className="mt-2 font-serif text-2xl tracking-[0.12em]">{relic.name}</h3>
                </div>
                <span
                  className="shrink-0 border px-2 py-1 text-[9px] tracking-[0.14em]"
                  style={{ borderColor: 'var(--city-accent)', color: 'var(--city-primary)' }}
                >
                  {relic.protectionLevel}
                </span>
              </div>

              <dl className="mt-5 grid grid-cols-[64px_1fr] gap-y-2 text-[11px]">
                <dt className="text-[var(--text-secondary)]">年代</dt>
                <dd>{relic.era}</dd>
                <dt className="text-[var(--text-secondary)]">藏地</dt>
                <dd>{relic.museumOrSite}</dd>
                <dt className="text-[var(--text-secondary)]">出土</dt>
                <dd>{relic.findSpot === '待考' ? <PendingTag /> : relic.findSpot}</dd>
              </dl>

              <p className="mt-4 flex-1 text-xs leading-[1.95] text-[var(--text-primary)]">
                {relic.story}
              </p>

              <div className="mt-5 flex items-center justify-between gap-2 border-t pt-3 hairline">
                <div className="flex items-center gap-2">
                  <VerificationTag status={relic.verification} />
                  {relic.coordinates ? (
                    <button
                      type="button"
                      className="ink-link text-[10px] text-[var(--city-primary)]"
                      onClick={() => {
                        if (!relic.coordinates) return;
                        setSelected(relic.registryId);
                        focusMap({
                          scope: 'relics',
                          lng: relic.coordinates[0],
                          lat: relic.coordinates[1],
                          label: relic.name,
                          scroll: false,
                        });
                      }}
                    >
                      图上寻迹 →
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ink-link text-[10px] text-[var(--text-secondary)]"
                      onClick={() => focusMap({ scope: 'relics', reset: true, scroll: false })}
                    >
                      全域印记 · 复位地图
                    </button>
                  )}
                </div>
                <SourceBadge sourceRefs={relic.sourceRefs} sources={sources} />
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}
