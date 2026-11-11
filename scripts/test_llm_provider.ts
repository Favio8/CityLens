/**
 * 官方大模型连通性测试脚本（AC-04）。
 *
 * 用法：
 *   npm run test:llm                                  # 用当前生效配置（/admin 运行时 > .env）
 *   npm run test:llm -- --base-url https://api.deepseek.com --model deepseek-chat --api-key sk-...
 *
 * 行为：向 {baseUrl}/chat/completions 发一次最小请求（max_tokens=8），
 * 打印 provider / baseUrl / model / HTTP 状态 / 延迟，退出码 0=可用、1=不可用。
 * Key 只从命令行参数或本地 .env / SQLite 运行时配置读取，不落盘、不回显。
 */
import Database from 'better-sqlite3';
import { config } from '../server/config';

interface Args {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--base-url' && next) {
      args.baseUrl = next.replace(/\/+$/, '');
      index += 1;
    } else if (token === '--model' && next) {
      args.model = next;
      index += 1;
    } else if (token === '--api-key' && next) {
      args.apiKey = next;
      index += 1;
    } else if (token === '--timeout-ms' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) args.timeoutMs = parsed;
      index += 1;
    }
  }
  return args;
}

interface EffectiveConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  source: 'runtime' | 'env';
}

/** 运行时配置（/admin 保存）优先于 .env；只读打开，不写库。 */
function readRuntimeLlm(): EffectiveConfig | null {
  try {
    const db = new Database(config.dbPath, { readonly: true });
    try {
      const row = db
        .prepare('SELECT value_json FROM app_settings WHERE key = ?')
        .get('llm') as { value_json: string } | undefined;
      if (!row) return null;
      const stored = JSON.parse(row.value_json) as {
        provider?: string;
        baseUrl?: string;
        model?: string;
        apiKey?: string;
        timeoutMs?: number;
        mock?: boolean;
      };
      if (stored.mock === true) return null;
      if (!stored.apiKey) return null;
      return {
        provider: stored.provider ?? 'custom',
        baseUrl: (stored.baseUrl ?? '').replace(/\/+$/, ''),
        model: stored.model ?? '',
        apiKey: stored.apiKey,
        timeoutMs: Number.isFinite(stored.timeoutMs) ? (stored.timeoutMs as number) : config.llm.timeoutMs,
        source: 'runtime',
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function envConfig(): EffectiveConfig {
  const baseUrl = config.llm.baseUrl.replace(/\/+$/, '');
  const provider = baseUrl.includes('api.stepfun.com')
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
    source: 'env',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const effective = readRuntimeLlm() ?? envConfig();
  const target: EffectiveConfig = {
    ...effective,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  };

  console.log(
    `[test:llm] source=${target.source} provider=${target.provider} ` +
      `baseUrl=${target.baseUrl} model=${target.model || '(未填写)'} ` +
      `apiKey=${target.apiKey ? '已配置' : '未配置'}`,
  );
  if (!target.baseUrl || !target.model) {
    console.error('[test:llm] 缺少 Base URL 或模型名：请通过参数或 .env / /admin 配置');
    process.exitCode = 1;
    return;
  }
  if (!target.apiKey) {
    console.error('[test:llm] 未配置 API Key：请通过参数或 .env（LLM_API_KEY）或 /admin 提供');
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(target.timeoutMs, 60000));
  const startedAt = Date.now();
  try {
    const response = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({
        model: target.model,
        stream: false,
        max_tokens: 8,
        temperature: 0,
        messages: [{ role: 'user', content: '只回复 OK' }],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    let message = '';
    try {
      const json = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      message =
        json.error?.message ??
        json.choices?.[0]?.message?.content?.trim() ??
        (response.ok ? '连接成功' : text.slice(0, 200));
    } catch {
      message = text.slice(0, 200);
    }
    const ok = response.ok && !/error/i.test(message.slice(0, 5));
    console.log(
      `[test:llm] ${ok ? 'OK' : 'FAIL'} http=${response.status} latency=${latencyMs}ms model=${target.model}`,
    );
    console.log(`[test:llm] message=${message || '(空)'}`);
    if (!ok) process.exitCode = 1;
    return;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted = (error as Error).name === 'AbortError';
    console.error(
      `[test:llm] FAIL http=0 latency=${latencyMs}ms ` +
        `message=${aborted ? `连接超时（>${Math.min(target.timeoutMs, 60000)}ms）` : `连接失败：${(error as Error).message}`}`,
    );
    process.exitCode = 1;
    return;
  } finally {
    clearTimeout(timer);
  }
}

void main();
