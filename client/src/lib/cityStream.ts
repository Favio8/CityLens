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

/**
 * 从缓存档案取回「最近一次生成尝试失败」记录。
 * 刷新失败但旧内容仍可用时，整页刷新后也要能看到失败提示与单卷重试入口。
 */
export function archiveToErrors(
  archive: CityArchiveResponse,
): Partial<Record<ModuleName, SseModuleErrorEvent>> {
  const result: Partial<Record<ModuleName, SseModuleErrorEvent>> = {};
  const attempts = archive.meta.moduleAttempts ?? {};
  for (const [name, attempt] of Object.entries(attempts)) {
    if (!attempt || attempt.status !== 'failed') continue;
    result[name as ModuleName] = {
      seq: 0,
      name: name as ModuleName,
      code: attempt.code,
      retryable: attempt.code !== 'NO_FACTS',
    };
  }
  return result;
}

/**
 * 是否「可恢复的网络类异常」：连接失败（fetch TypeError）、响应体读取中断、
 * 以及没有业务错误体的非 ok 响应。这类异常与「缺少 done 的 EOF」走同一条
 * 有界重连流程；带明确业务码的错误（COOLDOWN/BUDGET_EXCEEDED/…）不重连。
 */
export function isRecoverableStreamError(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    return error.code === 'REQUEST_FAILED';
  }
  return true;
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
  /** 用户发起的生成尝试标识；缺省时由控制器生成。 */
  attemptId?: string;
}

/** 恢复请求：只携带稳定任务标识，绝不携带 force/modules。 */
export interface ResumeOptions {
  jobId?: string;
  attemptId?: string;
}

export interface CityStreamDeps {
  fetchArchive: (cityId: string, signal: AbortSignal) => Promise<CityArchiveResponse>;
  fetchStream: (
    cityId: string,
    options: GenerateOptions,
    signal: AbortSignal,
  ) => Promise<Response>;
  /** 只读恢复：并入运行中的原任务或回放其终态；不得创建新生成。 */
  fetchResume: (cityId: string, options: ResumeOptions, signal: AbortSignal) => Promise<Response>;
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

/** 一次用户发起的生成尝试的稳定标识；与 jobId 独立，meta 丢失时仍可恢复。 */
function createAttemptId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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
  /** 本次用户发起的生成尝试标识：恢复时与 meta.jobId 一起构成稳定任务标识。 */
  private attemptId: string | null = null;
  /** 本轮生成的完成标记：与 state.done（可能是上一轮/缓存的 done）严格区分。 */
  private runDone = false;
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
    this.attemptId = null;
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
            // 刷新失败但旧内容可用的模块：缓存读取也要带回失败提示与重试入口。
            errors: archiveToErrors(archive),
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

  /**
   * 用户显式发起（或并入）一次流式生成：开始生成 / 强制刷新 / 单卷重试。
   * 每次都是新的生成尝试（新 attemptId），恢复原任务不走这里。
   */
  async startGeneration(options: GenerateOptions = {}): Promise<void> {
    if (this.closed) return;
    const cityId = this.cityId;
    if (!cityId) return;
    if (this.streamController && !this.streamController.signal.aborted) return;
    this.batch += 1;
    const batch = this.batch;
    this.reconnects = 0;
    // 新一轮生成：完成标记只属于本轮，绝不能用上一轮（或缓存）的 done 判断本轮结束。
    this.runDone = false;
    this.abortStream();
    const controller = new AbortController();
    this.streamController = controller;

    // 新的生成尝试：生成稳定 attemptId；上一轮 jobId 不再适用，
    // 否则「meta 前断线」的恢复会错误地找回上一轮任务。
    const attemptId = options.attemptId ?? createAttemptId();
    this.attemptId = attemptId;

    this.commit(
      {
        ...this.state,
        // 保留已缓存的模块/档案/主题（旧内容不闪退），只重置本轮相关状态。
        phase: 'streaming_init',
        done: null,
        errors: {},
        fatal: null,
        fromCache: false,
        notice: null,
        jobId: null,
      },
      batch,
    );

    await this.runConnection('generate', { ...options, attemptId }, batch, controller);
  }

  /**
   * 断线恢复 / 「继续展卷」：只读取状态、回放原任务终态或并入运行中的原任务。
   * 不产生新生成请求（无 force/modules），因此不新增任务、不调用生成器、不计费。
   */
  async resumeGeneration(): Promise<void> {
    if (this.closed) return;
    const cityId = this.cityId;
    if (!cityId) return;
    if (this.streamController && !this.streamController.signal.aborted) return;
    this.batch += 1;
    const batch = this.batch;
    this.reconnects = 0;
    this.runDone = false;
    this.abortStream();
    const controller = new AbortController();
    this.streamController = controller;

    this.commit(
      {
        ...this.state,
        // 保留已收到的模块与档案（恢复失败也不清空旧内容）。
        phase: 'streaming_init',
        done: null,
        fatal: null,
        notice: null,
      },
      batch,
    );

    await this.runConnection('resume', {}, batch, controller);
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
      // 服务端回显的 attemptId 是权威值（旧客户端可能未生成自己的标识）。
      if (parsed.data.attemptId) this.attemptId = parsed.data.attemptId;
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
      const fromCache = parsed.data.fromCache === true;
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
          // 真正生成成功才清除失败提示；旧内容回放（fromCache）必须保留本轮失败记录，
          // 否则「本次更新失败，继续展示旧内容」与单卷重试入口会一起消失。
          errors: fromCache
            ? this.state.errors
            : (Object.fromEntries(
                Object.entries(this.state.errors).filter(([key]) => key !== parsed.data.name),
              ) as Partial<Record<ModuleName, SseModuleErrorEvent>>),
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
      // 本轮完成标记先落定：即使随后的档案补拉被切城取消，重连判断也已生效。
      this.runDone = true;
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
          // 缓存重新读取同样要保留「最近一次尝试失败」：回放终态时单卷重试入口不消失。
          // 成功重跑的模块已被服务端清除 lastAttempt，不会复活过期失败提示。
          errors: { ...this.state.errors, ...archiveToErrors(archive) },
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

  /**
   * 单次连接执行器：generate 走用户生成契约，resume 走只读恢复契约。
   * 两种连接的异常处理一致：可恢复网络异常走有界恢复；明确业务终态直接收尾。
   */
  private async runConnection(
    kind: 'generate' | 'resume',
    options: GenerateOptions,
    batch: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const cityId = this.cityId;
      if (!cityId) return;
      const response =
        kind === 'generate'
          ? await this.deps.fetchStream(cityId, options, controller.signal)
          : await this.deps.fetchResume(
              cityId,
              {
                ...(this.state.jobId ? { jobId: this.state.jobId } : {}),
                ...(this.attemptId ? { attemptId: this.attemptId } : {}),
              },
              controller.signal,
            );
      if (!this.isCurrent(batch)) return;
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as {
          code?: string;
          message?: string;
          retryAfterSec?: number;
        } | null;
        throw new ApiRequestError(
          payload?.code ?? 'REQUEST_FAILED',
          payload?.message ?? `请求失败（HTTP ${response.status}）`,
          response.status,
          payload?.retryAfterSec,
        );
      }
      await this.deps.consume(
        response,
        (event) => this.handleEvent(event, batch),
        controller.signal,
      );
      if (!this.isCurrent(batch)) return;
      // 流正常结束但本轮未收到 done：网络中断或被截断，走有界恢复。
      if (!this.runDone) await this.reconnectOrFail(batch);
    } catch (error) {
      if (!this.isCurrent(batch)) return;
      // 主动取消（切城 / 关闭 / 重新开始）：静默，不重连。
      if ((error as Error).name === 'AbortError') return;
      // 可恢复的网络类异常（连接失败、响应体读取中断、无业务错误体）：
      // 与「缺少 done 的 EOF」走同一条有界恢复流程。
      if (isRecoverableStreamError(error)) {
        await this.reconnectOrFail(batch);
        return;
      }
      if (error instanceof ApiRequestError) {
        // 明确业务终态（冷却 / 预算 / 恢复不可用 / 未配置…）：
        // 保留服务端 code/message/retryAfterSec，不自动重启生成。
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

  /**
   * 有界恢复：**只调用只读恢复契约**，携带 jobId / attemptId 找回原任务。
   * - 原任务仍在运行：服务端并入并在同一连接上随收尾发送 done；
   * - 原任务已结束：服务端只读回放其终态与可用档案；
   * - 不可恢复（不存在/过期/进程重启）：保留明确错误码，由用户显式重新展卷。
   * 恢复过程不发送 force/modules，因此不会创建第二个生成任务、不会重复计费。
   */
  private async reconnectOrFail(batch: number): Promise<void> {
    if (!this.isCurrent(batch)) return;
    if (this.reconnects >= this.maxReconnects) {
      this.commit(
        {
          ...this.state,
          phase: 'error',
          fatal: {
            code: 'STREAM_INTERRUPTED',
            message: '读城流中断，已生成的卷不会丢失；点击「继续展卷」即可接着读（不会重新扣额度）',
          },
        },
        batch,
      );
      return;
    }
    this.reconnects += 1;
    // 本批次的流已结束：先释放句柄，等待期间允许取消（切换城市/重新开始）。
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
    // 恢复也是「一次新的连接尝试」：完成标记重新计。
    this.runDone = false;
    const controller = new AbortController();
    this.streamController = controller;
    await this.runConnection('resume', {}, nextBatch, controller);
  }
}
