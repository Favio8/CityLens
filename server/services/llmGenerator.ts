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
import { ZodError } from 'zod';
import type {
  ModuleName,
  SourceRef,
  VerificationStatus,
} from '../../shared/schema';
import { MODULE_DATA_SCHEMAS, PENDING } from '../../shared/schema';
import { validateNarrativeYears } from '../../shared/validators';
import type { CityBrief } from '../db/cityRepo';
import { config } from '../config';
import type {
  FactSnapshot,
  Gazetteer,
  PoetryCorpus,
  RegistryRelic,
  RelicsRegistry,
  SnapshotFigure,
} from './presetData';
import {
  DYNASTY_SOURCE,
  getDynasties,
  getFactSnapshot,
  getGazetteer,
  getRelicImages,
  getRelicsRegistry,
} from './presetData';
import {
  figureYear,
  formatRelicEra,
  relicFindSpot,
  relicMuseumOrSite,
  relicProtectionLevel,
  resolveChronicleAnchor,
  resolveEntityPlace,
} from './entityVerifier';
import {
  buildPoetryIndex,
  createTitleDeduplicator,
  deriveImagery,
  findPoemCandidates,
  getPoetryIndex,
  poemSourceRef,
  selectDiversePoems,
  verifyPoemSelection,
} from './poetryVerifier';
import { DICTIONARY_SOURCE, DICTIONARY_SOURCE_ID } from './cacheService';
import {
  envLlmConfig,
  type LlmRuntimeConfig,
  type LlmSettingsService,
} from './llmSettings';

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
  const imageIndex = config.enableImages ? getRelicImages() : null;
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
    const images = (imageIndex?.records ?? [])
      .filter((record) => record.registryId === relic.registryId)
      .map((record) => ({
        url: record.path,
        credit: record.credit,
        license: record.license,
        sourceUrl: record.sourceUrl,
      }));
    return {
      registryId: relic.registryId,
      name: relic.name,
      era: relic.era || formatRelicEra(null),
      museumOrSite: relicMuseumOrSite(relic),
      protectionLevel: relicProtectionLevel(relic),
      findSpot: relicFindSpot(relic),
      story: '该条目来自自建文物名录（全国重点文物保护单位 / 禁止出境展览文物），详情与馆藏说明待人工复核补充。',
      coordinates: place.coordinates,
      ...(images.length > 0 ? { images } : {}),
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

/** 人物遗迹：仅当关联证据是地名（籍贯/卒地/任职地）且能在地名库解析时生成坐标。 */
function buildFigureSites(
  figure: SnapshotFigure,
  city: CityBrief,
  gazetteer: Gazetteer | null,
): Array<{ placeName: string; coordinates: [number, number] }> {
  const placeProperties = new Set(['birthplace', 'deathplace', 'workplace']);
  if (!placeProperties.has(figure.evidence.property)) return [];
  const placeName = figure.evidence.value.trim();
  if (!placeName) return [];
  const place = resolveEntityPlace(
    { name: placeName, coordinates: null },
    city.cityId,
    city.center,
    gazetteer,
  );
  return place.coordinates
    ? [{ placeName, coordinates: place.coordinates }]
    : [];
}

function buildFigures(input: GenerateInput): GeneratedModule {
  const snapshot = input.snapshot ?? getFactSnapshot(input.city.cityId);
  if (!snapshot || snapshot.figures.length === 0) {
    throw new GenerationError('NO_FACTS', '本地快照无可用人物实体');
  }
  const gazetteer = input.gazetteer ?? getGazetteer();
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
    sites: buildFigureSites(figure, input.city, gazetteer),
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
  const ranked = findPoemCandidates(index, input.city.cityId, 20);
  if (ranked.length === 0) {
    throw new GenerationError('NO_FACTS', '本地诗词库无本城候选');
  }
  const candidates = selectDiversePoems(ranked, 5);
  const sources: SourceRef[] = [];
  const poems = [];
  for (const candidate of candidates) {
    const verified = verifyPoemSelection(
      {
        poemId: candidate.poemId,
        background: PENDING,
        relationType: 'direct',
        imageryMap: deriveImagery(
          candidate,
          input.city.cityId,
          input.gazetteer ?? getGazetteer(),
          { aliases: input.aliases, center: input.city.center },
        ),
      },
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

/* -------------------------------------------------------------------------- */
/* 真实 LLM：DeepSeek 兼容接口                                                 */
/* -------------------------------------------------------------------------- */

const LLM_SOURCE_ID = 'S-LLM-CURATION';
/** 当前生效的大模型配置；每次生成开始时由 DeepSeekGenerator 写入。 */
let activeLlmConfig: LlmRuntimeConfig = envLlmConfig();

const PROVIDER_LABELS: Record<LlmRuntimeConfig['provider'], string> = {
  deepseek: 'DeepSeek',
  stepfun: '阶跃星辰',
  custom: '自定义 LLM',
};

function llmSource(): SourceRef {
  return {
    id: LLM_SOURCE_ID,
    type: 'llm_curation',
    title: `${PROVIDER_LABELS[activeLlmConfig.provider]} 结构化整理（${activeLlmConfig.model}）`,
    retrievedAt: '2026-11-10T00:00:00.000Z',
  };
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const SYSTEM_PROMPT =
  '你是 CityLens 的城市方志整理员。只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。' +
  '严格使用给定候选清单中的 id、名称与年份；不得编造坐标、年代、统计数值或候选之外的实体。' +
  '无法确认的内容写「待考」。';

/** 以 fetch + SSE 流式读取 OpenAI 兼容接口，返回完整文本。 */
async function callDeepSeek(messages: ChatMessage[]): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), activeLlmConfig.timeoutMs);
  try {
    const response = await fetch(`${activeLlmConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${activeLlmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: activeLlmConfig.model,
        stream: true,
        temperature: 0.3,
        messages,
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new GenerationError('LLM_HTTP_ERROR', `大模型接口返回 ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          buffer = '';
          break;
        }
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          content += chunk.choices?.[0]?.delta?.content ?? '';
        } catch {
          // 忽略心跳/非 JSON 行
        }
      }
    }
    if (content.trim().length === 0) {
      throw new GenerationError('LLM_EMPTY', '大模型未返回内容');
    }
    return content;
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new GenerationError('LLM_TIMEOUT', '大模型响应超时');
    }
    throw new GenerationError('LLM_NETWORK', `大模型请求失败：${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new GenerationError('LLM_OUTPUT_INVALID', '大模型未返回 JSON 对象');
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new GenerationError('LLM_OUTPUT_INVALID', '大模型返回的 JSON 无法解析');
  }
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function llmIdentity(input: GenerateInput): Promise<GeneratedModule> {
  const text = await callDeepSeek([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `城市：${input.city.standardName}（${input.city.province}）。` +
        '请用 8-60 个字写一句城市人格，概括它的气质，不要罗列数据或景点。' +
        '只输出 {"oneLinePersona":"..."}。',
    },
  ]);
  const parsed = parseJsonObject(text);
  const persona = asText(parsed.oneLinePersona);
  if (persona.length < 8 || persona.length > 60) {
    throw new GenerationError('LLM_OUTPUT_INVALID', '城市人格长度不符合 8-60 字');
  }
  const base = buildIdentity(input);
  return {
    ...base,
    sources: [...base.sources, llmSource()],
    data: {
      ...(base.data as Record<string, unknown>),
      oneLinePersona: persona,
      sourceRefs: [DICTIONARY_SOURCE_ID, llmSource().id],
    },
  };
}

async function llmChronicle(input: GenerateInput): Promise<GeneratedModule> {
  const dynasties = getDynasties();
  if (!dynasties || dynasties.dynasties.length === 0) {
    throw new GenerationError('NO_FACTS', '缺少本地朝代年表');
  }
  const table = dynasties.dynasties
    .map((dynasty) => `${dynasty.name}(${dynasty.startYear},${dynasty.endYear ?? 'null'})`)
    .join('、');
  const text = await callDeepSeek([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `城市：${input.city.standardName}。本地朝代年表：${table}。` +
        '请挑选 3-5 个与本城历史最相关的朝代，输出 {"items":[{"eraName","startYear","endYear",' +
        '"periodRange","ancientCityName","keyEvents","relicToday"}]}。' +
        'eraName 必须来自年表，startYear/endYear 必须与年表完全一致；' +
        'keyEvents 10-400 字，relicToday 写今天仍可寻访的遗址或建筑名；' +
        'keyEvents 中如出现具体年份，该年份必须在上面的年表中出现，否则改用朝代级表述。',
    },
  ]);
  const parsed = parseJsonObject(text);
  // 叙事中的具体年份只能是年表里出现过的年份（PRD 3.2 三·年表）。
  const allowedYears = new Set<number>();
  for (const dynasty of dynasties.dynasties) {
    allowedYears.add(dynasty.startYear);
    if (dynasty.endYear !== null) allowedYears.add(dynasty.endYear);
  }
  const gazetteer = input.gazetteer ?? getGazetteer();
  const data = asArray(parsed.items).flatMap((item) => {
    const dynasty = dynasties.dynasties.find((entry) => entry.name === asText(item.eraName));
    if (!dynasty) return [];
    if (Number(item.startYear) !== dynasty.startYear) return [];
    const endYear = Number(item.endYear);
    if (dynasty.endYear !== null && endYear !== dynasty.endYear) return [];
    const periodRange = asText(item.periodRange);
    const ancientCityName = asText(item.ancientCityName);
    const keyEvents = asText(item.keyEvents);
    const relicToday = asText(item.relicToday);
    if (!periodRange || !ancientCityName || !keyEvents || !relicToday) return [];
    if (!validateNarrativeYears(keyEvents, allowedYears).ok) return [];
    const anchor = resolveChronicleAnchor(
      relicToday,
      input.city.cityId,
      input.city.center,
      gazetteer,
    );
    return [
      {
        eraName: dynasty.name,
        startYear: dynasty.startYear,
        endYear,
        periodRange,
        ancientCityName,
        keyEvents,
        relicToday,
        centerCoord: anchor.coordinates,
        sourceRefs: [llmSource().id, DYNASTY_SOURCE.id],
        verification: 'pending_human_review' as const,
      },
    ];
  });
  if (data.length === 0) {
    throw new GenerationError('LLM_OUTPUT_INVALID', '年代轴没有通过年表校验的条目');
  }
  return {
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [llmSource(), DYNASTY_SOURCE],
    data,
  };
}

async function llmLandmarks(input: GenerateInput): Promise<GeneratedModule> {
  const snapshot = input.snapshot ?? getFactSnapshot(input.city.cityId);
  if (!snapshot || snapshot.landmarks.length === 0) {
    throw new GenerationError('NO_FACTS', '本地快照无可用景点实体');
  }
  const candidates = snapshot.landmarks.slice(0, 12).map((landmark) => ({
    entityId: landmark.entityId,
    name: landmark.name,
    heritage: landmark.heritageDesignations,
  }));
  const text = await callDeepSeek([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `城市：${input.city.standardName}。候选景点：${JSON.stringify(candidates)}。` +
        '请选出 4-6 处，必游（must_visit）与秘境（hidden_gem）兼有。' +
        '输出 {"items":[{"entityId","category","bestSeason","reason"}]}；' +
        'entityId 必须来自候选，reason 10-300 字且只描述该地的文化价值，bestSeason 可为「待考」。',
    },
  ]);
  const parsed = parseJsonObject(text);
  const gazetteer = input.gazetteer ?? getGazetteer();
  const sources = [snapshotSource(snapshot)];
  const data = asArray(parsed.items).flatMap((item) => {
    const entityId = asText(item.entityId);
    const landmark = snapshot.landmarks.find((entry) => entry.entityId === entityId);
    if (!landmark) return [];
    const place = resolveEntityPlace(
      { name: landmark.name, coordinates: landmark.coordinates },
      input.city.cityId,
      input.city.center,
      gazetteer,
    );
    return [
      {
        entityRef: landmark.entityId,
        name: landmark.name,
        category: item.category === 'hidden_gem' ? ('hidden_gem' as const) : ('must_visit' as const),
        bestSeason: asText(item.bestSeason) || PENDING,
        reason: asText(item.reason),
        placeName: place.placeName,
        coordinates: place.coordinates,
        coordSource: place.coordSource,
        sourceRefs: [snapshot.sourceRef.id],
        verification: 'pending_human_review' as const,
      },
    ];
  });
  if (data.length === 0) {
    throw new GenerationError('LLM_OUTPUT_INVALID', '景点选择未匹配到候选实体');
  }
  return { status: 'degraded', verification: 'pending_human_review', sources, data };
}

async function llmRelics(input: GenerateInput): Promise<GeneratedModule> {
  const registry = input.registry ?? getRelicsRegistry();
  if (!registry) throw new GenerationError('NO_FACTS', '缺少文物名录产物');
  const relics = registry.relics.filter((relic) => relic.cityId === input.city.cityId);
  if (relics.length === 0) throw new GenerationError('NO_FACTS', '本城文物名录为空');
  const candidates = relics.slice(0, 12).map((relic) => ({
    registryId: relic.registryId,
    name: relic.name,
    era: relic.era,
  }));
  const text = await callDeepSeek([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `城市：${input.city.standardName}。候选文物：${JSON.stringify(candidates)}。` +
        '请选出 2-6 件，输出 {"items":[{"registryId","story"}]}；' +
        'registryId 必须来自候选，story 10-400 字，写它的来历与看点，不要改写出土信息。',
    },
  ]);
  const parsed = parseJsonObject(text);
  const gazetteer = input.gazetteer ?? getGazetteer();
  const usedSources = new Map<string, SourceRef>();
  const data = asArray(parsed.items).flatMap((item) => {
    const relic = relics.find((entry) => entry.registryId === asText(item.registryId));
    if (!relic) return [];
    for (const sourceId of relic.sourceRefs) {
      const source = registry.sources.find((entry) => entry.id === sourceId);
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
    const place = resolveEntityPlace(
      { name: relic.name, coordinates: relic.coordinates },
      input.city.cityId,
      input.city.center,
      gazetteer,
    );
    return [
      {
        registryId: relic.registryId,
        name: relic.name,
        era: relic.era || formatRelicEra(null),
        museumOrSite: relicMuseumOrSite(relic),
        protectionLevel: relicProtectionLevel(relic),
        findSpot: relicFindSpot(relic),
        story: asText(item.story),
        coordinates: place.coordinates,
        sourceRefs: relic.sourceRefs,
        verification: 'pending_human_review' as const,
      },
    ];
  });
  if (data.length === 0) {
    throw new GenerationError('LLM_OUTPUT_INVALID', '文物选择未匹配到名录条目');
  }
  return {
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [...usedSources.values()],
    data,
  };
}

async function llmFigures(input: GenerateInput): Promise<GeneratedModule> {
  const snapshot = input.snapshot ?? getFactSnapshot(input.city.cityId);
  if (!snapshot || snapshot.figures.length === 0) {
    throw new GenerationError('NO_FACTS', '本地快照无可用人物实体');
  }
  const text = await callDeepSeek([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `城市：${input.city.standardName}。候选人物：${JSON.stringify(
          snapshot.figures.slice(0, 12).map((figure) => ({
            entityRef: figure.entityId,
            name: figure.name,
            relationType: figure.relationType,
            evidence: figure.evidence,
          })),
        )}。` +
        '请选出 2-6 位，输出 {"items":[{"entityRef","dynasty","cityBond","highlights"}]}；' +
        'entityRef 必须来自候选，cityBond 10-300 字说明与城市的真实关联，highlights 10-200 字；' +
        '朝代不确定写「待考」。',
    },
  ]);
  const parsed = parseJsonObject(text);
  const gazetteer = input.gazetteer ?? getGazetteer();
  const data = asArray(parsed.items).flatMap((item) => {
    const figure = snapshot.figures.find((entry) => entry.entityId === asText(item.entityRef));
    if (!figure) return [];
    return [
      {
        entityRef: figure.entityId,
        name: figure.name,
        dynasty: asText(item.dynasty) || PENDING,
        birthYear: figureYear(figure.birthYear),
        deathYear: figureYear(figure.deathYear),
        relationType: figure.relationType,
        evidence: figure.evidence,
        cityBond: asText(item.cityBond),
        highlights: asText(item.highlights),
        sites: buildFigureSites(figure, input.city, gazetteer),
        sourceRefs: [snapshot.sourceRef.id],
        verification: 'pending_human_review' as const,
      },
    ];
  });
  if (data.length === 0) {
    throw new GenerationError('LLM_OUTPUT_INVALID', '人物选择未匹配到候选实体');
  }
  return {
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [snapshotSource(snapshot)],
    data,
  };
}

async function llmPoetics(input: GenerateInput): Promise<GeneratedModule> {
  const index = input.poetryCorpus
    ? buildPoetryIndex(input.poetryCorpus)
    : getPoetryIndex();
  const candidates = findPoemCandidates(index, input.city.cityId, 8);
  if (candidates.length === 0) {
    throw new GenerationError('NO_FACTS', '本地诗词库无本城候选');
  }
  const payload = candidates.map((poem) => ({
    poemId: poem.poemId,
    title: poem.title,
    author: poem.author,
    dynasty: poem.dynasty,
    lines: poem.lines,
  }));
  const text = await callDeepSeek([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `城市：${input.city.standardName}。候选诗词：${JSON.stringify(payload)}。` +
        '请选出 2-5 首，输出 {"items":[{"poemId","background","imagery":[{"word","note",' +
        '"isGeographic","placeName"}]}]}。' +
        'poemId 必须来自候选；background 10-200 字或「待考」；imagery 的词必须逐字出现在该诗正文中，' +
        'isGeographic 为 true 时 placeName 填诗中地名，否则不带 placeName。',
    },
  ]);
  const parsed = parseJsonObject(text);
  const sources: SourceRef[] = [];
  const poems: unknown[] = [];
  const acceptTitle = createTitleDeduplicator();
  for (const item of asArray(parsed.items)) {
    const corpusPoem = candidates.find((poem) => poem.poemId === asText(item.poemId));
    if (!corpusPoem) continue;
    if (!acceptTitle(corpusPoem.title)) continue;
    const imagery = asArray(item.imagery).map((entry) => ({
      word: asText(entry.word),
      note: asText(entry.note),
      isGeographic: entry.isGeographic === true,
      ...(asText(entry.placeName) ? { placeName: asText(entry.placeName) } : {}),
    }));
    const verified = verifyPoemSelection(
      {
        poemId: corpusPoem.poemId,
        background: asText(item.background) || PENDING,
        relationType: 'direct',
        imageryMap: imagery,
      },
      index,
      input.city.cityId,
    );
    if (verified.ok && verified.poem) {
      poems.push(verified.poem);
      sources.push(poemSourceRef(corpusPoem));
    }
  }
  if (poems.length === 0) {
    throw new GenerationError('LLM_OUTPUT_INVALID', '诗词候选未通过逐字与意象校验');
  }
  return {
    status: 'ok',
    verification: 'verified_by_source',
    sources,
    data: poems,
  };
}

async function llmLocalSoul(input: GenerateInput): Promise<GeneratedModule> {
  const text = await callDeepSeek([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `城市：${input.city.standardName}。请整理本地市井文化，输出 {"foods":[{"name","flavor","origin"}],` +
        '"dialects":[{"word","pronunciation","meaning","example"}],' +
        '"ichItems":[{"name","level":"national|provincial|待考","intro"}],' +
        '"festivals":[{"name","season","custom"}]}。' +
        '每类 1-3 条；只写确有共识的民俗，不确定的非遗等级写「待考」。',
    },
  ]);
  const parsed = parseJsonObject(text);
  const ichItems = asArray(parsed.ichItems).map((item) => ({
    name: asText(item.name),
    level: ['national', 'provincial'].includes(asText(item.level))
      ? (asText(item.level) as 'national' | 'provincial')
      : ('待考' as const),
    intro: asText(item.intro),
    sourceRefs: [llmSource().id],
  }));
  return {
    status: 'degraded',
    verification: 'pending_human_review',
    sources: [llmSource()],
    data: {
      aiCurated: true,
      foods: asArray(parsed.foods),
      dialects: asArray(parsed.dialects),
      ichItems,
      festivals: asArray(parsed.festivals),
    },
  };
}

/** 真实 LLM：只让模型做选择与叙事，事实字段由本地库回填并校验。 */
export class DeepSeekGenerator implements ModuleGenerator {
  private readonly settings: LlmRuntimeConfig;
  readonly promptVersion = 'openai-compatible-v1';

  constructor(settings: LlmRuntimeConfig = envLlmConfig()) {
    this.settings = settings;
  }

  get name(): string {
    return `${this.settings.model}@${this.settings.provider}`;
  }

  async generate(input: GenerateInput): Promise<GeneratedModule> {
    activeLlmConfig = this.settings;
    if (input.module === 'dataPulse') {
      throw new GenerationError(
        'NO_FACTS',
        '暂无可核验的本城统计序列来源，数据脉搏模块保持「待考」',
      );
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.generateOnce(input);
        validateModuleData(input.module, result.data);
        return result;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof GenerationError
            ? error.code === 'LLM_OUTPUT_INVALID' || error.code === 'LLM_EMPTY'
            : error instanceof ZodError;
        if (!retryable) throw error;
      }
    }
    throw new GenerationError(
      'LLM_OUTPUT_INVALID',
      `大模型输出两次未通过校验：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private generateOnce(input: GenerateInput): Promise<GeneratedModule> {
    switch (input.module) {
      case 'identity':
        return llmIdentity(input);
      case 'chronicle':
        return llmChronicle(input);
      case 'landmarks':
        return llmLandmarks(input);
      case 'relics':
        return llmRelics(input);
      case 'figures':
        return llmFigures(input);
      case 'poetics':
        return llmPoetics(input);
      case 'localSoul':
        return llmLocalSoul(input);
      default:
        throw new GenerationError('NO_FACTS', `模块 ${String(input.module)} 暂无可用事实来源`);
    }
  }
}

/** 运行时按管理页配置选择 Mock 或 OpenAI 兼容生成器，无需重启服务。 */
class DynamicGenerator implements ModuleGenerator {
  readonly promptVersion = 'dynamic-v1';

  constructor(private readonly settings: LlmSettingsService) {}

  get name(): string {
    const current = this.settings.get();
    return current.mock ? 'mock-local-facts' : `${current.model}@${current.provider}`;
  }

  generate(input: GenerateInput): Promise<GeneratedModule> {
    const current = this.settings.get();
    const generator = current.mock ? new MockGenerator() : new DeepSeekGenerator(current);
    return generator.generate(input);
  }
}

export function createGenerator(settings?: LlmSettingsService): ModuleGenerator {
  if (settings) return new DynamicGenerator(settings);
  if (config.mockLlm) return new MockGenerator();
  return new DeepSeekGenerator();
}

/** 校验生成结果是否符合共享 Schema；失败即整模块失败。 */
export function validateModuleData(module: ModuleName, data: unknown): unknown {
  return MODULE_DATA_SCHEMAS[module].parse(data);
}
