import { afterEach, describe, expect, it } from 'vitest';
import type { ModuleName } from '../../shared/schema';
import { buildApp } from '../index';
import { openDb, type Db } from '../db';
import { ArchiveRepo } from '../db/archiveRepo';

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
});

function seedCity(db: Db, cityId: string, name: string, province: string): void {
  db.prepare(
    `INSERT INTO cities
       (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat, hot_rank)
     VALUES (?, ?, ?, 'prefecture', 'pinyin', 'English', 108.9, 34.3, ?)`,
  ).run(cityId, name, province, cityId === 'CN-610100' ? 1 : null);
}

function seedArchive(db: Db, cityId: string, name: string): void {
  const repo = new ArchiveRepo(db);
  repo.ensureArchive({
    cityId,
    status: 'unpublished',
    themePalette: {
      light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
      dark: { primary: '#D98A6E', secondary: '#A8ADB4', accent: '#E0B860' },
    },
    sources: [],
    isPreset: cityId === 'CN-610100',
    generator: null,
    generatedAt: '2026-11-11T00:00:00.000Z',
  });
  const modules: Array<[ModuleName, unknown]> = [
    [
      'identity',
      {
        standardName: name,
        aliases: [name],
        center: [108.9422, 34.2611],
        area: { value: 10107, unit: 'km²', statYear: 2024, sourceRefs: ['S-1'] },
        population: { value: 1323.63, unit: '万人', statYear: 2025, sourceRefs: ['S-1'] },
        climateType: { value: '温带季风气候', sourceRefs: ['S-1'] },
        adminDivisions: { value: '11 区 2 县', sourceRefs: ['S-1'] },
        oneLinePersona: '十三朝古都，半部中国史的立体切片。',
        sourceRefs: ['S-1'],
        verification: 'pending_human_review',
      },
    ],
    [
      'dataPulse',
      {
        gdpSeries: [
          { year: 2024, value: 13317.78 },
          { year: 2025, value: 13902.67 },
        ],
        popSeries: [{ year: 2025, value: 1323.63 }],
        statMeta: {
          gdp: { unit: '亿元', caliber: '地区生产总值（现价）', sourceRefs: ['S-1'] },
          pop: { unit: '万人', caliber: '年末常住人口', sourceRefs: ['S-1'] },
        },
        climateMonthly: [],
        climateMeta: { period: '1991–2020', station: 'ERA5', sourceRefs: [] },
      },
    ],
    [
      'landmarks',
      [
        {
          entityRef: 'Q-1',
          name: '大雁塔',
          category: 'must_visit',
          bestSeason: '春秋',
          reason: '唐代砖塔，丝绸之路东段的标志遗存。',
          placeName: '大雁塔',
          coordinates: [108.9592, 34.2186],
          coordSource: 'local_gazetteer',
          sourceRefs: ['S-1'],
          verification: 'pending_human_review',
        },
      ],
    ],
    [
      'poetics',
      [
        {
          poemId: 'tang-1',
          title: '登科后',
          author: '孟郊',
          dynasty: '唐',
          lines: ['春风得意马蹄疾', '一日看尽长安花'],
          background: '待考',
          relationType: 'direct',
          imageryMap: [],
          sourceRefs: ['S-1'],
          verification: 'verified_by_source',
        },
      ],
    ],
  ];
  for (const [name, data] of modules) {
    repo.saveModule({
      cityId,
      name,
      status: name === 'poetics' ? 'ok' : 'degraded',
      data,
      verification: { status: 'pending_human_review' },
      generatedAt: '2026-11-11T00:00:00.000Z',
    });
  }
  repo.setMeta(cityId, {
    themePalette: {
      light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
      dark: { primary: '#D98A6E', secondary: '#A8ADB4', accent: '#E0B860' },
    },
    sources: [],
    generator: null,
    generatedAt: '2026-11-11T00:00:00.000Z',
  });
  repo.updateStatus(cityId, 'partial', '2026-11-11T00:00:00.000Z');
}

function setup() {
  const db = openDb(':memory:');
  seedCity(db, 'CN-610100', '西安', '陕西省');
  seedCity(db, 'CN-330100', '杭州', '浙江省');
  seedCity(db, 'CN-320300', '徐州', '江苏省');
  seedArchive(db, 'CN-610100', '西安');
  seedArchive(db, 'CN-330100', '杭州');
  const app = buildApp({ db });
  apps.push(app);
  return { db, app };
}

describe('GET /api/compare', () => {
  it('双城对比返回两城快照，GDP 取最新非空年份', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/compare?cities=CN-610100,CN-330100',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      cities: Array<{
        cityId: string;
        gdp: { value: unknown; statYear?: number; unit?: string };
        population: { value: unknown };
        climateType: { value: unknown };
        poemCount: number;
        landmarks: Array<{ name: string }>;
      }>;
    };
    expect(body.cities).toHaveLength(2);
    const xian = body.cities[0]!;
    expect(xian.cityId).toBe('CN-610100');
    expect(xian.gdp).toMatchObject({ value: 13902.67, statYear: 2025, unit: '亿元' });
    expect(xian.population.value).toBe(1323.63);
    expect(xian.climateType.value).toBe('温带季风气候');
    expect(xian.poemCount).toBe(1);
    expect(xian.landmarks[0]!.name).toBe('大雁塔');
  });

  it('任一城市未生成返回 404', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/compare?cities=CN-610100,CN-320300',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('NOT_GENERATED');
  });

  it('城市不存在返回 404', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/compare?cities=CN-610100,CN-999999',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('CITY_NOT_FOUND');
  });

  it('参数非法（数量 / 格式 / 同城）返回 400', async () => {
    const { app } = setup();
    const single = await app.inject({ method: 'GET', url: '/api/compare?cities=CN-610100' });
    expect(single.statusCode).toBe(400);
    const badFormat = await app.inject({
      method: 'GET',
      url: '/api/compare?cities=CN-610100,xian',
    });
    expect(badFormat.statusCode).toBe(400);
    const same = await app.inject({
      method: 'GET',
      url: '/api/compare?cities=CN-610100,CN-610100',
    });
    expect(same.statusCode).toBe(400);
  });
});
