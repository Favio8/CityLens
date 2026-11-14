/**
 * 生成任务仓储层（PRD 5.2 表 5 / 3.5）。
 * 同城单飞依赖 uq_running_job 部分唯一索引；限流与预算基于任务表统计。
 */
import type { ModuleName } from '../../shared/schema';
import type { Db } from './index';

export type JobStatus = 'running' | 'done' | 'partial' | 'failed';

export interface JobRecord {
  jobId: string;
  cityId: string;
  status: JobStatus;
  forceFlag: boolean;
  modules: ModuleName[];
  failedModules: ModuleName[];
  requesterHash: string;
  /** 客户端发起的生成尝试标识；历史任务为 null。 */
  attemptId: string | null;
  llmCalls: number;
  startedAt: string;
  finishedAt: string | null;
  cooldownUntil: string | null;
}

interface JobRow {
  job_id: string;
  city_id: string;
  status: string;
  force_flag: number;
  modules_json: string;
  failed_json: string | null;
  requester_hash: string;
  llm_calls: number;
  started_at: string;
  finished_at: string | null;
  cooldown_until: string | null;
  attempt_id: string | null;
}

function toRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    cityId: row.city_id,
    status: row.status as JobStatus,
    forceFlag: row.force_flag === 1,
    modules: JSON.parse(row.modules_json) as ModuleName[],
    failedModules: row.failed_json ? (JSON.parse(row.failed_json) as ModuleName[]) : [],
    requesterHash: row.requester_hash,
    attemptId: row.attempt_id ?? null,
    llmCalls: row.llm_calls,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cooldownUntil: row.cooldown_until,
  };
}

export class JobRepo {
  constructor(private readonly db: Db) {}

  /** 创建 running 任务；同城已有 running 任务时返回 null（依赖唯一部分索引）。 */
  create(input: {
    jobId: string;
    cityId: string;
    force: boolean;
    modules: ModuleName[];
    requesterHash: string;
    startedAt: string;
    attemptId?: string | null;
  }): JobRecord | null {
    try {
      this.db
        .prepare(
          `INSERT INTO generation_jobs
             (job_id, city_id, status, force_flag, modules_json, requester_hash,
              llm_calls, started_at, attempt_id)
           VALUES (?, ?, 'running', ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          input.jobId,
          input.cityId,
          input.force ? 1 : 0,
          JSON.stringify(input.modules),
          input.requesterHash,
          input.startedAt,
          input.attemptId ?? null,
        );
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
      throw error;
    }
    const row = this.db
      .prepare('SELECT * FROM generation_jobs WHERE job_id = ?')
      .get(input.jobId) as JobRow;
    return toRecord(row);
  }

  get(jobId: string): JobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM generation_jobs WHERE job_id = ?')
      .get(jobId) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  getRunning(cityId: string): JobRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM generation_jobs WHERE city_id = ? AND status = 'running'`)
      .get(cityId) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 按客户端尝试标识定位同城任务（断线恢复在未收到 meta 时的稳定标识）。 */
  findByAttempt(cityId: string, attemptId: string): JobRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM generation_jobs
         WHERE city_id = ? AND attempt_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(cityId, attemptId) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 同城最近一次任务（无 jobId/attemptId 的兼容恢复路径）。 */
  findLatestByCity(cityId: string): JobRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM generation_jobs
         WHERE city_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(cityId) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  finish(jobId: string, status: JobStatus, failed: ModuleName[], cooldownUntil: string | null): void {
    this.db
      .prepare(
        `UPDATE generation_jobs
         SET status = ?, failed_json = ?, finished_at = ?, cooldown_until = ?
         WHERE job_id = ?`,
      )
      .run(
        status,
        failed.length > 0 ? JSON.stringify(failed) : null,
        new Date().toISOString(),
        cooldownUntil,
        jobId,
      );
  }

  incrementLlmCalls(jobId: string, delta = 1): void {
    this.db
      .prepare('UPDATE generation_jobs SET llm_calls = llm_calls + ? WHERE job_id = ?')
      .run(delta, jobId);
  }

  /**
   * 记录一次真实 LLM 调用（按实际发生时间）。
   * 与 generation_jobs.llm_calls（任务级汇总，仅作展示）并行维护：
   * 每日预算只认这里的 called_at，任务跨午夜运行也不会串日。
   */
  recordLlmCall(jobId: string, cityId: string, calledAt: string): void {
    this.db
      .prepare('INSERT INTO llm_call_log (job_id, city_id, called_at) VALUES (?, ?, ?)')
      .run(jobId, cityId, calledAt);
  }

  /** 实际请求时间不早于 sinceIso 的 LLM 调用次数（每日预算唯一口径）。 */
  countLlmCallsSince(sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM llm_call_log WHERE called_at >= ?')
      .get(sinceIso) as { n: number };
    return row.n;
  }

  /**
   * 暴露事务：供「统计 + 记账」这类必须原子执行的复合操作使用
   * （better-sqlite3 同步执行，事务内不会被并发任务拆开）。
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** 同一请求方对同一城市最近一次 force 任务（用于 5 分钟冷却）。 */
  findRecentForce(cityId: string, requesterHash: string, sinceIso: string): JobRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM generation_jobs
         WHERE city_id = ? AND requester_hash = ? AND force_flag = 1 AND started_at >= ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(cityId, requesterHash, sinceIso) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  countDistinctCitiesSince(requesterHash: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT city_id) AS n FROM generation_jobs
         WHERE requester_hash = ? AND started_at >= ?`,
      )
      .get(requesterHash, sinceIso) as { n: number };
    return row.n;
  }

  /** 同城未解除的失败冷却任务。 */
  findActiveCooldown(cityId: string, nowIso: string): JobRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM generation_jobs
         WHERE city_id = ? AND cooldown_until IS NOT NULL AND cooldown_until > ?
         ORDER BY cooldown_until DESC LIMIT 1`,
      )
      .get(cityId, nowIso) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 崩溃遗留的 running 任务：超时后标记失败，避免永久阻塞单飞。 */
  failStale(olderThanIso: string, cooldownUntil: string): number {
    const result = this.db
      .prepare(
        `UPDATE generation_jobs
         SET status = 'failed', finished_at = ?, cooldown_until = ?
         WHERE status = 'running' AND started_at < ?`,
      )
      .run(new Date().toISOString(), cooldownUntil, olderThanIso);
    return result.changes;
  }

  /** 新任务开始时清除该城历史冷却，避免成功生成后仍被旧任务阻塞。 */
  clearCooldowns(cityId: string): void {
    this.db
      .prepare(
        `UPDATE generation_jobs SET cooldown_until = NULL
         WHERE city_id = ? AND cooldown_until IS NOT NULL`,
      )
      .run(cityId);
  }

  listRecent(limit = 20): JobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM generation_jobs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as JobRow[];
    return rows.map(toRecord);
  }
}
