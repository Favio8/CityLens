import { describe, expect, it } from 'vitest';
import type { Coord, ChronicleItem, Poem, SourceRef } from './schema';
import {
  computeArchiveStatus,
  extractYears,
  haversineKm,
  validateChronicleOrder,
  validateCoord,
  validateImagery,
  validateNarrativeYears,
  validateNumericRange,
  validatePoemAgainstCorpus,
  validateSourceRefs,
  validateYear,
  validateYearInRange,
} from './validators';

const XIAN_CENTER: Coord = [108.9422, 34.2611];

describe('坐标校验（PRD 3.2 四.3）', () => {
  it('计算球面距离', () => {
    const distance = haversineKm([0, 0], [0, 1]);
    expect(distance).toBeGreaterThan(110);
    expect(distance).toBeLessThan(112);
  });

  it('城市中心 180km 内通过', () => {
    const result = validateCoord([109.27, 34.38], XIAN_CENTER);
    expect(result.ok).toBe(true);
    expect(result.distanceKm).toBeLessThan(180);
  });

  it('超出 180km 拒绝', () => {
    const result = validateCoord([116.4, 39.9], XIAN_CENTER);
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('180km');
  });

  it('缺失坐标与非法数值拒绝', () => {
    expect(validateCoord(null, XIAN_CENTER).ok).toBe(false);
    expect(validateCoord([Number.NaN, 34], XIAN_CENTER).ok).toBe(false);
    expect(validateCoord([200, 34], XIAN_CENTER).ok).toBe(false);
  });
});

describe('年份与数值校验', () => {
  it('公元 0 年不存在，公元前为负数', () => {
    expect(validateYear(0)).toBe(false);
    expect(validateYear(-221)).toBe(true);
    expect(validateYear(2026)).toBe(true);
  });

  it('年份必须落在区间内', () => {
    expect(validateYearInRange(700, 618, 907)).toBe(true);
    expect(validateYearInRange(1000, 618, 907)).toBe(false);
    expect(validateYearInRange(-100, -221, -206)).toBe(false);
  });

  it('数量级校验', () => {
    expect(validateNumericRange(10108, { min: 50, max: 500_000 })).toBe(true);
    expect(validateNumericRange(12_000_000, { min: 0.1, max: 5000 })).toBe(false);
  });

  it('从叙事中提取年份（含公元前）', () => {
    expect(extractYears('公元前221年置内史，618年设长安县，公元2024年')).toEqual([
      -221, 618, 2024,
    ]);
  });

  it('叙事中的具体年份必须在 Fact Context 内', () => {
    const allowed = new Set([-221, 618, 907]);
    expect(validateNarrativeYears('公元前221年秦置内史', allowed).ok).toBe(true);
    expect(validateNarrativeYears('1234年发生某事', allowed).ok).toBe(false);
  });
});

describe('来源引用校验', () => {
  const sources: SourceRef[] = [
    { id: 'S1', type: 'local_snapshot', title: '维度快照', retrievedAt: '2026-11-10T00:00:00.000Z' },
    { id: 'S2', type: 'poetry_corpus', title: '诗词库', retrievedAt: '2026-11-10T00:00:00.000Z' },
  ];

  it('全部命中通过', () => {
    expect(validateSourceRefs(['S1', 'S2'], sources).ok).toBe(true);
  });

  it('缺失条目列出', () => {
    const result = validateSourceRefs(['S1', 'S9'], sources);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['S9']);
  });
});

describe('诗词核验（PRD 3.2 三）', () => {
  const corpus = {
    poemId: 'tang-0001',
    title: '登科后',
    author: '孟郊',
    dynasty: '唐',
    lines: ['昔日龌龊不足夸', '今朝放荡思无涯', '春风得意马蹄疾', '一日看尽长安花'],
  };
  const poem: Pick<Poem, 'poemId' | 'title' | 'author' | 'dynasty' | 'lines'> = {
    poemId: 'tang-0001',
    title: '登科后',
    author: '孟郊',
    dynasty: '唐',
    lines: ['昔日龌龊不足夸', '今朝放荡思无涯', '春风得意马蹄疾', '一日看尽长安花'],
  };

  it('逐字一致通过', () => {
    expect(validatePoemAgainstCorpus(poem, corpus).ok).toBe(true);
  });

  it('改字、改作者、少句均被拒绝', () => {
    expect(
      validatePoemAgainstCorpus({ ...poem, lines: [...poem.lines.slice(0, 3), '一日看尽长安花。'] }, corpus)
        .ok,
    ).toBe(false);
    expect(validatePoemAgainstCorpus({ ...poem, author: '李白' }, corpus).ok).toBe(false);
    expect(validatePoemAgainstCorpus({ ...poem, lines: poem.lines.slice(0, 2) }, corpus).ok).toBe(
      false,
    );
    expect(validatePoemAgainstCorpus(poem, undefined).ok).toBe(false);
  });

  it('意象词必须在原文中出现', () => {
    const lines = ['春风得意马蹄疾', '一日看尽长安花'];
    expect(
      validateImagery([{ word: '长安花', isGeographic: true }], lines).ok,
    ).toBe(true);
    expect(validateImagery([{ word: '洛阳花', isGeographic: true }], lines).ok).toBe(false);
  });

  it('泛指意象不得带坐标', () => {
    const result = validateImagery(
      [{ word: '春风', isGeographic: false, coordinates: [108.9, 34.2] }],
      ['春风得意马蹄疾'],
    );
    expect(result.ok).toBe(false);
  });
});

describe('年表校验', () => {
  const nodes: Pick<ChronicleItem, 'eraName' | 'startYear' | 'endYear'>[] = [
    { eraName: '西周', startYear: -1046, endYear: -771 },
    { eraName: '秦', startYear: -221, endYear: -206 },
    { eraName: '唐', startYear: 618, endYear: 907 },
  ];

  it('升序且起止合法通过', () => {
    expect(validateChronicleOrder(nodes).ok).toBe(true);
  });

  it('乱序或结束早于开始被拒绝', () => {
    expect(validateChronicleOrder([...nodes].reverse()).ok).toBe(false);
    expect(
      validateChronicleOrder([{ eraName: '唐', startYear: 907, endYear: 618 }]).ok,
    ).toBe(false);
  });
});

describe('发布规则', () => {
  it('identity 通过且 ≥5 个模块通过（ok/degraded）才发布', () => {
    expect(
      computeArchiveStatus(
        {
          identity: 'ok',
          chronicle: 'ok',
          landmarks: 'ok',
          relics: 'ok',
          figures: 'ok',
          poetics: 'failed',
        },
        ['identity', 'chronicle', 'landmarks', 'relics', 'figures', 'poetics'],
      ),
    ).toBe('partial');

    expect(
      computeArchiveStatus(
        {
          identity: 'degraded',
          chronicle: 'degraded',
          landmarks: 'ok',
          relics: 'ok',
          figures: 'ok',
        },
        ['identity', 'chronicle', 'landmarks', 'relics', 'figures'],
      ),
    ).toBe('partial');

    expect(
      computeArchiveStatus(
        { identity: 'failed', chronicle: 'ok' },
        ['identity', 'chronicle'],
      ),
    ).toBe('unpublished');
  });
});
