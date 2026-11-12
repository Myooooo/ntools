# v4 设计方向与 UI 审计（标准模式 / Light 性能模式）

> 依据技能：`frontend-design`、`apple-design`、`emil-design-eng`、`animate`、`choreograph`、`animation-performance`、`mobile-native`、`break-ui`。
> 目标：把「标准模式」重做成更克制、更有辨识度的内部工作台；「Light（Lite）模式」= 标准模式去掉高级动效与页面特效后的性能版本。
> 环境：Chromium 102 / 麒麟 ARM / 内网 `file://`；无外网字体/图片。

## 1. 设计简报（来自 frontend-design 的 process）

- **对象**：国企内网知识工作者的日常「工作台」——待办、AI 对话、二维码/Markdown/图片转换。
- **主要任务**：每天重复多次的快速录入、扫读、切换；长时间停留；键盘与鼠标为主，移动端为辅。
- **环境约束**：荧光灯办公光环境、125% 缩放、锁定版 Chromium、低配 ARM；无品牌自由（不能引外网素材）。
- **情绪目标**：平静、可信、专注、有一点精密仪器的秩序感；不是消费级 SaaS 的“卡片 + 渐变”感。

## 2. 设计方向：Precision Workbench（精密工作台）

**一句话**：像一台校准过的办公仪器——石墨/纸感底色、发丝分隔、单一仪器蓝强调、铜色只用于时间与提醒；信息靠对齐与字号建立层级，不靠卡片堆叠。

### 2.1 色彩（4–6 个核心值）

| 角色 | 深色（默认） | 浅色 |
| --- | --- | --- |
| 墨底 | `#0B0E13` | `#F4F5F7` |
| 纸面 / 面板 | `#131820` / `#182029` | `#FFFFFF` / `#FAFBFC` |
| 发丝线 | `rgba(255,255,255,.075)` | `rgba(20,24,32,.09)` |
| 主文字 | `#EDF1F6` | `#15181D` |
| 仪器蓝（唯一强调） | `#6EA8FE` | `#2F6FDB` |
| 铜色（时间/提醒，仅语义） | `#D8B06A` | `#9A6B1F` |
| 危险/成功 | `#FF7A72` / `#45D6A0` | `#D94848` / `#0F8A5F` |

规则：
- 渐变只保留在品牌标记与主 CTA（且标准模式有、Lite 无）；正文/大面不用渐变。
- 铜色**只**用于时间、截止、逾期、提醒；不做装饰。
- 不用纯黑；深色保持石墨蓝底，浅色保持冷纸白。

### 2.2 字体与字阶

- 系统 CJK 栈（`--nc-font-sans`），代码/数字用 mono。
- 字阶：`28/600` 页面标题（tracking -0.02em）、`20/600` 二级、`15/600` 段落标题、`13.5/400` 正文、`12` 元信息、`11` 微标签。
- 行高：标题 1.2；正文 1.55；密集列表 1.35。
- 数字一律 `font-variant-numeric: tabular-nums`；时间列用铜色/等宽数字。
- 禁止：全大写标签、无意义的 eyebrow 小标题、中点串（`A · B · C`）作为元信息。

### 2.3 布局概念（ASCII）

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ 工作台    │  待办事项               6 项待办    今天 22:41     [新建] │  ← 页面头条：标题 + 关键数字，无 eyebrow
│ 导航      ├──────────────┬───────────────────────────────────────────┤
│          │ 视图/清单     │  记录式任务列表（发丝分隔，无逐条卡片）      │
│ 待办 ●   │ 全部   6      │  今天 │ 提交季度报告             高 │
│ 二维码    │ 今天   3      │  18:00│ 安全巡检整改             中 │
│ MD       │ 逾期   1      │ ────── 分组标题 ────────────────────────── │
│ 图片      │ 已完成 2      │  ...                                       │
│ nChat    │              │  [ 快速录入 ………………………………………  ]        │
│          │              ├───────────────────────────────────────────┤
│          │              │ 检查器（选中任务）/ 空态                     │
└──────────┴──────────────┴───────────────────────────────────────────┘
```

- 导航保留文字（非技术用户需要可读性），但更窄（196px）并强化当前工具的“仪器刻度”指示。
- 任务列表是**记录（ledger）**：左时间槽 + 发丝分隔 + 选中行浅浅的铜色/蓝色底；不再每行一张圆角卡。
- 聊天改为**访谈记录**：左侧角色刻度，助手内容全宽，用户消息右侧轻量蓝底；不使用大渐变气泡。
- 设置保持右侧 Sheet，但内容区做成“检查器”：段标题 + 发丝行 + 表格化端点列表。

### 2.4 动效原则（标准模式）

| 场景 | 处理 | 依据 |
| --- | --- | --- |
| 标签切换 | 内容 opacity + 6px 上移，160ms，`--nc-ease-out`；导航指示即时跟随 | 用户动作反馈，不做全屏乱飞 |
| 首次进入 | 仅一次工作台 reveal（opacity 220ms），不做每段 fade-up | frontend-design / choreograph |
| 列表新增/删除 | opacity + 6px，160ms；删除先 120ms 淡出再收合 | 状态可读、无高频位移动画 |
| 按钮按压 | scale(0.97)，120ms ease-out；hover 仅背景/描边 | animate / mobile-native |
| 弹层/Sheet | opacity + scale(0.985)/translate 8px，200–220ms；关闭 160ms | 材质化、非弹跳 |
| 菜单 | scale(0.97)+opacity，140ms，transform-origin 跟随触发按钮 | emil-design-eng |
| Toast | translateY(8px)+opacity，180ms；退出同时长 | 状态提示 |
| 聊天消息 | opacity 140ms；流式光标呼吸 1s | 高频内容不炫技 |
| Hover | 全部包在 `@media (hover:hover) and (pointer:fine)` | mobile-native |
| Lite / reduced-motion | 去位移/缩放/ambient/glass，保留 opacity 与颜色即时反馈 | apple-design / animate |

### 2.5 标准模式的高级效果（Lite 全部移除）

- 工作台环境光：极淡的顶部冷光 + 右下铜色反光（`--nc-ambient`，固定背景，不随滚动）。
- 材质：导航栏、页面头条、Sheet、输入 dock 使用半透明玻璃（`backdrop-filter`，仅小面积，Lite 关）。
- 悬浮层：菜单/Toast/Modal 有柔和阴影 + 1px 高光边；列表容器**不用阴影**。
- 微交互：按钮 hover 轻微提亮、卡片 hover 1px 上浮（仅少数“可点卡片”）、导航 active 刻度、聊天统计浮层、快捷时间 chip active。
- 页面背景：一层极细的 32px 网格 + 冷光/铜色环境光（低透明度；Lite 关）。

### 2.6 Light / Lite（性能模式）定义

> 用户口径：Light 模式建立在标准模式基础上，去掉高级动效和页面效果，提升性能。

实现为 `html[data-lite="true"]` 的**减法覆盖**：
- 移除：ambient 背景、网格纹理、玻璃/模糊、渐变（改为纯色强调）、阴影（仅保留 1px 发丝线）、hover 位移/上浮、scale/translate 进入动画、所有非必要 transition（时长 0）。
- 保留：布局、字阶、颜色语义、即时 hover 背景变化、`:active` 颜色/按压（无缩放）、焦点环、可读性对比。
- 所有页面/组件从同一 token 派生，不维护第二套 UI。

## 3. UI 审计（emil-design-eng 要求的 Before/After 格式）

| Before | After | Why |
| --- | --- | --- |
| 每个区块都是同一种圆角卡片 + 同样的浅阴影 | 记录式列表：只浮层有阴影；列表/面板用 1px 发丝分隔 | 通用 SaaS 卡片套件，层级靠阴影而非结构 |
| 主按钮/Logo 使用渐变，多处渐变点缀 | 仪器蓝单色 CTA；铜色仅用于时间语义；渐变只留品牌标记 | 减少“AI 生成感”的渐变语法 |
| 元信息串 `gpt-4o · api.xxx`、`今日完成 0 · 本周完成 2` | 拆为列/标签；日期、数字独立对齐 | frontend-design 明确指出的模板化 tell |
| 58 处 `:hover` 未做能力判断 | 统一包 `@media (hover:hover) and (pointer:fine)` | 触屏 sticky hover |
| app shell `height:100vh` | `100vh` fallback + `100dvh`（102 自动忽略后者）+ safe-area | mobile-native / iOS 地址栏 |
| 输入 13.5px，移动端聚焦可能缩放 | `(pointer: coarse)` 下输入 16px | mobile-native |
| 无 `theme-color` / `tap-highlight` / `touch-action` | 补齐交替色 theme-color、透明 tap highlight、manipulation | 原生感 |
| 所有页面进入都用同一种 fade-up | 仅一次工作台 reveal；页面切换只做内容淡入 + 6px | AI 式 scattered motion |
| 待办行 hover `translateX(2px)` | 高频列表只用背景/描边变化，不位移 | 高频表面少动效 |
| 菜单从中心缩放 | `transform-origin` 跟随触发按钮 | Popover 空间来源 |
| 深色为纯黑 + 蓝，浅色为冷灰白，缺乏身份 | 石墨蓝底 / 冷纸白，发丝线 + 铜色时间语义 | 从“工作台”题材来的识别度 |
| 聊天大渐变气泡 + 每消息动画 | 角色刻度 + 轻量用户块；消息 opacity 120–140ms | 长文本可读性与克制 |
| Lite 只是把动画时长设 0 | Lite 由标准减法派生：去 ambient/glass/shadow/lift/scale；保留即时反馈 | 用户要求的 Light 性能模式 |
| 标题/正文只有一个宽松字阶，无光学字距 | 标题负字距、正文 0、数字 tabular、正文行宽 <80ch | Typography craft |
| 空状态统一居中图标+标题+双按钮 | 按页面语义给空状态（待办给录入/示例，聊天给建议，设置给引导） | 避免模板化 empty state |

## 4. 待验证/可能破坏点（break-ui 清单）

- 长任务标题 / 超长备注 / 无空格 URL / 多标签（20 个）/ 长清单名：是否截断、换行、撑破行高。
- 端点名称与 Base URL 极长：设置面板行是否会推走操作按钮。
- 聊天长代码块、无空格长串、emoji、满宽中文：是否横向溢出。
- 320px 宽、200% 缩放、125%/150% 显示缩放下的布局；移动端键盘弹起时输入区是否可用。
- Lite 下所有高级效果是否真的移除、性能是否提升（减少 blur/shadow/animation）。


---

## 8. 实施状态（v4 已落地）

- 公共层：`tokens.css`（Palette/Type/Motion/Effect + Light 减法）、`base.css`（移动端原生基线/排版/关键帧）、`components.css` v4 层（工具按钮、输入、菜单/Toast/Modal、空状态）。
- 页面层：`tools.css` 整文件重写（工作台外壳、记录式待办、QR/MD/图片工作台、AI 弹窗/快捷 chips）、`chat.css` 整文件重写（访谈记录、工具栏、输入 dock、欢迎态）、`settings.css` v4 层（检查器化设置 Sheet）。
- 交互层：菜单 `transform-origin` 跟随触发按钮；`theme-color` 随主题；mobile-native 基线（viewport-fit / tap-highlight / overscroll / touch-action / 粗指针 16px / safe-area / hover 门控）。
- 验收：`bash tools/check.sh` 5/5 全绿（118 PASS + tests 81/81）；`tools/break-ui.js` 32/32 组合 0 问题，移动端原生 12/12 PASS。
- 审计结果与修复轨迹：见 [design-break-audit.md](design-break-audit.md)；视觉对比截图：`/tmp/nc-shots/v4/design/`。
