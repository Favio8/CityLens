import { describe, expect, it } from 'vitest';
import { getCityStats, resetStatsBaselineCache } from './statsBaseline';

describe('statsBaseline', () => {
  it('返回六座预置城市的统计与气候基线', () => {
    resetStatsBaselineCache();
    for (const cityId of ['CN-610100', 'CN-330100', 'CN-510100', 'CN-110000', 'CN-320500', 'CN-410300']) {
      const stats = getCityStats(cityId);
      expect(stats, cityId).not.toBeNull();
      expect(stats?.city.gdp.series).toHaveLength(5);
      expect(stats?.city.pop.series).toHaveLength(5);
      expect(stats?.city.climate.monthly).toHaveLength(12);
      expect(stats?.sources.length).toBeGreaterThan(0);
    }
  });

  it('成都序列为 2021–2025 官方公报值（修正后的完整序列）', () => {
    resetStatsBaselineCache();
    const chengdu = getCityStats('CN-510100');
    expect(chengdu?.city.gdp.series.map((point) => point.value)).toEqual([
      19917,
      20817.5,
      22074.7,
      23511.3,
      24763.6,
    ]);
    expect(chengdu?.city.pop.series.map((point) => point.value)).toEqual([
      2119.2,
      2126.8,
      2140.3,
      2147.4,
      2153.5,
    ]);
  });

  it('缺失年份保持 null，不估算', () => {
    resetStatsBaselineCache();
    // 西安 2021 年常住人口未检索到官方公报值，保持 null
    const xian = getCityStats('CN-610100');
    expect(xian?.city.pop.series[0]?.value).toBeNull();
    expect(xian?.city.pop.series[0]?.year).toBe(2021);
    expect(xian?.city.pop.series.slice(1).every((point) => point.value !== null)).toBe(true);
  });

  it('未收录城市返回 null', () => {
    resetStatsBaselineCache();
    expect(getCityStats('CN-000000')).toBeNull();
  });
});
