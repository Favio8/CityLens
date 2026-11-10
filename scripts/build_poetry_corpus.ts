/**
 * 构建期脚本：从 chinese-poetry 抽取与 6 座预置城市相关的诗词，建立逐字校验用本地库。
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

type Converter = (text: string) => string;
const toSimplified: Converter = (OpenCC as unknown as {
  Converter: (opts: { from: string; to: string }) => Converter;
}).Converter({ from: 'tw', to: 'cn' });

const PRESET_IDS = ['CN-610100', 'CN-330100', 'CN-510100', 'CN-110000', 'CN-320500', 'CN-410300'];

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
    '燕京', '幽州', '大都', '蓟门', '卢沟', '居庸', '金台', '北平', '燕山', '玉泉山',
  ],
  'CN-320500': [
    '姑苏', '苏州', '吴门', '平江', '枫桥', '寒山寺', '虎丘', '太湖', '阊门', '胥门',
    '吴江', '洞庭山',
  ],
  'CN-410300': [
    '洛阳', '洛水', '洛城', '龙门', '邙山', '金谷', '天津桥', '洛邑', '神都', '东都',
    '伊水', '北邙',
  ],
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
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw new Error(`${url} 获取失败：${(lastError as Error).message}`);
}

async function listDir(dir: string): Promise<string[]> {
  const items = await fetchJson<Array<{ name: string; type: string }>>(
    `${API}/${encodeURIComponent(dir)}?ref=master`,
  );
  return items.filter((i) => i.type === 'file').map((i) => i.name);
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

function scorePoem(title: string, body: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (title.includes(keyword)) score += 6;
    if (body.includes(keyword)) score += 1;
  }
  return Math.min(score, 20);
}

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
  const text = `${titleSimplified}\n${lines.join('\n')}`;

  const matchedCities: string[] = [];
  let bestScore = 0;
  for (const [cityId, keywords] of cityKeywords) {
    const score = scorePoem(titleSimplified, text, keywords);
    if (score > 0) {
      matchedCities.push(cityId);
      bestScore = Math.max(bestScore, score);
    }
  }
  if (matchedCities.length === 0) return null;

  const contentKey = `${author}|${titleSimplified}|${lines.join('')}`;
  const poemId =
    dynasty === '唐' && raw.id ? `tang:${raw.id}` : `${dynasty === '宋' ? 'songci' : dynasty === '元' ? 'yuanqu' : 'poem'}:${hash(contentKey)}`;

  return {
    poemId,
    title: titleSimplified,
    author: toSimplified(author),
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
  const cityKeywords = new Map<string, string[]>();
  for (const cityId of PRESET_IDS) {
    const city = dict.cities.find((c) => c.cityId === cityId);
    if (!city) throw new Error(`词典缺少预置城市 ${cityId}`);
    const keywords = new Set(CITY_KEYWORDS[cityId] ?? []);
    keywords.add(city.standardName);
    for (const alias of city.aliases) {
      if (alias.matchType === 'ancient') keywords.add(alias.display);
    }
    cityKeywords.set(cityId, [...keywords]);
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

  const byCity = new Map<string, CorpusPoem[]>(PRESET_IDS.map((id) => [id, []]));
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

  // 每城保留 150 首：名篇优先，其后按匹配分与文本长度排序
  const selected = new Map<string, CorpusPoem>();
  const cityStats: Record<string, number> = {};
  for (const cityId of PRESET_IDS) {
    const list = byCity.get(cityId) ?? [];
    const deduped = [...new Set(list)].sort((a, b) => {
      const seedDiff = Number(b.seedFor.includes(cityId)) - Number(a.seedFor.includes(cityId));
      if (seedDiff !== 0) return seedDiff;
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return a.title.localeCompare(b.title, 'zh-Hans-CN');
    });
    const top = deduped.slice(0, 150);
    cityStats[cityId] = top.length;
    top.forEach((poem) => selected.set(poem.poemId, poem));
    if (top.length === 0) failures.push(`${cityId} 没有检索到任何诗词`);
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
