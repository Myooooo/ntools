# nTools v4.6 交付报告（本周视图 / 详情侧边栏动画）

> 日期：2026-11-13 ｜ 基线：Chromium 102 / 麒麟 ARM / `file://`

## 1. 需求对照

| # | 反馈 | 交付 |
|---|---|---|
| 1 | 左侧视图增加「本周」 | schema `VIEWS = ['all','today','week','overdue','done']`；新增 `isThisWeek`（本地时区周一 00:00–周日 23:59）；`docCounts.week` 统计 open 且 due 在本周；store `selectVisible` 新增 week 分支；左侧「今天」之后新增「本周」按钮（日历图标/计数/badge），空状态「本周没有待办」，移动端横向 chips 同步。旧 settings.view 非法值仍回退 all。 |
| 2 | 详情侧边栏展开/收起动画符合规范 | 桌面打开：`.is-detail-opening` + `todo-detail-in` 180ms（opacity + translateX 10px→0，ease-out）；关闭：`.is-detail-closing` + `todo-detail-out` 140ms（opacity + translateX 0→12px，退出更快），动画结束后才清空选中/收起列；覆盖 X、保存并关闭、Esc、详情删除、行内删除自动关闭。移动端抽屉保持 220ms ease-drawer，关闭时 scrim 延迟到抽屉结束才 hidden，打开同步；快速开合可中断不叠加。Lite/reduced-motion 由 JS/CSS 双重关闭动画、立即完成。 |

## 2. 关键实现

| 文件 | 变更 |
|---|---|
| `js/schema-todo.js` | VIEWS 插入 week；`isThisWeek`；`docCounts.week`；导出与 validate 同步 |
| `js/todo-store.js` | `selectVisible` week 分支（open && isThisWeek） |
| `js/todo-view.js` | 本周标签/计数/badge/空态；详情动画编排（opening/closing/Esc/scrim/删除/保存/中断） |
| `css/tools.css` | 详情进入/退出 keyframes（仅 opacity+transform）；Lite/reduced 关闭 |
| `ntools.html` | 本周导航按钮（data-view=week） |
| `tools/e2e-v41.js` | 新增 9 条 v4.6 断言：本周筛选/计数/空态、详情动画 mid/end、保存后 toast 时序、Lite/reduced 即时 |

## 3. 验收

| 检查 | 结果 |
|---|---|
| `node --check` | schema/store/view/e2e-v41 全过 |
| `node tools/run-tests.js` | 81/81 |
| `node tools/verify.js` | 3 页全 PASS |
| `node tools/e2e.js` | 全 PASS |
| `node tools/e2e-features.js` | 53/53，console.error 0 |
| `node tools/e2e-v41.js` | 全 PASS（含 v4.6 新增断言） |
| 自建 CDP | 8/8：isThisWeek 边界、week 筛选/计数/置顶/热区/循环、移动 chips、scrim 延迟、快速开合中断、删除自动关闭、Esc、无页面错误 |
| 截图 | `/tmp/nc-shots/task28/`：本周深/浅/Lite 1440、440 移动端、空态、详情打开/关闭中/关闭后、保存关闭、移动抽屉三态 |

## 4. 已知限制

- `isThisWeek` 为 active 语义（与 `isToday` 一致）：本周内已过时间但未完成的任务仍属于本周视图；跨周的逾期任务只在「逾期/全部」中出现。
- 关闭动画为内容淡出 + 布局收列的组合：桌面列宽收起发生在动画结束后（约 150ms），避免不了最后一帧的布局变化，但视觉上被淡出掩盖；未使用布局动画以保证性能。
- 移动抽屉仍是右侧滑入（v4.2 底部上滑设计已被 v4.3+ 的侧栏结构取代，本轮保持现状）；如需改底部 sheet 可另开需求。
- 详情动画依赖 JS 计时与 CSS keyframes；极端低端设备上动画仍走合成层，但由于只动 opacity/transform，风险可控；Lite 下完全关闭。
