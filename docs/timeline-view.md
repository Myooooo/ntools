# Todo「全景时间线」视图（v4.1）

> 归属：`js/todo-timeline.js` + `css/timeline.css`（独立模块，不改 store 数据；由 A 的 `NC.tools.todo.setMode('timeline')` 与 `#todo-timeline` 容器接线）。
> 基线：经典脚本 IIFE / Chromium 102 / 麒麟 ARM / `file://`；无色盲依赖；Lite 为减法。

## 1. 调研与交互借鉴（2–3 个产品）

| 产品 | 关键交互 | 本项目采纳 |
|---|---|---|
| **Asana Timeline** | 时间线可按 *时 / 日 / 周 / 月 / 季 / 半年 / 年* 缩放；可横向拖动查看长周期，支持框选一段日期聚焦（中文资料）；日期冲突用红色依赖线提示 | ① 刻度随范围自适应（≤1.4 天用小时刻度、≤7 天用日/半天刻度、更长用日/周）；② 横向可滚动；③ **刻度区拖拽框选范围**并实时高亮；④ 逾期/冲突用危险色而非依赖线（只读视图） |
| **Google Calendar（周视图）** | 周视图网格 + 红色"当前时间"线，只出现在今天这一列；整列高亮 | 「现在」指示线（铜色 `--nc-warning`，仅当 now 落在范围内显示，跨整个轴；今天列加淡蓝底与「今天」徽标） |
| **Todoist（Calendar layout / Upcoming）** | 周/3 天/月布局；移动端竖屏显示 3 天、横屏显示周；Upcoming 汇总未来 7 天，可前后翻周、点「Today」回到今天；可拖动任务到其他日期 | ① 默认范围 **未来 7 天**（对齐 Upcoming）；② 预设「未来 3 天 / 本周 / 本月 / 重置」替代纯翻页；③ **<900 容器宽切换为纵向按天流水**（对齐移动端列表形态）；④ 本版只读，不支持拖动改期（避免误改 store） |

引用：
- Asana 官方帮助（时间线缩放粒度）：https://help.asana.com/hc/ko/articles/22972075358107
- Asana Timeline 交互中文资料（横向拖拽 + 日期范围框选）：https://www.php.cn/faq/2696325.html （二手资料，标注为参考）
- Google Calendar 视图说明（周视图红色"现在"线）：https://support.georgiacyber.org/hc/en-us/articles/14667428658455-Google-Calendar-Views （帮助中心镜像，标注为参考）
- Todoist Calendar layout（周/3 天/月、移动端方向自适应）：https://www.todoist.com/zh-CN/help/todoist/features/use-the-calendar-layout-in-todoist-lPHRQTu0o
- Todoist Upcoming（未来 7 天、前后翻周、Today）：https://get.todoist.help/hc/en-us/articles/360000031019-Plan-your-week-with-the-Upcoming-view

## 2. API（`NC.timeline`）

| 方法 | 说明 |
|---|---|
| `mount(container[, options])` | 挂载到容器（element 或选择器）；重复调用会先 unmount；`options.showDone` 可覆盖默认。返回 `boolean` |
| `unmount()` | 解除 store 订阅 / ResizeObserver / 事件，移除 DOM；范围与「显示已完成」仅保留在模块内存（memory），跨 mount 保留 |
| `refresh()` | 强制重绘（数据变化时也可依赖自动订阅；A 切回视图时可调用） |
| `getState()` | `{mounted, mode:'h'|'v', width, range, showDone, counts:{inRange,visible,outRange,noDue,overdue,pinned}}` |
| `setRange(start, end)` / `getRange()` | 设置/读取当前范围（epoch ms；非法或 span<15min 会被归一） |
| `presetRange(id)` | `next3` / `week` / `month` / `reset`（内存生效） |
| `defaultRange()` / `isMounted()` | 未来 7 天 / 挂载状态 |

**数据契约（只读）**：`NC.store.todo.getDoc().tasks` 中 `due` 为 epoch ms 的任务进入时间线；`status`（open/done/canceled）、`priority`、`pinned`（可选字段；缺失时不做置顶标识）、`recurrence`（可选）用于标识。
**点击任务** → `NC.store.todo.selectTask(id)`（A 的详情抽屉打开）；模块不写 store。

## 3. 视图规则

### 3.1 横向（容器宽 ≥900px）

- 默认范围：`now → now + 7 天`；范围来自 datetime-local 输入 / 预设 / 刻度区框选，三处联动。
- 刻度：`span ≤ 1.4 天` 3 小时刻度；`≤7 天` 日刻度（每格 168px）；`≤14 天` 118px/天；`≤45 天` 66px/天；更长 40px/天。画布宽度 ≥ 容器宽时可横向滚动（`overflow-x:auto`，`shift+滚轮`/触控板/滚动条均可）。
- 任务 chip：按 `due` 定位，重叠自动分道（同泳道间隔 ≥ `CHIP_W - 8`）；每 chip 显示时间、标题（单行省略）、优先级点/状态/首个标签。
- 标识：置顶=旗帜（铜色）；循环=刷新图标；逾期=感叹号 + 危险色左缘；完成=降低透明度+删除线；取消=点线删除线。
- **逾期且在范围开始之前**的开放任务：固定在轴左缘第一/后续泳道（`is-edge-overdue`），不计入「范围外」，避免默认未来范围里"逾期任务消失"。
- 「现在」线：铜色竖线 + 时间标签（置于轴底，避免遮挡首日标题/chip）；范围不含 now 时隐藏。
- 无日期任务：底部独立区（前 8 条 + "还有 N 项"），点击可选中任务。
- 范围外计数：`统计条` 显示「范围外 N」；空范围时空状态提供「未来 3 天 / 本月」快捷入口和「扩展至全部」。

### 3.2 纵向（容器宽 <900px）

- 纵向"时间流水"：按天分组（`今天 / 明天 / 后天 / 周X · 月日`），组头显示项数；今天组附「现在 HH:mm」；早于范围开始的分组加「逾期」徽标。
- 行：时间（等宽数字）+ 置顶/循环/优先级标识 + 标题（省略）+ 标签；完成后划线弱化。
- 范围控件保持在顶部；`≤560px` 时开始/结束输入纵向堆叠（避免 datetime-local 在 16px 触屏字号下被裁切）。
- 无横向滚动（`document.scrollWidth ≤ clientWidth` 断言，见 e2e）。

### 3.3 范围框选

- 指针在刻度区按下拖动 → 实时高亮（`--nc-accent-soft` 选区 + 时间气泡，含起止时间）；
- 松开生效；拖动距离 <4 分钟视为误触不生效；最小范围 15 分钟；
- 双击刻度区 / 「重置」按钮 → 未来 7 天；
- 键盘：框选层可聚焦（role=application + aria-label），Esc 取消进行中的拖拽；横向滚动容器聚焦后 ←/→ 滚动 160px。

## 4. 性能与动效

- 只渲染 **有 due 且落在范围内** 的任务（+最多 12 条范围左缘逾期）；渲染上限 220 条（超过时提示缩小范围）。
- 重绘走 `requestAnimationFrame` 节流；store `subscribe` / `todo:changed` 触发增量刷新；容器尺寸变化用 `ResizeObserver` 触发模式切换/重排。
- 500 条任务（仅部分到期）：mount/refresh 断言 <1200ms（实测通常个位数 ms，布局只处理范围内任务）。
- 首次进入一次 orchestrated reveal：轴线 220ms 淡入、chips 240ms 上移淡入（stagger 12ms）、现在线 260ms 缩放出现；仅标准模式；`data-lite=true` 或 `prefers-reduced-motion` 下全部关闭且无持续动画。
- Lite：去玻璃（`backdrop-filter`）/阴影/过渡；保留颜色与即时按压反馈。

## 5. 可访问性 / 响应式

- 所有任务 chip/行是 `<button>`，含 `aria-label`（时间+标题+置顶/循环/优先级/逾期/完成状态）；焦点环走 `:focus-visible`。
- 统计/图例为文本 + 图标（非唯一颜色编码）；触控目标：chip 36px 高、行 36px+、按钮 `nc-btn` 系列；`(pointer:coarse)` 下输入 16px 防缩放。
- 容器宽断点 900 由 JS 测量容器（非 viewport 猜设备）；390 移动端无横向溢出（e2e 断言）。

## 6. 验证

```bash
node --check js/todo-timeline.js        # 语法
node tools/e2e-timeline.js              # 40 条断言（mock 数据，不联网）
```

e2e 覆盖：动态加载资源 → mock 500 条数据 → mount/getState → 默认 7 天范围与统计 → 置顶/循环/逾期/完成标识 → 任务点击 → selectTask → 起止输入 → 预设三键+重置 → **指针拖拽框选（实时高亮+松开生效）** → 双击重置 → 显示已完成开关 → refresh/新增任务 → 500 条性能护栏 → 390 纵向流水（按天分组/无横向溢出/点击选中）→ 页面内集成（点「全景」→ `#todo-timeline .tl-root` 挂载；切回「列表」→ unmount；`settings.viewMode` 持久）→ unmount 清理 DOM。
**结果：40/40 通过，页面 console.error = 0。**

截图（标准/浅色/Lite × 1440/390 + 页面内集成）→ `/tmp/nc-shots/v4/timeline/`：
`timeline-{standard,light,lite}-{1440,390}.png`、`inpage-timeline-standard-{1440,390}.png`。

同批回归：`bash tools/check.sh`（结果见交付报告）。

## 7. 已知限制（本版范围）

- **只读**：不支持在时间线上拖动改期/拉伸；改期回到列表或详情抽屉（A 的交互）。
- 重复任务只显示「循环」标识，不在时间线上展开重复实例（展开需要写 store 或只读投影，二期）。
- 月份/季度超长范围可查看但 chip 密度高，建议用框选/预设聚焦；未做聚合折叠。
- 框选仅在刻度区（轴带）；任务区不加拖动选择，避免与 chip 点击冲突。
- 时钟推进不自动滚动/刷新（避免持续动画/定时器占用），刷新或数据变更时更新「现在」线。
