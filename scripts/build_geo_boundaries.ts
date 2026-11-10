/**
 * 构建期脚本：下载六座预置城市的行政区轮廓 GeoJSON。
 *
 * 数据源：DataV.GeoAtlas（免 Key 的公开接口，字段为 adcode/acroutes）。
 * 真实性约定：
 *  - 只写入成功下载并通过结构校验的文件，失败时优先使用本地缓存，绝不伪造轮廓；
 *  - 清单中记录来源、抓取时间与「授权/审图号待人工确认」提示；
 *  - 公开上线前必须完成地图合规审校，或替换为天地图/自然资源部标准地图来源。
 *
 * 用法：npm run data:geo
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(here, '.cache/geo');
const OUTPUT_DIR = resolve(here, '../client/public/geo');
const SOURCE_TEMPLATE = 'https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json';
const USER_AGENT = 'CityLens/0.1 (build_geo_boundaries; local development)';

const PRESETS: Array<{ cityId: string; adcode: string }> = [
  { cityId: 'CN-610100', adcode: '610100' },
  { cityId: 'CN-330100', adcode: '330100' },
  { cityId: 'CN-510100', adcode: '510100' },
  { cityId: 'CN-110000', adcode: '110000' },
  { cityId: 'CN-320500', adcode: '320500' },
  { cityId: 'CN-410300', adcode: '410300' },
];

interface BoundaryFeature {
  type: string;
  properties?: { adcode?: number; name?: string; acroutes?: number[] };
  geometry?: { type?: string; coordinates?: unknown };
}

interface BoundaryCollection {
  type: 'FeatureCollection';
  features: BoundaryFeature[];
}

function validate(collection: BoundaryCollection, adcode: string): string[] {
  const issues: string[] = [];
  if (collection.type !== 'FeatureCollection') issues.push('type 不是 FeatureCollection');
  if (!Array.isArray(collection.features) || collection.features.length === 0) {
    issues.push('features 为空');
  }
  for (const [index, feature] of (collection.features ?? []).entries()) {
    if (!feature.geometry?.coordinates) issues.push(`第 ${index + 1} 个要素缺少 geometry`);
    const routes = feature.properties?.acroutes;
    if (Array.isArray(routes) && !routes.some((code) => String(code) === adcode)) {
      issues.push(`第 ${index + 1} 个要素的 acroutes 不包含 ${adcode}`);
    }
  }
  return issues;
}

async function fetchBoundary(adcode: string): Promise<{ data: BoundaryCollection; fromCache: boolean }> {
  const cachePath = resolve(CACHE_DIR, `${adcode}_full.json`);
  const url = SOURCE_TEMPLATE.replace('{adcode}', adcode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const data = (await response.json()) as BoundaryCollection;
    const issues = validate(data, adcode);
    if (issues.length > 0) throw new Error(`结构校验失败：${issues.join('；')}`);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(data)}\n`, 'utf8');
    return { data, fromCache: false };
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8')) as BoundaryCollection;
      const issues = validate(cached, adcode);
      if (issues.length > 0) throw new Error(issues.join('；'));
      console.warn(`[geo] ${adcode} 联网失败，使用本地缓存：${(error as Error).message}`);
      return { data: cached, fromCache: true };
    } catch {
      throw new Error(`[geo] ${adcode} 下载失败且无可用缓存：${(error as Error).message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const manifest: Array<{
    cityId: string;
    adcode: string;
    features: number;
    fromCache: boolean;
    sourceUrl: string;
  }> = [];

  for (const preset of PRESETS) {
    const { data, fromCache } = await fetchBoundary(preset.adcode);
    const outputPath = resolve(OUTPUT_DIR, `${preset.cityId}.json`);
    await writeFile(outputPath, `${JSON.stringify(data)}\n`, 'utf8');
    manifest.push({
      cityId: preset.cityId,
      adcode: preset.adcode,
      features: data.features.length,
      fromCache,
      sourceUrl: SOURCE_TEMPLATE.replace('{adcode}', preset.adcode),
    });
    console.log(
      `[geo] ${preset.cityId} ← ${preset.adcode}：${data.features.length} 个区县` +
        (fromCache ? '（缓存）' : ''),
    );
  }

  await writeFile(
    resolve(OUTPUT_DIR, '_manifest.json'),
    `${JSON.stringify(
      {
        source: 'DataV.GeoAtlas',
        sourceTemplate: SOURCE_TEMPLATE,
        fetchedAt: new Date().toISOString(),
        licenseNote:
          'DataV.GeoAtlas 公开轮廓的授权条款与审图号尚未完成人工确认；公开上线前必须合规审校，或替换为天地图/自然资源部标准地图来源。',
        cities: manifest,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`[geo] 写入 ${manifest.length} 份轮廓与清单 → ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error('[geo] 失败：', (error as Error).message);
  process.exit(1);
});
