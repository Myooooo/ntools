# v4.1 全站动效审计与聊天域补齐

> 对象：`ntools.html` 工作台（入口/侧栏/tab/待办/聊天/设置/工具叶）、共享 `NC.ui` 弹层、`index.html` 跳转页。
> 依据：`animate`（频率门槛 / ease-out / 退出更快 / 只动 transform·opacity）、`choreograph`（一个容器一次入场 / 高频不 stagger / Lead→Support 关系）、`emil-design-eng`（禁用 `transition: all`、`scale(0)`、`ease-in`）、`animation-performance`（合成层优先、避免 width/height/box-shadow 动画、backdrop blur 成本）。
> 环境：Chromium 102 / 麒麟 ARM / `file://`；标准模式 vs Light(Lite)；所有值来自 `css/tokens.css`。
> 本文件只做审计与聊天域改动记录；标 **Lead** / **A** 的条目不在本审计员写域，未改动。

## 1. 全局动效 token 与门槛

| token | 值 | 用途 |
| --- | --- | --- |
| `--nc-dur-press` | 120ms | 按压反馈 |
| `--nc-dur-fast` | 140ms | hover / 小弹层 / 图标切换 |
| `--nc-dur` | 180ms | 常规过渡 / Toast / 消息 |
| `--nc-dur-slow` | 260ms | 壳层首次揭示 / 内容块 |
| `--nc-dur-page` | 180ms | 页面/分区切换 |
| `--nc-dur-panel` | 220ms | Modal / Sheet / 抽屉 |
| `--nc-ease-out` | `cubic-bezier(.23,1,.32,1)` | 入场 |
| `--nc-ease-in-out` | `cubic-bezier(.77,0,.175,1)` | 屏内位移 |
| `--nc-ease-drawer` | `cubic-bezier(.32,.72,0,1)` | 抽屉 / Sheet |

Lite / `prefers-reduced-motion: reduce` 由 `tokens.css` 把全部 dur 置 0、移除 ambient/glass/shadow/enter 位移；各文件再补结构性关闭。审计结论：**token 体系完整，问题集中在“退出被裁切 / 双入场 / 高频位移 / 无退出动画”四类**。

## 2. 全站现状总览

| 区域 | 当前动效 | 驱动 | 频率 | 必要性 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 入口跳转页 | 无 | — | 每次访问 | 无 | OK（静态页，不引入动效） |
| 应用壳首次揭示 | `nc-shell-in` 260ms（opacity+4px） | `css/base.css:379-383` | 每会话 1 次 | 弱 | OK（一次性，Lite/reduced 关闭） |
| Tab 切换 | 整页 `nc-rise-in` 180ms（opacity+6px） | `css/tools.css:209-212` | 每天数十次 | 中 | **P2**：高频面整页位移；建议 140ms + 4px 或仅 opacity |
| 侧栏展开/收起 | 宽度 220ms drawer + 标签 140/180ms + 图标旋转 220ms | `css/rail.css:9-14,61-68,74-96` | 偶尔 | 中 | OK（Lite/reduced 即时）；宽度动画会layout，属可接受成本 |
| 侧栏 nav active | 背景/文字 140ms；刻度线瞬切 | `css/tools.css:89-100` | 高频 | 中 | OK（高频只变色，刻度即时） |
| 设置 Sheet | 居中窗 220ms opacity+scale/8px | `css/settings.css:1097-1135` | 偶尔 | 中 | 入场 OK；**P1 退出被裁切**（JS 180ms 后 hidden，见 §4.3） |
| 设置内分区切换 | `nc-anim-in` 260ms rise | `js/settings-panel.js:644` + `css/base.css:333-335` | 每次切换 | 中 | **P1 双入场**：Sheet 滑入 + 分区再 rise，违反 one-entrance |
| 待办新行 | `nc-rise-in` 180ms；JS `is-new` 320ms 后移除 | `css/tools.css:1423-1425`、`js/todo-view.js:843-845` | 每次新增 | 中 | OK；建议 160ms 内 |
| 待办删除 | 无退出（`.is-leaving` 规则存在但无 JS 使用） | `css/tools.css:1427-1430`（死规则） | 每次删除 | 中 | **A**：行瞬间消失、后续行跳动；要么接受即时，要么 120ms 淡出 + popLayout |
| 待办分组折叠 | 仅 chevron 旋转 140ms；行整块瞬变 | `css/tools.css:1718-1724`、`js/todo-view.js:1426` | 偶尔 | 低 | 可接受；若要过渡建议整组 120ms opacity |
| 待办采集器展开 | `nc-rise-in` 180ms | `css/tools.css:3416-3418` | 每次录入 | 弱 | 仅淡入、无高度过渡（高度跳变）；可接受 |
| 待办详情（桌面） | 无（选中即渲染） | `js/todo-view.js` | 频繁 | 中 | OK（检查器内容不位移） |
| 待办详情抽屉（≤1100） | 面板 translateX 220ms drawer；遮罩 180ms | `css/tools.css:2540-2544,2012-2026` | 偶尔 | 中 | **A**：关闭时遮罩 class 移除后立即 hidden，面板还在滑出 → 闪烁 |
| 待办拖拽 | 仅 opacity/box-shadow 状态，无位移动画 | `css/tools.css` | 高频 | — | OK（拖拽 1:1 由 JS 驱动） |
| 待办置顶/时间线 | 本轮代码未实现（grep 无 pin/timeline） | — | — | — | N/A；未来实现时用 FLIP/即时 |
| 菜单 `NC.ui.openMenu` | 进入 `nc-pop-in` 180ms；关闭立即移除 | `css/components.css:787-797`、`js/ui.js:445-455` | 高频 | 中 | **Lead P1**：无退出、keyframes 不可中断；建议 140ms transition + 退出 120ms hidden 延迟（origin 已有） |
| Toast | 进入/退出各 180ms（transform+opacity） | `css/components.css:1292-1305`、`js/ui.js:311-320,347` | 高频 | 中 | OK；建议退出 140ms（比进入快） |
| Modal | 进入 220ms opacity+scale/8px；关闭 180ms 后移除 | `css/components.css:1260-1279`、`js/ui.js:107-112,165` | 偶尔 | 中 | **Lead P1**：180 < 220，退出被裁切 40ms |
| 聊天域 | 见 §5（本次补齐） | `css/chat.css` 等 | — | — | 已补齐 10 项，见下 |
| 工具叶（QR/MD/图片） | 仅 hover/颜色；Lite 即时 | `css/tools.css` | 中 | 弱 | OK |

## 3. 问题清单（Before / After）

| Before | After | Why |
| --- | --- | --- |
| 设置 Sheet 关闭：`classList.remove('is-open')` 后 180ms 直接 `hidden`（`settings-panel.js:727-731`），而面板过渡 220ms（`settings.css:1111-1125`） | 关闭延迟 ≥ `--nc-dur-panel`（220ms）或过渡降到 180ms，两者对齐 | 退出被裁切，最后一帧“跳没” |
| Modal 同样 180ms 移除 vs 220ms 过渡（`ui.js:107-112` / `components.css:1267-1277`） | 统一 220ms 或 180ms | 同上 |
| `NC.ui.openMenu` 只有进入动画，`close()` 立即 `removeChild`（`ui.js:445-455`） | 进入 140ms transition；退出 120ms opacity/scale 后移除；`transform-origin` 已跟随触发按钮（`ui.js:495`） | 高频菜单退出突兀，且 keyframes 不可被打断 |
| Tab 每次切换整页 `nc-rise-in` 180ms（`tools.css:209-212`） | `opacity` 140ms + 4px，或高频场景只做 opacity | 高频面整体位移会削弱“仪器感”，且每帧 rise 无信息量 |
| 设置分区内容再播 `nc-anim-in` 260ms（`settings-panel.js:644`） | 分区只做 120ms opacity，或去掉（Sheet 已负责入场） | 一个容器一次入场 |
| 待办删除无过渡；`.is-leaving` 是死 CSS（`tools.css:1427-1430`） | 立即移除（更符合 ledger）或 120ms 淡出 + `position:absolute` 释放布局 | 行消失时后续行跳动 |
| 待办抽屉遮罩先消失、面板后滑出（`todo-view.js:2101-2111`） | 遮罩延迟到面板过渡结束再 hidden（≥220ms） | 空间路径一致 |
| 聊天自定义菜单无退出、快速点击可能卡在 hidden 前（v4 前） | `openMenu/closeMenu` 增加 160ms hidden 延迟 + 重入守卫（`js/chat-embed.js:275-319`） | 可中断、不叠层 |
| 聊天图片预览添加/删除瞬间重排（v4 前） | 添加 140ms scale/opacity；删除 130ms 淡出后再移除（`composer.js`） | 小面状态变化需要可读 |
| 聊天思考过程原生 `<details>` 瞬开瞬合 | 接管 click，max-height 180ms + opacity/transform 140ms 双向（`message-view.js:216-280`） | 长文本展开需要连续感 |
| 聊天回底按钮 `hidden` 瞬切 | `opacity/translate/visibility` 140ms，hidden 时仍 `display:inline-flex` 但不可见/不可点（`chat.css:1750-1770`） | 出现/消失不闪 |
| 聊天发送↔停止图标硬切换 | 两个图标绝对定位交叉 140ms（`chat.css:1694-1727`） | 状态指示 |
| 聊天提示词 sheet 220ms 过渡 vs 180ms hidden | CSS 过渡对齐 180ms（`chat.css:1772-1786`） | 退出不被裁切 |
| 聊天灯箱关闭立即 hidden | 180ms fade 后 hidden；关闭中 `pointer-events:none`（`message-view.js:412-456`） | 退出对称 |
| 聊天 `scroll-behavior: smooth` + 流式 `scrollTop` 自动跟随 | 改为 `auto`（`chat.css:1625-1628`）；回底按钮即时定位 | 流式高频写入下 smooth 会追帧/抖动 |

## 4. 逐区明细

### 4.1 入口 / 应用壳
- `index.html` 跳转页：无动画，符合“入口只做一次、不要表演”。
- `base.css:379-383`：`.tools-app` 一次性 `nc-shell-in` 260ms（opacity+4px），且仅在 `prefers-reduced-motion: no-preference` 且非 Lite 时生效 → 合理。
- 主题切换：token 直接切换，无颜色过渡（`base.css` 无 `transition` on theme vars）→ 即时、无闪，符合 ARM 性能；不作为缺口。

### 4.2 Tab / 侧栏
- Tab：`tools.css:209-212` 每次 `.tools-page.is-active` 播 180ms rise；导航刻度 `::before` 即时、背景色 140ms（`tools.css:89-100`）。结论：可用，但高频面建议降为 140ms / 4px 或只 opacity（Lead）。
- 侧栏：`rail.css:9-14` 宽度 220ms drawer、`61-68` 标签 opacity/translate、`74-96` 收起布局、`109-127` Lite/reduced 即时。宽度动画属 layout 属性，桌面偶发可接受；若后续 ARM 反馈掉帧，可改为固定宽度 + 内容 `transform`。

### 4.3 设置
- Sheet 入场：`settings-panel.js:714-716` hidden→rAF is-open，`settings.css:1097-1135` 220ms opacity + scale(0.985)/8px → 符合“材质化、非弹跳”。
- 退出：`settings-panel.js:727-731` 180ms 后 hidden，早于 220ms → **P1 裁切**。
- 分区：`settings-panel.js:644` 每次重建 `sp-content nc-anim-in`（`base.css:333-335` 260ms rise）→ 与 Sheet 入场叠加，违反 choreograph「一个容器一次入场」。
- 端点编辑：`settings.css:889-891` `sp-profile-editor` rise 180ms（每次切换编辑对象）→ 建议仅 opacity 120ms。

### 4.4 待办
- 新增行：`todo-view.js:843-845` 初次渲染后 `is-new`（`tools.css:1423-1425`），320ms 后移除类；`nc-rise-in` 使用 `--nc-enter-y`，Lite/reduced 关闭（`tools.css:3212-3234`）→ OK。
- 删除：`tools.css:1427-1430` 的 `.is-leaving` 无 JS 引用；行直接从 DOM 移除 → 建议二选一（即时 or 120ms 淡出 + popLayout），A 决策。
- 分组：`todo-view.js:1426` 只切 class，图标旋转 140ms；分组行整块瞬变 → 可接受（密集 ledger 不鼓励位移动画）。
- 采集器：`todo-composer__extra` rise 180ms（`tools.css:3416-3418`）；展开/收起无高度过渡（height 不能 transform 等价）→ 可接受，不做 height 动画（performance 原则）。
- 抽屉：`tools.css:2540-2544` 面板 translateX 220ms drawer；`todo-view.js:2101-2111` 关闭时 scrim 立即 hidden → **A P1** 遮罩先消失。
- 拖拽/选中/hover：仅 opacity、背景色、inset box-shadow（静态）；无每帧位移动画 → 符合高频面克制。
- 置顶/时间线：当前代码未实现（grep 无相关逻辑），无动效可审；未来如需排序动画建议 FLIP 120–180ms，且仅拖动结束播放。

### 4.5 菜单 / Toast / Modal（Lead 公共层）
- 菜单：`components.css:787-797` 进入 `nc-pop-in var(--nc-dur)`；`ui.js:445-455` 关闭立即 removeChild；`ui.js:495` 已设置 `--nc-menu-origin`。问题：无退出、keyframes 重启（高频菜单快速开合会闪）。建议改为 `is-open` class + transition，关闭 120ms 后移除。
- Toast：`components.css:1292-1305` + `ui.js:311-320,347` 进入/退出 180ms 对称；建议退出 140ms（退出应比进入快）。
- Modal：`components.css:1260-1279` 220ms；`ui.js:107-112` 180ms 后移除 → 裁切；`ui.js:165` rAF show 正确；模态居中 origin 正确（不跟随触发）。
- 公共层 `nc-progress__bar` 用 width 过渡（`components.css:889`），若用于进度条可接受（真实进度需要 layout），否则建议 scaleX。

### 4.6 自定义弹层（`NC.ui.openMenu` 之外）
| 弹层 | 位置 | 动效现状 | 结论 |
| --- | --- | --- | --- |
| 聊天菜单 `#chat-menu` | `js/chat-embed.js` | 本审计已补：进入 140ms、退出 160ms hidden 延迟、重入守卫 | OK |
| 聊天系统提示词 `#chat-system-prompt-sheet` | `js/settings-view.js` 控制 hidden/class | 入场 rAF is-open；退出 180ms 后 hidden；本审计将 CSS 过渡对齐 180ms | OK |
| 图片灯箱 `#image-lightbox` | `js/message-view.js` | 本审计已补退出 180ms | OK |
| 全局设置 `#settings-sheet` | Lead `settings-panel.js` | 见 4.3 | Lead P1 |
| 待办详情抽屉/遮罩 | A `todo-view.js` | 见 4.4 | A P1 |
| `NC.ui` Modal/Toast/Menu | Lead `ui.js` | 见 4.5 | Lead P1/P2 |

重复叠放检查：`#chat-menu` / `#chat-prompt-sheet?` / `#image-lightbox` 均为静态单节点（QA 断言 count=1）；连续 5 次点击菜单按钮后仍只有 1 个 `#chat-menu` 且 `aria-expanded` 与可见态一致；`hidden` 延迟期间再次打开会取消定时器 → 无叠层。菜单之外的自定义弹层均单实例（设置 Sheet / 待办抽屉由各自 JS 单例管理）。

## 5. 聊天域本次补齐（choreograph 记录）

### 5.1 时间线（标准模式）

| 元素 | 角色 | 开始 | 时长 | 动作 | 关系 |
| --- | --- | --- | --- | --- | --- |
| 欢迎标题行 `.chat-welcome__head` | Lead | 0ms | 180ms | opacity + 4px | — |
| 欢迎说明+建议+快捷键 `.chat-welcome__body` | Support | 60ms | 180ms | opacity + 6px | Overlap（同组一起） |
| 新消息 `.chat-msg.is-entering` | Lead | 0ms | 140ms | opacity + 4px | 仅新消息；历史渲染不播 |
| 思考摘要展开/收起 | Support | 0ms | 180ms 高度 + 140ms opacity | max-height / opacity / -2px | 与 summary chevron 同步 |
| 统计浮层 | Support | 0ms | 140ms | opacity + 4px，origin bottom-left | 点击即开 |
| 聊天菜单 | Lead | 0ms | 140ms 入 / 160ms 后 hidden | scale(0.97)+opacity，origin top-right | 源按钮方向 |
| 提示词 Sheet | Lead | 0ms | 180ms | opacity + 8px/scale(0.985) | 居中模态 |
| 图片预览（添加） | Support | 0ms | 140ms | scale(0.96)+opacity | — |
| 图片预览（删除） | Support | 0ms | 130ms 后移除 | opacity+scale | 先视觉退出再释放 |
| 回底按钮 | Support | 0ms | 140ms | opacity + 4px + visibility | 高频状态，不位移大 |
| 发送↔停止 | Support | 0ms | 140ms | 图标 opacity+scale 交叉 | 同容器 |

### 5.2 不动的部分与理由
- 消息操作按钮：hover/focus 只做 opacity（140ms），不做位移；触屏常显。
- 流式正文：逐 token 直接更新，不做逐字动画；光标 1s 呼吸（已有）。
- 聊天滚动：`scroll-behavior:auto`，流式自动跟随不做 smooth（性能与正确性）。
- 打字指示器：出现即显示，不加入场（高频，且流式首 token 很快替换）。
- 历史消息渲染：`renderAll` 不播入场；只有 `add()` 新消息带 `is-entering`。

### 5.3 需要真机/录制确认的感受点
- 欢迎 Lead+Support 两拍是否读成“一个工作台出现”，而不是队列（需要录屏慢放看 60ms 重叠）。
- 思考过程 max-height 过渡与正文可滚动区在长文本（>240px）时的手感。
- 聊天菜单快速连点（关闭中再开）是否完全无闪；已在 QA 断言状态一致，但帧级连续性需真机。

## 6. Lite / reduced-motion 矩阵（聊天）

| 能力 | 标准 | Lite | reduced-motion |
| --- | --- | --- | --- |
| 欢迎 Lead/Support 入场 | 180ms + 60ms 错峰 | 无动画 | 无动画 |
| 新消息入场 | 140ms + 4px | 无动画 | 无动画 |
| 思考展开/收起 | 高度/透明度过渡 | 即时 | 即时 |
| 统计浮层 | 140ms | 1ms 级（token 0） | 1ms 级 |
| 菜单 | 140ms 入 / 160ms 退出 | 即时 hidden | 即时 hidden |
| 图片预览/回底/发送停止 | 140ms | 即时 | 即时 |
| 工具栏/输入 dock 玻璃 | blur+saturate | 无 blur、实色 | token 关 |

## 7. 剩余清单（不在本审计员写域）

**Lead（公共层）**
- P1 `js/ui.js:107-112` + `css/components.css:1260-1279`：Modal 关闭 180ms vs 220ms 过渡 → 统一 220ms（或过渡 180ms）。
- P1 `js/settings-panel.js:727-731` + `css/settings.css:1111-1125`：设置 Sheet 同一问题。
- P1 `js/ui.js:445-455` + `css/components.css:787-797`：`NC.ui.openMenu` 增加退出（120ms transition + hidden 延迟），把 keyframes 改为 class transition（可中断）。
- P2 `js/settings-panel.js:644`：设置分区去掉 `nc-anim-in` 或降为 120ms opacity，避免 Sheet+内容双入场。
- P2 `css/tools.css:209-212`：Tab 切换 180ms 整页 rise → 140ms / 4px 或只 opacity。
- P2 `js/ui.js:311-320`：Toast 退出 140ms（比进入快）。
- P2 `css/components.css:889`：进度条 width 过渡确认只用于真实进度，否则 scaleX。

**A（Todo）**
- P1 `js/todo-view.js:2101-2111`：抽屉关闭时 scrim 延迟 220ms 再 hidden，与面板滑出同路径。
- P2 `css/tools.css:1427-1430`：`.todo-item.is-leaving` 无 JS 使用（死规则）；删除要么即时（现在），要么补 120ms 淡出 + popLayout，二选一并删死 CSS。
- P2 `css/tools.css:3416-3418`：采集器展开仅 fade，高度跳变；如要过渡，建议 `grid-template-rows` 不可用（102），保持现状即可。
- 备注：置顶/时间线本轮未实现，无动效可审。

## 8. 验证

- `node --check js/*.js`：全部通过。
- `node tools/verify.js ntools.html` / `index.html`：全 PASS。
- `node tools/e2e-features.js`：53/53 PASS，0 console.error。
- 自建 v4.1 动效 QA（CDP，`/tmp/app-auditor-v41-qa.js`）：19/19 PASS —— 欢迎两拍、新消息 140ms、思考展开/收起过渡、统计 origin/时长、菜单连点不叠放+退出延迟、提示词 sheet 进出、图片预览进出、回底显隐、发送↔停止交叉、Lite/reduced 关位移、自定义弹层单实例、无 console.error。
- 截图（`/tmp/nc-shots/v4/`）：`v41-app-welcome-dark-1440.png`、`v41-app-chat-dark-1440.png`、`v41-app-reasoning-open-dark-1440.png`、`v41-app-stats-dark-1440.png`、`v41-app-menu-dark-1440.png`、`v41-app-prompt-sheet-dark-1440.png`、`v41-app-preview-dark-1440.png`、`v41-app-jump-dark-1440.png`、`v41-app-welcome-lite-dark-1440.png`、`v41-app-welcome-light-1440.png`、`v41-app-chat-light-1440.png`、`v41-app-chat-dark-390.png`。

## 9. 未验证 / 需现场确认

- 麒麟 ARM + 软件渲染下，设置面板/Modal 的 `backdrop-filter`（静态，不参与动画）与聊天小面积玻璃的实际帧率；Lite 是兜底。
- 触屏真机上菜单退出延迟与虚拟键盘（`interactive-widget=resizes-content`）叠加时的输入 dock 位置。
- 滚动长会话时消息入场动画与 `scrollTop` 自动跟随的帧级配合（headless 只能断言状态，无法判断手感）。


## 10. Lead 收口记录（本审计之后已修复）

| 审计项 | 处理 |
|---|---|
| Modal 关闭 180ms vs 220ms 过渡 | `NC.ui` 移除延迟改为 240ms（大于 CSS 220ms），退出不再裁切 |
| 设置 Sheet 关闭时序 | 隐藏延迟 240ms；居中弹窗入场 `scale(0.985)+8px`，首次打开不再叠加分区 `nc-anim-in` |
| `NC.ui.openMenu` 无退出/叠放 | 重写为全局单例：同触发按钮开关切换、打开新菜单先关旧、`is-closing` 140ms 退出、滚动/resize 关闭、120ms 过渡 CSS |
| 设置分区双入场 | `renderSection(id,{silent})`：首次打开不播内容入场，分区切换才播 |
| Tab 整页 rise | `interaction.css`：140ms / 4px（标准模式）；Lite/reduced 即时 |
| Toast 退出 | `is-leaving` 过渡 140ms，快于进入 180ms |
| 设置窗口居中 | 右侧滑出改为居中 980×760 弹窗（v4.1 用户反馈），保留焦点陷阱/Esc |
| rail hover 门控 | `rail.css` 的 `.tools-rail__toggle:hover` 包 capabilities 查询；break-ui 复跑 **84/84** 全门控 |
| A：抽屉/删除死规则 | A 已改为移动端底部抽屉；列表增删/完成/置顶/折叠动效补齐（详见 task-14） |
