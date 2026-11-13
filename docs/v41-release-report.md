# nTools v4.1 交付报告（交互修复 / Todo 新能力 / 全景时间线）

> 日期：2026-11-13 ｜ 基线：Chromium 102 / 麒麟 ARM / `file://` / 无构建链
> 关联文档：[animation-audit-v4.1.md](animation-audit-v4.1.md)、[timeline-view.md](timeline-view.md)、[design-direction-v4.md](design-direction-v4.md)

## 1. 需求对照

| # | 需求 | 交付 |
|---|---|---|
| 1 | Todo 右上角菜单重复点击无限叠放，并检查其他类似问题 | `NC.ui.openMenu` 改为全局单例：同一时刻只允许一个菜单；重复点击同一触发按钮为开/关；打开新菜单前关闭旧菜单；带 origin-aware 的 140ms 退出动画与 120ms 关闭过渡。已复查聊天自定义菜单（单实例 + 重入守卫）、设置/弹窗/灯箱单例。 |
| 2 | 设置改为弹出窗口（右侧滑出不直观），并检查其他类似问题 | 设置 Sheet 改为**居中弹窗**（980×760，`:open` 时 `scale(.985)+8px → 1`，200ms）；移动端全屏；右侧滑出样式已移除。同类审查：聊天系统提示词弹窗本就居中；移动端 Todo 详情抽屉由右侧滑出改为**底部上滑**（grabber/圆角/安全区）；菜单为锚定弹层。 |
| 3 | 很多元素没有出场动画，按 emilkowalski 技能重检所有动画 | 产出 [animation-audit-v4.1.md](animation-audit-v4.1.md)：全站逐面审计（入口/tab/侧栏/设置/待办 7 个子面/聊天/菜单/Toast/Modal/自定义弹层），按 animate/choreograph 原则校准。已补齐：菜单开合、设置窗口、侧栏收起、tab 切换（180→140ms/4px）、待办增删/完成/置顶/折叠/采集展开/详情抽屉、聊天欢迎两拍/思考展开/统计/提示词弹窗/灯箱/图片预览/回底/发送-停止交叉、时间线一次性揭示；Toast 退出快于进入；Lite/reduced-motion 全部即时。 |
| 4 | 三天内到期任务整行渐变染色，黄→红越近越深 | 行级 `heat-1/2/3/overdue`：未完成且 due≤72h 的行通过 `::before` 铺整行 90° 渐变（warning-soft→danger-soft），24/48/72h 分档并随 tick 同步；>72h、完成、取消、无日期不染色；深/浅主题与 Lite（降低不透明度）均适配。 |
| 5 | 新增置顶，置顶永远在最顶部 | schema `pinned:boolean`（v1 迁移/导入导出归一化默认 false）；store `togglePin`；四种排序 pinned 恒优先；视图顶部独立「置顶」分组且不与后续分组重复；行内/详情置顶按钮 + P 快捷键 + 视觉标识。 |
| 6 | 侧边菜单可收起，收起后只显示功能 logo，下面只显示设置按钮 | 新增 `rail.css` + `#rail-toggle-btn`：196px→68px 图标模式，标签淡出，导航居中，徽标角标；收起后 footer 仅保留设置按钮；状态持久化 `ntools.rail-collapsed`；移动端仍为顶部栏、隐藏切换按钮；标准模式宽度过渡，Lite/reduced 即时。 |
| 7a | 新建按钮里的 N 去掉，快捷键提示挪到底部 | `ntools.html` 删除按钮内 kbd；运行时会向底部提示条注入 `N 新建`、`/ 搜索`，与 Space/E/Del/Ctrl+Z 并列（移动端 footer 本就隐藏）。 |
| 7b | 新增全景视图：时间线按到期排布、可框定起止时间 | 独立模块 `NC.timeline`：横向时间轴（容器≥900px）、自动刻度/分道、现在线、逾期固定左缘、置顶/循环/优先级/完成状态、无日期区、范围外计数；**刻度区指针拖拽框选** + 起止 datetime + 未来3天/本周/本月/重置 + 双击重置 + Esc；窄屏纵向时间流水；rAF 节流 + 500 条护栏；Lite 关闭动画。调研参考 Asana Timeline / Google Calendar / Todoist Calendar（见 timeline-view.md）。 |
| 8 | 循环任务：每日/每周/每月/每年，完成后下周期重置未完成并按当前到期排序 | schema 纯函数 `nextRecurrenceDue`（日/周/月/年，月末/闰年夹取，≤now 连续前移，until 截止）；store 完成时同一任务 due 前移、status=open、completedAt=null、记录 lastMaterialized/lastCompletedAt，不生成副本；创建区/详情「重复」选择，缺 due 自动补下班时间；行/详情循环标识；取消完成不前移；`todo:recurred` toast。 |

## 2. 主要文件

| 文件 | 变更 |
|---|---|
| `js/ui.js` | 菜单单例/开关/退出动画/滚动与 resize 关闭；Modal 退出时长对齐 240ms |
| `js/settings-panel.js` | 居中弹窗时序、首次打开不重复入场、退出 240ms |
| `js/ntools-app.js` | 侧栏收起状态/持久化 |
| `js/schema-todo.js` | `pinned`、`viewMode`、`nextRecurrenceDue`、`lastCompletedAt` |
| `js/todo-store.js` | `togglePin`、pinned 排序、循环完成前移、viewMode 设置 |
| `js/todo-view.js` | 置顶分组/按钮、循环选择/标识、热区 class、列表-全景切换、时间线挂载、底部快捷键注入、列表动效、移动端底部抽屉 |
| `js/todo.js` | `setMode`、P 快捷键、循环 toast、帮助面板 |
| `js/todo-timeline.js` | 全景时间线独立模块（mount/unmount/refresh + range API） |
| `js/chat-embed.js` / `message-view.js` / `composer.js` | 菜单退出/重入守卫、欢迎两拍、思考展开、灯箱/图片预览/回底等动效 |
| `css/components.css` / `chat.css` / `settings.css` / `tools.css` | 菜单退出、设置弹窗、热区/置顶/循环/时间线、动效层 |
| `css/rail.css` / `timeline.css` / `interaction.css` | 新增：可收起侧栏 / 时间线 / 交互动效收口 |
| `ntools.html` | 侧栏按钮、时间线资源、viewport/theme-color、版本 v4.1 |
| `tools/e2e-v41.js` / `e2e-timeline.js` | 新增 E2E（17 / 40 断言） |
| `docs/animation-audit-v4.1.md`、`docs/timeline-view.md` | 新增审计与设计说明 |

## 3. 验收结果

| 检查 | 结果 |
|---|---|
| `bash tools/check.sh` | **7/7 全绿**：语法 / verify 4 页 / e2e / e2e-features 53 / e2e-timeline 40 / e2e-v41 17 / tests 81 |
| `node tools/e2e-timeline.js` | 40/40 PASS，页面 console.error 0；mock 500 条数据 |
| `node tools/e2e-v41.js` | 17/17 PASS：菜单单例、设置弹窗几何居中、侧栏收起/持久化、新建按钮/快捷键提示、置顶排序/分组、循环推进、热区分档、时间线横/纵/卸载 |
| `node tools/break-ui.js` | 32 组最坏数据/宽度/200% 缩放：0 破坏项；移动端原生 12/12 PASS（hover 门控 77/77） |
| 纯函数 | checks/tests.html 81/81 |
| 截图 | `/tmp/nc-shots/v41/final/`（列表/时间线/设置/侧栏/移动端）、`/tmp/nc-shots/v4/timeline/`（时间线 8 张）、`/tmp/nc-shots/v4/break/`（25 张最坏数据） |

## 4. 已知限制

- **循环任务**：`recurrence.count` 字段保留但暂未消费（只实现 interval/until）；monthly 采用月末夹取语义（1/31→2/28→3/28），如需固定回 31 日需记录锚点日；完成时立即前移，不保留“本期已完成”历史行（lastCompletedAt 可追溯）。
- **全景时间线**：只读视图，不支持轴上拖动改期；循环任务只显示标识不展开周期实例；范围/隐藏完成偏好仅内存；时钟推进不自动 tick（避免常驻动画），数据变更/refresh 时更新。
- **设置弹窗**：移动端全屏；桌面固定 980×760 上限，超小桌面由窗口滚动承载。
- **动效**：headless 无法验证真机手感；建议麒麟 ARM/奇安信实机复核 sticky hover、软键盘、safe-area 与 60fps。
- **真实数据**：跨标签同步、导入导出、撤销/重做对 pinned/recurrence 的兼容已由纯函数与 E2E 覆盖；仍建议首次升级前导出备份。
