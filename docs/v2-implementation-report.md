# nChat / nTools v2 实施报告（交付验收版）

> 实施日期：2026-11-12
> 目标环境：奇安信可信浏览器 **Chromium 102** / 麒麟 Linux / 信创 ARM / `file://` 双击运行 / 无构建链
> 对照方案：[refactor-and-optimization-plan.md](refactor-and-optimization-plan.md)

## 1. 交付摘要

按方案完成全量重构，共重写/新增 **26 个自有 JS 模块（约 11.4k 行）**、**5 个 CSS 文件（约 5.3k 行）**、**4 个 HTML 入口**（约 3k 行），并新增验收工具链。两个入口均实现"零安装、双击可用、离线运行"。

| 目标 | 结果 |
|---|---|
| Chrome 102 兼容 | ✅ 无 ES Module / 无构建链 / 无可选链以上新语法；`polyfills.js` 兜底；`compat-check.html` 可现场自检 |
| 全量重构 | ✅ 巨石闭包拆分为 core / storage / schema / store / service / view / 组合根；`app.js` 194 行 |
| 性能 | ✅ Todo 500 条：导入 28–38ms、渲染 ≤500ms（实测 28–37ms）、搜索 4–7ms；流式渲染节流；keyed diff；tick 不重建 |
| 设计风格 | ✅ 统一设计令牌与组件；深/浅主题 + Lite；克制动效；三栏待办；响应式；无未样式化控件 |
| Todo 重点 | ✅ P0 全部 14 项 + P1 主要 7 项（详见 §5） |
| 安全 | ✅ 修复 Todo / Markdown 存储型 XSS、导入零校验、API Key 明文旅转、DOMPurify 升级 3.4.9；E2E 安全用例全过 |

## 2. 验收证据（可复跑）

```bash
bash tools/check.sh
```

最近一次结果：

| 检查 | 结果 |
|---|---|
| `node --check`（26 个 JS） | 全部通过 |
| `tools/verify.js`（4 个页面） | 全部通过（0 失败、0 页面错误、0 失败请求） |
| `tools/e2e.js` | **41 项交互断言全部通过**（含 mock SSE 流式/停止、payload 白名单、500 条性能、XSS、密钥脱敏） |
| `tools/run-tests.js`（tests.html） | **62 项纯函数断言全部通过**（507ms） |
| `tools/screenshot.sh` | 18/18 截图成功（index / ntools / compat-check × dark/light/lite × 1440/390） |

截图目录：`/tmp/nc-shots/`（含 `manifest.txt`）；关键截图：
`index-dark-1440.png`、`index-light-1440.png`、`index-dark-390.png`、
`ntools-dark-1440.png`、`ntools-light-1440.png`、`ntools-dark-390.png`、
`compat-check-dark-1440.png`、`tests-dark-1440.png`、
`tabs/ntools-todo-drawer-dark-1440.png`（待办三栏 + 详情抽屉）、
`tabs/ntools-qr-dark-1440.png`、`tabs/ntools-md-dark-1440.png`、`tabs/ntools-image-dark-1440.png`。

## 3. 架构落地

```
入口页（index.html / ntools.html / compat-check.html / tests.html）
   └─ 组合根：app.js（194 行）/ ntools-app.js（460 行）
        └─ 视图层：message-view / composer / settings-view / todo-view
             └─ 状态层：settings-store / conversation-store / todo-store（撤销栈）
                  └─ 服务层：sse（纯状态机）/ api / reminder ticker
                       └─ 基础设施：core / compat / storage / schema-chat / schema-todo / ui / icons / theme
```

- 加载顺序固定：`theme-boot`（阻塞防闪烁）→ polyfills → vendor → core/compat/icons/storage/ui/theme → 领域模块 → 组合根；全部经典 `<script defer>`。
- store 不碰 DOM、view 不碰存储/网络、service 不碰 DOM；数据流经 `NC.events` 单向传递。
- 存储：统一 `NC.storage`（try/catch、坏数据备份、配额降级、内存模式），所有键带版本；迁移前自动 `*.v1_backup` / `*.v2_backup`。
- 详见 [architecture.md](architecture.md)。

## 4. 安全修复对照（原 P0 清单）

| 原 P0 项 | 处置 |
|---|---|
| ntools Markdown 预览未净化 | 已加载 DOMPurify，`marked.parse → DOMPurify.sanitize`，E2E XSS 用例通过 |
| Todo 标题 XSS / ID 拼内联 onclick | 全量 `textContent` + `data-*` + 事件委托，无内联 onclick；导入任务恶意标题按纯文本显示 |
| Todo 顶层 `JSON.parse` 崩页 | 改 `NC.storage` 安全读取，坏数据备份 + 空文档恢复，不影响其它工具 |
| Todo/会话/配置导入零校验 | 统一 schema 校验 → 归一 → 预览 → 合并/替换；坏行进 quarantine；非法输入拒绝不落盘 |
| API Key 明文导出 | 导出默认剥离 `apiKey`，勾选包含需二次确认；导入后需重填 |
| `saveConversation` 配额/状态卡死 | `NC.storage` + 配额降级 + finalize 状态复位；E2E 验证停止后输入恢复 |
| DOMPurify 3.0.6 偏旧 | 升级至 **3.4.9**（SHA-256 见 THIRD_PARTY_NOTICES.md） |

## 5. Todo 专项交付

**P0（全部完成）**：新增 / 行内编辑 / 完成 / 软删除 + 5s 撤销 / 回收站 / 全部·今天·逾期·已完成筛选 / 搜索（标题+备注+标签，200ms 防抖）/ 排序（智能·截止·创建·手动）/ 快捷键（N、/、↑↓、Space、Enter、E、Del、Esc、Ctrl+Z/Shift+Z、Alt↑↓、?）/ 空状态多样化 / 计数徽标 / v1→v2 幂等迁移 / 导入导出（预览+合并/替换+自动备份+上限）/ 页内提醒 ticker（对齐分钟、隐藏暂停、标题角标、打开补报）/ 跨标签 storage 同步（revision 冲突提示）。

**P1（已实现）**：优先级、多清单（增删改/设默认/任务移动/计数）、标签、手动拖拽排序（键盘兜底）、统计概览、回收站视图、快捷键帮助面板。

**P2（按契约不做）**：重复任务、子任务编辑 UI（数据模型保留）、附件、加密。

性能实测（`tools/e2e.js`，无头 Chrome）：

| 场景 | 实测 |
|---|---|
| 500 条任务导入 + 首次渲染 | 28–38ms |
| 500 条列表 DOM 数量 | 500 |
| 500 条搜索响应 | 4–7ms |
| tick 刷新 | 只更新时间文本，不重建 DOM |

## 6. 设计系统与视觉

- **令牌**（`css/tokens.css`）：深色为默认（低饱和蓝紫、细边框、柔和阴影、径向光晕背景），浅色干净；`data-lite` 关闭毛玻璃与动画；`prefers-reduced-motion` 自动适配。
- **组件**（`css/components.css`，`nc-*` 前缀）：按钮 6 变体、输入/选择/开关、卡片/面板、徽标/标签/键帽、分段控件、空状态、加载/骨架、模态、Toast、菜单、进度条、列表进出场。
- **动效**：统一 120–260ms，仅 transform/opacity；列表项 fade-up、删除先淡出再移除、模态缩放淡入、Toast 上滑；Lite/reduce-motion 下瞬时完成。
- **页面**：nChat 宽屏卡片化 + 空状态欢迎（3 个建议胶囊）+ 消息气泡/思考折叠/流式光标/统计浮层；nTools 左侧 rail + 三栏待办（≤1100px 右栏抽屉、≤768px 单列、tab 与视图 chips 横向滚动）。
- **可访问性**：语义按钮、label/aria-label、`aria-expanded/labelledby/live`、模态焦点陷阱 + Esc + 焦点归位、`:focus-visible` 焦点环、视图切换与滚动的键盘路径；移除 `user-scalable=no`。

## 7. 兼容性结论（Chrome 102）

| 项 | 结论 |
|---|---|
| ES Module | `file://` 下被 CORS 阻断 → 全项目使用经典脚本 + IIFE（自检页只读检测，不做 import 探测） |
| localStorage | 可用；`file://` 全机共享同一存储域；异常/禁用时降级内存模式并提示 |
| 剪贴板 | `file://` 为安全上下文，`navigator.clipboard` 可用，保留 `execCommand` 兜底 |
| 通知 | `file://` 下权限被拒 → 只用页内提醒（页面关闭后不提醒，帮助面板明示） |
| API 请求 | `Origin: null` + OPTIONS 预检；网关需放行 `ACAO: *`、`authorization,content-type`、`POST,OPTIONS`，或使用内网 nginx 同源反代 |
| 字体 | 内置 CJK 字体栈（Noto Sans CJK SC / 思源黑体 / 文泉驿 / 微软雅黑），emoji 依赖系统 Noto Color Emoji |

现场验证步骤与 18 项 checklist 见 [compatibility.md](compatibility.md)。

## 8. 文件变更概览

- 重写：`index.html`、`ntools.html`、`js/app.js`、`README.md`
- 新增：`compat-check.html`、`tests.html`、`css/{tokens,base,components,chat,tools}.css`、26 个 JS 模块、`docs/{architecture,dev-contract,compatibility,v2-implementation-report}.md`、`tools/{verify,e2e,run-tests,screenshot.sh,check.sh}`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`img/tools.png`
- 升级：`js/purify.min.js` → 3.4.9
- 删除：`css/style.css`（被 tokens/base/components/chat 取代）、`tools/esm-probe.js`（不再需要）
- 更新：`img/main.png`（v2 界面截图）

## 9. 已知限制与后续建议

1. **关页提醒**：纯前端 + `file://` 无法做系统通知/后台，提醒仅页面打开时有效；如需系统级提醒，需另立"本地服务/桌面壳"项目。
2. **多标签同步**：采用 storage 事件 + revision 冲突提示，不做自动三方合并；极端并发下用户需手动刷新。
3. **拖拽排序**：桌面 HTML5 DnD；移动端用 Alt↑↓ 或切排序方式；未做长按拖拽手势。
4. **导入上限**：5MB / 5000 条；替换导入保留当前 settings；quarantine 暂不提供逐条编辑。
5. **聊天会话**：按配置隔离已实现；无"会话列表/多会话"管理（旧版单会话的演进，后续可加）。
6. **CSP**：`ntools`/`index` 仍有少量内联 style（组件初始态），未启用严格 CSP；当前以校验 + 净化 + 白名单为安全边界。
7. **依赖升级**：marked 15.0.12 与 qrcode.js 未升级；升级后需跑 `tests.html` + `tools/e2e.js` 回归。
8. **性能**：在 ARM 低配/软件渲染机器建议默认 Lite（首访会根据低配/减少动效自动开启）；真实目标机建议用 `compat-check.html` 复核帧率与字体。
