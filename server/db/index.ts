import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config';

export type Db = Database.Database;

const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** 打开数据库并确保表结构存在。WAL 模式 + 外键约束。 */
export function openDb(path: string = config.dbPath): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
