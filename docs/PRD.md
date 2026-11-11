# CityLens 读城 — 交互式城市人文档案系统产品需求文档 (PRD)

| 文档版本 | 状态 | 产品负责人 | 适用阶段 | 更新日期 | 基线 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **v1.1.0** | 评审意见已合入，待研发 (Ready for Dev) | Senior PM & Architect | MVP 一期（中国地级及以上城市 + 海外架构预留） | 2026-11-10 | 在 v1.0.0 上修订 |

---

## 0. 版本变更说明（v1.0 → v1.1）

### 0.1 评审问题处理对照

| 编号 | v1.0 存在的问题 | v1.1 的处理 | 所在章节 |
| :--- | :--- | :--- | :--- |
| 1 | 别名表外键指向档案表，未生成的城市没有别名，联想与消歧无法工作；`city_id` 有三种写法 | 新增 `cities` 主表（由词典导入）；`city_id` 统一为 `CN-` + 6 位行政区划代码；别名表加唯一约束 | 5.2 |
| 2 | 缓存与生成缺并发、失败、滥用防护；单模块重试与整份 JSON 存一列矛盾 | 同城单飞、增量生成、失败冷却、预置城市保护、模块级存储与原子替换、全局限流与预算 | 2.2 / 3.5 / 5.2 |
| 3 | 坐标校验 180km 与验收 1.5km 矛盾；坐标系混用 | 坐标不再由大模型产出，由后端解析；统一 WGS84；记录坐标来源 | 3.2 / 5.3 |
| 4 | 只有诗词有核验，文物、人物、景点、来源无核验 | 实体必须来自事实上下文；自建文物名录；来源引用只能指向已检索条目；新增逐条 `sourceRefs` | 3.2 / 5.3 |
| 5 | “100% 原文匹配”会误杀真诗，静默替换后意象错配；作者与朝代合并存储 | 模型只从候选诗 ID 中选择，正文一律取自本地库；先选诗再生成意象；作者与朝代拆字段 | 3.2 / 5.3 |
| 6 | 首屏、检索超时指标有多套数字 | 统一为一张指标表，首屏路径不依赖在线检索与大模型 | 3.3 |
| 7 | 网络环境假设偏乐观（Wikipedia、百度百科、Google Fonts、境外模型） | 以离线事实快照为主，在线检索仅“尽力而为”；字体自托管；默认国内模型；底图源唯一 | 3.1 / 5.1 |
| 8 | 范围表述矛盾（地级 vs 敦煌；临安规则；词典来源不明） | 明确范围定义与特例白名单；区县名归并上级城市并提示；词典由脚本生成 | 1.2 / 5.4 |
| 9 | 验收自己证明自己 | 预置数据逐条标注来源与核验状态；自动校验脚本 + 产品负责人人工抽查，开发自测不计入通过 | 6 / 7 |
| 10 | 缺接口契约、路由、统计年份字段、图片字段、验收用例；技术选型“或”太多 | 新增 API 与 SSE 协议、路由、`Fact` 结构、图片开关、AC-11～AC-19；选型全部定死 | 0.2 / 3.4 / 5.3 / 7 |
| 11 | 数量范围不一致、例子不当、史实表述、主题色对比度、EventSource 用法、LaTeX | 逐项修正（见 7.2、4.2、3.4，全文去除 LaTeX 写法） | 全文 |

### 0.2 已定决策（原 PRD 中“或”的取舍）

| 决策项 | 一期选定 | 备注 |
| :--- | :--- | :--- |
| 前端 | React 18 + TypeScript 5（strict）+ Vite 5 + Tailwind CSS | |
| 后端 | Node.js 20 LTS + Fastify + TypeScript | 不再保留 Express 选项 |
| 数据库 | SQLite（better-sqlite3）+ 仓储接口层 | PostgreSQL 放入二期，不使用 Prisma |
| 工程组织 | npm workspaces：`client`、`server`、`shared` | `shared` 放 Zod Schema 与类型 |
| 地图渲染 | MapLibre GL JS | 不使用高德 JS 地图 |
| 底图与地名搜索 | 天地图（环境变量 `TIANDITU_KEY`） | 无 Key 时不加载底图瓦片，仅绘制行政区轮廓 GeoJSON 与宣纸底色 |
| 坐标系 | WGS84，格式 `[lng, lat]` | 全链路唯一，禁止混用 GCJ-02 |
| 大模型 | 默认 DeepSeek（OpenAI 兼容接口），可通过环境变量切换通义千问等兼容服务 | 优先 `json_schema`，不支持时退化为 `json_object` + Zod 校验 + 最多 2 次修复重试 |
| 流式通道 | SSE，客户端用 fetch 流（`@microsoft/fetch-event-source`）+ `AbortController` | 不使用原生 `EventSource`，因为需要 POST 与自定义请求头 |
| 字体 | 自托管并子集化，不引用 Google Fonts | 影响首屏体积与 Lighthouse |
| 图片 | 一期默认关闭（`ENABLE_IMAGES=false`） | 开启时仅允许 Wikimedia Commons 并记录许可证 |

---

## 1. 【产品定位与功能范围（要做什么）】

### 1.1 核心价值主张 (Value Proposition)
**CityLens 读城** 是一款结合“严肃史料检索（RAG）”与“滚动叙事（Scrollytelling）”的交互式城市认知 Web 应用。用户输入任意城市名（支持古称、别名、拼音、英文），系统在数秒内呈现或流式生成一份兼具历史纵深与现代活力的八维全景档案，让用户在 **5–10 分钟** 内看懂一座城的来龙去脉与精神底色。

#### 目标用户群体与核心痛点

| 目标用户画像 | 核心使用场景 | 现有方案痛点 | CityLens 解决方案 |
| :--- | :--- | :--- | :--- |
| **深度文化旅行者** | 出发前或高铁、航班途中，快速建立目的地整体历史与空间认知 | 小红书、马蜂窝多为碎片化打卡点；百度百科词条冗长，缺乏空间与时间联动 | 一页式滚动叙事，历史沿革、文物、诗词与地理坐标双向联动 |
| **人文历史与地理爱好者** | 探索建城史、古今地名演变、名宦游历轨迹与诗词意象 | 史料散落在地方志、文保名录与古籍库中，检索门槛高 | 拖动式朝代时间轴 + 经核验的诗词地理映射，呈现“古今叠压”的城市肌理 |
| **教育工作者与学生** | 历史、地理、语文跨学科备课或拓展阅读 | 缺乏文史地融合的高质量数字教具 | 结构化八大模块，核心事实均附出处，可溯源核查 |

### 1.2 范围定义与 MVP 功能清单

#### 城市范围定义（一期）
- **收录范围**：民政部行政区划代码表中的**地级及以上**行政区（直辖市、地级市、自治州、地区、盟，约 333 个）。
- **特例白名单**：另设不超过 20 个“文旅知名县级市”（如敦煌、曲阜、都江堰、阆中），由产品负责人确认清单，使用各自的 6 位行政区划代码。
- **区县及以下**：不独立成城。输入区县名时，归并到上级城市并给出一条提示（例如“临安区是杭州市辖区”）。
- **词典来源**：`city_dictionary.json` 由脚本从行政区划代码表生成，拼音与英文名由脚本补全；古称与别称只人工整理前 60 座名城，其余城市至少保证标准名、拼音、英文名可检索。
- **海外预留**：`country_code` 字段与 `{ISO 国家码}-{本地代码}` 的 `city_id` 格式，一期不收录海外城市。

#### 功能清单与优先级

| 模块分类 | 功能模块名称 | 优先级 | 一期必做的功能边界 | 明确不做 |
| :--- | :--- | :--- | :--- | :--- |
| **基础引擎** | **名称规范化与消歧引擎** | **P0** | 标准名、古称/别称、拼音（`xian`）、英文名（`Xi'an`）映射到唯一 `city_id`；同拼音、同名、形近字弹出消歧选择；区县名归并上级城市并提示 | 不支持乡镇、街道级单元 |
| **基础引擎** | **持久化缓存与流式编排** | **P0** | SQLite 持久化；命中缓存 < 500ms 返回并标记“已为你复用”；未命中通过 SSE 按模块流式生成并落库 | 不支持多用户协同编辑 |
| **基础引擎** | **生成任务编排** | **P0** | 同城单飞、增量生成（已通过校验的模块不重复生成）、失败冷却、限流、每日调用预算、预置城市保护 | 一期不做分布式任务队列 |
| **基础引擎** | **离线事实快照与核验管线** | **P0** | 构建期脚本生成事实快照、古诗词核验库、文物名录、地名库；运行期用于事实上下文与校验 | 不做实时全网抓取 |
| **内容模块 01** | **城市名片 (City Identity)** | **P0** | 标准名、古称/别称、坐标、面积、常住人口、气候类型、行政区划概览、一句话城市性格、城市专属主题色 | 不展示实时天气与空气质量 |
| **内容模块 02** | **前世今生 (Chronicle)** | **P0** | 朝代时间轴（5–8 个关键历史切片），联动切换当时城名、叙事与城址中心坐标 | 不做逐年编年史 |
| **内容模块 03** | **景点地图 (Landmarks)** | **P0** | 必去地标 4–6 个 + 小众历史秘境 2–4 个，含最佳季节、推荐理由；卡片与地图双向联动 | 不做订票、OTA 比价、导航路线 |
| **内容模块 04** | **文物与博物馆 (Relics)** | **P0** | 4–6 件代表性文物、遗址或馆藏重器（名录不足时按实际条数），含年代、馆藏地、保护级别与故事 | 不做 3D 文物建模 |
| **内容模块 05** | **历史名人 (Figures)** | **P0** | 4–6 位籍贯于此或在此留下重要轨迹的历史人物，含生平高光与城市关联、遗迹坐标 | 不展示演艺明星与争议人物 |
| **内容模块 06** | **诗句中的 Ta (Poetics)** | **P0** | 3–5 首经本地古籍库核验的历代名篇，含原文、作者、朝代、创作背景与意象地点联动 | **严禁大模型默写诗词**；候选诗全部取自本地库 |
| **内容模块 07** | **城市味道 (Local Soul)** | **P1** | 美食、方言、非遗、节庆民俗；界面统一标注“AI 整理” | 不做餐厅商户推荐 |
| **内容模块 08** | **数说城市 (Data Pulse)** | **P1** | 近 5 年 GDP 与常住人口走势、月均气温与降水双轴图；所有指标标注单位、口径、统计年份 | 不做实时金融或房产数据 |
| **用户工具** | **收藏、足迹与缓存刷新** | **P1** | LocalStorage 收藏夹与最近浏览（最多 20 条）；单模块或全量“重新生成”（二次确认） | 一期不做账号登录 |
| **二期规划** | **扩展能力预留** | **P2** | 双城对比、“如果只有一天”路线、知识小测验、长图海报；一期仅在数据结构与路由层预留 | 不纳入一期验收 |

---

## 2. 【交互逻辑与用户体验（怎么交互）】

### 2.1 核心用户旅程 (User Journey)

```
[进入首屏] ──> [水墨粒子画布 + 极简搜索框 / 热门城市胶囊]
                    │
        (输入关键词，防抖 300ms 实时联想)
                    ▼
           [提交查询 / 点击推荐]  → GET /api/cities/search
                    │
                    ├─> status=none      ──> [水墨空状态 + 推荐名城]
                    ├─> status=ambiguous ──> [弹出“城市消歧选择卡”]
                    ▼ (status=exact，得到唯一 city_id；区县名附带 hint 提示)
           [路由跳转 /city/:cityId]  → GET /api/cities/:cityId
                    │
         ┌──────────┴──────────┐
         ▼ 200 (Cache Hit)     ▼ 404 NOT_GENERATED
  [< 500ms 完整渲染]      ├─ 无 LLM Key ──> [“尚未收录”状态页 + 预置名城入口]
  [顶部“已为你复用”印章]  └─ 有 Key ──> POST /api/cities/:cityId/generate (SSE)
         │                     │  meta 事件 < 300ms：城名书写动效
         │                     │  identity 事件 ≤ 3.5s：名片 + 主题色
         │                     │  其余模块逐个“水墨显影”挂载
         └──────────┬──────────┘
                    ▼
        [沉浸式滚动叙事 (Scrollytelling)]
         ├─> 交互 1：拖动“前世今生”朝代滑块 ──> 城名、叙事、地图城址同步切换
         ├─> 交互 2：点击景点/文物/名人卡片 ──> 地图 flyTo 并展开 Popup；点地图 Marker ──> 卡片滚动居中并高亮
         ├─> 交互 3：点击诗词卡片展开 ──> 悬停意象词显示批注，地图同步高亮对应点位
         ├─> 交互 4：侧边“卷轴目录” ──> 平滑锚点跳转
         └─> 交互 5：点击“重新生成” ──> 二次确认 ──> 增量或强制刷新并重新流式生成
```

### 2.2 状态流转与系统反馈规范 (State Machine)

| 交互动作 / 触发条件 | 系统状态变迁 | 界面实时视觉反馈 | 防呆与边界控制 |
| :--- | :--- | :--- | :--- |
| **搜索框输入字符** | `IDLE` → `SUGGESTING` | 延迟 300ms 触发联想，下拉格式：`西安 (Xi'an) · 匹配古称：长安/镐京` | 最大长度 30 字符；过滤特殊脚本字符（防 XSS 与注入） |
| **提交同拼音/同名/形近词**（如 `suzhou`、`taizhou`、`fuzhou`） | `SUGGESTING` → `DISAMBIGUATING` | 弹出宣纸质感模态框，列出候选（如 `江苏省苏州市` 与 `安徽省宿州市`），展示省份与一句话简介 | 点击遮罩或按 `ESC` 退回修改；形近字拼写错误（如“毫州”）自动纠正为“亳州”并提示 |
| **提交区县名或古都旧称**（如 `临安`、`Lin'an`） | `SUGGESTING` → `READY` | 直接进入杭州，页面顶部浮现提示：“临安区为杭州市辖区；南宋都城临安即今杭州” | 区县名不生成独立档案，不弹消歧 |
| **缓存命中加载** | `LOADING_CACHE` → `READY` | 顶部朱砂印章微标签：“**藏书阁已收录 · 为你秒速展卷**”（停留 3 秒后渐隐为常驻生成时间铭牌） | 该状态下禁止发起任何大模型请求 |
| **缓存未命中且有 LLM Key** | `STREAMING_INIT` → `STREAMING_MODULES` → `READY` | 1. `meta` 事件（本地数据）< 300ms 上屏城名书写动效；<br>2. `identity` 事件 ≤ 3.5s 上屏，主题色平滑过渡；<br>3. 其余模块以“宣纸水墨呼吸骨架屏”占位，每个模块通过校验后触发“墨迹晕开”显影 | 生成期间锁定“重新生成”；切换城市时前端 `AbortController.abort()` 断开旧流，**服务端生成任务不取消**，继续完成并落库 |
| **缓存未命中且无 LLM Key** | `NOT_GENERATED` → `UNAVAILABLE` | “此城尚未收录”状态页，提供预置名城入口与配置说明 | “重新生成”按钮置灰并提示原因 |
| **同城已有生成任务进行中** | `STREAMING_INIT` → `ATTACHED` | 并入既有任务：回放已完成模块，继续接收后续事件；提示“已有读者正在为此城展卷，已为你并入” | 不新建任务，不重复调用大模型 |
| **拖动“前世今生”时间轴** | `ERA_ACTIVE(index)` | 游标吸附到朝代节点（阻尼微动效）；背景浮现古称水印；地图缩放并高亮该时期城址坐标 | 连续拖动时用 `requestAnimationFrame` 节流地图重绘 |
| **地图点位与卡片联动** | `MAP_CARD_SYNC` | 点卡片：描边高亮，地图 `flyTo`（duration 1200ms，curve 1.42），Marker 放大弹出简卡；点 Marker：卡片列表 `scrollIntoView` 居中并呼吸高亮 | 无精确坐标的条目标注“全域印记”，点击时地图复位到城市中心 |
| **点击诗词意象词** | `POEM_IMAGE_FOCUS` | 地理意象词（如“寒山寺”）悬停或点击显示批注气泡，并高亮关联点位 | 泛指意象（如“明月”）只展示文学批注，不触发地图跳转 |
| **点击“重新生成”** | `READY` → `CONFIRM_REGEN` → `STREAMING_INIT` | 确认框：“当前档案生成于 `YYYY-MM-DD HH:mm`。重新生成将重新检索史料并替换通过校验的模块（约需 15–30 秒），未通过校验的模块保留旧内容。是否确认？” | 同一 IP 对同一城市每 5 分钟最多强制刷新 1 次（返回 429 与剩余秒数）；**预置城市受保护**，无管理令牌时返回 `PRESET_LOCKED` |
| **模块生成失败或超时** | `STREAMING_*` → `PARTIAL` | 已成功渲染的模块保留；失败模块显示“史料卷宗调取受阻”卡片，提供【单独重试该模块】与【切换预置名城】 | 单模块重试走 `generate` 接口的 `modules` 参数，只更新该模块 |
| **整体生成失败** | `STREAMING_*` → `ERROR_FALLBACK` | 通过校验的模块不丢弃，但档案状态为 `unpublished`，不对其他访客提供；用户看到失败提示与重试入口 | 失败冷却 10 分钟，期间同城请求返回 `COOLDOWN` 与剩余秒数，不再调用大模型 |

### 2.3 数据展示与可视化规范
1. **数据溯源角标**：名片数据、文物、历史事件、名人旁提供轻量 `[源]` 徽章，悬停或点击展示来源。徽章只能引用档案 `sources` 列表中真实检索到的条目，**不得出现模型自行编写的典籍或网址**。
2. **不确定信息诚实标注**：权威库中缺失或存在争议的字段，统一渲染为浅灰边框的 `【待考】` 标签，绝不展示模型猜测值。
3. **AI 整理标注**：城市味道模块、诗词“创作背景”、各模块叙事性文案旁标注“AI 整理”；页脚固定展示“内容由 AI 整合，请以权威资料为准”。
4. **图表动态呈现（数说城市）**：
   - GDP 与人口双视图：折线图采用主题色渐变填充；Tooltip 显示数值、单位（亿元、万人）、口径与统计年份。
   - 气候水文图：1–12 月平均气温（平滑曲线，单位 °C）与平均降水量（水墨柱状图，单位 mm）双 Y 轴；图注标注统计时段（如 1991–2020）。

---

## 3. 【技术架构与实现底线（技术底线）】

### 3.1 技术栈选型与约束

| 架构层级 | 选型 | 核心职责与工程约束 |
| :--- | :--- | :--- |
| **前端框架** | React 18 / TypeScript 5（`strict: true`）/ Vite 5 | 函数组件 + 自定义 Hooks 解耦业务逻辑 |
| **样式与主题** | Tailwind CSS + CSS Variables | 动态注入 `--city-primary`、`--city-secondary`、`--city-accent`、`--bg-canvas` 等变量，切换城市与明暗主题零闪烁 |
| **动效** | GSAP（ScrollTrigger）+ Framer Motion + Canvas 2D | GSAP 负责视差与时间轴钉住；Framer Motion 负责卡片展开、模态框与显影；Canvas 负责首屏水墨粒子与书写笔触 |
| **地图与图表** | MapLibre GL JS + Apache ECharts 5（按需引入） | 统一封装 `MapController`；底图使用天地图，行政区轮廓使用经合规审校的 GeoJSON；ECharts 只引入柱状与折线 |
| **字体** | Noto Serif SC（标题）、Inter、JetBrains Mono，全部自托管 | 中文字体做子集化与分包；`font-display: swap`；不使用任何外部字体 CDN |
| **后端** | Node.js 20 LTS + Fastify + TypeScript | RESTful API 与 SSE 端点；统一管理环境变量；任何私钥严禁进入前端包 |
| **数据库** | SQLite（better-sqlite3）+ 仓储接口层 | 开箱即用；所有 SQL 收敛在仓储层，为二期切换 PostgreSQL 留口 |
| **大模型与校验** | 默认 DeepSeek（OpenAI 兼容）+ Zod | 结构化输出 + 服务端 Zod 校验；不支持 `json_schema` 时退化为 `json_object` + 最多 2 次修复重试 |
| **工程组织** | npm workspaces（`client`、`server`、`shared`） | `shared/schema.ts` 为前后端共用的 Zod Schema 与类型唯一来源 |

### 3.2 核心逻辑真实性底线（严禁视觉欺骗与幻觉造假）

#### 一、总原则
1. **模型只做“选择”与“叙事”，不做“事实创造”**：实体（景点、文物、人物、诗词）只能从事实上下文给出的候选中选取；名称、坐标、年份、数值、馆藏归属等事实字段由系统从权威数据填入，不接受模型自由输出。
2. **来源可追溯**：每个实体与关键事实带 `sourceRefs`，只能指向 `sources` 列表里真实存在的条目。没有任何非模型来源的实体整条丢弃。
3. **宁缺毋滥**：核验通不过的内容剔除或标注“待考”，不用看似合理的内容充数。

#### 二、四段式管线

| 阶段 | 内容 | 说明 |
| :--- | :--- | :--- |
| **阶段 0：构建期（一次性脚本）** | 生成 `city_dictionary.json`、`verified_poetry_corpus.json`、`relics_registry.json`、`place_gazetteer.json`、`fact_snapshot/{cityId}.json` | 快照脚本需在可访问 Wikidata 的环境运行一次，产物提交入库；若无法联网，须在交付文档中如实披露，预置数据降级为“人工整理 + 待复核” |
| **阶段 1：事实上下文（运行期）** | 读取本地词典、快照、诗词候选与文物名录组装 Fact Context；在线 Wikipedia/Wikidata 检索作为补充，硬超时 2500ms，失败即跳过，不算错误 | **首屏路径只依赖本地数据**，不等待在线检索与大模型 |
| **阶段 2：结构化叙事** | 按模块调用大模型，输入候选实体列表，输出“选中的实体 ID + 叙事文本” | 见下方各模块约束 |
| **阶段 3：校验与落库** | Zod 结构校验、实体校验、诗词校验、坐标解析、年份与数值校验，通过后按模块落库 | 校验失败的模块不落库，计入 `module_error` |

#### 三、各模块生成与校验矩阵

| 对象 | 候选来源 | 模型允许输出 | 系统强制规则 | 失败处理 |
| :--- | :--- | :--- | :--- | :--- |
| **诗词** | 本地诗词库按“城市名 + 古称 + 快照地标名”检索得到的候选（含 `poemId`、原文） | 选中的 `poemId`、创作背景、意象注释 | 标题、作者、朝代、`lines` 一律取自库；先选诗，再基于真实原文生成意象；`imageryMap[].word` 必须在归一化后的原文中出现；泛指意象标记 `isGeographic=false` | 意象词不在原文中则丢弃该意象；不足 3 首则降级展示并标注 |
| **景点** | 快照中的实体（带 `entityId`）与国保名录 | 选中的 `entityId`、推荐理由、最佳季节 | 名称与地名取自实体；坐标由坐标解析器产出（见下）；无来源则丢弃 | 坐标解析失败则 `coordinates=null`，卡片标“全域印记” |
| **文物** | 自建 `relics_registry.json`（国保名录 + 禁止出境展览文物名录 + 各大博物馆公开藏品）与快照中带文保属性的实体 | 选中的 `registryId`、故事 | 名称、年代、馆藏地、保护级别一律覆盖为名录值；名录之外的文物不得出现 | 名录不足时按实际条数展示，最少 1 件；0 件则模块为 `degraded` 并显示“名录收录有限” |
| **人物** | 快照中与该城（含古称、所辖）有出生地、逝世地、工作地或任职关联的实体 | 选中的 `entityId`、生平高光、城市关联叙述 | 生卒年取自实体，缺失为“待考”；`evidence` 记录关联属性；人物与城市无属性关联则丢弃 | 同上 |
| **年表** | 快照与本地沿革要点 + 固定朝代年表 `dynasties.json` | 朝代选择与叙事文本 | 起止年份由系统按朝代年表填充；叙事中出现的具体年份必须出现在 Fact Context 中，否则改写为朝代级表述或标“待考” | 校验失败的节点丢弃，节点数少于 5 则模块为 `degraded` |
| **统计与气候** | `stats_baseline.json`、快照中的统计值、气候标准值库 | 不输出任何数值 | 数值全部由系统填入，附单位、口径、统计年份；数量级校验（如常住人口 0.1–5000 万） | 缺失年份为 `null`，整模块无数据则显示“待考”空状态 |
| **城市味道** | 无强校验源 | 美食、方言、非遗、节庆文案 | 非遗等级只能取自快照中的名录，否则为“待考”；整模块带 `aiCurated=true` | 界面统一标注“AI 整理” |

#### 四、坐标解析器（`coordResolver`）
1. 解析顺序：本地地名库 `place_gazetteer.json` → 天地图地名搜索（需 `TIANDITU_KEY`）→ 返回 `null`。
2. 所有坐标为 WGS84 的 `[lng, lat]`；记录 `coordSource`（`local_gazetteer` / `tianditu` / `wikidata` / `preset_manual`）。
3. 边界校验：解析结果必须落在城市中心 180km 范围内，且名称匹配；否则丢弃为 `null`。**大模型输出的坐标一律忽略。**
4. 精度验收：预置城市坐标必须来自地名库或人工核对，与权威地图同名地物的偏差小于 1.5km；解析自天地图的结果仅要求通过 180km 边界与名称匹配，精度在验收时抽查。

#### 五、真缓存与增量生成
- 缓存主键为 `city_id`（如 `CN-610100`）。命中时后端日志必须打印 `[CACHE HIT] city_id=CN-610100 latency=12ms`，**命中时绝对禁止调用大模型**。
- **增量生成**：模块已 `ok` 的不重复生成（除非 `force`）；失败模块在冷却结束后只重跑失败部分，避免重复烧钱。
- **发布规则**：`identity` 模块通过校验且通过校验的模块数不少于 5 个，档案才标为 `complete` 或 `partial` 并对其他访客可见；否则为 `unpublished`。
- **原子替换**：重新生成时，每个模块通过校验后在事务内替换旧版本并递增 `data_version`；未通过的模块保留旧内容。重新生成期间其他访客仍读取旧缓存。

### 3.3 性能、合规与无障碍底线

| 维度 | 唯一指标 |
| :--- | :--- |
| **缓存命中** | 命中本地缓存或预置数据时，TTFB < 100ms，完整 JSON < 500ms |
| **流式首屏** | SSE 连接建立 < 300ms；`meta` 事件（本地数据：城名、坐标、别名）< 300ms 上屏；`identity` 模块 ≤ 3.5s 上屏 |
| **identity 降级** | 若大模型在 3.5s 内未返回，先用本地基础事实上屏 `identity`（`status=degraded`、默认墨色主题），主题色与一句话性格随 `theme` 事件稍后到达 |
| **在线检索** | Wikipedia/Wikidata 硬超时 2500ms，仅服务阶段 2 的补充，不进入首屏路径 |
| **大模型** | 单模块超时 25s；单次生成总上限 90s |
| **动画** | 首屏粒子与滚动视差约 60fps；检测到 `prefers-reduced-motion: reduce` 或帧率持续低于 30fps 时，自动关闭粒子扰动与复杂视差，降级为透明度渐变 |
| **响应式** | Desktop（≥ 1280px）、Tablet（768–1279px）、Mobile（375–767px）三种视口，无横向滚动条、无文字重叠 |
| **Lighthouse** | 预置城市页，生产构建：Desktop Performance ≥ 80，Mobile Performance ≥ 70 |
| **地图合规** | 展示中国地图时在容器右下角显示数据来源与审图号声明；行政区 GeoJSON 须经合规审校，开发前确认其授权条款 |
| **字体与第三方资源** | 字体自托管；不加载 Google Fonts、境外 CDN；所有 API 密钥仅在服务端 |

### 3.4 接口契约与路由

#### 前端路由

| 路由 | 说明 |
| :--- | :--- |
| `/` | 首页：搜索框、热门城市、最近浏览与收藏入口 |
| `/city/:cityId` | 城市档案页，`cityId` 形如 `CN-610100`；可分享、可作为收藏键；支持锚点 `#poetics` 等 |
| `*` | 404 空状态（“版图中暂未寻获此页”） |

#### REST 与 SSE 接口

| 方法与路径 | 说明 | 成功响应 | 主要错误码 |
| :--- | :--- | :--- | :--- |
| `GET /api/cities/search?q=` | 名称规范化与联想 | `{status: "exact"/"ambiguous"/"none", candidates: [{cityId, name, province, matchedAlias, matchType, summary}], hint?}` | `400 INVALID_QUERY` |
| `GET /api/cities/hot` | 热门与预置城市列表 | `{cities: [{cityId, name, province, isPreset}]}` | — |
| `GET /api/cities/:cityId` | 读取缓存档案 | `200 {fromCache: true, meta, identity, chronicle, landmarks, relics, figures, poetics, localSoul, dataPulse, sources}`（缺失模块为 `null`） | `404 NOT_GENERATED`、`404 CITY_NOT_FOUND`、`429/503 COOLDOWN` |
| `POST /api/cities/:cityId/generate` | 生成、补全或重新生成；请求体 `{force?: boolean, modules?: string[]}`；响应为 SSE | 见下方事件协议 | `403 PRESET_LOCKED`、`429 REGEN_COOLDOWN`、`429 RATE_LIMITED`、`503 NO_LLM_KEY`、`503 BUDGET_EXCEEDED` |
| `GET /api/health` | 健康检查（含 LLM Key、天地图 Key 是否配置） | `{ok, llmConfigured, mapConfigured}` | — |

单模块重试 = `generate` 且 `modules` 只含该模块；重新生成 = `generate` 且 `force: true`。`force` 对预置城市需请求头 `x-admin-token` 与环境变量 `ADMIN_TOKEN` 一致。

#### SSE 事件协议

| 事件 | 载荷 | 说明 |
| :--- | :--- | :--- |
| `meta` | `{seq, cityId, standardName, province, aliases, center, isPreset, jobId}` | 本地数据，首个事件 |
| `module` | `{seq, name, status: "ok"/"degraded", data, sources}` | `name` 取值：`identity`、`chronicle`、`landmarks`、`relics`、`figures`、`poetics`、`localSoul`、`dataPulse` |
| `theme` | `{seq, light, dark}` | 主题色（`identity` 降级时稍后到达） |
| `module_error` | `{seq, name, code, retryable}` | `code`：`LLM_TIMEOUT`、`SCHEMA_INVALID`、`VERIFY_FAILED`、`NO_FACTS` |
| `done` | `{seq, cityId, status: "complete"/"partial"/"unpublished", failedModules, generatedAt, dataVersion}` | 流结束 |
| `error` | `{seq, code, message, retryAfterSec?}` | 致命错误，流终止 |
| `ping` | `{}` | 每 15s 心跳 |

客户端用 fetch 流解析事件，切换城市或卸载页面时调用 `AbortController.abort()`。

### 3.5 生成任务编排与反滥用

| 机制 | 规则 |
| :--- | :--- |
| **同城单飞** | `generation_jobs` 表对 `status='running'` 的任务建立按 `city_id` 的唯一约束；后到的请求并入同一广播，回放已完成模块（一期单进程；多实例需共享锁，列入二期） |
| **失败冷却** | 档案 `unpublished` 后同城 10 分钟内不再生成，返回 `COOLDOWN` 与剩余秒数；冷却结束后增量重试 |
| **重新生成限流** | 同一 IP 对同一城市每 5 分钟最多 1 次 |
| **新城市生成限流** | 同一 IP 每小时最多触发 10 个新城市的生成 |
| **每日预算** | 环境变量 `LLM_DAILY_CALL_LIMIT`（默认 500）；超限返回 `BUDGET_EXCEEDED`，界面引导至预置名城 |
| **预置城市保护** | `is_preset=1` 的城市默认禁止重新生成，需 `ADMIN_TOKEN` |
| **无 Key 行为** | 未配置 LLM Key 时禁用所有生成与重新生成入口，已缓存与预置城市功能完整 |
| **无 Key 行为（v1.1.1 注记，2026-11-11 产品负责人确认）** | 线上运行全程配置官方 LLM Key；无 Key 时的「本地快照生成（degraded）」分支仅作开发自测用途保留，不面向线上访客。PRD 原「未缓存城市显示尚未收录整页」与实现的差异按此取舍执行，并在 `FEATURES_AND_VERIFICATION.md` AC-14 记录 |
| **隐私** | IP 加盐哈希后存储，不保存原始 IP |
| **输入安全** | 搜索词长度限制 30，服务端白名单字符校验；SQL 全部参数化 |

---

## 4. 【UI 布局与视觉规范（视觉风格）】

### 4.1 视觉基调：“东方美学 × 数字动感”
以宋明刻本的疏朗留白与宣纸水墨的温润质感为骨，以现代数字媒体的流畅微交互与数据可视化为魂。做到“雅致而不陈腐，动感而不喧宾夺主”。

### 4.2 色彩系统与城市专属动态主题色

#### 1. 全局基础明暗主题

| 语义变量名 | 日间宣纸模式 | 夜间墨色模式 | 用途 |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#F7F4ED`（暖白宣纸色，3% 噪点纹理） | `#121316`（徽墨深灰黑，微弱丝绢纹理） | 页面主背景 |
| `--bg-surface` | `rgba(255, 253, 248, 0.82)` | `rgba(28, 30, 36, 0.82)` | 卡片、浮层（配合 `backdrop-filter: blur(12px)`） |
| `--text-primary` | `#1E1E1E` | `#EAE6DF` | 标题与核心正文 |
| `--text-secondary` | `#5A564C` | `#A39E93` | 辅助说明、纪年、坐标轴 |
| `--border-subtle` | `rgba(30, 30, 30, 0.12)` | `rgba(234, 230, 223, 0.12)` | 描边与分割线 |

#### 2. 城市专属主题色（每座城市明暗各一套）
档案中的 `meta.themePalette` 为 `{light: {primary, secondary, accent}, dark: {primary, secondary, accent}}`，前端通过 CSS 变量过渡（`transition: background-color 0.8s ease, color 0.8s ease`）。下表为六座预置城市的**日间基准色**，夜间版本由预置数据单独给出（整体提亮）。

| 城市 | 主色 `--city-primary` | 辅色 `--city-secondary` | 点缀色 `--city-accent` | 意象 |
| :--- | :--- | :--- | :--- | :--- |
| **西安** | `#8C3F2B` 秦砖赭石 | `#4A4E54` 城墙青灰 | `#C89B40` 盛唐鎏金 | 厚重皇城、黄土高坡与青铜秦砖 |
| **杭州** | `#3B6E6C` 秘色青瓷 | `#7A8B8B` 西湖烟雨灰 | `#D46A6A` 曲院荷红 | 江南烟雨、越窑青瓷 |
| **成都** | `#B83B2A` 川剧朱红 | `#3A6B4C` 竹海翠绿 | `#E09F3E` 盖碗茶金 | 市井烟火、翠竹茶馆 |
| **北京** | `#9E2A2B` 宫墙朱砂 | `#5C6468` 胡同青砖 | `#D9A036` 琉璃明黄 | 紫禁城规制与胡同肌理 |
| **苏州** | `#4A6572` 黛瓦水墨 | `#8E9B97` 太湖石灰 | `#B55D4C` 枫桥丹枫 | 粉墙黛瓦、苏式园林 |
| **洛阳** | `#9B2948` 魏紫牡丹 | `#5E5346` 龙门岩灰 | `#C59B27` 唐三彩釉黄 | 十三朝古都、国色牡丹 |

**对比度规则（WCAG AA）：**
- 作为文字色的 `--city-primary`、`--city-secondary` 与当前背景的对比度必须 ≥ 4.5:1。
- `--city-accent` **仅用于装饰性填充与描边，不承载文字**；用于图表线条、图标等非装饰图形时需 ≥ 3:1。
- 粗算示例：西安点缀色 `#C89B40` 在日间底色上约 2.3:1，赭石 `#8C3F2B` 在夜间底色上约 2.5:1，均不达标，因此必须分明暗两套并经校验。
- 前端提供 `ensureContrast(color, background, minRatio)` 函数：不达标时按 HSL 明度每次 3% 向可读方向调整，直至达标（日间变深，夜间变亮）。预置城市的六套配色须有单元测试覆盖。

### 4.3 字体层级规范 (Typography)

| 层级 | 字体族栈 | 字号与行高（Desktop / Mobile） | 细节 |
| :--- | :--- | :--- | :--- |
| **首屏巨幅城名** | `'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', serif` | 72px (1.1) / 44px (1.15) | 字重 700，字间距 0.15em，书法笔触遮罩或 Canvas 渲染 |
| **章节主标题 (H2)** | `'Noto Serif SC', 'Songti SC', serif` | 36px (1.3) / 26px (1.35) | 字重 600，配古籍卷标序号（`壹 · 城市名片`、`贰 · 前世今生`） |
| **卡片标题与诗句** | `'Noto Serif SC', serif` | 20px (1.6) / 18px (1.6) | 诗词居中，意象词虚线下划线 `text-underline-offset: 6px` |
| **叙事正文与说明** | `'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif` | 16px (1.75) / 15px (1.7) | 每行 35–45 个汉字宽 |
| **数据指标与年份** | `'JetBrains Mono', 'DIN Alternate', monospace` | 24–32px (1.2) | `font-variant-numeric: tabular-nums` |

所有字体文件自托管并子集化；首屏城名使用的字形按需加载。

### 4.4 界面空间布局与响应式规则

```
+-----------------------------------------------------------------------------------+
| [Top Bar]  CityLens 读城 Logo  |  快捷搜索框 (Cmd+K)  | 收藏夹 | 历史 | 宣纸/墨色 |
+-----------------------------------------------------------------------------------+
|                         [Hero Section: 首屏水墨粒子画布]                          |
|                                   西   安                                         |
|                        "十三朝古都，半部中国史的立体切片"                         |
|                   [长安] [镐京] [京兆] · 34.26°N, 108.94°E                        |
+-----------------------------------------------------------------------------------+
| [模块 01：城市名片 (Bento Grid 6格：位置/面积/人口/气候/区划/主题色卡)]           |
+-----------------------------------------------------------------------------------+
| [模块 02：前世今生 (全宽沉浸式：古今地图/背景视差 + 朝代可拖拽时间轴)]            |
+-----------------------------------------------------------------------------------+
| [模块 03 & 04 & 05：空间联动叙事区 (桌面端左文右图 Sticky 布局)]                  |
| +-----------------------------------+ +-----------------------------------------+ |
| | [Tab: 景点地标 | 国宝文物 | 名人] | |      [Sticky 交互式水墨底图容器]        | |
| |  - 卡片 1 / 卡片 2 / 卡片 3 ...   | |      卡片高亮、FlyTo 与弹窗实时联动     | |
| +-----------------------------------+ +-----------------------------------------+ |
+-----------------------------------------------------------------------------------+
| [模块 06：诗句中的 Ta (卷轴卡片流 + 意象词悬停注释 + 关联诗境地点定位)]           |
+-----------------------------------------------------------------------------------+
| [模块 07：城市味道 (四栏风物志：风味 | 方言词典 | 非遗技艺 | 节庆民俗) AI 整理]    |
+-----------------------------------------------------------------------------------+
| [模块 08：数说城市 (ECharts：GDP 与人口趋势 + 12 个月气温降水复合图)]             |
+-----------------------------------------------------------------------------------+
| [Footer] 数据来源声明 | 生成时间戳 | [重新生成档案] | 免责声明                    |
+-----------------------------------------------------------------------------------+
                                                                    [右侧悬浮卷轴目录]
```

- **Desktop（≥ 1024px）**：内容最大宽度 1280px；模块 03/04/05 左栏卡片列表（45%）+ 右栏 Sticky 地图（55%，高度 `calc(100vh - 100px)`）；右侧常驻卷轴目录。
- **Tablet（768–1023px）**：双栏卡片网格，地图在模块顶部吸顶（高度 380px），下方横向滑动卡片。
- **Mobile（< 768px）**：单栏垂直流；侧边目录收纳为右下角悬浮按钮（FAB）；地图为紧凑置顶容器（高度 280px），避免拦截垂直滚动手势。
- **地图底图**：天地图底图叠加 CSS 滤镜（`sepia`、`grayscale` 与水墨色阶映射）或自定义 MapLibre 样式层；无 `TIANDITU_KEY` 时只绘制行政区轮廓。

---

## 5. 【数据模型与计算规则（数据来源）】

### 5.1 数据流向与多源融合架构

```
┌─ 构建期（一次性脚本，产物提交入库）──────────────────────────────────────────┐
│ build_city_dictionary  行政区划代码表 → city_dictionary.json（标准名/拼音/英文/古称）│
│ build_poetry_corpus    chinese-poetry → 繁转简 → verified_poetry_corpus.json        │
│ build_fact_snapshot    Wikidata SPARQL → fact_snapshot/{cityId}.json（实体候选）    │
│ 手工整理               relics_registry.json、place_gazetteer.json、dynasties.json   │
└─────────────────────────────────────────────────────────────────────────────┘

[用户输入 Query]
      │
      ▼
(1) CityNormalizer：词典检索 → status=exact / ambiguous / none（区县名附 hint）
      │
      ▼
(2) 缓存查询：cities → city_archives + city_modules
    ├── 命中 ──> 返回完整档案（fromCache: true）
    └── 未命中或缺模块 ──> (3)
      │
      ▼
(3) JobManager：同城单飞 → 增量计划（只生成非 ok 模块）→ 限流与预算检查
      │
      ▼
(4) Fact Context：本地快照 + 诗词候选 + 文物名录（本地）；在线 Wikipedia/Wikidata 补充（2500ms 硬超时，可跳过）
      │
      ▼
(5) 模块生成：LLM 在候选内“选择 + 叙事” → Zod 校验 → 实体/诗词/坐标/年份/数值校验
      │
      ▼
(6) 模块落库（事务内原子替换）→ 推送 SSE 事件 → 发布规则判定（identity 通过且 ≥ 5 个模块通过）
```

**数据来源与许可：**
- 结构化事实：Wikidata（构建期快照）、国家统计局与地方统计公报、国家文物局名录、各大博物馆公开资料。
- 诗词：开源古籍库 chinese-poetry（遵循其仓库许可证，页脚致谢）；入库时统一转为简体并保留繁体原文字段。同一首诗存在异文时，展示库中收录版本并标注“版本不同”。
- 在线百科：仅 Wikipedia/Wikidata，不抓取百度百科；国内网络不可达时静默跳过。
- 地图与地名：天地图。
- 每个字段说明含义、单位与统计年份；档案记录生成时间与模型版本。

### 5.2 核心数据库表结构（SQLite）

```sql
-- 1. 城市主表（由 city_dictionary.json 导入，未生成档案的城市也在此）
CREATE TABLE IF NOT EXISTS cities (
    city_id       TEXT PRIMARY KEY,          -- 'CN-' + 6位行政区划代码，如 'CN-610100'；海外预留 'JP-xxxxxx'
    standard_name TEXT NOT NULL,             -- 标准中文名，如 '西安'
    province      TEXT NOT NULL,             -- 所属省级行政区，如 '陕西省'
    admin_level   TEXT NOT NULL,             -- 'municipality' / 'prefecture' / 'whitelist_county'
    country_code  TEXT NOT NULL DEFAULT 'CN',
    pinyin        TEXT NOT NULL,             -- 无声调拼音，如 'xian'
    english_name  TEXT NOT NULL,             -- 如 "Xi'an"
    center_lng    REAL NOT NULL,             -- WGS84
    center_lat    REAL NOT NULL,
    summary       TEXT,                      -- 消歧卡片用一句话简介
    hot_rank      INTEGER                    -- 热门排序，可为空
);

-- 2. 城市别名与检索索引表
CREATE TABLE IF NOT EXISTS city_aliases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    alias_key  TEXT NOT NULL,                -- 小写归一化检索词（如 '长安'、'changan'、'xian'）
    city_id    TEXT NOT NULL REFERENCES cities(city_id),
    match_type TEXT NOT NULL,                -- 'standard' / 'ancient' / 'pinyin' / 'english' / 'district_hint' / 'typo'
    hint       TEXT,                         -- 区县名归并时的提示语，如 '临安区为杭州市辖区'
    UNIQUE (alias_key, city_id, match_type)
);
CREATE INDEX IF NOT EXISTS idx_alias_key ON city_aliases(alias_key);

-- 3. 档案元数据表（一城一行）
CREATE TABLE IF NOT EXISTS city_archives (
    city_id            TEXT PRIMARY KEY REFERENCES cities(city_id),
    status             TEXT NOT NULL,        -- 'complete' / 'partial' / 'unpublished'
    theme_palette_json TEXT NOT NULL,        -- {light:{...}, dark:{...}}
    sources_json       TEXT NOT NULL,        -- SourceRef 列表
    schema_version     TEXT NOT NULL DEFAULT '1.1',
    data_version       INTEGER NOT NULL DEFAULT 1,
    is_preset          INTEGER NOT NULL DEFAULT 0,
    generator_json     TEXT,                 -- {model, promptVersion}；预置手工数据为 null
    generated_at       TEXT NOT NULL,        -- ISO 8601
    updated_at         TEXT NOT NULL
);

-- 4. 模块表（模块级存储，支持单模块重试与原子替换）
CREATE TABLE IF NOT EXISTS city_modules (
    city_id           TEXT NOT NULL REFERENCES cities(city_id),
    module_name       TEXT NOT NULL,         -- identity/chronicle/landmarks/relics/figures/poetics/localSoul/dataPulse
    status            TEXT NOT NULL,         -- 'ok' / 'degraded' / 'failed'
    data_json         TEXT,                  -- 通过校验的模块数据；失败时保留旧版本
    verification_json TEXT NOT NULL,         -- 校验记录：自动校验结果、人工复核状态
    generated_at      TEXT NOT NULL,
    PRIMARY KEY (city_id, module_name)
);

-- 5. 生成任务表（单飞、冷却、限流）
CREATE TABLE IF NOT EXISTS generation_jobs (
    job_id          TEXT PRIMARY KEY,
    city_id         TEXT NOT NULL REFERENCES cities(city_id),
    status          TEXT NOT NULL,           -- 'running' / 'done' / 'partial' / 'failed'
    force_flag      INTEGER NOT NULL DEFAULT 0,
    modules_json    TEXT NOT NULL,           -- 本次计划生成的模块
    failed_json     TEXT,
    requester_hash  TEXT NOT NULL,           -- 加盐 IP 哈希
    llm_calls       INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    cooldown_until  TEXT                     -- 失败冷却截止时间
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_running_job ON generation_jobs(city_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_job_requester ON generation_jobs(requester_hash, started_at);
```

### 5.3 核心业务字段与变量字典

#### 通用结构

```ts
type Coord = [number, number];                 // [lng, lat]，WGS84
type Fact<T> = {
  value: T | "待考";
  unit?: string;                               // 如 'km²'、'万人'、'亿元'
  statYear?: number | null;                    // 统计年份
  caliber?: string;                            // 口径，如 '常住人口'
  sourceRefs: string[];                        // 指向 sources[].id
};
type SourceRef = {
  id: string;
  type: "local_snapshot" | "wikidata" | "wikipedia" | "gov_stat" | "nrha"
      | "museum" | "poetry_corpus" | "relics_registry" | "preset_manual" | "llm_curation";
  title: string;
  url?: string;
  retrievedAt: string;                         // ISO 8601
};
```
规则：`llm_curation` 类型来源只能支撑叙事文本，**不能作为实体存在的唯一来源**。

#### 字段字典

| 模块 | 字段路径 | 类型 | 约束、规则与来源 |
| :--- | :--- | :--- | :--- |
| **全局元数据** | `meta.cityId` | `string` | 格式 `CN-` + 6 位数字，如 `CN-610100` |
| | `meta.schemaVersion` / `meta.dataVersion` | `string` / `number` | 结构版本与数据版本，重新生成时递增 `dataVersion` |
| | `meta.generatedAt` | `string` | ISO 8601 |
| | `meta.status` | enum | `complete` / `partial` |
| | `meta.moduleStatus` | `object` | 各模块 `ok` / `degraded` / `failed` / `missing` |
| | `meta.generator` | `object` or `null` | `{model, promptVersion}`；预置手工数据为 `null` |
| | `meta.isPreset` | `boolean` | 是否预置黄金样本 |
| | `meta.themePalette` | `object` | `{light, dark}`，各含 `primary`、`secondary`、`accent`（HEX），须通过对比度校验 |
| | `fromCache` | `boolean` | 仅出现在响应中，不入库 |
| | `sources` | `SourceRef[]` | 全档案来源列表 |
| **01 城市名片** | `identity.standardName` | `string` | 取自词典 |
| | `identity.aliases` | `string[]` | 取自词典，至少 2 项（词典不足时为已有项） |
| | `identity.center` | `Coord` | 取自词典 |
| | `identity.area` | `Fact<number>` | 单位 `km²`，附统计年份 |
| | `identity.population` | `Fact<number>` | 单位 `万人`，常住人口，保留 1–2 位小数，附统计年份 |
| | `identity.climateType` | `Fact<string>` | 气候学标准分类 |
| | `identity.adminDivisions` | `Fact<string>` | 如 `"11个市辖区、2个县"` |
| | `identity.oneLinePersona` | `string` | 15–35 字，模型叙事，标注 AI 整理 |
| **02 前世今生** | `chronicle[]` | `Array` | 5–8 项，按 `startYear` 升序 |
| | `chronicle[].eraName` | `string` | 朝代或时期名，如 `"西周"`、`"唐"`、`"现代"`；取自朝代年表 |
| | `chronicle[].epithet` | `string`（可选） | 时代别称，如 `"盛唐气象"`；不得用作 `eraName` |
| | `chronicle[].startYear` / `endYear` | `number` / `number` or `null` | 公元纪年，公元前为负数；由朝代年表填充；`endYear=null` 表示延续至今 |
| | `chronicle[].periodRange` | `string` | 展示用，如 `"618年—907年"` |
| | `chronicle[].ancientCityName` | `string` | 当时城名，如 `"大兴/长安"` |
| | `chronicle[].keyEvents` | `string` | 60–150 字；叙事中的具体年份须出现在 Fact Context |
| | `chronicle[].relicToday` | `string` | 现存空间印记 |
| | `chronicle[].centerCoord` | `Coord` or `null` | 由地名库或快照解析；`null` 时沿用上一节点或城市中心 |
| | `chronicle[].sourceRefs` | `string[]` | |
| **03 景点地图** | `landmarks[]` | `Array` | 6–10 项（必去 4–6 + 小众 2–4）；数据不足时按实际条数，最少 1 项 |
| | `landmarks[].entityRef` | `string` | 快照实体 ID 或名录 ID |
| | `landmarks[].category` | enum | `must_visit` / `hidden_gem` |
| | `landmarks[].bestSeason` | `string` | 如 `"3—5月、9—11月"`，可为 `"待考"` |
| | `landmarks[].reason` | `string` | 40–100 字推荐理由 |
| | `landmarks[].placeName` | `string` | 用于坐标解析 |
| | `landmarks[].coordinates` | `Coord` or `null` | 由 `coordResolver` 产出 |
| | `landmarks[].coordSource` | enum | `local_gazetteer` / `tianditu` / `wikidata` / `preset_manual` / `city_center` |
| | `landmarks[].sourceRefs` | `string[]` | 至少 1 个非 `llm_curation` 来源 |
| **04 文物重器** | `relics[]` | `Array` | 4–6 项；名录不足时按实际条数 |
| | `relics[].registryId` | `string` | `relics_registry.json` 中的 ID |
| | `relics[].name` / `era` / `museumOrSite` / `protectionLevel` | `string` | 一律取自名录，模型不得改写 |
| | `relics[].findSpot` | `string` | 出土或发现地，缺失为 `"待考"` |
| | `relics[].story` | `string` | 80–160 字 |
| | `relics[].coordinates` | `Coord` or `null` | 馆所或遗址坐标 |
| | `relics[].images[]` | `Array`（可选） | `{url, credit, license, sourceUrl}`；仅 `ENABLE_IMAGES=true` 且来自 Wikimedia Commons |
| | `relics[].sourceRefs` | `string[]` | |
| **05 历史名人** | `figures[]` | `Array` | 4–6 项；数据不足时按实际条数 |
| | `figures[].entityRef` | `string` | 快照实体 ID |
| | `figures[].name` / `dynasty` | `string` | |
| | `figures[].birthYear` / `deathYear` | `number` or `"待考"` | 取自实体，公元前为负数 |
| | `figures[].relationType` | enum | `native` / `sojourner` |
| | `figures[].evidence` | `object` | `{property, value}`，`property`：`birthplace` / `deathplace` / `workplace` / `position` / `preset_manual` |
| | `figures[].cityBond` | `string` | 与本城的具体关联，须与 `evidence` 一致 |
| | `figures[].highlights` | `string` | 不超过 100 字生平高光 |
| | `figures[].sites[]` | `Array` | `{placeName, coordinates}` 关联遗迹 |
| | `figures[].sourceRefs` | `string[]` | |
| **06 诗句中的 Ta** | `poetics[]` | `Array` | 3–5 项，候选全部来自本地诗词库 |
| | `poetics[].poemId` | `string` | 诗词库 ID |
| | `poetics[].title` | `string` | 题目，如 `"登科后"`（不含书名号，由前端渲染） |
| | `poetics[].author` | `string` | 仅作者，如 `"孟郊"` |
| | `poetics[].dynasty` | `string` | 仅朝代，如 `"唐"` |
| | `poetics[].lines` | `string[]` | 原文句数组，**直接取自诗词库** |
| | `poetics[].background` | `string` or `"待考"` | 创作背景，AI 整理 |
| | `poetics[].relationType` | enum | `direct`（直接写该城）/ `regional`（历史地理域关联诗篇） |
| | `poetics[].imageryMap[]` | `Array` | `{word, note, isGeographic, placeName, coordinates}`；`word` 必须出现在 `lines` 中；`isGeographic=false` 时不含坐标 |
| | `poetics[].sourceRefs` | `string[]` | 含诗词库来源 |
| **07 城市味道** | `localSoul.aiCurated` | `boolean` | 恒为 `true`，界面标注 AI 整理 |
| | `localSoul.foods[]` | `Array` | 3–5 项 `{name, flavor, origin}` |
| | `localSoul.dialects[]` | `Array` | 2–4 项 `{word, pronunciation, meaning, example}` |
| | `localSoul.ichItems[]` | `Array` | 2–4 项 `{name, level, intro, sourceRefs}`，`level`：`national` / `provincial` / `"待考"`，仅取自快照名录 |
| | `localSoul.festivals[]` | `Array` | 2–3 项 `{name, season, custom}` |
| **08 数说城市** | `dataPulse.gdpSeries[]` | `Array<{year, value}>` | 近 5 年，单位亿元；缺失年份 `value=null` |
| | `dataPulse.popSeries[]` | `Array<{year, value}>` | 近 5 年，单位万人 |
| | `dataPulse.statMeta` | `object` | `{gdp: {unit, caliber, sourceRefs}, pop: {unit, caliber, sourceRefs}}` |
| | `dataPulse.climateMonthly[]` | `Array<{month, tempC, precipMm}>` | 12 项；数值取自气候标准值库 |
| | `dataPulse.climateMeta` | `object` | `{period: "1991–2020", station, sourceRefs}` |

**统一数量约定：** 年表 5–8；景点 6–10；文物 4–6；人物 4–6；诗词 3–5；美食 3–5；方言 2–4；非遗 2–4；节庆 2–3；统计序列固定近 5 年。数据不足时按“可核验的实际条数”展示，模块标为 `degraded`；0 条时显示“待考”空状态。

**诗词示例（仅示意结构）：**
```json
{
  "poemId": "tang-xxxxx",
  "title": "登科后",
  "author": "孟郊",
  "dynasty": "唐",
  "lines": ["（原文取自诗词库）"],
  "relationType": "direct",
  "imageryMap": [
    { "word": "长安花", "note": "（AI 整理的注释）", "isGeographic": true,
      "placeName": "曲江池遗址", "coordinates": null }
  ]
}
```
`coordinates` 一律由 `coordResolver` 回填，示例中不手写坐标。

### 5.4 边界条件与异常处理规则
1. **统计数据缺失**：近 5 年序列不完整时，缺失年份为 `null`，ECharts 设置 `connectNulls: true` 并标注“部分年份数据待考”；有效点不足 3 个时改为文字列表展示，不画图。
2. **古诗词匹配不足降级**：建城较晚的现代城市（如深圳、克拉玛依），本地库无直接描写时，自动回溯其所属历史地理单元（如深圳关联“新安”“零丁洋”，文天祥《过零丁洋》），`relationType` 标为 `regional`，卡片标注“历史地理域关联诗篇”，绝不伪造诗作。
3. **重名、同音与形近消歧字典**：
   - 同拼音：`suzhou` → 苏州（江苏）/ 宿州（安徽）；`taizhou` → 泰州（江苏）/ 台州（浙江）。
   - 去声调后同拼音：`fuzhou` → 福州（福建）/ 抚州（江西）。
   - 同名多义：`吉林`（吉林省 / 吉林市）等，进入消歧。
   - 形近字纠错：`毫州` → 亳州（安徽），自动纠正并提示。
   - 区县与旧称归并（不弹消歧）：`临安`、`Lin'an` → 杭州（附提示）；`长安` → 西安；`金陵` → 南京。
4. **预置数据来源标注**：预置档案每个实体带 `sourceRefs` 与 `verification`（`verified_by_source` / `pending_human_review` / `preset_manual`）；数值类字段若没有来源，一律填“待考”。

---

## 6. 【交付物标准（输出什么）】

### 6.1 产出物清单
1. **完整可运行的前后端全栈源码**（npm workspaces Monorepo，一条命令并发启动）。
2. **数据库初始化与种子数据**：自动建表；**6 座预置城市高保真档案**（西安、杭州、成都、北京、苏州、洛阳），无 API Key 的离线环境下可 100% 体验所有交互、地图联动、时间轴与诗词意象。预置数据须由管线从快照与诗词库组装实体，叙事文本可由模型或人工撰写，所有实体与数值带来源与核验状态。
3. **构建期脚本**：`build_city_dictionary`、`build_poetry_corpus`、`build_fact_snapshot`，以及对应的产物文件与生成说明。
4. **数据生成与校验引擎**：System Prompt 模板（带 `promptVersion`）、事实检索器、诗词核验器、实体核验器、坐标解析器、任务编排器、Zod Schema。
5. **自动校验脚本** `npm run verify`：对所有预置城市输出机器可读的校验报告（见 7.2）。
6. **工程文档包**：
   - `README.md`：环境要求、一键安装与启动、环境变量说明、架构图、构建期脚本使用说明。
   - `.env.example`：`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`TIANDITU_KEY`、`ADMIN_TOKEN`、`LLM_DAILY_CALL_LIMIT`、`ENABLE_IMAGES`、`PORT`。
   - `FEATURES_AND_VERIFICATION.md`：功能完成度（已完成 / 部分完成 / 未完成及原因）、自测记录、**人工复核记录**、已知问题。

### 6.2 推荐项目目录结构

```text
citylens/
├── README.md
├── FEATURES_AND_VERIFICATION.md
├── .env.example
├── package.json                       # workspaces: client, server, shared；脚本 dev / build / seed / verify
├── shared/
│   └── schema.ts                      # Zod Schema 与 TypeScript 类型（唯一来源）
├── scripts/
│   ├── build_city_dictionary.ts       # 行政区划代码表 → city_dictionary.json
│   ├── build_poetry_corpus.ts         # chinese-poetry → 简体核验库
│   ├── build_fact_snapshot.ts         # Wikidata SPARQL → fact_snapshot/（需联网环境运行）
│   └── verify_presets.ts              # 预置数据自动校验，输出报告
├── server/
│   ├── db/
│   │   ├── schema.sql
│   │   ├── seed.ts
│   │   └── presets/                   # 西安、杭州、成都、北京、苏州、洛阳
│   ├── data/
│   │   ├── city_dictionary.json
│   │   ├── dynasties.json             # 固定朝代年表
│   │   ├── verified_poetry_corpus.json
│   │   ├── relics_registry.json       # 国保名录 + 禁止出境展览文物 + 博物馆公开藏品
│   │   ├── place_gazetteer.json       # 本地地名与坐标库（WGS84）
│   │   ├── stats_baseline.json        # 统计公报基准值
│   │   └── fact_snapshot/
│   ├── prompts/                       # 各模块 Prompt 模板（带版本）
│   ├── services/
│   │   ├── normalizer.ts              # 名称规范化与消歧
│   │   ├── cacheService.ts            # 持久化缓存读写（仓储层）
│   │   ├── jobManager.ts              # 同城单飞、增量计划、冷却
│   │   ├── rateLimiter.ts             # IP 限流与每日预算
│   │   ├── factRetriever.ts           # 本地快照 + 在线补充（2500ms 超时）
│   │   ├── poetryVerifier.ts          # 候选检索与意象校验
│   │   ├── entityVerifier.ts          # 景点、文物、人物核验
│   │   ├── coordResolver.ts           # 地名 → WGS84 坐标
│   │   └── llmGenerator.ts            # 结构化生成与 Zod 校验编排
│   └── index.ts                       # 路由：/api/cities/search、/hot、/:cityId、/:cityId/generate、/api/health
└── client/
    └── src/
        ├── components/
        │   ├── hero/InkCanvasHero.tsx
        │   ├── search/CitySearchModal.tsx
        │   ├── modules/IdentityBento.tsx
        │   ├── modules/ChronicleTimeline.tsx
        │   ├── modules/SpatialExplorer.tsx
        │   ├── modules/PoeticsScroll.tsx
        │   ├── modules/LocalSoulGrid.tsx
        │   ├── modules/DataPulseCharts.tsx
        │   └── layout/ScrollNavSidebar.tsx
        ├── hooks/
        │   ├── useCityStream.ts       # fetch 流式 SSE + AbortController + 缓存状态
        │   ├── useDynamicTheme.ts     # 主题色、ensureContrast、明暗切换
        │   └── useLocalLibrary.ts     # 收藏与最近浏览（LocalStorage）
        └── pages/                     # Home、CityPage、NotFound
```

LocalStorage 键：`citylens:favorites`（`cityId[]`）、`citylens:recents`（最多 20 条 `{cityId, name, ts}`，重复访问移到最前）、`citylens:theme`。

### 6.3 建议开发顺序（每步结束均处于可运行状态）
1. `shared/schema.ts`、数据库建表、词典脚本、`normalizer` 与搜索接口。
2. 诗词库、事实快照、文物名录、地名库脚本与产物。
3. `cacheService`、`jobManager`、SSE 接口，使用模拟 LLM 跑通流式、单飞、冷却与限流。
4. 前端骨架：路由、主题系统、搜索与消歧、流式 Hook、骨架屏。
5. 八个模块组件与地图、时间轴、诗词联动。
6. 接入真实 LLM、校验管线；生成 6 座预置城市并跑 `npm run verify`。
7. 动效打磨、响应式、无障碍、Lighthouse，按第 7 章完成验收并填写记录。

---

## 7. 【验收标准与测试用例（如何验收）】

### 7.1 功能验收标准 (Given / When / Then)

| 编号 | 验收模块 | Given | When | Then |
| :--- | :--- | :--- | :--- | :--- |
| **AC-01** | 古称与外文归并 | 用户位于首页搜索框 | 依次输入 `长安`、`Xi'an`、`金陵`、`Lin'an` | 分别归并到 `CN-610100`（西安）、`CN-610100`、`CN-320100`（南京）、`CN-330100`（杭州）；`Lin'an` 显示“临安区为杭州市辖区”提示；`city_aliases` 无重复行，`city_archives` 无重复档案 |
| **AC-02** | 同音与形近消歧 | 同上 | 输入 `suzhou`、`taizhou`、`fuzhou`、`毫州` | 前三者弹出消歧卡，分别列出苏州/宿州、泰州/台州、福州/抚州（含省份与简介），点选后进入对应城市；`毫州` 自动纠正为亳州并提示，不报错 |
| **AC-03** | 缓存极速命中 | 西安或任意已生成城市已入库 | 再次进入该城市页面 | 服务端响应 < 500ms；页面顶部显示“已为你复用”及原始生成时间；日志输出 `[CACHE HIT]`，**大模型调用次数为 0** |
| **AC-04** | 流式显影生成 | 未缓存的有效城市（如 `泉州`、`开封`），已配置 LLM Key；另测白名单县级市 `敦煌` | 回车触发生成 | 页面立即进入流式布局；`meta` 事件 < 300ms；`identity` ≤ 3.5s；骨架屏按模块逐个显影；生成完成后同城再次访问走缓存 |
| **AC-05** | 时间轴多维联动 | 浏览任意城市的前世今生模块 | 拖动朝代滑块“秦汉 → 唐 → 现代” | 朝代水印、当时城名、叙事文案、地图城址点位同步平滑切换；`eraName` 与起止年份一致（唐为 618—907） |
| **AC-06** | 地图与卡片双向联动 | 位于景点、文物或名人模块 | 1. 点击景点卡片；2. 点击地图上另一个 Marker | 动作 1：地图 `flyTo` 并弹出气泡；动作 2：卡片列表滚动到对应卡片并高亮。无坐标条目显示“全域印记”，点击后地图复位 |
| **AC-07** | 诗词意象联动与核验 | 位于诗词模块 | 展开一首诗，悬停地理意象词 | 弹出注释气泡并高亮对应地点；泛指意象不触发地图；`lines`、作者、朝代与诗词库逐字一致；`imageryMap.word` 均出现在原文中 |
| **AC-08** | 重新生成与保护 | 正在浏览已缓存的非预置城市 | 点击“重新生成” | 先弹确认框，取消无事发生；确认后增量重新生成，通过校验的模块原子替换并更新时间戳；5 分钟内再次点击返回限流提示；在**预置城市**点击提示“预置馆藏受保护” |
| **AC-09** | 异常与不存在城市 | 位于首页搜索框 | 输入 `亚特兰蒂斯市` 或 `asdfghjkl` | 在规范化阶段拦截，展示“版图中暂未寻获此城”与热门名城入口，不报错崩溃 |
| **AC-10** | 视觉主题与无障碍 | 在不同城市与设备下浏览 | 1. 西安切换到杭州；2. 切换日间/夜间；3. 开启 `prefers-reduced-motion` | 主题色平滑过渡；六座预置城市明暗两套配色的文字色对比度均 ≥ 4.5:1（单元测试通过）；减少动画偏好下粒子与大位移视差静默降级 |
| **AC-11** | 收藏与最近浏览 | 浏览过若干城市 | 收藏、取消收藏、刷新页面、浏览超过 20 个城市 | 收藏刷新后保留；最近浏览最多 20 条，重复访问的城市移到最前；点击条目进入 `/city/:cityId` |
| **AC-12** | 部分失败与单模块重试 | 设置 `SIMULATE_FAIL=poetics`（模拟 LLM 超时） | 生成未缓存城市 | 其余模块正常显影；诗词模块显示“史料卷宗调取受阻”；点击“单独重试”后只更新该模块（日志证明仅 1 次 LLM 调用）。再模拟 5 个模块失败：档案为 `unpublished`，不对他人提供，同城 10 分钟内请求返回 `COOLDOWN`；冷却后仅重跑失败模块 |
| **AC-13** | 并发单飞 | 一个未缓存城市 | 同时发起 10 个生成请求 | 日志显示仅创建 1 个任务，每个模块仅 1 次 LLM 调用；10 个客户端都收到完整事件流（后到者先回放已完成模块） |
| **AC-14** | 无 Key 与预算 | 未配置 LLM Key，或每日预算耗尽 | 访问预置城市、已缓存城市、未缓存城市 | 预置与已缓存城市功能完整；未缓存城市显示“尚未收录”状态页与预置名城入口；所有重新生成入口置灰并说明原因 |
| **AC-15** | 响应式 | Chrome 设备模拟 | 分别以 375px、768px、1280px 宽度浏览预置城市全页 | 无横向滚动条、无文字重叠；Mobile 目录为 FAB，地图高度约 280px 且不拦截垂直滚动 |
| **AC-16** | 性能 | 生产构建（`build` + `preview`） | 对预置城市页运行 Lighthouse | Desktop Performance ≥ 80，Mobile Performance ≥ 70；记录报告 |
| **AC-17** | 数据合规自动校验 | 6 座预置城市已入库 | 运行 `npm run verify` | 0 个错误：Schema 全部通过；诗词 `lines` 与诗词库一致；所有坐标在城市中心 180km 内且 `coordSource` 不是大模型；每个实体至少有 1 个非 `llm_curation` 来源；所有统计值有单位与统计年份或为“待考” |
| **AC-18** | 网络失败与生成超时 | 屏蔽在线检索网络；模拟单模块超时 | 访问预置城市、缓存城市与未缓存城市 | 预置与缓存城市不受影响；未缓存城市仍可基于本地快照生成，相关模块标 `degraded`；超时模块按 AC-12 处理，不出现白屏 |
| **AC-19** | 干净环境一次运行 | 全新机器或容器，仅有 Node 20 | 按 README 执行安装、初始化与启动 | 一次跑通，6 座预置城市可完整体验；记录执行命令与耗时 |

### 7.2 真实性基准校验（分两步，缺一不可）

**第一步：自动校验。** `npm run verify` 报告全部通过（AC-17）。

**第二步：人工抽查。** 由**产品负责人本人**（非开发者、非生成工具）对至少 5 座城市（西安、杭州、成都、北京、苏州或洛阳）抽查：每城 5 个景点、5 位人物、3–5 首诗词，并在 `FEATURES_AND_VERIFICATION.md` 记录表中逐条填写权威来源链接与结论。**开发自测结果不计入通过。**

| 校验维度 | 通过标准 | 一票否决 |
| :--- | :--- | :--- |
| **古诗词真实性** | 全部诗词能在《全唐诗》《全宋词》或 chinese-poetry 中检索到，字句、作者、朝代一致；诗中意象确与该城历史地理相关 | 出现编造的“伪古诗”、张冠李戴作者，或把写 A 城的诗归入 B 城 |
| **文物与馆藏归属** | 名称、年代、馆藏地与国家文物局或博物馆官网公开信息一致（如：镶金兽首玛瑙杯——陕西历史博物馆；太阳神鸟金饰——金沙遗址博物馆） | 编造不存在的文物，或把故宫、国博独有藏品放在地方博物馆且无出土渊源说明 |
| **历史人物关联** | 关联描述符合史实记载（如：白居易任杭州刺史期间主持修筑湖堤蓄水、留下大量咏杭诗篇；苏轼知杭州疏浚西湖；杜甫寓居成都浣花溪草堂）。**不得表述为“白居易修筑白堤”** | 人物与该城无历史交集，或生卒年、朝代出现常识性错误 |
| **地理坐标精度** | 预置城市坐标与权威地图同名地物偏差 < 1.5km；飞跃后落在对应景区或城区；非预置城市坐标通过 180km 边界与名称匹配 | 坐标落在海外、海洋或其他省份 |
| **统计数据标注** | GDP、人口、面积均有单位（亿元、万人、km²）、口径与统计年份；无法确认的标“待考” | 无单位、无年份，或捏造违背数量级常识的数据 |
| **来源引用** | `[源]` 徽章指向的条目都在 `sources` 中真实存在 | 出现档案之外的、模型自行编写的典籍或网址 |

**人工复核记录表模板（写入 `FEATURES_AND_VERIFICATION.md`）：**

| 城市 | 对象类型 | 名称 | 权威来源链接 | 自动校验 | 人工结论（通过/不通过） | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| | | | | | | |

### 7.3 风险与遗留披露矩阵

研发交付时需在 `FEATURES_AND_VERIFICATION.md` 中如实披露以下边界：

| 风险 / 边缘场景 | 潜在影响 | 一期缓解与兜底 | 后续迭代 (v1.2+) |
| :--- | :--- | :--- | :--- |
| **大模型生成耗时波动** | 未缓存城市完整 8 个模块可能耗时 15–35s | 分阶段流式推送：本地数据先出，`identity` 目标 ≤ 3.5s，后台并发补齐其余模块；单飞避免重复调用 | Redis + 后台热门城市 Top 100 定时预热，使 95% 请求直接命中缓存 |
| **冷门城市诗词与文物稀缺** | 命中率可能为 0 | 向上回溯古州府与地理大区，标“历史地理域关联诗篇”；模块按实际条数展示并标 `degraded`；绝不让模型造诗、造文物 | 扩充清代与近现代地方志诗词索引、更多馆藏名录 |
| **在线百科不可达** | 国内网络下 Wikipedia/Wikidata 通常无法直连 | 运行期以本地快照为主，在线检索 2500ms 超时即跳过；百度百科不抓取 | 离线向量化地方志与国保名录知识库 |
| **快照构建需联网** | 开发环境无法访问 Wikidata 时快照质量下降 | 在交付文档如实披露；预置数据降级为“人工整理 + 待复核”并在验收中重点抽查 | 在可联网 CI 中定期重建快照 |
| **叙事文本仍由模型撰写** | 实体已受约束，但叙事措辞仍可能不准确 | 叙事文案标注“AI 整理”；叙事中的具体年份受 Fact Context 校验；页脚免责声明；提供“重新生成”与反馈入口 | 增加用户纠错反馈与人工审核队列 |
| **生成成本与滥用** | 公开服务被刷导致费用失控 | 限流、每日预算、预置城市保护、失败冷却、增量生成 | 账号体系与配额 |
| **单进程与 SQLite 并发写** | 无法水平扩展 | 一期单进程；写操作走事务；仓储层隔离 SQL | 切换 PostgreSQL，任务锁迁移到 Redis |
| **地图审美与合规冲突** | 商业底图色彩杂乱，破坏水墨调性 | 天地图底图 + CSS 滤镜或自定义样式层；右下角展示来源与审图号；无 Key 时仅绘制轮廓 | 定制古今双图层矢量瓦片（叠加唐宋明清城垣轮廓） |
