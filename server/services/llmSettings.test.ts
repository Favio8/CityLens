import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { openDb } from '../db';
import { LlmSettingsService } from './llmSettings';

function service(): LlmSettingsService {
  return new LlmSettingsService(openDb(':memory:'));
}

describe('大模型运行时配置', () => {
  it('未保存时沿用 .env：mock 与 Key 状态跟随环境变量', () => {
    const settings = service();
    const current = settings.get();
    expect(current.source).toBe('env');
    // .env 有 Key 时真实调用；无 Key 时自动模拟（与 config.mockLlm 一致）。
    expect(current.mock).toBe(config.mockLlm);
    expect(settings.hasKey()).toBe(config.llm.apiKey.length > 0);
  });

  it('保存自定义服务后立即生效，读取接口不泄露明文 Key', () => {
    const settings = service();
    const publicView = settings.save({
      provider: 'stepfun',
      baseUrl: 'https://api.stepfun.com/v1/',
      model: 'step-5',
      apiKey: 'sk-test-123456789',
      mock: false,
      timeoutMs: 30000,
    });
    expect(settings.get()).toMatchObject({
      provider: 'stepfun',
      baseUrl: 'https://api.stepfun.com/v1',
      model: 'step-5',
      mock: false,
      timeoutMs: 30000,
      source: 'runtime',
    });
    expect(publicView.hasApiKey).toBe(true);
    expect(publicView.apiKeyMasked).toBe('sk-…6789');
    expect(JSON.stringify(publicView)).not.toContain('sk-test-123456789');
  });

  it('留空 Key 保持不变，clearApiKey 才会清空；reset 回到 .env', () => {
    const settings = service();
    settings.save({ apiKey: 'sk-first-0000', mock: false });
    settings.save({ model: 'next-model' });
    expect(settings.get().apiKey).toBe('sk-first-0000');
    settings.save({ clearApiKey: true });
    expect(settings.hasKey()).toBe(false);
    expect(settings.reset().source).toBe('env');
  });
});
