import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Footer } from './components/layout/Footer';
import { TopBar } from './components/layout/TopBar';
import { SearchProvider } from './components/search/SearchProvider';
import { ThemeProvider } from './hooks/useDynamicTheme';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';

/** 城市页承载 MapLibre 与 ECharts，按路由懒加载以缩小首屏体积。 */
const CityPage = lazy(() =>
  import('./pages/CityPage').then((module) => ({ default: module.CityPage })),
);

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <ThemeProvider>
      <SearchProvider>
        <ScrollToTop />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:bg-[var(--bg-elevated)] focus:px-4 focus:py-2"
        >
          跳到正文
        </a>
        <TopBar />
        <div id="main-content">
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/city/:cityId" element={<CityPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </div>
        <Footer />
      </SearchProvider>
    </ThemeProvider>
  );
}

/** 路由级懒加载占位：保持宣纸底色，避免白屏。 */
function RouteFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" aria-live="polite" aria-busy="true">
      <div className="text-center">
        <p className="mono text-[10px] tracking-[0.3em] text-[var(--text-secondary)]">展卷中</p>
        <div className="mx-auto mt-4 h-px w-24 overflow-hidden bg-[var(--border-subtle)]">
          <span className="ink-sweep block h-px w-1/2 bg-[var(--city-primary)]" />
        </div>
      </div>
    </div>
  );
}
