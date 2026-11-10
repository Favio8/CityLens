/**
 * 模块生成器（PRD 3.4 / 3.5）。
 *
 * 一期提供：
 *  - MockGenerator：无 LLM Key 时使用，只能用本地快照/名录/诗词库组装，
 *    缺数据的模块抛 NO_FACTS（模块级失败），绝不虚构。
 *  - DeepSeekGenerator：阶段 6 接入。
 *
 * 生成器只允许选择实体，事实字段由本模块从本地产物回填。
 */
import type {
  ModuleName,
  SourceRef,
  VerificationStatus,
} from '../../shared/schema';
import { MODULE_DATA_SCHEMAS, PENDING } from '../../shared/schema';
import type { CityBrief } from '../db/cityRepo';
import { config } from '../config';
import type {
  FactSnapshot,
  Gazetteer,
  PoetryCorpus,
  RegistryRelic,
  RelicsRegistry,
} from './presetData';
import { getFactSnapshot, getGazetteer, getRelicsRegistry } from './presetData';
import {
  figureYear,
  formatRelicEra,
  relicFindSpot,
  relicMuseumOrSite,
  relicProtectionLevel,
  resolveEntityPlace,
} from './entityVerifier';
import {
  buildPoetryIndex,
  findPoemCandidates,
  getPoetryIndex,
  poemSourceRef,
  verifyPoemSelection,
} from './poetryVerifier';
import { DICTIONARY_SOURCE, DICTIONARY_SOURCE_ID } from './cacheService';

export class GenerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

export interface GenerateInput {
  city: CityBrief;
  module: ModuleName;
  aliases: string[];
  /** 测试注入；默认读取 server/data。 */
  snapshot?: FactSnapshot | null;
  registry?: RelicsRegistry | null;
  gazetteer?: Gazetteer | null;
  poetryCorpus?: PoetryCorpus | null;
}

export interface GeneratedModule {
  status: 'ok' | 'degraded';
  data: unknown;
  verification: VerificationStatus;
  sources: SourceRef[];
}

export interface ModuleGenerator {
  readonly name: string;
  /** 提示词版本，写入档案 meta.generator.promptVersion，便于追溯成卷口径。 */
  readonly promptVersion: string;
  generate(input: GenerateInput): Promise<GeneratedModule>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pendingString(): { value: string; sourceRefs: string[] } {
  return { value: PENDING, sourceRefs: [] };
}

function pendingNumber(): { value: string; unit?: string; statYear?: number; sourceRefs: string[] } {
  return { value: PENDING, sourceRefs: [] };
}

function snapshotSource(snapshot: FactSnapshot): SourceRef {
  return {
    id: snapshot.sourceRef.id,
    type: 'local_snapshot',
    title: snapshot.sourceRef.title,
    ...(snapshot.sourceRef.url ? { url: snapshot.sourceRef.url } : {}),
    retrievedAt: snapshot.sourceRef.retrievedAt,
  };
}

function buildIdentity(input: GenerateInput): GeneratedModule {
  const aliases = input.aliases.length > 0 ? input.aliases : [input.city.standardName];
  return {
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [DICTIONARY_SOURCE],
    data: {
      standardName: input.city.standardName,
      aliases,
      center: input.city.center,
      area: pendingNumber(),
      population: pendingNumber(),
      climateType: pendingString(),
      adminDivisions: pendingString(),
      oneLinePersona: PENDING,
      sourceRefs: [DICTIONARY_SOURCE_ID],
      verification: 'pending_human_review',
    },
  };
}

function buildLandmarks(input: GenerateInput): GeneratedModule {
  const snapshot = input.snapshot ?? getFactSnapshot(input.city.cityId);
  if (!snapshot || snapshot.landmarks.length === 0) {
    throw new GenerationError('NO_FACTS', '本地快照无可用景点实体');
  }
  const gazetteer = input.gazetteer ?? getGazetteer();
  const selected = snapshot.landmarks.slice(0, 6);
  const data = selected.map((landmark, index) => {
    const place = resolveEntityPlace(
      { name: landmark.name, coordinates: landmark.coordinates },
      input.city.cityId,
      input.city.center,
      gazetteer,
    );
    return {
      entityRef: landmark.entityId,
      name: landmark.name,
      category: index < 4 ? ('must_visit' as const) : ('hidden_gem' as const),
      bestSeason: PENDING,
      reason: `该地标来自 Wikidata 事实快照（${landmark.heritageDesignations.join('、') || '无文保身份记录'}）；推荐理由与最佳季节待人工复核补充。`,
      placeName: place.placeName,
      coordinates: place.coordinates,
      coordSource: place.coordSource,
      sourceRefs: [snapshot.sourceRef.id],
      verification: 'pending_human_review' as const,
    };
  });
  return {
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [snapshotSource(snapshot)],
    data,
  };
}

function buildRelics(input: GenerateInput): GeneratedModule {
  const registry = input.registry ?? getRelicsRegistry();
  if (!registry) throw new GenerationError('NO_FACTS', '缺少文物名录产物');
  const relics = registry.relics.filter((relic) => relic.cityId === input.city.cityId);
  if (relics.length === 0) throw new GenerationError('NO_FACTS', '本城文物名录为空');
  const gazetteer = input.gazetteer ?? getGazetteer();
  const usedSources = new Map<string, SourceRef>();
  const data = relics.slice(0, 6).map((relic: RegistryRelic) => {
    const place = resolveEntityPlace(
      { name: relic.name, coordinates: relic.coordinates },
      input.city.cityId,
      input.city.center,
      gazetteer,
    );
    for (const sourceId of relic.sourceRefs) {
      const source = registry.sources.find((item) => item.id === sourceId);
      if (source) {
        usedSources.set(sourceId, {
          id: source.id,
          type: source.type as SourceRef['type'],
          title: source.title,
          ...(source.url ? { url: source.url } : {}),
          retrievedAt: source.retrievedAt,
        });
      }
    }
    return {
      registryId: relic.registryId,
      name: relic.name,
      era: relic.era || formatRelicEra(null),
      museumOrSite: relicMuseumOrSite(relic),
      protectionLevel: relicProtectionLevel(relic),
      findSpot: relicFindSpot(relic),
      story: '该条目来自自建文物名录（全国重点文物保护单位 / 禁止出境展览文物），详情与馆藏说明待人工复核补充。',
      coordinates: place.coordinates,
      sourceRefs: relic.sourceRefs,
      verification: 'pending_human_review' as const,
    };
  });
  return {
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [...usedSources.values()],
    data,
  };
}

function buildFigures(input: GenerateInput): GeneratedModule {
  const snapshot = input.snapshot ?? getFactSnapshot(input.city.cityId);
  if (!snapshot || snapshot.figures.length === 0) {
    throw new GenerationError('NO_FACTS', '本地快照无可用人物实体');
  }
  const data = snapshot.figures.slice(0, 6).map((figure) => ({
    entityRef: figure.entityId,
    name: figure.name,
    dynasty: PENDING,
    birthYear: figureYear(figure.birthYear),
    deathYear: figureYear(figure.deathYear),
    relationType: figure.relationType,
    evidence: figure.evidence,
    cityBond: `与城市的关联来自 Wikidata 属性 ${figure.evidence.property}（${figure.evidence.value}），生平细节待人工复核。`,
    highlights: '当前仅保留可核验的城市关联属性，生平高光待人工复核补全。',
    sites: [],
    sourceRefs: [snapshot.sourceRef.id],
    verification: 'pending_human_review' as const,
  }));
  return {
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [snapshotSource(snapshot)],
    data,
  };
}

function buildPoetics(input: GenerateInput): GeneratedModule {
  const corpus = input.poetryCorpus;
  const index = corpus ? buildPoetryIndex(corpus) : getPoetryIndex();
  const candidates = findPoemCandidates(index, input.city.cityId, 5);
  if (candidates.length === 0) {
    throw new GenerationError('NO_FACTS', '本地诗词库无本城候选');
  }
  const sources: SourceRef[] = [];
  const poems = [];
  for (const candidate of candidates) {
    const verified = verifyPoemSelection(
      { poemId: candidate.poemId, background: PENDING, relationType: 'direct', imageryMap: [] },
      index,
      input.city.cityId,
    );
    if (verified.ok && verified.poem) {
      poems.push(verified.poem);
      sources.push(poemSourceRef(candidate));
    }
  }
  if (poems.length === 0) {
    throw new GenerationError('NO_FACTS', '诗词候选未通过逐字校验');
  }
  return {
    status: 'ok',
    verification: 'verified_by_source',
    sources,
    data: poems.slice(0, 5),
  };
}

/** 模拟 LLM：仅用本地事实产物组装，缺数据即失败。 */
export class MockGenerator implements ModuleGenerator {
  readonly name = 'mock-local-facts';
  readonly promptVersion = 'mock-v1';

  constructor(
    private readonly options: { delayMs?: number; failModules?: string[] } = {},
  ) {}

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    const failModules = this.options.failModules ?? config.simulateFail;
    if (failModules.includes(input.module)) {
      throw new GenerationError('LLM_TIMEOUT', `模拟失败：模块 ${input.module} 超时`);
    }
    const delay = this.options.delayMs ?? config.mockLlmDelayMs;
    if (delay > 0) await sleep(delay);

    switch (input.module) {
      case 'identity':
        return buildIdentity(input);
      case 'landmarks':
        return buildLandmarks(input);
      case 'relics':
        return buildRelics(input);
      case 'figures':
        return buildFigures(input);
      case 'poetics':
        return buildPoetics(input);
      case 'chronicle':
      case 'localSoul':
      case 'dataPulse':
        throw new GenerationError('NO_FACTS', `模拟模式缺少 ${input.module} 的可核验事实数据`);
      default:
        throw new GenerationError('UNKNOWN_MODULE', `未知模块 ${String(input.module)}`);
    }
  }
}

class NotImplementedGenerator implements ModuleGenerator {
  readonly name = 'deepseek-pending';
  readonly promptVersion = 'pending';

  async generate(): Promise<GeneratedModule> {
    throw new GenerationError('LLM_NOT_IMPLEMENTED', '真实 LLM 将在阶段 6 接入，请设置 MOCK_LLM=true');
  }
}

export function createGenerator(): ModuleGenerator {
  if (config.mockLlm) return new MockGenerator();
  return new NotImplementedGenerator();
}

/** 校验生成结果是否符合共享 Schema；失败即整模块失败。 */
export function validateModuleData(module: ModuleName, data: unknown): unknown {
  return MODULE_DATA_SCHEMAS[module].parse(data);
}
