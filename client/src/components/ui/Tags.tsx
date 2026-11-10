/** 「待考」与「AI 整理」标记（PRD 2.3）。 */

export function PendingTag({ label = '待考' }: { label?: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px] tracking-[0.18em] text-[var(--text-secondary)] hairline">
      {label}
    </span>
  );
}

export function AiTag({ label = 'AI 整理' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] tracking-[0.12em] text-[var(--text-secondary)] hairline">
      <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-[var(--city-accent)]" />
      {label}
    </span>
  );
}

export function VerificationTag({ status }: { status: 'verified_by_source' | 'pending_human_review' | 'preset_manual' }) {
  const text =
    status === 'verified_by_source'
      ? '来源可核验'
      : status === 'preset_manual'
        ? '人工整理'
        : '待人工复核';
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] tracking-[0.14em] ${
        status === 'verified_by_source'
          ? 'border-[var(--city-primary)] text-[var(--city-primary)]'
          : 'text-[var(--text-secondary)] hairline'
      }`}
    >
      {text}
    </span>
  );
}
