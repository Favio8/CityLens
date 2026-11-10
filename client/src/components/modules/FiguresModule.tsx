/** 05 名人故里：人物卡、证据链、遗迹定位与内嵌地图（AC-06）。 */
import { useEffect, useMemo, useState } from 'react';
import type { Figure, SourceRef } from '@citylens/shared/schema';
import { EVIDENCE_LABELS } from '../../lib/labels';
import { focusMap } from '../../lib/mapFocus';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { VerificationTag } from '../ui/Tags';
import { CityMap, type CityMapPoint } from './CityMap';

function year(value: number | '待考'): string {
  if (value === '待考') return '待考';
  return value < 0 ? `前 ${Math.abs(value)}` : `${value}`;
}

export function FiguresModule({
  cityId,
  cityName,
  center,
  data,
  sources,
}: {
  cityId: string;
  cityName: string;
  center: [number, number];
  data: Figure[];
  sources: SourceRef[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedFigure = selected?.split('::')[0] ?? null;

  const points = useMemo<CityMapPoint[]>(
    () =>
      data.flatMap((figure) =>
        figure.sites.flatMap((site) =>
          site.coordinates
            ? [
                {
                  id: `${figure.entityRef}::${site.placeName}`,
                  name: site.placeName,
                  coordinates: site.coordinates,
                  kindLabel: figure.name,
                },
              ]
            : [],
        ),
      ),
    [data],
  );

  useEffect(() => {
    if (!selectedFigure) return;
    document
      .getElementById(`figure-card-${selectedFigure}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selectedFigure]);

  return (
    <div>
      {points.length > 0 ? (
        <div className="mb-6">
          <p className="mb-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            人物遗迹坐标统一为 WGS84。点击姓名下的地点标签或「图上寻迹」定位；点击地图标记回到对应人物卡。
          </p>
          <CityMap
            cityId={cityId}
            cityName={cityName}
            center={center}
            points={points}
            scope="figures"
            selectedId={selected}
            onSelect={setSelected}
            heightClass="h-[240px] md:h-[320px]"
            ariaLabel={`${cityName}名人遗迹地图`}
          />
        </div>
      ) : (
        <p className="mb-6 text-xs leading-relaxed text-[var(--text-secondary)]">
          本城人物暂无可核验的遗迹坐标，未绘制地图点位；条目不臆测位置。
        </p>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {data.map((figure, index) => {
          const firstSite = figure.sites.find((site) => site.coordinates);
          return (
            <Reveal as="article" key={figure.entityRef} delay={index * 0.05}>
              <div
                id={`figure-card-${figure.entityRef}`}
                className={`flex h-full scroll-mt-24 flex-col rounded-md border p-6 transition-colors hairline ${
                  selectedFigure === figure.entityRef
                    ? 'border-[var(--city-primary)] bg-[var(--city-primary)]/5'
                    : 'hover:border-[var(--city-primary)]'
                }`}
                style={{
                  background:
                    selectedFigure === figure.entityRef ? undefined : 'var(--bg-surface)',
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-serif text-2xl tracking-[0.16em]">{figure.name}</h3>
                    <p className="mt-1 text-[10px] tracking-[0.14em] text-[var(--text-secondary)]">
                      {figure.dynasty === '待考' ? '朝代待考' : figure.dynasty} ·{' '}
                      {year(figure.birthYear)}—{year(figure.deathYear)}
                    </p>
                  </div>
                  <span className="shrink-0 border px-2 py-1 text-[9px] tracking-[0.14em] hairline">
                    {figure.relationType === 'native' ? '桑梓' : '寓居'}
                  </span>
                </div>

                <p className="mt-4 text-xs leading-[1.95]">{figure.cityBond}</p>
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {figure.highlights}
                </p>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  <span className="border px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-[var(--text-secondary)] hairline">
                    {EVIDENCE_LABELS[figure.evidence.property]} · {figure.evidence.value}
                  </span>
                  {figure.sites.map((site) => (
                    <button
                      key={site.placeName}
                      type="button"
                      onClick={() => {
                        if (!site.coordinates) {
                          focusMap({ scope: 'figures', reset: true, scroll: false });
                          return;
                        }
                        setSelected(`${figure.entityRef}::${site.placeName}`);
                        focusMap({
                          scope: 'figures',
                          lng: site.coordinates[0],
                          lat: site.coordinates[1],
                          label: site.placeName,
                          scroll: false,
                        });
                      }}
                      className={`border px-1.5 py-0.5 text-[9px] tracking-[0.12em] hairline ${
                        site.coordinates
                          ? 'hover:border-[var(--city-primary)] hover:text-[var(--city-primary)]'
                          : 'opacity-60'
                      }`}
                    >
                      {site.placeName}
                      {site.coordinates ? ' ↗' : ' · 全域'}
                    </button>
                  ))}
                </div>

                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <div className="flex items-center gap-2">
                    <VerificationTag status={figure.verification} />
                    {firstSite?.coordinates ? (
                      <button
                        type="button"
                        className="ink-link text-[10px] text-[var(--city-primary)]"
                        onClick={() => {
                          if (!firstSite.coordinates) return;
                          setSelected(`${figure.entityRef}::${firstSite.placeName}`);
                          focusMap({
                            scope: 'figures',
                            lng: firstSite.coordinates[0],
                            lat: firstSite.coordinates[1],
                            label: firstSite.placeName,
                            scroll: false,
                          });
                        }}
                      >
                        图上寻迹 →
                      </button>
                    ) : null}
                  </div>
                  <SourceBadge sourceRefs={figure.sourceRefs} sources={sources} />
                </div>
              </div>
            </Reveal>
          );
        })}
      </div>
    </div>
  );
}
