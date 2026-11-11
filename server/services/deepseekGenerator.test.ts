import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentitySchema, LandmarksSchema } from '../../shared/schema';
import type { CityBrief } from '../db/cityRepo';
import {
  DeepSeekGenerator,
  GenerationError,
} from './llmGenerator';
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
