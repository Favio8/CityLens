/** 前端 API 客户端：所有响应均按 shared/schema.ts 的 Zod Schema 解析。 */
import {
  ApiErrorSchema,
  CityArchiveResponseSchema,
  HotCitiesResponseSchema,
  SearchResponseSchema,
  type CityArchiveResponse,
  type HotCity,
  type SearchResponse,
} from '@citylens/shared/schema';
import type { ZodTypeAny, z } from 'zod';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSec?: number;

  constructor(code: string, message: string, status: number, retryAfterSec?: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

async function readError(response: Response): Promise<ApiRequestError> {
  let code = 'REQUEST_FAILED';
  let message = `请求失败（HTTP ${response.status}）`;
  let retryAfterSec: number | undefined;
  try {
    const parsed = ApiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.code;
      message = parsed.data.message;
      retryAfterSec = parsed.data.retryAfterSec;
    }
  } catch {
    // 非 JSON 错误体，保留默认文案
  }
  return new ApiRequestError(code, message, response.status, retryAfterSec);
}

async function getJson<S extends ZodTypeAny>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw await readError(response);
  const payload: unknown = await response.json();
  return schema.parse(payload);
}

export function searchCities(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  return getJson(`/api/cities/search?q=${encodeURIComponent(query)}`, SearchResponseSchema, signal);
}

export async function getHotCities(signal?: AbortSignal): Promise<HotCity[]> {
  const data = await getJson('/api/cities/hot', HotCitiesResponseSchema, signal);
  return data.cities;
}

export function getCityArchive(cityId: string, signal?: AbortSignal): Promise<CityArchiveResponse> {
  return getJson(`/api/cities/${encodeURIComponent(cityId)}`, CityArchiveResponseSchema, signal);
}

export interface HealthInfo {
  ok: boolean;
  llmConfigured: boolean;
  mapConfigured: boolean;
  mockLlm: boolean;
  presetCities: number;
  archives: number;
}

export async function getHealth(signal?: AbortSignal): Promise<HealthInfo> {
  const response = await fetch('/api/health', { signal });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as HealthInfo;
}

export interface MapConfig {
  enabled: boolean;
  key: string | null;
  styleUrl: string | null;
}

/** 天地图 Key 由服务端下发；大模型 Key 永远不会进入前端。 */
export async function getMapConfig(signal?: AbortSignal): Promise<MapConfig> {
  const response = await fetch('/api/map/config', { signal });
  if (!response.ok) return { enabled: false, key: null, styleUrl: null };
  return (await response.json()) as MapConfig;
}
