# 兼容性说明（执行版）

> 适用：nTools / nChat v2（纯静态、无构建链、经典脚本 IIFE）。目标环境：**奇安信可信浏览器（Chromium 102 基线）/ 麒麟 Linux / 信创 ARM / 内网 `file://` 双击运行**。
> 完整论证、证据与来源索引见 `docs/refactor-and-optimization-plan.md` 第 2 章（目标环境）与第 11 章（待现场验证清单）；本文件是给开发、实施、验收人员用的压缩版。
> 部署前**先双击运行 `compat-check.html`**，并把"复制报告"内容记入验收单。

## 1. 目标环境与硬约束

| # | 约束 | 对实现的硬性要求 |
|---|---|---|
| E1 | 纯静态、双击 `file://` 运行，无服务器 | 不用原生 ES Module、不用 fetch 读本地资源、不用 Service Worker；资源全部相对路径 |
| E2 | 无构建链、无包管理、无外网 | 不引入框架/构建工具/CDN/Web 字体；vendor 全部本地；写完即可双击运行 |
| E3 | 信创 ARM + 麒麟 Linux | 控制重渲染与动画；CJK 字体栈；HiDPI；默认可用 Lite 模式；避免高开销滤镜 |
| E4 | 基于 Chromium 的奇安信可信浏览器，实际内核未知 | 语法/API 取保守交集；新 API 必须特性检测 + 降级；上线前现场读内核 |
| E5 | 企业安全策略可能禁用 localStorage / 通知 / 剪贴板 / 下载 | 全部做能力检测与降级，绝不假设必然可用 |
| E6 | 无后端、无账号，数据仅在本机 | 数据自洽、可导出/导入；不承诺多端同步与关页提醒 |

## 2. 兼容基线

> "最低 Chromium"来自 MDN Browser Compat Data / caniuse；本项目按 **Chromium 102 基线**开发，所有新代码不得依赖下表"禁用"项。

| 特性 / API | 最低 Chromium | 本项目结论 |
|---|---|---|
| `?.`、`??` | 80 | **可用**（项目代码已用；<80 整页语法错误） |
| **`Array.prototype.at`** | **92** | **P0 垫片**：`marked v15` 内部依赖，<92 会 `TypeError`；已由 `js/polyfills.js` 在 vendor 前补齐 |
| `Object.hasOwn` / `structuredClone` | 93 / 98 | 不依赖（polyfill 有 `hasOwn`；`structuredClone` 不用） |
| `AbortController` | 66 | 可用（停止生成） |
| `fetch` / `Response.body` / `TextDecoder` | 42 / 43 / 38 | 可用；`response.body` 判空，缺失回退 `response.text()` |
| `ReadableStream` | 43 | 可用（SSE 流式） |
| `ResizeObserver` | 64 | 可用（已有 try/catch 降级） |
| `matchMedia` | 9 | 可用（主题/动效/Lite） |
| `localStorage` | 4 | 可用但受策略影响，**必须异常兜底**（`js/storage.js` 内存模式） |
| `IndexedDB` / `BroadcastChannel` | 24 / 54 | 可选；不可用时回退 `storage` 事件 |
| `Blob` / `URL.createObjectURL` / `a[download]` | 5 / 19 / 15 | 可用；吊销 ObjectURL 需异步（`NC.util.downloadBlob` 已处理） |
| `FileReader` / `File` / `canvas.toDataURL` | 6 / 13 / 2 | 可用（导入、二维码、Base64） |
| `navigator.clipboard` | 66（安全上下文） | `file://` 是安全上下文 → 可用；`http://内网IP` 不可用 → 走 `execCommand` 兜底 |
| `Notification` | 20（安全上下文 62） | **不可依赖**：`file://` 下 `requestPermission()` 实测 `denied`；提醒只做页内 |
| `crypto.randomUUID` / `crypto.subtle` | 92 / 37 | 不作为唯一方案；ID 用自定义 `uid()`；加密可选、必须检测 |
| CSS 变量 / Grid / `min()`/`clamp()` | 49 / 57 / 79 | 可用 |
| flex 容器 `gap` | 84 | 可用；若现场内核=83 需 margin 兜底 |
| `backdrop-filter` | 76 | 可用但 ARM/软渲染开销大：**Lite 模式关闭** |
| `:focus-visible` / `prefers-reduced-motion` | 86 / 74 | 可用；更老内核回退 |
| `:is()` / `:where()` | 88 | 谨慎使用（不用于关键布局/选择器） |
| `:has()` / 容器查询 / `dvh`/`svh`/`lvh` / `color-mix()` / `aspect-ratio` | 105 / 105 / 108 / 111 / 88 | **禁用**（项目不用；`aspect-ratio` 非必需也不引入） |
| `<dialog>` | 37 | 可用但不用（统一自研 modal 控制焦点） |

**结论**：
- 零改造可跑门槛 = **Chromium 92**（marked v15 的 `Array.prototype.at`），不是 86。
- 加 `js/polyfills.js` 后门槛 = **84**（flex gap）；若现场=83 再补 gap 兜底即可覆盖奇安信公开内核全区间。
- 新代码按 ES2017/2018 书写；所有较新能力集中在 `js/compat.js` 特性检测 + 降级；**禁止**在业务代码散落 `?.` 以外的实验性 API。

### 2.1 v3 新增能力（原生聊天 / 全局端点 / Todo AI / 快捷时间）

| 能力 | 实现与依赖 | 兼容性结论 |
|---|---|---|
| 全局模型端点 `NC.store.llm` | 存储键 `ntools.llm.v1`；首次启动迁移旧 `nchat-settings`（`{currentId,configs[]}`） | 仍走 localStorage；迁移幂等、失败不落盘；升级不丢旧配置 |
| 一次性模型调用 `NC.ai.complete` | 非流式 `POST {baseUrl}/chat/completions`（`stream:false`），`response.text()` 解析 | 不依赖 `ReadableStream`（比聊天流式门槛更低）；错误映射中文；`file://` 下仍受 CORS/Origin null 约束 |
| 设置面板 `NC.settingsPanel` | 右侧 Sheet `#settings-sheet`：模型端点 / Todo AI / 通用 / 数据 / 关于 | 纯 DOM + CSS 变量，无新 API；Esc/遮罩关闭、焦点陷阱 |
| 原生聊天嵌入 | `#page-nchat` 内 `#chat-app`（`js/chat-embed.js` 懒初始化），**不再用 iframe** | 消除 file:// iframe 跨源限制；流式仍用 fetch + ReadableStream |
| Todo AI 识别 | `NC.todoAi` → `NC.ai`；结果只填创建表单，**不自动创建** | 需至少 1 个可用端点；识别失败不写数据 |
| 快捷时间 `NC.todoTime` | 纯本地时间计算，读 `NC.store.llm.getWorkEndTime()` | 无网络/无新 API；下班时间默认 17:30，可改（影响下班前/明天前/周五前/月底前） |

> 自动化验收：`tools/e2e-features.js`（设置面板 / 原生聊天 / Todo AI / 快捷时间，mock fetch 不联网）+ `tools/shots-v3.sh`（v3 功能截图）。

## 3. 奇安信可信浏览器内核

官方"先锋版"公开时间线（来源见 §10）：

| 时间 | 内核 | 时间 | 内核 |
|---|---|---|---|
| 2020-07 | 83 | 2022-05 | 102 |
| 2020-09 | 87 | 2023-01 | 110 |
| 2020-11 | 89 | 2024-12 | 132 |
| 2021-01 | 90 | — | — |
| 2021-10 | 97 | — | — |

- **已查证**：时间线来自奇安信官方新闻/公众号；麒麟/统信商店曾上架 110、132；申威平台官方表述"Chromium 90 以上"。
- **未查证/推断**：国企实际安装的"专业版/标准版/企业版"与先锋版内核**无公开对照表**，正式版通常滞后。因此**不能由公开资料推定现场版本**，必须现场读取 `chrome://version`。
- **支持目标**：下限 83、完整功能推荐 92、最可能现场 97/102/110；132 需回归验证。
- 内核 <92 时 `compat-check.html` 会显示"降级"并提示 polyfill 已生效；<84 时 flex gap 检测为降级。

## 4. `file://` 限制与对策

> 以下"实测"基于 macOS Chromium 150 headless（机制与奇安信同源），**仍需目标机复测**。

| 限制 | 结论 | 对策 / 验证 |
|---|---|---|
| 原生 ES Module | **必然失败**（CORS）。实测报错：`Access to script at 'file:///…' from origin 'null' has been blocked by CORS policy: Cross origin requests are only supported for protocol schemes: chrome, chrome-extension, …` | 全部经典 `<script src>` + IIFE；自检页以信息态说明（首屏不做 import 探测，避免控制台噪声）；禁止引入 ESM/打包器 |
| 本地 `fetch()` 读 JSON/JS | 失败（同 CORS） | 校验规则写成 JS 常量；备份/导入用 `<input type=file>` + FileReader |
| `localStorage` | 可用；**Chromium 把所有本地 HTML 视为同一 origin `file://`，全机共享一份存储**（实测跨目录、index/ntools 共享）。策略禁用/退出清理会抛异常或清空 | 全部读写走 `NC.storage`（try/catch + 内存模式）；自检页写 marker，"重启后再开"验证持久性 |
| 请求内网 API | 能发，但带 `Origin: null`（实测 OPTIONS 与 POST 均为 `null`）；`POST+JSON+Authorization` 触发 OPTIONS 预检；`file:// → http://` **不受**混合内容拦截 | 网关放行 `Access-Control-Allow-Origin: *`（不带 Cookie 即可）或 `null`，允许 `POST, OPTIONS` 与 `authorization, content-type`；不能改网关则 nginx 同源反代 `/api` |
| 页面改由 nginx **https** 托管 | 页面为安全上下文；但 API 若是 `http://` 会被混合内容拦截；`http://内网IP` 托管则页面非安全上下文 | 统一 https 或同源反代；`http` 内网 IP 部署会失去 clipboard/crypto.subtle |
| 剪贴板 | `file://` 是安全上下文，用户手势下 `writeText` 可用；`http://内网IP` 不可用；BDLP 策略可禁复制；iframe 内需 Permissions-Policy 委派 | `clipboard.writeText → execCommand 兜底 → 弹窗手动复制`；自检页"测试复制"实测 |
| 通知 | `file://` 下 `requestPermission()` 实测 `denied`；无 Service Worker/后台 | 只做页内提醒（toast + 标题 + 角标），明示"关闭页面后不提醒" |
| iframe / 原生嵌入 | **v3 起 nChat 原生嵌入 `ntools.html#page-nchat`（无 iframe）**，消除 file:// iframe 跨源限制；`index.html` 改为跳转页；`compat-check.html` 内部仍有 iframe 自检探测 | 工具页不再依赖 iframe；旧版本仍按 v2 结论（可显示、父页不可控） |
| Blob 下载 | 可用（实测 `blob:null` + `a[download]` 落盘）；同步 `revokeObjectURL` 可能取消下载；企业下载策略可能弹窗/拦截 | `NC.util.downloadBlob`：append → click → 延迟吊销；导出失败提供文本框手动复制 |
| 资源缓存 | `file://` 无 HTTP 缓存，覆盖文件即生效；nginx 托管需 `Cache-Control: no-cache` | 发布包带版本号；js/css 用 `?v=`；禁止强缓存 `index.html`；不引入 SW |
| 国密 SSL（SM2） | 若内网 API 走国密证书，普通 Chrome/Edge 测试机可能连不通，仅奇安信可通过 | 验收必须用奇安信实机；开发机与目标机分工验证 |
| IE 内核 / ActiveX | 信创 ARM Linux 端只有 Chromium/Blink，**没有 IE 双核** | 不引入 ActiveX/IE 专用写法 |

## 5. 部署形态

1. **首选（必须保证）**：U 盘/共享盘拷贝文件夹 → 双击 `ntools.html`（v3 统一入口；`index.html` 仅做跳转页兼容旧链接）。`file://` 下 localStorage 全机共享，**换目录/升级覆盖不丢数据**（实测），v3 升级会自动迁移旧的 `nchat-settings`。
2. **备选（需现场验证）**：内网 nginx 纯静态托管（无后端逻辑）。好处：消除 Origin/CORS、iframe、缓存的大部分限制；注意安全上下文与混合内容（见 §4）。若启用 CSP，`script-src 'self'` 即可（本项目无内联脚本/内联事件；`compat-check.html` 含内联脚本，如需纳管可单独排除或加 hash）。
3. **不建议**：Electron/Tauri 桌面壳（引入构建链与运维成本，超出"纯 HTML 小程序"定位）。

## 6. 麒麟 Linux + ARM 实操

- **中文字体**：令牌已含 `"Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei"` 回退；现场 `fc-list :lang=zh` 确认。emoji（💬👤🤖）依赖 Noto Color Emoji，缺失时显示豆腐块 → 用文字标签降级。
- **HiDPI**：控制中心→显示→缩放 100/125/150/200%（或 `gsettings`）。Chromium/GTK 混合缩放易出现 1px 边框发虚、图标错位 → 以 125%/150% 实机截图验收，避免用固定 px 的细描边。
- **性能（最关键）**：飞腾/鲲鹏/景嘉微等国产 GPU 驱动参差，常见默认关硬件加速/退软渲染。`backdrop-filter`（毛玻璃）、大面积模糊、无限全屏渐变动画是主要卡顿源 → **低配默认 Lite**（`NC.compat.bootstrap()` 依据 `hardwareConcurrency ≤ 4`/reduced-motion 建议；`theme.js` 已支持记忆）；验收看 `chrome://gpu` 的 Compositing/Rasterization 是否 Hardware accelerated + 滚动帧率。
- **输入法/快捷键**：麒麟用 fcitx5/ibus；Ctrl+Space 切换。中文选词 Enter 不能触发发送（统一 `e.isComposing || e.keyCode === 229` 守卫，`composer.js` 已实现）。奇安信有鼠标手势/超级拖拽/自定义快捷键，可能抢事件或与"禁止复制"策略冲突 → 现场实测。
- **下载/文件**：默认 `~/下载`（中文 locale）或 `~/Downloads`；企业策略可禁用下载/上传，QAX 杀毒会扫描下载产物；导出失败要有手动复制兜底。
- **双击关联**：麒麟默认 `.html` 打开程序可能不是奇安信 → `xdg-mime query default text/html` 检查，必要时右键"打开方式"或设默认。
- **离线**：项目零外网依赖（无 CDN/Web 字体/远程图标；SVG 内联、data URI），断网可用；仅 API URL 需内网可达。

## 7. 自检页使用（`compat-check.html`）

1. 双击打开（或托管访问）；等待"检测中"全部完成。
2. 看**汇总**：通过 / 降级 / 不可用计数；「阻塞项」非空即不可部署；「推荐模式」给出是否默认 Lite。
3. 看**运行环境**：UA、内核（与 `chrome://version` 核对）、协议/Origin、安全上下文、窗口/DPR、CPU/存储状态、检测时间。
4. 看**分组检测**：运行时与语法、本地存储、安全上下文与剪贴板、通知、网络、iframe/下载、CSS、性能。状态含义：**通过 / 降级（可用但有损）/ 不可用（阻塞）/ 信息（记录项，如 ESM 说明）**。
5. **交互自测**：点"测试复制""测试下载"，填内网 API 地址点"测试"（验证 CORS）；观察实际结果（受企业策略影响）。
6. **持久化**：首次运行写入 marker；**关闭浏览器重开本页**，显示"上次运行 X 分钟前"= 持久化正常；回到首次写入 = 策略退出清理。
7. 点**复制报告**（失败时自动弹出手动复制窗口），粘贴到验收记录/回传开发。
8. 页面 `?embed=1` 是被 iframe 探测用的精简模式；正常使用不要加参数。
9. **ES Module 说明**：项目统一经典脚本；`file://` 下本地 ES Module 会被 CORS 阻止（已查证）。为保持控制台零噪声，本页**首屏不做 import 探测**，该项以信息态说明设计即可；如需人工验证，见 §4 表格。

> 配套：`tests.html` 是纯函数回归断言页（60 项，覆盖 `core.util` / `storage` / `schema.todo` / `schema.chat` / `sse` / `api`），双击即跑、缺模块自动跳过；**每次发版前必跑**，通过时标题显示「TESTS PASS」。

## 8. 现场验收清单（压缩版，逐项打勾）

| # | 项目 | 方法 | 通过标准 |
|---|---|---|---|
| V1 | 内核版本 | `chrome://version` + 自检页 | 记录内核号；<92 时确认自检页 Markdown 正常（polyfill 生效） |
| V2 | 双击运行 | 文件管理器双击 `ntools.html`（或 `index.html` 跳转） | 正常打开、无白屏、控制台无红色报错 |
| V3 | 存储持久 | 保存配置/对话 → 刷新 → 重启浏览器再读 | 数据仍在；自检页 marker 显示"上次运行" |
| V4 | 存储被禁降级 | 观察自检页存储项；只看不写 | 显示"内存模式"时不白屏，导出可用 |
| V5 | API CORS | 自检页填 `/health` 测试；发一条消息 | HTTP 有响应（401/403 也算 CORS 通过）；流式逐字出现 |
| V6 | 剪贴板 | 自检页"测试复制" + 消息复制按钮 | 粘贴内容正确；失败有手动兜底 |
| V7 | 下载 | 自检页"测试下载" + 导出配置/对话 | 文件落在下载目录、文件名正确、可再次导入 |
| V8 | 通知 | 自检页显示 `Notification.permission` | 不依赖系统通知；页内提醒正常 |
| V9 | 原生聊天 | ntools → nChat tab | 无 iframe；面板可聊天；无端点/缺 Key 时有"打开设置"引导 |
| V10 | Markdown/XSS | 在 Markdown 工具输入 `<img src=x onerror=alert(1)>` | 不执行脚本；预览正常 |
| V11 | 中文输入法 | 拼音选词时按 Enter | 只上屏、不发送；Shift+Enter 换行 |
| V12 | 主题/Lite | 切换深浅色/Lite，刷新/重启 | 记忆正确；Lite 下毛玻璃与动画关闭 |
| V13 | HiDPI | 125%/150% 缩放 | 布局不溢出、按钮可点、无发虚断层 |
| V14 | 性能 | 滚动长列表/长对话；`chrome://gpu` | 无明显卡顿；软渲染时默认 Lite |
| V15 | 离线 | 断网后双击页面 | 页面可打开（仅 API 不可用） |
| V16 | 升级 | 换新版本目录覆盖后打开 | `NC.version` 更新；旧配置/数据仍在；无旧文件残留问题 |
| V17 | 管控策略 | 对照 QAX 策略：复制/下载/开发者工具/退出清数据 | 逐项记录；被禁项有降级路径 |
| V18 | 国密/证书 | 用 QAX 与普通 Chrome 对照请求内网 API | 记录是否国密 SSL/自签 CA；仅 QAX 通时以 QAX 为验收机 |
| V19 | 全局端点 | 设置 → 模型端点：新增/编辑/删除/设为当前；刷新页面 | 端点持久化；聊天端点下拉同步；旧 `nchat-settings` 迁移到 `ntools.llm.v1` |
| V20 | 原生聊天行为 | 发送消息、停止生成、切换端点后各发一条 | 流式逐字；停止保留内容；会话/系统提示词按端点隔离；payload 含当前端点 system 消息 |
| V21 | Todo AI | 配置可用端点后，待办页「AI 识别」粘贴邮件 → 识别 | 填充标题/详情/截止/优先级/标签；**不自动创建**；编辑后手动创建成功 |
| V22 | 快捷时间 | 创建面板点 6 个 chips；设置改下班时间后重测「下班前/明天前/周五前/月底前」 | 填入时间符合规则；改下班时间后重新计算生效 |
| V23 | v3 自动化 | `node tools/e2e-features.js`；`tools/shots-v3.sh` | E2E 全绿且无 console.error；截图输出 `/tmp/nc-shots-v3/` |

> 未验证项不得对外宣称"已支持"；验收结果回填本表与 `compat-check.html` 报告。

## 9. 已知限制与责任边界

- 无 Service Worker/后台：关页后不能提醒、不能后台同步。
- `file://` 下 `localStorage` 全机共享：同一台电脑不同目录版本共用数据（升级不丢数据，但也意味着回退版本会看到新数据）；不支持多端同步。
- 企业 BDLP/管控策略可禁用复制、下载、开发者工具、存储：本方案只保证"检测 + 降级 + 可导出"，不保证绕过策略。
- 通知仅页内；加密/多账号/云备份不在范围内（见方案第 10 章）。

## 10. 参考来源

- 奇安信内核时间线（官方）：83 `https://www.qianxin.com/news/detail?news_id=328`、87 `?news_id=664`、89 `?news_id=789`、90 `?news_id=889`、97 `?news_id=2504`、102 `?news_id=4995`、申威 90+ `?news_id=4023`、110/132（官方公众号，见方案附录 E）。
- 产品能力（BDLP 可禁复制/下载/打印、双核与远程渲染、信创 CPU/OS 适配）：`https://www.qianxin.com/product/detail/pid/468`。
- MDN：CORS 非 HTTP 请求 `https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSRequestNotHttp`；`Access-Control-Allow-Origin`（null 语义）`https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Origin`；Clipboard API（安全上下文/iframe Permissions-Policy）`https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API`。
- Chromium 源码：file 源可信（`security_origin.cc`）、混合内容仅对 https 源生效（`scheme_registry.cc`），见方案附录 E。
- MDN BCD / caniuse：`Array.json`、`gap.json`、`backdrop-filter.json`、`ResizeObserver.json`、`Crypto.json`、`Clipboard.json`、`Notification.json`；`caniuse.com/flexbox-gap`、`caniuse.com/css-grid`、`caniuse.com/fetch`。
