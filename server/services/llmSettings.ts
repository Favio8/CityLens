/**
 * 大模型运行时配置。
 *
 * 优先级：管理页保存的运行时配置 > .env 默认值。
 * 未保存时保持旧行为：无 Key 自动使用模拟 LLM。
 * API Key 只保存在本地 SQLite（server/data/*.db，已被 gitignore），不会下发到前端。
 */
import type { Db } from '../db';
import { config } from '../config';
import { maskSecret } from '../lib/mask';

export const LLM_PROVIDERS = ['deepseek', 'stepfun', 'custom'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const DEFAULT_BASE_URLS: Record<LlmProvider, string> = {
  deepseek: 'https://api.deepseek.com',
  stepfun: 'https://api.stepfun.com/v1',
  custom: '',
};

export interface LlmRuntimeConfig {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  mock: boolean;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

export interface LlmSettingsInput {
  provider?: LlmProvider;
  baseUrl?: string;
  model?: string;
  /** undefined 或空字符串表示保持现有 Key；clearApiKey=true 才清空。 */
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
  mock?: boolean;
}

export interface LlmPublicSettings {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  timeoutMs: number;
  mock: boolean;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

interface StoredLlmSettings {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  mock: boolean;
}

const SETTINGS_KEY = 'llm';

export function envLlmConfig(): LlmRuntimeConfig {
  const baseUrl = config.llm.baseUrl.replace(/\/+$/, '');
  const provider: LlmProvider = baseUrl.includes('api.stepfun.com')
    ? 'stepfun'
    : baseUrl.includes('api.deepseek.com')
      ? 'deepseek'
      : 'custom';
  return {
    provider,
    baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    timeoutMs: config.llm.timeoutMs,
    mock: config.mockLlm,
    source: 'env',
    updatedAt: null,
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export class LlmSettingsService {
  private cached: LlmRuntimeConfig | null;

  constructor(private readonly db: Db) {
    this.cached = this.readRuntime();
  }

  private readRuntime(): LlmRuntimeConfig | null {
    try {
      const row = this.db
        .prepare('SELECT value_json, updated_at FROM app_settings WHERE key = ?')
        .get(SETTINGS_KEY) as { value_json: string; updated_at: string } | undefined;
      if (!row) return null;
      const stored = JSON.parse(row.value_json) as StoredLlmSettings;
      if (!stored || typeof stored !== 'object') return null;
      return {
        provider: LLM_PROVIDERS.includes(stored.provider) ? stored.provider : 'custom',
        baseUrl: normalizeBaseUrl(stored.baseUrl ?? ''),
        model: stored.model?.trim() ?? '',
        apiKey: stored.apiKey?.trim() ?? '',
        timeoutMs: Number.isFinite(stored.timeoutMs) ? stored.timeoutMs : config.llm.timeoutMs,
        mock: stored.mock === true,
        source: 'runtime',
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  get(): LlmRuntimeConfig {
    return this.cached ?? envLlmConfig();
  }

  hasKey(): boolean {
    return this.get().apiKey.length > 0;
  }

  isMock(): boolean {
    return this.get().mock;
  }

  publicSettings(): LlmPublicSettings {
    const current = this.get();
    return {
      provider: current.provider,
      baseUrl: current.baseUrl,
      model: current.model,
      hasApiKey: current.apiKey.length > 0,
      apiKeyMasked: maskSecret(current.apiKey),
      timeoutMs: current.timeoutMs,
      mock: current.mock,
      source: current.source,
      updatedAt: current.updatedAt,
    };
  }

  save(input: LlmSettingsInput): LlmPublicSettings {
    const current = this.get();
    const apiKey =
      input.clearApiKey === true
        ? ''
        : input.apiKey && input.apiKey.trim().length > 0
          ? input.apiKey.trim()
          : current.apiKey;
    const provider =
      input.provider && LLM_PROVIDERS.includes(input.provider) ? input.provider : current.provider;
    const next: LlmRuntimeConfig = {
      provider,
      baseUrl: normalizeBaseUrl(input.baseUrl ?? current.baseUrl),
      model: (input.model ?? current.model).trim(),
      apiKey,
      timeoutMs: input.timeoutMs ?? current.timeoutMs,
      mock: input.mock ?? current.mock,
      source: 'runtime',
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(next), next.updatedAt);
    this.cached = next;
    return this.publicSettings();
  }

  reset(): LlmPublicSettings {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(SETTINGS_KEY);
    this.cached = null;
    return this.publicSettings();
  }
}
