import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PoetryCorpus } from './presetData';
import {
  buildPoetryIndex,
  deriveImagery,
  findPoemCandidates,
  selectDiversePoems,
  verifyPoemSelection,
  verifyPoemText,
} from './poetryVerifier';

const corpus = JSON.parse(
  readFileSync(new URL('../../server/data/verified_poetry_corpus.json', import.meta.url), 'utf8'),
) as PoetryCorpus;

const index = buildPoetryIndex(corpus);

function seed(author: string, title: string) {
  const poem = corpus.poems.find((item) => item.author === author && item.title === title);
  if (!poem) throw new Error(`测试底本缺少 ${author}《${title}》`);
  return poem;
}

describe('诗词候选检索', () => {
  it('六座预置城市均有候选，名篇排在最前', () => {
    for (const cityId of [
      'CN-610100',
      'CN-330100',
      'CN-510100',
      'CN-110000',
      'CN-320500',
      'CN-410300',
    ]) {
      const candidates = findPoemCandidates(index, cityId, 5);
      expect(candidates.length).toBe(5);
    }
    const xian = findPoemCandidates(index, 'CN-610100', 3);
    expect(xian[0]?.title).toBe('登科后');
    const suzhou = findPoemCandidates(index, 'CN-320500', 3);
    expect(suzhou[0]?.title).toBe('枫桥夜泊');
  });

  it('未收录城市返回空候选（不伪造）', () => {
    expect(findPoemCandidates(index, 'CN-440300', 5)).toEqual([]);
  });

  it('选题去重：同题应制诗与同题组诗不重复占版', () => {
    const chengdu = selectDiversePoems(findPoemCandidates(index, 'CN-510100', 20), 5);
    const titles = chengdu.map((poem) => poem.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.filter((title) => title.includes('将赴成都草堂')).length).toBeLessThanOrEqual(1);
    expect(chengdu.length).toBeGreaterThanOrEqual(3);

    const suzhou = selectDiversePoems(findPoemCandidates(index, 'CN-320500', 20), 5);
    const taohuShi = suzhou.filter((poem) => poem.title.includes('太湖石'));
    expect(taohuShi.length).toBeLessThanOrEqual(2);

    const xian = selectDiversePoems(findPoemCandidates(index, 'CN-610100', 20), 5);
    const xianTitles = xian.map((poem) => poem.title);
    expect(new Set(xianTitles).size).toBe(xianTitles.length);
  });
});

describe('离线意象推导', () => {
  it('只从原文逐字命中本城地名库的词生成地理意象', () => {
    const poem = seed('孟郊', '登科后');
    const imagery = deriveImagery(poem, 'CN-610100');
    const changan = imagery.find((item) => item.word === '长安');
    expect(changan).toBeDefined();
    expect(changan?.isGeographic).toBe(true);
    expect(changan?.coordinates).not.toBeNull();
    expect(imagery.every((item) => poem.lines.join('').includes(item.word))).toBe(true);
  });

  it('原文没有的地名不生成意象', () => {
    const poem = seed('张继', '枫桥夜泊');
    const imagery = deriveImagery(poem, 'CN-610100');
    expect(imagery.some((item) => item.word === '长安')).toBe(false);
  });
});

describe('诗词逐字校验', () => {
  it('库内原文与作者朝代完全一致时通过', () => {
    const poem = seed('孟郊', '登科后');
    const result = verifyPoemText(poem, index);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('改动任意一个字即失败', () => {
    const poem = seed('孟郊', '登科后');
    const tampered = { ...poem, lines: [...poem.lines] };
    tampered.lines[0] = `${tampered.lines[0]}。`;
    const result = verifyPoemText(tampered, index);
    expect(result.ok).toBe(false);
    expect(result.issues.join('')).toContain('第 1 句');
  });

  it('张冠李戴作者失败', () => {
    const poem = seed('张继', '枫桥夜泊');
    const result = verifyPoemText({ ...poem, author: '李白' }, index);
    expect(result.ok).toBe(false);
    expect(result.issues.join('')).toContain('作者');
  });

  it('不存在的 poemId 失败', () => {
    const result = verifyPoemText(
      { poemId: 'tang:deadbeef', title: '伪诗', author: '某人', dynasty: '唐', lines: ['假句'] },
      index,
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('不存在');
  });
});

describe('诗词选择与意象校验', () => {
  it('事实字段全部以库内为准，模型只提供 poemId 与意象注释', () => {
    const poem = seed('孟郊', '登科后');
    const result = verifyPoemSelection(
      {
        poemId: poem.poemId,
        background: '孟郊四十六岁进士及第后所作。',
        relationType: 'direct',
        imageryMap: [
          {
            word: '长安',
            note: '唐代都城，诗中指帝都繁华。',
            isGeographic: true,
            placeName: '长安',
          },
        ],
      },
      index,
      'CN-610100',
    );
    expect(result.ok).toBe(true);
    expect(result.poem?.title).toBe('登科后');
    expect(result.poem?.author).toBe('孟郊');
    expect(result.poem?.dynasty).toBe('唐');
    expect(result.poem?.lines).toEqual(poem.lines);
    expect(result.poem?.verification).toBe('verified_by_source');
    expect(result.poem?.sourceRefs[0]).toContain(poem.poemId);
  });

  it('意象词不在原文中则失败', () => {
    const poem = seed('孟郊', '登科后');
    const result = verifyPoemSelection(
      {
        poemId: poem.poemId,
        imageryMap: [
          { word: '大雁塔', note: '不相干的意象', isGeographic: true, placeName: '大雁塔' },
        ],
      },
      index,
      'CN-610100',
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join('')).toContain('未出现在原文');
  });

  it('地理意象缺少 placeName 失败；泛指意象带坐标失败', () => {
    const poem = seed('孟郊', '登科后');
    const noPlace = verifyPoemSelection(
      {
        poemId: poem.poemId,
        imageryMap: [{ word: '长安', note: '注释', isGeographic: true }],
      },
      index,
      'CN-610100',
    );
    expect(noPlace.ok).toBe(false);
    expect(noPlace.issues.join('')).toContain('placeName');

    const nonGeo = verifyPoemSelection(
      {
        poemId: poem.poemId,
        imageryMap: [
          {
            word: '春风',
            note: '泛指春风',
            isGeographic: false,
            coordinates: [108.9, 34.2],
          },
        ],
      },
      index,
      'CN-610100',
    );
    expect(nonGeo.ok).toBe(false);
    expect(nonGeo.issues.join('')).toContain('不应携带坐标');
  });

  it('把未关联本城的诗归入本城会失败', () => {
    const poem = seed('孟郊', '登科后');
    const result = verifyPoemSelection({ poemId: poem.poemId }, index, 'CN-330100');
    expect(result.ok).toBe(false);
    expect(result.issues.join('')).toContain('未与本城');
  });
});
