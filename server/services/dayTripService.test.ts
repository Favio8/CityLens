import { describe, expect, it } from 'vitest';
import type { ModuleName } from '../../shared/schema';
import { DEFAULT_THEME_PALETTE } from '../../shared/cityThemes';
import type { ArchiveBundle } from './cacheService';
import type { ArchiveRecord, ModuleRecord } from '../db/archiveRepo';
import type { CityBrief } from '../db/cityRepo';
import type { FactSnapshot } from './presetData';
import { buildDayTrip } from './dayTripService';

const city = {
  cityId: 'CN-320300',
  standardName: '徐州',
  province: '江苏省',
  center: [117.18587, 34.26104],
  isPreset: false,
} as unknown as CityBrief;

function bundleWith(modules: Partial<Record<ModuleName, unknown>>): ArchiveBundle {
  const archive: ArchiveRecord = {
    cityId: city.cityId,
    status: 'partial',
    themePalette: DEFAULT_THEME_PALETTE,
    sources: [],
    schemaVersion: '1.1',
    dataVersion: 1,
    isPreset: false,
    generator: null,
    generatedAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  };
  const map = new Map<ModuleName, ModuleRecord>();
  for (const [name, data] of Object.entries(modules)) {
    map.set(name as ModuleName, {
      name: name as ModuleName,
      status: 'ok',
      data,
      verification: {},
      generatedAt: archive.generatedAt,
    });
  }
  return { archive, modules: map };
}

const landmark = (
  name: string,
  lng: number,
  category: 'must_visit' | 'hidden_gem' = 'must_visit',
) => ({
  entityRef: `Q-${name}`,
  name,
  category,
  bestSeason: '春秋',
  reason: '推荐理由足够长度以满足 Schema 校验要求。',
  placeName: name,
  coordinates: [lng, 34.3] as [number, number],
  coordSource: 'local_gazetteer' as const,
  sourceRefs: ['S-TEST'],
  verification: 'pending_human_review' as const,
});

describe('dayTripService', () => {
  it('6 个有坐标点位按距离分上午/下午/晚上各 2 个', () => {
    const bundle = bundleWith({
      landmarks: [
        landmark('近点', 117.19),
        landmark('中点', 117.28),
        landmark('远点', 117.38),
        landmark('更远', 117.48),
        landmark('最远', 117.58),
        landmark('偏远', 117.68),
      ],
    });
    const trip = buildDayTrip(city, bundle);
    expect(trip.stops).toHaveLength(6);
    expect(trip.degraded).toBe(false);
    const slots = trip.stops.map((stop) => stop.slot);
    expect(slots.filter((slot) => slot === 'morning')).toHaveLength(2);
    expect(slots.filter((slot) => slot === 'afternoon')).toHaveLength(2);
    expect(slots.filter((slot) => slot === 'evening')).toHaveLength(2);
    // 上午是距离最近的两个
    expect(trip.stops[0]!.name).toBe('近点');
    expect(trip.notice).toContain('示意路线');
    expect(trip.notice).toContain('非导航');
  });

  it('景点与文物同名去重；无坐标条目跳过', () => {
    const bundle = bundleWith({
      landmarks: [
        landmark('重复点', 117.2),
        landmark('无坐标', 0, 'hidden_gem'),
      ],
      relics: [
        {
          registryId: 'R-重复点',
          name: '重复点',
          era: '汉',
          museumOrSite: '徐州博物馆',
          protectionLevel: '国保',
          findSpot: '待考',
          story: '文物故事长度满足 Schema 校验要求的说明文字。',
          coordinates: [117.2, 34.3],
          sourceRefs: ['S-TEST'],
          verification: 'pending_human_review',
        },
      ],
    });
    const landmarks = (bundle.modules.get('landmarks')!.data as Array<Record<string, unknown>>);
    landmarks[1]!.coordinates = null;
    const trip = buildDayTrip(city, bundle);
    expect(trip.stops.map((stop) => stop.name)).toEqual(['重复点']);
    expect(trip.degraded).toBe(true);
  });

  it('没有任何坐标时返回空路线并标 degraded', () => {
    const bundle = bundleWith({
      landmarks: [{ ...landmark('无坐标', 117.2), coordinates: null }],
    });
    const trip = buildDayTrip(city, bundle);
    expect(trip.stops).toHaveLength(0);
    expect(trip.degraded).toBe(true);
  });

  it('无档案时用 Wikidata 快照排路线，坐标来源标 wikidata 且注明快照', () => {
    const snapshot: FactSnapshot = {
      cityId: city.cityId,
      cityName: city.standardName,
      cityQid: 'Q12345',
      center: city.center as [number, number],
      retrievedAt: '2026-11-11T00:00:00.000Z',
      sourceRef: {
        id: 'S-WD-CN-320300',
        type: 'wikidata',
        title: 'Wikidata 事实快照 · 徐州',
        url: 'https://query.wikidata.org/sparql',
        retrievedAt: '2026-11-11T00:00:00.000Z',
      },
      landmarks: [
        {
          entityId: 'Q1',
          name: '快照近点',
          coordinates: [117.2, 34.3],
          kind: '博物馆',
          heritageDesignations: [],
          description: null,
          sitelinks: 10,
        },
        {
          entityId: 'Q2',
          name: '快照远点',
          coordinates: [117.6, 34.6],
          kind: null,
          heritageDesignations: [],
          description: null,
          sitelinks: 8,
        },
        {
          entityId: 'Q3',
          name: '快照无坐标',
          coordinates: null,
          kind: '古迹',
          heritageDesignations: [],
          description: null,
          sitelinks: 5,
        },
      ],
      relics: [
        {
          entityId: 'Q4',
          name: '快照文物',
          coordinates: [117.3, 34.35],
          inceptionYear: 1368,
          museumOrSite: '徐州博物馆',
          location: null,
          designations: ['全国重点文物保护单位'],
          description: null,
          sitelinks: 6,
        },
      ],
      figures: [],
      failures: [],
    };
    const trip = buildDayTrip(city, null, snapshot);
    expect(trip.stops.map((stop) => stop.name)).toEqual(['快照近点', '快照文物', '快照远点']);
    expect(trip.stops.every((stop) => stop.coordSource === 'wikidata')).toBe(true);
    expect(trip.stops[0]!.sourceRefs).toEqual(['S-WD-CN-320300']);
    expect(trip.notice).toContain('Wikidata 事实快照');
    expect(trip.degraded).toBe(true);
  });

  it('档案有点位时优先用档案，不回退快照', () => {
    const bundle = bundleWith({ landmarks: [landmark('档案点', 117.2)] });
    const snapshot: FactSnapshot = {
      cityId: city.cityId,
      cityName: city.standardName,
      cityQid: 'Q12345',
      center: city.center as [number, number],
      retrievedAt: '2026-11-11T00:00:00.000Z',
      sourceRef: {
        id: 'S-WD-CN-320300',
        type: 'wikidata',
        title: 'Wikidata 事实快照 · 徐州',
        retrievedAt: '2026-11-11T00:00:00.000Z',
      },
      landmarks: [
        {
          entityId: 'Q9',
          name: '快照点',
          coordinates: [117.25, 34.31],
          kind: '古迹',
          heritageDesignations: [],
          description: null,
          sitelinks: 3,
        },
      ],
      relics: [],
      figures: [],
      failures: [],
    };
    const trip = buildDayTrip(city, bundle, snapshot);
    expect(trip.stops.map((stop) => stop.name)).toEqual(['档案点']);
    expect(trip.stops[0]!.coordSource).toBe('local_gazetteer');
    expect(trip.notice).not.toContain('Wikidata');
  });
});
