/**
 * 诗词核验器（PRD 3.2 三·诗词）。
 *
 * 模型只允许输出 poemId、创作背景与意象注释；标题、作者、朝代、正文一律取自本地库。
 * 本模块负责：候选检索、逐字比对、意象词校验、按库内原文回填。
 */
import type { Coord, Poem, SourceRef } from '../../shared/schema';
import { PENDING } from '../../shared/schema';
import {
  normalizeForImagery,
  normalizeText,
  validateImagery,
  validatePoemAgainstCorpus,
} from '../../shared/validators';
import type { CorpusPoem, Gazetteer, PoetryCorpus } from './presetData';
import { getGazetteer, getPoetryCorpus } from './presetData';

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

function normalizeTitle(title: string): string {
  return normalizeText(title).replace(/[\s·・]/g, '');
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= text.length; i += 1) grams.add(text.slice(i, i + 3));
  return grams;
}

/**
 * 选题去重：避免同题组诗、同题应制诗占满版面。
 * 规则：完全同题拒绝；与已选题共享 ≥8 字前缀的视为同一组诗；
 * 同一三字片段已在两首题名中出现时，第三首拒绝。
 */
export function createTitleDeduplicator(): (title: string) => boolean {
  const titles: string[] = [];
  const gramCount = new Map<string, number>();
  return (rawTitle) => {
    const title = normalizeTitle(rawTitle);
    if (titles.some((item) => item === title)) return false;
    if (titles.some((item) => sharedPrefixLength(item, title) >= 8)) return false;
    const grams = trigrams(title);
    if ([...grams].some((gram) => (gramCount.get(gram) ?? 0) >= 2)) return false;
    titles.push(title);
    for (const gram of grams) gramCount.set(gram, (gramCount.get(gram) ?? 0) + 1);
    return true;
  };
}

export function selectDiversePoems(candidates: readonly CorpusPoem[], limit = 5): CorpusPoem[] {
  const acceptTitle = createTitleDeduplicator();
  const selected: CorpusPoem[] = [];
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (acceptTitle(candidate.title)) selected.push(candidate);
  }
  return selected;
}

/**
 * 离线意象推导：只从原文中逐字命中、且确在本城地名库中的地名生成地理意象；
 * 泛指意象仅取自固定词表，并明确标注不指具体地点。绝不臆造原文没有的词。
 */
const GENERIC_IMAGERY: ReadonlyArray<{ word: string; note: string }> = [
  { word: '明月', note: '泛指意象，借月寄怀，不指具体地点。' },
  { word: '秋风', note: '泛指意象，多寄寓时序与身世之感，不指具体地点。' },
  { word: '春风', note: '泛指意象，常写春意与际遇，不指具体地点。' },
  { word: '春草', note: '泛指意象，常写离思与兴废，不指具体地点。' },
  { word: '孤舟', note: '泛指意象，常写行旅漂泊，不指具体地点。' },
  { word: '杨柳', note: '泛指意象，古诗中常与送别相关，不指具体地点。' },
  { word: '烟雨', note: '泛指意象，写江南雨景氛围，不指具体地点。' },
  { word: '烟波', note: '泛指意象，写水乡浩渺，不指具体地点。' },
  { word: '斜阳', note: '泛指意象，常写日暮与怀古，不指具体地点。' },
  { word: '落日', note: '泛指意象，常写日暮与怀古，不指具体地点。' },
  { word: '暮雨', note: '泛指意象，写黄昏雨景，不指具体地点。' },
  { word: '白杨', note: '泛指意象，常与墓地、怀古相连，不指具体地点。' },
  { word: '青山', note: '泛指意象，常写远山与归隐，不指具体地点。' },
  { word: '白云', note: '泛指意象，常写远意与隐逸，不指具体地点。' },
  { word: '故园', note: '泛指意象，指故乡，不指具体地点。' },
  { word: '江湖', note: '泛指意象，指漂泊之地，不指具体地点。' },
  { word: '流水', note: '泛指意象，古诗中常喻时光流逝，不指具体地点。' },
  { word: '落花', note: '泛指意象，常写春尽与伤逝，不指具体地点。' },
];

/**
 * 人工核对的「诗中简称 → 本城地名库条目」映射。
 * 只收录语义明确、不会误配的简称；不在表内的写法一律不做简称推导。
 */
const PLACE_SHORT_NAMES: Record<string, ReadonlyArray<{ word: string; entryName: string }>> = {
  'CN-330100': [{ word: '灵隐', entryName: '灵隐寺' }],
  'CN-410300': [
    { word: '龙门', entryName: '龙门石窟' },
    { word: '邙山', entryName: '邙山陵墓群' },
  ],
};

export function deriveImagery(
  corpusPoem: CorpusPoem,
  cityId: string,
  gazetteer: Gazetteer | null = getGazetteer(),
  options: { aliases?: readonly string[]; center?: Coord } = {},
): NonNullable<PoemSelectionInput['imageryMap']> {
  const plain = normalizeForImagery(corpusPoem.lines.join(''));
  const entries = (gazetteer?.entries ?? []).filter((entry) => entry.cityId === cityId);
  const places = entries
    .filter((entry) => entry.name.length >= 2)
    .map((entry) => ({ word: entry.name, coordinates: entry.coordinates }))
    .filter((place) => plain.includes(normalizeForImagery(place.word)))
    .sort((a, b) => b.word.length - a.word.length);

  const imagery: NonNullable<PoemSelectionInput['imageryMap']> = [];
  const used: string[] = [];
  for (const place of places) {
    if (used.includes(place.word)) continue;
    if (used.some((name) => name.includes(place.word))) continue;
    used.push(place.word);
    imagery.push({
      word: place.word,
      note: '诗中出现的地名，坐标取自本地地名库（WGS84）。',
      isGeographic: true,
      placeName: place.word,
      coordinates: place.coordinates,
    });
    if (imagery.length >= 2) break;
  }

  // 人工核对的简称（如“龙门”→“龙门石窟”），仅在原文逐字出现时使用。
  if (imagery.length < 2) {
    for (const short of PLACE_SHORT_NAMES[cityId] ?? []) {
      if (imagery.length >= 2) break;
      if (!plain.includes(normalizeForImagery(short.word)) || used.includes(short.word)) continue;
      const entry = entries.find((item) => item.name === short.entryName);
      if (!entry) continue;
      used.push(short.word);
      imagery.push({
        word: short.word,
        note: '诗中出现的地名，坐标取自本地地名库（WGS84）。',
        isGeographic: true,
        placeName: short.entryName,
        coordinates: entry.coordinates,
      });
    }
  }

  // 本城古称（如“幽州”“临安”）在诗中常作地名使用；坐标只能取今日城市中心作参照。
  if (imagery.length < 2 && options.center) {
    const aliases = (options.aliases ?? [])
      .filter((alias) => alias.length >= 2 && !/区$/.test(alias) && /[\u4e00-\u9fa5]/.test(alias))
      .sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      if (imagery.length >= 2) break;
      if (!plain.includes(normalizeForImagery(alias)) || used.includes(alias)) continue;
      used.push(alias);
      imagery.push({
        word: alias,
        note: '诗中出现本城古称，坐标取今日城市中心作参照（WGS84）。',
        isGeographic: true,
        placeName: alias,
        coordinates: options.center,
      });
    }
  }

  for (const item of GENERIC_IMAGERY) {
    if (imagery.length >= 3) break;
    if (plain.includes(item.word) && !used.includes(item.word)) {
      imagery.push({ word: item.word, note: item.note, isGeographic: false });
    }
  }
  return imagery;
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
