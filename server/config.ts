import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = here;
export const ROOT_DIR = resolve(here, '..');
export const DATA_DIR = resolve(SERVER_DIR, 'data');

dotenv.config({ path: resolve(ROOT_DIR, '.env') });
dotenv.config({ path: resolve(SERVER_DIR, '.env') });

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  dbPath: process.env.DB_PATH ?? resolve(DATA_DIR, 'citylens.db'),
  dataDir: DATA_DIR,
  /**
   * 运行期缓存目录（城市侦察 / 检索 / 气候 / 用量 / 按需事实快照）。
   * 默认与 dataDir 一致；测试与干净复跑可用 CITYLENS_RUNTIME_DIR 指到独立临时目录，
   * 避免读写用户现有缓存。构建期产物（词典/诗词库/名录等）始终在 dataDir。
   */
  runtimeDir: process.env.CITYLENS_RUNTIME_DIR?.trim() || DATA_DIR,
  clientDist: resolve(ROOT_DIR, 'client/dist'),
  llm: {
    apiKey: process.env.LLM_API_KEY?.trim() ?? '',
    baseUrl: (process.env.LLM_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.LLM_MODEL?.trim() || 'deepseek-chat',
    dailyCallLimit: num(process.env.LLM_DAILY_CALL_LIMIT, 500),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 60000),
  },
  tiandituKey: process.env.TIANDITU_KEY?.trim() ?? '',
  tiandituServerKey: process.env.TIANDITU_SERVER_KEY?.trim() ?? '',
  search: {
    tavilyApiKey: process.env.TAVILY_API_KEY?.trim() ?? '',
    baseUrl: (process.env.TAVILY_BASE_URL?.trim() || 'https://api.tavily.com').replace(/\/+$/, ''),
    dailyLimit: num(process.env.SEARCH_DAILY_LIMIT, 200),
  },
  adminToken: process.env.ADMIN_TOKEN?.trim() ?? '',
  enableImages: process.env.ENABLE_IMAGES === 'true',
  /** 无 Key 时自动使用模拟 LLM；也可用 MOCK_LLM=true 强制模拟。 */
  mockLlm: process.env.MOCK_LLM === 'true' || !process.env.LLM_API_KEY?.trim(),
  ipHashSalt: process.env.IP_HASH_SALT?.trim() || 'citylens-dev-salt',
  simulateFail: (process.env.SIMULATE_FAIL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  mockLlmDelayMs: num(process.env.MOCK_LLM_DELAY_MS, 150),
  /** 生产环境允许的跨域来源（逗号分隔）；开发环境额外放行 localhost 任意端口。 */
  allowedOrigins: (process.env.APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
} as const;

export const llmConfigured = (): boolean => config.llm.apiKey.length > 0;
export const mapConfigured = (): boolean => config.tiandituKey.length > 0;
export const searchConfigured = (): boolean => config.search.tavilyApiKey.length > 0;
export const clientDistExists = (): boolean => existsSync(config.clientDist);

/** CORS / SSE 共用的来源校验：同源请求（无 Origin）始终放行。 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (config.allowedOrigins.includes(origin)) return true;
  if (config.nodeEnv !== 'production') {
    return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }
  return false;
}
