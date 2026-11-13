/**
 * 城市分享海报（P2-22 升级）：750×1334 固定竖版 Canvas，零外部图片 CDN。
 * - buildPosterSpec：纯函数，从档案提取海报数据（缺失一律「待考」）；
 * - renderPoster：仅在浏览器调用，右下角绘制可扫码二维码；
 * - 海报代码由 ShareDialog 动态加载，不进入城市页首屏 chunk。
 */
import { PENDING, type CityArchiveResponse } from '@citylens/shared/schema';
import { createQrMatrix } from './qr';

export interface PosterSpec {
  cityName: string;
  cityId: string;
  province: string;
  coordinates: string;
  persona: string;
  aliases: string[];
  landmarks: string[];
  relics: string[];
  figures: string[];
  stats: Array<{ label: string; value: string }>;
  poems: Array<{ title: string; author: string; dynasty: string }>;
  poemLines: string[];
  generatedAt: string;
  sourceCount: number;
  isPreset: boolean;
  theme: { primary: string; secondary: string; accent: string };
  disclaimer: string;
  shareUrl: string;
}

const WIDTH = 750;
const HEIGHT = 1334;
const PADDING = 48;
const PAPER = '#f7f4ed';
const INK = '#1e1e1e';
const MUTED = '#5a564c';
const HAIRLINE = 'rgba(30, 30, 30, 0.16)';
const SERIF = '"Noto Serif SC", "Songti SC", serif';
const MONO = '"JetBrains Mono", "DIN Alternate", monospace';

function factText(value: unknown, unit?: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return unit ? `${value.toLocaleString('zh-CN')} ${unit}` : value.toLocaleString('zh-CN');
  }
  return PENDING;
}

function latestPoint(series: Array<{ year: number; value: number | null }>): { year: number; value: number } | null {
  const points = (series ?? []).filter(
    (point): point is { year: number; value: number } => typeof point.value === 'number',
  );
  return points.length > 0 ? (points[points.length - 1] ?? null) : null;
}

function formatCoord([lng, lat]: [number, number]): string {
  const latLabel = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
  const lngLabel = `${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
  return `${latLabel}, ${lngLabel}`;
}

/** 过滤诗题下的夹注/出处说明，只把真正的诗句放进海报。 */
function isNoteLine(line: string): boolean {
  const text = line.trim();
  if (!text) return true;
  if (/^[（(]/.test(text)) return true;
  if (text.includes('亦载此诗') || text.includes('题作') || text.includes('见元人')) return true;
  return false;
}

/** 从档案响应提取海报数据；模块缺失或字段为「待考」时如实呈现，不估算。 */
export function buildPosterSpec(archive: CityArchiveResponse, shareUrl: string): PosterSpec {
  const identity = archive.identity;
  const dataPulse = archive.dataPulse;
  const persona =
    identity && typeof identity.oneLinePersona === 'string' ? identity.oneLinePersona : PENDING;

  const stats: Array<{ label: string; value: string }> = [];
  if (dataPulse) {
    const gdp = latestPoint(dataPulse.gdpSeries);
    stats.push({
      label: gdp ? `地区生产总值（${gdp.year}）` : '地区生产总值',
      value: gdp ? factText(gdp.value, dataPulse.statMeta.gdp.unit) : PENDING,
    });
    const pop = latestPoint(dataPulse.popSeries);
    stats.push({
      label: pop ? `常住人口（${pop.year}）` : '常住人口',
      value: pop ? factText(pop.value, dataPulse.statMeta.pop.unit) : PENDING,
    });
  }
  if (identity && typeof identity.climateType.value === 'string') {
    stats.push({ label: '气候类型', value: identity.climateType.value });
  }

  const poemSource = (archive.poetics ?? []).find((poem) =>
    poem.lines.some((line) => line.trim() && !isNoteLine(line)),
  );
  const candidateLines = poemSource
    ? poemSource.lines.filter((line) => line.trim() && !isNoteLine(line))
    : [];
  // 优先使用短句（真正的近体诗句）；若整首都是长句，保留长句交给渲染层截断。
  const shortLines = candidateLines.filter(
    (line) => [...line.replace(/\s/g, '')].length <= 24,
  );
  const verseLines = shortLines.length > 0 ? shortLines : candidateLines;
  const palette = archive.meta.themePalette;
  return {
    cityName: archive.meta.standardName,
    cityId: archive.meta.cityId,
    province: archive.meta.province,
    coordinates: formatCoord(archive.meta.center),
    persona,
    aliases: archive.meta.aliases.slice(0, 3),
    landmarks: (archive.landmarks ?? []).slice(0, 1).map((item) => item.name),
    relics: (archive.relics ?? []).slice(0, 1).map((item) => `${item.name}（${item.era}）`),
    figures: (archive.figures ?? []).slice(0, 1).map((item) => item.name),
    stats,
    poems: poemSource
      ? [
          {
            title: poemSource.title,
            author: poemSource.author,
            dynasty: poemSource.dynasty,
          },
        ]
      : [],
    poemLines: verseLines.slice(-2),
    generatedAt: archive.meta.generatedAt,
    sourceCount: archive.sources.length,
    isPreset: archive.meta.isPreset,
    theme: {
      primary: palette.light.primary,
      secondary: palette.light.secondary,
      accent: palette.light.accent,
    },
    disclaimer: '内容由 AI 依据所列来源整理；重要事实请以原始来源为准。',
    shareUrl,
  };
}

export function posterFileName(spec: PosterSpec): string {
  const date = spec.generatedAt.slice(0, 10);
  return `读城-${spec.cityName}-${date}.png`;
}

function hairline(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color = HAIRLINE,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxSize: number,
  minSize: number,
  maxWidth: number,
  weight = '700',
): number {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${SERIF}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  return minSize;
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let output = text;
  while (output.length > 1 && ctx.measureText(`${output}…`).width > maxWidth) {
    output = output.slice(0, -1);
  }
  return `${output}…`;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const chars = [...text];
  const lines: string[] = [];
  let current = '';
  for (const char of chars) {
    const next = current + char;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = char;
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  const consumed = lines.join('').length;
  if (lines.length === maxLines && consumed < chars.length) {
    const last = lines[maxLines - 1] ?? '';
    let shortened = last;
    while (shortened.length > 0 && ctx.measureText(`${shortened}…`).width > maxWidth) {
      shortened = shortened.slice(0, -1);
    }
    lines[maxLines - 1] = `${shortened}…`;
  }
  return lines;
}

function drawSectionLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 16, 7, 18);
  ctx.font = `600 18px ${SERIF}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, x + 16, y);
  ctx.restore();
}

function drawSeal(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((-4 * Math.PI) / 180);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(-size / 2, -size / 2, size, size);
  ctx.fillStyle = color;
  ctx.font = `700 ${Math.round(size * 0.48)}px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 1);
  ctx.restore();
}

function drawQr(
  ctx: CanvasRenderingContext2D,
  matrix: boolean[][],
  x: number,
  y: number,
  size: number,
  dark: string,
): void {
  const quiet = 4;
  const total = matrix.length + quiet * 2;
  const moduleSize = Math.max(1, Math.floor(size / total));
  const drawn = moduleSize * total;
  const offsetX = x + Math.floor((size - drawn) / 2);
  const offsetY = y + Math.floor((size - drawn) / 2);

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = dark;
  for (let row = 0; row < matrix.length; row += 1) {
    for (let col = 0; col < matrix.length; col += 1) {
      if (matrix[row]?.[col]) {
        ctx.fillRect(
          offsetX + (col + quiet) * moduleSize,
          offsetY + (row + quiet) * moduleSize,
          moduleSize,
          moduleSize,
        );
      }
    }
  }
  ctx.restore();
}

function drawWatermark(ctx: CanvasRenderingContext2D, spec: PosterSpec): void {
  ctx.save();
  ctx.globalAlpha = 0.045;
  ctx.fillStyle = spec.theme.primary;
  ctx.font = `700 360px ${SERIF}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(spec.cityName.slice(0, 1), WIDTH - 34, HEIGHT - 110);
  ctx.restore();
}

/** 竖版海报：宣纸底 + 主题色题签 + 扫码区；仅在浏览器环境调用。 */
export function renderPoster(spec: PosterSpec): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  // Canvas 不可用时明确失败，由调用方展示降级提示，不返回空白画布让用户下载空图。
  if (!ctx) throw new Error('当前环境不支持 Canvas 渲染');

  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  ctx.textBaseline = 'alphabetic';

  // 纸面与外框
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = spec.theme.primary;
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, WIDTH - 40, HEIGHT - 40);
  ctx.restore();

  drawWatermark(ctx, spec);

  // 顶部品牌
  ctx.fillStyle = spec.theme.primary;
  ctx.font = `600 18px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText('CITYLENS / 读城', PADDING, 88);
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;
  ctx.font = `16px ${SERIF}`;
  ctx.fillText('城市人文档案', WIDTH - PADDING, 88);
  hairline(ctx, PADDING, 112, WIDTH - PADDING, 112);

  drawSeal(ctx, spec.cityName.slice(0, 1), WIDTH - 74, 182, 54, spec.theme.primary);

  // 城名与地理信息
  const citySize = fitFontSize(ctx, spec.cityName, 96, 64, 560);
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  ctx.font = `700 ${citySize}px ${SERIF}`;
  ctx.fillText(spec.cityName, WIDTH / 2, 272);

  ctx.font = `22px ${SERIF}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(`${spec.province} · ${spec.coordinates}`, WIDTH / 2, 318);

  if (spec.aliases.length > 0) {
    ctx.font = `22px ${SERIF}`;
    ctx.fillStyle = spec.theme.secondary;
    ctx.fillText(`古称 ${spec.aliases.join(' · ')}`, WIDTH / 2, 358);
  }

  // 人格引文
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = spec.theme.accent;
  ctx.font = `700 72px ${SERIF}`;
  ctx.textAlign = 'left';
  ctx.fillText('“', PADDING, 452);
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `28px ${SERIF}`;
  const persona = spec.persona === PENDING ? '城市人格待考' : spec.persona;
  const personaLines = wrapText(ctx, persona, WIDTH - PADDING * 2 - 32, 3);
  personaLines.forEach((line, index) => {
    ctx.fillText(line, PADDING + 28, 420 + index * 44);
  });
  hairline(ctx, PADDING, 552, WIDTH - PADDING, 552);

  // 城市切片
  drawSectionLabel(ctx, '城市切片', PADDING, 594, spec.theme.primary);
  const slices = [
    { label: '代表景点', value: spec.landmarks[0] ?? PENDING },
    { label: '文物重器', value: spec.relics[0] ?? PENDING },
    { label: '历史名人', value: spec.figures[0] ?? PENDING },
  ];
  const columnWidth = 190;
  const columnGap = 28;
  slices.forEach((slice, index) => {
    const x = PADDING + index * (columnWidth + columnGap);
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `16px ${SERIF}`;
    ctx.fillText(slice.label, x, 632);
    ctx.fillStyle = INK;
    ctx.font = `24px ${SERIF}`;
    const lines = wrapText(ctx, slice.value, columnWidth, 2);
    lines.forEach((line, lineIndex) => {
      ctx.fillText(line, x, 668 + lineIndex * 32);
    });
    if (index < slices.length - 1) {
      hairline(ctx, x + columnWidth + columnGap / 2, 612, x + columnWidth + columnGap / 2, 704);
    }
  });

  // 诗句中的城
  drawSectionLabel(ctx, '诗句中的城', PADDING, 760, spec.theme.primary);
  if (spec.poemLines.length > 0) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = spec.theme.accent;
    ctx.font = `700 64px ${SERIF}`;
    ctx.textAlign = 'left';
    ctx.fillText('“', PADDING, 824);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `34px ${SERIF}`;
    spec.poemLines.forEach((line, index) => {
      const size = fitFontSize(ctx, line, 34, 26, 560);
      ctx.font = `${size}px ${SERIF}`;
      ctx.fillText(truncateText(ctx, line, 560), PADDING + 44, 818 + index * 50);
    });
    const poem = spec.poems[0];
    if (poem) {
      ctx.font = `20px ${SERIF}`;
      ctx.fillStyle = MUTED;
      ctx.fillText(
        truncateText(ctx, `《${poem.title}》${poem.dynasty} · ${poem.author}`, 560),
        PADDING + 44,
        918,
      );
    }
  } else {
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `26px ${SERIF}`;
    ctx.fillText('诗词待考', PADDING + 8, 824);
  }
  hairline(ctx, PADDING, 948, WIDTH - PADDING, 948);

  // 数说城市
  drawSectionLabel(ctx, '数说城市', PADDING, 990, spec.theme.primary);
  const stats = spec.stats.slice(0, 3);
  const statColumns = Math.max(1, stats.length);
  const statWidth = 190;
  for (let index = 0; index < statColumns; index += 1) {
    const stat = stats[index];
    const x = PADDING + index * (statWidth + columnGap);
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `14px ${SERIF}`;
    ctx.fillText(storeLabel(stat), x, 1028);
    ctx.fillStyle = INK;
    ctx.font = `22px ${SERIF}`;
    ctx.fillText(truncateText(ctx, stat?.value ?? PENDING, statWidth), x, 1058);
  }

  // 二维码区
  ctx.save();
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(PADDING, 1072, WIDTH - PADDING * 2, 196);
  ctx.strokeStyle = HAIRLINE;
  ctx.strokeRect(PADDING, 1072, WIDTH - PADDING * 2, 196);
  ctx.restore();

  const matrix = createQrMatrix(spec.shareUrl);
  drawQr(ctx, matrix, PADDING + 20, 1086, 168, INK);

  ctx.textAlign = 'left';
  ctx.fillStyle = spec.theme.primary;
  ctx.font = `600 30px ${SERIF}`;
  ctx.fillText('扫码读城', PADDING + 220, 1140);

  ctx.fillStyle = MUTED;
  ctx.font = `18px ${SERIF}`;
  ctx.fillText('把这座城转给朋友', PADDING + 220, 1174);

  ctx.fillStyle = MUTED;
  ctx.font = `14px ${MONO}`;
  const urlText = spec.shareUrl.replace(/^https?:\/\//, '');
  ctx.fillText(truncateText(ctx, urlText, 350), PADDING + 220, 1212);

  drawSeal(ctx, '读', WIDTH - 92, 1212, 44, spec.theme.primary);

  // 页脚
  ctx.textAlign = 'left';
  ctx.fillStyle = MUTED;
  ctx.font = `14px ${SERIF}`;
  const generated = spec.generatedAt.replace('T', ' ').slice(0, 19);
  ctx.fillText(`来源 ${spec.sourceCount} 条 · 生成于 ${generated}`, PADDING, 1292);
  ctx.font = `12px ${SERIF}`;
  ctx.fillText(truncateText(ctx, spec.disclaimer, WIDTH - PADDING * 2), PADDING, 1310);

  return canvas;
}

function storeLabel(stat: { label: string } | undefined): string {
  return stat?.label ?? '待考';
}
