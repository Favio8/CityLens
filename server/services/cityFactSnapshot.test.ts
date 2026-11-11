import { describe, expect, it } from 'vitest';
import type { FactSnapshot } from './presetData';
import {
  loadCitySnapshot,
  resetCityFactSnapshotCache,
  snapshotToRegistry,
} from './cityFactSnapshot';

const snapshot: FactSnapshot = {
  cityId: 'CN-000000',
  cityName: '测试城',
  cityQid: 'Q1',
  center: [120, 30],
  retrievedAt: '2026-11-10T00:00:00.000Z',
  sourceRef: {
    id: 'S-WD-CN-000000',
    type: 'wikidata',
    title: 'Wikidata 事实快照 · 测试城',
    retrievedAt: '2026-11-10T00:00:00.000Z',
  },
  landmarks: [],
  relics: [
    {
      entityId: 'Q2',
      name: '测试塔',
      coordinates: [120.1, 30.1],
      inceptionYear: 618,
      museumOrSite: null,
      location: '测试区',
      designations: ['全国重点文物保护单位'],
      description: '测试文物',
      sitelinks: 12,
    },
  ],
  figures: [],
  failures: [],
};

describe('按需事实快照', () => {
  it('把快照文物映射为名录条目，保留来源与待考字段', () => {
    const [relic] = snapshotToRegistry(snapshot);
    expect(relic).toMatchObject({
      registryId: 'CN-000000:Q2',
      cityId: 'CN-000000',
      cityName: '测试城',
      name: '测试塔',
      era: '618年',
      museumOrSite: '测试区',
      protectionLevel: '全国重点文物保护单位',
      findSpot: '待考',
      coordinates: [120.1, 30.1],
      sourceRefs: ['S-WD-CN-000000'],
    });
  });

  it('已有本地快照时直接返回，不触发联网', async () => {
    resetCityFactSnapshotCache();
    const existing = await loadCitySnapshot({
      cityId: 'CN-610100',
      standardName: '西安',
      province: '陕西省',
      adminLevel: 'prefecture',
      pinyin: "xi'an",
      englishName: "Xi'an",
      center: [108.94, 34.34],
      summary: null,
      hotRank: 1,
      isPreset: true,
    });
    expect(existing?.cityId).toBe('CN-610100');
    expect(existing?.landmarks.length).toBeGreaterThan(0);
  });

  it('词典中没有 Wikidata QID 的城市直接返回 null', async () => {
    resetCityFactSnapshotCache();
    const missing = await loadCitySnapshot({
      cityId: 'CN-999999',
      standardName: '不存在城',
      province: '测试省',
      adminLevel: 'prefecture',
      pinyin: 'bucunzai',
      englishName: 'Missing',
      center: [0, 0],
      summary: null,
      hotRank: null,
      isPreset: false,
    });
    expect(missing).toBeNull();
  });
});
