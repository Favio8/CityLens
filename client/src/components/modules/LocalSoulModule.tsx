/** 07 城市性格：烟火、方言、非遗与节令（AI 整理，标注待人工复核）。 */
import type { LocalSoul, SourceRef } from '@citylens/shared/schema';
import { AiTag, PendingTag } from '../ui/Tags';
import { SourceBadge } from '../ui/SourceBadge';
import { Reveal } from '../ui/Reveal';

const ICH_LABELS = { national: '国家级', provincial: '省级', 待考: '待考' } as const;

export function LocalSoulModule({ data, sources }: { data: LocalSoul; sources: SourceRef[] }) {
  return (
    <div>
      <div className="mb-8 flex flex-col gap-2 rounded-sm border-l-2 bg-[var(--city-primary)]/5 py-3 pl-4 pr-3 md:flex-row md:items-center md:justify-between" style={{ borderColor: 'var(--city-primary)' }}>
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
          本卷由 AI 依据可考资料整理，可能存在口味与习俗的地域差异；页面底部已标注来源说明，欢迎核对原始资料。
        </p>
        <AiTag />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Reveal>
          <div className="h-full rounded-md border p-6 hairline" style={{ background: 'var(--bg-surface)' }}>
            <h3 className="font-serif text-lg tracking-[0.16em]">街头烟火</h3>
            <ul className="mt-5 space-y-4">
              {data.foods.map((food) => (
                <li key={food.name} className="group flex gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center border font-serif text-lg transition-colors group-hover:border-[var(--city-primary)] group-hover:text-[var(--city-primary)] hairline">
                    {food.name.slice(0, 1)}
                  </span>
                  <div>
                    <p className="font-serif text-sm tracking-[0.1em]">{food.name}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                      {food.flavor} · {food.origin}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="h-full rounded-md border p-6 hairline" style={{ background: 'var(--bg-surface)' }}>
            <h3 className="font-serif text-lg tracking-[0.16em]">方言里的城</h3>
            <ul className="mt-5 divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
              {data.dialects.map((dialect) => (
                <li key={dialect.word} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-baseline gap-3">
                    <span className="font-serif text-lg">{dialect.word}</span>
                    <span className="mono text-[10px] text-[var(--city-primary)]">{dialect.pronunciation}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{dialect.meaning}</p>
                  <p className="mt-1 font-serif text-xs leading-relaxed">「{dialect.example}」</p>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="h-full rounded-md border p-6 hairline" style={{ background: 'var(--bg-surface)' }}>
            <h3 className="font-serif text-lg tracking-[0.16em]">非遗与手艺</h3>
            <ul className="mt-5 space-y-4">
              {data.ichItems.map((item) => (
                <li key={item.name}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-serif text-sm tracking-[0.08em]">{item.name}</span>
                    <span
                      className={`border px-1.5 py-0.5 text-[9px] tracking-[0.12em] ${
                        item.level === 'national'
                          ? 'border-[var(--city-primary)] text-[var(--city-primary)]'
                          : 'text-[var(--text-secondary)] hairline'
                      }`}
                    >
                      {item.level === '待考' ? <PendingTag label="等级待考" /> : ICH_LABELS[item.level]}
                    </span>
                    <SourceBadge sourceRefs={item.sourceRefs} sources={sources} />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">{item.intro}</p>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={0.15}>
          <div className="h-full rounded-md border p-6 hairline" style={{ background: 'var(--bg-surface)' }}>
            <h3 className="font-serif text-lg tracking-[0.16em]">四时节令</h3>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {data.festivals.map((festival) => (
                <li key={festival.name} className="rounded-sm border p-3 hairline">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-serif text-sm">{festival.name}</span>
                    <span className="text-[9px] tracking-[0.14em] text-[var(--city-primary)]">{festival.season}</span>
                  </div>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--text-secondary)]">{festival.custom}</p>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
