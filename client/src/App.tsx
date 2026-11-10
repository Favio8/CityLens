import { useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Footer } from './components/layout/Footer';
import { TopBar } from './components/layout/TopBar';
import { SearchProvider } from './components/search/SearchProvider';
import { ThemeProvider } from './hooks/useDynamicTheme';
import { CityPage } from './pages/CityPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';

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
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/city/:cityId" element={<CityPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
        <Footer />
      </SearchProvider>
    </ThemeProvider>
  );
}
