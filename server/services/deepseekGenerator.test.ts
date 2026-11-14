import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentitySchema, LandmarksSchema } from '../../shared/schema';
import type { CityBrief } from '../db/cityRepo';
import {
  DeepSeekGenerator,
  GenerationError,
} from './llmGenerator';
import type { LlmRuntimeConfig } from './llmSettings';
import { getFactSnapshot } from './presetData';

const CITY: CityBrief = {
  cityId: 'CN-610100',
  standardName: '西安',
  province: '陕西省',
  adminLevel: 'prefecture',
  pinyin: 'xian',
  englishName: 'Xi’an',
  center: [108.9402, 34.3416],
  summary: null,
  hotRank: 1,
  isPreset: true,
};

function config(overrides: Partial<LlmRuntimeConfig> = {}): LlmRuntimeConfig {
  return {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: 'sk-test',
    timeoutMs: 5000,
    mock: false,
    source: 'runtime',
    updatedAt: null,
    ...overrides,
  };
}

function sseResponse(payloads: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const content of payloads) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepSeekGenerator：模型只做选择与叙事，事实由本地库回填', () => {
  it('城市人格通过长度校验后写入 identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(['{"oneLinePersona":', '"长安的风从城墙吹到今天。"}']),
      ),
    );
    const generator = new DeepSeekGenerator();
    const result = await generator.generate({ city: CITY, module: 'identity', aliases: ['长安'] });
    const data = IdentitySchema.parse(result.data);
    expect(data.oneLinePersona).toBe('长安的风从城墙吹到今天。');
    expect(data.sourceRefs).toContain('S-LLM-CURATION');
    expect(data.area.value).toBe('待考');
  });

  it('景点只接受候选 entityId，坐标与来源来自本地快照', async () => {
    const snapshot = getFactSnapshot(CITY.cityId);
    const first = snapshot?.landmarks.find((landmark) => landmark.coordinates);
    expect(first).toBeDefined();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          JSON.stringify({
            items: [
              {
                entityId: first!.entityId,
                category: 'must_visit',
                bestSeason: '春秋',
                reason: '本地快照中的真实景点，用于验证候选约束与坐标回填。',
              },
              {
                entityId: 'Q-NOT-IN-LIST',
                category: 'hidden_gem',
                bestSeason: '待考',
                reason: '这条不在候选清单中，应被丢弃。',
              },
            ],
          }),
        ]),
      ),
    );
    const generator = new DeepSeekGenerator();
    const result = await generator.generate({
      city: CITY,
      module: 'landmarks',
      aliases: ['长安'],
      snapshot,
    });
    const data = LandmarksSchema.parse(result.data);
    expect(data).toHaveLength(1);
    expect(data[0]!.entityRef).toBe(first!.entityId);
    expect(data[0]!.sourceRefs).toEqual([snapshot!.sourceRef.id]);
    expect(data[0]!.coordSource).not.toBe('city_center');
  });

  it('诗词候选不合法时重试一次，仍失败则抛出可重试错误', async () => {
    const invalidPayload = [
      JSON.stringify({
        items: [{ poemId: 'not-a-real-poem', background: '待考', imagery: [] }],
      }),
    ];
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(sseResponse(invalidPayload)));
    vi.stubGlobal('fetch', fetchMock);
    const generator = new DeepSeekGenerator();
    await expect(
      generator.generate({ city: CITY, module: 'poetics', aliases: ['长安'] }),
    ).rejects.toMatchObject({ name: 'GenerationError', code: 'LLM_OUTPUT_INVALID' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('年代叙事里出现年表之外的年份时丢弃该节点', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          JSON.stringify({
            items: [
              {
                eraName: '唐',
                startYear: 618,
                endYear: 907,
                periodRange: '618—907',
                ancientCityName: '长安',
                keyEvents: '公元618年唐立国，长安成为都城，城市格局延续至今。',
                relicToday: '大雁塔',
              },
              {
                eraName: '唐',
                startYear: 618,
                endYear: 907,
                periodRange: '618—907',
                ancientCityName: '长安',
                keyEvents: '1234年发生了一件年表之外的事，应当被校验拦截。',
                relicToday: '大雁塔',
              },
            ],
          }),
        ]),
      ),
    );
    const generator = new DeepSeekGenerator();
    const result = await generator.generate({ city: CITY, module: 'chronicle', aliases: ['长安'] });
    const data = result.data as Array<{ keyEvents: string; centerCoord: unknown }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.keyEvents).toContain('618');
    expect(data[0]!.centerCoord).not.toBeNull();
  });

  it('数据脉搏在缺少统计产物时明确拒绝生成', async () => {
    const generator = new DeepSeekGenerator();
    await expect(
      generator.generate({ city: CITY, module: 'dataPulse', aliases: ['长安'] }),
    ).rejects.toBeInstanceOf(GenerationError);
  });

  it('人物叙事泄漏字段名/键名时丢弃该人物，保留正常条目', async () => {
    const snapshot = getFactSnapshot(CITY.cityId);
    const figures = snapshot?.figures ?? [];
    expect(figures.length).toBeGreaterThanOrEqual(2);
    const [clean, leaky] = figures;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          JSON.stringify({
            items: [
              {
                entityRef: leaky!.entityId,
                dynasty: '唐',
                cityBond: `其 relationType 为 native，birthplace 见候选资料。`,
                highlights: '唐代人物，事迹见本地快照与候选清单说明。',
              },
              {
                entityRef: clean!.entityId,
                dynasty: '唐',
                cityBond: '此人长期在长安任职，留下大量诗文与市政事迹。',
                highlights: '唐代名臣，政绩与文名俱存，遗迹今日仍可寻访。',
              },
            ],
          }),
        ]),
      ),
    );
    const generator = new DeepSeekGenerator();
    const result = await generator.generate({
      city: CITY,
      module: 'figures',
      aliases: ['长安'],
      snapshot,
    });
    const data = result.data as Array<{ entityRef: string; cityBond: string; highlights: string; dynasty: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.entityRef).toBe(clean!.entityId);
    // 只约束叙事文本（evidence.property 是 Schema 合法字段，不在此列）
    const narrative = data.map((item) => `${item.dynasty}${item.cityBond}${item.highlights}`).join('');
    expect(narrative).not.toMatch(/relationType|birthplace|deathplace|position/);
  });
});

/* -------------------------------------------------------------------------- */
/* P1：并发模型配置隔离 / 预算记账 / 总截止取消                                */
/* -------------------------------------------------------------------------- */

describe('P1：并发模型配置隔离', () => {
  it('两个不同提供方并发生成：请求地址、模型与来源记录各自正确', async () => {
    const calls: Array<{ url: string; model: string; authorization: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { model: string };
        const headers = init.headers as Record<string, string>;
        calls.push({
          url: String(input),
          model: body.model,
          authorization: headers.authorization ?? '',
        });
        return Promise.resolve(
          sseResponse(['{"oneLinePersona":', '"长安的风从城墙吹到今天。"}']),
        );
      }),
    );

    const deepseek = new DeepSeekGenerator(
      config({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-deepseek' }),
    );
    const stepfun = new DeepSeekGenerator(
      config({ provider: 'stepfun', baseUrl: 'https://api.stepfun.com/step_plan/v1', model: 'step-3.7-flash', apiKey: 'sk-stepfun' }),
    );

    const [a, b] = await Promise.all([
      deepseek.generate({ city: CITY, module: 'identity', aliases: ['长安'] }),
      stepfun.generate({ city: CITY, module: 'identity', aliases: ['长安'] }),
    ]);

    expect(calls).toHaveLength(2);
    const deepseekCall = calls.find((call) => call.model === 'deepseek-chat')!;
    const stepfunCall = calls.find((call) => call.model === 'step-3.7-flash')!;
    expect(deepseekCall.url).toBe('https://api.deepseek.com/chat/completions');
    expect(deepseekCall.authorization).toBe('Bearer sk-deepseek');
    expect(stepfunCall.url).toBe('https://api.stepfun.com/step_plan/v1/chat/completions');
    expect(stepfunCall.authorization).toBe('Bearer sk-stepfun');

    // 来源标题与各自配置一致，不串用。
    const deepseekSource = a.sources.find((source) => source.id === 'S-LLM-CURATION')!;
    const stepfunSource = b.sources.find((source) => source.id === 'S-LLM-CURATION')!;
    expect(deepseekSource.title).toBe('DeepSeek 结构化整理（deepseek-chat）');
    expect(stepfunSource.title).toBe('阶跃星辰 结构化整理（step-3.7-flash）');
    expect(deepseek.name).toBe('deepseek-chat@deepseek');
    expect(stepfun.name).toBe('step-3.7-flash@stepfun');
  });

  it('后台配置变化不污染进行中的调用（配置随任务快照）', async () => {
    const calls: Array<{ model: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { model: string };
        calls.push({ model: body.model });
        return Promise.resolve(
          sseResponse(['{"oneLinePersona":', '"长安的风从城墙吹到今天。"}']),
        );
      }),
    );
    const generator = new DeepSeekGenerator(config({ model: 'model-a' }));
    const pending = generator.generate({ city: CITY, module: 'identity', aliases: ['长安'] });
    // 生成进行中「后台改配置」：新建另一个生成器（模拟 settings 变更），不影响在途调用。
    const other = new DeepSeekGenerator(config({ model: 'model-b' }));
    void other.generate({ city: CITY, module: 'identity', aliases: ['长安'] });
    await pending;
    await Promise.resolve();
    expect(calls.map((call) => call.model).sort()).toEqual(['model-a', 'model-b']);
  });
});

describe('P1：LLM 预算记账与截止取消', () => {
  it('每次真实请求（含重试）前都调用 onLlmCall；预算耗尽不发起请求', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          sseResponse([JSON.stringify({ items: [{ poemId: 'not-a-real-poem', background: '待考', imagery: [] }] })]),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const onLlmCall = vi.fn();
    const generator = new DeepSeekGenerator(config());
    await expect(
      generator.generate({ city: CITY, module: 'poetics', aliases: ['长安'], onLlmCall }),
    ).rejects.toMatchObject({ name: 'GenerationError', code: 'LLM_OUTPUT_INVALID' });
    // 两次尝试 = 两次真实请求 = 两次记账。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onLlmCall).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    onLlmCall.mockClear();
    const exhausted = vi.fn(() => {
      throw new GenerationError('BUDGET_EXCEEDED', '今日 LLM 调用预算已用尽，请明日再试');
    });
    await expect(
      generator.generate({ city: CITY, module: 'identity', aliases: ['长安'], onLlmCall: exhausted }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    // 预算耗尽：不发起任何上游请求。
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it('纯本地失败（NO_FACTS）不计账：onLlmCall 未被调用', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onLlmCall = vi.fn();
    const generator = new DeepSeekGenerator(config());
    // dataPulse 只用本地侦察产物，无 recon 时直接 NO_FACTS。
    await expect(
      generator.generate({ city: CITY, module: 'dataPulse', aliases: ['长安'], onLlmCall }),
    ).rejects.toMatchObject({ code: 'NO_FACTS' });
    expect(onLlmCall).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('总截止信号触发时取消在途请求并映射为 LLM_TIMEOUT', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(
      (_input: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const generator = new DeepSeekGenerator(config({ timeoutMs: 60_000 }));
    const pending = generator.generate({
      city: CITY,
      module: 'identity',
      aliases: ['长安'],
      signal: controller.signal,
    });
    // 模拟任务级总截止到达。
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
  });

  it('收到已经取消的 signal：不记账、不发请求', async () => {
    // 复现：上游在请求前已被取消时，旧实现仍会发出一次请求并执行一次记账。
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onLlmCall = vi.fn();
    const generator = new DeepSeekGenerator(config());
    await expect(
      generator.generate({
        city: CITY,
        module: 'identity',
        aliases: ['长安'],
        signal: controller.signal,
        onLlmCall,
      }),
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onLlmCall).not.toHaveBeenCalled();
  });
});
