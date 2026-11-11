/**
 * 构建期脚本：下载六座预置城市的行政区轮廓 GeoJSON。
 *
 * 数据源（默认）：DataV.GeoAtlas（免 Key 的公开接口，字段为 adcode/acroutes）。
 * 数据源（可选）：天地图行政区划服务 V2（`--source=tianditu`，需 TIANDITU_SERVER_KEY）。
 * 真实性约定：
 *  - 只写入成功下载并通过结构校验的文件，失败时优先使用本地缓存，绝不伪造轮廓；
 *  - 清单中记录来源、抓取时间与「授权/审图号待人工确认」提示；
 *  - 公开上线前必须完成地图合规审校，或替换为天地图/自然资源部标准地图来源。
 *
 * 坐标系注意：天地图返回的轮廓为 GCJ-02（与其瓦片一致），与项目 WGS84 红线冲突；
 * 因此 `--source=tianditu` 仅作为合规替换候选，默认仍使用 DataV，并在产物清单中
 * 显式记录坐标系。是否采用需人工合规判定，不得静默切换。
 *
 * 用法：npm run data:geo [-- --source=tianditu]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(here, '.cache/geo');
const OUTPUT_DIR = resolve(here, '../client/public/geo');
const SOURCE_TEMPLATE = 'https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json';
const USER_AGENT = 'CityLens/0.1 (build_geo_boundaries; local development)';
/** 天地图行政区划服务 V2（国标码为 9 位：156 + 6 位行政区划代码）。 */
const TIANDITU_TEMPLATE =
  'https://api.tianditu.gov.cn/v2/administrative?keyword=156{adcode}&childLevel=0&extensions=true';

const SOURCE_MODE = process.argv.includes('--source=tianditu') ? 'tianditu' : 'datav';

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
  properties?: {
    adcode?: number;
    name?: string;
    acroutes?: number[];
    coordSystem?: string;
  };
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
  if (SOURCE_MODE === 'tianditu') {
    return fetchTiandituBoundary(adcode);
  }
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

/* -------------------------------------------------------------------------- */
/* 天地图来源（GCJ-02，合规替换候选；默认不启用）                              */
/* -------------------------------------------------------------------------- */

type Ring = number[][];

/** 解析 WKT MULTIPOLYGON(((lng lat,...))) 为 GeoJSON 多边形数组。 */
function parseWktMultiPolygon(wkt: string): Array<Array<Ring>> {
  const polygons: Array<Array<Ring>> = [];
  const pattern = /\(\(([^()]+)\)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(wkt)) !== null) {
    const ring: Ring = match[1]!
      .split(',')
      .map((pair) => pair.trim().split(/\s+/).map(Number))
      .filter((point) => point.length === 2 && point.every((value) => Number.isFinite(value)));
    if (ring.length >= 3) polygons.push([ring]);
  }
  return polygons;
}

async function fetchTiandituBoundary(adcode: string): Promise<{
  data: BoundaryCollection;
  fromCache: boolean;
}> {
  const key = process.env.TIANDITU_SERVER_KEY?.trim() ?? '';
  if (!key) {
    throw new Error('[geo] 天地图来源需要 TIANDITU_SERVER_KEY（服务端 Key）');
  }
  const cachePath = resolve(CACHE_DIR, `tianditu_${adcode}.json`);
  const url = `${TIANDITU_TEMPLATE.replace('{adcode}', adcode)}&tk=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const payload = (await response.json()) as {
      status?: number;
      message?: string;
      data?: { district?: Array<{ name?: string; gb?: string; boundary?: string }> };
    };
    const district = payload.data?.district?.[0];
    if (!district?.boundary) {
      throw new Error(`天地图未返回轮廓（${payload.message ?? 'unknown'}）`);
    }
    const polygons = parseWktMultiPolygon(district.boundary);
    if (polygons.length === 0) throw new Error('天地图 WKT 解析结果为空');
    const data: BoundaryCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            name: district.name ?? adcode,
            coordSystem: 'GCJ-02',
          },
          geometry: { type: 'MultiPolygon', coordinates: polygons },
        },
      ],
    };
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(data)}\n`, 'utf8');
    return { data, fromCache: false };
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8')) as BoundaryCollection;
      console.warn(`[geo] ${adcode} 天地图联网失败，使用本地缓存：${(error as Error).message}`);
      return { data: cached, fromCache: true };
    } catch {
      throw new Error(`[geo] ${adcode} 天地图下载失败且无可用缓存：${(error as Error).message}`);
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
        source: SOURCE_MODE === 'tianditu' ? '天地图行政区划服务 V2' : 'DataV.GeoAtlas',
        sourceMode: SOURCE_MODE,
        sourceTemplate:
          SOURCE_MODE === 'tianditu'
            ? 'https://api.tianditu.gov.cn/v2/administrative?keyword=156{adcode}&childLevel=0&extensions=true'
            : SOURCE_TEMPLATE,
        coordSystem: SOURCE_MODE === 'tianditu' ? 'GCJ-02（天地图，需人工合规判定后采用）' : 'WGS84',
        fetchedAt: new Date().toISOString(),
        licenseNote:
          SOURCE_MODE === 'tianditu'
            ? '天地图轮廓为 GCJ-02（与其瓦片一致），与项目 WGS84 红线冲突；采用前需完成合规与坐标系判定，或改为自然资源部标准地图来源。'
            : 'DataV.GeoAtlas 公开轮廓的授权条款与审图号尚未完成人工确认；公开上线前必须合规审校，或替换为天地图/自然资源部标准地图来源。',
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
