/**
 * 实体核验器（PRD 3.2 三·景点/文物/人物）。
 *
 * 实体名称、坐标、年代、馆藏归属等事实字段一律从快照/名录回填，
 * 模型只能选择 entityId / registryId 并撰写叙事。任何不在候选中的实体整条丢弃。
 */
import type { Coord } from '../../shared/schema';
import { PENDING } from '../../shared/schema';
import { validateCoord } from '../../shared/validators';
import { resolveCoordLocal, type CoordResolverDeps } from './coordResolver';
import type {
  FactSnapshot,
  Gazetteer,
  RegistryRelic,
  RelicsRegistry,
  SnapshotFigure,
  SnapshotLandmark,
  SnapshotRelic,
} from './presetData';

export interface EntityVerification<T> {
  ok: boolean;
  issues: string[];
  entity: T | null;
  /** 该实体可追溯的来源 ID（供档案 sources 使用）。 */
  sourceRefs: string[];
}

function fail<T>(issues: string[]): EntityVerification<T> {
  return { ok: false, issues, entity: null, sourceRefs: [] };
}

/** 景点：必须存在于本城快照（景点或文物实体均可作为地标候选）。 */
export function verifyLandmark(
  entityRef: string,
  snapshot: FactSnapshot | null,
): EntityVerification<SnapshotLandmark> {
  if (!snapshot) return fail(['本城缺少事实快照']);
  const entity = snapshot.landmarks.find((item) => item.entityId === entityRef) ?? null;
  if (!entity) return fail([`快照中不存在景点实体 entityId=${entityRef}`]);
  return { ok: true, issues: [], entity, sourceRefs: [snapshot.sourceRef.id] };
}

/** 文物：registryId 必须存在于自建名录，且属于本城。 */
export function verifyRelic(
  registryId: string,
  registry: RelicsRegistry | null,
  cityId: string,
): EntityVerification<RegistryRelic> {
  if (!registry) return fail(['缺少文物名录产物 relics_registry.json']);
  const entity = registry.relics.find((item) => item.registryId === registryId) ?? null;
  if (!entity) return fail([`文物名录中不存在 registryId=${registryId}`]);
  if (entity.cityId !== cityId) {
    return fail([`文物 ${registryId} 属于 ${entity.cityId}，不得归入本城`]);
  }
  if (entity.sourceRefs.length === 0) return fail(['文物缺少可追溯来源']);
  return { ok: true, issues: [], entity, sourceRefs: entity.sourceRefs };
}

/** 人物：必须存在于本城快照，且关联属性可核验。 */
export function verifyFigure(
  entityRef: string,
  snapshot: FactSnapshot | null,
): EntityVerification<SnapshotFigure> {
  if (!snapshot) return fail(['本城缺少事实快照']);
  const entity = snapshot.figures.find((item) => item.entityId === entityRef) ?? null;
  if (!entity) return fail([`快照中不存在人物实体 entityId=${entityRef}`]);
  if (!entity.evidence?.property || !entity.evidence?.value) {
    return fail(['人物缺少与城市的关联证据']);
  }
  return { ok: true, issues: [], entity, sourceRefs: [snapshot.sourceRef.id] };
}

/** 快照中带文保属性的实体也可作为文物候选（不含坐标时坐标交给解析器）。 */
export function verifySnapshotRelicAsRelic(
  entityRef: string,
  snapshot: FactSnapshot | null,
): EntityVerification<SnapshotRelic> {
  if (!snapshot) return fail(['本城缺少事实快照']);
  const entity = snapshot.relics.find((item) => item.entityId === entityRef) ?? null;
  if (!entity) return fail([`快照中不存在文物实体 entityId=${entityRef}`]);
  return { ok: true, issues: [], entity, sourceRefs: [snapshot.sourceRef.id] };
}

export interface ResolvedEntityPlace {
  name: string;
  placeName: string;
  coordinates: Coord | null;
  coordSource: 'local_gazetteer' | 'wikidata' | 'preset_manual' | 'city_center';
  distanceKm: number | null;
  reasons: string[];
}

/**
 * 回填实体坐标：本地地名库优先；未命中时若实体自身带 Wikidata 坐标且通过 180km 校验，
 * 则记为 wikidata 来源；否则为 null（前端标“全域印记”）。
 */
export function resolveEntityPlace(
  entity: { name: string; coordinates: Coord | null },
  cityId: string,
  center: Coord,
  gazetteer: Gazetteer | null,
  deps: CoordResolverDeps = {},
): ResolvedEntityPlace {
  const local = resolveCoordLocal(
    deps.gazetteer === undefined ? gazetteer : deps.gazetteer,
    cityId,
    entity.name,
    center,
  );
  if (local.coordinates) {
    return {
      name: entity.name,
      placeName: local.matchedName ?? entity.name,
      coordinates: local.coordinates,
      coordSource: local.coordSource === 'city_center' ? 'city_center' : 'local_gazetteer',
      distanceKm: local.distanceKm,
      reasons: [],
    };
  }
  if (entity.coordinates) {
    const check = validateCoord(entity.coordinates, center);
    if (check.ok) {
      return {
        name: entity.name,
        placeName: entity.name,
        coordinates: entity.coordinates,
        coordSource: 'wikidata',
        distanceKm: check.distanceKm,
        reasons: [],
      };
    }
    return {
      name: entity.name,
      placeName: entity.name,
      coordinates: null,
      coordSource: 'wikidata',
      distanceKm: check.distanceKm,
      reasons: check.reasons,
    };
  }
  return {
    name: entity.name,
    placeName: entity.name,
    coordinates: null,
    coordSource: 'local_gazetteer',
    distanceKm: null,
    reasons: ['无可用坐标'],
  };
}

/** 生卒年缺失统一为“待考”，保留公元前负数。 */
export function figureYear(value: number | null | undefined): number | typeof PENDING {
  return typeof value === 'number' && Number.isInteger(value) && value !== 0 ? value : PENDING;
}

/** 文物年代缺失为“待考”，有值则格式化为公元纪年。 */
export function formatRelicEra(inceptionYear: number | null): string {
  if (inceptionYear === null || inceptionYear === 0) return PENDING;
  return inceptionYear < 0 ? `公元前${Math.abs(inceptionYear)}年` : `公元${inceptionYear}年`;
}

export function relicFindSpot(relic: RegistryRelic): string {
  return relic.findSpot.trim() ? relic.findSpot : PENDING;
}

export function relicMuseumOrSite(relic: RegistryRelic): string {
  return relic.museumOrSite.trim() ? relic.museumOrSite : PENDING;
}

export function relicProtectionLevel(relic: RegistryRelic): string {
  return relic.protectionLevel.trim() ? relic.protectionLevel : PENDING;
}
