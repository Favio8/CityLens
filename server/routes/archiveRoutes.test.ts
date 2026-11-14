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

/**
 * 所有已打开的响应体读取器：afterEach 先统一取消，再关服务端与数据库。
 * SSE 连接不取消会让 app.close() 等待到 hook 超时，也会给 Worker 留下悬挂句柄。
 */
const openReaders: Array<() => Promise<void>> = [];
const openedDbs: Db[] = [];

function trackReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<void> {
  let cancelled = false;
  const cancel = async (): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel();
    } catch {
      // 流已结束/已取消
    }
  };
  openReaders.push(cancel);
  return cancel;
}

/** 测试专用内存库：统一登记，afterEach 关闭，避免跨用例累积原生句柄。 */
function memoryDb(): Db {
  const db = openDb(':memory:');
  openedDbs.push(db);
  return db;
}

async function collectSse(url: string, init?: RequestInit): Promise<SseResult> {
  const response = await fetch(url, init);
  if (!response.ok || !response.body) {
    return { status: response.status, events: [] };
  }
  const reader = response.body.getReader();
  const cancel = trackReader(reader);
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
        await cancel();
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
  calls = 0;
  async generate(): Promise<GeneratedModule> {
    this.calls += 1;
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

/**
 * 计费 + 末模块挂起的生成器：并发并入恢复专项。
 * 每次调用都记账（onLlmCall），dataPulse 挂起以制造「原任务仍在运行」窗口。
 */
class GatedBillingGenerator implements ModuleGenerator {
  readonly name = 'gated-billing';
  readonly promptVersion = 'gated-billing-v1';
  calls = 0;
  private release: (() => void) | null = null;

  releaseLast(): void {
    this.release?.();
    this.release = null;
  }

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    this.calls += 1;
    input.onLlmCall?.();
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

/**
 * 可切换失败模块、逐次计费且确定性的生成器（恢复契约测试专用）。
 * - 每次 generate 都调用 onLlmCall（模拟真实 LLM 计费），除非 billOnly 指定只对某模块计费；
 * - 模块数据固定合法，避免依赖本地事实快照。
 */
class BillingGenerator implements ModuleGenerator {
  readonly name = 'billing-test';
  readonly promptVersion = 'billing-v1';
  failModules: ModuleName[] = [];
  billOnly: ModuleName | null = null;
  calls: ModuleName[] = [];

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    this.calls.push(input.module);
    if (this.billOnly === null || this.billOnly === input.module) input.onLlmCall?.();
    if (this.failModules.includes(input.module)) {
      throw new GenerationError('LLM_TIMEOUT', `模拟失败：模块 ${input.module} 超时`);
    }
    return {
      status: 'ok',
      verification: 'verified_by_source',
      sources: [
        { id: 'S-OK', type: 'preset_manual', title: '测试来源', retrievedAt: generatedAt },
      ],
      data: completeModuleData(input.module),
    };
  }
}

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
  const cancelReader = trackReader(reader);
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
    cancel: cancelReader,
  };
}

/** 已发布档案的只读签名：用于断言恢复未修改版本号与生成时间。 */
async function readPublishedArchive(
  base: string,
  cityId: string,
): Promise<{ status: string; dataVersion: number; generatedAt: string; identity: unknown }> {
  const response = await fetch(`${base}/api/cities/${cityId}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    identity: unknown;
    meta: { status: string; dataVersion: number; generatedAt: string };
  };
  return {
    status: body.meta.status,
    dataVersion: body.meta.dataVersion,
    generatedAt: body.meta.generatedAt,
    identity: body.identity,
  };
}

/** generation_jobs 总行数（恢复是否新增任务的硬断言）。 */
function countJobs(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get() as { n: number };
  return row.n;
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
  const db = memoryDb();
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
  // 顺序很关键：先取消所有 SSE 读取器，app.close() 才不会被悬挂连接拖到超时；
  // 最后关闭内存库，避免原生句柄在 Worker 内跨用例累积。
  for (const cancel of openReaders.splice(0)) await cancel();
  await Promise.all(runningApps.splice(0).map((app) => app.close().catch(() => undefined)));
  for (const db of openedDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // 已关闭
    }
  }
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
    const db = memoryDb();
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
 * 恢复契约（本轮专项）：断线后只能调用 POST /generate/resume。
 * 该入口只并入运行中的原任务或只读回放终态，绝不进入 JobManager.start，
 * 因此不新增 generation_jobs、不调用生成器、不写 llm_call_log、不改档案版本/生成时间。
 */
describe('恢复契约：断线只读恢复，不重新生成计费', () => {
  it('全部完成：服务端已完成、客户端丢失 done → 恢复终态，不新增任务/调用/账本/档案写入', async () => {
    const billing = new BillingGenerator();
    const { db, app } = setup(billing);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    const first = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, attemptId: 'attempt-complete' }),
      },
      (events) => events.some((item) => item.event === 'meta'),
    );
    expect(first.status).toBe(200);
    const meta = first.events.find((item) => item.event === 'meta')!.data as {
      jobId: string;
      attemptId?: string;
    };
    expect(meta.attemptId).toBe('attempt-complete');
    await first.cancel();
    await waitFor(async () => jobs.getRunning('CN-350500') === null, 10_000, 50, '任务收尾');

    const callsAfter = billing.calls.length;
    const llmAfter = jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z');
    const before = await readPublishedArchive(base, 'CN-350500');
    expect(callsAfter).toBe(MODULE_NAMES.length);
    expect(llmAfter).toBe(MODULE_NAMES.length);

    const recovered = await collectSse(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: meta.jobId }),
    });
    expect(recovered.status).toBe(200);
    expect(recovered.events[0]!.event).toBe('notice');
    expect(recovered.events[0]!.data.code).toBe('RESUMED_TERMINAL');
    const done = recovered.events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.status).toBe('complete');
    const identity = recovered.events.find(
      (item) => item.event === 'module' && item.data.name === 'identity',
    );
    expect(identity).toBeDefined();
    expect((identity!.data as { fromCache?: boolean }).fromCache).toBe(true);

    // 恢复没有新增任务、没有生成器调用、没有账本记录、没有档案写入。
    expect(countJobs(db)).toBe(1);
    expect(billing.calls.length).toBe(callsAfter);
    expect(jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z')).toBe(llmAfter);
    expect(await readPublishedArchive(base, 'CN-350500')).toEqual(before);
  });

  it('部分完成且含失败模块：恢复回放 partial 终态与失败提示，不自动重试失败模块', async () => {
    const billing = new BillingGenerator();
    billing.failModules = ['dataPulse', 'localSoul'];
    const { db, app } = setup(billing);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    const first = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, attemptId: 'attempt-partial' }),
      },
      (events) => events.some((item) => item.event === 'meta'),
    );
    const meta = first.events.find((item) => item.event === 'meta')!.data as { jobId: string };
    await first.cancel();
    await waitFor(async () => jobs.getRunning('CN-350500') === null, 10_000, 50, '任务收尾');
    const callsAfter = billing.calls.length;
    const llmAfter = jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z');
    const before = await readPublishedArchive(base, 'CN-350500');
    expect(before.status).toBe('partial');

    const recovered = await collectSse(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: meta.jobId }),
    });
    const done = recovered.events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.status).toBe('partial');
    expect(done.data.failedModules).toEqual(['localSoul', 'dataPulse']);
    const failed = recovered.events
      .filter((item) => item.event === 'module_error')
      .map((item) => item.data.name);
    expect(failed.sort()).toEqual(['dataPulse', 'localSoul']);
    // 失败卷不携带内容；其余卷以 fromCache 回放。
    expect(
      recovered.events.some(
        (item) => item.event === 'module' && item.data.name === 'dataPulse',
      ),
    ).toBe(false);
    expect(
      recovered.events.some(
        (item) => item.event === 'module' && item.data.name === 'identity',
      ),
    ).toBe(true);

    expect(countJobs(db)).toBe(1);
    expect(billing.calls.length).toBe(callsAfter);
    expect(jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z')).toBe(llmAfter);
    expect(await readPublishedArchive(base, 'CN-350500')).toEqual(before);
  });

  it('场景 A：保留旧内容但最近一次尝试失败 → 恢复只回放失败提示与旧内容，不重跑 identity', async () => {
    const billing = new BillingGenerator();
    const { db, app } = setup(billing);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    // 首次生成：全部成功，建立可读档案与 identity 旧内容。
    const seed = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-a-1' }),
    });
    expect(seed.events.at(-1)?.data.status).toBe('complete');
    const identityBefore = (await readPublishedArchive(base, 'CN-350500')).identity;
    expect(identityBefore).not.toBeNull();

    // force 刷新：identity 失败，旧内容按 P0 规则保留（lastAttempt=failed）。
    billing.failModules = ['identity'];
    const refresh = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, attemptId: 'attempt-a-2' }),
      },
      (events) => events.some((item) => item.event === 'meta'),
    );
    const refreshMeta = refresh.events.find((item) => item.event === 'meta')!.data as {
      jobId: string;
    };
    await refresh.cancel();
    await waitFor(async () => jobs.getRunning('CN-350500') === null, 10_000, 50, '刷新收尾');

    const callsAfterRefresh = billing.calls.length;
    const llmAfterRefresh = jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z');
    const beforeResume = await readPublishedArchive(base, 'CN-350500');
    expect(beforeResume.identity).toEqual(identityBefore);

    // 客户端丢失 done 后恢复：带 jobId 的只读回放。
    const recovered = await collectSse(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: refreshMeta.jobId }),
    });
    const done = recovered.events.at(-1)!;
    expect(done.data.status).toBe('complete');
    expect(done.data.failedModules).toEqual(['identity']);
    const errorEvent = recovered.events.find(
      (item) => item.event === 'module_error' && item.data.name === 'identity',
    );
    expect(errorEvent?.data.code).toBe('LLM_TIMEOUT');
    const retained = recovered.events.find(
      (item) =>
        item.event === 'module' &&
        item.data.name === 'identity' &&
        item.data.fromCache === true,
    );
    expect(retained).toBeDefined();
    expect((retained!.data as { data: unknown }).data).toEqual(identityBefore);

    // 再按 attemptId 恢复一次：仍不新增任务/调用/账本/档案写入。
    const again = await collectSse(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-a-2' }),
    });
    expect(again.events.at(-1)?.data.status).toBe('complete');

    expect(countJobs(db)).toBe(2); // 首次生成 + force 刷新；恢复 0 新增
    expect(billing.calls.length).toBe(callsAfterRefresh);
    expect(jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z')).toBe(llmAfterRefresh);
    expect(await readPublishedArchive(base, 'CN-350500')).toEqual(beforeResume);
    // 失败提示与旧内容在 GET 口径下同样同时可见。
    const hit = await fetch(`${base}/api/cities/CN-350500`);
    const body = (await hit.json()) as {
      identity: unknown;
      meta: { moduleStatus: Record<string, string>; moduleAttempts?: Record<string, { code: string }> };
    };
    expect(body.meta.moduleStatus.identity).toBe('ok');
    expect(body.meta.moduleAttempts?.identity?.code).toBe('LLM_TIMEOUT');
    expect(body.identity).toEqual(identityBefore);
  });

  it('场景 B：预算恰好耗尽后仍可恢复已完成终态（恢复不经过预算入口）', async () => {
    const billing = new BillingGenerator();
    billing.billOnly = 'identity';
    const { db, app } = setup(billing);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    // 用掉除最后一次之外的全部预算（只写逐次调用日志，不伪造任务汇总）。
    for (let i = 0; i < config.llm.dailyCallLimit - 1; i += 1) {
      jobs.recordLlmCall('budget-seed', 'CN-900000', new Date().toISOString());
    }
    const generated = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-budget' }),
    });
    expect(generated.events.at(-1)?.data.status).toBe('complete');
    const meta = generated.events.find((item) => item.event === 'meta')!.data as { jobId: string };
    expect(jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z')).toBe(config.llm.dailyCallLimit);

    // 预算入口确实已耗尽：新的生成被 503 拦截。
    const blocked = await fetch(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(blocked.status).toBe(503);
    expect(((await blocked.json()) as { code: string }).code).toBe('BUDGET_EXCEEDED');

    // 恢复不受预算入口影响：200 + 终态，且不记账。
    const recovered = await collectSse(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: meta.jobId }),
    });
    expect(recovered.status).toBe(200);
    expect(recovered.events.at(-1)?.data.status).toBe('complete');
    expect(countJobs(db)).toBe(1);
    expect(jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z')).toBe(
      config.llm.dailyCallLimit,
    );
    expect((await fetch(`${base}/api/cities/CN-350500`)).status).toBe(200);
  });

  it('恢复过程中原任务恰好结束：并入同一任务并收到 done，不产生第二个任务', async () => {
    const gated = new GatedCompleteGenerator();
    const { db, app } = setup(gated);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    const first = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, attemptId: 'attempt-race' }),
      },
      (events) => events.some((item) => item.event === 'meta'),
    );
    const meta = first.events.find((item) => item.event === 'meta')!.data as { jobId: string };
    await first.cancel();
    expect(jobs.getRunning('CN-350500')).not.toBeNull();

    const resumed = await openSse(
      `${base}/api/cities/CN-350500/generate/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: meta.jobId }),
      },
      (events) => events.some((item) => item.event === 'notice' && item.data.code === 'RESUMED'),
    );
    expect(resumed.status).toBe(200);
    expect(
      resumed.events.some((item) => item.event === 'notice' && item.data.code === 'RESUMED'),
    ).toBe(true);

    // 恢复连接已并入后任务才收尾：同一连接必须收到 done。
    gated.releaseLast();
    await resumed.readUntil((events) => events.some((item) => item.event === 'done'));
    const done = resumed.events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.status).toBe('complete');
    await resumed.cancel();

    await waitFor(async () => jobs.getRunning('CN-350500') === null, 10_000, 50, '任务收尾');
    expect(gated.calls).toBe(MODULE_NAMES.length);
    expect(countJobs(db)).toBe(1);
  });

  it('收到 meta 前断线：按 attemptId 多次恢复仍只有一个任务；未知 attemptId 明确不可恢复', async () => {
    const hanging = new HangingGenerator();
    const { db, app } = setup(hanging);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    // 首次请求已到服务端，但客户端在读到 meta 之前就断线（只保留 attemptId）。
    const response = await fetch(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-meta-lost' }),
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    await waitFor(async () => countJobs(db) === 1, 10_000, 50, '首次任务已创建');

    // 多次恢复都只并入同一个任务（读到回放的 meta 为止）。
    for (let round = 0; round < 2; round += 1) {
      const resumed = await openSse(
        `${base}/api/cities/CN-350500/generate/resume`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attemptId: 'attempt-meta-lost' }),
        },
        (events) => events.some((item) => item.event === 'meta'),
      );
      expect(
        resumed.events.some((item) => item.event === 'notice' && item.data.code === 'RESUMED'),
      ).toBe(true);
      const meta = resumed.events.find((item) => item.event === 'meta')!.data as {
        jobId: string;
        attemptId?: string;
      };
      expect(meta.attemptId).toBe('attempt-meta-lost');
      expect(meta.jobId).toBeTruthy();
      await resumed.cancel();
    }
    expect(countJobs(db)).toBe(1);
    expect(hanging.calls).toBe(1);

    // 手动「继续展卷」等价于再一次恢复：仍只有一个任务。
    const manual = await openSse(
      `${base}/api/cities/CN-350500/generate/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'attempt-meta-lost' }),
      },
      (events) => events.some((item) => item.event === 'notice'),
    );
    await manual.cancel();
    expect(countJobs(db)).toBe(1);

    // 客户端标识不属于任何任务：明确 409，不顶替、不新建。
    const unknown = await fetch(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-never-arrived' }),
    });
    expect(unknown.status).toBe(409);
    expect(((await unknown.json()) as { code: string }).code).toBe('RESUME_UNAVAILABLE');
    expect(countJobs(db)).toBe(1);
    expect(hanging.calls).toBe(1);
  });

  it('并发并入：B 并入 A 的任务后未收到 meta 即断线，按 attemptId 恢复到同一 jobId', async () => {
    const gated = new GatedBillingGenerator();
    const { db, app } = setup(gated);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    // A 创建任务并读到 meta（持有 jobId 与自己的 attemptId）。
    const first = await openSse(
      `${base}/api/cities/CN-350500/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, attemptId: 'attempt-a' }),
      },
      (events) => events.some((item) => item.event === 'meta'),
    );
    expect(first.status).toBe(200);
    const meta = first.events.find((item) => item.event === 'meta')!.data as {
      jobId: string;
      attemptId?: string;
    };
    expect(meta.attemptId).toBe('attempt-a');
    await first.cancel();
    expect(jobs.getRunning('CN-350500')).not.toBeNull();
    const callsAfterStart = gated.calls;

    // B 对同城发起生成：服务端并入 A 的任务；B 在读到 meta 之前断开（只保留 attemptId）。
    const joined = await fetch(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-b' }),
    });
    expect(joined.status).toBe(200);
    await joined.body?.cancel();
    // 并入即绑定：B 的标识登记到原任务（修复前被丢弃，恢复必然失败）。
    expect(jobs.findByAttempt('CN-350500', 'attempt-b')?.jobId).toBe(meta.jobId);
    expect(countJobs(db)).toBe(1);
    expect(gated.calls).toBe(callsAfterStart); // 并入不触发任何新生成

    // B 只带 attemptId 恢复：并入同一任务，回放 meta 的 jobId 与 A 一致。
    const resumed = await openSse(
      `${base}/api/cities/CN-350500/generate/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'attempt-b' }),
      },
      (events) => events.some((item) => item.event === 'meta'),
    );
    expect(resumed.status).toBe(200);
    expect(
      resumed.events.some((item) => item.event === 'notice' && item.data.code === 'RESUMED'),
    ).toBe(true);
    expect(
      (resumed.events.find((item) => item.event === 'meta')!.data as { jobId: string }).jobId,
    ).toBe(meta.jobId);

    // 放行收尾：并入连接随原任务一起收到 done。
    gated.releaseLast();
    await resumed.readUntil((events) => events.some((item) => item.event === 'done'));
    const done = resumed.events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.status).toBe('complete');
    await resumed.cancel();
    await waitFor(async () => jobs.getRunning('CN-350500') === null, 10_000, 50, '任务收尾');

    const callsAfterDone = gated.calls;
    const llmAfterDone = jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z');
    const archiveAtFinish = await readPublishedArchive(base, 'CN-350500');

    // 任务结束后 B 再按 attemptId 恢复：终态回放同一 jobId（修复前 RESUME_UNAVAILABLE）。
    const afterFinish = await collectSse(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-b' }),
    });
    expect(afterFinish.status).toBe(200);
    expect(afterFinish.events[0]!.data.code).toBe('RESUMED_TERMINAL');
    expect(
      (afterFinish.events.find((item) => item.event === 'meta')!.data as { jobId: string }).jobId,
    ).toBe(meta.jobId);
    expect(afterFinish.events.at(-1)!.data.status).toBe('complete');

    // A 的 attemptId 同样定位到同一任务。
    const byA = await collectSse(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-a' }),
    });
    expect(byA.status).toBe(200);
    expect(
      (byA.events.find((item) => item.event === 'meta')!.data as { jobId: string }).jobId,
    ).toBe(meta.jobId);

    // 只读断言：任务数、生成器调用、账本、档案元数据在恢复前后不变。
    expect(countJobs(db)).toBe(1);
    expect(gated.calls).toBe(callsAfterDone);
    expect(jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z')).toBe(llmAfterDone);
    expect(await readPublishedArchive(base, 'CN-350500')).toEqual(archiveAtFinish);

    // 未知标识仍然明确不可恢复，不顶替、不新建。
    const unknown = await fetch(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-never-arrived' }),
    });
    expect(unknown.status).toBe(409);
    expect(((await unknown.json()) as { code: string }).code).toBe('RESUME_UNAVAILABLE');
    expect(countJobs(db)).toBe(1);
    expect(gated.calls).toBe(callsAfterDone);
  });

  it('显式单卷重试与自动恢复的区别：重试新建任务并计费，恢复不新增', async () => {
    const billing = new BillingGenerator();
    const { db, app } = setup(billing);
    const base = await listen(app);
    const jobs = new JobRepo(db);

    const seed = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-retry-seed' }),
    });
    expect(seed.events.at(-1)?.data.status).toBe('complete');

    billing.failModules = ['identity'];
    const refresh = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, attemptId: 'attempt-retry-1' }),
    });
    expect(refresh.events.at(-1)?.data.status).toBe('complete');
    const refreshMeta = refresh.events.find((item) => item.event === 'meta')!.data as {
      jobId: string;
    };
    const callsAfterRefresh = billing.calls.length;
    const llmAfterRefresh = jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z');
    const beforeRetry = await readPublishedArchive(base, 'CN-350500');

    // 自动恢复：不新增任务、不调用生成器、不记账、不改档案。
    const recovered = await collectSse(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: refreshMeta.jobId }),
    });
    expect(recovered.events.at(-1)?.data.failedModules).toEqual(['identity']);
    expect(countJobs(db)).toBe(2);
    expect(billing.calls.length).toBe(callsAfterRefresh);
    expect(jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z')).toBe(llmAfterRefresh);
    expect(await readPublishedArchive(base, 'CN-350500')).toEqual(beforeRetry);

    // 用户显式单卷重试：只生成 identity，新建任务、正常计费、档案版本递增。
    billing.failModules = [];
    const retried = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: ['identity'], attemptId: 'attempt-retry-2' }),
    });
    const retriedDone = retried.events.at(-1)!;
    expect(retriedDone.event).toBe('done');
    expect(retriedDone.data.status).toBe('complete');
    expect(countJobs(db)).toBe(3);
    expect(billing.calls.length).toBe(callsAfterRefresh + 1);
    expect(jobs.countLlmCallsSince('1970-01-01T00:00:00.000Z')).toBe(llmAfterRefresh + 1);
    const afterRetry = await readPublishedArchive(base, 'CN-350500');
    expect(afterRetry.dataVersion).toBeGreaterThan(beforeRetry.dataVersion);
    expect(afterRetry.generatedAt).not.toBe(beforeRetry.generatedAt);
    // 重试成功后 failure 提示清除（与 GET 口径一致）。
    const hit = await fetch(`${base}/api/cities/CN-350500`);
    const body = (await hit.json()) as {
      meta: { moduleAttempts?: Record<string, { code: string }> };
    };
    expect(body.meta.moduleAttempts?.identity).toBeUndefined();
  });

  it('未达发布门槛：恢复得到 429 COOLDOWN，不暴露未发布内容', async () => {
    const failing = new BillingGenerator();
    failing.failModules = [...MODULE_NAMES];
    const { app } = setup(failing);
    const base = await listen(app);
    const first = await collectSse(`${base}/api/cities/CN-350500/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, attemptId: 'attempt-unpublished' }),
    });
    expect(first.events.at(-1)?.data.status).toBe('unpublished');

    const retry = await fetch(`${base}/api/cities/CN-350500/generate/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-unpublished' }),
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
