/**
 * 诗词语料归属回归（对抗性审查 fixture，2026-11-11）。
 *
 * 背景：审查发现「天津桥」被「天津」关键词误配（同类于此前的「西岭草堂」事件），
 * 以及「西湖 / 上京 / 钟离 / 黄河 / 琅琊」等通用地名造成跨城误配。
 * 本测试锁定修复后的归属规则，防止回归。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../config';

interface CorpusPoem {
  poemId: string;
  title: string;
  author: string;
  matchedCities: string[];
}

function loadCorpus(): CorpusPoem[] {
  const raw = readFileSync(resolve(config.dataDir, 'verified_poetry_corpus.json'), 'utf8');
  const parsed = JSON.parse(raw) as { poems?: CorpusPoem[] };
  return parsed.poems ?? [];
}

describe('诗词语料归属回归', () => {
  const poems = loadCorpus();

  it('洛阳「天津桥」诗只归洛阳，不归天津', () => {
    const bridgePoems = poems.filter((poem) => poem.title.includes('天津桥'));
    expect(bridgePoems.length).toBeGreaterThan(0);
    for (const poem of bridgePoems) {
      expect(poem.matchedCities, `${poem.title} · ${poem.author}`).toContain('CN-410300');
      expect(poem.matchedCities, `${poem.title} · ${poem.author}`).not.toContain('CN-120000');
    }
  });

  it('天津仅保留古称（直沽/津门/盘山等）诗，不含天津桥', () => {
    const tianjinPoems = poems.filter((poem) => poem.matchedCities.includes('CN-120000'));
    expect(tianjinPoems.length).toBeGreaterThan(0);
    expect(tianjinPoems.length).toBeLessThan(10);
    for (const poem of tianjinPoems) {
      expect(poem.title.includes('天津桥'), poem.title).toBe(false);
    }
  });

  it('通用地名不再造成单城标题命中：福州诗不含「西湖」标题', () => {
    const fuzhouPoems = poems.filter((poem) => poem.matchedCities.includes('CN-350100'));
    expect(fuzhouPoems.length).toBeGreaterThan(0);
    expect(fuzhouPoems.filter((poem) => poem.title.startsWith('西湖'))).toEqual([]);
  });

  it('六座预置城市均有诗且语料规模保持量级', () => {
    for (const cityId of ['CN-610100', 'CN-330100', 'CN-510100', 'CN-110000', 'CN-320500', 'CN-410300']) {
      expect(
        poems.some((poem) => poem.matchedCities.includes(cityId)),
        cityId,
      ).toBe(true);
    }
    expect(poems.length).toBeGreaterThan(2000);
  });
});
