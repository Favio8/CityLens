/**
 * 真实性校验核心逻辑（PRD 3.2 / 5.3）。
 * 全部为纯函数，便于单元测试，也供 verify 脚本复用。
 */
import type { Coord, ChronicleItem, Poem, SourceRef } from './schema';
import { PENDING } from './schema';

const EARTH_RADIUS_KM = 6371.0088;

/** 检索词归一化：NFKC、小写、去空白与撇号/间隔号/连字符。 */
export function normalizeKey(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s'’‘`·・\-_.]/g, '');
}

/** 文本归一化（诗词逐字比对用）：NFKC + 去首尾空白，不做任何改写。 */
export function normalizeText(input: string): string {
  return input.normalize('NFKC').trim();
}

/** 诗词意象比对时允许忽略空白，但不得改动字序或字形。 */
export function normalizeForImagery(input: string): string {
  return normalizeText(input).replace(/\s+/g, '');
}

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 两点间球面距离（km），WGS84 经纬度。 */
export function haversineKm(a: Coord, b: Coord): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface CoordValidation {
  ok: boolean;
  distanceKm: number;
  reasons: string[];
}

/** 坐标边界校验：见 PRD 3.2 四.3，必须落在城市中心 180km 内。 */
export function validateCoord(
  coord: Coord | null | undefined,
  center: Coord,
  maxKm = 180,
): CoordValidation {
  if (!coord) return { ok: false, distanceKm: Number.POSITIVE_INFINITY, reasons: ['坐标缺失'] };
  const [lng, lat] = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return { ok: false, distanceKm: Number.POSITIVE_INFINITY, reasons: ['坐标非数值'] };
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return { ok: false, distanceKm: Number.POSITIVE_INFINITY, reasons: ['坐标越界'] };
  }
  const distanceKm = haversineKm(coord, center);
  const reasons: string[] = [];
  if (distanceKm > maxKm) reasons.push(`距离城市中心 ${distanceKm.toFixed(1)}km，超过 ${maxKm}km`);
  return { ok: reasons.length === 0, distanceKm, reasons };
}

/** 年份合法性：公元前为负数，年份 0 不存在。 */
export function validateYear(year: number): boolean {
  return Number.isInteger(year) && year !== 0 && year >= -3000 && year <= 2200;
}

/** 年份必须落在给定的史实区间内（含端点）。 */
export function validateYearInRange(year: number, startYear: number, endYear: number | null): boolean {
  if (!validateYear(year)) return false;
  if (year < startYear) return false;
  if (endYear !== null && year > endYear) return false;
  return true;
}

/** 统计值数量级校验（PRD 3.2 三：数量级常识）。 */
export const NUMERIC_BOUNDS = {
  areaKm2: { min: 50, max: 500_000 },
  populationWan: { min: 0.1, max: 5000 },
  gdpYi: { min: 0, max: 200_000 },
  tempC: { min: -40, max: 45 },
  precipMm: { min: 0, max: 4000 },
} as const;

export function validateNumericRange(value: number, bounds: { min: number; max: number }): boolean {
  return Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
}

/** sourceRefs 必须全部指向档案 sources 中真实存在的条目。 */
export function validateSourceRefs(
  refs: readonly string[],
  sources: readonly Pick<SourceRef, 'id'>[],
): { ok: boolean; missing: string[] } {
  const ids = new Set(sources.map((s) => s.id));
  const missing = [...new Set(refs.filter((r) => !ids.has(r)))];
  return { ok: missing.length === 0, missing };
}

/** 实体存在性：模型只能选择 Fact Context 中给出的候选。 */
export function validateEntitySelection<T extends { entityId: string }>(
  entityRef: string,
  candidates: readonly T[],
): { ok: boolean; entity: T | null } {
  const entity = candidates.find((c) => c.entityId === entityRef) ?? null;
  return { ok: entity !== null, entity };
}

export interface PoemCorpusEntry {
  poemId: string;
  title: string;
  author: string;
  dynasty: string;
  lines: string[];
}

export interface PoemValidation {
  ok: boolean;
  issues: string[];
}

/**
 * 诗词校验：标题、作者、朝代、lines 必须与本地诗词库逐字一致（PRD 3.2 三）。
 * lines 按句比对，忽略首尾空白，不改动任何字形与标点。
 */
export function validatePoemAgainstCorpus(
  poem: Pick<Poem, 'poemId' | 'title' | 'author' | 'dynasty' | 'lines'>,
  corpus: PoemCorpusEntry | undefined,
): PoemValidation {
  if (!corpus) return { ok: false, issues: [`诗词库中不存在 poemId=${poem.poemId}`] };
  const issues: string[] = [];
  if (poem.poemId !== corpus.poemId) issues.push('poemId 不一致');
  if (normalizeText(poem.title) !== normalizeText(corpus.title)) issues.push('标题与诗词库不一致');
  if (normalizeText(poem.author) !== normalizeText(corpus.author)) issues.push('作者与诗词库不一致');
  if (normalizeText(poem.dynasty) !== normalizeText(corpus.dynasty))
    issues.push('朝代与诗词库不一致');
  if (poem.lines.length !== corpus.lines.length) {
    issues.push(`诗句句数不一致（应为 ${corpus.lines.length} 句）`);
  } else {
    const mismatch = poem.lines.findIndex(
      (line, i) => normalizeText(line) !== normalizeText(corpus.lines[i] ?? ''),
    );
    if (mismatch >= 0) issues.push(`第 ${mismatch + 1} 句与诗词库不一致`);
  }
  return { ok: issues.length === 0, issues };
}

/** 意象词必须出现在归一化后的原文中；泛指意象不得带坐标。 */
export function validateImagery(
  imagery: readonly { word: string; isGeographic: boolean; coordinates?: Coord | null }[],
  lines: readonly string[],
): { ok: boolean; issues: string[] } {
  const plainText = normalizeForImagery(lines.join(''));
  const issues: string[] = [];
  for (const item of imagery) {
    const word = normalizeForImagery(item.word);
    if (!word || !plainText.includes(word)) {
      issues.push(`意象词「${item.word}」未出现在原文中`);
    }
    if (!item.isGeographic && item.coordinates) {
      issues.push(`泛指意象「${item.word}」不应带坐标`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/** 年表节点校验：年份升序、起止合法、与固定朝代年表一致。 */
export function validateChronicleOrder(
  nodes: readonly Pick<ChronicleItem, 'eraName' | 'startYear' | 'endYear'>[],
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  nodes.forEach((node, i) => {
    if (!validateYear(node.startYear)) issues.push(`第 ${i + 1} 个节点起始年份非法`);
    if (node.endYear !== null) {
      if (!validateYear(node.endYear)) issues.push(`第 ${i + 1} 个节点结束年份非法`);
      if (node.endYear < node.startYear) issues.push(`第 ${i + 1} 个节点结束早于开始`);
    }
    if (i > 0) {
      const prev = nodes[i - 1]!;
      if (node.startYear < prev.startYear) issues.push(`第 ${i + 1} 个节点年份未升序`);
    }
  });
  return { ok: issues.length === 0, issues };
}

/** 叙事中出现的具体年份必须出现在 Fact Context 允许的年份集合中（PRD 3.2 三·年表）。 */
export function extractYears(text: string): number[] {
  const years: number[] = [];
  const regex = /(公元前)?(\d{1,4})\s*年/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = Number(match[2]);
    if (!Number.isFinite(raw)) continue;
    years.push(match[1] ? -raw : raw);
  }
  return years;
}

export function validateNarrativeYears(
  text: string,
  allowedYears: ReadonlySet<number>,
): { ok: boolean; unknown: number[] } {
  const unknown = extractYears(text).filter((y) => !allowedYears.has(y) && y !== -1);
  return { ok: unknown.length === 0, unknown };
}

/** 发布规则：identity 通过且 ok 模块数 ≥ 5。 */
export function computeArchiveStatus(
  moduleStatus: Readonly<Record<string, string>>,
  attempted: readonly string[],
): 'complete' | 'partial' | 'unpublished' {
  const okCount = attempted.filter((m) => moduleStatus[m] === 'ok').length;
  if (moduleStatus.identity !== 'ok' || okCount < 5) return 'unpublished';
  return attempted.every((m) => moduleStatus[m] === 'ok') ? 'complete' : 'partial';
}

/** “待考”占位符判定。 */
export function isPending(value: unknown): value is typeof PENDING {
  return value === PENDING;
}
