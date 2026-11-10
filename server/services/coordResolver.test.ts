import { describe, expect, it } from 'vitest';
import type { Coord } from '../../shared/schema';
import type { Gazetteer } from './presetData';
import { getGazetteer } from './presetData';
import { findGazetteerEntry, resolveCoord, resolveCoordLocal } from './coordResolver';

const XIAN_CENTER: Coord = [108.942222222, 34.261111111];

const gazetteer: Gazetteer = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  entries: [
    {
      name: '大雁塔',
      coordinates: [108.9642, 34.2195],
      cityId: 'CN-610100',
      kind: 'landmark',
      entityId: 'Q1',
      sourceRef: 'S-TEST',
    },
    {
      name: '沈阳故宫',
      coordinates: [123.455, 41.796],
      cityId: 'CN-210100',
      kind: 'landmark',
      entityId: 'Q2',
      sourceRef: 'S-TEST',
    },
    {
      name: '远郊点',
      coordinates: [112.0, 36.0],
      cityId: 'CN-610100',
      kind: 'landmark',
      entityId: 'Q3',
      sourceRef: 'S-TEST',
    },
  ],
};

describe('coordResolver 本地地名库', () => {
  it('完全同名命中并回填 local_gazetteer', async () => {
    const result = await resolveCoord(
      { cityId: 'CN-610100', placeName: '大雁塔', center: XIAN_CENTER, allowRemote: false },
      { gazetteer },
    );
    expect(result.coordSource).toBe('local_gazetteer');
    expect(result.coordinates).toEqual([108.9642, 34.2195]);
    expect(result.distanceKm).toBeLessThan(180);
  });

  it('名称包含关系可命中（大雁塔北广场 → 大雁塔）', async () => {
    const result = await resolveCoord(
      {
        cityId: 'CN-610100',
        placeName: '大雁塔北广场',
        center: XIAN_CENTER,
        allowRemote: false,
      },
      { gazetteer },
    );
    expect(result.coordSource).toBe('local_gazetteer');
    expect(result.matchedName).toBe('大雁塔');
  });

  it('超过 180km 的坐标被丢弃为 null', async () => {
    const result = await resolveCoord(
      { cityId: 'CN-610100', placeName: '远郊点', center: XIAN_CENTER, allowRemote: false },
      { gazetteer },
    );
    expect(result.coordinates).toBeNull();
    expect(result.coordSource).toBe('none');
    expect(result.reasons.join('')).toContain('180km');
  });

  it('不得跨城市匹配同名地点', async () => {
    const result = await resolveCoord(
      { cityId: 'CN-610100', placeName: '沈阳故宫', center: XIAN_CENTER, allowRemote: false },
      { gazetteer },
    );
    expect(result.coordinates).toBeNull();
  });

  it('本地未命中时回退远程检索（天地图来源）', async () => {
    const result = await resolveCoord(
      { cityId: 'CN-610100', placeName: '未收录地点', center: XIAN_CENTER },
      {
        gazetteer,
        remoteSearch: async () => [
          { name: '未收录地点', coordinates: [108.95, 34.26], source: 'tianditu' },
        ],
      },
    );
    expect(result.coordSource).toBe('tianditu');
    expect(result.coordinates).toEqual([108.95, 34.26]);
  });

  it('远程结果超出 180km 或名称不符时丢弃', async () => {
    const result = await resolveCoord(
      { cityId: 'CN-610100', placeName: '未收录地点', center: XIAN_CENTER },
      {
        gazetteer,
        remoteSearch: async () => [
          { name: '未收录地点', coordinates: [120.0, 30.0], source: 'tianditu' },
        ],
      },
    );
    expect(result.coordinates).toBeNull();

    const mismatch = await resolveCoord(
      { cityId: 'CN-610100', placeName: '未收录地点', center: XIAN_CENTER },
      {
        gazetteer,
        remoteSearch: async () => [
          { name: '完全不同的地方', coordinates: [108.95, 34.26], source: 'tianditu' },
        ],
      },
    );
    expect(mismatch.coordinates).toBeNull();
  });

  it('空地名直接返回 null', async () => {
    const result = await resolveCoord(
      { cityId: 'CN-610100', placeName: '   ', center: XIAN_CENTER },
      { gazetteer },
    );
    expect(result.coordinates).toBeNull();
    expect(result.reasons[0]).toContain('地名为空');
  });

  it('同步版本只查本地库', () => {
    const result = resolveCoordLocal(gazetteer, 'CN-610100', '大雁塔', XIAN_CENTER);
    expect(result.coordinates).toEqual([108.9642, 34.2195]);
    expect(findGazetteerEntry(gazetteer, 'CN-610100', '大雁塔')?.entry.entityId).toBe('Q1');
  });
});

describe('coordResolver 真实地名库（构建期产物）', () => {
  it('西安秦始皇陵能从本地地名库解析且落在 180km 内', async () => {
    const real = getGazetteer();
    expect(real).not.toBeNull();
    const result = await resolveCoord(
      { cityId: 'CN-610100', placeName: '秦始皇陵', center: XIAN_CENTER, allowRemote: false },
      { gazetteer: real },
    );
    expect(result.coordinates).not.toBeNull();
    expect(result.coordSource).toBe('local_gazetteer');
    expect(result.distanceKm).toBeLessThan(180);
  });
});
