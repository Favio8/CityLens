/**
 * 长图海报对话框（P2-22）：Canvas 原生绘制，零外部图片 CDN；
 * 支持下载 PNG；移动端同屏展示图片供长按保存。
 */
import { useEffect, useRef, useState } from 'react';
import type { CityArchiveResponse } from '@citylens/shared/schema';
import { buildPosterSpec, posterFileName, renderPoster } from '../../lib/poster';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export function PosterDialog({
  open,
  archive,
  onClose,
}: {
  open: boolean;
  archive: CityArchiveResponse | null;
  onClose: () => void;
}) {
  const close = (): void => onClose();
  const dialogRef = useFocusTrap(open, close);
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || !archive) return;
    try {
      const canvas = renderPoster(buildPosterSpec(archive));
      setPreview(canvas.toDataURL('image/png'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [open, archive]);

  if (!open) return null;

  const download = (): void => {
    if (!archive) return;
    const canvas = renderPoster(buildPosterSpec(archive));
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = posterFileName(buildPosterSpec(archive));
      anchor.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
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
        aria-labelledby="poster-title"
        className="surface-card max-h-full w-full max-w-md overflow-y-auto rounded-md p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="eyebrow">导出长图</p>
        <h2 id="poster-title" className="mt-3 font-serif text-2xl tracking-[0.12em]">
          城市长图海报
        </h2>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          包含城名、人设、代表景点 / 文物 / 人物、关键统计、来源与生成时间；移动端可长按图片保存。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="ink-btn ink-btn--solid px-4 py-2 text-[11px]"
            onClick={download}
            disabled={!archive || failed}
          >
            下载 PNG
          </button>
        </div>
        {failed ? (
          <p className="mt-4 text-[11px] text-red-700" role="alert">
            当前环境无法渲染海报（Canvas 不可用）。
          </p>
        ) : preview ? (
          <img
            src={preview}
            alt="城市长图海报预览"
            className="mt-4 w-full rounded-sm border hairline"
          />
        ) : (
          <div className="mt-4 h-40 animate-pulse rounded-sm bg-[var(--border-subtle)]" aria-busy="true" />
        )}
      </div>
    </div>
  );
}
