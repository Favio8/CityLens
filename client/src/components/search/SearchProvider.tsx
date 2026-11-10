/** 搜索上下文：全局 ⌘K / Ctrl+K 打开宣纸搜索模态框。 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CitySearchModal } from './CitySearchModal';

interface SearchContextValue {
  openSearch: () => void;
  closeSearch: () => void;
  isOpen: boolean;
}

const SearchContext = createContext<SearchContextValue | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const openSearch = useCallback(() => setIsOpen(true), []);
  const closeSearch = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo(
    () => ({ openSearch, closeSearch, isOpen }),
    [openSearch, closeSearch, isOpen],
  );

  return (
    <SearchContext.Provider value={value}>
      {children}
      <CitySearchModal open={isOpen} onClose={closeSearch} />
    </SearchContext.Provider>
  );
}

export function useSearch(): SearchContextValue {
  const context = useContext(SearchContext);
  if (!context) throw new Error('useSearch 必须在 SearchProvider 内使用');
  return context;
}
