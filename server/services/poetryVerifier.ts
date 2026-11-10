/**
 * 诗词核验器（PRD 3.2 三·诗词）。
 *
 * 模型只允许输出 poemId、创作背景与意象注释；标题、作者、朝代、正文一律取自本地库。
 * 本模块负责：候选检索、逐字比对、意象词校验、按库内原文回填。
 */
import type { Coord, Poem, SourceRef } from '../../shared/schema';
import { PENDING } from '../../shared/schema';
import {
  normalizeText,
  validateImagery,
  validatePoemAgainstCorpus,
} from '../../shared/validators';
import type { CorpusPoem, PoetryCorpus } from './presetData';
import { getPoetryCorpus } from './presetData';

export interface PoetryIndex {
  poems: CorpusPoem[];
  byId: Map<string, CorpusPoem>;
  byCity: Map<string, CorpusPoem[]>;
}

export function buildPoetryIndex(corpus: PoetryCorpus | null | undefined): PoetryIndex {
  const index: PoetryIndex = { poems: [], byId: new Map(), byCity: new Map() };
  if (!corpus) return index;
  for (const poem of corpus.poems) {
    index.poems.push(poem);
    index.byId.set(poem.poemId, poem);
    for (const cityId of poem.matchedCities) {
      const list = index.byCity.get(cityId) ?? [];
      if (!list.includes(poem)) list.push(poem);
      index.byCity.set(cityId, list);
    }
  }
  return index;
}

let cachedIndex: PoetryIndex | null = null;

export function getPoetryIndex(): PoetryIndex {
  if (!cachedIndex) cachedIndex = buildPoetryIndex(getPoetryCorpus());
  return cachedIndex;
}

/** 候选诗词：名篇优先，其次按匹配分与题目排序。 */
export function findPoemCandidates(
  index: PoetryIndex,
  cityId: string,
  limit = 8,
): CorpusPoem[] {
  const list = index.byCity.get(cityId) ?? [];
  return [...list]
    .sort((a, b) => {
      const seedDiff =
        Number(b.seedFor.includes(cityId)) - Number(a.seedFor.includes(cityId));
      if (seedDiff !== 0) return seedDiff;
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return a.title.localeCompare(b.title, 'zh-Hans-CN');
    })
    .slice(0, limit);
}

/** 模型提交的诗词选择：只含允许模型输出的字段。 */
export interface PoemSelectionInput {
  poemId: string;
  background?: string;
  relationType?: 'direct' | 'regional';
  imageryMap?: Array<{
    word: string;
    note: string;
    isGeographic: boolean;
    placeName?: string;
    coordinates?: Coord | null;
  }>;
}

export interface PoemVerification {
  ok: boolean;
  issues: string[];
  /** 校验通过后的档案级诗词对象（事实字段全部来自本地库）。 */
  poem: Poem | null;
  corpusPoem: CorpusPoem | null;
}

const RETRIEVED_AT = new Date().toISOString();

export function poemSourceRef(corpusPoem: CorpusPoem, retrievedAt = RETRIEVED_AT): SourceRef {
  return {
    id: `S-POETRY:${corpusPoem.poemId}`,
    type: 'poetry_corpus',
    title: `chinese-poetry 底本 · ${corpusPoem.author}《${corpusPoem.title}》`,
    url: corpusPoem.sourceUrl,
    retrievedAt,
  };
}

/**
 * 校验并回填一首诗。
 * 1. poemId 必须存在于本地库；
 * 2. 若模型回传了 title/author/dynasty/lines，必须与库内逐字一致（不允许改写）；
 * 3. 意象词必须出现在库内正文中；泛指意象不得带坐标；
 * 4. 返回对象的事实字段全部取自库内。
 */
export function verifyPoemSelection(
  input: PoemSelectionInput,
  index: PoetryIndex,
  cityId?: string,
): PoemVerification {
  const corpusPoem = index.byId.get(input.poemId) ?? null;
  if (!corpusPoem) {
    return {
      ok: false,
      issues: [`诗词库中不存在 poemId=${input.poemId}`],
      poem: null,
      corpusPoem: null,
    };
  }

  const issues: string[] = [];
  if (cityId && !corpusPoem.matchedCities.includes(cityId)) {
    issues.push(`该诗未与本城 ${cityId} 建立地理关联，不得归入本城`);
  }

  const imagery = (input.imageryMap ?? []).filter((item) => item.word.trim().length > 0);
  const imageryCheck = validateImagery(
    imagery.map((item) => ({
      word: item.word,
      isGeographic: item.isGeographic,
      coordinates: item.coordinates ?? null,
    })),
    corpusPoem.lines,
  );
  issues.push(...imageryCheck.issues);

  for (const item of imagery) {
    if (item.isGeographic && !item.placeName?.trim()) {
      issues.push(`地理意象「${item.word}」缺少 placeName，无法回填坐标`);
    }
    if (!item.isGeographic && item.coordinates) {
      issues.push(`泛指意象「${item.word}」不应携带坐标`);
    }
  }

  const relationType = input.relationType ?? 'direct';

  const background =
    input.background && input.background.trim().length > 0 ? input.background.trim() : PENDING;

  const poem: Poem = {
    poemId: corpusPoem.poemId,
    title: corpusPoem.title,
    author: corpusPoem.author,
    dynasty: corpusPoem.dynasty,
    lines: [...corpusPoem.lines],
    background,
    relationType,
    imageryMap: imagery.map((item) => ({
      word: normalizeText(item.word),
      note: item.note,
      isGeographic: item.isGeographic,
      ...(item.placeName ? { placeName: item.placeName } : {}),
      coordinates: item.coordinates ?? null,
    })),
    sourceRefs: [poemSourceRef(corpusPoem).id],
    verification: 'verified_by_source',
  };

  return {
    ok: issues.length === 0,
    issues,
    poem: issues.length === 0 ? poem : null,
    corpusPoem,
  };
}

/** 逐字比对（供 verify 脚本与模型回传字段复核使用）。 */
export function verifyPoemText(
  poem: Pick<Poem, 'poemId' | 'title' | 'author' | 'dynasty' | 'lines'>,
  index: PoetryIndex,
): { ok: boolean; issues: string[] } {
  return validatePoemAgainstCorpus(poem, index.byId.get(poem.poemId));
}

export function resetPoetryIndexCache(): void {
  cachedIndex = null;
}
