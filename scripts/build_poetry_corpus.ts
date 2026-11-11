/**
 * 构建期脚本：从 chinese-poetry 抽取与预置城市及重点非预置城市相关的诗词，建立逐字校验用本地库。
 *
 * 数据源：https://github.com/chinese-poetry/chinese-poetry（MIT）
 * - 全唐诗/poet.tang.*.json
 * - 宋词/ci.song.*.json
 * - 元曲/yuanqu.json
 *
 * 只保留命中城市名/古称/地标关键词的作品；繁体统一转简体用于比对，
 * 同时保留原文。网络失败如实记录，不伪造诗词。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';
import { loadDictionary } from './lib/wikidata';

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(here, '.cache/chinese-poetry');
const OUTPUT = resolve(here, '../server/data/verified_poetry_corpus.json');
const API = 'https://api.github.com/repos/chinese-poetry/chinese-poetry/contents';
const RAW = 'https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master';
const USER_AGENT = 'CityLens/0.1 (build_poetry_corpus)';
/** 可选：公开仓库只读 Token，用于提高 GitHub API 限额；不配置也能工作。 */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim() ?? '';
const LISTING_DIR = resolve(CACHE_DIR, '.listings');
const REFRESH_LISTING = process.env.REFRESH_POETRY === '1';

type Converter = (text: string) => string;
const toSimplified: Converter = (OpenCC as unknown as {
  Converter: (opts: { from: string; to: string }) => Converter;
}).Converter({ from: 'tw', to: 'cn' });

const PRESET_IDS = ['CN-610100', 'CN-330100', 'CN-510100', 'CN-110000', 'CN-320500', 'CN-410300'];

/** 额外覆盖的非预置城市：每城保留较少篇目，用于非预置城市的诗词卷。 */
const EXTRA_CITY_IDS = [
  'CN-320100', // 南京
  'CN-310000', // 上海
  'CN-440100', // 广州
  'CN-420100', // 武汉
  'CN-500000', // 重庆
  'CN-430100', // 长沙
  'CN-410100', // 郑州
  'CN-120000', // 天津
  'CN-370200', // 青岛
  'CN-350200', // 厦门
  'CN-530100', // 昆明
  'CN-321000', // 扬州
  'CN-330600', // 绍兴
  'CN-410200', // 开封
  'CN-140100', // 太原
  'CN-340100', // 合肥
  'CN-360100', // 南昌
  'CN-350100', // 福州
  'CN-350500', // 泉州
  'CN-320200', // 无锡
  'CN-321100', // 镇江
  'CN-330200', // 宁波
  'CN-320300', // 徐州
  'CN-450300', // 桂林
];
const ALL_CITY_IDS = [...PRESET_IDS, ...EXTRA_CITY_IDS];
/** 通用词/现代地名做城市名时极易误配，自动扩展时跳过。 */
const AUTO_KEYWORD_STOPLIST = new Set([
  '白银',
  '东方',
  '中山',
  '北海',
  '三沙',
  '三明',
  '双河',
  '新星',
  '白杨',
  '胡杨河',
]);
/** 预置城市保留 150 首，人工扩展城市 50 首，其余城市 20 首。 */
const POEMS_PER_CITY = new Map<string, number>([
  ...PRESET_IDS.map((id) => [id, 150] as const),
  ...EXTRA_CITY_IDS.map((id) => [id, 50] as const),
]);

/** 人工整理的城市相关地名关键词（仅用于筛选，不参与事实生成）。 */
const CITY_KEYWORDS: Record<string, string[]> = {
  'CN-610100': [
    '长安', '曲江', '灞桥', '渭水', '终南', '大明宫', '华清', '骊山', '未央', '慈恩寺',
    '大雁塔', '乐游原', '镐京', '京兆', '西京',
  ],
  'CN-330100': [
    '西湖', '钱塘', '临安', '孤山', '灵隐', '苏堤', '白堤', '余杭', '武林', '西泠',
    '六和塔', '钱塘湖', '之江',
  ],
  'CN-510100': [
    '成都', '锦官城', '浣花', '锦江', '青城', '武侯', '草堂', '益州', '蓉城', '蜀道',
    '岷江',
  ],
  'CN-110000': [
    '燕京', '幽州', '蓟门', '卢沟', '居庸', '金台', '北平', '燕山', '玉泉山',
  ],
  'CN-320500': [
    '姑苏', '苏州', '吴门', '平江', '枫桥', '寒山寺', '虎丘', '太湖', '阊门', '胥门',
    '吴江', '洞庭山',
  ],
  'CN-410300': [
    '洛阳', '洛水', '洛城', '龙门', '邙山', '金谷', '天津桥', '洛邑', '神都', '东都',
    '伊水', '北邙',
  ],
  'CN-320100': [
    '金陵', '秦淮', '钟山', '石头城', '建康', '建邺', '乌衣巷', '玄武湖', '莫愁湖',
    '栖霞', '台城', '凤凰台', '白下', '秣陵',
  ],
  'CN-310000': ['松江', '华亭', '沪渎', '申城', '黄浦', '歇浦', '龙华', '淀山', '云间'],
  'CN-440100': [
    '羊城', '穗城', '番禺', '珠江', '越秀', '白云山', '五羊', '花城', '南海', '尉佗',
  ],
  'CN-420100': [
    '黄鹤楼', '武昌', '汉阳', '江夏', '汉口', '鹦鹉洲', '晴川', '东湖', '龟山', '蛇山',
    '夏口',
  ],
  'CN-500000': [
    '渝州', '巴山', '巴渝', '山城', '瞿塘', '巫山', '白帝城', '嘉陵', '涪陵', '夔州',
    '江州',
  ],
  'CN-430100': ['湘江', '岳麓', '潭州', '星城', '橘子洲', '贾谊', '长沙', '浏阳', '湘水'],
  'CN-410100': ['管城', '商城', '圃田', '荥阳', '嵩山', '黄河', '中岳', '新郑', '郑国'],
  'CN-120000': ['直沽', '津门', '海河', '沽上', '盘山', '大沽', '天津', '三岔'],
  'CN-370200': ['胶澳', '琴岛', '崂山', '胶州', '即墨', '琅琊', '田横'],
  'CN-350200': ['鹭岛', '鹭江', '同安', '鼓浪屿', '嘉禾', '思明', '沧海'],
  'CN-530100': ['滇池', '春城', '昆州', '拓东', '金马', '碧鸡', '西山', '大观楼', '盘龙'],
  'CN-321000': [
    '广陵', '维扬', '江都', '瘦西湖', '二十四桥', '瓜洲', '平山堂', '竹西', '邗沟', '隋堤',
  ],
  'CN-330600': [
    '会稽', '越州', '山阴', '鉴湖', '兰亭', '若耶', '镜湖', '剡溪', '禹陵', '沈园', '越中',
  ],
  'CN-410200': ['汴京', '汴梁', '大梁', '东京', '夷门', '汴河', '相国寺', '龙亭', '金明', '陈留'],
  'CN-140100': ['并州', '晋阳', '龙城', '汾河', '晋祠', '天龙山', '双塔', '太原'],
  'CN-340100': ['庐州', '庐阳', '包河', '巢湖', '逍遥津', '淝水', '合肥'],
  'CN-360100': ['洪州', '豫章', '滕王阁', '赣江', '西山', '青云谱', '百花洲', '南昌'],
  'CN-350100': ['榕城', '三山', '闽江', '冶城', '西湖', '鼓山', '乌山', '于山', '福州'],
  'CN-350500': [
    '刺桐', '鲤城', '温陵', '清源山', '洛阳桥', '开元寺', '晋江', '安溪', '泉州',
  ],
  'CN-320200': ['梁溪', '金匮', '太湖', '惠山', '锡山', '鼋头渚', '梅里', '二泉', '无锡'],
  'CN-321100': ['京口', '润州', '北固', '金山', '焦山', '西津渡', '甘露', '镇江'],
  'CN-330200': ['明州', '鄞州', '四明', '甬江', '天一阁', '东钱湖', '招宝山', '宁波'],
  'CN-320300': ['彭城', '云龙', '泗水', '戏马台', '燕子楼', '九里山', '徐州'],
  'CN-450300': ['桂林', '漓江', '象鼻', '叠彩', '独秀', '阳朔', '苍梧', '桂州'],
  // 常见旅游城市补覆盖（古称 / 属地古迹；仅用于筛选，不参与事实生成）。
  'CN-130100': ['石家庄', '常山', '真定', '石邑', '井陉'],
  'CN-130300': ['秦皇岛', '碣石', '卢龙', '榆关', '昌黎'],
  'CN-130600': ['保定', '博陵', '范阳', '督亢', '涞水'],
  'CN-130700': ['张家口', '宣化', '武州', '涿鹿', '怀来'],
  'CN-130800': ['承德', '热河', '避暑山庄', '滦平'],
  'CN-210100': ['沈阳', '盛京', '奉天', '沈州'],
  'CN-210200': ['大连', '旅顺', '金州', '复州'],
  'CN-230100': ['哈尔滨', '上京', '会宁府', '阿勒锦'],
  'CN-320600': ['南通', '紫琅', '狼山'],
  'CN-320700': ['连云港', '海州', '朐山', '郁洲'],
  'CN-321300': ['宿迁', '下相', '钟吾'],
  'CN-330900': ['舟山', '昌国', '翁山'],
  'CN-331100': ['丽水', '处州', '栝州', '莲城'],
  'CN-340300': ['蚌埠', '钟离', '涂山'],
  'CN-340500': ['马鞍山', '当涂', '采石', '姑孰', '牛渚'],
};

/** 必须入库的经典名篇（入库后仍逐字比对原文）。 */
const SEEDS: Array<{ cityId: string; title: string; author: string }> = [
  { cityId: 'CN-610100', title: '登科后', author: '孟郊' },
  // 底本《御定全唐詩》题作「錢唐湖春行」（唐/塘古通），以库内原文为准，不改写。
  { cityId: 'CN-330100', title: '钱唐湖春行', author: '白居易' },
  { cityId: 'CN-330100', title: '望海潮', author: '柳永' },
  { cityId: 'CN-320500', title: '枫桥夜泊', author: '张继' },
  { cityId: 'CN-510100', title: '春夜喜雨', author: '杜甫' },
  { cityId: 'CN-510100', title: '蜀相', author: '杜甫' },
  { cityId: 'CN-410300', title: '春夜洛城闻笛', author: '李白' },
];

interface RawPoem {
  author?: string;
  title?: string;
  rhythmic?: string;
  paragraphs?: string[];
  id?: string;
  dynasty?: string;
}

interface CorpusPoem {
  poemId: string;
  title: string;
  author: string;
  dynasty: string;
  lines: string[];
  linesTraditional: string[];
  sourceUrl: string;
  matchedCities: string[];
  seedFor: string[];
  matchScore: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
      if (GITHUB_TOKEN && url.startsWith('https://api.github.com/')) {
        headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw new Error(`${url} 获取失败：${(lastError as Error).message}`);
}

/**
 * 目录清单优先读本地缓存：首次联网成功后写入 .listings，
 * 之后即使 GitHub API 被限流或断网，也能用已缓存的文件清单重建诗词库。
 */
async function listDir(dir: string): Promise<string[]> {
  const listingPath = resolve(LISTING_DIR, `${dir}.json`);
  if (!REFRESH_LISTING) {
    try {
      const cached = JSON.parse(await readFile(listingPath, 'utf8')) as { files: string[] };
      if (cached.files.length > 0) return cached.files;
    } catch {
      /* 首次运行没有清单，继续联网 */
    }
  }

  try {
    const items = await fetchJson<Array<{ name: string; type: string }>>(
      `${API}/${encodeURIComponent(dir)}?ref=master`,
    );
    const files = items.filter((i) => i.type === 'file').map((i) => i.name);
    await mkdir(LISTING_DIR, { recursive: true });
    await writeFile(listingPath, JSON.stringify({ dir, files, fetchedAt: new Date().toISOString() }, null, 2));
    return files;
  } catch (error) {
    // 联网失败时退回扫描本地缓存目录，保证离线可重建。
    try {
      const entries = await readdir(resolve(CACHE_DIR, dir));
      const files = entries.filter((name) => name.endsWith('.json')).sort();
      if (files.length > 0) {
        console.warn(`[poetry] ${dir} 目录联网失败，改用本地缓存清单（${files.length} 个文件）`);
        return files;
      }
    } catch {
      /* 本地也没有缓存 */
    }
    throw error;
  }
}

async function loadFile(dir: string, name: string): Promise<RawPoem[]> {
  const cachePath = resolve(CACHE_DIR, dir, name);
  try {
    return JSON.parse(await readFile(cachePath, 'utf8')) as RawPoem[];
  } catch {
    const url = `${RAW}/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`;
    const data = await fetchJson<RawPoem[]>(url);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(data), 'utf8');
    return data;
  }
}

function hash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * 去掉括注/夹注后再做地名匹配。
 * 古籍中的题注、夹注常含大量他城地名（例如杭州僧传注文里的「西岭草堂」），
 * 直接用全文匹配会把无关作品误配给别的城市。
 */
function stripAnnotations(text: string): string {
  let current = text;
  let previous: string;
  do {
    previous = current;
    current = current
      .replace(/（[^（）]*）/g, '')
      .replace(/〖[^〖〗]*〗/g, '')
      .replace(/\([^()]*\)/g, '');
  } while (current !== previous);
  return current;
}

interface KeywordHits {
  titleHits: number;
  bodyHits: number;
}

/** 分别统计标题与正文命中的关键词数量（同词只计一次）。 */
function countKeywordHits(title: string, body: string, keywords: string[]): KeywordHits {
  let titleHits = 0;
  let bodyHits = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (title.includes(keyword)) titleHits += 1;
    if (body.includes(keyword)) bodyHits += 1;
  }
  return { titleHits, bodyHits };
}

const SEED_KEYS = new Set(SEEDS.map((seed) => `${seed.author}|${seed.title}`));

function makePoem(
  raw: RawPoem,
  dynasty: string,
  sourceUrl: string,
  cityKeywords: Map<string, string[]>,
): CorpusPoem | null {
  const author = raw.author?.trim();
  const title = (raw.title ?? raw.rhythmic ?? '').trim();
  const linesTraditional = (raw.paragraphs ?? []).map((p) => p.trim()).filter(Boolean);
  if (!author || !title || linesTraditional.length === 0) return null;
  if (linesTraditional.some((l) => l.length === 0)) return null;

  const titleSimplified = toSimplified(title);
  const lines = linesTraditional.map((l) => toSimplified(l));
  const authorSimplified = toSimplified(author);
  const titleForMatch = stripAnnotations(titleSimplified);
  const bodyForMatch = stripAnnotations(lines.join('\n'));
  const isSeed = SEED_KEYS.has(`${authorSimplified}|${titleSimplified}`);

  const matchedCities: string[] = [];
  let bestScore = 0;
  for (const [cityId, keywords] of cityKeywords) {
    const { titleHits, bodyHits } = countKeywordHits(titleForMatch, bodyForMatch, keywords);
    // 标题命中视为直接相关；仅正文命中时要求至少两个不同关键词，避免单个泛称误配。
    if (titleHits > 0 || bodyHits >= 2) {
      matchedCities.push(cityId);
      bestScore = Math.max(bestScore, Math.min(titleHits * 6 + bodyHits, 20));
    }
  }
  // 名篇即使不含关键词也保留，交给 SEEDS 显式归属。
  if (matchedCities.length === 0 && !isSeed) return null;

  const contentKey = `${author}|${titleSimplified}|${lines.join('')}`;
  const poemId =
    dynasty === '唐' && raw.id ? `tang:${raw.id}` : `${dynasty === '宋' ? 'songci' : dynasty === '元' ? 'yuanqu' : 'poem'}:${hash(contentKey)}`;

  return {
    poemId,
    title: titleSimplified,
    author: authorSimplified,
    dynasty,
    lines,
    linesTraditional,
    sourceUrl,
    matchedCities,
    seedFor: [],
    matchScore: bestScore,
  };
}

async function main(): Promise<void> {
  const dict = loadDictionary();
  const allCities = dict.cities.filter(
    (city) => !AUTO_KEYWORD_STOPLIST.has(city.standardName),
  );
  const allCityIds = allCities.map((city) => city.cityId);
  const manualIds = new Set(ALL_CITY_IDS);
  const cityKeywords = new Map<string, string[]>();
  for (const city of allCities) {
    const keywords = new Set(CITY_KEYWORDS[city.cityId] ?? []);
    keywords.add(city.standardName);
    for (const alias of city.aliases) {
      if (alias.matchType === 'ancient') keywords.add(alias.display);
    }
    cityKeywords.set(city.cityId, [...keywords]);
  }

  const failures: string[] = [];
  const jobs: Array<{ dir: string; name: string; dynasty: string }> = [];

  try {
    const tangFiles = (await listDir('全唐诗')).filter((n) => /^poet\.tang\.\d+\.json$/.test(n));
    console.log(`[poetry] 全唐诗 ${tangFiles.length} 个文件`);
    tangFiles.forEach((name) => jobs.push({ dir: '全唐诗', name, dynasty: '唐' }));
  } catch (error) {
    failures.push(`全唐诗目录获取失败：${(error as Error).message}`);
  }
  try {
    const songFiles = (await listDir('宋词')).filter((n) => /^ci\.song\.\d+\.json$/.test(n));
    console.log(`[poetry] 宋词 ${songFiles.length} 个文件`);
    songFiles.forEach((name) => jobs.push({ dir: '宋词', name, dynasty: '宋' }));
  } catch (error) {
    failures.push(`宋词目录获取失败：${(error as Error).message}`);
  }
  jobs.push({ dir: '元曲', name: 'yuanqu.json', dynasty: '元' });

  const byCity = new Map<string, CorpusPoem[]>(allCityIds.map((id) => [id, []]));
  const byContent = new Map<string, CorpusPoem>();
  let processedFiles = 0;

  for (let i = 0; i < jobs.length; i += 4) {
    const batch = jobs.slice(i, i + 4);
    const results = await Promise.all(
      batch.map(async (job) => {
        try {
          const raw = await loadFile(job.dir, job.name);
          return { job, raw };
        } catch (error) {
          failures.push(`${job.dir}/${job.name} 下载失败：${(error as Error).message}`);
          return { job, raw: [] as RawPoem[] };
        }
      }),
    );
    for (const { job, raw } of results) {
      if (raw.length === 0) continue;
      processedFiles += 1;
      const sourceUrl = `${RAW}/${encodeURIComponent(job.dir)}/${encodeURIComponent(job.name)}`;
      for (const item of raw) {
        const poem = makePoem(item, job.dynasty, sourceUrl, cityKeywords);
        if (!poem) continue;
        const contentKey = `${poem.author}|${poem.title}|${poem.lines.join('')}`;
        if (byContent.has(contentKey)) {
          const existing = byContent.get(contentKey)!;
          for (const cityId of poem.matchedCities) {
            if (!existing.matchedCities.includes(cityId)) existing.matchedCities.push(cityId);
          }
          continue;
        }
        byContent.set(contentKey, poem);
        for (const cityId of poem.matchedCities) {
          byCity.get(cityId)!.push(poem);
        }
      }
    }
    console.log(`[poetry] 已处理 ${Math.min(i + 4, jobs.length)}/${jobs.length} 个文件，候选 ${byContent.size} 首`);
  }

  if (processedFiles === 0) {
    throw new Error(`全部诗词文件获取失败：${failures.join('; ')}`);
  }

  // 确保经典名篇入库
  for (const seed of SEEDS) {
    const found = [...byContent.values()].find(
      (p) => p.title === seed.title && p.author === seed.author,
    );
    if (!found) {
      failures.push(`名篇未入库：${seed.author}《${seed.title}》`);
      continue;
    }
    found.seedFor.push(seed.cityId);
    if (!found.matchedCities.includes(seed.cityId)) found.matchedCities.push(seed.cityId);
    const list = byCity.get(seed.cityId)!;
    if (!list.includes(found)) list.push(found);
  }

  // 预置城市 150 首、人工扩展城市 50 首、其余城市 20 首：名篇优先，其后按匹配分与标题排序
  const selected = new Map<string, CorpusPoem>();
  const cityStats: Record<string, number> = {};
  for (const cityId of allCityIds) {
    const list = byCity.get(cityId) ?? [];
    const deduped = [...new Set(list)].sort((a, b) => {
      const seedDiff = Number(b.seedFor.includes(cityId)) - Number(a.seedFor.includes(cityId));
      if (seedDiff !== 0) return seedDiff;
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return a.title.localeCompare(b.title, 'zh-Hans-CN');
    });
    const top = deduped.slice(0, POEMS_PER_CITY.get(cityId) ?? 20);
    cityStats[cityId] = top.length;
    top.forEach((poem) => selected.set(poem.poemId, poem));
    if (top.length === 0 && manualIds.has(cityId)) {
      failures.push(`${cityId} 没有检索到任何诗词`);
    }
  }

  const poems = [...selected.values()].sort(
    (a, b) => a.dynasty.localeCompare(b.dynasty, 'zh') || a.author.localeCompare(b.author, 'zh-Hans-CN'),
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      repo: 'https://github.com/chinese-poetry/chinese-poetry',
      license: 'MIT',
      note: '繁体已用 OpenCC 转为简体用于逐字比对，同时保留 linesTraditional 原文。',
    },
    stats: {
      filesProcessed: processedFiles,
      poems: poems.length,
      byCity: cityStats,
    },
    failures,
    poems,
  };

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  // 记录本地源文件缓存清单，便于下次离线重建与人工核对版本。
  const cachedFiles: Record<string, number> = {};
  for (const dir of ['全唐诗', '宋词', '元曲']) {
    try {
      cachedFiles[dir] = (await readdir(resolve(CACHE_DIR, dir))).filter((name) =>
        name.endsWith('.json'),
      ).length;
    } catch {
      cachedFiles[dir] = 0;
    }
  }
  await writeFile(
    resolve(CACHE_DIR, '_manifest.json'),
    `${JSON.stringify(
      {
        source: 'https://github.com/chinese-poetry/chinese-poetry',
        license: 'MIT',
        updatedAt: new Date().toISOString(),
        cachedFiles,
        note: '构建期源文件缓存，不提交到仓库；删除后重新运行 npm run data:poetry 会重新下载。',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`[poetry] 写入 ${poems.length} 首诗词 → ${OUTPUT}`);
  console.log('[poetry] 各城数量：', cityStats);
  if (failures.length) {
    console.warn(`[poetry] 降级记录 ${failures.length} 条：`);
    failures.forEach((f) => console.warn(`  - ${f}`));
  }
  for (const seed of SEEDS) {
    const found = poems.find((p) => p.title === seed.title && p.author === seed.author);
    if (!found) console.warn(`[poetry] 缺少名篇：${seed.author}《${seed.title}》`);
  }
}

main().catch((error) => {
  console.error('[poetry] 失败：', (error as Error).message);
  process.exit(1);
});
