# v3 功能迭代契约（原生聊天 / 全局端点 / Todo AI / 设计打磨）

> 基线：`docs/dev-contract.md` 继续有效（经典脚本、IIFE、Chromium 102、无构建链、数据安全渲染）。
> 本轮新增/变更的接口与所有权如下。**只改自己写域，公共 API 变更先找 Lead。**

## 0. 目标与验收

1. nChat **原生**嵌入 `ntools.html` 的 `#page-nchat`（不再用 iframe）；旧 `index.html` 只做跳转页。
2. 模型端点（profile）提升为 nTools 全局设置：设置面板可增删改多个端点（名称/Base URL/API Key/Model），并选择当前聊天端点。
3. 聊天系统提示词**按端点独立**，可在聊天页快捷编辑（写入 `profile.chatSystemPrompt`）。
4. Todo 支持大模型识别：粘贴邮件/长文本 → 提取标题、详情、截止时间、优先级、标签 → **填充表单但不自动创建**，用户编辑后手动点击创建。
5. Todo 创建界面增加快捷时间：`下班前 / 明天前 / 周五前 / 下周前 / 月底前 / 清除`；下班时间默认 `17:30`，可在设置中修改。
6. 设置面板支持：Todo AI 系统提示词（调用时自动注入当前日期时间/星期/时区/下班时间）、temperature、top-p、使用端点。
7. UI：参考 Apple Design（克制、层次、留白、圆角材质、细腻动效），同时照顾信创 ARM 性能（transform/opacity、Lite/reduce-motion 关闭动画、懒加载聊天）。

## 1. 全局数据层 `NC.store.llm`（Lead 实现，`js/llm-store.js`）

存储键 `ntools.llm.v1`；首次启动迁移旧 `nchat-settings`（`{currentId,configs[]}`）。

```js
state = {
  version: 1,
  profiles: [{
    id, name, baseUrl, apiKey, modelId,
    chatSystemPrompt,            // 该端点的聊天系统提示词（聊天页可编辑）
    temperature, topP,           // 0-2；聊天默认 1 / 0.95
    createdAt, updatedAt
  }],
  currentProfileId,
  todoAi: {
    profileId,                   // 用于 Todo 识别的端点；null = 跟随当前端点
    systemPrompt,                // 支持 {{NOW}} {{DATE}} {{WEEKDAY}} {{TZ}} {{WORK_END}} 占位符
    temperature,                 // 默认 0.2
    topP                         // 默认 0.9
  },
  workEndTime: '17:30',          // 'HH:mm'
  updatedAt
}
```

API（全部不 throw；写操作持久化并 emit）：

| 方法 | 返回 | 说明 |
|---|---|---|
| `init()` | state | 迁移/加载；幂等 |
| `getState()` | 快照 | 深拷贝，调用方可读 |
| `getProfiles()` / `getProfile(id)` / `getCurrentProfile()` | profile 副本 | 不存在返回 null |
| `selectProfile(id)` | bool | 切换当前端点；emit `llm:profile-selected` `{profileId, profile}` |
| `addProfile(partial)` | profile | 自动 `p_<uid>`、合理默认值；至少保留 1 个 |
| `updateProfile(id, patch)` | profile/null | allowlist：name/baseUrl/apiKey/modelId/chatSystemPrompt/temperature/topP |
| `removeProfile(id)` | bool | 不允许删最后一个；删当前则自动选第一个 |
| `getChatConfig(profileId?)` | config | `{id,name,apiUrl,apiKey,modelId,systemPrompt:chatSystemPrompt,enableAdvanced:true,temperature,top_p:topP}` |
| `setChatSystemPrompt(profileId, text)` | profile | 聊天页快捷编辑用 |
| `getTodoAi()` / `setTodoAi(patch)` | todoAi 副本 / 新值 | patch 白名单：profileId/systemPrompt/temperature/topP |
| `getWorkEndTime()` / `setWorkEndTime('HH:mm')` | string / bool | 非法值拒绝，返回 false |
| `exportAll({includeKeys})` | object | 默认不含 apiKey；`keysIncluded` 标记 |
| `importAll(json, {merge})` | `{ok, imported, rejected, message}` | 经 schema 归一；失败不落盘 |
| `reset()` | bool | 重置为默认（设置面板“恢复默认”用） |

事件：`llm:changed` `{state, reason}`、`llm:profile-selected` `{profileId, profile}`。

默认 `todoAi.systemPrompt`（含占位符，调用时替换）：

```text
你是待办事项提取助手。请从用户提供的文本中提取一项待办任务，并只输出 JSON 对象，不要输出解释。
字段：title（≤80字）、notes（≤1000字）、due（YYYY-MM-DDTHH:mm 本地时间，无法判断为 null）、
dueAllDay（boolean）、priority（low|normal|high|urgent）、tags（0-5 个字符串）、listName（可选）。
当前时间：{{NOW}}（{{WEEKDAY}}，时区 {{TZ}}），下班时间 {{WORK_END}}。
相对时间（如“明天下班前”“周五前”“月底前”）请换算成具体时间；无法判断 due 时给 null。
```

## 2. 一次性模型调用 `NC.ai`（Lead 实现，`js/ai.js`）

```js
NC.ai.complete({
  profile,            // {baseUrl/apiUrl, apiKey, modelId} 或 llm profile
  systemPrompt,       // string
  userText,           // string 或 messages[]
  messages,           // 可选完整 [{role, content}]，优先于 userText
  temperature, topP,  // 可选
  timeoutMs,          // 默认 60000
  signal              // 可选 AbortSignal
}) → Promise<
  {ok:true, text, usage:{promptTokens,completionTokens,totalTokens}, latencyMs}
  | {ok:false, error:{type:'config'|'auth'|'rate'|'server'|'network'|'timeout'|'aborted'|'parse', message, status?}}
>
```

- 非流式 `POST {baseUrl}/chat/completions`，`stream:false`；自动补 `/chat/completions`、去尾斜杠。
- `NC.ai.extractJson(text)`：剥离 ```json 围栏/前后说明，提取第一个平衡的 `{...}` 或 `[...]`，返回 object|null（纯函数，可单测）。
- `NC.ai.testProfile(profile)`：设置面板“测试连接”按钮用，返回 `{ok, latencyMs, message}`。
- 错误映射中文可读（401→密钥无效、404→地址/模型、429→限流、超时等）。

## 3. 全局设置面板 `NC.settingsPanel`（Lead 实现）

- 文件：`js/settings-panel.js` + `css/settings.css`；入口：侧栏底部 `#settings-btn`（齿轮）与应用菜单「设置」。
- DOM：`#settings-sheet`（全屏右侧 sheet/弹层）、`#settings-nav`、`#settings-body`、`#settings-close`。
- API：
  - `init()` 绑定入口并渲染内置分区；
  - `open(sectionId?)` / `close()`；
  - `registerSection({id,title,icon,order,render(container, ctx)})`（可选扩展；本轮内置分区即可）。
- 内置分区：
  1. **模型端点**：列表 + 新增/删除；编辑名称、Base URL、API Key（password，可显示）、Model ID、聊天系统提示词、temperature/topP；设为当前；测试连接。
  2. **Todo AI**：使用端点（下拉，含“跟随当前端点”）、系统提示词 textarea（说明占位符）、temperature、topP。
  3. **通用**：主题（深/浅）、Lite、下班时间（`type=time`，默认 17:30）、当前存储状态。
  4. **数据**：导出全部（默认不含密钥）、导入、清空聊天记录、清空 Todo、清除全部本地数据（二次确认）。
  5. **关于**：版本、兼容性自检链接、快捷键入口。
- 设置保存立即生效并 emit 事件；显示“已保存”状态；Esc/点击遮罩关闭；焦点陷阱。
- 聊天页快捷入口：聊天工具栏「系统提示词」按钮打开小面板（B 实现），写入 `NC.store.llm.setChatSystemPrompt`。

## 4. 原生聊天嵌入（B 实现）

### 4.1 DOM 契约（Lead 在 `ntools.html #page-nchat` 提供）

```html
<div class="chat-app chat-app--embed" id="chat-app">
  <header class="chat-toolbar chat-toolbar--embed">
    <select id="chat-profile-select" aria-label="模型端点"></select>
    <span id="chat-profile-meta"></span>
    <button id="chat-system-prompt-btn">系统提示词</button>
    <button id="chat-menu-btn" aria-expanded="false">…</button>
    <div id="chat-menu" hidden>
      <button id="export-conversation-btn">导出对话</button>
      <button id="backup-conversation-btn">备份对话</button>
      <button id="restore-conversation-btn">恢复对话</button>
      <button id="clear-chat-btn">清除对话</button>
    </div>
  </header>
  <main id="chat-container" class="chat-main" role="log"></main>
  <button id="jump-bottom-btn" class="chat-jump" hidden></button>
  <footer id="input-area-container" class="chat-composer">…（composer 依赖的 id 全套）</footer>
</div>
<div id="image-lightbox">#lightbox-close #lightbox-img</div>
<input type="file" id="restore-conversation-input" hidden>
<div id="chat-system-prompt-sheet" hidden> #chat-system-prompt-input #chat-system-prompt-save
  #chat-system-prompt-reset #chat-system-prompt-cancel #chat-system-prompt-profile </div>
```

composer 必需 id：`input-area-container`、`user-input`、`send-btn`、`upload-btn`、`image-input`、`image-preview-container`。
message-view 必需 id：`chat-container`、`image-lightbox`、`lightbox-img`、`lightbox-close`。
controller 菜单必需 id：`export-conversation-btn`、`backup-conversation-btn`、`restore-conversation-btn`、`clear-chat-btn`、`restore-conversation-input`、`jump-bottom-btn`。

### 4.2 组合根 `js/chat-embed.js`（B 新建）

- `NC.chatEmbed.init()`：**幂等、懒加载**（ntools-app 首次切到 `#nchat` 时调用）。
- 初始化顺序：`NC.store.llm.init()`（若未初始化）→ `NC.store.settings`（适配层）→ `conversation.init(currentProfileId)` → `messages.init(#chat-container, handlers)` → `composer.init(...)` → `controller.init({ settings, conversation, messages, composer, openSettings })`。
- 端点下拉：渲染 profiles，切换时 `NC.store.llm.selectProfile` + `conversation.switchConfig(profileId)` + `controller.renderConversation(...)`；聊天按端点独立会话。
- 系统提示词小面板：读/写当前端点 `chatSystemPrompt`；保存后 toast；下一条消息生效（无需清空会话）。
- 无端点/缺 Key：显示引导（打开设置面板的模型端点分区）。
- `js/settings-store.js` 改为 **适配层**（同上 API：`init/getState/getConfig/subscribe/select/...`），内部读 `NC.store.llm`；不要保留旧存储双写。
- `js/chat-controller.js` 仅做最小改动：`deps.settingsView.open()` → `deps.openSettings()`（或无端点时 emit `chat:need-config`）；payload/流式逻辑保持。
- `css/chat.css`：适配嵌入式（`.chat-app--embed` 填满面板、圆角/边框、顶部栏与 nTools 风格一致；移除独立页面的 body/居中假设；≤768px 紧凑）。
- `index.html` 由 Lead 改为跳转页；`js/app.js`、`js/settings-view.js` 由 B 删除或改造（确保无脚本再引用）。

### 4.3 行为契约（不可回退）

切换端点 → 新端点独立会话；系统提示词按端点隔离；发送/流式/思考/停止/统计/复制/重新生成/编辑/删除/导出/备份/恢复/清空保持 v2 行为；无配置时给出可操作提示；`file://` 下无 ES Module。

## 5. Todo AI 与快捷时间（A 实现）

### 5.1 `js/todo-ai.js`（A 新建）

- `NC.todoAi.DEFAULT_PROMPT`（与 llm-store 默认一致；llm-store 初始化时若取不到可用该值）。
- `NC.todoAi.buildSystemPrompt(now?, profile?)`：取 `NC.store.llm.getTodoAi()`；替换 `{{NOW}}`（`YYYY-MM-DD HH:mm`）、`{{DATE}}`、`{{WEEKDAY}}`、`{{TZ}}`、`{{WORK_END}}`；若模板缺少“只输出 JSON”约束则追加。**不缓存在 prompt 里写死时间**，每次调用重新生成。
- `NC.todoAi.parseText(text, {signal})` → `{ok, data:{title,notes,due,dueAllDay,priority,tags,listName}, error?}`：
  - 端点：`todoAi.profileId || currentProfileId`；temperature/topP 用 todoAi 配置；
  - `due` 支持 `YYYY-MM-DDTHH:mm` / `YYYY-MM-DD HH:mm` / ISO；无法解析→null；
  - `priority` 映射到 `low|normal|high|urgent`；`tags` 去空、去重、≤5；
  - 解析失败时用原文截断兜底为 title/notes？不：返回错误提示“识别结果格式异常，可重试”，不写数据。
- `NC.todoAi.openDialog()`：模态框（NC.ui.openModal size lg）：
  - 大 textarea（placeholder：粘贴工作邮件/会议纪要…）、端点与模型提示、识别按钮；
  - loading 状态（按钮 spinner + 不可关闭防止误触）；
  - 成功后关闭并调用 `NC.tools.todo.fillDraft(data)`；**绝不自动创建**。
- 入口：待办顶部操作区「AI 识别」按钮（sparkles 图标）+ 创建输入框粘贴长文本（>120 字）时 toast 提供「AI 识别」动作。

### 5.2 快捷时间 `NC.todoTime`（A 实现，供 UI/测试）

`NC.todoTime.quickDueOptions(now?)` → `[{kind,label,ts,text}]`；`NC.todoTime.computeQuickDue(kind, now?, workEnd?)` → epoch ms|null（纯函数）。

| kind | label | 规则（workEnd 默认 17:30，可在设置改） |
|---|---|---|
| `work-end` | 下班前 | 今天 workEnd；若已过则下一个工作日 workEnd（跳过周六日） |
| `tomorrow` | 明天前 | 明天 workEnd |
| `friday` | 周五前 | 本周五 workEnd；若已过则下周五 |
| `next-week` | 下周前 | 下周一 09:00 |
| `month-end` | 月底前 | 本月最后一天 workEnd |
| `clear` | 清除 | 清空 due |

### 5.3 UI 改动（A）

- 创建区展开面板新增快捷时间 chips（`.todo-quick-due`），点击填充 `#todo-new-due` 并显示对应日期文本；手动修改时间后取消 active。
- `NC.tools.todo.fillDraft(data)`：填充标题/详情/截止/优先级/标签（清单可选），展开详细面板、聚焦标题、不提交；返回 bool。
- 详情抽屉可复用快捷时间（可选，时间允许再做）。
- `tools.css` 新增 AI 弹窗、快捷 chips、loading、粘贴提示样式；遵循 tokens 与动效约定。

## 6. 测试与验收（C 实现）

- `tests.html` 新增断言：
  - `NC.ai.extractJson`（围栏/前后缀/嵌套/畸形）；
  - `NC.todoTime.computeQuickDue`（工作日/周末/已过下班/月底/跨年边界）；
  - `NC.todoAi.buildSystemPrompt`（当前时间注入、占位符替换、workEnd 生效）；
  - `NC.store.llm` 迁移与 CRUD（在临时 localStorage 中跑，结束清理）。
- 新建 `tools/e2e-features.js`（mock fetch，不联网）：
  1. 设置面板：打开 → 新增端点（填 mock 值）→ 保存 → 端点下拉同步 → 设为当前 → 刷新后仍在；
  2. 原生聊天：`#page-nchat` 内无 iframe；mock SSE 发送/流式/停止正常；切换端点会话隔离；系统提示词保存后请求 payload 含 system 消息；
  3. Todo AI：mock 返回 JSON → 点击「AI 识别」→ 粘贴邮件 → 识别 → 表单被填充（标题/详情/截止/标签）→ **未创建任务** → 修改标题后点击创建 → 任务创建成功；
  4. 快捷时间：下班前/明天前/周五前/下周前/月底前填充值正确；设置改下班时间后重新计算生效；
  5. 全程无 console.error / 未捕获异常。
- 截图：`tools/screenshot.sh` 基础上补 `ntools.html#nchat`、设置面板、Todo AI 弹窗、快捷时间 chips 的截图（可写 `tools/shots-v3.sh` 或扩展）。
- 文档：更新 `docs/compatibility.md` 如有影响；README 功能清单由 Lead 更新。

## 7. 写域与协作

| 成员 | 写域 |
|---|---|
| Lead | `js/llm-store.js`、`js/ai.js`、`js/settings-panel.js`、`css/settings.css`、`ntools.html`、`js/ntools-app.js`、`index.html`、`README.md`、`docs/*`、`tools/e2e.js`、`tools/verify.js`、`css/tokens.css`、`css/components.css`、`img/*`、最终提交/推送 |
| B（app-auditor） | `js/chat-embed.js`、`js/settings-store.js`、`js/chat-controller.js`、`js/message-view.js`、`js/composer.js`、`js/settings-view.js`（改造为聊天系统提示词小面板，或删除）、`css/chat.css`、删除 `js/app.js`（确认无引用后） |
| A（todo-specialist） | `js/todo-ai.js`、`js/todo-time.js`（可选）、`js/todo.js`、`js/todo-view.js`、`css/tools.css` |
| C（platform-compat） | `tests.html`、`tools/e2e-features.js`、`tools/shots-v3.sh`、`docs/compatibility.md` 如涉及 |

- 公共 API 缺失先发消息给 Lead，不改他人文件；不 git commit；完成后跑 `node --check` 与对应截图/自动化自查。
- 实现顺序：Lead 先落 `llm-store/ai/settings-panel` 与 `ntools.html` 骨架；B/A 可先写各自模块（按本契约接口），在骨架就位后联调；C 在 B/A 模块就位后跑 E2E。
