# nChat · nTools v2

> 本地优先的 AI 聊天前端 + 效率工具集。纯静态 HTML，双击即用，无需服务器、无需安装、数据只留在本机浏览器。
> 目标环境：国企内网 / 信创 ARM / 麒麟 Linux / 奇安信可信浏览器（Chromium 102 基线）。

![nChat](img/main.png)

![nTools 待办](img/tools.png)

## ✨ 这是什么

两个可独立打开的入口，共用一套设计系统与本地数据：

| 入口 | 用途 |
|---|---|
| `index.html` | **nChat**：OpenAI 兼容 AI 聊天（多配置、SSE 流式、思考过程、图片多模态、Token 统计、会话备份） |
| `ntools.html` | **nTools**：待办事项（重点）、二维码生成、Markdown 渲染、图片 Base64 转换、内嵌 nChat |

v2 相比 v1 的核心变化：全面重写为分层架构（经典脚本 + IIFE，无构建链）、消除已知 XSS/存储风险、Todo 升级为可日常使用（编辑/筛选/搜索/撤销/多清单/标签/提醒）、统一设计令牌与动效、补齐无障碍与响应式、加入自检与自动化验收。

## 🚀 快速开始

1. 下载整个文件夹（保持目录结构，建议 zip 解压后使用）。
2. **首次部署先打开 `compat-check.html`**：确认内核、存储、剪贴板、通知、网络等能力状态（约 30 秒）。
3. 双击 `index.html` 使用聊天，双击 `ntools.html` 使用工具集。

> 首次聊天需要配置一次：点击右上角 ⚙️ → 填写 Base URL / API Key / Model ID → 保存配置。
> 默认值已预置：`https://api.openai.com/v1`、`gpt-4o`；内网模型请替换为内网网关地址。

### 浏览器要求

- 奇安信可信浏览器（Chromium 102 基线），或 Chrome / Edge 等 Chromium 内核浏览器。
- **不支持 IE / 双核兼容模式 / ActiveX**；信创 ARM Linux 端只有 Chromium/Blink 内核。
- 不需要 Node.js、npm、构建工具或外网。

## 🧰 功能一览

### nChat（AI 聊天）

- 多配置管理：新建 / 切换 / 删除 / 导入导出，标题下拉快速切换；导出配置默认**不含 API Key**。
- 任意 OpenAI 兼容接口：`{Base URL}/chat/completions`，Bearer 鉴权，支持 `stream:true`。
- 流式输出：逐字渲染、思考过程（`reasoning_content` / `<think>`）折叠展示、停止生成保留已生成内容。
- 多模态：最多 5 张图片，自动压缩（最长边 1024 / JPEG 0.8），可预览、灯箱查看。
- 消息操作：复制 / 重新生成 / 编辑 / 删除；会截断后续消息的操作有确认与撤销。
- 会话：按配置独立保存、自动持久化、刷新恢复；JSON 备份 / 恢复；导出 Markdown。
- 性能统计：Prompt / Output / Total tokens、速率、耗时；缺失 usage 时估算并标注。
- 体验：深浅主题、Lite 模式、中文输入法 Enter 守卫、智能滚动（阅读时不强制回底）、Esc/焦点环/aria。

### nTools（效率工具）

- **待办事项**（三栏：视图 / 列表 / 详情抽屉）
  - 新增、行内编辑（双击标题或 `E`）、完成、软删除 + 5 秒撤销、回收站。
  - 筛选：全部 / 今天 / 逾期 / 已完成；搜索标题 / 备注 / 标签（200ms 防抖）；排序：智能 / 截止 / 创建 / 手动。
  - 优先级（低/普通/高/紧急）、多清单、标签、手动拖拽排序、统计概览。
  - 页内提醒：对齐分钟检查，页内 Toast + 标题角标 + 逾期计数；`document.hidden` 时暂停。
  - 导入导出：v1 数据幂等迁移、自动备份、预览后合并/替换、坏数据隔离；跨标签同步。
  - 深/浅主题、Lite 模式、键盘全流程（`N` 新建、`/` 搜索、`Space` 完成、`E` 编辑、`Del` 删除、`Ctrl+Z` 撤销、`?` 帮助）。
- **二维码**：文本/网址生成、尺寸选择、下载 PNG（超容量与失败有提示）。
- **Markdown**：实时预览（DOMPurify 净化）、导入/导出 `.md`、草稿自动保存、字数统计。
- **图片 Base64**：拖拽/选择图片、缩放、转 Base64、Base64 还原、复制结果。
- **内嵌 nChat**：工具页内直接聊天；若企业策略阻断 iframe，会提示单独打开。

## ⌨️ 快捷键

| 场景 | 按键 | 行为 |
|---|---|---|
| 聊天 | `Enter` | 发送（中文输入法选词时不误发） |
| 聊天 | `Shift + Enter` | 换行 |
| 聊天 | `Esc` | 关闭菜单 / 设置 / 弹窗 / 灯箱 / 统计浮层 |
| 待办 | `N` | 聚焦新建任务 |
| 待办 | `/` | 聚焦搜索 |
| 待办 | `↑` / `↓` | 列表内移动焦点 |
| 待办 | `Space` | 完成 / 取消完成当前任务 |
| 待办 | `Enter` | 打开当前任务详情 |
| 待办 | `E` | 编辑当前任务标题 |
| 待办 | `Delete` | 删除当前任务（进回收站，可撤销） |
| 待办 | `Ctrl + Z` / `Ctrl + Shift + Z` | 撤销 / 重做 |
| 待办 | `Alt + ↑` / `Alt + ↓` | 手动排序（sort = 手动） |
| 待办 | `?` | 快捷键帮助 |

## 📁 项目结构

```
nchat/
├─ index.html                 # nChat 入口（仅结构 + 按序脚本）
├─ ntools.html                # nTools 入口（5 个工具 tab）
├─ compat-check.html          # 兼容性自检（首次部署先跑）
├─ tests.html                 # 纯函数回归断言（双击即跑）
├─ css/
│  ├─ tokens.css              # 设计令牌（颜色/字体/间距/动效/主题/Lite）
│  ├─ base.css                # reset、排版、滚动条、焦点可见性
│  ├─ components.css          # 按钮/输入/模态/Toast/菜单等公共组件（nc-*）
│  ├─ chat.css                # nChat 样式
│  └─ tools.css               # nTools 样式
├─ js/
│  ├─ marked.min.js           # marked v15.0.12（Markdown 解析）
│  ├─ purify.min.js           # DOMPurify 3.4.9（XSS 净化）
│  ├─ qrcode.min.js           # 二维码生成
│  ├─ theme-boot.js           # 首屏主题引导（防闪烁，阻塞加载）
│  ├─ polyfills.js            # 最小兼容垫片
│  ├─ core.js                 # NC 命名空间 / 事件总线 / DOM / 日期工具
│  ├─ compat.js               # 运行时能力检测
│  ├─ storage.js              # 安全存储适配（异常/配额降级）
│  ├─ icons.js                # 内联 SVG 图标集
│  ├─ ui.js                   # 模态 / Toast / 菜单 / 焦点陷阱
│  ├─ theme.js                # 主题与 Lite 管理
│  ├─ schema-chat.js          # 聊天数据校验/归一化（纯函数）
│  ├─ schema-todo.js          # Todo 数据校验/迁移（纯函数）
│  ├─ settings-store.js       # 聊天配置状态
│  ├─ conversation-store.js   # 会话状态（按配置隔离）
│  ├─ sse.js                  # SSE 增量解析（纯状态机）
│  ├─ api.js                  # 请求构造 / 超时 / 错误映射
│  ├─ message-view.js         # 消息渲染
│  ├─ composer.js             # 输入区 / 图片压缩 / 停止
│  ├─ settings-view.js        # 设置面板 / 导入导出
│  ├─ chat-controller.js      # 聊天控制器（流式状态机）
│  ├─ app.js                  # nChat 组合根
│  ├─ todo-store.js           # Todo 状态 / 撤销栈 / 持久化
│  ├─ todo-view.js            # Todo 视图（keyed diff / 委托）
│  ├─ todo.js                 # Todo 功能入口（提醒/导入导出/快捷键）
│  ├─ ntools-app.js           # nTools 组合根（tab/主题/初始化）
│  ├─ qr.js / markdown.js / image.js  # 工具叶子模块
│  └─ theme.js
├─ img/
│  ├─ main.png                # nChat 界面截图
│  └─ tools.png               # nTools 待办界面截图
├─ docs/
│  ├─ architecture.md         # 架构、分层、存储键、事件
│  ├─ dev-contract.md         # 开发契约（接口/所有权/验收）
│  ├─ compatibility.md        # 兼容性结论与现场验证步骤
│  └─ refactor-and-optimization-plan.md  # v1 评估与改造方案（历史）
└─ tools/
   ├─ verify.js               # CDP 无头验收（页面错误 + DOM/迁移断言 + 截图）
   ├─ e2e.js                  # 关键交互 + mock SSE + 500 条性能
   ├─ screenshot.sh           # 批量截图
   ├─ run-tests.js            # 无头运行 tests.html
   └─ check.sh                # 一键验收（语法 + 页面 + E2E + 纯函数）
```

## 🔐 数据与隐私

- 所有数据保存在浏览器 `localStorage`，不上传任何服务器（只有你配置的 API 请求会发往你指定的地址）。
- 存储键：`nchat-settings`、`nchat-conversation.v2`、`nchat-theme`、`nchat-lite-mode`、`ntools.todo.v2`、`ntools_md`。
- 聊天导出配置默认**不含 API Key**；勾选包含时有二次确认。
- 升级/迁移前会自动备份原数据（`*.v1_backup` / `*.v2_backup`），不会静默删除。
- 共享电脑建议：用完后在设置中清除密钥/清除本地数据；`file://` 下本地页面共享同一存储域，这是 Chromium 的行为。
- 卡片式摘要：Todo 提醒仅在页面打开时有效；关闭浏览器后不会提醒（纯前端无后台，`file://` 下通知权限被拒）。

## 🔧 兼容性与部署

- **基线**：Chromium 102（奇安信可信浏览器公开内核时间线 83→132，实际版本以目标机为准）。
- **以 `file://` 双击运行为主**：不支持 ES Module、不能 fetch 本地资源，因此采用经典脚本 + IIFE；升级时直接覆盖文件夹即可（存储按源共享）。
- **内网 API 网关要求**（`file://` 请求会带 `Origin: null`，且 JSON + Authorization 触发 OPTIONS 预检）：
  - 允许 `Access-Control-Allow-Origin: *`（本应用跨源不带 Cookie，用 `*` 即可）；
  - 允许 `Access-Control-Allow-Headers: authorization, content-type`；
  - 允许 `Access-Control-Allow-Methods: POST, OPTIONS`；
  - 若网关不支持，可改用内网 nginx 同源静态托管/反向代理。
- **通知**：`file://` 下 Notification 权限被拒 → Todo 只用页内提醒；剪贴板在 `file://` 下可用（`isSecureContext`），仍保留 `execCommand` 兜底。
- **字体**：已内置 CJK 字体栈（Noto Sans CJK SC / 思源黑体 / 文泉驿 / 微软雅黑），无需外网字体。
- **Lite 模式**：低配/软渲染机器建议开启（禁用毛玻璃与动画）；系统开启"减少动效"时会自动适配。

## 🧪 开发与验收

- 无需构建：修改后直接刷新浏览器即可。
- 约定：经典 `<script>` + `window.NC` 命名空间，不引入框架/打包器/ES Module；用户数据一律 `textContent` 或 `DOMPurify`。
- 验收命令（需要本机有 Chrome for Testing，可用 `CHROME` 环境变量指定路径）：

```bash
# 1. 语法检查
for f in js/*.js; do node --check "$f"; done

# 2. 页面级验收（捕获 console/异常 + DOM/迁移断言 + 深/浅/移动截图）
node tools/verify.js

# 3. 交互 E2E（含 mock SSE 流式/停止、500 条待办性能）
node tools/e2e.js

# 4. 纯函数回归（双击即可）
open tests.html

# 5. 一键全量
bash tools/check.sh
```

页面自检与截图输出：

- `tests.html`：60 项断言，全绿显示「全部通过」。
- `compat-check.html`：内核/存储/剪贴板/通知/CSS 能力三态自检，可一键复制报告回传。
- 截图：`/tmp/nc-shots/`（`index-*`、`ntools-*`、`compat-check-*`、`tests-*`）。

## ❓ 常见问题

| 现象 | 排查 |
|---|---|
| 页面空白/按钮无反应 | 打开 `compat-check.html` 看内核与存储；确认 js/css 目录完整；`chrome://version` 记录内核版本 |
| 聊天报 "Failed to fetch" | 多半是 CORS：确认网关放行 `Origin: null` + OPTIONS，见上文 |
| 401 / 模型不存在 | 检查 Base URL 是否以 `/v1` 结尾、API Key、Model ID；错误消息会显示服务端返回内容 |
| 提示"存储不可用/仅内存" | 浏览器策略禁用了 localStorage；导出数据后联系管理员，或改用内网静态托管 |
| 待办提醒不弹系统通知 | `file://` 下通知被拒，设计上只用页内提醒 |
| 文字发虚/界面过小 | 麒麟显示缩放 125%/150% 下已适配；仍异常可反馈 `compat-check` 截图 |
| 升级后仍是旧界面 | 覆盖时确认文件已替换；`file://` 无强缓存，可关闭标签页重开或强制刷新 |

## 🗒️ v2 变更摘要

- 架构：单文件内联脚本 → 分层模块（core/storage/schema/store/service/view/组合根），经典脚本加载。
- 安全：修复 Todo/Markdown 存储型 XSS；导入/恢复全量校验；API Key 导出脱敏；DOMPurify 升级至 3.4.9。
- 稳定：存储异常/配额降级、SSE 解析健壮化、流式不再卡死输入区、导入前自动备份。
- Todo：编辑/筛选/搜索/排序/撤销/回收站/多清单/标签/提醒/统计/键盘/跨标签同步。
- 设计：统一设计令牌与组件、深浅主题、Lite、消息/列表动效、响应式、无障碍与焦点管理。
- 工程：`tests.html`、`compat-check.html`、`tools/verify.js`、`tools/e2e.js` 验收体系。

## 📄 许可

本项目采用 [MIT License](LICENSE) 开源。第三方依赖及其许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
