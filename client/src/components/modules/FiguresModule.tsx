/** 05 名人故里：人物卡、证据链与遗迹定位。 */
import type { Figure, SourceRef } from '@citylens/shared/schema';
import { EVIDENCE_LABELS } from '../../lib/labels';
import { focusMap } from '../../lib/mapFocus';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';
import { VerificationTag } from '../ui/Tags';

function year(value: number | '待考'): string {
  if (value === '待考') return '待考';
  return value < 0 ? `前 ${Math.abs(value)}` : `${value}`;
}

export function FiguresModule({ data, sources }: { data: Figure[]; sources: SourceRef[] }) {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {data.map((figure, index) => (
        <Reveal as="article" key={figure.entityRef} delay={index * 0.05}>
          <div className="flex h-full flex-col rounded-md border p-6 transition-colors hover:border-[var(--city-primary)] hairline" style={{ background: 'var(--bg-surface)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-serif text-2xl tracking-[0.16em]">{figure.name}</h3>
                <p className="mt-1 text-[10px] tracking-[0.14em] text-[var(--text-secondary)]">
                  {figure.dynasty === '待考' ? '朝代待考' : figure.dynasty} · {year(figure.birthYear)}—
                  {year(figure.deathYear)}
                </p>
              </div>
              <span className="shrink-0 border px-2 py-1 text-[9px] tracking-[0.14em] hairline">
                {figure.relationType === 'native' ? '桑梓' : '寓居'}
              </span>
            </div>

            <p className="mt-4 text-xs leading-[1.95]">{figure.cityBond}</p>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">{figure.highlights}</p>

            <div className="mt-4 flex flex-wrap gap-1.5">
              <span className="border px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-[var(--text-secondary)] hairline">
                {EVIDENCE_LABELS[figure.evidence.property]} · {figure.evidence.value}
              </span>
              {figure.sites.map((site) => (
                <button
                  key={site.placeName}
                  type="button"
                  onClick={() =>
                    site.coordinates
                      ? focusMap({ lng: site.coordinates[0], lat: site.coordinates[1], label: site.placeName })
                      : undefined
                  }
                  disabled={!site.coordinates}
                  className={`border px-1.5 py-0.5 text-[9px] tracking-[0.12em] hairline ${
                    site.coordinates ? 'hover:border-[var(--city-primary)] hover:text-[var(--city-primary)]' : 'opacity-60'
                  }`}
                >
                  {site.placeName}
                  {site.coordinates ? ' ↗' : ''}
                </button>
              ))}
            </div>

            <div className="mt-auto flex items-center justify-between gap-2 pt-4">
              <VerificationTag status={figure.verification} />
              <SourceBadge sourceRefs={figure.sourceRefs} sources={sources} />
            </div>
          </div>
        </Reveal>
      ))}
    </div>
  );
}
