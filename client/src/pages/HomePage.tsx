/** 首页：首屏 + 八卷说明 + 馆藏名城。 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HotCity } from '@citylens/shared/schema';
import { HomeHero } from '../components/hero/HomeHero';
import { Reveal } from '../components/ui/Reveal';
import { useLocalLibrary } from '../hooks/useLocalLibrary';
import { getHotCities } from '../lib/api';
import { formatDateTime } from '../lib/format';

const VOLUMES = [
  ['壹', '城市名片', '标准名、古称、坐标、面积人口与一句城市人格。'],
  ['贰', '前世今生', '从建城到当代的年表，每个朝代都有可点击的坐标。'],
  ['叁', '景点地图', '必游与秘境分层落图，WGS84 坐标逐点校核。'],
  ['肆', '文物重器', '国保与禁止出境文物名录，讲清它为何重要。'],
  ['伍', '名人故里', '与这座城市互相成就的人物，及其留下的痕迹。'],
  ['陆', '诗词文脉', '诗词逐字比对本地底本，意象必须出现在原文。'],
  ['柒', '城市性格', '本地人的脾气、饮食与街巷，用可考细节说话。'],
  ['捌', '数据脉搏', '人口、GDP 与文旅数据，标注来源与统计年份。'],
] as const;

export function HomePage() {
  const [hot, setHot] = useState<HotCity[]>([]);
  const { favorites, recents, names } = useLocalLibrary();

  useEffect(() => {
    const controller = new AbortController();
    void getHotCities(controller.signal)
      .then(setHot)
      .catch(() => setHot([]));
    return () => controller.abort();
  }, []);

  const presets = hot.filter((city) => city.isPreset).slice(0, 6);
  const fallbackPresets = presets.length > 0 ? presets : hot.slice(0, 6);

  return (
    <div>
      <HomeHero hot={hot} />

      <section className="border-t hairline" aria-labelledby="home-volumes-title">
        <div className="page-shell py-16 md:py-24">
          <Reveal>
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="eyebrow">八卷成志</p>
                <h2 className="section-title mt-3" id="home-volumes-title">一座城的八个切面</h2>
              </div>
              <p className="max-w-md text-xs leading-relaxed text-[var(--text-secondary)]">
                每卷独立生成、独立降级。某卷失败不会拖垮整座城；所有事实附来源，未考之处明确标注。
              </p>
            </div>
          </Reveal>

          <div className="mt-10 grid grid-cols-1 gap-px overflow-hidden border bg-[var(--border-subtle)] sm:grid-cols-2 lg:grid-cols-4 hairline">
            {VOLUMES.map(([index, title, desc], position) => (
              <Reveal key={index} delay={position * 0.05}>
                <article className="group h-full bg-[var(--bg-canvas)] p-6 transition-colors duration-500 hover:bg-[var(--city-primary)]/5">
                  <div className="flex items-baseline justify-between">
                    <span className="hanzi-index">{index}</span>
                    <span className="mono text-[10px] text-[var(--text-secondary)]">
                      {String(position + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <h3 className="mt-5 font-serif text-lg tracking-[0.14em]">{title}</h3>
                  <p className="mt-3 text-xs leading-[1.9] text-[var(--text-secondary)]">{desc}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t hairline" aria-labelledby="home-presets-title">
        <div className="page-shell py-16 md:py-24">
          <Reveal>
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="eyebrow">馆藏名城</p>
                <h2 className="section-title mt-3" id="home-presets-title">六座城的完整档案</h2>
              </div>
              <p className="max-w-md text-xs leading-relaxed text-[var(--text-secondary)]">
                西安、杭州、成都、北京、苏州、洛阳由构建期管线组装，开箱即可读。
              </p>
            </div>
          </Reveal>

          <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-3">
            {fallbackPresets.map((city, position) => (
              <Reveal key={city.cityId} delay={position * 0.06}>
                <Link
                  to={`/city/${city.cityId}`}
                  className="group relative flex h-full min-h-[168px] flex-col justify-between overflow-hidden rounded-md border p-5 transition-all duration-500 hover:-translate-y-1 hover:shadow-[var(--shadow-soft)] hairline"
                  style={{ background: 'var(--bg-surface)' }}
                >
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -bottom-8 -right-3 font-serif text-[112px] leading-none text-[var(--city-primary)] opacity-[0.07] transition-all duration-700 group-hover:opacity-[0.14]"
                  >
                    {city.name.slice(0, 1)}
                  </span>
                  <div>
                    <span className="text-[10px] tracking-[0.2em] text-[var(--text-secondary)]">{city.province}</span>
                    <h3 className="mt-2 font-serif text-2xl tracking-[0.14em]">{city.name}</h3>
                  </div>
                  <p className="relative mt-6 text-[10px] tracking-[0.18em] text-[var(--city-primary)]">
                    {city.isPreset ? '预置馆藏 · 即刻展卷' : '城市档案'}
                    <span aria-hidden className="ml-2 inline-block transition-transform duration-300 group-hover:translate-x-1">→</span>
                  </p>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {favorites.length > 0 || recents.length > 0 ? (
        <section className="border-t hairline" aria-labelledby="home-library-title">
          <div className="page-shell py-16 md:py-20">
            <Reveal>
              <p className="eyebrow">你的书案</p>
              <h2 className="section-title mt-3" id="home-library-title">继续上次的阅读</h2>
            </Reveal>
            <div className="mt-8 grid gap-3 md:grid-cols-2">
              {recents.slice(0, 4).map((entry) => (
                <Link
                  key={entry.cityId}
                  to={`/city/${entry.cityId}`}
                  className="flex items-center justify-between border-b py-3 hairline"
                >
                  <span className="font-serif text-sm tracking-[0.14em]">{entry.name || names[entry.cityId]}</span>
                  <span className="mono text-[10px] text-[var(--text-secondary)]">{formatDateTime(new Date(entry.ts).toISOString())}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
