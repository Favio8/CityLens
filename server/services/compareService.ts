/**
 * 双城对比服务（P2-19）：从两座城市的已发布档案提取对比快照。
 * 缺失字段一律「待考」，不估算；不调用大模型。
 */
import type {
  CompareCity,
  CompareNumberFact,
  CompareTextFact,
} from '../../shared/schema';
import { PENDING, RelicsSchema, FiguresSchema, LandmarksSchema, PoeticsSchema, IdentitySchema, DataPulseSchema } from '../../shared/schema';
import type { ArchiveBundle } from './cacheService';
import type { CityBrief } from '../db/cityRepo';

function latestSeries(
  series: Array<{ year: number; value: number | null }> | undefined,
  unit: string,
  caliber: string,
  sourceRefs: string[],
): CompareNumberFact {
  const points = (series ?? []).filter((point) => typeof point.value === 'number');
  const latest = points.length > 0 ? points[points.length - 1] : null;
  if (!latest) {
    return { value: PENDING, unit, caliber, sourceRefs };
  }
  return {
    value: latest.value as number,
    unit,
    statYear: latest.year,
    caliber,
    sourceRefs,
  };
}

/** 从单城档案提取对比快照；模块缺失或解析失败时对应字段为「待考」/空数组。 */
export function buildCompareCity(city: CityBrief, bundle: ArchiveBundle): CompareCity {
  const identityRaw = bundle.modules.get('identity')?.data;
  const identity = IdentitySchema.safeParse(identityRaw);
  const dataPulseRaw = bundle.modules.get('dataPulse')?.data;
  const dataPulse = DataPulseSchema.safeParse(dataPulseRaw);
  const landmarksRaw = bundle.modules.get('landmarks')?.data;
  const landmarks = LandmarksSchema.safeParse(landmarksRaw);
  const relicsRaw = bundle.modules.get('relics')?.data;
  const relics = RelicsSchema.safeParse(relicsRaw);
  const figuresRaw = bundle.modules.get('figures')?.data;
  const figures = FiguresSchema.safeParse(figuresRaw);
  const poeticsRaw = bundle.modules.get('poetics')?.data;
  const poetics = PoeticsSchema.safeParse(poeticsRaw);

  const persona = identity.success && typeof identity.data.oneLinePersona === 'string'
    ? identity.data.oneLinePersona
    : PENDING;

  const climateType: CompareTextFact = identity.success && typeof identity.data.climateType.value === 'string'
    ? { value: identity.data.climateType.value, sourceRefs: identity.data.climateType.sourceRefs }
    : { value: PENDING, sourceRefs: [] };

  const gdp = dataPulse.success
    ? latestSeries(
        dataPulse.data.gdpSeries,
        dataPulse.data.statMeta.gdp.unit,
        dataPulse.data.statMeta.gdp.caliber,
        dataPulse.data.statMeta.gdp.sourceRefs,
      )
    : { value: PENDING, sourceRefs: [] };

  const population = dataPulse.success
    ? latestSeries(
        dataPulse.data.popSeries,
        dataPulse.data.statMeta.pop.unit,
        dataPulse.data.statMeta.pop.caliber,
        dataPulse.data.statMeta.pop.sourceRefs,
      )
    : { value: PENDING, sourceRefs: [] };

  const landmarkEntries = landmarks.success
    ? landmarks.data
        .slice()
        .sort((a, b) => (a.category === 'must_visit' ? -1 : 0) - (b.category === 'must_visit' ? -1 : 0))
        .slice(0, 3)
        .map((item) => ({ name: item.name, detail: item.reason }))
    : [];

  const relicEntries = relics.success
    ? relics.data.slice(0, 2).map((item) => ({
        name: item.name,
        detail: [item.era, item.museumOrSite].filter((part) => part && part !== PENDING).join(' · ') || PENDING,
      }))
    : [];

  const figureEntries = figures.success
    ? figures.data.slice(0, 2).map((item) => ({
        name: item.name,
        detail: [item.dynasty, item.cityBond].filter((part) => part && part !== PENDING).join(' · ') || PENDING,
      }))
    : [];

  return {
    cityId: city.cityId,
    standardName: city.standardName,
    province: city.province,
    oneLinePersona: persona,
    gdp,
    population,
    climateType,
    landmarks: landmarkEntries,
    relics: relicEntries,
    figures: figureEntries,
    poemCount: poetics.success ? poetics.data.length : 0,
    themePalette: bundle.archive.themePalette,
    archiveStatus: bundle.archive.status,
    generatedAt: bundle.archive.generatedAt,
  };
}
