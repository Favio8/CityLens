import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config';
import { openDb } from '../db';
import { buildApp } from '../index';

const apps: Array<ReturnType<typeof buildApp>> = [];
/** .env 配置了 ADMIN_TOKEN 时，管理接口测试也要带上令牌。 */
const ADMIN_HEADERS = config.adminToken ? { 'x-admin-token': config.adminToken } : {};

function makeApp() {
  const db = openDb(':memory:');
  const app = buildApp({ db });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
});

describe('管理接口：大模型自定义配置', () => {
  it('本机可读取、保存并恢复配置，响应不含明文 Key', async () => {
    const app = makeApp();
    const initial = await app.inject({
      method: 'GET',
      url: '/api/admin/llm',
      headers: ADMIN_HEADERS,
    });
    expect(initial.statusCode).toBe(200);
    // .env 有 Key 时为真实调用，无 Key 时为模拟（与 config.mockLlm 一致）。
    expect(initial.json()).toMatchObject({ source: 'env', mock: config.mockLlm });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/llm',
      headers: ADMIN_HEADERS,
      payload: {
        provider: 'stepfun',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'step-5',
        apiKey: 'sk-admin-test-5678',
        mock: false,
        timeoutMs: 30000,
      },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      provider: 'stepfun',
      model: 'step-5',
      mock: false,
      hasApiKey: true,
      apiKeyMasked: 'sk-…5678',
      source: 'runtime',
    });
    expect(JSON.stringify(body)).not.toContain('sk-admin-test-5678');

    const reset = await app.inject({
      method: 'DELETE',
      url: '/api/admin/llm',
      headers: ADMIN_HEADERS,
    });
    expect(reset.statusCode).toBe(200);
    // 恢复后回到 .env：有 Key 时 hasApiKey 为 true，无 Key 时为 false。
    expect(reset.json()).toMatchObject({ source: 'env', hasApiKey: config.llm.apiKey.length > 0 });
  });

  it('总览返回服务状态与数据产物；地图 Key 保存后立即下发', async () => {
    const app = makeApp();
    const overview = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: ADMIN_HEADERS,
    });
    expect(overview.statusCode).toBe(200);
    const data = overview.json() as {
      artifacts: Array<{ key: string; status: string }>;
      security: { adminAccess: string };
      database: { cities: number };
      services: {
        llm: { callsToday: number; dailyBudget: number; remaining: number };
      };
    };
    expect(data.artifacts.some((item) => item.key === 'poetry')).toBe(true);
    expect(data.security.adminAccess).toBe(config.adminToken ? 'token' : 'local-only');
    expect(data.database.cities).toBeGreaterThanOrEqual(0);
    // 今日 LLM 调用与预算：口径与 rateLimiter.checkBudget 一致
    expect(data.services.llm.callsToday).toBeGreaterThanOrEqual(0);
    expect(data.services.llm.dailyBudget).toBe(config.llm.dailyCallLimit);
    expect(data.services.llm.remaining).toBe(
      Math.max(0, config.llm.dailyCallLimit - data.services.llm.callsToday),
    );

    // 初始状态取决于 .env 是否配置了天地图 Key，测试不假设一定为空。
    const envMap = {
      enabled: Boolean(config.tiandituKey),
      key: config.tiandituKey || null,
    };
    const before = await app.inject({ method: 'GET', url: '/api/map/config' });
    expect(before.json()).toMatchObject(envMap);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/map',
      headers: ADMIN_HEADERS,
      payload: {
        browserKey: 'browser-key-123456',
        serverKey: 'server-key-987654',
        enabled: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      hasBrowserKey: true,
      hasServerKey: true,
      browserKeyMasked: 'bro…3456',
      serverKeyMasked: 'ser…7654',
      enabled: true,
      source: 'runtime',
    });

    const after = await app.inject({ method: 'GET', url: '/api/map/config' });
    expect(after.json()).toMatchObject({ enabled: true, key: 'browser-key-123456' });

    await app.inject({ method: 'DELETE', url: '/api/admin/map', headers: ADMIN_HEADERS });
    const reset = await app.inject({ method: 'GET', url: '/api/map/config' });
    expect(reset.json()).toMatchObject(envMap);
  });

  it('联网检索 Key 保存后只返回掩码，并可恢复 .env', async () => {
    const app = makeApp();
    const initial = await app.inject({
      method: 'GET',
      url: '/api/admin/search',
      headers: ADMIN_HEADERS,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ source: 'env', dailyLimit: config.search.dailyLimit });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/search',
      headers: ADMIN_HEADERS,
      payload: { apiKey: 'tvly-dev-admin-test-1234', dailyLimit: 50 },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      hasApiKey: true,
      apiKeyMasked: 'tvl…1234',
      dailyLimit: 50,
      source: 'runtime',
    });
    expect(JSON.stringify(body)).not.toContain('tvly-dev-admin-test-1234');

    const reset = await app.inject({
      method: 'DELETE',
      url: '/api/admin/search',
      headers: ADMIN_HEADERS,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ source: 'env', dailyLimit: config.search.dailyLimit });
  });
});
