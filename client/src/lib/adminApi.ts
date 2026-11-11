/** 后台管理 API：大模型运行时配置。Token 只保存在 sessionStorage。 */

export const ADMIN_TOKEN_KEY = 'citylens:admin-token';

export interface AdminLlmSettings {
  provider: 'deepseek' | 'stepfun' | 'custom';
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  timeoutMs: number;
  mock: boolean;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

export interface AdminLlmInput {
  provider?: AdminLlmSettings['provider'];
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
  mock?: boolean;
}

export interface AdminLlmTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  model: string;
  message: string;
}

export interface AdminMapSettings {
  hasBrowserKey: boolean;
  browserKeyMasked: string;
  hasServerKey: boolean;
  serverKeyMasked: string;
  enabled: boolean;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

export interface AdminMapInput {
  browserKey?: string;
  serverKey?: string;
  clearServerKey?: boolean;
  enabled?: boolean;
}

export interface AdminMapTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  count: number;
  message: string;
}

export interface AdminSearchSettings {
  hasApiKey: boolean;
  apiKeyMasked: string;
  dailyLimit: number;
  source: 'runtime' | 'env';
  updatedAt: string | null;
}

export interface AdminSearchInput {
  apiKey?: string;
  clearApiKey?: boolean;
  dailyLimit?: number;
}

export interface AdminSearchTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  count: number;
  message: string;
}

export interface AdminArtifact {
  key: string;
  label: string;
  count: number | null;
  updatedAt: string | null;
  status: 'ready' | 'missing';
  note: string;
}

export interface AdminOverview {
  llm: AdminLlmSettings;
  map: AdminMapSettings;
  search: AdminSearchSettings;
  services: {
    llm: {
      configured: boolean;
      mock: boolean;
      callsToday: number;
      dailyBudget: number;
      remaining: number;
    };
    map: { enabled: boolean };
    search: {
      configured: boolean;
      source: 'runtime' | 'env';
      usage: { date: string; count: number; limit: number };
    };
    images: { enabled: boolean; count: number };
  };
  artifacts: AdminArtifact[];
  security: {
    adminTokenConfigured: boolean;
    adminAccess: 'token' | 'local-only';
    allowedOrigins: string[];
  };
  database: { cities: number; archives: number; presets: number };
}

async function request<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': token,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 错误体 */
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

export function getAdminOverview(token: string): Promise<AdminOverview> {
  return request('/api/admin/overview', token);
}

export function getAdminLlm(token: string): Promise<AdminLlmSettings> {
  return request('/api/admin/llm', token);
}

export function saveAdminLlm(token: string, input: AdminLlmInput): Promise<AdminLlmSettings> {
  return request('/api/admin/llm', token, { method: 'PUT', body: JSON.stringify(input) });
}

export function resetAdminLlm(token: string): Promise<AdminLlmSettings> {
  return request('/api/admin/llm', token, { method: 'DELETE' });
}

export function testAdminLlm(
  token: string,
  input: Pick<AdminLlmInput, 'baseUrl' | 'model' | 'apiKey' | 'timeoutMs'>,
): Promise<AdminLlmTestResult> {
  return request('/api/admin/llm/test', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function saveAdminMap(token: string, input: AdminMapInput): Promise<AdminMapSettings> {
  return request('/api/admin/map', token, { method: 'PUT', body: JSON.stringify(input) });
}

export function resetAdminMap(token: string): Promise<AdminMapSettings> {
  return request('/api/admin/map', token, { method: 'DELETE' });
}

export function testAdminMap(
  token: string,
  input: Pick<AdminMapInput, 'browserKey' | 'serverKey'>,
): Promise<AdminMapTestResult> {
  return request('/api/admin/map/test', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function saveAdminSearch(
  token: string,
  input: AdminSearchInput,
): Promise<AdminSearchSettings> {
  return request('/api/admin/search', token, { method: 'PUT', body: JSON.stringify(input) });
}

export function resetAdminSearch(token: string): Promise<AdminSearchSettings> {
  return request('/api/admin/search', token, { method: 'DELETE' });
}

export function testAdminSearch(
  token: string,
  input: Pick<AdminSearchInput, 'apiKey'>,
): Promise<AdminSearchTestResult> {
  return request('/api/admin/search/test', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
