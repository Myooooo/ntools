# v2 重构开发契约（执行版）

> 目标：Chromium 102（奇安信可信浏览器）/ 麒麟 Linux / `file://` 双击可用 / 无构建链 / 经典脚本 IIFE。
> 本文件是并行开发的唯一接口约定。**改动公共基础设施前必须先通知 Lead**。

## 0. 硬性规则

1. **不使用 ES Module / import / export / 打包器**；所有 JS 为经典 `<script src>`，IIFE 包裹，挂到 `window.NC`。
2. **Chromium 102 基线**：可用 `?.`/`??`、`Array.prototype.at`、`Object.hasOwn`、`structuredClone`、`flex gap`；**禁用** `:has()`、容器查询、`dvh/svh/lvh`、`color-mix()`、`crypto.randomUUID` 作为唯一方案、Service Worker。
3. **零外网依赖**：不得引用 CDN、Web 字体、远程图片。图标只用 `js/icons.js` 或内联 SVG。
4. **用户数据渲染**：一律 `textContent` / `NC.util.e()`；只有可信静态模板可用 `innerHTML`。Markdown 必须 `DOMPurify.sanitize(marked.parse())`。
5. **性能**：列表渲染用 keyed diff（按 id 复用节点）；禁止每次状态变化重建整棵树；滚动/输入/流式渲染用 `requestAnimationFrame`/`throttle`/`debounce`；`document.hidden` 时暂停 ticker。
6. **动效**：只做 transform/opacity，120–260ms，统一使用 `--nc-dur*` / `--nc-ease*`；`html[data-lite="true"]` 与 `prefers-reduced-motion` 下必须自动关闭。
7. **可访问性**：可点击元素用 `<button>`；表单有 label/aria-label；模态焦点陷阱 + Esc；`:focus-visible` 可见焦点环；触控目标 ≥ 32px。
8. **文件所有权**：只改自己负责的文件；发现公共 API 不够用，发消息给 Lead，不要自行改公共文件。
9. **每改完一个文件跑** `node --check <file>`；页面级改动跑 headless 截图自查（命令见 §7）。
10. **不要 git commit / git checkout / git reset**；Lead 统一提交。

## 1. 加载顺序（两页统一）

```html
<!-- CSS -->
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/base.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/chat.css">   <!-- 或 tools.css -->
<!-- 主题引导：必须在 CSS 之后、其他脚本之前，阻塞加载，防闪烁 -->
<script src="js/theme-boot.js"></script>
<!-- 其余脚本全部 defer，顺序即依赖顺序 -->
<script defer src="js/polyfills.js"></script>
<script defer src="js/vendor/marked.min.js"></script>        <!-- 仅聊天/MD 页面 -->
<script defer src="js/vendor/purify.min.js"></script>        <!-- 聊天/MD 页面必须 -->
<script defer src="js/vendor/qrcode.min.js"></script>        <!-- 仅工具页 -->
<script defer src="js/core.js"></script>
<script defer src="js/compat.js"></script>
<script defer src="js/icons.js"></script>
<script defer src="js/storage.js"></script>
<script defer src="js/ui.js"></script>
<script defer src="js/theme.js"></script>
<!-- 以下按页面 -->
... 页面模块（见 §3 / §4） ...
```

> 现有 `js/marked.min.js`、`js/purify.min.js`、`js/qrcode.min.js` 位置暂不变（保持 `js/` 根目录），本轮不移动 vendor。

## 2. 公共 API（Lead 维护，稳定）

### `NC` 命名空间

- `NC.version = '2.0.0'`
- `NC.events`: `on(type, fn) → off()`、`off(type, fn)`、`once(type, fn)`、`emit(type, payload)`、`clear(type?)`
- `NC.util`：
  - `escapeHtml(v)` / `escapeAttr`、`e(tag, props, children)`（安全建 DOM；`props.text` / `props.on` / `props.dataset` / `props.class`）
  - `delegate(root, eventType, selector, handler) → off()`
  - `uid(prefix)`、`cssEscape(v)`、`clamp(v,min,max)`
  - `debounce(fn,wait)`（带 `.cancel()/.flush()`）、`throttle(fn,wait)`、`rafThrottle(fn)`
  - `copyText(text) → Promise<boolean>`、`downloadBlob(filename, data, mime) → boolean`
  - `formatBytes(n)`、`pad2(n)`
  - 时间：`startOfDay(ts)`、`endOfDay(ts)`、`dayDiff(a,b)`、`isSameDay(a,b)`、`formatTime(ts)`、`formatDate(ts,withYear)`、`formatDateTime(ts)`、`relativeTime(ts,now)`、`toDateTimeInputValue(ts)`、`parseDateTimeInputValue(str)`
  - `dueMeta(ts, now) → { tone: 'overdue'|'today'|'tomorrow'|'soon'|'later'|'none', label, dateLabel, timeLabel }`
  - `prefersReducedMotion()`、`parseJSON(text, fallback)`、`ready(fn)`
- `NC.compat`：`features`（`storage/clipboard/notification/indexedDB/broadcastChannel/resizeObserver/abortController/stream/cryptoSubtle/randomUUID/cssGap/cssBackdrop/secureContext/chromeVersion/fileProtocol...`）、`has(name)`、`bootstrap()`
- `NC.storage`：
  - `available`、`memoryMode()`、`maxBytes`
  - `get(key, fallback)`（安全 JSON 读取）、`set(key, value) → {ok, bytes, memoryMode?}`、`getRaw(key)`、`setRaw(key, rawString)`、`remove(key)`、`has(key)`、`keys(prefix)`
  - `estimateBytes(v)`、`onExternalChange(key, handler) → off()`、`backupCorrupted(key, raw)`
  - 事件：`storage:error`、`storage:corrupt`、`quota:warning`
- `NC.ui`：
  - `openModal({title, message, content:Node, actions:[{label,kind,onClick,close}], dismissible, size:'sm'|'lg'|'wide', onClose, initialFocus}) → {el, close}`
  - `confirm(message, {title, confirmText, cancelText, danger, onConfirm}) → Promise<boolean>`
  - `alert(title, message) → Promise<void>`
  - `prompt({title,message,value,placeholder,multiline,required,confirmText,cancelText}) → Promise<string|null>`
  - `toast(message, {type:'info'|'success'|'warn'|'error', duration, action:{label,onClick}}) → dismiss()`
  - `openMenu(anchorEl, items, {onClose}) → {el, close}`，items: `{label, icon, hint, danger, disabled, onSelect}` 或 `{type:'divider'}`
  - `trapFocus(container) → release()`、`setBusy(button, busy)`、`installGlobalErrorHandlers()`
  - 事件：`app:error`
- `NC.icons`：`el(name, size) → SVGElement`、`svg(name, size) → string`、`has(name)`。可用名见 `js/icons.js`（plus/check/check-circle/x/trash/edit/search/calendar/clock/flag/tag/list/inbox/chevron-*/more/settings/sun/moon/download/upload/copy/send/stop/refresh/sparkles/alert/info/arrow-*/filter/folder/drag/image/link/menu/grid/layers/external/eye/key/command/zap/wifi-off）
- `NC.theme`：`init()`、`set('light'|'dark')`、`toggle()`、`setLite(bool)`、`toggleLite()`、`isLite()`、`isLight()`；事件 `theme:changed` / `lite:changed`；持久化键 `nchat-theme` / `nchat-lite-mode`
- `NC.themeBoot` 已由 `theme-boot.js` 在首屏同步执行，页面无需重复。

### 设计令牌（`css/tokens.css`，全部 `--nc-` 前缀）

颜色：`--nc-bg` `--nc-bg-soft` `--nc-surface` `--nc-surface-2` `--nc-surface-3` `--nc-surface-hover` `--nc-elevated` `--nc-input-bg` `--nc-border` `--nc-border-strong` `--nc-text` `--nc-text-2` `--nc-text-3` `--nc-accent` `--nc-accent-hover` `--nc-accent-soft` `--nc-accent-faint` `--nc-accent-ring` `--nc-accent-2` `--nc-gradient-accent` `--nc-success` `--nc-warning` `--nc-danger` + `-soft` 变体 + `--nc-priority-*`
字体：`--nc-font-sans` `--nc-font-mono` `--nc-fs-2xs…3xl` `--nc-lh-*`
间距/圆角/动效/层级：`--nc-space-1…12` `--nc-radius-xs…pill` `--nc-dur-fast/dur/slow` `--nc-ease/out/spring` `--nc-z-sticky/dropdown/modal/toast`
阴影：`--nc-shadow-1/2/3` `--nc-shadow-accent`
其他：`--nc-glass` `--nc-glass-blur` `--nc-overlay` `--nc-bg-page` `--nc-code-bg` `--nc-scrollbar` `--nc-focus-ring`

公共组件（`css/components.css`）：`nc-btn`(-primary/-ghost/-danger/-outline/-sm/-lg/-icon/-block/`is-loading`)、`nc-input`/`nc-textarea`/`nc-select`/`nc-field`/`nc-label`/`nc-field-hint`/`has-error`、`nc-check`、`nc-switch`、`nc-card`/`nc-panel`、`nc-badge`(-accent/-success/-warning/-danger/-count)、`nc-chip`、`nc-kbd`、`nc-seg`/`nc-seg__btn`、`nc-empty`、`nc-spinner`/`nc-skeleton`、`nc-modal-overlay`/`nc-modal`/`nc-modal__*`、`nc-toasts`/`nc-toast*`、`nc-menu*`、`nc-progress`、`nc-list-enter`/`nc-list-leave`、工具类 `nc-sr-only`/`nc-truncate`/`nc-clamp-2`/`nc-scroll`。

## 3. 工具页（nTools）文件所有权与接口

**Owner：todo-specialist（A）**

| 文件 | 说明 |
|---|---|
| `ntools.html` | 外壳重写：去掉全部内联 `<style>`/`<script>`/`onclick`；按 §1 顺序加载；包含 5 个 tab 与 todo 三栏结构 |
| `js/ntools-app.js` | 外壳逻辑：tab 切换（hash 同步）、主题/Lite 菜单、初始化各工具模块、初始化 Todo |
| `js/schema-todo.js` | Todo 文档校验/归一化/迁移（纯函数，可单测） |
| `js/todo-store.js` | Todo 状态 + 持久化 + 撤销/重做 + 跨标签同步 |
| `js/todo-view.js` | Todo 视图（keyed diff、事件委托、详情抽屉、行内编辑、筛选/搜索/排序 UI） |
| `js/todo.js` | Todo 功能入口：提醒 ticker、导入导出、快捷键、demo 数据 |
| `css/tools.css` | 工具页全部样式（含 todo/qr/md/image/nchat 面板、响应式、动效） |

**Owner：platform-compat（C）**（只写以下文件，**不得改 `ntools.html`**）

| 文件 | 接口约定 |
|---|---|
| `js/qr.js` | `NC.tools.qr.init()`：只读查找 `#qr-input`(input)、`#qr-size`(select)、`#qr-generate`(button)、`#qr-download`(button)、`#qr-output`(div 容器)、`#qr-placeholder`(div)；生成用 `new QRCode(container,{...})`；下载取 canvas `toDataURL('image/png')`；错误用 `NC.ui.toast` |
| `js/markdown.js` | `NC.tools.markdown.init()`：`#md-input`(textarea)、`#md-preview`(div)、`#md-export`(button)、`#md-import`(input[type=file] hidden)、`#md-import-btn`(button)、`#md-stats`(span)；渲染必须 `DOMPurify.sanitize(marked.parse(text), {USE_PROFILES:{html:true}})`；输入 200ms 防抖 + `ntools_md` 持久化 |
| `js/image.js` | `NC.tools.image.init()`：`#img-dropzone`、`#img-file`(input)、`#img-preview`(img)、`#img-scale`(range)、`#img-scale-label`、`#img-res-original`、`#img-res-target`、`#img-convert`、`#img-output`(textarea)、`#img-copy`、`#img-restore`；缩放宽高 `Math.max(1, …)`；复制走 `NC.util.copyText` |
| `compat-check.html` | 独立自检页（样式可内联少量，或复用 tokens/base/components）；展示 UA/内核/协议/安全上下文/存储/剪贴板/通知/iframe/数组 at/CSS 能力；三态 + 一键复制报告 |
| `tests.html` | 双击可跑断言页：`core.util`、`storage`（mock 可用 try/catch 场景）、`schema-todo`、`schema-chat`、`sse`、`api` 纯函数；红/绿列表 + 汇总；不依赖网络 |
| `docs/compatibility.md` | 兼容性结论 + 现场验证步骤（可基于已有 docs/refactor-and-optimization-plan.md 第 2/11 章压缩） |
| `tools/screenshot.sh` | 用 Chrome for Testing headless 对 `index.html`、`ntools.html`、`compat-check.html` 截图到 `/tmp/nc-shots/`（两主题 × 桌面/移动） |

**C 不得写**：`ntools.html`、`index.html`、`js/todo*`、`js/schema-todo.js`、`js/schema-chat.js`、`js/app.js`、`css/*`、公共 `js/*`。

## 4. 聊天页（nChat）文件所有权与接口

**Owner：app-auditor（B）**

| 文件 | 说明 |
|---|---|
| `index.html` | 重写结构：保留功能与 DOM id 契约（见下），按 §1 加载；去掉内联 style 与 `user-scalable=no`；补 aria |
| `js/app.js` | 组合根（目标 <200 行）：初始化 stores/views、wire 事件、首屏 |
| `js/schema-chat.js` | 纯函数：`normalizeConfig`、`normalizeConfigs`、`normalizeConversation`、`normalizeBackup`、`sanitizeApiUrl`、`isAllowedImageUrl`、`WHITELIST`；挂 `NC.schema.chat` |
| `js/settings-store.js` | `NC.store.settings`：`init()`、`getState()`、`getConfig()`、`subscribe(fn)`、`select(id)`、`create(name)`、`remove(id)`、`save(patch)`、`exportConfigs({includeKey})`、`importConfigs(text)`；事件 `settings:changed`、`config:switched`；存储键 `nchat-settings`（形状保持 `{currentId,configs}`，内部加 `version:2`） |
| `js/conversation-store.js` | `NC.store.conversation`：`init(configId)`、`getState()`、`messages`、`subscribe(fn)`、`append(msg)`、`update(id,patch)`、`remove(id)`、`truncateFrom(index)`、`clear()`、`saveNow()`、`exportBackup()`、`importBackup(json)`、`switchConfig(configId)`；存储键 `nchat-conversation.v2`，形状 `{version:2, sessions:{[configId]:{messages,updatedAt}}}`；自动迁移旧数组 |
| `js/sse.js` | `NC.sse.createParser({onEvent,onDone,onError}) → {feed(text),end()}` 纯状态机；支持 CRLF、多行 data、`[DONE]`、空行分隔、跨 chunk carry；`NC.sse.parseSSE(text)` 便于测试 |
| `js/api.js` | `NC.api.chat({config, messages, signal, onDelta, onReasoning, onUsage, onDone, onError})`；`NC.api.buildUrl(base)`、`NC.api.buildPayload({config, messages, stream})` 纯函数；超时/中止/错误体映射；payload 只允许 `{role, content}` |
| `js/message-view.js` | `NC.view.messages.init(container)`、`renderAll(messages)`、`add(msg)`、`update(id,patch)`、`remove(id)`、`setStreaming(bool)`、`scrollToBottom(force)`、`renderMarkdown(text)`；统计 tooltip、复制/重新生成/编辑/删除按钮（通过事件回调） |
| `js/composer.js` | `NC.view.composer.init({onSend,onStop,onError})`、`setBusy(bool)`、`clear()`、`getValue()`、`stagedImages` 管理；IME Enter 守卫、图片压缩（最长边 1024/JPEG 0.8/最多 5 张）、粘贴/拖拽可选 |
| `js/settings-view.js` | `NC.view.settings.init()`：绑定设置面板、配置下拉、导入导出、`NC.ui` 模态；密钥导出默认脱敏 |
| `js/chat-controller.js` | `NC.chat.controller.init()`：发送→流式状态机→stats→finalize/abort/错误兜底；重新生成/编辑/删除的确认与撤销；导出/备份/恢复/清空；菜单与存储提示接线。只做控制器，不直接建 DOM（通过 view API） |
| `css/chat.css` | 聊天页样式：基于 tokens 重写，保留原视觉语言但统一令牌；消息入场动画、思考折叠、流式光标、输入区、设置面板、下拉、灯箱、响应式 |

**B 必须保留的 DOM id 契约**（供测试/调试）：`app-title`、`title-wrapper`、`toggle-settings-btn`、`menu-btn`、`main-menu`、`config-dropdown-menu`、`settings-panel`、`config-select`、`add-config-btn`、`delete-config-btn`、`config-name`、`system-prompt`、`api-url`、`api-key`、`model-id`、`advanced-toggle-btn`、`advanced-settings-container`、`temp-slider`、`temp-input`、`topp-slider`、`topp-input`、`save-settings-btn`、`save-status`、`import-settings-btn`、`import-settings-input`、`export-settings-btn`、`clear-chat-btn`、`chat-container`、`input-area-container`、`image-preview-container`、`image-input`、`upload-btn`、`user-input`、`send-btn`、`image-lightbox`、`lightbox-img`、`lightbox-close`、`export-conversation-btn`、`backup-conversation-btn`、`restore-conversation-btn`、`theme-toggle-btn`、`lite-mode-btn`。

**B 不得写**：`ntools.html`、`js/todo*`、`js/schema-todo.js`、`js/sse.js` 以外的 A/C 文件、`css/tools.css`、公共 `js/*`。

### 聊天行为契约（必须保持）

- 首启默认配置（`默认配置` / `https://api.openai.com/v1` / `gpt-4o` / temp 1.0 / top_p 0.95）+ 欢迎语。
- Enter 发送 / Shift+Enter 换行 / 中文 IME 选词 Enter 不发送；空白且无图不发送。
- 流式逐字渲染、思考过程可折叠、停止保留已生成内容、错误红条不持久化。
- 消息操作：复制、重新生成（截断后续消息需确认/撤销）、编辑、删除。
- 会话自动保存、刷新恢复；备份/恢复/导出 Markdown 可用。
- 图片最多 5 张、压缩参数不变、灯箱可看。
- 深浅主题 + Lite 模式记忆；统计（Prompt/Output/Total/Rate/Time）。
- 删除/重新生成/清空等破坏性操作有确认或撤销。

## 5. Todo 数据契约（A 实现，C 测试）

存储键：
- 主：`ntools.todo.v2`（单文档）
- 迁移前备份：`ntools.todo.v1_backup`
- 最近良好备份：`ntools.todo.v2_backup`
- v1 旧键：`ntools_todo`（迁移后只读保留）

文档形状：

```js
{
  schemaVersion: 2,
  revision: Number,
  updatedAt: Number,
  lists: [{ id, name, color, order, archived, createdAt, updatedAt }],
  tasks: [{
    id, listId, title, notes, status: 'open'|'done'|'canceled',
    priority: 'low'|'normal'|'high'|'urgent',
    due: Number|null, dueAllDay: Boolean,
    tags: [String], subtasks: [{id,title,done,order}],
    recurrence: null, reminder: {leadMinutes, firedAt, snoozeUntil, channels} | null,
    order: Number, createdAt, updatedAt, completedAt: Number|null, deletedAt: Number|null,
    source: String
  }],
  settings: { defaultListId, view: 'all'|'today'|'overdue'|'done', sort: 'smart'|'due'|'created'|'manual', showCompleted, reminderLeadMinutes, compact },
  meta: { app, appVersion, migratedFrom, migratedAt, quarantine: [] }
}
```

- 默认清单 `{id:'list_default', name:'待办', order:0}`。
- 迁移 v1：数组 → 文档；`id: "v1-" + oldId`；`content→notes`；`completed→status/completedAt=null`；`due` 非有限数→null；脏行进 `meta.quarantine`；绝不 throw。
- 导入：识别 v2 文档 / v1 数组 / `{data:[...]}`；校验→归一→预览（合法 n/拒收 m）→合并或替换；替换前写 `ntools.todo.v2_backup`。
- 导出：`{schemaVersion:2, app:'nTools', appVersion, exportedAt, lists, tasks, settings}`。

### Todo 功能范围（本轮 P0 + 主要 P1）

P0（必须全部实现）：新增/行内编辑/完成/删除+5s撤销/回收站（软删）/筛选（全部·今天·逾期·已完成）/搜索/排序（智能·截止·创建·手动）/键盘快捷键（N、/、↑↓、Space、Enter、E、Delete、Esc、Ctrl+Z/Ctrl+Shift+Z）/空状态/计数徽标/导入导出+迁移/提醒 ticker（页内 toast + 标题角标 + 逾期计数，对齐分钟、隐藏暂停）/跨标签 storage 同步。
P1（尽量实现，时间不足可留 TODO 注释）：优先级、多清单、标签、手动拖拽排序、统计概览（今日/逾期/本周完成）、回收站视图、快捷键帮助。
P2（不做）：重复任务、子任务编辑 UI（数据模型可保留）、附件、加密。

## 6. 性能与视觉要求

- Todo 500 条：首屏 ≤300ms、滚动流畅、tick 不重建 DOM、不丢滚动/焦点。
- 聊天流式：首 token 立即渲染，后续 60ms 节流；Markdown 每帧最多一次；自动滚动仅在 near-bottom（80px）内。
- 动效清单（统一节奏）：
  - 列表项进入 `nc-fade-up` 180ms；删除先 `nc-list-leave` 120ms 再移除；
  - 视图切换 120ms 淡入；
  - 模态 180ms 缩放淡入；Toast 上滑；
  - 按钮 hover 120ms；不用无限全屏动画；
  - Lite/reduced-motion 下全部瞬时完成。
- 视觉：深色为默认（高级感：低饱和蓝紫、细边框、柔和阴影、层次清晰）；浅色干净；信息密度：列表行 52–60px、分组标题 12px/大写字母间距；留白用 `--nc-space-*`；不使用大色块。
- 响应式：工具页 ≤1100px 详情改抽屉；≤768px 左侧 rail 变顶部/图标栏、待办单列；聊天 ≤768px 输入区紧凑、设置面板全屏。

## 7. 自查命令

```bash
# 语法
for f in js/*.js; do node --check "$f" || echo "FAIL $f"; done

# 截图（Chromium 154 headless；仅用于视觉自查）
CHROME="/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
mkdir -p /tmp/nc-shots
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1440,900 \
  --screenshot=/tmp/nc-shots/todo-dark.png "file:///Users/fmy/code/nchat/ntools.html"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=390,844 \
  --screenshot=/tmp/nc-shots/todo-mobile.png "file:///Users/fmy/code/nchat/ntools.html"
```

截图后用 `read_image` 查看并自查：布局不溢出、层级清楚、空状态/按钮/输入框风格统一、无默认蓝色链接/黑色边框等"未样式化"痕迹。

## 8. 协作方式

- 共享任务板：每个成员认领自己的任务（task id 会随消息发送）。
- 完成时用 `send_message` 给 Lead：变更文件清单、关键决策、已跑的验证命令与结果、已知问题。
- 遇到跨文件接口缺口：先发消息给 Lead，不要改别人的文件。
- Lead 负责：公共文件、最终集成、冲突修复、提交与验收。
