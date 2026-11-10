/**
 * 06 诗词文脉：竖排诗笺、意象悬停批注与诗境地图联动（AC-07）。
 * - 悬停地理意象：弹出批注气泡，并高亮/定位诗境地图上的对应点位；
 * - 泛指意象：只显示文学批注，不触发地图定位；
 * - 意象词均由后端按「原文逐字命中 + 本城地名库」生成，前端不额外推断。
 */
import { useMemo, useState, type FocusEvent, type MouseEvent } from 'react';
import type { Coord, Poem, SourceRef } from '@citylens/shared/schema';
import { focusMap } from '../../lib/mapFocus';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { VerificationTag } from '../ui/Tags';
import { CityMap, type CityMapPoint } from './CityMap';

interface BubbleState {
  note: string;
  isGeographic: boolean;
  x: number;
  y: number;
}

export function PoeticsModule({
  cityId,
  cityName,
  center,
  data,
  sources,
}: {
  cityId: string;
  cityName: string;
  center: [number, number];
  data: Poem[];
  sources: SourceRef[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [bubble, setBubble] = useState<BubbleState | null>(null);

  const points = useMemo<CityMapPoint[]>(() => {
    const result: CityMapPoint[] = [];
    for (const poem of data) {
      for (const imagery of poem.imageryMap) {
        if (imagery.isGeographic && imagery.coordinates) {
          result.push({
            id: `${poem.poemId}:${imagery.word}`,
            name: imagery.placeName ?? imagery.word,
            coordinates: imagery.coordinates as Coord,
            kindLabel: `《${poem.title}》`,
          });
        }
      }
    }
    return result;
  }, [data]);

  const showBubble = (
    event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>,
    note: string,
    isGeographic: boolean,
  ): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    setBubble({ note, isGeographic, x: rect.left + rect.width / 2, y: rect.top });
  };

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-xs leading-relaxed text-[var(--text-secondary)]">
        诗题、作者、朝代与正文逐字取自本地诗词库。悬停带虚线的意象词可查看批注；地理意象会同步高亮诗境地图上的点位。
      </p>

      {points.length > 0 ? (
        <div>
          <p className="mb-3 text-[10px] tracking-[0.2em] text-[var(--text-secondary)]">
            诗境地图 · 悬停意象词即定位
          </p>
          <CityMap
            cityId={cityId}
            cityName={cityName}
            center={center}
            points={points}
            scope="poetics"
            selectedId={selected}
            onSelect={setSelected}
            heightClass="h-[240px] md:h-[320px]"
            ariaLabel={`${cityName}诗境地图`}
          />
        </div>
      ) : (
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
          本城诗词暂无可核验的地理意象坐标，未绘制诗境地图；文学批注仍可悬停查看。
        </p>
      )}

      {data.map((poem, index) => (
        <Reveal as="article" key={poem.poemId} delay={index * 0.05}>
          <div
            className="relative overflow-hidden rounded-md border p-6 md:p-8"
            style={{ background: 'var(--bg-surface)' }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute right-4 top-2 select-none font-serif text-[120px] leading-none text-[var(--city-primary)] opacity-[0.05]"
            >
              〝
            </span>

            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-serif text-2xl tracking-[0.12em] md:text-3xl">{poem.title}</h3>
                <p className="mt-2 text-[11px] tracking-[0.16em] text-[var(--text-secondary)]">
                  {poem.dynasty} · {poem.author}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="border px-2 py-1 text-[9px] tracking-[0.14em]"
                  style={{ borderColor: 'var(--city-primary)', color: 'var(--city-primary)' }}
                >
                  {poem.relationType === 'direct' ? '写于此城' : '写及此地'}
                </span>
                <VerificationTag status={poem.verification} />
              </div>
            </div>

            <div className="mt-6 overflow-x-auto">
              <div className="flex min-w-max flex-row-reverse items-start justify-center gap-3 md:mx-auto md:h-[260px] md:gap-5">
                {poem.lines.map((line) => (
                  <p
                    key={line}
                    className="poem-line font-serif text-lg leading-[2] tracking-[0.18em] md:text-xl md:leading-[1.9]"
                  >
                    {line}
                  </p>
                ))}
              </div>
            </div>

            {poem.background !== '待考' ? (
              <p
                className="mt-6 max-w-3xl border-l-2 pl-4 text-xs leading-[1.95] text-[var(--text-secondary)]"
                style={{ borderColor: 'var(--city-accent)' }}
              >
                {poem.background}
              </p>
            ) : null}

            {poem.imageryMap.length > 0 ? (
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className="text-[10px] tracking-[0.2em] text-[var(--text-secondary)]">意象</span>
                {poem.imageryMap.map((imagery) => {
                  const key = `${poem.poemId}:${imagery.word}`;
                  const geographic = imagery.isGeographic && imagery.coordinates !== null;
                  return (
                    <button
                      key={imagery.word}
                      type="button"
                      aria-label={`${imagery.word}：${imagery.note}`}
                      onMouseEnter={(event) => {
                        showBubble(event, imagery.note, imagery.isGeographic);
                        if (geographic) {
                          setSelected(key);
                          focusMap({
                            scope: 'poetics',
                            lng: imagery.coordinates?.[0],
                            lat: imagery.coordinates?.[1],
                            label: imagery.placeName ?? imagery.word,
                            scroll: false,
                          });
                        }
                      }}
                      onFocus={(event) => showBubble(event, imagery.note, imagery.isGeographic)}
                      onMouseLeave={() => setBubble(null)}
                      onBlur={() => setBubble(null)}
                      onClick={() => {
                        if (!geographic) return;
                        setSelected(key);
                        focusMap({
                          scope: 'poetics',
                          lng: imagery.coordinates?.[0],
                          lat: imagery.coordinates?.[1],
                          label: imagery.placeName ?? imagery.word,
                          scroll: false,
                        });
                      }}
                      className={`border-b border-dotted px-1 py-0.5 text-[10px] tracking-[0.1em] transition-colors ${
                        imagery.isGeographic
                          ? 'border-[var(--city-primary)] text-[var(--city-primary)]'
                          : 'border-[var(--text-secondary)] text-[var(--text-secondary)]'
                      } ${selected === key ? 'bg-[var(--city-primary)]/10' : ''}`}
                    >
                      {imagery.word}
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end">
              <SourceBadge sourceRefs={poem.sourceRefs} sources={sources} />
            </div>
          </div>
        </Reveal>
      ))}

      {bubble ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 w-64 -translate-x-1/2 -translate-y-full rounded-sm border bg-[var(--bg-elevated)] p-3 text-[11px] leading-relaxed shadow-lg hairline"
          style={{ left: bubble.x, top: bubble.y - 8 }}
        >
          <p className="text-[var(--text-primary)]">{bubble.note}</p>
          <p className="mt-1 text-[9px] tracking-[0.14em] text-[var(--text-secondary)]">
            {bubble.isGeographic ? '地理意象 · 已同步诗境地图' : '泛指意象 · 不触发地图'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
