import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CityBrief } from '../db/cityRepo';
import { InvalidQueryError, normalizeQuery, type AliasRecord, type NormalizerRepo } from './normalizer';

interface DictionaryFile {
  cities: Array<{
    cityId: string;
    standardName: string;
    province: string;
    adminLevel: string;
    pinyin: string;
    englishName: string;
    center: [number, number];
    summary: string;
    hotRank: number | null;
    aliases: Array<{ key: string; display: string; matchType: string; hint?: string }>;
  }>;
}

const dict = JSON.parse(
  readFileSync(new URL('../../server/data/city_dictionary.json', import.meta.url), 'utf8'),
) as DictionaryFile;

const aliasIndex = new Map<string, AliasRecord[]>();
const cityBriefs: CityBrief[] = [];

for (const city of dict.cities) {
  cityBriefs.push({
    cityId: city.cityId,
    standardName: city.standardName,
    province: city.province,
    adminLevel: city.adminLevel,
    pinyin: city.pinyin,
    englishName: city.englishName,
    center: city.center,
    summary: city.summary,
    hotRank: city.hotRank,
    isPreset: false,
  });
  for (const alias of city.aliases) {
    const list = aliasIndex.get(alias.key) ?? [];
    list.push({
      aliasKey: alias.key,
      displayAlias: alias.display,
      cityId: city.cityId,
      matchType: alias.matchType,
      hint: alias.hint ?? null,
      standardName: city.standardName,
      province: city.province,
      summary: city.summary,
    });
    aliasIndex.set(alias.key, list);
  }
}

const repo: NormalizerRepo = {
  findAliases(keys) {
    return keys.flatMap((key) => aliasIndex.get(key) ?? []);
  },
  listCities() {
    return cityBriefs;
  },
};

describe('名称规范化与消歧（AC-01 / AC-02 / AC-09）', () => {
  it('古称「长安」归并到西安', () => {
    const result = normalizeQuery('长安', repo);
    expect(result.status).toBe('exact');
    expect(result.candidates[0]?.cityId).toBe('CN-610100');
    expect(result.candidates[0]?.matchType).toBe('ancient');
  });

  it('英文「Xi\'an」归并到西安', () => {
    const result = normalizeQuery("Xi'an", repo);
    expect(result.status).toBe('exact');
    expect(result.candidates[0]?.cityId).toBe('CN-610100');
  });

  it('古称「金陵」归并到南京', () => {
    const result = normalizeQuery('金陵', repo);
    expect(result.status).toBe('exact');
    expect(result.candidates[0]?.cityId).toBe('CN-320100');
  });

  it('「Lin\'an」归并到杭州并给出区县提示', () => {
    const result = normalizeQuery("Lin'an", repo);
    expect(result.status).toBe('exact');
    expect(result.candidates[0]?.cityId).toBe('CN-330100');
    expect(result.hint).toContain('临安区');
  });

  it('「临安」归并到杭州并给出提示', () => {
    const result = normalizeQuery('临安', repo);
    expect(result.status).toBe('exact');
    expect(result.candidates[0]?.cityId).toBe('CN-330100');
    expect(result.hint).toContain('杭州市辖区');
  });

  it.each([
    ['suzhou', ['CN-320500', 'CN-341300']],
    ['taizhou', ['CN-321200', 'CN-331000']],
    ['fuzhou', ['CN-350100', 'CN-361000']],
  ])('同拼音 %s 返回消歧候选', (query, expectedIds) => {
    const result = normalizeQuery(query, repo);
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.map((c) => c.cityId).sort()).toEqual([...expectedIds].sort());
    for (const candidate of result.candidates) {
      expect(candidate.province.length).toBeGreaterThan(1);
      expect(candidate.summary).toBeTruthy();
    }
  });

  it('形近字「毫州」纠正为亳州并提示', () => {
    const result = normalizeQuery('毫州', repo);
    expect(result.status).toBe('exact');
    expect(result.candidates[0]?.name).toBe('亳州');
    expect(result.hint).toContain('纠正');
  });

  it('不存在的城市返回 none', () => {
    expect(normalizeQuery('亚特兰蒂斯市', repo).status).toBe('none');
    expect(normalizeQuery('asdfghjkl', repo).status).toBe('none');
  });

  it('空查询与非法字符抛 INVALID_QUERY', () => {
    expect(() => normalizeQuery('   ', repo)).toThrow(InvalidQueryError);
    expect(() => normalizeQuery('<script>alert(1)</script>', repo)).toThrow(InvalidQueryError);
    expect(() => normalizeQuery('一'.repeat(31), repo)).toThrow(InvalidQueryError);
  });

  it('city_aliases 中不存在完全重复的别名行', () => {
    const seen = new Set<string>();
    for (const city of dict.cities) {
      for (const alias of city.aliases) {
        const key = `${alias.key}|${city.cityId}|${alias.matchType}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
