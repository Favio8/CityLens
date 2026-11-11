/**
 * 城市长图海报（P2-22）：原生 Canvas 2D 绘制，零外部依赖、零外部图片 CDN。
 * - buildPosterSpec：纯函数，从档案提取海报数据（缺失一律「待考」）；
 * - renderPoster：仅在浏览器调用，返回 canvas，可 toBlob 下载或转 dataURL 供长按保存。
 */
import { PENDING, type CityArchiveResponse } from '@citylens/shared/schema';

export interface PosterSpec {
  cityName: string;
  cityId: string;
  province: string;
  persona: string;
  aliases: string[];
  landmarks: string[];
  relics: string[];
  figures: string[];
  stats: Array<{ label: string; value: string }>;
  poems: Array<{ title: string; author: string; dynasty: string }>;
  generatedAt: string;
  sourceCount: number;
  isPreset: boolean;
  theme: { primary: string; secondary: string; accent: string };
  disclaimer: string;
}

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

/** 从档案响应提取海报数据；模块缺失或字段为「待考」时如实呈现，不估算。 */
export function buildPosterSpec(archive: CityArchiveResponse): PosterSpec {
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

  const palette = archive.meta.themePalette;
  return {
    cityName: archive.meta.standardName,
    cityId: archive.meta.cityId,
    province: archive.meta.province,
    persona,
    aliases: archive.meta.aliases.slice(0, 4),
    landmarks: (archive.landmarks ?? []).slice(0, 3).map((item) => item.name),
    relics: (archive.relics ?? []).slice(0, 2).map((item) => `${item.name}（${item.era}）`),
    figures: (archive.figures ?? []).slice(0, 2).map((item) => item.name),
    stats,
    poems: (archive.poetics ?? []).slice(0, 2).map((item) => ({
      title: item.title,
      author: item.author,
      dynasty: item.dynasty,
    })),
    generatedAt: archive.meta.generatedAt,
    sourceCount: archive.sources.length,
    isPreset: archive.meta.isPreset,
    theme: {
      primary: palette.light.primary,
      secondary: palette.light.secondary,
      accent: palette.light.accent,
    },
    disclaimer: '内容由 AI 依据所列来源整理；重要事实请以原始来源为准。',
  };
}

export function posterFileName(spec: PosterSpec): string {
  const date = spec.generatedAt.slice(0, 10);
  return `读城-${spec.cityName}-${date}.png`;
}

interface Section {
  title: string;
  lines: string[];
}

/** 竖版长图：宣纸底 + 主题色题签；仅在浏览器环境调用。 */
export function renderPoster(spec: PosterSpec): HTMLCanvasElement {
  const width = 750;
  const padding = 56;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  // Canvas 不可用时明确失败，由调用方展示降级提示，不返回空白画布让用户下载空图。
  if (!ctx) throw new Error('当前环境不支持 Canvas 渲染');

  const sections: Section[] = [];
  if (spec.landmarks.length > 0) sections.push({ title: '代表景点', lines: spec.landmarks });
  if (spec.relics.length > 0) sections.push({ title: '文物重器', lines: spec.relics });
  if (spec.figures.length > 0) sections.push({ title: '历史名人', lines: spec.figures });
  if (spec.poems.length > 0) {
    sections.push({
      title: '诗句中的城',
      lines: spec.poems.map((poem) => `《${poem.title}》${poem.dynasty}·${poem.author}`),
    });
  }
  if (spec.stats.length > 0) {
    sections.push({ title: '数说城市', lines: spec.stats.map((stat) => `${stat.label}：${stat.value}`) });
  }

  const lineHeight = 34;
  const height =
    padding * 2 +
    150 + // 城名区
    (spec.aliases.length > 0 ? 46 : 0) +
    (spec.persona !== PENDING ? 96 : 0) +
    sections.reduce((total, section) => total + 64 + section.lines.length * lineHeight + 24, 0) +
    140; // 来源与时间脚注
  canvas.width = width;
  canvas.height = Math.round(height);

  // 纸面
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, canvas.height);
  ctx.strokeStyle = spec.theme.primary;
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, width - 36, canvas.height - 36);

  let y = padding + 40;
  ctx.textAlign = 'center';
  ctx.fillStyle = spec.theme.primary;
  ctx.font = '600 20px "Noto Serif SC", serif';
  ctx.fillText(`CITYLENS · 读城${spec.isPreset ? ' · 预置馆藏' : ''}`, width / 2, y);
  y += 78;

  ctx.fillStyle = '#1e1e1e';
  ctx.font = '700 84px "Noto Serif SC", serif';
  ctx.fillText(spec.cityName, width / 2, y);
  y += 48;
  ctx.font = '24px "Noto Serif SC", serif';
  ctx.fillStyle = '#5a564c';
  ctx.fillText(`${spec.province} · ${spec.cityId}`, width / 2, y);
  y += 40;

  if (spec.aliases.length > 0) {
    ctx.font = '22px "Noto Serif SC", serif';
    ctx.fillStyle = spec.theme.secondary;
    ctx.fillText(`古称 ${spec.aliases.join(' · ')}`, width / 2, y);
    y += 46;
  }

  if (spec.persona !== PENDING) {
    ctx.textAlign = 'left';
    ctx.font = '26px "Noto Serif SC", serif';
    ctx.fillStyle = '#1e1e1e';
    // 简单折行：每行约 24 个全角字符；超出 3 行时末行加省略号，避免静默截断。
    const chars = [...spec.persona];
    const rows: string[] = [];
    for (let index = 0; index < chars.length; index += 24) {
      rows.push(chars.slice(index, index + 24).join(''));
    }
    const shown = rows.slice(0, 3);
    if (rows.length > shown.length) {
      shown[shown.length - 1] = `${shown[shown.length - 1]?.slice(0, 23) ?? ''}…`;
    }
    for (const row of shown) {
      ctx.fillText(row, padding, y);
      y += 44;
    }
    y += 8;
  }

  for (const section of sections) {
    y += 20;
    ctx.textAlign = 'left';
    ctx.fillStyle = spec.theme.primary;
    ctx.font = '600 26px "Noto Serif SC", serif';
    ctx.fillText(`▎${section.title}`, padding, y);
    y += 44;
    ctx.fillStyle = '#2b2b2b';
    ctx.font = '23px "Noto Serif SC", serif';
    for (const line of section.lines) {
      ctx.fillText(line, padding + 16, y);
      y += lineHeight;
    }
    y += 16;
  }

  y += 24;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#5a564c';
  ctx.font = '18px "Noto Serif SC", serif';
  ctx.fillText(`生成时间：${spec.generatedAt.replace('T', ' ').slice(0, 19)} · 来源 ${spec.sourceCount} 条`, padding, y);
  y += 32;
  ctx.fillText(spec.disclaimer, padding, y);
  return canvas;
}
