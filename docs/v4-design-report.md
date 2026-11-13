# v4 前端设计报告（标准模式 / Light 性能模式）

> 日期：2026-11-12 ｜ 目标：Chromium 102 / 麒麟 ARM / `file://` / 无构建链
> 依据技能：`frontend-design`、`apple-design`、`emil-design-eng`、`animate`、`choreograph`、`animation-performance`、`mobile-native`、`break-ui`
> 设计方向：[design-direction-v4.md](design-direction-v4.md) ｜ 破坏性审计：[design-break-audit.md](design-break-audit.md)

## 1. 设计方向：Precision Workbench（精密工作台）

- **对象**：国企内网知识工作者的日常桌面——待办、AI 对话、二维码/Markdown/图片工具；长时间停留、重复操作、键盘鼠标为主。
- **情绪**：平静、可信、专注，有一点校准过的仪器感；不是消费级 SaaS 的「圆角卡片 + 渐变」。
- **色彩**：石墨蓝黑 / 冷纸白；仪器蓝唯一强调；**铜色只用于时间/提醒语义**；发丝线代替卡片阴影。
- **字体**：系统 CJK 栈；28px/600 页面标题（负字距）、20px 二级、13.5px 正文、12px 元信息；数字 `tabular-nums`。
- **布局**：196px 工具导轨 + 工作台页头 + 记录式内容；待办为「索引 / ledger 记录 / 检查器」三栏；聊天为「角色刻度 + 全宽助手 + 右侧用户块」的访谈记录。
- **动效**：只做有目的的过渡（tab 内容 160–180ms、列表增删、弹层 200–220ms、按钮按压 120ms）；一次工作台 reveal，不做逐段 fade-up；全部 transform/opacity。

## 2. 审计摘要（Before / After）

| Before（v3） | After（v4） | 依据 |
|---|---|---|
| 每个区块同款圆角卡片 + 阴影，泛 SaaS 套件感 | 发丝线 + 记录式 ledger；仅浮层有阴影；半径分层 6/10/16/20 | frontend-design |
| 渐变 CTA/Logo 与多处渐变点缀 | 仪器蓝单色 CTA；铜色时间语义；渐变只留品牌标记 | frontend-design / apple-design |
| 元信息中点串（`A · B · C`） | 拆列/标签/发丝分隔，时间与计数等宽数字 | frontend-design |
| 58 处 hover 未做能力判断 | **77/77 全部** `@media (hover:hover) and (pointer:fine)` | mobile-native |
| 移动壳 `100vh`、输入 13.5px、无 tap-highlight/theme-color | `100vh`→`100dvh` 兜底、粗指针 16px、tap-highlight 透明、theme-color 双主题、safe-area、overscroll | mobile-native |
| 高频列表 hover 位移、每消息 fade-up、所有页面同一种 fadeIn | 高频表面只改背景；消息只新消息 opacity+4px；一次 shell reveal | emil-design-eng / animate / choreograph |
| 菜单从中心缩放 | `transform-origin` 跟随触发按钮 | emil-design-eng |
| Lite 只是把动画时长设 0 | **Light 模式 = 标准模式的减法**：去 ambient/网格/玻璃/阴影/渐变/位移/缩放/非必要动效；保留布局、字阶、颜色语义与即时反馈 | 用户口径 + animate / apple-design |
| 空状态统一居中图标+标题+双按钮 | 按语义定制（待办录入/示例、聊天建议、设置引导），左对齐/工作台式 | frontend-design |
| 深色纯黑+亮蓝、浅色冷灰 | 石墨蓝 + 冷纸白 + 铜色时间语义，形成识别度 | frontend-design |

## 3. 交付文件

| 文件 | 内容 |
|---|---|
| `css/tokens.css` | v4 令牌：石墨/纸面、仪器蓝/铜色、强缓动曲线、动效时长、`--nc-ambient`/`--nc-glass-*`/`--nc-brand-*`、Light 减法覆盖、reduced-motion |
| `css/base.css` | 排版/焦点/滚动条 + 移动端原生基线（tap-highlight、overscroll、touch-action、粗指针 16px、safe-area、100dvh 兜底）、一次性 shell reveal、关键帧 |
| `css/components.css` | v4 公共组件层：工具按钮、输入、select 箭头修复、模态/Toast/菜单材质与 origin、空状态、列表动画；图标按钮 padding 修复 |
| `css/tools.css` | 整文件重写：工作台外壳、记录式待办、采集条/快捷时间、AI 弹窗、QR/MD/图片工作台、响应式 1100/900/768/560、底部渐隐 |
| `css/chat.css` | 整文件重写：访谈记录、工具栏、输入 dock、欢迎态、思考/统计检查器、Lite 减法、移动端 |
| `css/settings.css` | v4 检查器式设置 Sheet：ledger 端点行、发丝分隔、来源明确的过渡、移动端 |
| `js/ui.js` | 菜单 `transform-origin` 跟随触发按钮 |
| `js/theme-boot.js` / `theme.js` | `theme-color` 随深/浅主题同步 |
| `ntools.html` | viewport-fit=cover、theme-color meta、版本 v4.0 |
| `js/message-view.js` / `chat-embed.js` / `composer.js` | 角色刻度轻量 DOM、元信息拆列、触屏输入提示（B） |
| `js/todo-view.js` | 时间槽 bucket+clock、完成/取消中性语义、去中点串（A） |
| `docs/design-direction-v4.md`、`docs/design-break-audit.md` | 方向规格、审计与修复轨迹 |
| `tools/break-ui.js`、`tools/design-shots.sh` | 最坏数据审计、30 张设计截图归档 |

## 4. 标准模式与 Light（Lite）模式

| 维度 | 标准模式 | Light（性能）模式 |
|---|---|---|
| 背景 | ambient 冷光/铜色反光 + 极淡层次 | `--nc-ambient: none` 纯色 |
| 材质 | 小面积玻璃（导轨/工具栏/Sheet/输入 dock） | 实色 `--nc-glass-bg: var(--nc-surface)`、无 blur |
| 阴影 | 浮层 shadow-2/3 | 全部 none，仅发丝线 |
| 渐变 | 品牌标记/主 CTA | `--nc-brand-bg: var(--nc-accent)` 纯色 |
| 动效 | tab 淡入+6px、列表增删、弹层 200ms、按压 120ms、消息 140ms | 时长 0、无位移/缩放/滚动动画 |
| Hover | 背景/描边/少量 1px 上浮（仅 hover 设备） | 仅即时背景/颜色变化 |
| 布局/字阶/颜色语义 | 保留 | **完全保留**（同一套 token 派生） |

实现方式：`html[data-lite="true"]` 只覆盖 effect/motion token + 结构性兜底；不维护第二套样式。

## 5. 验收证据

### 5.1 自动化

| 命令 | 结果 |
|---|---|
| `bash tools/check.sh` | ✅ 5/5 全绿：语法 / verify 4 页 / e2e / e2e-features 53/53 / tests 81/81（118 PASS，0 FAIL） |
| `node tools/break-ui.js` | ✅ 32/32 组合 0 问题；500 行列表行高中位 57–59px；长标题/URL/标签/端点名全部 hold |
| 移动端原生检查 | ✅ 12/12：viewport-fit、theme-color、tap-highlight、overscroll、touch-action、16px 输入、77/77 hover 门控、safe-area、100dvh、触控目标、console 0 |
| `tools/design-shots.sh` | ✅ 30 张：标准/浅色/Lite × 1440/390 × todo/chat/settings/AI 弹窗 |
| `node tools/break-ui.js`（截图） | 25 张于 `/tmp/nc-shots/v4/break/` |

### 5.2 视觉验收（人工截图）

- 标准/深色：`/tmp/nc-shots/v4/design/todo-standard-1440.png`、`chat-standard-1440.png`、`settings-models-standard-1440.png`、`ai-dialog-standard-1440.png`
- 浅色：`*-light-1440.png`；Lite：`*-lite-1440.png`；移动 390：`*-390.png`
- 历史对比：v3 截图与 v4 截图可在 `/tmp/nc-shots/` 与 `/tmp/nc-shots/v4/` 对照。

## 6. 已知限制与建议

- **真机复核**：headless 无法验证 sticky hover、软键盘遮挡、safe-area 实机观感、125%/150% 缩放字体；建议在麒麟 ARM/奇安信实机跑 `checks/compat-check.html` 与手工清单。
- **极端数据决策**（审计建议，未强制改）：长标题可加 title 悬浮、长清单/端点名可中段截断、20 标签可加 `+N`；当前用 `aria-label` 保证可访问。
- **动效验收**：建议在实机录屏并用 DevTools Animations 慢放，确认 tab 淡入/列表增删/弹层的手感；Lite 下应无任何位移动画。
- 聊天长代码块保持 `pre` 内横向滚动，不全局换行（决定与安全渲染一致）。
