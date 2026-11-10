import { describe, expect, it } from 'vitest';
import {
  CANVAS_BACKGROUNDS,
  CITY_THEME_PALETTES,
  DEFAULT_THEME_PALETTE,
  paletteForCity,
} from './cityThemes';
import { PRESET_CITY_IDS } from './schema';
import { checkThemePalette } from './theme';

describe('预置城市主题色', () => {
  it('覆盖全部预置城市', () => {
    for (const cityId of PRESET_CITY_IDS) {
      expect(CITY_THEME_PALETTES[cityId], cityId).toBeDefined();
    }
    expect(Object.keys(CITY_THEME_PALETTES)).toHaveLength(PRESET_CITY_IDS.length);
  });

  it('每套主题均通过 ensureContrast 校正后的对比度校验', () => {
    for (const cityId of PRESET_CITY_IDS) {
      const result = checkThemePalette(paletteForCity(cityId), CANVAS_BACKGROUNDS);
      expect(result.issues, `${cityId}: ${result.issues.join('; ')}`).toHaveLength(0);
    }
    expect(checkThemePalette(DEFAULT_THEME_PALETTE, CANVAS_BACKGROUNDS).ok).toBe(true);
  });

  it('六城主题互不相同，非预置城市回落默认色', () => {
    const signatures = PRESET_CITY_IDS.map((cityId) => paletteForCity(cityId).light.primary);
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(paletteForCity('CN-999999')).toEqual(DEFAULT_THEME_PALETTE);
  });
});
