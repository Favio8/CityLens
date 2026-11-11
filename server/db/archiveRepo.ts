/**
 * 档案仓储层（PRD 5.2 表 3/表 4）。所有 SQL 收敛在此。
 * 模块级存储 + 事务内原子替换 + data_version 递增。
 */
import type {
  ArchiveStatus,
  ModuleName,
  ModuleStatus,
  SourceRef,
  ThemePalette,
} from '../../shared/schema';
import type { Db } from './index';

export interface ArchiveRecord {
  cityId: string;
  status: ArchiveStatus;
  themePalette: ThemePalette;
  sources: SourceRef[];
  schemaVersion: string;
  dataVersion: number;
  isPreset: boolean;
  generator: { model: string; promptVersion: string } | null;
  generatedAt: string;
  updatedAt: string;
}

export interface ModuleRecord {
  name: ModuleName;
  status: ModuleStatus;
  data: unknown | null;
  verification: unknown;
  generatedAt: string;
}

interface ArchiveRow {
  city_id: string;
  status: string;
  theme_palette_json: string;
  sources_json: string;
  schema_version: string;
  data_version: number;
  is_preset: number;
  generator_json: string | null;
  generated_at: string;
  updated_at: string;
}

interface ModuleRow {
  module_name: string;
  status: string;
  data_json: string | null;
  verification_json: string;
  generated_at: string;
}

export interface ArchiveWriteInput {
  cityId: string;
  status: ArchiveStatus;
  themePalette: ThemePalette;
  sources: SourceRef[];
  isPreset?: boolean;
  generator?: { model: string; promptVersion: string } | null;
  generatedAt: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class ArchiveRepo {
  constructor(private readonly db: Db) {}

  getArchive(cityId: string): ArchiveRecord | null {
    const row = this.db
      .prepare('SELECT * FROM city_archives WHERE city_id = ?')
      .get(cityId) as ArchiveRow | undefined;
    if (!row) return null;
    return {
      cityId: row.city_id,
      status: row.status as ArchiveStatus,
      themePalette: parseJson<ThemePalette>(row.theme_palette_json, {
        light: { primary: '#1E1E1E', secondary: '#5A564C', accent: '#8C3F2B' },
        dark: { primary: '#EAE6DF', secondary: '#A39E93', accent: '#C89B40' },
      }),
      sources: parseJson<SourceRef[]>(row.sources_json, []),
      schemaVersion: row.schema_version,
      dataVersion: row.data_version,
      isPreset: row.is_preset === 1,
      generator: parseJson<{ model: string; promptVersion: string } | null>(
        row.generator_json,
        null,
      ),
      generatedAt: row.generated_at,
      updatedAt: row.updated_at,
    };
  }

  listModules(cityId: string): ModuleRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM city_modules WHERE city_id = ?')
      .all(cityId) as ModuleRow[];
    return rows.map((row) => ({
      name: row.module_name as ModuleName,
      status: row.status as ModuleStatus,
      data: parseJson<unknown>(row.data_json, null),
      verification: parseJson<unknown>(row.verification_json, null),
      generatedAt: row.generated_at,
    }));
  }

  ensureArchive(input: ArchiveWriteInput): void {
    this.db
      .prepare(
        `INSERT INTO city_archives
           (city_id, status, theme_palette_json, sources_json, schema_version,
            data_version, is_preset, generator_json, generated_at, updated_at)
         VALUES (?, ?, ?, ?, '1.1', 1, ?, ?, ?, ?)
         ON CONFLICT(city_id) DO NOTHING`,
      )
      .run(
        input.cityId,
        input.status,
        JSON.stringify(input.themePalette),
        JSON.stringify(input.sources),
        input.isPreset ? 1 : 0,
        input.generator ? JSON.stringify(input.generator) : null,
        input.generatedAt,
        input.generatedAt,
      );
  }

  /** 预置档案构建：存在则整体覆盖元数据，便于重复执行构建脚本。 */
  upsertArchive(input: ArchiveWriteInput): void {
    this.db
      .prepare(
        `INSERT INTO city_archives
           (city_id, status, theme_palette_json, sources_json, schema_version,
            data_version, is_preset, generator_json, generated_at, updated_at)
         VALUES (?, ?, ?, ?, '1.1', 1, ?, ?, ?, ?)
         ON CONFLICT(city_id) DO UPDATE SET
           status = excluded.status,
           theme_palette_json = excluded.theme_palette_json,
           sources_json = excluded.sources_json,
           is_preset = excluded.is_preset,
           generator_json = excluded.generator_json,
           generated_at = excluded.generated_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.cityId,
        input.status,
        JSON.stringify(input.themePalette),
        JSON.stringify(input.sources),
        input.isPreset ? 1 : 0,
        input.generator ? JSON.stringify(input.generator) : null,
        input.generatedAt,
        input.generatedAt,
      );
  }

  /** 模块通过校验后原子替换，并递增 data_version。 */
  saveModule(input: {
    cityId: string;
    name: ModuleName;
    status: Exclude<ModuleStatus, 'missing'>;
    data: unknown;
    verification: unknown;
    generatedAt: string;
  }): void {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO city_modules
             (city_id, module_name, status, data_json, verification_json, generated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(city_id, module_name) DO UPDATE SET
             status = excluded.status,
             data_json = excluded.data_json,
             verification_json = excluded.verification_json,
             generated_at = excluded.generated_at`,
        )
        .run(
          input.cityId,
          input.name,
          input.status,
          JSON.stringify(input.data),
          JSON.stringify(input.verification ?? {}),
          input.generatedAt,
        );
      this.db
        .prepare(
          `UPDATE city_archives
           SET data_version = data_version + 1, updated_at = ?
           WHERE city_id = ?`,
        )
        .run(input.generatedAt, input.cityId);
    });
    transaction();
  }

  /** 模块失败：保留旧 data_json，只更新状态与校验记录。 */
  markModuleFailed(
    cityId: string,
    name: ModuleName,
    verification: unknown,
    generatedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO city_modules
           (city_id, module_name, status, data_json, verification_json, generated_at)
         VALUES (?, ?, 'failed', NULL, ?, ?)
         ON CONFLICT(city_id, module_name) DO UPDATE SET
           status = 'failed',
           verification_json = excluded.verification_json`,
      )
      .run(cityId, name, JSON.stringify(verification ?? {}), generatedAt);
  }

  updateStatus(cityId: string, status: ArchiveStatus, generatedAt?: string): void {
    this.db
      .prepare(
        `UPDATE city_archives SET status = ?, updated_at = ?
         WHERE city_id = ?`,
      )
      .run(status, generatedAt ?? new Date().toISOString(), cityId);
  }

  setMeta(
    cityId: string,
    input: {
      themePalette: ThemePalette;
      sources: SourceRef[];
      generator: { model: string; promptVersion: string } | null;
      generatedAt: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE city_archives
         SET theme_palette_json = ?, sources_json = ?, generator_json = ?,
             generated_at = ?, updated_at = ?
         WHERE city_id = ?`,
      )
      .run(
        JSON.stringify(input.themePalette),
        JSON.stringify(input.sources),
        input.generator ? JSON.stringify(input.generator) : null,
        input.generatedAt,
        input.generatedAt,
        cityId,
      );
  }

  updateTheme(cityId: string, palette: ThemePalette): void {
    this.db
      .prepare('UPDATE city_archives SET theme_palette_json = ?, updated_at = ? WHERE city_id = ?')
      .run(JSON.stringify(palette), new Date().toISOString(), cityId);
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

  /**
   * 清理未发布档案（P1-11 维护通道）：只删除 status='unpublished' 且非预置的
   * 档案行及其模块行；预置与已发布档案绝不受影响。返回被删除的 city_id 列表。
   */
  deleteUnpublished(): string[] {
    const rows = this.db
      .prepare("SELECT city_id FROM city_archives WHERE status = 'unpublished' AND is_preset = 0")
      .all() as Array<{ city_id: string }>;
    const cityIds = rows.map((row) => row.city_id);
    if (cityIds.length === 0) return [];
    const placeholders = cityIds.map(() => '?').join(',');
    const remove = this.db.transaction((ids: string[]) => {
      this.db.prepare(`DELETE FROM city_modules WHERE city_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM city_archives WHERE city_id IN (${placeholders})`).run(...ids);
    });
    remove(cityIds);
    return cityIds;
  }
}
