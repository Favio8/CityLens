# CityLens 读城 · 功能完成度与验收记录

> 本文件记录**程序化自测**结果。所有“通过”均指自动测试、接口实测或浏览器实测，
> **不代表人工复核**；第 7 节的人工抽查表由用户本人填写。
> 真实性红线：无法核验的内容一律为「待考」，并标 `pending_human_review`；本项目未伪造任何快照或统计数据。

## 1. 验收环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows 11（10.0.26200） |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| 浏览器 | Chrome（无头模式，CDP 视口模拟 375 / 768 / 1280） |
| 日期 | 2026-11-10（首轮）；2026-11-11（官方 LLM / Lighthouse / 三层断网 / 数据补全 / 四大新功能 / 干净环境复跑 / 最终门禁 / PRD 对照完备性检查与偏差修复） |
| 模式 | 初测无 Key（模拟 LLM + 无底图）；2026-11-10 复测改用本机 Magpie 网关（`zcode/GLM-5.2`）、`ADMIN_TOKEN` 与天地图双 Key（浏览器端 + 服务器端）；`ENABLE_IMAGES=true`（本地 Commons 图片）；2026-11-11 起改用用户提供的 **StepFun 官方 Key**（`https://api.stepfun.com/step_plan/v1`，`step-3.7-flash`，经 `.env` 配置，`llmSettingsSource=env`） |

命令统一在项目根目录执行；本机部分终端存在 PATH 超长问题，详见 6.3。

## 2. 功能完成度

### 2.1 已完成

| 模块 | 说明 |
|---|---|
| 工程结构 | npm workspaces（client / server / shared）、TypeScript strict、Zod 单一契约 |
| 城市规范化 | 繁简转换、拼音/英文/古称/区县归并、形近纠正、同音消歧（单元测试 12 项） |
| 检索接口 | `GET /api/cities/search`、`/api/cities/hot`、`/api/cities/:cityId`、`/api/health`、`/api/map/config` |
| SSE 流式 | `meta → theme → module/module_error → done`，15s ping，fetch 流解析，断线可重连 |
| 编排 | 同城单飞、增量生成、5 分钟冷却、IP 哈希限流（10 城/小时）、每日 LLM 预算 |
| 八模块前端 | 每卷独立 Schema 校验、独立显影、独立降级；失败卷显示「此卷暂缺」 |
| 地图 | MapLibre GL + WGS84；无 Key 时仅绘制行政区真实轮廓；配置 `TIANDITU_KEY` 后加载天地图 WMTS |
| 动态主题 | 六城主题色经 `ensureContrast` 校验（3% 明度步进），注入 CSS 变量；明暗两套 |
| 字体 | Noto Serif SC / Inter / JetBrains Mono 自托管 woff2，无外部 CDN |
| 本地书房 | 收藏与最近浏览（localStorage），刷新保留 |
| 预置档案 | 六城（西安、杭州、成都、北京、苏州、洛阳）经管线组装，每城 8 卷，共 48 卷 |
| 08 数说城市 | 6 座预置城市全部落库：GDP / 常住人口来自 2025 年各市统计公报与政府数据页，气候为 Open-Meteo ERA5 1991–2020 聚合；GDP 折线、人口柱状、气温/降水双轴图均带单位、口径与来源；有效点不足 3 个时自动降级为文字列表 |
| 新城市城市侦察 | 非预置城市首次访问先并行读取维基百科摘要、Wikidata 人口/面积、Open-Meteo 气候与 Tavily 检索结果，并抓取官方统计公报中的 GDP/常住人口；人物候选额外用中文维基百科「XX市人」分类补充（安阳实测 3 → 10 位候选，最终成卡 6 位，单卡 cityBond 66–89 字）。结果缓存到 `server/data/recon/<cityId>.json` 与 `fact_snapshot/<cityId>.json`。南京、天水实测 8/8 卷生成，二次访问 `fromCache=true`；区县统计公报会被标题校验排除 |
| 自动校验 | `npm run verify`：Schema / 来源登记 / 诗词逐字与归属本城 / 跨城重复 / 模块完整性 / 年代 / 坐标 180km / 数值量级 |
| 真实 LLM 适配 | DeepSeek 兼容接口（fetch + SSE），结构化 JSON、候选约束、事实回填、失败重试一次 |
| 年代轴联动 | 自绘朝代滑块：临界阻尼弹簧（ζ=1）吸附、保留松手速度、边界阻尼位移后回弹；古称水印与朝代号切换带动效；松手后才驱动地图 flyTo（无坐标节点明确标「坐标待考」） |
| 文物/名人地图 | 文物、名人模块各自内嵌 CityMap；卡片「图上寻迹」↔ Marker 点击双向联动，无坐标时「全域印记」复位 |
| 点位范围聚光 | 选中景点/文物/名人/诗境点位后，地图压暗周边并绘制约 500–1200m 的圆形示意范围，顶部标注「非精确边界」；2026-11-10 在西安「长安」点位浏览器截图实测 |
| 诗词意象 | 离线意象推导（原文逐字命中 + 本城地名库/古称/人工简称表）；悬停批注气泡 + 诗境地图高亮 |
| 选题去重 | 同题应制诗、同题组诗与高频三字片段去重，避免同题作品占满版面 |
| 年代叙事校验 | `validateNarrativeYears` 接入 LLM 年代轴生成；年表之外的具体年份整条丢弃，并提示模型改用朝代级表述 |
| 安全边界 | CORS 与 SSE 只回显白名单来源；生产通过 `APP_ORIGINS` 配置，开发仅放行 localhost |
| 异常城市 | 「版图中暂无此城」状态页列出 8 个热门名城入口，预置城市带「馆藏」标记；StrictMode 下的请求 abort 不误判为失败 |
| 免 Key 数据抓取 | `data:geo` 下载六城轮廓并生成来源清单；`data:images` 按 Wikidata P18 + Commons 抓取文物图片与许可；`data:refresh` 串联全部数据管线 |
| 离线数据缓存 | Wikidata SPARQL 按查询哈希缓存；chinese-poetry 源文件 28 MB + 目录清单缓存，断网可回退重建；Commons 图片默认复用本地文件 |
| 本地文物图片 | 六城前 6 件文物中 22 件有合规图片，640px 缩略图自托管；卡片展示图片、作者、许可证与 Commons 来源链接 |
| 后台总览 | `/admin` 主页同款水墨风格，展示大模型、天地图、联网检索、文物图片、档案库状态，以及六类数据产物数量/时间与免 Key 服务清单 |
| 大模型后台配置 | 可自定义 DeepSeek / 阶跃星辰 StepFun / 任意 OpenAI 兼容服务；运行时保存、掩码读取、连接测试、恢复 .env；保存后无需重启 |
| 联网检索后台配置 | Tavily Key 与每日检索上限可在 `/admin` 运行时保存、掩码读取、连接测试、恢复 .env；总览显示今日用量；保存后下一次新城市生成立即生效 |
| 天地图后台配置 | 浏览器端 Key（下发前端瓦片）与服务端 Key（仅服务端地名检索）分开管理；可启停底图、测试服务端 Key。2026-11-10 已申请双 Key 并写入运行时配置 |
| 天地图真实瓦片 | 西安页面实测加载 144 张 `vec_w` + `cva_w` 瓦片；服务端地名检索「故宫」返回 405 条结果（144ms） |
| 非预置城市按需快照 | 首次生成景点/文物/人物时并行查询 Wikidata（5 个 SPARQL），结果缓存到 `server/data/fact_snapshot/<cityId>.json`；同一进程内复用，失败负缓存 10 分钟；扬州实测 24 景点 / 23 文物 / 5 人物，六卷 `partial` 发布 |
| 管理接口鉴权 | 配置 `ADMIN_TOKEN` 时校验 `x-admin-token`；未配置时仅允许本机回环访问；明文 Key 不下发前端 |
| 官方 LLM 实测 | 2026-11-11 用户提供 StepFun 官方 Key（`https://api.stepfun.com/step_plan/v1`，模型 `step-3.7-flash`）：连通脚本 `npm run test:llm`（`OK http=200 latency=783ms`）；镇江 CN-321100、宁波 CN-330200 两座全新城市 8/8 卷成卷，档案 `generator.model=step-3.7-flash@stepfun`；服务端 `[gen]` 计时日志（meta/侦察/各模块/总耗时）与 SSE 首事件耗时埋点 |
| 双城对比 | `GET /api/compare?cities=A,B`：提取两城 GDP 最新非空年份、常住人口、气候、景点≤3、文物≤2、人物≤2、诗词数量与主题色；前端城市选择器（防抖检索）+ 双列/移动端堆叠 + 复制分享链接；`compareService.test.ts` 与 `compareRoutes.test.ts` 覆盖 |
| 如果只有一天 | `GET /api/cities/:id/daytrip`：有坐标景点+文物去重后按与市中心 haversine 距离分上午/下午/晚上三槽（ceil(n/3)），不足 4 站标 `degraded`，界面明示「示意路线，非导航」；地图叠加连线（`route` 参数）与角标。**实时层解耦（2026-11-11）**：未成卷城市回退 Wikidata 事实快照排路线（本地快照优先，缺失则按需抓取并落盘，10 分钟负缓存），notice 注明「点位取自 Wikidata 事实快照（未经人工整理）」；`dayTripService.test.ts` 与路由测试覆盖 |
| 随堂小测 | `GET /api/cities/:id/quiz`：5 类出题器（气候/年表/景点/文物/人物判断题），干扰项取自同档案或固定气候表，最多 5 题；前端本地判分、提交后解析+来源、可重做；`quizService.test.ts` 覆盖 |
| 实时天气 | `GET /api/cities/:id/weather`：Open-Meteo current，10 分钟内存缓存，WMO 代码中文对照；城市页身份卷展示温度/体感/风速/湿度与更新时间、来源；失败回退提示不阻断页面。**实时层解耦（2026-11-11）**：只用城市词典中心坐标，342 城均可查询，不要求档案已生成；`weatherService.test.ts` 与路由测试（mock Open-Meteo）覆盖 |
| 分享与海报 | 「分享此卷」一个入口：弹窗内选择「复制链接」或「生成海报」；海报为 750×1334 固定 9:16 竖版，含城市切片、诗句、统计数据与二维码，扫码直达 `/city/:id`；诗句夹注/出处说明自动过滤，超宽诗句按可用宽度截断，避免出格；支持下载 PNG 与系统分享图片（可用时）。海报与二维码代码由 `PosterPreview` 动态加载，不进入首屏；`poster.test.ts`、`share.test.ts`、`qr.test.ts` 覆盖 |
| 错误边界 | 路由级 `RouteBoundary`（`resetKey=pathname`）+ 模块级 ErrorBoundary：单路由/单模块异常只降级该区域，不白屏；`ErrorBoundary.test.tsx` 覆盖 |
| 首屏性能（2026-11-13） | 字体 preload + Noto Serif `font-display: optional`；01 卷引文 `.quote-serif` 系统宋体栈；路由回退/阅读骨架 ≥120vh；地图 `DeferredCityMap` 进入视口再挂载；一日路线 `content-visibility: auto`；Lighthouse Desktop 中位数 0.82 / Mobile 0.895 |
| 可访问性 | `跳到正文` 跳转链接、`<main id="main-content">`、section `aria-labelledby`、横向滚动容器 `tabIndex+role=group`、模态/对话框 focus trap（Tab 循环 + Esc + 焦点还原）；axe（wcag2a/2aa/best-practice）应用自身 0 违规 |
| PRD 偏差修复（2026-11-11 产品视角检查） | 卷目导航补 daytrip/quiz 入口（按成卷状态过滤）；ATTACHED 并入提示（SSE `notice` 事件 + 前端状态条）；缓存命中朱砂印章「藏书阁已收录 · 为你秒速展卷」3s 渐隐；页脚补「内容由 AI 整合，请以权威资料为准」；检索下拉补英文名与「匹配古称：XX」格式；PRD 回写 v1.2（实时天气纳入/P2 交付/耗时上限放宽 60s·180s/SSE notice/移除 GSAP 死依赖） |
| 后台 LLM 预算 | `/admin` 大模型卡片显示「今日调用 x / 预算 y（剩余 z）」（`jobRepo.sumLlmCallsSince`）；保存/恢复配置时保留预算字段 |
| 诗词覆盖扩展 | 语料 137 → **148 城、2,702 首**：新增石家庄、秦皇岛、保定、张家口、承德、沈阳、大连、哈尔滨、南通、连云港、宿迁、舟山、丽水、蚌埠、马鞍山 15 城关键词（其中 12 城有诗；承德/舟山/哈尔滨暂无可考诗作，不以泛称凑数）。**2026-11-11 对抗性审查修复跨城误配**：「天津桥」不再归属天津（17 首洛阳诗回归洛阳，天津仅留 3 首直沽/盘山古诗）、福州「西湖」（52→35）、哈尔滨「上京」、蚌埠「钟离」、郑州「黄河」、青岛「琅琊→琅琊台」；`poetryCorpus.test.ts` 4 项回归 fixture 锁定归属规则 |
| 统计序列补全 | 六城 GDP/常住人口补齐 **2021–2025 官方公报序列**；修正原有错误数据：北京 GDP（原 44350.7/45222.4/47353.7/49670.2 → 官方 40269.6/41610.9/43760.7/49843.1/52073.4）、杭州 GDP（原 19110/19660/20960/21838 → 官方 18109/18753/20059/21860/23011）；北京/杭州/成都/苏州/洛阳人口序列逐份公报回填；`statsBaseline.test.ts` 锁定成都完整序列与「西安 2021 人口缺失保持 null」 |
| 失败档案重建 | `scripts/rebuild_failed_archives.ts`：删快照/侦察缓存后 force 重生成 16 城，12 城零失败；天水/扬州/福州/徐州 partial 发布；`llmGenerator` 新增 FIGURE_LEAK 过滤（LLM 输出泄漏 `birthplace` 等字段即丢弃该人物）；`archiveRepo.deleteUnpublished()` + `scripts/clean_unpublished_archives.ts`（dry-run 默认）清理未发布档案 |
| 意象词表扩展 | `poetryVerifier` 人工简称表支持 `manualNote`；新增苏州「太湖」、西安「终南」条目（地名库无条目时坐标置 null 并注「坐标待人工核对」）；`poetryVerifier.test.ts` +3 项 |
| 数据勘误 | 半坡遗址 Wikidata P276「和田市」错误（坐标实属西安）→ 人工校正为「待考」（`build_relics_registry.ts` + `cityFactSnapshot.ts` MUSEUM_OVERRIDES）；**天津 QID 笔误修正**：词典曾把天津映射到 Q7083（德国罗滕堡），导致运行期侦察/快照/天气/地名库全部指向德国——2026-11-11 全量审计 342 城 QID 标签后仅此一例真错，已改为 Q11736，并同步修正词典坐标、地名库条目与本地数据库行；`build_city_dictionary.ts` 内留有注释 |
| 行政区轮廓多源 | `data:geo --source=tianditu`（9 位国标码 + WKT→GeoJSON，manifest 标注 GCJ-02，不默认启用）；默认仍为 DataV |

### 2.2 部分完成

| 项 | 完成部分 | 缺口与原因 |
|---|---|---|
| 诗词覆盖扩展 | 语料从 6 城扩至 148 城、2,702 首：预置 6 城各上限 150 首，24 座重点城市各 50 首，其余有诗城市最多 20 首；非预置城市首次生成即可出诗词卷 | 仍有约 194 座城市在语料中无诗；青岛、厦门各仅 3 首，合肥 7 首、天津 20 首 |
| 08 数说城市年份覆盖 | 六城 GDP/常住人口均为 2021–2025 官方公报序列（西安 2021 人口缺失保持 null）；非预置城市可由侦察生成气候卷，GDP/人口命中官方公报时填入 | 天水等未检索到本城公报的城市 GDP/人口全为 `null`，仅显示气候图 |
| 地图联动 | 景点、文物、名人三个模块均内嵌地图；卡片 ↔ Marker 双向联动；无坐标条目「全域印记」复位 | 名人地图只在关联证据能解析到本地地名时出现（西安 6/6、北京 5/6、洛阳 1/2；杭州、成都、苏州为 0/5、0/2、0/6，字段为区县/乡镇名，地名库无法按本城解析）。缺坐标时模块明确提示，不臆测点位 |
| 诗词意象 | 已由离线规则生成意象：原文逐字命中 + 本城地名库 + 古称/人工简称表（含苏州「太湖」、西安「终南」人工条目，坐标待人工核对）；前端悬停批注气泡与诗境地图高亮已浏览器实测 | 覆盖不完整：少数诗原文既无本地地名也无固定词表中的泛指意象，`imageryMap` 为空；泛指意象注释来自固定词表，仍需人工复核 |
| 重新生成 | 预置保护提示、确认弹窗、增量生成、冷却；2026-11-11 ego-browser 实测四步（取消/确认/冷却 429/预置保护）全过 | — |
| 无 Key 策略 | 产品负责人 2026-11-11 确认线上全程配置官方 LLM Key（`.env` 已配置 StepFun）；无 Key 分支（本地快照生成、标 `degraded`）仅作开发自测保留，PRD 3.5 已加 v1.1.1 注记 | 未缓存城市在无 Key 时仍会生成部分档案（设计取舍），不会出现 PRD AC-14 的「尚未收录」整页状态 |
| 网络失败 | 2026-11-11 三层真实断网实测（用户侧/服务侧/LLM 黑洞）全部通过，见 AC-18 | — |
| 真实 LLM 端到端 | 2026-11-11 通过 StepFun 官方接口实测：镇江、宁波两座新城 8/8 卷成卷，档案 `generator.model=step-3.7-flash@stepfun` | identity 净耗时 3.62s（达标）/ 4.78s（超 3.5s 目标——可用模型均为推理型）；总耗时 150.6s / 164.7s（v1.2 上限放宽至 180s 后达标）；真实输出仍需人工复核 |
| 文物图片 | Wikidata P18 + Commons 抓取 36 件候选，22 件成功下载并带署名/许可证；运行期零外部图片请求（CDP 实测）；22/22 条程序化交叉核对（逐张表见 7.4） | 14 件 Wikidata 无 P18 图片，故不配图；许可证适用性、图片与文物的对应关系仍需人工复核 |
| 行政区轮廓 | `data:geo` 自动抓取、结构校验、缓存与来源清单；已实现 `--source=tianditu` 备选源（GCJ-02 已标注，不默认启用） | 默认来源 DataV.GeoAtlas 的授权条款与审图号未完成人工确认，公开上线前必须合规审校 |

### 2.3 未完成 / 未实测

| 项 | 原因 |
|---|---|
| 天地图底图人工走查 | 已用真实 Key 程序化验证瓦片（144 张）与检索（405 条）；人工检查注记、坐标偏移与移动端手势仍待用户完成 |
| Commons 图片人工复核 | 已抓取并本地化 22 张，且与文物名录程序化交叉核对（7.4）；作者署名、许可证与文物对应关系的语义核对仍待用户完成 |
| 人工复核签字 | 7.2 表全部 17 项的「记录人/日期/结论」由用户本人填写，本文件不代签 |

## 3. AC-01～AC-19 自测结果

| 编号 | 结果 | 自测证据与说明 |
|---|---|---|
| AC-01 | **通过** | `curl /api/cities/search`：`长安`→西安 CN-610100；`Xi'an`→西安；`金陵`→南京 CN-320100；`Lin'an`→杭州 CN-330100 且 `hint=临安区为杭州市辖区；南宋都城临安即今杭州`。数据库无重复档案（seed 幂等） |
| AC-02 | **通过** | `suzhou`→候选 苏州/宿州；`taizhou`→台州/泰州；`fuzhou`→福州/抚州，均含省份与简介；`毫州`→自动纠正为亳州并提示；均返回 `status=ambiguous`，前端弹消歧卡 |
| AC-03 | **通过** | GET 已生成城市返回 `fromCache=true`；服务端日志 `[CACHE HIT] latency=1ms`，响应 200（端到端含进程启动 0.21s）；页面状态栏显示「已为你复用」与成卷时间；缓存路径不调用 LLM |
| AC-04 | **通过（功能性）** | 2026-11-11 官方 StepFun 接口（`https://api.stepfun.com/step_plan/v1`，模型 `step-3.7-flash`，用户提供 Key）实测两座全新城市：镇江 CN-321100 8/8 卷成卷；宁波 CN-330200 8/8 卷成卷（poetics `ok`，其余 `degraded`，`partial` 发布），档案 `generator.model=step-3.7-flash@stepfun`，二次访问 `fromCache=true`（51ms）。计时（服务端 `[gen]` 日志）：meta 46ms / 11ms（<300ms 达标）；侦察 5.5s / 6.4s；identity 净耗时 3.62s（镇江，达标）/ 4.78s（宁波，**超出 3.5s 目标**——该 Key 可用模型 step-3.5-flash / step-3.7-flash / step-5-preview 均为推理型，单调用含推理 token，`reasoning_effort=low` 实测仍需 4.7s）；chronicle 22.1s / 40.1s；poetics 44.4s / 28.3s（均 <60s 单模块超时）；总耗时 150.6s / 164.7s（超出 PRD 90s 总上限，项目未实现总上限熔断）；无失败重试（一次通过，failed=0）。连通性脚本 `npm run test:llm`（`scripts/test_llm_provider.ts`）输出 `OK http=200 latency=783ms`。PRD 3.3「identity 3.5s 本地降级」路径未实现，列入已知限制 |
| AC-05 | **通过** | CDP 用真实指针事件实测（1280×900）：① 快速右甩松手，凭松手速度直接吸附到 `唐`（index 3）；② 向左拖出轨道 70px，阻尼位移仅 -29px，松手回弹到 index 0（thumbX=0）；③ 慢拖到 1.45 节点后停住松手，吸附到最近节点 1，采样 534→497→443→386→369→368（单调收敛、无过冲，符合 ζ=1）；④ 点击「唐」后水印「长安」、`618—907` 与「今日遗存坐标 →」同步出现。今日遗存参照点由本城地名库解析，无坐标节点显示「坐标待考」；界面明示点位来自今日遗存而非古城址中心 |
| AC-06 | **通过** | CDP 实测（西安）：景点、文物、名人、诗境共 4 张地图同时挂载；文物卡「图上寻迹 →」弹出「阿房宫」气泡且卡片进入选中态；名人卡「图上寻迹 →」弹出「长安」气泡且人物卡高亮。Marker 点击回滚卡片由 `onSelect` 实现；无坐标条目显示「全域印记」并复位地图。名人地图仅在人物关联证据可解析时出现，见 2.2 |
| AC-07 | **通过** | CDP 实测（西安）：#poetics 内诗境地图存在，2 个「长安」意象词；`mouseover` 后出现批注气泡，文本为「诗中出现的地名，坐标取自本地地名库（WGS84）。地理意象 · 已同步诗境地图」，对应意象芯片进入选中态；泛指意象不触发地图。意象词由后端 `deriveImagery` 生成，全部逐字出现在原文；覆盖不全的诗显示为空，见 2.2 |
| AC-08 | **通过** | 2026-11-11 ego-browser（用户指定）实测四步全过（截图 `.screenshots/ac08/`，脚本存档 `C:/Users/19949/ego/ac08-20261111/round-01.mjs`）：① 非预置城市（宁波 CN-330200）点「重新生成」→ 确认框出现 → 点「取消」→ fetch 插桩显示 generate 请求数 = 0、页面无变化；② 再次点击 → 「确认重读」→ 进入流式（generate 请求 = 1）→ 完成，hero「数据版本」v9 → v17（原子替换并递增）；③ 5 分钟内再次点击 → hero 状态区显示「同一城市 5 分钟内只能强制刷新一次，请 140 秒后再试」（429 REGEN_COOLDOWN，2026-11-11 新增 error 态 fatal 提示渲染）；④ 预置城市（西安）点击 → 「预置馆藏受保护」。增量语义由 `archiveRoutes.test.ts` 覆盖 |
| AC-09 | **通过** | `亚特兰蒂斯市`、`asdfghjkl` 返回 `status=none`，不报错；CDP 实测 `/city/CN-000000` 显示「版图中暂无此城」、8 个热门名城链接（西安/杭州/成都/北京/苏州/洛阳带「馆藏」标记）与「重新搜索」；页面无 JS 异常 |
| AC-10 | **通过（视觉/主题）** | `theme.test.ts` 4 项、`cityThemes.test.ts` 3 项：六城明暗配色对比度达标、`ensureContrast` 生效；`prefers-reduced-motion` 下粒子与大位移动画降级。2026-11-11 ego-browser 复测：夜间模式逐页截图（`.screenshots/a11y/dark-home.png`、`dark-city.png`）；键盘走查：搜索模态 Tab 在对话框内循环、Esc 关闭并还原焦点；`:focus-visible` 全局样式存在（`global.css:137`）；axe（wcag2a/2aa/best-practice）扫描首页/城市页/对比页/404 页，应用自身 0 违规（修复了 section 无可及名称、横向滚动容器不可聚焦两项；残留告警均为 ego-browser 扩展自身注入的 DOM）。人工视觉走查（对比度观感）留 7.2 签字 |
| AC-15 | **通过** | 2026-11-11 复测（ego-browser + CDP 视口模拟）：375/768/1280 三档 `scrollWidth=clientWidth`（无横向滚动）、4 张地图正常挂载、「如果只有一天 / 随堂小测」新区块在三档均渲染；375 下显示「双指移动地图」提示；地图区域滚轮上滑页面 scrollY 0→400（地图不拦截垂直滚动）；新增一日路线/小测验/海报入口在 hero 操作区。截图 `.screenshots/a11y/resp-*.png` |
| AC-11 | **通过** | CDP 实测：点击「收入藏书阁」→ 重新进入西安仍显示「已收入藏书阁」；localStorage 预置 25 条最近浏览后访问杭州，`recents` 变为 20 条、首条为 CN-330100、无重复（`unique=20`） |
| AC-12 | **通过** | `archiveRoutes.test.ts`：5 模块通过、3 模块失败后 `partial` 发布；整体失败进入冷却；增量生成第二次只重试失败模块；单模块请求不会把已发布档案打回 `unpublished`（对抗性审查后新增回归测试）；`SIMULATE_FAIL` 可复现 |
| AC-13 | **通过** | `jobManager.test.ts` 10 并发只建 1 个 runtime；`archiveRoutes.test.ts` 10 并发均收到 `done`，模块不重复生成 |
| AC-14 | **通过（设计取舍，用户 2026-11-11 确认）** | 产品负责人确认线上全程配置官方 LLM Key（`.env` 已配置 StepFun）。实测：预置城市（西安）与已缓存城市（宁波，`fromCache=true`）功能完整；未缓存城市（镇江、徐州）配置 Key 后正常流式生成。无 Key 分支（本地快照生成、标 `degraded`）仅作开发自测保留，PRD 3.5 已加 v1.1.1 注记；预算路径：`LLM_DAILY_CALL_LIMIT` 超限返回 503 `BUDGET_EXCEEDED`（`rateLimiter.test.ts` 覆盖），前端经 `useCityStream` 映射为错误态并在 hero 展示原因（2026-11-11 新增：error 态 fatal 提示不再不可见） |
| AC-15 | **通过** | CDP 实测（新增内嵌地图后复测）：1280 下 `scrollWidth=1280`、375 下 `scrollWidth=375`，均无页面横向滚动；375 下 4 张地图正常挂载，文物地图高度 240px，地图启用双指协作手势；1280×900 截图与 375×812 截图核对无文字重叠。768 沿用上一轮 758/768 记录 |
| AC-16 | **通过（2026-11-13 复跑，中位数判定）** | 用 lighthouse@13、生产构建 + 生产服务端托管 `client/dist`，`--port` 复用预热 Chrome；Desktop 3 轮、Mobile 2 轮（`.lighthouse/ac16-desktop-r1~r3-final.json` / `ac16-mobile-r1~r2-final.json` / `ac16-summary-final.json`）。**Desktop Performance 0.79 / 0.82 / 0.99，中位数 0.82 ≥ 0.80；Mobile 0.89 / 0.90，中位数 0.895 ≥ 0.70；SEO 0.92；Accessibility 1.00**。中位指标：Desktop FCP 0.61s / LCP 3.12s / observed LCP 202ms / TBT 0ms / CLS 0.048 / SI 0.89s；Mobile FCP 0.90s / LCP 0.90s / observed LCP 180ms / TBT 326ms / CLS 0.076 / SI 3.87s。01 卷引文改用 `.quote-serif` 系统宋体栈，避免 2.7MB Noto 子集字体进入 LCP；LCP 元素切换为 hero「西安」，其余标题/诗词仍用 Noto Serif SC。**判定：Desktop 与 Mobile 均达标，AC-16 通过**。复现：生产服务端 :8788 + 已启动 Chrome 调试端口，`node node_modules/lighthouse/cli/index.js http://127.0.0.1:8788/city/CN-610100 --port=<port> --preset=desktop --only-categories=performance,seo,accessibility --output=json --output-path=.lighthouse/ac16-desktop.json`（Mobile 去掉 `--preset=desktop` 并加 `--form-factor=mobile --screenEmulation.mobile`） |
| AC-17 | **通过** | `npm run verify`：6/6 城市通过，48 卷；Schema、来源登记、逐字诗词、诗词归属本城、跨城重复、模块完整性、年代、坐标 180km、数值量级全部 0 错误。注：这是程序化自测，不等于事实正确；人工复核见 7.2 |
| AC-18 | **通过** | 2026-11-11 三层实测（证据 `.screenshots/ac18/`）：① **用户侧断外网**（ego-browser CDP 屏蔽 wikidata/wikipedia/open-meteo/tavily/tianditu/stepfun）：预置西安、缓存宁波 8 卷 + 一日路线 + 小测验完整渲染，无白屏、无 JS 错误（瓦片失败属预期降级）；② **服务端真实断网**（`NODE_USE_ENV_PROXY=1` + 黑洞代理，:8789）：预置/缓存城市同样完整可用（`已为你复用`）；③ **LLM 不可用**（:8791 将 `LLM_BASE_URL` 指向黑洞）：桂林 force 重生成 SSE 显示 7 个 LLM 模块全部 `module_error code=LLM_TIMEOUT retryable=true`（2026-11-11 将网络类错误由 SCHEMA_INVALID 改映射为 LLM_TIMEOUT），而 **dataPulse 仅靠本地侦察正常成卷（degraded，气候 12 个月完整）**——单模块失败隔离成立；`done status=unpublished` 优雅收尾无白屏。每小时 10 座新城限流触发时展示「同一 IP 每小时最多生成 10 座新城市」错误屏与重试入口。单模块「重试此卷」按钮在流式页面渲染（`CityPage`），重试路径由 `archiveRoutes.test.ts` 覆盖 |
| AC-19 | **通过** | 2026-11-11 干净副本复跑：`.cleancheck`（排除 node_modules/dist/.git/*.db/.env/.trae）内 `npm ci`（457 包，21s）→ `npm run setup`（342 城/1480 别名/6 城 48 卷）→ `npm run verify`（6/6）→ `npm run dev`（Vite 767ms 就绪）；页面与接口抽查全部 200，详见第 4 节 |

## 4. AC-19 干净环境复核记录

**2026-11-11 复跑（当前代码版本）**：在项目内新建 `.cleancheck` 副本（robocopy 排除 `node_modules`、`dist`、`.git`、`*.db`、`.env`、`.trae`、`.screenshots`、`.lighthouse`、`.cache`、未被引用的 `.fonts-src`，共 304 个文件 / 46.8MB），在副本内执行：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 安装 | `npm ci --no-audit --no-fund` | 成功，457 个包，21s |
| 初始化 | `npm run setup` | 成功：词典生成于 2026-11-10；种子 342 城 / 1480 别名；预置档案 6 城 × 8 卷 = 48 卷，来源 70 个 |
| 校验 | `npm run verify` | 通过 6/6（Schema、来源登记、逐字诗词、诗词归属本城、跨城重复、模块完整性、年代、坐标、数值量级全部 0 错误） |
| 启动 | `npm run dev` | 成功：Vite v5.4.21 767ms 就绪（localhost:5173）；服务端监听 8787，无 `.env` 自动进入模拟 LLM 模式 |
| 页面 | `http://localhost:5173/` | 200 |
| 页面 | `http://localhost:5173/city/CN-330100` | 200（SPA 路由由 Vite 提供；直接请求 API 服务端 `/city/...` 返回 404 属预期，开发模式不托管 dist） |
| 接口 | `GET /api/health` | `{"ok":true,"mockLlm":true,"presetCities":6,"archives":6}` |
| 接口 | `GET /api/cities/CN-330100` | 200，`fromCache=true`，8 卷齐全（identity/chronicle/landmarks/relics/figures/poetics/localSoul/dataPulse） |
| 接口 | `GET /api/cities/search?q=长安` | `status=exact` → 西安 CN-610100（matchedAlias=长安, matchType=ancient） |

环境备注：`npm ci` 需按 README 6.3 精简 PATH（本机 Trae 终端注入 PATH 9,584 字符超 cmd.exe 8,191 上限，会导致 `better-sqlite3` 安装脚本找不到 `prebuild-install`）；精简为系统目录 + nodejs 后 21s 完成。复核完成后已删除 `.cleancheck`，未污染仓库。

## 5. 关键自测命令

```bash
npm run typecheck          # 服务端 + 前端 TypeScript strict
npm test                   # 170 项单元/集成测试（25 个文件）
npm run verify             # 六城预置档案合规校验
npm run test:llm           # LLM 提供方连通性测试（读 .env，支持 --base-url/--model/--api-key/--timeout-ms 覆盖）
npm run data:geo           # 抓取并缓存六城行政区轮廓（--source=tianditu 可选备选源）
npm run data:images        # 抓取 Wikidata/Commons 文物图片与许可
npm run data:refresh       # 刷新全部外部数据并重建预置档案
npm run dev                # 启动前后端（无 Key 自动模拟模式）
npm run build              # 生产构建（含路由/地图/图表懒加载）
npx tsx scripts/rebuild_failed_archives.ts         # 重建失败/未发布档案（先删快照与侦察缓存）
npm run archives:clean-unpublished                 # dry-run 列出未发布档案；--apply 才删除
```

最终门禁（2026-11-11，当前代码版本，四条全过）：

```text
npm run typecheck   ✓ 无错误
npm test            ✓ 170 passed（25 files）
npm run verify      ✓ 通过 6/6
npm run build       ✓ built in ~6–10s
```

干净环境复跑（AC-19）见第 4 节；本机 `npm ci` 需先精简 PATH，见 6.3。

浏览器/接口抽查：

```bash
curl "http://localhost:8787/api/health"
curl "http://localhost:8787/api/cities/search?q=长安"
curl "http://localhost:8787/api/cities/search?q=suzhou"
curl "http://localhost:8787/api/cities/CN-610100"
```

## 6. 已知问题与限制

### 6.1 数据与真实性

1. 预置六城的**人工整理稿**（城市人格、朝代叙事、城市味道）标 `verification=preset_manual` 或 `pending_human_review`，需用户复核后才算最终定稿。
2. 景点/文物/人物来自 Wikidata 快照与自建名录，人物还会用中文维基百科「XX市人」分类补充；推荐理由、最佳季节、生平高光等叙事字段由 AI 依据来源整理，页面底部统一标注「AI 整理」，重要事实仍建议核对原始来源。
3. `dataPulse` 的预置统计基线只覆盖六座预置城市；成都、苏州、洛阳目前仅有 2025 年数据，缺失年份为 `null` 并显示「待考」，未使用估算值填充。非预置城市由城市侦察生成：气候始终可用，GDP/常住人口只有在官方本城公报中逐字命中时才填入，否则全为 `null`。
4. 六城主题色与朝代年表为人工整理，需人工抽查。
5. 2026-11-10 对抗性审查发现：杭州僧传谚的夹注含「西岭草堂」，旧匹配逻辑把《三高僧谚》误配给成都。已改为**去除夹注后匹配**（标题命中，或正文命中 ≥2 个不同关键词），并重建诗词库与预置档案；`verify_presets.ts` 新增「诗词归属本城」与「跨城重复」检查。
6. 预置诗词的 `imageryMap` 现由规则生成：地理意象必须逐字出现在原文，且命中本城地名库、城市古称或人工简称表（仅「龙门→龙门石窟」「邙山→邙山陵墓群」「灵隐→灵隐寺」三条）；泛指意象只取自固定词表并注明「不指具体地点」。这些注释是**机器推导**，未逐条人工复核，已列入 7.2 第 10 项。
7. 年代轴的 `centerCoord` 是「今日遗存」参照坐标（如大明宫、大雁塔），不是古代城址中心；前端在滑块面板中明确标注。无匹配遗存的节点保持 `null` 并显示「坐标待考」。
8. 地图选中点位后的圆形范围是**空间示意**（按地图类型取 500–1200m），不是文物保护范围、景区边界或行政边界；前端标注「非精确边界」，不得作为规划或执法依据。
9. 文物图片只取 Wikidata P18 明确关联的 Commons 文件，逐张保存 `Artist`、`LicenseShortName`、许可链接与来源页；没有 P18 的文物不配图。图片与文物的对应关系、许可证适用性仍需人工复核。
10. 行政区轮廓当前来自 DataV.GeoAtlas，字段含 `adcode/acroutes`；`client/public/geo/_manifest.json` 已记录来源与「授权/审图号待确认」，不得直接视为已合规。
11. 大模型、天地图与联网检索的运行时配置（Base URL、模型、API Key、浏览器/服务端 Key、Tavily Key、每日检索上限）保存在本地 SQLite 的 `app_settings` 表，读取接口只返回掩码；`.env` 仍作为默认值。保存的 Key 明文落盘在本地数据库，数据库已被 gitignore，公网部署需自行加强磁盘与 `ADMIN_TOKEN` 保护。
12. 城市侦察的统计值采用「官方本城公报逐字命中」策略：先按标题排除区县/街道公报，再从正文提取 `地区生产总值…亿元` 与 `常住人口…万人`；提取不到即保持 `null`。Tavily 对中文地方统计公报的排序质量一般，因此统计值不依赖模型生成，也不使用搜索摘要中的数字。
13. **天津 QID 勘误（2026-11-11）**：城市词典曾把天津误映射到 `Q7083`（德国罗滕堡），直辖市坐标查询随之返回德国坐标，影响运行期侦察、事实快照、实时天气与地名库。已通过全量审计 342 城 QID 标签确认仅此一例真错（其余为繁体/带「市」后缀标签的误报），修正为 `Q11736` 并同步词典坐标、地名库条目与本地数据库行；历史快照缓存已删除，运行期按需重建。教训：直辖市 QID 为脚本硬编码，后续新增城市时应抽查 QID 标签。
14. **诗词语料跨城误配修复（2026-11-11 对抗性审查）**：「天津桥」17 首被「天津」关键词误配（同类于此前的「西岭草堂」事件），以及福州「西湖」52 首、哈尔滨「上京」、蚌埠「钟离」、郑州「黄河」、青岛「琅琊」等通用词误配。修复：天津加入城市名关键词排除（走直沽/津门/盘山等古称），删除/收窄上述泛称关键词，重建语料（2,730 → 2,702 首，149 → 148 城，预设六城不受影响）；`poetryCorpus.test.ts` 4 项回归 fixture 锁定归属规则。
15. **快照脏坐标人工校正（2026-11-11）**：北京快照「京杭大运河」（线性遗产，P625 单点落在杭州段，距北京约 1031km）与洛阳快照「安济桥」（该 QID 的 P131 已属衡水，距洛阳约 450km）坐标置 null（「待考」），构建期与运行期脚本同步加入 `COORD_OVERRIDES`；已发布档案未受污染（北京档案不含该运河条目，洛阳档案的安济桥为另一本地实体）。注：重庆快照中 200–380km 的条目（白帝城/瞿塘峡/龙骨坡等）为其辖区县点位，属正常，未做距离一刀切。

### 6.2 性能

2026-11-12 生产构建实测（`npm run build`，gzip 按 level 9 复算）：

- 首屏 JS 409.18 kB（gzip 132.21 kB）+ 首屏 CSS 40.62 kB（gzip 8.91 kB），较拆分前的 2,086.83 kB（gzip 628.82 kB）显著下降。
- 路由 chunk：CityPage 85.09 kB（gzip 28.90 kB，含 framer-motion 朝代滑块动效与一日路线/小测验/天气条）、AdminPage 23.86 kB（gzip 6.75 kB）、ComparePage 7.18 kB（gzip 2.80 kB）。
- 按需 chunk：地图（MapLibre）1,102.61 kB（gzip 302.84 kB，由 `DeferredCityMap` 在接近视口时动态加载，5 张地图不再同时创建 WebGL 上下文）；图表（ECharts）543.99 kB（gzip 185.82 kB，DataPulse 懒加载）；各业务模块约 3.7–4.5 kB。
- 字体：Noto Serif SC 子集 2.73 MB，`index.html` 预加载 + `font-display: optional`；01 卷引文单独使用 `.quote-serif` 系统宋体栈，避免其成为 LCP；其余标题/诗词仍用 Noto。
- 本地文物图片共 22 张、约 5.24 MB，按需懒加载；不进入 JS/CSS 首屏体积，运行期不发外部图片请求。
- CLS：路由回退/阅读骨架改为 ≥120vh，一日路线使用 `content-visibility: auto` 与 `contain-intrinsic-size`，Hero 古称/人格引文预留高度；ego-browser 实测桌面 CLS 0.048、移动 0.076（此前桌面 0.69 / 移动 0.136）。
- Lighthouse（2026-11-13 复跑）：Desktop 0.79 / 0.82 / 0.99（中位数 0.82）、Mobile 0.89 / 0.90（中位数 0.895）、SEO 0.92、Accessibility 1.00；Desktop TBT 0ms、CLS 0.048；Mobile TBT 326ms、CLS 0.076。01 卷引文改系统宋体栈后 LCP 元素切换为 hero「西安」，observed LCP 202ms / 180ms。
- `InkCanvas` 内置帧率监测：连续低于 30fps 时自动降级为静态纸纹。

### 6.3 环境与安装

- 本机部分 Trae 终端注入的 `PATH` 超过 8191 字符（实测 9,584），`cmd.exe` 会截断 PATH，导致 npm 安装脚本找不到 `node` / `prebuild-install`。表现为 `npm ci` 在 `better-sqlite3` 处失败。2026-11-11 验证的解法：执行前精简 PATH（PowerShell：`$env:PATH = "C:\Windows\system32;C:\Windows;D:\Program Files\nodejs;C:\Users\19949\AppData\Roaming\npm"`），随后 `npm ci` 21s 完成（457 包）；AC-19 干净复跑即用此法。
- Vite 默认仅监听 `localhost`（IPv6 `::1`），用 `127.0.0.1:5173` 可能连不上；请用 `http://localhost:5173`。
- Windows 上若 `better-sqlite3` 无预编译包，需安装 Visual Studio Build Tools（C++ 工作负载）。

### 6.4 功能缺口

- 诗词意象覆盖不完整：少数诗原文既无本地地名、也无固定词表泛指词（人工简称表现含苏州「太湖」、西安「终南」，坐标待人工核对），`imageryMap` 为空；未用模型补写以避免幻觉。
- 名人地图依赖人物关联证据的字段形态：杭州、成都、苏州的 `birthplace/deathplace` 为区县或乡镇名（如「临安区」「郫都区」「姑苏村」），本地地名库无法按本城解析，故这些城市的名人模块不绘制点位，仅显示说明。
- 非预置城市的年代轴为 LLM 生成，`validateNarrativeYears` 已接入并会丢弃年表外年份的节点；已用 StepFun 官方接口实测真实生成，`verification` 仍为 `pending_human_review`。
- PRD 3.3 的「identity 3.5s 本地降级」路径未实现（v1.2 已确认保持：流式骨架屏 + 逐卷显影兜底等待体验）；PRD 90s 总耗时上限已由产品负责人放宽至 180s（v1.2，见 PRD 0.3），当前仍不设总熔断。StepFun 实测：identity 净耗时 3.62s（达标）/ 4.78s（超标，可用模型均为推理型），总耗时 150.6s / 164.7s（放宽后达标）。
- SSE/CORS 已收紧：生产只允许 `APP_ORIGINS` 中的来源，开发放行 localhost；公网部署仍需配置该变量并建议置于反向代理之后。
- 预置诗词选题重复度问题已处理：新增同题/同组诗/高频三字片段去重；成都「将赴成都草堂」组诗现最多 1 首、苏州太湖石题咏最多 2 首、西安同题应制诗不再重复。剩余少数主题相近但题名不同的诗仍保留。
- 未缓存城市在无 Key 时仍生成部分档案，与 PRD AC-14 文案不一致（设计取舍，产品负责人 2026-11-11 确认线上全程配置官方 Key）。
- 真实 LLM 已通过 StepFun 官方接口实测（镇江、宁波 8/8 卷）；天地图瓦片已实测 144 张、服务端检索 405 条，人工视觉走查与坐标偏移核对仍待用户完成。Commons 图片已完成本地抓取、展示实测与 22/22 程序化交叉核对，语义对应与许可适用性待人工复核。
- 非预置城市已改为「先侦察、再生成、后缓存」：维基百科/Wikidata/Open-Meteo/Tavily + 官方公报；诗词库覆盖 148 城（2,702 首），其余城市仍显示「此卷暂缺」；约 194 座城市暂无诗词。
- 六城 GDP/常住人口已补齐 2021–2025 官方公报序列（西安 2021 人口缺失保持 null）；`dataPulse` 气候仍为 ERA5 1991–2020 聚合值——实时天气由新增的 `WeatherStrip`（Open-Meteo current）单独提供。非预置城市若未检索到本城公报，GDP/人口全为 `null`。
- 城市侦察依赖运行时网络：首次生成一座新城市会多 10–30s（维基百科 + Wikidata + 两次检索 + 气候 + 公报抓取）；检索结果缓存 7 天、侦察结果缓存 30 天，失败负缓存 10 分钟；Tavily 中文检索质量一般，且国内访问维基百科通常需要 `HTTPS_PROXY`。
- 行政区轮廓默认来源（DataV.GeoAtlas）的授权与审图号未确认；公开上线前必须完成合规审校或替换来源（已实现 `--source=tianditu` 备选，manifest 标注 GCJ-02，不默认启用）。
- 国家文物局名录无公开 API，仍需人工下载官方名单后导入；当前文物名录来自 Wikidata 文保身份。
- Lighthouse 绝对分数本机不可信（Chrome 冷启动污染计时），AC-16 的达标判定需在正常机器按记录命令复跑。
- 一日路线快照回退的首个请求（本城无本地快照）需联网抓取 Wikidata，约 5–15s，之后走本地缓存；Wikidata 不可用时返回 404 并提示，前端显示「路线未能生成」降级卡。
- 知识小测验仍要求档案已生成（题目依赖 identity/chronicle/气候等档案事实字段，快照只有景点/文物/人物，不足以出题）。
- E2E 关键路径（12 条）以文档化人工脚本形式记录于 `e2e/README.md`，未接入自动化 CI。

## 7. 人工复核记录

### 7.1 复核说明

以下工作**只能由用户本人完成**，本文件不代填、不预设结论：

```bash
npm run setup
npm run verify
npm run dev
# 浏览器打开 http://localhost:5173
```

### 7.2 人工抽查记录表（证据列已由程序化自测填写；记录人/日期/结论留空待用户签字）

| 序号 | 抽查项 | 抽查方法 | 证据（程序化自测，2026-11-11） | 记录人 | 日期 | 结论 / 备注 |
|---|---|---|---|---|---|---|
| 1 | 西安城市人格与朝代叙事 | 阅读 01、02 卷，对照 `server/services/presetCurations.ts` | `npm run verify` 6/6 通过（含年代轴与模块完整性 0 错误）；档案 `verification=preset_manual` | | | |
| 2 | 杭州城市人格与朝代叙事 | 同上 | 同上 | | | |
| 3 | 成都城市人格与朝代叙事 | 同上 | 同上 | | | |
| 4 | 北京城市人格与朝代叙事 | 同上 | 同上 | | | |
| 5 | 苏州城市人格与朝代叙事 | 同上 | 同上 | | | |
| 6 | 洛阳城市人格与朝代叙事 | 同上 | 同上 | | | |
| 7 | 景点推荐理由与最佳季节 | 03 卷逐条阅读，核对「待考」标注 | verify 含坐标 180km 检查（0 错误）；landmarks 卷来源登记完整；扬州实测 24 景点 `partial` 发布 | | | |
| 8 | 文物故事与馆藏说明 | 04 卷逐条阅读，核对名录来源 | `relics_registry.json` 全量带来源；半坡遗址 P276 误标已勘误为「待考」；22/22 图片交叉核对见 7.4 | | | |
| 9 | 人物生平与城市关联 | 05 卷逐条阅读，核对 Wikidata 属性 | `entityVerifier` 校验 QID 与属性；LLM 输出泄漏字段即丢弃（FIGURE_LEAK）；安阳重建后 6 位人物无泄漏 | | | |
| 10 | 诗词注释与意象位置 | 06 卷抽查 3 首，对照诗词库原文 | verify 含「逐字诗词」与「诗词归属本城」检查（0 错误）；意象词全部逐字命中原文（`poetryVerifier.test.ts` +3 项） | | | |
| 11 | 城市味道、方言、非遗、节庆 | 07 卷阅读，核对来源与等级 | localSoul 卷来源登记完整；模块 Schema 校验通过 | | | |
| 12 | 六城主题色观感 | 切换六城，检查明暗模式可读性 | `theme.test.ts` 4 项 + `cityThemes.test.ts` 3 项（对比度达标、`ensureContrast` 生效）；夜间模式逐页截图 `.screenshots/a11y/dark-*.png`；2026-11-12 彩排暗色截图 `.screenshots/demo-20261112/32-dark-mode.png` | | | |
| 13 | 375 / 768 / 1280 实机观感 | 手机与桌面浏览器各浏览一遍 | CDP/ego-browser 三档实测无横向滚动、地图不拦截垂直滚动（截图 `.screenshots/a11y/resp-*.png`）；axe 应用自身 0 违规；2026-11-12 复测 5 张地图随视口逐张挂载、375 无横向滚动（`demo-20261112/34-mobile-landmarks.png`、`35-mobile-daytrip.png`） | | | |
| 14 | 真实 LLM 模式 | 填写 `LLM_API_KEY` 后生成一座未缓存城市 | StepFun 官方 Key 实测镇江、宁波两座新城 8/8 卷（AC-04）；连通脚本 `npm run test:llm` OK | | | |
| 15 | 天地图底图 | 填写 `TIANDITU_KEY` 后检查瓦片、注记与坐标偏移 | 程序化实测 144 张瓦片 + 服务端检索 405 条；2026-11-12 ego-browser 走查桌面 158 张 / 移动 106 张瓦片请求、无 WebGL 降级（`.screenshots/tianditu-20261112/desktop-landmarks.png`、`mobile-landmarks.png`）；注记/偏移的人工观感留用户 | | | |
| 16 | 文物图片与许可 | 对照 `server/data/relic_images.json` 抽查图片是否对应文物、署名与许可证是否准确 | `relic_images.json` × `relics_registry.json` 程序化交叉核对 22/22 条（逐张表见 7.4）：文件名、credit、license、Commons 来源页、对应 registryId/文物名/馆藏地全部有据；前端已展示 credit、许可证与 Commons 来源链接；2026-11-12 彩排实测文物卡「图上寻迹」联动（`demo-20261112/11-relic-map-focus-after-defer.png`）。「图片是否确为该文物」的语义核对与许可证适用性留用户签字 | | | |
| 17 | 行政区轮廓合规 | 核对 `client/public/geo/_manifest.json` 的来源授权与审图号，或替换为合规来源 | manifest 已记录来源 DataV.GeoAtlas 与「授权/审图号待确认」；`--source=tianditu` 备选源已实现并验证（GCJ-02 已标注，不默认启用）；2026-11-12 仍未取得授权确认，签字留空 | | | |

### 7.3 待抽查清单（供用户勾选）

- [ ] 六城叙事文本无事实性错误
- [ ] 所有「待考」标注位置合理，未被误读为已核实
- [ ] 预置档案与来源浮层一一对应
- [ ] 诗词原文、作者、朝代与本地诗词库一致
- [ ] 地图点位与真实地理位置一致（WGS84，无偏移）
- [ ] 移动端地图不拦截页面滚动
- [ ] 夜间模式文字对比度可读
- [ ] 真实 LLM 输出未出现候选之外的实体
- [ ] 天地图 Key 仅在浏览器端使用，LLM Key 未出现在网络响应中
- [ ] 文物图片与文物一一对应，作者署名与许可证准确
- [ ] 行政区轮廓来源已获授权并标注审图号（或已替换为合规来源）

> 再次强调：第 3 节所有「通过」均为程序化自测，不等同于人工复核通过。

### 7.4 文物图片逐张核对表（2026-11-11 程序化交叉核对，语义核对留用户签字）

数据来源：`server/data/relic_images.json` × `server/data/relics_registry.json`；前端 `RelicsModule` 已展示 credit / 许可证 / Commons 来源链接。22/22 条 registryId 均能在名录中找到对应文物。

| 本地文件 | 署名（credit） | 许可证 | Commons 来源页 | 对应 registryId | 对应文物（城市·名称） |
|---|---|---|---|---|---|
| CN-110000_Q133650.jpg | FishOil | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Beihai_Park.jpg | CN-110000:Q133650 | 北京·北海公园 |
| CN-110000_Q746736.jpg | N509FZ | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Bailin_Temple,_Beijing_(20240104152910).jpg | CN-110000:Q746736 | 北京·柏林寺 |
| CN-110000_Q798826.jpg | DF08 at English Wikipedia | Public domain | https://commons.wikimedia.org/wiki/File:GreatWall_Badaling.jpg | CN-110000:Q798826 | 北京·八达岭 |
| CN-110000_Q804054.jpg | Gene Zhang | CC BY 2.0 | https://commons.wikimedia.org/wiki/File:WhiteCloudpic1.jpg | CN-110000:Q804054 | 北京·白云观 |
| CN-110000_Q838166.jpg | Rolfmueller | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Babaoshan_cemetery_entrance_2012_01.jpg | CN-110000:Q838166 | 北京·八宝山革命公墓 |
| CN-320500_Q11052959.jpg | Haier7917 | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:常熟宋崇教兴福寺方塔.jpg | CN-320500:Q11052959 | 苏州·崇教兴福寺塔 |
| CN-320500_Q5600169.jpg | Lamassu Design Gurdjieff | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Canglang_ting_UNESCO.jpg | CN-320500:Q5600169 | 苏州·沧浪亭 |
| CN-320500_Q807059.jpg | Rolf Müller ( User:Rolfmueller ) | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Preciousbeltbridge.jpg | CN-320500:Q807059 | 苏州·宝带桥 |
| CN-320500_Q836041.jpg | Jakub Hałun | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:20090905_Suzhou_North_Temple_Pagoda_4611.jpg | CN-320500:Q836041 | 苏州·报恩寺塔 |
| CN-330100_Q10949410.jpg | Zhangzhugang | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Hangzhou_Baochengsi_Mahegela_Zaoxiang_20120518-02.jpg | CN-330100:Q10949410 | 杭州·宝成寺麻曷葛剌造像 |
| CN-330100_Q11116104.jpg | Siyuwj | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Stone_Pillars_of_Brahma_Temple,_2018-10-28_12.jpg | CN-330100:Q11116104 | 杭州·梵天寺经幢 |
| CN-330100_Q1401634.jpg | Doctoroftcm | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Feilaifeng_zaoxiang_7577.jpg | CN-330100:Q1401634 | 杭州·飞来峰造像 |
| CN-330100_Q15932495.jpg | Siyuwj | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Cangqian_Granary,_2017-11-25_05.jpg | CN-330100:Q15932495 | 杭州·仓前粮仓 |
| CN-330100_Q977249.jpg | Yumeto | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:20250418_Baochu_Ta.jpg | CN-330100:Q977249 | 杭州·保俶塔 |
| CN-410300_Q1264618.jpg | xiquinhosilva | CC BY 2.0 | https://commons.wikimedia.org/wiki/File:27467-Luoyang_(49085730123).jpg | CN-410300:Q1264618 | 洛阳·白马寺 |
| CN-510100_Q1069942.jpg | 螺钉 | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:成都的武侯祠.jpg | CN-510100:Q1069942 | 成都·成都武侯祠 |
| CN-510100_Q123375882.jpg | Kcx36 | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:青城山朝阳洞_04.jpg | CN-510100:Q123375882 | 成都·朝阳洞 |
| CN-510100_Q17025263.jpg | Nekitarc | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:成都博物馆藏商业街古蜀船棺合葬墓船棺.jpg | CN-510100:Q17025263 | 成都·成都古蜀船棺合葬墓 |
| CN-510100_Q4857451.jpg | BenBen | CC BY-SA 2.5 | https://commons.wikimedia.org/wiki/File:Baoguangsi.jpg | CN-510100:Q4857451 | 成都·宝光寺 |
| CN-610100_Q1073538.jpg | Gzy.29 | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:阿房宫遗址大门.jpg | CN-610100:Q1073538 | 西安·阿房宫 |
| CN-610100_Q15913387.jpg | Zhangzhugang | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Xi'an_Balujun_Banshichu_Jiuzhi_2014.01.04_09-44-59.jpg | CN-610100:Q15913387 | 西安·八路军西安办事处旧址 |
| CN-610100_Q806929.jpg | eecc | Public domain | https://commons.wikimedia.org/wiki/File:Banpo.jpg | CN-610100:Q806929 | 西安·半坡遗址 |

> 数据勘误（2026-11-11）：`CN-610100:Q806929` 半坡遗址的上游 Wikidata P276 误标为「和田市」（坐标 109.0475,34.2744 属西安），已在 `scripts/build_relics_registry.ts` 与 `server/services/cityFactSnapshot.ts` 中加入人工校正，该字段改为「待考」，不填入无法核验的替代值。其余 36 件候选中文物 14 件无 P18 图片，保持无图。
