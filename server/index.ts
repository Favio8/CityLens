import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config, clientDistExists, llmConfigured, mapConfigured } from './config';
import { ArchiveRepo } from './db/archiveRepo';
import { CityRepo } from './db/cityRepo';
import { getDb } from './db';
import { JobRepo } from './db/jobRepo';
import { ApiError } from './errors';
import { registerArchiveRoutes } from './routes/archiveRoutes';
import { JobManager } from './services/jobManager';
import { createGenerator, type ModuleGenerator } from './services/llmGenerator';
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
  const generator = options.generator ?? createGenerator();
  const jobManager = new JobManager({ archiveRepo, jobRepo, cityRepo: repo, generator });
  const rateLimiter = new RateLimiter(jobRepo, { dailyCallLimit: config.llm.dailyCallLimit });

  app.register(cors, { origin: true });

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

  app.get('/api/health', async () => ({
    ok: true,
    llmConfigured: llmConfigured(),
    mapConfigured: mapConfigured(),
    mockLlm: config.mockLlm,
    presetCities: archiveRepo.countPresets(),
    archives: archiveRepo.countArchives(),
  }));

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

  registerArchiveRoutes(app, {
    repo,
    archiveRepo,
    jobRepo,
    jobManager,
    rateLimiter,
    isMock: config.mockLlm,
  });

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
  console.log(
    `[citylens] LLM ${llmConfigured() ? '已配置' : '未配置（模拟 LLM）'}；天地图 ${mapConfigured() ? '已配置' : '未配置（无底图模式）'}`,
  );
}

const isDirectRun = process.argv[1] && /(?:^|[\\/])index\.ts$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[citylens] 启动失败：', error);
    process.exit(1);
  });
}
