/**
 * 持久化缓存服务（PRD 3.2 五 / 3.4 GET 接口）。
 * 命中缓存时绝不调用大模型；日志格式固定为 `[CACHE HIT] city_id=... latency=...ms`。
 */
import type {
  CityArchiveResponse,
  ModuleErrorCode,
  ModuleName,
  ModuleStatus,
} from '../../shared/schema';
import { MODULE_ERROR_CODES, MODULE_NAMES } from '../../shared/schema';
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
  // 最近一次生成尝试失败（内容可能仍可用）：随档案下发，让「旧内容 + 本次失败」同时可见。
  const moduleAttempts: NonNullable<CityArchiveResponse['meta']>['moduleAttempts'] = {};
  for (const name of MODULE_NAMES) {
    const record = bundle.modules.get(name);
    const attempt = latestAttempt(record);
    if (attempt) moduleAttempts[name] = attempt;
  }
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
      ...(Object.keys(moduleAttempts).length > 0 ? { moduleAttempts } : {}),
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
    const record = bundle.modules.get(name);
    const status = record?.status;
    // 最近一次生成尝试失败的模块即使有旧内容也要重试（单卷重试按钮依赖此口径）。
    if ((status === 'ok' || status === 'degraded') && !lastAttemptFailed(record)) {
      result.add(name);
    }
  }
  return result;
}

/** verification.lastAttempt.status === 'failed'：最近一次生成尝试失败（内容可能仍可用）。 */
export function lastAttemptFailed(module: ModuleRecord | undefined): boolean {
  if (!module) return false;
  const verification = module.verification as { lastAttempt?: { status?: string } } | null;
  return verification?.lastAttempt?.status === 'failed';
}

/** 取出规范的「最近一次失败尝试」记录；没有则返回 null。 */
export function latestAttempt(
  module: ModuleRecord | undefined,
): { status: 'failed'; code: ModuleErrorCode; message?: string; at: string } | null {
  if (!module) return null;
  const verification = module.verification as {
    status?: string;
    code?: string;
    message?: string;
    at?: string;
    lastAttempt?: { status?: string; code?: string; message?: string; at?: string };
  } | null;
  // 两种存储形态：保留旧内容的失败记在 verification.lastAttempt；
  // 无旧内容的失败把 attempt 直接作为 verification 根对象（markModuleFailed）。
  const attempt =
    verification?.lastAttempt ?? (verification?.status === 'failed' ? verification : null);
  if (attempt?.status !== 'failed' || typeof attempt.at !== 'string') return null;
  const code = MODULE_ERROR_CODES.includes(attempt.code as ModuleErrorCode)
    ? (attempt.code as ModuleErrorCode)
    : 'SCHEMA_INVALID';
  return {
    status: 'failed',
    code,
    ...(typeof attempt.message === 'string' ? { message: attempt.message } : {}),
    at: attempt.at,
  };
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
