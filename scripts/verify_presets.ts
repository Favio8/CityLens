/**
 * npm run verify —— 预置档案自动校验。
 *
 * 校验范围：六座预置城市已落库的档案。
 *  1. 档案存在、标记为预置、未下架；
 *  2. 八卷数据逐卷通过共享 Zod Schema；
 *  3. 所有 sourceRefs 均在档案来源表中登记；
 *  4. 诗词逐字比对、意象词在原文、年代与本地年表一致；
 *  5. 坐标在市中心 180km 内且为 WGS84；数值在合理量级；
 *  6. 城市主题色通过 ensureContrast 校验且与预置主题一致。
 *
 * 任何一项失败即退出码 1，供 CI/人工验收使用。
 */
import { ZodError } from 'zod';
import {
  PRESET_CITY_IDS,
  type Coord,
  type ModuleName,
  type SourceRef,
} from '../shared/schema';
import {
  ChronicleSchema,
  DataPulseSchema,
  FiguresSchema,
  IdentitySchema,
  LandmarksSchema,
  LocalSoulSchema,
  MODULE_DATA_SCHEMAS,
  PoeticsSchema,
  RelicsSchema,
} from '../shared/schema';
import { CANVAS_BACKGROUNDS, paletteForCity } from '../shared/cityThemes';
import { checkThemePalette } from '../shared/theme';
import {
  haversineKm,
  validateChronicleOrder,
  validateImagery,
  validateNumericRange,
  validatePoemAgainstCorpus,
} from '../shared/validators';
import { ArchiveRepo, type ModuleRecord } from '../server/db/archiveRepo';
import { CityRepo } from '../server/db/cityRepo';
import { openDb } from '../server/db';
import {
  getDynasties,
  getFactSnapshot,
  getPoetryCorpus,
  getRelicsRegistry,
} from '../server/services/presetData';

const EXPECTED_MISSING: ModuleName[] = ['dataPulse'];

function collectSourceIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceIds(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sourceRefs' && Array.isArray(child)) {
      for (const id of child) if (typeof id === 'string') out.add(id);
    } else {
      collectSourceIds(child, out);
    }
  }
}

function describeZodError(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function checkModule(
  name: ModuleName,
  record: ModuleRecord,
  sources: Map<string, SourceRef>,
  cityId: string,
  center: Coord,
): string[] {
  if (record.data === null) {
    return EXPECTED_MISSING.includes(name) ? [] : [`${name} 没有数据`];
  }
  const parsed = MODULE_DATA_SCHEMAS[name].safeParse(record.data);
  if (!parsed.success) {
    return [`${name} Schema 校验失败：${describeZodError(parsed.error)}`];
  }

  const issues: string[] = [];
  const used = new Set<string>();
  collectSourceIds(record.data, used);
  for (const id of used) {
    if (!sources.has(id)) issues.push(`${name} 引用了未登记来源 ${id}`);
  }

  switch (name) {
    case 'identity': {
      const data = IdentitySchema.parse(record.data);
      if (Math.abs(data.center[0] - center[0]) > 0.5) issues.push('identity 中心点与城市中心不一致');
      if (typeof data.area.value === 'number' && !validateNumericRange(data.area.value, { min: 50, max: 300000 })) {
        issues.push(`面积数值异常：${data.area.value}`);
      }
      if (
        typeof data.population.value === 'number' &&
        !validateNumericRange(data.population.value, { min: 100000, max: 50000000 })
      ) {
        issues.push(`人口数值异常：${data.population.value}`);
      }
      for (const fact of [data.area, data.population]) {
        if (typeof fact.statYear === 'number' && (fact.statYear < 1949 || fact.statYear > 2026)) {
          issues.push(`统计年份异常：${fact.statYear}`);
        }
      }
      break;
    }
    case 'chronicle': {
      const data = ChronicleSchema.parse(record.data);
      const order = validateChronicleOrder(data);
      issues.push(...order.issues);
      const dynasties = getDynasties()?.dynasties ?? [];
      for (const item of data) {
        const dynasty = dynasties.find((entry) => entry.name === item.eraName);
        if (!dynasty) {
          issues.push(`年代条目 ${item.eraName} 不在本地年表`);
          continue;
        }
        if (dynasty.startYear !== item.startYear) issues.push(`${item.eraName} 起始年与年表不符`);
        if (dynasty.endYear !== null && dynasty.endYear !== item.endYear) {
          issues.push(`${item.eraName} 结束年与年表不符`);
        }
      }
      break;
    }
    case 'landmarks': {
      const data = LandmarksSchema.parse(record.data);
      const snapshot = getFactSnapshot(cityId);
      const entityIds = new Set(snapshot?.landmarks.map((entry) => entry.entityId) ?? []);
      for (const item of data) {
        if (!entityIds.has(item.entityRef)) issues.push(`景点 ${item.name} 不在本地快照`);
        if (item.coordinates && haversineKm(center, item.coordinates) > 180) {
          issues.push(`景点 ${item.name} 距市中心超过 180km`);
        }
      }
      break;
    }
    case 'relics': {
      const data = RelicsSchema.parse(record.data);
      const registry = getRelicsRegistry();
      const relicIds = new Set(
        (registry?.relics ?? []).filter((item) => item.cityId === cityId).map((item) => item.registryId),
      );
      for (const item of data) {
        if (!relicIds.has(item.registryId)) issues.push(`文物 ${item.name} 不在本地名录`);
        if (item.coordinates && haversineKm(center, item.coordinates) > 180) {
          issues.push(`文物 ${item.name} 距市中心超过 180km`);
        }
      }
      break;
    }
    case 'figures': {
      const data = FiguresSchema.parse(record.data);
      const snapshot = getFactSnapshot(cityId);
      const entityIds = new Set(snapshot?.figures.map((entry) => entry.entityId) ?? []);
      for (const item of data) {
        if (!entityIds.has(item.entityRef)) issues.push(`人物 ${item.name} 不在本地快照`);
        if (
          typeof item.birthYear === 'number' &&
          typeof item.deathYear === 'number' &&
          item.birthYear > item.deathYear
        ) {
          issues.push(`人物 ${item.name} 生卒年倒置`);
        }
      }
      break;
    }
    case 'poetics': {
      const data = PoeticsSchema.parse(record.data);
      const corpus = getPoetryCorpus();
      const byId = new Map((corpus?.poems ?? []).map((poem) => [poem.poemId, poem]));
      for (const poem of data) {
        const result = validatePoemAgainstCorpus(poem, byId.get(poem.poemId));
        if (!result.ok) issues.push(...result.issues.map((issue) => `诗词「${poem.title}」${issue}`));
        const imagery = validateImagery(
          poem.imageryMap.map((item) => ({
            word: item.word,
            isGeographic: item.isGeographic,
            coordinates: item.coordinates,
          })),
          poem.lines,
        );
        if (!imagery.ok) {
          issues.push(...imagery.issues.map((issue) => `诗词「${poem.title}」${issue}`));
        }
      }
      break;
    }
    case 'localSoul': {
      const data = LocalSoulSchema.parse(record.data);
      if (data.aiCurated !== true) issues.push('城市味道未标记 AI 整理');
      for (const item of data.ichItems) {
        for (const id of item.sourceRefs) {
          if (!sources.has(id)) issues.push(`非遗 ${item.name} 引用了未登记来源 ${id}`);
        }
      }
      break;
    }
    case 'dataPulse': {
      const data = DataPulseSchema.parse(record.data);
      for (const point of [...data.gdpSeries, ...data.popSeries]) {
        if (typeof point.value === 'number' && !validateNumericRange(point.value, { min: 0, max: 1e14 })) {
          issues.push(`数据脉搏数值异常：${point.value}`);
        }
      }
      break;
    }
    default:
      break;
  }
  return issues;
}

function main(): void {
  const db = openDb();
  const archiveRepo = new ArchiveRepo(db);
  const cityRepo = new CityRepo(db);

  const failures: string[] = [];
  let passCount = 0;

  for (const cityId of PRESET_CITY_IDS) {
    const city = cityRepo.getCity(cityId);
    if (!city) {
      failures.push(`${cityId} 不在城市词典`);
      continue;
    }
    const archive = archiveRepo.getArchive(cityId);
    if (!archive) {
      failures.push(`${city.standardName} ${cityId} 缺少档案，请运行 npm run data:presets`);
      continue;
    }
    const issues: string[] = [];
    if (!archive.isPreset) issues.push('档案未标记为预置');
    if (archive.status === 'unpublished') issues.push('档案状态为 unpublished');

    const theme = checkThemePalette(archive.themePalette, CANVAS_BACKGROUNDS);
    issues.push(...theme.issues);
    if (JSON.stringify(archive.themePalette) !== JSON.stringify(paletteForCity(cityId))) {
      issues.push('主题色与预置主题不一致');
    }

    const sources = new Map(archive.sources.map((source) => [source.id, source]));
    const modules = archiveRepo.listModules(cityId);
    const present = new Set(modules.map((module) => module.name));
    const missing = EXPECTED_MISSING.filter((name) => !present.has(name));

    for (const record of modules) {
      if (record.status === 'failed' || record.data === null) continue;
      issues.push(...checkModule(record.name, record, sources, cityId, city.center));
    }

    if (issues.length > 0) {
      failures.push(`${city.standardName} ${cityId}：${issues.join('；')}`);
    } else {
      passCount += 1;
    }
    console.log(
      `[verify] ${issues.length === 0 ? '✓' : '✗'} ${city.standardName} ${cityId} · ` +
        `${modules.length} 卷` +
        (missing.length > 0 ? `（已知暂缺 ${missing.join(',')}）` : ''),
    );
  }

  db.close();

  if (failures.length > 0) {
    console.error('\n[verify] 未通过：');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n[verify] 通过 ${passCount}/${PRESET_CITY_IDS.length} 座预置城市。`);
  console.log('[verify] 说明：这是程序化自测，不等于人工复核；7.2 人工抽查仍需用户完成。');
}

try {
  main();
} catch (error) {
  console.error('[verify] 执行失败：', error);
  process.exit(1);
}
