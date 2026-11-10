import { describe, expect, it } from 'vitest';
import { checkThemePalette, contrastRatio, ensureContrast } from './theme';

const DAY_BG = '#F7F4ED';
const NIGHT_BG = '#121316';

describe('主题色对比度（PRD 4.2 / AC-10）', () => {
  it('ensureContrast 将不达标点缀色调至 ≥4.5', () => {
    const original = contrastRatio('#C89B40', DAY_BG);
    expect(original).toBeLessThan(4.5);
    const fixed = ensureContrast('#C89B40', DAY_BG, 4.5);
    expect(contrastRatio(fixed, DAY_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('深色背景向提亮方向调整', () => {
    const fixed = ensureContrast('#8C3F2B', NIGHT_BG, 4.5);
    expect(contrastRatio(fixed, NIGHT_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('已达标颜色保持不变', () => {
    const color = '#1E1E1E';
    expect(ensureContrast(color, DAY_BG, 4.5).toUpperCase()).toBe(color);
  });

  it('accent 装饰色只需 ≥3:1', () => {
    const result = checkThemePalette(
      {
        light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#A97B22' },
        dark: { primary: '#D9A75F', secondary: '#B9BCC2', accent: '#C89B40' },
      },
      { light: DAY_BG, dark: NIGHT_BG },
    );
    expect(result.issues).toEqual([]);
  });
});
