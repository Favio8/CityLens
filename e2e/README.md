# CityLens E2E 关键路径实测记录

> 2026-11-11 使用 ego-browser（ego lite，用户指定）对本地生产模式服务端实测。
> 服务端：`NODE_ENV=production npm start`（托管 `client/dist`，:8787）；前端为生产构建产物。
> 2026-11-12 演讲彩排复跑：生产构建托管于 :8788，脚本 `C:/Users/19949/ego/citylens-demo-20261112/round-*.mjs`，截图 `.screenshots/demo-20261112/`。
> 所有脚本存档于 `C:/Users/19949/ego/<目标>-20261111/round-*.mjs`，截图存档于项目 `.screenshots/`。

## 运行方式

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
| 9 | 长图海报 | 通过：CityHero「导出长图」→ PosterDialog（Canvas 预览）→「下载 PNG」实测下载 `读城-西安-2026-11-11.png`，173,108 字节（2026-11-12） | `poster.test.ts` 4 项；`.screenshots/demo-20261112/26-poster-dialog.png` |
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
7. 「导出长图」→ 下载 PNG（实测 173KB）
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

- 本机 Lighthouse（2026-11-13，Desktop 3 轮 / Mobile 2 轮）：Desktop 0.79 / 0.82 / 0.99（中位数 0.82），
  Mobile 0.89 / 0.90（中位数 0.895），SEO 0.92 / A11y 1.00；AC-16 已按中位数通过；
  LCP 审计值仍有轮次波动，报告与复现命令见 FEATURES AC-16。
- ego-browser 扩展会向页面注入自带 DOM，axe 的 button-name/image-alt/link-name/
  landmark-unique 残留告警来自扩展本身，应用自身为 0 违规。
