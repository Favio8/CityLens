import { describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { LlmSettingsService } from './llmSettings';

function service(): LlmSettingsService {
  return new LlmSettingsService(openDb(':memory:'));
}

describe('大模型运行时配置', () => {
  it('未保存时沿用 .env，并在无 Key 时保持模拟模式', () => {
    const settings = service();
    const current = settings.get();
    expect(current.source).toBe('env');
    expect(current.mock).toBe(true);
    expect(settings.hasKey()).toBe(false);
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
