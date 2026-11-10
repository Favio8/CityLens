/**
 * 生成任务编排（PRD 2.2 / 3.5）。
 * 同城单飞：内存 runtime + generation_jobs 唯一索引双保险；
 * 增量生成：已通过校验的 ok 模块默认跳过；
 * 模块级失败保留旧内容；整体失败进入 10 分钟冷却。
 */
import { randomUUID } from 'node:crypto';
import type { ModuleErrorCode, ModuleName, SourceRef, ThemePalette } from '../../shared/schema';
import { MODULE_NAMES } from '../../shared/schema';
import { computeArchiveStatus } from '../../shared/validators';
import type { ArchiveRepo } from '../db/archiveRepo';
import type { CityBrief, CityRepo } from '../db/cityRepo';
import type { JobRepo } from '../db/jobRepo';
import { FAILURE_COOLDOWN_MS } from '../../shared/schema';
import {
  DEFAULT_THEME_PALETTE,
  buildArchiveResponse,
  loadBundle,
  moduleStatusMap,
  reusableModules,
} from './cacheService';
import {
  GenerationError,
  validateModuleData,
  type ModuleGenerator,
} from './llmGenerator';

export type SseEventName = 'meta' | 'theme' | 'module' | 'module_error' | 'done' | 'error';

export interface SseEnvelope {
  event: SseEventName;
  data: unknown;
  seq: number;
}

export type SseHandler = (event: SseEnvelope) => void;

export interface JobRuntime {
  jobId: string;
  cityId: string;
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
}

export interface StartJobInput {
  city: CityBrief;
  aliases: string[];
  requesterHash: string;
  force: boolean;
  modules: ModuleName[];
}

export interface StartJobResult {
  runtime: JobRuntime;
  attached: boolean;
}

export interface JobManagerDeps {
  archiveRepo: ArchiveRepo;
  jobRepo: JobRepo;
  cityRepo: CityRepo;
  generator: ModuleGenerator;
  now?: () => Date;
  staleAfterMs?: number;
}

const DEFAULT_MODULES = [...MODULE_NAMES];

function toModuleErrorCode(code: string): ModuleErrorCode {
  if (code === 'LLM_TIMEOUT' || code === 'NO_FACTS') return code;
  if (code === 'SOURCE_MISSING' || code === 'VERIFY_FAILED') return 'VERIFY_FAILED';
  return 'SCHEMA_INVALID';
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
  private readonly staleAfterMs: number;

  constructor(private readonly deps: JobManagerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.staleAfterMs = deps.staleAfterMs ?? 120_000;
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
    const requested = input.modules.length > 0 ? input.modules : DEFAULT_MODULES;
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
    });
    if (!created) {
      const racing = this.runtimes.get(input.city.cityId);
      if (racing && !racing.finished) return { runtime: racing, attached: true };
      throw new GenerationError('JOB_CONFLICT', '同城已有生成任务，请稍后重试');
    }
    this.deps.jobRepo.clearCooldowns(input.city.cityId);

    const runtime: JobRuntime = {
      jobId,
      cityId: input.city.cityId,
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
    try {
      for (const module of runtime.planned) {
        this.deps.jobRepo.incrementLlmCalls(runtime.jobId);
        try {
          const generated = await this.deps.generator.generate({
            city: input.city,
            module,
            aliases: input.aliases,
          });
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
          });
          this.emit(runtime, 'module', {
            seq: runtime.seq + 1,
            name: module,
            status: generated.status,
            data,
            sources: generated.sources,
          });
        } catch (error) {
          const rawCode =
            error instanceof GenerationError
              ? error.code
              : (error as { name?: string }).name === 'ZodError'
                ? 'SCHEMA_INVALID'
                : 'GENERATION_FAILED';
          const code = toModuleErrorCode(rawCode);
          const message = error instanceof Error ? error.message : String(error);
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
        }
      }

      const bundle = loadBundle(this.deps.archiveRepo, runtime.cityId);
      const statusMap = bundle ? moduleStatusMap(bundle) : {};
      const status = computeArchiveStatus(statusMap, runtime.requested);
      const generatedAt = this.now().toISOString();
      this.deps.archiveRepo.setMeta(runtime.cityId, {
        themePalette: runtime.themePalette,
        sources: [...runtime.sources.values()],
        generator: { model: this.deps.generator.name, promptVersion: 'mock-v1' },
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
      this.emit(runtime, 'done', {
        seq: runtime.seq + 1,
        cityId: runtime.cityId,
        status,
        failedModules: failed,
        generatedAt,
        dataVersion: bundle?.archive.dataVersion ?? 1,
      });
      this.finish(runtime);
    } catch (error) {
      this.failRuntime(runtime, error);
    }
  }

  private failRuntime(runtime: JobRuntime, error: unknown): void {
    if (runtime.finished) return;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof GenerationError ? error.code : 'INTERNAL_ERROR';
    const cooldownUntil = new Date(this.now().getTime() + FAILURE_COOLDOWN_MS).toISOString();
    this.deps.archiveRepo.updateStatus(runtime.cityId, 'unpublished', this.now().toISOString());
    this.deps.jobRepo.finish(runtime.jobId, 'failed', [], cooldownUntil);
    this.emit(runtime, 'error', {
      seq: runtime.seq + 1,
      code,
      message,
      retryAfterSec: FAILURE_COOLDOWN_MS / 1000,
    });
    this.emit(runtime, 'done', {
      seq: runtime.seq + 1,
      cityId: runtime.cityId,
      status: 'unpublished',
      failedModules: [],
      generatedAt: this.now().toISOString(),
      dataVersion: 1,
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
