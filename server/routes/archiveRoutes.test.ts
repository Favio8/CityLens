import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MODULE_NAMES } from '../../shared/schema';
import { buildApp } from '../index';
import { config } from '../config';
import { openDb, type Db } from '../db';
import { JobRepo } from '../db/jobRepo';
import { hashIp } from '../services/rateLimiter';
import { MockGenerator } from '../services/llmGenerator';

interface SseRecord {
  event: string;
  data: Record<string, unknown>;
}

interface SseResult {
  status: number;
  events: SseRecord[];
}

async function collectSse(url: string, init?: RequestInit): Promise<SseResult> {
  const response = await fetch(url, init);
  if (!response.ok || !response.body) {
    return { status: response.status, events: [] };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: SseRecord[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (!eventLine) continue;
      const event = eventLine.slice(7).trim();
      const data = dataLine ? (JSON.parse(dataLine.slice(6)) as Record<string, unknown>) : {};
      events.push({ event, data });
      if (event === 'done') {
        await reader.cancel();
        return { status: response.status, events };
      }
    }
  }
  return { status: response.status, events };
}

function setup(generator = new MockGenerator({ delayMs: 5 })) {
  const db = openDb(':memory:');
  const insertCity = db.prepare(
    `INSERT INTO cities
       (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat, hot_rank)
     VALUES (?, ?, ?, 'prefecture', ?, ?, ?, ?, ?)`,
  );
  insertCity.run('CN-610100', '西安', '陕西省', 'xian', "Xi'an", 108.9422, 34.2611, 1);
  insertCity.run('CN-350500', '泉州', '福建省', 'quanzhou', 'Quanzhou', 118.6757, 24.8741, null);
  for (let i = 0; i < 12; i += 1) {
    insertCity.run(`CN-9000${String(i).padStart(2, '0')}`, `测试城${i}`, '测试省', 'test', 'Test', 118.0, 24.0, null);
  }
  db.prepare(
    `INSERT INTO city_aliases (alias_key, display_alias, city_id, match_type)
     VALUES ('长安', '长安', 'CN-610100', 'ancient')`,
  ).run();
  const app = buildApp({ db, generator });
  return { db, app };
}

const runningApps: Array<ReturnType<typeof buildApp>> = [];

async function listen(app: ReturnType<typeof buildApp>): Promise<string> {
  runningApps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.close()));
});

describe('SSE 生成与单飞', () => {
  it('事件顺序符合协议，5 个模块通过、3 个失败后 partial 发布', async () => {
    const { db, app } = setup();
    const base = await listen(app);
    const result = await collectSse(`${base}/api/cities/CN-610100/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(result.status).toBe(200);
    const names = result.events.map((item) => item.event);
    expect(names[0]).toBe('meta');
    expect(names[1]).toBe('theme');
    expect(names.at(-1)).toBe('done');
    const modules = result.events.filter((item) => item.event === 'module');
    const errors = result.events.filter((item) => item.event === 'module_error');
    expect(modules.map((item) => item.data.name).sort()).toEqual([
      'figures',
      'identity',
      'landmarks',
      'poetics',
      'relics',
    ]);
    expect(errors.map((item) => item.data.name).sort()).toEqual([
      'chronicle',
      'dataPulse',
      'localSoul',
    ]);
    const done = result.events.at(-1)!;
    expect(done.data.status).toBe('partial');
    expect(done.data.dataVersion).toBeGreaterThan(0);
    const meta = result.events[0]!.data;
    expect(meta.standardName).toBe('西安');
    expect(meta.aliases).toContain('长安');
    expect(meta.jobId).toBeTruthy();

    const rows = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('10 个并发请求只创建一个任务，全部收到 done', async () => {
    const { db, app } = setup();
    const base = await listen(app);
    const requests = Array.from({ length: 10 }, () =>
      collectSse(`${base}/api/cities/CN-610100/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    const results = await Promise.all(requests);
    expect(results.every((item) => item.status === 200)).toBe(true);
    expect(
      results.every((item) => item.events.at(-1)?.event === 'done'),
    ).toBe(true);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get() as { n: number };
    expect(rows.n).toBe(1);
    const done = results[0]!.events.at(-1)!;
    expect(done.data.status).toBe('partial');
  });

  it('增量生成：第二次只重试 3 个失败模块', async () => {
    const { app } = setup();
    const base = await listen(app);
    const first = await collectSse(`${base}/api/cities/CN-610100/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(first.events.at(-1)?.data.status).toBe('partial');
    const second = await collectSse(`${base}/api/cities/CN-610100/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const regenerated = second.events.filter(
      (item) => item.event === 'module' && item.data.fromCache !== true,
    );
    const replayed = second.events.filter(
      (item) => item.event === 'module' && item.data.fromCache === true,
    );
    const retriedErrors = second.events.filter((item) => item.event === 'module_error');
    expect(regenerated).toEqual([]);
    expect(replayed.length).toBe(5);
    expect(retriedErrors.map((item) => item.data.name).sort()).toEqual([
      'chronicle',
      'dataPulse',
      'localSoul',
    ]);
  });
});

describe('缓存读取', () => {
  it('已发布档案 GET 返回 fromCache=true；未生成返回 404', async () => {
    const { app } = setup();
    const base = await listen(app);
    await collectSse(`${base}/api/cities/CN-610100/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const hit = await fetch(`${base}/api/cities/CN-610100`);
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as { fromCache: boolean; meta: { moduleStatus: Record<string, string> } };
    expect(body.fromCache).toBe(true);
    expect(body.meta.moduleStatus.identity).toBe('degraded');
    expect(body.meta.moduleStatus.chronicle).toBe('failed');

    const missing = await fetch(`${base}/api/cities/CN-350500`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('NOT_GENERATED');

    const unknown = await fetch(`${base}/api/cities/CN-000000`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe('CITY_NOT_FOUND');
  });
});

describe('保护与限流', () => {
  it('非 force 的单模块请求不会把已发布档案打成 unpublished', async () => {
    const { app } = setup();
    const base = await listen(app);
    await collectSse(`${base}/api/cities/CN-610100/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const subset = await collectSse(`${base}/api/cities/CN-610100/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: ['landmarks'] }),
    });
    expect(subset.status).toBe(200);
    expect(subset.events.at(-1)?.data.status).toBe('partial');

    const hit = await fetch(`${base}/api/cities/CN-610100`);
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as { fromCache: boolean; meta: { status: string } };
    expect(body.fromCache).toBe(true);
    expect(body.meta.status).toBe('partial');
  });

  it('重复模块名只创建一次任务模块记录', async () => {
    const { db, app } = setup();
    const base = await listen(app);
    await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: ['landmarks', 'landmarks', 'landmarks'] }),
    });
    const job = db
      .prepare('SELECT modules_json FROM generation_jobs WHERE city_id = ?')
      .get('CN-350500') as { modules_json: string };
    expect(JSON.parse(job.modules_json)).toEqual(['landmarks']);
  });

  it('预置城市强制刷新无管理令牌返回 403 PRESET_LOCKED', async () => {
    const { app } = setup();
    const base = await listen(app);
    const response = await fetch(`${base}/api/cities/CN-610100/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('PRESET_LOCKED');
  });

  it('整体失败后进入冷却，GET 与再次生成均返回 429', async () => {
    const failing = new MockGenerator({ delayMs: 1, failModules: [...MODULE_NAMES] });
    const { app } = setup(failing);
    const base = await listen(app);
    const first = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(first.events.at(-1)?.data.status).toBe('unpublished');

    const get = await fetch(`${base}/api/cities/CN-350500`);
    expect(get.status).toBe(429);
    const getBody = (await get.json()) as { code: string; retryAfterSec: number };
    expect(getBody.code).toBe('COOLDOWN');
    expect(getBody.retryAfterSec).toBeGreaterThan(0);

    const again = await fetch(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(429);
    expect(((await again.json()) as { code: string }).code).toBe('COOLDOWN');
  });

  it('同一 IP 一小时内第 11 座新城市返回 429 RATE_LIMITED', async () => {
    const { db, app } = setup();
    const jobs = new JobRepo(db);
    const hash = hashIp('127.0.0.1', config.ipHashSalt);
    for (let i = 0; i < 10; i += 1) {
      jobs.create({
        jobId: `seed-${i}`,
        cityId: `CN-9000${String(i).padStart(2, '0')}`,
        force: false,
        modules: ['identity'],
        requesterHash: hash,
        startedAt: new Date().toISOString(),
      });
      jobs.finish(`seed-${i}`, 'partial', [], null);
    }
    const base = await listen(app);
    const response = await fetch(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });
});
