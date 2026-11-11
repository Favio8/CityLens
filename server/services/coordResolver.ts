/**
 * 坐标解析器（PRD 3.2 四）。
 *
 * 解析顺序：本地地名库 → 天地图地名搜索（需 TIANDITU_KEY，硬超时 2500ms）→ null。
 * 所有坐标均为 WGS84 [lng, lat]。大模型给出的坐标一律不进入本解析器。
 * 解析结果必须通过 180km 边界校验与名称匹配，否则丢弃为 null。
 */
import type { Coord } from '../../shared/schema';
import { normalizeKey, validateCoord } from '../../shared/validators';
import { getActiveMapConfig } from './mapSettings';
import type { Gazetteer, GazetteerEntry } from './presetData';
import { getGazetteer } from './presetData';

export const REMOTE_TIMEOUT_MS = 2500;

export type ResolvedCoordSource =
  | 'local_gazetteer'
  | 'tianditu'
  | 'wikidata'
  | 'preset_manual'
  | 'city_center';

export interface CoordCandidate {
  name: string;
  coordinates: Coord;
  source: ResolvedCoordSource;
}

export interface ResolveResult {
  coordinates: Coord | null;
  coordSource: ResolvedCoordSource | 'none';
  matchedName: string | null;
  distanceKm: number | null;
  reasons: string[];
}

export interface CoordResolverDeps {
  gazetteer?: Gazetteer | null;
  /** 远程检索注入点（测试用）。返回空数组表示未命中。 */
  remoteSearch?: (name: string) => Promise<CoordCandidate[]>;
}

/** 名称匹配等级：0 完全一致，1 包含关系，2 不匹配。 */
function nameMatchLevel(query: string, candidate: string): number {
  const q = normalizeKey(query);
  const c = normalizeKey(candidate);
  if (!q || !c) return 2;
  if (q === c) return 0;
  const shorter = q.length <= c.length ? q : c;
  if (shorter.length < 2) return 2;
  return q.includes(c) || c.includes(q) ? 1 : 2;
}

/** 在本地地名库中检索同名地点，优先完全一致，其次包含关系且名称更短。 */
export function findGazetteerEntry(
  gazetteer: Gazetteer | null | undefined,
  cityId: string,
  placeName: string,
): { entry: GazetteerEntry; level: number } | null {
  if (!gazetteer) return null;
  let best: { entry: GazetteerEntry; level: number } | null = null;
  for (const entry of gazetteer.entries) {
    if (entry.cityId !== cityId) continue;
    const level = nameMatchLevel(placeName, entry.name);
    if (level === 2) continue;
    if (
      !best ||
      level < best.level ||
      (level === best.level && entry.name.length < best.entry.name.length)
    ) {
      best = { entry, level };
    }
  }
  return best;
}

/** 天地图 v2 地名搜索（GCJ-02 与 WGS84 在一期误差范围内，统一按 WGS84 记录来源）。 */
export async function tiandituSearch(
  name: string,
  cityId: string,
  center: Coord = [116.4, 39.9],
): Promise<CoordCandidate[]> {
  const map = getActiveMapConfig();
  const key = map.serverKey || map.browserKey;
  if (!key) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    // 天地图 v2 检索要求 level 与 mapBound；以城市中心 ±0.6° 作为检索范围。
    const pad = 0.6;
    const mapBound = `${center[0] - pad},${center[1] - pad},${center[0] + pad},${center[1] + pad}`;
    const postStr = JSON.stringify({
      keyWord: name,
      level: 12,
      mapBound,
      queryType: 1,
      start: 0,
      count: 10,
    });
    const url = `https://api.tianditu.gov.cn/v2/search?postStr=${encodeURIComponent(postStr)}&type=query&tk=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      pois?: Array<{ name?: string; lonlat?: string; address?: string }>;
    };
    return (body.pois ?? [])
      .map((poi): CoordCandidate | null => {
        const [lng, lat] = (poi.lonlat ?? '').split(',').map(Number);
        if (!poi.name || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
        return {
          name: poi.name,
          coordinates: [lng, lat] as Coord,
          source: 'tianditu',
        };
      })
      .filter((item): item is CoordCandidate => item !== null);
  } catch {
    // 在线检索失败不算错误（PRD 3.2 阶段 1），直接回退。
    return [];
  } finally {
    clearTimeout(timer);
    void cityId;
  }
}

function evaluate(
  candidate: CoordCandidate,
  placeName: string,
  center: Coord,
  maxKm: number,
): ResolveResult {
  const reasons: string[] = [];
  const matchLevel = nameMatchLevel(placeName, candidate.name);
  if (matchLevel === 2) reasons.push(`地名不匹配：${candidate.name}`);
  const check = validateCoord(candidate.coordinates, center, maxKm);
  if (!check.ok) reasons.push(...check.reasons);
  if (reasons.length > 0) {
    return {
      coordinates: null,
      coordSource: 'none',
      matchedName: candidate.name,
      distanceKm: Number.isFinite(check.distanceKm) ? check.distanceKm : null,
      reasons,
    };
  }
  return {
    coordinates: candidate.coordinates,
    coordSource: candidate.source,
    matchedName: candidate.name,
    distanceKm: check.distanceKm,
    reasons: [],
  };
}

/**
 * 解析地名坐标。
 * - 本地命中：source 取 local_gazetteer（城市中心条目取 city_center）。
 * - 本地未命中且允许在线：调用远程检索（默认天地图）。
 * - 全部失败：coordinates=null，coordSource='none'。
 */
export async function resolveCoord(
  input: { cityId: string; placeName: string; center: Coord; allowRemote?: boolean; maxKm?: number },
  deps: CoordResolverDeps = {},
): Promise<ResolveResult> {
  const { cityId, placeName, center, allowRemote = true, maxKm = 180 } = input;
  if (!placeName.trim()) {
    return {
      coordinates: null,
      coordSource: 'none',
      matchedName: null,
      distanceKm: null,
      reasons: ['地名为空'],
    };
  }

  const gazetteer = deps.gazetteer === undefined ? getGazetteer() : deps.gazetteer;
  const allReasons: string[] = [];
  const local = findGazetteerEntry(gazetteer, cityId, placeName);
  if (local) {
    const source: ResolvedCoordSource =
      local.entry.kind === 'city_center' ? 'city_center' : 'local_gazetteer';
    const result = evaluate(
      { name: local.entry.name, coordinates: local.entry.coordinates, source },
      placeName,
      center,
      maxKm,
    );
    if (result.coordinates) return result;
    allReasons.push(...result.reasons);
  }

  if (allowRemote) {
    const remote = deps.remoteSearch ?? (() => tiandituSearch(placeName, cityId, center));
    const candidates = await remote(placeName);
    for (const candidate of candidates) {
      const result = evaluate(candidate, placeName, center, maxKm);
      if (result.coordinates) return result;
      allReasons.push(...result.reasons);
    }
  }

  return {
    coordinates: null,
    coordSource: 'none',
    matchedName: null,
    distanceKm: null,
    reasons:
      allReasons.length > 0
        ? [...new Set(allReasons)]
        : [`未能在本地地名库或在线检索中解析「${placeName}」`],
  };
}

/** 同步版本：仅查本地地名库，用于不需要远程解析的预置数据构建。 */
export function resolveCoordLocal(
  gazetteer: Gazetteer | null | undefined,
  cityId: string,
  placeName: string,
  center: Coord,
  maxKm = 180,
): ResolveResult {
  const local = findGazetteerEntry(gazetteer, cityId, placeName);
  if (!local) {
    return {
      coordinates: null,
      coordSource: 'none',
      matchedName: null,
      distanceKm: null,
      reasons: [`本地地名库无「${placeName}」`],
    };
  }
  const source: ResolvedCoordSource =
    local.entry.kind === 'city_center' ? 'city_center' : 'local_gazetteer';
  return evaluate(
    { name: local.entry.name, coordinates: local.entry.coordinates, source },
    placeName,
    center,
    maxKm,
  );
}
