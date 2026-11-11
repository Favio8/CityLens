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
import { config, isOriginAllowed } from '../config';
import type { LlmSettingsService } from '../services/llmSettings';
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
import { buildDayTrip } from '../services/dayTripService';
import { loadCitySnapshot } from '../services/cityFactSnapshot';
import { buildQuiz } from '../services/quizService';
import { getCityWeather } from '../services/weatherService';

export interface ArchiveRouteDeps {
  repo: CityRepo;
  archiveRepo: ArchiveRepo;
  jobRepo: JobRepo;
  jobManager: JobManager;
  rateLimiter: RateLimiter;
  llmSettings: LlmSettingsService;
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

  /** 行旅工具共用：读取已发布档案；未生成返回 404。 */
  const requireBundle = (cityId: string) => {
    const city = repo.getCity(cityId);
    if (!city) throw new ApiError('CITY_NOT_FOUND', '版图中暂无此城', 404);
    const bundle = loadBundle(archiveRepo, city.cityId);
    if (!bundle || bundle.archive.status === 'unpublished') {
      throw new ApiError('NOT_GENERATED', '此城尚未成卷，暂不提供该工具', 404);
    }
    return { city, bundle };
  };

  /** 「如果只有一天」一日路线（示意路线，非导航）。 */
  app.get<{ Params: { cityId: string } }>('/api/cities/:cityId/daytrip', async (request) => {
    const city = repo.getCity(request.params.cityId);
    if (!city) throw new ApiError('CITY_NOT_FOUND', '版图中暂无此城', 404);
    const bundle = loadBundle(archiveRepo, city.cityId);
    if (bundle && bundle.archive.status !== 'unpublished') {
      return buildDayTrip(city, bundle);
    }
    // 实时层解耦：未成卷也尝试用 Wikidata 快照排路线（本地优先，缺失则按需抓取；
    // 失败有 10 分钟负缓存，不会每次请求都打 Wikidata）。
    const snapshot = await loadCitySnapshot(city);
    if (snapshot) return buildDayTrip(city, null, snapshot);
    throw new ApiError('NOT_GENERATED', '此城尚未成卷，且未检索到可核验的点位快照', 404);
  });

  /** 知识小测验：题目来自档案事实字段，本地判分。 */
  app.get<{ Params: { cityId: string } }>('/api/cities/:cityId/quiz', async (request) => {
    const { city, bundle } = requireBundle(request.params.cityId);
    return buildQuiz(city, bundle);
  });

  /** 实时天气（Open-Meteo，无需 Key）；失败 502，前端回退气候基线。 */
  app.get<{ Params: { cityId: string } }>('/api/cities/:cityId/weather', async (request) => {
    const city = repo.getCity(request.params.cityId);
    if (!city) throw new ApiError('CITY_NOT_FOUND', '版图中暂无此城', 404);
    const weather = await getCityWeather(city.cityId, city.center);
    if (!weather) {
      throw new ApiError('WEATHER_UNAVAILABLE', '实时天气暂不可用，已回退到气候基线', 502);
    }
    return weather;
  });

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
      const requestStartedAt = Date.now();
      const body = GenerateRequestSchema.parse(request.body ?? {});
      const city = repo.getCity(request.params.cityId);
      if (!city) throw new ApiError('CITY_NOT_FOUND', '版图中暂无此城', 404);

      const llm = deps.llmSettings.get();
      if (!llm.mock && !llm.apiKey) {
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

      let firstEventLogged = false;
      reply.hijack();
      const origin = request.headers.origin;
      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        Vary: 'Origin',
      };
      // 只回显白名单内的来源；不携带 Cookie，因此不开启 credentials。
      if (origin && isOriginAllowed(origin)) headers['Access-Control-Allow-Origin'] = origin;
      reply.raw.writeHead(200, headers);
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
          if (!firstEventLogged) {
            firstEventLogged = true;
            console.log(
              `[sse] city=${runtime.cityId} firstEvent=${event.event} ms=${Date.now() - requestStartedAt}`,
            );
          }
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
