# nTools v3 功能迭代报告（交付验收版）

> 日期：2026-11-12 ｜ 目标：Chromium 102 / 麒麟 Linux / 信创 ARM / `file://` / 无构建链
> 对照契约：[dev-contract-v3.md](dev-contract-v3.md) ｜ 前序报告：[v2-implementation-report.md](v2-implementation-report.md)

## 1. 需求完成对照

| 需求 | 完成情况 |
|---|---|
| 把 nChat 原生融入 nTools 作为一个 tab（去掉 iframe） | ✅ `#page-nchat` 原生 DOM，`js/chat-embed.js` 懒加载组合根；`index.html` 变跳转页；全站单入口 |
| 大模型配置作为 nTools 基础配置项，放设置面板，支持多个端点 profile | ✅ 全局设置 Sheet「模型端点」：增删改 / 切换当前 / 测试连接 / 导入导出（默认脱敏） |
| nChat 可单独设置不同的系统提示词 | ✅ 按端点独立 `profile.chatSystemPrompt`；聊天页顶部「系统提示词」快捷编辑，设置面板亦可编辑 |
| Todo 大模型识别：粘贴整篇邮件 → 提取标题/详情/到期/标签 → 自动填充但**不立即创建**，可编辑后手动创建 | ✅ 「AI 识别」弹窗 + mock 全链路验证：填充后 `tasks=0`，编辑后手动创建成功 |
| Todo LLM 系统提示词自动包含当前日期时间 | ✅ 每次调用注入 `{{NOW}}/{{DATE}}/{{WEEKDAY}}/{{TZ}}/{{WORK_END}}`，设置面板实时预览 |
| 设置面板支持 Todo LLM 系统提示词 + temperature + top-p | ✅ 设置 → Todo AI：端点选择、提示词、Temperature、Top P、恢复默认 |
| 创建界面快捷时间：下班前 / 明天前 / 周五前 / 下周前 / 月底前等 | ✅ 6 个 chips（含清除），workEnd 默认 17:30；设置面板可改为任意时间并实时重算 |
| 参考 Apple Design / 前端设计原则优化 UI，兼顾性能 | ✅ 统一设计令牌与材质、克制动效、深/浅/Lite、懒加载聊天、keyed diff、无重滤镜列表；详见 §5 |
| 自动化验收与提交 | ✅ 5 套验收全绿；已提交并推送到 `Myooooo/ntools` |

## 2. 交付内容

### 新增文件

| 文件 | 行数 | 说明 |
|---|---|---|
| `js/llm-store.js` | 459 | 全局端点 / 聊天提示词 / Todo AI 配置 / 下班时间；旧 `nchat-settings` 迁移 |
| `js/ai.js` | 336 | 非流式补全、错误映射、超时/中止、`extractJson`、连接测试 |
| `js/settings-panel.js` | 776 | 右侧 Sheet：模型端点 / Todo AI / 通用 / 数据 / 关于 |
| `js/chat-embed.js` | 334 | 原生聊天组合根（懒加载、端点切换、系统提示词入口、菜单、缺配置引导） |
| `js/todo-ai.js` | 675 | 提示词注入、识别、JSON 归一、AI 弹窗、填充草稿 |
| `js/todo-time.js` | 244 | 快捷时间纯函数（边界处理） |
| `css/settings.css` | 595 | 设置 Sheet 样式与响应式 |
| `tools/e2e-features.js` | — | 53 项新功能 E2E（mock fetch，不联网） |
| `tools/shots-v3.sh` | — | v3 截图脚本 |
| `docs/dev-contract-v3.md` / 本报告 | — | 契约与验收记录 |

### 主要改造

- `ntools.html`：原生聊天 DOM（约 120 行）、设置按钮、新脚本与样式顺序；移除 iframe。
- `js/settings-store.js`：改为 `NC.store.llm` 只读适配层（零持久化双写）。
- `js/settings-view.js`：改为聊天系统提示词 Sheet。
- `js/chat-controller.js`：`openSettings` 注入（无配置引导）。
- `js/message-view.js` / `js/composer.js`：嵌入适配、不留独立页假设。
- `css/chat.css`：新增约 470 行嵌入布局 / 工具栏 / 菜单 / 提示词 Sheet / 响应式。
- `js/todo-view.js`：AI 按钮、快捷 chips、详情/标签字段、草稿提示、submit 支持 notes/tags。
- `js/todo.js`：`fillDraft` 暴露、长文本 AI 提示、`llm:changed` 刷新快捷时间。
- `css/tools.css`：AI 弹窗/快捷 chips/草稿态样式；`.tools-page--nchat` 贴边。
- `js/app.js`：删除（旧独立聊天入口退役）。
- `index.html`：跳转页。
- `tools/verify.js` / `tools/check.sh`：加入原生聊天/设置面板检查与新功能 E2E。
- `README.md` / `docs/architecture.md` / 截图资源：同步 v3。

## 3. 验收证据

### 3.1 一键验收（`bash tools/check.sh`，最近一次）

| 阶段 | 结果 |
|---|---|
| 1/5 语法检查（33 个 JS） | ✅ 全部通过 |
| 2/5 页面级验收（index/ntools/compat-check/tests） | ✅ **26 项 PASS**，0 页面错误、0 失败请求 |
| 3/5 回归 E2E（`tools/e2e.js`） | ✅ **39 项 PASS**（待办交互/Ctrl+Z/聊天流式/停止/安全 XSS/密钥脱敏/500 条性能） |
| 4/5 新功能 E2E（`tools/e2e-features.js`） | ✅ **53 项 PASS**（端点 CRUD/系统提示词/Todo AI/快捷时间/会话隔离/无 console.error） |
| 5/5 纯函数断言（`tests.html` 无头） | ✅ **81 项 PASS**（534ms） |

关键 E2E 断言摘录：

- 设置面板：新增端点 → 保存 → 下拉同步 → 设为当前 → 刷新持久；导出默认无 `apiKey`，显式包含才导出。
- 原生聊天：`#page-nchat` 内 `iframes=0`；mock SSE 流式渲染；payload 含系统提示词且 URL 正确、`stream:true`；停止后输入恢复并保留内容；切端点会话隔离、切回恢复。
- Todo AI：mock 返回 JSON → 表单标题/截止/详情/标签填充 → **任务数仍为 0** → 编辑标题后点击创建 → 任务 1 条且字段正确。
- 快捷时间：6 个 chips；下班前/明天前/周五前/下周前/月底前填充值正确；设置改 18:00 后「下班前」重算正确。
- 安全：聊天 Markdown / Todo 导入 / Markdown 工具 XSS 全部净化（`xss=0`，无 script/img onerror/js 链接）。

### 3.2 性能

| 场景 | 实测 |
|---|---|
| 500 条待办导入 + 渲染 | 29–30ms |
| 500 条搜索 | 4ms |
| 聊天初始化 | 懒加载：首次切到 nChat 才初始化（首屏不下载/不渲染聊天） |
| 动效 | 仅 transform/opacity，120–260ms；Lite/reduced-motion 自动关闭 |

### 3.3 截图（人工视觉验收）

- `/tmp/nc-shots/v3/v3-hero-chat-dark.png`、`v3-hero-chat-light.png`（原生聊天，含流式/思考/统计）
- `/tmp/nc-shots/v3/v3-hero-settings-dark.png`、`v3-hero-settings-todoai-light.png`（设置面板 / Todo AI）
- `/tmp/nc-shots/v3/v3-hero-todo-dark.png`（AI 识别按钮 + 快捷时间 chips）
- `/tmp/nc-shots/v3/v3-ai-dialog-1440-dark.png`、`v3-ai-dialog-390-dark.png`、`v3-draft-filled-1440-dark.png`
- `/tmp/nc-shots/v3-chat-mobile-390.png`、`v3-prompt-sheet-mobile-390.png`
- 仓库 README 截图更新：`img/main.png`（原生聊天）、`img/tools.png`（待办 AI/快捷时间）、`img/settings.png`（设置）

## 4. 数据迁移与兼容

- 首次启动 `llm-store.init()` 读取 `ntools.llm.v1`；不存在则迁移旧 `nchat-settings`：
  - 旧 config id 合法时保留 → 旧 `nchat-conversation.v2` 会话直接延续；
  - 旧 `systemPrompt` → `profile.chatSystemPrompt`；`apiUrl → baseUrl`；`top_p → topP`；
  - 旧键保留可回滚。
- 新增 `ntools.llm.v1` 不改变 Todo / 聊天会话既有键；旧数据零丢失。
- Chromium 102 兼容：无 ES Module / 新 CSS 特性；`file://` 下经典脚本、localStorage、剪贴板可用；通知仍降级为页内提醒。

## 5. 设计说明（Apple Design / Frontend Design 取向）

- **层次与材质**：低饱和中性色 + 单一强调色；设置 Sheet 使用细边框 + 半透明材质；卡片圆角 10–20px；阴影层级只用于浮层。
- **排版**：标题负字距、正文 1.5–1.7 行高；列表行 52–60px；信息密度以“可扫读”为先。
- **留白**：统一 4/8 栅格；设置分区、表单、端点卡片分组清晰；空状态有明确引导与操作。
- **动效**：列表 fade-up、Sheet 滑入、模态缩放淡入、Toast 上滑、按钮按压反馈；统一 120–260ms、`transform/opacity`；Lite 与 reduce-motion 全关。
- **性能取向**：聊天懒加载、列表 keyed diff、ticker 对齐分钟、搜索防抖、避免全屏模糊与大色块动画，照顾 ARM 软渲染。
- **可访问性**：语义按钮/表单 label、aria 状态、Sheet 焦点陷阱 + Esc、焦点环、键盘路径完整。

## 6. 已知限制（不阻塞）

1. AI 识别依赖内网网关放行 `file://` 的 CORS（`Origin: null`）；错误提示已给出排查方向。
2. 模型返回 `dueAllDay=true` 时当前按当天 workEnd 填充（无全天任务概念）。
3. AI 填充的清单仅按名称匹配已有清单，不自动新建清单；标签上限 20。
4. 快捷时间「明天前」按字面明天（不跳过周末）；「下班前」会跳过周末。
5. 详情抽屉内未放快捷时间按钮（创建区已有；可后续补）。
6. `file://` 下关闭页面后无提醒；聊天图片上传流程沿用 v2 行为，未新增自动化用例。
7. 多标签页聊天状态不做实时同步；跨标签待办仍为 revision 冲突提示。

## 7. 后续建议

- 增加“按端点会话列表/多会话管理”（当前每端点单会话）。
- 详情抽屉复用快捷时间；Todo AI 支持多任务一次性提取（当前提取单条）。
- 设置面板增加提示词库/预设；端点支持自定义请求头（部分内网网关需要）。
- 若网关支持，考虑把图片/大附件迁到 IndexedDB（localStorage 配额边界）。
