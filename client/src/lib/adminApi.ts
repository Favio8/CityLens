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
