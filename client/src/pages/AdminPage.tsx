/** 后台管理：统一查看与配置大模型、天地图、数据产物与安全状态。 */
import { useEffect, useState, type ReactNode } from 'react';
import { InkCanvas } from '../components/hero/InkCanvas';
import {
  ADMIN_TOKEN_KEY,
  getAdminOverview,
  resetAdminLlm,
  resetAdminMap,
  saveAdminLlm,
  saveAdminMap,
  testAdminLlm,
  testAdminMap,
  type AdminLlmSettings,
  type AdminLlmTestResult,
  type AdminMapTestResult,
  type AdminOverview,
} from '../lib/adminApi';

const PROVIDER_PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    hint: 'DeepSeek 官方接口，请求路径为 {baseUrl}/chat/completions。',
  },
  stepfun: {
    label: '阶跃星辰 StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-5',
    hint: 'Base URL 通常以 /v1 结尾；模型 ID 以 StepFun 控制台实际提供的为准。',
  },
  custom: {
    label: '自定义 OpenAI 兼容接口',
    baseUrl: '',
    model: '',
    hint: '任何兼容 /chat/completions 的服务均可，例如自建网关或其他云厂商。',
  },
} as const;

type Provider = keyof typeof PROVIDER_PRESETS;

interface LlmForm {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  mock: boolean;
}

interface MapForm {
  browserKey: string;
  serverKey: string;
  enabled: boolean;
}

const EMPTY_LLM_FORM: LlmForm = {
  provider: 'deepseek',
  baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
  model: PROVIDER_PRESETS.deepseek.model,
  apiKey: '',
  timeoutMs: 60000,
  mock: true,
};

const EMPTY_MAP_FORM: MapForm = { browserKey: '', serverKey: '', enabled: true };
const FIELD =
  'mt-1.5 w-full border bg-transparent px-3 py-2 text-xs outline-none hairline focus:border-[var(--city-primary)]';
const LABEL = 'text-[10px] tracking-[0.16em] text-[var(--text-secondary)]';

function toLlmForm(settings: AdminLlmSettings): LlmForm {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: '',
    timeoutMs: settings.timeoutMs,
    mock: settings.mock,
  };
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'off' }) {
  const color = tone === 'ok' ? 'bg-emerald-600' : tone === 'warn' ? 'bg-amber-500' : 'bg-[var(--text-secondary)]';
  return <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function AdminSection({
  id,
  index,
  title,
  description,
  aside,
  children,
}: {
  id: string;
  index: string;
  title: string;
  description: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mt-12 scroll-mt-24">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b pb-4 hairline">
        <div>
          <p className="hanzi-index">{index} · {title}</p>
          <h2 className="mt-2 font-serif text-2xl tracking-[0.12em] md:text-3xl">{title}</h2>
          <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {description}
          </p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '');
  const [tokenInput, setTokenInput] = useState(token);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [llmForm, setLlmForm] = useState<LlmForm>(EMPTY_LLM_FORM);
  const [mapForm, setMapForm] = useState<MapForm>(EMPTY_MAP_FORM);
  const [loading, setLoading] = useState(false);
  const [savingLlm, setSavingLlm] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [savingMap, setSavingMap] = useState(false);
  const [testingMap, setTestingMap] = useState(false);
  const [llmMessage, setLlmMessage] = useState<string | null>(null);
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  const [llmTest, setLlmTest] = useState<AdminLlmTestResult | null>(null);
  const [mapTest, setMapTest] = useState<AdminMapTestResult | null>(null);

  const load = async (adminToken: string): Promise<void> => {
    setLoading(true);
    setLlmMessage(null);
    setMapMessage(null);
    try {
      const data = await getAdminOverview(adminToken);
      setOverview(data);
      setLlmForm(toLlmForm(data.llm));
      setMapForm({ browserKey: '', serverKey: '', enabled: data.map.enabled });
      setToken(adminToken);
      sessionStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
    } catch (error) {
      setOverview(null);
      setLlmMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) void load(token);
    // 仅在首次挂载时恢复会话内令牌
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveLlm = async (): Promise<void> => {
    if (!overview) return;
    setSavingLlm(true);
    setLlmMessage(null);
    setLlmTest(null);
    try {
      const data = await saveAdminLlm(token, {
        provider: llmForm.provider,
        baseUrl: llmForm.baseUrl,
        model: llmForm.model,
        ...(llmForm.apiKey.trim() ? { apiKey: llmForm.apiKey.trim() } : {}),
        timeoutMs: llmForm.timeoutMs,
        mock: llmForm.mock,
      });
      setOverview({
        ...overview,
        llm: data,
        services: {
          ...overview.services,
          llm: { configured: data.hasApiKey && !data.mock, mock: data.mock },
        },
      });
      setLlmForm(toLlmForm(data));
      setLlmMessage(data.mock ? '已保存：当前使用模拟 LLM。' : '已保存：下次生成将使用新配置。');
    } catch (error) {
      setLlmMessage((error as Error).message);
    } finally {
      setSavingLlm(false);
    }
  };

  const testLlm = async (): Promise<void> => {
    setTestingLlm(true);
    setLlmMessage(null);
    setLlmTest(null);
    try {
      setLlmTest(
        await testAdminLlm(token, {
          baseUrl: llmForm.baseUrl,
          model: llmForm.model,
          ...(llmForm.apiKey.trim() ? { apiKey: llmForm.apiKey.trim() } : {}),
          timeoutMs: Math.min(llmForm.timeoutMs, 30000),
        }),
      );
    } catch (error) {
      setLlmMessage((error as Error).message);
    } finally {
      setTestingLlm(false);
    }
  };

  const resetLlm = async (): Promise<void> => {
    if (!overview) return;
    if (!window.confirm('恢复大模型为 .env 默认配置？运行时保存的 Base URL、模型与 Key 将被删除。')) return;
    try {
      const data = await resetAdminLlm(token);
      setOverview({
        ...overview,
        llm: data,
        services: {
          ...overview.services,
          llm: { configured: data.hasApiKey && !data.mock, mock: data.mock },
        },
      });
      setLlmForm(toLlmForm(data));
      setLlmMessage('已恢复 .env 默认配置。');
    } catch (error) {
      setLlmMessage((error as Error).message);
    }
  };

  const saveMap = async (): Promise<void> => {
    if (!overview) return;
    setSavingMap(true);
    setMapMessage(null);
    setMapTest(null);
    try {
      const data = await saveAdminMap(token, {
        ...(mapForm.browserKey.trim() ? { browserKey: mapForm.browserKey.trim() } : {}),
        ...(mapForm.serverKey.trim() ? { serverKey: mapForm.serverKey.trim() } : {}),
        enabled: mapForm.enabled,
      });
      setOverview({ ...overview, map: data, services: { ...overview.services, map: { enabled: data.enabled && data.hasBrowserKey } } });
      setMapForm({ browserKey: '', serverKey: '', enabled: data.enabled });
      setMapMessage('已保存：刷新城市页后生效。');
    } catch (error) {
      setMapMessage((error as Error).message);
    } finally {
      setSavingMap(false);
    }
  };

  const testMap = async (): Promise<void> => {
    setTestingMap(true);
    setMapMessage(null);
    setMapTest(null);
    try {
      setMapTest(
        await testAdminMap(token, {
          ...(mapForm.browserKey.trim() ? { browserKey: mapForm.browserKey.trim() } : {}),
          ...(mapForm.serverKey.trim() ? { serverKey: mapForm.serverKey.trim() } : {}),
        }),
      );
    } catch (error) {
      setMapMessage((error as Error).message);
    } finally {
      setTestingMap(false);
    }
  };

  const resetMap = async (): Promise<void> => {
    if (!overview) return;
    if (!window.confirm('恢复天地图配置为 .env 默认？运行时保存的 Key 将被删除。')) return;
    try {
      const data = await resetAdminMap(token);
      setOverview({ ...overview, map: data, services: { ...overview.services, map: { enabled: data.enabled && data.hasBrowserKey } } });
      setMapForm({ browserKey: '', serverKey: '', enabled: data.enabled });
      setMapMessage('已恢复 .env 默认配置。');
    } catch (error) {
      setMapMessage((error as Error).message);
    }
  };

  const preset = PROVIDER_PRESETS[llmForm.provider];

  return (
    <main>
      <section className="relative overflow-hidden border-b hairline">
        <InkCanvas />
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, transparent 0%, transparent 55%, color-mix(in srgb, var(--bg-canvas) 92%, transparent) 100%)',
          }}
        />
        <div className="page-shell relative py-12 md:py-16">
          <p className="eyebrow">CITYLENS · ADMIN</p>
          <h1 className="display-city mt-4 text-[52px] md:text-[82px]">后台管理</h1>
          <p className="mt-4 max-w-2xl text-sm leading-[1.9] text-[var(--text-secondary)]">
            统一管理大模型、天地图、图片与外部数据服务。Key 只保存在本地 SQLite，读取接口只返回掩码；
            保存后无需重启服务。
          </p>
          {overview ? (
            <div className="mt-6 flex flex-wrap items-center gap-2 text-[10px] tracking-[0.12em]">
              <span className="flex items-center gap-1.5 border px-2 py-1 hairline">
                <StatusDot tone={overview.services.llm.mock ? 'warn' : 'ok'} />
                大模型 · {overview.services.llm.mock ? '模拟' : '真实调用'}
              </span>
              <span className="flex items-center gap-1.5 border px-2 py-1 hairline">
                <StatusDot tone={overview.services.map.enabled ? 'ok' : 'off'} />
                天地图 · {overview.services.map.enabled ? '已配置' : '无底图'}
              </span>
              <span className="flex items-center gap-1.5 border px-2 py-1 hairline">
                <StatusDot tone={overview.services.images.enabled ? 'ok' : 'off'} />
                文物图片 · {overview.services.images.count} 张
              </span>
              <span className="flex items-center gap-1.5 border px-2 py-1 hairline">
                <StatusDot tone="ok" />
                档案库 · {overview.database.archives} 份
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <div className="page-shell py-10">
        {!overview ? (
          <section className="surface-card mx-auto max-w-xl rounded-md p-6">
            <p className="eyebrow">访问令牌</p>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              服务端配置了 <code className="mono">ADMIN_TOKEN</code> 时必须填写；未配置时仅允许本机回环访问。
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="ADMIN_TOKEN（本机留空可进入）"
                className="min-w-0 flex-1 border bg-transparent px-3 py-2 text-xs outline-none hairline focus:border-[var(--city-primary)]"
                autoComplete="off"
              />
              <button type="button" className="ink-btn ink-btn--solid px-4 py-2 text-[11px]" onClick={() => void load(tokenInput.trim())} disabled={loading}>
                {loading ? '读取中…' : '进入管理'}
              </button>
            </div>
            {llmMessage ? (
              <p className="mt-4 text-[11px] leading-relaxed text-[var(--city-primary)]" role="status">
                {llmMessage}
              </p>
            ) : null}
          </section>
        ) : (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <nav className="flex flex-wrap gap-2 text-[10px] tracking-[0.12em]">
                {[
                  ['admin-overview', '总览'],
                  ['admin-llm', '大模型'],
                  ['admin-map', '天地图'],
                  ['admin-data', '数据与安全'],
                ].map(([id, label]) => (
                  <a key={id} href={`#${id}`} className="ink-btn px-3 py-1.5">
                    {label}
                  </a>
                ))}
              </nav>
              <span className="mono text-[10px] text-[var(--text-secondary)]">
                {overview.security.adminAccess === 'token' ? '令牌模式' : '本机模式'} ·{' '}
                {overview.llm.source === 'runtime' ? '运行时配置' : '.env 默认'}
              </span>
            </div>

            <section id="admin-overview" className="mt-8 scroll-mt-24">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="surface-card rounded-md p-5">
                  <div className="flex items-center justify-between">
                    <p className="eyebrow">大模型</p>
                    <StatusDot tone={overview.services.llm.mock ? 'warn' : 'ok'} />
                  </div>
                  <p className="mt-3 font-serif text-lg">{overview.llm.provider}</p>
                  <p className="mono mt-1 text-[10px] text-[var(--text-secondary)]">{overview.llm.model || '未填写模型'}</p>
                  <p className="mt-3 text-[10px] text-[var(--text-secondary)]">
                    {overview.llm.hasApiKey ? `Key ${overview.llm.apiKeyMasked}` : '未配置 Key'} ·{' '}
                    {overview.llm.mock ? '模拟模式' : '真实调用'}
                  </p>
                </div>
                <div className="surface-card rounded-md p-5">
                  <div className="flex items-center justify-between">
                    <p className="eyebrow">天地图</p>
                    <StatusDot tone={overview.services.map.enabled ? 'ok' : 'off'} />
                  </div>
                  <p className="mt-3 font-serif text-lg">{overview.services.map.enabled ? '底图已启用' : '无底图模式'}</p>
                  <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
                    浏览器 Key {overview.map.hasBrowserKey ? overview.map.browserKeyMasked : '未配置'}
                  </p>
                  <p className="mt-3 text-[10px] text-[var(--text-secondary)]">
                    服务端 Key {overview.map.hasServerKey ? overview.map.serverKeyMasked : '未配置'}
                  </p>
                </div>
                <div className="surface-card rounded-md p-5">
                  <div className="flex items-center justify-between">
                    <p className="eyebrow">文物图片</p>
                    <StatusDot tone={overview.services.images.enabled ? 'ok' : 'off'} />
                  </div>
                  <p className="mt-3 font-serif text-lg">{overview.services.images.count} 张</p>
                  <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
                    {overview.services.images.enabled ? '档案中启用本地图片' : '档案中未启用图片'}
                  </p>
                  <p className="mt-3 text-[10px] text-[var(--text-secondary)]">Wikimedia Commons · 本地缓存</p>
                </div>
                <div className="surface-card rounded-md p-5">
                  <div className="flex items-center justify-between">
                    <p className="eyebrow">档案库</p>
                    <StatusDot tone="ok" />
                  </div>
                  <p className="mt-3 font-serif text-lg">{overview.database.archives} 份</p>
                  <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
                    预置 {overview.database.presets} · 城市词典 {overview.database.cities}
                  </p>
                  <p className="mt-3 text-[10px] text-[var(--text-secondary)]">SQLite · 本地运行</p>
                </div>
              </div>
            </section>

            <AdminSection
              id="admin-llm"
              index="01"
              title="大模型服务"
              description="支持 DeepSeek、阶跃星辰 StepFun 与任意 OpenAI 兼容接口。保存后立即生效，不会把明文 Key 返回前端。"
              aside={
                <span className="mono text-[10px] text-[var(--text-secondary)]">
                  {overview.llm.updatedAt ? `更新于 ${when(overview.llm.updatedAt)}` : '尚未保存运行时配置'}
                </span>
              }
            >
              <div className="surface-card rounded-md p-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className={LABEL}>服务商</span>
                    <select
                      value={llmForm.provider}
                      onChange={(event) => {
                        const provider = event.target.value as Provider;
                        const next = PROVIDER_PRESETS[provider];
                        setLlmForm((current) => ({
                          ...current,
                          provider,
                          baseUrl: next.baseUrl || current.baseUrl,
                          model: next.model || current.model,
                        }));
                      }}
                      className={FIELD}
                    >
                      {(Object.keys(PROVIDER_PRESETS) as Provider[]).map((key) => (
                        <option key={key} value={key} className="text-black">
                          {PROVIDER_PRESETS[key].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className={LABEL}>请求超时（毫秒）</span>
                    <input
                      type="number"
                      min={5000}
                      max={180000}
                      step={1000}
                      value={llmForm.timeoutMs}
                      onChange={(event) => setLlmForm((current) => ({ ...current, timeoutMs: Number(event.target.value) }))}
                      className={FIELD}
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className={LABEL}>Base URL</span>
                    <input
                      type="url"
                      value={llmForm.baseUrl}
                      onChange={(event) => setLlmForm((current) => ({ ...current, baseUrl: event.target.value }))}
                      placeholder="https://api.stepfun.com/v1"
                      className={FIELD}
                    />
                    <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-secondary)]">{preset.hint}</span>
                  </label>
                  <label className="block">
                    <span className={LABEL}>模型 ID</span>
                    <input
                      type="text"
                      value={llmForm.model}
                      onChange={(event) => setLlmForm((current) => ({ ...current, model: event.target.value }))}
                      placeholder="step-5"
                      className={FIELD}
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL}>API Key</span>
                    <input
                      type="password"
                      value={llmForm.apiKey}
                      onChange={(event) => setLlmForm((current) => ({ ...current, apiKey: event.target.value }))}
                      placeholder={overview.llm.hasApiKey ? `已保存：${overview.llm.apiKeyMasked}（留空不修改）` : '粘贴 API Key'}
                      className={FIELD}
                      autoComplete="new-password"
                    />
                  </label>
                </div>

                <label className="mt-5 flex items-start gap-3 rounded-sm border p-3 text-[11px] hairline">
                  <input
                    type="checkbox"
                    checked={llmForm.mock}
                    onChange={(event) => setLlmForm((current) => ({ ...current, mock: event.target.checked }))}
                    className="mt-0.5 accent-[var(--city-primary)]"
                  />
                  <span>
                    使用模拟 LLM（不调用外部接口）
                    <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-secondary)]">
                      取消勾选并保存 API Key 后，未缓存城市才会真正发起调用。
                    </span>
                  </span>
                </label>

                <div className="mt-6 flex flex-wrap items-center gap-2">
                  <button type="button" className="ink-btn ink-btn--solid px-4 py-2 text-[11px]" onClick={() => void saveLlm()} disabled={savingLlm}>
                    {savingLlm ? '保存中…' : '保存配置'}
                  </button>
                  <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={() => void testLlm()} disabled={testingLlm}>
                    {testingLlm ? '测试中…' : '测试连接'}
                  </button>
                  <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={() => void resetLlm()}>
                    恢复 .env 默认
                  </button>
                </div>

                {llmMessage ? <p className="mt-4 text-[11px] leading-relaxed text-[var(--city-primary)]" role="status">{llmMessage}</p> : null}
                {llmTest ? (
                  <div className="mt-4 rounded-sm border p-3 text-[11px] leading-relaxed hairline" role="status">
                    <p className="mono text-[10px] tracking-[0.12em]">
                      {llmTest.ok ? '连接成功' : '连接失败'} · HTTP {llmTest.status} · {llmTest.latencyMs}ms · {llmTest.model}
                    </p>
                    <p className="mt-1 text-[var(--text-secondary)]">{llmTest.message}</p>
                  </div>
                ) : null}
              </div>
            </AdminSection>

            <AdminSection
              id="admin-map"
              index="02"
              title="天地图服务"
              description="浏览器端 Key 用于前端瓦片，服务端 Key 只用于服务端地名检索。保存后刷新城市页生效。"
              aside={<span className="mono text-[10px] text-[var(--text-secondary)]">{overview.map.source === 'runtime' ? '运行时配置' : '.env 默认'}</span>}
            >
              <div className="surface-card rounded-md p-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className={LABEL}>浏览器端 Key</span>
                    <input
                      type="password"
                      value={mapForm.browserKey}
                      onChange={(event) => setMapForm((current) => ({ ...current, browserKey: event.target.value }))}
                      placeholder={overview.map.hasBrowserKey ? `已保存：${overview.map.browserKeyMasked}` : '粘贴浏览器端 Key'}
                      className={FIELD}
                      autoComplete="new-password"
                    />
                    <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-secondary)]">
                      会通过 /api/map/config 下发给前端，仅用于瓦片请求；请在天地图控制台配置域名白名单。
                    </span>
                  </label>
                  <label className="block">
                    <span className={LABEL}>服务端 Key</span>
                    <input
                      type="password"
                      value={mapForm.serverKey}
                      onChange={(event) => setMapForm((current) => ({ ...current, serverKey: event.target.value }))}
                      placeholder={overview.map.hasServerKey ? `已保存：${overview.map.serverKeyMasked}` : '粘贴服务端 Key（可选）'}
                      className={FIELD}
                      autoComplete="new-password"
                    />
                    <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-secondary)]">
                      只留在服务端，用于地名检索；未填写时回退使用浏览器端 Key。
                    </span>
                  </label>
                </div>

                <label className="mt-5 flex items-start gap-3 rounded-sm border p-3 text-[11px] hairline">
                  <input
                    type="checkbox"
                    checked={mapForm.enabled}
                    onChange={(event) => setMapForm((current) => ({ ...current, enabled: event.target.checked }))}
                    className="mt-0.5 accent-[var(--city-primary)]"
                  />
                  <span>
                    启用天地图底图
                    <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-secondary)]">
                      关闭后前端进入无底图模式，只绘制行政区轮廓。
                    </span>
                  </span>
                </label>

                <div className="mt-6 flex flex-wrap items-center gap-2">
                  <button type="button" className="ink-btn ink-btn--solid px-4 py-2 text-[11px]" onClick={() => void saveMap()} disabled={savingMap}>
                    {savingMap ? '保存中…' : '保存配置'}
                  </button>
                  <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={() => void testMap()} disabled={testingMap}>
                    {testingMap ? '测试中…' : '测试服务端 Key'}
                  </button>
                  <button type="button" className="ink-btn px-4 py-2 text-[11px]" onClick={() => void resetMap()}>
                    恢复 .env 默认
                  </button>
                  <a href="https://console.tianditu.gov.cn/" target="_blank" rel="noreferrer" className="ink-link text-[10px] text-[var(--text-secondary)]">
                    天地图控制台 ↗
                  </a>
                </div>

                {mapMessage ? <p className="mt-4 text-[11px] leading-relaxed text-[var(--city-primary)]" role="status">{mapMessage}</p> : null}
                {mapTest ? (
                  <div className="mt-4 rounded-sm border p-3 text-[11px] leading-relaxed hairline" role="status">
                    <p className="mono text-[10px] tracking-[0.12em]">
                      {mapTest.ok ? '服务端 Key 可用' : '服务端 Key 测试失败'} · HTTP {mapTest.status} · {mapTest.latencyMs}ms · {mapTest.count} 条
                    </p>
                    <p className="mt-1 text-[var(--text-secondary)]">{mapTest.message}</p>
                  </div>
                ) : null}
              </div>
            </AdminSection>

            <AdminSection
              id="admin-data"
              index="03"
              title="数据产物与安全"
              description="构建期抓取的数据产物状态，以及当前管理接口的访问方式。产物刷新请运行 npm run data:refresh。"
            >
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {overview.artifacts.map((artifact) => (
                  <div key={artifact.key} className="surface-card rounded-md p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-serif text-sm tracking-[0.08em]">{artifact.label}</p>
                      <StatusDot tone={artifact.status === 'ready' ? 'ok' : 'warn'} />
                    </div>
                    <p className="mono mt-2 text-lg">
                      {artifact.count === null ? '—' : artifact.count.toLocaleString('zh-CN')}
                    </p>
                    <p className="mt-1 text-[10px] text-[var(--text-secondary)]">{artifact.note}</p>
                    <p className="mono mt-2 text-[9px] text-[var(--text-secondary)]">{when(artifact.updatedAt)}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="surface-card rounded-md p-5">
                  <p className="eyebrow">免 Key 数据服务</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
                    {['Wikidata', 'chinese-poetry', 'Wikimedia Commons', 'DataV.GeoAtlas（授权待确认）', '国家文物局（人工导入）'].map((item) => (
                      <span key={item} className="border px-2 py-1 hairline">{item}</span>
                    ))}
                  </div>
                  <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-secondary)]">
                    Wikidata 与诗词源文件均有本地缓存；Commons 图片已下载到本地；构建期 Key（如 GITHUB_TOKEN）仍需写入 .env。
                  </p>
                </div>
                <div className="surface-card rounded-md p-5">
                  <p className="eyebrow">管理安全</p>
                  <dl className="mt-3 space-y-2 text-[11px]">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-[var(--text-secondary)]">访问模式</dt>
                      <dd className="mono">{overview.security.adminAccess === 'token' ? 'ADMIN_TOKEN' : '仅本机回环'}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-[var(--text-secondary)]">ADMIN_TOKEN</dt>
                      <dd className="mono">{overview.security.adminTokenConfigured ? '已配置' : '未配置'}</dd>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <dt className="text-[var(--text-secondary)]">允许来源</dt>
                      <dd className="mono text-right">
                        {overview.security.allowedOrigins.length > 0 ? overview.security.allowedOrigins.join('、') : '开发环境 localhost'}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 border-t pt-3 text-[10px] leading-relaxed text-[var(--text-secondary)] hairline">
                    大模型与天地图 Key 以明文存放在本地 SQLite（已被 gitignore）；公网部署必须设置 ADMIN_TOKEN，
                    并建议通过反向代理限制 /admin 与 /api/admin 的访问。
                  </p>
                </div>
              </div>
            </AdminSection>
          </div>
        )}
      </div>
    </main>
  );
}
