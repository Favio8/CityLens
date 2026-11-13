# CityLens 分享弹窗与可扫码海报计划（2026-11-13）

## 1. 目标

把城市页当前「分享此卷 = 直接复制链接」改成一次完整的分享体验：

1. 点击「分享此卷」打开弹窗，提供「复制链接」与「生成海报」两条路径；
2. 海报重做为固定 9:16 竖版，排版美观、适合朋友圈/小红书传播；
3. 海报右下角带二维码，扫码直达该城页面；
4. 支持下载 PNG；移动端支持系统分享图片（`navigator.share` 可用时）。

## 2. 当前基线（已勘察）

| 项 | 事实 | 依据 |
|---|---|---|
| 分享入口 | 「分享此卷」直接 `navigator.clipboard.writeText(window.location.href)`，按钮文字临时变「链接已复制」 | `CityHero.tsx:70-78`、`:221-228` |
| 海报入口 | 另有独立「导出长图」按钮，打开 `PosterDialog` | `CityHero.tsx:250-258`、`:313-317` |
| 海报实现 | `buildPosterSpec` 提取城名/人设/景点/文物/人物/诗题/统计；`renderPoster` 动态高度长图，750px 宽，无二维码 | `client/src/lib/poster.ts:8-95`、`:103-211` |
| 海报弹窗 | `PosterDialog` 有 Canvas 预览、下载 PNG、焦点陷阱、Esc | `client/src/components/poster/PosterDialog.tsx:10-102` |
| 样式 | 按钮 `ink-btn`、卡片 `surface-card`、主题 CSS 变量、`font-serif` / `quote-serif` 已在全局定义 | `client/src/styles/global.css` |
| QR 依赖 | `package.json` / `package-lock.json` / `node_modules` 中没有二维码库 | 已检索 |
| 测试 | `poster.test.ts` 覆盖 spec 提取与文件名；无分享/二维码测试 | `client/src/lib/poster.test.ts` |

## 3. 方案

### 3.1 依赖与纯函数

- 新增客户端依赖：
  - `npm install qrcode-generator -w client`
  - `npm install -D @types/qrcode-generator -w client`
  - 若 `@types/qrcode-generator` 不可用，则在 `client/src/types/qrcode-generator.d.ts` 声明最小类型；不要引入外部 CDN。
- 新增 `client/src/lib/share.ts`：
  ```ts
  export function buildShareUrl(cityId: string, origin = window.location.origin): string {
    return new URL(`/city/${encodeURIComponent(cityId)}`, origin).toString();
  }
  ```
- 新增 `client/src/lib/qr.ts`：
  ```ts
  import qrcode from 'qrcode-generator';
  export function createQrMatrix(text: string, ecc: 'L'|'M'|'Q'|'H' = 'M'): boolean[][];
  ```
  - 用 `qrcode(0, ecc)` → `addData(text)` → `make()` → `getModuleCount()` / `isDark(row, col)`。
  - 纯函数、同步、可在 node 测试中运行。

### 3.2 海报重做（固定 9:16，含二维码）

修改 `client/src/lib/poster.ts`：

- `PosterSpec` 新增：
  - `shareUrl: string`；
  - `poemLines: string[]`（取 `archive.poetics[0].lines.slice(-2)`，无诗则为空）。
- `buildPosterSpec(archive, shareUrl)` 第二个参数必填；测试同步传入。
- `renderPoster(spec)` 改为固定 **750 × 1334**（9:16），不再动态增高：
  - 纸面 `#f7f4ed`，外框 24px，主题色细线；
  - 顶部：`CITYLENS · 读城` + 右侧城市印章（城名首字，旋转 -4°，主题色）；
  - 城名 96px 宋体居中，下方省份 / 坐标 / 古称；
  - 人格引文最多 3 行，超出行末省略；
  - 「三枚城市切片」：代表景点 / 文物 / 人物三列，各取 1 条；
  - 「诗句中的城」：`poemLines` 两行大字 + 朝代·作者；无诗时显示「诗词待考」；
  - 「数说城市」：GDP / 常住人口 / 气候三项，带年份与单位；缺失显示「待考」；
  - 二维码区（约 180px）：白底、深色模块、4 模块静区；右侧「扫码读城」+ 截短 URL；
  - 页脚：来源数、生成日期、AI 整理免责声明；
  - 背景加 1–2 个大号半透明城名水印与细线，保持「宣纸 + 印章」气质，不引入外部图片。
- 二维码绘制：
  - 用 `createQrMatrix(spec.shareUrl)`；
  - `moduleSize = Math.floor(180 / (count + 8))`，整数像素绘制，避免模糊；
  - 深色模块 `#1e1e1e`，背景 `#ffffff`；
  - 若 URL 过长导致模块过密，仍保持 180px，不缩字号；URL 文本在右侧截断显示。
- 字体：`PosterPreview` 在绘制前 `await Promise.race([document.fonts.ready, 1500ms 超时])`，确保 Noto Serif SC 已就绪；超时则用回退字体继续渲染，不阻塞。

### 3.3 新分享弹窗

新增 `client/src/components/share/ShareDialog.tsx`：

- Props：`open`、`archive: CityArchiveResponse | null`、`onClose`。
- 使用 `useFocusTrap(open, onClose)`；`role="dialog"`、`aria-modal`、Esc 关闭、焦点还原。
- 视图状态：`view: 'menu' | 'poster'`，打开时重置为 `menu`。
- 菜单视图：
  - 标题「分享此卷」+ 城市名；
  - 两张操作卡：
    - **复制链接**：调用 `navigator.clipboard.writeText(shareUrl)`，失败时用临时 `textarea + document.execCommand('copy')` 兜底；2 秒内显示「链接已复制」。
    - **生成海报**：切到 `poster` 视图；
  - `navigator.share` 存在时显示「系统分享」文字按钮，分享 `{ title, text, url }`；
  - 展示可复制的 URL（`mono` 小字），便于手动复制。
- 海报视图：
  - `React.lazy(() => import('./PosterPreview'))`，`Suspense` 占位；
  - `PosterPreview` 接收 `archive`、`shareUrl`，渲染预览 + 操作：
    - 「返回」回到菜单；
    - 「下载 PNG」（`canvas.toBlob`，文件名沿用 `posterFileName(spec)`）；
    - `navigator.canShare({ files })` 时显示「分享图片」，否则只显示下载；
  - 失败时显示「海报生成失败，请重试」，不出现空白图。
- 新增 `client/src/components/share/PosterPreview.tsx`：
  - 负责 `buildPosterSpec` + `renderPoster` + `toDataURL`；
  - 下载/系统分享逻辑从旧 `PosterDialog` 迁移；
  - 预览 `max-h-[60vh] object-contain`，移动端可长按保存；
  - `aria-live` 反馈复制/分享结果。

### 3.4 Hero 入口调整

修改 `client/src/components/hero/CityHero.tsx`：

- 删除 `copied` 状态与直接复制的 `share()`；
- 新增 `shareOpen` 状态；
- 「分享此卷」按钮改为 `onClick={() => setShareOpen(true)}`，改为 `col-span-2` 主按钮（`ink-btn--solid`）；
- 删除独立「导出长图」按钮与 `posterOpen` 状态；
- 删除 `PosterDialog` 引用，改为：
  ```tsx
  <ShareDialog open={shareOpen} archive={archive ?? null} onClose={() => setShareOpen(false)} />
  ```
- 删除 `client/src/components/poster/PosterDialog.tsx`（由 ShareDialog/PosterPreview 取代），避免死代码。

### 3.5 性能与包体

- `PosterPreview` 必须由 `React.lazy` 动态加载，确保 `poster.ts` + `qrcode-generator` 不进入 CityPage 首屏 chunk。
- 构建后检查：
  - `CityPage-*.js` 体积不应明显增长（当前约 85.18 kB / gzip 28.92 kB）；
  - 新增 `PosterPreview-*.js` 独立 chunk。
- 不改动 AC-16 已通过的字体、地图懒加载与 CLS 策略。

### 3.6 测试与文档

- `client/src/lib/poster.test.ts`：
  - `buildPosterSpec(archive(), 'https://example.com/city/CN-610100')`；
  - 断言 `shareUrl`、`poemLines`、现有字段不回归。
- 新增 `client/src/lib/share.test.ts`：`buildShareUrl` 正常/带尾斜杠 origin。
- 新增 `client/src/lib/qr.test.ts`：矩阵为正方形、尺寸 ≥21、左上角 7×7 定位图案存在；不依赖 Canvas。
- 更新 `FEATURES_AND_VERIFICATION.md`：
  - 「长图海报」行改为「分享弹窗 + 9:16 可扫码海报」；
  - 记录下载、系统分享、二维码 URL 与本地演示限制。
- 更新 `e2e/README.md`：
  - 演示步骤 7 改为「分享此卷 → 复制链接 / 生成海报 → 下载 PNG」；
  - 已知限制补「二维码使用当前页面 origin；本地 localhost 二维码手机不可达，演示请用局域网 IP 或公网域名」。

## 4. 决策与假设

- **只保留一个分享入口**：移除独立「导出长图」，避免两个入口重复；海报从分享弹窗进入。
- **固定 9:16 海报**：比当前动态长图更适合社交传播；内容做取舍，不追求把所有档案塞进一张图。
- **二维码编码当前城市页 URL**：`origin + /city/:id`，不附带查询参数；本地 localhost 不可扫码，属部署限制，写入文档。
- **二维码库选 `qrcode-generator`**：纯 JS、无 Node 依赖、体积小，适合 Vite 客户端；不引外部 QR 图片 API。
- **系统分享渐进增强**：`navigator.share` / `navigator.canShare` 不可用时只显示复制与下载，不报错。
- **不改变真实性口径**：海报中的缺失数据继续显示「待考」，不估算、不补写。
- **不新增后端接口**：分享与二维码完全在客户端完成，API Key 不进入海报。

## 5. 验证步骤

1. `typecheck`（server + client）0 错误。
2. `vitest run`：170 项既有测试 + 新增 share/qr/poster 测试全部通过。
3. `vite build` 成功；确认 CityPage chunk 未明显增大、PosterPreview 独立 chunk 存在。
4. ego-browser（用户指定）：
   - 城市页点击「分享此卷」→ 弹窗出现，包含「复制链接」「生成海报」；
   - 点击复制 → 出现「链接已复制」；通过 `navigator.clipboard.readText` 或页面状态验证 URL；
   - 点击生成海报 → 预览出现，图片尺寸 750×1334，二维码区域有深色模块；
   - 点击下载 → 下载 PNG，文件名 `读城-西安-YYYY-MM-DD.png`，字节数 > 100KB；
   - 375 宽度复测：弹窗不溢出、按钮可点、海报可滚动查看；
   - 关闭弹窗后焦点回到「分享此卷」按钮。
5. 海报二维码指向 `origin/city/:id`；在公网/局域网地址下用手机扫码验证（如环境允许）。
6. 更新 FEATURES 与 e2e README，确保无「人工复核通过」误写。

## 6. 风险与回退

| 风险 | 回退 |
|---|---|
| `qrcode-generator` 类型缺失或导入失败 | 加本地 `.d.ts`；仍失败则改用 `qrcode` 包或内联最小 QR 实现 |
| 海报字体未加载导致排版偏差 | `document.fonts.ready` + 1.5s 超时；超时用回退宋体继续 |
| 二维码在深色/复杂背景不可扫 | QR 固定白底 + 深色模块 + 4 模块静区，不叠加装饰 |
| 本地 localhost 二维码手机不可达 | 文档说明；演示用局域网 IP 或公网域名 |
| 移除「导出长图」影响旧文档/测试 | 同步更新 e2e README、FEATURES；构建与测试兜底 |
| 海报 chunk 影响首屏性能 | `React.lazy` 动态加载；构建后核对 chunk 体积，必要时进一步拆分 |
