# CityLens AC-16 Desktop 收口计划（2026-11-13）

## 1. 目标

把 Desktop Lighthouse Performance 从当前中位数 **0.79** 推到 **≥0.80**，同时保持 Mobile 中位数 ≥0.70；若无法达成，保留现状并如实记录，不做进一步架构改造。

## 2. 当前基线（已勘察）

| 项 | 事实 | 依据 |
|---|---|---|
| Desktop 分数 | 0.79 / 0.80 / 0.79，中位数 0.79 | `.lighthouse/ac16-desktop-r1~r3.json` |
| Mobile 分数 | 0.73 / 0.75，中位数 0.74（已达标） | `.lighthouse/ac16-mobile-r1~r2.json` |
| Desktop LCP | 审计 3.71s；trace 观测 535ms | `ac16-summary.json` |
| LCP 元素 | `IdentityModule` 城市人格引文 `<p className="font-serif ...">` | `client/src/components/modules/IdentityModule.tsx:80` |
| 字体 | Noto Serif SC 子集 2.73MB，preload + `font-display: optional` | `client/index.html:12`、`global.css:9-17` |
| 字体栈 | Tailwind `font-serif` 以 Noto 优先：Noto → Source Han Serif → Songti SC → serif | `client/tailwind.config.js:16` |
| 其他指标 | Desktop TBT 17ms、CLS 0.048、SI 0.98s；SEO 0.92、A11y 1.00 | `ac16-summary.json` |
| 门禁 | typecheck / 170 测试 / verify 6/6 / build 全部通过 | 2026-11-12 复跑 |

结论：Desktop 只差 1 分；Mobile 已达标。Desktop 的主要拖累是 LCP 审计值，而 LCP 元素是使用 2.7MB Noto 子集字体的引文。

## 3. 方案

### 3.1 引文改用系统宋体栈（最小改动）

- `client/src/styles/global.css`
  - 新增 `.quote-serif`：
    ```css
    .quote-serif {
      font-family: 'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', serif;
    }
    ```
  - 注释说明：仅用于 01 卷 LCP 引文，避免 2.7MB 自托管子集字体进入 LCP；其余标题/诗词仍用 Noto Serif SC。
- `client/src/components/modules/IdentityModule.tsx:80`
  - `className="font-serif ..."` → `className="quote-serif ..."`。
  - 装饰引号 `span`（L76）保留 `font-serif`，不参与 LCP。
- 不改 `tailwind.config.js` 全局 serif 栈，避免全站字形变化；不改 `CityHero`（移动端 LCP 是 hero 的「西安」，且已达标）。

### 3.2 构建与观感回归

- `node node_modules/typescript/bin/tsc -p client/tsconfig.json --noEmit`
- `node node_modules/vite/bin/vite.js build`（cwd = client）
- 用 ego-browser 打开 `http://127.0.0.1:8788/city/CN-610100`：
  - 截图 01 卷引文与 02 卷，确认宋体观感可接受、无溢出、无换行异常
  - 若观感明显劣化，回退 `.quote-serif` 改动

### 3.3 Lighthouse 复跑

- 复用生产服务 `:8788`（当前常驻）与预热 Chrome（chrome-launcher，临时 profile）。
- Desktop 跑 3 轮、Mobile 跑 2 轮，复用 `C:\Users\19949\AppData\Local\Temp\citylens-lh-20261112\run-ac16.mjs` 的方法与节流参数。
- 报告命名：`ac16-desktop-r1~r3-final.json`、`ac16-mobile-r1~r2-final.json`、`ac16-summary-final.json`。
- 判定：
  - Desktop 中位数 ≥0.80 且 Mobile 中位数 ≥0.70 → **AC-16 通过**
  - Desktop 仍 0.79 → 查看新的 LCP 元素；若仍是 Noto 文本，最多再按同一策略改一处；若仍不达标，停止并记录 0.79
  - 不采用 `--throttling-method=devtools` 等改变验收口径的方法

### 3.4 文档回写

- `FEATURES_AND_VERIFICATION.md`
  - AC-16 行：更新为最终 3+2 轮中位数、LCP 元素、字体策略、通过/未通过判定
  - 2.3「Lighthouse 绝对分数」行同步
  - 6.2 性能段落补 `.quote-serif` 策略与最终分数
- `e2e/README.md` 已知限制同步最终数字
- 7.2 人工签字列保持空白，不代签

### 3.5 门禁与交付

- `typecheck`（server + client）
- `node node_modules/vitest/vitest.mjs run`
- `node node_modules/tsx/dist/cli.mjs scripts/verify_presets.ts`
- client build
- `git status --short` 列出改动；**不自动 commit**，待用户确认

## 4. 决策与假设

- 选择系统宋体栈，而不是继续缩小 Noto 子集：改动最小、风险最低，字形与宋体接近；继续子集化会影响诗词/动态文本覆盖。
- 只改 01 卷 LCP 引文，不改全站 serif，不动 hero，避免影响已通过的 Mobile。
- 若字体改动不能把 Desktop 推到 0.80，回退该改动，保留 0.79 并如实记录；不为分数牺牲整体观感。
- Lighthouse 是 CLI 测量，不涉及 ego-browser；页面观感复核使用 ego-browser（用户指定）。
- 当前生产服务仍在 `:8788`，ego-browser 会话保持常驻；若服务掉线，先重新启动再跑。
- 不新增文档文件，只改现有验收文档。

## 5. 验证步骤

1. 引文截图与 02 卷截图正常，无横向滚动/溢出。
2. `.lighthouse/ac16-*-final.json` 与 `ac16-summary-final.json` 存在。
3. Desktop 3 轮中位数与 Mobile 2 轮中位数写入 AC-16；判定与实际报告一致。
4. typecheck 0 错误、170/170 测试、verify 6/6、build 成功。
5. 文档中不出现「人工复核通过」；7.2 签字列为空。
6. 未执行 git commit。

## 6. 风险与回退

| 风险 | 回退 |
|---|---|
| 系统宋体观感明显变差 | 删除 `.quote-serif`，恢复 `font-serif`，保留 0.79 |
| Desktop 仍 0.79 或 LCP 元素转移到 Noto 标题 | 最多再改一处；否则停止并记录，不继续扩大改动 |
| Lighthouse 波动 | 取 3 轮中位数，不只取最好一轮；报告全部保留 |
| 生产服务/Chrome 掉线 | 重启 `:8788` 与 chrome-launcher 预热流程后重跑 |
