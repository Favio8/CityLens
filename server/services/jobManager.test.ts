import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULE_NAMES, type ModuleName, type SourceRef } from '../../shared/schema';
import { openDb } from '../db';
import { ArchiveRepo } from '../db/archiveRepo';
import { CityRepo } from '../db/cityRepo';
import { JobRepo } from '../db/jobRepo';
import { JobManager, collectSourceRefs, type JobRuntime, type LlmBudget } from './jobManager';
import type { GenerateInput, GeneratedModule, ModuleGenerator } from './llmGenerator';
import { GenerationError, MockGenerator } from './llmGenerator';
import { buildArchiveResponse, loadBundle, moduleStatusMap } from './cacheService';
import { computeArchiveStatus } from '../../shared/validators';

const CITY_ID = 'CN-610100';
const OTHER_CITY_ID = 'CN-320500';
const TEST_SOURCE: SourceRef = {
  id: 'S-TEST',
  type: 'preset_manual',
  title: '测试来源',
  retrievedAt: '2026-11-11T00:00:00.000Z',
};

/** 全部模块都能成功产出的确定性生成器（用于截止/发布状态测试）。 */
class FixedGenerator implements ModuleGenerator {
  readonly name = 'fixed-test';
  readonly promptVersion = 'fixed-v1';
  calls: ModuleName[] = [];

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    this.calls.push(input.module);
    return {
      status: 'ok',
      verification: 'verified_by_source',
      sources: [TEST_SOURCE],
      data: fixedModuleData(input.module),
    };
  }
}

function fixedModuleData(module: ModuleName): unknown {
  switch (module) {
    case 'identity':
      return {
        standardName: '西安',
        aliases: ['长安'],
        center: [108.9402, 34.3416],
        area: { value: '待考', sourceRefs: [] },
        population: { value: '待考', sourceRefs: [] },
        climateType: { value: '待考', sourceRefs: [] },
        adminDivisions: { value: '待考', sourceRefs: [] },
        oneLinePersona: '长安的风从城墙吹到今天。',
        sourceRefs: ['S-TEST'],
        verification: 'verified_by_source',
      };
    case 'chronicle':
      return [
        {
          eraName: '唐',
          startYear: 618,
          endYear: 907,
          periodRange: '618—907',
          ancientCityName: '长安',
          keyEvents: '李唐定都长安，丝路枢纽地位延续至今。',
          relicToday: '大雁塔',
          centerCoord: null,
          sourceRefs: ['S-TEST'],
          verification: 'pending_human_review',
        },
      ];
    case 'landmarks':
      return [
        {
          entityRef: 'Q-1',
          name: '大雁塔',
          category: 'must_visit',
          bestSeason: '春秋',
          reason: '唐代砖塔，丝绸之路遗存。',
          placeName: '西安大雁塔',
          coordinates: [108.9592, 34.2186],
          coordSource: 'local_gazetteer',
          sourceRefs: ['S-TEST'],
          verification: 'pending_human_review',
        },
      ];
    case 'relics':
      return [
        {
          registryId: 'R-1',
          name: '半坡遗址',
          era: '新石器时代',
          museumOrSite: '西安半坡博物馆',
          protectionLevel: '国保',
          findSpot: '待考',
          story: '仰韶文化聚落遗址，黄河流域史前文明见证。',
          coordinates: null,
          sourceRefs: ['S-TEST'],
          verification: 'pending_human_review',
        },
      ];
    case 'figures':
      return [
        {
          entityRef: 'Q-2',
          name: '白居易',
          dynasty: '唐',
          birthYear: 772,
          deathYear: 846,
          relationType: 'sojourner',
          evidence: { property: 'workplace', value: '长安' },
          cityBond: '白居易长期在长安任职，留下大量诗文与市政事迹。',
          highlights: '唐代诗人，代表作《长恨歌》《琵琶行》。',
          sites: [],
          sourceRefs: ['S-TEST'],
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
          lines: ['长安大道连狭斜'],
          background: '待考',
          relationType: 'direct',
          imageryMap: [],
          sourceRefs: ['S-TEST'],
          verification: 'pending_human_review',
        },
      ];
    case 'localSoul':
      return {
        aiCurated: true,
        foods: [{ name: '羊肉泡馍', flavor: '浓郁', origin: '关中' }],
        dialects: [
          { word: '嘹咋咧', pronunciation: 'liao za lie', meaning: '好得很', example: '这饭嘹咋咧' },
        ],
        ichItems: [{ name: '秦腔', level: '待考', intro: '西北大戏', sourceRefs: ['S-TEST'] }],
        festivals: [{ name: '春节', season: '正月初一', custom: '闹社火' }],
      };
    case 'dataPulse':
      return {
        gdpSeries: [{ year: 2025, value: null }],
        popSeries: [{ year: 2025, value: null }],
        statMeta: {
          gdp: { unit: '亿元', caliber: '地区生产总值（现价）', sourceRefs: ['S-TEST'] },
          pop: { unit: '万人', caliber: '年末常住人口', sourceRefs: ['S-TEST'] },
        },
        climateMonthly: [],
        climateMeta: { period: '1991–2020', station: '待考', sourceRefs: [] },
      };
    default:
      throw new Error('未知模块');
  }
}

/** 每次 generate 后推进注入时钟，用于总截止测试（不实际等待）。 */
class ClockAdvancingGenerator implements ModuleGenerator {
  readonly name = 'clock-advancing';
  readonly promptVersion = 'clock-v1';
  constructor(
    private readonly inner: FixedGenerator,
    private readonly stepMs: number,
    private readonly clock: { now: Date },
  ) {}

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    const result = await this.inner.generate(input);
    this.clock.now = new Date(this.clock.now.getTime() + this.stepMs);
    return result;
  }
}

function setup(options: {
  failModules?: string[];
  generator?: ModuleGenerator;
  now?: () => Date;
  deadlineMs?: number;
  budget?: LlmBudget;
} = {}) {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO cities
       (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat)
     VALUES (?, '西安', '陕西省', 'prefecture', 'xian', ?, 108.9422, 34.2611)`,
  ).run(CITY_ID, "Xi'an");
  db.prepare(
    `INSERT INTO cities
       (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat)
     VALUES (?, '苏州', '江苏省', 'prefecture', 'suzhou', 'Suzhou', 120.5853, 31.2989)`,
  ).run(OTHER_CITY_ID);
  db.prepare(
    `INSERT INTO city_aliases (alias_key, display_alias, city_id, match_type)
     VALUES ('长安', '长安', ?, 'ancient')`,
  ).run(CITY_ID);

  const archiveRepo = new ArchiveRepo(db);
  const jobRepo = new JobRepo(db);
  const cityRepo = new CityRepo(db);
  const counting = new CountingGenerator(
    options.generator ??
      new MockGenerator({
        delayMs: 2,
        failModules: options.failModules ?? ['chronicle', 'localSoul', 'dataPulse'],
      }),
  );
  const manager = new JobManager({
    archiveRepo,
    jobRepo,
    cityRepo,
    generator: counting,
    budget: options.budget ?? { consume: () => true },
    ...(options.now ? { now: options.now } : {}),
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
  });
  const city = cityRepo.getCity(CITY_ID);
  if (!city) throw new Error('测试城市不存在');
  const otherCity = cityRepo.getCity(OTHER_CITY_ID);
  if (!otherCity) throw new Error('测试城市不存在');
  return { db, archiveRepo, jobRepo, cityRepo, manager, counting, city, otherCity };
}

class CountingGenerator implements ModuleGenerator {
  count = 0;
  calls: ModuleName[] = [];
  constructor(private readonly inner: ModuleGenerator) {}
  get name(): string {
    return this.inner.name;
  }
  get promptVersion(): string {
    return this.inner.promptVersion;
  }
  async generate(input: GenerateInput): Promise<GeneratedModule> {
    this.count += 1;
    this.calls.push(input.module);
    return this.inner.generate(input);
  }
}

function waitDone(runtime: JobRuntime, manager: JobManager): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let detach: () => void = () => undefined;
    detach = manager.attach(runtime, (event) => {
      if (event.event === 'done') {
        detach();
        resolve(event.data as Record<string, unknown>);
      }
    });
  });
}

/** 收集整条流（含回放），在 done 时一次性返回，便于断言事件序列。 */
function collectStream(
  runtime: JobRuntime,
  manager: JobManager,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  return new Promise((resolve) => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let detach: () => void = () => undefined;
    detach = manager.attach(runtime, (event) => {
      events.push({ event: event.event, data: event.data as Record<string, unknown> });
      if (event.event === 'done') {
        detach();
        resolve(events);
      }
    });
  });
}

describe('同城单飞', () => {
  it('并发 10 次 start 只创建一个任务，其余并入同一 runtime', async () => {
    const { manager, counting, city, jobRepo } = setup();
    const first = manager.start({
      city,
      aliases: ['长安'],
      requesterHash: 'hash-a',
      force: false,
      modules: [...MODULE_NAMES],
    });
    const others = Array.from({ length: 9 }, () =>
      manager.start({
        city,
        aliases: ['长安'],
        requesterHash: 'hash-b',
        force: false,
        modules: [...MODULE_NAMES],
      }),
    );
    expect(others.every((item) => item.attached)).toBe(true);
    expect(new Set([first, ...others].map((item) => item.runtime.jobId)).size).toBe(1);

    const done = await waitDone(first.runtime, manager);
    expect(done.status).toBe('partial');
    expect(counting.count).toBe(MODULE_NAMES.length);
    expect(jobRepo.listRecent(10).length).toBe(1);
  });
});

describe('增量生成', () => {
  let context: ReturnType<typeof setup>;

  beforeEach(() => {
    context = setup();
  });

  it('第二次生成跳过已通过的 5 个模块，只补齐失败模块', async () => {
    const { manager, counting, city } = context;
    const first = manager.start({
      city,
      aliases: [],
      requesterHash: 'hash',
      force: false,
      modules: [...MODULE_NAMES],
    });
    const firstDone = await waitDone(first.runtime, manager);
    expect(firstDone.status).toBe('partial');
    expect(counting.count).toBe(8);

    counting.calls = [];
    const second = manager.start({
      city,
      aliases: [],
      requesterHash: 'hash',
      force: false,
      modules: [...MODULE_NAMES],
    });
    expect(second.runtime.planned.length).toBe(3);
    const secondDone = await waitDone(second.runtime, manager);
    expect(secondDone.status).toBe('partial');
    expect(counting.calls.sort()).toEqual(['chronicle', 'dataPulse', 'localSoul']);
  });

  it('force 时全部模块重新生成', async () => {
    const { manager, counting, city } = context;
    await waitDone(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      manager,
    );
    counting.calls = [];
    const forced = manager.start({
      city,
      aliases: [],
      requesterHash: 'hash',
      force: true,
      modules: [...MODULE_NAMES],
    });
    expect(forced.runtime.planned.length).toBe(8);
    await waitDone(forced.runtime, manager);
    expect(counting.calls.length).toBe(8);
  });

  it('单模块请求不会把已发布档案打回 unpublished', async () => {
    const { manager, archiveRepo, city } = context;
    await waitDone(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      manager,
    );
    expect(archiveRepo.getArchive(CITY_ID)?.status).toBe('partial');

    const subset = manager.start({
      city,
      aliases: [],
      requesterHash: 'hash',
      force: false,
      modules: ['landmarks'],
    });
    expect(subset.runtime.planned).toEqual([]);
    const done = await waitDone(subset.runtime, manager);
    expect(done.status).toBe('partial');
    expect(archiveRepo.getArchive(CITY_ID)?.status).toBe('partial');
  });

  it('重复模块名只生成一次', async () => {
    const { manager, counting, city } = context;
    const runtime = manager.start({
      city,
      aliases: [],
      requesterHash: 'hash',
      force: false,
      modules: ['landmarks', 'landmarks', 'landmarks'],
    }).runtime;
    expect(runtime.requested).toEqual(['landmarks']);
    expect(runtime.planned).toEqual(['landmarks']);
    await waitDone(runtime, manager);
    expect(counting.calls).toEqual(['landmarks']);
  });
});

describe('模块级失败与冷却', () => {
  it('失败模块保留旧数据，整体失败进入冷却', async () => {
    const { manager, archiveRepo, jobRepo, city } = setup({
      failModules: ['landmarks', 'identity'],
    });
    const runtime = manager.start({
      city,
      aliases: [],
      requesterHash: 'hash',
      force: false,
      modules: ['identity', 'landmarks'],
    }).runtime;
    const done = await waitDone(runtime, manager);
    expect(done.status).toBe('unpublished');

    const modules = archiveRepo.listModules(CITY_ID);
    expect(modules.every((module) => module.status === 'failed')).toBe(true);

    const cooldown = jobRepo.findActiveCooldown(CITY_ID, new Date().toISOString());
    expect(cooldown).not.toBeNull();
    expect(new Date(cooldown!.cooldownUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it('成功生成后不残留冷却', async () => {
    const { manager, jobRepo, city } = setup();
    const runtime = manager.start({
      city,
      aliases: [],
      requesterHash: 'hash',
      force: false,
      modules: [...MODULE_NAMES],
    }).runtime;
    await waitDone(runtime, manager);
    expect(jobRepo.findActiveCooldown(CITY_ID, new Date().toISOString())).toBeNull();
  });
});

describe('sourceRefs 收集', () => {
  it('递归收集嵌套模块数据中的来源引用', () => {
    const refs = collectSourceRefs({
      a: { sourceRefs: ['S1', 'S2'] },
      b: [{ sourceRefs: ['S2', 'S3'] }, { nested: { sourceRefs: ['S4'] } }],
    });
    expect([...refs].sort()).toEqual(['S1', 'S2', 'S3', 'S4']);
  });
});

describe('进程重启后的任务冲突', () => {
  it('DB 中未过 stale 期的 running 任务使 start 抛 409 JOB_CONFLICT，而非 500', () => {
    const { manager, jobRepo, city } = setup();
    // 模拟进程重启：DB 里残留一个刚开始的 running 任务（未到 stale 期）。
    jobRepo.create({
      jobId: 'restart-leftover',
      cityId: CITY_ID,
      force: false,
      modules: ['identity'],
      requesterHash: 'hash-restart',
      startedAt: new Date().toISOString(),
    });
    let error: { code?: string; statusCode?: number } | null = null;
    try {
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash-new',
        force: false,
        modules: [...MODULE_NAMES],
      });
    } catch (thrown) {
      error = thrown as { code?: string; statusCode?: number };
    }
    expect(error).not.toBeNull();
    expect(error?.code).toBe('JOB_CONFLICT');
    expect(error?.statusCode).toBe(409);
  });
});

/* -------------------------------------------------------------------------- */
/* P0：重新生成失败不得下架旧档案                                              */
/* -------------------------------------------------------------------------- */

/** 只让指定模块失败的确定性生成器（其余成功）。 */
class SelectiveFailGenerator implements ModuleGenerator {
  readonly name = 'selective-fail';
  readonly promptVersion = 'selective-v1';
  constructor(private readonly fail: ModuleName[]) {}

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    if (this.fail.includes(input.module)) {
      throw new GenerationError('LLM_TIMEOUT', `模拟失败：模块 ${input.module} 超时`);
    }
    return {
      status: 'ok',
      verification: 'verified_by_source',
      sources: [TEST_SOURCE],
      data: fixedModuleData(input.module),
    };
  }
}

describe('P0：重新生成失败时旧档案保持可用', () => {
  it('force 重生成 identity 失败后档案仍为 complete，GET 与 SSE 口径一致', async () => {
    const first = setup({ generator: new FixedGenerator() });
    await waitDone(
      first.manager.start({
        city: first.city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      first.manager,
    );
    expect(first.archiveRepo.getArchive(CITY_ID)?.status).toBe('complete');
    const identityBefore = first.archiveRepo
      .listModules(CITY_ID)
      .find((m) => m.name === 'identity');

    // 同一 DB 上换一个只失败 identity 的生成器，模拟 force 刷新。
    const failing = new JobManager({
      archiveRepo: first.archiveRepo,
      jobRepo: first.jobRepo,
      cityRepo: first.cityRepo,
      generator: new SelectiveFailGenerator(['identity']),
      budget: { consume: () => true },
    });
    const stream = collectStream(
      failing.start({
        city: first.city,
        aliases: [],
        requesterHash: 'hash',
        force: true,
        modules: [...MODULE_NAMES],
      }).runtime,
      failing,
    );
    const events = await stream;
    const done = events.at(-1)!;
    expect(done.data.status).toBe('complete');
    expect(done.data.failedModules).toEqual(['identity']);

    // 模块行：identity 保持 ok 且数据未丢，失败只记入 lastAttempt。
    const identityAfter = first.archiveRepo
      .listModules(CITY_ID)
      .find((m) => m.name === 'identity');
    expect(identityAfter?.status).toBe('ok');
    expect(identityAfter?.data).toEqual(identityBefore?.data);
    const verification = identityAfter?.verification as {
      lastAttempt?: { status: string; code: string };
    };
    expect(verification.lastAttempt?.status).toBe('failed');
    expect(verification.lastAttempt?.code).toBe('LLM_TIMEOUT');

    // 档案不下架、无冷却。
    expect(first.archiveRepo.getArchive(CITY_ID)?.status).toBe('complete');
    expect(
      first.jobRepo.findActiveCooldown(CITY_ID, new Date().toISOString()),
    ).toBeNull();

    // SSE 同时给出失败信号与保留内容（与 GET 口径一致）。
    const errorEvent = events.find((e) => e.event === 'module_error' && e.data.name === 'identity');
    expect(errorEvent?.data.code).toBe('LLM_TIMEOUT');
    const retained = events.find(
      (e) => e.event === 'module' && e.data.name === 'identity' && e.data.fromCache === true,
    );
    expect(retained).toBeDefined();

    // 公开读取口径：GET 仍返回完整旧内容。
    const bundle = loadBundle(first.archiveRepo, CITY_ID);
    const response = buildArchiveResponse(first.city, bundle!, ['长安']);
    expect(response).not.toBeNull();
    expect(response!.identity).not.toBeNull();
    expect(response!.meta.status).toBe('complete');
  });

  it('普通卷失败保留旧内容；单卷重试会重新尝试该模块', async () => {
    const first = setup({ generator: new FixedGenerator() });
    await waitDone(
      first.manager.start({
        city: first.city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      first.manager,
    );
    const landmarksBefore = first.archiveRepo
      .listModules(CITY_ID)
      .find((m) => m.name === 'landmarks');

    const failing = new JobManager({
      archiveRepo: first.archiveRepo,
      jobRepo: first.jobRepo,
      cityRepo: first.cityRepo,
      generator: new SelectiveFailGenerator(['landmarks']),
      budget: { consume: () => true },
    });
    const done = await waitDone(
      failing.start({
        city: first.city,
        aliases: [],
        requesterHash: 'hash',
        force: true,
        modules: [...MODULE_NAMES],
      }).runtime,
      failing,
    );
    expect(done.status).toBe('complete');

    const landmarksAfter = first.archiveRepo
      .listModules(CITY_ID)
      .find((m) => m.name === 'landmarks');
    expect(landmarksAfter?.status).toBe('ok');
    expect(landmarksAfter?.data).toEqual(landmarksBefore?.data);

    // 单卷重试（非 force）：失败过的模块不再被视为可复用，会重新生成。
    const retryManager = new JobManager({
      archiveRepo: first.archiveRepo,
      jobRepo: first.jobRepo,
      cityRepo: first.cityRepo,
      generator: new FixedGenerator(),
      budget: { consume: () => true },
    });
    const retry = retryManager.start({
      city: first.city,
      aliases: [],
      requesterHash: 'hash',
      force: false,
      modules: ['landmarks'],
    });
    expect(retry.runtime.planned).toEqual(['landmarks']);
    const retryDone = await waitDone(retry.runtime, retryManager);
    expect(retryDone.status).toBe('complete');
    const landmarksRetried = first.archiveRepo
      .listModules(CITY_ID)
      .find((m) => m.name === 'landmarks');
    expect(landmarksRetried?.verification).toEqual({ status: 'verified_by_source' });
  });

  it('全量刷新多模块失败：已有内容全部保留，档案保持已发布', async () => {
    const first = setup({ generator: new FixedGenerator() });
    await waitDone(
      first.manager.start({
        city: first.city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      first.manager,
    );
    const before = new Map(
      first.archiveRepo.listModules(CITY_ID).map((m) => [m.name, m.data]),
    );

    const failing = new JobManager({
      archiveRepo: first.archiveRepo,
      jobRepo: first.jobRepo,
      cityRepo: first.cityRepo,
      generator: new SelectiveFailGenerator(['identity', 'landmarks', 'poetics', 'dataPulse']),
      budget: { consume: () => true },
    });
    const events = await collectStream(
      failing.start({
        city: first.city,
        aliases: [],
        requesterHash: 'hash',
        force: true,
        modules: [...MODULE_NAMES],
      }).runtime,
      failing,
    );
    const done = events.at(-1)!;
    expect(done.data.status).toBe('complete');
    expect(new Set(done.data.failedModules as string[])).toEqual(
      new Set(['identity', 'landmarks', 'poetics', 'dataPulse']),
    );

    for (const [name, data] of before) {
      const after = first.archiveRepo.listModules(CITY_ID).find((m) => m.name === name);
      expect(after?.data).toEqual(data);
    }
    const bundle = loadBundle(first.archiveRepo, CITY_ID);
    expect(buildArchiveResponse(first.city, bundle!, [])).not.toBeNull();
  });

  it('首次生成失败仍按原门槛：unpublished + 冷却', async () => {
    const { manager, archiveRepo, jobRepo, city } = setup({
      generator: new SelectiveFailGenerator([...MODULE_NAMES]),
    });
    const done = await waitDone(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      manager,
    );
    expect(done.status).toBe('unpublished');
    expect(archiveRepo.getArchive(CITY_ID)?.status).toBe('unpublished');
    const cooldown = jobRepo.findActiveCooldown(CITY_ID, new Date().toISOString());
    expect(cooldown).not.toBeNull();
  });

  it('刷新过程中其他访客读取到的是旧内容，且来源登记完整一致', async () => {
    // 控制生成节奏：identity 成功后挂起，直到测试放行。
    let releaseFigures: (() => void) | null = null;
    const gated = new (class implements ModuleGenerator {
      readonly name = 'gated';
      readonly promptVersion = 'gated-v1';
      done = 0;
      async generate(input: GenerateInput): Promise<GeneratedModule> {
        if (input.module === 'figures') {
          await new Promise<void>((resolve) => {
            releaseFigures = resolve;
          });
        }
        this.done += 1;
        return {
          status: 'ok',
          verification: 'verified_by_source',
          sources: [TEST_SOURCE],
          data: fixedModuleData(input.module),
        };
      }
    })();

    const seed = setup({ generator: new FixedGenerator() });
    await waitDone(
      seed.manager.start({
        city: seed.city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      seed.manager,
    );
    const versionBefore = seed.archiveRepo.getArchive(CITY_ID)!.dataVersion;
    const sourcesBefore = seed.archiveRepo.getArchive(CITY_ID)!.sources.map((s) => s.id);

    const manager = new JobManager({
      archiveRepo: seed.archiveRepo,
      jobRepo: seed.jobRepo,
      cityRepo: seed.cityRepo,
      generator: gated,
      budget: { consume: () => true },
    });
    const runtime = manager.start({
      city: seed.city,
      aliases: [],
      requesterHash: 'hash',
      force: true,
      modules: [...MODULE_NAMES],
    }).runtime;

    // 等到 figures 挂起（identity~relics 已成功落库）。
    await vi.waitFor(() => expect(releaseFigures).not.toBeNull());

    // 访客读取：档案仍可读、内容为旧值、来源登记包含旧来源且无缺失引用。
    const bundle = loadBundle(seed.archiveRepo, CITY_ID);
    expect(bundle).not.toBeNull();
    const response = buildArchiveResponse(seed.city, bundle!, []);
    expect(response).not.toBeNull();
    expect(response!.meta.status).toBe('complete');
    expect(response!.identity).not.toBeNull();
    const registered = new Set(response!.sources.map((s) => s.id));
    for (const sourceId of sourcesBefore) expect(registered.has(sourceId)).toBe(true);
    // 新来源与模块数据在同一事务内落库，读者不会看到缺少来源的内容。
    expect(seed.archiveRepo.getArchive(CITY_ID)!.dataVersion).toBeGreaterThan(versionBefore);

    releaseFigures!();
    await waitDone(runtime, manager);
  });
});

/* -------------------------------------------------------------------------- */
/* P1：预算记账                                                               */
/* -------------------------------------------------------------------------- */

describe('P1：LLM 预算在真正请求前原子检查与记账', () => {
  it('Mock 与本地模块不冒充付费 LLM 调用（llm_calls 保持 0）', async () => {
    const consume = vi.fn(() => true);
    const { manager, jobRepo, city } = setup({ budget: { consume } });
    await waitDone(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      manager,
    );
    expect(consume).not.toHaveBeenCalled();
    const job = jobRepo.listRecent(1)[0]!;
    expect(job.llmCalls).toBe(0);
  });

  it('真实 LLM 请求（含重试）才计数；预算耗尽即中止且不再发起请求', async () => {
    let remaining = 2;
    const consume = vi.fn(() => {
      if (remaining <= 0) return false;
      remaining -= 1;
      return true;
    });
    const charging = new (class implements ModuleGenerator {
      readonly name = 'charging';
      readonly promptVersion = 'charging-v1';
      generateCalls: ModuleName[] = [];
      async generate(input: GenerateInput): Promise<GeneratedModule> {
        this.generateCalls.push(input.module);
        // 模拟「真正发请求前」的额度检查与记账。
        input.onLlmCall?.();
        return {
          status: 'ok',
          verification: 'verified_by_source',
          sources: [TEST_SOURCE],
          data: fixedModuleData(input.module),
        };
      }
    })();
    const { manager, city } = setup({ generator: charging, budget: { consume } });
    const events = await collectStream(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      manager,
    );
    // 前两个模块成功（记账 2 次），第三个模块预算耗尽：BUDGET_EXCEEDED 并不再继续。
    expect(consume).toHaveBeenCalledTimes(3);
    expect(charging.generateCalls).toEqual(['identity', 'chronicle', 'landmarks']);
    const errors = events.filter((e) => e.event === 'module_error');
    expect(errors.map((e) => e.data.name)).toEqual(['landmarks']);
    expect(errors[0]!.data.code).toBe('BUDGET_EXCEEDED');
    const done = events.at(-1)!;
    expect(done.data.status).toBe('unpublished');
    expect(done.data.failedModules).toEqual(['landmarks']);
    // 未发布 → 冷却照旧。
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent?.data.code).toBe('BUDGET_EXCEEDED');
  });
});

/* -------------------------------------------------------------------------- */
/* P1：单次生成总截止与任务恢复                                               */
/* -------------------------------------------------------------------------- */

describe('P1：单次生成总截止（180s）', () => {
  it('到达总截止后不再开始新模块，已成功内容保留，SSE 有明确终止结果', async () => {
    const clock = { now: new Date('2026-11-14T10:00:00.000Z') };
    const { manager, archiveRepo, jobRepo, city } = setup({
      generator: new ClockAdvancingGenerator(new FixedGenerator(), 30_000, clock),
      now: () => clock.now,
      deadlineMs: 75_000,
    });
    const events = await collectStream(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      manager,
    );
    // 每模块耗时 30s：identity、chronicle 成功；landmarks 生成期间跨过 75s 截止，
    // 其结果被丢弃（迟到不落库），relics 及之后不再开始。
    const generated = events.filter((e) => e.event === 'module').map((e) => e.data.name);
    expect(generated).toEqual(['identity', 'chronicle']);
    const late = events.find((e) => e.event === 'module_error' && e.data.name === 'landmarks');
    expect(late?.data.code).toBe('LLM_TIMEOUT');
    const done = events.at(-1)!;
    expect(done.data.status).toBe('unpublished');
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent?.data.code).toBe('GENERATION_DEADLINE');
    expect(errorEvent?.data.retryAfterSec).toBe(600);

    // 已成功内容保留；截止后到达的 landmarks 未落库，后续模块未开始。
    const modules = archiveRepo.listModules(CITY_ID);
    expect(modules.map((m) => m.name).sort()).toEqual(['chronicle', 'identity', 'landmarks']);
    const byName = new Map(modules.map((m) => [m.name, m]));
    expect(byName.get('identity')?.status).toBe('ok');
    expect(byName.get('chronicle')?.status).toBe('ok');
    expect(byName.get('landmarks')?.status).toBe('failed');
    expect(byName.get('landmarks')?.data).toBeNull();
    // 未达发布门槛 → 任务失败并冷却。
    const job = jobRepo.listRecent(1)[0]!;
    expect(job.status).toBe('failed');
    expect(jobRepo.findActiveCooldown(CITY_ID, new Date().toISOString())).not.toBeNull();
  });

  it('已有可用档案时到达总截止：档案不下架、无冷却、notice 明确提示', async () => {
    const clock = { now: new Date('2026-11-14T10:00:00.000Z') };
    const seed = setup({ generator: new FixedGenerator() });
    await waitDone(
      seed.manager.start({
        city: seed.city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      seed.manager,
    );
    const manager = new JobManager({
      archiveRepo: seed.archiveRepo,
      jobRepo: seed.jobRepo,
      cityRepo: seed.cityRepo,
      generator: new ClockAdvancingGenerator(new FixedGenerator(), 30_000, clock),
      budget: { consume: () => true },
      now: () => clock.now,
      deadlineMs: 60_000,
    });
    const events = await collectStream(
      manager.start({
        city: seed.city,
        aliases: [],
        requesterHash: 'hash',
        force: true,
        modules: [...MODULE_NAMES],
      }).runtime,
      manager,
    );
    const done = events.at(-1)!;
    expect(done.data.status).toBe('complete');
    expect(events.find((e) => e.event === 'error')).toBeUndefined();
    const notice = events.find((e) => e.event === 'notice');
    expect(notice?.data.code).toBe('GENERATION_DEADLINE');
    expect(seed.archiveRepo.getArchive(CITY_ID)?.status).toBe('complete');
    expect(seed.jobRepo.findActiveCooldown(CITY_ID, new Date().toISOString())).toBeNull();
  });

  it('迟到结果不得落库：生成完成后超过截止的结果被丢弃', async () => {
    const clock = { now: new Date('2026-11-14T10:00:00.000Z') };
    const late = new (class implements ModuleGenerator {
      readonly name = 'late';
      readonly promptVersion = 'late-v1';
      async generate(input: GenerateInput): Promise<GeneratedModule> {
        if (input.module === 'landmarks') {
          // 模拟上游在截止后才返回。
          clock.now = new Date(clock.now.getTime() + 120_000);
        }
        return {
          status: 'ok',
          verification: 'verified_by_source',
          sources: [TEST_SOURCE],
          data: fixedModuleData(input.module),
        };
      }
    })();
    const { manager, archiveRepo, city } = setup({
      generator: late,
      now: () => clock.now,
      deadlineMs: 60_000,
    });
    const events = await collectStream(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: [...MODULE_NAMES],
      }).runtime,
      manager,
    );
    const error = events.find(
      (e) => e.event === 'module_error' && e.data.name === 'landmarks',
    );
    expect(error?.data.code).toBe('LLM_TIMEOUT');
    const landmarks = archiveRepo.listModules(CITY_ID).find((m) => m.name === 'landmarks');
    expect(landmarks?.status).not.toBe('ok');
    expect(events.at(-1)!.data.status).toBe('unpublished');
  });

  it('总截止到达时取消进行中的上游请求', async () => {
    const hanging = new (class implements ModuleGenerator {
      readonly name = 'hanging';
      readonly promptVersion = 'hanging-v1';
      aborted = false;
      async generate(input: GenerateInput): Promise<GeneratedModule> {
        return new Promise<GeneratedModule>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => {
              this.aborted = true;
              reject(new GenerationError('LLM_TIMEOUT', '大模型响应超时'));
            },
            { once: true },
          );
        });
      }
    })();
    const { manager, archiveRepo, city } = setup({
      generator: hanging,
      deadlineMs: 40,
    });
    const events = await collectStream(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: ['identity'],
      }).runtime,
      manager,
    );
    expect(hanging.aborted).toBe(true);
    expect(events.find((e) => e.event === 'module_error')?.data.code).toBe('LLM_TIMEOUT');
    expect(events.at(-1)!.data.status).toBe('unpublished');
    expect(archiveRepo.listModules(CITY_ID).every((m) => m.status === 'failed')).toBe(true);
  });

  it('活跃任务不会因其他城市开始生成而被误判为崩溃遗留', async () => {
    const clock = { now: new Date('2026-11-14T10:00:00.000Z') };
    const hanging = new (class implements ModuleGenerator {
      readonly name = 'hanging-2';
      readonly promptVersion = 'hanging-v2';
      async generate(input: GenerateInput): Promise<GeneratedModule> {
        return new Promise<GeneratedModule>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(new GenerationError('LLM_TIMEOUT', '已取消')),
            { once: true },
          );
        });
      }
    })();
    const { manager, jobRepo, city, otherCity } = setup({
      generator: hanging,
      now: () => clock.now,
      deadlineMs: 180_000,
    });
    const runtime = manager.start({
      city,
      aliases: [],
      requesterHash: 'hash',
      force: false,
      modules: ['identity'],
    }).runtime;

    // 推进 150s：仍在 180s 总截止内，属活跃任务。
    clock.now = new Date(clock.now.getTime() + 150_000);
    manager.start({
      city: otherCity,
      aliases: [],
      requesterHash: 'hash-b',
      force: false,
      modules: ['identity'],
    });
    expect(jobRepo.get(runtime.jobId)?.status).toBe('running');
    expect(jobRepo.getRunning(CITY_ID)).not.toBeNull();
  });

  it('超过 stale 期的遗留 running 任务仍会被判失败（崩溃恢复语义保留）', () => {
    const clock = { now: new Date('2026-11-14T10:00:00.000Z') };
    const { manager, jobRepo, otherCity } = setup({ now: () => clock.now });
    const leftover = jobRepo.create({
      jobId: 'stale-leftover',
      cityId: CITY_ID,
      force: false,
      modules: ['identity'],
      requesterHash: 'hash-old',
      startedAt: new Date(clock.now.getTime() - 400_000).toISOString(),
    });
    expect(leftover).not.toBeNull();
    manager.start({
      city: otherCity,
      aliases: [],
      requesterHash: 'hash-new',
      force: false,
      modules: ['identity'],
    });
    expect(jobRepo.get('stale-leftover')?.status).toBe('failed');
    expect(jobRepo.get('stale-leftover')?.cooldownUntil).not.toBeNull();
  });

  it('上游永不返回且忽略取消时，编排层按时结束并发送唯一终止结果', async () => {
    // 复现：deadlineMs=30，上游既不 resolve 也不响应 abort。
    const hanging = new (class implements ModuleGenerator {
      readonly name = 'hanging-forever';
      readonly promptVersion = 'hanging-v1';
      async generate(): Promise<GeneratedModule> {
        return new Promise<GeneratedModule>(() => undefined); // 永不 settle
      }
    })();
    const { manager, jobRepo, archiveRepo, city } = setup({
      generator: hanging,
      deadlineMs: 30,
    });
    const events = await collectStream(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: ['identity'],
      }).runtime,
      manager,
    );
    // 必须收到唯一终止结果（旧实现会一直挂起，没有 done）。
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.status).toBe('unpublished');
    expect(events.filter((event) => event.event === 'done')).toHaveLength(1);
    // 任务状态正确收尾，不残留 running。
    const job = jobRepo.listRecent(1)[0]!;
    expect(job.status).toBe('failed');
    expect(jobRepo.getRunning(CITY_ID)).toBeNull();
    // 没有任何内容被这个挂起的模块污染。
    expect(archiveRepo.listModules(CITY_ID).every((m) => m.status === 'failed')).toBe(true);
  });

  it('上游忽略取消但迟到返回：迟到结果不落库，任务已收尾', async () => {
    const late = new (class implements ModuleGenerator {
      readonly name = 'late-ignoring-abort';
      readonly promptVersion = 'late-v1';
      async generate(input: GenerateInput): Promise<GeneratedModule> {
        void input.signal; // 明确忽略取消
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          status: 'ok',
          verification: 'verified_by_source',
          sources: [TEST_SOURCE],
          data: fixedModuleData(input.module),
        };
      }
    })();
    const { manager, archiveRepo, city } = setup({ generator: late, deadlineMs: 30 });
    const events = await collectStream(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: ['identity'],
      }).runtime,
      manager,
    );
    expect(events.at(-1)!.event).toBe('done');
    // 截止之后才返回的内容不得成为可用内容。
    const identity = archiveRepo.listModules(CITY_ID).find((m) => m.name === 'identity');
    expect(identity?.status).not.toBe('ok');
    expect(identity?.data).toBeNull();
  });

  it('预先到达截止时不开始任何模块，直接收尾', async () => {
    const clock = { now: new Date('2026-11-14T10:00:00.000Z') };
    const { manager, counting, city } = setup({
      generator: new FixedGenerator(),
      now: () => clock.now,
      deadlineMs: 0,
    });
    const events = await collectStream(
      manager.start({
        city,
        aliases: [],
        requesterHash: 'hash',
        force: false,
        modules: ['identity'],
      }).runtime,
      manager,
    );
    expect(events.at(-1)!.data.status).toBe('unpublished');
    expect(counting.calls).toEqual([]);
  });
});
