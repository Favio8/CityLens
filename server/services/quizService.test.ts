import { describe, expect, it } from 'vitest';
import type { ModuleName } from '../../shared/schema';
import { DEFAULT_THEME_PALETTE } from '../../shared/cityThemes';
import type { ArchiveBundle } from './cacheService';
import type { ArchiveRecord, ModuleRecord } from '../db/archiveRepo';
import type { CityBrief } from '../db/cityRepo';
import { buildQuiz } from './quizService';

const city = {
  cityId: 'CN-320300',
  standardName: '徐州',
  province: '江苏省',
  center: [117.18587, 34.26104],
  isPreset: false,
} as unknown as CityBrief;

function bundleWith(modules: Partial<Record<ModuleName, unknown>>): ArchiveBundle {
  const archive: ArchiveRecord = {
    cityId: city.cityId,
    status: 'partial',
    themePalette: DEFAULT_THEME_PALETTE,
    sources: [],
    schemaVersion: '1.1',
    dataVersion: 1,
    isPreset: false,
    generator: null,
    generatedAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  };
  const map = new Map<ModuleName, ModuleRecord>();
  for (const [name, data] of Object.entries(modules)) {
    map.set(name as ModuleName, {
      name: name as ModuleName,
      status: 'ok',
      data,
      verification: {},
      generatedAt: archive.generatedAt,
    });
  }
  return { archive, modules: map };
}

const fullArchive = {
  identity: {
    standardName: '徐州',
    aliases: ['彭城'],
    center: [117.18587, 34.26104],
    area: { value: 11258, unit: 'km²', statYear: 2024, sourceRefs: ['S-A'] },
    population: { value: 901, unit: '万人', statYear: 2024, sourceRefs: ['S-A'] },
    climateType: { value: '温带季风气候', sourceRefs: ['S-A'] },
    adminDivisions: { value: '5 区 3 县 2 市', sourceRefs: ['S-A'] },
    oneLinePersona: '彭城大地，刚柔并济。',
    sourceRefs: ['S-A'],
    verification: 'pending_human_review',
  },
  chronicle: [
    {
      eraName: '汉',
      startYear: -202,
      endYear: 220,
      periodRange: '前202年—220年',
      ancientCityName: '彭城',
      keyEvents: '项羽都彭城，西楚霸业兴于此地，为古城最早的高光时刻。',
      relicToday: '戏马台',
      centerCoord: null,
      sourceRefs: ['S-C'],
      verification: 'pending_human_review',
    },
    {
      eraName: '唐',
      startYear: 618,
      endYear: 907,
      periodRange: '618年—907年',
      ancientCityName: '徐州',
      keyEvents: '唐代徐州为运河重镇，舟车络绎，商贸繁盛。',
      relicToday: '云龙山',
      centerCoord: null,
      sourceRefs: ['S-C'],
      verification: 'pending_human_review',
    },
  ],
  landmarks: [
    {
      entityRef: 'Q-1',
      name: '云龙山',
      category: 'must_visit',
      bestSeason: '春秋',
      reason: '城中山水地标，可俯瞰城区与故黄河。',
      placeName: '云龙山',
      coordinates: [117.18, 34.26],
      coordSource: 'local_gazetteer',
      sourceRefs: ['S-L'],
      verification: 'pending_human_review',
    },
    {
      entityRef: 'Q-2',
      name: '龟山汉墓',
      category: 'hidden_gem',
      bestSeason: '四季',
      reason: '西汉楚王陵墓，工程与谜团兼具。',
      placeName: '龟山汉墓',
      coordinates: [117.11, 34.31],
      coordSource: 'local_gazetteer',
      sourceRefs: ['S-L'],
      verification: 'pending_human_review',
    },
  ],
  relics: [
    {
      registryId: 'R-1',
      name: '金缕玉衣',
      era: '汉',
      museumOrSite: '徐州博物馆',
      protectionLevel: '禁止出境展览文物',
      findSpot: '狮子山楚王墓',
      story: '汉代玉衣由数千玉片以金缕编成，礼制与工艺的巅峰。',
      coordinates: null,
      sourceRefs: ['S-R'],
      verification: 'pending_human_review',
    },
    {
      registryId: 'R-2',
      name: '银缕玉衣',
      era: '汉',
      museumOrSite: '狮子山楚王墓（遗址）',
      protectionLevel: '国保',
      findSpot: '待考',
      story: '以银缕编缀的玉衣，与金缕玉衣同出刘氏楚王陵。',
      coordinates: null,
      sourceRefs: ['S-R'],
      verification: 'pending_human_review',
    },
  ],
  figures: [
    {
      entityRef: 'Q-9',
      name: '刘邦',
      dynasty: '汉',
      birthYear: -256,
      deathYear: -195,
      relationType: 'native',
      evidence: { property: 'birthplace', value: '沛县' },
      cityBond: '刘邦起于沛县，今属徐州，汉家基业自此而兴。',
      highlights: '布衣天子，开创两汉四百年江山。',
      sites: [],
      sourceRefs: ['S-F'],
      verification: 'pending_human_review',
    },
  ],
};

describe('quizService', () => {
  it('完整档案生成 5 道题，answerId 均为合法选项', () => {
    const quiz = buildQuiz(city, bundleWith(fullArchive));
    expect(quiz.questions).toHaveLength(5);
    expect(new Set(quiz.questions.map((q) => q.id)).size).toBe(5);
    for (const question of quiz.questions) {
      expect(question.options.map((o) => o.id)).toContain(question.answerId);
      expect(question.options.every((o) => o.text !== '待考')).toBe(true);
      expect(question.explanation.length).toBeGreaterThan(0);
    }
    const kinds = quiz.questions.map((q) => q.factKind);
    expect(kinds).toContain('identity');
    expect(kinds).toContain('chronicle');
    expect(kinds).toContain('landmarks');
    expect(kinds).toContain('relics');
    expect(kinds).toContain('figures');
  });

  it('人物题为判断题，选项为对/错', () => {
    const quiz = buildQuiz(city, bundleWith(fullArchive));
    const figureQuestion = quiz.questions.find((q) => q.factKind === 'figures');
    expect(figureQuestion?.type).toBe('boolean');
    expect(figureQuestion?.options.map((o) => o.text)).toEqual(['正确', '错误']);
    expect(figureQuestion?.answerId).toBe('t');
    expect(figureQuestion?.prompt).toContain('沛县');
  });

  it('气候类型为「待考」时不出 identity 题，其余题不受影响', () => {
    const quiz = buildQuiz(
      city,
      bundleWith({ ...fullArchive, identity: { ...fullArchive.identity, climateType: { value: '待考', sourceRefs: [] } } }),
    );
    expect(quiz.questions.find((q) => q.factKind === 'identity')).toBeUndefined();
    expect(quiz.questions.length).toBeGreaterThanOrEqual(4);
  });

  it('空档案返回 0 题，不抛错', () => {
    const quiz = buildQuiz(city, bundleWith({}));
    expect(quiz.questions).toHaveLength(0);
    expect(quiz.cityId).toBe('CN-320300');
  });
});
