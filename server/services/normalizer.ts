import * as OpenCC from 'opencc-js';
import type { CityBrief } from '../db/cityRepo';

type Converter = (text: string) => string;
let converter: Converter | null = null;

/** 繁转简（用于检索归一，不改变任何入库原文）。 */
export function toSimplified(text: string): string {
  if (!converter) {
    const factory = (OpenCC as unknown as { Converter: (opts: { from: string; to: string }) => Converter })
      .Converter;
    converter = factory({ from: 'tw', to: 'cn' });
  }
  return converter(text);
}

/**
 * 城市名规范化与消歧（PRD 2.2 / 5.4）。
 * 纯逻辑依赖注入仓储接口，便于单元测试。
 */
export interface AliasRecord {
  aliasKey: string;
  displayAlias: string | null;
  cityId: string;
  matchType: string;
  hint: string | null;
  standardName: string;
  province: string;
  summary: string | null;
  englishName?: string | null;
}

export interface NormalizerRepo {
  findAliases(keys: string[]): AliasRecord[];
  listCities(): CityBrief[];
}

export interface SearchCandidateOut {
  cityId: string;
  name: string;
  province: string;
  matchedAlias: string;
  matchType: 'standard' | 'ancient' | 'pinyin' | 'english' | 'district_hint' | 'typo';
  summary: string | null;
  englishName?: string | null;
}

export interface SearchResultOut {
  status: 'exact' | 'ambiguous' | 'none';
  candidates: SearchCandidateOut[];
  hint?: string;
}

export class InvalidQueryError extends Error {
  readonly code = 'INVALID_QUERY';
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQueryError';
  }
}

export const MAX_QUERY_LENGTH = 30;

/** 允许：汉字、拉丁字母、数字、空格、撇号、间隔号、连字符、点。 */
const ALLOWED_QUERY = /^[\p{Script=Han}A-Za-z0-9\s'’‘·.\-]+$/u;

/** 形近字混淆对：仅对白名单中的字形差异做自动纠正，避免误伤同音城市。 */
const CONFUSION_PAIRS = new Set(['毫亳', '亳毫', '洲州', '州洲', '荷菏', '菏荷']);

const MATCH_PRIORITY: Record<string, number> = {
  typo: 0,
  district_hint: 1,
  ancient: 2,
  standard: 3,
  english: 4,
  pinyin: 5,
};

export function normalizeKey(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s'’‘`·・\-_.]/g, '');
}

export function assertValidQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new InvalidQueryError('请输入城市名、古称或拼音');
  if ([...trimmed].length > MAX_QUERY_LENGTH) {
    throw new InvalidQueryError(`检索词不能超过 ${MAX_QUERY_LENGTH} 个字符`);
  }
  if (!ALLOWED_QUERY.test(trimmed)) {
    throw new InvalidQueryError('检索词包含不支持的字符');
  }
  return trimmed;
}

function toCandidate(row: AliasRecord): SearchCandidateOut {
  return {
    cityId: row.cityId,
    name: row.standardName,
    province: row.province,
    matchedAlias: row.displayAlias ?? row.aliasKey,
    matchType: row.matchType as SearchCandidateOut['matchType'],
    summary: row.summary,
    englishName: row.englishName ?? null,
  };
}

function pickBestPerCity(
  rows: ReturnType<NormalizerRepo['findAliases']>,
): Map<string, (typeof rows)[number]> {
  const best = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const current = best.get(row.cityId);
    if (!current) {
      best.set(row.cityId, row);
      continue;
    }
    const a = MATCH_PRIORITY[row.matchType] ?? 99;
    const b = MATCH_PRIORITY[current.matchType] ?? 99;
    if (a < b) best.set(row.cityId, row);
  }
  return best;
}

/** 形近字纠正：等长、仅一处不同，且差异字对在白名单内。 */
function findConfusionCorrection(raw: string, cities: CityBrief[]): CityBrief | null {
  const query = toSimplified(raw);
  const matches = cities.filter((city) => {
    if (city.standardName.length !== query.length) return false;
    let diff = -1;
    for (let i = 0; i < query.length; i += 1) {
      if (query[i] === city.standardName[i]) continue;
      if (diff !== -1) return false;
      diff = i;
    }
    if (diff === -1) return false;
    return CONFUSION_PAIRS.has(`${query[diff]}${city.standardName[diff]}`);
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function normalizeQuery(raw: string, repo: NormalizerRepo): SearchResultOut {
  const trimmed = assertValidQuery(raw);
  const simplified = toSimplified(trimmed);
  const keys = [...new Set([normalizeKey(trimmed), normalizeKey(simplified)])].filter(Boolean);

  const rows = repo.findAliases(keys);
  if (rows.length > 0) {
    const best = pickBestPerCity(rows);
    const list = [...best.values()];
    if (list.length > 1) {
      return {
        status: 'ambiguous',
        candidates: list
          .map(toCandidate)
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
      };
    }
    const row = list[0]!;
    const result: SearchResultOut = {
      status: 'exact',
      candidates: [toCandidate(row)],
    };
    if (row.hint) result.hint = row.hint;
    return result;
  }

  const correction = findConfusionCorrection(simplified, repo.listCities());
  if (correction) {
    return {
      status: 'exact',
      candidates: [
        {
          cityId: correction.cityId,
          name: correction.standardName,
          province: correction.province,
          matchedAlias: correction.standardName,
          matchType: 'typo',
          summary: correction.summary,
          englishName: correction.englishName,
        },
      ],
      hint: `已为你纠正为「${correction.standardName}」`,
    };
  }

  return { status: 'none', candidates: [] };
}
