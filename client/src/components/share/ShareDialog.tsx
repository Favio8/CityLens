/**
 * 分享此卷：一个入口，两个选择——复制链接 / 生成可扫码海报。
 * 海报预览按需动态加载，二维码完全在客户端生成。
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import type { CityArchiveResponse } from '@citylens/shared/schema';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { buildShareUrl } from '../../lib/share';

const PosterPreview = lazy(() =>
  import('./PosterPreview').then((module) => ({ default: module.PosterPreview })),
);

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  return ok;
}

export function ShareDialog({
  open,
  archive,
  onClose,
}: {
  open: boolean;
  archive: CityArchiveResponse | null;
  onClose: () => void;
}) {
  const dialogRef = useFocusTrap(open, onClose);
  const [view, setView] = useState<'menu' | 'poster'>('menu');
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    setView('menu');
    setCopied(false);
    setStatus('');
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!open) return null;

  const cityName = archive?.meta.standardName ?? '此城';
  const shareUrl = archive ? buildShareUrl(archive.meta.cityId) : '';
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const isLocal =
    typeof window !== 'undefined' &&
    ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

  const copyLink = async (): Promise<void> => {
    if (!shareUrl) return;
    let copiedOk = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        copiedOk = true;
      }
    } catch {
      copiedOk = false;
    }
    if (!copiedOk) {
      try {
        copiedOk = fallbackCopy(shareUrl);
      } catch {
        copiedOk = false;
      }
    }
    if (copiedOk) {
      setCopied(true);
      setStatus('链接已复制，去粘贴给朋友吧');
    } else {
      setStatus('复制失败，请手动选择下方链接');
    }
  };

  const nativeShare = async (): Promise<void> => {
    if (!shareUrl) return;
    try {
      await navigator.share({
        title: `读城 · ${cityName}`,
        text: `${cityName}的城市人文档案，八卷已展。`,
        url: shareUrl,
      });
      setStatus('已唤起系统分享');
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setStatus('系统分享不可用，可改用复制链接或海报');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/30 px-5 py-8 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="surface-card max-h-full w-full max-w-md overflow-y-auto rounded-md p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow">{view === 'menu' ? '分享此卷' : '生成海报'}</p>
            <h2 id="share-title" className="mt-3 font-serif text-2xl tracking-[0.12em]">
              {view === 'menu' ? `${cityName} · 分享` : `${cityName} · 城市海报`}
            </h2>
          </div>
          <button
            type="button"
            className="ink-btn shrink-0 px-3 py-1.5 text-[10px]"
            onClick={onClose}
            aria-label="关闭分享"
          >
            关闭
          </button>
        </div>

        {view === 'menu' ? (
          <>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              把这座城发给朋友，或生成一张带二维码的竖版海报；扫码即可读城。
            </p>

            <div className="mt-5 grid gap-3">
              <button
                type="button"
                onClick={() => void copyLink()}
                className="flex w-full items-center justify-between gap-4 rounded-md border p-4 text-left transition-colors hairline hover:border-[var(--city-primary)]"
              >
                <span>
                  <span className="block font-serif text-lg tracking-[0.08em]">
                    {copied ? '链接已复制' : '复制链接'}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    发送给朋友，或粘贴到微信、小红书、微博
                  </span>
                </span>
                <span aria-hidden className="mono text-xs text-[var(--city-primary)]">
                  →
                </span>
              </button>

              <button
                type="button"
                onClick={() => setView('poster')}
                disabled={!archive}
                className="flex w-full items-center justify-between gap-4 rounded-md border p-4 text-left transition-colors hairline hover:border-[var(--city-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>
                  <span className="block font-serif text-lg tracking-[0.08em]">生成海报</span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    9:16 竖版海报，右下角二维码可扫码读城
                  </span>
                </span>
                <span aria-hidden className="mono text-xs text-[var(--city-primary)]">
                  →
                </span>
              </button>
            </div>

            <input
              readOnly
              value={shareUrl || '档案加载中…'}
              aria-label="分享链接"
              onFocus={(event) => event.currentTarget.select()}
              className="mt-4 w-full rounded-sm border bg-transparent p-3 font-mono text-base leading-relaxed text-[var(--text-secondary)] hairline md:text-[10px]"
            />

            {isLocal ? (
              <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-secondary)]">
                当前为本地地址；手机扫码请用局域网 IP 或公网域名打开本页。
              </p>
            ) : null}

            {canNativeShare ? (
              <button
                type="button"
                className="ink-link mt-3 text-[11px] text-[var(--text-secondary)]"
                onClick={() => void nativeShare()}
              >
                用系统分享…
              </button>
            ) : null}

            <p
              className="mt-3 min-h-[1em] text-[11px] text-[var(--city-primary)]"
              role="status"
              aria-live="polite"
            >
              {status}
            </p>
          </>
        ) : null}

        {view === 'poster' && archive ? (
          <Suspense
            fallback={
              <div className="mt-4 h-64 animate-pulse rounded-sm bg-[var(--border-subtle)]" aria-busy="true" />
            }
          >
            <PosterPreview
              archive={archive}
              shareUrl={shareUrl}
              onBack={() => setView('menu')}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
