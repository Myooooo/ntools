# nTools v4.4 交付报告（到期染色 / 回收站 / 仓库清理）

> 日期：2026-11-13 ｜ 基线：Chromium 102 / 麒麟 ARM / `file://`

## 1. 需求对照

| # | 反馈 | 交付 |
|---|---|---|
| 1 | 优化三天内到期染色：当天到期应为红色，逾期深红 | `heatClass` 从“72 小时窗口”改为**日历天**：逾期→`heat-overdue`（深红）、今天→`heat-3`（红）、明天→`heat-2`（橙）、后天→`heat-1`（黄）、≥3 天/完成/取消/无 due/回收站→不染色。每日 tick 自动跨日更新；深/浅主题使用独立 `--heat-*` 色（浅色下 warning 与 priority-high 同色，故新增橙/红专用值），Lite 降低不透明度。当天 0.34、逾期 0.54，逾期明显更深。 |
| 2 | 回收站行按钮改为恢复/彻底删除；页面加清空回收站按钮 | trash 视图行加 `is-trash`：仅显示恢复（↻）与彻底删除（红色 hover），隐藏置顶/编辑/删除/完成勾选框，按钮常显；恢复 `restoreTask` + toast，彻底删除 `ui.confirm → purgeTask`。页头注入「清空回收站」危险按钮（仅 trash 且有数据时显示），走既有 `confirm → clearTrash`，清空后自动隐藏；390/320 可见且无横向溢出。 |
| 3 | 移除多余文件和缓存，包括过期 docs，并提交 | 删除 8 份过期 docs：`refactor-and-optimization-plan.md`、`v2/v3-implementation-report.md`、`dev-contract.md`、`dev-contract-v3.md`、`v41/v42/v43-release-report.md`。保留 architecture、compatibility、design-direction-v4、design-break-audit、animation-audit-v4.1、timeline-view、v4-design-report，本报告。代码/工具注释中的旧文档引用统一改指 `docs/architecture.md` 或删除；demo 文案去 dev-contract。仓库检查无 `.DS_Store`/`*.bak`/`*~`/`*.tmp`/`__pycache__`/空目录/未引用资产；`.gitignore` 已覆盖缓存，vendor 库保留。 |

## 2. 关键实现

- **热区**：`heatClass(task, now)` 用 `util.startOfDay` 计算日历日差；`syncHeatClass` 在每分钟 tick 调用；CSS 使用 `.todo-item` 级 `--heat-1-color`…`--heat-overdue-color`（深/浅主题各一套），`::before` 整行 90° 渐变，正文/勾选/操作在上层。
- **回收站**：行操作按钮在 `createTaskNode` 中同时创建 pin/edit/delete 与 restore/purge，`updateTaskNode` 按 `ui.view === 'trash'` 切换显隐；行 checkbox `hidden`；清空按钮由 `ensureTrashClearButton()` 注入页头并在 `render` 中同步 hidden。
- **清理**：`git rm` 8 个 docs；逐文件更新 js 注释；`docs/compatibility.md` 删除失效引用；README 结构树与链接同步精简。

## 3. 验收

| 检查 | 结果 |
|---|---|
| `bash tools/check.sh` | **7/7 全绿**（verify 3 页 / e2e / e2e-features 53 / e2e-timeline 58 / e2e-v41 / tests 81） |
| `node tools/e2e-v41.js` | 全 PASS：新日历天热区断言（今天/明天/后天/4 天后/逾期/完成）、回收站按钮、四态 seg、时间线 |
| `node tools/verify.js` | 3 页全 PASS，console/资源 0 error |
| `node tools/run-tests.js` | 81/81 |
| 手检 | 今天=红、逾期=深红、明天=橙、后天=黄；回收站行仅恢复/彻底删除、无 checkbox；页头清空按钮出现/隐藏/确认；320/390 无溢出；grep 无 active 文件引用已删 docs |
| 截图 | `/tmp/nc-shots/task23/`（深/浅/Lite 染色、滚动四档、回收站桌面/390/320） |

## 4. 已知限制

- 浅色主题橙/黄使用新增 `--heat-*` 专用变量（tokens 暂无独立 orange/amber 语义色）；后续可替换。
- 热区 opacity 为视觉取值（0.20/0.26/0.34/0.54），可按实际显示器再调。
- 回收站行仍可点击打开详情，详情内恢复/彻底删除逻辑保持原样。
- 历史 v2/v3 内容已从仓库删除；README 版本变更保留各版本摘要。
