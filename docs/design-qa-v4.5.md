# nTools v4.5 设计复检 QA 报告

> 日期：2026-11-13 ｜ 范围：全站 5 个 tab（待办 / nChat / 二维码 / Markdown / 图片）× 深/浅 × 标准/Lite × 1440/1024/390，以及 todo 详情、回收站、热区、侧栏收起、chat welcome/端点/legacy 等状态。
> 性质：只读设计 QA（未改业务 CSS/JS）；验收口径：可读、可对齐、可操作、Lite 真减法、移动端不溢出。
> 关联：聊天域深度复检见 [design-review-v4.5.md](design-review-v4.5.md)；设计方向见 [design-direction-v4.md](design-direction-v4.md)。

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| 截图归档 | **80 张**全页面/状态截图 → `/tmp/nc-shots/v45/qa/`（`manifest.txt`） |
| 自动化设计自检 | **63 项全部通过（0 失败）**；17 条观察项见 §4（均为打磨建议，**阻塞问题 0**） |
| Break UI（最坏数据） | **0 问题**（32 组合矩阵全 0）；25 张截图；移动端检查 13/14 通过（唯一失败：2 条 `:hover` 未能力门控，见 §4-O2） |
| 回归验收 | `verify.js` 全 PASS、`e2e-v41.js` 全 PASS、`e2e-timeline.js` 58/58、`check.sh` **7/7** 全绿 |

**设计 QA 通过**：对齐/对比度/Lite 减法/粘性 footer/移动端溢出/侧栏收起/回收站/热区均符合预期；剩余 8 条为跨页基线与细节打磨建议。

## 2. 方法与复跑

- 截图与自检统一由 **`tools/design-shots.sh`（新增 `NC_SHOT_MODE=qa` 模式）** 驱动 CDP 无头 Chrome 完成：
  - 统一注入 demo 数据（标签/置顶/循环/逾期/热区四档/回收站/长标题、两条模型端点、4 条聊天消息）；
  - 每次截图前清理 demo 数据产生的 toast（保留 1 张 `chat-toast-overlap` 作为证据图）；
  - 计算样式自检：元素 rect 中线、WCAG 对比度（`getComputedStyle` 取样）、Lite 与标准模式的 `backdrop-filter/box-shadow/animations` 差异、键盘 Tab 焦点、hover 前后状态、滚动后的 sticky footer、各 tab/宽度 `scrollWidth-clientWidth`、viewport/theme-color/触控目标。
- 复跑命令：
  ```bash
  NC_SHOT_MODE=qa bash tools/design-shots.sh /tmp/nc-shots/v45/qa
  # 报告：/tmp/nc-shots/v45/qa/qa-report.json（checks/issues/observations/extras）
  ```

## 3. 截图清单（80 张）

**矩阵（60 张）**：`<tab>-<dark|light>-<std|lite>-<1440|1024|390>.png`
- tab：`todo` / `chat` / `qr` / `md` / `image`
- 主题：dark / light；模式：std（标准）/ lite（Lite）；宽度：1440 / 1024 / 390

**状态补充（20 张）**：
`todo-heat-{dark,light}-std-1440`、`todo-detail-open-{dark,light}-std-1440`、`todo-detail-closed-dark-std-1440`、`todo-trash-{dark,light}-std-1440`、`todo-trash-dark-std-390`、`todo-rail-collapsed-dark-std-1440`、`todo-rail-hover-dark-std-1440`、`chat-welcome-{dark,light}-std-1440`、`chat-welcome-lite-1440`、`chat-messages-dark-std-1440`、`chat-toast-overlap-dark-std-1440`（证据图）、`chat-endpoint-focus-dark-std-1440`、`chat-endpoint-390`、`chat-legacy-endpoints-{dark,light}-std-1440`、`settings-models-legacy-dark-std-1440`。

**Break UI**：`/tmp/nc-shots/v45/break/`（25 张，32 组合矩阵）。

## 4. 问题表（阻塞 0；观察/建议 8 条）

> 严重度：P1 阻塞 / P2 应修 / P3 打磨。本轮**未发现 P1**；以下均为 P2/P3 观察项，未改代码。

| # | 严重度 | 位置 | 现象 / Before | 建议 After | 证据/定位 |
|---|---|---|---|---|---|
| O1 | P2（体验） | `css/components.css:690-701`（`.nc-toasts` fixed bottom 24、宽 480）、`:716`（toast `pointer-events:auto`）；触发 `js/todo.js:278` | 逾期提醒 toast 停留 5.2s，覆盖 chat 输入 dock（输入区 y=851-885 与 toast 区域重叠）、图片页底部按钮、详情 footer；toast 期间点击被拦截 | toast 底部偏移抬到 composer 之上，或在 chat 页抑制逾期提醒；也可缩短停留/仅保留“查看”入口 | `chat-toast-overlap-dark-std-1440.png`、`chat-legacy-endpoints-*.png` |
| O2 | P3（移动端） | `css/tools.css:3709-3717` | 回收站「恢复 / 彻底删除」两条 `:hover` 未包 `@media (hover:hover) and (pointer:fine)`，触屏易出现粘滞 hover | 两条 hover 规则整体放入能力查询 media（与其余 30 条一致） | `break-ui` 移动端检查失败项：`tools.css:2 条` |
| O3 | P3（一致性） | `css/tools.css:262-270`（`.tools-head align-items:flex-end`）；todo 页有局部覆盖 | 页面头条操作区底对齐：MD 页头操作区中线比标题低 **23.8px**（贴合副标题行），todo 页则贴合标题行；跨页基线不一致 | 统一策略：actions 与标题首行基线对齐（或整块垂直居中）；各页共用一条规则 | `md-dark-std-1440.png`、`qa-report.json` observations |
| O4 | P3（间距） | `css/settings.css:856-873`（actions `opacity:0` 仍占位，`padding:0 12px 12px`）、`:292-297`；`js/settings-panel.js:207-225` | 端点列表每行始终渲染 actions 区：非当前行按钮透明但占 41px，行高 110px，视觉上是两行内容 + 一条空白带；当前行才显示按钮 | actions 改 absolute overlay（不占行高），或仅 hover/selected 时展开并保持行高紧凑；同步设计复检 §4 建议 | `settings-models-legacy-dark-std-1440.png` |
| O5 | P3（观察） | `css/tools.css:1493-1503`（tags）、`:1647-1663`（actions `top:50%` 居中）、`:1461-1475`（标题在首行） | 行右列（标签/按钮）按行垂直居中，标题在首行 → **中线差 8.8px**；tag 与按钮彼此中线一致（0px），属两行布局的自然结果 | 若要求右列与标题同基线：`align-self:flex-start` + 与首行 line-height 对齐；否则维持现状即可 | 6 行 × 深/浅均测得 8.8px（observations） |
| O6 | P3（移动端） | `css/tools.css:1493-1503 / 1647-1683`、响应式段 `:3425-3450` | 390 下行尾 tags 与行操作同时常显：长标题可用宽度被压到 **148px**（折 2 行，行高 74px），视觉偏挤 | 移动端将行操作收进详情（或滑动操作），tags 允许换到第二行；保证标题 ≥60% 行宽 | `todo-dark-std-390.png`、`:390` 测量 |
| O7 | P3（排版） | `js/markdown.js:141`；设置端点 meta 同问题见 `docs/design-review-v4.5.md §4` | Markdown 页头元信息使用中点串「109 字符 · 7 行」；与设计方向 §2.3「去中点串、用列/发丝线表达」不一致 | 拆分为两列/两个数字块（`109 字符`｜`7 行`），或仅保留其一 | `md-dark-std-1440.png` |
| O8 | P3（构图） | `css/tools.css:418-490`（`.qr-stage-card` / `.qr-stage` / `.qr-form`） | 1440 下 QR 卡与表单列间距约 220px、页面下方大片空白，内容未随视口收敛，显得松散 | 两列 grid 居中并加 `max-width`（如 960-1040px），或把 QR/表单收进同一工作台面板 | `qr-dark-std-1440.png` |

> 说明：O5 是观察项（tag/按钮中线本身 0px 通过）；O1/O2 成本低，建议收尾时处理。O3/O4 涉及 Lead 域（tools/settings 公共页头与设置列表），O6–O8 为移动端/排版/构图打磨。

## 5. What held up（通过项摘要）

| 维度 | 实测结果 |
|---|---|
| 垂直对齐 | 6 行 todo 的 **tag ↔ 行操作按钮中线 0px**（深/浅各 6 行）；页头标题 ↔ 模式切换 0px；chat 发送按钮 ↔ 输入区 1px；chat 端点 ↔ 元信息 0px |
| 对比度（深） | todo 标题 17.05:1、到期 9.52:1、标签 5.64:1、视图计数 5.64:1、侧栏导航 17.05:1（均 ≥4.5） |
| 对比度（浅） | todo 标题 16.31:1、到期 5.32:1、标签 4.91:1、视图计数 4.91:1；chat 输入提示 15.57/17.79:1（≥3） |
| Lite 减法 | 玻璃 `saturate(1.4) blur(14px)` → `none`；`document.getAnimations()` 2 → 0；阴影只剩 1px 发丝 inset；截图无 ambient/玻璃差异 |
| hover / focus | 非激活导航项 hover 背景 `rgba(0,0,0,0)` → `rgb(24,33,44)`；行操作 `opacity 0→1`；Tab 焦点落在 `.tools-rail__toggle`，`outline 2px solid` 可见 |
| 粘性 footer | 详情 `.detail-foot` `position:sticky`，滚动前后 bottom 均 804，滚动后仍完整可见（viewport 900） |
| 移动端 | 5 tab × 1440/1024/390 + 回收站 390 **横向溢出全部 0px**；viewport-fit=cover、theme-color `#0b0e13 ⇄ #f4f5f7`、触控目标无 <28px |
| 回收站 | 3 行：仅恢复/彻底删除可见（edit/pin 可见数 0）；「清空回收站」按钮可见且危险样式 |
| 侧栏收起 | 收起宽度 **68px**；hover 展开按钮 opacity 0→1；logo/悬浮两态截图正常 |
| 热区四档 | 逾期深红 / 今天红 / 明天橙 / 后天黄，完成与 ≥4 天不染色；深/浅主题各自可读（截图对照） |
| chat legacy | 合并后 2 个端点（`内网 GPT-4o`、`旧 nChat 配置`），当前 = legacy-1，toolbar meta 显示模型+主机；合并 toast 仅首次 |
| 端点下拉 | 原生 `<select>` 无法在无头截图捕获展开浮层（已知限制）；用聚焦态 + legacy 值 + 设置列表三张图替代验证 |

## 6. 验证结果（本轮实际执行）

| 命令 | 结果 |
|---|---|
| `node tools/break-ui.js`（`BREAK_OUT=/tmp/nc-shots/v45/break`） | **0 问题**：32 组合（4 场景 × 4 宽 × 2 缩放）docOverflow/裁切/文本/行高/布局全 0；500 行中位高 59px；25 张截图 |
| break-ui 移动端检查 | 13/14 PASS；唯一失败 = O2（2 条 hover 未门控） |
| `node tools/verify.js` | 3 页全部 PASS（24 项检查，0 error） |
| `node tools/e2e-v41.js` | 全部 PASS（30 项断言，0 失败） |
| `node tools/e2e-timeline.js` | **58/58 PASS**，console.error 0 |
| `bash tools/check.sh` | **✅ 7/7 全部验收通过**（check 退出码 0；在收到“停止长循环”前已完成，不再复跑） |
| console/资源 | QA 全部页面 console.error = 0、资源加载 0 error |

## 7. 已知限制

- 无头 Chrome 不能截图原生 `<select>` 展开浮层；端点下拉以“聚焦态 + 当前值 + 设置列表”三图验证，真机可再点开确认。
- 深/浅主题下的 `hover` 由 CDP 鼠标模拟；触屏真机（奇安信/麒麟 ARM）的粘滞 hover、软键盘遮挡、safe-area 实机观感仍需现场复核（v4 报告已列）。
- 截图使用 demo 数据（非最坏数据）；最坏数据由 break-ui 覆盖。
- 本 QA 模式为只读，不修改业务代码；`tools/design-shots.sh` 新增 QA 分支供复跑，原设计截图用法（默认 mode）保持不变。

## 8. 建议收尾顺序

1. O1 toasts 遮挡 composer/底部按钮（P2，1 处 CSS + 1 处触发时机）。
2. O2 两条 hover 门控（P3，2 行 CSS）。
3. O3/O4 页头操作区基线、设置端点行空白带（Lead 域，可随下一轮统一）。
4. O5–O8 为打磨项，可按截图逐条取舍。

## 9. Lead 收口（v4.5 已修，2026-11-13）

| # | 处理 | 位置 |
|---|---|---|
| O1 | Toast 底部从 20px 抬到 `calc(88px + safe-area)`，浮于 chat 输入 dock/详情 footer 之上（实测 toast bottom 812 vs dock top 835，gap 23px） | `css/components.css` `.nc-toasts` |
| O2 | 回收站恢复/彻底删除两条 hover 包 `@media (hover:hover) and (pointer:fine)`；break-ui 复跑 **86/86** 门控、移动端 14/14 | `css/tools.css` |
| O3 | `.tools-head` 统一 `align-items:center`；MD 页操作区/标题中线差 **23.8px → 0** | `css/interaction.css` |
| O4 | 桌面设置端点操作改为 absolute overlay；行高 **110px → 70px**，消除空白带；移动端保持常显布局 | `css/interaction.css` |
| O7 | Markdown 统计改为「109 字符　7 行」（无中点） | `js/markdown.js` |
| O8 | QR 工作台 max-width 920 / gap 28，1440 构图收拢 | `css/interaction.css` |
| O5/O6 | 保留现状：右列按行中线是设计取舍（tag↔按钮 0px 已通过）；390 长标题压缩作为已知限制记录在 v4.5 报告 | — |

> 设计复检结论：所有 P1/P2 已修复；O5/O6 为明确取舍，其余 P3 已收口。新增 `docs/v45-release-report.md` 汇总交付。
