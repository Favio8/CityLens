/**
 * 管理接口：大模型自定义配置（读取 / 保存 / 连接测试 / 恢复 .env）。
 *
 * 鉴权：
 *  - 配置了 ADMIN_TOKEN 时，必须携带 x-admin-token；
 *  - 未配置时只允许本机回环地址访问，避免局域网内裸奔。
 * API Key 只保存在本地 SQLite，读取接口只返回掩码。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, ROOT_DIR } from '../config';
import type { ArchiveRepo } from '../db/archiveRepo';
import type { CityRepo } from '../db/cityRepo';
import { ApiError } from '../errors';
import { LLM_PROVIDERS, type LlmSettingsService } from '../services/llmSettings';
import type { MapSettingsService } from '../services/mapSettings';
import {
  getGazetteer,
  getPoetryCorpus,
  getRelicImages,
  getRelicsRegistry,
} from '../services/presetData';

const LlmSettingsInputSchema = z.object({
  provider: z.enum(LLM_PROVIDERS).optional(),
  baseUrl: z.string().trim().url('Base URL 必须是合法 URL').optional(),
  model: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
  timeoutMs: z.number().int().min(5000).max(180000).optional(),
  mock: z.boolean().optional(),
});

const LlmTestInputSchema = z.object({
  baseUrl: z.string().trim().url('Base URL 必须是合法 URL').optional(),
  model: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().max(500).optional(),
  timeoutMs: z.number().int().min(3000).max(60000).optional(),
});

const MapSettingsInputSchema = z.object({
  browserKey: z.string().max(500).optional(),
  serverKey: z.string().max(500).optional(),
  clearServerKey: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const MapTestInputSchema = z.object({
  serverKey: z.string().max(500).optional(),
  browserKey: z.string().max(500).optional(),
});

export interface AdminRouteDeps {
  llmSettings: LlmSettingsService;
  mapSettings: MapSettingsService;
  repo: CityRepo;
  archiveRepo: ArchiveRepo;
}

interface DataArtifact {
  key: string;
  label: string;
  count: number | null;
  updatedAt: string | null;
  status: 'ready' | 'missing';
  note: string;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function dataArtifacts(): DataArtifact[] {
  const poetry = getPoetryCorpus();
  const relics = getRelicsRegistry();
  const gazetteer = getGazetteer();
  const images = getRelicImages();
  const geo = readJson<{ fetchedAt?: string; cities?: unknown[] }>(
    resolve(ROOT_DIR, 'client/public/geo/_manifest.json'),
  );
  let snapshots = 0;
  try {
    snapshots = readdirSync(resolve(config.dataDir, 'fact_snapshot')).filter(
      (name) => name.endsWith('.json') && !name.startsWith('_'),
    ).length;
  } catch {
    snapshots = 0;
  }

  return [
    {
      key: 'poetry',
      label: '诗词库',
      count: poetry?.stats.poems ?? null,
      updatedAt: poetry?.generatedAt ?? null,
      status: poetry ? 'ready' : 'missing',
      note: 'chinese-poetry（MIT）',
    },
    {
      key: 'relics',
      label: '文物名录',
      count: relics?.relics.length ?? null,
      updatedAt: relics?.generatedAt ?? null,
      status: relics ? 'ready' : 'missing',
      note: 'Wikidata 文保身份汇总',
    },
    {
      key: 'gazetteer',
      label: '地名坐标库',
      count: gazetteer?.entries.length ?? null,
      updatedAt: gazetteer?.generatedAt ?? null,
      status: gazetteer ? 'ready' : 'missing',
      note: '城市中心 + 景点 + 文物',
    },
    {
      key: 'snapshots',
      label: '城市事实快照',
      count: snapshots,
      updatedAt: null,
      status: snapshots > 0 ? 'ready' : 'missing',
      note: '六座预置城市',
    },
    {
      key: 'images',
      label: '文物图片',
      count: images?.stats.downloaded ?? null,
      updatedAt: images?.generatedAt ?? null,
      status: images ? 'ready' : 'missing',
      note: 'Wikimedia Commons（本地缓存）',
    },
    {
      key: 'geo',
      label: '行政区轮廓',
      count: geo?.cities?.length ?? null,
      updatedAt: geo?.fetchedAt ?? null,
      status: geo ? 'ready' : 'missing',
      note: 'DataV.GeoAtlas（授权待确认）',
    },
  ];
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function assertAdmin(request: FastifyRequest): void {
  if (config.adminToken) {
    const token = request.headers['x-admin-token'];
    if (typeof token !== 'string' || token !== config.adminToken) {
      throw new ApiError('ADMIN_FORBIDDEN', '管理令牌无效', 403);
    }
    return;
  }
  if (!isLoopback(request.ip)) {
    throw new ApiError(
      'ADMIN_FORBIDDEN',
      '未配置 ADMIN_TOKEN，仅允许本机访问管理配置；远端部署请先设置 ADMIN_TOKEN',
      403,
    );
  }
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { llmSettings, mapSettings, repo, archiveRepo } = deps;

  app.get('/api/admin/overview', async (request) => {
    assertAdmin(request);
    const llm = llmSettings.publicSettings();
    const map = mapSettings.publicSettings();
    const images = getRelicImages();
    return {
      llm,
      map,
      services: {
        llm: { configured: llm.hasApiKey && !llm.mock, mock: llm.mock },
        map: { enabled: map.enabled && map.hasBrowserKey },
        images: { enabled: config.enableImages, count: images?.records.length ?? 0 },
      },
      artifacts: dataArtifacts(),
      security: {
        adminTokenConfigured: Boolean(config.adminToken),
        adminAccess: config.adminToken ? 'token' : 'local-only',
        allowedOrigins: config.allowedOrigins,
      },
      database: {
        cities: repo.countCities(),
        archives: archiveRepo.countArchives(),
        presets: archiveRepo.countPresets(),
      },
    };
  });

  app.get('/api/admin/llm', async (request) => {
    assertAdmin(request);
    return llmSettings.publicSettings();
  });

  app.put<{ Body: unknown }>('/api/admin/llm', async (request) => {
    assertAdmin(request);
    const input = LlmSettingsInputSchema.parse(request.body ?? {});
    const current = llmSettings.get();
    const nextMock = input.mock ?? current.mock;
    const baseUrl = (input.baseUrl ?? current.baseUrl).trim();
    const model = (input.model ?? current.model).trim();
    if (!nextMock && (!baseUrl || !model)) {
      throw new ApiError('INVALID_LLM_CONFIG', 'Base URL 与模型名不能为空', 400);
    }
    return llmSettings.save(input);
  });

  app.delete('/api/admin/llm', async (request) => {
    assertAdmin(request);
    return llmSettings.reset();
  });

  app.put<{ Body: unknown }>('/api/admin/map', async (request) => {
    assertAdmin(request);
    const input = MapSettingsInputSchema.parse(request.body ?? {});
    return mapSettings.save(input);
  });

  app.delete('/api/admin/map', async (request) => {
    assertAdmin(request);
    return mapSettings.reset();
  });

  app.post<{ Body: unknown }>('/api/admin/map/test', async (request) => {
    assertAdmin(request);
    const input = MapTestInputSchema.parse(request.body ?? {});
    const current = mapSettings.get();
    const key = input.serverKey?.trim() || current.serverKey || current.browserKey;
    if (!key) {
      throw new ApiError('INVALID_MAP_CONFIG', '请先填写服务端 Key 或浏览器端 Key', 400);
    }
    const postStr = JSON.stringify({ keyWord: '故宫', queryType: 1, start: 0, count: 3 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const startedAt = Date.now();
    try {
      const response = await fetch(
        `https://api.tianditu.gov.cn/v2/search?postStr=${encodeURIComponent(postStr)}&type=query&tk=${encodeURIComponent(key)}`,
        { signal: controller.signal },
      );
      const latencyMs = Date.now() - startedAt;
      const text = await response.text();
      let count = 0;
      let errorMessage = '';
      try {
        const json = JSON.parse(text) as {
          count?: string | number;
          status?: { info?: string; infocode?: string };
        };
        count = Number(json.count ?? 0);
        errorMessage = json.status?.info ?? '';
      } catch {
        errorMessage = text.slice(0, 200);
      }
      const ok = response.ok && !errorMessage;
      return {
        ok,
        status: response.status,
        latencyMs,
        count,
        message: ok
          ? `天地图返回 ${count} 条地点结果`
          : errorMessage || `天地图接口返回 HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        latencyMs: Date.now() - startedAt,
        count: 0,
        message:
          (error as Error).name === 'AbortError'
            ? '天地图连接超时'
            : `天地图连接失败：${(error as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  });

  app.post<{ Body: unknown }>('/api/admin/llm/test', async (request) => {
    assertAdmin(request);
    const input = LlmTestInputSchema.parse(request.body ?? {});
    const current = llmSettings.get();
    const baseUrl = (input.baseUrl ?? current.baseUrl).replace(/\/+$/, '');
    const model = input.model ?? current.model;
    const apiKey = input.apiKey?.trim() || current.apiKey;
    const timeoutMs = input.timeoutMs ?? Math.min(current.timeoutMs, 20000);
    if (!baseUrl || !model) {
      throw new ApiError('INVALID_LLM_CONFIG', '请先填写 Base URL 与模型名', 400);
    }
    if (!apiKey) {
      throw new ApiError('INVALID_LLM_CONFIG', '未填写 API Key，无法测试连接', 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: 8,
          temperature: 0,
          messages: [{ role: 'user', content: '只回复 OK' }],
        }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const text = await response.text();
      let message = '';
      try {
        const json = JSON.parse(text) as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string };
        };
        message =
          json.error?.message ??
          json.choices?.[0]?.message?.content?.trim() ??
          (response.ok ? '连接成功' : text.slice(0, 200));
      } catch {
        message = text.slice(0, 200);
      }
      return {
        ok: response.ok,
        status: response.status,
        latencyMs,
        model,
        message: message || (response.ok ? '连接成功' : '接口返回非 JSON 内容'),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        latencyMs: Date.now() - startedAt,
        model,
        message:
          (error as Error).name === 'AbortError'
            ? `连接超时（>${timeoutMs}ms）`
            : `连接失败：${(error as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  });
}
