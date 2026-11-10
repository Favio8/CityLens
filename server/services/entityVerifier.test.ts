import { describe, expect, it } from 'vitest';
import type { Coord } from '../../shared/schema';
import { PENDING } from '../../shared/schema';
import type { Gazetteer } from './presetData';
import { getFactSnapshot, getRelicsRegistry, getGazetteer } from './presetData';
import {
  figureYear,
  formatRelicEra,
  relicFindSpot,
  relicMuseumOrSite,
  resolveEntityPlace,
  verifyFigure,
  verifyLandmark,
  verifyRelic,
  verifySnapshotRelicAsRelic,
} from './entityVerifier';

const XIAN_CENTER: Coord = [108.942222222, 34.261111111];
const snapshot = getFactSnapshot('CN-610100');
const registry = getRelicsRegistry();
const gazetteer = getGazetteer();

if (!snapshot || !registry) throw new Error('测试前置数据缺失：请先运行构建期脚本');

describe('景点实体核验', () => {
  it('快照内实体通过并回填快照来源', () => {
    const landmark = snapshot!.landmarks[0]!;
    const result = verifyLandmark(landmark.entityId, snapshot);
    expect(result.ok).toBe(true);
    expect(result.entity?.name).toBe(landmark.name);
    expect(result.sourceRefs).toEqual([snapshot!.sourceRef.id]);
  });

  it('不在候选中的实体整条丢弃', () => {
    const result = verifyLandmark('Q-NOT-EXIST', snapshot);
    expect(result.ok).toBe(false);
    expect(result.entity).toBeNull();
    expect(result.issues[0]).toContain('Q-NOT-EXIST');
  });

  it('缺少快照时失败而不是放行', () => {
    expect(verifyLandmark('Q1', null).ok).toBe(false);
  });

  it('快照文物实体可作为文物候选', () => {
    const relic = snapshot!.relics[0]!;
    const result = verifySnapshotRelicAsRelic(relic.entityId, snapshot);
    expect(result.ok).toBe(true);
    expect(result.entity?.name).toBe(relic.name);
  });
});

describe('文物名录核验', () => {
  it('名录内且属于本城的文物通过', () => {
    const relic = registry!.relics.find((item) => item.cityId === 'CN-610100')!;
    const result = verifyRelic(relic.registryId, registry, 'CN-610100');
    expect(result.ok).toBe(true);
    expect(result.entity?.name).toBe(relic.name);
    expect(result.sourceRefs.length).toBeGreaterThan(0);
  });

  it('名录之外或跨城的文物失败', () => {
    const other = registry!.relics.find((item) => item.cityId === 'CN-110000')!;
    const crossCity = verifyRelic(other.registryId, registry, 'CN-610100');
    expect(crossCity.ok).toBe(false);
    expect(crossCity.issues.join('')).toContain('不得归入本城');

    expect(verifyRelic('CN-610100:Q-FAKE', registry, 'CN-610100').ok).toBe(false);
    expect(verifyRelic('CN-610100:Q1', null, 'CN-610100').ok).toBe(false);
  });

  it('名录字段缺失时统一回填“待考”', () => {
    const pendingRelic = {
      registryId: 'CN-610100:Q-PENDING',
      cityId: 'CN-610100',
      cityName: '西安',
      name: '示例',
      era: PENDING,
      museumOrSite: '',
      protectionLevel: '',
      findSpot: '',
      coordinates: null,
      description: null,
      sourceRefs: ['S-TEST'],
    };
    expect(formatRelicEra(null)).toBe(PENDING);
    expect(relicMuseumOrSite(pendingRelic)).toBe(PENDING);
    expect(relicFindSpot(pendingRelic)).toBe(PENDING);
    expect(formatRelicEra(-221)).toBe('公元前221年');
  });
});

describe('人物实体核验', () => {
  it('快照人物通过，且 evidence 指向城市关联', () => {
    const figure = snapshot!.figures.find((item) => item.sitelinks > 0)!;
    const result = verifyFigure(figure.entityId, snapshot);
    expect(result.ok).toBe(true);
    expect(result.entity?.evidence.property.length).toBeGreaterThan(0);
  });

  it('不在快照中的人物被丢弃', () => {
    expect(verifyFigure('Q-NOT-EXIST', snapshot).ok).toBe(false);
  });

  it('生卒年缺失为“待考”，公元前保留负数', () => {
    expect(figureYear(null)).toBe(PENDING);
    expect(figureYear(undefined)).toBe(PENDING);
    expect(figureYear(0)).toBe(PENDING);
    expect(figureYear(-155)).toBe(-155);
    expect(figureYear(701)).toBe(701);
  });
});

describe('实体坐标回填', () => {
  it('本地地名库优先（local_gazetteer）', () => {
    const qinShihuang = snapshot!.landmarks.find((item) => item.name === '秦始皇陵');
    expect(qinShihuang).toBeTruthy();
    const place = resolveEntityPlace(qinShihuang!, 'CN-610100', XIAN_CENTER, gazetteer);
    expect(place.coordSource).toBe('local_gazetteer');
    expect(place.coordinates).not.toBeNull();
    expect(place.distanceKm).toBeLessThan(180);
  });

  it('地名库未命中但实体自带合法坐标时记为 wikidata', () => {
    const syntheticGazetteer: Gazetteer = { generatedAt: '', entries: [] };
    const place = resolveEntityPlace(
      { name: '未收录实体', coordinates: [108.95, 34.26] },
      'CN-610100',
      XIAN_CENTER,
      syntheticGazetteer,
    );
    expect(place.coordSource).toBe('wikidata');
    expect(place.coordinates).toEqual([108.95, 34.26]);
  });

  it('实体坐标超出 180km 时丢弃为 null', () => {
    const syntheticGazetteer: Gazetteer = { generatedAt: '', entries: [] };
    const place = resolveEntityPlace(
      { name: '错误坐标实体', coordinates: [120.0, 30.0] },
      'CN-610100',
      XIAN_CENTER,
      syntheticGazetteer,
    );
    expect(place.coordinates).toBeNull();
    expect(place.distanceKm).toBeGreaterThan(180);
  });

  it('无坐标实体返回 null 并给出原因', () => {
    const syntheticGazetteer: Gazetteer = { generatedAt: '', entries: [] };
    const place = resolveEntityPlace(
      { name: '无坐标实体', coordinates: null },
      'CN-610100',
      XIAN_CENTER,
      syntheticGazetteer,
    );
    expect(place.coordinates).toBeNull();
    expect(place.reasons.length).toBeGreaterThan(0);
  });
});
