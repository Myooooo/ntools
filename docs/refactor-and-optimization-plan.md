# nChat / nTools 重构与功能优化方案

> **版本**：v1.0（评估稿，仅方案，不含代码改动）
> **日期**：2026-11-12
> **基线**：`main` @ `30858e0`（工作区干净）
> **目标环境**：国企内网 / 信创 ARM 电脑 / 麒麟 Linux（Kylin）/ 奇安信可信浏览器（Chromium 内核）/ 纯 HTML、无后端、无构建链
> **文档范围**：全面评估 + 重构方案 + 功能优化方案，**TodoList 为重点专项**
> **实施状态（2026-11-12）**：本方案已按计划执行完成，交付验收见 [v2-implementation-report.md](v2-implementation-report.md)。本文档保留为评估与决策记录。

---

## 目录

- [0. 结论摘要](#0-结论摘要)
- [1. 项目现状评估](#1-项目现状评估)
- [2. 目标环境与硬约束](#2-目标环境与硬约束)
- [3. 问题清单（带证据）](#3-问题清单带证据)
- [4. 总体重构方案](#4-总体重构方案)
- [5. TodoList 专项改造方案（重点）](#5-todolist-专项改造方案重点)
- [6. nChat 与其他模块优化](#6-nchat-与其他模块优化)
- [7. 实施路线图与人天估算](#7-实施路线图与人天估算)
- [8. 测试与验收策略](#8-测试与验收策略)
- [9. 风险与缓解](#9-风险与缓解)
- [10. 范围边界（明确不做什么）](#10-范围边界明确不做什么)
- [11. 待现场验证清单](#11-待现场验证清单)
- [12. 附录](#12-附录)

---

## 0. 结论摘要

### 0.1 一句话判断

**不建议推倒重写。** 项目"功能密度高、部署形态正确、用户体验有亮点"，问题是典型的"单页原型长期迭代成产品"留下的工程债：无模块边界、外部数据不设防、存储假设过于乐观、错误处理薄弱。正确路线是**冻结行为契约 → 剥离基础设施四层 → Todo 专项重构 → 逐步迁移聊天模块**，每个阶段结束都保持"双击就能用"。

### 0.2 五个最关键的结论

1. **存在必须先修的安全与数据风险（P0，上线/分享前必须完成）**
   - `ntools.html:660` 的 Markdown 预览未加载 DOMPurify，直接 `innerHTML = marked.parse(...)`；`ntools.html:567/561/572` 待办标题、ID 未转义直接拼 HTML/JS。
   - 在 Chromium 的 `file://` 下，**同一台机器的本地页面共享同一份 localStorage**（本机 Chromium 实测，目标机复核）。这意味着任一处本地 XSS 都能读取 `nchat-settings` 里的 **API Key** 和全部对话，风险从"自己弹个窗"升级为**凭据与隐私泄露**。
   - 导入/恢复 JSON（`app.js:1017`、`ntools.html:594`）零校验直接落盘；一个坏导入可以让页面**每次刷新都崩溃**，且无备份、无撤销。
   - `ntools.html:459` 顶层无保护 `JSON.parse`：localStorage 里一个坏字符就会让整个内联脚本中断，**5 个工具全部失效**。
   - 依赖库 DOMPurify 3.0.6 偏旧（受 CVE-2024-47875 等影响），建议升级。
2. **TodoList 是"能跑但不好用"的半成品**
   - 不能编辑任何任务（标题/详情/截止时间只能删除重建）；无筛选、无搜索、无排序控制、无撤销；不设截止时间就无法新增任务。
   - 每 60 秒全量 `innerHTML` 重建列表：滚动位置丢失、选中丢失、后台标签页也在空转，ARM 低配机上可感知卡顿。
   - 数据模型只有 5 个字段（`id/title/content/due/completed`），没有优先级、标签、子任务、创建/完成时间、排序位，后续功能全部无从下手。
   - 渲染用字符串模板拼接，待办标题可被导入数据注入 XSS；ID 无引号拼进内联 `onclick`，导入字符串 ID 后点击即报错。
3. **兼容性必须"保守设计 + 现场验证"**
   - 硬约束：必须支持 **双击 HTML 以 `file://` 运行**。因此**不能使用原生 ES Module**（file:// 下被 CORS 拒绝，已实测）、不能用 fetch 读本地 JSON/脚本、不能引入框架、不能依赖 CDN/外网。
   - **关键发现（已查证/实测）**：奇安信可信浏览器公开内核时间线为 **Chromium 83 → 87 → 89 → 90 → 97 → 102 → 110 → 132**（2020–07 至 2024–12），实际安装版本不可由公开资料推定，**必须现场 `chrome://version` 确认**。
   - **比 `?.`/`??` 更硬的门槛是 Chromium 92**：本地 `marked v15.0.12` 内部使用 `Array.prototype.at`，**内核 <92 时 `marked.parse` 直接抛 TypeError，聊天正文渲染全挂**（已实测）；而项目自身使用的 `?.`/`??` 只需 Chromium 80、flex `gap` 只需 84。
   - **对策（P0，约 30 分钟）**：在 `vendor/marked.min.js` 之前加载一个经典脚本 `js/polyfills.js` 补齐 `Array.prototype.at`/`String.prototype.at`，把有效门槛降回 80–84；若现场内核为 83，再补 flex `gap` 的 margin 兜底（约 0.5 人天）。不引入转译链、不降级 marked 大版本（除非 polyfill 验证失败，备选回退 marked v4/v9 的 ES5 构建）。
   - **上线第一阻塞项**：`file://` 页面请求内网 API 时浏览器发送 `Origin: null`，且 `Authorization` + JSON 会触发 OPTIONS 预检。网关必须放行 `Access-Control-Allow-Origin: *`（本应用跨源不带 Cookie，用 `*` 即可）并允许 `authorization, content-type` 与 `POST, OPTIONS`，否则聊天功能整体不可用（详见 2.3 / 11）。
4. **重构不是"重写一遍"，而是"分层 + 补契约"**
   - 目标结构：`core / storage / schema+store / service(sse,api) / view / 组合根`；store 不碰 DOM，view 不碰存储，service 不碰 DOM，`app.js` 变成 <150 行的组合根。
   - 所有用户与外部数据走 `createElement + textContent` 或 `DOMPurify`；导入一律"校验→归一→预览→提交"。
   - 新增 `tests.html`（双击可跑的断言页）覆盖纯函数：迁移器、导入校验、SSE 解析、工具函数。
5. **投入产出**
   - 完整方案约 **15.5 人天**（单人），2 人并行约 **8–9 天**；其中"安全热修 + Todo 可用版"最小集约 **6–7 人天**。
   - 收益：消除 P0 风险；Todo 从"记事"升级为"可日常使用"；聊天模块获得可维护边界与更稳的流式/持久化；后续新功能成本显著下降。

### 0.3 建议的执行顺序（详见第 7 章）

```
Phase 0 安全与稳定性热修（1.5d，含兼容垫片）
   └→ Phase 1 基础设施与契约冻结（2d）
        └→ Phase 2 Todo 数据层 + 渲染重构（2.5d）
             └→ Phase 3 Todo P0 功能（2.5d）
                  ├→ Phase 4 Todo P1 + 视觉统一（2.5d）
                  └→ Phase 5 nChat 分层重构（3d）
                       └→ Phase 6 回归、目标环境验收、文档（1.5d）
```

---

## 1. 项目现状评估

### 1.1 运行形态与代码构成

| 入口 | 职责 | 规模 | 依赖 | 存储 |
|---|---|---|---|---|
| `index.html` | AI 聊天前端（OpenAI 兼容、SSE 流式、多配置、图片、思考过程、统计、备份） | HTML 169 行 + `js/app.js` 1082 行 + `css/style.css` 1442 行 | marked 15.0.12、DOMPurify 3.0.6（均本地） | `nchat-settings`、`nchat-conversation`、`nchat-theme`、`nchat-lite-mode` |
| `ntools.html` | 工具集：待办 / 二维码 / Markdown 渲染 / 图片 Base64 / 内嵌 nChat（iframe） | HTML 804 行，其中**内联 CSS ≈190 行、内联 JS ≈420 行** | marked、qrcode.js（**缺 DOMPurify**） | `ntools_todo`、`ntools_md` |

- 部署方式：下载文件夹后双击 `index.html` / `ntools.html`，以 `file://` 协议运行；无服务器、无安装、无外网。
- 工程化：**无** `package.json` / 构建脚本 / lint / 测试 / CI / `LICENSE` 文件（README 声明 MIT）。
- 第三方库全部本地化（marked 40KB、DOMPurify 24KB、qrcode 20KB），符合内网离线要求，这一点值得保持。

### 1.2 代码度量（自有代码）

| 指标 | 数值 | 说明 |
|---|---|---|
| 自有 JS | ≈1502 行 | `app.js` 1082 + `ntools.html` 内联 ≈420 |
| 自有 CSS | ≈1632 行 | `style.css` 1442 + `ntools.html` 内联 ≈190 |
| HTML 结构 | ≈970 行 | 两个入口 + 模态框 |
| `innerHTML` 使用 | 31 处 | `app.js` 25 + `ntools.html` 6；其中约 10 处承载动态数据 |
| 内联事件 `onclick=` | 22 处 | 全部在 `ntools.html`，依赖全局对象 |
| 内联 `style=` | 30 处 | 全部在 `ntools.html` |
| `addEventListener` | 36 处 | `app.js` 32 + `ntools.html` 4 |
| `aria-*` / `role=` | **0 处** | 无障碍完全缺失 |
| 全局可调用对象/函数 | 7 个 | `nModal`、`switchTab`、`todo`、`qrTool`、`mdTool`、`imgTool`、`dropzone` |
| 最长函数 | 232 行 | `fetchAssistantResponse`（`app.js:689–920`），混合请求/解析/渲染/统计/存储 |
| 重复实现 | ≥7 组 | 统计详情按钮、配置列表渲染、下拉菜单、模态、主题/Lite、字段映射等 |
| 设计令牌 | 2 套 | `style.css:1–21` 与 `ntools.html:13–27`，色值不一致（如主色 `#0071e3` vs `#2f81f7`） |
| 测试 / Lint / CI | 0 / 0 / 0 | 所有改动只能靠手工点测回归 |

### 1.3 做得好的地方（重构中必须保留）

1. **部署形态正确**：零依赖、零安装、离线可用，完全适配内网信创环境。
2. **隐私模型正确**：数据只进浏览器本地存储，不发第三方；README 有隐私承诺（但需与"导出含密钥"对齐，见 3.4）。
3. **功能密度高**：多 API 配置、图片多模态、思考过程（reasoning + `<think>` 标签）、Token 统计、会话备份/恢复、深浅主题、Lite 模式、Markdown 安全渲染（聊天侧）——对一个小工具而言完成度相当高。
4. **已有关键工程直觉**：Lite 模式（低性能设备）、resize 自适应输入区、错误消息、图片压缩、DOMPurify（聊天侧）、`execCommand` 复制兜底等，说明作者已有性能与兼容意识。
5. **中文语境与文档**：README 完整、界面全中文，直接可用。

### 1.4 评估记分卡

| 维度 | 评分 | 说明 |
|---|---|---|
| 功能完整度 | 7.5 / 10 | 核心场景齐全；缺编辑、筛选、搜索、撤销、提醒、多会话 |
| 可维护性 | 3.5 / 10 | 巨石闭包、内联脚本、重复实现、无测试 |
| 安全性 | 3.0 / 10 | 两处存储型 XSS、导入零校验、密钥明文导出、依赖偏旧；聊天侧有 DOMPurify 是加分项 |
| 稳定性/容错 | 3.5 / 10 | 存储读写无保护、错误吞噬、流式边界漏洞；正常路径可用 |
| 性能 | 6.0 / 10 | 正常聊天可接受；`O(n²)` 流式重渲染、每消息全量落盘、60s 全量重渲染是短板 |
| 兼容性 | 5.0 / 10（未验证） | 无构建、无 CDN 方向正确；内核版本、CORS、通知/剪贴板均未验证 |
| 可测试性 | 1.5 / 10 | 零测试，业务逻辑全部闭包内不可测 |
| 文档 | 6.5 / 10 | README 完整但部分表述过时/与实现冲突；无架构文档、无兼容性说明 |
| 部署友好度 | 9.0 / 10 | 双击即用；仅需注意 CORS 与浏览器版本 |

### 1.5 核心判断

> 这是"单页原型长期迭代到产品"的典型形态：用户可感知价值高，但边界模糊、错误处理薄弱、存储假设乐观。**不建议重写**——重写会丢大量已被验证的交互细节（思考过程、统计、图片压缩、备份格式、主题/Lite 等），且无法解决根因。建议"契约冻结 + 分层剥离 + 小步提交"，先做安全与存储，再做 Todo 专项，最后把聊天模块搬进同一套基础设施。

---

## 2. 目标环境与硬约束

### 2.1 约束清单

| # | 约束 | 对方案的硬性要求 |
|---|---|---|
| E1 | 纯静态、双击 `file://` 运行，无服务器 | 不用原生 ES Module、不用 fetch 读本地资源、不用 Service Worker；资源全相对路径 |
| E2 | 无构建链、无包管理、无外网 | 不引入框架/构建工具/CDN/Web 字体；vendor 全部本地；新增代码必须"写完即可运行" |
| E3 | 内网信创 ARM + 麒麟 Linux | 控制重渲染与动画；CJK 字体栈；HiDPI 适配；Lite 模式可用；避免高开销滤镜 |
| E4 | 基于 Chromium 的奇安信可信浏览器，公开内核时间线 83–132，实际安装版本未知 | 语法/API 取保守交集；**`marked v15` 实际要求 Chromium 92，必须加 `Array.prototype.at` polyfill**；新 API 必须特性检测 + 降级；上线前现场确认内核 |
| E5 | 企业安全策略可能禁用 localStorage / 通知 / 剪贴板 / 下载 | 所有相关能力做能力检测与降级，绝不假设一定可用 |
| E6 | 无后端、无账号体系，数据在本机 | 数据模型必须自洽、可导出/导入；不承诺多端同步、关页提醒、云端备份 |

### 2.2 兼容基线（保守交集，现场确认后可放宽）

> 说明：以下"最低 Chromium"取自 MDN Browser Compat Data / caniuse 的公开数据；奇安信内核时间线见 2.5，**实际安装版本必须现场确认**。本方案按"加 polyfill 后覆盖 83+；完整功能建议 92+"设计。

| 特性/语法 | 最低 Chromium | 本项目结论 |
|---|---|---|
| `?.` 可选链、`??` 空值合并 | 80 | 当前 `app.js` 已用（8 + 4 处），<80 会**整页语法错误** |
| **`Array.prototype.at`** | **92** | **P0 兼容垫片**：`marked v15` 内部依赖，<92 时 `marked.parse` 抛 TypeError（实测），聊天正文渲染全挂；必须在 vendor 前 polyfill |
| `String.prototype.at` | 92 | 同批 polyfill（成本极低） |
| `AbortController` | 66 | 可用 |
| `fetch` / `Response.body` / `TextDecoder` | 42 / 43 / 38 | 可用；`response.body` 判空，缺失时回退 `response.text()` |
| `ResizeObserver` | 64 | 可用（已有 try/catch 降级） |
| `matchMedia` | 9 | 可用 |
| `localStorage` | 4 | 可用性受策略影响，**必须异常兜底** |
| `IndexedDB` | 24 | 可用（二期使用，仍做降级） |
| `BroadcastChannel` | 54 | 可用性待现场验证（多标签同步备选） |
| `Blob` / `URL.createObjectURL` / `a.download` | 5 / 19 / 15 | 可用（下载吊销需异步，见 2.3） |
| `FileReader` / `File` / `canvas.toDataURL` | 6 / 13 / 2 | 可用 |
| `crypto.randomUUID` | 92 | **不可依赖**，使用自定义 `uid()` 兜底 |
| `crypto.subtle`（AES-GCM） | 37（需安全上下文） | `file://` 实测为安全上下文，可作为可选加密；仍做特性检测 |
| `navigator.clipboard` | 66（需安全上下文） | `file://` 实测 `isSecureContext=true`、用户手势下 `writeText` 可用；`http://内网IP` 托管时不可用 → 保留 `execCommand` 兜底 |
| `Notification` | 20（安全上下文 62） | **`file://` 下 `requestPermission()` 实测返回 `denied`**，按不可用设计，只做页内提醒 |
| CSS 变量 / Grid / `min()`/`clamp()` | 49 / 57 / 79 | 可用 |
| `flex` 容器 `gap` | 84 | 可用；若现场内核 83，需 margin 兜底（约 0.5 人天） |
| `backdrop-filter` | 76 | 可用但 ARM/软件渲染开销大，Lite 模式关闭 |
| `:focus-visible` | 86 | 可用；更老内核用 `:focus` 兜底 |
| `prefers-reduced-motion` | 74 | 可用 |
| `:is()` / `:where()` | 88 | 谨慎使用 |
| `:has()` | 105 | **禁用** |
| `dvh` / `svh` / `lvh` | 108 | **禁用**，用 `100vh` + JS 变量兜底 |
| 容器查询 / `aspect-ratio` / `color-mix()` | 105 / 88 / 111 | **禁用**（`aspect-ratio` 可用但非必需） |
| `structuredClone` / `Object.hasOwn` | 98 / 93 | **禁用**或手写替代 |
| `<dialog>` | 37 | 可用但非必需（统一用自研 modal 控制焦点更稳） |

**结论**：
- **零改造可跑门槛 = Chromium 92**（不是 86！因为 marked v15 依赖 `Array.prototype.at`）。
- **加 polyfill 后门槛 = 84**（flex gap）；若现场为 83，再补 gap 兜底即可覆盖奇安信公开时间线全区间。
- 新代码统一按 **ES2017/2018** 写，不引入上表"禁用"项；所有较新能力集中在 `core/compat.js` 特性检测 + 降级。
- 上线前在目标机 `chrome://version` 记录内核，并跑 `compat-check.html` 自检页（见 4.8 / 11）。

> 参考来源：MDN BCD（`Array.json`/`gap.json`/`backdrop-filter.json`/`ResizeObserver.json`/`Crypto.json`/`Clipboard.json`/`Notification.json`）、caniuse（flexbox-gap / css-grid / fetch）、Chromium 源码（scheme_registry / security_origin）、奇安信官方新闻与产品页；完整链接见附录 E。

### 2.3 `file://` 运行的关键限制与对策（已在本机 Chromium 实测 + 公开资料查证）

> 实测环境为 macOS Chromium 150 headless；与目标机（奇安信，内核 83–132）机制同源，但**仍需在目标机复测**。表格中"已实测"均指该环境。

| 限制 | 结论 | 对策 |
|---|---|---|
| 原生 ES Module | **必然失败**。实测报错：`blocked by CORS policy: Cross origin requests are only supported for protocol schemes: chrome, chrome-extension, …`（MDN CORSRequestNotHttp） | 经典 `<script src>` + IIFE 命名空间；按 HTML 中顺序加载；自检页用 `import()` 预期失败展示"不可用（正常）" |
| 本地 `fetch()` 读 JSON/JS | 失败（同 CORS） | 校验规则与迁移器写成 JS 常量；备份/导入用 `<input type=file>` + FileReader |
| `localStorage` | 可用；**Chromium 把所有本地 HTML 视为同一 origin `file://`，全机共享同一份存储**（已实测跨目录、ntools 与 index 共享同一批 key；Firefox 才是逐文件独立）。策略禁用/退出清理会抛异常或清空 | 所有读写 try/catch + 内存模式降级；用 marker 做"重启后是否还在"自检；README 说明共享语义 |
| 请求内网 API | 能发，但带 `Origin: null`（实测 OPTIONS 与 POST 均为 `null`）；`POST + JSON + Authorization` 必触发 OPTIONS 预检；`file:// → http://` **不受**混合内容拦截（Chromium 混合内容只对 https 源生效）。若页面改由 nginx **https** 托管而 API 是 http，则会被混合内容拦截 | 网关设置 `Access-Control-Allow-Origin: *`（跨源不带 Cookie 即可）或 `null`，放行 `POST, OPTIONS` 与 `authorization, content-type`；不能改网关时用 nginx 同源反代 `/api`（见 2.4） |
| 剪贴板 | `file://` **是安全上下文**（实测 `isSecureContext=true`），用户手势下 `navigator.clipboard.writeText` 可用；`http://内网IP` 托管时**不是**安全上下文 → 只能 `execCommand`；奇安信 BDLP 等管控可禁复制 | `clipboard.writeText` → 失败回退 `textarea + execCommand('copy')` → 再失败弹出可手工复制文本框；内嵌页面同样走兜底 |
| 通知 | `file://` 下 `Notification.requestPermission()` **实测返回 `denied`**；无 Service Worker/后台 | 只做页内提醒（toast + 标题闪烁 + 角标），**明示"关闭页面后不提醒"** |
| iframe 嵌入 `index.html` | 可显示（现状正常）；但 `file:// → file://` 属跨源：父页读不到子页 `contentDocument`（实测 null / SecurityError），localStorage 仍共享 | 不需要父页控制即无影响；失败时显示"单独打开 nChat"按钮；长期方案见 6.2 |
| Blob 下载 | 可用（实测 `blob:null` + `a[download]` 落盘）；但**同步 `URL.revokeObjectURL()` 可能取消下载**；企业下载策略可能弹窗/改目录且无回调 | 改为 `appendChild(a) → click → setTimeout(revoke)`；导出后给明确成功提示；失败时提供"文本框 + 手工复制"兜底 |
| 资源缓存 | `file://` 无 HTTP 缓存，覆盖文件即可生效；nginx 托管时需 `Cache-Control: no-cache` 与资源版本串 | 发布包带版本号；`?v=` 查询串；禁止强缓存 `index.html`；不引入 Service Worker |
| 国密 SSL（SM2） | 若内网 API 走国密证书，普通 Chrome/Edge 测试机可能连不通，只有奇安信可通过 | 验收必须用奇安信实机；开发机与目标机分工验证 |
| IE 内核/ActiveX | 信创 ARM Linux 端只有 Chromium/Blink，**不要指望 IE 双核兼容** | 不引入 ActiveX/IE 专用写法 |

### 2.4 部署形态建议（保持"纯 HTML"前提）

1. **首选（不变）**：U 盘/共享盘拷贝文件夹 → 双击 `index.html` / `ntools.html`。所有改造必须保证此形态可用；`file://` 下 localStorage 全机共享，**换目录/升级覆盖不会丢数据**（已实测）。
2. **备选（需验证）**：内网 nginx 静态托管（无后端逻辑）。
   - 好处：消除 Origin/CORS、iframe、缓存的大部分限制；可统一入口与版本发布。
   - **注意**：若走 `http://内网IP`，页面**不是安全上下文** → `navigator.clipboard`、`crypto.subtle` 不可用；若走 https，则 API 必须同为 https 或同源反代，否则触发混合内容拦截。
   - 方案：同一份代码兼容两种形态；`compat-check.html` 检测协议并提示能力差异。
3. **不建议**：Electron/Tauri 桌面壳（引入构建链与运维成本，超出"纯 HTML 小程序"定位）；除非后续确需"关页提醒/开机自启"。

### 2.5 奇安信可信浏览器内核时间线与支持目标

奇安信官方"先锋版"公开时间线（来源见附录 E）：

| 时间 | Chromium 内核 | 时间 | Chromium 内核 |
|---|---|---|---|
| 2020-07 | 83 | 2022-05 | 102 |
| 2020-09 | 87 | 2023-01 | 110 |
| 2020-11 | 89 | 2024-12 | 132 |
| 2021-01 | 90 | — | — |
| 2021-10 | 97 | — | — |

- **已查证**：上述时间线来自奇安信官方新闻/公众号；麒麟/统信商店曾上架 110、132；申威平台官方表述"Chromium 90 以上"。
- **未查证/推断**：国企实际安装的"专业版/标准版/企业版"与先锋版内核的对应关系**无公开对照表**，正式版通常滞后于先锋版，因此**不能由公开资料推定现场版本**，必须现场读取 `chrome://version`。
- **支持目标**：以 Chromium 83 为下限、92 为"完整功能推荐线"、97/102/110 为"最可能现场版本"设计：
  - <92：必须加 `Array.prototype.at` polyfill（否则 marked 崩）；
  - =83：再加 flex `gap` margin 兜底；
  - ≥92：现有功能可直接运行；
  - 132 等新版本无兼容问题，但需回归验证。

---

## 3. 问题清单（带证据）

> 优先级定义：**P0** = 数据安全/丢失、功能整体不可用、上线阻塞，必须最先修；**P1** = 高频体验缺陷或稳定隐患，随重构修；**P2** = 打磨项。

### 3.1 全局与架构（A 类）

| 编号 | 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| A1 | P1 | 全部聊天逻辑包在一个 1082 行 `DOMContentLoaded` 闭包内，52 个 DOM 引用、7 个可变状态、32 个监听器全部私有 | `app.js:1–1082` | 无法单测、无法复用、任何改动都要全量手工回归 |
| A2 | P1 | `fetchAssistantResponse` 单函数 232 行，混合请求构造/SSE 解析/思考状态机/增量渲染/统计/存储/UI 复位 | `app.js:689–920` | 复杂度热点，最易出 bug、最难改 |
| A3 | P1 | 设置状态有 7 处副本（`currentSettings`、表单、高级面板 class、localStorage…）；**改了 Key/模型但未点"保存配置"就直接发送，用的仍是旧配置** | `app.js:218–242`、`275–301`、`935–937` | 用户以为已生效，实际 401 或用错模型 |
| A4 | P1 | 重复实现 ≥7 组：统计详情按钮（`531–541` / `896–906`）、配置列表（`203–212` / `335–351`）、两套下拉（`353–362`/`969`/`954–962`）、两套模态（`169–188` / `451–466`）、主题/Lite（`62–91` / `94–118`）、字段映射（`225–233` / `276–286`） | 见左 | 改一处漏一处，行为漂移 |
| A5 | P1 | 事件模型混用：`addEventListener` 与直接 `onclick` 赋值混排；菜单互斥逻辑散落 4 处 | `342`、`550`、`564`、`571`、`578`、`969`、`954–962` | DOM 重建后需重绑，易漏绑/重复绑 |
| A6 | P1 | 错误吞噬：`catch(e){}` 静默；无 `window.onerror`/`unhandledrejection` 兜底 | `app.js:852`、`386`、`1058` | 异常后 UI 半死且无提示 |
| A7 | P2 | 魔法值/存储键散落（`'nchat-settings'`、`2000ms`、`1024/0.8`、`60000`…） | 全局 | 易错、难维护 |
| A8 | P2 | 死代码与瑕疵：`removeErrorMessages` 的过滤永不命中；`resizeObserver` 无法 disconnect；`style.css:1171` 双分号；`#clear-chat-btn` 写死颜色 | `app.js:403–412`、`163–166`；`css/style.css:1171`、`667–670` | 噪声与误导 |
| A9 | P1 | 无测试/lint/CI；README 即唯一规格，且部分表述与实现冲突（如"Lite 版本移除图片上传"实际不存在独立轻量版） | 仓库根目录 | 重构无安全网 |
| A10 | P1 | 性能：流式每个 delta 全量 `marked.parse + DOMPurify.sanitize` 重渲染（`O(n²)`）、每 chunk 强制 `scrollTop`、每条消息全量 `JSON.stringify` 落盘、45s 渐变动画 + 多处 `backdrop-filter` | `app.js:842`、`725`、`815`、`851`、`598`；`style.css:164` | 长回答卡顿、ARM 低配机发热掉帧 |
| A11 | P1 | 依赖加载脆弱：marked/purify 是 head 中非 defer 阻塞脚本，缺失/顺序错即白屏且无提示 | `index.html:10–13` | 部署漏文件时难以排查 |
| A12 | P1 | 语法门槛：`?.` 8 处、`??` 4 处、flex `gap`、`ResizeObserver`、`AbortController`、`TextDecoder` 流；若内核 <80 直接白屏，flex `gap` 需 84 | `app.js:267/421/426/552/735/793/981/1050`、`230–233`、`css/style.css`（flex gap） | 上线前必须确认内核 |
| A13 | **P0** | **实际硬门槛被低估**：`marked v15.0.12` 内部使用 `Array.prototype.at`（Chromium 92+），内核 83–91 时 `marked.parse` 抛 `TypeError: t.at is not a function`，聊天正文渲染全挂 | `js/marked.min.js`（v15.0.12）；平台组实测：删除 `Array.prototype.at` 后触发该 TypeError，补 1 行 polyfill 即恢复 | 奇安信公开时间线 83–132 中 83–91 均无法渲染消息；必须加 polyfill 或降级 marked |

### 3.2 TodoList（T 类，本方案重点）

| 编号 | 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| T1 | **P0** | 顶层无保护 `JSON.parse(localStorage.getItem('ntools_todo'))`；坏数据/存储被禁用 → **整个内联脚本中断**，二维码/MD/图片工具全部失效 | `ntools.html:459` | 单点故障导致整页不可用 |
| T2 | **P0** | `save()` 无 try/catch：配额写满时 `setItem` 抛错在 `render()` 之前 → 内存已改、UI 未更新，用户看到“点了没反应” | `ntools.html:466–469`、`492–496` | 状态错乱、数据静默丢失 |
| T3 | **P0** | 存储型 XSS：`item.title` 直接插入 `innerHTML`；`item.id` 无引号拼进内联 `onclick`（字符串 ID 直接报错，恶意 ID 可注入代码） | `ntools.html:560–575`（title 在 567，id 在 561/572） | 导入恶意 JSON/共享数据即执行脚本；同源下可窃取 nChat API Key |
| T4 | **P0** | 导入零校验、先覆盖、无确认、无备份：导入 `{}` 可把页面变成“每次刷新都挂”；导入 `[]` 直接清空数据 | `ntools.html:588–601` | 不可逆数据丢失 + 持续崩溃 |
| T5 | P1 | 全量 `innerHTML` 重建 + 60s `setInterval`：列表跳回顶部、选中/焦点丢失、后台空转、ARM 卡顿 | `ntools.html:463`、`542`、`550–577` | 高频可感知体验缺陷 |
| T6 | P1 | `render()` 内 `this.data.sort(...)` 直接改源数组：导出顺序被视图排序污染 | `ntools.html:545–548`、`581` | 数据顺序不稳定，后续自定义排序无从谈起 |
| T7 | P1 | `id = Date.now()` 可能同毫秒碰撞；`===` 严格比较导致导入字符串 ID 后操作静默失效；重复 ID 删除会误删多条 | `ntools.html:480`、`493`、`502` | 操作丢失/误删 |
| T8 | P1 | **无编辑能力**：只有 add/toggle/remove/showDetails，详情弹窗只有“关闭” | `ntools.html:458–602`、`371–381` | 写错一个字只能删掉重建 |
| T9 | P1 | 无筛选/搜索/排序/计数/清空已完成 | `ntools.html:236–269` | 任务超过 20 条即难用 |
| T10 | P1 | 日期语义问题：截止时间必填；添加后只清标题/详情不清日期；过去时间无校验；“0 分钟后”、已完成仍显示倒计时、`toLocaleString` 随系统 locale 漂移 | `ntools.html:474/477/483/487–488`、`523–531`、`514` | 误操作、显示误导 |
| T11 | P1 | 无提醒：无 `Notification`、无页内提醒，只有左边框颜色；打开详情后不随时间刷新 | 全局 grep 无 `Notification`；`ntools.html:144–147`、`507–521` | 错过截止时间 |
| T12 | P1 | 详情弹窗无 Esc/焦点陷阱/焦点返回；无 `role=dialog`；只有“关闭”，不能就地完成/编辑/删除；与全局 modal 双轨控制 `display` | `ntools.html:371–381`、`507–521`、`93–115` | 键盘/读屏不可用、操作低效 |
| T13 | P2 | 无障碍：`* { outline:none }`；输入无 label；假 checkbox（div）；li 不可聚焦；删除是 div；仅用颜色区分紧急度；无 `aria-live` | `ntools.html:29`、`144–147`、`246–250`、`558–574` | 键盘/读屏/色弱用户不可用 |
| T14 | P2 | 空状态/反馈/导出细节：空列表无提示；导出无成功提示且不 `revokeObjectURL`；无计数、无示例数据 | `ntools.html:265–267`、`580–586` | 体验粗糙 |
| T15 | P2 | 布局/性能：长标题无 `overflow-wrap`；`modal-body` 无 `max-height`；`backdrop-filter` + hover `transform` 在 ARM 易掉帧；字体栈无中文字体 | `ntools.html:136–152`、`118–122`、`95`、`142`、`24` | 长内容溢出、掉帧、字体不可控 |
| T16 | P2 | 多标签一致性：无 `storage` 事件监听；两个窗口互相覆盖且无感知 | 全局 grep 无 `addEventListener('storage')` | 数据被静默覆盖 |
| T17 | P2 | 导入导出细节：`readAsText` 无 `onerror`；无文件大小上限；导出无版本标识；无 BOM 提示 | `ntools.html:580–601` | 导入失败无原因、文件不可诊断 |
| T18 | P2 | 其他：`remove(id,event)` 依赖内联 event；`add` 后不聚焦回标题；无 `maxlength`；v1 无 `createdAt/updatedAt` | `ntools.html:471–501` | 细节体验与后续功能受限 |

### 3.3 nChat 安全（S 类）

| 编号 | 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| S1 | **P0** | API Key 明文落盘，且**导出配置包含密钥**（README 还宣传“方便分享”） | `app.js:245–247`、`294–297`、`971`；`README.md:14` | 配置文件一传阅即泄露密钥；共享电脑可见 |
| S2 | **P0** | 恢复备份/导入配置零校验：`conversation` 直接赋值并渲染；图片 URL 拼进 `innerHTML` 属性、`stats` 拼进 tooltip、`id` 拼进选择器 | `app.js:1017–1027`、`446`、`534–538`、`896–905`、`421`/`480` | 用户主动“恢复备份”即可执行任意 JS，窃取全部本地数据 |
| S3 | **P0** | `ntools.html` 的 Markdown 预览未净化：未加载 DOMPurify，直接 `innerHTML = marked.parse(...)` | `ntools.html:8–9`、`660` | **全项目最高危单点**：打开/导入恶意 `.md` 即 XSS；同源可窃取 API Key |
| S4 | **P0** | DOMPurify 3.0.6 过旧（CVE-2024-47875 等 mXSS 绕过影响该版本区间） | `js/purify.min.js:1` | 现有净化可被绕过 |
| S5 | P1 | 无 CSP；`customPromptMessage.innerHTML` 接受内部字符串 | `index.html`（无 CSP）、`app.js:172` | 缺少纵深防御 |
| S6 | P1 | `file://` → 内网 API 的 CORS（`Origin: null`）与混合内容未验证；错误只抛 `status: statusText`，CORS 失败显示 “Failed to fetch” | `app.js:760–767` | **上线第一阻塞风险**，且无法定位 |
| S7 | P1 | `apiUrl` 未校验（可指向任意主机）；切换配置不隔离会话 → 历史（含图片/敏感内容）会发给新端点 | `app.js:754–758`、`327–330`、`739–742` | 数据外发/串服务 |
| S8 | P2 | 外部图片可被 Markdown 渲染（追踪像素/内网探测）；链接点击整页导航丢失会话；无“清除密钥/清空本地数据”入口 | `app.js:430–433`、`746`、`README.md` | 隐私与体验细节 |

### 3.4 nChat 持久化（P 类）

| 编号 | 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| P1 | **P0** | `saveConversation` 无 try/catch，且调用点在流式 `finally` 内；配额异常会让 `finally` 中断 → 输入区永久 disabled、按钮卡在“停止”，刷新后丢历史 | `app.js:365–367`、`598`、`911`、`916` | 最痛故障：卡死 + 丢数据 |
| P2 | **P0** | base64 图片直接进会话并整体 `stringify`：单图 100–400KB，5 图单条消息 1–2MB，2–3 条即爆 5MB 配额 | `app.js:620–647`、`943`、`366` | 配额溢出 + 历史丢失 |
| P3 | **P0** | 无版本号/迁移：备份写 `version:1` 但恢复从不校验；字段演进后旧数据渲染崩溃且无法修复 | `app.js:996–1000`、`1017–1018`、`369–391` | 升级即“打不开旧数据” |
| P4 | P1 | 单会话不分配置（全局唯一 key），切换 provider 后历史原样发送 | `app.js:59`、`327–330` | 跨服务数据泄露（同 S7） |
| P5 | P1 | 多标签覆盖：无 `storage` 事件/锁，最后写入者胜 | 全局 grep 无 | 静默丢消息 |
| P6 | P1 | 写盘粒度粗：每条消息全量序列化；流式期间不落盘，崩溃即丢已生成内容；无 `pagehide` flush；无占用提示/清理入口 | `app.js:598`、`911` | 性能与可靠性 |
| P7 | P1 | 保存失败不可见（仅 console），用户以为已保存 | `app.js:365–367`、`294–297` | 信任受损 |

### 3.5 流式解析与交互（R/U 类，摘要）

| 编号 | 级别 | 问题 | 证据 |
|---|---|---|---|
| R1 | **P0** | `[DONE]` 只跳出内层循环；CRLF 时 `'[DONE]\r'` 判断失效；外层 `while(true)` 继续等 → 服务端不关连接时会一直挂到用户点停止 | `app.js:773–790` |
| R2 | P1 | 无整体/首字节/chunk 空闲超时，无 `reader.cancel()`，`response.body` 可能为 null 未判空 | `app.js:769`、`773` |
| R3 | P1 | 错误响应体丢弃，用户看不到 “invalid api_key / model not found / 额度不足” | `app.js:767` |
| R4 | P1 | 请求把内部字段 `stats`/`reasoning` 一并发送，严格网关会 400 | `app.js:741` |
| R5 | P1 | `usage` 缺失时 Token/Rate 全为 0；未请求 `stream_options.include_usage` | `app.js:846–850`、`867–885` |
| R6 | P1 | 流内 `{"error":...}` 与未知事件被 `catch(e){}` 静默吞掉，表现为回答突然截断 | `app.js:852` |
| R7 | P1 | `<think>` 标签跨 chunk 边界（如 `"<thi"+"nk>"`）未处理，会漏进正文 | `app.js:804–843` |
| R8 | P2 | 200 但非 SSE/空流：typing indicator 永不消失 | `app.js:783`、`695` |
| U1 | P1 | 中文 IME 回车误发送（无 `isComposing` 判断）——中文用户第一高频 bug | `app.js:1073` |
| U2 | P1 | 流式期间禁用输入框（无法预输入，输入法被打断） | `app.js:665–671` |
| U3 | P1 | 强制滚底，用户上翻阅读被拽回 | `app.js:590/699/815/851` |
| U4 | P1 | 重新生成/编辑保存会静默截断其后全部消息，无“将删除 N 条”提示与撤销 | `app.js:469–499` |
| U5 | P1 | 无障碍基本缺失：无 aria/role、无 Esc、无焦点陷阱、统计仅 hover 可见；viewport 禁止缩放 | `index.html:6/146–165`、`app.js:169–188`、`css/style.css:1020–1024` |
| U6 | P2 | 首屏 FOUC（主题在 defer 脚本里才设置）；无 `prefers-reduced-motion`；Lite 需手动开 | `app.js:62–118`、`index.html:10–14` |
| U7 | P2 | 菜单项是 `<a href="#">` 且未 `preventDefault`（URL 变 `#`、可能触发历史/滚动） | `index.html:44–51`、`app.js:973/993/1006/1070` |

### 3.6 工具页（G 类，Todo 以外）

| 编号 | 级别 | 问题 | 证据 |
|---|---|---|---|
| G1 | **P0** | Markdown 预览无净化（同 S3） | `ntools.html:660` |
| G2 | P1 | MD 导入不落盘（刷新即丢）；每次按键全量 `setItem` + 全量 parse，大文档卡顿 | `ntools.html:655–660`、`668–676` |
| G3 | P1 | 二维码下载用 `setTimeout(100)` 抢时序；生成无 try/catch（超容量抛错）；placeholder 生成后不复位 | `ntools.html:606–644` |
| G4 | P1 | 图片 Base64：10% 缩放可被 floor 成 0 → 空 canvas；`toDataURL` 类型与实际输出不符；非 base64 SVG 数据会使 `match` 抛未捕获异常；无输入大小上限 | `ntools.html:730–736`、`753–779` |
| G5 | P1 | `* { outline:none }`、导航为 div onclick → 全页键盘不可用 | `ntools.html:29`、`214–228` |
| G6 | P2 | 拖拽只绑定第一个 dropzone；MD 导出不 `revokeObjectURL`；iframe 无 `title`/降级提示；ntools 固定深色主题与 nChat 主题不同步 | `ntools.html:791`、`662–666`、`355` |
| G7 | P2 | 下载工具 `downloadBlob` 在 `a.click()` 后**同步** `URL.revokeObjectURL()`，个别浏览器会取消下载；且未 append 到 DOM | `app.js:967`（对比平台组实测结论，见 2.3） |

### 3.7 P0 汇总（必须最先完成，共 13 项）

| # | P0 项 | 涉及 |
|---|---|---|
| 1 | ntools Markdown 渲染接入 DOMPurify 并升级 DOMPurify | S3、S4、G1 |
| 2 | Todo 渲染改 `textContent`/DOM 构造，ID 改字符串 + `data-*` + 事件委托，禁止内联 `onclick` 拼 ID | T3 |
| 3 | Todo 存储读写与 JSON 解析全部 try/catch + 内存降级；工具初始化互相隔离 | T1、T2 |
| 4 | Todo 导入管道：形状识别 + 校验 + 归一 + 预览 + 自动备份 + 合并/替换 + 上限 | T4 |
| 5 | 会话恢复/配置导入校验与渲染收口（图片 URL 白名单、stats 数字校验、ID 重新生成） | S2 |
| 6 | API Key 导出策略：默认剥离密钥，勾选包含需二次确认；导入后密钥需重填 | S1 |
| 7 | nChat 存储适配器 + 配额降级 + `finally` 状态复位；存储不可用进入内存模式 | P1、P2、P7 |
| 8 | 备份/会话数据加版本号与迁移器（写入 `version:2`，读旧数据先迁移） | P3 |
| 9 | SSE：`[DONE]`/CRLF/超时/错误响应体/字段白名单/`usage` 回退/思考标签 carry buffer | R1–R7 |
| 10 | 中文 IME 回车修复；流式期间不锁输入框；智能滚动（near-bottom 才跟随） | U1–U3 |
| 11 | **兼容垫片**：`marked` 前置 `Array.prototype.at`/`String.prototype.at` polyfill；按现场内核补 flex `gap` 兜底；启动加依赖自检 | A13、2.2 |
| 12 | 目标环境基线验证：内核版本、`file://` localStorage 共享、CORS、下载/剪贴板、iframe | 2.3、11 |
| 13 | 重复/重新生成截断确认（至少提示 N 条），避免误删 | U4 |

> 说明：P0 全部可以**不动整体架构**热修完成（预计 3–4 人天，其中 polyfill 约 0.5 小时），但建议按第 7 章顺序与分层重构合并执行，避免二次返工。

---

## 4. 总体重构方案

### 4.1 六条原则

1. **不重写**：保留全部用户可见行为（见 8.6 行为契约 C1–C11）；每个阶段结束都能双击运行。
2. **契约冻结**：先写 README 行为契约 + 冒烟清单 + 基线截图，再动代码。
3. **经典脚本 + IIFE 命名空间**：文件数控制在 12–15；每个文件独立 `'use strict'`；显式加载顺序即依赖顺序。
4. **分层解耦**：store 不碰 DOM，view 不碰存储，service 不碰 DOM，组合根只做装配。
5. **安全优先于功能**：外部数据一律不可信；渲染先收口，再谈新功能。
6. **小步可回滚**：一次提交只做一件事；迁移前自动备份；旧存储键保留一个版本。

### 4.2 目标目录结构

```
nchat/
├─ index.html                 # 只保留结构 + 按顺序的 <script>；无内联脚本
├─ ntools.html                # 工具集外壳；分阶段去内联（过渡期保留 window 别名）
├─ tests.html                 # 双击可跑的断言页（无框架，红/绿列表）
├─ compat-check.html          # 兼容性自检页（内核/存储/网络/API 逐项显示，可一键复制报告）
├─ css/
│  ├─ tokens.css              # 唯一设计令牌：颜色/字体/间距/圆角/阴影/主题/Lite/reduced-motion
│  ├─ base.css                # reset、排版、滚动条、焦点可见性、字体栈
│  ├─ components.css          # 按钮/输入/下拉/模态/灯箱/tooltip/toast/空状态
│  ├─ chat.css                # nChat 专属布局与消息样式
│  └─ tools.css               # nTools 布局/待办/二维码/MD/图片工具
├─ js/
│  ├─ vendor/                 # marked.min.js、purify.min.js、qrcode.min.js（原样，记录版本与校验和）
│  ├─ polyfills.js            # 必须最先加载：Array.prototype.at/String.prototype.at（marked v15 依赖）等最小垫片
│  ├─ theme-boot.js           # 阻塞、<1KB：读 localStorage 设 data-theme/data-lite，防 FOUC
│  ├─ core.js                 # NChat 命名空间、事件总线、工具函数（escape/uid/cssEscape/throttle/debounce/download/clipboard/formatTime）
│  ├─ compat.js               # 特性检测 + 降级实现 + 运行时诊断
│  ├─ storage.js              # safeGet/safeSet/remove、配额检测、内存模式、IndexedDB 适配、迁移注册
│  ├─ schema.js               # 配置/会话/备份/Todo 文档的校验与归一化（纯函数，可单测）
│  ├─ todo-store.js           # Todo 状态 + 持久化 + 撤销栈 + 跨标签同步
│  ├─ todo-view.js            # Todo 渲染（keyed diff）、事件委托、详情/编辑 UI
│  ├─ todo.js                 # Todo 功能入口（组合 store/view/提醒/导入导出）
│  ├─ settings-store.js       # nChat 配置 CRUD/当前配置/脏标记
│  ├─ conversation-store.js   # nChat 会话状态/追加/截断/图片引用
│  ├─ sse.js                  # SSE 增量解析（纯状态机，可单测）
│  ├─ api.js                  # URL/payload 构造、fetch、超时/中止/错误映射、usage 归一
│  ├─ message-view.js         # 消息 DOM 构造、局部更新、footer、统计
│  ├─ composer.js             # 输入区/图片压缩/发送停止/IME/智能滚动
│  ├─ settings-view.js        # 设置表单/导入导出/密钥脱敏
│  ├─ menus.js                # 统一下拉/模态/灯箱/toast（唯一实现）
│  ├─ ntools-app.js           # nTools 组合根
│  └─ app.js                  # nChat 组合根（目标 <150 行）
└─ img/main.png
```

> 文件数刻意克制：内网环境没有构建链，文件过多会放大加载顺序与维护成本。初期可先落 `core/storage/schema/sse/todo-*` 六个文件，其余逐步迁移。

### 4.3 加载顺序与 IIFE 规范

```html
<!-- index.html（其余结构保持不变） -->
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/base.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/chat.css">
<script src="js/theme-boot.js"></script>          <!-- 不 defer，防主题闪烁 -->
<script defer src="js/polyfills.js"></script>    <!-- 必须早于 vendor：补 Array.prototype.at -->
<script defer src="js/vendor/marked.min.js"></script>
<script defer src="js/vendor/purify.min.js"></script>
<script defer src="js/core.js"></script>
<script defer src="js/compat.js"></script>
<script defer src="js/storage.js"></script>
<script defer src="js/schema.js"></script>
<script defer src="js/settings-store.js"></script>
<script defer src="js/conversation-store.js"></script>
<script defer src="js/sse.js"></script>
<script defer src="js/api.js"></script>
<script defer src="js/menus.js"></script>
<script defer src="js/theme.js"></script>        <!-- 可并入 core -->
<script defer src="js/message-view.js"></script>
<script defer src="js/composer.js"></script>
<script defer src="js/settings-view.js"></script>
<script defer src="js/app.js"></script>
```

每个文件统一骨架（无 `import/export`，无全局泄漏，仅挂 `window.NChat`）：

```js
// js/core.js —— 其余模块同构
(function (global) {
  'use strict';
  var NC = global.NChat = global.NChat || { version: '2.0.0' };

  NC.events = (function () {
    var map = new Map();
    function on(type, fn) {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push(fn);
      return function () { off(type, fn); };
    }
    function off(type, fn) {
      var arr = map.get(type);
      if (!arr) return;
      map.set(type, arr.filter(function (f) { return f !== fn; }));
    }
    function emit(type, payload) {
      (map.get(type) || []).slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error('[NC]', type, e); }
      });
    }
    return { on: on, off: off, emit: emit };
  })();

  NC.util = {
    escapeHtml: function (s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    uid: function (prefix) {
      // 不依赖 crypto.randomUUID（Chromium <92 不支持，file:// 下亦需兜底）
      return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    },
    cssEscape: function (v) {
      return (global.CSS && CSS.escape) ? CSS.escape(String(v))
        : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }
  };
  NC.log = function () { if (global.NC_DEBUG) console.log.apply(console, ['[NC]'].concat([].slice.call(arguments))); };
})(window);
```

**过渡期兼容**：`ntools.html` 改造完成前保留 `window.todo/qrTool/mdTool/imgTool/switchTab/nModal` 别名，避免 22 个内联 `onclick` 全部失效；HTML 改完后删除别名。

### 4.4 分层契约与事件

| 层 | 模块 | 可以做什么 | 禁止做什么 |
|---|---|---|---|
| 基础设施 | `core` `compat` `storage` `schema` | DOM 工具、事件总线、存储、校验纯函数 | 业务逻辑、直接渲染页面 |
| 状态层 | `todo-store` `settings-store` `conversation-store` | 持有状态、action/reducer、持久化、emit 事件 | 读写 DOM、发网络请求 |
| 服务层 | `sse` `api` `reminder` | 纯逻辑/网络/定时，回调返回结果 | 读写 DOM、直接读写 localStorage |
| 视图层 | `todo-view` `message-view` `composer` `settings-view` `menus` | 根据快照渲染、绑定委托事件、调用 store action | 直接调 fetch、直接读写 localStorage |
| 组合根 | `app.js` `ntools-app.js` | 初始化各模块、订阅事件、装配依赖 | 承载业务规则 |

核心事件（统一 `NC.events`）：

| 事件 | 载荷 | 订阅方 |
|---|---|---|
| `todo:changed` | `{ doc, meta:{reason} }` | `todo-view`、提醒引擎、标题角标 |
| `todo:render` | `{ view, tasks, counts }` | `todo-view` |
| `settings:changed` / `config:switched` | `{ configId }` | 设置面板、标题、会话切换 |
| `conversation:changed` / `conversation:truncated` | `{ messages }` / `{ fromIndex, removed }` | `message-view` |
| `stream:start/delta/reasoning/usage/done/error/aborted` | 增量文本/统计/错误 | `message-view`、`composer` |
| `storage:error` / `quota:warning` | `{ key, error }` | 顶部警告条、toast |
| `theme:changed` / `lite:changed` | `{ theme, lite }` | `theme-boot`（跨页同步） |

### 4.5 存储层设计

目标：**任何存储异常都不能让页面白屏或卡死**。

1. **键规范**：统一前缀 `ntools.` / `nchat.`，带版本：`ntools.todo.v2`、`nchat.settings.v2`、`nchat.conversation.v2`；旧键只读保留（`ntools_todo`、`nchat-settings`…）。
2. **安全读写**：
   - `safeGet(key, fallback)`：`try { JSON.parse } catch → 把坏原文备份到 `<key>.corrupt.<ts>`（写不进去就提示下载）→ 返回 fallback`。
   - `safeSet(key, value)`：`try { setItem(JSON.stringify) } catch(e) { if (isQuotaError) emit('quota:warning') else emit('storage:error'); return false }`。
   - 每次写入前估算序列化字节数；超过预算（如 localStorage 3.5MB）先触发降级/提示，而不是等浏览器抛错。
3. **内存模式**：`storage.available === false` 时所有读写走内存 Map，顶部常驻横幅“浏览器存储不可用，本次修改不会保存”，并引导“下载当前数据”。
4. **降级优先级**：`localStorage` → 内存；图片/大对象 → IndexedDB（二期）；IndexedDB 不可用 → 不存图片（只存占位）。
5. **写入策略**：store 内 `debounce(300ms)` + `pagehide/visibilitychange` flush + 流式过程 2s 节流快照。
6. **版本与迁移**：`schemaVersion` 整数 + `MIGRATIONS[from]` 映射；读取时"迁移 → 归一 → 校验"，迁移前写 `*.v1-backup`；迁移失败绝不删除原数据。
7. **多标签**：监听 `storage` 事件（`file://` 下是否触发需验证）；比较 `revision`：本地无未保存改动则整体替换，有改动则显示冲突横幅。`BroadcastChannel` 作为备选，不做双写。

### 4.6 渲染策略

1. **用户数据只用 DOM API**：`createElement` + `textContent`；禁止把 title/notes/标签等拼进 `innerHTML`。静态模板可用 `innerHTML`，但不得插入任何变量。
2. **keyed diff（按 ID 复用节点）**：
   ```js
   var nodes = new Map();            // id -> <li>，跨渲染保留
   function renderList(tasks) {
     var ul = document.getElementById('todo-list');
     var seen = Object.create(null);
     tasks.forEach(function (task, i) {
       var el = nodes.get(task.id);
       if (!el) { el = createRow(task); nodes.set(task.id, el); }
       updateRow(el, task);                         // 只更新变化字段
       seen[task.id] = true;
       var ref = ul.children[i] || null;
       if (el !== ref) ul.insertBefore(el, ref);    // 位置未变则不移动
     });
     Array.from(nodes.keys()).forEach(function (id) {
       if (!seen[id]) { var n = nodes.get(id); n.remove(); nodes.delete(id); }
     });
   }
   ```
   目标：滚动位置、文本选中、焦点、CSS 过渡全部保留。
3. **事件委托**：列表容器上仅一个 `click` 监听，通过 `e.target.closest('[data-act]')` 分发；行内不再挂监听、不再有内联 `onclick` 拼 ID。
4. **时间 ticker**：对齐分钟边界 + 仅可见时运行：
   ```js
   function scheduleTick() {
     var wait = 60000 - (Date.now() % 60000) + 50;
     setTimeout(function () {
       if (!document.hidden) updateRelativeTimes();  // 只改时间文本节点
       scheduleTick();
     }, wait);
   }
   document.addEventListener('visibilitychange', function () {
     if (!document.hidden) updateRelativeTimes();
   });
   ```
5. **流式渲染节流**：首 token 立即渲染，其后 60–100ms 合并一次；纯文本增量优先 `append` 文本节点，遇到段落/代码块边界再走 Markdown 全量（聊天侧）。
6. **空状态与反馈**：空列表给出引导（“点击 N 新建，或先添加一条示例任务”）；危险操作有 toast/撤销；保存状态有图标（已保存/保存失败/仅内存）。

### 4.7 安全基线

1. **外部数据一律不可信**：导入的 Todo/配置/会话/备份，先过 `schema.js` 校验与归一化，再落盘、再渲染。
2. **渲染收口**：全部用户数据走 `textContent`；Markdown 必须 `DOMPurify.sanitize(marked.parse(text), 配置)`；图片 URL 只允许 `data:image/(png|jpeg|webp|gif);base64,` 或明确的 http(s)（可配置）。
3. **导入管道**：`读取 → 形状识别 → 校验/归一（脏行隔离 quarantine）→ 预览（合法 n 条 / 拒收 m 条）→ 用户确认（合并/替换）→ 自动备份 → 原子提交`；任何失败不写入。
4. **密钥**：导出配置默认不含 `apiKey`；勾选包含需二次确认并明示风险；导入的密钥留空提示重填；设置页提供“清除密钥/清空全部本地数据”。
5. **CSP**：内网静态托管时启用严格 CSP（`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src http: https:; base-uri 'none'; object-src 'none'`）；`file://` 下 `'self'` 匹配需实测，失败则暂缓，以净化 + 校验为主。
6. **依赖**：DOMPurify 升级到 3.4.x；vendor 记录版本、来源与 SHA-256；不加 SRI（`file://` 下会失败）。
7. **错误信息**：不回显密钥；HTTP 错误读取响应体前 2KB 并做文本转义；CORS/网络错误给出可操作提示。

### 4.8 兼容层与自检

**最小垫片 `js/polyfills.js`（P0，约 30 分钟）**

- 必须在所有 vendor 之前加载，至少补齐 `Array.prototype.at`（marked v15 依赖）与 `String.prototype.at`；实现为不依赖新语法的 ES5 代码，并避免污染不可枚举属性。
- 若现场内核为 83，再按需补 flex `gap` 的 CSS margin 兜底（不改 JS）。
- 备选：若 polyfill 在目标机验证失败，回退到 marked v4/v9 的 ES5 构建（需同步回归 Markdown 渲染用例）；**不引入转译链**。

**`compat.js` 运行时能力表**

- 暴露 `NC.compat.features` 与 `NC.compat.warn(name)`；关键项：`Array.prototype.at`、`?.`/`??`（以现场解析结果为准）、`localStorage` 读写、`ResizeObserver`、`AbortController`、`ReadableStream`/`response.body`、`IndexedDB`、`BroadcastChannel`、`navigator.clipboard`、`crypto.randomUUID`/`crypto.subtle`、`Notification.permission`、`CSS.supports('backdrop-filter'/'gap')`。
- 启动时若关键依赖（marked/purify）缺失或不可用，显示可操作错误页，禁止静默白屏。

**`compat-check.html` 自检页（部署首日必跑）**

1. **环境头部**（供现场截图回传）：UA、内核号（解析并与 `chrome://version` 核对）、`location.protocol/origin`、`isSecureContext`、`devicePixelRatio`、屏幕尺寸、`hardwareConcurrency`、`deviceMemory`（可能 undefined）、语言。
2. **逐项三态检测**（✅ 通过 / ⚠️ 降级 / ❌ 不可用，每项附"建议动作"）：ES 语法（`eval` 测 `?.`/`??`、`typeof [].at`）、fetch/`response.body`/`AbortController`/`TextDecoder`、`localStorage` 全链路、`Blob`/`a.download`、`FileReader`、`clipboard`、`isSecureContext`、`Notification.permission`、CSS（Grid/gap/backdrop-filter/变量等）。
3. **行为探测**：动态 `import()` 预期失败 → 显示"ESM 不可用（file:// 预期，正常）"；iframe 嵌入空白本地页 → "可显示、跨源不可控（正常）"；可配置的 `/health` fetch → 显示成功/失败与 CORS 提示。
4. **存储持久性自检**：写 marker + 时间戳，提示"重启浏览器后再开本页，若 marker 消失 = 管控策略退出清数据"。
5. **性能自检**：rAF 60 帧平均帧间隔 + 滚动 2 秒测帧率，>20ms/帧提示"建议 Lite"（只建议，不自动改设置）。
6. **结论区**：推荐模式（完整/Lite）、P0 阻塞项清单、"一键复制报告"（clipboard 失败时走 `execCommand` 兜底）。

**其他兼容约定**

- **字体栈**：`-apple-system, "Segoe UI", Roboto, "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "Microsoft YaHei", "PingFang SC", sans-serif`；代码用等宽栈并允许回退；emoji（💬👤🤖）依赖 Noto Color Emoji，缺失时降级为文字标签。
- **Lite 策略**：首访在"低配（`hardwareConcurrency ≤ 4`）/ 软件渲染 / `backdrop-filter` 不支持 / 非安全上下文中任一项成立"时**默认开启 Lite**，并给一次性提示；用户可手动切换。Lite 状态跨 `file://` 页面共享。
- **`prefers-reduced-motion`**：尊重系统设置，与 Lite 同样关闭动画；全屏无限渐变动画改为静态背景（即使完整模式也建议）。
- **降级清单**：`Notification` 不可用 → 页内提醒；`clipboard` 不可用 → `execCommand`；`IndexedDB` 不可用 → 不存图片；`BroadcastChannel` 不可用 → `storage` 事件；`ResizeObserver` 不可用 → `window.resize`。

### 4.9 工程质量

| 项 | 方案（不引入构建链） |
|---|---|
| 单元测试 | `tests.html`：加载 `core/schema/sse/todo-store(纯函数部分)`，用 `assert` 列表渲染红/绿；双击即可跑，也可在 CI 中用无头浏览器跑（可选） |
| 冒烟清单 | README 内 C1–C11 行为契约 + 手工清单（首启/配置/发送/流式/停止/错误/图片/备份/主题/Lite/断点） |
| 代码规范 | 统一 `'use strict'`、IIFE、命名空间；避免全局泄漏；关键常量集中；每函数建议 ≤60 行 |
| 版本管理 | `NC.version` 常量 + README 变更记录；发布包 `nchat-v2.0.0-2026xxxx.zip`；`app.js` 顶部注释版本 |
| 提交策略 | 分支 `refactor/v2`；每个迁移步骤一个独立提交，保证"任意提交都可双击运行"；里程碑打 tag |
| 文档 | 新增 `docs/`（架构说明、兼容性说明、CORS 要求、迁移说明）；更新 README 项目结构/功能/隐私表述；补 `LICENSE`（MIT）与 `THIRD_PARTY_NOTICES.md` |

### 4.10 关键决策记录（ADR 摘要）

| 决策 | 选项 | 结论 | 理由 |
|---|---|---|---|
| 是否引入构建链/框架 | Vite+Vue/React、原生、手写 | **原生 + IIFE** | 内网无法维护 npm/构建产物；`file://` 不支持 ES Module；现有代码已证明可行 |
| 是否拆分为多个 HTML 页面 | 单入口 SPA、保留双入口 | **保留双入口 + 共享模块** | 破坏最小；两个入口已满足"工具集 + 聊天"；不引入路由复杂度 |
| Todo 存储形态 | 单文档、按任务键值、IndexedDB | **单文档 + v2 键 + 自动备份** | 原子写、易迁移/导出、1000 条量级 localStorage 足够；图片等大对象才用 IndexedDB |
| 是否保留 v1 键 | 删除、双写、只读保留 | **只读保留一个版本** | 可回滚；双写必然冲突；迁移器幂等 |
| 删除交互 | 确认弹窗、软删除+Undo | **软删除 + 5s Undo + 回收站（P1）** | 待办删除频率高，确认弹窗打断流；撤销更符合直觉 |
| 提醒实现 | 系统通知、页内提醒、本地服务 | **页内提醒 + 明确边界** | `file://` 下通知不可靠、无后台；不引入后端 |
| 会话是否按配置隔离 | 全局单会话、按 configId 分会话 | **按 configId 分会话（P1）** | 防止历史跨服务外发；符合多配置语义 |
| 图片存储 | localStorage、IndexedDB | **IndexedDB + localStorage 元数据（二期）** | localStorage 5MB 必然溢出；IndexedDB 容量与性能更合适 |

---

## 5. TodoList 专项改造方案（重点）

### 5.1 现状 vs 目标能力矩阵

| 能力 | 现状 | 目标（本方案） | 优先级 |
|---|---|---|---|
| 新增任务 | ✅ 标题+详情+截止时间（截止必填） | ✅ 标题必填、截止可选、优先级/清单/标签可选、回车提交 | P0 |
| 编辑任务 | ❌ 完全没有 | ✅ 行内编辑标题/详情/截止/优先级，详情抽屉可改全部 | P0 |
| 完成/取消完成 | ✅ checkbox | ✅ 保留，增加完成时间、撤销、批量操作 | P0 |
| 删除 | ✅ 确认后永久删除 | ✅ 立即删除 + 5s Undo + 回收站（7 天） | P0 |
| 筛选 | ❌ | ✅ 全部/今天/逾期/已完成 + 计数徽标 | P0 |
| 搜索 | ❌ | ✅ 标题/详情/标签，200ms debounce | P0 |
| 排序 | 隐式（完成→截止） | ✅ 智能（逾期→今天→近期→远期）/截止/创建/手动拖拽 | P0/P1 |
| 优先级 | ❌ | ✅ 低/普通/高/紧急（图标+色条，不只靠颜色） | P1 |
| 清单/分组 | ❌ 单一列表 | ✅ 多清单（默认清单 + 自定义、颜色、重命名、删除迁移） | P1 |
| 标签 | ❌ | ✅ 0–20 个/任务，自动补全，按标签过滤 | P1 |
| 子任务 | ❌ | ✅ 可勾选、父任务显示 n/m 进度、全部完成可选自动完成 | P1（可延后） |
| 提醒 | ❌ | ✅ 页内 toast/标题角标/逾期计数/稍后提醒；关页不提醒（明示） | P1 |
| 重复任务 | ❌ | ✅ 日/周/月/年简版；打开页面时物化下一次 | P2 |
| 快捷键 | ❌ | ✅ N/搜索/E/空格/Delete/Esc/↑↓ | P0（P0 子集） |
| 统计 | ❌ | ✅ 今日待办/逾期/本周完成/清单分布 | P1 |
| 导入/导出 | ⚠️ 无校验裸 JSON | ✅ v2 带版本、校验、预览、合并/替换、自动备份、CSV/MD 导出（P2） | P0 |
| 跨标签同步 | ❌ | ✅ `storage` 事件 + revision | P1 |
| 数据迁移 | ❌ 无版本 | ✅ v1→v2 幂等迁移 + 备份 + 回滚 | P0 |

### 5.2 目标信息架构与交互

```
┌────────────────────────────────────────────────────────────────────────┐
│ nTools │ 待办事项            [🔍 搜索任务…]        [＋ 新建任务]  [⋯ 更多] │
├──────────────┬─────────────────────────────────────────┬───────────────┤
│ 智能视图      │  今天 · 3 项                             │ 任务详情抽屉    │
│ ● 全部   12  │  ┌─────────────────────────────────────┐ │ 标题（可编辑）  │
│ ● 今天    3  │  │ ☐ 完成季度报表          高  ⏰ 今天  │ │ 截止时间        │
│ ● 逾期    1  │  │    标签：报表 · 子任务 1/3            │ │ 优先级/清单/标签 │
│ ● 已完成  8  │  └─────────────────────────────────────┘ │ 备注            │
│              │  ┌─────────────────────────────────────┐ │ 子任务列表      │
│ 清单          │  │ ☑ 提交周报            ⏰ 09:00 已过期 │ │ 创建/完成时间   │
│ ▸ 工作    7  │  └─────────────────────────────────────┘ │ [完成] [删除]   │
│ ▸ 个人    5  │  明天 · 2 项 ...                          │                │
│ + 新建清单    │                                         │                │
└──────────────┴─────────────────────────────────────────┴───────────────┘
```

- **布局**：≥1100px 三栏（视图 / 列表 / 详情抽屉）；<1100px 详情改为底部抽屉/全屏模态；目标内网典型分辨率 1366×768 可完整容纳。
- **列表分组**：逾期 / 今天 / 明天 / 本周 / 以后 / 已完成（折叠，显示计数），过期项置顶并标红文字（不只靠颜色）。
- **新建区**：折叠为单行输入（标题 + 可选截止/优先级），`Enter` 快捷提交，`Ctrl+Enter` 提交并继续新建，`Esc` 清空；添加后焦点回到标题并可立即输入下一条。
- **时间显示**：绝对时间优先（`今天 18:00`、`明天 09:00`、`11-20 18:00`），相对时间作副信息；已完成不显示倒计时；跨天自动刷新。
- **空状态**：区分“全部为空”“筛选无结果”“搜索无结果”三种文案，并给“清空筛选 / 新建任务 / 导入示例”入口。

**快捷键（与输入框冲突时以输入为准）**

| 键 | 行为 |
|---|---|
| `N` | 聚焦新建输入 |
| `/` | 聚焦搜索 |
| `↑` / `↓` | 列表内移动焦点（roving tabindex） |
| `Space` | 切换当前项完成状态 |
| `Enter` | 打开当前项详情 |
| `E` | 编辑当前项标题 |
| `Delete` / `Backspace` | 删除当前项（进回收站 + Undo） |
| `Esc` | 关闭详情/清空搜索/退出编辑 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销/重做 |
| `Ctrl+Enter` | 新建区“保存并继续” |

### 5.3 数据模型 v2

**存储键**

| 键 | 内容 | 说明 |
|---|---|---|
| `ntools.todo.v2` | Todo 文档（单文档） | 唯一写入源 |
| `ntools.todo.v1_backup` | v1 原始字符串 | 迁移前冻结，只读 |
| `ntools.todo.v2_backup` | 上一次良好文档 | 导入/迁移前自动写入，保留 1 份 |
| `ntools_todo` | v1 旧键 | 迁移后保留一个版本用于回滚 |

**文档结构（示例）**

```json
{
  "schemaVersion": 2,
  "revision": 42,
  "updatedAt": 1762940000000,
  "lists": [
    { "id": "list_default", "name": "待办", "color": "#2f81f7", "order": 0,
      "archived": false, "createdAt": 1762000000000, "updatedAt": 1762000000000 }
  ],
  "tasks": [
    {
      "id": "t-ld3k2a-8f2c1d",
      "listId": "list_default",
      "title": "完成季度报表",
      "notes": "数据截止 15 号，找财务要模板",
      "status": "open",
      "priority": "high",
      "due": 1762952400000,
      "dueAllDay": false,
      "tags": ["报表", "财务"],
      "subtasks": [
        { "id": "s-1", "title": "收集数据", "done": true, "order": 0 },
        { "id": "s-2", "title": "核对口径", "done": false, "order": 1 }
      ],
      "recurrence": null,
      "reminder": { "leadMinutes": 15, "firedAt": null, "snoozeUntil": null, "channels": ["inapp"] },
      "order": 1024,
      "createdAt": 1762900000000,
      "updatedAt": 1762940000000,
      "completedAt": null,
      "deletedAt": null,
      "source": "manual"
    }
  ],
  "settings": {
    "defaultListId": "list_default",
    "view": "all",
    "sort": "smart",
    "showCompleted": true,
    "reminderLeadMinutes": 15,
    "compact": false
  },
  "meta": { "app": "nTools", "appVersion": "2.0.0", "migratedFrom": "v1", "migratedAt": 1762940000000, "quarantine": [] }
}
```

**字段与约束**

| 字段 | 类型 | 必填 | 约束/默认 | 说明 |
|---|---|---|---|---|
| `schemaVersion` | int | ✅ | `2` | 迁移依据 |
| `revision` | int | ✅ | ≥0，每次提交 +1 | 多标签冲突检测 |
| `updatedAt` | int(ms) | ✅ | 合理时间范围 | 文档级时间戳 |
| `lists[].id` | string | ✅ | `^[A-Za-z0-9_-]{6,64}$` | `list_default` 固定默认 |
| `lists[].name` | string | ✅ | 1–60，非空白 | trim 后校验 |
| `lists[].color` | string | | `^#[0-9a-fA-F]{6}$` | 默认 `#2f81f7` |
| `lists[].order` | number | | 默认 0 | 清单排序 |
| `tasks[].id` | string | ✅ | 唯一，6–64 | 新任务 `uid('t')`；v1 迁移为 `v1-<旧id>` |
| `tasks[].listId` | string | ✅ | 必须存在，否则回退默认清单 | 引用完整性 |
| `tasks[].title` | string | ✅ | 1–500，非空白 | 超长截断并记录 quarantine |
| `tasks[].notes` | string | | 0–10000，默认 `""` | 详情 |
| `tasks[].status` | enum | ✅ | `open`/`done`/`canceled`，默认 `open` | 完成语义 |
| `tasks[].priority` | enum | | `low`/`normal`/`high`/`urgent`，默认 `normal` | 排序/视觉 |
| `tasks[].due` | int/null | | 有限正数 ≤ 4102444800000，默认 null | epoch ms；**可为空** |
| `tasks[].dueAllDay` | bool | | 默认 false | 仅日期时按当天 23:59 处理 |
| `tasks[].tags` | string[] | | ≤20 个，每个 1–32，去重 | 过滤 |
| `tasks[].subtasks` | array | | ≤100；`{id,title 1–200,done,order}` | 进度 |
| `tasks[].recurrence` | object/null | | 见下 | P2 预留 |
| `tasks[].reminder` | object/null | | `leadMinutes` 0–43200 | P1 |
| `tasks[].order` | number | | 默认 0 | 手动排序；拖拽取中点，间隙过小整体重排（步长 1024） |
| `tasks[].createdAt/updatedAt` | int | ✅ | 合理范围 | 排序/审计 |
| `tasks[].completedAt` | int/null | | 完成时写入 | 统计 |
| `tasks[].deletedAt` | int/null | | 软删除；保留 7 天 | 回收站 |
| `tasks[].source` | string | | `manual`/`migrated_v1`/`imported` | 溯源 |

`recurrence`：`{ freq: "daily"|"weekly"|"monthly"|"yearly", interval: 1–99, byWeekday?: [0–6], until?: epochMs|null, count?: 1–1000|null, lastMaterializedAt?: epochMs|null }`。

**内存索引**（加载后构建，不持久化）：`byId: Map<id, task>`、`byList`、`dueIndex`（按 due 排序）、`counts`（open/today/overdue/doneThisWeek）、`searchText`（title+notes+tags，小写）。

**校验与归一化**（`schema.js`，纯函数）：字段白名单、类型/长度/枚举/引用完整性/上限（任务 ≤5000、清单 ≤50）、ID 唯一性、`due` 有限数、`tags` 去重、`order` 重排；拒收行写入 `meta.quarantine` 并在导入预览中展示，不阻断其余数据。

### 5.4 v1 → v2 迁移

| v1 字段 | v2 字段 | 迁移规则 |
|---|---|---|
| 根数组 | `{schemaVersion:2, revision:1, lists, tasks, settings, meta}` | 创建默认清单 `list_default` |
| `id: number` | `id: "v1-<old>"` | 确定性生成，保证重复导入幂等；冲突/非法加随机后缀 |
| `title` | `title` | trim；空 → quarantine；>500 截断并把原文前缀写入 `notes` |
| `content` | `notes` | 默认 `""`；>10000 截断并标记 |
| `due: number` | `due` / `dueAllDay:false` | 有限数且在合理范围内才保留，否则 null 并入 quarantine |
| `completed: true/false` | `status: "done"/"open"`，`completedAt: null` | 无历史完成时间 |
| — | `listId: "list_default"`、`priority:"normal"`、`order: index*1024`、`tags:[]`、`subtasks:[]`、`recurrence:null`、`reminder:null`、`deletedAt:null`、`source:"migrated_v1"`、`createdAt/updatedAt:迁移时刻` | 补默认值 |

**迁移流程（永不 throw）**

1. 读 `ntools.todo.v2`：`safeGet` → `normalizeDoc` → 成功即用。
2. 无可用 v2 → 读 v1 `ntools_todo`：先把原始字符串冻结到 `ntools.todo.v1_backup`（已存在不覆盖）→ 按上表迁移 → 写 v2 → **保留 v1 键**。
3. 都没有 → 空文档 + 默认清单。
4. 任一步失败 → 内存空文档 + 顶部横幅 + “下载原始数据”按钮（**绝不静默删除**）。
5. 首次迁移成功后显示一次性提示：“已迁移 N 条，原数据已备份”；设置中提供“从 v1 备份恢复”。

**导入/导出格式**

- 导出：`{schemaVersion:2, app:"nTools", appVersion, exportedAt, lists, tasks, settings}`，文件名 `ntools-todo-<yyyyMMdd-HHmm>.json`。
- 导入识别三种形状：v2 文档 / v1 裸数组 / `{data:[...]}`；统一走“迁移 → 归一 → 校验 → 预览 → 提交”。
- 合并策略：按 `id` 合并，`updatedAt` 新者胜；源文档中不存在的 `listId` 自动创建同名清单；替换模式前必须自动备份。
- 上限：文件 ≤5MB、任务 ≤5000；超限直接拒绝并提示。

### 5.5 功能清单与验收标准

#### P0（第一个可用版本必须包含）

| 编号 | 功能 | 关键交互 | 验收标准 |
|---|---|---|---|
| T2-1 | 稳健存储层 | 读写包装、内存降级、坏数据隔离、自动备份 | 清空/写坏/禁用 localStorage 三种场景下：页面可打开、其余工具正常、有可操作提示、坏数据可下载；任务操作不因保存失败而状态错乱 |
| T2-2 | 安全渲染与 ID | `textContent`/DOM 构造、字符串 ID、`data-*`、事件委托 | 标题含 `<img onerror>`/`<script>`/超长串 → 原样显示不执行；导入字符串/非法 ID 后完成/删除正常；无内联 `onclick` 拼 ID |
| T2-3 | 导入导出 v2 | 形状识别、校验、预览、合并/替换、自动备份 | `{}`、`[]`、`[null]`、坏 JSON、5MB 文件、v1 备份、v2 备份 7 类样本均有明确结果；取消/失败时现有数据零变化；可“恢复上一份” |
| T2-4 | v2 模型 + 迁移 | 一次性迁移、幂等、保留 v1 | 50 条混合脏数据（字符串 ID、重复 ID、NaN due、超长 title、null 项）迁移后合法条数正确、字段合法、不报错；重启不重复迁移；v1 键仍在 |
| T2-5 | 新增/编辑任务 | 行内编辑（双击标题）、详情抽屉编辑、`Enter` 保存/`Esc` 取消 | 编辑后刷新仍在；`Esc` 不落库；标题为空拒绝并提示；截止时间可清空；添加后表单清空且焦点回标题 |
| T2-6 | 删除与撤销 | 立即删除 + 5s Undo toast + 回收站入口（P1 完善） | 删除后 5s 内可恢复原位置；回收站可恢复；批量删除合并为一步撤销 |
| T2-7 | 视图/筛选/搜索 | 全部/今天/逾期/已完成 + 搜索 + 计数 | 100 条跨日期任务计数正确（“今天”按本地 00:00–24:00）；空结果有空状态；搜索 200ms debounce；视图状态持久化 |
| T2-8 | 键盘与弹窗可达 | roving tabindex、快捷键、modal 焦点陷阱/Esc/焦点归位 | 全流程不用鼠标可新建/编辑/完成/删除/撤销；读屏可读出“未完成/已完成、截止时间”；焦点环可见 |

#### P1（第二个版本）

| 编号 | 功能 | 验收标准 |
|---|---|---|
| T3-1 | 优先级 | 四种优先级可设置、可过滤、排序生效；视觉上图标+文字+色条，不只靠颜色 |
| T3-2 | 多清单 | 新建/重命名/删除（有任务时二次确认并迁移到默认清单）/颜色/排序；过滤与计数正确；导出含 lists |
| T3-3 | 标签 | 0–20 个/任务、自动补全已有标签、按标签过滤、导出保留 |
| T3-4 | 拖拽/键盘排序 | 仅“手动排序”启用；拖拽后顺序持久；1000 条操作流畅；`Alt+↑/↓` 可调整 |
| T3-5 | 页内提醒 | 到点页内 toast/标题角标/逾期计数/稍后提醒；刷新不重复；明示“关页不提醒” |
| T3-6 | 跨标签同步 | 两个窗口修改互相同步（≤1s），无重复任务、无静默覆盖 |
| T3-7 | 撤销/重做栈 | 最近 20 步；批量操作合并为一步；`Ctrl+Z`/`Ctrl+Shift+Z` |
| T3-8 | 统计概览 | 今日待办/逾期/本周完成/清单分布与列表一致；空数据不显示 NaN |
| T3-9 | 子任务 | 可勾选、父任务显示进度、全部完成可选自动完成；持久化正确 |

#### P2（后续）

- 重复任务（日/周/月/年 + interval/byWeekday/until/count；打开页面时物化下一次，`lastMaterializedAt` 防重）。
- 周视图/日历视图/看板视图；导出 Markdown/CSV/打印；附件与链接字段。
- 搜索语法（`tag:xxx`、`is:overdue`、`due:<today`）、“?” 快捷键帮助面板。
- 口令加密（WebCrypto AES-GCM，仅防共用电脑顺手看，不防 XSS，需明说；`file://` 下 `crypto.subtle` 可用性待验证）。
- 回收站自动清理（7 天）、统计图表（不引入图表库，用 CSS 条形图）。

### 5.6 实现要点（伪代码）

**Store（单一状态 + action/reducer + 撤销栈）**

```js
var state = { doc: null, view: 'all', search: '', selectedId: null };
var undoStack = [];   // 最多 20 条 {label, patch}
var redoStack = [];

function dispatch(action, payload) {
  var before = state.doc;
  switch (action) {
    case 'task/add':    state.doc = withTask(state.doc, normalizeTask(payload)); break;
    case 'task/update': state.doc = patchTask(state.doc, payload.id, payload.patch); break;
    case 'task/toggle': state.doc = toggleTask(state.doc, payload.id); break;
    case 'task/remove': state.doc = softDelete(state.doc, payload.id); break;
    case 'task/restore':state.doc = restoreTask(state.doc, payload.id); break;
  }
  state.doc.revision += 1;
  state.doc.updatedAt = Date.now();
  undoStack.push({ action: action, patch: diff(before, state.doc) });  // 简化为快照/补丁
  persistSoon();                        // debounce 300ms
  render();                             // keyed diff，不整页重建
  NC.events.emit('todo:changed', { doc: state.doc, reason: action });
}
```

**渲染/委托（no innerHTML for user data）**

```js
function createRow(task) {
  var li = document.createElement('li');
  li.className = 'todo-item';
  li.dataset.id = task.id;

  var check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'todo-check';
  check.dataset.act = 'toggle';
  check.checked = task.status === 'done';
  check.setAttribute('aria-label', '完成：' + task.title);

  var title = document.createElement('div');
  title.className = 'todo-title';
  title.textContent = task.title;      // 关键：绝不拼 innerHTML
  title.dataset.act = 'open';

  var due = document.createElement('span');
  due.className = 'todo-due';
  due.dataset.role = 'due';
  due.textContent = formatDue(task);
  ...
  return li;
}

list.addEventListener('click', function (e) {
  var actEl = e.target.closest('[data-act]');
  var row = e.target.closest('[data-id]');
  if (!row) return;
  var id = row.dataset.id;
  if (actEl) dispatch(actEl.dataset.act === 'toggle' ? 'task/toggle' : actEl.dataset.act, { id: id });
  else openDetail(id);
});
```

**提醒引擎（页内，`file://` 安全）**

```js
function checkReminders(now) {
  doc.tasks.forEach(function (t) {
    if (t.status !== 'open' || !t.reminder || t.reminder.firedAt) return;
    var at = t.due - (t.reminder.leadMinutes || 0) * 60000;
    if (now >= at && (!t.reminder.snoozeUntil || now >= t.reminder.snoozeUntil)) {
      t.reminder.firedAt = now;
      notifyInApp(t);                    // toast + 标题角标 + 可选提示音
      dispatch('task/reminder-fired', { id: t.id });
    }
  });
}
// tick 对齐分钟并仅在 document.hidden === false 时执行；同时补报“打开页面时已逾期”
```

**跨标签**

```js
window.addEventListener('storage', function (e) {
  if (e.key !== 'ntools.todo.v2' || !e.newValue) return;
  var incoming = safeParse(e.newValue);
  if (!incoming) return;
  if (incoming.revision > state.doc.revision && !dirty.hasPendingWrites()) {
    state.doc = normalizeDoc(incoming);
    render();
  } else if (incoming.revision > state.doc.revision) {
    showConflictBanner('另一窗口已修改待办，点击刷新');
  }
});
```

### 5.7 提醒方案（明确边界）

| 方案 | 可行性 | 结论 |
|---|---|---|
| 系统通知（Notification API） | `file://` 下 `requestPermission()` **已实测返回 `denied`**；无 Service Worker/后台 | **不作为依赖**；能力检测可用时作为增强，不可用静默降级 |
| 页内提醒（toast + 标题角标 + 顶栏逾期计数） | 可靠 | **主方案**；打开页面期间每分钟检查，打开时补报逾期 |
| 提示音 | `AudioContext` 需用户手势解锁 | 首次交互后可选开启；默认关闭或仅角标 |
| 关闭页面后提醒 | 纯前端无后台做不到 | **文档明示**；若未来确需，另立"本地服务/桌面壳"项目 |
| 内网静态托管 + 常驻标签页 | 可行 | 可作为“工作台”使用方式写入 README；不承诺系统级提醒 |

### 5.8 异常与安全边界

1. **XSS**：所有用户文本 `textContent`；导入数据先校验再渲染；Markdown 只用于 nChat 与 MD 工具（必须 DOMPurify）。
2. **脏数据**：不合法字段归一化或进 `quarantine`，绝不进入渲染；`due=NaN` 视为 null；ID 重复重建。
3. **存储**：写前估算大小；写失败回滚 State（或标记“仅内存”）并提示；迁移前备份；`pagehide` flush。
4. **配额**：Todo 文档建议上限：任务 ≤5000 条、`notes` ≤10000 字符、序列化 ≤3.5MB；超限提示导出清理，不静默失败。
5. **时间**：统一 epoch ms 存储、本地时区展示；不使用夏令时假设（中国无 DST，但不硬编码时区）；月份用 `Intl` 或手写格式化，避免 `toLocaleString` 随 locale 漂移。
6. **并发**：`revision` + storage 事件；不做双写/CRDT，冲突时提示用户刷新或保留本地。

### 5.9 Todo 专项验收清单（现场）

- [ ] 冷启动（清空 localStorage）→ 空状态 + 默认清单，无 JS 报错
- [ ] 新增/编辑/完成/删除/撤销/清空已完成 6 条主路径全部通过
- [ ] 导入 v1 备份（含脏数据）→ 迁移成功、提示条数、原键保留、刷新幂等
- [ ] 导入坏 JSON → 明确拒绝、现有数据零变化
- [ ] 标题输入 XSS payload → 纯文本显示、无脚本执行
- [ ] 500 条任务：滚动/切换视图/搜索流畅；60s tick 后滚动位置不跳
- [ ] 关闭/重开页面：视图、筛选、排序、任务、主题全部恢复
- [ ] 双窗口同时编辑：不丢数据、有冲突提示
- [ ] 键盘全流程无障碍；读屏可读状态
- [ ] 麒麟 ARM 目标机 + 奇安信浏览器实机通过（见第 11 章）

---

## 6. nChat 与其他模块优化

> 本章非重点，仅给出"随重构一起做"的清单；详细证据见第 3 章 S/P/R/U 类。

### 6.1 nChat 重构要点（按优先级）

1. **安全收口（P0）**：导入/恢复校验与归一化；渲染改 DOM 构造；API Key 导出默认脱敏；DOMPurify 升级；可选 CSP。
2. **存储（P0/P1）**：`storage.js` 适配器 + 配额降级 + 内存模式；会话加版本号与迁移；二期把图片搬进 IndexedDB（消息只存 `imageId` + 缩略图，导出时再内联，保持旧格式兼容）。
3. **SSE（P0/P1）**：`sse.js` 纯状态机（CRLF、多行 data、`[DONE]` 真正终止、carry buffer、`finish_reason`、流内 error）；`api.js` 负责 URL/payload 白名单、超时、中止、错误映射、`stream_options.include_usage` 可选与回退。
4. **会话模型（P1）**：按 `configId` 分会话；切换配置时提示/新开对话；支持会话列表（标题、时间、删除）——这是"多配置"承诺的自然延伸，建议纳入 P1。
5. **交互（P1）**：IME Enter 修复；流式不锁输入；near-bottom 智能滚动 + 回底按钮；截断确认 + 撤销；错误可重试；统计改点击（触屏/键盘可达）；`aria-live` 流式播报；去掉 `user-scalable=no`。
6. **架构（P1）**：按 4.2/4.4 拆分；`app.js` 只做组合根；主题/Lite 抽公共模块；vendor 改 `defer`；启动自检 `typeof marked`。

### 6.2 工具页与跨页

1. **统一设计令牌**：`ntools.html` 内联 CSS 迁到 `css/tools.css`，颜色/圆角/阴影全部走 `tokens.css`；提供浅色主题（ntools 目前固定深色）；Lite 模式同步。
2. **iframe 内嵌 nChat**：保留但加 `title`；若被企业策略阻断，显示“单独打开 nChat”按钮；长期可通过 `?embed=1` 隐藏内嵌页重复工具栏，并用 `postMessage` 同步主题。
3. **二维码**：生成/下载改为直接操作实例（`canvas.toDataURL`），去掉 `setTimeout` 抢时序；超容量提示；placeholder 复位；按钮禁用态。
4. **图片 Base64**：修 10% 缩放为 `Math.max(1, …)`；按实际输出 MIME 记录；非 base64 SVG 数据先校验；输入大小上限；复制走统一剪贴板工具。
5. **Markdown 工具**：DOMPurify 净化；输入防抖 + 持久化；导入后也写入 localStorage；行数/字数统计。
6. **跨页主题同步**：`file://` 下 localStorage 共享（已实测），可直接复用；内嵌页用 `postMessage` 兜底。
7. **下载**：`downloadBlob` 改为 `document.body.appendChild(a) → a.click() → setTimeout(revokeObjectURL, 1000)`，避免同步吊销导致下载被取消；全部导出统一走该工具并给成功反馈。
8. **依赖版本**：`vendor/` 前加 `polyfills.js`；`marked v15` 依赖 `Array.prototype.at`，不得随意降级/升级主版本而不跑回归。

### 6.3 文档与许可

- 更新 README：**首次部署先跑 `compat-check.html`**；项目结构（当前缺 `ntools.html` 的模块说明）、功能清单（Lite 描述过时）、隐私表述（与密钥导出策略一致）、兼容性要求（内核版本与 polyfill 说明、CORS 要求、两种启动方式）、常见问题（白屏/401/CORS/存储禁用/通知不可用/升级后仍跑旧文件）。
- 新增 `LICENSE`（MIT，README 已声明但仓库缺失）、`THIRD_PARTY_NOTICES.md`（marked MIT、DOMPurify Apache-2.0/MPL-2.0、qrcode.js MIT，附版本与来源）。
- 新增 `docs/architecture.md`（模块图、事件表、存储键表）与 `docs/compatibility.md`（自检页使用说明、现场验证记录）。

---

## 7. 实施路线图与人天估算

> 估算前提：1 名熟悉前端的开发者；已具备目标环境访问权限。按"每个阶段结束都可双击运行"组织。

### 7.1 阶段总表

| 阶段 | 目标 | 主要交付物 | 验收 | 人天 |
|---|---|---|---|---|
| **Phase 0 热修** | 消除安全/数据 P0，建立基线 | `polyfills.js`（`Array.prototype.at` 等）；ntools MD 净化 + DOMPurify 升级；Todo 渲染收口/ID/存储容错；导入校验最小闭环；nChat 存储保护 + 状态复位 + 密钥导出策略；会话/配置导入校验；SSE 关键修复；`compat-check.html` + 目标机基线记录 | P0 优先级清单 13 项通过；目标机可跑；无控制台报错 | 1.5–2 |
| **Phase 1 基础设施** | 建立可复用底座与回归网 | `core.js`、`compat.js`、`storage.js`、`schema.js`、`menus.js`、`theme-boot.js`、`tests.html`、`tokens.css`/`base.css`/`components.css`；行为契约 C1–C11 写入 README；基线截图 | `tests.html` 全绿；两页引用新模块后行为零变化 | 2 |
| **Phase 2 Todo 数据+渲染** | 换掉 v1 数据层与渲染 | `todo-store.js`（含撤销栈）、`todo-view.js`（keyed diff + 委托）、v1→v2 迁移器、导入导出管道 | 迁移/导入 7 类样本通过；列表 500 条滚动不跳；XSS 用例通过 | 2.5 |
| **Phase 3 Todo P0 功能** | 补齐日常可用功能 | 行内编辑/详情抽屉、删除撤销/回收站、视图筛选/搜索/计数、排序、快捷键、a11y 最小集 | T2-1~T2-8 验收全过 | 2.5 |
| **Phase 4 Todo P1 + 视觉** | 进阶功能与统一视觉 | 优先级/多清单/标签/拖拽/提醒/统计/跨标签；ntools 浅色主题 + 令牌统一 + 响应式侧栏 | T3 验收；1366×768 与 1024 宽度可用；Lite/浅色一致 | 2.5 |
| **Phase 5 nChat 分层** | 聊天模块可维护、可测试 | `sse.js`/`api.js`/`message-view.js`/`composer.js`/`settings-store`/`conversation-store`；`app.js` 组合根；会话按配置隔离（P1）；IndexedDB 图片（二选一按需） | C1–C11 回归通过；流式边界用例通过；刷新/配额/多标签场景通过 | 3 |
| **Phase 6 回归与交付** | 目标环境验收与文档 | 手工矩阵、安全用例、性能基准、迁移演练；README/兼容性/许可；发布包与版本说明 | 第 8 章全部通过；现场验收签字 | 1.5 |
| **合计** | | | | **≈15.5 人天** |

### 7.2 里程碑

- **M0（Phase 0 结束）**：安全与数据 P0 清零，目标机基线可用 → 可小范围试用。
- **M1（Phase 2 结束）**：Todo 数据层与渲染完成，功能与现状一致但更稳 → 可替换使用。
- **M2（Phase 3 结束）**：Todo 达到"日常可用"（编辑/筛选/搜索/撤销） → 作为默认待办工具推广。
- **M3（Phase 5 结束）**：nChat 分层完成、安全与配额问题解决 → 全量发布 v2.0.0。

### 7.3 并行与裁剪建议

- **2 人并行**：A 负责"基础设施 + nChat 分层"（Phase 1→5），B 负责"Todo 专项"（Phase 2→4）；Phase 0 与 Phase 6 共同参与，预计 8–9 天。
- **最小可用集（≈6–7 人天）**：Phase 0 + Phase 1（仅 core/storage/schema/tests）+ Phase 2 + Phase 3 的编辑/筛选/搜索/撤销；多清单/标签/提醒/拖拽延后。
- **不建议**：先做 Phase 4/5 的新功能而不做 Phase 0；安全与存储问题会持续放大返工成本。

### 7.4 分支与提交策略

1. 从 `main` 拉 `refactor/v2`；`main` 保持可发布，里程碑打 tag（`v1.0-baseline`、`v2.0.0`）。
2. 每个迁移步骤一个提交，提交信息含阶段编号与验收方式；禁止"大爆炸提交"。
3. 每次提交前跑 `tests.html` + 冒烟清单；涉及 UI 的变更附浅/深/Lite 三张截图。
4. 发布包：`zip` + `SHA256SUMS` + `CHANGELOG.md`；旧版本文档保留回滚说明。

---

## 8. 测试与验收策略

### 8.1 `tests.html`（无框架、双击可跑）

覆盖纯函数（不碰 DOM/localStorage 的部分）：

| 模块 | 用例 |
|---|---|
| `core.util` | escapeHtml 六类字符、uid 唯一性/格式、cssEscape、时间格式化（今天/明天/跨年/超时） |
| `schema` | v1 迁移映射、脏数据隔离、非法 ID/重复 ID、超长截断、`due=NaN`、v2 文档往返归一化幂等 |
| `storage` | 序列化/反序列化、坏 JSON 备份、配额错误分类（mock） |
| `sse` | 单行/CRLF/多行 data/`[DONE]`/流内 error/跨 chunk 标签/空流 |
| `todo-store`（纯逻辑） | add/update/toggle/remove/restore、撤销/重做、revision 递增、筛选/搜索选择器 |
| `api` | URL 拼接（尾斜杠/带 query/已含 path）、payload 白名单、错误映射 |

渲染层用"DOM 断言"：新建 title 含 `<img onerror>` 的任务，断言 `row.textContent` 包含原文、`row.querySelector('img') === null`。

### 8.2 目标环境手工验收矩阵

| 维度 | 取值 |
|---|---|
| 浏览器/内核 | 奇安信可信浏览器（必测）；按公开时间线至少覆盖 **Chromium 83 / 92 / 110** 三档（如现场是 87/89/90/97/102 则按实际档补测）；零改造门槛 92，加 polyfill 后 80–84 可用 |
| 系统 | 麒麟 Linux ARM 实机（必测）；开发机对照 |
| 启动方式 | `file://` 双击（必测）；内网静态托管（建议测；http 与 https 各测一次，注意安全上下文差异） |
| 分辨率/缩放 | 1366×768 @100%、1920×1080 @125%/150%、1024×768（最小） |
| 主题 | 深色、浅色、Lite、系统 reduce-motion |
| 存储 | 正常、写满配额、被禁用、含坏数据、旧 v1 数据、重启浏览器后是否保留 |
| 网络 | 正常、CORS 被拒、401/404/500、流式中断、服务端不关连接、空流、国密 SSL 网关 |
| 输入法 | 中文拼音/五笔 Enter 选词不误发送 |
| 数据 | 空、50 条、500 条、含图片/思考过程/统计的历史 |
| 管控策略 | 禁止复制/下载/开发者工具、退出清站点数据、脚本注入等情况各验证一次 |

**8.2.1 首次部署现场验收 Checklist（约 30 分钟）**

1. 记录 QAX 版本/内核（`chrome://version` 截图）；确认双击 `.html` 由 QAX 打开（`xdg-mime query default text/html`，必要时右键"打开方式"）。
2. 检查 QAX 设置→隐私：站点数据可用、退出不清数据、未禁用复制/下载/开发者工具。
3. 打开 `compat-check.html`：全绿或所有降级项已知；`Array.prototype.at` 必测（决定 marked 是否需要 polyfill）。
4. 保存配置 → 刷新 → 仍在；**重启浏览器 → 仍在**（排除"退出清数据"策略）。
5. 发一条消息：流式逐字出现（若整段一次性出现 = 网关/代理缓冲 SSE，需查网关配置）。
6. 停止生成可用；Markdown/代码块/表格渲染正常。
7. 复制按钮在 `index.html` 与 ntools 内嵌 nChat 各测一次。
8. 导出配置/导出对话/备份对话 → `~/下载` 有文件、文件名正确、能重新导入。
9. 图片上传（完整版）压缩与回显正常。
10. ntools 五个 tab 正常；中文输入法选词回车不误发；Lite 切换有效且刷新记忆。
11. HiDPI 125%/150% 下布局不溢出、按钮可点。
12. 断网后页面仍可打开（离线依赖）；跨目录升级后旧配置/对话仍在。
13. 滚动长聊天记录/长待办列表无明显卡顿；卡则默认 Lite。
14. 升级包校验 SHA-256、版本号显示正确（`NC.version`）。

### 8.3 安全测试用例（每项必须 PASS）

1. Todo 标题/详情/标签注入 `<img src=x onerror=...>`、`<script>`、`"><svg onload=...>` → 纯文本显示、无执行。
2. 导入 Todo JSON：`{}`、`[]`、`[null]`、字符串 ID、重复 ID、`__proto__` 字段、超长字段 → 明确结果、页面不崩、无副作用。
3. 恢复会话备份：图片 URL 注入 `"><img onerror=...>`、stats 注入 HTML、id 注入引号 → 拒绝/转义，无执行。
4. ntools Markdown 预览：`<img src=x onerror=...>`、`[x](javascript:alert(1))`、mXSS 经典 payload → 无执行（DOMPurify 生效）。
5. 导入配置：`__proto__` 污染、非法 URL、超长字符串 → 白名单归一、无原型污染。
6. 导出配置默认不含 `apiKey`；勾选包含时有二次确认；导入后密钥为空。
7. 错误提示不包含 API Key/完整请求头；控制台无敏感信息。

### 8.4 性能基准（ARM 目标机）

| 场景 | 目标 |
|---|---|
| Todo 500 条：首屏渲染 | ≤300ms；滚动无可感知卡顿 |
| Todo tick（60s） | 不重建 DOM、不丢滚动位置；CPU 占用接近 0 |
| 切换视图/搜索 | ≤100ms 反馈（500 条） |
| 聊天长回答（≥3000 字，含代码块） | 流式渲染不卡顿、无 `O(n²)` 卡死；首 token 即显 |
| 存储写入 | 每次 ≤50ms；流式期间不阻塞渲染 |
| 冷启动 | ≤1s（本地文件）；无白屏 |

### 8.5 数据迁移演练

1. 用真实 v1 导出文件（建议收集 3–5 份用户实际数据）跑迁移器。
2. 构造 7 类样本：正常 v1、含字符串 ID、含重复 ID、含 `null` 项、含 NaN due、超长 title/notes、v2 往返。
3. 验证：合法条数、字段合规、幂等（连续加载两次不重复迁移）、v1 键保留、失败可回滚。
4. 演练"迁移中关闭页面/写满配额"两种中断场景。

### 8.6 行为契约（重构回归清单，建议写入 README）

| 编号 | 契约 |
|---|---|
| C1 | `index.html`/`ntools.html` 双击（`file://`）可用；零构建、零外网依赖；两页共享配置/对话（Chromium 机制已实测共享，目标机复核后更新 README） |
| C2 | 首启默认配置与欢迎语；主题首访跟随系统、之后记忆；Lite 记忆 |
| C3 | 配置新建/删除（至少保留 1 个）/切换（两处入口）；保存后提示"已保存"；刷新不丢；字段语义与范围（temp/top_p 0–2）不变；导入兼容旧版单配置 |
| C4 | Enter 发送、Shift+Enter 换行；空白且无图不发送；配置缺失提示；图片最多 5 张、压缩参数不变、可预览/删除/灯箱；请求为 `{base}/chat/completions`、Bearer 鉴权、`stream:true`、system prompt 置首、advanced 才带 temp/top_p |
| C5 | 流式逐字显示；首 token 前 typing indicator；思考过程实时展示、结束折叠并显示用时、刷新后仍可查看；停止保留已生成内容并持久化；错误红条不持久化；流结束无残留转圈；统计含 Prompt/Output/Total/Rate/Time 且缺省按 0 处理 |
| C6 | 消息操作：复制（对勾反馈）/重新生成（截断后重发）/编辑（user 编辑后自动重发、assistant 仅改内容）/删除（确认）；流式期间按钮禁用、发送按钮变停止 |
| C7 | 会话自动保存、刷新恢复（图片/思考/统计）；导出 Markdown 文件名与内容格式；备份 JSON 形状 `{version,timestamp,conversation}`；恢复/清除的提示与行为；error 不入历史 |
| C8 | 存储键名与形状保持兼容；升级可读旧数据；迁移前保留 `*-v1-backup` |
| C9 | 深浅色/Lite/消息气泡/Markdown/统计 tooltip/模态/灯箱/设置面板/768 断点视觉不回退（基线截图对比） |
| C10 | 所有外部内容渲染必须 DOMPurify 或等强净化；API Key 不进导出文件；导入数据校验后才落盘 |
| C11 | 无 window 泄漏（除 `NChat` 命名空间与过渡别名）；`index.html` 无内联脚本；纯函数有 `tests.html` 覆盖 |

---

## 9. 风险与缓解

| # | 风险 | 概率/影响 | 缓解 |
|---|---|---|---|
| R1 | 奇安信内核低于预期：83–91 时 marked v15 因 `Array.prototype.at` 直接崩（聊天正文全挂）；<80 时 `?.`/`??` 语法错误白屏 | 中高/致命 | 第 0 天现场 `chrome://version` 确认；`compat-check.html` 自检；`polyfills.js` 兜底（约 0.5 小时）；83 再补 flex-gap，<80 手工降级 12 处语法（约 0.5 人天）；极端情况回退 marked v4/v9 |
| R2 | `file://` → 内网 API 的 CORS/混合内容被拦截，聊天完全不可用 | 中/致命 | Phase 0 首日验证；网关放行 `Origin: null`；备选内网 nginx 同源托管/反代；README 写排查步骤 |
| R3 | 数据迁移失败/用户数据丢失 | 低/高 | 迁移前冻结备份；迁移器永不 throw；坏数据 quarantine；提供“恢复上一版” |
| R4 | 存储被企业策略禁用 | 中/高 | 内存模式 + 醒目横幅 + 数据下载；Phase 0 现场验证 |
| R5 | 拆分后 CSS 视觉回退（1443 行大量后代选择器） | 中/中 | 迁移期冻结类名/结构；三断点 × 三主题基线截图对比 |
| R6 | 隐式 autosave 改显式 store 后漏写/双写 | 中/中 | storage trace 日志；冒烟清单逐项核对“刷新后是否还在”；先加适配器再改调用点 |
| R7 | 流式渲染节流导致“打字机”手感变差 | 中/低 | 首 token 立即、60ms 节流可配置、保留旧渲染 feature flag 兜底 |
| R8 | 范围蔓延（新功能越加越多） | 高/中 | 严格按 P0/P1/P2 冻结；P2 不进 v2.0；每阶段有明确验收 |
| R9 | 无测试/无构建导致回归成本高 | 高/中 | `tests.html` + 行为契约 + 冒烟清单 + 每步可运行；关键纯函数优先抽离 |
| R10 | 依赖升级（marked/DOMPurify）引入行为差异 | 中/低 | 升级后跑安全用例 + 历史对话回归；vendor 记录版本与 SHA-256，保留旧版回滚 |
| R11 | 多人/多任务并行写同一文件 | 中/中 | 按阶段划分写域；`app.js` 组合根最后由一人改；每次合并前跑 `tests.html` |
| R12 | 升级后浏览器缓存旧 JS | 中/低 | 发布包版本号 + 版本查询串 + README 强刷说明；`NC.version` 在控制台/页脚可见 |

---

## 10. 范围边界（明确不做什么）

1. **不引入框架/构建链/包管理/Service Worker**：保持"文件夹双击即用"。
2. **不做后端、账号体系、云端同步、多端同步**：数据仍只在本机浏览器。
3. **不重写 UI 视觉**：保留现有风格语言，只统一令牌、修可访问性与响应式。
4. **不改 API 协议**：继续使用 OpenAI 兼容 `/chat/completions` + SSE；不做 Anthropic/Gemini 原生协议适配（可作为后续独立需求）。
5. **不做系统级提醒/后台常驻**：`file://` 纯前端无法做到；除非未来另立桌面壳或本地服务项目。
6. **不做复杂协作能力**（共享清单、多人编辑、CRDT）。
7. **不做密码学意义上的加密保险箱**：可选的本地口令加密只用于"共用电脑防顺手看"，并明确说明不防 XSS/内存读取。
8. **不追求 100% 无障碍认证**：先做到键盘全流程可用、读屏可读关键状态、对比度达标。
9. **不在本次改造 `img/main.png` 等非代码资产**（可在发布包中排除截图以减小体积）。

---

## 11. 待现场验证清单

> 建议 Phase 0 第一天在目标机完成，结果记入 `docs/compatibility.md`；未验证项不得对外宣称"已支持"。

| # | 验证项 | 初查结论（待现场确认） | 方法 / 影响 |
|---|---|---|---|
| V1 | 奇安信内核版本 | 公开时间线 83→87→89→90→97→102→110→132；实际安装版本**无法由公开资料推定** | `chrome://version` 记录；决定 polyfill/语法基线 |
| V2 | `file://` localStorage 可用与共享 | 本机实测可用且**全机共享**（跨目录、index/ntools 互通）；Firefox 才隔离；策略可能禁用/退出清理 | 两目录交叉读写 + 重启后 marker；影响数据模型/README |
| V3 | 安全上下文/剪贴板/加密 | 本机实测 `file://` 为安全上下文，用户手势下 `writeText` 可用；`http://内网IP` 托管则不可用；BDLP 可禁复制 | `isSecureContext` + 实际复制/`crypto.subtle`；影响复制与可选加密 |
| V4 | `file://` → 内网 API 的 CORS | 本机实测 POST/OPTIONS 均带 `Origin: null`，JSON+Authorization 触发预检；`file→http` **不受**混合内容拦截，但 https 托管→http API 会被拦 | Network + 网关日志；**上线第一阻塞项**；网关放行 ACAO `*`/`null` + `POST,OPTIONS` + `authorization,content-type` |
| V5 | `Notification` | 本机实测 `requestPermission()` 返回 `denied` | 自检页显示；提醒按页内方案（预期一致） |
| V6 | iframe 嵌入本地 `index.html` | 本机实测可显示；`file→file` 跨源，父页拿不到 `contentDocument`；localStorage 共享 | 打开 nChat tab + 控制台；影响工具集形态与主题同步 |
| V7 | Blob 下载 | 本机实测 `blob:null` + `a[download]` 落盘成功；同步 revoke 可能取消下载；企业下载策略可能拦截 | 实际导出 4 类文件；影响备份/导出兜底 |
| V8 | 多标签同步机制 | 待验证：`storage` 事件 / `BroadcastChannel` 在 `file://` 是否触发 | 双窗口交叉修改；影响跨标签实现 |
| V9 | 中文字体/HiDPI | 待验证：`fc-list :lang=zh`；Noto Color Emoji 是否缺失（💬👤🤖 豆腐块） | 125%/150% 截图对比；影响字体栈与 emoji 降级 |
| V10 | ARM 软渲染性能 | 待验证：国产 GPU 驱动常默认关硬件加速，`backdrop-filter` + 无限渐变是主要卡顿源 | `chrome://gpu` + rAF 帧率；决定默认 Lite |
| V11 | 目标 API 行为 | 待验证：`stream_options.include_usage`、`reasoning_content`、`<think>` 标签、错误体格式、鉴权头、是否国密 SSL | curl/最小页面对接；影响统计/思考/错误提示 |
| V12 | 中文输入法 Enter | 待验证（麒麟 fcitx5/ibus 拼音/五笔；QAX 可能抢快捷键） | 实测选词回车；影响 IME 修复验收 |
| V13 | 企业策略注入/内联脚本 | 待验证（部分管控会注入脚本或限制内联事件） | 控制台 + 页面行为；影响 CSP 与内联事件改造节奏 |
| V14 | 真实 v1 数据样本 | 待收集（Todo 与会话各 3–5 份，含可能的历史脏数据） | 用户导出文件；影响迁移器演练 |
| V15 | 升级分发与缓存 | `file://` 无 HTTP 缓存、覆盖即生效；nginx 托管需 `no-cache` | zip 覆盖后检查 `NC.version`；影响发布流程 |
| V16 | 国密 SSL（SM2） | 待验证：若内网 API 走国密证书，普通 Chrome 测试机可能连不通，仅奇安信可通过 | 用 QAX 与 Chrome 对照请求；影响验收分工 |
| V17 | QAX 管控策略（BDLP） | 待验证：是否禁复制/打印/右键/下载/开发者工具；是否退出清站点数据 | 对照产品策略逐项试；影响剪贴板/下载/存储兜底 |
| V18 | 双击 `.html` 默认程序 | 待验证：麒麟默认浏览器可能不是 QAX；`xdg-mime query default text/html` | 影响启动方式与用户指引 |
| V19 | `Array.prototype.at`/polyfill | 本机实测 <92 时 marked 抛 `TypeError: t.at is not a function`，1 行 polyfill 可修复 | 目标机 console 跑 `typeof [].at` 与 `marked.parse('**x**')`；**P0** |
| V20 | 存储持久性（策略） | 待验证：写 marker → 重启浏览器 → 再读 | 判断"退出清数据"策略；影响内存模式提示 |

---

## 12. 附录

### A. 关键证据索引（节选）

| 主题 | 位置 |
|---|---|
| Todo 顶层存储解析 | `ntools.html:459` |
| Todo 写盘与渲染 | `ntools.html:466–469`、`540–577` |
| Todo XSS/ID 拼接 | `ntools.html:560–575` |
| Todo 导入 | `ntools.html:588–601` |
| Todo 定时器/排序副作用 | `ntools.html:463`、`545–548` |
| Todo 时间语义 | `ntools.html:474/477/483/487–488`、`523–531` |
| Todo 详情弹窗 | `ntools.html:371–381`、`507–521` |
| ntools MD 无净化 | `ntools.html:8–9`、`660` |
| nTools 内联脚本/CSS | `ntools.html:383–802`、`11–202` |
| API Key 存取/导出 | `app.js:245–247`、`294–297`、`971` |
| 会话存储无保护 | `app.js:365–367`、`598`、`911`、`916` |
| 会话恢复无校验 | `app.js:1017–1027` |
| 图片 dataURL 入历史 | `app.js:620–647`、`943` |
| SSE 解析循环 | `app.js:769–854` |
| `[DONE]` 仅 break 内层 | `app.js:773–790` |
| 思考标签状态机 | `app.js:804–843` |
| 请求夹带统计/思考字段 | `app.js:741` |
| 统计详情重复实现 | `app.js:531–541`、`896–906` |
| 设置状态副本 | `app.js:218–242`、`275–301`、`935–937` |
| 流式期间锁输入 | `app.js:665–671` |
| IME 回车 | `app.js:1073` |
| 强制滚底 | `app.js:590/699/815/851` |
| 主题/Lite | `app.js:62–118`；`css/style.css:1–21`、`37–101` |
| viewport 禁止缩放 | `index.html:6` |
| 全局无 aria/role | `index.html`、`ntools.html`（0 处） |

### B. 第三方依赖与许可

| 库 | 版本 | 许可 | 用途 | 备注 |
|---|---|---|---|---|
| marked | 15.0.12 | MIT | Markdown → HTML | **依赖 `Array.prototype.at`（Chromium 92+），必须配 `polyfills.js`**；锁定版本并记录 SHA-256 |
| DOMPurify | 3.0.6 | Apache-2.0 / MPL-2.0 | XSS 净化 | **建议升级至 3.4.x** |
| qrcode.js | 无版本标记 | MIT | 二维码生成 | 建议补版本来源说明或替换为可维护版本 |
| 自有代码 | — | MIT（README 声明） | — | 需补 `LICENSE` 文件 |

### C. v1 → v2 迁移速查

```
根数组                       → { schemaVersion:2, revision:1, updatedAt, lists:[默认清单], tasks, settings, meta }
id: Date.now()               → "v1-<oldId>"（确定性、幂等、去重）
title                        → title（trim；空→quarantine；>500 截断+notes 记录）
content                      → notes（默认 ""；>10000 截断+标记）
due: number|NaN              → due: 合法 epoch ms 或 null；dueAllDay:false
completed: boolean           → status: "done"/"open"；completedAt:null
—                            → listId:"list_default"、priority:"normal"、order:index*1024、tags:[]、subtasks:[]、
                               recurrence:null、reminder:null、deletedAt:null、source:"migrated_v1"、createdAt/updatedAt:迁移时刻
```

### D. 术语

| 术语 | 说明 |
|---|---|
| P0/P1/P2 | 优先级：P0 数据安全/整体不可用/上线阻塞；P1 高频体验或稳定隐患；P2 打磨项 |
| keyed diff | 按稳定 ID 复用/移动/更新 DOM 节点，而非整树重建 |
| 组合根 | 只负责初始化模块、注入依赖、订阅事件的最外层入口 |
| quarantine | 导入时无法归一化、但保留在文档 `meta` 中供用户查看/下载的脏数据 |
| 行为契约 | 重构前后必须一致的用户可见行为清单（8.6 C1–C11） |
| 内存模式 | 存储不可用时，数据只保存在当前页面内存中并明确提示 |

### E. 参考来源（兼容性与环境查证）

**奇安信可信浏览器内核时间线（官方）**

- Chromium 83（2020-07）：https://www.qianxin.com/news/detail?news_id=328
- Chromium 87（2020-09）：https://www.qianxin.com/news/detail?news_id=664
- Chromium 89（2020-11）：https://www.qianxin.com/news/detail?news_id=789
- Chromium 90（2021-01）：https://www.qianxin.com/news/detail?news_id=889
- Chromium 97（2021-10）：https://www.qianxin.com/news/detail?news_id=2504
- Chromium 102（2022-05）：https://www.qianxin.com/news/detail?news_id=4995
- 申威平台"Chromium 90 以上"：https://www.qianxin.com/news/detail?news_id=4023
- Chromium 110：https://mp.weixin.qq.com/s?__biz=MzU0NDk0NTAwMw==&mid=2247581879&idx=2&sn=19eb2a7dc7f2d319c2c9a475bd625168
- Chromium 132：https://mp.weixin.qq.com/s?__biz=MzU0NDk0NTAwMw==&idx=1&mid=2247624041&sn=d2b675e4ae32666d3188c4bb9b49cf55

**Web 平台兼容性**

- MDN Browser Compat Data（`Array.json` / `gap.json` / `backdrop-filter.json` / `ResizeObserver.json` / `Crypto.json` / `Clipboard.json` / `Notification.json`）：https://github.com/mdn/browser-compat-data
- caniuse flexbox-gap：https://caniuse.com/flexbox-gap
- caniuse css-grid：https://caniuse.com/css-grid
- MDN Clipboard API（安全上下文要求）：https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API
- MDN CORS 错误 CORSRequestNotHttp（`file://` 下 ESM 被拒）：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSRequestNotHttp
- MDN `Access-Control-Allow-Origin`（不建议设 `null`，优先 `*`）：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Origin

**Chromium 源码（混合内容与安全上下文判定）**

- `scheme_registry.cc`（混合内容只对 https 源生效）：https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/weborigin/scheme_registry.cc
- `security_origin.cc`（`file://` 视为可信源）：https://chromium.googlesource.com/chromium/src/+/53378481ea3dfd52d2209bcf49ef55b34e4ff2b3/third_party/blink/renderer/platform/weborigin/security_origin.cc

**奇安信产品与麒麟生态**

- 奇安信可信浏览器产品页（BDLP 可配置禁复制/打印/右键/下载/开发者工具）：https://www.qianxin.com/product/detail/pid/468
- 麒麟软件解决方案页（信创场景）：https://www.kylinos.cn/product/solution/scene/solutionIndustry/commonIndustry/2059527978686189570.html

> 说明：上述内核时间线为"先锋版"公开资料；国企实际安装版本与先锋版的对应关系无公开对照表，**必须现场实测**。`file://` 行为结论来自本机 Chromium 150 实测复现，目标机需按第 11 章复核。

---

> **再次说明**：本文档仅为评估与方案，未执行任何代码修改。执行前建议先完成第 11 章 V1–V4、V19 现场验证，并确认第 7 章排期与范围。
