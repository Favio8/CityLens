#!/usr/bin/env node
/**
 * e2e/regression.mjs —— 可执行的浏览器回归（零新增依赖，基于 Chrome DevTools Protocol）。
 *
 * 覆盖路径：搜索直达、缓存城市、失败重试（单卷）、快速切城、双城对比、分享海报。
 * 完全离线可重复：自建临时 SQLite + 模拟 LLM + 预置档案；不依赖真实密钥与外网缓存
 * （测试城市的侦察缓存缺失时写入一次性 stub，结束后清理）。
 *
 * 用法：
 *   node e2e/regression.mjs            # 完整跑一遍（自起服务端与 Chrome）
 *   E2E_KEEP=1 node e2e/regression.mjs # 保留服务端/Chrome 便于调试
 *   E2E_BASE_URL=http://127.0.0.1:8788 node e2e/regression.mjs  # 复用已启动的生产服务端
 *
 * 环境变量：E2E_PORT（默认 8799）、E2E_CDP_PORT（默认 9222）、E2E_CITY（默认 CN-321100 镇江）、
 *           E2E_CHROME（Chrome/Edge 可执行文件路径）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const PORT = Number(process.env.E2E_PORT ?? 8799);
const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9222);
const KEEP = process.env.E2E_KEEP === '1';
const TEST_CITY = process.env.E2E_CITY ?? 'CN-321100';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[e2e] ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
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
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params ?? {}, message.sessionId);
        }
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
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
    this.ws.close();
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
/** 本次创建的一次性侦察 stub 路径（结束后删除）；复用已有缓存时为 null。 */
let stubReconPath = null;

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
  tmp = mkdtempSync(resolve(tmpdir(), 'citylens-e2e-'));
  const dbPath = resolve(tmp, 'citylens.db');
  const env = {
    ...process.env,
    DB_PATH: dbPath,
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
  console.log('[e2e] 初始化临时数据库（seed + 预置档案 + 测试城市 partial 档案）…');
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

  // 测试城市的侦察缓存：存在则复用；缺失则写入一次性 stub（结束后清理）。
  const reconPath = resolve(ROOT, 'server/data/recon', `${TEST_CITY}.json`);
  if (existsSync(reconPath)) {
    console.log(`[e2e] 复用已有侦察缓存 ${TEST_CITY}`);
  } else {
    mkdirSync(dirname(reconPath), { recursive: true });
    const stub = {
      version: 1,
      cityId: TEST_CITY,
      cityName: 'e2e-test-city',
      generatedAt: new Date().toISOString(),
      wikipedia: null,
      wikidata: null,
      searches: [],
      stats: { gdp: null, pop: null, attempts: [] },
      climate: null,
      sources: [],
    };
    writeFileSync(reconPath, `${JSON.stringify(stub, null, 2)}\n`, 'utf8');
    stubReconPath = reconPath;
    console.log(`[e2e] 已写入一次性侦察 stub ${TEST_CITY}（离线可重复）`);
  }

  if (!process.env.E2E_BASE_URL) {
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
  }
  await waitForHealth();
  console.log(`[e2e] 服务端就绪 ${BASE}`);
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
  await goto(`${BASE}/city/CN-610100`);
  const reused = await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '缓存命中标记',
  );
  const moduleCount = await cdp.evaluate(
    `document.querySelectorAll('section[id]').length`,
  );
  const identityOk = await cdp.evaluate(
    `document.querySelector('#identity')?.textContent?.includes('城市名片')`,
  );
  check('缓存命中展示「已为你复用」', Boolean(reused));
  check('八卷 + 行旅工具分区齐全', moduleCount >= 10, `sections=${moduleCount}`);
  check('身份卷渲染城市名片', Boolean(identityOk));
}

async function scenarioFailureRetry() {
  console.log('[e2e] 场景 3：失败重试（SIMULATE_FAIL=chronicle，force 重生成）');
  await goto(`${BASE}/city/${TEST_CITY}`);
  // 预置档案：缓存命中。
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '测试城市缓存命中',
  );
  // 触发 force 重生成（非预置城市，无需令牌；有确认弹窗）。
  await clickByText('button', '重新生成');
  await clickByText('button', '确认重读');
  // 等待流式结束：失败卷出现重试入口。
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
  // 其他卷不受影响：identity 分区有内容（保留旧内容或新生成）。
  const identityRendered = await cdp.evaluate(
    `(() => {
       const section = document.querySelector('#identity');
       return Boolean(section && section.textContent && section.textContent.length > 40);
     })()`,
  );
  check('单模块失败不影响其他卷', Boolean(identityRendered));
  // 档案未下架：页面仍可读（无冷却屏）。
  const noCooldown = await cdp.evaluate(
    `!document.body.innerText.includes('此城刚刚起卷')`,
  );
  check('重生成失败后档案未下架', Boolean(noCooldown));
  // 点击重试：仍然失败（SIMULATE_FAIL 未撤），页面不白屏。
  await clickByText('button', '重试此卷');
  await sleep(1500);
  const stillThere = await cdp.evaluate(
    `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('重试此卷')) || document.body.innerText.includes('此卷未能成卷')`,
  );
  const bodyHasContent = await cdp.evaluate(`document.body.innerText.length > 200`);
  check('重试后错误态稳定（无白屏）', Boolean(stillThere && bodyHasContent));
}

async function scenarioCitySwitch() {
  console.log('[e2e] 场景 4：快速切城（A→B→A）');
  await goto(`${BASE}/city/CN-610100`);
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '西安就绪',
  );
  await goto(`${BASE}/city/CN-330100`);
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '杭州就绪',
  );
  const hangzhou = await cdp.evaluate(
    `document.body.innerText.includes('杭州') && !document.body.innerText.includes('西安')`,
  );
  check('切到杭州后展示杭州且无西安残留', Boolean(hangzhou));
  await goto(`${BASE}/city/CN-610100`);
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '回到西安',
  );
  const back = await cdp.evaluate(`document.body.innerText.includes('西安')`);
  check('A→B→A 后回到西安档案', Boolean(back));
}

async function scenarioCompare() {
  console.log('[e2e] 场景 5：双城对比');
  await goto(`${BASE}/compare?cities=CN-610100,CN-330100`);
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

async function scenarioPoster() {
  console.log('[e2e] 场景 6：分享海报');
  await goto(`${BASE}/city/CN-610100`);
  await waitFor(
    async () => cdp.evaluate(`document.body.innerText.includes('已为你复用')`),
    20_000,
    250,
    '西安就绪',
  );
  await clickByText('button', '分享此卷');
  await clickByText('button', '生成海报');
  const poster = await waitFor(
    async () =>
      cdp.evaluate(
        `(() => {
           const canvas = document.querySelector('canvas');
           const img = document.querySelector('img[alt*="海报"], img[src^="blob:"], img[src^="data:"]');
           return Boolean(canvas || img);
         })()`,
      ),
    25_000,
    300,
    '海报预览',
  );
  check('海报预览生成（canvas/图片）', Boolean(poster));
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
  } finally {
    cdp?.close();
    if (chrome && !KEEP) chrome.kill();
    if (server && !KEEP) {
      server.kill();
      // 等待进程退出，释放临时数据库文件句柄后再清理。
      await Promise.race([
        new Promise((r) => server.once('exit', r)),
        sleep(3000),
      ]);
    }
    // 清理一次性侦察 stub（仅删除本次创建的文件，已有缓存不动）。
    if (stubReconPath && existsSync(stubReconPath)) {
      rmSync(stubReconPath, { force: true });
      console.log('[e2e] 已清理一次性侦察 stub');
    }
    if (tmp && !KEEP) {
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {
        console.warn(`[e2e] 临时目录清理失败（可手动删除）：${tmp}`);
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log('');
  console.log(`[e2e] 结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`[e2e] 失败：${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main();
