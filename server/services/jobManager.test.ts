import { beforeEach, describe, expect, it } from 'vitest';
import { MODULE_NAMES, type ModuleName } from '../../shared/schema';
import { openDb } from '../db';
import { ArchiveRepo } from '../db/archiveRepo';
import { CityRepo } from '../db/cityRepo';
import { JobRepo } from '../db/jobRepo';
import { JobManager, collectSourceRefs, type JobRuntime } from './jobManager';
import type { GenerateInput, GeneratedModule, ModuleGenerator } from './llmGenerator';
import { MockGenerator } from './llmGenerator';

const CITY_ID = 'CN-610100';

function setup(failModules: string[] = ['chronicle', 'localSoul', 'dataPulse']) {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO cities
       (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat)
     VALUES (?, '西安', '陕西省', 'prefecture', 'xian', ?, 108.9422, 34.2611)`,
  ).run(CITY_ID, "Xi'an");
  db.prepare(
    `INSERT INTO city_aliases (alias_key, display_alias, city_id, match_type)
     VALUES ('长安', '长安', ?, 'ancient')`,
  ).run(CITY_ID);

  const archiveRepo = new ArchiveRepo(db);
  const jobRepo = new JobRepo(db);
  const cityRepo = new CityRepo(db);
  const counting = new CountingGenerator(new MockGenerator({ delayMs: 2, failModules }));
  const manager = new JobManager({ archiveRepo, jobRepo, cityRepo, generator: counting });
  const city = cityRepo.getCity(CITY_ID);
  if (!city) throw new Error('测试城市不存在');
  return { db, archiveRepo, jobRepo, cityRepo, manager, counting, city };
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
    const { manager, archiveRepo, jobRepo, city } = setup(['landmarks', 'identity']);
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
