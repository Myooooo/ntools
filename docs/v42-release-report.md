# nTools v4.2 交付报告（界面细节 / 全景时间线语义修正）

> 日期：2026-11-13 ｜ 基线：Chromium 102 / 麒麟 ARM / `file://`
> 关联：[v4.1 交付报告](v41-release-report.md)、[timeline-view.md](timeline-view.md)

## 1. 需求对照

| # | 反馈 | 交付 |
|---|---|---|
| 1 | Todo 行内勾选框、时间、标签、按钮没有垂直居中 | `.todo-item` 改为 `align-items:center`；checkbox margin 归零；时间槽 `top:50% + translateY(-50%)`；并修复 v4.1 热区引入的 `.todo-item > * { position:relative }` 层叠 bug（它会把绝对定位的时间槽/操作按钮拉成 relative、整体偏上 13px）。实测桌面深/浅/Lite 每行 row/chk/body/action/due 中心差 0–1px；移动端时间槽按设计回到 meta 行内。 |
| 2 | 侧栏收起后 logo 居中，悬浮变成展开按钮 | 收起态 logo 居中；悬浮/键盘聚焦时 logo 淡出并让位给居中的「展开」按钮（chevron），点击展开；展开态保留右上角收起按钮；状态持久化。 |
| 3 | 示例数据加入循环任务用于测试 | demo 数据新增「每日站会同步」（daily）与「每月账单核对」（monthly），加上原「整理本周会议纪要」（weekly），共 3 个循环任务；`?demo=1` 与菜单「载入示例数据」都可见，可验证完成推进。 |
| 4 | 点击 Todo 行后的右侧详情栏右上角加关闭叉 | `.detail-close` 桌面+移动常显在详情头部右上角，点击 `closeDrawer`；与「清除截止时间」的 X 在形状/位置上区分。 |
| 5a | 全景视图显示创建时间→目标时间的长度，而非固定长度 | 任务条宽度 = `min(due, range.end) − max(createdAt, range.start)` 按比例尺计算；极短任务最小 48px 且右端锚定 due；左/右裁剪有虚线与标记；条内显示「开始 → 到期 · 时长」，title/aria 含完整时间与是否裁剪。 |
| 5b | 全景视图不需要显示没设定时间的待办 | 移除 `.tl-nodue` 区块、无日期统计/图例/计数；`collect` 只处理有 `due` 的任务，空状态/范围外计数重新校准。 |
| 5c | 全景视图时间范围选择框没有对齐 | 横向：起止输入 180×32 等宽等高，与预设组/显示已完成/扩展按钮同一底部基线；纵向：2 列等宽网格、≤560px 单列堆叠；e2e 用 rect 断言横/纵对齐。 |
| 5d | 全景视图左侧分组和状态筛选应生效 | `collect` 改用 `todoStore.selectVisible(now).tasks`，全部/今天/逾期/已完成、清单、搜索全部生效；「显示已完成」与 `doc.settings.showCompleted` 单一状态；`todo:changed` 自动重绘，不重复 mount；纵向流水同数据源。 |
| 5e | 切换全景按钮位置会变、过渡突兀 | 切换按钮移入标题行（主区左缘固定），四态（列表+详情开/关、全景、切回）rect 完全一致 `{x:540,y:26,w:89,h:33}`（1440），±1px；timeline 隐藏按钮用 `visibility:hidden` 保留占位；状态与 active 即时，新视图 180ms opacity+4px 淡入（Lite/reduced 即时）。 |
| 5f | 默认范围导致时长条全部左缘裁剪 | 默认范围数据化：start = 过滤后最早 createdAt（取整到小时、不早于 now−45d）；end = max(now+7d, start+7d, 近窗最晚 due)，跨度上限 60d；「重置」回到该范围；长范围日标签 7 天降采样；首次挂载滚动定位到「现在」。默认条完整显示创建→到期，手动缩小范围时才出现裁剪标记。 |

## 2. 主要文件

| 文件 | 变更 |
|---|---|
| `css/tools.css` | 行垂直居中、热区层叠修复、详情关闭叉常显、模式切换按钮入标题行、切换淡入、移动端 due 复位 |
| `js/todo-view.js` | seg 插入标题行与四态稳定、详情关闭叉、模式切换 180ms 类、过滤刷新链路 |
| `js/todo.js` | demo 新增 daily/monthly 循环任务 |
| `js/todo-timeline.js` | createdAt→due 时长条、裁剪标记、无日期移除、selectVisible 过滤、showCompleted 单一状态、数据化默认范围 |
| `css/timeline.css` | 时长条形状/裁剪标记、范围控件横向+纵向对齐、移除无日期样式、移动端对齐 |
| `css/rail.css` | 收起态 logo 居中 + 悬浮变展开按钮 |
| `tools/e2e-timeline.js` | 58 断言（时长比例/裁剪/无日期/筛选/控件对齐/默认范围） |
| `tools/e2e-v41.js` | 增加行居中、详情叉、demo 循环、侧栏悬浮、seg 四态稳定断言 |

## 3. 验收

| 检查 | 结果 |
|---|---|
| `bash tools/check.sh` | **7/7 全绿**：语法 / verify 4 页 / e2e / e2e-features 53 / e2e-timeline 58 / e2e-v41（含 v4.2 新断言）/ tests 81 |
| `node tools/e2e-timeline.js` | 58/58 PASS，console.error 0 |
| `node tools/e2e-v41.js` | 全 PASS（行居中、详情叉、demo 循环、侧栏 hover、seg 四态 ±1px） |
| 手检 | 行中心差 0–1px；seg 四态 rect 相同；时间线默认范围含 createdAt、无日期任务 0、左侧筛选后条数/计数同步变化；详情叉桌面/移动可用 |
| 截图 | `/tmp/nc-shots/v42/final/`、`/tmp/nc-shots/v43/`、`/tmp/nc-shots/v4/timeline/` |

## 4. 已知限制

- 时间线只读，不支持轴上拖动改期/拉伸；循环任务只显示标识、不展开周期实例。
- 默认范围以最早 createdAt 为起点、上限 60 天；更早的开放任务作为左缘逾期固定展示，不参与时长条。
- v1 迁移数据的 `createdAt` 是迁移时间，时长条会偏短；脏数据 `createdAt > due` 按 due 单点处理。
- 同一开始时间任务多时仍会阶梯堆叠（区间贪心正确结果），已加 20 道护栏与提示。
