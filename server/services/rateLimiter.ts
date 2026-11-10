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

export function startOfToday(now = new Date()): string {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
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
    const used = this.jobs.sumLlmCallsSince(startOfToday(this.now()));
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
}
