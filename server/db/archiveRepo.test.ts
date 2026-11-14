import { describe, expect, it } from 'vitest';
import { openDb } from './index';
import { ArchiveRepo } from './archiveRepo';

const PALETTE = {
  light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
  dark: { primary: '#D2957F', secondary: '#A8ADB4', accent: '#E0B860' },
};

function seed(db: ReturnType<typeof openDb>, cityId: string, status: 'unpublished' | 'partial', isPreset: number): void {
  db.prepare(
    `INSERT INTO cities
       (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat, hot_rank)
     VALUES (?, ?, '测试省', 'prefecture', 'pinyin', 'English', 108.9, 34.3, ?)`,
  ).run(cityId, cityId, null);
  const repo = new ArchiveRepo(db);
  repo.ensureArchive({
    cityId,
    status: 'unpublished',
    themePalette: PALETTE,
    sources: [],
    isPreset: isPreset === 1,
    generator: null,
    generatedAt: '2026-11-11T00:00:00.000Z',
  });
  repo.saveModule({
    cityId,
    name: 'identity',
    status: 'failed',
    data: null,
    verification: { status: 'failed' },
    generatedAt: '2026-11-11T00:00:00.000Z',
  });
  if (status === 'partial') repo.updateStatus(cityId, 'partial');
}

describe('ArchiveRepo.deleteUnpublished', () => {
  it('只删除非预置的未发布档案及其模块', () => {
    const db = openDb(':memory:');
    seed(db, 'CN-900001', 'unpublished', 0);
    seed(db, 'CN-900002', 'unpublished', 1); // 预置未发布：不动
    seed(db, 'CN-900003', 'partial', 0); // 已发布：不动

    const repo = new ArchiveRepo(db);
    const removed = repo.deleteUnpublished();

    expect(removed).toEqual(['CN-900001']);
    expect(repo.countArchives()).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM city_modules WHERE city_id = ?').get('CN-900001')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM city_modules WHERE city_id = ?').get('CN-900002')).toEqual({ n: 1 });
  });

  it('没有未发布档案时返回空数组', () => {
    const db = openDb(':memory:');
    seed(db, 'CN-900004', 'partial', 0);
    expect(new ArchiveRepo(db).deleteUnpublished()).toEqual([]);
  });
});

describe('ArchiveRepo.markModuleFailed（P0：可用内容与最近尝试分离）', () => {
  function seedWithContent(db: ReturnType<typeof openDb>, cityId: string): ArchiveRepo {
    db.prepare(
      `INSERT INTO cities
         (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat, hot_rank)
       VALUES (?, ?, '测试省', 'prefecture', 'pinyin', 'English', 108.9, 34.3, ?)`,
    ).run(cityId, cityId, null);
    const repo = new ArchiveRepo(db);
    repo.ensureArchive({
      cityId,
      status: 'partial',
      themePalette: PALETTE,
      sources: [],
      isPreset: false,
      generator: null,
      generatedAt: '2026-11-11T00:00:00.000Z',
    });
    repo.saveModule({
      cityId,
      name: 'identity',
      status: 'ok',
      data: { standardName: cityId, oneLinePersona: '旧内容' },
      verification: { status: 'verified_by_source' },
      generatedAt: '2026-11-11T00:00:00.000Z',
    });
    return repo;
  }

  it('已有合格旧内容时失败：保留 ok 状态与数据，只记录 lastAttempt', () => {
    const db = openDb(':memory:');
    const repo = seedWithContent(db, 'CN-900010');
    repo.markModuleFailed(
      'CN-900010',
      'identity',
      { status: 'failed', code: 'LLM_TIMEOUT', message: '模拟失败' },
      '2026-11-12T00:00:00.000Z',
    );
    const module = repo.listModules('CN-900010').find((m) => m.name === 'identity');
    expect(module?.status).toBe('ok');
    expect(module?.data).toEqual({ standardName: 'CN-900010', oneLinePersona: '旧内容' });
    expect(module?.verification).toMatchObject({
      status: 'verified_by_source',
      lastAttempt: {
        status: 'failed',
        code: 'LLM_TIMEOUT',
        at: '2026-11-12T00:00:00.000Z',
      },
    });
    // 档案状态不受影响。
    expect(repo.getArchive('CN-900010')?.status).toBe('partial');
  });

  it('没有旧内容时失败：按原门槛置 failed', () => {
    const db = openDb(':memory:');
    const repo = seedWithContent(db, 'CN-900011');
    repo.markModuleFailed(
      'CN-900011',
      'landmarks',
      { status: 'failed', code: 'NO_FACTS', message: '无数据' },
      '2026-11-12T00:00:00.000Z',
    );
    const module = repo.listModules('CN-900011').find((m) => m.name === 'landmarks');
    expect(module?.status).toBe('failed');
    expect(module?.data).toBeNull();
  });

  it('保存成功会清除 lastAttempt（内容、校验记录一致）', () => {
    const db = openDb(':memory:');
    const repo = seedWithContent(db, 'CN-900012');
    repo.markModuleFailed(
      'CN-900012',
      'identity',
      { status: 'failed', code: 'LLM_TIMEOUT', message: '模拟失败' },
      '2026-11-12T00:00:00.000Z',
    );
    repo.saveModule({
      cityId: 'CN-900012',
      name: 'identity',
      status: 'degraded',
      data: { standardName: 'CN-900012', oneLinePersona: '新内容' },
      verification: { status: 'pending_human_review' },
      generatedAt: '2026-11-13T00:00:00.000Z',
    });
    const module = repo.listModules('CN-900012').find((m) => m.name === 'identity');
    expect(module?.status).toBe('degraded');
    expect(module?.data).toEqual({ standardName: 'CN-900012', oneLinePersona: '新内容' });
    expect(module?.verification).toEqual({ status: 'pending_human_review' });
  });
});

describe('ArchiveRepo.saveModule 来源登记（P0：生成途中不出现缺少来源的内容）', () => {
  it('模块来源在同一事务内合并进档案 sources_json', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO cities
         (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat, hot_rank)
       VALUES ('CN-900013', 'CN-900013', '测试省', 'prefecture', 'pinyin', 'English', 108.9, 34.3, ?)`,
    ).run(null);
    const repo = new ArchiveRepo(db);
    repo.ensureArchive({
      cityId: 'CN-900013',
      status: 'partial',
      themePalette: PALETTE,
      sources: [
        { id: 'S-OLD', type: 'wikidata', title: '旧来源', retrievedAt: '2026-11-11T00:00:00.000Z' },
      ],
      isPreset: false,
      generator: null,
      generatedAt: '2026-11-11T00:00:00.000Z',
    });
    repo.saveModule({
      cityId: 'CN-900013',
      name: 'landmarks',
      status: 'ok',
      data: [{ name: '测试景点', sourceRefs: ['S-NEW'] }],
      verification: { status: 'verified_by_source' },
      generatedAt: '2026-11-12T00:00:00.000Z',
      sources: [
        { id: 'S-NEW', type: 'local_snapshot', title: '新来源', retrievedAt: '2026-11-12T00:00:00.000Z' },
      ],
    });
    const archive = repo.getArchive('CN-900013');
    expect(archive?.sources.map((s) => s.id).sort()).toEqual(['S-NEW', 'S-OLD']);
    expect(archive?.dataVersion).toBeGreaterThan(1);
    // 不传 sources 时只递增版本，不动来源登记。
    repo.saveModule({
      cityId: 'CN-900013',
      name: 'relics',
      status: 'ok',
      data: [{ name: '测试文物' }],
      verification: { status: 'verified_by_source' },
      generatedAt: '2026-11-13T00:00:00.000Z',
    });
    expect(repo.getArchive('CN-900013')?.sources.map((s) => s.id).sort()).toEqual([
      'S-NEW',
      'S-OLD',
    ]);
  });
});
