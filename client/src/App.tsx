import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Footer } from './components/layout/Footer';
import { TopBar } from './components/layout/TopBar';
import { SearchProvider } from './components/search/SearchProvider';
import { ThemeProvider } from './hooks/useDynamicTheme';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';

/** 城市页承载 MapLibre 与 ECharts，按路由懒加载以缩小首屏体积。 */
const CityPage = lazy(() =>
  import('./pages/CityPage').then((module) => ({ default: module.CityPage })),
);
const AdminPage = lazy(() =>
  import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })),
);
const ComparePage = lazy(() =>
  import('./pages/ComparePage').then((module) => ({ default: module.ComparePage })),
);

/** 路由级错误边界：单路由异常只降级该路由，不白屏。 */
function RouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary
      title="此页渲染异常"
      resetKey={pathname}
    >
      {children}
    </ErrorBoundary>
  );
}

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
        <main id="main-content">
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route
                path="/"
                element={
                  <RouteBoundary>
                    <HomePage />
                  </RouteBoundary>
                }
              />
              <Route
                path="/city/:cityId"
                element={
                  <RouteBoundary>
                    <CityPage />
                  </RouteBoundary>
                }
              />
              <Route
                path="/admin"
                element={
                  <RouteBoundary>
                    <AdminPage />
                  </RouteBoundary>
                }
              />
              <Route
                path="/compare"
                element={
                  <RouteBoundary>
                    <ComparePage />
                  </RouteBoundary>
                }
              />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </main>
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
