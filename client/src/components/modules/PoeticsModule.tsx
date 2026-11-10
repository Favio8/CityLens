/** 06 诗词文脉：竖排诗笺、意象考据与地理联动。 */
import type { Poem, SourceRef } from '@citylens/shared/schema';
import { focusMap } from '../../lib/mapFocus';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { VerificationTag } from '../ui/Tags';

export function PoeticsModule({ data, sources }: { data: Poem[]; sources: SourceRef[] }) {
  return (
    <div className="space-y-5">
      {data.map((poem, index) => (
        <Reveal as="article" key={poem.poemId} delay={index * 0.05}>
          <div className="relative overflow-hidden rounded-md border p-6 md:p-8" style={{ background: 'var(--bg-surface)' }}>
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
                <span className="border px-2 py-1 text-[9px] tracking-[0.14em]" style={{ borderColor: 'var(--city-primary)', color: 'var(--city-primary)' }}>
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
              <p className="mt-6 max-w-3xl border-l-2 pl-4 text-xs leading-[1.95] text-[var(--text-secondary)]" style={{ borderColor: 'var(--city-accent)' }}>
                {poem.background}
              </p>
            ) : null}

            {poem.imageryMap.length > 0 ? (
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className="text-[10px] tracking-[0.2em] text-[var(--text-secondary)]">意象</span>
                {poem.imageryMap.map((imagery) => (
                  <button
                    key={imagery.word}
                    type="button"
                    onClick={() =>
                      imagery.coordinates
                        ? focusMap({
                            lng: imagery.coordinates[0],
                            lat: imagery.coordinates[1],
                            label: imagery.placeName ?? imagery.word,
                          })
                        : undefined
                    }
                    disabled={!imagery.isGeographic}
                    title={imagery.note}
                    className={`border px-2 py-1 text-[10px] tracking-[0.1em] hairline ${
                      imagery.isGeographic
                        ? 'text-[var(--city-primary)] hover:border-[var(--city-primary)]'
                        : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    {imagery.word}
                    <span className="ml-1 opacity-60">{imagery.note}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end">
              <SourceBadge sourceRefs={poem.sourceRefs} sources={sources} />
            </div>
          </div>
        </Reveal>
      ))}
    </div>
  );
}
