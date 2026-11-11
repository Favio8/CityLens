/**
 * 知识小测验服务（P2-21）：题目全部来自该城档案的事实字段，本地判分，不依赖 LLM。
 * 干扰项只取自同一档案的其他实体或固定气候类型表；禁止出现档案之外的知识点。
 */
import type { Quiz, QuizFactKind, QuizQuestion } from '../../shared/schema';
import { PENDING, ChronicleSchema, FiguresSchema, LandmarksSchema, RelicsSchema, IdentitySchema } from '../../shared/schema';
import type { ArchiveBundle } from './cacheService';
import type { CityBrief } from '../db/cityRepo';

const CLIMATE_TYPES = [
  '亚热带季风气候',
  '温带季风气候',
  '温带大陆性气候',
  '高原山地气候',
  '热带季风气候',
];

interface Draft {
  factKind: QuizFactKind;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  answerId: string;
  explanation: string;
  sourceRefs: string[];
}

function shuffleFree(options: Array<{ id: string; text: string }>): Array<{ id: string; text: string }> {
  // 选项顺序固定（按 id），判分不依赖随机，保证可复现。
  return options;
}

function climateQuestion(city: CityBrief, bundle: ArchiveBundle): Draft | null {
  const identity = IdentitySchema.safeParse(bundle.modules.get('identity')?.data);
  if (!identity.success) return null;
  const climate = identity.data.climateType;
  if (typeof climate.value !== 'string' || climate.value === PENDING) return null;
  const distractors = CLIMATE_TYPES.filter((type) => type !== climate.value).slice(0, 3);
  if (distractors.length < 2) return null;
  const options = [
    { id: 'a', text: climate.value },
    ...distractors.map((text, index) => ({ id: String.fromCharCode(98 + index), text })),
  ];
  return {
    factKind: 'identity',
    prompt: `${city.standardName}属于哪种气候类型？`,
    options: shuffleFree(options),
    answerId: 'a',
    explanation: `档案「城市名片」记载：${climate.value}。`,
    sourceRefs: climate.sourceRefs,
  };
}

function chronicleQuestion(city: CityBrief, bundle: ArchiveBundle): Draft | null {
  const chronicle = ChronicleSchema.safeParse(bundle.modules.get('chronicle')?.data);
  if (!chronicle.success || chronicle.data.length < 2) return null;
  const first = chronicle.data[0]!;
  const second = chronicle.data[1]!;
  if (first.ancientCityName === second.ancientCityName) return null;
  const options = [
    { id: 'a', text: first.ancientCityName },
    { id: 'b', text: second.ancientCityName },
  ];
  if (first.ancientCityName.length < 1 || second.ancientCityName.length < 1) return null;
  return {
    factKind: 'chronicle',
    prompt: `在${first.eraName}时期，${city.standardName}当时被称为什么？`,
    options,
    answerId: 'a',
    explanation: `档案「前世今生」：${first.eraName}（${first.periodRange}）时称「${first.ancientCityName}」；${second.eraName}时称「${second.ancientCityName}」。`,
    sourceRefs: first.sourceRefs,
  };
}

function landmarkQuestion(city: CityBrief, bundle: ArchiveBundle): Draft | null {
  const landmarks = LandmarksSchema.safeParse(bundle.modules.get('landmarks')?.data);
  if (!landmarks.success) return null;
  const mustVisit = landmarks.data.filter((item) => item.category === 'must_visit');
  const others = landmarks.data.filter((item) => item.category !== 'must_visit');
  if (mustVisit.length === 0 || others.length === 0) return null;
  const answer = mustVisit[0]!;
  const options = [
    { id: 'a', text: answer.name },
    ...others.slice(0, 2).map((item, index) => ({ id: String.fromCharCode(98 + index), text: item.name })),
  ];
  return {
    factKind: 'landmarks',
    prompt: `下列哪处被${city.standardName}档案列为「必去地标」？`,
    options,
    answerId: 'a',
    explanation: `档案「景点地图」：${answer.name}为必去地标；其余为小众历史秘境。`,
    sourceRefs: answer.sourceRefs,
  };
}

function relicQuestion(city: CityBrief, bundle: ArchiveBundle): Draft | null {
  const relics = RelicsSchema.safeParse(bundle.modules.get('relics')?.data);
  if (!relics.success || relics.data.length < 2) return null;
  const first = relics.data[0]!;
  const second = relics.data[1]!;
  if (first.museumOrSite === second.museumOrSite) return null;
  const options = [
    { id: 'a', text: first.museumOrSite },
    { id: 'b', text: second.museumOrSite },
  ];
  return {
    factKind: 'relics',
    prompt: `档案中，${first.name}的馆藏地 / 所在遗址是？`,
    options,
    answerId: 'a',
    explanation: `档案「文物重器」：${first.name}——${first.museumOrSite}；${second.name}——${second.museumOrSite}。`,
    sourceRefs: first.sourceRefs,
  };
}

function figureBooleanQuestion(city: CityBrief, bundle: ArchiveBundle): Draft | null {
  const figures = FiguresSchema.safeParse(bundle.modules.get('figures')?.data);
  if (!figures.success || figures.data.length === 0) return null;
  const figure = figures.data[0]!;
  const evidence = figure.evidence.value;
  if (!evidence) return null;
  return {
    factKind: 'figures',
    prompt: `档案记载：${figure.name}与${city.standardName}的关联是「${evidence}」。`,
    options: [
      { id: 't', text: '正确' },
      { id: 'f', text: '错误' },
    ],
    answerId: 't',
    explanation: `档案「历史名人」：${figure.name}，${figure.cityBond}`,
    sourceRefs: figure.sourceRefs,
  };
}

const DRAFTERS: Array<(city: CityBrief, bundle: ArchiveBundle) => Draft | null> = [
  climateQuestion,
  chronicleQuestion,
  landmarkQuestion,
  relicQuestion,
  figureBooleanQuestion,
];

/** 生成最多 5 道题；能出几道出几道，不出档案之外的知识点。 */
export function buildQuiz(city: CityBrief, bundle: ArchiveBundle): Quiz {
  const questions: QuizQuestion[] = [];
  for (const draft of DRAFTERS) {
    if (questions.length >= 5) break;
    const built = draft(city, bundle);
    if (!built) continue;
    questions.push({
      id: `q${questions.length + 1}`,
      type: built.options.length === 2 && built.options[0]?.id === 't' ? 'boolean' : 'single',
      prompt: built.prompt,
      options: built.options,
      answerId: built.answerId,
      explanation: built.explanation,
      sourceRefs: built.sourceRefs,
      factKind: built.factKind,
    });
  }
  return {
    cityId: city.cityId,
    cityName: city.standardName,
    questions,
    generatedAt: new Date().toISOString(),
  };
}
