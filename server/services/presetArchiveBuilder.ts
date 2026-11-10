/**
 * 预置档案构建器：把本地构建期产物（Wikidata 快照、文物名录、诗词库、朝代年表）
 * 与人工资讯整理稿组装成六座城市的完整档案。
 *
 * 说明：统计数值（面积/人口）与气候、行政区划暂无本地可核验来源，一律填「待考」；
 * 数据脉搏缺少可核验的统计序列，暂不生成该模块，档案状态为 partial。
 */
import type {
  ModuleName,
  ModuleStatus,
  SourceRef,
  VerificationStatus,
} from '../../shared/schema';
import { PENDING } from '../../shared/schema';
import type { CityBrief } from '../db/cityRepo';
import { DICTIONARY_SOURCE, DICTIONARY_SOURCE_ID } from './cacheService';
import { collectSourceRefs } from './jobManager';
import { MockGenerator, type GeneratedModule, validateModuleData } from './llmGenerator';
import { DYNASTY_SOURCE, getDynasties } from './presetData';
import { PRESET_CURATIONS } from './presetCurations';

export const PRESET_MANUAL_SOURCE: SourceRef = {
  id: 'S-PRESET-MANUAL',
  type: 'preset_manual',
  title: 'CityLens 预置城市人工整理稿（待复核）',
  retrievedAt: '2026-11-10T00:00:00.000Z',
};

export const PRESET_DYNASTY_SOURCE = DYNASTY_SOURCE;

export interface PresetModule {
  name: ModuleName;
  status: Exclude<ModuleStatus, 'missing'>;
  data: unknown;
  verification: VerificationStatus;
  sources: SourceRef[];
}

export interface PresetBundle {
  modules: PresetModule[];
  sources: SourceRef[];
  missing: ModuleName[];
}

const FACT_MODULES: ModuleName[] = ['landmarks', 'relics', 'figures', 'poetics'];

function pendingString(): Record<string, unknown> {
  return { value: PENDING, sourceRefs: [] };
}

function pendingNumber(): Record<string, unknown> {
  return { value: PENDING, sourceRefs: [] };
}

function buildIdentity(
  city: CityBrief,
  aliases: string[],
  persona: string,
): PresetModule {
  return {
    name: 'identity',
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [DICTIONARY_SOURCE, PRESET_MANUAL_SOURCE],
    data: {
      standardName: city.standardName,
      aliases: aliases.length > 0 ? aliases : [city.standardName],
      center: city.center,
      area: pendingNumber(),
      population: pendingNumber(),
      climateType: pendingString(),
      adminDivisions: pendingString(),
      oneLinePersona: persona,
      sourceRefs: [DICTIONARY_SOURCE_ID, PRESET_MANUAL_SOURCE.id],
      verification: 'pending_human_review',
    },
  };
}

function assertCuration(cityId: string) {
  const curation = PRESET_CURATIONS[cityId];
  if (!curation) throw new Error(`[preset] 缺少 ${cityId} 的人工整理稿`);
  return curation;
}

function buildChronicle(cityId: string): PresetModule {
  const curation = assertCuration(cityId);
  const dynasties = getDynasties();
  const data = curation.chronicle.map((entry) => {
    const dynasty = dynasties?.dynasties.find((item) => item.name === entry.eraName);
    if (!dynasty) {
      throw new Error(`[preset] ${cityId} 年代条目 ${entry.eraName} 不在本地朝代年表中`);
    }
    if (dynasty.startYear !== entry.startYear) {
      throw new Error(
        `[preset] ${cityId} ${entry.eraName} 起始年 ${entry.startYear} 与年表 ${dynasty.startYear} 不一致`,
      );
    }
    return {
      eraName: entry.eraName,
      ...(entry.epithet ? { epithet: entry.epithet } : {}),
      startYear: entry.startYear,
      endYear: entry.endYear,
      periodRange: entry.periodRange,
      ancientCityName: entry.ancientCityName,
      keyEvents: entry.keyEvents,
      relicToday: entry.relicToday,
      centerCoord: null,
      sourceRefs: [PRESET_MANUAL_SOURCE.id, PRESET_DYNASTY_SOURCE.id],
      verification: 'preset_manual',
    };
  });
  return {
    name: 'chronicle',
    status: 'degraded',
    verification: 'preset_manual',
    sources: [PRESET_MANUAL_SOURCE, PRESET_DYNASTY_SOURCE, DICTIONARY_SOURCE],
    data,
  };
}

function buildLocalSoul(cityId: string): PresetModule {
  const soul = assertCuration(cityId).localSoul;
  return {
    name: 'localSoul',
    status: 'degraded',
    verification: 'preset_manual',
    sources: [PRESET_MANUAL_SOURCE],
    data: {
      aiCurated: true,
      foods: soul.foods,
      dialects: soul.dialects,
      ichItems: soul.ichItems.map((item) => ({
        ...item,
        sourceRefs: [PRESET_MANUAL_SOURCE.id],
      })),
      festivals: soul.festivals,
    },
  };
}

/**
 * 组装一座预置城市的全部可生成模块。
 * 事实模块复用 MockGenerator 的本地产物装配逻辑，保证与运行期口径一致。
 */
export async function buildPresetBundle(
  city: CityBrief,
  aliases: string[],
): Promise<PresetBundle> {
  const curation = assertCuration(city.cityId);

  const generator = new MockGenerator({ delayMs: 0 });
  const modules: PresetModule[] = [
    buildIdentity(city, aliases, curation.persona),
    buildChronicle(city.cityId),
    buildLocalSoul(city.cityId),
  ];
  const missing: ModuleName[] = ['dataPulse'];

  for (const name of FACT_MODULES) {
    try {
      const generated: GeneratedModule = await generator.generate({
        city,
        module: name,
        aliases,
      });
      modules.push({
        name,
        status: generated.status,
        data: generated.data,
        verification: generated.verification,
        sources: generated.sources,
      });
    } catch (error) {
      missing.push(name);
      console.warn(
        `[preset] ${city.cityId} 跳过 ${name}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const sources = new Map<string, SourceRef>();
  for (const source of [DICTIONARY_SOURCE, PRESET_MANUAL_SOURCE, PRESET_DYNASTY_SOURCE]) {
    sources.set(source.id, source);
  }
  for (const module of modules) {
    for (const source of module.sources) sources.set(source.id, source);
  }

  return { modules, sources: [...sources.values()], missing };
}

/** 校验每卷数据与来源引用完整性；任何问题都抛错，避免把坏数据写进档案。 */
export function assertPresetBundle(bundle: PresetBundle, cityId: string): void {
  for (const module of bundle.modules) {
    validateModuleData(module.name, module.data);
    const used = collectSourceRefs(module.data);
    for (const id of used) {
      if (!bundle.sources.some((source) => source.id === id)) {
        throw new Error(`[preset] ${cityId} ${module.name} 引用了未登记的来源 ${id}`);
      }
    }
  }
}
