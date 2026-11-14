import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './index';
import { JobRepo } from './jobRepo';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('generation_jobs attempt_id 迁移（隔离副本）', () => {
  it('老库补列后保留历史行，attempt_id 保持 NULL（不伪造）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'citylens-migration-'));
    tempDirs.push(dir);
    const path = join(dir, 'legacy.db');

    // 构造迁移前的老库：generation_jobs 没有 attempt_id 列，并写入一条历史任务。
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE generation_jobs (
        job_id          TEXT PRIMARY KEY,
        city_id         TEXT NOT NULL,
        status          TEXT NOT NULL,
        force_flag      INTEGER NOT NULL DEFAULT 0,
        modules_json    TEXT NOT NULL,
        failed_json     TEXT,
        requester_hash  TEXT NOT NULL,
        llm_calls       INTEGER NOT NULL DEFAULT 0,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        cooldown_until  TEXT
      );
      INSERT INTO generation_jobs
        (job_id, city_id, status, modules_json, requester_hash, started_at)
      VALUES ('legacy-job', 'CN-610100', 'done', '["identity"]', 'hash-old', '2026-11-01T00:00:00.000Z');
    `);
    legacy.close();

    const db = openDb(path);
    try {
      const columns = db.prepare('PRAGMA table_info(generation_jobs)').all() as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === 'attempt_id')).toBe(true);

      const row = db
        .prepare('SELECT job_id, attempt_id FROM generation_jobs WHERE job_id = ?')
        .get('legacy-job') as { job_id: string; attempt_id: string | null };
      expect(row).toEqual({ job_id: 'legacy-job', attempt_id: null });

      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_job_attempt'")
        .get() as { name: string } | undefined;
      expect(index?.name).toBe('idx_job_attempt');
    } finally {
      db.close();
    }
  });

  it('重复打开同一库幂等：迁移不报错、不重复改写数据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'citylens-migration-'));
    tempDirs.push(dir);
    const path = join(dir, 'repeat.db');

    const first = openDb(path);
    try {
      first
        .prepare(
          `INSERT INTO cities
             (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat)
           VALUES ('CN-610100', '西安', '陕西省', 'prefecture', 'xian', 'Xi''an', 108.9422, 34.2611)`,
        )
        .run();
      first
        .prepare(
          `INSERT INTO generation_jobs
             (job_id, city_id, status, modules_json, requester_hash, started_at, attempt_id)
           VALUES ('job-1', 'CN-610100', 'done', '["identity"]', 'hash', '2026-11-14T00:00:00.000Z', 'attempt-1')`,
        )
        .run();
    } finally {
      first.close();
    }

    const second = openDb(path);
    try {
      const row = second
        .prepare('SELECT job_id, attempt_id FROM generation_jobs WHERE job_id = ?')
        .get('job-1') as { job_id: string; attempt_id: string | null };
      expect(row).toEqual({ job_id: 'job-1', attempt_id: 'attempt-1' });
    } finally {
      second.close();
    }
  });
});

describe('attempt 绑定表迁移（隔离副本）', () => {
  it('老库（无绑定表）重开后：历史 attempt_id 回填绑定，仍可按 attemptId 恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'citylens-migration-'));
    tempDirs.push(dir);
    const path = join(dir, 'legacy-attempts.db');

    // 构造「attempt 绑定表」引入之前的库：有 attempt_id 列与历史任务，但没有绑定表。
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE generation_jobs (
        job_id          TEXT PRIMARY KEY,
        city_id         TEXT NOT NULL,
        status          TEXT NOT NULL,
        force_flag      INTEGER NOT NULL DEFAULT 0,
        modules_json    TEXT NOT NULL,
        failed_json     TEXT,
        requester_hash  TEXT NOT NULL,
        llm_calls       INTEGER NOT NULL DEFAULT 0,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        cooldown_until  TEXT,
        attempt_id      TEXT
      );
      CREATE TABLE cities (
        city_id       TEXT PRIMARY KEY,
        standard_name TEXT NOT NULL,
        province      TEXT NOT NULL,
        admin_level   TEXT NOT NULL,
        country_code  TEXT NOT NULL DEFAULT 'CN',
        pinyin        TEXT NOT NULL,
        english_name  TEXT NOT NULL,
        center_lng     REAL NOT NULL,
        center_lat     REAL NOT NULL,
        summary        TEXT,
        hot_rank       INTEGER
      );
      INSERT INTO cities
        (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat)
        VALUES ('CN-610100', '西安', '陕西省', 'prefecture', 'xian', 'Xi''an', 108.9422, 34.2611);
      INSERT INTO generation_jobs
        (job_id, city_id, status, modules_json, requester_hash, started_at, attempt_id)
        VALUES ('legacy-attempt-job', 'CN-610100', 'done', '["identity"]', 'hash-old',
                '2026-11-01T00:00:00.000Z', 'legacy-attempt');
      INSERT INTO generation_jobs
        (job_id, city_id, status, modules_json, requester_hash, started_at)
        VALUES ('legacy-null-job', 'CN-610100', 'done', '["identity"]', 'hash-old',
                '2026-11-02T00:00:00.000Z');
    `);
    legacy.close();

    const db = openDb(path);
    try {
      const jobs = new JobRepo(db);
      // 历史 attempt 回填进绑定表：恢复接口仍可按 attemptId 精确定位原任务。
      const found = jobs.findByAttempt('CN-610100', 'legacy-attempt');
      expect(found?.jobId).toBe('legacy-attempt-job');
      // 历史 NULL 不被伪造：未知标识仍然查不到。
      expect(jobs.findByAttempt('CN-610100', 'legacy-null-job')).toBeNull();
      const bindings = db
        .prepare('SELECT job_id, attempt_id FROM generation_job_attempts ORDER BY job_id')
        .all();
      expect(bindings).toEqual([
        { job_id: 'legacy-attempt-job', attempt_id: 'legacy-attempt' },
      ]);
      // 跨城隔离在迁移后同样成立。
      expect(jobs.findByAttempt('CN-320500', 'legacy-attempt')).toBeNull();
    } finally {
      db.close();
    }

    // 重复打开幂等：不重复回填、不改写历史行。
    const again = openDb(path);
    try {
      const bindings = again
        .prepare('SELECT job_id, attempt_id FROM generation_job_attempts ORDER BY job_id')
        .all();
      expect(bindings).toEqual([
        { job_id: 'legacy-attempt-job', attempt_id: 'legacy-attempt' },
      ]);
      const row = again
        .prepare('SELECT job_id, attempt_id FROM generation_jobs WHERE job_id = ?')
        .get('legacy-attempt-job') as { job_id: string; attempt_id: string | null };
      expect(row).toEqual({ job_id: 'legacy-attempt-job', attempt_id: 'legacy-attempt' });
    } finally {
      again.close();
    }
  });
});
