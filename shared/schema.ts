/**
 * CityLens 读城 —— 前后端共用的 Zod Schema 与类型唯一来源。
 * 字段约束严格对应 PRD 5.3《核心业务字段与变量字典》。
 */
import { z } from 'zod';

/** 缺失/无法核验的统一占位符。绝不展示模型猜测值。 */
export const PENDING = '待考' as const;
export const PendingSchema = z.literal(PENDING);

export const MODULE_NAMES = [
  'identity',
  'chronicle',
  'landmarks',
  'relics',
  'figures',
  'poetics',
  'localSoul',
  'dataPulse',
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];
export const ModuleNameSchema = z.enum(MODULE_NAMES);

export const MODULE_TITLES: Record<ModuleName, string> = {
  identity: '城市名片',
  chronicle: '前世今生',
  landmarks: '景点地图',
  relics: '文物重器',
  figures: '历史名人',
  poetics: '诗句中的 Ta',
  localSoul: '城市味道',
  dataPulse: '数说城市',
};

export const MODULE_STATUSES = ['ok', 'degraded', 'failed', 'missing'] as const;
export const ModuleStatusSchema = z.enum(MODULE_STATUSES);
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;

export const ARCHIVE_STATUSES = ['complete', 'partial', 'unpublished'] as const;
export const ArchiveStatusSchema = z.enum(ARCHIVE_STATUSES);
export type ArchiveStatus = z.infer<typeof ArchiveStatusSchema>;

export const VERIFICATION_STATUSES = [
  'verified_by_source',
  'pending_human_review',
  'preset_manual',
] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const SOURCE_TYPES = [
  'local_snapshot',
  'wikidata',
  'wikipedia',
  'gov_stat',
  'nrha',
  'museum',
  'poetry_corpus',
  'relics_registry',
  'preset_manual',
  'llm_curation',
] as const;
export const SourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** 城市 ID：一期 'CN-' + 6 位行政区划代码；海外预留 ISO 国家码前缀。 */
export const CITY_ID_REGEX = /^[A-Z]{2}-[A-Za-z0-9]{4,8}$/;
export const CityIdSchema = z.string().regex(CITY_ID_REGEX, 'cityId 格式应为 XX-123456');

/** WGS84 坐标，格式 [lng, lat]。全链路唯一，禁止 GCJ-02。 */
export const CoordSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export type Coord = z.infer<typeof CoordSchema>;

export const IsoDateSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: '必须是 ISO 8601 时间' });

export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '主题色必须是 6 位 HEX，如 #8C3F2B');

export const SourceRefSchema = z.object({
  id: z.string().min(1),
  type: SourceTypeSchema,
  title: z.string().min(1),
  url: z.string().url().optional(),
  retrievedAt: IsoDateSchema,
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/* -------------------------------------------------------------------------- */
/* Fact<T>：所有数值/文本型事实都带单位、口径、统计年份与来源                  */
/* -------------------------------------------------------------------------- */

const factBaseShape = {
  unit: z.string().min(1).optional(),
  statYear: z.number().int().nullable().optional(),
  caliber: z.string().min(1).optional(),
  sourceRefs: z.array(z.string().min(1)).default([]),
};

/** 数值型事实：非“待考”时必须有单位、统计年份与至少 1 个来源。 */
export const NumberFactSchema = z
  .object({
    value: z.union([z.number().finite(), PendingSchema]),
    ...factBaseShape,
  })
  .superRefine((fact, ctx) => {
    if (typeof fact.value !== 'number') return;
    if (!fact.unit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '数值事实缺少 unit', path: ['unit'] });
    }
    if (typeof fact.statYear !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '数值事实缺少 statYear',
        path: ['statYear'],
      });
    }
    if (fact.sourceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '数值事实缺少 sourceRefs',
        path: ['sourceRefs'],
      });
    }
  });
export type NumberFact = z.infer<typeof NumberFactSchema>;

/** 文本型事实：非“待考”时必须有至少 1 个来源。 */
export const StringFactSchema = z
  .object({
    value: z.union([z.string().min(1), PendingSchema]),
    ...factBaseShape,
  })
  .superRefine((fact, ctx) => {
    if (fact.value === PENDING) return;
    if (fact.sourceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '文本事实缺少 sourceRefs',
        path: ['sourceRefs'],
      });
    }
  });
export type StringFact = z.infer<typeof StringFactSchema>;

/* -------------------------------------------------------------------------- */
/* 主题                                                                        */
/* -------------------------------------------------------------------------- */

export const ThemeColorsSchema = z.object({
  primary: HexColorSchema,
  secondary: HexColorSchema,
  accent: HexColorSchema,
});
export type ThemeColors = z.infer<typeof ThemeColorsSchema>;

export const ThemePaletteSchema = z.object({
  light: ThemeColorsSchema,
  dark: ThemeColorsSchema,
});
export type ThemePalette = z.infer<typeof ThemePaletteSchema>;

/* -------------------------------------------------------------------------- */
/* 全局元数据                                                                  */
/* -------------------------------------------------------------------------- */

export const GeneratorInfoSchema = z.object({
  model: z.string().min(1),
  promptVersion: z.string().min(1),
});

export const MetaSchema = z.object({
  cityId: CityIdSchema,
  standardName: z.string().min(1),
  province: z.string().min(1),
  aliases: z.array(z.string()),
  center: CoordSchema,
  schemaVersion: z.string().min(1),
  dataVersion: z.number().int().nonnegative(),
  generatedAt: IsoDateSchema,
  status: ArchiveStatusSchema,
  moduleStatus: z.record(ModuleNameSchema, ModuleStatusSchema),
  generator: GeneratorInfoSchema.nullable(),
  isPreset: z.boolean(),
  themePalette: ThemePaletteSchema,
});
export type Meta = z.infer<typeof MetaSchema>;

/* -------------------------------------------------------------------------- */
/* 01 城市名片                                                                 */
/* -------------------------------------------------------------------------- */

export const IdentitySchema = z.object({
  standardName: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  center: CoordSchema,
  area: NumberFactSchema,
  population: NumberFactSchema,
  climateType: StringFactSchema,
  adminDivisions: StringFactSchema,
  oneLinePersona: z.union([z.string().min(8).max(60), PendingSchema]),
  sourceRefs: z.array(z.string().min(1)).min(1),
  verification: VerificationStatusSchema,
});
export type Identity = z.infer<typeof IdentitySchema>;

/* -------------------------------------------------------------------------- */
/* 02 前世今生                                                                 */
/* -------------------------------------------------------------------------- */

export const ChronicleItemSchema = z.object({
  eraName: z.string().min(1),
  epithet: z.string().min(1).optional(),
  startYear: z.number().int(),
  endYear: z.number().int().nullable(),
  periodRange: z.string().min(1),
  ancientCityName: z.string().min(1),
  keyEvents: z.string().min(10).max(400),
  relicToday: z.string().min(1),
  centerCoord: CoordSchema.nullable(),
  sourceRefs: z.array(z.string().min(1)).min(1),
  verification: VerificationStatusSchema,
});
export type ChronicleItem = z.infer<typeof ChronicleItemSchema>;
export const ChronicleSchema = z.array(ChronicleItemSchema).min(1).max(8);

/* -------------------------------------------------------------------------- */
/* 03 景点地图                                                                 */
/* -------------------------------------------------------------------------- */

export const LANDMARK_CATEGORIES = ['must_visit', 'hidden_gem'] as const;
export const LandmarkCategorySchema = z.enum(LANDMARK_CATEGORIES);

export const COORD_SOURCES = [
  'local_gazetteer',
  'tianditu',
  'wikidata',
  'preset_manual',
  'city_center',
] as const;
export const CoordSourceSchema = z.enum(COORD_SOURCES);
export type CoordSource = z.infer<typeof CoordSourceSchema>;

export const LandmarkSchema = z.object({
  entityRef: z.string().min(1),
  name: z.string().min(1),
  category: LandmarkCategorySchema,
  bestSeason: z.union([z.string().min(1), PendingSchema]),
  reason: z.string().min(10).max(300),
  placeName: z.string().min(1),
  coordinates: CoordSchema.nullable(),
  coordSource: CoordSourceSchema,
  sourceRefs: z.array(z.string().min(1)).min(1),
  verification: VerificationStatusSchema,
});
export type Landmark = z.infer<typeof LandmarkSchema>;
export const LandmarksSchema = z.array(LandmarkSchema).min(1).max(10);

/* -------------------------------------------------------------------------- */
/* 04 文物重器                                                                 */
/* -------------------------------------------------------------------------- */

export const RelicImageSchema = z.object({
  url: z.string().url(),
  credit: z.string().min(1),
  license: z.string().min(1),
  sourceUrl: z.string().url(),
});

export const RelicSchema = z.object({
  registryId: z.string().min(1),
  name: z.string().min(1),
  era: z.string().min(1),
  museumOrSite: z.string().min(1),
  protectionLevel: z.string().min(1),
  findSpot: z.union([z.string().min(1), PendingSchema]),
  story: z.string().min(10).max(400),
  coordinates: CoordSchema.nullable(),
  images: z.array(RelicImageSchema).optional(),
  sourceRefs: z.array(z.string().min(1)).min(1),
  verification: VerificationStatusSchema,
});
export type Relic = z.infer<typeof RelicSchema>;
export const RelicsSchema = z.array(RelicSchema).min(1).max(6);

/* -------------------------------------------------------------------------- */
/* 05 历史名人                                                                 */
/* -------------------------------------------------------------------------- */

export const FIGURE_RELATION_TYPES = ['native', 'sojourner'] as const;
export const FigureRelationTypeSchema = z.enum(FIGURE_RELATION_TYPES);

export const FIGURE_EVIDENCE_PROPERTIES = [
  'birthplace',
  'deathplace',
  'workplace',
  'position',
  'preset_manual',
] as const;
export const FigureEvidenceSchema = z.object({
  property: z.enum(FIGURE_EVIDENCE_PROPERTIES),
  value: z.string().min(1),
});

export const FigureSiteSchema = z.object({
  placeName: z.string().min(1),
  coordinates: CoordSchema.nullable(),
});

export const FigureSchema = z.object({
  entityRef: z.string().min(1),
  name: z.string().min(1),
  dynasty: z.union([z.string().min(1), PendingSchema]),
  birthYear: z.union([z.number().int(), PendingSchema]),
  deathYear: z.union([z.number().int(), PendingSchema]),
  relationType: FigureRelationTypeSchema,
  evidence: FigureEvidenceSchema,
  cityBond: z.string().min(10).max(300),
  highlights: z.string().min(10).max(200),
  sites: z.array(FigureSiteSchema).max(4),
  sourceRefs: z.array(z.string().min(1)).min(1),
  verification: VerificationStatusSchema,
});
export type Figure = z.infer<typeof FigureSchema>;
export const FiguresSchema = z.array(FigureSchema).min(1).max(6);

/* -------------------------------------------------------------------------- */
/* 06 诗句中的 Ta                                                              */
/* -------------------------------------------------------------------------- */

export const POEM_RELATION_TYPES = ['direct', 'regional'] as const;
export const PoemRelationTypeSchema = z.enum(POEM_RELATION_TYPES);

export const ImagerySchema = z.object({
  word: z.string().min(1),
  note: z.string().min(1),
  isGeographic: z.boolean(),
  placeName: z.string().min(1).optional(),
  coordinates: CoordSchema.nullable().optional(),
});

export const PoemSchema = z.object({
  poemId: z.string().min(1),
  title: z.string().min(1),
  author: z.string().min(1),
  dynasty: z.string().min(1),
  lines: z.array(z.string().min(1)).min(1),
  background: z.union([z.string().min(1), PendingSchema]),
  relationType: PoemRelationTypeSchema,
  imageryMap: z.array(ImagerySchema),
  sourceRefs: z.array(z.string().min(1)).min(1),
  verification: VerificationStatusSchema,
});
export type Poem = z.infer<typeof PoemSchema>;
export const PoeticsSchema = z.array(PoemSchema).min(1).max(5);

/* -------------------------------------------------------------------------- */
/* 07 城市味道                                                                 */
/* -------------------------------------------------------------------------- */

export const ICH_LEVELS = ['national', 'provincial', PENDING] as const;
export const IchLevelSchema = z.enum(ICH_LEVELS);

export const LocalSoulSchema = z.object({
  aiCurated: z.literal(true),
  foods: z
    .array(
      z.object({
        name: z.string().min(1),
        flavor: z.string().min(1),
        origin: z.string().min(1),
      }),
    )
    .min(1)
    .max(5),
  dialects: z
    .array(
      z.object({
        word: z.string().min(1),
        pronunciation: z.string().min(1),
        meaning: z.string().min(1),
        example: z.string().min(1),
      }),
    )
    .min(1)
    .max(4),
  ichItems: z
    .array(
      z.object({
        name: z.string().min(1),
        level: IchLevelSchema,
        intro: z.string().min(1),
        sourceRefs: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1)
    .max(4),
  festivals: z
    .array(
      z.object({
        name: z.string().min(1),
        season: z.string().min(1),
        custom: z.string().min(1),
      }),
    )
    .min(1)
    .max(3),
});
export type LocalSoul = z.infer<typeof LocalSoulSchema>;

/* -------------------------------------------------------------------------- */
/* 08 数说城市                                                                 */
/* -------------------------------------------------------------------------- */

export const SeriesPointSchema = z.object({
  year: z.number().int(),
  value: z.number().nullable(),
});

export const DataPulseSchema = z.object({
  gdpSeries: z.array(SeriesPointSchema).min(1).max(5),
  popSeries: z.array(SeriesPointSchema).min(1).max(5),
  statMeta: z.object({
    gdp: z.object({
      unit: z.string().min(1),
      caliber: z.string().min(1),
      sourceRefs: z.array(z.string().min(1)).min(1),
    }),
    pop: z.object({
      unit: z.string().min(1),
      caliber: z.string().min(1),
      sourceRefs: z.array(z.string().min(1)).min(1),
    }),
  }),
  climateMonthly: z
    .array(
      z.object({
        month: z.number().int().min(1).max(12),
        tempC: z.number().nullable(),
        precipMm: z.number().nullable(),
      }),
    )
    .max(12)
    .default([]),
  climateMeta: z.object({
    period: z.string().min(1),
    station: z.string().min(1),
    sourceRefs: z.array(z.string().min(1)).default([]),
  }),
});
export type DataPulse = z.infer<typeof DataPulseSchema>;

/* -------------------------------------------------------------------------- */
/* 模块联合与档案响应                                                          */
/* -------------------------------------------------------------------------- */

export const ModuleDataSchema = z.union([
  IdentitySchema,
  ChronicleSchema,
  LandmarksSchema,
  RelicsSchema,
  FiguresSchema,
  PoeticsSchema,
  LocalSoulSchema,
  DataPulseSchema,
]);

/** 按模块名索引的 Schema，供服务端校验与前端渲染共用。 */
export const MODULE_DATA_SCHEMAS = {
  identity: IdentitySchema,
  chronicle: ChronicleSchema,
  landmarks: LandmarksSchema,
  relics: RelicsSchema,
  figures: FiguresSchema,
  poetics: PoeticsSchema,
  localSoul: LocalSoulSchema,
  dataPulse: DataPulseSchema,
} as const;

export const CityArchiveResponseSchema = z.object({
  fromCache: z.boolean(),
  meta: MetaSchema,
  identity: IdentitySchema.nullable(),
  chronicle: ChronicleSchema.nullable(),
  landmarks: LandmarksSchema.nullable(),
  relics: RelicsSchema.nullable(),
  figures: FiguresSchema.nullable(),
  poetics: PoeticsSchema.nullable(),
  localSoul: LocalSoulSchema.nullable(),
  dataPulse: DataPulseSchema.nullable(),
  sources: z.array(SourceRefSchema),
});
export type CityArchiveResponse = z.infer<typeof CityArchiveResponseSchema>;

/* -------------------------------------------------------------------------- */
/* 搜索与接口契约                                                              */
/* -------------------------------------------------------------------------- */

export const MATCH_TYPES = [
  'standard',
  'ancient',
  'pinyin',
  'english',
  'district_hint',
  'typo',
] as const;
export const MatchTypeSchema = z.enum(MATCH_TYPES);
export type MatchType = z.infer<typeof MatchTypeSchema>;

export const SearchCandidateSchema = z.object({
  cityId: CityIdSchema,
  name: z.string().min(1),
  province: z.string().min(1),
  matchedAlias: z.string().min(1),
  matchType: MatchTypeSchema,
  summary: z.string().nullable(),
});
export type SearchCandidate = z.infer<typeof SearchCandidateSchema>;

export const SearchStatusSchema = z.enum(['exact', 'ambiguous', 'none']);
export const SearchResponseSchema = z.object({
  status: SearchStatusSchema,
  candidates: z.array(SearchCandidateSchema),
  hint: z.string().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const HotCitySchema = z.object({
  cityId: CityIdSchema,
  name: z.string().min(1),
  province: z.string().min(1),
  isPreset: z.boolean(),
  summary: z.string().nullable(),
});
export type HotCity = z.infer<typeof HotCitySchema>;
export const HotCitiesResponseSchema = z.object({
  cities: z.array(HotCitySchema),
});

export const GenerateRequestSchema = z.object({
  force: z.boolean().optional(),
  // 模块名去重由 JobManager 统一处理；这里限制长度，避免单请求无限放大生成次数。
  modules: z.array(ModuleNameSchema).min(1).max(MODULE_NAMES.length).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  llmConfigured: z.boolean(),
  mapConfigured: z.boolean(),
  mockLlm: z.boolean(),
  presetCities: z.number().int().nonnegative(),
  archives: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryAfterSec: z.number().int().nonnegative().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* -------------------------------------------------------------------------- */
/* SSE 事件协议（PRD 3.4）                                                     */
/* -------------------------------------------------------------------------- */

export const SSE_EVENT_NAMES = [
  'meta',
  'module',
  'theme',
  'module_error',
  'done',
  'error',
  'ping',
] as const;
export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

export const SseMetaEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  cityId: CityIdSchema,
  standardName: z.string(),
  province: z.string(),
  aliases: z.array(z.string()),
  center: CoordSchema,
  isPreset: z.boolean(),
  jobId: z.string(),
});
export type SseMetaEvent = z.infer<typeof SseMetaEventSchema>;

export const SseModuleEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  name: ModuleNameSchema,
  status: z.enum(['ok', 'degraded']),
  data: z.unknown(),
  sources: z.array(SourceRefSchema),
});
export type SseModuleEvent = z.infer<typeof SseModuleEventSchema>;

export const SseThemeEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  light: ThemeColorsSchema,
  dark: ThemeColorsSchema,
});

export const MODULE_ERROR_CODES = [
  'LLM_TIMEOUT',
  'SCHEMA_INVALID',
  'VERIFY_FAILED',
  'NO_FACTS',
] as const;
export type ModuleErrorCode = (typeof MODULE_ERROR_CODES)[number];

export const SseModuleErrorEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  name: ModuleNameSchema,
  code: z.enum(MODULE_ERROR_CODES),
  retryable: z.boolean(),
});
export type SseModuleErrorEvent = z.infer<typeof SseModuleErrorEventSchema>;

export const SseDoneEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  cityId: CityIdSchema,
  status: ArchiveStatusSchema,
  failedModules: z.array(ModuleNameSchema),
  generatedAt: IsoDateSchema,
  dataVersion: z.number().int().nonnegative(),
});
export type SseDoneEvent = z.infer<typeof SseDoneEventSchema>;

export const SseErrorEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  code: z.string(),
  message: z.string(),
  retryAfterSec: z.number().int().nonnegative().optional(),
});
export type SseErrorEvent = z.infer<typeof SseErrorEventSchema>;

export type SseEvent =
  | { event: 'meta'; data: SseMetaEvent }
  | { event: 'module'; data: SseModuleEvent }
  | { event: 'theme'; data: z.infer<typeof SseThemeEventSchema> }
  | { event: 'module_error'; data: SseModuleErrorEvent }
  | { event: 'done'; data: SseDoneEvent }
  | { event: 'error'; data: SseErrorEvent }
  | { event: 'ping'; data: Record<string, never> };

/** 预置名城（阶段 6 由管线生成，受保护，需管理令牌强制刷新）。 */
export const PRESET_CITY_IDS = [
  'CN-610100', // 西安
  'CN-330100', // 杭州
  'CN-510100', // 成都
  'CN-110000', // 北京
  'CN-320500', // 苏州
  'CN-410300', // 洛阳
] as const;

/** 档案发布规则：identity 通过且通过校验的模块数不少于 5 个。 */
export const MIN_OK_MODULES_FOR_PUBLISH = 5;

/** 预置城市保护与冷却常量（毫秒）。 */
export const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
export const REGEN_COOLDOWN_MS = 5 * 60 * 1000;
export const NEW_CITY_HOURLY_LIMIT = 10;
export const MAX_QUERY_LENGTH = 30;
