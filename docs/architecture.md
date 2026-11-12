# nChat / nTools v2 架构说明

> 运行形态：纯静态、`file://` 双击可用、无构建链、无后端；经典 `<script>` + IIFE 命名空间（`window.NC`）。
> 目标内核：奇安信可信浏览器 Chromium 102 / 麒麟 Linux ARM。

## 1. 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 入口页（index.html / ntools.html / compat-check.html / tests.html）│
└───────────────┬──────────────────────────────────────────────┘
                │ 组合根：app.js / ntools-app.js（只装配，不写业务）
                ▼
┌────────────────────────── 视图层 ──────────────────────────────┐
│ message-view / composer / settings-view / todo-view            │
│ 只读状态快照、只写 DOM、事件委托、调用 store action             │
└───────────────┬──────────────────────────────────────────────┘
                │ NC.events（单向数据流）
┌───────────────▼──────────────┐   ┌─────────────────────────────┐
│ 状态层                      │   │ 服务层                       │
│ settings-store              │   │ sse（纯状态机）              │
│ conversation-store          │   │ api（URL/payload/超时/错误）  │
│ todo-store（含撤销栈）       │   │ reminder（页内提醒 ticker）   │
└───────────────┬──────────────┘   └─────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────┐
│ 基础设施：core（命名空间/事件/DOM/日期） storage（safeGet/Set） │
│           schema-todo / schema-chat（校验与迁移，纯函数）       │
│           compat（能力检测） icons / ui（模态/Toast/菜单）      │
│           theme-boot（首屏防闪烁） / theme（主题 & Lite）        │
└──────────────────────────────────────────────────────────────┘
```

硬规则：
- store **不碰 DOM**，view **不碰存储/网络**，service **不碰 DOM**；
- 所有外部数据（导入/备份/历史）先经 schema 校验归一，再落盘、再渲染；
- 用户数据只用 `textContent` / `NC.util.e()` 渲染；Markdown 必须 DOMPurify。

## 2. 模块与加载顺序

### 聊天页 index.html

| 顺序 | 文件 | 职责 |
|---|---|---|
| 1 | `css/tokens.css` → `base.css` → `components.css` → `chat.css` | 设计令牌 / 基础 / 公共组件 / 聊天样式 |
| 2 | `js/theme-boot.js`（阻塞） | 首屏设置 `data-theme`/`data-lite`，防 FOUC |
| 3 | `polyfills.js` → `vendor/marked` → `vendor/purify` | 兼容垫片 + 渲染依赖 |
| 4 | `core.js` → `compat.js` → `icons.js` → `storage.js` → `ui.js` → `theme.js` | 基础设施 |
| 5 | `schema-chat.js` → `settings-store.js` → `conversation-store.js` → `sse.js` → `api.js` | 数据与网络 |
| 6 | `message-view.js` → `composer.js` → `settings-view.js` | 视图 |
| 7 | `chat-controller.js` | 控制器（流式状态机/消息操作/会话文件/菜单动作） |
| 8 | `app.js` | 组合根 |

### 工具页 ntools.html

| 顺序 | 文件 | 职责 |
|---|---|---|
| 1 | CSS：tokens → base → components → tools | |
| 2 | `theme-boot.js` → `polyfills.js` → `vendor/marked` → `vendor/purify` → `vendor/qrcode` | |
| 3 | `core.js` → `compat.js` → `icons.js` → `storage.js` → `ui.js` → `theme.js` | |
| 4 | `schema-todo.js` → `todo-store.js` → `todo-view.js` → `todo.js` | Todo 专项 |
| 5 | `qr.js` → `markdown.js` → `image.js` | 工具叶子模块 |
| 6 | `ntools-app.js` | 组合根（tab/主题/初始化） |

## 3. 存储键

| 键 | 内容 | 备注 |
|---|---|---|
| `nchat-settings` | `{version:2, currentId, configs[]}` | 兼容旧形状（无 version 时迁移） |
| `nchat-conversation.v2` | `{version:2, sessions:{[configId]:{messages[],updatedAt}}}` | 旧 `nchat-conversation`（数组）自动迁移 |
| `nchat-theme` | `light` / `dark` | |
| `nchat-lite-mode` | `'true'` / `'false'` | |
| `ntools.todo.v2` | Todo 单文档（`schemaVersion:2`） | 详情见 dev-contract |
| `ntools.todo.v1_backup` | v1 原始字符串 | 迁移前冻结 |
| `ntools.todo.v2_backup` | 上一次良好文档 | 导入/迁移前自动备份 |
| `ntools_todo` | v1 旧键 | 迁移后只读保留一个版本 |
| `ntools_md` | Markdown 工具草稿 | |

追加规则：新键统一带版本；旧键只读保留；迁移永不删除原数据；写入前估算大小（≤3.5MB）。

## 4. 事件

| 事件 | 载荷 | 发送方 → 订阅方 |
|---|---|---|
| `theme:changed` / `lite:changed` | `{theme}` / `{lite}` | theme → 页面 |
| `settings:changed` / `config:switched` | `{configs,currentId}` / `{configId}` | settings-store → 视图/会话 |
| `conversation:changed` / `conversation:truncated` | `{messages}` / `{fromIndex,removed}` | conversation-store → message-view |
| `stream:start/delta/reasoning/usage/done/error/aborted` | 增量/统计/错误 | api → message-view/composer |
| `todo:changed` | `{doc,reason}` | todo-store → todo-view/提醒/角标 |
| `storage:error` / `storage:corrupt` / `quota:warning` | `{key,error,...}` | storage → 顶栏警告 |
| `app:error` | `{error,message}` | ui 全局兜底 → 提示 |

约定：emit 只传不可变快照或明确字段；view 不得在订阅里再 emit 同名事件，避免递归。

## 5. Todo 数据流

```
用户操作 → todo-view 委托处理 → todo-store.dispatch(action)
        → 更新 doc + revision+1 + updatedAt
        → 入撤销栈（快照/补丁）
        → debounce 300ms 持久化（pagehide flush）
        → events.emit('todo:changed')
        → todo-view keyed diff 更新受影响节点
        → 提醒引擎 ticker / 标题角标 / 跨标签广播（storage 事件）
```

性能要点：
- `keyed diff`：`Map<id, HTMLElement>` 复用节点，只有变化字段改 textContent/class；
- ticker 对齐分钟边界，`document.hidden` 暂停，只更新时间文本与逾期计数；
- 搜索 200ms 防抖；批量操作合并为一步撤销；
- 滚动、焦点、选中在重渲染后保持。

## 6. 兼容与降级

| 能力 | Chrome 102 | 降级 |
|---|---|---|
| localStorage | 可用（`file://` 全机共享） | 内存模式 + 常驻横幅 |
| clipboard API | 可用（`file://` 安全上下文） | `execCommand('copy')` |
| Notification | `file://` 下 denied | 页内 Toast + 标题角标 |
| IndexedDB | 可用 | 不持久化图片，仅占位 |
| BroadcastChannel | 可用 | `storage` 事件 |
| 流式 fetch | 可用 | `response.text()` 一次性返回 |
| 毛玻璃/动画 | 可用 | Lite 模式 / reduce-motion 关闭 |

## 7. 验证

- `tests.html`：纯函数断言（core/storage/schema/sse/api），双击即跑；
- `compat-check.html`：运行时能力三态自检 + 一键复制报告；
- `tools/screenshot.sh`：headless 截图（深/浅/Lite × 桌面/移动）；
- 现场：`chrome://version` 内核、CORS（`Origin: null`+OPTIONS）、存储持久性、中文 IME、下载/剪贴板策略。
