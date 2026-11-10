/**
 * 天地图运行时配置。
 *
 * - 浏览器端 Key：通过 /api/map/config 下发给前端加载瓦片；
 * - 服务端 Key：只用于服务端地名检索；
 * - 管理页保存后立即生效，并同步到后端坐标解析器，无需重启。
 */
import type { Db } from '../db';
import { config } from '../config';
import { maskSecret } from '../lib/mask';

export interface MapRuntimeConfig {
  browserKey: string;
  serverKey: string;
  enabled: boolean;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

export interface MapSettingsInput {
  browserKey?: string;
  serverKey?: string;
  clearServerKey?: boolean;
  enabled?: boolean;
}

export interface MapPublicSettings {
  hasBrowserKey: boolean;
  browserKeyMasked: string;
  hasServerKey: boolean;
  serverKeyMasked: string;
  enabled: boolean;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

interface StoredMapSettings {
  browserKey: string;
  serverKey: string;
  enabled: boolean;
}

const SETTINGS_KEY = 'map';

export function envMapConfig(): MapRuntimeConfig {
  return {
    browserKey: config.tiandituKey,
    serverKey: config.tiandituServerKey,
    enabled: config.tiandituKey.length > 0,
    source: 'env',
    updatedAt: null,
  };
}

let activeMapConfig: MapRuntimeConfig = envMapConfig();

export function getActiveMapConfig(): MapRuntimeConfig {
  return activeMapConfig;
}

export class MapSettingsService {
  private cached: MapRuntimeConfig | null;

  constructor(private readonly db: Db) {
    this.cached = this.readRuntime();
    activeMapConfig = this.cached ?? envMapConfig();
  }

  private readRuntime(): MapRuntimeConfig | null {
    try {
      const row = this.db
        .prepare('SELECT value_json, updated_at FROM app_settings WHERE key = ?')
        .get(SETTINGS_KEY) as { value_json: string; updated_at: string } | undefined;
      if (!row) return null;
      const stored = JSON.parse(row.value_json) as StoredMapSettings;
      if (!stored || typeof stored !== 'object') return null;
      return {
        browserKey: stored.browserKey?.trim() ?? '',
        serverKey: stored.serverKey?.trim() ?? '',
        enabled: stored.enabled !== false,
        source: 'runtime',
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  get(): MapRuntimeConfig {
    return this.cached ?? envMapConfig();
  }

  publicSettings(): MapPublicSettings {
    const current = this.get();
    return {
      hasBrowserKey: current.browserKey.length > 0,
      browserKeyMasked: maskSecret(current.browserKey),
      hasServerKey: current.serverKey.length > 0,
      serverKeyMasked: maskSecret(current.serverKey),
      enabled: current.enabled,
      source: current.source,
      updatedAt: current.updatedAt,
    };
  }

  save(input: MapSettingsInput): MapPublicSettings {
    const current = this.get();
    const browserKey =
      input.browserKey && input.browserKey.trim().length > 0
        ? input.browserKey.trim()
        : current.browserKey;
    const serverKey =
      input.clearServerKey === true
        ? ''
        : input.serverKey && input.serverKey.trim().length > 0
          ? input.serverKey.trim()
          : current.serverKey;
    const next: MapRuntimeConfig = {
      browserKey,
      serverKey,
      enabled: input.enabled ?? current.enabled,
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
    activeMapConfig = next;
    return this.publicSettings();
  }

  reset(): MapPublicSettings {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(SETTINGS_KEY);
    this.cached = null;
    activeMapConfig = envMapConfig();
    return this.publicSettings();
  }
}
