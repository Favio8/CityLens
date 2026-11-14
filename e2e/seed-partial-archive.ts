/**
 * e2e 辅助：为测试城市预置可公开读取的 partial 档案。
 *
 * 用途：Mock LLM 下 chronicle/localSoul/dataPulse 永远 NO_FACTS，新城市无法达到
 * 发布门槛；预置档案后即可在浏览器里回归「force 重生成 → 模块失败 → 重试」与
 * 「切城竞态」路径。identity/landmarks/relics/figures/poetics 五卷预置合格旧内容，
 * 其中 identity 同时用于回归「已有合格旧内容 → 刷新失败 → 旧内容仍在且可以单卷重试」
 * （e2e 场景 3 以 SIMULATE_FAIL=identity 触发）。E2E_CITY / E2E_CITY2 / E2E_CITY3
 * 三座城市都会预置（后两座分别用于切城竞态与断线恢复回归）。
 * 只写 e2e 自己的临时数据库（DB_PATH 指向临时目录），绝不触碰真实数据库。
 */
import { PENDING } from '../shared/schema';
import { openDb } from '../server/db';
import { ArchiveRepo } from '../server/db/archiveRepo';

const cities = [
  process.env.E2E_CITY ?? 'CN-321100',
  process.env.E2E_CITY2 ?? 'CN-320100',
  // 断线恢复回归专用：不与场景 3（写型刷新）共用城市，避免 5 分钟刷新冷却干扰。
  process.env.E2E_CITY3 ?? 'CN-320400',
];
const palette = {
  light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
  dark: { primary: '#D2957F', secondary: '#A8ADB4', accent: '#E0B860' },
};

const db = openDb();
const repo = new ArchiveRepo(db);

for (const cityId of cities) {
  const city = db
    .prepare('SELECT city_id, standard_name FROM cities WHERE city_id = ?')
    .get(cityId) as { city_id: string; standard_name: string } | undefined;
  if (!city) {
    console.error(`[e2e-seed] 城市 ${cityId} 不在词典中，请先 seed`);
    process.exit(1);
  }
  const generatedAt = new Date().toISOString();
  repo.ensureArchive({
    cityId,
    status: 'partial',
    themePalette: palette,
    sources: [
      { id: 'S-E2E', type: 'preset_manual', title: 'e2e 预置来源', retrievedAt: generatedAt },
    ],
    isPreset: false,
    generator: null,
    generatedAt,
  });

  const data: Record<string, unknown> = {
    identity: {
      standardName: city.standard_name,
      aliases: [city.standard_name],
      center: [118.0, 32.0],
      area: { value: PENDING, sourceRefs: [] },
      population: { value: PENDING, sourceRefs: [] },
      climateType: { value: PENDING, sourceRefs: [] },
      adminDivisions: { value: PENDING, sourceRefs: [] },
      oneLinePersona: `一座用于回归测试的${city.standard_name}。`,
      sourceRefs: ['S-E2E'],
      verification: 'pending_human_review',
    },
    landmarks: [
      {
        entityRef: 'Q-E2E-1',
        name: '测试景点',
        category: 'must_visit',
        bestSeason: PENDING,
        reason: 'e2e 预置景点，用于浏览器回归。',
        placeName: city.standard_name,
        coordinates: null,
        coordSource: 'city_center',
        sourceRefs: ['S-E2E'],
        verification: 'pending_human_review',
      },
    ],
    relics: [
      {
        registryId: 'R-E2E-1',
        name: '测试文物',
        era: '待考',
        museumOrSite: '测试馆',
        protectionLevel: '待考',
        findSpot: PENDING,
        story: 'e2e 预置文物，用于浏览器回归。',
        coordinates: null,
        sourceRefs: ['S-E2E'],
        verification: 'pending_human_review',
      },
    ],
    figures: [
      {
        entityRef: 'Q-E2E-2',
        name: '测试人物',
        dynasty: '待考',
        birthYear: PENDING,
        deathYear: PENDING,
        relationType: 'native',
        evidence: { property: 'birthplace', value: city.standard_name },
        cityBond: 'e2e 预置人物，用于浏览器回归。',
        highlights: 'e2e 预置生平，用于浏览器回归。',
        sites: [],
        sourceRefs: ['S-E2E'],
        verification: 'pending_human_review',
      },
    ],
    poetics: [
      {
        poemId: 'P-E2E-1',
        title: '测试诗',
        author: '测试人',
        dynasty: '唐',
        lines: ['测试诗句一行'],
        background: PENDING,
        relationType: 'direct',
        imageryMap: [],
        sourceRefs: ['S-E2E'],
        verification: 'pending_human_review',
      },
    ],
  };

  for (const [name, value] of Object.entries(data)) {
    repo.saveModule({
      cityId,
      name: name as 'identity',
      status: 'ok',
      data: value,
      verification: { status: 'pending_human_review' },
      generatedAt,
    });
  }
  // chronicle/localSoul/dataPulse 无旧内容：重生成失败时会展示错误卡与重试入口。
  for (const name of ['chronicle', 'localSoul', 'dataPulse'] as const) {
    repo.saveModule({
      cityId,
      name,
      status: 'failed',
      data: null,
      verification: { status: 'failed' },
      generatedAt,
    });
  }
  repo.updateStatus(cityId, 'partial', generatedAt);
  console.log(`[e2e-seed] 已为 ${city.standard_name}（${cityId}）预置 partial 档案`);
}
