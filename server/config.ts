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
  clientDist: resolve(ROOT_DIR, 'client/dist'),
  llm: {
    apiKey: process.env.LLM_API_KEY?.trim() ?? '',
    baseUrl: (process.env.LLM_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.LLM_MODEL?.trim() || 'deepseek-chat',
    dailyCallLimit: num(process.env.LLM_DAILY_CALL_LIMIT, 500),
  },
  tiandituKey: process.env.TIANDITU_KEY?.trim() ?? '',
  adminToken: process.env.ADMIN_TOKEN?.trim() ?? '',
  enableImages: process.env.ENABLE_IMAGES === 'true',
  ipHashSalt: process.env.IP_HASH_SALT?.trim() || 'citylens-dev-salt',
  simulateFail: (process.env.SIMULATE_FAIL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  mockLlmDelayMs: num(process.env.MOCK_LLM_DELAY_MS, 0),
} as const;

export const llmConfigured = (): boolean => config.llm.apiKey.length > 0;
export const mapConfigured = (): boolean => config.tiandituKey.length > 0;
export const clientDistExists = (): boolean => existsSync(config.clientDist);
