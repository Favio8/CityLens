/** 城市页：读取缓存 / 流式生成 / 模块渲染 / 失败与冷却状态。 */
import { useEffect, useMemo } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { IdentitySchema, type Identity } from '@citylens/shared/schema';
import { CityHero } from '../components/hero/CityHero';
import { ScrollNav } from '../components/layout/ScrollNav';
import { Reveal } from '../components/ui/Reveal';
import { SectionShell } from '../components/ui/SectionShell';
import { useCityStream } from '../hooks/useCityStream';
import { useCityTheme } from '../hooks/useDynamicTheme';
import { useLocalLibrary } from '../hooks/useLocalLibrary';
import { formatRetry } from '../lib/format';
import { useSearch } from '../components/search/SearchProvider';

const MODULE_TITLES = [
  ['identity', '01', '城市名片'],
  ['chronicle', '02', '前世今生'],
  ['landmarks', '03', '景点地图'],
  ['relics', '04', '文物重器'],
  ['figures', '05', '名人故里'],
  ['poetics', '06', '诗词文脉'],
  ['localSoul', '07', '城市性格'],
  ['dataPulse', '08', '数据脉搏'],
] as const;

export function CityPage() {
  const { cityId = '' } = useParams();
  const location = useLocation();
  const hint = (location.state as { hint?: string | null } | null)?.hint ?? null;
  const { state, retryModule, regenerate } = useCityStream(cityId);
  const { openSearch } = useSearch();
  const { isFavorite, toggleFavorite, addRecent } = useLocalLibrary();

  useCityTheme(state.theme ?? state.archive?.meta.themePalette ?? state.meta?.themePalette ?? null);

  const identity = useMemo<Identity | null>(() => {
    const raw =
      state.archive?.identity ??
      (state.modules.identity?.data as unknown) ??
      null;
    if (!raw) return null;
    const parsed = IdentitySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }, [state.archive, state.modules.identity]);

  useEffect(() => {
    if (!state.meta) return;
    addRecent({ cityId: state.meta.cityId, name: state.meta.standardName });
    document.title = `${state.meta.standardName} · CityLens 读城`;
    return () => {
      document.title = 'CityLens 读城';
    };
  }, [state.meta, addRecent]);

  if (state.phase === 'not_found') {
    return (
      <StatusScreen
        title="版图中暂无此城"
        description="一期收录地级及以上行政区与少量文旅名城。请换一个名字，或从热门名城开始。"
        actionLabel="重新搜索"
        onAction={openSearch}
      />
    );
  }

  if (state.phase === 'unavailable') {
    return (
      <StatusScreen
        title="读城引擎尚未配置"
        description="服务端未检测到可用的大模型 Key。请按 README 配置 LLM_API_KEY，或使用模拟模式继续体验。"
        actionLabel="返回卷首"
        onAction={() => window.location.assign('/')}
      />
    );
  }

  if (state.phase === 'cooldown') {
    return (
      <StatusScreen
        title="此城刚刚起卷"
        description={`${state.fatal?.message ?? '为避免重复消耗，请稍后再来。'}${
          state.fatal?.retryAfterSec ? `（约 ${formatRetry(state.fatal.retryAfterSec)}后）` : ''
        }`}
        actionLabel="返回卷首"
        onAction={() => window.location.assign('/')}
      />
    );
  }

  if (state.phase === 'error' && !state.meta) {
    return (
      <StatusScreen
        title="展卷未成"
        description={state.fatal?.message ?? '生成过程出现未知错误，请稍后重试。'}
        actionLabel="重新展卷"
        onAction={() => void regenerate()}
      />
    );
  }

  const persona =
    identity && typeof identity.oneLinePersona === 'string' ? identity.oneLinePersona : null;
  const moduleCount = Object.keys(state.modules).length;

  return (
    <div>
      <CityHero
        meta={state.meta}
        phase={state.phase}
        moduleCount={moduleCount}
        fromCache={state.fromCache}
        isFavorite={isFavorite(cityId)}
        persona={persona}
        hint={hint}
        onToggleFavorite={() => toggleFavorite(cityId)}
        onRegenerate={() => regenerate()}
      />
      <ScrollNav />

      <main className="page-shell pb-10">
        {state.phase === 'reading' ? (
          <ReadingSkeleton cityId={cityId} />
        ) : (
          <div>
            {MODULE_TITLES.map(([name, index, title]) => {
              const module = state.modules[name];
              const error = state.errors[name];
              return (
                <SectionShell
                  key={name}
                  id={name}
                  index={index}
                  title={title}
                  aside={
                    module ? (
                      <span className="mono text-[10px] tracking-[0.16em] text-[var(--text-secondary)]">
                        {module.status === 'degraded' ? '降级成卷' : '已成卷'}
                      </span>
                    ) : error ? (
                      <button
                        type="button"
                        onClick={() => retryModule(name)}
                        className="ink-btn px-3 py-1.5 text-[10px]"
                      >
                        重试此卷
                      </button>
                    ) : (
                      <span className="mono text-[10px] tracking-[0.16em] text-[var(--text-secondary)]">
                        显影中
                      </span>
                    )
                  }
                >
                  <Reveal>
                    <div className="surface-card rounded-md p-8">
                      <p className="font-serif text-sm leading-relaxed text-[var(--text-secondary)]">
                        {error
                          ? `此卷未能成卷（${error.code}），可单独重试，不影响其他卷。`
                          : module
                            ? '此卷数据已就绪，正在排版。'
                            : '方志官正在检索与校验，请稍候。'}
                      </p>
                      {!module && !error ? (
                        <div className="mt-6 space-y-3" aria-hidden>
                          <div className="ink-breathe h-3 w-2/3 rounded bg-[var(--border-subtle)]" />
                          <div className="ink-breathe h-3 w-full rounded bg-[var(--border-subtle)]" style={{ animationDelay: '0.2s' }} />
                          <div className="ink-breathe h-3 w-4/5 rounded bg-[var(--border-subtle)]" style={{ animationDelay: '0.4s' }} />
                        </div>
                      ) : null}
                    </div>
                  </Reveal>
                </SectionShell>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function ReadingSkeleton({ cityId }: { cityId: string }) {
  return (
    <div className="py-10">
      <p className="mono text-[10px] tracking-[0.3em] text-[var(--text-secondary)]">
        READING ARCHIVE · {cityId}
      </p>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="surface-card rounded-md p-8">
            <div className="ink-breathe h-2.5 w-16 rounded bg-[var(--border-subtle)]" />
            <div className="mt-6 space-y-3">
              <div className="ink-breathe h-3 w-3/4 rounded bg-[var(--border-subtle)]" style={{ animationDelay: '0.1s' }} />
              <div className="ink-breathe h-3 w-full rounded bg-[var(--border-subtle)]" style={{ animationDelay: '0.25s' }} />
              <div className="ink-breathe h-3 w-5/6 rounded bg-[var(--border-subtle)]" style={{ animationDelay: '0.4s' }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusScreen({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="relative flex min-h-[70vh] items-center justify-center overflow-hidden px-5">
      <div className="page-shell max-w-xl text-center">
        <p className="eyebrow">CITYLENS · 读城</p>
        <h1 className="mt-6 font-serif text-[42px] leading-tight tracking-[0.12em] md:text-[56px]">{title}</h1>
        <p className="mt-5 text-sm leading-[1.9] text-[var(--text-secondary)]">{description}</p>
        <button type="button" onClick={onAction} className="ink-btn ink-btn--solid mt-8">
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
