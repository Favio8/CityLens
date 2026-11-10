/** 02 前世今生：竖向年代轴，可联动景点地图。 */
import type { ChronicleItem, SourceRef } from '@citylens/shared/schema';
import { focusMap } from '../../lib/mapFocus';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { VerificationTag } from '../ui/Tags';

export function ChronicleModule({ data, sources }: { data: ChronicleItem[]; sources: SourceRef[] }) {
  return (
    <ol className="relative ml-2 border-l pl-6 hairline md:ml-4 md:pl-10">
      {data.map((item, index) => (
        <Reveal as="li" key={`${item.eraName}-${item.startYear}`} delay={index * 0.05} className="relative pb-10 last:pb-0">
          <span
            aria-hidden
            className="absolute -left-[31px] top-2 h-2.5 w-2.5 rounded-full border-2 md:-left-[47px]"
            style={{ borderColor: 'var(--city-primary)', background: 'var(--bg-canvas)' }}
          />
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-serif text-xl tracking-[0.12em] md:text-2xl">{item.eraName}</h3>
            {item.epithet ? (
              <span className="text-[10px] tracking-[0.16em] text-[var(--city-primary)]">{item.epithet}</span>
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
                            lng: item.centerCoord[0],
                            lat: item.centerCoord[1],
                            label: `${item.eraName} · ${item.ancientCityName}`,
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
  );
}
