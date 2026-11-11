import { PRESET_CITY_IDS } from '../../shared/schema';
import type { Db } from './index';

export interface CityBrief {
  cityId: string;
  standardName: string;
  province: string;
  adminLevel: string;
  pinyin: string;
  englishName: string;
  center: [number, number];
  summary: string | null;
  hotRank: number | null;
  isPreset: boolean;
}

export interface AliasRow {
  aliasKey: string;
  displayAlias: string | null;
  cityId: string;
  matchType: string;
  hint: string | null;
  standardName: string;
  province: string;
  summary: string | null;
  englishName?: string | null;
}

interface CityRow {
  city_id: string;
  standard_name: string;
  province: string;
  admin_level: string;
  pinyin: string;
  english_name: string;
  center_lng: number;
  center_lat: number;
  summary: string | null;
  hot_rank: number | null;
  is_preset?: number;
}

function toBrief(row: CityRow): CityBrief {
  return {
    cityId: row.city_id,
    standardName: row.standard_name,
    province: row.province,
    adminLevel: row.admin_level,
    pinyin: row.pinyin,
    englishName: row.english_name,
    center: [row.center_lng, row.center_lat],
    summary: row.summary,
    hotRank: row.hot_rank,
    isPreset: row.is_preset === 1 || (PRESET_CITY_IDS as readonly string[]).includes(row.city_id),
  };
}

export class CityRepo {
  constructor(private readonly db: Db) {}

  listCities(): CityBrief[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COALESCE(a.is_preset, 0) AS is_preset
         FROM cities c LEFT JOIN city_archives a ON a.city_id = c.city_id`,
      )
      .all() as CityRow[];
    return rows.map(toBrief);
  }

  getCity(cityId: string): CityBrief | null {
    const row = this.db
      .prepare(
        `SELECT c.*, COALESCE(a.is_preset, 0) AS is_preset
         FROM cities c LEFT JOIN city_archives a ON a.city_id = c.city_id
         WHERE c.city_id = ?`,
      )
      .get(cityId) as CityRow | undefined;
    return row ? toBrief(row) : null;
  }

  findAliases(keys: string[]): AliasRow[] {
    if (keys.length === 0) return [];
    const uniqueKeys = [...new Set(keys)];
    const rows: AliasRow[] = [];
    // 分批查询，避免 SQLite 变量数量上限
    for (let i = 0; i < uniqueKeys.length; i += 200) {
      const chunk = uniqueKeys.slice(i, i + 200);
      const placeholders = chunk.map(() => '?').join(',');
      const result = this.db
        .prepare(
          `SELECT ca.alias_key, ca.display_alias, ca.city_id, ca.match_type, ca.hint,
                  c.standard_name, c.province, c.summary, c.english_name
           FROM city_aliases ca JOIN cities c ON c.city_id = ca.city_id
           WHERE ca.alias_key IN (${placeholders})`,
        )
        .all(...chunk) as Array<{
        alias_key: string;
        display_alias: string | null;
        city_id: string;
        match_type: string;
        hint: string | null;
        standard_name: string;
        province: string;
        summary: string | null;
        english_name: string | null;
      }>;
      for (const r of result) {
        rows.push({
          aliasKey: r.alias_key,
          displayAlias: r.display_alias,
          cityId: r.city_id,
          matchType: r.match_type,
          hint: r.hint,
          standardName: r.standard_name,
          province: r.province,
          summary: r.summary,
          englishName: r.english_name,
        });
      }
    }
    return rows;
  }

  /** 城市的古称/别称展示名（用于 meta.aliases 与预置档案）。 */
  listAncientAliases(cityId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(display_alias, alias_key) AS alias
         FROM city_aliases
         WHERE city_id = ? AND match_type = 'ancient'
         ORDER BY id ASC`,
      )
      .all(cityId) as Array<{ alias: string }>;
    return rows.map((r) => r.alias);
  }

  listHot(limit = 12): CityBrief[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COALESCE(a.is_preset, 0) AS is_preset
         FROM cities c LEFT JOIN city_archives a ON a.city_id = c.city_id
         WHERE c.hot_rank IS NOT NULL
         ORDER BY c.hot_rank ASC
         LIMIT ?`,
      )
      .all(limit) as CityRow[];
    if (rows.length > 0) return rows.map(toBrief);
    // 词典尚未设置热门排序时的兜底：按预置、名称排序
    const fallback = this.db
      .prepare(
        `SELECT c.*, COALESCE(a.is_preset, 0) AS is_preset
         FROM cities c LEFT JOIN city_archives a ON a.city_id = c.city_id
         ORDER BY is_preset DESC, c.city_id ASC LIMIT ?`,
      )
      .all(limit) as CityRow[];
    return fallback.map(toBrief);
  }

  countCities(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM cities').get() as { n: number };
    return row.n;
  }

  countPresets(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM city_archives WHERE is_preset = 1')
      .get() as { n: number };
    return row.n;
  }

  countArchives(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM city_archives').get() as { n: number };
    return row.n;
  }
}
