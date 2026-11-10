/**
 * 构建期脚本：行政区划代码表 → server/data/city_dictionary.json
 *
 * 数据源：Wikidata SPARQL（P442 中华人民共和国行政区划代码 + P625 坐标 + P131 上级行政区）。
 * 说明：
 * - 只收录代码为 4 位（省级 2 位 + 地级 2 位）的实体，即地级及以上行政区；
 * - 直辖市（北京/天津/上海/重庆）按 QID 单独查询；
 * - 特例白名单县级市（敦煌/曲阜/都江堰/阆中）按行政区划代码查询；
 * - 拼音由 pinyin-pro 生成并对多音字地名做人工覆盖；
 * - 古称/别称、区县归并提示、形近字纠错为人工整理，均标记为需人工复核。
 *
 * 网络失败时脚本以非 0 退出，且不覆盖已有产物（不伪造快照）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';
import { normalizeKey } from '../shared/validators';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(here, '../server/data/city_dictionary.json');
const USER_AGENT = 'CityLens/0.1 (build_city_dictionary; local development)';
const ENDPOINT = 'https://query.wikidata.org/sparql';

interface SparqlBinding {
  [key: string]: { value: string; type: string } | undefined;
}

interface DictCity {
  cityId: string;
  standardName: string;
  province: string;
  wikidataQid: string;
  adminLevel: 'municipality' | 'prefecture' | 'whitelist_county';
  countryCode: 'CN';
  pinyin: string;
  englishName: string;
  center: [number, number];
  summary: string;
  hotRank: number | null;
  aliases: Array<{
    key: string;
    display: string;
    matchType: 'standard' | 'ancient' | 'pinyin' | 'english' | 'district_hint' | 'typo';
    hint?: string;
    curated?: boolean;
  }>;
}

const PROVINCE_BY_CODE: Record<string, string> = {
  '11': '北京市',
  '12': '天津市',
  '13': '河北省',
  '14': '山西省',
  '15': '内蒙古自治区',
  '21': '辽宁省',
  '22': '吉林省',
  '23': '黑龙江省',
  '31': '上海市',
  '32': '江苏省',
  '33': '浙江省',
  '34': '安徽省',
  '35': '福建省',
  '36': '江西省',
  '37': '山东省',
  '41': '河南省',
  '42': '湖北省',
  '43': '湖南省',
  '44': '广东省',
  '45': '广西壮族自治区',
  '46': '海南省',
  '50': '重庆市',
  '51': '四川省',
  '52': '贵州省',
  '53': '云南省',
  '54': '西藏自治区',
  '61': '陕西省',
  '62': '甘肃省',
  '63': '青海省',
  '64': '宁夏回族自治区',
  '65': '新疆维吾尔自治区',
  '71': '台湾省',
  '81': '香港特别行政区',
  '82': '澳门特别行政区',
};

const WHITELIST: Array<{ code: string; name: string; province: string }> = [
  { code: '620982', name: '敦煌', province: '甘肃省' },
  { code: '370881', name: '曲阜', province: '山东省' },
  { code: '510181', name: '都江堰', province: '四川省' },
  { code: '511381', name: '阆中', province: '四川省' },
];

const MUNICIPALITIES: Array<{ qid: string; code: string; name: string; province: string }> = [
  { qid: 'Q956', code: '110000', name: '北京', province: '北京市' },
  { qid: 'Q7083', code: '120000', name: '天津', province: '天津市' },
  { qid: 'Q8686', code: '310000', name: '上海', province: '上海市' },
  { qid: 'Q11725', code: '500000', name: '重庆', province: '重庆市' },
];

const PRESET_CODES = new Set(['610100', '330100', '510100', '110000', '320500', '410300']);

const HOT_RANK: Record<string, number> = {
  西安: 1,
  杭州: 2,
  成都: 3,
  北京: 4,
  苏州: 5,
  洛阳: 6,
  南京: 7,
  上海: 8,
  广州: 9,
  重庆: 10,
  武汉: 11,
  长沙: 12,
  开封: 13,
  扬州: 14,
  泉州: 15,
  敦煌: 16,
  太原: 17,
  大同: 18,
  绍兴: 19,
  昆明: 20,
};

/** 多音字/特殊读音地名的人工覆盖（不依赖模型）。 */
const PINYIN_OVERRIDES: Record<string, string> = {
  西安: 'xian',
  六安: 'luan',
  蚌埠: 'bengbu',
  亳州: 'bozhou',
  台州: 'taizhou',
  宿州: 'suzhou',
  苏州: 'suzhou',
  福州: 'fuzhou',
  抚州: 'fuzhou',
  泰州: 'taizhou',
  厦门: 'xiamen',
  重庆: 'chongqing',
  长春: 'changchun',
  长沙: 'changsha',
  洛阳: 'luoyang',
  漯河: 'luohe',
  濮阳: 'puyang',
  衢州: 'quzhou',
  丽水: 'lishui',
  儋州: 'danzhou',
  泸州: 'luzhou',
  娄底: 'loudi',
  吕梁: 'lvliang',
  都江堰: 'dujiangyan',
  阆中: 'langzhong',
  曲阜: 'qufu',
  敦煌: 'dunhuang',
  '呼和浩特': 'huhehaote',
  '乌鲁木齐': 'wulumuqi',
};

const ENGLISH_OVERRIDES: Record<string, string> = {
  西安: "Xi'an",
  杭州: 'Hangzhou',
  成都: 'Chengdu',
  北京: 'Beijing',
  苏州: 'Suzhou',
  洛阳: 'Luoyang',
  南京: 'Nanjing',
  上海: 'Shanghai',
  广州: 'Guangzhou',
  重庆: 'Chongqing',
  武汉: 'Wuhan',
  长沙: 'Changsha',
  开封: 'Kaifeng',
  扬州: 'Yangzhou',
  泉州: 'Quanzhou',
  敦煌: 'Dunhuang',
  太原: 'Taiyuan',
  大同: 'Datong',
  绍兴: 'Shaoxing',
  昆明: 'Kunming',
  亳州: 'Bozhou',
  宿州: 'Suzhou',
  台州: 'Taizhou',
  泰州: 'Taizhou',
  抚州: 'Fuzhou',
  福州: 'Fuzhou',
};

/** 人工整理的古称/别称（前 60 座名城中的一部分，需人工复核）。 */
const ANCIENT_ALIASES: Record<string, string[]> = {
  西安: ['长安', '镐京', '京兆', '西京'],
  南京: ['金陵', '建康', '江宁', '应天', '石头城'],
  杭州: ['临安', '钱塘', '余杭', '武林'],
  苏州: ['姑苏', '吴门', '平江'],
  洛阳: ['洛邑', '神都', '东都', '雒阳'],
  成都: ['锦官城', '蓉城', '益州'],
  北京: ['燕京', '北平', '幽州', '蓟城'],
  开封: ['汴京', '汴梁'],
  扬州: ['广陵', '江都', '维扬'],
  武汉: ['江城', '武昌', '汉阳', '汉口'],
  广州: ['羊城', '穗城', '番禺'],
  长沙: ['潭州', '星城'],
  太原: ['晋阳', '并州'],
  大同: ['平城', '云中'],
  安阳: ['殷'],
  郑州: ['管城'],
  徐州: ['彭城'],
  镇江: ['京口', '润州'],
  常州: ['延陵', '毗陵'],
  无锡: ['梁溪', '金匮'],
  绍兴: ['越州', '会稽'],
  宁波: ['明州'],
  福州: ['榕城', '三山'],
  泉州: ['刺桐', '鲤城'],
  南昌: ['洪州', '豫章'],
  九江: ['浔阳', '江州'],
  合肥: ['庐州'],
  济南: ['泉城'],
  宝鸡: ['陈仓'],
  天水: ['秦州'],
  兰州: ['金城'],
  呼和浩特: ['归绥'],
  沈阳: ['盛京', '奉天'],
  敦煌: ['沙州'],
  都江堰: ['灌县'],
  重庆: ['渝州', '恭州'],
  天津: ['直沽', '津门'],
  上海: ['申城', '沪上'],
  厦门: ['鹭岛'],
  深圳: ['鹏城'],
  大理: ['叶榆'],
};

/** 区县名归并到上级城市（只收录全国唯一、不会误并的区县名）。 */
const DISTRICT_HINTS: Record<string, { city: string; hint: string }> = {
  临安: { city: '杭州', hint: '临安区为杭州市辖区；南宋都城临安即今杭州' },
  临安区: { city: '杭州', hint: '临安区为杭州市辖区；南宋都城临安即今杭州' },
  余杭: { city: '杭州', hint: '余杭区为杭州市辖区' },
  余杭区: { city: '杭州', hint: '余杭区为杭州市辖区' },
  姑苏区: { city: '苏州', hint: '姑苏区为苏州市辖区' },
  武侯区: { city: '成都', hint: '武侯区为成都市辖区' },
  锦江区: { city: '成都', hint: '锦江区为成都市辖区' },
  洛龙区: { city: '洛阳', hint: '洛龙区为洛阳市辖区' },
  涧西区: { city: '洛阳', hint: '涧西区为洛阳市辖区' },
  碑林区: { city: '西安', hint: '碑林区为西安市辖区' },
  雁塔区: { city: '西安', hint: '雁塔区为西安市辖区' },
  玄武区: { city: '南京', hint: '玄武区为南京市辖区' },
  黄浦区: { city: '上海', hint: '黄浦区为上海市辖区' },
  浦东新区: { city: '上海', hint: '浦东新区为上海市辖区' },
};

/** 形近字纠错（人工整理，需复核）。 */
const TYPO_ALIASES: Record<string, { city: string; hint: string }> = {
  毫州: { city: '亳州', hint: '已为你纠正为「亳州」（安徽省）' },
  株州: { city: '株洲', hint: '已为你纠正为「株洲」（湖南省）' },
  荷泽: { city: '菏泽', hint: '已为你纠正为「菏泽」（山东省）' },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sparql(query: string, attempt = 0): Promise<SparqlBinding[]> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ query, format: 'json' }).toString(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { results: { bindings: SparqlBinding[] } };
    return json.results.bindings;
  } catch (error) {
    if (attempt >= 2) throw error;
    await sleep(1500 * (attempt + 1));
    return sparql(query, attempt + 1);
  }
}

function parsePoint(value: string): [number, number] | null {
  const m = /Point\(([-\d.]+)\s+([-\d.]+)\)/.exec(value);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function cleanName(label: string): string {
  return label.replace(/市$/, '').trim();
}

function nameForPinyin(name: string): string {
  return name.replace(/(地区|自治州|盟|特别行政区)$/, '');
}

function makePinyin(name: string): string {
  const override = PINYIN_OVERRIDES[name];
  if (override) return override;
  const base = nameForPinyin(name);
  const arr = pinyin(base, { toneType: 'none', type: 'array' });
  return arr.join('').replace(/[^a-z]/gi, '').toLowerCase();
}

function makeEnglish(name: string, pinyinSyllable: string, wikidataLabel?: string): string {
  const override = ENGLISH_OVERRIDES[name];
  if (override) return override;
  if (wikidataLabel && /^[\x20-\x7E]+$/.test(wikidataLabel)) return wikidataLabel;
  return pinyinSyllable.charAt(0).toUpperCase() + pinyinSyllable.slice(1);
}

const MUNICIPALITY_CODES = new Set(['110000', '120000', '310000', '500000']);

function levelOf(name: string, code: string): DictCity['adminLevel'] {
  if (MUNICIPALITY_CODES.has(code)) return 'municipality';
  if (WHITELIST.some((w) => w.code === code)) return 'whitelist_county';
  return 'prefecture';
}

function summaryFor(province: string, adminLevel: DictCity['adminLevel'], name: string): string {
  if (adminLevel === 'municipality') return `直辖市 · ${province}`;
  if (adminLevel === 'whitelist_county') return `${province} · 县级市（文旅白名单）`;
  if (name.endsWith('自治州')) return `${province} · 自治州`;
  if (name.endsWith('地区')) return `${province} · 地区`;
  if (name.endsWith('盟')) return `${province} · 盟`;
  return `${province} · 地级市`;
}

function pushAlias(
  city: DictCity,
  key: string,
  matchType: DictCity['aliases'][number]['matchType'],
  display?: string,
  hint?: string,
): void {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  if (
    city.aliases.some(
      (a) => a.key === normalized && a.matchType === matchType,
    )
  ) {
    return;
  }
  const alias: DictCity['aliases'][number] = {
    key: normalized,
    display: display ?? key,
    matchType,
  };
  if (hint) alias.hint = hint;
  if (matchType === 'ancient' || matchType === 'district_hint' || matchType === 'typo') {
    alias.curated = true;
  }
  city.aliases.push(alias);
}

function dedupeAndSort(cities: DictCity[]): DictCity[] {
  const seen = new Set<string>();
  return cities
    .filter((city) => {
      if (seen.has(city.cityId)) return false;
      seen.add(city.cityId);
      return true;
    })
    .sort((a, b) => a.cityId.localeCompare(b.cityId));
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const cities: DictCity[] = [];

  const prefectureQuery = `SELECT ?item ?itemLabel ?code ?coord ?provinceLabel ?enLabel WHERE {
    ?item wdt:P442 ?code .
    ?item wdt:P625 ?coord .
    BIND(REPLACE(?code, " ", "") AS ?c)
    FILTER(STRLEN(?c) = 4)
    OPTIONAL { ?item wdt:P131 ?province . }
    OPTIONAL { ?item rdfs:label ?enLabel FILTER(LANG(?enLabel) = "en") }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
  }`;

  console.log('[dictionary] 查询地级及以上行政区（Wikidata SPARQL）…');
  let prefectureRows: SparqlBinding[] = [];
  try {
    prefectureRows = await sparql(prefectureQuery);
    console.log(`[dictionary] 返回 ${prefectureRows.length} 行`);
  } catch (error) {
    failures.push(`地级行政区查询失败：${(error as Error).message}`);
  }

  const byCode = new Map<
    string,
    { name: string; province: string; coord: [number, number]; en?: string; qid: string }
  >();
  for (const row of prefectureRows) {
    const codeRaw = row.code?.value;
    const coordRaw = row.coord?.value;
    const label = row.itemLabel?.value;
    if (!codeRaw || !coordRaw || !label) continue;
    if (label.includes('直辖县级')) continue;
    if (!/(市|地区|自治州|盟|特别行政区)$/.test(label)) continue;
    const compact = codeRaw.replace(/\s/g, '');
    if (compact.length !== 4) continue;
    const code = `${compact}00`;
    const name = cleanName(label);
    const coord = parsePoint(coordRaw);
    if (!coord) continue;
    const province =
      row.provinceLabel?.value && row.provinceLabel.value !== name
        ? row.provinceLabel.value
        : PROVINCE_BY_CODE[compact.slice(0, 2)] ?? '待考';
    const en = row.enLabel?.value;
    const qid = row.item?.value?.split('/').pop() ?? '';
    if (!qid) continue;
    const existing = byCode.get(code);
    if (!existing || (!existing.en && en)) {
      byCode.set(code, { name, province, coord, en, qid });
    }
  }

  console.log('[dictionary] 查询直辖市…');
  const muniQuery = `SELECT ?item ?itemLabel ?coord WHERE {
    VALUES ?item { ${MUNICIPALITIES.map((m) => `wd:${m.qid}`).join(' ')} }
    ?item wdt:P625 ?coord .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
  }`;
  try {
    const muniRows = await sparql(muniQuery);
    for (const row of muniRows) {
      const qid = row.item?.value?.split('/').pop();
      const coordRaw = row.coord?.value;
      const meta = MUNICIPALITIES.find((m) => m.qid === qid);
      if (!meta || !coordRaw) continue;
      const coord = parsePoint(coordRaw);
      if (!coord) continue;
      byCode.set(meta.code, { name: meta.name, province: meta.province, coord, qid: meta.qid });
    }
  } catch (error) {
    failures.push(`直辖市查询失败：${(error as Error).message}`);
  }
  if (!byCode.has('110000')) failures.push('未能取得北京市坐标');

  console.log('[dictionary] 查询白名单县级市…');
  for (const item of WHITELIST) {
    const labelQuery = `SELECT ?item ?itemLabel ?coord ?code WHERE {
      VALUES ?label { "${item.name}市"@zh-hans "${item.name}"@zh-hans "${item.name}市"@zh "${item.name}"@zh }
      ?item rdfs:label ?label .
      ?item wdt:P625 ?coord .
      OPTIONAL { ?item wdt:P442 ?code . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
    } LIMIT 5`;
    try {
      const rows = await sparql(labelQuery);
      const match = rows.find((row) => {
        const code = row.code?.value?.replace(/\s/g, '');
        return !code || code === item.code;
      });
      const coordRaw = match?.coord?.value;
      if (!coordRaw) {
        failures.push(`未能取得白名单城市「${item.name}」（${item.code}）的坐标`);
        continue;
      }
      const coord = parsePoint(coordRaw);
      if (!coord) {
        failures.push(`白名单城市「${item.name}」坐标解析失败`);
        continue;
      }
      byCode.set(item.code, {
        name: item.name,
        province: item.province,
        coord,
        qid: match?.item?.value?.split('/').pop() ?? '',
      });
    } catch (error) {
      failures.push(`白名单城市「${item.name}」查询失败：${(error as Error).message}`);
    }
  }
  for (const w of WHITELIST) {
    if (!byCode.has(w.code)) {
      console.warn(`[dictionary] 白名单城市「${w.name}」缺失，详见 failures`);
    }
  }

  for (const [code, info] of byCode) {
    const adminLevel = levelOf(info.name, code);
    const py = makePinyin(info.name);
    const city: DictCity = {
      cityId: `CN-${code}`,
      standardName: info.name,
      province: info.province,
      wikidataQid: info.qid,
      adminLevel,
      countryCode: 'CN',
      pinyin: py,
      englishName: makeEnglish(info.name, py, info.en),
      center: info.coord,
      summary: summaryFor(info.province, adminLevel, info.name),
      hotRank: HOT_RANK[info.name] ?? null,
      aliases: [],
    };
    pushAlias(city, info.name, 'standard');
    if (!info.name.endsWith('市')) pushAlias(city, `${info.name}市`, 'standard');
    pushAlias(city, py, 'pinyin');
    pushAlias(city, city.englishName, 'english');
    for (const alias of ANCIENT_ALIASES[info.name] ?? []) {
      pushAlias(city, alias, 'ancient', alias);
    }
    cities.push(city);
  }

  const byName = new Map(cities.map((c) => [c.standardName, c]));
  for (const [district, mapping] of Object.entries(DISTRICT_HINTS)) {
    const parent = byName.get(mapping.city);
    if (!parent) {
      failures.push(`区县归并目标城市不存在：${mapping.city}`);
      continue;
    }
    pushAlias(parent, district, 'district_hint', district, mapping.hint);
    const districtPinyin = makePinyin(district.replace(/新区$|区$|县$/, ''));
    if (districtPinyin && districtPinyin !== normalizeKey(district)) {
      pushAlias(parent, districtPinyin, 'district_hint', district, mapping.hint);
    }
  }
  for (const [typo, mapping] of Object.entries(TYPO_ALIASES)) {
    const target = byName.get(mapping.city);
    if (!target) {
      failures.push(`形近纠错目标城市不存在：${mapping.city}`);
      continue;
    }
    pushAlias(target, typo, 'typo', typo, mapping.hint);
  }

  const finalCities = dedupeAndSort(cities);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      name: 'Wikidata SPARQL',
      endpoint: ENDPOINT,
      query: 'P442 行政区划代码（4 位）+ P625 坐标 + P131 上级行政区',
      license: 'CC0（Wikidata 数据）',
      note: '古称/别称、区县归并提示、形近纠错为人工整理，标记 curated=true，需人工复核。',
    },
    failures,
    stats: {
      cities: finalCities.length,
      aliases: finalCities.reduce((n, c) => n + c.aliases.length, 0),
    },
    cities: finalCities,
  };

  await mkdir(dirname(OUTPUT), { recursive: true });
  const tmp = `${OUTPUT}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, OUTPUT);

  console.log(`[dictionary] 已写入 ${finalCities.length} 座城市 → ${OUTPUT}`);
  if (failures.length > 0) {
    console.warn(`[dictionary] 失败/降级记录 ${failures.length} 条：`);
    for (const f of failures) console.warn(`  - ${f}`);
  }

  // 自检：预置 6 城必须齐全
  for (const code of PRESET_CODES) {
    if (!finalCities.some((c) => c.cityId === `CN-${code}`)) {
      throw new Error(`预置城市缺失：CN-${code}`);
    }
  }
  if (finalCities.length < 300) {
    throw new Error(`城市数量异常：${finalCities.length}，应接近 333`);
  }
}

main().catch(async (error) => {
  console.error('[dictionary] 构建失败：', (error as Error).message);
  try {
    await readFile(OUTPUT);
    console.error('[dictionary] 已保留上一次成功产物，未覆盖。');
  } catch {
    console.error('[dictionary] 无可用旧产物。');
  }
  process.exit(1);
});
