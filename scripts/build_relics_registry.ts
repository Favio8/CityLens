/**
 * 构建期脚本：汇总 6 座预置城市的文物名录。
 * 来源：fact_snapshot 中带“全国重点文物保护单位 / 禁止出境展览文物”身份的实体。
 * 缺失字段统一填「待考」，不补造。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatYear } from './lib/wikidata';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(here, '../server/data/fact_snapshot');
const DICT_PATH = resolve(here, '../server/data/city_dictionary.json');
const OUTPUT = resolve(here, '../server/data/relics_registry.json');

interface SnapshotRelic {
  entityId: string;
  name: string;
  coordinates: [number, number] | null;
  inceptionYear: number | null;
  museumOrSite: string | null;
  location: string | null;
  designations: string[];
  description: string | null;
  sitelinks: number | null;
}

interface Snapshot {
  cityId: string;
  cityName: string;
  retrievedAt: string;
  sourceRef: { id: string; type: string; title: string; url: string; retrievedAt: string };
  relics: SnapshotRelic[];
}

async function main(): Promise<void> {
  const dict = JSON.parse(await readFile(DICT_PATH, 'utf8')) as {
    cities: Array<{ cityId: string; standardName: string }>;
  };
  const files = (await readdir(SNAPSHOT_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  if (files.length === 0) throw new Error('没有找到事实快照，请先运行 npm run data:snapshot');

  const registry: Array<{
    registryId: string;
    cityId: string;
    cityName: string;
    name: string;
    era: string;
    museumOrSite: string;
    protectionLevel: string;
    findSpot: string;
    coordinates: [number, number] | null;
    description: string | null;
    sourceRefs: string[];
  }> = [];
  const sources = new Map<string, Snapshot['sourceRef']>();
  const failures: string[] = [];

  for (const file of files) {
    const snapshot = JSON.parse(await readFile(resolve(SNAPSHOT_DIR, file), 'utf8')) as Snapshot;
    sources.set(snapshot.sourceRef.id, snapshot.sourceRef);
    const cityName =
      dict.cities.find((c) => c.cityId === snapshot.cityId)?.standardName ?? snapshot.cityName;
    for (const relic of snapshot.relics) {
      if (!relic.name) {
        failures.push(`${snapshot.cityId} 存在无名称文物 ${relic.entityId}`);
        continue;
      }
      const protectionLevel = relic.designations.length
        ? relic.designations.join('、')
        : '待考';
      registry.push({
        registryId: `${snapshot.cityId}:${relic.entityId}`,
        cityId: snapshot.cityId,
        cityName,
        name: relic.name,
        era: relic.inceptionYear === null ? '待考' : formatYear(relic.inceptionYear),
        museumOrSite: relic.museumOrSite ?? relic.location ?? '待考',
        protectionLevel,
        findSpot: '待考',
        coordinates: relic.coordinates,
        description: relic.description,
        sourceRefs: [snapshot.sourceRef.id],
      });
    }
  }

  registry.sort((a, b) => a.cityId.localeCompare(b.cityId) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const unique = new Map(registry.map((r) => [r.registryId, r]));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      name: 'Wikidata（全国重点文物保护单位 Q1188574 / 禁止出境展览文物 Q11155976）',
      note: '仅收录带官方遗产身份标记且位于该市行政范围内的实体；缺失字段填「待考」。',
    },
    failures,
    stats: { relics: unique.size },
    sources: [...sources.values()],
    relics: [...unique.values()],
  };
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[relics] 写入 ${unique.size} 件文物 → ${OUTPUT}`);
  if (failures.length) failures.forEach((f) => console.warn(`  - ${f}`));
}

main().catch((error) => {
  console.error('[relics] 失败：', (error as Error).message);
  process.exit(1);
});
