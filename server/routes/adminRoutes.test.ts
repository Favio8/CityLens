import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { buildApp } from '../index';

const apps: Array<ReturnType<typeof buildApp>> = [];

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
    const initial = await app.inject({ method: 'GET', url: '/api/admin/llm' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ source: 'env', mock: true, hasApiKey: false });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/llm',
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

    const reset = await app.inject({ method: 'DELETE', url: '/api/admin/llm' });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ source: 'env', hasApiKey: false });
  });

  it('总览返回服务状态与数据产物；地图 Key 保存后立即下发', async () => {
    const app = makeApp();
    const overview = await app.inject({ method: 'GET', url: '/api/admin/overview' });
    expect(overview.statusCode).toBe(200);
    const data = overview.json() as {
      artifacts: Array<{ key: string; status: string }>;
      security: { adminAccess: string };
      database: { cities: number };
    };
    expect(data.artifacts.some((item) => item.key === 'poetry')).toBe(true);
    expect(data.security.adminAccess).toBe('local-only');
    expect(data.database.cities).toBeGreaterThanOrEqual(0);

    const before = await app.inject({ method: 'GET', url: '/api/map/config' });
    expect(before.json()).toMatchObject({ enabled: false, key: null });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/map',
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

    await app.inject({ method: 'DELETE', url: '/api/admin/map' });
    const reset = await app.inject({ method: 'GET', url: '/api/map/config' });
    expect(reset.json()).toMatchObject({ enabled: false, key: null });
  });
});
