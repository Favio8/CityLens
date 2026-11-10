/**
 * 管理接口：大模型自定义配置（读取 / 保存 / 连接测试 / 恢复 .env）。
 *
 * 鉴权：
 *  - 配置了 ADMIN_TOKEN 时，必须携带 x-admin-token；
 *  - 未配置时只允许本机回环地址访问，避免局域网内裸奔。
 * API Key 只保存在本地 SQLite，读取接口只返回掩码。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { ApiError } from '../errors';
import { LLM_PROVIDERS, type LlmSettingsService } from '../services/llmSettings';

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

export interface AdminRouteDeps {
  llmSettings: LlmSettingsService;
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
  const { llmSettings } = deps;

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
