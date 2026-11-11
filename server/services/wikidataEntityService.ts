/**
 * Wikidata 城市实体事实：人口历史、面积与坐标。
 * 只读取带明确来源的声明，不做推算。
 */
import { parseWikibaseYear, sparql, type Binding } from '../../scripts/lib/wikidata';

export interface WikidataCityFacts {
  qid: string;
  populations: Array<{ year: number; value: number }>;
  areaKm2: number | null;
  label: string | null;
  description: string | null;
}

interface Claim {
  mainsnak?: { datavalue?: { value?: unknown } };
  rank?: string;
  qualifiers?: Record<string, Array<{ datavalue?: { value?: unknown } }>>;
}

interface EntityPayload {
  entities?: Record<
    string,
    {
      labels?: Record<string, { value?: string }>;
      descriptions?: Record<string, { value?: string }>;
      claims?: Record<string, Claim[]>;
    }
  >;
}

function claimValue(claim: Claim): unknown {
  return claim.mainsnak?.datavalue?.value;
}

function qualifierYear(claim: Claim): number | null {
  const time = claim.qualifiers?.P585?.[0]?.datavalue?.value;
  if (!time || typeof time !== 'object') return null;
  const value = (time as { time?: unknown }).time;
  if (typeof value !== 'string') return null;
  const match = /^[+-](\d{4})-/.exec(value);
  return match ? Number(match[1]) : null;
}

export async function fetchWikidataCityFacts(qid: string): Promise<WikidataCityFacts | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  try {
    const response = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, {
      headers: {
        'User-Agent': 'CityLens/0.1 (local research; contact: local)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as EntityPayload;
    const entity = payload.entities?.[qid];
    const claims = entity?.claims ?? {};

    const populations: Array<{ year: number; value: number }> = [];
    for (const claim of claims.P1082 ?? []) {
      if (claim.rank === 'deprecated') continue;
      const value = Number(claimValue(claim));
      const year = qualifierYear(claim);
      if (!Number.isFinite(value) || value <= 0 || !year) continue;
      populations.push({ year, value });
    }
    const byYear = new Map<number, number>();
    for (const point of populations.sort((a, b) => b.year - a.year)) {
      if (!byYear.has(point.year)) byYear.set(point.year, point.value);
    }

    let areaKm2: number | null = null;
    for (const claim of claims.P2046 ?? []) {
      if (claim.rank === 'deprecated') continue;
      const value = Number(claimValue(claim));
      if (Number.isFinite(value) && value > 0) {
        areaKm2 = Math.round(value * 100) / 100;
        break;
      }
    }

    return {
      qid,
      populations: [...byYear.entries()].map(([year, value]) => ({ year, value })),
      areaKm2,
      label: entity?.labels?.zh?.value?.trim() ?? null,
      description: entity?.descriptions?.zh?.value?.trim() ?? null,
    };
  } catch {
    return null;
  }
}

export interface PersonFacts {
  qid: string;
  label: string;
  description: string | null;
  birthYear: number | null;
  deathYear: number | null;
  sitelinks: number;
}

/** 批量读取人物基础事实（生卒、描述、跨语言站点数）。 */
export async function fetchPersonFacts(qids: string[]): Promise<PersonFacts[]> {
  const unique = [...new Set(qids.filter((qid) => /^Q\d+$/.test(qid)))];
  if (unique.length === 0) return [];
  const results: PersonFacts[] = [];
  for (let index = 0; index < unique.length; index += 50) {
    results.push(...(await fetchPersonBatch(unique.slice(index, index + 50))));
  }
  return results;
}

async function fetchPersonBatch(qids: string[]): Promise<PersonFacts[]> {
  const query = `SELECT ?p ?pLabel ?birth ?death ?sl ?desc WHERE {
    VALUES ?p { ${qids.map((qid) => `wd:${qid}`).join(' ')} }
    OPTIONAL { ?p wdt:P569 ?birth }
    OPTIONAL { ?p wdt:P570 ?death }
    OPTIONAL { ?p wikibase:sitelinks ?sl }
    OPTIONAL { ?p schema:description ?desc FILTER(LANG(?desc) = "zh-hans") }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
  }`;
  try {
    const rows = await sparql(query, 0, 15000);
    const byQid = new Map<string, PersonFacts>();
    for (const row of rows) {
      const qid = qidFromValue(row.p);
      const label = textValue(row, 'pLabel');
      if (!qid || !label || byQid.has(qid)) continue;
      byQid.set(qid, {
        qid,
        label,
        description: textValue(row, 'desc'),
        birthYear: parseWikibaseYear(row.birth?.value),
        deathYear: parseWikibaseYear(row.death?.value),
        sitelinks: Number(row.sl?.value ?? 0) || 0,
      });
    }
    return [...byQid.values()];
  } catch {
    return [];
  }
}

function textValue(row: Binding, key: string): string | null {
  const value = row[key]?.value;
  return value && value.trim() ? value.trim() : null;
}

function qidFromValue(binding: Binding['p']): string | null {
  const uri = binding?.value;
  if (!uri) return null;
  const match = /(Q\d+)$/.exec(uri);
  return match?.[1] ?? null;
}
