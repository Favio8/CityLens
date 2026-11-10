/** 首页首屏：水墨粒子、书写感标题、巨幅搜索入口。 */
import { Link } from 'react-router-dom';
import type { HotCity } from '@citylens/shared/schema';
import { useSearch } from '../search/SearchProvider';
import { InkCanvas } from './InkCanvas';

const MODULES = [
  ['壹', '城市名片'],
  ['贰', '前世今生'],
  ['叁', '景点地图'],
  ['肆', '文物重器'],
  ['伍', '名人故里'],
  ['陆', '诗词文脉'],
  ['柒', '城市性格'],
  ['捌', '数据脉搏'],
] as const;

export function HomeHero({ hot }: { hot: HotCity[] }) {
  const { openSearch } = useSearch();

  return (
    <section className="relative flex min-h-[92svh] flex-col justify-center overflow-hidden" aria-labelledby="home-title">
      <InkCanvas />
      <div className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-[var(--border-subtle)] to-transparent lg:block" />

      <div className="page-shell relative py-24">
        <div className="flex items-start justify-between gap-8">
          <p className="eyebrow reveal" style={{ animationDelay: '120ms' }}>
            CityLens · 城市人文档案
          </p>
          <p className="vertical-label hidden text-[10px] text-[var(--text-secondary)] md:block" aria-hidden>
            东方美学 · 数字动感
          </p>
        </div>

        <h1 id="home-title" className="mt-8 md:mt-10">
          <span className="write-in block font-serif text-[52px] font-semibold leading-[1.12] tracking-[0.12em] md:text-[92px] xl:text-[110px]">
            以一城为卷
          </span>
          <span
            className="write-in mt-1 block font-serif text-[52px] font-semibold leading-[1.12] tracking-[0.12em] text-[var(--city-primary)] md:mt-2 md:text-[92px] xl:text-[110px]"
            style={{ animationDelay: '0.35s' }}
          >
            读千年中国
          </span>
        </h1>

        <p
          className="reveal mt-7 max-w-xl text-sm leading-[1.9] text-[var(--text-secondary)] md:text-base"
          style={{ animationDelay: '0.5s' }}
        >
          输入一座城，八位数字方志官同时落笔：前世今生、景点文物、名人诗脉、烟火日常。
          每一处事实都标注来源，每一段未考都诚实留白。
        </p>

        <div className="reveal mt-10 max-w-2xl" style={{ animationDelay: '0.65s' }}>
          <button
            type="button"
            onClick={openSearch}
            className="group flex w-full items-center justify-between gap-4 rounded-full border py-3 pl-6 pr-3 text-left transition-all duration-500 hover:border-[var(--city-primary)] hover:shadow-[var(--shadow-soft)] hairline md:py-4 md:pl-8"
            style={{ background: 'var(--bg-surface)' }}
            aria-label="打开城市搜索"
          >
            <span className="flex items-center gap-3 text-sm tracking-[0.08em] text-[var(--text-secondary)] md:text-base">
              <span className="hidden h-2 w-2 rounded-full bg-[var(--city-primary)] md:inline-block" aria-hidden />
              输入城市名、古称或拼音
            </span>
            <span className="ink-btn ink-btn--solid shrink-0 rounded-full px-5 py-2.5 text-xs tracking-[0.2em] md:px-7">
              展卷
              <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span>
            </span>
          </button>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[10px] tracking-[0.24em] text-[var(--text-secondary)]">如今可读</span>
            {hot.slice(0, 6).map((city) => (
              <Link key={city.cityId} to={`/city/${city.cityId}`} className="city-pill">
                {city.name}
              </Link>
            ))}
          </div>
        </div>

        <div
          className="reveal mt-14 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-3 border-t pt-6 hairline sm:grid-cols-4"
          style={{ animationDelay: '0.8s' }}
        >
          {MODULES.map(([index, name]) => (
            <div key={index} className="flex items-baseline gap-2">
              <span className="hanzi-index text-[10px]">{index}</span>
              <span className="font-serif text-xs tracking-[0.14em] md:text-sm">{name}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 md:flex" aria-hidden>
        <span className="text-[9px] tracking-[0.36em] text-[var(--text-secondary)]">SCROLL</span>
        <span className="h-10 w-px overflow-hidden bg-[var(--border-subtle)]">
          <span className="block h-4 w-px animate-[ink-rise_2s_ease-in-out_infinite] bg-[var(--city-primary)]" />
        </span>
      </div>
    </section>
  );
}
