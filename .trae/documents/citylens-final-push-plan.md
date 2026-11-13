# CityLens 收尾推进计划（2026-11-12）

## 1. 目标与边界

**目标**：把剩余 P0 中「代理可执行」的部分闭环，并为「只能由用户完成」的复核/合规项准备好证据。

1. AC-16 Lighthouse 可信复跑（19 条 AC 中唯一未闭环项）
2. 演讲演示彩排 + 演示脚本 + 海报下载补证
3. 天地图人工走查截图 + 7.2 复核证据索引
4. 验收文档回写 + 四道门禁复跑

**明确不做**：

- 不新增业务功能，不建后台复核工作台（人工复核只提供证据与模板，不代签）
- 不做 P1 数据大规模补全（194 城无诗、14 件文物无图等保持现状）
- 不切换行政区轮廓数据源（DataV → 天地图涉及 GCJ-02 与合规判定，留用户拍板）
- 不自动 git commit（如需提交，执行前由用户确认）
- 不把任何「程序化自测通过」写成「人工复核通过」

## 2. 当前基线（已勘察确认）

| 项 | 事实 | 依据 |
|---|---|---|
| 今日门禁 | typecheck 0 错误；170 测试 / 25 文件全过；verify 6/6 城 48 卷 | 2026-11-12 实跑 |
| DB 档案 | 26 城全部 `status=partial`；预置 6 城 `is_preset=1` | `server/data/citylens.db` 只读查询 |
| 演示城市 | CN-610100 西安、CN-330100 杭州、CN-330200 宁波、CN-321100 镇江、CN-350500 泉州、CN-450300 桂林，均 8 卷（poetics=ok，其余 degraded） | 同上 |
| 环境变量 | LLM_API_KEY / LLM_BASE_URL / LLM_MODEL、天地图双 Key、Tavily、ADMIN_TOKEN 均已配置 | `.env` 仅核对键名 |
| Lighthouse | 依赖 13.6.0 已安装；CLI 支持 `--port` 连接已启动 Chrome（`cli-flags.d.ts:69`） | `node_modules/lighthouse` |
| 生产托管 | `client/dist` 由服务端静态托管，端口读 `PORT` | `server/config.ts:20/25`、`server/index.ts:134` |
| 已知缺口 | AC-16 分数不可信；海报下载未留证；7.2 共 17 项 0 签字；DataV 审图号未确认 | `FEATURES_AND_VERIFICATION.md` |
| 终端限制 | PATH 超长导致 npm script 找不到 `tsc/vitest/tsx`；改用 node 入口调用 | 本次复跑验证 |

## 3. 工作流 A：AC-16 Lighthouse 可信复跑（先做）

### A1 生产构建与启动

在项目根目录执行（避开 PATH 截断，直接调 node 入口）：

```powershell
node node_modules/typescript/bin/tsc -p client/tsconfig.json --noEmit
node node_modules/vite/bin/vite.js build          # cwd = client
$env:NODE_ENV='production'; $env:PORT='8788'
node node_modules/tsx/dist/cli.mjs server/index.ts # 后台运行
```

校验：`curl http://127.0.0.1:8788/api/health` 返回 200，且页面 `/city/CN-610100` 可访问。

### A2 复用已启动 Chrome（关键：绕开冷启动污染）

```powershell
Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList `
  '--headless=new','--remote-debugging-port=9222',`
  "--user-data-dir=$env:TEMP\citylens-lh-20261112",`
  '--no-first-run','--no-default-browser-check','about:blank'
```

先跑一轮预热（丢弃），再跑正式两轮，正式轮复用同一 Chrome 实例：

```powershell
node node_modules/lighthouse/cli/index.js http://127.0.0.1:8788/city/CN-610100 `
  --port=9222 --only-categories=performance,seo,accessibility `
  --output=json --output-path=.lighthouse/warmup.json

node node_modules/lighthouse/cli/index.js http://127.0.0.1:8788/city/CN-610100 `
  --port=9222 --only-categories=performance,seo,accessibility `
  --output=json --output-path=.lighthouse/final-desktop.json
```

Mobile 追加 `--form-factor=mobile --screenEmulation.mobile`，输出 `final-mobile.json`。

### A3 判定

- 达标：Desktop Performance ≥ 80，Mobile Performance ≥ 70；SEO/A11y 记录实际值。
- 用 node 读取 JSON 的 `categories.*.score` 与 `audits` 中 LCP/TBT/CLS/FCP/SI 的 `numericValue`，写入验收记录。
- 若仍出现「报告终值远大于 trace 内 observedLCP」的冷启动伪差，如实记 BLOCKED，不伪造分数。

### A4 仅在未达标时做最小优化（最多 2 轮）

按序排查，禁止启用 `manualChunks`（已知会把动态边界合并进父 chunk）：

1. `client/index.html`：首屏字体 `preload`（仅自托管 woff2，不引 CDN）
2. `client/src/components/hero/InkCanvas.tsx`：动画初始化延迟到 `requestIdleCallback`（保留 reduced-motion 降级）
3. `client/src/components/modules/RelicsModule.tsx`：确认图片 `loading="lazy"` 与尺寸占位（已具备，仅在 CLS 问题时调整）
4. 其余优化只做能明确归因于某个 audit 的最小改动；每轮重跑 A2 并保留报告

### A5 文档回写（唯一允许的文档改动）

- `FEATURES_AND_VERIFICATION.md`
  - AC-16 行（约 L120）：改为可信复跑结果，列 Desktop/Mobile/SEO/A11y、报告路径、是否达标
  - 2.3 未完成表（L91–L98）：Lighthouse 行同步
  - 6.2 性能（L199–L208）：补最终分数与命令
- `e2e/README.md`「已知限制」（L56–L59）：若已可信复跑，更新为「已复跑，见报告」；否则保留

## 4. 工作流 B：演讲演示彩排与演示包

### B1 接口层核验（先确认演示城市全部秒开）

对 6 座演示城市逐个请求：

```powershell
curl.exe http://127.0.0.1:8788/api/cities/CN-610100
curl.exe http://127.0.0.1:8788/api/cities/CN-330100
curl.exe http://127.0.0.1:8788/api/cities/CN-330200
curl.exe http://127.0.0.1:8788/api/cities/CN-321100
curl.exe http://127.0.0.1:8788/api/cities/CN-350500
curl.exe http://127.0.0.1:8788/api/cities/CN-450300
```

记录 `fromCache`、8 卷是否齐全、响应耗时。任何一座缺卷则改用同城已有档案城市替代，不现场重新生成。

### B2 浏览器全流程彩排（ego-browser，用户指定）

视口 1280×900 与 375×812 各走一遍，截图存 `.screenshots/demo-20261112/`：

1. 首页搜索「长安」→ 进入西安；记录主题色与 hero
2. 八卷滚动；朝代滑块拖到「唐」→ 水印/年号/地图联动
3. 景点卡 ↔ 地图 Marker 双向联动；文物卡「图上寻迹」
4. 诗词意象悬停 → 批注气泡 + 诗境地图高亮
5. 「如果只有一天」路线 + 「随堂小测」答 3 题
6. 「导出长图」→ 下载 PNG（补 e2e 已知缺口：记录文件名与字节数）
7. `/compare?cities=CN-610100,CN-330100` 双城对比
8. 暗色模式切换；`/city/CN-000000` 异常城市页
9. 375 视口复跑关键 3 步（hero/地图/路线），确认无横向滚动

### B3 降级路径

- 复用 AC-18 三层断网证据，不重复全量实验。
- 演示口径固定为：「预置/缓存城市无网可用；新城市生成依赖网络与 LLM，现场不演示实时生成」。
- 若现场天地图瓦片失败，降级为行政区轮廓 + 明确说明。

### B4 演示脚本落盘（改现有文档，不新建 md）

在 `e2e/README.md` 增加「演示路径（演讲用）」一节，内容：

- 演示前检查：构建产物、服务端口、6 城 `fromCache`、Chrome 缩放 100%
- 点击顺序（B2 的 1–8）
- 预期画面与降级话术
- 禁止项：现场生成全新城市（150–165s）、现场重跑 Lighthouse、现场改后台配置
- 换机提醒：非预置档案在本地 SQLite（gitignored），换机需提前重新生成或只用预置六城

## 5. 工作流 C：人工复核与合规证据

- C1 天地图走查截图：西安页 1280/375，各截「底图瓦片 + 注记 + 地标点位」一张，存 `.screenshots/tianditu-20261112/`；供用户判断注记与坐标偏移。
- C2 7.2 证据索引：只补「证据」列中的产物路径（报告/截图），记录人/日期/结论三列保持空白。
- C3 合规决策要点：执行完在回复中给出 DataV 与天地图两套来源的授权/审图号/坐标系对比，供用户拍板；不改代码、不切换默认源。
- C4 文物图片：沿用 7.4 逐张表与线上卡片，不新建 contact sheet；彩排时截一张文物图卡片作为证据。

## 6. 工作流 D：收尾门禁

```powershell
node node_modules/typescript/bin/tsc -p server/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p client/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/tsx/dist/cli.mjs scripts/verify_presets.ts
node node_modules/vite/bin/vite.js build   # cwd = client
```

- 全部通过后 `git status --short` 列出改动文件，交用户确认是否提交。
- 最终回复更新进度口径：开发实现度、验收闭环度、演讲准备度三个百分比。

## 7. 验收标准

- `.lighthouse/final-desktop.json`、`final-mobile.json` 存在，分数与判定写入 AC-16；不可信则如实标 BLOCKED。
- 6 座演示城市接口均 `fromCache=true`、8 卷齐全；彩排 8 步全部通过并留截图。
- 海报下载留证（文件名 + 字节数）；若浏览器限制，明确记录未留证原因。
- `e2e/README.md` 含「演示路径（演讲用）」。
- 7.2 人工签字列仍为空；文档中无「人工复核通过」字样。
- 四道门禁全过；未执行 git commit（除非用户确认）。

## 8. 风险与回退

| 风险 | 回退 |
|---|---|
| Lighthouse 仍被冷启动污染 | 记录 BLOCKED + trace 观测值，不伪造；建议换机复跑 |
| 性能不达标且优化无效 | 最多 2 轮，保留数据与 top audits，不做架构级改造 |
| 彩排发现功能缺陷 | 只修影响演示的阻断问题；其余记录为已知限制 |
| Chrome/端口冲突 | 换 9223 调试端口与独立 user-data-dir；服务端口换 8789 |
| 文档改动误写「已复核」 | 提交前全文搜索「人工复核通过」核对；签字列必须为空 |

## 9. 执行顺序

A（AC-16）→ B（彩排 + 演示脚本）→ C（走查截图 + 证据索引）→ D（门禁 + 状态汇报）。A 阻塞时先做 B，不空等。
