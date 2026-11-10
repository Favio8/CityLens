import { describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { JobRepo } from '../db/jobRepo';
import { hashIp, RateLimiter, startOfToday } from './rateLimiter';

function setup(options: ConstructorParameters<typeof RateLimiter>[1] = {}) {
  const db = openDb(':memory:');
  const insertCity = db.prepare(
    `INSERT INTO cities
       (city_id, standard_name, province, admin_level, pinyin, english_name, center_lng, center_lat)
     VALUES (?, ?, '测试省', 'prefecture', 'test', 'Test', 108.9, 34.2)`,
  );
  for (let i = 0; i < 12; i += 1) {
    insertCity.run(`CN-61000${i}`, `测试城${i}`);
  }
  const jobs = new JobRepo(db);
  const limiter = new RateLimiter(jobs, options);
  return { db, jobs, limiter };
}

function createJob(
  jobs: JobRepo,
  cityId: string,
  requesterHash: string,
  startedAt: string,
  force = false,
): string {
  const jobId = `job-${cityId}-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const row = jobs.create({
    jobId,
    cityId,
    force,
    modules: ['identity'],
    requesterHash,
    startedAt,
  });
  if (!row) throw new Error('任务创建失败');
  return jobId;
}

describe('hashIp', () => {
  it('加盐哈希稳定且不同盐结果不同', () => {
    expect(hashIp('127.0.0.1', 'salt-a')).toBe(hashIp('127.0.0.1', 'salt-a'));
    expect(hashIp('127.0.0.1', 'salt-a')).not.toBe(hashIp('127.0.0.1', 'salt-b'));
    expect(hashIp('127.0.0.1', 'salt-a')).not.toContain('127.0.0.1');
  });
});

describe('新城市限流', () => {
  it('同一 IP 一小时内最多生成 10 座新城市，第 11 座被拒绝', () => {
    const now = new Date('2026-11-10T10:00:00.000Z');
    const { jobs, limiter } = setup({ now: () => now });
    const hash = hashIp('1.1.1.1', 'salt');
    for (let i = 0; i < 9; i += 1) {
      createJob(jobs, `CN-61000${i}`, hash, now.toISOString());
    }
    expect(limiter.checkNewCity(hash).allowed).toBe(true);
    createJob(jobs, 'CN-610009', hash, now.toISOString());

    const blocked = limiter.checkNewCity(hash);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.code).toBe('RATE_LIMITED');
      expect(blocked.retryAfterSec).toBe(3600);
    }
  });

  it('一小时之前的任务不计入限流', () => {
    const now = new Date('2026-11-10T10:00:00.000Z');
    const { jobs, limiter } = setup({ now: () => now });
    const hash = hashIp('2.2.2.2', 'salt');
    const old = new Date(now.getTime() - 61 * 60 * 1000).toISOString();
    for (let i = 0; i < 10; i += 1) createJob(jobs, `CN-61000${i}`, hash, old);
    expect(limiter.checkNewCity(hash).allowed).toBe(true);
  });
});

describe('强制刷新冷却', () => {
  it('同一 IP 对同一城市 5 分钟内二次刷新被拒绝并给出剩余秒数', () => {
    const now = new Date('2026-11-10T10:00:00.000Z');
    const { jobs, limiter } = setup({ now: () => now });
    const hash = hashIp('3.3.3.3', 'salt');
    createJob(jobs, 'CN-610001', hash, now.toISOString(), true);
    const blocked = limiter.checkRegen(hash, 'CN-610001');
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.code).toBe('REGEN_COOLDOWN');
      expect(blocked.retryAfterSec).toBe(300);
    }
  });

  it('超过 5 分钟后放行', () => {
    let now = new Date('2026-11-10T10:00:00.000Z');
    const { jobs, limiter } = setup({ now: () => now });
    const hash = hashIp('4.4.4.4', 'salt');
    createJob(jobs, 'CN-610001', hash, now.toISOString(), true);
    now = new Date('2026-11-10T10:05:01.000Z');
    expect(limiter.checkRegen(hash, 'CN-610001').allowed).toBe(true);
  });

  it('冷却按 IP 隔离', () => {
    const now = new Date('2026-11-10T10:00:00.000Z');
    const { jobs, limiter } = setup({ now: () => now });
    createJob(jobs, 'CN-610001', hashIp('5.5.5.5', 'salt'), now.toISOString(), true);
    expect(limiter.checkRegen(hashIp('6.6.6.6', 'salt'), 'CN-610001').allowed).toBe(true);
  });
});

describe('每日预算', () => {
  it('当日调用量达到上限后拒绝', () => {
    const now = new Date('2026-11-10T10:00:00.000Z');
    const { jobs, limiter } = setup({ now: () => now, dailyCallLimit: 50 });
    const jobId = createJob(jobs, 'CN-610001', 'hash', now.toISOString());
    jobs.incrementLlmCalls(jobId, 49);
    expect(limiter.checkBudget().allowed).toBe(true);
    jobs.incrementLlmCalls(jobId, 1);
    const blocked = limiter.checkBudget();
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.code).toBe('BUDGET_EXCEEDED');
  });

  it('startOfToday 取本地零点', () => {
    const date = new Date('2026-11-10T23:30:00');
    const start = new Date(startOfToday(date));
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });
});
