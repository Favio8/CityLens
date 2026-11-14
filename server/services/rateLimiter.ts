/**
 * 限流与预算（PRD 3.5 / 2.2）。
 * - IP 只存加盐哈希，不落明文；
 * - 同一 IP 每小时最多生成 10 座新城市；
 * - 同一 IP 对同一城市强制刷新 5 分钟冷却；
 * - 全局每日 LLM 调用预算，超限返回 503。
 */
import { createHash } from 'node:crypto';
import type { JobRepo } from '../db/jobRepo';

export const NEW_CITY_HOURLY_LIMIT = 10;
export const REGEN_COOLDOWN_MS = 5 * 60 * 1000;

export type RateDecision =
  | { allowed: true }
  | { allowed: false; code: 'RATE_LIMITED' | 'REGEN_COOLDOWN' | 'BUDGET_EXCEEDED'; retryAfterSec: number; message: string };

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`, 'utf8').digest('hex');
}

/**
 * 「今日」起点：固定按 Asia/Shanghai 日界计算。
 * 服务端可能以 UTC 部署（容器默认时区），若用服务器本地日界，
 * 「今日 LLM 调用 / 预算」会与「请明日再试」的北京时间预期错位。
 * Asia/Shanghai 为固定 UTC+8（无夏令时）：北京时间当日零点 = UTC 当日零点前 8 小时。
 */
export function startOfToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value ?? '0');
  const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const beijingMidnightUtc = Date.UTC(part('year'), part('month') - 1, part('day')) - SHANGHAI_OFFSET_MS;
  return new Date(beijingMidnightUtc).toISOString();
}

export interface RateLimiterOptions {
  hourlyNewCityLimit?: number;
  regenCooldownMs?: number;
  dailyCallLimit?: number;
  now?: () => Date;
}

export class RateLimiter {
  private readonly hourlyLimit: number;
  private readonly regenCooldownMs: number;
  private readonly dailyLimit: number;
  private readonly now: () => Date;

  constructor(
    private readonly jobs: JobRepo,
    options: RateLimiterOptions = {},
  ) {
    this.hourlyLimit = options.hourlyNewCityLimit ?? NEW_CITY_HOURLY_LIMIT;
    this.regenCooldownMs = options.regenCooldownMs ?? REGEN_COOLDOWN_MS;
    this.dailyLimit = options.dailyCallLimit ?? 500;
    this.now = options.now ?? (() => new Date());
  }

  /** 只在“该城尚无已发布档案”时调用，统计最近一小时该请求方生成过的新城市数。 */
  checkNewCity(requesterHash: string): RateDecision {
    const since = new Date(this.now().getTime() - 60 * 60 * 1000).toISOString();
    const count = this.jobs.countDistinctCitiesSince(requesterHash, since);
    if (count >= this.hourlyLimit) {
      return {
        allowed: false,
        code: 'RATE_LIMITED',
        retryAfterSec: 60 * 60,
        message: `同一 IP 每小时最多生成 ${this.hourlyLimit} 座新城市，请稍后再试`,
      };
    }
    return { allowed: true };
  }

  /** 强制刷新冷却：同一 IP 对同一城市 5 分钟内最多 1 次。 */
  checkRegen(requesterHash: string, cityId: string): RateDecision {
    const since = new Date(this.now().getTime() - this.regenCooldownMs).toISOString();
    const recent = this.jobs.findRecentForce(cityId, requesterHash, since);
    if (recent) {
      const elapsed = this.now().getTime() - Date.parse(recent.startedAt);
      const retryAfterSec = Math.max(1, Math.ceil((this.regenCooldownMs - elapsed) / 1000));
      return {
        allowed: false,
        code: 'REGEN_COOLDOWN',
        retryAfterSec,
        message: `同一城市 5 分钟内只能强制刷新一次，请 ${retryAfterSec} 秒后再试`,
      };
    }
    return { allowed: true };
  }

  checkBudget(): RateDecision {
    const used = this.jobs.countLlmCallsSince(startOfToday(this.now()));
    if (used >= this.dailyLimit) {
      return {
        allowed: false,
        code: 'BUDGET_EXCEEDED',
        retryAfterSec: 60 * 60,
        message: '今日 LLM 调用预算已用尽，请明日再试',
      };
    }
    return { allowed: true };
  }

  /**
   * 真正发出 LLM 请求前的原子额度检查与记账。
   * better-sqlite3 同步执行，事务内「统计 + 记账」不会被并发任务拆开，
   * 因此并行任务总量不会突破每日预算；重试请求同样计数。
   * 记账按 calledAt（实际请求时间）所属北京日期归属，任务跨午夜运行不串日；
   * 迁移前的历史调用没有逐次时间戳，不补造记录（见 llm_call_log 注释）。
   * 返回 false 表示预算已用尽，调用方必须放弃本次请求。
   */
  consumeForJob(jobId: string, cityId: string, calledAt?: string): boolean {
    const since = startOfToday(this.now());
    const at = calledAt ?? this.now().toISOString();
    return this.jobs.transaction(() => {
      const used = this.jobs.countLlmCallsSince(since);
      if (used >= this.dailyLimit) return false;
      this.jobs.recordLlmCall(jobId, cityId, at);
      this.jobs.incrementLlmCalls(jobId, 1);
      return true;
    });
  }
}
