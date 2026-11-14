/**
 * 城市档案流式读取的状态机（PRD 2.2 状态机 / 3.4 SSE 协议）。
 * 框架无关：React Hook（useCityStream）只负责把控制器状态映射进组件。
 *
 * 关键不变量：
 * - 每个请求带「城市 + 批次」令牌，迟到的异步回写一律丢弃；
 * - 流在 done 前 EOF/中断时执行有界自动重连（复用服务端单飞任务与回放）；
 * - 重连耗尽后给出明确错误态与重试入口，绝不永久停留在「生成中」；
 * - 切换城市只取消前端订阅，服务端任务按原规则继续（本模块不发取消语义）。
 */
import {
  MODULE_NAMES,
  SseDoneEventSchema,
  SseErrorEventSchema,
  SseMetaEventSchema,
  SseModuleErrorEventSchema,
  SseModuleEventSchema,
  SseNoticeEventSchema,
  SseThemeEventSchema,
  type CityArchiveResponse,
  type Meta,
  type ModuleName,
  type SseDoneEvent,
  type SseModuleErrorEvent,
  type ThemePalette,
  type SourceRef,
} from '@citylens/shared/schema';
import { ApiRequestError } from './api';
import { consumeSse, type RawSseEvent } from './sse';

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

export const initialStreamState: CityStreamState = {
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

export function mapApiError(error: ApiRequestError): Partial<CityStreamState> {
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

export interface GenerateOptions {
  force?: boolean;
  modules?: ModuleName[];
  adminToken?: string;
}

export interface CityStreamDeps {
  fetchArchive: (cityId: string, signal: AbortSignal) => Promise<CityArchiveResponse>;
  fetchStream: (
    cityId: string,
    options: GenerateOptions,
    signal: AbortSignal,
  ) => Promise<Response>;
  consume: (
    response: Response,
    onEvent: (event: RawSseEvent) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  onChange: (state: CityStreamState) => void;
  /** 自动重连次数上限（默认 2）。 */
  maxReconnects?: number;
  /** 自动重连延迟（默认 800ms）。 */
  reconnectDelayMs?: number;
  /** 可注入的延时实现，便于测试。 */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_MAX_RECONNECTS = 2;
const DEFAULT_RECONNECT_DELAY_MS = 800;

const defaultWait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

export class CityStreamController {
  private state: CityStreamState = initialStreamState;
  private cityId: string | null = null;
  /** 请求批次：openCity / startGeneration 都会递增，旧批次回写全部失效。 */
  private batch = 0;
  private streamController: AbortController | null = null;
  private archiveController: AbortController | null = null;
  private autoStartedBatch = -1;
  private reconnects = 0;
  private readonly maxReconnects: number;
  private readonly reconnectDelayMs: number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private closed = false;

  constructor(private readonly deps: CityStreamDeps) {
    this.maxReconnects = deps.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    this.reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.wait = deps.wait ?? defaultWait;
  }

  getState(): CityStreamState {
    return this.state;
  }

  /** 打开一座城市：取消旧订阅、重置状态、读缓存，未生成则自动发起一次生成。 */
  openCity(cityId: string): void {
    this.closed = false;
    this.cityId = cityId;
    this.batch += 1;
    const batch = this.batch;
    this.reconnects = 0;
    this.abortStream();
    this.abortArchive();
    this.commit(initialStreamState, batch);

    void (async () => {
      try {
        const archive = await this.deps.fetchArchive(cityId, this.archiveSignal(batch));
        if (!this.isCurrent(batch)) return;
        this.commit(
          {
            ...initialStreamState,
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
          },
          batch,
        );
      } catch (error) {
        if (!this.isCurrent(batch)) return;
        if (error instanceof ApiRequestError) {
          this.commit({ ...initialStreamState, ...mapApiError(error) }, batch);
          if (error.code === 'NOT_GENERATED' && this.autoStartedBatch !== batch) {
            this.autoStartedBatch = batch;
            void this.startGeneration();
          }
          return;
        }
        this.commit(
          {
            ...initialStreamState,
            phase: 'error',
            fatal: { code: 'NETWORK_ERROR', message: '网络中断，未能连通读城服务' },
          },
          batch,
        );
      }
    })();
  }

  /** 发起（或并入）一次流式生成；重复调用在同一批次内被忽略。 */
  async startGeneration(options: GenerateOptions = {}): Promise<void> {
    if (this.closed) return;
    const cityId = this.cityId;
    if (!cityId) return;
    if (this.streamController && !this.streamController.signal.aborted) return;
    this.batch += 1;
    const batch = this.batch;
    this.reconnects = 0;
    this.abortStream();
    const controller = new AbortController();
    this.streamController = controller;

    this.commit(
      {
        ...this.state,
        phase: 'streaming_init',
        fatal: null,
        fromCache: false,
        notice: null,
      },
      batch,
    );

    try {
      const response = await this.deps.fetchStream(cityId, options, controller.signal);
      if (!this.isCurrent(batch)) return;
      if (!response.ok || !response.body) {
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
      await this.deps.consume(response, (event) => this.handleEvent(event, batch), controller.signal);
      if (!this.isCurrent(batch)) return;
      // 流正常结束但未收到 done：网络中断或被截断，走有界重连。
      if (this.state.done === null) {
        await this.reconnectOrFail(options, batch);
      }
    } catch (error) {
      if (!this.isCurrent(batch)) return;
      if ((error as Error).name === 'AbortError') return;
      if (error instanceof ApiRequestError) {
        this.commit({ ...this.state, ...mapApiError(error) }, batch);
        return;
      }
      this.commit(
        {
          ...this.state,
          phase: 'error',
          fatal: { code: 'NETWORK_ERROR', message: '网络中断，未能连通读城服务' },
        },
        batch,
      );
    } finally {
      // 只清理本批次自己的流句柄，绝不清除新任务的运行标志。
      if (this.streamController === controller) this.streamController = null;
    }
  }

  retryModule(name: ModuleName): void {
    if (!MODULE_NAMES.includes(name)) return;
    void this.startGeneration({ modules: [name] });
  }

  regenerate(adminToken?: string): void {
    void this.startGeneration({ force: true, adminToken });
  }

  /** 卸载/离开：取消全部在途请求；服务端任务不受影响。 */
  close(): void {
    this.closed = true;
    this.batch += 1;
    this.abortStream();
    this.abortArchive();
  }

  /* ---------------------------------------------------------------------- */

  private isCurrent(batch: number): boolean {
    return !this.closed && batch === this.batch && this.cityId !== null;
  }

  private archiveSignal(batch: number): AbortSignal {
    this.abortArchive();
    const controller = new AbortController();
    this.archiveController = controller;
    void batch;
    return controller.signal;
  }

  private abortArchive(): void {
    this.archiveController?.abort();
    this.archiveController = null;
  }

  private abortStream(): void {
    this.streamController?.abort();
    this.streamController = null;
  }

  private commit(patch: CityStreamState, batch: number): void {
    if (!this.isCurrent(batch)) return;
    this.state = patch;
    this.deps.onChange(patch);
  }

  private handleEvent(event: RawSseEvent, batch: number): void {
    if (!this.isCurrent(batch)) return;
    if (event.event === 'ping') return;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (event.event === 'notice') {
      const parsed = SseNoticeEventSchema.safeParse(payload);
      if (parsed.success) {
        this.commit({ ...this.state, notice: parsed.data.message }, batch);
      }
      return;
    }

    if (event.event === 'meta') {
      const parsed = SseMetaEventSchema.safeParse(payload);
      if (!parsed.success) return;
      const meta: Meta = {
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
        themePalette: this.state.theme ?? {
          light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
          dark: { primary: '#D98A6E', secondary: '#A8ADB4', accent: '#E0B860' },
        },
      };
      this.commit(
        { ...this.state, phase: 'streaming_modules', jobId: parsed.data.jobId, meta },
        batch,
      );
      return;
    }

    if (event.event === 'theme') {
      const parsed = SseThemeEventSchema.safeParse(payload);
      if (!parsed.success) return;
      this.commit(
        { ...this.state, theme: { light: parsed.data.light, dark: parsed.data.dark } },
        batch,
      );
      return;
    }

    if (event.event === 'module') {
      const parsed = SseModuleEventSchema.safeParse(payload);
      if (!parsed.success) return;
      this.commit(
        {
          ...this.state,
          phase: 'streaming_modules',
          modules: {
            ...this.state.modules,
            [parsed.data.name]: {
              name: parsed.data.name,
              status: parsed.data.status,
              data: parsed.data.data,
              sources: parsed.data.sources,
            },
          },
          errors: Object.fromEntries(
            Object.entries(this.state.errors).filter(([key]) => key !== parsed.data.name),
          ) as Partial<Record<ModuleName, SseModuleErrorEvent>>,
        },
        batch,
      );
      return;
    }

    if (event.event === 'module_error') {
      const parsed = SseModuleErrorEventSchema.safeParse(payload);
      if (!parsed.success) return;
      this.commit(
        { ...this.state, errors: { ...this.state.errors, [parsed.data.name]: parsed.data } },
        batch,
      );
      return;
    }

    if (event.event === 'done') {
      const parsed = SseDoneEventSchema.safeParse(payload);
      if (!parsed.success) return;
      void this.handleDone(parsed.data, batch);
      return;
    }

    if (event.event === 'error') {
      const parsed = SseErrorEventSchema.safeParse(payload);
      if (!parsed.success) return;
      this.commit(
        {
          ...this.state,
          phase: 'error',
          fatal: {
            code: parsed.data.code,
            message: parsed.data.message,
            retryAfterSec: parsed.data.retryAfterSec,
          },
        },
        batch,
      );
    }
  }

  /** done 收尾：未发布走冷却/未收录；已发布补拉完整档案（受批次保护）。 */
  private async handleDone(done: SseDoneEvent, batch: number): Promise<void> {
    this.commit({ ...this.state, done, phase: 'ready' }, batch);
    try {
      const archive = await this.deps.fetchArchive(done.cityId, this.archiveSignal(batch));
      if (!this.isCurrent(batch)) return;
      this.commit(
        {
          ...this.state,
          archive,
          meta: archive.meta,
          theme: archive.meta.themePalette,
          fromCache: false,
          phase: 'ready',
        },
        batch,
      );
    } catch (error) {
      if (!this.isCurrent(batch)) return;
      if (error instanceof ApiRequestError) {
        // 未达发布门槛：按服务端的精确状态（冷却 / 未收录）收尾。
        if (done.status === 'unpublished') {
          this.commit({ ...this.state, ...mapApiError(error) }, batch);
        }
        // 已发布但补拉失败：流式数据已足够展示，保持 ready。
      }
    }
  }

  /** 有界重连：复用服务端单飞任务（并入并回放），保留已收到的模块。 */
  private async reconnectOrFail(options: GenerateOptions, batch: number): Promise<void> {
    if (!this.isCurrent(batch)) return;
    if (this.reconnects >= this.maxReconnects) {
      this.commit(
        {
          ...this.state,
          phase: 'error',
          fatal: {
            code: 'STREAM_INTERRUPTED',
            message: '读城流中断，已生成的卷不会丢失，点击重新展卷即可继续',
          },
        },
        batch,
      );
      return;
    }
    this.reconnects += 1;
    // 本批次的流已正常结束：先释放句柄，等待期间允许取消（切换城市/重新开始）。
    this.streamController = null;
    try {
      await this.wait(this.reconnectDelayMs, new AbortController().signal);
    } catch {
      return; // 等待期间被取消（切换城市/重新开始）
    }
    if (!this.isCurrent(batch)) return;
    // isCurrent 已保证没有更新批次的任务在跑（startGeneration 会递增批次）。
    this.batch += 1;
    const nextBatch = this.batch;
    const controller = new AbortController();
    this.streamController = controller;
    try {
      const cityId = this.cityId;
      if (!cityId) return;
      const response = await this.deps.fetchStream(cityId, options, controller.signal);
      if (!this.isCurrent(nextBatch)) return;
      if (!response.ok || !response.body) {
        throw new ApiRequestError('REQUEST_FAILED', '重连失败，请稍后重试', response.status);
      }
      await this.deps.consume(
        response,
        (event) => this.handleEvent(event, nextBatch),
        controller.signal,
      );
      if (!this.isCurrent(nextBatch)) return;
      if (this.state.done === null) {
        await this.reconnectOrFail(options, nextBatch);
      }
    } catch (error) {
      if (!this.isCurrent(nextBatch)) return;
      if ((error as Error).name === 'AbortError') return;
      if (error instanceof ApiRequestError) {
        this.commit({ ...this.state, ...mapApiError(error) }, nextBatch);
        return;
      }
      await this.reconnectOrFail(options, nextBatch);
    } finally {
      if (this.streamController === controller) this.streamController = null;
    }
  }
}
