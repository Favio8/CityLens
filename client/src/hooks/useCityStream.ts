/**
 * 城市档案流式读取 Hook（PRD 2.2 状态机 / 3.4 SSE 协议）。
 * - 先读缓存；未生成则自动发起 fetch 流式生成；
 * - 切换城市或卸载时 AbortController.abort()，服务端任务继续完成并落库。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MODULE_NAMES,
  SseDoneEventSchema,
  SseErrorEventSchema,
  SseMetaEventSchema,
  SseNoticeEventSchema,
  SseModuleErrorEventSchema,
  SseModuleEventSchema,
  SseThemeEventSchema,
  type CityArchiveResponse,
  type Meta,
  type ModuleName,
  type SseDoneEvent,
  type SseModuleErrorEvent,
  type ThemePalette,
  type SourceRef,
} from '@citylens/shared/schema';
import { ApiRequestError, getCityArchive } from '../lib/api';
import { consumeSse } from '../lib/sse';

export type StreamPhase =
  | 'reading'
  | 'not_generated'
  | 'streaming_init'
  | 'streaming_modules'
  | 'ready'
  | 'cooldown'
  | 'unavailable'
  | 'not_found'
  | 'error';

export interface StreamedModule {
  name: ModuleName;
  status: 'ok' | 'degraded';
  data: unknown;
  sources: SourceRef[];
}

export interface FatalError {
  code: string;
  message: string;
  retryAfterSec?: number;
}

export interface CityStreamState {
  phase: StreamPhase;
  meta: Meta | null;
  theme: ThemePalette | null;
  modules: Partial<Record<ModuleName, StreamedModule>>;
  errors: Partial<Record<ModuleName, SseModuleErrorEvent>>;
  done: SseDoneEvent | null;
  archive: CityArchiveResponse | null;
  fromCache: boolean;
  fatal: FatalError | null;
  jobId: string | null;
  notice: string | null;
}

const initialState: CityStreamState = {
  phase: 'reading',
  meta: null,
  theme: null,
  modules: {},
  errors: {},
  done: null,
  archive: null,
  fromCache: false,
  fatal: null,
  jobId: null,
  notice: null,
};

/** 把缓存档案转成与流式事件一致的模块结构，供统一渲染。 */
export function archiveToModules(
  archive: CityArchiveResponse,
): Partial<Record<ModuleName, StreamedModule>> {
  const result: Partial<Record<ModuleName, StreamedModule>> = {};
  for (const name of MODULE_NAMES) {
    const data = archive[name];
    const status = archive.meta.moduleStatus[name];
    if (data !== null && data !== undefined && (status === 'ok' || status === 'degraded')) {
      result[name] = { name, status, data, sources: [] };
    }
  }
  return result;
}

function mapApiError(error: ApiRequestError): Partial<CityStreamState> {
  switch (error.code) {
    case 'NOT_GENERATED':
      return { phase: 'not_generated' };
    case 'CITY_NOT_FOUND':
      return { phase: 'not_found', fatal: { code: error.code, message: error.message } };
    case 'COOLDOWN':
      return {
        phase: 'cooldown',
        fatal: { code: error.code, message: error.message, retryAfterSec: error.retryAfterSec },
      };
    case 'LLM_NOT_CONFIGURED':
    case 'NO_LLM_KEY':
      return { phase: 'unavailable', fatal: { code: error.code, message: error.message } };
    default:
      return {
        phase: 'error',
        fatal: {
          code: error.code,
          message: error.message,
          retryAfterSec: error.retryAfterSec,
        },
      };
  }
}

export function useCityStream(cityId: string) {
  const [state, setState] = useState<CityStreamState>(initialState);
  const streamAbortRef = useRef<AbortController | null>(null);
  const autoStartedRef = useRef(false);
  const streamingRef = useRef(false);

  const startGeneration = useCallback(
    async (options: { force?: boolean; modules?: ModuleName[]; adminToken?: string } = {}) => {
      if (streamingRef.current) return;
      streamingRef.current = true;
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;

      setState((prev) => ({
        ...prev,
        phase: 'streaming_init',
        fatal: null,
        fromCache: false,
        notice: null,
      }));

      try {
        const response = await fetch(`/api/cities/${encodeURIComponent(cityId)}/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(options.adminToken ? { 'x-admin-token': options.adminToken } : {}),
          },
          body: JSON.stringify({
            force: options.force ?? false,
            ...(options.modules ? { modules: options.modules } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            code?: string;
            message?: string;
            retryAfterSec?: number;
          } | null;
          throw new ApiRequestError(
            payload?.code ?? 'REQUEST_FAILED',
            payload?.message ?? `生成请求失败（HTTP ${response.status}）`,
            response.status,
            payload?.retryAfterSec,
          );
        }

        await consumeSse(
          response,
          ({ event, data }) => {
            if (event === 'ping') return;
            let payload: unknown;
            try {
              payload = JSON.parse(data);
            } catch {
              return;
            }

            if (event === 'notice') {
              const parsed = SseNoticeEventSchema.safeParse(payload);
              if (parsed.success) setState((prev) => ({ ...prev, notice: parsed.data.message }));
              return;
            }

            if (event === 'meta') {
              const parsed = SseMetaEventSchema.safeParse(payload);
              if (!parsed.success) return;
              setState((prev) => ({
                ...prev,
                phase: 'streaming_modules',
                jobId: parsed.data.jobId,
                meta:
                  prev.meta ??
                  ({
                    cityId: parsed.data.cityId,
                    standardName: parsed.data.standardName,
                    province: parsed.data.province,
                    aliases: parsed.data.aliases,
                    center: parsed.data.center,
                    schemaVersion: '1.1',
                    dataVersion: 0,
                    generatedAt: new Date().toISOString(),
                    status: 'partial',
                    moduleStatus: {},
                    generator: null,
                    isPreset: parsed.data.isPreset,
                    themePalette: prev.theme ?? {
                      light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
                      dark: { primary: '#D98A6E', secondary: '#A8ADB4', accent: '#E0B860' },
                    },
                  } satisfies Meta),
              }));
              return;
            }

            if (event === 'theme') {
              const parsed = SseThemeEventSchema.safeParse(payload);
              if (!parsed.success) return;
              setState((prev) => ({
                ...prev,
                theme: { light: parsed.data.light, dark: parsed.data.dark },
              }));
              return;
            }

            if (event === 'module') {
              const parsed = SseModuleEventSchema.safeParse(payload);
              if (!parsed.success) return;
              setState((prev) => ({
                ...prev,
                phase: 'streaming_modules',
                modules: {
                  ...prev.modules,
                  [parsed.data.name]: {
                    name: parsed.data.name,
                    status: parsed.data.status,
                    data: parsed.data.data,
                    sources: parsed.data.sources,
                  },
                },
                errors: Object.fromEntries(
                  Object.entries(prev.errors).filter(([key]) => key !== parsed.data.name),
                ) as Partial<Record<ModuleName, SseModuleErrorEvent>>,
              }));
              return;
            }

            if (event === 'module_error') {
              const parsed = SseModuleErrorEventSchema.safeParse(payload);
              if (!parsed.success) return;
              setState((prev) => ({
                ...prev,
                errors: { ...prev.errors, [parsed.data.name]: parsed.data },
              }));
              return;
            }

            if (event === 'done') {
              const parsed = SseDoneEventSchema.safeParse(payload);
              if (!parsed.success) return;
              setState((prev) => ({ ...prev, done: parsed.data, phase: 'ready' }));
              // 拉取完整档案（含 sources 与 meta 时间戳），保证展示与缓存一致
              void getCityArchive(cityId)
                .then((archive) => {
                  setState((prev) => ({
                    ...prev,
                    archive,
                    meta: archive.meta,
                    theme: archive.meta.themePalette,
                    fromCache: false,
                    phase: 'ready',
                  }));
                })
                .catch(() => {
                  /* 流式数据已足够展示，忽略补拉失败 */
                });
              return;
            }

            if (event === 'error') {
              const parsed = SseErrorEventSchema.safeParse(payload);
              if (!parsed.success) return;
              setState((prev) => ({
                ...prev,
                phase: 'error',
                fatal: {
                  code: parsed.data.code,
                  message: parsed.data.message,
                  retryAfterSec: parsed.data.retryAfterSec,
                },
              }));
            }
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiRequestError) {
          setState((prev) => ({ ...prev, ...mapApiError(error) }));
        } else {
          setState((prev) => ({
            ...prev,
            phase: 'error',
            fatal: { code: 'NETWORK_ERROR', message: '网络中断，未能连通读城服务' },
          }));
        }
      } finally {
        streamingRef.current = false;
      }
    },
    [cityId],
  );

  useEffect(() => {
    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    autoStartedRef.current = false;
    streamingRef.current = false;
    setState(initialState);

    void (async () => {
      try {
        const archive = await getCityArchive(cityId, controller.signal);
        if (controller.signal.aborted) return;
        setState({
          ...initialState,
          phase: 'ready',
          archive,
          modules: archiveToModules(archive),
          meta: archive.meta,
          theme: archive.meta.themePalette,
          fromCache: true,
          done: {
            seq: 0,
            cityId: archive.meta.cityId,
            status: archive.meta.status,
            failedModules: MODULE_NAMES.filter(
              (name) => archive.meta.moduleStatus[name] === 'failed',
            ),
            generatedAt: archive.meta.generatedAt,
            dataVersion: archive.meta.dataVersion,
          },
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiRequestError) {
          setState((prev) => ({ ...prev, ...mapApiError(error) }));
          if (error.code === 'NOT_GENERATED' && !autoStartedRef.current) {
            autoStartedRef.current = true;
            void startGeneration();
          }
        } else {
          setState((prev) => ({
            ...prev,
            phase: 'error',
            fatal: { code: 'NETWORK_ERROR', message: '网络中断，未能连通读城服务' },
          }));
        }
      }
    })();

    return () => {
      controller.abort();
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      streamingRef.current = false;
    };
  }, [cityId, startGeneration]);

  const retryModule = useCallback(
    (name: ModuleName) => {
      if (!MODULE_NAMES.includes(name)) return;
      void startGeneration({ modules: [name] });
    },
    [startGeneration],
  );

  const regenerate = useCallback(
    (adminToken?: string) => {
      void startGeneration({ force: true, adminToken });
    },
    [startGeneration],
  );

  return { state, startGeneration, retryModule, regenerate };
}
