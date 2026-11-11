/**
 * 构建期脚本：生成六座预置城市的「数说城市」基线数据。
 *
 * 数据来源：
 * - GDP / 常住人口：各市政府统计公报或政府数据页（逐城登记 URL，缺失年份为 null）。
 * - 气候：Open-Meteo ERA5 再分析 1991–2020 日值，按城市中心格点聚合为月均温与月降水。
 *
 * 绝不估算缺失年份；无来源的年份保持 null，前端显示「待考」。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDictionary } from './lib/wikidata';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(here, '../server/data/stats_baseline.json');
const CLIMATE_CACHE = resolve(here, '.cache/climate');
const REFRESH_CLIMATE = process.env.REFRESH_CLIMATE === '1';
const PRESET_IDS = ['CN-610100', 'CN-330100', 'CN-510100', 'CN-110000', 'CN-320500', 'CN-410300'];
const NOW = new Date().toISOString();

interface SeriesPoint {
  year: number;
  value: number | null;
}

interface SourceRef {
  id: string;
  type: 'gov_stat' | 'local_snapshot';
  title: string;
  url: string;
  retrievedAt: string;
}

interface CityStatsInput {
  gdp: { unit: string; caliber: string; sourceRefs: string[]; values: Record<number, number> };
  pop: { unit: string; caliber: string; sourceRefs: string[]; values: Record<number, number> };
}

const SOURCES: SourceRef[] = [
  {
    id: 'S-STAT-XA',
    type: 'gov_stat',
    title: '西安市人民政府数据页（来源：西安市国民经济和社会发展统计公报）',
    url: 'https://www.xa.gov.cn/sj/',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-XA-2025',
    type: 'gov_stat',
    title: '西安市2025年国民经济和社会发展统计公报',
    url: 'https://tjj.xa.gov.cn/tjsj/tjgb/tjgb/2055106184529166338.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-BJ-2021',
    type: 'gov_stat',
    title: '北京市2021年国民经济和社会发展统计公报',
    url: 'https://tjj.beijing.gov.cn/EnglishSite/SC/202204/P020220406395809040784.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-BJ-2022',
    type: 'gov_stat',
    title: '北京市2022年国民经济和社会发展统计公报',
    url: 'https://tjj.beijing.gov.cn/tjsj_31433/tjgb_31445/ndgb_31446/202303/t20230321_2940951.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-BJ-2023',
    type: 'gov_stat',
    title: '北京市2023年国民经济和社会发展统计公报',
    url: 'https://tjj.beijing.gov.cn/zxfbu/202403/t20240319_3594001.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-BJ-2024',
    type: 'gov_stat',
    title: '北京市2024年国民经济和社会发展统计公报',
    url: 'https://tjj.beijing.gov.cn/zxfbu/202503/t20250319_4038768.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-BJ-2025',
    type: 'gov_stat',
    title: '北京市2025年国民经济和社会发展统计公报',
    url: 'http://tjj.beijing.gov.cn/tjsj_31433/tjgb_31445/ndgb_31446/202603/t20260326_4566469.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-HZ-2021',
    type: 'gov_stat',
    title: '杭州市2021年国民经济和社会发展统计公报',
    url: 'https://tjj.hangzhou.gov.cn/art/2022/4/6/art_1229279682_4028665.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-HZ-2022',
    type: 'gov_stat',
    title: '杭州市2022年国民经济和社会发展统计公报',
    url: 'https://tjj.hangzhou.gov.cn/art/2023/3/20/art_1229279682_4149703.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-HZ-2022-POP',
    type: 'gov_stat',
    title: '2022年杭州人口主要数据（杭州市统计局）',
    url: 'https://tjj.hangzhou.gov.cn/art/2023/3/17/art_1229279240_4149695.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-HZ-2023',
    type: 'gov_stat',
    title: '杭州市2023年国民经济和社会发展统计公报',
    url: 'https://tjj.hangzhou.gov.cn/art/2024/3/15/art_1229279682_4246532.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-HZ-2025',
    type: 'gov_stat',
    title: '杭州市2025年国民经济和社会发展统计公报',
    url: 'https://tjj.hangzhou.gov.cn/col/col1229279682/art/2026/art_99cf56b3747b44b492375d4b4d4943d3.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-CD-2021',
    type: 'gov_stat',
    title: '成都市2021年国民经济和社会发展统计公报',
    url: 'https://cdstats.chengdu.gov.cn/cdstjj/uploads/20230222161346k5uiy2uqiaf.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-CD-2022',
    type: 'gov_stat',
    title: '成都市2022年国民经济和社会发展统计公报',
    url: 'https://cdstats.chengdu.gov.cn/gkml/uploadfiles/1607625235320909855/10898551684401725442022%20%E5%B9%B4%E6%88%90%E9%83%BD%E5%B8%82%E5%9B%BD%E6%B0%91%E7%BB%8F%E6%B5%8E%E5%92%8C%E7%A4%BE%E4%BC%9A%E5%8F%91%E5%B1%95%E7%BB%9F%E8%AE%A1%E5%85%AC%E6%8A%A5.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-CD-2023',
    type: 'gov_stat',
    title: '成都市2023年国民经济和社会发展统计公报',
    url: 'https://cdstats.chengdu.gov.cn/gkml/uploadfiles/1607625235320909855/12235749834820157442023%E5%B9%B4%E6%88%90%E9%83%BD%E5%B8%82%E5%9B%BD%E6%B0%91%E7%BB%8F%E6%B5%8E%E5%92%8C%E7%A4%BE%E4%BC%9A%E5%8F%91%E5%B1%95%E7%BB%9F%E8%AE%A1%E5%85%AC%E6%8A%A5.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-CD-2024',
    type: 'gov_stat',
    title: '成都市2024年国民经济和社会发展统计公报',
    url: 'https://cdstats.chengdu.gov.cn/gkml/uploadfiles/1607625235320909855/13573860346224967682024%E5%B9%B4%E6%88%90%E9%83%BD%E5%B8%82%E5%9B%BD%E6%B0%91%E7%BB%8F%E6%B5%8E%E5%92%8C%E7%A4%BE%E4%BC%9A%E5%8F%91%E5%B1%95%E7%BB%9F%E8%AE%A1%E5%85%AC%E6%8A%A5.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-CD-2025',
    type: 'gov_stat',
    title: '成都市2025年国民经济和社会发展统计公报',
    url: 'https://www.chengdu.gov.cn/gkml/uploadfiles/1607625235320909855/14939263714648391682025%E5%B9%B4%E6%88%90%E9%83%BD%E5%B8%82%E5%9B%BD%E6%B0%91%E7%BB%8F%E6%B5%8E%E5%92%8C%E7%A4%BE%E4%BC%9A%E5%8F%91%E5%B1%95%E7%BB%9F%E8%AE%A1%E5%85%AC%E6%8A%A5.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-SZ-2021',
    type: 'gov_stat',
    title: '苏州市2021年国民经济和社会发展概况（统计年鉴）',
    url: 'https://tjj.suzhou.gov.cn/sztjj/tjnj/2022/zk/html/gb.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-SZ-2021-POP',
    type: 'gov_stat',
    title: '苏州统计年鉴2022·综合（2021年末常住人口）',
    url: 'https://tjj.suzhou.gov.cn/sztjj/tjnj/2022/zk/html/sm01.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-SZ-2022',
    type: 'gov_stat',
    title: '苏州市2022年国民经济和社会发展统计公报',
    url: 'https://www.suzhou.gov.cn/szsrmzf/ndgmjjhshfztjsjfb/202303/cb4c9f0a234e453f8a2fc19a5049475c.shtml',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-SZ-2022-POP',
    type: 'gov_stat',
    title: '苏州统计年鉴2023·人口劳动力（2022年末常住人口）',
    url: 'https://tjj.suzhou.gov.cn/sztjj/tjnj/2023/zk/html/sm02.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-SZ-2023',
    type: 'gov_stat',
    title: '苏州市2023年国民经济和社会发展统计公报',
    url: 'http://tjj.suzhou.gov.cn/sztjj/tjgb/202403/44c648294e5e4275aa371908e6b199bc.shtml',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-SZ-2023-POP',
    type: 'gov_stat',
    title: '苏州统计年鉴2024·人口劳动力（2023年末常住人口）',
    url: 'https://tjj.suzhou.gov.cn/sztjj/tjnj/2024/2024/zk/html/sm02.pdf',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-SZ-2024',
    type: 'gov_stat',
    title: '苏州市2024年国民经济和社会发展统计公报',
    url: 'https://www.suzhou.gov.cn/szsrmzf/ndgmjjhshfztjsjfb/202506/c413b01f30224b7ba5ddbc1768cabe5c.shtml',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-SZ-2025',
    type: 'gov_stat',
    title: '苏州市2025年国民经济和社会发展统计公报',
    url: 'https://tjj.suzhou.gov.cn/sztjj/tjgb/202604/3dc4b574cabd4e86b36ec5d3280e927c.shtml',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-LY-2021',
    type: 'gov_stat',
    title: '洛阳市2021年国民经济和社会发展统计公报',
    url: 'http://lytjj.ly.gov.cn/2022/05-11/276288.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-LY-2022',
    type: 'gov_stat',
    title: '洛阳市2022年国民经济和社会发展统计公报',
    url: 'http://www.ly.gov.cn/2023/04-03/28904.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-LY-2023',
    type: 'gov_stat',
    title: '洛阳市2023年国民经济和社会发展统计公报',
    url: 'https://m.ly.gov.cn/2024/05-09/144721.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-LY-2024',
    type: 'gov_stat',
    title: '洛阳市2024年国民经济和社会发展统计公报',
    url: 'http://lytjj.ly.gov.cn/2025/04-24/564507.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-STAT-LY-2025',
    type: 'gov_stat',
    title: '洛阳市2025年国民经济和社会发展统计公报',
    url: 'http://www.ly.gov.cn/2026/05-11/1060335.html',
    retrievedAt: NOW,
  },
  {
    id: 'S-CLIMATE-OPENMETEO',
    type: 'local_snapshot',
    title: 'Open-Meteo ERA5 再分析 1991–2020 月均温与月降水',
    url: 'https://archive-api.open-meteo.com/v1/archive',
    retrievedAt: NOW,
  },
];

const STATS: Record<string, CityStatsInput> = {
  'CN-610100': {
    gdp: {
      unit: '亿元',
      caliber: '地区生产总值（现价）',
      sourceRefs: ['S-STAT-XA', 'S-STAT-XA-2025'],
      values: { 2021: 10688.28, 2022: 11486.51, 2023: 12010.76, 2024: 13317.78, 2025: 13902.67 },
    },
    pop: {
      unit: '万人',
      caliber: '年末常住人口（2022–2025）',
      sourceRefs: ['S-STAT-XA', 'S-STAT-XA-2025'],
      values: { 2022: 1299.59, 2023: 1307.82, 2024: 1316.76, 2025: 1323.63 },
    },
  },
  'CN-110000': {
    gdp: {
      unit: '亿元',
      caliber: '地区生产总值（现价，初步核算）',
      sourceRefs: [
        'S-STAT-BJ-2021',
        'S-STAT-BJ-2022',
        'S-STAT-BJ-2023',
        'S-STAT-BJ-2024',
        'S-STAT-BJ-2025',
      ],
      values: { 2021: 40269.6, 2022: 41610.9, 2023: 43760.7, 2024: 49843.1, 2025: 52073.4 },
    },
    pop: {
      unit: '万人',
      caliber: '年末常住人口（人口变动情况抽样调查推算数，官方公报发布值）',
      sourceRefs: [
        'S-STAT-BJ-2021',
        'S-STAT-BJ-2022',
        'S-STAT-BJ-2023',
        'S-STAT-BJ-2024',
        'S-STAT-BJ-2025',
      ],
      values: { 2021: 2188.6, 2022: 2184.3, 2023: 2185.8, 2024: 2183.2, 2025: 2180.0 },
    },
  },
  'CN-330100': {
    gdp: {
      unit: '亿元',
      caliber: '地区生产总值（现价，初步核算）',
      sourceRefs: ['S-STAT-HZ-2021', 'S-STAT-HZ-2022', 'S-STAT-HZ-2023', 'S-STAT-HZ-2025'],
      values: { 2021: 18109, 2022: 18753, 2023: 20059, 2024: 21860, 2025: 23011 },
    },
    pop: {
      unit: '万人',
      caliber: '年末常住人口（人口变动抽样调查推算）',
      sourceRefs: ['S-STAT-HZ-2021', 'S-STAT-HZ-2022-POP', 'S-STAT-HZ-2023', 'S-STAT-HZ-2025'],
      values: { 2021: 1220.4, 2022: 1237.6, 2023: 1252.2, 2024: 1262.4, 2025: 1270.0 },
    },
  },
  'CN-510100': {
    gdp: {
      unit: '亿元',
      caliber: '地区生产总值（现价，初步核算）',
      sourceRefs: ['S-STAT-CD-2021', 'S-STAT-CD-2022', 'S-STAT-CD-2023', 'S-STAT-CD-2024', 'S-STAT-CD-2025'],
      values: { 2021: 19917.0, 2022: 20817.5, 2023: 22074.7, 2024: 23511.3, 2025: 24763.6 },
    },
    pop: {
      unit: '万人',
      caliber: '年末常住人口',
      sourceRefs: ['S-STAT-CD-2021', 'S-STAT-CD-2022', 'S-STAT-CD-2023', 'S-STAT-CD-2024', 'S-STAT-CD-2025'],
      values: { 2021: 2119.2, 2022: 2126.8, 2023: 2140.3, 2024: 2147.4, 2025: 2153.5 },
    },
  },
  'CN-320500': {
    gdp: {
      unit: '亿元',
      caliber: '地区生产总值（现价，初步核算；2023 年初步数后经经济普查修订为 25513.4 亿元，未逐年替换）',
      sourceRefs: ['S-STAT-SZ-2021', 'S-STAT-SZ-2022', 'S-STAT-SZ-2023', 'S-STAT-SZ-2024', 'S-STAT-SZ-2025'],
      values: { 2021: 22718.3, 2022: 23958.34, 2023: 24653.4, 2024: 26727.0, 2025: 27695.1 },
    },
    pop: {
      unit: '万人',
      caliber: '年末常住人口（统计年鉴）',
      sourceRefs: ['S-STAT-SZ-2021-POP', 'S-STAT-SZ-2022-POP', 'S-STAT-SZ-2023-POP', 'S-STAT-SZ-2024', 'S-STAT-SZ-2025'],
      values: { 2021: 1284.78, 2022: 1291.06, 2023: 1295.8, 2024: 1298.7, 2025: 1304.77 },
    },
  },
  'CN-410300': {
    gdp: {
      unit: '亿元',
      caliber: '地区生产总值（现价，初步核算；2024 年最终核实为 5825.86 亿元）',
      sourceRefs: ['S-STAT-LY-2021', 'S-STAT-LY-2022', 'S-STAT-LY-2023', 'S-STAT-LY-2024', 'S-STAT-LY-2025'],
      values: { 2021: 5447.1, 2022: 5675.2, 2023: 5481.6, 2024: 5818.6, 2025: 6164.52 },
    },
    pop: {
      unit: '万人',
      caliber: '年末常住人口',
      sourceRefs: ['S-STAT-LY-2021', 'S-STAT-LY-2022', 'S-STAT-LY-2023', 'S-STAT-LY-2024', 'S-STAT-LY-2025'],
      values: { 2021: 706.9, 2022: 707.9, 2023: 707.9, 2024: 708.1, 2025: 708.3 },
    },
  },
};

function series(values: Record<number, number>): SeriesPoint[] {
  return [2021, 2022, 2023, 2024, 2025].map((year) => ({
    year,
    value: values[year] ?? null,
  }));
}

interface ClimatePayload {
  daily?: {
    time?: string[];
    temperature_2m_mean?: Array<number | null>;
    precipitation_sum?: Array<number | null>;
  };
}

async function fetchClimate(cityId: string, center: [number, number]) {
  const cachePath = resolve(CLIMATE_CACHE, `${cityId}.json`);
  let payload: ClimatePayload | null = null;
  if (!REFRESH_CLIMATE) {
    try {
      payload = JSON.parse(await readFile(cachePath, 'utf8')) as ClimatePayload;
    } catch {
      /* 无缓存，联网获取 */
    }
  }
  if (!payload?.daily) {
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${center[1]}&longitude=${center[0]}` +
      '&start_date=1991-01-01&end_date=2020-12-31&daily=temperature_2m_mean,precipitation_sum&timezone=Asia%2FShanghai';
    let response: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(url);
      if (response.ok) break;
      if (response.status === 429 && attempt < 3) {
        const waitMs = 15000 * (attempt + 1);
        console.warn(`[stats] 气候接口限流，${waitMs / 1000}s 后重试…`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
        continue;
      }
      throw new Error(`气候接口返回 ${response.status}`);
    }
    if (!response?.ok) throw new Error(`气候接口返回 ${response?.status ?? 'unknown'}`);
    payload = (await response.json()) as ClimatePayload;
    await mkdir(CLIMATE_CACHE, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  const daily = payload?.daily ?? {};
  const dates = daily.time ?? [];
  const temps = daily.temperature_2m_mean ?? [];
  const precs = daily.precipitation_sum ?? [];
  const buckets = new Map<number, { tempSum: number; tempDays: number; precipSum: number; years: Set<number> }>();
  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    if (!date) continue;
    const month = Number(date.slice(5, 7));
    if (!month) continue;
    const bucket = buckets.get(month) ?? { tempSum: 0, tempDays: 0, precipSum: 0, years: new Set<number>() };
    const temp = temps[i];
    const precip = precs[i];
    if (typeof temp === 'number' && Number.isFinite(temp)) {
      bucket.tempSum += temp;
      bucket.tempDays += 1;
    }
    if (typeof precip === 'number' && Number.isFinite(precip)) {
      bucket.precipSum += precip;
    }
    bucket.years.add(Number(date.slice(0, 4)));
    buckets.set(month, bucket);
  }

  const monthly = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const bucket = buckets.get(month);
    if (!bucket) return { month, tempC: null, precipMm: null };
    return {
      month,
      tempC: bucket.tempDays > 0 ? Math.round((bucket.tempSum / bucket.tempDays) * 10) / 10 : null,
      precipMm:
        bucket.years.size > 0
          ? Math.round((bucket.precipSum / bucket.years.size) * 10) / 10
          : null,
    };
  });
  return monthly;
}

async function main(): Promise<void> {
  const dict = loadDictionary();
  const cities: Record<string, unknown> = {};
  for (const cityId of PRESET_IDS) {
    const city = dict.cities.find((item) => item.cityId === cityId);
    const stats = STATS[cityId];
    if (!city || !stats) throw new Error(`缺少 ${cityId} 的词典或统计配置`);
    console.log(`[stats] ${city.standardName} 气候聚合中…`);
    const climateMonthly = await fetchClimate(cityId, city.center);
    cities[cityId] = {
      gdp: { ...stats.gdp, series: series(stats.gdp.values) },
      pop: { ...stats.pop, series: series(stats.pop.values) },
      climate: {
        period: '1991–2020',
        station: 'ERA5 再分析（城市中心格点）',
        sourceRefs: ['S-CLIMATE-OPENMETEO'],
        monthly: climateMonthly,
      },
    };
    console.log(`[stats] ${city.standardName} 完成：GDP ${stats.gdp.values[2025]} 亿元，常住人口 ${stats.pop.values[2025]} 万人`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    note: 'GDP/人口来自各市统计公报或政府数据页；缺失年份保持 null。气候为 Open-Meteo ERA5 1991–2020 聚合值。',
    sources: SOURCES,
    cities,
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[stats] 写入 ${Object.keys(cities).length} 座城市 → ${OUTPUT}`);
}

main().catch((error) => {
  console.error('[stats] 失败：', (error as Error).message);
  process.exit(1);
});
