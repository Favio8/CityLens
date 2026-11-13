/** 01 城市名片：面积、人口、气候、区划与城市人格。 */
import type { Identity, NumberFact, SourceRef, StringFact } from '@citylens/shared/schema';
import { SourceBadge } from '../ui/SourceBadge';
import { PendingTag, VerificationTag } from '../ui/Tags';
import { WeatherStrip } from './WeatherStrip';

interface IdentityModuleProps {
  data: Identity;
  sources: SourceRef[];
  cityId?: string;
}

function NumberTile({
  label,
  fact,
  sources,
  suffix,
}: {
  label: string;
  fact: NumberFact;
  sources: SourceRef[];
  suffix?: string;
}) {
  const pending = fact.value === '待考';
  return (
    <div className="flex h-full flex-col justify-between border-t pt-4 hairline">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] tracking-[0.24em] text-[var(--text-secondary)]">{label}</span>
        {fact.statYear ? <span className="mono text-[10px] text-[var(--text-secondary)]">{fact.statYear}</span> : null}
      </div>
      <div className="mt-4">
        <span className={`data-value ${pending ? 'font-serif text-2xl' : 'text-[34px] leading-none md:text-[44px]'}`}>
          {pending ? '待考' : fact.value}
        </span>
        {!pending && suffix ? (
          <span className="ml-1 text-xs text-[var(--text-secondary)]">{suffix}</span>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[10px] leading-relaxed text-[var(--text-secondary)]">
          {fact.caliber ?? fact.unit ?? ''}
        </span>
        <SourceBadge sourceRefs={fact.sourceRefs ?? []} sources={sources} />
      </div>
    </div>
  );
}

function StringTile({ label, fact, sources }: { label: string; fact: StringFact; sources: SourceRef[] }) {
  const pending = fact.value === '待考';
  return (
    <div className="flex h-full flex-col justify-between border-t pt-4 hairline">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] tracking-[0.24em] text-[var(--text-secondary)]">{label}</span>
        {fact.statYear ? <span className="mono text-[10px] text-[var(--text-secondary)]">{fact.statYear}</span> : null}
      </div>
      <p className={`mt-4 ${pending ? 'font-serif text-xl' : 'font-serif text-lg leading-relaxed tracking-[0.02em]'}`}>
        {pending ? '待考' : fact.value}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--text-secondary)]">{fact.caliber ?? ''}</span>
        <SourceBadge sourceRefs={fact.sourceRefs ?? []} sources={sources} />
      </div>
    </div>
  );
}

export function IdentityModule({ data, sources, cityId }: IdentityModuleProps) {
  const persona = typeof data.oneLinePersona === 'string' ? data.oneLinePersona : null;
  return (
    <div>
      {persona ? (
        <blockquote className="relative mb-10 max-w-4xl pl-6 md:pl-10">
          <span
            aria-hidden
            className="absolute left-0 top-0 font-serif text-5xl leading-none text-[var(--city-primary)] opacity-30"
          >
            “
          </span>
          <p className="quote-serif text-xl leading-[1.9] tracking-[0.04em] md:text-2xl">{persona}</p>
        </blockquote>
      ) : (
        <div className="mb-10 flex items-center gap-2">
          <PendingTag label="城市人格待考" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        <NumberTile label="面积" fact={data.area} sources={sources} suffix={data.area.unit ?? 'km²'} />
        <NumberTile label="常住人口" fact={data.population} sources={sources} suffix={data.population.unit ?? '万人'} />
        <StringTile label="气候" fact={data.climateType} sources={sources} />
        <StringTile label="行政区划" fact={data.adminDivisions} sources={sources} />
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-3 border-t pt-5 hairline">
        <span className="text-[10px] tracking-[0.24em] text-[var(--text-secondary)]">别称</span>
        {data.aliases.map((alias) => (
          <span key={alias} className="city-pill !py-1 text-[11px]">
            {alias}
          </span>
        ))}
        <span className="flex-1" />
        <span className="mono text-[10px] text-[var(--text-secondary)]">
          {data.center[0].toFixed(4)}, {data.center[1].toFixed(4)}
        </span>
        <VerificationTag status={data.verification} />
      </div>

      {cityId ? <WeatherStrip cityId={cityId} /> : null}
    </div>
  );
}
