#!/usr/bin/env node
/**
 * e2e/regression.mjs —— 可执行的浏览器回归（零新增依赖，基于 Chrome DevTools Protocol）。
 *
 * 覆盖路径：搜索直达、缓存城市、失败重试（单卷）、应用内切城竞态、双城对比、分享海报。
 *
 * 隔离与安全：
 * - 数据库（DB_PATH）与全部运行期缓存（CITYLENS_RUNTIME_DIR：侦察/检索/气候/用量/按需快照）
 *   都放在系统临时目录，绝不读写用户现有缓存或真实数据库；
 * - 模拟 LLM + 无密钥 + 预置档案，测试城市缺失侦察缓存时写入临时目录内的一次性 stub；
 * - 写型场景（重新生成/重试）只对自建隔离服务端执行；E2E_BASE_URL 指向外部服务时
 *   这些场景显式 SKIP，绝不对外部服务发起写操作；
 * - 未模拟的外部依赖：实时天气（Open-Meteo current）。它失败时前端回退气候基线，
 *   不影响任何断言；此处如实标记，不宣称完全离线。
 *
 * 用法：
 *   node e2e/regression.mjs              # 完整跑一遍（自起服务端与 Chrome）
 *   E2E_KEEP=1 node e2e/regression.mjs   # 保留服务端/Chrome 便于调试
 *   E2E_BASE_URL=http://127.0.0.1:8788 node e2e/regression.mjs  # 复用已启动服务端（只读场景）
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const PORT = Number(process.env.E2E_PORT ?? 8799);
const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const EXTERNAL_BASE = Boolean(process.env.E2E_BASE_URL);
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9222);
const KEEP = process.env.E2E_KEEP === '1';
const TEST_CITY = process.env.E2E_CITY ?? 'CN-321100';
/** 切城竞态的旧城市：非预置、有预置档案（E2E_CITY2），避免预置刷新保护干扰。 */
const OLD_CITY = process.env.E2E_CITY2 ?? 'CN-320100';
const NEW_CITY = 'CN-330100'; // 杭州（预置，缓存命中）
const PRESET_CITY = 'CN-610100'; // 西安（预置，缓存命中）

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[e2e] ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true, detail: reason });
  console.log(`[e2e] SKIP ${name} — ${reason}`);
}

/** 结束进程树（Windows 上 tsx 会派生子进程，只杀 CLI 会遗留持有数据库的子进程）。 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      return;
    } catch {
      // 回退到 kill()
    }
  }
  child.kill();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* Chrome 定位                                                                */
/* -------------------------------------------------------------------------- */

const CHROME_CANDIDATES = [
  process.env.E2E_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 最小 CDP 客户端                                                            */
/* -------------------------------------------------------------------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.listeners = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.consoleErrors.push(
          (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '),
        );
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(
          message.params?.exceptionDetails?.text ?? 'page exception',
        );
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message.sessionId);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      ws.addEventListener('open', resolvePromise, { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP 连接失败：${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  async send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 30_000);
    });
  }

  /** 在页面中执行表达式并返回 JSON 值。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面执行失败：${result.exceptionDetails.text ?? 'unknown'}`);
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 已关闭
    }
  }
}

async function waitFor(fn, timeoutMs = 30_000, intervalMs = 250, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

/* -------------------------------------------------------------------------- */
/* 环境准备                                                                   */
/* -------------------------------------------------------------------------- */

let server = null;
let chrome = null;
let cdp = null;
let tmp = null;

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务端未就绪
    }
    if (Date.now() > deadline) throw new Error('服务端健康检查超时');
    await sleep(250);
  }
}

async function setupEnvironment() {
  if (EXTERNAL_BASE) {
    // 复用外部服务端：不建库、不写任何缓存；写型场景稍后显式 SKIP。
    await waitForHealth();
    console.log(`[e2e] 复用外部服务端 ${BASE}（不写入；写型场景将 SKIP）`);
    return;
  }
  tmp = mkdtempSync(resolve(tmpdir(), 'citylens-e2e-'));
  const runtimeDir = resolve(tmp, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const env = {
    ...process.env,
    DB_PATH: resolve(tmp, 'citylens.db'),
    CITYLENS_RUNTIME_DIR: runtimeDir,
    NODE_ENV: 'production',
    MOCK_LLM: 'true',
    MOCK_LLM_DELAY_MS: '0',
    SIMULATE_FAIL: 'chronicle',
    ENABLE_IMAGES: 'false',
    LLM_API_KEY: '',
    TAVILY_API_KEY: '',
    TIANDITU_KEY: '',
    TIANDITU_SERVER_KEY: '',
  };
  console.log('[e2e] 初始化临时数据库与运行期缓存（seed + 预置档案 + 测试城市 partial 档案）…');
  execFileSync(process.execPath, [TSX, 'server/db/seed.ts'], { cwd: ROOT, env, stdio: 'inherit' });
  execFileSync(process.execPath, [TSX, 'scripts/build_preset_archives.ts'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  // Mock LLM 下 chronicle/localSoul/dataPulse 永远 NO_FACTS，新城市无法达到发布门槛；
  // 预置一份 partial 档案，即可回归「已发布档案的失败重试」路径。
  execFileSync(process.execPath, [TSX, 'e2e/seed-partial-archive.ts'], {
    cwd: ROOT,
    env: { ...env, E2E_CITY: TEST_CITY },
    stdio: 'inherit',
  });

  // 测试城市的侦察 stub 写在临时运行期目录内，绝不触碰项目目录。
  for (const cityId of [TEST_CITY, OLD_CITY]) {
    const reconPath = resolve(runtimeDir, 'recon', `${cityId}.json`);
    mkdirSync(dirname(reconPath), { recursive: true });
    writeFileSync(
      reconPath,
      `${JSON.stringify(
        {
          version: 1,
          cityId,
          cityName: 'e2e-test-city',
          generatedAt: new Date().toISOString(),
          wikipedia: null,
          wikidata: null,
          searches: [],
          stats: { gdp: null, pop: null, attempts: [] },
          climate: null,
          sources: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  console.log(`[e2e] 已写入临时侦察 stub ${TEST_CITY} / ${OLD_CITY}（位于临时运行期目录）`);

  console.log(`[e2e] 启动生产服务端 :${PORT} …`);
  server = spawn(process.execPath, [TSX, 'server/index.ts'], {
    cwd: ROOT,
    env: {
      ...env,
      PORT: String(PORT),
      APP_ORIGINS: `http://127.0.0.1:${PORT},http://localhost:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  await waitForHealth();
  console.log(`[e2e] 服务端就绪 ${BASE}（临时库 + 隔离运行期缓存）`);
}

async function setupBrowser() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('未找到 Chrome/Edge；请设置 E2E_CHROME');
  console.log(`[e2e] 启动浏览器 ${chromePath}`);
  chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    'about:blank',
  ]);
  const version = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) return response.json();
      return null;
    } catch {
      return null;
    }
  }, 15_000, 250, 'CDP 端点');
  cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.sessionId = attached.sessionId;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
}

async function goto(url) {
  const loaded = new Promise((resolvePromise) => {
    cdp.on('Page.loadEventFired', () => resolvePromise());
  });
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(10_000)]);
  await sleep(150);
}

async function clickByText(selector, text, timeoutMs = 10_000) {
  await waitFor(
    async () =>
      cdp.evaluate(
        `(() => {
           const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
           const target = nodes.find((node) => (node.textContent ?? '').includes(${JSON.stringify(text)}));
           if (!target) return false;
           target.click();
           return true;
         })()`,
      ),
    timeoutMs,
    200,
    `点击「${text}」`,
  );
}

async function clickSelector(selector, timeoutMs = 10_000) {
  await waitFor(
    async () =>
      cdp.evaluate(
        `(() => {
           const target = document.querySelector(${JSON.stringify(selector)});
           if (!target) return false;
           target.click();
           return true;
         })()`,
      ),
    timeoutMs,
    200,
    `点击 ${selector}`,
  );
}

async function typeInto(selector, text) {
  await waitFor(
    async () =>
      cdp.evaluate(
        `(() => {
           const target = document.querySelector(${JSON.stringify(selector)});
           if (!target) return false;
           target.focus();
           return true;
         })()`,
      ),
    10_000,
    200,
    `聚焦 ${selector}`,
  );
  await cdp.send('Input.insertText', { text });
}

async function pressEnter(selector) {
  await cdp.evaluate(
    `(() => {
       const target = document.querySelector(${JSON.stringify(selector)});
       target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     })()`,
  );
}

/* -------------------------------------------------------------------------- */
/* 场景                                                                       */
/* -------------------------------------------------------------------------- */

async function scenarioSearch() {
  console.log('[e2e] 场景 1：搜索直达');
  await goto(`${BASE}/`);
  await clickSelector('button[aria-label="搜索城市（Ctrl+K）"]');
  await typeInto('input[aria-label="城市名、古称、拼音或英文"]', '长安');
  await pressEnter('input[aria-label="城市名、古称、拼音或英文"]');
  await waitFor(async () => cdp.evaluate(`location.pathname.startsWith('/city/')`), 15_000, 250, '跳转城市页');
  const city = await cdp.evaluate(`document.body.innerText.includes('西安')`);
  check('搜索「长安」直达西安城市页', Boolean(city), await cdp.evaluate(`location.pathname`));
}

async function scenarioCachedCity() {
  console.log('[e2e] 场景 2：缓存城市（预置西安）');
  // 场景 2/6 使用预置西安；场景 4 的旧城市为非预置的 OLD_CITY（有预置档案）。
  await goto(`${BASE}/city/${PRESET_CITY}`);
  const reused = await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '缓存命中标记',
  );
  const moduleCount = await cdp.evaluate(`document.querySelectorAll('section[id]').length`);
  const identityOk = await cdp.evaluate(
    `document.querySelector('#identity')?.textContent?.includes('城市名片')`,
  );
  check('缓存命中展示「已为你复用」', Boolean(reused));
  check('八卷 + 行旅工具分区齐全', moduleCount >= 10, `sections=${moduleCount}`);
  check('身份卷渲染城市名片', Boolean(identityOk));
}

async function scenarioFailureRetry() {
  console.log('[e2e] 场景 3：失败重试（SIMULATE_FAIL=chronicle，force 重生成）');
  if (EXTERNAL_BASE) {
    skip('失败重试（写型场景）', 'E2E_BASE_URL 指向外部服务，禁止写操作');
    return;
  }
  await goto(`${BASE}/city/${TEST_CITY}`);
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '测试城市缓存命中',
  );
  await clickByText('button', '重新生成');
  await clickByText('button', '确认重读');
  await waitFor(
    async () =>
      cdp.evaluate(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('重试此卷'))`,
      ),
    60_000,
    300,
    '失败卷重试入口',
  );
  const retryCount = await cdp.evaluate(
    `[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('重试此卷')).length`,
  );
  check('失败卷展示重试入口', retryCount > 0, `retry buttons=${retryCount}`);
  const identityRendered = await cdp.evaluate(
    `(() => {
       const section = document.querySelector('#identity');
       return Boolean(section && section.textContent && section.textContent.length > 40);
     })()`,
  );
  check('单模块失败不影响其他卷', Boolean(identityRendered));
  const noCooldown = await cdp.evaluate(`!document.body.innerText.includes('此城刚刚起卷')`);
  check('重生成失败后档案未下架', Boolean(noCooldown));
  await clickByText('button', '重试此卷');
  await sleep(1500);
  const stillThere = await cdp.evaluate(
    `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('重试此卷')) || document.body.innerText.includes('此卷未能成卷')`,
  );
  const bodyHasContent = await cdp.evaluate(`document.body.innerText.length > 200`);
  check('重试后错误态稳定（无白屏）', Boolean(stillThere && bodyHasContent));
}

/**
 * 场景 4：应用内切城竞态。
 * 在旧城市（非预置、有预置档案）页触发一次 generate 请求并延迟其响应，
 * 然后在响应落地前通过应用内导航切到杭州；验证迟到响应不覆盖新城市、
 * 且没有发生整页刷新。
 */
async function scenarioCitySwitch() {
  console.log('[e2e] 场景 4：应用内切城竞态（延迟旧城市响应）');
  const oldArchive = await (await fetch(`${BASE}/api/cities/${OLD_CITY}`)).json();
  const oldName = oldArchive.meta.standardName;
  await goto(`${BASE}/city/${OLD_CITY}`);
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '旧城市就绪',
  );

  // 注入 fetch 延迟：仅延迟旧城市的接口请求，模拟迟到响应。
  await cdp.evaluate(
    `(() => {
       if (window.__e2ePatched) return true;
       window.__e2ePatched = true;
       window.__e2eSpaMarker = true;
       window.__e2eDelayed = [];
       const original = window.fetch.bind(window);
       window.fetch = (input, init) => {
         const url = typeof input === 'string' ? input : (input && input.url) || '';
         if (url.includes('/api/cities/${OLD_CITY}')) {
           window.__e2eDelayed.push(url);
           return new Promise((resolvePromise) => {
             setTimeout(() => resolvePromise(original(input, init)), 3000);
           });
         }
         return original(input, init);
       };
       return true;
     })()`,
  );

  // 在旧城市页触发一次会被延迟的 generate 请求（非预置城市，无需令牌）。
  await clickByText('button', '重新生成');
  await clickByText('button', '确认重读');
  await waitFor(
    async () => cdp.evaluate(`(window.__e2eDelayed || []).length > 0`),
    10_000,
    150,
    '旧城市在途请求',
  );
  const inFlight = await cdp.evaluate(`(window.__e2eDelayed || []).length`);
  check('旧城市请求已在途（可制造迟到响应）', inFlight > 0, `delayed=${inFlight}`);

  // 应用内导航切到杭州（不刷新页面）。
  await clickSelector('button[aria-label="搜索城市（Ctrl+K）"]');
  await typeInto('input[aria-label="城市名、古称、拼音或英文"]', '杭州');
  await pressEnter('input[aria-label="城市名、古称、拼音或英文"]');
  await waitFor(
    async () =>
      cdp.evaluate(
        `location.pathname === '/city/${NEW_CITY}' && document.body.innerText.includes('已为你复用')`,
      ),
    20_000,
    250,
    '杭州就绪（SPA 内导航）',
  );
  const afterSwitch = await cdp.evaluate(
    `(() => ({
       path: location.pathname,
       spaMarker: window.__e2eSpaMarker === true,
       hasHangzhou: document.body.innerText.includes('杭州'),
       hasOldCity: document.body.innerText.includes(${JSON.stringify(oldName)}),
       hasOldPersona: document.body.innerText.includes('一座用于回归测试的'),
     }))()`,
  );
  check(
    '切城后展示杭州且无旧城市残留',
    afterSwitch.path === `/city/${NEW_CITY}` &&
      afterSwitch.hasHangzhou &&
      !afterSwitch.hasOldCity &&
      !afterSwitch.hasOldPersona,
    JSON.stringify(afterSwitch),
  );
  check('切换未经整页刷新（SPA 标记存活）', afterSwitch.spaMarker === true);

  // 等迟到响应落地：新城市内容不得被覆盖。
  await sleep(4000);
  const afterLate = await cdp.evaluate(
    `(() => ({
       path: location.pathname,
       spaMarker: window.__e2eSpaMarker === true,
       hasHangzhou: document.body.innerText.includes('杭州'),
       hasOldCity: document.body.innerText.includes(${JSON.stringify(oldName)}),
       hasOldPersona: document.body.innerText.includes('一座用于回归测试的'),
       sections: document.querySelectorAll('section[id]').length,
     }))()`,
  );
  check(
    '迟到响应不覆盖新城市（仍为杭州、无刷新）',
    afterLate.path === `/city/${NEW_CITY}` &&
      afterLate.hasHangzhou &&
      !afterLate.hasOldCity &&
      !afterLate.hasOldPersona &&
      afterLate.spaMarker === true &&
      afterLate.sections >= 10,
    JSON.stringify(afterLate),
  );
}

async function scenarioCompare() {
  console.log('[e2e] 场景 5：双城对比（预置双城，含真实统计）');
  await goto(`${BASE}/compare?cities=${PRESET_CITY},${NEW_CITY}`);
  const both = await waitFor(
    async () =>
      cdp.evaluate(
        `(() => {
           const text = document.body.innerText;
           return text.includes('西安') && text.includes('杭州') && text.includes('地区生产总值');
         })()`,
      ),
    20_000,
    250,
    '对比渲染',
  );
  check('对比页双城 + 经济指标渲染', Boolean(both));
}

/** 分享弹窗内的海报预览 img（限定范围，避免误命中背景水墨 canvas）。 */
const POSTER_IMG_SELECTOR = '[role="dialog"] img[alt$="城市海报预览"]';

async function posterPreviewReady() {
  return cdp.evaluate(
    `(() => {
       const img = document.querySelector(${JSON.stringify(POSTER_IMG_SELECTOR)});
       if (!img) return { ready: false, reason: 'no-img' };
       if (!img.complete || img.naturalWidth === 0) return { ready: false, reason: 'decoding' };
       return { ready: true, width: img.naturalWidth, height: img.naturalHeight };
     })()`,
  );
}

async function scenarioPoster() {
  console.log('[e2e] 场景 6：分享海报');
  await goto(`${BASE}/city/${PRESET_CITY}`);
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '西安就绪',
  );
  await clickByText('button', '分享此卷');
  await clickByText('button', '生成海报');

  // 失败注入：先破坏 canvas 渲染，证明断言不会「蒙混通过」。
  await cdp.evaluate(
    `(() => { HTMLCanvasElement.prototype.getContext = () => null; return true; })()`,
  );
  const broken = await waitFor(
    async () => {
      const state = await posterPreviewReady();
      if (state.ready) return state;
      const failed = await cdp.evaluate(
        `document.body.innerText.includes('海报生成失败')`,
      );
      return failed ? { ready: false, reason: 'failure-shown' } : null;
    },
    15_000,
    250,
    '海报失败态',
  );
  check(
    '海报失败注入被检测（断言有牙，不会被背景 canvas 蒙混）',
    broken?.ready === false && broken?.reason === 'failure-shown',
    JSON.stringify(broken),
  );

  // 恢复正常渲染，验证真实预览与导出。
  await clickByText('button', '返回');
  await cdp.evaluate(
    `(() => { location.reload(); return true; })()`,
  );
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '西安重新就绪',
  );
  await clickByText('button', '分享此卷');
  await clickByText('button', '生成海报');
  const preview = await waitFor(
    async () => {
      const state = await posterPreviewReady();
      return state.ready ? state : null;
    },
    25_000,
    300,
    '海报预览解码',
  );
  check(
    '海报预览为弹窗内 750×1334 图片',
    preview?.width === 750 && preview?.height === 1334,
    JSON.stringify(preview),
  );

  // 导出 PNG：捕获 createObjectURL 的 Blob，验证类型与体积。
  await cdp.evaluate(
    `(() => {
       window.__e2ePosterBlob = null;
       const original = URL.createObjectURL.bind(URL);
       URL.createObjectURL = (object) => {
         window.__e2ePosterBlob = { type: object.type, size: object.size };
         return original(object);
       };
       return true;
     })()`,
  );
  await clickByText('button', '下载 PNG');
  await sleep(1200);
  const blob = await cdp.evaluate(`window.__e2ePosterBlob`);
  check(
    '导出 PNG（image/png 且体积合理）',
    blob?.type === 'image/png' && blob?.size > 10_000,
    JSON.stringify(blob),
  );
  await clickSelector('button[aria-label="关闭分享"]').catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  try {
    await setupEnvironment();
    await setupBrowser();
    await scenarioSearch();
    await scenarioCachedCity();
    await scenarioFailureRetry();
    await scenarioCitySwitch();
    await scenarioCompare();
    await scenarioPoster();
  } catch (error) {
    check('e2e 执行异常', false, error.message);
    if (cdp) {
      const errors = cdp.consoleErrors.slice(0, 10);
      if (errors.length > 0) {
        console.log('[e2e] 页面错误（诊断）：');
        for (const item of errors) console.log(`[e2e]   ${item}`);
      }
    }
  } finally {
    cdp?.close();
    if (chrome && !KEEP) {
      killTree(chrome);
      // 等待浏览器退出，避免占用临时目录导致清理失败。
      await Promise.race([
        new Promise((r) => chrome.once('exit', r)),
        sleep(3000),
      ]);
    }
    if (server && !KEEP) {
      killTree(server);
      // 等待进程退出，释放临时数据库文件句柄后再清理。
      await Promise.race([
        new Promise((r) => server.once('exit', r)),
        sleep(3000),
      ]);
    }
    if (tmp && !KEEP) {
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
      } catch {
        console.warn(`[e2e] 临时目录清理失败（可手动删除）：${tmp}`);
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  const skipped = results.filter((item) => item.skipped);
  console.log('');
  console.log(
    `[e2e] 结果：${results.length - failed.length - skipped.length}/${results.length - skipped.length} 通过` +
      (skipped.length > 0 ? `，${skipped.length} 项 SKIP` : ''),
  );
  if (failed.length > 0) {
    for (const item of failed) {
      console.log(`[e2e] 失败：${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    }
    process.exitCode = 1;
  }
}

main();
