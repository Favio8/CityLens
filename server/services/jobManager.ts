/**
 * 生成任务编排（PRD 2.2 / 3.5）。
 * 同城单飞：内存 runtime + generation_jobs 唯一索引双保险；
 * 增量生成：已通过校验且最近一次尝试未失败的模块默认跳过；
 * 模块级失败保留旧内容（区分「当前可用内容」与「最近一次生成尝试失败」）；
 * 整体失败进入 10 分钟冷却；单次生成受 180s 总截止约束（PRD v1.2）。
 */
import { randomUUID } from 'node:crypto';
import type {
  ArchiveStatus,
  ModuleErrorCode,
  ModuleName,
  ResumeTerminalCode,
  SourceRef,
  ThemePalette,
} from '../../shared/schema';
import { MODULE_NAMES } from '../../shared/schema';
import { computeArchiveStatus } from '../../shared/validators';
import type { ArchiveRepo } from '../db/archiveRepo';
import { hasUsableModuleContent } from '../db/archiveRepo';
import type { CityBrief, CityRepo } from '../db/cityRepo';
import type { JobRecord, JobRepo } from '../db/jobRepo';
import { ApiError } from '../errors';
import { FAILURE_COOLDOWN_MS } from '../../shared/schema';
import {
  DEFAULT_THEME_PALETTE,
  buildArchiveResponse,
  latestAttempt,
  loadBundle,
  moduleStatusMap,
  reusableModules,
} from './cacheService';
import {
  GenerationError,
  validateModuleData,
  type ModuleGenerator,
} from './llmGenerator';
import { loadCityRecon } from './cityRecon';

export type SseEventName = 'meta' | 'theme' | 'module' | 'module_error' | 'done' | 'error' | 'notice';

export interface SseEnvelope {
  event: SseEventName;
  data: unknown;
  seq: number;
}

export type SseHandler = (event: SseEnvelope) => void;

export interface JobRuntime {
  jobId: string;
  cityId: string;
  /** 客户端发起的生成尝试标识；旧客户端为空。 */
  attemptId: string | null;
  requested: ModuleName[];
  planned: ModuleName[];
  reusable: ModuleName[];
  force: boolean;
  replay: SseEnvelope[];
  subscribers: Set<SseHandler>;
  seq: number;
  finished: boolean;
  startedAt: number;
  sources: Map<string, SourceRef>;
  themePalette: ThemePalette;
  /** 单次生成总截止的中止信号；超时后取消进行中的上游请求。 */
  deadlineAbort: AbortController;
}

export interface StartJobInput {
  city: CityBrief;
  aliases: string[];
  requesterHash: string;
  force: boolean;
  modules: ModuleName[];
  attemptId?: string;
}

export interface ResumeJobInput {
  city: CityBrief;
  aliases: string[];
  jobId?: string;
  attemptId?: string;
}

/**
 * 恢复结果（只读语义，绝不创建任务）：
 * - attached：并入仍在运行的原任务，随其收尾收到终态；
 * - terminal：回放已结束原任务的终态与可用档案；
 * - unavailable：原任务不存在/已过期/不可恢复，需要用户显式发起新生成。
 */
export type ResumeOutcome =
  | { kind: 'attached'; runtime: JobRuntime }
  | {
      kind: 'terminal';
      jobId: string;
      status: ArchiveStatus;
      events: SseEnvelope[];
    }
  | { kind: 'unavailable'; code: ResumeTerminalCode; message: string };

export interface StartJobResult {
  runtime: JobRuntime;
  attached: boolean;
}

/** LLM 预算记账：在真正发出请求前原子地检查并记一次调用（按实际请求时间归属北京日期）。 */
export interface LlmBudget {
  consume(jobId: string, cityId: string, calledAt?: string): boolean;
}

export interface JobManagerDeps {
  archiveRepo: ArchiveRepo;
  jobRepo: JobRepo;
  cityRepo: CityRepo;
  generator: ModuleGenerator;
  budget: LlmBudget;
  now?: () => Date;
  /** 单次生成总截止（PRD v1.2：180s），覆盖侦察、生成与重试全过程。 */
  deadlineMs?: number;
  /** 崩溃遗留任务判定阈值；必须大于 deadlineMs，避免误杀活跃任务。 */
  staleAfterMs?: number;
  /** 无 jobId/attemptId 的兼容恢复窗口：更早的任务视为已过期，不盲目回放。 */
  resumeWindowMs?: number;
}

const DEFAULT_MODULES = [...MODULE_NAMES];
/** PRD v1.2：单模块超时 60s（LLM_TIMEOUT_MS）、单次生成总上限 180s。 */
const DEFAULT_DEADLINE_MS = 180_000;
/** stale 阈值取总截止 + 120s 余量：活跃任务不会被他城 start 误判为崩溃遗留。 */
const DEFAULT_STALE_AFTER_MS = DEFAULT_DEADLINE_MS + 120_000;
/** 兼容恢复窗口 30 分钟：显式 jobId/attemptId 不受此限（只读回放无副作用）。 */
const DEFAULT_RESUME_WINDOW_MS = 30 * 60 * 1000;

function toModuleErrorCode(code: string): ModuleErrorCode {
  if (code === 'LLM_TIMEOUT' || code === 'NO_FACTS' || code === 'BUDGET_EXCEEDED') return code;
  // 总截止到达：对模块表现为可重试的超时。
  if (code === 'GENERATION_DEADLINE') return 'LLM_TIMEOUT';
  // 网络类失败（连接失败 / 接口错误）归入 LLM_TIMEOUT：可重试、不误导为结构问题。
  if (code === 'LLM_NETWORK' || code === 'LLM_HTTP_ERROR') return 'LLM_TIMEOUT';
  if (code === 'SOURCE_MISSING' || code === 'VERIFY_FAILED') return 'VERIFY_FAILED';
  return 'SCHEMA_INVALID';
}

/** 总截止竞争 Promise 的拒绝：用于把「编排层停止等待」与「上游自身失败」区分开。 */
function isDeadlineError(error: unknown): boolean {
  return error instanceof GenerationError && error.code === 'GENERATION_DEADLINE';
}

/** 递归收集模块数据里的 sourceRefs，确保都能在 sources 中找到。 */
export function collectSourceRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceRefs(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'sourceRefs' && Array.isArray(child)) {
        for (const id of child) if (typeof id === 'string') out.add(id);
      } else {
        collectSourceRefs(child, out);
      }
    }
  }
  return out;
}

export class JobManager {
  private readonly runtimes = new Map<string, JobRuntime>();
  private readonly now: () => Date;
  private readonly deadlineMs: number;
  private readonly staleAfterMs: number;
  private readonly resumeWindowMs: number;
  /** 注入了时钟（测试）：截止判定以循环内的时钟检查为准，不武装实时定时器。 */
  private readonly usesInjectedClock: boolean;

  constructor(private readonly deps: JobManagerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.resumeWindowMs = deps.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;
    this.usesInjectedClock = deps.now !== undefined;
  }

  getRuntime(cityId: string): JobRuntime | undefined {
    return this.runtimes.get(cityId);
  }

  /** 同步完成“新建或并入”，返回后调用方即可 attach 并写 SSE。 */
  start(input: StartJobInput): StartJobResult {
    const existing = this.runtimes.get(input.city.cityId);
    if (existing && !existing.finished) return { runtime: existing, attached: true };

    const now = this.now();
    const staleIso = new Date(now.getTime() - this.staleAfterMs).toISOString();
    const cooldownIso = new Date(now.getTime() + FAILURE_COOLDOWN_MS).toISOString();
    this.deps.jobRepo.failStale(staleIso, cooldownIso);

    const bundle = loadBundle(this.deps.archiveRepo, input.city.cityId);
    const reusable = input.force ? new Set<ModuleName>() : reusableModules(bundle);
    // 去重，避免同一模块在单次请求里被重复生成（放大 LLM 调用）。
    const requested = [...new Set(input.modules.length > 0 ? input.modules : DEFAULT_MODULES)];
    const planned = requested.filter((module) => !reusable.has(module));

    this.deps.archiveRepo.ensureArchive({
      cityId: input.city.cityId,
      status: 'unpublished',
      themePalette: bundle?.archive.themePalette ?? DEFAULT_THEME_PALETTE,
      sources: [],
      isPreset: input.city.isPreset,
      generator: null,
      generatedAt: now.toISOString(),
    });

    const jobId = randomUUID();
    const created = this.deps.jobRepo.create({
      jobId,
      cityId: input.city.cityId,
      force: input.force,
      modules: requested,
      requesterHash: input.requesterHash,
      startedAt: now.toISOString(),
      attemptId: input.attemptId ?? null,
    });
    if (!created) {
      const racing = this.runtimes.get(input.city.cityId);
      if (racing && !racing.finished) return { runtime: racing, attached: true };
      // 进程重启后 DB 里的 running 任务尚未被判 stale：按 409 冲突返回，而非 500。
      throw new ApiError('JOB_CONFLICT', '同城已有生成任务，请稍后重试', 409);
    }
    this.deps.jobRepo.clearCooldowns(input.city.cityId);

    const runtime: JobRuntime = {
      jobId,
      cityId: input.city.cityId,
      attemptId: input.attemptId ?? null,
      requested,
      planned,
      reusable: [...reusable],
      force: input.force,
      replay: [],
      subscribers: new Set(),
      seq: 0,
      finished: false,
      startedAt: now.getTime(),
      sources: new Map(
        (bundle?.archive.sources ?? []).map((source) => [source.id, source] as const),
      ),
      themePalette: bundle?.archive.themePalette ?? DEFAULT_THEME_PALETTE,
      deadlineAbort: new AbortController(),
    };
    this.runtimes.set(input.city.cityId, runtime);

    this.push(runtime, 'meta', {
      seq: runtime.seq + 1,
      cityId: input.city.cityId,
      standardName: input.city.standardName,
      province: input.city.province,
      aliases: input.aliases.length > 0 ? input.aliases : [input.city.standardName],
      center: input.city.center,
      isPreset: input.city.isPreset,
      jobId,
      ...(runtime.attemptId ? { attemptId: runtime.attemptId } : {}),
    });
    this.push(runtime, 'theme', {
      seq: runtime.seq + 1,
      light: runtime.themePalette.light,
      dark: runtime.themePalette.dark,
    });

    for (const module of runtime.reusable) {
      if (!requested.includes(module)) continue;
      const record = bundle?.modules.get(module);
      if (!record) continue;
      this.push(runtime, 'module', {
        seq: runtime.seq + 1,
        name: module,
        status: record.status,
        data: record.data,
        sources: [],
        fromCache: true,
      });
    }

    void this.run(runtime, input).catch((error: unknown) => {
      this.failRuntime(runtime, error);
    });

    return { runtime, attached: false };
  }

  attach(runtime: JobRuntime, handler: SseHandler): () => void {
    for (const event of runtime.replay) handler(event);
    if (runtime.finished) return () => undefined;
    runtime.subscribers.add(handler);
    return () => runtime.subscribers.delete(handler);
  }

  /**
   * 断线恢复：只并入运行中的原任务，或只读回放已结束任务的终态。
   * 这里绝不调用 start、绝不创建 generation_jobs、绝不调用生成器或记账，
   * 也不写档案（data_version / generated_at 保持不变）。
   */
  resume(input: ResumeJobInput): ResumeOutcome {
    const cityId = input.city.cityId;
    const active = this.runtimes.get(cityId);
    if (active && !active.finished) {
      // jobId 是任务主键，优先；未收到 meta 时用 attemptId；两者皆无则并入该城运行中任务。
      const matches = input.jobId
        ? input.jobId === active.jobId
        : input.attemptId
          ? input.attemptId === active.attemptId
          : true;
      if (matches) return { kind: 'attached', runtime: active };
    }

    const record = this.locateResumeJob(cityId, input);
    if (record === 'mismatch') {
      return {
        kind: 'unavailable',
        code: 'JOB_MISMATCH',
        message: '该任务不属于此城，无法恢复；如需生成请手动重新展卷',
      };
    }
    if (!record) {
      return {
        kind: 'unavailable',
        code: 'RESUME_UNAVAILABLE',
        message: '没有可恢复的生成任务；如需生成请手动重新展卷',
      };
    }
    if (record.status === 'running') {
      // DB 里仍是 running，但内存中已无对应 runtime（进程重启 / 其它实例）：
      // 无法并入，也绝不新建任务顶替。
      return {
        kind: 'unavailable',
        code: 'JOB_NOT_RESUMABLE',
        message: '原任务已无法恢复（服务可能已重启）；如需生成请手动重新展卷',
      };
    }
    const { status, events } = this.buildTerminalReplay(input.city, input.aliases, record);
    return { kind: 'terminal', jobId: record.jobId, status, events };
  }

  /**
   * 定位待恢复任务：
   * - jobId / attemptId 是稳定任务标识，不做时间窗口限制（回放只读）；
   * - 两者都缺省时退回「同城最近一次任务」，且只认恢复窗口内的任务，避免回放陈旧历史。
   */
  private locateResumeJob(
    cityId: string,
    input: ResumeJobInput,
  ): JobRecord | 'mismatch' | null {
    if (input.jobId) {
      const byJob = this.deps.jobRepo.get(input.jobId);
      if (!byJob) return null;
      if (byJob.cityId !== cityId) return 'mismatch';
      return byJob;
    }
    if (input.attemptId) {
      return this.deps.jobRepo.findByAttempt(cityId, input.attemptId);
    }
    const latest = this.deps.jobRepo.findLatestByCity(cityId);
    if (!latest) return null;
    const startedAt = Date.parse(latest.startedAt);
    if (!Number.isFinite(startedAt) || this.now().getTime() - startedAt > this.resumeWindowMs) {
      return null;
    }
    return latest;
  }

  /** 已结束任务的终态回放：meta/theme/可用模块/失败提示/done，全部来自只读读取。 */
  private buildTerminalReplay(
    city: CityBrief,
    aliases: string[],
    record: JobRecord,
  ): { status: ArchiveStatus; events: SseEnvelope[] } {
    const bundle = loadBundle(this.deps.archiveRepo, city.cityId);
    const status: ArchiveStatus = bundle?.archive.status ?? 'unpublished';
    const published = bundle !== null && status !== 'unpublished';
    const themePalette = bundle?.archive.themePalette ?? DEFAULT_THEME_PALETTE;
    const events: SseEnvelope[] = [];
    let seq = 0;
    const push = (event: SseEventName, data: Record<string, unknown>): void => {
      seq += 1;
      events.push({ event, data: { seq, ...data }, seq });
    };

    push('notice', {
      code: 'RESUMED_TERMINAL',
      message: '已恢复原任务的终态（未重新生成、未消耗额度）',
    });
    push('meta', {
      cityId: city.cityId,
      standardName: city.standardName,
      province: city.province,
      aliases: aliases.length > 0 ? aliases : [city.standardName],
      center: city.center,
      isPreset: city.isPreset,
      jobId: record.jobId,
      ...(record.attemptId ? { attemptId: record.attemptId } : {}),
    });
    push('theme', { light: themePalette.light, dark: themePalette.dark });

    const failedModules: ModuleName[] = [];
    if (published) {
      const statusMap = moduleStatusMap(bundle);
      for (const name of MODULE_NAMES) {
        const module = bundle.modules.get(name);
        if (!module || module.data === null) continue;
        if (statusMap[name] !== 'ok' && statusMap[name] !== 'degraded') continue;
        push('module', {
          name,
          status: module.status,
          data: module.data,
          sources: [],
          fromCache: true,
        });
      }
      // 失败提示只取自档案的最近一次尝试，与 GET /api/cities/:id 同一口径；
      // 已成功重跑的模块不会复活过期失败。
      for (const name of MODULE_NAMES) {
        const attempt = latestAttempt(bundle.modules.get(name));
        if (!attempt) continue;
        failedModules.push(name);
        push('module_error', {
          name,
          code: attempt.code,
          retryable: attempt.code !== 'NO_FACTS',
        });
      }
    } else {
      // 未发布档案不对外暴露任何模块内容，只报告任务级失败清单。
      failedModules.push(...record.failedModules);
    }

    push('done', {
      cityId: city.cityId,
      status,
      failedModules,
      generatedAt: bundle?.archive.generatedAt ?? record.finishedAt ?? record.startedAt,
      dataVersion: bundle?.archive.dataVersion ?? 0,
    });
    return { status, events };
  }

  private emit(runtime: JobRuntime, event: SseEventName, data: unknown): void {
    const envelope = this.push(runtime, event, data);
    for (const handler of runtime.subscribers) {
      try {
        handler(envelope);
      } catch {
        // 单个客户端写入失败不影响任务。
      }
    }
  }

  private push(runtime: JobRuntime, event: SseEventName, data: unknown): SseEnvelope {
    runtime.seq += 1;
    const envelope: SseEnvelope = { event, data, seq: runtime.seq };
    runtime.replay.push(envelope);
    return envelope;
  }

  private async run(runtime: JobRuntime, input: StartJobInput): Promise<void> {
    const failed: ModuleName[] = [];
    const jobStartedAt = Date.now();
    const deadlineAt = runtime.startedAt + this.deadlineMs;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let deadlineExceeded = false;
    let budgetExhausted = false;
    this.armDeadlineTimer(runtime, deadlineAt, timers);
    try {
      // 非预置城市先做一次城市侦察：维基百科、Wikidata、Tavily、气候与官方统计。
      // 侦察失败不阻断生成，各模块会按 NO_FACTS 降级。
      let recon = null;
      if (!input.city.isPreset) {
        if (this.now().getTime() >= deadlineAt) {
          deadlineExceeded = true;
        } else {
          const reconStartedAt = Date.now();
          // 取消信号随调用传递：侦察边界响应 abort，已取消则直接放弃。
          const reconWork = loadCityRecon(input.city, runtime.deadlineAbort.signal);
          reconWork.catch(() => undefined);
          try {
            recon = await Promise.race([reconWork, this.deadlineRejection(deadlineAt, timers)]);
          } catch (error) {
            if (!isDeadlineError(error)) throw error;
            deadlineExceeded = true;
          }
          if (recon) {
            console.log(
              `[gen] city=${input.city.cityId} recon ms=${Date.now() - reconStartedAt}`,
            );
          }
        }
      }
      for (const module of runtime.planned) {
        // 总截止覆盖侦察、生成与重试：到达后不再开始新模块。
        if (deadlineExceeded || this.now().getTime() >= deadlineAt) {
          deadlineExceeded = true;
          break;
        }
        if (budgetExhausted) break;
        const moduleStartedAt = Date.now();
        // 上游可能永不返回或忽略取消：与截止竞争，编排层按时结束等待。
        const work = this.deps.generator.generate({
          city: input.city,
          module,
          aliases: input.aliases,
          recon,
          signal: runtime.deadlineAbort.signal,
          onLlmCall: () => {
            // 真正发出 LLM 请求前的原子额度检查与记账（重试请求同样计数，
            // 按实际请求时间归属北京日期，任务跨午夜运行不串日）。
            if (!this.deps.budget.consume(runtime.jobId, runtime.cityId)) {
              throw new GenerationError(
                'BUDGET_EXCEEDED',
                '今日 LLM 调用预算已用尽，请明日再试',
              );
            }
          },
        });
        // 迟到结果/迟到拒绝都必须被吞掉：不得影响收尾，也不得落库。
        work.catch(() => undefined);
        try {
          const generated = await Promise.race([work, this.deadlineRejection(deadlineAt, timers)]);
          // 迟到结果不得落库：生成完成后再次核对总截止。
          if (this.now().getTime() >= deadlineAt) {
            throw new GenerationError(
              'GENERATION_DEADLINE',
              `模块 ${module} 超过单次生成总截止（${this.deadlineMs}ms），结果未落库`,
            );
          }
          const data = validateModuleData(module, generated.data);
          const used = collectSourceRefs(data);
          const missing = [...used].filter(
            (id) => !generated.sources.some((source) => source.id === id),
          );
          if (missing.length > 0) {
            throw new GenerationError(
              'SOURCE_MISSING',
              `模块 ${module} 引用了未提供的来源：${missing.join(',')}`,
            );
          }
          for (const source of generated.sources) runtime.sources.set(source.id, source);
          this.deps.archiveRepo.saveModule({
            cityId: runtime.cityId,
            name: module,
            status: generated.status,
            data,
            verification: { status: generated.verification },
            generatedAt: this.now().toISOString(),
            sources: generated.sources,
          });
          this.emit(runtime, 'module', {
            seq: runtime.seq + 1,
            name: module,
            status: generated.status,
            data,
            sources: generated.sources,
          });
          console.log(
            `[gen] city=${runtime.cityId} module=${module} status=${generated.status} ms=${Date.now() - moduleStartedAt}`,
          );
        } catch (error) {
          const deadlineHit = isDeadlineError(error);
          if (deadlineHit) deadlineExceeded = true;
          const rawCode =
            error instanceof GenerationError
              ? error.code
              : (error as { name?: string }).name === 'ZodError'
                ? 'SCHEMA_INVALID'
                : 'GENERATION_FAILED';
          const code = toModuleErrorCode(rawCode);
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[gen] city=${runtime.cityId} module=${module} failed raw=${rawCode} code=${code} message=${message}`,
          );
          this.deps.archiveRepo.markModuleFailed(
            runtime.cityId,
            module,
            { status: 'failed', code, message, at: this.now().toISOString() },
            this.now().toISOString(),
          );
          this.emit(runtime, 'module_error', {
            seq: runtime.seq + 1,
            name: module,
            code,
            retryable: code !== 'NO_FACTS',
          });
          failed.push(module);
          if (code === 'BUDGET_EXCEEDED') budgetExhausted = true;
          if (deadlineHit) break;
        }
      }

      // 失败但仍持有可用旧内容的模块：补发 fromCache 事件，
      // 使 SSE 与 GET /api/cities/:id 对可用内容的读取口径一致。
      const retained = new Map<ModuleName, { status: 'ok' | 'degraded'; data: unknown }>();
      if (failed.length > 0) {
        for (const record of this.deps.archiveRepo.listModules(runtime.cityId)) {
          if (!failed.includes(record.name)) continue;
          if (hasUsableModuleContent(record)) {
            retained.set(record.name, {
              status: record.status as 'ok' | 'degraded',
              data: record.data,
            });
          }
        }
      }
      for (const [name, content] of retained) {
        this.emit(runtime, 'module', {
          seq: runtime.seq + 1,
          name,
          status: content.status,
          data: content.data,
          sources: [],
          fromCache: true,
        });
      }

      const bundle = loadBundle(this.deps.archiveRepo, runtime.cityId);
      const statusMap = bundle ? moduleStatusMap(bundle) : {};
      // 发布规则针对整份档案判定：模块状态只反映「当前可用内容」，
      // 单次尝试失败不会把已发布档案打回 unpublished。
      const status = computeArchiveStatus(statusMap, MODULE_NAMES);
      const generatedAt = this.now().toISOString();
      this.deps.archiveRepo.setMeta(runtime.cityId, {
        themePalette: runtime.themePalette,
        sources: [...runtime.sources.values()],
        generator: {
          model: this.deps.generator.name,
          promptVersion: this.deps.generator.promptVersion,
        },
        generatedAt,
      });
      this.deps.archiveRepo.updateStatus(runtime.cityId, status, generatedAt);

      const cooldownUntil =
        status === 'unpublished'
          ? new Date(this.now().getTime() + FAILURE_COOLDOWN_MS).toISOString()
          : null;
      this.deps.jobRepo.finish(
        runtime.jobId,
        status === 'complete' ? 'done' : status === 'partial' ? 'partial' : 'failed',
        failed,
        cooldownUntil,
      );
      if (deadlineExceeded) {
        // 明确终止结果：已发布档案走非致命 notice；未发布走 error + 冷却。
        if (status === 'unpublished') {
          this.emit(runtime, 'error', {
            seq: runtime.seq + 1,
            code: 'GENERATION_DEADLINE',
            message: `本次生成超过 ${Math.round(this.deadlineMs / 1000)} 秒总截止，未达到成卷门槛`,
            retryAfterSec: FAILURE_COOLDOWN_MS / 1000,
          });
        } else {
          this.emit(runtime, 'notice', {
            seq: runtime.seq + 1,
            code: 'GENERATION_DEADLINE',
            message: `本次生成已达 ${Math.round(this.deadlineMs / 1000)} 秒总截止，已停止继续展卷；已成之卷不受影响，可单独重试未成之卷。`,
          });
        }
      }
      if (budgetExhausted && status === 'unpublished') {
        this.emit(runtime, 'error', {
          seq: runtime.seq + 1,
          code: 'BUDGET_EXCEEDED',
          message: '今日 LLM 调用预算已用尽，请明日再试',
          retryAfterSec: FAILURE_COOLDOWN_MS / 1000,
        });
      } else if (budgetExhausted) {
        this.emit(runtime, 'notice', {
          seq: runtime.seq + 1,
          code: 'BUDGET_EXCEEDED',
          message: '今日 LLM 调用预算已用尽，剩余未生成的卷请明日再试；已成之卷不受影响。',
        });
      }
      this.emit(runtime, 'done', {
        seq: runtime.seq + 1,
        cityId: runtime.cityId,
        status,
        failedModules: failed,
        generatedAt,
        dataVersion: bundle?.archive.dataVersion ?? 1,
      });
      console.log(
        `[gen] city=${runtime.cityId} done status=${status} modules=${runtime.planned.length} failed=${failed.length} deadline=${deadlineExceeded} total=${Date.now() - jobStartedAt}ms`,
      );
      this.finish(runtime);
    } catch (error) {
      this.failRuntime(runtime, error);
    } finally {
      // 清理截止定时器并取消上游（幂等：重复 abort 无副作用）。
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      runtime.deadlineAbort.abort();
    }
  }

  /** 武装实时截止定时器：到点取消进行中的上游请求。注入时钟的测试不武装。 */
  private armDeadlineTimer(
    runtime: JobRuntime,
    deadlineAt: number,
    timers: Set<ReturnType<typeof setTimeout>>,
  ): void {
    if (this.usesInjectedClock) return;
    const delay = deadlineAt - Date.now();
    if (delay <= 0 || delay > this.deadlineMs) return;
    const timer = setTimeout(() => runtime.deadlineAbort.abort(), delay);
    timer.unref?.();
    timers.add(timer);
  }

  /**
   * 截止竞争Promise：到点 reject，让编排层结束对上游的等待。
   * - 已过截止：立即 reject；
   * - 注入时钟（测试）：返回永不 settle 的 Promise，由循环内时钟检查负责；
   * - 其余：真实定时器 reject，并在 work 先完成时被安全吞掉。
   */
  private deadlineRejection(
    deadlineAt: number,
    timers: Set<ReturnType<typeof setTimeout>>,
  ): Promise<never> {
    const error = new GenerationError(
      'GENERATION_DEADLINE',
      `单次生成总截止（${this.deadlineMs}ms）已到，停止等待上游`,
    );
    if (this.usesInjectedClock) return new Promise<never>(() => undefined);
    const delay = deadlineAt - Date.now();
    if (delay <= 0) {
      const rejected = Promise.reject(error);
      rejected.catch(() => undefined);
      return rejected;
    }
    if (delay > this.deadlineMs) return new Promise<never>(() => undefined);
    const promise = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(error), delay);
      timer.unref?.();
      timers.add(timer);
    });
    // work 先完成时该 Promise 才会 reject：预先挂一个空 catch，避免未处理拒绝。
    promise.catch(() => undefined);
    return promise;
  }

  private failRuntime(runtime: JobRuntime, error: unknown): void {
    if (runtime.finished) return;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof GenerationError ? error.code : 'INTERNAL_ERROR';
    const generatedAt = this.now().toISOString();
    // 崩溃/异常中断同样不得把已有可用内容下架：按当前模块状态重算发布状态。
    const bundle = loadBundle(this.deps.archiveRepo, runtime.cityId);
    const status = bundle
      ? computeArchiveStatus(moduleStatusMap(bundle), MODULE_NAMES)
      : 'unpublished';
    const cooldownUntil =
      status === 'unpublished'
        ? new Date(this.now().getTime() + FAILURE_COOLDOWN_MS).toISOString()
        : null;
    this.deps.archiveRepo.updateStatus(runtime.cityId, status, generatedAt);
    this.deps.jobRepo.finish(
      runtime.jobId,
      status === 'complete' ? 'done' : status === 'partial' ? 'partial' : 'failed',
      [],
      cooldownUntil,
    );
    this.emit(runtime, 'error', {
      seq: runtime.seq + 1,
      code,
      message,
      ...(cooldownUntil ? { retryAfterSec: FAILURE_COOLDOWN_MS / 1000 } : {}),
    });
    this.emit(runtime, 'done', {
      seq: runtime.seq + 1,
      cityId: runtime.cityId,
      status,
      failedModules: [],
      generatedAt,
      dataVersion: bundle?.archive.dataVersion ?? 1,
    });
    this.finish(runtime);
  }

  private finish(runtime: JobRuntime): void {
    runtime.finished = true;
    this.runtimes.delete(runtime.cityId);
  }

  /** 预置城市档案的 GET 响应（阶段 6 质检复用）。 */
  readArchive(city: CityBrief, aliases: string[]) {
    const bundle = loadBundle(this.deps.archiveRepo, city.cityId);
    return bundle ? buildArchiveResponse(city, bundle, aliases) : null;
  }
}
