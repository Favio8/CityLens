# CityLens 读城

交互式城市人文档案系统。输入城市名、古称或拼音，读城引擎以流式方式逐模块生成八个人文模块，每个模块独立显影、独立降级。

> 当前进度：阶段 1–3（服务端基础、离线事实管线、缓存编排与 SSE）。前端完整界面在阶段 4–7 交付，详见 [FEATURES_AND_VERIFICATION.md](./FEATURES_AND_VERIFICATION.md)。

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
npm run seed          # 建表并导入城市词典（server/data/citylens.db）
npm run dev           # 同时启动 server:8787 与 client:5173
```

只启动服务端：

```bash
npm run dev:server
curl http://localhost:8787/api/health
curl "http://localhost:8787/api/cities/search?q=长安"
curl http://localhost:8787/api/cities/hot
```

> 若在 Windows 上 `better-sqlite3` 未找到预编译包，会回退到源码编译，需要安装 Visual Studio Build Tools（C++ 工作负载）。

### 数据管线（可重复执行）

```bash
npm run data:dictionary   # Wikidata 行政区划代码 + 坐标 → city_dictionary.json
npm run data:poetry       # chinese-poetry → 本地诗词库（逐字校验源）
npm run data:snapshot     # Wikidata → 城市事实快照
npm run data:gazetteer    # 地名坐标库
npm run seed              # 重新导入词典（幂等）
```

构建期脚本的网络失败会以非 0 退出并保留旧产物，不会伪造快照；失败原因写入产物 `failures` 字段，并同步记录到验收文档。

### 数据产物（构建期生成，已提交）

| 产物 | 生成脚本 | 内容与用途 |
|---|---|---|
| `server/data/city_dictionary.json` | `build_city_dictionary.ts` | 342 座城市（334 地级 + 4 直辖市 + 4 文旅县级市白名单）、1480 条别名、WGS84 中心点、Wikidata QID |
| `server/data/verified_poetry_corpus.json` | `build_poetry_corpus.ts` | chinese-poetry（MIT）全唐诗/宋词/元曲中与六座预置城市相关的 868 首作品（每城 150 首），繁转简仅用于比对，保留原文 |
| `server/data/fact_snapshot/{cityId}.json` | `build_fact_snapshot.ts` | 六座预置城市的 Wikidata 景点/文物/人物事实快照 |
| `server/data/relics_registry.json` | `build_relics_registry.ts` | 由快照汇总的 427 件文物名录（国保 / 禁止出境展览文物） |
| `server/data/place_gazetteer.json` | `build_place_gazetteer.ts` | 862 条 WGS84 地名坐标（城市中心 + 景点 + 文物） |
| `server/data/dynasties.json` | 人工整理 | 固定朝代年表（起止年份），待人工复核 |

产物中的每条实体均带 `sourceRef`/`sourceRefs`；`server/data/*.db*` 为运行时数据库，不提交。

## 无 Key 开发模式

项目在没有 LLM Key、没有天地图 Key 时也能完整开发与自测：

- 未配置 `LLM_API_KEY`：服务端启用**模拟 LLM**，仍然走完整的流式、单飞、冷却、限流与降级路径，输出带 `mock` 标记，绝不写入预置档案。
- 未配置 `TIANDITU_KEY`：前端使用**无底图模式**，只绘制行政区轮廓与宣纸底色。
- `ENABLE_IMAGES=false`（默认）：不请求任何外部图片。

配置真实 Key：复制 `.env.example` 为 `.env`，填写 `LLM_API_KEY`、`TIANDITU_KEY`。密钥只在服务端读取，前端构建产物不包含任何密钥。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务端口 | `8787` |
| `LLM_API_KEY` | DeepSeek 兼容接口密钥；为空则启用模拟 LLM | 空 |
| `LLM_BASE_URL` | 大模型接口地址 | `https://api.deepseek.com` |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |
| `TIANDITU_KEY` | 天地图 Key；为空则无底图模式 | 空 |
| `ADMIN_TOKEN` | 预置城市强制重生成令牌 | 空 |
| `LLM_DAILY_CALL_LIMIT` | 每日 LLM 调用预算 | `500` |
| `ENABLE_IMAGES` | 是否启用 Commons 图片 | `false` |
| `IP_HASH_SALT` | 请求方 IP 哈希盐，生产环境必须修改 | `citylens-dev-salt` |
| `SIMULATE_FAIL` | 模拟指定模块失败，如 `poetics,figures` | 空 |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 服务状态与 Key 配置情况 |
| GET | `/api/cities/search?q=` | 城市规范化检索（古称/拼音/英文/区县/纠错/消歧） |
| GET | `/api/cities/hot` | 热门城市（预置城市优先） |
| GET | `/api/cities/:cityId` | 读取缓存档案 |
| POST | `/api/cities/:cityId/generate` | SSE 流式生成（阶段 3） |

SSE 事件：`meta` → `theme` → 8 个 `module`（可穿插 `module_error`）→ `done`；`ping` 每 15s 保活。

## 数据真实性

- 景点、文物、人物、诗词、坐标、统计数值全部来自构建期脚本产物、本地名录或可核验的公开来源，每项都带 `sourceRefs` 与 `verification`。
- 无法取得或无法核验的内容统一填「待考」，`verification` 为 `pending_human_review`，不会用看似合理的内容充数。
- 预置城市的叙事文字为人工/AI 整理，`verification` 不冒充人工复核。人工抽查由用户按 PRD 7.2 完成。
- 文件中的 `preset_manual` / `curated` 字段表示人工整理内容，仍需人工复核。
