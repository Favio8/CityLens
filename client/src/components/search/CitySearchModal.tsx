/**
 * 城市检索与消歧模态框（PRD 2.1 / 2.2 / AC-01 / AC-02 / AC-09）。
 * 300ms 防抖联想；同音/形近/City 同名弹出消歧卡；区县与古称直接归并并提示。
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HotCity, SearchCandidate, SearchResponse } from '@citylens/shared/schema';
import { MAX_QUERY_LENGTH } from '@citylens/shared/schema';
import { getHotCities, searchCities } from '../../lib/api';

interface CitySearchModalProps {
  open: boolean;
  onClose: () => void;
}

const MATCH_LABELS: Record<SearchCandidate['matchType'], string> = {
  standard: '标准名',
  ancient: '古称 / 别称',
  pinyin: '拼音',
  english: '英文名',
  district_hint: '区县归并',
  typo: '形近纠正',
};

export function CitySearchModal({ open, onClose }: CitySearchModalProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hot, setHot] = useState<HotCity[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResult(null);
    setError(null);
    const controller = new AbortController();
    void getHotCities(controller.signal)
      .then(setHot)
      .catch(() => setHot([]));
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchCities(trimmed, controller.signal)
        .then((response) => {
          setResult(response);
          setError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : '检索失败');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, open]);

  if (!open) return null;

  const go = (candidate: SearchCandidate): void => {
    navigate(`/city/${candidate.cityId}`, {
      state: { hint: result?.hint ?? null },
    });
    onClose();
  };

  const submit = async (): Promise<void> => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (result?.status === 'exact' && result.candidates[0]) {
      go(result.candidates[0]);
      return;
    }
    setLoading(true);
    try {
      const response = await searchCities(trimmed);
      setResult(response);
      if (response.status === 'exact' && response.candidates[0]) {
        go(response.candidates[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '检索失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh] md:pt-[16vh]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        aria-label="关闭搜索"
        className="absolute inset-0 cursor-default bg-[rgba(18,19,22,0.55)] backdrop-blur-[6px]"
        onClick={onClose}
      />
      <div
        className="surface-card relative w-full max-w-2xl overflow-hidden rounded-lg"
        style={{ boxShadow: 'var(--shadow-lift)' }}
      >
        <h2 id={titleId} className="sr-only">
          搜索城市
        </h2>
        <div className="flex items-center gap-3 border-b px-5 py-4 hairline">
          <span aria-hidden className="text-[var(--city-primary)]">
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="输入城市名、古称、拼音或英文，如「长安」「suzhou」"
            aria-label="城市名、古称、拼音或英文"
            className="w-full bg-transparent font-serif text-lg tracking-[0.06em] outline-none placeholder:text-[var(--text-secondary)]/70"
          />
          <kbd className="mono hidden shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] hairline md:inline-block">
            ESC
          </kbd>
        </div>

        <div className="max-h-[58vh] overflow-y-auto px-3 py-3">
          {!query.trim() ? (
            <HotCities hot={hot} onPick={(cityId) => { navigate(`/city/${cityId}`); onClose(); }} />
          ) : loading && !result ? (
            <p className="px-3 py-8 text-center text-sm text-[var(--text-secondary)]">正在翻阅地方志…</p>
          ) : error ? (
            <p className="px-3 py-8 text-center text-sm text-[var(--text-secondary)]">{error}</p>
          ) : result?.status === 'none' ? (
            <div className="px-3 py-6 text-center">
              <p className="font-serif text-lg tracking-[0.12em]">版图中暂未寻获此城</p>
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                一期收录地级及以上行政区与少量文旅名城，试试这些地方：
              </p>
              <HotCities hot={hot.slice(0, 6)} onPick={(cityId) => { navigate(`/city/${cityId}`); onClose(); }} compact />
            </div>
          ) : result ? (
            <div className="space-y-2">
              {result.status === 'ambiguous' ? (
                <p className="px-3 pb-1 pt-2 text-xs tracking-[0.16em] text-[var(--text-secondary)]">
                  读音相近或同名多义，请择一城
                </p>
              ) : null}
              {result.hint ? (
                <p className="mx-2 rounded-sm border-l-2 bg-[var(--city-primary)]/5 px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]" style={{ borderColor: 'var(--city-primary)' }}>
                  {result.hint}
                </p>
              ) : null}
              {result.candidates.map((candidate) => (
                <button
                  key={`${candidate.cityId}-${candidate.matchedAlias}`}
                  type="button"
                  onClick={() => go(candidate)}
                  className="group flex w-full items-start justify-between gap-4 rounded-md border border-transparent px-3 py-3 text-left transition-colors hover:border-[var(--border-subtle)] hover:bg-[var(--city-primary)]/5"
                >
                  <span>
                    <span className="font-serif text-lg tracking-[0.08em]">{candidate.name}</span>
                    <span className="ml-2 text-xs text-[var(--text-secondary)]">{candidate.province}</span>
                    <span className="mt-1 block max-w-xl text-xs leading-relaxed text-[var(--text-secondary)]">
                      {candidate.summary ?? '暂无简介'}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[10px] tracking-[0.14em] text-[var(--city-primary)]">
                      {MATCH_LABELS[candidate.matchType]}
                    </span>
                    <span className="mono mt-1 block text-[10px] text-[var(--text-secondary)]">
                      {candidate.cityId}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-[var(--text-secondary)]">
              输入关键词，开始读城
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-5 py-3 text-[10px] tracking-[0.14em] text-[var(--text-secondary)] hairline">
          <span>一期收录 342 城 · 支持古称 / 拼音 / 英文</span>
          <span className="mono hidden md:inline">Enter 展卷 · ESC 收起</span>
        </div>
      </div>
    </div>
  );
}

function HotCities({
  hot,
  onPick,
  compact = false,
}: {
  hot: HotCity[];
  onPick: (cityId: string) => void;
  compact?: boolean;
}) {
  if (hot.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-[var(--text-secondary)]">暂无热门城市</p>;
  }
  return (
    <div className={compact ? 'mt-4 flex flex-wrap justify-center gap-2' : 'px-2 py-2'}>
      {!compact ? (
        <p className="px-1 pb-2 text-xs tracking-[0.16em] text-[var(--text-secondary)]">热门名城</p>
      ) : null}
      <div className="flex flex-wrap gap-2 px-1">
        {hot.map((city) => (
          <button
            key={city.cityId}
            type="button"
            onClick={() => onPick(city.cityId)}
            className="city-pill"
          >
            <span className="font-serif">{city.name}</span>
            <span className="text-[10px] text-[var(--text-secondary)]">
              {city.isPreset ? '预置馆藏' : city.province}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" strokeLinecap="round" />
    </svg>
  );
}
