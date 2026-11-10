/**
 * 持久化缓存服务（PRD 3.2 五 / 3.4 GET 接口）。
 * 命中缓存时绝不调用大模型；日志格式固定为 `[CACHE HIT] city_id=... latency=...ms`。
 */
import type {
  CityArchiveResponse,
  ModuleName,
  ModuleStatus,
} from '../../shared/schema';
import { MODULE_NAMES } from '../../shared/schema';
import { DEFAULT_THEME_PALETTE } from '../../shared/cityThemes';
import type { CityBrief } from '../db/cityRepo';
import type { ArchiveRecord, ArchiveRepo, ModuleRecord } from '../db/archiveRepo';

export { DEFAULT_THEME_PALETTE };

export interface ArchiveBundle {
  archive: ArchiveRecord;
  modules: Map<ModuleName, ModuleRecord>;
}

export function loadBundle(repo: ArchiveRepo, cityId: string): ArchiveBundle | null {
  const archive = repo.getArchive(cityId);
  if (!archive) return null;
  const modules = new Map<ModuleName, ModuleRecord>();
  for (const module of repo.listModules(cityId)) modules.set(module.name, module);
  return { archive, modules };
}

export function moduleStatusMap(bundle: ArchiveBundle): Record<ModuleName, ModuleStatus> {
  const result = {} as Record<ModuleName, ModuleStatus>;
  for (const name of MODULE_NAMES) {
    result[name] = bundle.modules.get(name)?.status ?? 'missing';
  }
  return result;
}

/** 组装 GET /api/cities/:cityId 的响应；未发布档案不对外提供。 */
export function buildArchiveResponse(
  city: CityBrief,
  bundle: ArchiveBundle,
  aliases: string[],
): CityArchiveResponse | null {
  if (bundle.archive.status === 'unpublished') return null;
  const status = moduleStatusMap(bundle);
  const data = (name: ModuleName): unknown => {
    const module = bundle.modules.get(name);
    if (!module) return null;
    if (module.status === 'failed' || module.status === 'missing') return null;
    return module.data;
  };
  return {
    fromCache: true,
    meta: {
      cityId: city.cityId,
      standardName: city.standardName,
      province: city.province,
      aliases: aliases.length > 0 ? aliases : [city.standardName],
      center: city.center,
      schemaVersion: bundle.archive.schemaVersion,
      dataVersion: bundle.archive.dataVersion,
      generatedAt: bundle.archive.generatedAt,
      status: bundle.archive.status,
      moduleStatus: status,
      generator: bundle.archive.generator,
      isPreset: bundle.archive.isPreset,
      themePalette: bundle.archive.themePalette,
    },
    identity: data('identity') as CityArchiveResponse['identity'],
    chronicle: data('chronicle') as CityArchiveResponse['chronicle'],
    landmarks: data('landmarks') as CityArchiveResponse['landmarks'],
    relics: data('relics') as CityArchiveResponse['relics'],
    figures: data('figures') as CityArchiveResponse['figures'],
    poetics: data('poetics') as CityArchiveResponse['poetics'],
    localSoul: data('localSoul') as CityArchiveResponse['localSoul'],
    dataPulse: data('dataPulse') as CityArchiveResponse['dataPulse'],
    sources: bundle.archive.sources,
  };
}

/** 已完成且通过校验的模块（ok/degraded）；未 force 时跳过。 */
export function reusableModules(bundle: ArchiveBundle | null): Set<ModuleName> {
  const result = new Set<ModuleName>();
  if (!bundle) return result;
  for (const name of MODULE_NAMES) {
    const status = bundle.modules.get(name)?.status;
    if (status === 'ok' || status === 'degraded') result.add(name);
  }
  return result;
}

export function cooldownSeconds(untilIso: string, now = Date.now()): number {
  const until = Date.parse(untilIso);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function logCacheHit(cityId: string, startedAt: number): void {
  const latency = Date.now() - startedAt;
  console.log(`[CACHE HIT] city_id=${cityId} latency=${latency}ms`);
}

/** 预置档案的默认占位源（仅在构架阶段使用，不用于事实）。 */
export const DICTIONARY_SOURCE_ID = 'S-DICT';
export const DICTIONARY_SOURCE = {
  id: DICTIONARY_SOURCE_ID,
  type: 'wikidata' as const,
  title: 'Wikidata 行政区划与坐标（构建期词典）',
  url: 'https://query.wikidata.org/sparql',
  retrievedAt: '2026-11-10T00:00:00.000Z',
};
