import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_NAMES, PENDING } from '../../shared/schema';
import { DEFAULT_THEME_PALETTE } from '../../shared/cityThemes';
import { buildApp } from '../index';
import { config } from '../config';
import { openDb, type Db } from '../db';
import { ArchiveRepo } from '../db/archiveRepo';
import { JobRepo } from '../db/jobRepo';
import { hashIp } from '../services/rateLimiter';
import { MockGenerator } from '../services/llmGenerator';
import { setFactSnapshot, type FactSnapshot } from '../services/presetData';
import { resetWeatherCache } from '../services/weatherService';

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

describe('行旅工具实时层（解耦档案）', () => {
  /** 插入一座没有任何档案的测试城市。 */
  function insertBareCity(db: Db, cityId: string, name: string): void {
    db.prepare(
      `INSERT INTO cities
         (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat, hot_rank)
       VALUES (?, ?, '测试省', 'prefecture', 'test', 'Test', 118.0, 24.0, NULL)`,
    ).run(cityId, name);
  }

  it('未成卷城市有一日路线：走 Wikidata 快照回退，不要求档案', async () => {
    const { db, app } = setup();
    insertBareCity(db, 'CN-90099', '快照城');
    const snapshot: FactSnapshot = {
      cityId: 'CN-90099',
      cityName: '快照城',
      cityQid: 'Q999',
      center: [118.0, 24.0],
      retrievedAt: '2026-11-11T00:00:00.000Z',
      sourceRef: {
        id: 'S-WD-CN-90099',
        type: 'wikidata',
        title: 'Wikidata 事实快照 · 快照城',
        retrievedAt: '2026-11-11T00:00:00.000Z',
      },
      landmarks: [
        {
          entityId: 'Q1',
          name: '城东塔',
          coordinates: [118.05, 24.02],
          kind: '古建筑',
          heritageDesignations: [],
          description: null,
          sitelinks: 9,
        },
        {
          entityId: 'Q2',
          name: '城西寺',
          coordinates: [117.95, 24.01],
          kind: '寺庙',
          heritageDesignations: [],
          description: null,
          sitelinks: 7,
        },
      ],
      relics: [],
      figures: [],
      failures: [],
    };
    setFactSnapshot('CN-90099', snapshot);

    const base = await listen(app);
    const response = await fetch(`${base}/api/cities/CN-90099/daytrip`);
    expect(response.status).toBe(200);
    const trip = (await response.json()) as {
      stops: Array<{ name: string; coordSource: string; sourceRefs: string[] }>;
      degraded: boolean;
      notice: string;
    };
    // 按距离排序：城西寺（117.95）比城东塔（118.05）更近
    expect(trip.stops.map((stop) => stop.name)).toEqual(['城西寺', '城东塔']);
    expect(trip.stops.every((stop) => stop.coordSource === 'wikidata')).toBe(true);
    expect(trip.stops[0]!.sourceRefs).toEqual(['S-WD-CN-90099']);
    expect(trip.notice).toContain('Wikidata 事实快照');
    expect(trip.degraded).toBe(true);
  });

  it('未成卷城市可查实时天气：只用词典坐标，不要求档案', async () => {
    const { db, app } = setup();
    insertBareCity(db, 'CN-90098', '天气城');
    resetWeatherCache();
    // 只拦 Open-Meteo 请求；测试客户端访问本地服务器的 fetch 必须透传，否则会自环。
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(
        typeof input === 'object' && input !== null && 'url' in input
          ? (input as { url: string }).url
          : input,
      );
      if (url.includes('api.open-meteo.com')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              current: {
                time: '2026-11-11T12:00:00Z',
                temperature_2m: 18.44,
                weather_code: 3,
                wind_speed_10m: 12.34,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return realFetch(input, init);
    });

    try {
      const base = await listen(app);
      const response = await fetch(`${base}/api/cities/CN-90098/weather`);
      expect(response.status).toBe(200);
      const weather = (await response.json()) as {
        cityId: string;
        tempC: number;
        weatherCode: number;
        weatherLabel: string;
        windKmh: number;
        isRealtime: boolean;
        source: string;
      };
      expect(weather.cityId).toBe('CN-90098');
      expect(weather.tempC).toBe(18.4);
      expect(weather.weatherLabel).toBe('阴');
      expect(weather.windKmh).toBe(12.3);
      expect(weather.isRealtime).toBe(true);
      expect(weather.source).toBe('open-meteo');
      // 请求参数取自词典中心坐标（118.0, 24.0）
      const openMeteoCalls = fetchSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes('api.open-meteo.com'));
      expect(openMeteoCalls).toHaveLength(1);
      expect(openMeteoCalls[0]).toContain('latitude=24');
      expect(openMeteoCalls[0]).toContain('longitude=118');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('未知城市的行旅工具返回 404 CITY_NOT_FOUND', async () => {
    const { app } = setup();
    const base = await listen(app);
    const daytrip = await fetch(`${base}/api/cities/CN-000000/daytrip`);
    expect(daytrip.status).toBe(404);
    expect(((await daytrip.json()) as { code: string }).code).toBe('CITY_NOT_FOUND');
    const weather = await fetch(`${base}/api/cities/CN-000000/weather`);
    expect(weather.status).toBe(404);
    expect(((await weather.json()) as { code: string }).code).toBe('CITY_NOT_FOUND');
  });

  it('可发布但出不了题的档案：quiz 返回 404 NO_QUIZ（不再是 Schema 解析失败）', async () => {
    const { db, app } = setup();
    // 直接构造一份 partial 档案：气候待考、景点只有必去、文物只有 1 件、无年表/人物模块，
    // 五个出题器全部落空（FiguresSchema 要求人物 evidence 非空，故不出题必须缺席人物模块）。
    const archiveRepo = new ArchiveRepo(db);
    const generatedAt = '2026-11-11T00:00:00.000Z';
    archiveRepo.ensureArchive({
      cityId: 'CN-350500',
      status: 'partial',
      themePalette: DEFAULT_THEME_PALETTE,
      sources: [],
      isPreset: false,
      generator: null,
      generatedAt,
    });
    archiveRepo.saveModule({
      cityId: 'CN-350500',
      name: 'identity',
      status: 'ok',
      data: {
        standardName: '泉州',
        aliases: ['刺桐'],
        center: [118.6757, 24.8741],
        area: { value: PENDING, sourceRefs: [] },
        population: { value: PENDING, sourceRefs: [] },
        climateType: { value: PENDING, sourceRefs: [] },
        adminDivisions: { value: PENDING, sourceRefs: [] },
        oneLinePersona: PENDING,
        sourceRefs: [],
        verification: 'pending_human_review',
      },
      verification: {},
      generatedAt,
    });
    archiveRepo.saveModule({
      cityId: 'CN-350500',
      name: 'landmarks',
      status: 'ok',
      data: [
        {
          entityRef: 'Q-1',
          name: '开元寺',
          category: 'must_visit',
          bestSeason: PENDING,
          reason: '宋代遗构，闽南佛教寺院代表。',
          placeName: '泉州开元寺',
          coordinates: [118.5767, 24.8717],
          coordSource: 'local_gazetteer',
          sourceRefs: [],
          verification: 'pending_human_review',
        },
      ],
      verification: {},
      generatedAt,
    });
    archiveRepo.saveModule({
      cityId: 'CN-350500',
      name: 'relics',
      status: 'ok',
      data: [
        {
          registryId: 'R-1',
          name: '洛阳桥',
          era: '宋',
          museumOrSite: '泉州洛阳桥',
          protectionLevel: '国保',
          findSpot: '待考',
          story: '宋代跨海梁式石桥，闽南交通史见证。',
          coordinates: null,
          sourceRefs: [],
          verification: 'pending_human_review',
        },
      ],
      verification: {},
      generatedAt,
    });
    archiveRepo.updateStatus('CN-350500', 'partial', generatedAt);

    const base = await listen(app);
    const quiz = await fetch(`${base}/api/cities/CN-350500/quiz`);
    expect(quiz.status).toBe(404);
    expect(((await quiz.json()) as { code: string }).code).toBe('NO_QUIZ');

    // 同日路线仍然可用（走档案）
    const daytrip = await fetch(`${base}/api/cities/CN-350500/daytrip`);
    expect(daytrip.status).toBe(200);
  });
});
