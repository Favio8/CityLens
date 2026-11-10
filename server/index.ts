import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config, clientDistExists, isOriginAllowed } from './config';
import { ArchiveRepo } from './db/archiveRepo';
import { CityRepo } from './db/cityRepo';
import { getDb } from './db';
import { JobRepo } from './db/jobRepo';
import { ApiError } from './errors';
import { registerArchiveRoutes } from './routes/archiveRoutes';
import { registerAdminRoutes } from './routes/adminRoutes';
import { JobManager } from './services/jobManager';
import { createGenerator, type ModuleGenerator } from './services/llmGenerator';
import { LlmSettingsService } from './services/llmSettings';
import { MapSettingsService } from './services/mapSettings';
import { InvalidQueryError, normalizeQuery } from './services/normalizer';
import { RateLimiter } from './services/rateLimiter';

export interface BuildAppOptions {
  db?: ReturnType<typeof getDb>;
  logger?: boolean;
  generator?: ModuleGenerator;
}

/** 组装 Fastify 应用（导出以便集成测试）。 */
export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  const db = options.db ?? getDb();
  const repo = new CityRepo(db);
  const archiveRepo = new ArchiveRepo(db);
  const jobRepo = new JobRepo(db);
  const llmSettings = new LlmSettingsService(db);
  const mapSettings = new MapSettingsService(db);
  const generator = options.generator ?? createGenerator(llmSettings);
  const jobManager = new JobManager({ archiveRepo, jobRepo, cityRepo: repo, generator });
  const rateLimiter = new RateLimiter(jobRepo, { dailyCallLimit: config.llm.dailyCallLimit });

  app.register(cors, {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin ?? undefined)),
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send(error.retryAfterSec === undefined ? error.toJSON() : error.toJSON());
    }
    if (error instanceof InvalidQueryError) {
      return reply.code(400).send({ code: error.code, message: error.message });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        code: 'INVALID_BODY',
        message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    app.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务暂时不可用' });
  });

  app.get('/api/health', async () => {
    const llm = llmSettings.get();
    const map = mapSettings.get();
    return {
      ok: true,
      llmConfigured: llm.apiKey.length > 0,
      mapConfigured: map.enabled && Boolean(map.browserKey),
      mockLlm: llm.mock,
      llmProvider: llm.provider,
      llmModel: llm.model,
      llmSettingsSource: llm.source,
      presetCities: archiveRepo.countPresets(),
      archives: archiveRepo.countArchives(),
    };
  });

  app.get<{ Querystring: { q?: string } }>('/api/cities/search', async (request) => {
    const raw = request.query.q ?? '';
    try {
      return normalizeQuery(raw, repo);
    } catch (error) {
      if (error instanceof InvalidQueryError) throw new ApiError(error.code, error.message, 400);
      throw error;
    }
  });

  app.get('/api/cities/hot', async () => {
    const cities = repo.listHot(12).map((c) => ({
      cityId: c.cityId,
      name: c.standardName,
      province: c.province,
      isPreset: c.isPreset,
      summary: c.summary,
    }));
    return { cities };
  });

  /**
   * 地图配置。天地图 Key 是浏览器端瓦片请求所必需、且应按域名白名单限制的公开 Key；
   * 大模型 Key 永远不会通过任何接口下发。
   */
  app.get('/api/map/config', async () => {
    const map = mapSettings.get();
    const enabled = map.enabled && Boolean(map.browserKey);
    return {
      enabled,
      key: enabled ? map.browserKey : null,
      styleUrl: null,
    };
  });

  registerArchiveRoutes(app, {
    repo,
    archiveRepo,
    jobRepo,
    jobManager,
    rateLimiter,
    llmSettings,
  });
  registerAdminRoutes(app, { llmSettings, mapSettings, repo, archiveRepo });

  // 生产模式下托管前端构建产物（开发模式由 Vite 提供）
  if (clientDistExists() && existsSync(join(config.clientDist, 'index.html'))) {
    app.register(fastifyStatic, { root: config.clientDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

async function main(): Promise<void> {
  const app = buildApp({ logger: true });
  await app.listen({ port: config.port, host: config.host });
  console.log(`[citylens] 服务已启动 http://localhost:${config.port}`);
  const llm = new LlmSettingsService(getDb()).get();
  const map = new MapSettingsService(getDb()).get();
  console.log(
    `[citylens] LLM ${llm.apiKey ? `${llm.provider}/${llm.model}` : '未配置'}${
      llm.mock ? '（模拟 LLM）' : ''
    }；天地图 ${map.enabled && map.browserKey ? '已配置' : '未配置（无底图模式）'}`,
  );
}

const isDirectRun = process.argv[1] && /(?:^|[\\/])index\.ts$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[citylens] 启动失败：', error);
    process.exit(1);
  });
}
