/** 本地藏书阁：收藏与最近浏览（LocalStorage），跨组件同步。 */
import { useCallback, useEffect, useState } from 'react';

export const FAVORITES_KEY = 'citylens:favorites';
export const RECENTS_KEY = 'citylens:recents';
export const NAMES_KEY = 'citylens:city-names';
const SYNC_EVENT = 'citylens:library-change';
const MAX_RECENTS = 20;

export interface RecentEntry {
  cityId: string;
  name: string;
  ts: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new Event(SYNC_EVENT));
}

export function useLocalLibrary() {
  const [favorites, setFavorites] = useState<string[]>(() => readJson<string[]>(FAVORITES_KEY, []));
  const [recents, setRecents] = useState<RecentEntry[]>(() => readJson<RecentEntry[]>(RECENTS_KEY, []));
  const [names, setNames] = useState<Record<string, string>>(() => {
    const raw = window.localStorage.getItem(NAMES_KEY);
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    const sync = (): void => {
      setFavorites(readJson<string[]>(FAVORITES_KEY, []));
      setRecents(readJson<RecentEntry[]>(RECENTS_KEY, []));
      try {
        const parsed = JSON.parse(window.localStorage.getItem(NAMES_KEY) ?? '{}') as Record<string, string>;
        setNames(parsed ?? {});
      } catch {
        setNames({});
      }
    };
    window.addEventListener(SYNC_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SYNC_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const toggleFavorite = useCallback((cityId: string) => {
    const current = readJson<string[]>(FAVORITES_KEY, []);
    const next = current.includes(cityId)
      ? current.filter((id) => id !== cityId)
      : [...current, cityId];
    writeJson(FAVORITES_KEY, next);
    setFavorites(next);
  }, []);

  const rememberCityName = useCallback((cityId: string, name: string) => {
    let current: Record<string, string> = {};
    try {
      current = JSON.parse(window.localStorage.getItem(NAMES_KEY) ?? '{}') as Record<string, string>;
    } catch {
      current = {};
    }
    if (current[cityId] === name) return;
    window.localStorage.setItem(NAMES_KEY, JSON.stringify({ ...current, [cityId]: name }));
    window.dispatchEvent(new Event(SYNC_EVENT));
  }, []);

  const addRecent = useCallback(
    (entry: { cityId: string; name: string }) => {
      const current = readJson<RecentEntry[]>(RECENTS_KEY, []);
      const next: RecentEntry[] = [
        { ...entry, ts: Date.now() },
        ...current.filter((item) => item.cityId !== entry.cityId),
      ].slice(0, MAX_RECENTS);
      writeJson(RECENTS_KEY, next);
      setRecents(next);
      rememberCityName(entry.cityId, entry.name);
    },
    [rememberCityName],
  );

  return {
    favorites,
    recents,
    names,
    toggleFavorite,
    isFavorite: (cityId: string) => favorites.includes(cityId),
    addRecent,
    rememberCityName,
  };
}
