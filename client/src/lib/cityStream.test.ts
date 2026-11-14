// @vitest-environment node
/**
 * CityStreamController 状态机测试（PRD 2.2 / 3.4）：
 * 截断流重连、切换城市保护、done 收尾、有界重试。
 */
import { describe, expect, it } from 'vitest';
import type { CityArchiveResponse } from '@citylens/shared/schema';
import { ApiRequestError } from './api';
import { consumeSse } from './sse';
import {
  CityStreamController,
  archiveToErrors,
  archiveToModules,
  initialStreamState,
  type CityStreamState,
} from './cityStream';

interface FakeStream {
  stream: ReadableStream<Uint8Array>;
  send: (events: Array<{ event: string; data: unknown }>) => void;
  close: () => void;
}

/** 可手动投递/关闭的 SSE 流；abort 时立即报错（模拟 fetch 取消响应体）。 */
function fakeStream(signal: AbortSignal): FakeStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal.addEventListener(
    'abort',
    () => {
      try {
        controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      } catch {
        // 已关闭
      }
    },
    { once: true },
  );
  return {
    stream,
    send: (events) => {
      for (const item of events) {
        try {
          controller.enqueue(
            encoder.encode(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`),
          );
        } catch {
          // 流已取消/关闭：迟到事件静默丢弃
        }
      }
    },
    close: () => {
      try {
        controller.close();
      } catch {
        // 已关闭
      }
    },
  };
}

const CITY_A = 'CN-100001';
const CITY_B = 'CN-100002';

const META_EVENT = (cityId: string) => ({
  event: 'meta',
  data: {
    seq: 1,
    cityId,
    standardName: cityId === CITY_A ? '甲城' : '乙城',
    province: '测试省',
    aliases: [],
    center: [116, 39],
    isPreset: false,
    jobId: `job-${cityId}`,
  },
});

const MODULE_EVENT = (name: string, seq: number) => ({
  event: 'module',
  data: {
    seq,
    name,
    status: 'ok',
    data: { name },
    sources: [],
  },
});

const DONE_EVENT = (cityId: string, seq: number, status = 'partial') => ({
  event: 'done',
  data: {
    seq,
    cityId,
    status,
    failedModules: [],
    generatedAt: '2026-11-14T00:00:00.000Z',
    dataVersion: 1,
  },
});

function archive(cityId: string): CityArchiveResponse {
  return {
    fromCache: true,
    meta: {
      cityId,
      standardName: cityId === CITY_A ? '甲城' : '乙城',
      province: '测试省',
      aliases: [],
      center: [116, 39],
      schemaVersion: '1.1',
      dataVersion: 3,
      generatedAt: '2026-11-14T00:00:00.000Z',
      status: 'partial',
      moduleStatus: {
        identity: 'ok',
        chronicle: 'ok',
        landmarks: 'ok',
        relics: 'ok',
        figures: 'ok',
        poetics: 'ok',
        localSoul: 'failed',
        dataPulse: 'failed',
      },
      generator: null,
      isPreset: false,
      themePalette: {
        light: { primary: '#8C3F2B', secondary: '#4A4E54', accent: '#C89B40' },
        dark: { primary: '#D2957F', secondary: '#A8ADB4', accent: '#E0B860' },
      },
    },
    identity: null,
    chronicle: null,
    landmarks: null,
    relics: null,
    figures: null,
    poetics: null,
    localSoul: null,
    dataPulse: null,
    sources: [],
  };
}

interface Harness {
  controller: CityStreamController;
  states: CityStreamState[];
  streams: FakeStream[];
  streamCalls: Array<{
    cityId: string;
    options: { force?: boolean; modules?: string[]; attemptId?: string };
  }>;
  resumeCalls: Array<{ cityId: string; jobId?: string; attemptId?: string }>;
  archiveCalls: string[];
  latest: () => CityStreamState;
}

function harness(options: {
  maxReconnects?: number;
  reconnectDelayMs?: number;
  /** hit：缓存命中（不自动生成）；miss：NOT_GENERATED（自动发起生成，默认）。 */
  cache?: 'hit' | 'miss';
  fetchArchive?: (cityId: string) => Promise<CityArchiveResponse>;
  /** 按顺序编排第 N 次流的行为：默认都是可手动投递的正常流。 */
  streamScript?: Array<
    | { kind: 'stream' }
    | { kind: 'reject' }
    | { kind: 'readError'; events?: Array<{ event: string; data: unknown }> }
    | { kind: 'http'; status: number; body: unknown }
  >;
} = {}): Harness {
  const states: CityStreamState[] = [initialStreamState];
  const streams: FakeStream[] = [];
  const streamCalls: Array<{
    cityId: string;
    options: { force?: boolean; modules?: string[]; attemptId?: string };
  }> = [];
  const resumeCalls: Array<{ cityId: string; jobId?: string; attemptId?: string }> = [];
  const archiveCalls: string[] = [];
  const cache = options.cache ?? 'miss';
  const script = options.streamScript ?? [];
  let streamIndex = 0;
  /** 每次生成/恢复连接共用同一脚本与流数组，便于按顺序断言。 */
  const nextStream = (signal: AbortSignal): Promise<Response> => {
    const step = script[streamIndex] ?? { kind: 'stream' as const };
    streamIndex += 1;
    if (step.kind === 'reject') {
      // 首次连接异常（连接被拒 / DNS 失败）：fetch 层 TypeError。
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (step.kind === 'http') {
      return Promise.resolve(
        new Response(JSON.stringify(step.body), {
          status: step.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (step.kind === 'readError') {
      // 响应体读取中断：先异步吐若干事件再 error
      // （同步 error 会清空队列，事件将永远读不到）。
      const encoder = new TextEncoder();
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < (step.events ?? []).length) {
            const item = (step.events ?? [])[index]!;
            index += 1;
            controller.enqueue(
              encoder.encode(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`),
            );
            return;
          }
          controller.error(new TypeError('network error'));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    const fake = fakeStream(signal);
    streams.push(fake);
    return Promise.resolve(new Response(fake.stream, { status: 200 }));
  };
  const controller = new CityStreamController({
    fetchArchive: (cityId) => {
      archiveCalls.push(cityId);
      if (options.fetchArchive) return options.fetchArchive(cityId);
      return cache === 'miss'
        ? Promise.reject(new ApiRequestError('NOT_GENERATED', '此城尚未收录', 404))
        : Promise.resolve(archive(cityId));
    },
    fetchStream: (cityId, opts, signal) => {
      streamCalls.push({
        cityId,
        options: { force: opts.force, modules: opts.modules, attemptId: opts.attemptId },
      });
      return nextStream(signal);
    },
    fetchResume: (cityId, opts, signal) => {
      resumeCalls.push({ cityId, jobId: opts.jobId, attemptId: opts.attemptId });
      return nextStream(signal);
    },
    consume: (response, onEvent, signal) => consumeSse(response, onEvent, signal),
    onChange: (state) => states.push(state),
    ...(options.maxReconnects !== undefined ? { maxReconnects: options.maxReconnects } : {}),
    ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
  });
  return {
    controller,
    states,
    streams,
    streamCalls,
    resumeCalls,
    archiveCalls,
    latest: () => states[states.length - 1]!,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('CityStreamController：缓存读取', () => {
  it('openCity 命中缓存：phase=ready、fromCache、done 由档案合成', async () => {
    const h = harness({ cache: 'hit' });
    h.controller.openCity(CITY_A);
    await tick();
    expect(h.latest().phase).toBe('ready');
    expect(h.latest().fromCache).toBe(true);
    expect(h.latest().done?.status).toBe('partial');
    expect(h.archiveCalls).toEqual([CITY_A]);
    expect(h.streamCalls).toEqual([]);
  });

  it('未生成城市自动发起一次生成，且不会重复自动发起', async () => {
    const archiveCalls: string[] = [];
    const controller = new CityStreamController({
      fetchArchive: (cityId) => {
        archiveCalls.push(cityId);
        return Promise.reject(new ApiRequestError('NOT_GENERATED', '此城尚未收录', 404));
      },
      fetchStream: (_cityId, _opts, signal) => {
        const fake = fakeStream(signal);
        return Promise.resolve(new Response(fake.stream, { status: 200 }));
      },
      fetchResume: (_cityId, _opts, signal) => {
        const fake = fakeStream(signal);
        return Promise.resolve(new Response(fake.stream, { status: 200 }));
      },
      consume: (response, onEvent, signal) => consumeSse(response, onEvent, signal),
      onChange: () => undefined,
    });
    controller.openCity(CITY_A);
    await tick();
    expect(controller.getState().phase).toBe('streaming_init');
    // 流内再次收到 NOT_GENERATED 类错误也不应触发第二次自动生成。
    expect(archiveCalls).toEqual([CITY_A]);
  });
});

describe('CityStreamController：流中断与有界重连', () => {
  it('done 前 EOF：自动重连复用任务并保留已收到的模块', async () => {
    const h = harness({ reconnectDelayMs: 1 });
    h.controller.openCity(CITY_A);
    await tick();
    // 首次流：meta + identity 后异常 EOF（无 done）。
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    await tick();

    // 自动恢复：走只读恢复契约（携带 jobId），服务端回放全部事件 + 新模块 + done。
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(1);
    expect(h.resumeCalls[0]).toMatchObject({ cityId: CITY_A, jobId: `job-${CITY_A}` });
    expect(h.resumeCalls[0]!.attemptId).toBeTruthy();
    h.streams[1]!.send([
      META_EVENT(CITY_A),
      MODULE_EVENT('identity', 2),
      MODULE_EVENT('landmarks', 3),
      DONE_EVENT(CITY_A, 4),
    ]);
    await tick();
    h.streams[1]!.close();
    await tick();

    const state = h.latest();
    expect(state.phase).toBe('ready');
    expect(state.done?.status).toBe('partial');
    // 重连前收到的 identity 模块被保留。
    expect(Object.keys(state.modules).sort()).toEqual(['identity', 'landmarks']);
  });

  it('重连耗尽：明确错误态 STREAM_INTERRUPTED，且不再无限重试', async () => {
    const h = harness({ maxReconnects: 2, reconnectDelayMs: 1 });
    h.controller.openCity(CITY_A);
    await tick();
    for (let round = 0; round < 3; round += 1) {
      h.streams[round]!.send([META_EVENT(CITY_A)]);
      await tick();
      h.streams[round]!.close();
      await tick();
      await tick();
    }
    const state = h.latest();
    expect(state.phase).toBe('error');
    expect(state.fatal?.code).toBe('STREAM_INTERRUPTED');
    // 1 次用户生成 + 2 次有界恢复；恢复不再调用生成接口。
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(2);
    // 显式入口「继续展卷」仍走只读恢复，不发起新生成。
    void h.controller.resumeGeneration();
    await tick();
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(3);
  });

  it('缓存命中后重新生成：流被截断时重连，不被上一轮 done 阻止', async () => {
    // 复现：缓存命中时 state.done 非空；重新生成后流在新 done 前 EOF，
    // 旧实现沿用该 done 判断「已完成」→ 不重连 → 页面停在生成状态。
    const h = harness({ cache: 'hit', reconnectDelayMs: 1 });
    h.controller.openCity(CITY_A);
    await tick();
    expect(h.latest().phase).toBe('ready');
    expect(h.latest().done).not.toBeNull();

    void h.controller.startGeneration();
    await tick();
    expect(h.streamCalls).toHaveLength(1);
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    await tick();

    // 必须自动恢复（并入服务端任务并回放），且使用只读恢复接口。
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(1);
    h.streams[1]!.send([
      META_EVENT(CITY_A),
      MODULE_EVENT('identity', 2),
      MODULE_EVENT('landmarks', 3),
      DONE_EVENT(CITY_A, 4),
    ]);
    await tick();
    h.streams[1]!.close();
    await tick();

    const state = h.latest();
    expect(state.phase).toBe('ready');
    expect(state.done?.cityId).toBe(CITY_A);
    expect(Object.keys(state.modules).sort()).toEqual(['identity', 'landmarks']);
  });

  it('第二次生成同样具备截断恢复能力', async () => {
    const h = harness({ cache: 'hit', reconnectDelayMs: 1 });
    h.controller.openCity(CITY_A);
    await tick();
    // 第一轮：完整成功。
    void h.controller.startGeneration();
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2), DONE_EVENT(CITY_A, 3)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    expect(h.latest().phase).toBe('ready');

    // 第二轮：再次生成，流被截断 → 仍应重连。
    void h.controller.startGeneration();
    await tick();
    expect(h.streamCalls).toHaveLength(2);
    h.streams[1]!.send([META_EVENT(CITY_A), MODULE_EVENT('landmarks', 2)]);
    await tick();
    h.streams[1]!.close();
    await tick();
    await tick();
    // 第二次用户生成仍可恢复：生成接口只在用户点击时调用。
    expect(h.streamCalls).toHaveLength(2);
    expect(h.resumeCalls).toHaveLength(1);
    h.streams[2]!.send([META_EVENT(CITY_A), DONE_EVENT(CITY_A, 3)]);
    await tick();
    h.streams[2]!.close();
    await tick();
    expect(h.latest().phase).toBe('ready');
    expect(h.latest().done?.cityId).toBe(CITY_A);
  });

  it('切城期间的重连不会覆盖新城市', async () => {
    const h = harness({ cache: 'hit', reconnectDelayMs: 1 });
    h.controller.openCity(CITY_A);
    await tick();
    void h.controller.startGeneration();
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    // 重连等待中切到 B。
    h.controller.openCity(CITY_B);
    await tick();
    expect(h.latest().meta?.cityId).toBe(CITY_B);
    const streamsBefore = h.streamCalls.length;
    const resumesBefore = h.resumeCalls.length;
    await tick();
    await tick();
    // 旧批次的重连被批次令牌拦截，不得为 A 新建生成或恢复流。
    expect(h.streamCalls.length).toBe(streamsBefore);
    expect(h.resumeCalls.length).toBe(resumesBefore);
    expect(h.latest().meta?.cityId).toBe(CITY_B);
  });

  it('流内 error 事件：进入错误态并保留原因', async () => {
    const h = harness();
    h.controller.openCity(CITY_A);
    await tick();
    h.streams[0]!.send([
      META_EVENT(CITY_A),
      {
        event: 'error',
        data: { seq: 2, code: 'BUDGET_EXCEEDED', message: '今日 LLM 调用预算已用尽，请明日再试', retryAfterSec: 600 },
      },
      DONE_EVENT(CITY_A, 3, 'unpublished'),
    ]);
    await tick();
    h.streams[0]!.close();
    await tick();
    expect(h.latest().fatal?.code).toBe('BUDGET_EXCEEDED');
  });
});

describe('CityStreamController：done 收尾', () => {
  it('done 已发布：补拉档案并进入 ready', async () => {
    const h = harness({ cache: 'hit' });
    h.controller.openCity(CITY_A);
    await tick();
    // 缓存命中后由用户触发生成。
    void h.controller.startGeneration();
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2), DONE_EVENT(CITY_A, 3)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    const state = h.latest();
    expect(state.phase).toBe('ready');
    expect(state.archive?.meta.cityId).toBe(CITY_A);
    // 初始缓存读取 + done 后补拉各一次。
    expect(h.archiveCalls).toEqual([CITY_A, CITY_A]);
  });

  it('done 未发布：按服务端冷却状态收尾（cooldown）', async () => {
    let archiveReads = 0;
    const h = harness({
      cache: 'hit',
      fetchArchive: () => {
        archiveReads += 1;
        // 首次读取命中缓存；done 后的补拉返回 429 COOLDOWN。
        return archiveReads === 1
          ? Promise.resolve(archive(CITY_A))
          : Promise.reject(
              new ApiRequestError('COOLDOWN', '该城上次生成失败，冷却中（剩余 120 秒）', 429, 120),
            );
      },
    });
    h.controller.openCity(CITY_A);
    await tick();
    // 缓存命中后由用户触发生成。
    void h.controller.startGeneration();
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A), DONE_EVENT(CITY_A, 2, 'unpublished')]);
    await tick();
    h.streams[0]!.close();
    await tick();
    expect(h.latest().phase).toBe('cooldown');
    expect(h.latest().fatal?.code).toBe('COOLDOWN');
    expect(h.latest().fatal?.retryAfterSec).toBe(120);
  });
});

describe('CityStreamController：城市切换保护', () => {
  it('A→B 切换后，A 的迟到事件与补拉结果不覆盖 B', async () => {
    const h = harness();
    h.controller.openCity(CITY_A);
    await tick();
    // A 的流挂起（未生成城市自动发起）。
    expect(h.streamCalls.map((call) => call.cityId)).toEqual([CITY_A]);
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2)]);
    await tick();

    // 切到 B：缓存未命中 → 自动发起 B 的生成。
    h.controller.openCity(CITY_B);
    await tick();
    expect(h.streamCalls.map((call) => call.cityId)).toEqual([CITY_A, CITY_B]);
    expect(h.latest().phase).toBe('streaming_init');
    h.streams[1]!.send([META_EVENT(CITY_B)]);
    await tick();
    expect(h.latest().meta?.cityId).toBe(CITY_B);

    // A 的迟到事件到达：不得影响 B。
    h.streams[0]!.send([MODULE_EVENT('landmarks', 3), DONE_EVENT(CITY_A, 4)]);
    await tick();
    expect(h.latest().meta?.cityId).toBe(CITY_B);
    expect(h.latest().modules.landmarks).toBeUndefined();
    expect(h.latest().done?.cityId).not.toBe(CITY_A);

    // B 流进行中再次调用 startGeneration 被忽略（不新建流、不清除运行标志）。
    void h.controller.startGeneration();
    await tick();
    expect(h.streamCalls).toHaveLength(2);

    h.streams[1]!.send([META_EVENT(CITY_B), MODULE_EVENT('identity', 2), DONE_EVENT(CITY_B, 3)]);
    await tick();
    h.streams[1]!.close();
    await tick();
    expect(h.latest().meta?.cityId).toBe(CITY_B);
    // 已发布：补拉失败不影响 ready（流式数据已足够展示）。
    expect(h.latest().phase).toBe('ready');
    expect(h.latest().done?.cityId).toBe(CITY_B);
  });

  it('快速 A→B→A：每座城市都读到自己的档案，旧批次回写全部丢弃', async () => {
    const h = harness({ cache: 'hit' });
    h.controller.openCity(CITY_A);
    await tick();
    h.controller.openCity(CITY_B);
    await tick();
    h.controller.openCity(CITY_A);
    await tick();
    expect(h.archiveCalls).toEqual([CITY_A, CITY_B, CITY_A]);
    expect(h.latest().meta?.cityId).toBe(CITY_A);
    expect(h.latest().fromCache).toBe(true);
  });

  it('done 后的档案补拉迟到：不得覆盖新城市状态', async () => {
    // B 的首次读取立即成功；B 的第二次读取（done 补拉）挂起，用于验证迟到保护。
    let bReads = 0;
    const late: { resolve: ((value: CityArchiveResponse) => void) | null } = { resolve: null };
    const states: CityStreamState[] = [initialStreamState];
    const streams: FakeStream[] = [];
    const controller = new CityStreamController({
      fetchArchive: (cityId) => {
        if (cityId === CITY_B) {
          bReads += 1;
          if (bReads === 1) return Promise.resolve(archive(CITY_B));
          return new Promise<CityArchiveResponse>((resolve) => {
            late.resolve = resolve;
          });
        }
        return Promise.resolve(archive(cityId));
      },
      fetchStream: (_cityId, _opts, signal) => {
        const fake = fakeStream(signal);
        streams.push(fake);
        return Promise.resolve(new Response(fake.stream, { status: 200 }));
      },
      fetchResume: (_cityId, _opts, signal) => {
        const fake = fakeStream(signal);
        streams.push(fake);
        return Promise.resolve(new Response(fake.stream, { status: 200 }));
      },
      consume: (response, onEvent, signal) => consumeSse(response, onEvent, signal),
      onChange: (state) => states.push(state),
    });
    const latest = (): CityStreamState => states[states.length - 1]!;

    controller.openCity(CITY_B);
    await tick();
    expect(latest().phase).toBe('ready');

    void controller.startGeneration();
    await tick();
    streams[0]!.send([META_EVENT(CITY_B), MODULE_EVENT('identity', 2), DONE_EVENT(CITY_B, 3)]);
    await tick();
    streams[0]!.close();
    await tick();
    // done 补拉挂起中：切到 A。
    controller.openCity(CITY_A);
    await tick();
    expect(latest().meta?.cityId).toBe(CITY_A);
    expect(latest().archive?.meta.cityId).toBe(CITY_A);

    // 迟到的 B 补拉结果：不得覆盖 A。
    late.resolve?.(archive(CITY_B));
    await tick();
    expect(latest().meta?.cityId).toBe(CITY_A);
    expect(latest().archive?.meta.cityId).toBe(CITY_A);
  });

  it('close 后所有回写被忽略', async () => {
    const h = harness();
    h.controller.openCity(CITY_A);
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A)]);
    await tick();
    h.controller.close();
    h.streams[0]!.send([MODULE_EVENT('identity', 2), DONE_EVENT(CITY_A, 3)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    const before = h.states.length;
    await tick();
    expect(h.states.length).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* 统一网络异常 / EOF 恢复                                                     */
/* -------------------------------------------------------------------------- */

describe('CityStreamController：网络异常与 EOF 统一恢复', () => {
  it('首次连接异常（fetch 拒绝）后走有界重连并成功', async () => {
    const h = harness({
      reconnectDelayMs: 1,
      streamScript: [{ kind: 'reject' }, { kind: 'stream' }],
    });
    h.controller.openCity(CITY_A);
    await tick();
    await tick();
    // 必须自动恢复（旧实现只请求一次就进入 NETWORK_ERROR）。
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(1);
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2), DONE_EVENT(CITY_A, 3)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    expect(h.latest().phase).toBe('ready');
    expect(h.latest().done?.cityId).toBe(CITY_A);
  });

  it('响应体读取异常后走有界恢复并成功', async () => {
    const h = harness({
      reconnectDelayMs: 1,
      streamScript: [
        { kind: 'readError', events: [META_EVENT(CITY_A), MODULE_EVENT('identity', 2)] },
        { kind: 'stream' },
      ],
    });
    h.controller.openCity(CITY_A);
    await tick();
    await tick();
    await tick();
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(1);
    // 中断前收到的模块被保留。
    expect(Object.keys(h.latest().modules)).toEqual(['identity']);
    h.streams[0]!.send([META_EVENT(CITY_A), DONE_EVENT(CITY_A, 3)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    expect(h.latest().phase).toBe('ready');
  });

  it('恢复只调用只读恢复接口并携带原任务标识，不再发送 force', async () => {
    const h = harness({
      cache: 'hit',
      reconnectDelayMs: 1,
      streamScript: [{ kind: 'stream' }, { kind: 'stream' }],
    });
    h.controller.openCity(CITY_A);
    await tick();
    void h.controller.regenerate(); // 用户主动 force 刷新
    await tick();
    expect(h.streamCalls).toHaveLength(1);
    expect(h.streamCalls[0]!.options.force).toBe(true);
    const attemptId = h.streamCalls[0]!.options.attemptId;
    expect(attemptId).toBeTruthy();
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2)]);
    await tick();
    h.streams[0]!.close(); // 截断，无 done
    await tick();
    await tick();
    // 恢复接口只拿到 jobId/attemptId，生成接口不再被调用。
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(1);
    expect(h.resumeCalls[0]).toMatchObject({
      cityId: CITY_A,
      jobId: `job-${CITY_A}`,
      attemptId,
    });
  });

  it('持续失败耗尽后「继续展卷」仍只走恢复接口', async () => {
    const h = harness({
      maxReconnects: 2,
      reconnectDelayMs: 1,
      streamScript: [
        { kind: 'stream' },
        { kind: 'reject' },
        { kind: 'reject' },
        { kind: 'stream' },
      ],
    });
    h.controller.openCity(CITY_A);
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    await tick();
    await tick();
    const state = h.latest();
    expect(state.phase).toBe('error');
    expect(state.fatal?.code).toBe('STREAM_INTERRUPTED');
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(2);
    // 入口 = 再次恢复（不是生成）：服务端会并入/回放原任务。
    void h.controller.resumeGeneration();
    await tick();
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(3);
  });

  it('业务错误（COOLDOWN）不重连，保留服务端 code/message/retryAfterSec', async () => {
    const h = harness({
      reconnectDelayMs: 1,
      streamScript: [
        { kind: 'stream' },
        {
          kind: 'http',
          status: 429,
          body: { code: 'COOLDOWN', message: '该城上次生成失败，冷却中（剩余 120 秒）', retryAfterSec: 120 },
        },
      ],
    });
    h.controller.openCity(CITY_A);
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A)]);
    await tick();
    h.streams[0]!.close(); // 截断 → 恢复
    await tick();
    await tick();
    await tick();
    const state = h.latest();
    expect(state.phase).toBe('cooldown');
    expect(state.fatal?.code).toBe('COOLDOWN');
    expect(state.fatal?.retryAfterSec).toBe(120);
    expect(state.fatal?.message).toContain('冷却中');
    // 明确的业务终态不再恢复。
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(1);
  });

  it('等待重连期间切城：静默取消，不为旧城市新建生成或恢复流', async () => {
    const h = harness({
      cache: 'hit',
      reconnectDelayMs: 30,
      streamScript: [{ kind: 'stream' }],
    });
    h.controller.openCity(CITY_A);
    await tick();
    void h.controller.startGeneration();
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A)]);
    await tick();
    h.streams[0]!.close();
    h.controller.openCity(CITY_B); // 重连等待期间切城
    await tick();
    expect(h.latest().meta?.cityId).toBe(CITY_B);
    const before = h.streamCalls.length;
    const resumesBefore = h.resumeCalls.length;
    await tick();
    await tick();
    expect(h.streamCalls.length).toBe(before);
    expect(h.resumeCalls.length).toBe(resumesBefore);
    expect(h.latest().meta?.cityId).toBe(CITY_B);
  });
});

/* -------------------------------------------------------------------------- */
/* 恢复契约：meta 丢失 / 明确不可恢复 / 手动继续展卷                            */
/* -------------------------------------------------------------------------- */

describe('CityStreamController：只读恢复契约', () => {
  it('meta 前断线：恢复请求不带 jobId，但仍携带本次 attemptId', async () => {
    const h = harness({ reconnectDelayMs: 1 });
    h.controller.openCity(CITY_A);
    await tick();
    expect(h.streamCalls).toHaveLength(1);
    const attemptId = h.streamCalls[0]!.options.attemptId;
    expect(attemptId).toBeTruthy();
    // 还没收到 meta 就 EOF。
    expect(h.latest().jobId).toBeNull();
    h.streams[0]!.close();
    await tick();
    await tick();
    expect(h.resumeCalls).toHaveLength(1);
    expect(h.resumeCalls[0]!.jobId).toBeUndefined();
    expect(h.resumeCalls[0]!.attemptId).toBe(attemptId);
  });

  it('恢复明确不可用：进入错误态并保留服务端说明，不自动重新生成', async () => {
    const h = harness({
      reconnectDelayMs: 1,
      streamScript: [
        { kind: 'stream' },
        {
          kind: 'http',
          status: 409,
          body: {
            code: 'RESUME_UNAVAILABLE',
            message: '没有可恢复的生成任务；如需生成请手动重新展卷',
          },
        },
      ],
    });
    h.controller.openCity(CITY_A);
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    await tick();
    await tick();
    const state = h.latest();
    expect(state.phase).toBe('error');
    expect(state.fatal?.code).toBe('RESUME_UNAVAILABLE');
    expect(state.fatal?.message).toContain('手动重新展卷');
    // 不自动发起新生成，也不继续无谓恢复。
    expect(h.streamCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(1);
  });

  it('恢复终态回放：模块与失败提示进入最终状态', async () => {
    const cached = archive(CITY_A);
    const h = harness({
      cache: 'hit',
      reconnectDelayMs: 1,
      fetchArchive: () => Promise.resolve(cached),
      streamScript: [
        { kind: 'stream' },
        {
          kind: 'stream',
        },
      ],
    });
    h.controller.openCity(CITY_A);
    await tick();
    void h.controller.startGeneration();
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    await tick();
    expect(h.resumeCalls).toHaveLength(1);
    // 服务端终态回放：旧内容 + 失败提示 + done。
    h.streams[1]!.send([
      {
        event: 'notice',
        data: { seq: 1, code: 'RESUMED_TERMINAL', message: '已恢复原任务的终态（未重新生成、未消耗额度）' },
      },
      META_EVENT(CITY_A),
      { event: 'module_error', data: { seq: 3, name: 'localSoul', code: 'NO_FACTS', retryable: false } },
      DONE_EVENT(CITY_A, 4),
    ]);
    await tick();
    h.streams[1]!.close();
    await tick();
    await tick();
    const state = h.latest();
    expect(state.phase).toBe('ready');
    expect(state.errors.localSoul?.code).toBe('NO_FACTS');
    expect(state.done?.cityId).toBe(CITY_A);
  });

  it('手动「继续展卷」调用恢复接口而不是生成接口', async () => {
    const h = harness({
      cache: 'hit',
      reconnectDelayMs: 1,
      maxReconnects: 2,
      streamScript: [
        { kind: 'stream' },
        { kind: 'reject' },
        { kind: 'reject' },
        { kind: 'stream' },
      ],
    });
    h.controller.openCity(CITY_A);
    await tick();
    void h.controller.regenerate();
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    await tick();
    await tick();
    // 自动恢复耗尽 → STREAM_INTERRUPTED；手动入口仍只调用恢复接口。
    expect(h.latest().fatal?.code).toBe('STREAM_INTERRUPTED');
    const callsBefore = h.streamCalls.length;
    // 流保持打开（模拟恢复连接建立后继续接收），因此不 await。
    void h.controller.resumeGeneration();
    await tick();
    expect(h.streamCalls.length).toBe(callsBefore);
    expect(h.resumeCalls).toHaveLength(3);
    h.streams[1]!.close();
    await tick();
  });
});

/* -------------------------------------------------------------------------- */
/* 旧内容 + 最新失败同时可见                                                   */
/* -------------------------------------------------------------------------- */

describe('CityStreamController：旧内容与最新失败同时可见', () => {
  it('旧内容回放（fromCache）不清除本轮失败记录', async () => {
    // 复现事件序列：module_error(identity) → module(identity, fromCache) → done
    const h = harness({ cache: 'hit', reconnectDelayMs: 1 });
    h.controller.openCity(CITY_A);
    await tick();
    void h.controller.regenerate();
    await tick();
    h.streams[0]!.send([
      META_EVENT(CITY_A),
      { event: 'module_error', data: { seq: 2, name: 'identity', code: 'LLM_TIMEOUT', retryable: true } },
      { event: 'module', data: { ...MODULE_EVENT('identity', 3).data, fromCache: true } },
      {
        event: 'done',
        data: {
          seq: 4,
          cityId: CITY_A,
          status: 'partial',
          failedModules: ['identity'],
          generatedAt: '2026-11-14T00:00:00.000Z',
          dataVersion: 2,
        },
      },
    ]);
    await tick();
    h.streams[0]!.close();
    await tick();
    await tick();
    const state = h.latest();
    // 旧内容仍在，失败记录也仍在（旧实现会被 fromCache 回放清空）。
    expect(state.modules.identity).toBeDefined();
    expect(state.errors.identity?.code).toBe('LLM_TIMEOUT');
    expect(state.done?.failedModules).toEqual(['identity']);
  });

  it('真正生成成功后清除该模块的失败记录', async () => {
    const h = harness({ cache: 'hit', reconnectDelayMs: 1 });
    h.controller.openCity(CITY_A);
    await tick();
    void h.controller.regenerate();
    await tick();
    h.streams[0]!.send([
      META_EVENT(CITY_A),
      { event: 'module_error', data: { seq: 2, name: 'identity', code: 'LLM_TIMEOUT', retryable: true } },
    ]);
    await tick();
    expect(h.latest().errors.identity).toBeDefined();
    // 重试成功后：普通 module 事件（非 fromCache）清除失败提示。
    h.streams[0]!.send([MODULE_EVENT('identity', 3), DONE_EVENT(CITY_A, 4)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    await tick();
    expect(h.latest().errors.identity).toBeUndefined();
    expect(h.latest().modules.identity).toBeDefined();
  });

  it('缓存读取带回最近一次失败记录（archiveToErrors）', async () => {
    const cached = archive(CITY_A);
    cached.meta.moduleAttempts = {
      identity: { status: 'failed', code: 'LLM_TIMEOUT', at: '2026-11-14T00:00:00.000Z' },
    };
    const errors = archiveToErrors(cached);
    expect(errors.identity).toMatchObject({ name: 'identity', code: 'LLM_TIMEOUT', retryable: true });

    const h = harness({ cache: 'hit', fetchArchive: () => Promise.resolve(cached) });
    h.controller.openCity(CITY_A);
    await tick();
    expect(h.latest().phase).toBe('ready');
    // 失败提示随缓存一起带回（供单卷重试入口使用）。
    expect(h.latest().errors.identity?.code).toBe('LLM_TIMEOUT');
  });
});

describe('CityStreamController：重放事件幂等', () => {
  it('并入既有任务时的回放事件重复应用不产生重复模块', async () => {
    const h = harness();
    h.controller.openCity(CITY_A);
    await tick();
    h.streams[0]!.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2), DONE_EVENT(CITY_A, 3)]);
    await tick();
    h.streams[0]!.close();
    await tick();
    // 模拟服务端回放：同样的事件再发一次。
    h.streams[1]?.send([META_EVENT(CITY_A), MODULE_EVENT('identity', 2), DONE_EVENT(CITY_A, 3)]);
    await tick();
    expect(Object.keys(h.latest().modules)).toEqual(['identity']);
  });
});
