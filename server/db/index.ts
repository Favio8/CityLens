import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config';

export type Db = Database.Database;

const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/**
 * 幂等迁移：老库的 generation_jobs 没有 attempt_id 列。
 * 必须在执行 schema.sql 之前补列，否则 schema.sql 里的索引会因缺列而失败。
 * 只加列，不改写历史行（历史任务 attempt_id 为 NULL，不伪造）。
 */
function migrateBeforeSchema(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generation_jobs'")
    .get() as { name: string } | undefined;
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(generation_jobs)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'attempt_id')) {
    db.exec('ALTER TABLE generation_jobs ADD COLUMN attempt_id TEXT');
  }
}

/** 打开数据库并确保表结构存在。WAL 模式 + 外键约束。 */
export function openDb(path: string = config.dbPath): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateBeforeSchema(db);
  db.exec(SCHEMA_SQL);
  return db;
}

let cached: Db | null = null;

export function getDb(): Db {
  if (!cached) cached = openDb();
  return cached;
}

export function closeDb(): void {
  cached?.close();
  cached = null;
}
