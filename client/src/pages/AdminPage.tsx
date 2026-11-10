/** 后台管理：大模型自定义配置（DeepSeek / 阶跃星辰 / 任意 OpenAI 兼容接口）。 */
import { useEffect, useState } from 'react';
import {
  ADMIN_TOKEN_KEY,
  getAdminLlm,
  resetAdminLlm,
  saveAdminLlm,
  testAdminLlm,
  type AdminLlmSettings,
  type AdminLlmTestResult,
} from '../lib/adminApi';

const PROVIDER_PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    hint: 'DeepSeek 官方接口，路径为 {baseUrl}/chat/completions。',
  },
  stepfun: {
    label: '阶跃星辰 StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-5',
    hint: 'Base URL 通常以 /v1 结尾；模型 ID 请以 StepFun 控制台实际提供的为准（例如 step-5）。',
  },
  custom: {
    label: '自定义 OpenAI 兼容接口',
    baseUrl: '',
    model: '',
    hint: '任何兼容 /chat/completions 的服务均可，例如自建网关或其他云厂商。',
  },
} as const;

type Provider = keyof typeof PROVIDER_PRESETS;

interface FormState {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  mock: boolean;
}

const EMPTY_FORM: FormState = {
  provider: 'deepseek',
  baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
  model: PROVIDER_PRESETS.deepseek.model,
  apiKey: '',
  timeoutMs: 60000,
  mock: true,
};

function toForm(settings: AdminLlmSettings): FormState {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: '',
    timeoutMs: settings.timeoutMs,
    mock: settings.mock,
  };
}

export function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '');
  const [tokenInput, setTokenInput] = useState(token);
  const [settings, setSettings] = useState<AdminLlmSettings | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AdminLlmTestResult | null>(null);

  const load = async (adminToken: string): Promise<void> => {
    setLoading(true);
    setMessage(null);
    try {
      const data = await getAdminLlm(adminToken);
      setSettings(data);
      setForm(toForm(data));
      setToken(adminToken);
      sessionStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
    } catch (error) {
      setSettings(null);
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) void load(token);
    // 仅在首次挂载时尝试自动恢复会话内的令牌
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const chooseProvider = (provider: Provider): void => {
    const preset = PROVIDER_PRESETS[provider];
    setForm((current) => ({
      ...current,
      provider,
      baseUrl: preset.baseUrl || current.baseUrl,
      model: preset.model || current.model,
    }));
  };

  const save = async (): Promise<void> => {
    if (!token && !settings) {
      setMessage('请先输入管理令牌；本机未配置 ADMIN_TOKEN 时可直接留空进入。');
      return;
    }
    setSaving(true);
    setMessage(null);
    setTestResult(null);
    try {
      const data = await saveAdminLlm(token, {
        provider: form.provider,
        baseUrl: form.baseUrl,
        model: form.model,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        timeoutMs: form.timeoutMs,
        mock: form.mock,
      });
      setSettings(data);
      setForm(toForm(data));
      setMessage(data.mock ? '已保存：当前使用模拟 LLM。' : '已保存：下次生成将使用新配置。');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setMessage(null);
    setTestResult(null);
    try {
      const result = await testAdminLlm(token, {
        baseUrl: form.baseUrl,
        model: form.model,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        timeoutMs: Math.min(form.timeoutMs, 30000),
      });
      setTestResult(result);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const reset = async (): Promise<void> => {
    if (!window.confirm('恢复为 .env 默认配置？运行时保存的 Base URL、模型与 Key 将被删除。')) return;
    setMessage(null);
    try {
      const data = await resetAdminLlm(token);
      setSettings(data);
      setForm(toForm(data));
      setMessage('已恢复 .env 默认配置。');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  const preset = PROVIDER_PRESETS[form.provider];

  return (
    <main className="page-shell py-12 md:py-16">
      <p className="eyebrow">CITYLENS · ADMIN</p>
      <h1 className="mt-4 font-serif text-3xl tracking-[0.14em] md:text-4xl">后台管理</h1>
      <p className="mt-3 max-w-2xl text-xs leading-relaxed text-[var(--text-secondary)]">
        在这里自定义大模型服务。未配置 Key 时继续使用模拟 LLM；保存后无需重启服务。
        API Key 只写入本地 SQLite，读取接口只返回掩码。
      </p>

      <section className="surface-card mt-8 max-w-3xl rounded-md p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">访问令牌</p>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              服务端配置了 <code className="mono">ADMIN_TOKEN</code> 时必须填写；
              未配置时仅允许本机访问。
            </p>
          </div>
          {settings ? (
            <span className="border px-2 py-1 text-[10px] tracking-[0.12em] hairline">
              {settings.source === 'runtime' ? '运行时配置' : '.env 默认'}
            </span>
          ) : null}
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="ADMIN_TOKEN（本机留空可进入）"
            className="min-w-0 flex-1 border bg-transparent px-3 py-2 text-xs outline-none hairline focus:border-[var(--city-primary)]"
            autoComplete="off"
          />
          <button
            type="button"
            className="ink-btn px-4 py-2 text-[11px]"
            onClick={() => void load(tokenInput.trim())}
            disabled={loading}
          >
            {loading ? '读取中…' : settings ? '重新读取' : '进入管理'}
          </button>
        </div>
      </section>

      {settings ? (
        <section className="surface-card mt-6 max-w-3xl rounded-md p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="eyebrow">大模型配置</p>
            <span className="mono text-[10px] text-[var(--text-secondary)]">
              {settings.updatedAt
                ? `更新于 ${new Date(settings.updatedAt).toLocaleString('zh-CN')}`
                : '尚未保存运行时配置'}
            </span>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="text-[10px] tracking-[0.16em] text-[var(--text-secondary)]">服务商</span>
              <select
                value={form.provider}
                onChange={(event) => chooseProvider(event.target.value as Provider)}
                className="mt-1.5 w-full border bg-transparent px-3 py-2 text-xs hairline outline-none focus:border-[var(--city-primary)]"
              >
                {(Object.keys(PROVIDER_PRESETS) as Provider[]).map((key) => (
                  <option key={key} value={key} className="text-black">
                    {PROVIDER_PRESETS[key].label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[10px] tracking-[0.16em] text-[var(--text-secondary)]">
                请求超时（毫秒）
              </span>
              <input
                type="number"
                min={5000}
                max={180000}
                step={1000}
                value={form.timeoutMs}
                onChange={(event) => update('timeoutMs', Number(event.target.value))}
                className="mt-1.5 w-full border bg-transparent px-3 py-2 text-xs outline-none hairline focus:border-[var(--city-primary)]"
              />
            </label>

            <label className="block md:col-span-2">
              <span className="text-[10px] tracking-[0.16em] text-[var(--text-secondary)]">
                Base URL
              </span>
              <input
                type="url"
                value={form.baseUrl}
                onChange={(event) => update('baseUrl', event.target.value)}
                placeholder="https://api.stepfun.com/v1"
                className="mt-1.5 w-full border bg-transparent px-3 py-2 text-xs outline-none hairline focus:border-[var(--city-primary)]"
              />
              <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-secondary)]">
                {preset.hint}
              </span>
            </label>

            <label className="block">
              <span className="text-[10px] tracking-[0.16em] text-[var(--text-secondary)]">
                模型 ID
              </span>
              <input
                type="text"
                value={form.model}
                onChange={(event) => update('model', event.target.value)}
                placeholder="step-5"
                className="mt-1.5 w-full border bg-transparent px-3 py-2 text-xs outline-none hairline focus:border-[var(--city-primary)]"
              />
            </label>

            <label className="block">
              <span className="text-[10px] tracking-[0.16em] text-[var(--text-secondary)]">
                API Key
              </span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => update('apiKey', event.target.value)}
                placeholder={settings.hasApiKey ? `已保存：${settings.apiKeyMasked}（留空不修改）` : '粘贴 API Key'}
                className="mt-1.5 w-full border bg-transparent px-3 py-2 text-xs outline-none hairline focus:border-[var(--city-primary)]"
                autoComplete="new-password"
              />
            </label>
          </div>

          <label className="mt-5 flex items-start gap-3 rounded-sm border p-3 text-[11px] hairline">
            <input
              type="checkbox"
              checked={form.mock}
              onChange={(event) => update('mock', event.target.checked)}
              className="mt-0.5 accent-[var(--city-primary)]"
            />
            <span>
              使用模拟 LLM（不调用外部接口）
              <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-secondary)]">
                取消勾选并保存 API Key 后，才会使用上面的真实服务；未缓存城市才会真正发起调用。
              </span>
            </span>
          </label>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ink-btn ink-btn--solid px-4 py-2 text-[11px]"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存配置'}
            </button>
            <button
              type="button"
              className="ink-btn px-4 py-2 text-[11px]"
              onClick={() => void test()}
              disabled={testing}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={() => void reset()}>
              恢复 .env 默认
            </button>
          </div>

          {message ? (
            <p className="mt-4 text-[11px] leading-relaxed text-[var(--city-primary)]" role="status">
              {message}
            </p>
          ) : null}

          {testResult ? (
            <div
              className="mt-4 rounded-sm border p-3 text-[11px] leading-relaxed hairline"
              role="status"
            >
              <p className="mono text-[10px] tracking-[0.12em]">
                {testResult.ok ? '连接成功' : '连接失败'} · HTTP {testResult.status} ·{' '}
                {testResult.latencyMs}ms · {testResult.model}
              </p>
              <p className="mt-1 text-[var(--text-secondary)]">{testResult.message}</p>
            </div>
          ) : null}

          <p className="mt-5 border-t pt-3 text-[10px] leading-relaxed text-[var(--text-secondary)] hairline">
            当前生效：{settings.provider} · {settings.model || '未填写模型'} ·{' '}
            {settings.hasApiKey ? `Key ${settings.apiKeyMasked}` : '未配置 Key'} ·{' '}
            {settings.mock ? '模拟模式' : '真实调用'}。
          </p>
        </section>
      ) : null}

      {!settings && message ? (
        <p className="mt-4 max-w-3xl text-[11px] leading-relaxed text-[var(--city-primary)]" role="status">
          {message}
        </p>
      ) : null}
    </main>
  );
}
