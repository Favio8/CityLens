/**
 * 档案读取与流式生成路由（PRD 3.4）。
 * - GET /api/cities/:cityId：缓存命中 < 500ms；未生成 404；失败冷却 429。
 * - POST /api/cities/:cityId/generate：SSE（fetch 流），meta→theme→module…→done。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  GenerateRequestSchema,
  MODULE_NAMES,
  type ModuleName,
} from '../../shared/schema';
import { config, llmConfigured } from '../config';
import type { ArchiveRepo } from '../db/archiveRepo';
import type { CityRepo } from '../db/cityRepo';
import type { JobRepo } from '../db/jobRepo';
import { ApiError } from '../errors';
import {
  buildArchiveResponse,
  cooldownSeconds,
  loadBundle,
  logCacheHit,
} from '../services/cacheService';
import type { JobManager, SseEnvelope } from '../services/jobManager';
import { hashIp, type RateLimiter } from '../services/rateLimiter';

export interface ArchiveRouteDeps {
  repo: CityRepo;
  archiveRepo: ArchiveRepo;
  jobRepo: JobRepo;
  jobManager: JobManager;
  rateLimiter: RateLimiter;
  isMock: boolean;
}

const PING_INTERVAL_MS = 15_000;

function writeEvent(reply: FastifyReply, envelope: SseEnvelope): void {
  reply.raw.write(`event: ${envelope.event}\ndata: ${JSON.stringify(envelope.data)}\n\n`);
}

function cooldownError(cityId: string, untilIso: string): ApiError {
  const seconds = cooldownSeconds(untilIso);
  return new ApiError(
    'COOLDOWN',
    `该城上次生成失败，冷却中（剩余 ${seconds} 秒）`,
    429,
    seconds,
  );
}

export function registerArchiveRoutes(app: FastifyInstance, deps: ArchiveRouteDeps): void {
  const { repo, archiveRepo, jobRepo, jobManager, rateLimiter } = deps;

  app.get<{ Params: { cityId: string } }>('/api/cities/:cityId', async (request) => {
    const startedAt = Date.now();
    const city = repo.getCity(request.params.cityId);
    if (!city) throw new ApiError('CITY_NOT_FOUND', '版图中暂无此城', 404);

    const archive = archiveRepo.getArchive(city.cityId);
    if (archive && archive.status === 'unpublished') {
      const cooldown = jobRepo.findActiveCooldown(city.cityId, new Date().toISOString());
      if (cooldown?.cooldownUntil) throw cooldownError(city.cityId, cooldown.cooldownUntil);
    }

    const bundle = loadBundle(archiveRepo, city.cityId);
    const response = bundle
      ? buildArchiveResponse(city, bundle, repo.listAncientAliases(city.cityId))
      : null;
    if (!response) throw new ApiError('NOT_GENERATED', '此城尚未收录', 404);
    logCacheHit(city.cityId, startedAt);
    return response;
  });

  app.post<{ Params: { cityId: string }; Body: unknown }>(
    '/api/cities/:cityId/generate',
    async (request, reply) => {
      const body = GenerateRequestSchema.parse(request.body ?? {});
      const city = repo.getCity(request.params.cityId);
      if (!city) throw new ApiError('CITY_NOT_FOUND', '版图中暂无此城', 404);

      if (!deps.isMock && !llmConfigured()) {
        throw new ApiError('LLM_NOT_CONFIGURED', '未配置大模型 Key，暂不可生成', 503);
      }

      const archive = archiveRepo.getArchive(city.cityId);
      if (archive && archive.status === 'unpublished') {
        const cooldown = jobRepo.findActiveCooldown(city.cityId, new Date().toISOString());
        if (cooldown?.cooldownUntil) throw cooldownError(city.cityId, cooldown.cooldownUntil);
      }

      const force = body.force === true;
      const requesterHash = hashIp(request.ip, config.ipHashSalt);
      const modules: ModuleName[] = body.modules ?? [...MODULE_NAMES];

      if (force && city.isPreset) {
        const token = request.headers['x-admin-token'];
        if (!config.adminToken || token !== config.adminToken) {
          throw new ApiError('PRESET_LOCKED', '预置城市受保护，需管理令牌才能强制刷新', 403);
        }
      }

      const rateDecision = force
        ? rateLimiter.checkRegen(requesterHash, city.cityId)
        : archive && archive.status !== 'unpublished'
          ? ({ allowed: true } as const)
          : rateLimiter.checkNewCity(requesterHash);
      if (!rateDecision.allowed) {
        throw new ApiError(
          rateDecision.code,
          rateDecision.message,
          429,
          rateDecision.retryAfterSec,
        );
      }
      const budget = rateLimiter.checkBudget();
      if (!budget.allowed) {
        throw new ApiError(budget.code, budget.message, 503, budget.retryAfterSec);
      }

      const { runtime } = jobManager.start({
        city,
        aliases: repo.listAncientAliases(city.cityId),
        requesterHash,
        force,
        modules,
      });

      reply.hijack();
      const origin = request.headers.origin ?? '*';
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
      });
      reply.raw.write(`retry: 3000\n\n`);

      const ping = setInterval(() => {
        try {
          reply.raw.write(`event: ping\ndata: {}\n\n`);
        } catch {
          clearInterval(ping);
        }
      }, PING_INTERVAL_MS);

      let detach: (() => void) | null = null;
      let closed = false;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        detach?.();
        detach = null;
      };

      detach = jobManager.attach(runtime, (event) => {
        try {
          writeEvent(reply, event);
          if (event.event === 'done') {
            cleanup();
            reply.raw.end();
          }
        } catch {
          cleanup();
        }
      });
      if (closed) detach?.();

      reply.raw.on('close', cleanup);
      reply.raw.on('error', cleanup);
      return reply;
    },
  );
}
