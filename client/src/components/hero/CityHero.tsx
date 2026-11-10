/** 城市卷首：城名、古称、坐标、显影进度与操作。 */
import { useState } from 'react';
import type { Meta } from '@citylens/shared/schema';
import type { StreamPhase } from '../../hooks/useCityStream';
import { formatCoord, formatDateTime } from '../../lib/format';
import { InkCanvas } from './InkCanvas';

interface CityHeroProps {
  meta: Meta | null;
  phase: StreamPhase;
  moduleCount: number;
  fromCache: boolean;
  isFavorite: boolean;
  persona?: string | null;
  hint?: string | null;
  onToggleFavorite: () => void;
  onRegenerate?: () => void;
}

export function CityHero({
  meta,
  phase,
  moduleCount,
  fromCache,
  isFavorite,
  persona,
  hint,
  onToggleFavorite,
  onRegenerate,
}: CityHeroProps) {
  const [copied, setCopied] = useState(false);
  const streaming = phase === 'streaming_init' || phase === 'streaming_modules' || phase === 'reading';
  const statusText =
    phase === 'streaming_init'
      ? '方志官落笔中'
      : phase === 'streaming_modules'
        ? `已显影 ${moduleCount} / 8 卷`
        : fromCache
          ? '馆藏已收录'
          : '档案已成卷';

  const share = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="relative overflow-hidden border-b hairline" aria-labelledby="city-title">
      <InkCanvas />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, transparent 0%, transparent 45%, color-mix(in srgb, var(--bg-canvas) 88%, transparent) 100%)',
        }}
      />
      <div className="page-shell relative pb-10 pt-14 md:pb-16 md:pt-20">
        <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-3">
              <span className="eyebrow">{meta ? `${meta.province} · ${meta.cityId}` : '方志官检索中'}</span>
              {meta?.isPreset ? <span className="stamp">预置馆藏</span> : null}
              {meta?.generator?.model.includes('mock') ? (
                <span className="text-[10px] tracking-[0.16em] text-[var(--text-secondary)]">模拟生成</span>
              ) : null}
            </div>

            <h1
              id="city-title"
              className="display-city mt-5 flex flex-wrap items-baseline gap-x-5 gap-y-2 text-[64px] md:text-[104px] xl:text-[124px]"
            >
              <span className="write-in">{meta?.standardName ?? '展卷'}</span>
              <span className="mono text-xs font-normal tracking-[0.2em] text-[var(--text-secondary)] md:text-sm">
                {meta ? formatCoord(meta.center) : 'WGS84'}
              </span>
            </h1>

            {meta && meta.aliases.length > 0 ? (
              <p className="mt-4 font-serif text-sm tracking-[0.18em] text-[var(--text-secondary)]">
                古称
                {meta.aliases.slice(0, 4).map((alias) => (
                  <span key={alias} className="ml-3 border-b border-dotted border-[var(--border-strong)] pb-0.5">
                    {alias}
                  </span>
                ))}
              </p>
            ) : null}

            {persona ? (
              <p className="mt-6 max-w-2xl font-serif text-base leading-[2] tracking-[0.04em] md:text-lg">
                {persona}
              </p>
            ) : null}

            {hint ? (
              <p
                className="mt-5 border-l-2 py-1 pl-3 text-xs leading-relaxed text-[var(--text-secondary)]"
                style={{ borderColor: 'var(--city-primary)' }}
              >
                {hint}
              </p>
            ) : null}

            {streaming ? (
              <div className="mt-8 max-w-md" aria-live="polite">
                <div className="mb-2 flex items-center justify-between text-[10px] tracking-[0.2em] text-[var(--text-secondary)]">
                  <span>{statusText}</span>
                  <span className="mono">{Math.round((moduleCount / 8) * 100)}%</span>
                </div>
                <div className="h-px w-full bg-[var(--border-subtle)]">
                  <div
                    className="h-px bg-[var(--city-primary)] transition-all duration-700"
                    style={{ width: `${(moduleCount / 8) * 100}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <aside className="w-full shrink-0 lg:w-72">
            <div className="surface-card rounded-md p-5">
              <div className="flex items-center justify-between">
                <span className="eyebrow">{statusText}</span>
                <span
                  className="grid h-9 w-9 rotate-[-3deg] place-items-center border-2 font-serif text-sm"
                  style={{ borderColor: 'var(--city-primary)', color: 'var(--city-primary)' }}
                  aria-hidden
                >
                  {meta?.isPreset ? '藏' : '读'}
                </span>
              </div>
              <dl className="mt-4 space-y-2.5 text-[11px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--text-secondary)]">数据版本</dt>
                  <dd className="mono">v{meta?.dataVersion ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--text-secondary)]">成卷时间</dt>
                  <dd className="mono">{meta ? formatDateTime(meta.generatedAt) : '—'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--text-secondary)]">档案状态</dt>
                  <dd className="mono">{meta?.status ?? '生成中'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--text-secondary)]">主题色</dt>
                  <dd className="flex gap-1.5">
                    <span className="h-3 w-3 rounded-full border border-black/10" style={{ background: 'var(--city-primary)' }} />
                    <span className="h-3 w-3 rounded-full border border-black/10" style={{ background: 'var(--city-secondary)' }} />
                    <span className="h-3 w-3 rounded-full border border-black/10" style={{ background: 'var(--city-accent)' }} />
                  </dd>
                </div>
              </dl>

              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onToggleFavorite}
                  className={`ink-btn flex-1 px-3 py-2 text-[11px] ${isFavorite ? 'ink-btn--solid' : ''}`}
                  aria-pressed={isFavorite}
                  disabled={!meta}
                >
                  {isFavorite ? '已收入藏书阁' : '收入藏书阁'}
                </button>
                <button type="button" onClick={() => void share()} className="ink-btn px-3 py-2 text-[11px]" disabled={!meta}>
                  {copied ? '链接已复制' : '分享此卷'}
                </button>
                {onRegenerate && !meta?.isPreset ? (
                  <button type="button" onClick={onRegenerate} className="ink-btn px-3 py-2 text-[11px]" disabled={streaming}>
                    重读此城
                  </button>
                ) : null}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
