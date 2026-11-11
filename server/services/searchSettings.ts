/**
 * 联网检索（Tavily）运行时配置。
 *
 * 优先级：管理页保存的运行时配置 > .env 默认值。
 * API Key 只保存在本地 SQLite，读取接口只返回掩码；保存后立即生效。
 */
import type { Db } from '../db';
import { config } from '../config';
import { maskSecret } from '../lib/mask';

export interface SearchRuntimeConfig {
  apiKey: string;
  dailyLimit: number;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

export interface SearchSettingsInput {
  apiKey?: string;
  clearApiKey?: boolean;
  dailyLimit?: number;
}

export interface SearchPublicSettings {
  hasApiKey: boolean;
  apiKeyMasked: string;
  dailyLimit: number;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

interface StoredSearchSettings {
  apiKey: string;
  dailyLimit: number;
}

const SETTINGS_KEY = 'search';

export function envSearchConfig(): SearchRuntimeConfig {
  return {
    apiKey: config.search.tavilyApiKey,
    dailyLimit: config.search.dailyLimit,
    source: 'env',
    updatedAt: null,
  };
}

let activeSearchConfig: SearchRuntimeConfig = envSearchConfig();

export function getActiveSearchConfig(): SearchRuntimeConfig {
  return activeSearchConfig;
}

export class SearchSettingsService {
  private cached: SearchRuntimeConfig | null;

  constructor(private readonly db: Db) {
    this.cached = this.readRuntime();
    activeSearchConfig = this.cached ?? envSearchConfig();
  }

  private readRuntime(): SearchRuntimeConfig | null {
    try {
      const row = this.db
        .prepare('SELECT value_json, updated_at FROM app_settings WHERE key = ?')
        .get(SETTINGS_KEY) as { value_json: string; updated_at: string } | undefined;
      if (!row) return null;
      const stored = JSON.parse(row.value_json) as StoredSearchSettings;
      if (!stored || typeof stored !== 'object') return null;
      return {
        apiKey: stored.apiKey?.trim() ?? '',
        dailyLimit:
          Number.isFinite(stored.dailyLimit) && stored.dailyLimit > 0
            ? Math.min(Math.round(stored.dailyLimit), 5000)
            : config.search.dailyLimit,
        source: 'runtime',
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  get(): SearchRuntimeConfig {
    return this.cached ?? envSearchConfig();
  }

  publicSettings(): SearchPublicSettings {
    const current = this.get();
    return {
      hasApiKey: current.apiKey.length > 0,
      apiKeyMasked: maskSecret(current.apiKey),
      dailyLimit: current.dailyLimit,
      source: current.source,
      updatedAt: current.updatedAt,
    };
  }

  save(input: SearchSettingsInput): SearchPublicSettings {
    const current = this.get();
    const apiKey =
      input.clearApiKey === true
        ? ''
        : input.apiKey && input.apiKey.trim().length > 0
          ? input.apiKey.trim()
          : current.apiKey;
    const next: SearchRuntimeConfig = {
      apiKey,
      dailyLimit:
        input.dailyLimit !== undefined && Number.isFinite(input.dailyLimit)
          ? Math.min(Math.max(Math.round(input.dailyLimit), 1), 5000)
          : current.dailyLimit,
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
    activeSearchConfig = next;
    return this.publicSettings();
  }

  reset(): SearchPublicSettings {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(SETTINGS_KEY);
    this.cached = null;
    activeSearchConfig = envSearchConfig();
    return this.publicSettings();
  }
}
