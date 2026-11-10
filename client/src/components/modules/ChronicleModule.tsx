/**
 * 02 前世今生：朝代滑块 + 古称水印 + 竖向年代轴（AC-05）。
 * 拖动滑块同时切换朝代、城名、叙事与地图上的今日遗存参照点；
 * 参照点来自本城地名库，若该朝代今日遗存无坐标则明确标「待考」，不做推测。
 */
import { useEffect, useRef, useState } from 'react';
import type { ChronicleItem, SourceRef } from '@citylens/shared/schema';
import { focusMap } from '../../lib/mapFocus';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { VerificationTag } from '../ui/Tags';

export function ChronicleModule({ data, sources }: { data: ChronicleItem[]; sources: SourceRef[] }) {
  const [active, setActive] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const current = data[Math.min(active, data.length - 1)];

  const selectEra = (index: number): void => {
    setActive(index);
    const target = data[index];
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      if (target?.centerCoord) {
        focusMap({
          scope: 'landmarks',
          lng: target.centerCoord[0],
          lat: target.centerCoord[1],
          label: `${target.eraName} · ${target.relicToday}`,
          scroll: false,
        });
      }
    });
  };

  return (
    <div>
      <div
        className="relative mb-8 overflow-hidden rounded-md border p-5 md:p-7 hairline"
        style={{ background: 'var(--bg-surface)' }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute -right-4 -top-10 select-none font-serif text-[140px] leading-none text-[var(--city-primary)] opacity-[0.06] transition-all duration-700 md:text-[200px]"
        >
          {current?.ancientCityName}
        </span>

        <div className="relative">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--text-secondary)]">
                拖动朝代滑块 · 古今叠压
              </p>
              <p className="mt-2 font-serif text-2xl tracking-[0.14em] md:text-3xl">
                {current?.eraName}
                <span className="ml-3 text-[11px] tracking-[0.16em] text-[var(--city-primary)]">
                  {current?.ancientCityName}
                </span>
              </p>
            </div>
            <span className="mono text-[10px] tracking-[0.14em] text-[var(--text-secondary)]">
              {current?.periodRange}
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={Math.max(data.length - 1, 0)}
            step={1}
            value={active}
            onChange={(event) => selectEra(Number(event.target.value))}
            aria-label="朝代滑块"
            aria-valuetext={`${current?.eraName ?? ''} ${current?.periodRange ?? ''}`}
            className="mt-5 w-full cursor-pointer accent-[var(--city-primary)]"
          />
          <div className="mt-2 flex justify-between gap-1">
            {data.map((item, index) => (
              <button
                key={`${item.eraName}-${item.startYear}`}
                type="button"
                onClick={() => selectEra(index)}
                className={`text-[10px] tracking-[0.1em] transition-colors ${
                  index === active
                    ? 'text-[var(--city-primary)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                aria-pressed={index === active}
              >
                {item.eraName}
              </button>
            ))}
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-[1fr_220px]">
            <p className="text-sm leading-[1.95] text-[var(--text-primary)]">{current?.keyEvents}</p>
            <div className="space-y-2 rounded-sm border p-3 text-[11px] hairline">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-secondary)]">彼时城名</span>
                <span className="font-serif tracking-[0.1em]">{current?.ancientCityName}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-secondary)]">今日遗存</span>
                <span className="text-right">{current?.relicToday}</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-t pt-2 hairline">
                <span className="text-[var(--text-secondary)]">图上参照</span>
                {current?.centerCoord ? (
                  <button
                    type="button"
                    className="ink-link text-[var(--city-primary)]"
                    onClick={() =>
                      current.centerCoord
                        ? focusMap({
                            scope: 'landmarks',
                            lng: current.centerCoord[0],
                            lat: current.centerCoord[1],
                            label: `${current.eraName} · ${current.relicToday}`,
                          })
                        : undefined
                    }
                  >
                    今日遗存坐标 →
                  </button>
                ) : (
                  <span className="text-[var(--text-secondary)]">坐标待考</span>
                )}
              </div>
              <p className="text-[9px] leading-relaxed text-[var(--text-secondary)]">
                图上点位取自今日遗存，不代表古代城址中心。
              </p>
            </div>
          </div>
        </div>
      </div>

      <ol className="relative ml-2 border-l pl-6 hairline md:ml-4 md:pl-10">
        {data.map((item, index) => (
          <Reveal
            as="li"
            key={`${item.eraName}-${item.startYear}`}
            delay={index * 0.05}
            className={`relative pb-10 last:pb-0 ${
              index === active ? 'opacity-100' : 'opacity-90'
            }`}
          >
            <span
              aria-hidden
              className="absolute -left-[31px] top-2 h-2.5 w-2.5 rounded-full border-2 md:-left-[47px]"
              style={{
                borderColor: 'var(--city-primary)',
                background: index === active ? 'var(--city-primary)' : 'var(--bg-canvas)',
              }}
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-serif text-xl tracking-[0.12em] md:text-2xl">{item.eraName}</h3>
              {item.epithet ? (
                <span className="text-[10px] tracking-[0.16em] text-[var(--city-primary)]">
                  {item.epithet}
                </span>
              ) : null}
              <span className="mono text-[10px] tracking-[0.1em] text-[var(--text-secondary)]">
                {item.periodRange}
              </span>
            </div>

            <div className="mt-3 grid gap-4 md:grid-cols-[1fr_220px]">
              <div>
                <p className="text-sm leading-[1.95] text-[var(--text-primary)]">{item.keyEvents}</p>
                <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
                  今日遗存 · {item.relicToday}
                </p>
              </div>
              <div className="space-y-2 rounded-sm border p-3 text-[11px] hairline">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--text-secondary)]">彼时城名</span>
                  <span className="font-serif tracking-[0.1em]">{item.ancientCityName}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--text-secondary)]">定位</span>
                  {item.centerCoord ? (
                    <button
                      type="button"
                      className="ink-link text-[var(--city-primary)]"
                      onClick={() =>
                        item.centerCoord
                          ? focusMap({
                              scope: 'landmarks',
                              lng: item.centerCoord[0],
                              lat: item.centerCoord[1],
                              label: `${item.eraName} · ${item.relicToday}`,
                            })
                          : undefined
                      }
                    >
                      图上寻迹 →
                    </button>
                  ) : (
                    <span className="text-[var(--text-secondary)]">待考</span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <VerificationTag status={item.verification} />
                  <SourceBadge sourceRefs={item.sourceRefs} sources={sources} />
                </div>
              </div>
            </div>
          </Reveal>
        ))}
      </ol>
    </div>
  );
}
