/**
 * 海报预览与导出：动态加载 poster.ts + qrcode-generator，避免进入城市页首屏。
 */
import { useEffect, useMemo, useState } from 'react';
import type { CityArchiveResponse } from '@citylens/shared/schema';
import { buildPosterSpec, posterFileName, renderPoster } from '../../lib/poster';

export function PosterPreview({
  archive,
  shareUrl,
  onBack,
}: {
  archive: CityArchiveResponse;
  shareUrl: string;
  onBack: () => void;
}) {
  const spec = useMemo(() => buildPosterSpec(archive, shareUrl), [archive, shareUrl]);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    setCanvas(null);
    setPreview(null);
    setFailed(false);
    setStatus('');
    const render = async (): Promise<void> => {
      try {
        await Promise.race([
          document.fonts?.ready ?? Promise.resolve(),
          new Promise((resolve) => window.setTimeout(resolve, 1500)),
        ]);
        if (cancelled) return;
        const next = renderPoster(spec);
        if (cancelled) return;
        setCanvas(next);
        setPreview(next.toDataURL('image/png'));
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [spec]);

  const toBlob = (): Promise<Blob | null> =>
    new Promise((resolve) => {
      if (!canvas) {
        resolve(null);
        return;
      }
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });

  const download = async (): Promise<void> => {
    const blob = await toBlob();
    if (!blob) {
      setStatus('海报尚未生成完成，请稍候');
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = posterFileName(spec);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 延迟撤销：部分浏览器在 click 尚未落盘时撤销会得到空文件。
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus('海报已开始下载');
  };

  const shareImage = async (): Promise<void> => {
    const blob = await toBlob();
    if (!blob) {
      setStatus('海报尚未生成完成，请稍候');
      return;
    }
    const file = new File([blob], posterFileName(spec), { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `读城 · ${spec.cityName}`,
          text: spec.persona,
        });
      } else {
        await navigator.share({
          title: `读城 · ${spec.cityName}`,
          text: `${spec.cityName}的城市人文档案，扫码或点链接读城。`,
          url: shareUrl,
        });
      }
      setStatus('已唤起系统分享');
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setStatus('系统分享不可用，可改用下载 PNG');
    }
  };

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div>
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
        9:16 竖版海报，右下角二维码可直接扫码读城；移动端可长按图片保存。
      </p>

      <div className="mt-4 max-h-[58vh] overflow-y-auto rounded-sm border p-2 hairline">
        {failed ? (
          <p className="p-6 text-center text-[11px] text-red-700" role="alert">
            海报生成失败，请稍后重试。
          </p>
        ) : preview ? (
          <img src={preview} alt={`${spec.cityName}城市海报预览`} className="w-full rounded-sm" />
        ) : (
          <div className="h-64 animate-pulse rounded-sm bg-[var(--border-subtle)]" aria-busy="true" />
        )}
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={onBack}>
          返回
        </button>
        <button
          type="button"
          className="ink-btn ink-btn--solid px-4 py-2 text-[11px]"
          onClick={() => void download()}
          disabled={!canvas}
        >
          下载 PNG
        </button>
        {canNativeShare ? (
          <button
            type="button"
            className="ink-btn px-4 py-2 text-[11px]"
            onClick={() => void shareImage()}
            disabled={!canvas}
          >
            分享图片
          </button>
        ) : null}
      </div>
      <p className="mt-3 min-h-[1em] text-[11px] text-[var(--text-secondary)]" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
