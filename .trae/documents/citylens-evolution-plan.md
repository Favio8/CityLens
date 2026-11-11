# CityLens 读城 · 继续演进实施计划（P0 → P1 → P2）

> 版本：v1（2026-11-11）｜模式：Plan｜执行前提：用户已确认三件事——① 现在提供官方 LLM Key（DeepSeek 或 StepFun）；② 无 Key 分支保持现状（线上全程配置 Key，PRD 偏离写入文档）；③ 浏览器实测用 ego-browser（ego lite），不装 Playwright。

---

## 1. 当前基线（已勘察确认，非假设）

- **工程**：npm workspaces（shared / server / client）；Node v24.15.0；Fastify 5 + better-sqlite3 + React 18 + Vite 5 + MapLibre 6 + ECharts 6；`shared/schema.ts`（Zod）为唯一契约。
- **档案**：6 预置城 × 8 卷 = 48 卷（DB 中 6 城 status=partial）；非预置走「先侦察（cityRecon）、再生成、后缓存（recon 30 天 / fact_snapshot 落盘 / search_cache 7 天）」。
- **测试/校验**：120 项测试 / 16 文件；`npm run verify` 6/6 通过；`npm run typecheck`、`npm run build` 可用。
- **AC 状态**：13 通过、5 部分通过（AC-04/08/10/14/18）、1 未测（AC-16）。
- **DB 实况（只读查询）**：21 份非预置档案中 partial 10、unpublished 11（上海 CN-310000、广州 CN-440100、重庆 CN-500000、武汉 CN-420100、长沙 CN-430100、郑州 CN-410100、济南 CN-370100、绍兴 CN-330600、福州 CN-350100、泉州 CN-350500、无锡 CN-320200）；city_modules：degraded 86 / failed 72 / ok 10。
- **.env（只列键名）**：ENABLE_IMAGES、ADMIN_TOKEN、TIANDITU_KEY、TIANDITU_SERVER_KEY、TAVILY_API_KEY、SEARCH_DAILY_LIMIT 已设；**无 LLM_API_KEY**（用户将提供）。
- **数据产物**：诗词库 2,595 首覆盖 137 城（205 城无诗，byCity 含 0 计数项共 337 键）；文物名录 427 件；relic_images 22/36 下载成功；stats_baseline 仅 6 预置城（成都/苏州/洛阳只有 2025，北京/杭州人口 2 点）；fact_snapshot 10 城（含 CN-320100 南京、CN-321000 扬州、CN-410500 安阳、CN-620500 天水）；recon 4 城。
- **环境**：Chrome 已安装（`C:/Program Files/Google/Chrome/Application/chrome.exe`）；无 Playwright/lighthouse 依赖；git 分支 master，约 25 个文件有未提交修改（本计划不提交、不 commit）。
- **关键代码位置**：
  - 生成编排 `server/services/jobManager.ts`（单飞/增量/冷却，无计时埋点）；路由 `server/routes/archiveRoutes.ts`、`server/routes/adminRoutes.ts`；装配 `server/index.ts`。
  - 生成器 `server/services/llmGenerator.ts`（MockGenerator / DeepSeekGenerator / DynamicGenerator；llmFigures 提示词已禁字段名但**无输出过滤**）。
  - 侦察 `server/services/cityRecon.ts`（公报逐字命中）；按需快照 `server/services/cityFactSnapshot.ts`（含维基百科「XX市人」补充，evidence.property='position'）。
  - 前端流 `client/src/hooks/useCityStream.ts`（phase: reading/not_generated/streaming_*/ready/cooldown/unavailable/not_found/error）；`client/src/pages/CityPage.tsx`（**phase==='error' 且有 meta 时无任何用户可见反馈——AC-08 冷却提示缺口**）；`client/src/components/hero/CityHero.tsx`（预置保护 + 确认弹窗 + Esc，**无焦点陷阱**）；`client/src/components/search/CitySearchModal.tsx`（**无焦点陷阱/焦点还原**）；`client/src/components/modules/ModuleRenderer.tsx`（每模块 Schema 校验后分发，重组件 lazy）。
  - 地图 `client/src/components/modules/CityMap.tsx`（聚光灯遮罩 + 示意范围；cooperativeGestures <768px；scope: landmarks/relics/figures/poetics）。
  - 预算 `server/services/rateLimiter.ts`（`sumLlmCallsSince(startOfToday)`，admin 总览可复用）；LLM 运行时配置 `server/services/llmSettings.ts`（provider: deepseek/stepfun/custom）；AdminPage 已有 DeepSeek/StepFun 预设表单。
  - 统计基线 `scripts/build_stats_baseline.ts`（SOURCES/STATS 硬编码，气候走 `scripts/.cache/climate` 本地缓存）。

---

## 2. 已确认决策（执行期不得更改）

1. **官方 LLM Key**：用户执行开始时提供（DeepSeek 或 StepFun）。写入 `.env`（`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`）或 `/admin` 运行时配置；`.env` 已被 gitignore，Key 不提交。
2. **AC-14**：线上全程配置 Key；无 Key 时「本地快照生成（degraded）」的现有行为保留，作为开发自测分支。在 `docs/PRD.md` 3.5「无 Key 行为」加 v1.1.1 注记（用户 2026-11-11 确认），FEATURES AC-14 行改为「设计取舍（用户确认）」并附三类城市实测证据。**不改造「尚未收录」状态页。**
3. **E2E/浏览器实测**：ego-browser（ego lite）技能执行，截图/日志/步骤落盘可复现；不安装 Playwright。
4. **Lighthouse**：先尝试 `npm i -D lighthouse`（根目录）；安装或运行被网络策略拦截 → AC-16 记 BLOCKED，附产物体积证据与复现命令，不得伪造分数。
5. **DataV 轮廓授权**：无法确认 → BLOCKED；同时在 `scripts/build_geo_boundaries.ts` 增加天地图源选项尝试替换，失败则保留 DataV 产物并在 manifest/README/FEATURES 三处明示未合规。

---

## 3. P0 验收闭环（8 项）

### P0-1 AC-04 官方 LLM 实测
- **用户提供 Key 后第一步**：写入 `.env`；重启 dev server；`curl /api/health` 确认 `llmConfigured:true`、`llmProvider/llmModel` 正确。
- **新增可复用官方 provider 预设与测试脚本**：
  - `scripts/test_llm_provider.ts`（新增）：读取 `LlmSettingsService` 生效配置（运行时 > .env），向 `{baseUrl}/chat/completions` 发最小请求（max_tokens=8、temperature=0），输出 `provider/baseUrl/model/status/latencyMs`，退出码 0/1；支持 `--base-url/--model/--api-key/--timeout-ms` 覆盖（Key 只从参数或 .env 读，不落盘、不打印掩码以外的内容）。
  - `package.json` 根脚本新增 `"test:llm": "tsx scripts/test_llm_provider.ts"`。
  - `/admin` 已有的 DeepSeek / StepFun 预设表单保留不动（复用）。
- **计时埋点**（只加日志，不改行为）：`server/routes/archiveRoutes.ts` 记录「请求 → 首个 SSE 事件」耗时；`server/services/jobManager.ts` 的 `run()` 内按模块 `console.log('[gen] city=… module=identity ms=…')` 与总耗时。
- **实测一座新城市 8/8 卷**：选一座当前无 fact_snapshot 的非预置城市（执行时读 `server/data/fact_snapshot/` 确认，候选如 CN-621002 敦煌 / CN-130600 保定）；POST `/api/cities/:cityId/generate`；记录：meta 事件耗时（目标 <300ms）、identity 完成时间（目标 ≤3.5s）、总耗时、`generator.model`（形如 `deepseek-chat@deepseek`）、失败重试次数（日志中重试痕迹）。结果 + 截图写入 FEATURES AC-04 行。
- **验收**：档案 8 卷落库、`meta.generator.model` 为官方模型名；若官方 Key 最终不可用 → 脚本与预设保留，AC-04 标 BLOCKED 并说明缺什么。

### P0-2 AC-16 Lighthouse
- 尝试安装：根目录 `npm i -D lighthouse`（+ `chrome-launcher` 随依赖装入；用系统 Chrome，`CHROME_PATH` 指向已安装 Chrome）。
- 流程：`npm run build` → `NODE_ENV=production npm start`（:8787，生产静态托管）或 `npm run preview`（:4173）+ `npm run dev:server`；对 `http://localhost:4173/city/CN-610100` 跑 Desktop 与 Mobile 两轮（`--only-categories=performance,seo,accessibility`，输出 JSON/HTML 至 `.lighthouse/`，加入 .gitignore）。
- 目标：Desktop Performance ≥80、Mobile ≥70；记录 Performance/SEO/Accessibility 三项分。
- **不达标则优化（按序）**：① `client/vite.config.ts` 增加 `manualChunks`（react/react-dom、maplibre-gl、echarts、framer-motion 分离）；② `InkCanvas` 首屏粒子延迟到 idle 后初始化并限制 DPR；③ 字体 `font-display:swap` + preload 检查；④ CityPage 路由内按需再拆（ChronicleModule 等）；每轮重跑 Lighthouse 记录分数曲线。
- Lighthouse 不可用 → BLOCKED 分支：保留 6.2 节产物体积证据 + 上述复现命令。

### P0-3 AC-08 重新生成浏览器实测（ego-browser）
- **先补缺口**：`client/src/pages/CityPage.tsx`：当 `state.phase==='error'` 且 `state.meta` 存在时，把 `state.fatal.message` 传入 `CityHero` 新增 `notice`（或页内横幅）展示——否则 429 REGEN_COOLDOWN 对用户不可见。`CityHero` 确认弹窗补焦点陷阱（与 P1-15 同一组件，提前实现）。
- **实测步骤**（dev 模式，ego-browser，截图存 `.screenshots/ac08/`）：
  1. 非预置已缓存城市（南京 CN-320100）：点「重新生成」→ 确认框出现 → 点「取消」→ 断言无 `/generate` 请求、页面无变化。
  2. 再次点击 → 「确认重读」→ 断言 SSE 重跑且只重跑失败/指定模块（先对一座城用 `SIMULATE_FAIL=poetics` 造失败模块，再重试观察仅 poetics 一次调用；或读服务端 `[gen]` 日志）。
  3. 5 分钟内再次点击 → 出现「同一城市 5 分钟内只能强制刷新一次」提示（429 REGEN_COOLDOWN 文案可见）。
  4. 预置城市（西安 CN-610100）：点「重新生成」→ 显示「预置馆藏受保护」。
- 结果写入 FEATURES AC-08 行（由「部分通过」升级或维持并附证据）。

### P0-4 AC-18 真实断网 / 超时
- **真实断网（服务端在线、外部全断）**：ego-browser CDP 屏蔽外部域名（`*.wikidata.org`、`*.wikipedia.org`、`api.open-meteo.com`、`api.tavily.com`、`*.tianditu.gov.cn`、`api.deepseek.com`），本地 localhost 不放行：
  1. 预置城市（西安）：页面完整可用（天地图瓦片失败属预期降级，记录现象）。
  2. 已缓存城市（南京）：完整可用、无白屏。
  3. 未缓存城市（执行时选无快照城市，如 CN-130600）：侦察失败 → 基于本地快照降级，失败卷显示「史料卷宗调取受阻」，无白屏。
- **LLM 超时**：对未缓存城市以较低 `LLM_TIMEOUT_MS`（如 10000）触发真实超时 → 断言单模块 `module_error`、其余模块正常、「重试此卷」单独重试成功；若模型响应过快未超时，用 `SIMULATE_FAIL=poetics` 复现「单模块失败 + 单独重试」路径（单测 AC-12 已覆盖，浏览器补记录）。
- 结果写入 FEATURES AC-18 行 + 日志/截图。

### P0-5 AC-14 无 Key 策略（按决策 2 执行）
- `docs/PRD.md` 3.5 表「无 Key 行为」行追加 v1.1.1 注记。
- 实测证据（有 Key 环境）：预置城市、已缓存城市、未缓存城市三类均正常；预算路径：临时 `LLM_DAILY_CALL_LIMIT=1` 重启，第二座新城市返回 503 `BUDGET_EXCEEDED`，前端有引导文案（无则补 `useCityStream.mapApiError` 文案）。
- FEATURES AC-14 行更新。

### P0-6 AC-19 干净环境复跑
- 复制仓库到 `.cleancheck/`（排除 node_modules、dist、.git、*.db、.env、.trae）；在系统默认终端（避开 PATH 超长）执行：`npm ci --no-audit --no-fund` → `npm run setup` → `npm run verify` → `npm run dev`；记录每条命令输出与耗时；页面抽查 `/` 与 `/city/CN-330100` 返回 200；删除 `.cleancheck`。结果写入 FEATURES 第 4 节。

### P0-7 数据合规
- **DataV 轮廓**：`scripts/build_geo_boundaries.ts` 增加源选项（`--source=tianditu`，用 `TIANDITU_SERVER_KEY` 调天地图边界服务，产物结构校验失败即保留旧产物并写 `failures`）；无论替换成功与否，`client/public/geo/_manifest.json`、README 免 Key 缓存节、FEATURES 6.1-10 三处保持/更新「授权与审图号未确认 → BLOCKED」表述；公开上线前必须合规审校。前端行为不变（仅预置城加载轮廓）。
- **22 张 Commons 图片**：以 `server/data/relic_images.json` × `server/data/relics_registry.json` 生成逐张核对表（文件名、credit、license、sourceUrl、对应 registryId/文物名/馆藏地），写入 FEATURES 7.2 第 16 项证据列；确认 `client/src/components/modules/RelicsModule.tsx` 已展示 credit/license/来源链接（读代码确认，缺则补）。逐张「图片是否确为该文物」的语义核对留用户签字列。
- **天地图人工检查**：ego-browser 走查（西安）：注记可读性、坐标偏移（与已知地物比对）、移动端双指手势；截图存 `.screenshots/tianditu/`；写入 7.2 第 15 项证据列，签字列留空。

### P0-8 人工复核表证据列
- `FEATURES_AND_VERIFICATION.md` 7.2：17 项全部补「证据」列（可复现命令 / 截图路径 / 日志摘要）；「记录人 / 日期 / 结论」列一律留空，不代签。7.3 勾选清单中程序可证的条目打勾并注证据，其余留空。

---

## 4. P1 数据与质量（10 项）

### P1-9 数说城市补齐
- `scripts/build_stats_baseline.ts`：SOURCES 增加成都/苏州/洛阳 2021–2024 与北京/杭州人口序列的官方公报 URL（执行时逐页抓取核对数字，只取本城公报，提取不到的年份保持 `null` 并在 caliber 注明缺口；禁止估算）。
- 运行 `npm run data:stats`（气候读本地缓存，不联网）→ `npm run data:presets` → `npm run verify`。
- 非预置城市维持「官方本城公报逐字命中」（`cityRecon.extractStatsFromText`），不改策略。

### P1-10 诗词覆盖扩展
- `scripts/build_poetry_corpus.ts`：匹配键扩充为 `city_dictionary` 标准名 + aliases（含古称/拼音匹配已有则保留）+ 区县归并名；对重点旅游城市（当前 0–3 首的：青岛、厦门、合肥、天津、大连、桂林、泉州、福州、绍兴、无锡、南通、连云港、舟山、丽水、蚌埠、马鞍山等）提高每城上限；去重/选题规则不变。
- `npm run data:poetry`（chinese-poetry 28MB 本地缓存，离线可跑）→ 校验 `stats.byCity` 覆盖与每城数量 → `npm run data:presets` → `npm run verify`。
- 红线：无诗城市保持「此卷暂缺」，禁止模型补诗。目标：342 城尽量覆盖，常见旅游城市 ≥5 首。

### P1-11 重建缓存与失败档案
- **清理通道**：`server/db/archiveRepo.ts` 增加 `deleteUnpublished()`；新增 `scripts/clean_unpublished_archives.ts`（`npm run archives:clean-unpublished`，默认 `--dry-run` 打印清单，`--apply` 才删；只删 `status='unpublished'` 且非预置的行，绝不触碰预置）。
- **重建**：用官方 Key 对 11 城逐个 `POST /api/cities/:id/generate`（force，注意 5 分钟冷却与每小时 10 城限流，分批执行）；重建后仍失败的（无 QID/无事实）用清理脚本移除。
- **安阳等 4 城快照重建**：删除 `server/data/fact_snapshot/CN-320100.json`、`CN-620500.json`、`CN-321000.json`、`CN-410500.json` 及对应 `recon/` 缓存，重新触发生成（联网），使新「维基百科 XX市人」补充与新版人物提示词生效。
- **字段名泄漏防护**：`server/services/llmGenerator.ts` 的 `llmFigures` 输出增加过滤——`cityBond`/`highlights`/`dynasty` 文本匹配 `/relationType|birthplace|deathplace|workplace|position|entityRef|sourceRefs|registryId|poemId|候选/`（大小写不敏感）即丢弃该人物并 `console.warn`；`deepseekGenerator.test.ts` 补用例（泄漏样例被丢弃、正常样例保留）。
- 验收：安阳 ≥5 位人物且无泄漏；南京/天水/扬州重新生成并记录成卷情况。

### P1-12 文物图片
- `scripts/build_relic_images.ts`：对 14 件无 P18 文物增加 Commons 搜索回退（`action=query&list=search`，File 命名空间，`srsearch=<文物名>`），仅当文件名/描述/分类命中文物名或其馆藏地时接受，记录 `match: 'p18' | 'commons_search'` 与置信度；`REFRESH_IMAGES=1 npm run data:images`；未匹配保持无图（`images` 缺省），并在 FEATURES 列明「明确无图」清单。
- 红线：不用生成图；许可证字段一律来自 Commons 元数据。

### P1-13 诗词意象补缺
- `server/services/poetryVerifier.ts`：人工词表扩充——地理词：太湖→太湖（苏州/无锡境内）、终南山→终南山（西安周至，坐标缺失置 null）、李绅组诗涉及的杭州地名（执行时按原诗文本逐字确认）；泛指词：太湖石→`isGeographic=false` 注「泛指赏石题材」；词条注明「人工词表 · 机器推导」。
- 红线不变：`word` 必须逐字出现在原文；`imageryMap` 为空的诗保持为空并说明原因。
- `poetryVerifier.test.ts` 补用例（苏州太湖石诗、杭州李绅诗、西安终南题材诗）。

### P1-14 实时天气
- `server/services/weatherService.ts`（新增）：Open-Meteo `forecast` current（`temperature_2m,weather_code,wind_speed_10m,is_day`，`timezone=Asia/Shanghai`），10 分钟内存缓存，失败返回 null，不写库。
- `shared/schema.ts`：`WeatherResponseSchema`（`{cityId, observedAt, tempC, weatherCode, weatherLabel, windKmh, source:'open-meteo', isRealtime:true}`）。
- API：`GET /api/cities/:cityId/weather`（挂在 `server/routes/archiveRoutes.ts` 或 index.ts；失败返回 502 `WEATHER_UNAVAILABLE`）。
- 前端：`client/src/lib/api.ts` `getCityWeather`；`IdentityModule` 或 `DataPulseModule` 增加「实时天气」条（显示温度/天气/风速 + 更新时间 + 来源；与「1991–2020 气候基线」明确分区标注；失败回退基线并注明非实时）。
- 测试：`server/services/weatherService.test.ts`（mock fetch：成功/失败/缓存命中）。

### P1-15 可访问性与人工视觉
- `client/src/hooks/useFocusTrap.ts`（新增：Tab 循环、Esc 关闭、关闭后焦点还原）；接入 `CitySearchModal` 与 `CityHero` 确认框。
- 键盘走查（ego-browser）：Tab/Enter/Esc 全流程、焦点可见、模态陷阱；夜间模式逐页截图（首页/城市页/后台/404）；axe 检查：尝试 `npm i -D axe-core` 后经 CDP 注入 `axe.min.js` 运行 `axe.run()` 存 JSON；装不上则人工清单走查并如实记录。
- 375 / 768 / 1280 三档复测：`scrollWidth`、文字重叠、地图不拦截垂直滚动（`cooperativeGestures` <768px 已实现，复测确认）；截图存 `.screenshots/a11y/`。
- 结果写入 FEATURES AC-10 / AC-15 行。

### P1-16 E2E 自动化记录（ego-browser）
- 新增 `e2e/README.md`：关键路径 8+2 条，每条含前置条件、步骤、断言、artifacts 路径：① 搜索→消歧（suzhou）② 流式生成（未缓存城市）③ 缓存命中（`[CACHE HIT]` + 「已为你复用」）④ 重新生成（含 P0-3）⑤ 收藏/最近浏览 ⑥ 双城对比 ⑦ 一日路线 ⑧ 小测验 ⑨ 海报导出 ⑩ 404/异常城市。
- 执行并存档 `.screenshots/e2e/<date>/`；失败项记入已知限制，不静默跳过。

### P1-17 ErrorBoundary
- `client/src/components/ui/ErrorBoundary.tsx`（新增，class 组件：`componentDidCatch` 打印错误；渲染降级卡片「此卷渲染异常」+ 重试按钮重置状态）。
- `client/src/App.tsx`：每个路由 element 外包 ErrorBoundary（单路由崩溃不白屏，显示降级页 + 返回首页）。
- `client/src/pages/CityPage.tsx`：每个 `SectionShell` 模块内容外包 ErrorBoundary（单卷异常只降级该卷）。
- 测试：`vitest.config.ts` include 增加 `client/**/*.test.tsx`；`ErrorBoundary.test.tsx` 用 `react-dom/server` `renderToString`（node 环境）验证正常渲染与 `getDerivedStateFromError` 降级状态。

### P1-18 后台与文档
- `/api/admin/overview`（`server/routes/adminRoutes.ts`）：`services.llm` 增加 `callsToday` / `dailyBudget` / `remaining`（复用 `jobRepo.sumLlmCallsSince(startOfToday())` + `config.llm.dailyCallLimit`，与 rateLimiter 同口径）；`adminRoutes.test.ts` 更新断言。
- `AdminPage.tsx` 大模型卡片显示「今日调用 x / 预算 y（剩余 z）」。
- `README.md` 增加 Mermaid 架构图：浏览器 → Fastify（REST/SSE）→ SQLite（cities/city_archives/city_modules/generation_jobs/app_settings）+ 构建期数据产物 + LLM + Tavily + 天地图 + Open-Meteo/Wikidata/Wikidata Commons。

---

## 5. P2 新功能（4 项，均含 Schema / API / 前端 / 响应式 / 测试 / 文档）

> 通用约定：新功能**不进入** `MODULE_NAMES`（不属于档案八卷，不改 `CityArchiveResponseSchema` 主结构）；Schema 加在 `shared/schema.ts` 尾部「搜索与接口契约」区；API 统一 Zod 校验；前端路由懒加载；数据缺失一律「待考」，不估算。

### P2-19 双城对比
- `shared/schema.ts`：`CompareCitySchema`（cityId、standardName、province、oneLinePersona、gdp/pop/climateType（缺失「待考」）、topLandmarks[≤3]、topRelics[≤2]、topFigures[≤2]、poemCount、themePalette、archiveStatus）+ `CompareResponseSchema`。
- `server/routes/compareRoutes.ts`（新增）：`GET /api/compare?cities=CN-A,CN-B`——严格 2 个合法 `CityIdSchema`；城市不存在 400 `CITY_NOT_FOUND`；任一未生成 404 `NOT_GENERATED`（提示先生成）；复用 `cacheService.loadBundle` 读取；在 `server/index.ts` 注册。
- 前端：`client/src/pages/ComparePage.tsx`（lazy，路由 `/compare?cities=…`）；`lib/api.ts` `getCompare`；并排卡片（一句话人设、GDP/人口、气候、代表景点/文物/人物、诗词数量、主题色）；桌面双列、移动纵向堆叠；「复制分享链接」按钮；入口：TopBar/首页「双城对比」+ CityHero 快捷入口。
- 测试：`compareRoutes.test.ts` 集成测试（buildApp + 临时 DB：双城成功 / 一城未生成 / 城市不存在 / 参数非法）。

### P2-20 「如果只有一天」路线
- `shared/schema.ts`：`DayTripStopSchema`（name、placeName、coordinates、coordSource、slot: morning|afternoon|evening、category、sourceRefs）+ `DayTripSchema`（cityId、cityName、stops、notice「示意路线，非导航」、generatedAt）。
- `server/services/dayTripService.ts`（新增）：从档案 landmarks+relics 取有坐标条目 → 按名称去重 → 取 4–6 个 → 按与市中心距离分三档（近=上午、中=下午、远=晚上，每档 1–2 个）；不足 4 个按实际数量返回并标注 `degraded`；营业时间一律「待考」，不接 OTA。
- API：`GET /api/cities/:cityId/daytrip`（archiveRoutes 内新增）。
- 前端：`client/src/components/modules/DayTripModule.tsx`（新 section「一日路线」：上午/下午/晚上分组列表 + 内嵌 `CityMap`）；`CityMap.tsx` 增加 `route?: Coord[]` 与 `scope='daytrip'`，绘制连接线与方向，固定标注「示意路线，非导航」。
- 测试：`dayTripService.test.ts`（点数、分槽、去重、无坐标跳过、降级）。

### P2-21 知识小测验
- `shared/schema.ts`：`QuizQuestionSchema`（id、type: single|boolean、prompt、options[{id,text}]、answerId、explanation、sourceRefs、factKind）+ `QuizSchema`（cityId、questions[5]）。
- `server/services/quizService.ts`（新增）：从档案事实字段生成 5 题——① identity（气候类型或人口数值，非「待考」）② chronicle（朝代起止匹配）③ landmarks（必去/秘境或景点辨识）④ relics（年代或馆藏地）⑤ figures（朝代或关联类型）；干扰项取自同档案其他实体或固定常量表（气候类型表），**禁止出现档案之外的「知识点」**；本地判分不依赖 LLM。
- API：`GET /api/cities/:cityId/quiz`。
- 前端：`client/src/components/modules/QuizModule.tsx`（新 section「随堂小测」：逐题作答、提交后对错+解析+来源、重做；移动端单列）。
- 测试：`quizService.test.ts`（5 题、answerId 正确、选项不含「待考」、干扰项不重复、无档案 404）。

### P2-22 长图海报
- `client/src/lib/poster.ts`（新增，原生 Canvas 2D，零依赖、零外部图片 CDN）：纯函数 `buildPosterSpec(archive)` → 规范数据（城名、人设、代表景点≤3/文物≤2/人物≤2、关键统计、来源列表、生成时间、主题色、AI 整理标注）→ `renderPoster(spec)` 绘制 750px 宽竖版 → `toBlob` 下载；移动端同屏渲染 `<img>` 供长按保存。
- `client/src/components/poster/PosterDialog.tsx`：预览 + 下载 + 免责/来源脚注。
- 入口：CityHero「导出长图」。
- 测试：`poster.test.ts`（buildPosterSpec：字段完整、缺失「待考」、来源非空、时间格式）；ego-browser 实测导出（读取 blob 大小 > 0 并截图）。

---

## 6. 验证门禁与执行顺序

1. 每完成一项：`npm run typecheck` 必须通过；累计新增测试随 `npm test` 全量通过（不删除/不改弱已有 120 项）。
2. 阶段门禁：P0 完成后 `npm run verify` 6/6 + `npm run build`；P1 完成后同样全过且数据产物已重建；P2 完成后新增功能测试全过。
3. 执行顺序：P0-1（Key+实测）→ P0-2 → P0-3 → P0-4 → P0-5 → P0-6 → P0-7 → P0-8 → P1-9 → P1-10 → P1-11 → P1-12 → P1-13 → P1-14 → P1-15 → P1-16 → P1-17 → P1-18 → P2-19 → P2-20 → P2-21 → P2-22 → 文档收口（README/FEATURES/PRD 注记）。
4. 不做：git commit；提交 Key；删除已有能力；伪造数据/许可证/签字。

---

## 7. 预期新增/修改文件清单（执行期以实际为准）

- 新增：`scripts/test_llm_provider.ts`、`scripts/clean_unpublished_archives.ts`、`server/routes/compareRoutes.ts`、`server/services/weatherService.ts`、`server/services/dayTripService.ts`、`server/services/quizService.ts`、`client/src/pages/ComparePage.tsx`、`client/src/components/modules/DayTripModule.tsx`、`client/src/components/modules/QuizModule.tsx`、`client/src/components/poster/PosterDialog.tsx`、`client/src/lib/poster.ts`、`client/src/components/ui/ErrorBoundary.tsx`、`client/src/hooks/useFocusTrap.ts`、`e2e/README.md`。
- 修改：`package.json`（根脚本 test:llm、archives:clean-unpublished；devDep lighthouse/axe-core 视安装结果）、`vitest.config.ts`（client tsx 测试）、`shared/schema.ts`（Weather/DayTrip/Quiz/Compare Schema）、`server/index.ts`（admin overview 预算、compare 路由注册、weather/daytrip/quiz 路由）、`server/routes/adminRoutes.ts`、`server/routes/archiveRoutes.ts`、`server/services/jobManager.ts`（计时日志）、`server/services/llmGenerator.ts`（figures 泄漏过滤）、`server/services/poetryVerifier.ts`（意象词表）、`server/db/archiveRepo.ts`（deleteUnpublished）、`scripts/build_stats_baseline.ts`、`scripts/build_poetry_corpus.ts`、`scripts/build_relic_images.ts`、`scripts/build_geo_boundaries.ts`（tianditu 源选项）、`client/src/App.tsx`、`client/src/pages/CityPage.tsx`、`client/src/components/hero/CityHero.tsx`、`client/src/components/search/CitySearchModal.tsx`、`client/src/components/modules/CityMap.tsx`、`client/src/components/modules/RelicsModule.tsx`（署名展示确认）、`client/src/pages/AdminPage.tsx`、`client/src/lib/api.ts`、`client/vite.config.ts`（manualChunks，如需）、`docs/PRD.md`（AC-14 注记）、`README.md`（Mermaid 架构图）、`FEATURES_AND_VERIFICATION.md`（全量刷新）。

---

## 8. 风险与 BLOCKED 预判

- **官方 Key 失效/额度不足** → AC-04 BLOCKED；脚本与预设保留。
- **Lighthouse 安装被网络策略拦截** → AC-16 BLOCKED（附体积证据与命令）。
- **axe-core 安装失败** → 人工清单走查替代并如实标注。
- **DataV 授权/审图号无法确认** → BLOCKED；天地图源替换失败则保留 DataV + 三处警示。
- **Wikidata/Wikipedia 国内不可达** → 快照重建类项降级（负缓存 10 分钟），如实记录；不影响预置与缓存城市。
- **gov 公报页面改版/不可达** → 对应年份保持 null，不估算。
- **DB 清理误删风险** → 清理脚本默认 dry-run、只删 unpublished 非预置、执行前打印清单。
