/** 04 文物重器：博物馆标签式卡片。 */
import type { Relic, SourceRef } from '@citylens/shared/schema';
import { focusMap } from '../../lib/mapFocus';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { PendingTag, VerificationTag } from '../ui/Tags';

export function RelicsModule({ data, sources }: { data: Relic[]; sources: SourceRef[] }) {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {data.map((relic, index) => (
        <Reveal as="article" key={relic.registryId} delay={index * 0.05}>
          <div className="group relative flex h-full flex-col overflow-hidden rounded-md border p-6 transition-colors hover:border-[var(--city-primary)] hairline" style={{ background: 'var(--bg-surface)' }}>
            <span
              aria-hidden
              className="pointer-events-none absolute -right-2 -top-6 select-none font-serif text-[86px] leading-none text-[var(--city-primary)] opacity-[0.06] transition-opacity duration-500 group-hover:opacity-[0.12]"
            >
              {relic.era.slice(0, 1)}
            </span>

            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="mono text-[9px] tracking-[0.16em] text-[var(--text-secondary)]">{relic.registryId}</span>
                <h3 className="mt-2 font-serif text-2xl tracking-[0.12em]">{relic.name}</h3>
              </div>
              <span className="shrink-0 border px-2 py-1 text-[9px] tracking-[0.14em]" style={{ borderColor: 'var(--city-accent)', color: 'var(--city-primary)' }}>
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

            <p className="mt-4 flex-1 text-xs leading-[1.95] text-[var(--text-primary)]">{relic.story}</p>

            <div className="mt-5 flex items-center justify-between gap-2 border-t pt-3 hairline">
              <div className="flex items-center gap-2">
                <VerificationTag status={relic.verification} />
                {relic.coordinates ? (
                  <button
                    type="button"
                    className="ink-link text-[10px] text-[var(--city-primary)]"
                    onClick={() =>
                      relic.coordinates
                        ? focusMap({ lng: relic.coordinates[0], lat: relic.coordinates[1], label: relic.name })
                        : undefined
                    }
                  >
                    图上寻迹 →
                  </button>
                ) : null}
              </div>
              <SourceBadge sourceRefs={relic.sourceRefs} sources={sources} />
            </div>
          </div>
        </Reveal>
      ))}
    </div>
  );
}
