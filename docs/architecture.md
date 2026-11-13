# nTools v4.1 架构说明

> 运行形态：纯静态、`file://` 双击可用、无构建链、无后端；经典 `<script>` + IIFE 命名空间（`window.NC`）。
> 目标内核：奇安信可信浏览器 Chromium 102 / 麒麟 Linux ARM。
> 入口：`ntools.html`（主应用，含原生 nChat）；`index.html` 仅做旧书签跳转。
> 设计层：Precision Workbench；标准模式完整效果，Light（Lite）为同 token 的性能减法（见 docs/design-direction-v4.md）。

## 1. 分层

```
┌────────────────────────────────────────────────────────────────────┐
│ 入口页：ntools.html（主应用） / compat-check.html / tests.html       │
│          index.html（→ ntools.html#nchat 跳转）                     │
└───────────────┬────────────────────────────────────────────────────┘
                │ 组合根：ntools-app.js + chat-embed.js（只装配，不写业务）
                ▼
┌────────────────────────── 视图层 ──────────────────────────────┐
│ todo-view / message-view / composer / settings-view(聊天提示词)  │
│ settings-panel（全局设置 Sheet）                                  │
│ 只读状态快照、只写 DOM、事件委托、调用 store/service              │
└───────────────┬────────────────────────────────────────────────┘
                │ NC.events（单向数据流）
┌───────────────▼──────────────┐   ┌─────────────────────────────┐
│ 状态层                       │   │ 服务层                       │
│ llm-store（端点/AI 偏好）     │   │ ai（一次性补全 + JSON 提取）  │
│ settings-store（llm 适配层）  │   │ sse（流式解析状态机）         │
│ conversation-store（按端点）  │   │ api（URL/payload/超时/错误）  │
│ todo-store（撤销栈/迁移）     │   │ reminder（页内提醒 ticker）   │
└───────────────┬──────────────┘   └─────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────────┐
│ 基础设施：core（命名空间/事件/DOM/日期） storage（安全存储/配额） │
│           schema-chat / schema-todo（校验与迁移，纯函数）         │
│           compat（能力检测） icons / ui（模态/Toast/菜单）        │
│           theme-boot（首屏防闪烁） / theme（主题 & Lite）          │
└────────────────────────────────────────────────────────────────┘
```

硬规则：store 不碰 DOM；view 不碰存储/网络；service 不碰 DOM；外部数据先经 schema 归一；用户数据只用 `textContent` / `NC.util.e()`；Markdown 必须 DOMPurify。

## 2. 模块与加载顺序（`ntools.html`）

| 顺序 | 文件 | 职责 |
|---|---|---|
| 1 | `css/tokens.css` → `base.css` → `components.css` → `tools.css` → `chat.css` → `settings.css` → `rail.css` → `timeline.css` → `interaction.css` | 设计令牌 / 基础 / 公共组件 / 页面样式 / 侧栏 / 时间线 / 交互收口 |
| 2 | `js/theme-boot.js`（阻塞） | 首屏设置 `data-theme`/`data-lite`，防 FOUC |
| 3 | `polyfills.js` → `marked` → `purify` → `qrcode` | 兼容垫片 + 本地 vendor |
| 4 | `core.js` → `compat.js` → `icons.js` → `storage.js` → `ui.js` → `theme.js` | 基础设施 |
| 5 | `schema-chat.js` → `llm-store.js` → `ai.js` → `settings-panel.js` | 端点/AI/设置 |
| 6 | `sse.js` → `api.js` → `conversation-store.js` → `settings-store.js` → `message-view.js` → `composer.js` → `settings-view.js` → `chat-controller.js` → `chat-embed.js` | 原生聊天 |
| 7 | `schema-todo.js` → `todo-store.js` → `todo-view.js` → `todo-time.js` → `todo-ai.js` → `todo-timeline.js` → `todo.js` | 待办、Todo AI 与全景时间线 |
| 8 | `qr.js` → `markdown.js` → `image.js` | 工具叶子模块 |
| 9 | `ntools-app.js` | 主组合根，最后加载 |

`index.html` 不加载任何业务脚本，仅 `location.replace('ntools.html#nchat')` 并提供手动链接。

## 3. 存储键

| 键 | 内容 | 备注 |
|---|---|---|
| `ntools.llm.v1` | `{version,profiles[],currentProfileId,todoAi,workEndTime,updatedAt}` | 端点、聊天提示词、Todo AI 配置、下班时间 |
| `nchat-conversation.v2` | `{version:2,sessions:{[profileId]:{messages,updatedAt}}}` | 按端点隔离；旧数组自动迁移 |
| `ntools.todo.v2` | Todo 单文档（`schemaVersion:2`） | 迁移/导入/回收站/quarantine |
| `ntools.todo.v1_backup` / `ntools.todo.v2_backup` | 迁移前 / 最近良好备份 | 只读/回滚用 |
| `ntools_todo` | v1 旧键 | 迁移后保留一个版本 |
| `ntools_md` | Markdown 工具草稿 | |
| `nchat-theme` / `nchat-lite-mode` | `light`/`dark`、`'true'`/`'false'` | |

旧 `nchat-settings` 在 `llm-store.init()` 时迁移为 profiles（保留旧 config id，兼容旧会话），旧键保留可回滚。

## 4. 事件

| 事件 | 载荷 | 发送方 → 订阅方 |
|---|---|---|
| `llm:changed` | `{state, reason}` | llm-store → 设置面板 / 快捷时间 / 聊天 |
| `llm:profile-selected` | `{profileId, profile}` | llm-store → chat-embed（切换会话） |
| `settings:changed` / `config:switched` | `{configs,currentId}` / `{configId}` | settings-store(适配) → 聊天视图 |
| `conversation:changed` / `conversation:truncated` | `{messages}` / `{fromIndex,removed}` | conversation-store → message-view |
| `stream:start/delta/reasoning/usage/done/error/aborted` | 增量/统计/错误 | api → message-view/composer |
| `todo:changed` | `{doc,reason}` | todo-store → todo-view/提醒/角标 |
| `storage:error` / `storage:corrupt` / `quota:warning` | `{key,error,...}` | storage → 顶栏提示 |
| `app:error` | `{error,message}` | ui 全局兜底 → Toast |

## 5. 关键数据流

### 5.1 原生聊天（chat-embed）

```
ntools-app.switchTab('nchat')
   → NC.chatEmbed.init()（幂等懒加载）
        → NC.store.llm 已就绪（ntools-app 启动时已 init）
        → conversation.switchConfig(currentProfileId)
        → messages/composer 绑定 #page-nchat 内 DOM
        → controller.init({ settings: llm 适配层, openSettings })

发送：composer → controller.send → api.chat(config = llm.getChatConfig())
     → sse 增量 → message-view 局部渲染 → conversation-store 持久化（按端点）
端点切换：llm.selectProfile → conversation.switchConfig → renderConversation
系统提示词：profile.chatSystemPrompt → payload 的 system 消息（保存后下一条生效）
```

### 5.2 Todo AI 识别

```
用户粘贴邮件 → todo-ai.openDialog
  → buildSystemPrompt(now, profile)：取 llm.todoAi + workEndTime
       替换 {{NOW}}/{{DATE}}/{{WEEKDAY}}/{{TZ}}/{{WORK_END}}（每次调用重新生成）
  → NC.ai.complete(profile, systemPrompt, userText, temperature, topP)
  → NC.ai.extractJson → normalizeData
  → NC.tools.todo.fillDraft(data)
       → todo-view.applyDraft：填充标题/详情/截止/优先级/标签/清单
       → 展开创建区、聚焦标题、显示草稿条
  → 用户确认/编辑后点击「添加任务」→ todo-store.addTask 才落库
```

### 5.3 快捷时间

```
todo-time.computeQuickDue(kind, now, workEnd)
  ← workEnd 实时读取 NC.store.llm.getWorkEndTime()（默认 17:30，设置面板可改）
  kinds：work-end / tomorrow / friday / next-week / month-end / clear
```

## 6. 兼容与降级

| 能力 | Chromium 102 | 降级 |
|---|---|---|
| localStorage | 可用（`file://` 同源共享） | 内存模式 + 常驻横幅 |
| 剪贴板 API | 可用（安全上下文） | `execCommand('copy')` |
| Notification | `file://` 下 denied | 页内 Toast + 标题角标 |
| 流式 fetch | 可用 | `response.text()` 一次性兜底（api 层） |
| 毛玻璃 / 动画 | 可用 | Lite / reduced-motion 关闭 |
| 聊天初始化 | 懒加载 | 缺失模块时其它工具照常可用 |

## 7. 验证

- `tests.html`：81 项纯函数断言（core/storage/schema/sse/api/llm-store/todo-time/ai）；
- `tools/verify.js`：页面级验收（含原生聊天无 iframe、设置面板、v1→v2 迁移、截图）；
- `tools/e2e.js`：回归交互（待办/聊天流式/停止/安全/500 条性能）；
- `tools/e2e-features.js`：功能回归（多端点 CRUD、系统提示词、端点会话隔离、Todo AI、快捷时间）；
- `tools/break-ui.js`：最坏数据 / 320–1440 / 200% 缩放 / 移动端原生审计（v4.1，32 组 0 问题）；
- `tools/e2e-timeline.js`：全景时间线 E2E（40 断言）；`tools/e2e-v41.js`：v4.1 交互/置顶/循环/热区/侧栏/设置弹窗 E2E（17 断言）；
- 现场：`chrome://version`、CORS（Origin: null + OPTIONS）、存储持久性、中文 IME、下载/剪贴板策略。
