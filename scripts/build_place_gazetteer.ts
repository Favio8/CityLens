/**
 * 构建期脚本：地名坐标库（WGS84）。
 * 来源：事实快照中的景点/文物坐标 + 行政区中心点。只收录有真实坐标的条目。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDictionary } from './lib/wikidata';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(here, '../server/data/fact_snapshot');
const OUTPUT = resolve(here, '../server/data/place_gazetteer.json');

interface Snapshot {
  cityId: string;
  retrievedAt: string;
  sourceRef: { id: string; type: string; title: string; url: string; retrievedAt: string };
  landmarks: Array<{ entityId: string; name: string; coordinates: [number, number] }>;
  relics: Array<{ entityId: string; name: string; coordinates: [number, number] | null }>;
}

function normalize(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').trim();
}

async function main(): Promise<void> {
  const dict = loadDictionary();
  const entries: Array<{
    name: string;
    coordinates: [number, number];
    cityId: string;
    kind: string;
    entityId: string;
    sourceRef: string;
  }> = [];
  const seen = new Set<string>();

  const add = (
    name: string,
    coordinates: [number, number] | null,
    cityId: string,
    kind: string,
    entityId: string,
    sourceRef: string,
  ) => {
    if (!name || !coordinates) return;
    const key = `${cityId}|${normalize(name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name: normalize(name), coordinates, cityId, kind, entityId, sourceRef });
  };

  for (const city of dict.cities) {
    add(city.standardName, city.center, city.cityId, 'city_center', city.wikidataQid, 'S-DICT');
  }

  const files = (await readdir(SNAPSHOT_DIR).catch(() => [] as string[])).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_'),
  );
  for (const file of files) {
    const snapshot = JSON.parse(
      await readFile(resolve(SNAPSHOT_DIR, file), 'utf8'),
    ) as Snapshot;
    for (const item of snapshot.landmarks) {
      add(item.name, item.coordinates, snapshot.cityId, 'landmark', item.entityId, snapshot.sourceRef.id);
    }
    for (const item of snapshot.relics) {
      add(item.name, item.coordinates, snapshot.cityId, 'relic', item.entityId, snapshot.sourceRef.id);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      name: 'Wikidata SPARQL（P625）+ 行政区中心点',
      note: '全部为 WGS84；同名地点按 cityId 区分，不做跨城猜测。',
    },
    stats: { entries: entries.length },
    entries,
  };
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[gazetteer] 写入 ${entries.length} 条地名坐标 → ${OUTPUT}`);
}

main().catch((error) => {
  console.error('[gazetteer] 失败：', (error as Error).message);
  process.exit(1);
});
