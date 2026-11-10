# CityLens 读城

交互式城市人文档案系统。输入城市名、古称或拼音，读城引擎以流式方式逐模块生成八个人文模块，每个模块独立显影、独立降级。

> 当前进度：阶段 1–7 已完成（服务端、离线事实管线、缓存编排、SSE 流式、八模块前端、预置档案与 verify、性能与响应式打磨）。功能完成度、AC-01～AC-19 自测证据与待人工复核清单见 [FEATURES_AND_VERIFICATION.md](./FEATURES_AND_VERIFICATION.md)。

## 技术栈

- 前端：React + TypeScript（strict）+ Vite + MapLibre GL JS + ECharts
- 后端：Fastify + better-sqlite3 + SSE（`fetch` 流式）
- 共享契约：`shared/schema.ts`（Zod），前后端唯一类型来源
- 地图：天地图（WGS84，全链路禁止 GCJ-02）
- 大模型：DeepSeek / OpenAI 兼容接口

## 目录结构

```
CityLens/
├─ client/                 # React 前端
├─ server/
│  ├─ index.ts             # Fastify 入口
│  ├─ db/                  # 建表 SQL、仓储、种子
│  ├─ services/            # 规范化、缓存、编排、LLM
│  └─ data/                # 构建期产物（词典/诗词库/快照/名录/地名库）
├─ shared/                 # schema.ts / validators.ts / theme.ts
├─ scripts/                # 构建期数据管线
└─ docs/PRD.md             # CityLens 读城 PRD v1.1
```

## 快速开始（干净环境）

要求 Node.js ≥ 20，npm ≥ 10。

```bash
npm ci
npm run setup         # 建表 + 导入城市词典 + 构建六座预置城市档案
npm run dev           # 同时启动 server:8787 与 client:5173
npm run verify        # 预置档案自动校验（需先 setup）
```

打开 http://localhost:5173 ，搜索「长安」「临安」「锦官城」或直接进入预置城市。

只启动服务端：

```bash
npm run dev:server
curl http://localhost:8787/api/health
curl "http://localhost:8787/api/cities/search?q=长安"
curl http://localhost:8787/api/cities/hot
```

> 若在 Windows 上 `better-sqlite3` 未找到预编译包，会回退到源码编译，需要安装 Visual Studio Build Tools（C++ 工作负载）。
>
> 若 `npm ci` 在 `better-sqlite3` 的安装脚本处报 `'prebuild-install' 不是内部或外部命令`，通常是终端 `PATH` 过长（超过 8191 字符）导致 `cmd.exe` 截断 `PATH`。在系统默认终端中执行，或先精简 `PATH` 再安装即可；本项目无需额外的全局依赖。
>
> Vite 默认只监听 `localhost`（IPv6），请使用 http://localhost:5173 ；若浏览器打不开，改用 `npm run dev:client -- --host 127.0.0.1`。

### 数据管线（可重复执行）

```bash
npm run data:dictionary   # Wikidata 行政区划代码 + 坐标 → city_dictionary.json
npm run data:poetry       # chinese-poetry → 本地诗词库（逐字校验源）
npm run data:snapshot     # Wikidata → 城市事实快照
npm run data:gazetteer    # 地名坐标库
npm run data:geo          # DataV.GeoAtlas → 六城行政区轮廓（含来源清单）
npm run data:images       # Wikidata P18 + Wikimedia Commons → 本地文物图片与许可
npm run data:presets      # 六座预置城市档案（本地事实模块 + 人工整理稿）
npm run seed              # 重新导入词典（幂等）
npm run verify            # 校验预置档案：Schema / 来源 / 坐标 / 年份 / 诗词逐字
npm run data:refresh      # 依次刷新全部外部数据并重建预置档案
```

构建期脚本的网络失败会以非 0 退出并保留旧产物，不会伪造快照；失败原因写入产物 `failures` 字段，并同步记录到验收文档。

### 免 Key 数据源的本地缓存

- **Wikidata**：SPARQL 结果按查询哈希缓存在 `scripts/.cache/wikidata/`，断网时可直接复用；`REFRESH_WIKIDATA=1` 强制联网刷新。
- **chinese-poetry**：源 JSON 缓存在 `scripts/.cache/chinese-poetry/`（约 28 MB），并用 `.listings/` 记录目录清单；断网时自动回退本地缓存重建。可选 `GITHUB_TOKEN` 提高 GitHub API 限额，`REFRESH_POETRY=1` 强制更新清单。
- **Wikimedia Commons**：图片与许可元数据由 `npm run data:images` 抓取并落到 `client/public/images/relics/` 与 `server/data/relic_images.json`；默认复用已下载文件，`REFRESH_IMAGES=1` 强制刷新。
- **行政区轮廓**：`npm run data:geo` 会缓存到 `scripts/.cache/geo/` 并生成 `client/public/geo/_manifest.json`；现有来源为 DataV.GeoAtlas，**授权与审图号未完成人工确认**，公开上线前必须合规审校或替换为天地图/自然资源部标准地图来源。
- **国家文物局名录**：没有公开 API，无法可靠自动抓取，仍需人工下载官方名单后离线导入。

### 数据产物（构建期生成，已提交）

| 产物 | 生成脚本 | 内容与用途 |
|---|---|---|
| `server/data/city_dictionary.json` | `build_city_dictionary.ts` | 342 座城市（334 地级 + 4 直辖市 + 4 文旅县级市白名单）、1480 条别名、WGS84 中心点、Wikidata QID |
| `server/data/verified_poetry_corpus.json` | `build_poetry_corpus.ts` | chinese-poetry（MIT）全唐诗/宋词/元曲中与六座预置城市相关的 815 首作品（每城 150 首），繁转简仅用于比对，保留原文 |
| `server/data/fact_snapshot/{cityId}.json` | `build_fact_snapshot.ts` | 六座预置城市的 Wikidata 景点/文物/人物事实快照 |
| `server/data/relics_registry.json` | `build_relics_registry.ts` | 由快照汇总的 427 件文物名录（国保 / 禁止出境展览文物） |
| `server/data/place_gazetteer.json` | `build_place_gazetteer.ts` | 862 条 WGS84 地名坐标（城市中心 + 景点 + 文物） |
| `server/data/dynasties.json` | 人工整理 | 固定朝代年表（起止年份），待人工复核 |
| `server/data/relic_images.json` | `build_relic_images.ts` | 六城前 6 件文物的本地图片路径、Commons 署名、许可证与来源页 |
| `client/public/images/relics/` | `build_relic_images.ts` | 已下载到本地的文物缩略图（640px），运行期不请求外部图片 |
| `client/public/geo/*.json` | `build_geo_boundaries.ts` | 六城行政区轮廓；`_manifest.json` 记录来源与合规待确认提示 |

产物中的每条实体均带 `sourceRef`/`sourceRefs`；`server/data/*.db*` 为运行时数据库，不提交。

**预置档案覆盖 7/8 卷**：城市名片、前世今生、景点地图、文物重器、历史名人、诗句中的 Ta、城市味道均已落库；
「数说城市」因缺少可核验的统计序列产物（GDP/人口/气候月度值）暂不生成，前端显示「此卷暂缺」，
详见 [FEATURES_AND_VERIFICATION.md](./FEATURES_AND_VERIFICATION.md) 的已知问题；绝不以估算值填充。

## 无 Key 开发模式

项目在没有 LLM Key、没有天地图 Key 时也能完整开发与自测：

- 未配置 `LLM_API_KEY`：服务端启用**模拟 LLM**，仍然走完整的流式、单飞、冷却、限流与降级路径，输出带 `mock` 标记；预置档案只由 `npm run data:presets` 构建，模拟结果不会覆盖预置档案。
- 未配置 `TIANDITU_KEY`：前端使用**无底图模式**，只绘制行政区轮廓与宣纸底色。
- `ENABLE_IMAGES=false`（默认）：档案不带图片；运行 `npm run data:images` 后设为 `true`，会使用已下载到本地的 Commons 图片，运行期仍不请求外部图片。

配置真实 Key：复制 `.env.example` 为 `.env`，填写后重启 `npm run dev` 即可切换，无需改代码。

### 切换到真实模式（两步）

1. **大模型**：在 https://platform.deepseek.com/ 创建 API Key，写入 `.env`：

   ```dotenv
   LLM_API_KEY=sk-你的真实Key
   LLM_BASE_URL=https://api.deepseek.com
   LLM_MODEL=deepseek-chat
   ```

   重启后 `/api/health` 返回 `llmConfigured: true`。未配置时自动使用模拟 LLM。
   真实模式只让模型做「选择与叙事」，坐标、年份、统计数值仍由本地产物回填并校验；
   无法校验的输出会重试一次，仍失败则该卷降级，绝不写假数据。

   也可以不改 `.env`，直接在 `http://localhost:5173/admin` 配置（见下一节），保存后立即生效。

2. **天地图**：在 https://console.tianditu.gov.cn/ 申请「浏览器端」Key，并把
   `localhost` 与你的部署域名加入白名单，写入 `.env`：

   ```dotenv
   TIANDITU_KEY=你的天地图Key
   ```

   重启后地图自动加载 t0–t7 矢量底图与注记；天地图 Key 会通过 `/api/map/config`
   下发给浏览器（瓦片请求必需），大模型 Key 永不下发。

### 后台管理（`/admin`）

打开 `/admin`（页脚有「后台管理」入口），统一管理所有 Key 与服务。页面顶部是服务总览（大模型、天地图、文物图片、档案库），下方分为「大模型」「天地图」「数据与安全」三块。

- **大模型**：DeepSeek、阶跃星辰 StepFun（`https://api.stepfun.com/v1`，模型 ID 以控制台为准，页面预填 `step-5` 作示例）或任意 OpenAI 兼容服务；支持连接测试与恢复 `.env` 默认。
- **天地图**：浏览器端 Key（瓦片，会下发前端）与服务端 Key（地名检索，只留在服务端）可分别填写；支持启用/关闭底图与服务端 Key 测试。
- **数据与安全**：只读展示诗词库、文物名录、地名库、事实快照、文物图片、行政区轮廓的数量与时间；展示免 Key 服务、ADMIN_TOKEN 状态与 CORS 来源。

保存后 `/api/health` 会显示 `llmProvider` / `llmModel` / `llmSettingsSource=runtime`，不需要重启。
「测试连接」会发起一次最小请求验证 Key 与模型；「恢复 .env 默认」会删除运行时配置。
Key 只保存在本地 SQLite，读取接口只返回 `sk-…abcd` 掩码。

管理接口保护：配置了 `ADMIN_TOKEN` 时必须携带 `x-admin-token`；未配置时只允许本机回环地址访问，
公网部署请务必设置 `ADMIN_TOKEN` 并置于反向代理之后。

> 预置六城（西安、杭州、成都、北京、苏州、洛阳）使用离线档案，不消耗 LLM 额度；
> 其余城市首次访问时走真实 LLM 流式生成。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务端口 | `8787` |
| `LLM_API_KEY` | OpenAI 兼容接口密钥；为空则启用模拟 LLM；可被 `/admin` 运行时配置覆盖 | 空 |
| `LLM_BASE_URL` | 大模型接口地址（DeepSeek / StepFun / 自定义） | `https://api.deepseek.com` |
| `LLM_MODEL` | 模型名；可被 `/admin` 覆盖 | `deepseek-chat` |
| `LLM_TIMEOUT_MS` | 单次大模型请求超时（毫秒） | `60000` |
| `TIANDITU_KEY` | 天地图浏览器端 Key；为空则无底图模式 | 空 |
| `TIANDITU_SERVER_KEY` | 天地图服务端 Key，用于地名检索；可被 `/admin` 覆盖 | 空 |
| `ADMIN_TOKEN` | 后台管理与预置城市强制重生成令牌；为空时后台仅限本机 | 空 |
| `APP_ORIGINS` | 生产环境允许的跨域来源，逗号分隔；开发环境自动放行 localhost | 空 |
| `LLM_DAILY_CALL_LIMIT` | 每日 LLM 调用预算 | `500` |
| `ENABLE_IMAGES` | 是否启用 Commons 图片 | `false` |
| `IP_HASH_SALT` | 请求方 IP 哈希盐，生产环境必须修改 | `citylens-dev-salt` |
| `SIMULATE_FAIL` | 模拟指定模块失败，如 `poetics,figures` | 空 |
| `MOCK_LLM` | 强制使用模拟 LLM（即使配置了真实 Key） | 空（未配置 Key 时自动开启） |
| `MOCK_LLM_DELAY_MS` | 模拟 LLM 单模块延迟，用于观察流式时序 | `150` |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 服务状态与 Key 配置情况 |
| GET | `/api/cities/search?q=` | 城市规范化检索（古称/拼音/英文/区县/纠错/消歧） |
| GET | `/api/cities/hot` | 热门城市（预置城市优先） |
| GET | `/api/cities/:cityId` | 读取缓存档案 |
| POST | `/api/cities/:cityId/generate` | SSE 流式生成或复用档案 |

SSE 事件：`meta` → `theme` → 8 个 `module`（可穿插 `module_error`）→ `done`；`ping` 每 15s 保活。

### 阶段 3 自测（流式 / 单飞 / 冷却 / 限流）

以下命令在 PowerShell 中执行（`curl.exe -N` 关闭缓冲才能看到逐条事件）。无 Key 时自动使用模拟 LLM，延迟默认 150ms/模块。

```powershell
# 1) 流式：观察 meta → theme → 8 个 module/module_error → done
curl.exe -N -X POST http://localhost:8787/api/cities/CN-610100/generate -H "Content-Type: application/json" -d "{}"

# 2) 单飞：同时发起 3 个请求，只应创建 1 个 job，其余复用同一个流
1..3 | ForEach-Object -Parallel {
  curl.exe -s -o NUL -w "%{http_code} %{time_total}`n" -X POST http://localhost:8787/api/cities/CN-330100/generate -H "Content-Type: application/json" -d "{}"
} -ThrottleLimit 3

# 3) 缓存命中：生成完成后再 GET，应返回 fromCache: true 且无 LLM 调用
curl.exe http://localhost:8787/api/cities/CN-610100

# 4) 冷却：对未发布城市（如泉州市 CN-350500）生成后立刻再次请求，应返回 429 COOLDOWN
curl.exe -i -X POST http://localhost:8787/api/cities/CN-350500/generate -H "Content-Type: application/json" -d "{}"
curl.exe http://localhost:8787/api/cities/CN-350500

# 5) 限流：同一 IP 一小时内新建第 11 座城市，应返回 429 RATE_LIMITED（retryAfterSec=3600）
```

单元测试与类型检查：

```bash
node node_modules/vitest/vitest.mjs run   # 95 项：schema/校验/规范化/编排/SSE/主题色/真实 LLM 解析
npm run typecheck                          # server + client 的 tsc --noEmit
```

实现要点：同一城市生成请求由数据库唯一部分索引 `uq_running_job` 保证单飞；失败任务冷却 10 分钟、无档案城市冷却 5 分钟；每小时最多生成 10 座新城市；每日 LLM 调用受 `LLM_DAILY_CALL_LIMIT` 预算约束；已 `ok`/`degraded` 的模块在增量重生成时复用，不重复调用 LLM。

## 数据真实性

- 景点、文物、人物、诗词、坐标、统计数值全部来自构建期脚本产物、本地名录或可核验的公开来源，每项都带 `sourceRefs` 与 `verification`。
- 无法取得或无法核验的内容统一填「待考」，`verification` 为 `pending_human_review`，不会用看似合理的内容充数。
- 预置城市的叙事文字为人工/AI 整理，`verification` 不冒充人工复核。人工抽查由用户按 PRD 7.2 完成。
- 文件中的 `preset_manual` / `curated` 字段表示人工整理内容，仍需人工复核。
