# CityLens E2E 关键路径实测记录

> 2026-11-11 使用 ego-browser（ego lite，用户指定）对本地生产模式服务端实测。
> 服务端：`NODE_ENV=production npm start`（托管 `client/dist`，:8787）；前端为生产构建产物。
> 2026-11-12 演讲彩排复跑：生产构建托管于 :8788，脚本 `C:/Users/19949/ego/citylens-demo-20261112/round-*.mjs`，截图 `.screenshots/demo-20261112/`。
> 2026-11-13 分享海报复跑：脚本 `C:/Users/19949/ego/citylens-share-20261113/round-*.mjs`，截图 `.screenshots/share-20261113/`。
> 所有脚本存档于 `C:/Users/19949/ego/<目标>-20261111/round-*.mjs`，截图存档于项目 `.screenshots/`。

## 可执行回归（2026-11-14 新增，2026-11-14 二轮强化，2026-11-14 三轮扩展，零新增依赖）

`e2e/regression.mjs` 基于 Chrome DevTools Protocol（Node 内置 WebSocket），
自建临时数据库 + 模拟 LLM + 预置档案，**不依赖真实密钥，也不读写用户现有缓存**：

```bash
npm run e2e                 # 完整跑一遍（自起服务端 :8799 与 headless Chrome）
E2E_KEEP=1 npm run e2e      # 保留服务端/Chrome 便于调试
E2E_BASE_URL=http://127.0.0.1:8788 npm run e2e   # 复用外部服务端（写型场景自动 SKIP）
```

| # | 场景 | 断言 |
|---|---|---|
| 1 | 搜索直达 | 「长安」→ 跳转 `/city/CN-610100`，页面含西安 |
| 2 | 缓存城市 | 预置西安「已为你复用」、八卷 + 行旅工具分区齐全、身份卷渲染 |
| 3 | 失败重试 | force 重生成（SIMULATE_FAIL=identity，种子档案含合格旧内容）后失败卷有「重试此卷」、旧内容（identity 旧 persona）仍在、失败提示「本次更新失败，继续展示旧内容」可见、其他卷正常、档案未下架、重试后无白屏 |
| 4 | 应用内切城竞态 | 旧城市请求在途时经应用内导航切到杭州；迟到响应不覆盖新城市、未经整页刷新 |
| 5 | 双城对比 | `/compare?cities=CN-610100,CN-330100` 双城 + 经济指标渲染 |
| 6 | 分享海报 | 弹窗内 750×1334 预览图解码完成；导出 PNG（image/png、体积合理）；失败注入必须被检测 |

2026-11-14 三轮实测结果：**19/19 通过**（搜索 1、缓存 3、失败重试 7、切城 4、对比 1、海报 3）。
其中失败重试场景自三轮起覆盖「已有合格旧内容 → 刷新失败 → 旧内容仍在且可以单卷重试」：
identity 在种子档案中有旧 persona，刷新失败后旧内容回放不清空、失败提示与单卷重试入口同时可见。

隔离与可信度设计：
- 数据库（`DB_PATH`）与全部运行期缓存（`CITYLENS_RUNTIME_DIR`：侦察/检索/气候/用量/按需快照）
  均在系统临时目录；预置六城与构建期产物只读；测试城市的侦察 stub 写在临时运行期目录内。
- 写型场景（重新生成/重试）只对自建隔离服务端执行；`E2E_BASE_URL` 指向外部服务时显式 SKIP，
  绝不对外部服务发起写操作（预置城市保护在服务端强制生效）。
- 海报断言限定在分享弹窗内的预览 `<img>`（`[role="dialog"] img[alt$="城市海报预览"]`），
  等待 `naturalWidth/Height` 解码完成并校验 750×1334；导出路径通过捕获 `URL.createObjectURL`
  的 Blob 验证类型与体积；另有一条「失败注入」用例破坏 canvas 渲染，
  证明断言不会因为背景水墨 canvas 而蒙混通过。
- 切城用例通过页面内注入的 fetch 延迟制造真实的迟到响应，并用 SPA 标记验证没有整页刷新。
- 未模拟的外部依赖：实时天气（Open-Meteo current）——失败时前端回退气候基线，不影响任何断言，
  此处如实标记，不宣称完全离线。
- 失败时输出页面 console/异常诊断（前 10 条）与失败用例明细；进程按树结束（taskkill /T /F），
  临时目录带重试清理。

## 运行方式（ego-browser 人工走查）

```powershell
# PowerShell 5.1 无 heredoc，且 -e 参数不能含双引号/中文：
ego-browser nodejs -e "await import('file:///C:/Users/19949/ego/<目标>-20261111/round-01.mjs')"
```

脚本内使用 `taskSpace(name)` 复用同一任务空间；每轮写新的完整 `.mjs` 文件；
浏览器内 JS 只能写在 `page.evaluate()` 回调里；ego 运行时不支持 TypeScript 断言语法。

## 已覆盖路径

| # | 路径 | 结果 | 证据 |
|---|---|---|---|
| 1 | 搜索 → 消歧（suzhou 弹消歧卡） | 通过（AC-02 既有记录） | `server/services/normalizer.test.ts` |
| 2 | 流式生成（未缓存城市） | 通过：镇江/宁波 8/8 卷，meta 46ms/11ms，identity 3.62s/4.78s，`generator.model=step-3.7-flash@stepfun` | FEATURES AC-04 |
| 3 | 缓存命中 | 通过：宁波二次访问 `fromCache=true` 51ms，`[CACHE HIT] latency=0ms` | FEATURES AC-03/AC-04 |
| 4 | 重新生成（取消/确认/冷却/预置保护） | 通过四步：取消后 generate 请求 0；确认后 v9→v17；5 分钟冷却提示 140s；预置城市保护提示 | `.screenshots/ac08/`，脚本 `ac08-20261111/round-01.mjs` |
| 5 | 收藏 / 最近浏览 | 通过（AC-11 既有记录） | `useLocalLibrary` + CDP 实测 |
| 6 | 双城对比 | 通过：`/compare?cities=CN-610100,CN-330100` 双列渲染（GDP 取最新非空年份、待考处理）；`/api/compare` 集成测试 4 项 | `server/routes/compareRoutes.test.ts` |
| 7 | 一日路线 | 通过：西安页「如果只有一天」section + 地图连接线 + 「示意路线 · 非导航」标注；2026-11-12 复测 5 张地图（景点/文物/名人/诗境/一日）随视口逐张挂载，375/768/1280 均无横向滚动 | `.screenshots/a11y/resp-*.png`、`.screenshots/demo-20261112/30-maps-verified.png`，`dayTripService.test.ts` 3 项 |
| 8 | 知识小测验 | 通过：西安页「随堂小测」section，题目来自档案事实字段，本地判分 | `quizService.test.ts` 4 项 |
| 9 | 分享与海报 | 通过：CityHero「分享此卷」→ 弹窗（复制链接 / 生成海报）→ 750×1334 预览 → 下载 PNG `读城-西安-2026-11-11.png`，183,068 字节；北京长诗句夹注过滤后无出格（2026-11-13） | `poster.test.ts` 5 项、`share.test.ts` 2 项、`qr.test.ts` 2 项；`.screenshots/share-20261113/02-poster-preview.png`、`04-beijing-poster-preview.png` |
| 10 | 404 / 异常城市 | 通过：`/city/CN-000000` 显示「版图中暂无此城」+ 热门名城入口 | `.screenshots/a18-20261111/` 相关轮次 |
| 11 | 真实断网（用户侧 + 服务侧 + LLM 黑洞） | 通过：预置/缓存城市完整；LLM 失败时 7 卷 `module_error LLM_TIMEOUT`、dataPulse 本地侦察成卷、无白屏 | `.screenshots/ac18/` + `guilin-llm-blackhole.sse` |
| 12 | 可访问性（axe/键盘/响应式/暗色） | 通过：应用自身 0 违规；三档无横向滚动；地图不拦截滚动 | `.screenshots/a11y/` |

## 演示路径（演讲用，2026-11-12 彩排）

**演示前检查**

1. `npm run build`；`NODE_ENV=production PORT=8788 npm start`（或 :8787）
2. 6 座演示城市接口均 `fromCache=true`、8 卷齐全：西安 CN-610100 / 杭州 CN-330100 / 宁波 CN-330200 / 镇江 CN-321100 / 泉州 CN-350500 / 桂林 CN-450300
3. 浏览器缩放 100%；非预置档案在本地 SQLite（gitignored），换机需提前生成或只用预置六城

**点击顺序**

1. 首页搜索「长安」→ 西安；展示「匹配古称 / 别称」与消歧提示
2. Hero → 八卷滚动；朝代滑块拖到「唐」，看水印、年号与地图联动
3. 景点卡 ↔ 地图 Marker；文物卡「图上寻迹」→ 气泡与卡片高亮
4. 诗词意象「长安」悬停 → 批注气泡 + 诗境地图约 1000m 示意范围
5. 「如果只有一天」→ 上午 / 下午 / 晚上三槽 + 示意路线（非导航）
6. 「随堂小测」答 3 题 → 提交批改 → 得分、解析与来源
7. 「分享此卷」→ 复制链接 / 生成海报 → 下载 PNG（实测 183KB，含二维码）
8. `/compare?cities=CN-610100,CN-330100` → 暗色模式 → `/city/CN-000000`

**降级话术**

- 预置 / 缓存城市无网可用；新城市生成依赖网络与 LLM，现场不演示实时生成
- 天地图瓦片失败时仍显示行政区轮廓与点位，明确说明「无底图模式」
- 地图进入视口才挂载，滚动到位后约 1 秒出现，属预期懒加载

**禁止项**

- 现场生成全新城市（实测 150–165s）
- 现场重跑 Lighthouse 或修改后台配置

## 复现命令（接口层）

```bash
# 流式生成（未缓存城市）
curl.exe -sN -X POST http://localhost:8787/api/cities/CN-321100/generate -H "Content-Type: application/json" -d "{}"

# 缓存命中
curl.exe http://localhost:8787/api/cities/CN-330200

# 双城对比
curl.exe "http://localhost:8787/api/compare?cities=CN-610100,CN-330100"

# 一日路线 / 小测验 / 实时天气（西安为已生成城市）
curl.exe http://localhost:8787/api/cities/CN-610100/daytrip
curl.exe http://localhost:8787/api/cities/CN-610100/quiz
curl.exe http://localhost:8787/api/cities/CN-610100/weather

# 未成卷城市的实时层（daytrip 走 Wikidata 快照回退，weather 只用词典坐标）
curl.exe http://localhost:8787/api/cities/CN-350500/daytrip
curl.exe http://localhost:8787/api/cities/CN-350500/weather
```

## 已知限制

- 二维码编码当前页面 origin；本地 `localhost` / `127.0.0.1` 二维码手机不可达，
  演示请用局域网 IP 或公网域名打开页面。
- ego-browser 自动化点击「复制链接」会触发浏览器剪贴板权限提示；真实用户点击后授权即可。
  未授权时弹窗内提供只读链接，聚焦即可全选后手动复制。
- 本机 Lighthouse（2026-11-13，Desktop 3 轮 / Mobile 2 轮）：Desktop 0.79 / 0.82 / 0.99（中位数 0.82），
  Mobile 0.89 / 0.90（中位数 0.895），SEO 0.92 / A11y 1.00；AC-16 已按中位数通过；
  LCP 审计值仍有轮次波动，报告与复现命令见 FEATURES AC-16。
- ego-browser 扩展会向页面注入自带 DOM，axe 的 button-name/image-alt/link-name/
  landmark-unique 残留告警来自扩展本身，应用自身为 0 违规。
