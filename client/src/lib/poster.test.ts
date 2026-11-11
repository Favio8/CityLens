// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PENDING, type CityArchiveResponse } from '@citylens/shared/schema';
import { buildPosterSpec, posterFileName } from './poster';

function archive(overrides: Partial<CityArchiveResponse> = {}): CityArchiveResponse {
  return {
    fromCache: true,
    meta: {
      cityId: 'CN-610100',
      standardName: '西安',
      province: '陕西省',
      aliases: ['长安', '镐京', '大兴', '京兆'],
      center: [108.9422, 34.2611],
      schemaVersion: '1.1',
      dataVersion: 3,
      generatedAt: '2026-11-11T08:30:00.000Z',
      status: 'partial',
      moduleStatus: {
        identity: 'degraded',
        chronicle: 'degraded',
        landmarks: 'degraded',
        relics: 'degraded',
        figures: 'degraded',
        poetics: 'ok',
        localSoul: 'degraded',
        dataPulse: 'degraded',
      },
      generator: null,
      isPreset: true,
      themePalette: {
        light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
        dark: { primary: '#D2957F', secondary: '#A8ADB4', accent: '#D9B45C' },
      },
    },
    identity: {
      standardName: '西安',
      aliases: ['长安', '镐京'],
      center: [108.9422, 34.2611],
      area: { value: 10107, unit: 'km²', statYear: 2024, sourceRefs: ['S-1'] },
      population: { value: 1323.63, unit: '万人', statYear: 2025, sourceRefs: ['S-1'] },
      climateType: { value: '温带季风气候', sourceRefs: ['S-1'] },
      adminDivisions: { value: '11 区 2 县', sourceRefs: ['S-1'] },
      oneLinePersona: '十三朝古都，半部中国史的立体切片。',
      sourceRefs: ['S-1'],
      verification: 'pending_human_review',
    },
    chronicle: null,
    landmarks: [
      {
        entityRef: 'Q-1',
        name: '大雁塔',
        category: 'must_visit',
        bestSeason: '春秋',
        reason: '唐代砖塔。',
        placeName: '大雁塔',
        coordinates: [108.9592, 34.2186],
        coordSource: 'local_gazetteer',
        sourceRefs: ['S-1'],
        verification: 'pending_human_review',
      },
      {
        entityRef: 'Q-2',
        name: '兵马俑',
        category: 'must_visit',
        bestSeason: '四季',
        reason: '秦陵陪葬坑。',
        placeName: '秦始皇陵',
        coordinates: [109.2739, 34.3848],
        coordSource: 'local_gazetteer',
        sourceRefs: ['S-1'],
        verification: 'pending_human_review',
      },
      {
        entityRef: 'Q-3',
        name: '城墙',
        category: 'hidden_gem',
        bestSeason: '四季',
        reason: '明城墙。',
        placeName: '西安城墙',
        coordinates: [108.94, 34.25],
        coordSource: 'local_gazetteer',
        sourceRefs: ['S-1'],
        verification: 'pending_human_review',
      },
      {
        entityRef: 'Q-4',
        name: '小雁塔',
        category: 'hidden_gem',
        bestSeason: '四季',
        reason: '唐密檐砖塔。',
        placeName: '小雁塔',
        coordinates: [108.94, 34.24],
        coordSource: 'local_gazetteer',
        sourceRefs: ['S-1'],
        verification: 'pending_human_review',
      },
    ],
    relics: [
      {
        registryId: 'R-1',
        name: '镶金兽首玛瑙杯',
        era: '唐',
        museumOrSite: '陕西历史博物馆',
        protectionLevel: '禁止出境展览文物',
        findSpot: '何家村',
        story: '唐代玉器巅峰。',
        coordinates: null,
        sourceRefs: ['S-1'],
        verification: 'pending_human_review',
      },
    ],
    figures: [
      {
        entityRef: 'Q-9',
        name: '白居易',
        dynasty: '唐',
        birthYear: 772,
        deathYear: 846,
        relationType: 'sojourner',
        evidence: { property: 'workplace', value: '长安' },
        cityBond: '白居易曾居长安，咏叹下邽。',
        highlights: '唐代诗人。',
        sites: [],
        sourceRefs: ['S-1'],
        verification: 'pending_human_review',
      },
    ],
    poetics: [
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
    localSoul: null,
    dataPulse: {
      gdpSeries: [
        { year: 2024, value: 13317.78 },
        { year: 2025, value: 13902.67 },
      ],
      popSeries: [
        { year: 2024, value: null },
        { year: 2025, value: 1323.63 },
      ],
      statMeta: {
        gdp: { unit: '亿元', caliber: '地区生产总值（现价）', sourceRefs: ['S-1'] },
        pop: { unit: '万人', caliber: '年末常住人口', sourceRefs: ['S-1'] },
      },
      climateMonthly: [],
      climateMeta: { period: '1991–2020', station: 'ERA5', sourceRefs: [] },
    },
    sources: [
      { id: 'S-1', type: 'gov_stat', title: '西安市 2025 年统计公报', retrievedAt: '2026-11-11T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

describe('buildPosterSpec', () => {
  it('提取城名、人设、代表条目与最新统计年份', () => {
    const spec = buildPosterSpec(archive());
    expect(spec.cityName).toBe('西安');
    expect(spec.persona).toContain('十三朝古都');
    expect(spec.landmarks).toEqual(['大雁塔', '兵马俑', '城墙']);
    expect(spec.relics).toEqual(['镶金兽首玛瑙杯（唐）']);
    expect(spec.figures).toEqual(['白居易']);
    expect(spec.poems[0]).toMatchObject({ title: '登科后', author: '孟郊', dynasty: '唐' });
    const gdp = spec.stats.find((stat) => stat.label.includes('地区生产总值'));
    expect(gdp?.value).toBe('13,902.67 亿元');
    expect(gdp?.label).toContain('2025');
    const pop = spec.stats.find((stat) => stat.label.includes('常住人口'));
    expect(pop?.value).toBe('1,323.63 万人');
    expect(spec.sourceCount).toBe(1);
    expect(spec.isPreset).toBe(true);
    expect(spec.theme.primary).toBe('#8C3F2B');
  });

  it('模块缺失时对应条目为空，统计为「待考」', () => {
    const spec = buildPosterSpec(
      archive({
        identity: null,
        dataPulse: null,
        landmarks: null,
        relics: null,
        figures: null,
        poetics: null,
      }),
    );
    expect(spec.persona).toBe(PENDING);
    expect(spec.landmarks).toEqual([]);
    expect(spec.relics).toEqual([]);
    expect(spec.figures).toEqual([]);
    expect(spec.poems).toEqual([]);
    expect(spec.stats).toEqual([]);
    expect(spec.disclaimer).toContain('AI');
  });

  it('GDP 序列全空时该行显示「待考」', () => {
    const base = archive();
    const spec = buildPosterSpec({
      ...base,
      dataPulse: { ...base.dataPulse!, gdpSeries: [{ year: 2025, value: null }] },
    });
    const gdp = spec.stats.find((stat) => stat.label.includes('地区生产总值'));
    expect(gdp?.value).toBe(PENDING);
  });

  it('文件名包含城名与生成日期', () => {
    expect(posterFileName(buildPosterSpec(archive()))).toBe('读城-西安-2026-11-11.png');
  });
});
