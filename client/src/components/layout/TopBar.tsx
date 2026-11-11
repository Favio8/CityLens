/** 顶部导航：品牌、搜索入口、藏书阁（收藏/足迹）、日夜切换。 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTheme } from '../../hooks/useDynamicTheme';
import { useLocalLibrary } from '../../hooks/useLocalLibrary';
import { useSearch } from '../../components/search/SearchProvider';

type Drawer = 'favorites' | 'recents' | null;

export function TopBar() {
  const { openSearch } = useSearch();
  const { favorites, recents, names, toggleFavorite } = useLocalLibrary();
  const { mode, toggleMode } = useTheme();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setDrawer(null), [location.pathname]);

  useEffect(() => {
    if (!drawer) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setDrawer(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [drawer]);

  return (
    <header className="sticky top-0 z-40 w-full border-b backdrop-blur-md hairline" style={{ background: 'color-mix(in srgb, var(--bg-canvas) 82%, transparent)' }}>
      <div ref={containerRef} className="page-shell flex h-16 items-center justify-between gap-3">
        <Link to="/" className="group flex items-center gap-3" aria-label="CityLens 读城 首页">
          <span
            className="grid h-9 w-9 place-items-center border font-serif text-lg leading-none transition-transform duration-500 group-hover:rotate-[-4deg]"
            style={{ borderColor: 'var(--city-primary)', color: 'var(--city-primary)' }}
            aria-hidden
          >
            读
          </span>
          <span className="leading-tight">
            <span className="mono block text-[10px] tracking-[0.32em] text-[var(--text-secondary)]">
              CITYLENS
            </span>
            <span className="serif block text-sm tracking-[0.3em]">读城</span>
          </span>
        </Link>

        <div className="flex items-center gap-1.5 md:gap-2">
          <Link
            to="/compare"
            className="hidden items-center gap-2 rounded-full border px-3 py-2 text-xs tracking-[0.1em] transition-colors hover:border-[var(--city-primary)] hairline md:flex"
          >
            <CompareIcon />
            <span className="hidden sm:inline">双城对比</span>
          </Link>

          <button
            type="button"
            onClick={openSearch}
            className="group flex items-center gap-2 rounded-full border px-3 py-2 text-xs tracking-[0.1em] transition-colors hover:border-[var(--city-primary)] hairline md:px-4"
            aria-label="搜索城市（Ctrl+K）"
          >
            <SearchIcon />
            <span className="hidden sm:inline">搜一座城</span>
            <kbd className="mono hidden rounded border px-1 py-0.5 text-[9px] text-[var(--text-secondary)] hairline lg:inline-block">
              ⌘K
            </kbd>
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setDrawer(drawer === 'favorites' ? null : 'favorites')}
              className="relative flex items-center gap-2 rounded-full border px-3 py-2 text-xs tracking-[0.1em] transition-colors hover:border-[var(--city-primary)] hairline"
              aria-expanded={drawer === 'favorites'}
              aria-label={`收藏夹，共 ${favorites.length} 座城`}
            >
              <BookmarkIcon />
              <span className="hidden sm:inline">藏书阁</span>
              {favorites.length > 0 ? (
                <span className="mono absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--city-primary)] px-1 text-[9px] text-[var(--bg-canvas)]">
                  {favorites.length}
                </span>
              ) : null}
            </button>
            {drawer === 'favorites' ? (
              <LibraryPanel
                title="我的藏书阁"
                empty="尚未收藏城市。在城志页右上角点亮书签，即可收入阁中。"
                items={favorites
                  .slice()
                  .reverse()
                  .map((cityId) => ({ cityId, name: names[cityId] ?? '城市档案' }))}
                onRemove={toggleFavorite}
              />
            ) : null}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setDrawer(drawer === 'recents' ? null : 'recents')}
              className="flex items-center gap-2 rounded-full border px-3 py-2 text-xs tracking-[0.1em] transition-colors hover:border-[var(--city-primary)] hairline"
              aria-expanded={drawer === 'recents'}
              aria-label="最近足迹"
            >
              <FootprintIcon />
              <span className="hidden xl:inline">足迹</span>
            </button>
            {drawer === 'recents' ? (
              <LibraryPanel
                title="最近足迹"
                empty="还没有足迹。去读第一座城吧。"
                items={recents.map((entry) => ({ cityId: entry.cityId, name: entry.name }))}
              />
            ) : null}
          </div>

          <button
            type="button"
            onClick={toggleMode}
            className="grid h-9 w-9 place-items-center rounded-full border transition-colors hover:border-[var(--city-primary)] hairline"
            aria-label={mode === 'light' ? '切换到夜间墨色' : '切换到日间宣纸'}
            title={mode === 'light' ? '夜间墨色' : '日间宣纸'}
          >
            {mode === 'light' ? <MoonIcon /> : <SunIcon />}
          </button>
        </div>
      </div>
    </header>
  );
}

function LibraryPanel({
  title,
  empty,
  items,
  onRemove,
}: {
  title: string;
  empty: string;
  items: Array<{ cityId: string; name: string }>;
  onRemove?: (cityId: string) => void;
}) {
  return (
    <div
      className="surface-card absolute right-0 top-[calc(100%+10px)] w-[min(84vw,320px)] rounded-md p-4"
      style={{ boxShadow: 'var(--shadow-lift)' }}
      role="dialog"
      aria-label={title}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow">{title}</span>
        <span className="mono text-[10px] text-[var(--text-secondary)]">{items.length} 条</span>
      </div>
      {items.length === 0 ? (
        <p className="py-4 text-xs leading-relaxed text-[var(--text-secondary)]">{empty}</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto" tabIndex={0} aria-label={`${title}列表（可滚动）`}>
          {items.map((item) => (
            <li key={item.cityId} className="group flex items-center justify-between gap-2">
              <Link
                to={`/city/${item.cityId}`}
                className="ink-link flex-1 truncate py-1.5 font-serif text-sm tracking-[0.08em]"
              >
                {item.name}
              </Link>
              {onRemove ? (
                <button
                  type="button"
                  onClick={() => onRemove(item.cityId)}
                  className="px-1 text-[10px] text-[var(--text-secondary)] opacity-0 transition-opacity hover:text-[var(--city-primary)] group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`从藏书阁移除 ${item.name}`}
                >
                  移除
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" strokeLinecap="round" />
    </svg>
  );
}

function CompareIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <rect x="3" y="5" width="8" height="14" rx="1" />
      <rect x="13" y="5" width="8" height="14" rx="1" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M6 4h12v17l-6-4-6 4V4Z" strokeLinejoin="round" />
    </svg>
  );
}

function FootprintIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M5 20c2-1 3-3 3-6 0-3 1.5-5 3.5-5S15 11 15 14c0 3 1 4 4 5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="6" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" strokeLinecap="round" />
    </svg>
  );
}
