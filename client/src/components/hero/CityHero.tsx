/** 城市卷首：城名、古称、坐标、显影进度与操作。 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CityArchiveResponse, Meta } from '@citylens/shared/schema';
import type { StreamPhase } from '../../hooks/useCityStream';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatCoord, formatDateTime } from '../../lib/format';
import { PosterDialog } from '../poster/PosterDialog';
import { InkCanvas } from './InkCanvas';

interface CityHeroProps {
  meta: Meta | null;
  phase: StreamPhase;
  moduleCount: number;
  fromCache: boolean;
  isFavorite: boolean;
  persona?: string | null;
  hint?: string | null;
  /** 完整档案（缓存命中时存在），用于导出长图海报。 */
  archive?: CityArchiveResponse | null;
  /** 来自流式状态机的致命错误提示（如冷却 / 限流），展示在操作卡片中。 */
  notice?: string | null;
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
  archive,
  notice,
  onToggleFavorite,
  onRegenerate,
}: CityHeroProps) {
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  // 缓存命中印章（PRD 2.2）：朱砂微标签停留 3 秒后渐隐，露出常驻「成卷时间」铭牌。
  const [cacheStamp, setCacheStamp] = useState(false);

  useEffect(() => {
    if (!fromCache || !meta) {
      setCacheStamp(false);
      return;
    }
    setCacheStamp(true);
    const timer = window.setTimeout(() => setCacheStamp(false), 3000);
    return () => window.clearTimeout(timer);
  }, [fromCache, meta]);

  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const streaming = phase === 'streaming_init' || phase === 'streaming_modules' || phase === 'reading';
  const statusText =
    phase === 'streaming_init'
      ? '方志官落笔中'
      : phase === 'streaming_modules'
        ? `已显影 ${moduleCount} / 8 卷`
        : fromCache
          ? '已为你复用'
          : '档案已成卷';

  const closeConfirm = useCallback(() => setConfirmOpen(false), []);
  const dialogRef = useFocusTrap(confirmOpen, closeConfirm);

  const share = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const requestRegenerate = (): void => {
    if (meta?.isPreset) {
      setPresetNotice('预置馆藏受保护：该城档案由构建期管线组装，不支持重新生成。');
      return;
    }
    setPresetNotice(null);
    setConfirmOpen(true);
  };

  const noticeText = presetNotice ?? notice ?? null;

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
              {fromCache ? (
                <span
                  className={`stamp transition-opacity duration-700 ${
                    cacheStamp ? 'opacity-100' : 'pointer-events-none opacity-0'
                  }`}
                  style={{ borderColor: 'var(--city-primary)', color: 'var(--city-primary)' }}
                >
                  藏书阁已收录 · 为你秒速展卷
                </span>
              ) : null}
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

              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onToggleFavorite}
                  className={`ink-btn col-span-2 px-3 py-2 text-[11px] ${isFavorite ? 'ink-btn--solid' : ''}`}
                  aria-pressed={isFavorite}
                  disabled={!meta}
                >
                  {isFavorite ? '已收入藏书阁' : '收入藏书阁'}
                </button>
                <button
                  type="button"
                  onClick={() => void share()}
                  className={`ink-btn px-3 py-2 text-[11px] ${onRegenerate ? '' : 'col-span-2'}`}
                  disabled={!meta}
                >
                  {copied ? '链接已复制' : '分享此卷'}
                </button>
                <span className="sr-only" role="status" aria-live="polite">
                  {copied ? '链接已复制到剪贴板' : ''}
                </span>
                {onRegenerate ? (
                  <button
                    type="button"
                    onClick={requestRegenerate}
                    className="ink-btn px-3 py-2 text-[11px]"
                    disabled={streaming || !meta}
                  >
                    重新生成
                  </button>
                ) : null}
                {meta ? (
                  <Link
                    to={`/compare?cities=${meta.cityId},`}
                    className="ink-btn px-3 py-2 text-center text-[11px]"
                  >
                    双城对比
                  </Link>
                ) : null}
                {meta ? (
                  <button
                    type="button"
                    onClick={() => setPosterOpen(true)}
                    className="ink-btn px-3 py-2 text-[11px]"
                    disabled={!archive}
                  >
                    导出长图
                  </button>
                ) : null}
              </div>
              {noticeText ? (
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--city-primary)]" role="status">
                  {noticeText}
                </p>
              ) : null}
            </div>
          </aside>
        </div>
      </div>

      {confirmOpen ? (
        <div
          className="fixed inset-0 z-[70] grid place-items-center bg-black/30 px-5 backdrop-blur-sm"
          role="presentation"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="regenerate-title"
            aria-describedby="regenerate-desc"
            className="surface-card w-full max-w-md rounded-md p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="eyebrow">重新展卷</p>
            <h2 id="regenerate-title" className="mt-3 font-serif text-2xl tracking-[0.12em]">
              重读此城？
            </h2>
            <p id="regenerate-desc" className="mt-3 text-xs leading-[1.9] text-[var(--text-secondary)]">
              将增量重新生成档案：已通过校验的模块原子替换，失败模块单独重试。
              同一城市 5 分钟内仅可重新生成一次，确认后可能消耗一次模型调用。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={() => setConfirmOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="ink-btn ink-btn--solid px-4 py-2 text-[11px]"
                onClick={() => {
                  setConfirmOpen(false);
                  onRegenerate?.();
                }}
              >
                确认重读
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <PosterDialog
        open={posterOpen}
        archive={archive ?? null}
        onClose={() => setPosterOpen(false)}
      />
    </section>
  );
}
