# v4 设计 / 最坏数据 / 移动端原生 审计报告

> 执行：platform-compat（task-13）· 只读审计，不改业务 CSS/JS。
> 依据：`docs/design-direction-v4.md` §4 待验证清单；技能口径 `break-ui`（最坏但可信数据 + 宽度/200% 缩放）、`mobile-native`（平台层原生感检查）。
> 复跑：`node tools/break-ui.js`（输出 `/tmp/nc-shots/v4/break/`）、`tools/design-shots.sh`（输出 `/tmp/nc-shots/v4/design/`）、`bash tools/check.sh`。

---

## 1. 范围与方法

| 项 | 内容 |
|---|---|
| 页面 | `ntools.html`（v4 UI：todo / chat / settings / Todo AI 弹窗） |
| 数据注入 | 通过 localStorage 在数据边界注入（`ntools.todo.v2` / `ntools.llm.v1` / `nchat-conversation.v2`），不改 DOM/CSS |
| 宽度 | 1440 / 1024 / 768 / 320（窄屏含移动 emulation + 触摸） |
| 缩放 | 100% 与 **根字号 200%**（模拟放大/大字号，字体变大而盒子不变） |
| 检测项 | `document.scrollWidth > clientWidth`、区块越出视口、操作按钮被裁切/推走、文本 nowrap 溢出或被裁切、列表行高撑破、标签 chips 撑高、布局容器被撑破 |
| 截图 | `/tmp/nc-shots/v4/break/*.png`（场景-宽度-z缩放），另 `report.json` / `report.md` / `dataset.json` |

## 2. 注入的"最坏但可信"数据

| 字段 | 值 | 依据/上限 |
|---|---|---|
| 任务标题 | 59 字中文（"与华东区域三家供应商确认第四季度交付排期，并同步采购、法务、财务三个部门的审批节点与应急预案…"） | `schema-todo` title 上限 500；真实会议排期长度 |
| 备注 | 含 150+ 字符无空格 URL、120 字符无空格工单号 | notes 上限 20000；真实链接/工单 |
| 标签 | 20 个（采购/法务/财务/交付/…/华东） | LIMITS.tags = 20 |
| 清单名 | `华东区生产环境与灾备切换演练（2026 年第四季度）专项清单`（28 字） | LIMITS name 无显式上限；真实项目名 |
| 列表规模 | **500 条任务**（含 1 字标题 `Jo`、emoji/越南语/泰语混排、已完成/逾期、长标签组） | 目标 500 条流畅；LIMITS.tasks = 5000 |
| 端点名 | `华东区生产环境 · OpenAI 兼容网关（备用线路 / 灾备）`（28 字） | profiles ≤ 30 |
| Base URL | `https://llm-gateway.prod.northwind-industries-holdings.example.com/openai-compatible/v1`（94 字符无空格） | api url 上限 500 |
| 聊天内容 | 14 行长代码块、无空格长 token、满宽中文 3 段重复、emoji | 真实代码/粘贴内容 |

> 说明：所有值均为"真实用户可能产生 / 模型/接口可能返回"的取值范围，不使用 `aaaa…` 随机串。

## 3. 结果矩阵（覆盖率）

**结论：32/32 组合（4 场景 × 4 宽度 × 2 缩放）全部 0 问题** —— 无页面横向溢出、无被裁切/推走的操作按钮、无撑破行高。

| 场景 | 检查范围 | 1440 | 1024 | 768 | 320 | 200% 根字号 |
|---|---|---|---|---|---|---|
| todo（500 条 + 最坏单行） | docOverflow / 越界 / 裁切 / 文本 / 行高 / 标签 / 布局 | 0 | 0 | 0 | 0 | 0 |
| chat（长代码块/长 token/满宽中文） | 同上（scope=#page-nchat） | 0 | 0 | 0 | 0 | 0 |
| settings（长端点名 + 94 字符 URL） | 同上（scope=#settings-sheet） | 0 | 0 | 0 | 0 | 0 |
| Todo AI 弹窗（长 URL/长 token 文本） | 同上（scope=.nc-modal） | 0 | 0 | 0 | 0 | 0 |

**500 条列表行高实测**：1440/1024 中位数 59px、最大 59px；768 中位数 57px、最大 74px；320 中位数 57px、最大 75px（两行长标题）。符合 ledger 行高 52–60px 目标，长标题只影响该行且未撑破分组。

> 判定口径：`document.scrollWidth>clientWidth`、元素越出视口、操作按钮被祖先裁切/越界、nowrap 文本溢出、行高 > max(88, 2.2×中位数)、标签容器 >30px、布局容器 scrollWidth>clientWidth。横向可滚动容器（pre/横向 chips）属预期交互，不误报；离屏抽屉/浮动控件按"可访问性"单独判定。

## 4. 问题表（Severity / 现象 / 建议）

**未发现破坏性问题（0 条）。** 最坏数据下 UI 保持可读、操作可达、无横向溢出。

### What held up（已验证的稳健点）

- **500 条任务 × 4 宽度 × 200% 缩放**：无横向溢出；行高稳定（中位 57–59px、最大 75px），滚动容器正常。
- **59 字中文标题**：320 宽下 2 行后省略，行高不撑破；整行 `button.todo-item__body` 带 `aria-label="查看任务：<全量标题>"`，操作按钮常驻未被裁切。
- **20 个标签 / 长清单名（28 字）**：标签行内折叠不撑行高；清单名 ellipsis，左栏不产生横向滚动。
- **长端点名（28 字）+ 94 字符无空格 Base URL**：设置面板行高稳定，"编辑/删除/导出"等操作按钮未被推走；编辑态 input 正常内部滚动。
- **164 字符无空格 URL / 120 字符 token**：聊天正文自动换行（`overflow-wrap`），页面无横向滚动；长代码块只在 `pre` 内部横向滚动（预期）。
- **1 字标题 `Jo` / emoji + 越南语/泰语混排 / 已完成·逾期状态**：无错位、无裁切。

### Decisions for you（需产品/设计定夺）

1. **长任务标题是否鼠标可见全量**：视觉 2 行截断 + `aria-label` 已可访问；如追求鼠标悬停可见，建议给标题 span 补 `title` 属性（纯增强，1 行改动）。
2. **长清单名/端点名截断策略**：当前末尾省略号；若同类项尾部差异重要（如不同区域后缀），建议中段截断。
3. **标签 20 个的展示**：当前仅显示少量 + 溢出隐藏；建议明确 `+N` 计数，避免"信息消失感"。
4. **聊天代码块**：保留块内横向滚动（代码可读性优先），不建议全局换行。

## 5. 移动端原生检查（代码 + 计算样式）

| # | 检查项 | 结果 | 说明 / 修复建议 |
|---|---|---|---|
| M1 | `viewport-fit=cover` + 不禁止缩放 | ✅ | `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content` |
| M2 | `theme-color` 随主题切换 | ✅ | 单一 meta 由 `theme-boot.js`/`theme.js` 更新（#0b0e13 ⇄ #f4f5f7） |
| M3 | 亮/暗 `color-scheme` 声明 | ✅ | `dark light` |
| M4 | `-webkit-tap-highlight-color` | ✅ | `transparent`（base.css），实测计算值 `rgba(0,0,0,0)` |
| M5 | `overscroll-behavior` | ✅ | html/body `none`；内部滚动容器 `contain` |
| M6 | `touch-action: manipulation` | ✅ | 按钮/`[role=button]`/chip 等已覆盖（base.css） |
| M7 | 粗指针输入字号 ≥16px（防 iOS 聚焦缩放） | ✅ | 实测 todo/chat/md 输入在 `(pointer:coarse)` 下均为 **16px**（此前被类选择器覆盖，已由 A/B 修复）；`#chat-profile-select` 亦为 16px |
| M8 | hover 全部包 `@media (hover:hover) and (pointer:fine)` | ✅ | 静态扫描最终 CSS：**77/77 条 `:hover` 均已门控**（base/components/tools/chat/settings 全过）；v2 审计点名的 58 处已收口 |
| M9 | safe-area 使用 | ✅ | `env(safe-area-inset-*)` 共 14 处（base/components/chat/tools/settings） |
| M10 | 应用壳 100vh→100dvh 回退 | ✅ | `height:100vh; height:100dvh`；Chromium 102 忽略后者、更高内核生效 |
| M11 | hover/pointer 能力查询生效 | ✅ | 移动 emulation 下 `(pointer:coarse)`/`(hover:none)` 均命中 |
| M12 | 触控目标 ≥32px（样本） | ✅ | 采样 `#send-btn`、`#todo-new-submit`、`.tools-nav__item`、`#settings-btn`、行内操作按钮均 ≥32px；极小图标按钮仅存在于桌面密集区且已有扩大热区 |
| M13 | 移动端无 console.error | ✅ | 390 宽移动视口巡检无报错 |

> 说明：headless emulation 不能替代真机；触觉/键盘/安全区实际观感需在麒麟 ARM 或手机实机复核（见 `docs/compatibility.md` §8）。

## 6. v4 设计改动 Before / After 核对

| Before（v3） | After（v4 目标） | 审计观察 |
|---|---|---|
| 卡片列表 + 阴影 | 记录式 ledger：发丝分隔 + 左侧时间槽 | ✅ 已在 `todo-*-1440` 截图体现；行高与 500 条密度正常（见 §3/§4） |
| 导航 196px、文字型 | 更窄、当前工具"仪器刻度"指示 | ✅ 截图可见；320 宽切换为顶部图标栏 |
| 渐变 CTA / 多渐变点缀 | 仪器蓝单色 CTA，渐变只留品牌标记 | ✅ 截图核对（Lite 下同样去渐变） |
| 元信息中点串 | 拆列/标签 + tabular 数字 | ✅ 时间列/计数为等宽数字；长清单名 ellipsis（§4 记录为可接受） |
| 聊天大渐变气泡 | 访谈记录：角色刻度 + 全宽助手 + 轻量用户蓝块 | ✅ `chat-*` 截图；长代码块横向滚动在 `pre` 内（预期，不撑破页面） |
| 每页 fade-up | 一次工作台 reveal + 页面切换淡入 | 代码层 `nc-shell-in`/`nc-anim-in` 存在；Lite 关闭 |
| Lite = 动画 0 | Lite = 标准减去 ambient/glass/shadow/lift/scale | ✅ 14 处 `data-lite` 覆盖 + tokens 级去效果；截图对比待人工验收 |
| 58 处未门控 hover | 全部能力查询 | ✅ 77/77 条 `:hover` 已包 `@media (hover:hover) and (pointer:fine)`（M8） |
| 13.5px 输入移动端缩放 | coarse 下 16px | ✅ coarse 下 todo/chat/md 输入实测 16px（M7） |

## 7. 截图与产物

| 产物 | 路径 |
|---|---|
| break-ui 截图（4 宽 × 2 缩放 × 4 场景 + 移动） | `/tmp/nc-shots/v4/break/`（**25 张**，清单见 `report.json`/`report.md`；注：200% 仅归档 1440/320 两档，矩阵仍覆盖全部） |
| v4 设计验收截图（标准/浅色/Lite × 1440/390 × todo/chat/settings×2/AI 弹窗） | `/tmp/nc-shots/v4/design/`（**30 张**；命令面板当前版本未提供，SKIP 记录在 manifest） |
| 最坏数据样本 | `/tmp/nc-shots/v4/break/dataset.json` |

## 8. 复跑与已知限制

```bash
node tools/break-ui.js                 # 最坏数据 + 移动端检查
tools/design-shots.sh                  # 设计截图归档
bash tools/check.sh                    # verify / e2e / e2e-features / tests 回归
```

- 本报告基于最终 CSS 复跑（tools/base/components 落盘 23:30、chat 23:23；break-ui 23:36、design-shots 23:38、check.sh 23:41）；如后续 CSS 再变，重跑 `node tools/break-ui.js` 即可（32 组矩阵全自动）。
- headless 截图不能验证 hover sticky、真机键盘遮挡、安全区实机观感，需真机复核。
- 命令面板（⌘K）当前版本未提供，`design-shots.sh` 自动 SKIP 并记录；若后续新增，脚本无需改动（自动探测）。
- UI 版本号仍为 **v3.0.0**（`NC.version` / 侧栏"关于"），v4 发布前建议 Lead 统一 bump 到 `4.0.0`（`js/core.js` + README）。
