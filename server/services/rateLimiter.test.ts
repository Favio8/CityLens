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

  it('startOfToday 按 Asia/Shanghai 日界切分（北京时间当日零点的 UTC 值）', () => {
    // 2026-11-10 15:30 UTC = 北京 23:30，仍属 11 月 10 日；
    // 北京时间 11-10 00:00 = UTC 11-09 16:00。
    const before = new Date('2026-11-10T15:30:00.000Z');
    expect(startOfToday(before)).toBe('2026-11-09T16:00:00.000Z');
    // 2026-11-10 16:30 UTC = 北京 2026-11-11 00:30，已跨入次日；
    // 北京时间 11-11 00:00 = UTC 11-10 16:00。
    const after = new Date('2026-11-10T16:30:00.000Z');
    expect(startOfToday(after)).toBe('2026-11-10T16:00:00.000Z');
    // 北京时间当日零点整：UTC 16:00 属于新的一天。
    const boundary = new Date('2026-11-10T16:00:00.000Z');
    expect(startOfToday(boundary)).toBe('2026-11-10T16:00:00.000Z');
    const justBefore = new Date('2026-11-10T15:59:59.999Z');
    expect(startOfToday(justBefore)).toBe('2026-11-09T16:00:00.000Z');
  });

  it('跨日运行的任务按北京日界重新计数', () => {
    const now = new Date('2026-11-10T16:30:00.000Z');
    const { jobs, limiter } = setup({ now: () => now, dailyCallLimit: 50 });
    // 昨天（北京 11-10）用掉 49 次。
    const yesterdayJob = createJob(jobs, 'CN-610001', 'hash', '2026-11-10T10:00:00.000Z');
    jobs.incrementLlmCalls(yesterdayJob, 49);
    expect(limiter.checkBudget().allowed).toBe(true);
    // 北京 11-11 的新任务：额度全新。
    const todayJob = createJob(jobs, 'CN-610002', 'hash', now.toISOString());
    expect(limiter.consumeForJob(todayJob)).toBe(true);
  });
});

describe('LLM 预算原子记账（consumeForJob）', () => {
  it('剩余一次额度时放行最后一次调用，随后拒绝', () => {
    const now = new Date('2026-11-10T10:00:00.000Z');
    const { jobs, limiter } = setup({ now: () => now, dailyCallLimit: 3 });
    const jobId = createJob(jobs, 'CN-610001', 'hash', now.toISOString());
    jobs.incrementLlmCalls(jobId, 2);
    expect(limiter.consumeForJob(jobId)).toBe(true);
    expect(limiter.consumeForJob(jobId)).toBe(false);
    expect(jobs.get(jobId)?.llmCalls).toBe(3);
  });

  it('并发任务总量不突破预算（事务内统计+记账）', () => {
    const now = new Date('2026-11-10T10:00:00.000Z');
    const { jobs, limiter } = setup({ now: () => now, dailyCallLimit: 5 });
    const jobIds = Array.from({ length: 5 }, (_, i) =>
      createJob(jobs, `CN-61000${i}`, 'hash', now.toISOString()),
    );
    const results = jobIds.map((jobId) => limiter.consumeForJob(jobId));
    expect(results.every((allowed) => allowed)).toBe(true);
    // 第 6 个任务（跨任务）再请求即被拒绝，总量恰为 5。
    const extra = createJob(jobs, 'CN-610009', 'hash', now.toISOString());
    expect(limiter.consumeForJob(extra)).toBe(false);
    const used = jobs
      .listRecent(10)
      .reduce((sum, job) => sum + job.llmCalls, 0);
    expect(used).toBe(5);
  });

  it('午夜前后（北京 00:00）跨日的调用分别计入两日', () => {
    const justBefore = new Date('2026-11-10T15:59:59.000Z');
    const justAfter = new Date('2026-11-10T16:00:01.000Z');
    const { jobs } = setup();
    const limiterBefore = new RateLimiter(jobs, { now: () => justBefore, dailyCallLimit: 2 });
    const jobA = createJob(jobs, 'CN-610001', 'hash', justBefore.toISOString());
    expect(limiterBefore.consumeForJob(jobA)).toBe(true);
    expect(limiterBefore.consumeForJob(jobA)).toBe(true);
    expect(limiterBefore.consumeForJob(jobA)).toBe(false);

    const limiterAfter = new RateLimiter(jobs, { now: () => justAfter, dailyCallLimit: 2 });
    const jobB = createJob(jobs, 'CN-610002', 'hash', justAfter.toISOString());
    // 新的一天：额度重置。
    expect(limiterAfter.consumeForJob(jobB)).toBe(true);
  });
});
