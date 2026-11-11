/**
 * 双城对比页（P2-19）：/compare?cities=CN-610100,CN-330100。
 * 桌面双列并排，移动端纵向堆叠；缺失数据统一「待考」；支持复制分享链接。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CompareCity, CompareResponse, SearchCandidate } from '@citylens/shared/schema';
import { PENDING } from '@citylens/shared/schema';
import { getCompare, searchCities } from '../lib/api';

const CITY_ID_PATTERN = /^CN-\d{6}$/;

function readCityIds(params: URLSearchParams): [string | null, string | null] {
  const raw = (params.get('cities') ?? '').split(',').map((part) => part.trim());
  return [
    CITY_ID_PATTERN.test(raw[0] ?? '') ? (raw[0] as string) : null,
    CITY_ID_PATTERN.test(raw[1] ?? '') ? (raw[1] as string) : null,
  ];
}

/** 单个城市选择器：防抖检索 + 候选列表。 */
function CityPicker({
  label,
  value,
  onPick,
}: {
  label: string;
  value: string | null;
  onPick: (cityId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [picked, setPicked] = useState<SearchCandidate | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setCandidates([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchCities(trimmed, controller.signal)
        .then((response) => {
          if (response.status === 'none') setCandidates([]);
          else setCandidates(response.candidates.slice(0, 5));
        })
        .catch(() => {
          /* 忽略中止与网络错误 */
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="surface-card rounded-md p-5">
      <p className="eyebrow">{label}</p>
      {picked ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="font-serif text-lg">
            {picked.name}
            <span className="ml-2 text-xs text-[var(--text-secondary)]">{picked.province}</span>
          </span>
          <button
            type="button"
            className="ink-btn px-3 py-1.5 text-[10px]"
            onClick={() => {
              setPicked(null);
              setQuery('');
              onPick('');
            }}
          >
            更换
          </button>
        </div>
      ) : (
        <>
          <input
            value={query}
            maxLength={30}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入城市名 / 古称 / 拼音"
            aria-label={`${label}城市检索`}
            className="mt-3 w-full border bg-transparent px-3 py-2 text-xs outline-none hairline focus:border-[var(--city-primary)]"
          />
          {candidates.length > 0 ? (
            <div className="mt-2 space-y-1">
              {candidates.map((candidate) => (
                <button
                  key={`${candidate.cityId}-${candidate.matchedAlias}`}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-sm border border-transparent px-2 py-2 text-left text-xs hover:border-[var(--border-subtle)] hover:bg-[var(--city-primary)]/5"
                  onClick={() => {
                    setPicked(candidate);
                    onPick(candidate.cityId);
                  }}
                >
                  <span>
                    <span className="font-serif text-sm">{candidate.name}</span>
                    <span className="ml-2 text-[10px] text-[var(--text-secondary)]">{candidate.province}</span>
                  </span>
                  <span className="mono text-[9px] text-[var(--text-secondary)]">{candidate.cityId}</span>
                </button>
              ))}
            </div>
          ) : query.trim() ? (
            <p className="mt-2 text-[10px] text-[var(--text-secondary)]">未找到匹配城市</p>
          ) : null}
        </>
      )}
      {value ? <p className="mono mt-2 text-[9px] text-[var(--text-secondary)]">{value}</p> : null}
    </div>
  );
}

function FactRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-2.5 hairline">
      <span className="text-[10px] tracking-[0.2em] text-[var(--text-secondary)]">{label}</span>
      <span className="text-right">
        <span className={`font-serif text-sm ${value === PENDING ? 'text-[var(--text-secondary)]' : ''}`}>
          {value}
        </span>
        {hint ? <span className="ml-1 text-[9px] text-[var(--text-secondary)]">{hint}</span> : null}
      </span>
    </div>
  );
}

function CityColumn({ city }: { city: CompareCity }) {
  const palette = city.themePalette.light;
  return (
    <article className="surface-card rounded-md p-6">
      <div className="h-1.5 w-full rounded-full" style={{ background: palette.primary }} />
      <div className="mt-4 flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-3xl tracking-[0.1em]">{city.standardName}</h2>
        <span className="mono text-[10px] text-[var(--text-secondary)]">{city.cityId}</span>
      </div>
      <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{city.province}</p>
      <p className={`mt-4 font-serif text-sm leading-[1.9] ${city.oneLinePersona === PENDING ? 'text-[var(--text-secondary)]' : ''}`}>
        {city.oneLinePersona === PENDING ? '城市人格待考' : city.oneLinePersona}
      </p>

      <div className="mt-5">
        <FactRow
          label="地区生产总值"
          value={city.gdp.value === PENDING ? PENDING : `${city.gdp.value.toLocaleString('zh-CN')} ${city.gdp.unit ?? ''}`}
          hint={city.gdp.statYear ? `${city.gdp.statYear} 年` : undefined}
        />
        <FactRow
          label="常住人口"
          value={city.population.value === PENDING ? PENDING : `${city.population.value.toLocaleString('zh-CN')} ${city.population.unit ?? ''}`}
          hint={city.population.statYear ? `${city.population.statYear} 年` : undefined}
        />
        <FactRow label="气候类型" value={city.climateType.value} />
        <FactRow label="收录诗词" value={`${city.poemCount} 首`} />
        <FactRow label="档案状态" value={city.archiveStatus === 'complete' ? '完整' : city.archiveStatus === 'partial' ? '部分成卷' : city.archiveStatus} />
      </div>

      {(['landmarks', 'relics', 'figures'] as const).map((key) => {
        const title = key === 'landmarks' ? '代表景点' : key === 'relics' ? '代表文物' : '代表人物';
        const entries = city[key];
        if (entries.length === 0) return null;
        return (
          <div key={key} className="mt-5">
            <p className="eyebrow">{title}</p>
            <ul className="mt-2 space-y-1.5">
              {entries.map((entry) => (
                <li key={entry.name} className="text-xs leading-relaxed">
                  <span className="font-serif text-sm">{entry.name}</span>
                  <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--text-secondary)]">
                    {entry.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      <div className="mt-5 flex items-center gap-2 border-t pt-4 hairline">
        <span className="text-[10px] text-[var(--text-secondary)]">主题色</span>
        {(['primary', 'secondary', 'accent'] as const).map((key) => (
          <span
            key={key}
            className="h-4 w-4 rounded-full border border-black/10"
            style={{ background: palette[key] }}
          />
        ))}
        <span className="ml-auto mono text-[9px] text-[var(--text-secondary)]">
          成卷于 {city.generatedAt.slice(0, 10)}
        </span>
      </div>
      <Link to={`/city/${city.cityId}`} className="ink-btn mt-4 px-3 py-1.5 text-[10px]">
        进入 {city.standardName} 完整档案
      </Link>
    </article>
  );
}

export function ComparePage() {
  const [params, setParams] = useSearchParams();
  const [firstId, secondId] = useMemo(() => readCityIds(params), [params]);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!firstId || !secondId) {
      setData(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setData(null);
    setError(null);
    void getCompare(firstId, secondId, controller.signal)
      .then(setData)
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        const message = (fetchError as Error).message || '对比加载失败';
        setError(message);
      });
    return () => controller.abort();
  }, [firstId, secondId]);

  const pick = useCallback(
    (slot: 'first' | 'second') => (cityId: string) => {
      const next = new URLSearchParams(params);
      const first = slot === 'first' ? cityId : firstId ?? '';
      const second = slot === 'second' ? cityId : secondId ?? '';
      if (first && second) next.set('cities', `${first},${second}`);
      else next.set('cities', [first, second].filter(Boolean).join(','));
      setParams(next, { replace: true });
    },
    [params, firstId, secondId, setParams],
  );

  const share = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="page-shell py-12">
      <p className="eyebrow">CITYLENS · 双城对比</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-serif text-4xl tracking-[0.12em] md:text-5xl">两城并读</h1>
        {firstId && secondId ? (
          <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={() => void share()}>
            {copied ? '链接已复制' : '复制分享链接'}
          </button>
        ) : null}
      </div>
      <p className="mt-3 max-w-2xl text-xs leading-[1.9] text-[var(--text-secondary)]">
        选择两座已生成档案的城市并排对比：人设、经济人口、气候、代表景点 / 文物 / 人物与诗词收录。
        缺失数据一律「待考」，不做估算。
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <CityPicker label="第一城" value={firstId} onPick={pick('first')} />
        <CityPicker label="第二城" value={secondId} onPick={pick('second')} />
      </div>

      {error ? (
        <p className="mt-8 rounded-sm border border-dashed p-6 text-center text-xs leading-relaxed text-[var(--text-secondary)] hairline" role="alert">
          {error}
        </p>
      ) : null}

      {data ? (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <CityColumn city={data.cities[0]} />
          <CityColumn city={data.cities[1]} />
        </div>
      ) : !error && firstId && secondId ? (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="surface-card h-64 animate-pulse rounded-md" aria-busy="true" />
          <div className="surface-card h-64 animate-pulse rounded-md" aria-busy="true" />
        </div>
      ) : null}
    </div>
  );
}
