/** 来源徽章：只展示档案 sources 中真实存在的条目（PRD 2.3）。 */
import { useId, useState } from 'react';
import type { SourceRef } from '@citylens/shared/schema';

interface SourceBadgeProps {
  sourceRefs: string[];
  sources: SourceRef[];
}

export function SourceBadge({ sourceRefs, sources }: SourceBadgeProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const entries = sourceRefs
    .map((ref) => sources.find((source) => source.id === ref))
    .filter((entry): entry is SourceRef => Boolean(entry));

  if (entries.length === 0) {
    return <span className="text-[11px] tracking-widest text-[var(--text-secondary)]">[源暂缺]</span>;
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="border px-1.5 py-0.5 text-[10px] tracking-[0.2em] text-[var(--city-primary)] transition-colors hover:bg-[var(--city-primary)] hover:text-[var(--bg-canvas)]"
        style={{ borderColor: 'var(--city-primary)' }}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        onBlur={() => setOpen(false)}
      >
        [源]
      </button>
      {open ? (
        <span
          id={panelId}
          role="tooltip"
          className="surface-card absolute bottom-full left-0 z-30 mb-2 block w-64 rounded-md p-3 text-left text-[11px] leading-relaxed shadow-lg"
        >
          {entries.map((entry) => (
            <span key={entry.id} className="mb-2 block last:mb-0">
              <span className="block text-[var(--text-primary)]">{entry.title}</span>
              <span className="mono block text-[10px] text-[var(--text-secondary)]">
                {entry.type}
                {entry.url ? (
                  <>
                    {' · '}
                    <a
                      className="underline decoration-dotted underline-offset-2"
                      href={entry.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      原始链接
                    </a>
                  </>
                ) : null}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
