/** 动态城市主题：把主题色注入 CSS 变量，并用 ensureContrast 保证对比度。 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ThemePalette } from '@citylens/shared/schema';
import { ensureContrast, hexToRgb } from '@citylens/shared/theme';

export type ColorMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'citylens:theme';

export const CANVAS_BACKGROUNDS: Record<ColorMode, string> = {
  light: '#F7F4ED',
  dark: '#121316',
};

/** 默认主题取自 PRD 4.2 西安日间/夜间基准色。 */
export const DEFAULT_PALETTE: ThemePalette = {
  light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
  dark: { primary: '#D98A6E', secondary: '#A8ADB4', accent: '#E0B860' },
};

function readInitialMode(): ColorMode {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useThemeState(palette: ThemePalette | null) {
  const [mode, setMode] = useState<ColorMode>(readInitialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  }, [mode]);

  const colors = (palette ?? DEFAULT_PALETTE)[mode];

  useEffect(() => {
    const root = document.documentElement;
    const bg = CANVAS_BACKGROUNDS[mode];
    const primary = ensureContrast(colors.primary, bg, 4.5);
    const secondary = ensureContrast(colors.secondary, bg, 4.5);
    const accent = ensureContrast(colors.accent, bg, 3);
    const rgb = hexToRgb(primary);
    root.style.setProperty('--city-primary', primary);
    root.style.setProperty('--city-secondary', secondary);
    root.style.setProperty('--city-accent', accent);
    root.style.setProperty('--city-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`);
    root.style.setProperty('--theme-transition', '0.8s');
  }, [colors.primary, colors.secondary, colors.accent, mode]);

  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  return { mode, setMode, toggleMode };
}

interface ThemeContextValue {
  mode: ColorMode;
  toggleMode: () => void;
  setPalette: (palette: ThemePalette | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState<ThemePalette | null>(null);
  const { mode, toggleMode } = useThemeState(palette);
  const value = useMemo(
    () => ({ mode, toggleMode, setPalette }),
    [mode, toggleMode],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return context;
}

/** 城市页把档案的主题色注入全局；离开时恢复默认。 */
export function useCityTheme(palette: ThemePalette | null | undefined): void {
  const { setPalette } = useTheme();
  useEffect(() => {
    if (!palette) return;
    setPalette(palette);
    return () => setPalette(null);
  }, [palette, setPalette]);
}
