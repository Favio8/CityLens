/**
 * 「如果只有一天」一日路线服务（P2-20）。
 * 从档案的景点 / 文物中选取有坐标的点位，按与市中心距离分为上午 / 下午 / 晚上。
 * 档案尚未生成时回退 Wikidata 事实快照（本地优先、按需抓取），
 * 让路线工具不依赖 LLM 成卷即可覆盖全部词典城市。
 * 只输出示意路线，不订票、不承诺营业时间；点位不足 4 个时标 degraded。
 */
import type { Coord, DayTrip, DayTripStop } from '../../shared/schema';
import { LandmarksSchema, RelicsSchema } from '../../shared/schema';
import { haversineKm } from '../../shared/validators';
import type { ArchiveBundle } from './cacheService';
import type { CityBrief } from '../db/cityRepo';
import type { FactSnapshot } from './presetData';

interface Candidate {
  name: string;
  placeName: string;
  coordinates: Coord;
  coordSource: DayTripStop['coordSource'];
  category: string;
  sourceRefs: string[];
}

function collectCandidates(bundle: ArchiveBundle): Candidate[] {
  const candidates: Candidate[] = [];
  const landmarks = LandmarksSchema.safeParse(bundle.modules.get('landmarks')?.data);
  if (landmarks.success) {
    for (const item of landmarks.data) {
      if (!item.coordinates) continue;
      candidates.push({
        name: item.name,
        placeName: item.placeName,
        coordinates: item.coordinates,
        coordSource: item.coordSource,
        category: item.category === 'hidden_gem' ? '小众秘境' : '必去地标',
        sourceRefs: item.sourceRefs,
      });
    }
  }
  const relics = RelicsSchema.safeParse(bundle.modules.get('relics')?.data);
  if (relics.success) {
    for (const item of relics.data) {
      if (!item.coordinates) continue;
      candidates.push({
        name: item.name,
        placeName: item.name,
        coordinates: item.coordinates,
        coordSource: 'local_gazetteer',
        category: '文物遗迹',
        sourceRefs: item.sourceRefs,
      });
    }
  }
  return candidates;
}

/** 快照回退源：Wikidata 景点 + 文物（快照的 landmarks 已合并带坐标的文物，按名去重即可）。 */
function collectCandidatesFromSnapshot(snapshot: FactSnapshot): Candidate[] {
  const candidates: Candidate[] = [];
  for (const item of snapshot.landmarks) {
    if (!item.coordinates) continue;
    candidates.push({
      name: item.name,
      placeName: item.name,
      coordinates: item.coordinates,
      coordSource: 'wikidata',
      category: item.kind || '待考',
      sourceRefs: [snapshot.sourceRef.id],
    });
  }
  for (const relic of snapshot.relics) {
    if (!relic.coordinates) continue;
    candidates.push({
      name: relic.name,
      placeName: relic.name,
      coordinates: relic.coordinates,
      coordSource: 'wikidata',
      category: '文物遗迹',
      sourceRefs: [snapshot.sourceRef.id],
    });
  }
  return candidates;
}

/** 按距离分三档：上午最近（体力好）、下午居中、晚上最远（归程顺路）。 */
function assignSlots(count: number): DayTripStop['slot'][] {
  const morning = Math.ceil(count / 3);
  const afternoon = Math.ceil((count - morning) / 2);
  const slots: DayTripStop['slot'][] = [];
  for (let index = 0; index < count; index += 1) {
    if (index < morning) slots.push('morning');
    else if (index < morning + afternoon) slots.push('afternoon');
    else slots.push('evening');
  }
  return slots;
}

export function buildDayTrip(
  city: CityBrief,
  bundle: ArchiveBundle | null,
  snapshot?: FactSnapshot | null,
): DayTrip {
  const unique = new Map<string, Candidate>();
  let fromSnapshot = false;
  if (bundle) {
    for (const candidate of collectCandidates(bundle)) {
      if (!unique.has(candidate.name)) unique.set(candidate.name, candidate);
    }
  }
  // 无档案或档案无坐标点位时，回退 Wikidata 快照（实时层不依赖 LLM 成卷）。
  if (unique.size === 0 && snapshot) {
    for (const candidate of collectCandidatesFromSnapshot(snapshot)) {
      if (!unique.has(candidate.name)) unique.set(candidate.name, candidate);
    }
    fromSnapshot = unique.size > 0;
  }
  const sorted = [...unique.values()]
    .map((candidate) => ({ candidate, km: haversineKm(city.center, candidate.coordinates) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 6)
    .map((entry) => entry.candidate);

  const slots = assignSlots(sorted.length);
  const stops: DayTripStop[] = sorted.map((candidate, index) => ({
    name: candidate.name,
    placeName: candidate.placeName,
    coordinates: candidate.coordinates,
    coordSource: candidate.coordSource,
    slot: slots[index] ?? 'evening',
    category: candidate.category,
    sourceRefs: candidate.sourceRefs,
  }));

  return {
    cityId: city.cityId,
    cityName: city.standardName,
    stops,
    degraded: stops.length < 4,
    notice: fromSnapshot
      ? '示意路线，非导航：按与市中心距离分为上午 / 下午 / 晚上；点位取自 Wikidata 事实快照（未经人工整理），不提供订票，营业时间未知一律「待考」。'
      : '示意路线，非导航：按与市中心距离分为上午 / 下午 / 晚上；不提供订票，营业时间未知一律「待考」。',
    generatedAt: new Date().toISOString(),
  };
}
