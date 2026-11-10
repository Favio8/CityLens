/**
 * 构建期脚本：从 Wikidata P18 + Wikimedia Commons 抓取预置文物图片。
 *
 * 产物：
 *  - client/public/images/relics/<registryId>.<ext>：本地缩略图（默认宽 640）；
 *  - server/data/relic_images.json：署名、许可证、许可链接与来源页。
 *
 * 真实性约定：
 *  - 只使用 Wikidata 明确关联的 P18 图片，不按名称猜测配图；
 *  - 每张图必须带 Commons 返回的许可证与署名，缺失则跳过并记录原因；
 *  - 图片下载到本地，运行期不请求外部图片；许可仍需人工复核。
 *
 * 用法：npm run data:images（默认六城前 6 件文物；REFRESH_IMAGES=1 强制刷新）
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sparql, qidFromUri, sleep } from './lib/wikidata';

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(here, '../server/data/relics_registry.json');
const OUTPUT_JSON = resolve(here, '../server/data/relic_images.json');
const OUTPUT_DIR = resolve(here, '../client/public/images/relics');
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'CityLens/0.1 (build_relic_images; local development)';
const REFRESH = process.env.REFRESH_IMAGES === '1';
const IMAGE_WIDTH = 640;

const PRESET_IDS = ['CN-610100', 'CN-330100', 'CN-510100', 'CN-110000', 'CN-320500', 'CN-410300'];

interface RegistryRelic {
  registryId: string;
  cityId: string;
  name: string;
}

interface ImageRecord {
  registryId: string;
  cityId: string;
  name: string;
  qid: string;
  path: string;
  credit: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
  fetchedAt: string;
}

interface CommonsImageInfo {
  thumburl?: string;
  descriptionurl?: string;
  extmetadata?: Record<string, { value?: string }>;
}

function qidOf(registryId: string): string | null {
  const match = /:(Q\d+)$/.exec(registryId);
  return match?.[1] ?? null;
}

function stripHtml(value: string | undefined): string {
  return (value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Commons 的 Artist 字段常带 「(talk)」链接文本，展示前清理掉。 */
function normalizeCredit(value: string | undefined): string {
  return stripHtml(value)
    .replace(/\(\s*talk\s*\)/gi, '')
    .replace(/（\s*讨论\s*）/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function fileTitleFromP18(url: string): string | null {
  const marker = '/Special:FilePath/';
  const index = url.indexOf(marker);
  if (index < 0) return null;
  const name = decodeURIComponent(url.slice(index + marker.length).split('?')[0] ?? '');
  return name ? `File:${name}` : null;
}

function safeFileStem(registryId: string): string {
  return registryId.replace(/[^A-Za-z0-9_-]/g, '_');
}

async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url.slice(0, 120)} 获取失败：${(lastError as Error).message}`);
}

async function queryP18(qids: string[]): Promise<Map<string, string>> {
  const values = qids.map((qid) => `wd:${qid}`).join(' ');
  const query = `SELECT ?item ?image WHERE {
    VALUES ?item { ${values} }
    ?item wdt:P18 ?image .
  }`;
  const rows = await sparql(query);
  const map = new Map<string, string>();
  for (const row of rows) {
    const qid = qidFromUri(row.item?.value);
    const image = row.image?.value;
    if (qid && image && !map.has(qid)) map.set(qid, image);
  }
  return map;
}

async function queryCommons(titles: string[]): Promise<Map<string, CommonsImageInfo>> {
  const map = new Map<string, CommonsImageInfo>();
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    const url =
      `${COMMONS_API}?action=query&format=json&prop=imageinfo` +
      `&iiprop=url%7Cextmetadata&iiurlwidth=${IMAGE_WIDTH}` +
      `&titles=${encodeURIComponent(batch.join('|'))}`;
    const data = await fetchJson<{
      query?: { pages?: Record<string, { title?: string; imageinfo?: CommonsImageInfo[] }> };
    }>(url);
    for (const page of Object.values(data.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (page.title && info) map.set(page.title, info);
    }
    await sleep(400);
  }
  return map;
}

async function downloadImage(url: string, targetPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength < 1024) throw new Error('图片体积异常');
      await writeFile(targetPath, buffer);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1200 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url} 下载失败：${(lastError as Error).message}`);
}

async function loadExisting(): Promise<Map<string, ImageRecord>> {
  try {
    const data = JSON.parse(await readFile(OUTPUT_JSON, 'utf8')) as { records?: ImageRecord[] };
    const map = new Map<string, ImageRecord>();
    for (const record of data.records ?? []) {
      if (record.registryId && existsSync(resolve(here, '..', 'client/public', record.path.replace(/^\//, '')))) {
        map.set(record.registryId, record);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function main(): Promise<void> {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')) as {
    relics: RegistryRelic[];
  };
  const selected: RegistryRelic[] = [];
  for (const cityId of PRESET_IDS) {
    selected.push(...registry.relics.filter((relic) => relic.cityId === cityId).slice(0, 6));
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const existing = REFRESH ? new Map<string, ImageRecord>() : await loadExisting();
  const reused: ImageRecord[] = [];
  const pending: RegistryRelic[] = [];
  for (const relic of selected) {
    const record = existing.get(relic.registryId);
    if (record) reused.push(record);
    else pending.push(relic);
  }

  const skipped: Array<{ registryId: string; name: string; reason: string }> = [];
  const records: ImageRecord[] = [...reused];
  if (pending.length > 0) {
    const withQid = pending
      .map((relic) => ({ relic, qid: qidOf(relic.registryId) }))
      .filter((item): item is { relic: RegistryRelic; qid: string } => item.qid !== null);
    for (const relic of pending) {
      if (!qidOf(relic.registryId)) {
        skipped.push({ registryId: relic.registryId, name: relic.name, reason: 'registryId 不含 Wikidata QID' });
      }
    }

    const p18 = await queryP18([...new Set(withQid.map((item) => item.qid))]);
    const fileTitles = withQid
      .map((item) => ({ ...item, title: p18.get(item.qid) ? fileTitleFromP18(p18.get(item.qid)!) : null }))
      .filter((item): item is { relic: RegistryRelic; qid: string; title: string } => item.title !== null);
    for (const item of withQid) {
      if (!p18.has(item.qid)) {
        skipped.push({ registryId: item.relic.registryId, name: item.relic.name, reason: 'Wikidata 无 P18 图片' });
      }
    }

    const commons = await queryCommons(fileTitles.map((item) => item.title));
    for (const item of fileTitles) {
      const info = commons.get(item.title);
      if (!info?.thumburl || !info.descriptionurl) {
        skipped.push({ registryId: item.relic.registryId, name: item.relic.name, reason: 'Commons 无缩略图信息' });
        continue;
      }
      const license = stripHtml(info.extmetadata?.LicenseShortName?.value);
      const credit =
        normalizeCredit(info.extmetadata?.Artist?.value) ||
        normalizeCredit(info.extmetadata?.Credit?.value);
      if (!license || !credit) {
        skipped.push({ registryId: item.relic.registryId, name: item.relic.name, reason: '缺少许可证或署名' });
        continue;
      }
      const ext = extname(new URL(info.thumburl).pathname).toLowerCase() || '.jpg';
      const fileName = `${safeFileStem(item.relic.registryId)}${ext}`;
      const targetPath = resolve(OUTPUT_DIR, fileName);
      try {
        await downloadImage(info.thumburl, targetPath);
      } catch (error) {
        skipped.push({
          registryId: item.relic.registryId,
          name: item.relic.name,
          reason: `图片下载失败：${(error as Error).message}`,
        });
        continue;
      }
      records.push({
        registryId: item.relic.registryId,
        cityId: item.relic.cityId,
        name: item.relic.name,
        qid: item.qid,
        path: `/images/relics/${fileName}`,
        credit,
        license,
        licenseUrl: stripHtml(info.extmetadata?.LicenseUrl?.value) || null,
        sourceUrl: info.descriptionurl,
        fetchedAt: new Date().toISOString(),
      });
      console.log(`[images] ${item.relic.name} ← ${license} / ${credit}`);
    }
  }

  records.sort((a, b) => a.registryId.localeCompare(b.registryId));
  // 兼容旧记录：统一清理署名里的 talk 链接文本。
  for (const record of records) record.credit = normalizeCredit(record.credit);
  await writeFile(
    OUTPUT_JSON,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'Wikidata P18 + Wikimedia Commons imageinfo',
        licenseNote:
          '每条记录均保留 Commons 返回的许可证与署名；图片已下载到本地，但许可证适用性仍需人工复核。',
        stats: {
          requested: selected.length,
          downloaded: records.length,
          reused: reused.length,
          skipped: skipped.length,
        },
        records,
        skipped,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(
    `[images] 完成：请求 ${selected.length}，可用 ${records.length}（复用 ${reused.length}），跳过 ${skipped.length}`,
  );
  if (skipped.length > 0) {
    skipped.forEach((item) => console.warn(`  - ${item.name}：${item.reason}`));
  }
}

main().catch((error) => {
  console.error('[images] 失败：', (error as Error).message);
  process.exit(1);
});
