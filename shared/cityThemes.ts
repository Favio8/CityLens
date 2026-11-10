/**
 * 六座预置城市的主题色（PRD 4.2）。
 * 原始色仅表达城市气质，落库前一律经 ensureContrast 校正：
 * 日间背景 #F7F4ED、夜间背景 #121316，正文 ≥4.5，装饰色 ≥3。
 */
import type { ThemePalette } from './schema';
import { ensureContrast } from './theme';

export const CANVAS_BACKGROUNDS = { light: '#F7F4ED', dark: '#121316' } as const;

type RawPalette = ThemePalette;

function tune(
  colors: { primary: string; secondary: string; accent: string },
  background: string,
): { primary: string; secondary: string; accent: string } {
  return {
    primary: ensureContrast(colors.primary, background, 4.5),
    secondary: ensureContrast(colors.secondary, background, 4.5),
    accent: ensureContrast(colors.accent, background, 3),
  };
}

function normalize(palette: RawPalette): ThemePalette {
  return {
    light: tune(palette.light, CANVAS_BACKGROUNDS.light),
    dark: tune(palette.dark, CANVAS_BACKGROUNDS.dark),
  };
}

export const DEFAULT_THEME_PALETTE: ThemePalette = normalize({
  light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
  dark: { primary: '#D2957F', secondary: '#B4B9C0', accent: '#D9B45C' },
});

/** 城市气质的原始取色：西安赭石、杭州湖青、成都竹青、北京宫红、苏州黛蓝、洛阳牡丹紫。 */
const RAW_PALETTES: Record<string, RawPalette> = {
  'CN-610100': {
    light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
    dark: { primary: '#D2957F', secondary: '#B4B9C0', accent: '#D9B45C' },
  },
  'CN-330100': {
    light: { primary: '#25554A', secondary: '#5B544A', accent: '#B0656F' },
    dark: { primary: '#7FBFAF', secondary: '#C9C1B4', accent: '#E0A0A8' },
  },
  'CN-510100': {
    light: { primary: '#2F6046', secondary: '#5C4A36', accent: '#B23A3A' },
    dark: { primary: '#86C3A3', secondary: '#CBB79F', accent: '#E58C8C' },
  },
  'CN-110000': {
    light: { primary: '#8A2C2C', secondary: '#4C4A45', accent: '#B98A2F' },
    dark: { primary: '#DE8F8F', secondary: '#C2BEB6', accent: '#DDBC72' },
  },
  'CN-320500': {
    light: { primary: '#2E4A5A', secondary: '#4A4A4A', accent: '#A85C6E' },
    dark: { primary: '#9DBDCD', secondary: '#BFBFBF', accent: '#DDA3B0' },
  },
  'CN-410300': {
    light: { primary: '#6B3F6E', secondary: '#3E5A5A', accent: '#B07C2E' },
    dark: { primary: '#C9A0CC', secondary: '#93B7B7', accent: '#DDBA79' },
  },
};

export const CITY_THEME_PALETTES: Record<string, ThemePalette> = Object.fromEntries(
  Object.entries(RAW_PALETTES).map(([cityId, palette]) => [cityId, normalize(palette)]),
);

/** 取城市主题；非预置城市回落到品牌默认色。 */
export function paletteForCity(cityId: string): ThemePalette {
  return CITY_THEME_PALETTES[cityId] ?? DEFAULT_THEME_PALETTE;
}
