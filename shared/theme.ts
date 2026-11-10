/**
 * 主题色对比度工具（PRD 4.2）。
 * ensureContrast 在对比度不足时按 HSL 明度每次 3% 向可读方向调整：
 * 日间（浅背景）变深，夜间（深背景）变亮。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToRgb(hex: string): Rgb {
  const normalized = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`无效 HEX 颜色：${hex}`);
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 对比度，范围 1–21。 */
export function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(hexToRgb(foreground));
  const bg = relativeLuminance(hexToRgb(background));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case rn:
      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
      break;
    case gn:
      h = ((bn - rn) / d + 2) / 6;
      break;
    default:
      h = ((rn - gn) / d + 4) / 6;
  }
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

const STEP = 0.03;

/**
 * 对比度校正：不达标时按 HSL 明度每次 3% 向可读方向调整，直至达标。
 * 浅背景（日间）变深，深背景（夜间）变亮；若该方向走到端点仍不达标，
 * 则反向尝试，仍不达标时返回可达对比度最高的颜色。
 */
export function ensureContrast(color: string, background: string, minRatio: number): string {
  const bgLuminance = relativeLuminance(hexToRgb(background));
  const preferLighten = bgLuminance < 0.5;

  const attempt = (direction: 1 | -1): { color: string; ratio: number } | null => {
    let hsl = rgbToHsl(hexToRgb(color));
    let best: { color: string; ratio: number } | null = null;
    for (let i = 0; i <= 34; i += 1) {
      const hex = rgbToHex(hslToRgb(hsl));
      const ratio = contrastRatio(hex, background);
      if (!best || ratio > best.ratio) best = { color: hex, ratio };
      if (ratio >= minRatio) return { color: hex, ratio };
      const nextL = hsl.l + direction * STEP;
      if (nextL <= 0 || nextL >= 1) break;
      hsl = { ...hsl, l: nextL };
    }
    return best;
  };

  const first = attempt(preferLighten ? 1 : -1);
  if (first && first.ratio >= minRatio) return first.color;
  const second = attempt(preferLighten ? -1 : 1);
  if (first && second) return first.ratio >= second.ratio ? first.color : second.color;
  return first?.color ?? second?.color ?? color;
}

/** 主题色成套校验：primary/secondary 需 ≥4.5，accent 作为非文字装饰需 ≥3。 */
export function checkThemePalette(
  palette: {
    light: { primary: string; secondary: string; accent: string };
    dark: { primary: string; secondary: string; accent: string };
  },
  backgrounds: { light: string; dark: string },
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const checks: Array<{ mode: 'light' | 'dark'; key: 'primary' | 'secondary' | 'accent'; min: number }> =
    [
      { mode: 'light', key: 'primary', min: 4.5 },
      { mode: 'light', key: 'secondary', min: 4.5 },
      { mode: 'light', key: 'accent', min: 3 },
      { mode: 'dark', key: 'primary', min: 4.5 },
      { mode: 'dark', key: 'secondary', min: 4.5 },
      { mode: 'dark', key: 'accent', min: 3 },
    ];
  for (const check of checks) {
    const color = palette[check.mode][check.key];
    const bg = backgrounds[check.mode];
    const ratio = contrastRatio(color, bg);
    if (ratio < check.min) {
      issues.push(`${check.mode}.${check.key} ${color} 对比度 ${ratio.toFixed(2)} < ${check.min}`);
    }
  }
  return { ok: issues.length === 0, issues };
}
