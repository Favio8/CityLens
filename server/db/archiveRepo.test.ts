import { describe, expect, it } from 'vitest';
import { openDb } from './index';
import { ArchiveRepo } from './archiveRepo';

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
    themePalette: {
      light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
      dark: { primary: '#D2957F', secondary: '#A8ADB4', accent: '#E0B860' },
    },
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
