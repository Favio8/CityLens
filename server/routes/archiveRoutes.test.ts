import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_NAMES, PENDING, type ModuleName } from '../../shared/schema';
import { DEFAULT_THEME_PALETTE } from '../../shared/cityThemes';
import { buildApp } from '../index';
import { config } from '../config';
import { openDb, type Db } from '../db';
import { ArchiveRepo } from '../db/archiveRepo';
import { JobRepo } from '../db/jobRepo';
import { hashIp } from '../services/rateLimiter';
import { GenerationError, MockGenerator, type ModuleGenerator } from '../services/llmGenerator';
import type { GenerateInput, GeneratedModule } from '../services/llmGenerator';
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

/** 可在两次生成之间切换「identity 失败」的生成器（P0 路由级复现）。 */
class SwitchableGenerator implements ModuleGenerator {
  failIdentity = false;
  readonly name = 'switchable';
  readonly promptVersion = 'switchable-v1';
  private readonly inner = new MockGenerator({ delayMs: 1 });

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    if (this.failIdentity && input.module === 'identity') {
      throw new GenerationError('LLM_TIMEOUT', '模拟失败：模块 identity 超时');
    }
    return this.inner.generate(input);
  }
}

/** 永不返回的生成器：用于让任务保持 running，验证并入路径。 */
class HangingGenerator implements ModuleGenerator {
  readonly name = 'hanging';
  readonly promptVersion = 'hanging-v1';
  async generate(): Promise<GeneratedModule> {
    return new Promise<GeneratedModule>(() => undefined);
  }
}

/** 八卷全部成功的生成器；最后一个模块可挂起，用于制造「服务端未完成」窗口。 */
class GatedCompleteGenerator implements ModuleGenerator {
  readonly name = 'gated-complete';
  readonly promptVersion = 'gated-v1';
  calls = 0;
  /** 模拟这些模块失败（用于 partial 场景）。 */
  failModules: ModuleName[] = [];
  private release: (() => void) | null = null;

  /** 放行最后挂起的模块，让服务端任务收尾。 */
  releaseLast(): void {
    this.release?.();
    this.release = null;
  }

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    this.calls += 1;
    if (this.failModules.includes(input.module)) {
      throw new GenerationError('LLM_TIMEOUT', `模拟失败：模块 ${input.module} 超时`);
    }
    if (input.module === 'dataPulse') {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return {
      status: 'ok',
      verification: 'verified_by_source',
      sources: [{ id: 'S-OK', type: 'preset_manual', title: '测试来源', retrievedAt: generatedAt }],
      data: completeModuleData(input.module),
    };
  }
}

const generatedAt = '2026-11-14T00:00:00.000Z';

/** GatedCompleteGenerator 使用的合法模块数据（sourceRefs 指向生成器提供的 S-OK）。 */
function completeModuleData(module: ModuleName): unknown {
  const refs = ['S-OK'];
  switch (module) {
    case 'identity':
      return {
        standardName: '泉州',
        aliases: ['刺桐'],
        center: [118.6757, 24.8741],
        area: { value: PENDING, sourceRefs: refs },
        population: { value: PENDING, sourceRefs: refs },
        climateType: { value: PENDING, sourceRefs: refs },
        adminDivisions: { value: PENDING, sourceRefs: refs },
        oneLinePersona: '刺桐港的风帆驶进了今天的泉州。',
        sourceRefs: refs,
        verification: 'pending_human_review',
      };
    case 'landmarks':
      return [
        {
          entityRef: 'Q-1',
          name: '开元寺',
          category: 'must_visit',
          bestSeason: PENDING,
          reason: '宋代遗构，闽南佛教寺院代表。',
          placeName: '泉州开元寺',
          coordinates: [118.5767, 24.8717],
          coordSource: 'local_gazetteer',
          sourceRefs: refs,
          verification: 'pending_human_review',
        },
      ];
    case 'relics':
      return [
        {
          registryId: 'R-1',
          name: '洛阳桥',
          era: '宋',
          museumOrSite: '泉州洛阳桥',
          protectionLevel: '国保',
          findSpot: '待考',
          story: '宋代跨海梁式石桥，闽南交通史见证。',
          coordinates: null,
          sourceRefs: refs,
          verification: 'pending_human_review',
        },
      ];
    case 'figures':
      return [
        {
          entityRef: 'Q-2',
          name: '李贽',
          dynasty: '明',
          birthYear: 1527,
          deathYear: 1602,
          relationType: 'native',
          evidence: { property: 'birthplace', value: '泉州' },
          cityBond: '李贽出身泉州，明代思想家。',
          highlights: '著《焚书》《藏书》，晚年寓居麻城。',
          sites: [],
          sourceRefs: refs,
          verification: 'pending_human_review',
        },
      ];
    case 'poetics':
      return [
        {
          poemId: 'P-1',
          title: '测试诗',
          author: '测试人',
          dynasty: '唐',
          lines: ['刺桐花谢刺桐长'],
          background: PENDING,
          relationType: 'direct',
          imageryMap: [],
          sourceRefs: refs,
          verification: 'pending_human_review',
        },
      ];
    case 'chronicle':
      return [
        {
          eraName: '唐',
          startYear: 618,
          endYear: 907,
          periodRange: '618—907',
          ancientCityName: '泉州',
          keyEvents: '唐代设泉州，港口贸易渐兴。',
          relicToday: '开元寺',
          centerCoord: null,
          sourceRefs: refs,
          verification: 'pending_human_review',
        },
      ];
    case 'localSoul':
      return {
        aiCurated: true,
        foods: [{ name: '面线糊', flavor: '清鲜', origin: '闽南' }],
        dialects: [{ word: '咱厝', pronunciation: 'lan cu', meaning: '我家', example: '咱厝人' }],
        ichItems: [{ name: '南音', level: '待考', intro: '闽南传统音乐', sourceRefs: refs }],
        festivals: [{ name: '元宵', season: '正月十五', custom: '闹花灯' }],
      };
    case 'dataPulse':
      return {
        gdpSeries: [{ year: 2025, value: null }],
        popSeries: [{ year: 2025, value: null }],
        statMeta: {
          gdp: { unit: '亿元', caliber: '地区生产总值（现价）', sourceRefs: refs },
          pop: { unit: '万人', caliber: '年末常住人口', sourceRefs: refs },
        },
        climateMonthly: [],
        climateMeta: { period: '1991–2020', station: '待考', sourceRefs: refs },
      };
    default:
      throw new Error('未知模块');
  }
}

/** 打开一条 SSE 流并读取事件，直到满足 until 条件（不等待 done，便于测试挂起任务）。 */
async function openSse(
  url: string,
  init: RequestInit | undefined,
  until: (events: SseRecord[]) => boolean = (events) =>
    events.some((item) => item.event === 'meta'),
): Promise<{
  status: number;
  events: SseRecord[];
  /** 继续读取同一条连接，直到满足条件或流结束（用于并入任务后等待其收尾）。 */
  readUntil: (predicate: (events: SseRecord[]) => boolean) => Promise<void>;
  cancel: () => Promise<void>;
}> {
  const response = await fetch(url, init);
  const events: SseRecord[] = [];
  if (!response.ok || !response.body) {
    return {
      status: response.status,
      events,
      readUntil: async () => undefined,
      cancel: async () => undefined,
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readMore = async (): Promise<SseRecord | null> => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        if (!eventLine) continue;
        const event = eventLine.slice(7).trim();
        const data = dataLine ? (JSON.parse(dataLine.slice(6)) as Record<string, unknown>) : {};
        const record: SseRecord = { event, data };
        events.push(record);
        return record;
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  for (let guard = 0; guard < 64; guard += 1) {
    if (until(events)) break;
    const record = await readMore();
    if (!record) break;
  }
  return {
    status: response.status,
    events,
    readUntil: async (predicate) => {
      for (let guard = 0; guard < 256; guard += 1) {
        if (predicate(events)) return;
        const record = await readMore();
        if (!record) return;
      }
    },
    cancel: async () => {
      await reader.cancel();
    },
  };
}

/** 轮询等待条件成立（服务端任务收尾等异步状态）。 */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor 超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function setup(generator: ModuleGenerator = new MockGenerator({ delayMs: 5 })) {
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

  it('P0：force 重新生成 identity 失败后旧档案保持可读，且不被冷却', async () => {
    // 预置一份可公开读取的 partial 档案（identity + landmarks + 其余 ok）。
    const db = openDb(':memory:');
    const insertCity = db.prepare(
      `INSERT INTO cities
         (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat, hot_rank)
       VALUES (?, ?, ?, 'prefecture', ?, ?, ?, ?, ?)`,
    );
    insertCity.run('CN-350500', '泉州', '福建省', 'quanzhou', 'Quanzhou', 118.6757, 24.8741, null);
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
    const identityData = {
      standardName: '泉州',
      aliases: ['刺桐'],
      center: [118.6757, 24.8741],
      area: { value: PENDING, sourceRefs: [] },
      population: { value: PENDING, sourceRefs: [] },
      climateType: { value: PENDING, sourceRefs: [] },
      adminDivisions: { value: PENDING, sourceRefs: [] },
      oneLinePersona: '刺桐港的风帆驶进了今天的泉州。',
      sourceRefs: [],
      verification: 'pending_human_review',
    };
    for (const name of MODULE_NAMES) {
      // chronicle/localSoul/dataPulse 预置为失败（无旧内容），保持 partial 发布状态。
      const failed = name === 'chronicle' || name === 'localSoul' || name === 'dataPulse';
      archiveRepo.saveModule({
        cityId: 'CN-350500',
        name,
        status: failed ? 'failed' : 'ok',
        data: failed
          ? null
          : name === 'identity'
            ? identityData
            : name === 'landmarks'
              ? [
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
                ]
              : name === 'relics'
                ? [
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
                  ]
                : name === 'figures'
                  ? [
                      {
                        entityRef: 'Q-2',
                        name: '李贽',
                        dynasty: '明',
                        birthYear: 1527,
                        deathYear: 1602,
                        relationType: 'native',
                        evidence: { property: 'birthplace', value: '泉州' },
                        cityBond: '李贽出身泉州，明代思想家。',
                        highlights: '著《焚书》《藏书》，晚年寓居麻城。',
                        sites: [],
                        sourceRefs: [],
                        verification: 'pending_human_review',
                      },
                    ]
                  : name === 'poetics'
                    ? [
                        {
                          poemId: 'P-1',
                          title: '测试诗',
                          author: '测试人',
                          dynasty: '唐',
                          lines: ['刺桐花谢刺桐长'],
                          background: '待考',
                          relationType: 'direct',
                          imageryMap: [],
                          sourceRefs: [],
                          verification: 'pending_human_review',
                        },
                      ]
                    : {
                        gdpSeries: [{ year: 2025, value: null }],
                        popSeries: [{ year: 2025, value: null }],
                        statMeta: {
                          gdp: { unit: '亿元', caliber: '地区生产总值（现价）', sourceRefs: [] },
                          pop: { unit: '万人', caliber: '年末常住人口', sourceRefs: [] },
                        },
                        climateMonthly: [],
                        climateMeta: { period: '1991–2020', station: '待考', sourceRefs: [] },
                      },
        verification: {},
        generatedAt,
      });
    }
    archiveRepo.updateStatus('CN-350500', 'partial', generatedAt);

    // 让 Mock 能重新生成 landmarks/figures（其余模块在 Mock 下仍 NO_FACTS）。
    setFactSnapshot('CN-350500', {
      cityId: 'CN-350500',
      cityName: '泉州',
      cityQid: 'Q41705',
      center: [118.6757, 24.8741],
      retrievedAt: generatedAt,
      sourceRef: {
        id: 'S-WD-CN-350500',
        type: 'wikidata',
        title: 'Wikidata 事实快照 · 泉州',
        retrievedAt: generatedAt,
      },
      landmarks: [
        {
          entityId: 'Q1',
          name: '开元寺',
          coordinates: [118.5767, 24.8717],
          kind: '寺庙',
          heritageDesignations: [],
          description: null,
          sitelinks: 9,
        },
      ],
      relics: [],
      figures: [
        {
          entityId: 'Q2',
          name: '李贽',
          relationType: 'native',
          evidence: { property: 'birthplace', value: '泉州' },
          birthYear: 1527,
          deathYear: 1602,
          description: null,
          sitelinks: 12,
        },
      ],
      failures: [],
    } satisfies FactSnapshot);

    const switchable = new SwitchableGenerator();
    const app = buildApp({ db, generator: switchable });
    runningApps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    // 生成前：档案可公开读取。
    const before = await fetch(`${base}/api/cities/CN-350500`);
    expect(before.status).toBe(200);

    // force 刷新，identity 失败。
    switchable.failIdentity = true;
    const second = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(second.status).toBe(200);
    expect(second.events.at(-1)?.data.status).toBe('partial');
    expect(second.events.at(-1)?.data.failedModules).toContain('identity');
    // 失败信号与保留内容同时下发。
    expect(
      second.events.some(
        (item) => item.event === 'module_error' && item.data.name === 'identity',
      ),
    ).toBe(true);
    expect(
      second.events.some(
        (item) =>
          item.event === 'module' &&
          item.data.name === 'identity' &&
          item.data.fromCache === true,
      ),
    ).toBe(true);

    // 旧档案仍可公开读取，identity 旧内容仍在，未进入冷却。
    const hit = await fetch(`${base}/api/cities/CN-350500`);
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as {
      fromCache: boolean;
      identity: { oneLinePersona: string } | null;
      meta: { status: string; moduleStatus: Record<string, string> };
    };
    expect(body.fromCache).toBe(true);
    expect(body.meta.status).toBe('partial');
    expect(body.identity?.oneLinePersona).toBe('刺桐港的风帆驶进了今天的泉州。');
    expect(body.meta.moduleStatus.identity).toBe('ok');

    // 未发布才有的冷却不存在：可立即再次请求生成（不会 429）。
    const again = await fetch(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: ['landmarks'] }),
    });
    expect(again.status).toBe(200);
    await again.body?.cancel();
  });

  it('重连并入已有 force 任务：不被 5 分钟刷新冷却或预算入口拦截', async () => {
    // 复现：断线重连会再次 POST force；旧实现先查刷新冷却（429）与预算（503），
    // 导致客户端永远无法并入仍在运行的任务。
    const hanging = new HangingGenerator();
    const { db, app } = setup(hanging);
    const base = await listen(app);

    // 第一次 force 创建任务（生成器挂起，任务保持 running）。
    const first = await openSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(first.status).toBe(200);
    expect(first.events.some((item) => item.event === 'meta')).toBe(true);

    // 耗尽今日预算：入口检查若仍生效，重连会被 503 拦截。
    // （用另一座城市记账，避免与正在运行的任务争抢同城单飞位。）
    const jobs = new JobRepo(db);
    const seedJob = jobs.create({
      jobId: 'budget-seed',
      cityId: 'CN-900000',
      force: false,
      modules: ['identity'],
      requesterHash: 'seed',
      startedAt: new Date().toISOString(),
    })!;
    for (let i = 0; i < config.llm.dailyCallLimit; i += 1) {
      jobs.recordLlmCall(seedJob.jobId, 'CN-900000', new Date().toISOString());
    }

    // 同一 IP 立即再次 force（模拟重连）：必须并入而不是 429/503。
    const second = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      },
      (events) => events.some((item) => item.event === 'notice' && item.data.code === 'ATTACHED'),
    );
    expect(second.status).toBe(200);
    expect(
      second.events.some((item) => item.event === 'notice' && item.data.code === 'ATTACHED'),
    ).toBe(true);

    // 并入不新增任务、不新增 LLM 调用。
    const rows = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get() as { n: number };
    expect(rows.n).toBe(2); // budget-seed + 正在运行的任务
    const running = jobs.getRunning('CN-350500')!;
    expect(running.llmCalls).toBe(0);

    // 预置城市保护仍然生效（并入路径不绕过鉴权）。
    const presetForce = await fetch(`${base}/api/cities/CN-610100/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(presetForce.status).toBe(403);

    await first.cancel();
    await second.cancel();
  });
});

/**
 * 「服务端已完成、客户端丢失 done」的恢复路径（问题二）。
 * 客户端重连必须是非 force：服务端据此并入仍在运行的任务，或在任务已完成时
 * 按缓存立即回放终态——不重复生成、不重复计费、不绕过刷新冷却。
 */
describe('SSE 断线恢复：服务端已完成、客户端丢失 done', () => {
  it('全部完成：截断后非 force 重连读取终态档案，不重复生成计费', async () => {
    const gated = new GatedCompleteGenerator();
    const { db, app } = setup(gated);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    // 第一次 force 生成：读到第 7 个模块后取消（模拟客户端丢失 done）。
    const first = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      },
      (events) => events.filter((item) => item.event === 'module').length >= 7,
    );
    expect(first.status).toBe(200);
    await first.cancel();
    // 此刻服务端任务仍在运行（最后一个模块被挂起）。
    expect(jobs.getRunning('CN-350500')).not.toBeNull();

    // 服务端任务随后完成——客户端永远收不到它的 done（复现的丢失场景）。
    gated.releaseLast();
    await waitFor(async () => jobs.getRunning('CN-350500') === null, 10_000, 50, '任务收尾');
    const callsAfterFirst = gated.calls;

    // 旧客户端行为（重连仍发 force）：被 5 分钟刷新冷却拦截，进入无法恢复的终态。
    const forceRetry = await fetch(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(forceRetry.status).toBe(429);
    expect(((await forceRetry.json()) as { code: string }).code).toBe('REGEN_COOLDOWN');

    // 客户端恢复：非 force 重连 → 服务端按缓存回放终态。
    const recovered = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(recovered.status).toBe(200);
    const done = recovered.events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.status).toBe('complete');
    // 终态内容随回放下发。
    const identity = recovered.events.find(
      (item) => item.event === 'module' && item.data.name === 'identity',
    );
    expect(identity).toBeDefined();
    expect((identity!.data.data as { oneLinePersona: string }).oneLinePersona).toContain('刺桐港');

    // 不重复生成、不重复计费：重连任务 0 次 LLM 调用，生成器总调用次数不变。
    expect(gated.calls).toBe(callsAfterFirst);
    const rows = db
      .prepare('SELECT job_id, status, llm_calls FROM generation_jobs ORDER BY started_at')
      .all() as Array<{ job_id: string; status: string; llm_calls: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('done');
    expect(rows[1]!.llm_calls).toBe(0);
    // 最终展示内容：GET 返回完整档案。
    const hit = await fetch(`${base}/api/cities/CN-350500`);
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as { identity: { oneLinePersona: string } | null };
    expect(body.identity?.oneLinePersona).toContain('刺桐港');
  });

  it('重连竞态：并入运行中任务后恰好完成，仍能收到 done 终态', async () => {
    // 复现场景：客户端在服务端完成前后之间重连（非 force）——必须并入运行中的任务，
    // 并随任务收尾拿到 done，而不是新建刷新或卡在无终态。
    const gated = new GatedCompleteGenerator();
    const { db, app } = setup(gated);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    const first = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      },
      (events) => events.filter((item) => item.event === 'module').length >= 3,
    );
    expect(first.status).toBe(200);
    await first.cancel();
    expect(jobs.getRunning('CN-350500')).not.toBeNull();

    // 非 force 重连：任务仍在运行（最后一个模块被挂起）→ 必须并入而非新建。
    const reconnected = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      (events) => events.some((item) => item.event === 'notice' && item.data.code === 'ATTACHED'),
    );
    expect(reconnected.status).toBe(200);
    expect(
      reconnected.events.some((item) => item.event === 'notice' && item.data.code === 'ATTACHED'),
    ).toBe(true);

    // 并入确认后任务才收尾：同一条连接必须随完成收到 done。
    gated.releaseLast();
    await reconnected.readUntil((events) => events.some((item) => item.event === 'done'));
    const done = reconnected.events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.status).toBe('complete');
    await reconnected.cancel();

    // 竞态未产生第二个任务；Mock 不冒充付费调用，llm_calls 保持 0。
    await waitFor(async () => jobs.getRunning('CN-350500') === null, 10_000, 50, '任务收尾');
    expect(gated.calls).toBe(MODULE_NAMES.length);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get() as { n: number };
    expect(rows.n).toBe(1);
    const job = db
      .prepare('SELECT status, llm_calls FROM generation_jobs')
      .get() as { status: string; llm_calls: number };
    expect(job.status).toBe('done');
    expect(job.llm_calls).toBe(0);
  });

  it('部分完成：截断后重连得到 partial 终态', async () => {
    const gated = new GatedCompleteGenerator();
    gated.failModules = ['dataPulse']; // 7 卷成功、1 卷失败 → partial
    const { app } = setup(gated);
    const base = await listen(app);
    const first = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      },
      (events) => events.filter((item) => item.event === 'module').length >= 5,
    );
    expect(first.status).toBe(200);
    await first.cancel();
    await waitFor(
      async () => (await fetch(`${base}/api/cities/CN-350500`)).status === 200,
      10_000,
      50,
      'partial 发布',
    );

    const recovered = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const done = recovered.events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.status).toBe('partial');
    expect(done.data.failedModules).toEqual(['dataPulse']);
    // 终态内容随回放下发（identity 有值，失败卷不带内容）。
    const identity = recovered.events.find(
      (item) => item.event === 'module' && item.data.name === 'identity',
    );
    expect(identity).toBeDefined();
    expect((identity!.data.data as { oneLinePersona: string }).oneLinePersona).toContain('刺桐港');
  });

  it('未达发布门槛：重连得到 429 COOLDOWN 并保留服务端信息', async () => {
    const failing = new MockGenerator({ delayMs: 1, failModules: [...MODULE_NAMES] });
    const { app } = setup(failing);
    const base = await listen(app);
    const first = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(first.events.at(-1)?.data.status).toBe('unpublished');

    // 非 force 重连：未发布 + 冷却 → 明确的业务终态（客户端据此展示冷却，而不是无限重试）。
    const retry = await fetch(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(retry.status).toBe(429);
    const body = (await retry.json()) as { code: string; retryAfterSec: number };
    expect(body.code).toBe('COOLDOWN');
    expect(body.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('保护与限流（冷却与限流）', () => {
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
