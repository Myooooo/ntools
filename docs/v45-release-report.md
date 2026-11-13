# nTools v4.5 交付报告（设计复检 / 交互修复 / 旧端点兼容）

> 日期：2026-11-13 ｜ 基线：Chromium 102 / 麒麟 ARM / `file://`
> 设计技能：`frontend-design`、`apple-design`、`emil-design-eng`；审计：[design-review-v4.5.md](design-review-v4.5.md)、[design-qa-v4.5.md](design-qa-v4.5.md)

## 1. 需求对照

| # | 反馈 | 交付 |
|---|---|---|
| 1 | 用前端设计 skills 全面重检并优化界面 | 按 Precision Workbench 方向复检 5 个 tab、侧栏、设置、聊天、详情、时间线；输出设计复检与 QA 报告，并实施：标签右栏贴按钮左缘（A）、详情操作条粘性可达、侧栏收起/展开反馈、设置端点列表发丝分隔/对比度/端点计数/显式旧配置导入、页头操作区中线统一、QR 工作台收拢、Markdown 统计去中点串、Toast 抬到输入 dock 之上、聊天工具栏层级/端点元信息/状态点/切换反馈。 |
| 2 | 折叠后折叠按钮覆盖 logo | 根因：按钮点击后保留 `focus-within`，收起态的居中展开按钮被强制 opacity 1 覆盖 logo；同时基础规则错误地在收起态显示按钮。修复：移除收起态的强制显示、鼠标点击后 `blur()`、展开态按钮改为低对比度提示（0.42）、收起态仅 logo 悬浮/键盘聚焦时显示展开按钮。 |
| 3 | Todo 标签应贴右侧按钮左边 | tags 从 titleline 移到行级右侧栏：`check → body → tags → actions`；与 actions 垂直中线一致（dy=0），右缘距 actions.left 10px；无标签不占位；长标签截断 +N；320/390/1440、深浅/Lite 验证。 |
| 4 | 详情叉失效；保存后应关闭详情 | 关闭叉现在 `flushDetailEdits + clearSelection`（selectedId=null），桌面列真正收起、移动抽屉关闭（此前仅 drawerOpen=false 但选中未清空）；「保存」改为保存并关闭（toast「已保存并关闭」）；左上 checkbox 仍只负责完成。 |
| 5 | nChat 模型端点配置未正确读取，应兼容 | `ntools.llm.v1` 已存在时也一次性合并旧 `nchat-settings`（{currentId,configs[]} 或单对象），字段归一 `apiUrl→baseUrl`、`systemPrompt→chatSystemPrompt`、`top_p→topP`；按 id→baseUrl+modelId 去重，默认占位采纳旧 id 以保留旧会话；`legacyMerged` 标记防止重复导入/删除复活；设置 → 模型端点新增「从旧 nChat 导入」；首次合并 toast 提示。 |

## 2. 设计复检（Before / After 摘要）

| Before | After | 依据 |
|---|---|---|
| 侧栏收起后展开按钮居中覆盖 logo | logo 居中；仅悬浮/聚焦时原位变为展开按钮；展开态按钮常显低对比度提示 | apple-design / frontend-design |
| Todo 标签在标题行右端，与按钮不同垂直中线 | 行级右栏，标签/按钮同中线，gap 10px | frontend-design / emil |
| 详情底部长内容时操作条滚出视口 | `.detail-foot` sticky bottom，保存/删除始终可达 | apple-design |
| 设置端点列表 `model · url` 圆点分隔、text-3、行高 110px | 发丝分隔、text-2、行高 70px、操作作 overlay、区头关键数字、旧配置导入入口 | frontend-design |
| 页头操作区底对齐导致 MD 页中线差 23.8px | `.tools-head` 统一垂直居中（QA delta 0） | frontend-design |
| Markdown「109 字符 · 7 行」中点串 | 全角间距分列，无中点 | 设计方向 §2.3 |
| 逾期 toast 固定底部 20px，覆盖 chat 输入 dock/详情 footer | toast 提升到 88px + safe-area，浮于 dock 上方 | emil / QA O1 |
| 回收站 hover 未门控 | 包 `(hover:hover) and (pointer:fine)`，break-ui 86/86 门控 | mobile-native |
| 聊天工具栏端点/模型/主机同权重，无切换反馈 | 端点 600 字重、模型 mono、主机发丝分隔、状态点 title、aria-live + toast + 淡化；流式中切换先 finalize 旧会话 | frontend-design / apple |
| QR 1440 两列间距过大、下方空置 | 工作台 max-width 920、gap 28，构图收拢 | frontend-design |

## 3. 主要文件

| 文件 | 变更 |
|---|---|
| `css/rail.css` / `js/ntools-app.js` | 收起态 logo/展开按钮互斥与焦点处理；展开态提示；点击 blur |
| `css/tools.css` / `js/todo-view.js` | 行级 tags 右栏、详情关闭清选中、保存并关闭；回收站 hover 门控 |
| `css/interaction.css` | 详情 sticky footer、页头中线、设置操作 overlay、QR 收拢 |
| `css/settings.css` / `js/settings-panel.js` | 端点列表可读性、端点计数、从旧 nChat 导入 |
| `js/llm-store.js` | 旧 nchat-settings 一次性合并/去重/currentId/legacyMerged/importLegacy |
| `js/chat-embed.js` / `css/chat.css` | 工具栏层级、端点状态、切换反馈、流式中切换安全 |
| `js/markdown.js` | 统计去中点串 |
| `tools/e2e-v41.js` | tags 间距/中线、关闭叉/保存关闭断言 |
| `docs/design-review-v4.5.md`、`docs/design-qa-v4.5.md` | 设计复检与 QA 报告 |
| `tools/design-shots.sh` | 新增 `NC_SHOT_MODE=qa` 全页面设计截图/自检分支 |

## 4. 验收

| 检查 | 结果 |
|---|---|
| `bash tools/check.sh` | **7/7 全绿**（verify 3 页 / e2e / e2e-features 53 / e2e-timeline 58 / e2e-v41 / tests 81） |
| `node tools/e2e-v41.js` | 全 PASS：tags 右缘/中线、关闭后 selectedId null + detail 隐藏、保存落库 + 关闭、侧栏悬浮、legacy 端点等 |
| 旧端点兼容自测 | 17/17：KEY+legacy 合并、旧 id/currentId、下拉/meta、只导入一次、删除不复活、无 legacy 不变、单对象格式、显式导入 |
| 设计 QA | 63 项自检全 PASS、issues 0；`break-ui` 32 组 0 问题、移动端 14/14（hover 86/86 门控） |
| 截图 | `/tmp/nc-shots/v45/qa/`（80 张全页面矩阵）、`/tmp/nc-shots/v45/final/`（关键状态） |

## 5. 已知限制

- 无头 Chrome 无法截图原生 `<select>` 展开浮层；端点下拉以聚焦态/当前值/设置列表三图验证，真机可再确认。
- 旧 nChat 真实数据可能包含非标准 `configs`（缺失 id、字符串 id、超长 systemPrompt），已归一但建议现场用真实旧配置跑一次迁移。
- 移动端 390 行尾 tags + 常显操作仍会压缩长标题（QA O6）；当前取舍是标签完整显示，必要时可把操作收进详情。
- 触屏真机的粘滞 hover、软键盘遮挡、safe-area 实机观感仍需现场复核。
