# Todo「全景时间线」视图（v4.2）

> 归属：`js/todo-timeline.js` + `css/timeline.css`（独立模块，只读 store；由 `NC.tools.todo.setMode('timeline')` 与 `#todo-timeline` 容器接线）。
> 基线：经典脚本 IIFE / Chromium 102 / 麒麟 ARM / `file://`；无色盲依赖；Lite 为减法。
> v4.2 变更：任务条改为「创建时间 → 到期时间」时长条；移除无日期任务；范围控件对齐；左侧视图/清单/搜索筛选联动；**默认范围数据化（包含 createdAt，避免条全部左缘裁剪）**。

## 1. 调研与交互借鉴（2–3 个产品）

| 产品 | 关键交互 | 本项目采纳 |
|---|---|---|
| **Asana Timeline** | 时间线任务条表示起止区间（甘特逻辑）；可按 *时 / 日 / 周 / 月 / 季 / 半年 / 年* 缩放；横向拖动查看长周期，可框选一段日期聚焦 | ① **条 = createdAt → due 的时长条**，宽度按比例尺计算；② 刻度随范围自适应（≤1.4 天小时刻度、≤7 天日/半天刻度）；③ 横向可滚动；④ **刻度区拖拽框选范围**并实时高亮 |
| **Google Calendar（周视图）** | 周视图网格 + 红色"当前时间"线，只出现在今天这一列；今天列高亮 | 「现在」指示线（铜色 `--nc-warning`，仅 now 落在范围内时显示）；今天列淡蓝底 + 「今天」徽标 |
| **Todoist（Calendar layout / Upcoming）** | 周/3 天/月布局；移动端竖屏显示 3 天、横屏显示周；Upcoming 汇总未来 7 天，可前后翻周/回到今天 | ① 默认范围 **未来 7 天**；② 预设「未来 3 天 / 本周 / 本月 / 重置」；③ **<900 容器宽切换纵向按天流水**；④ 本版只读，不支持拖拽改期（避免误改 store） |

此外 v4.2 的「左侧视图/清单/搜索筛选联动」遵循列表页的既有交互语义（同一 `selectVisible` 数据源），不引入第二套筛选状态。

引用：
- Asana 官方帮助（时间线缩放粒度）：https://help.asana.com/hc/ko/articles/22972075358107
- Asana Timeline 交互中文资料（横向拖拽 + 日期范围框选）：https://www.php.cn/faq/2696325.html （二手资料，仅作参考）
- Google Calendar 视图说明（周视图红色"现在"线）：https://support.georgiacyber.org/hc/en-us/articles/14667428658455-Google-Calendar-Views （帮助中心镜像，仅作参考）
- Todoist Calendar layout（周/3 天/月、移动端方向自适应）：https://www.todoist.com/zh-CN/help/todoist/features/use-the-calendar-layout-in-todoist-lPHRQTu0o
- Todoist Upcoming（未来 7 天、前后翻周、Today）：https://get.todoist.help/hc/en-us/articles/360000031019-Plan-your-week-with-the-Upcoming-view

## 2. API（`NC.timeline`）

| 方法 | 说明 |
|---|---|
| `mount(container[, options])` | 挂载到容器（element 或选择器）；重复调用会先 unmount；`options.showCompleted` 可覆盖一次初始开关（随后与 `doc.settings.showCompleted` 同步）。返回 `boolean` |
| `unmount()` | 解除 store 订阅 / ResizeObserver / 事件，移除 DOM；**范围**仅保留在模块内存（跨 mount 保留） |
| `refresh()` | 强制重绘（store 变更也会自动订阅重绘，无需重复 mount） |
| `getState()` | `{mounted, mode:'h'|'v', width, range, showCompleted, counts:{total, withDue, inRange, visible, outRange, overdue, pinned, rendered, hiddenOverlap}}` |
| `setRange(start, end)` / `getRange()` | 设置/读取当前范围（epoch ms；非法或 span<15min 会被归一） |
| `presetRange(id)` | `next3` / `week` / `month` / `reset`（内存生效） |
| `defaultRange()` / `isMounted()` | 未来 7 天 / 挂载状态 |

**数据契约（只读）**：
- 数据源 = `NC.store.todo.selectVisible(now).tasks`（尊重左侧 **全部/今天/逾期/已完成** 视图、`listId` 清单、`search` 搜索），再过滤 `deletedAt`；任务点击 → `NC.store.todo.selectTask(id)`，模块不写 store。
- 时间线只处理 `due` 为 epoch ms 的任务；**无日期任务完全不纳入**（不渲染、不计数、不出现「无日期」区域）。
- 「显示已完成」开关与 `doc.settings.showCompleted` **同一份状态**：切换时 `store.updateSettings({showCompleted})`，列表页同步变化；`view=done` 时仍显示已完成任务。
- 时长条起点 `task.createdAt`、终点 `task.due`（`createdAt > due` 的脏数据按 due 单点处理）。

## 3. 视图规则

### 3.1 横向（容器宽 ≥900px）：创建 → 到期时长条

- 默认范围（无内存范围时）**数据化**：
  - `start` = 当前左侧筛选后最早 `createdAt`（向下取整到小时），且不早于 `now-45d`；
  - `end` = `max(now+7d, start+7d, 起点落在 now+7d 窗口内任务的最晚 due)`，最大跨度 `start+60d`；
  - 无任何可推导任务时回退 `now → now+7d`；超上限任务留在「范围外」；「现在」线保留；
  - 长范围（>45 天）日标签按周降采样（7 天一标），打开时横向滚动定位到「现在」附近。
  - 「重置」= 重新计算该数据化默认范围；「未来 3 天/本周/本月」预设保持原语义（纯框选，不因数据变化）。
- **时长条**：
  - 位置与宽度 = `[max(createdAt, range.start), min(due, range.end)]` 在比例尺上的映射，宽度随时长变化（不再固定 170px）；
  - `createdAt < range.start`：条从左缘开始，左缘虚线 + 溢出标记（`is-clip-start`）；
  - `due > range.end`：条在右缘裁剪，右缘高亮标记（`is-clip-end`）；
  - **极短任务**：最小可视宽度 **48px（44–56 区间），右端锚定 due；靠左缘过近时允许贴边；
  - **默认数据化范围已包含 createdAt**，因此默认状态下条内完整显示「开始 → 到期 · 时长」，不出现裁剪标记；只有用户手动缩小范围/预设框选后才出现左/右裁剪标记；
  - 条内按宽度分三档：宽条 `10:42 → 10:45 · 3 分钟`、窄条 `10:45 · 3 分钟`、极短条只显示到期时刻；`title`/`aria-label` 始终含完整「创建 / 到期 / 时长」；
  - 分道：按 `[start,end]` 区间贪心排布（同泳道间隔 ≥6px），不再按 due+固定宽；泳道安全上限 20，极端同起点数据折叠并提示「N 项重叠任务暂未显示」。
- 刻度：`span ≤ 1.4 天` 3 小时刻度；`≤7 天` 日刻度；更长按 118/66/40px 每天渐进；画布宽度至少填满可视区，超出可横向滚动。
- 标识：置顶=旗帜（铜色）；循环=刷新图标；逾期=感叹号 + 危险色左缘；完成=降低透明度+删除线；取消=点线删除线；**早于范围开始的开放任务**固定左缘（`is-edge-overdue`，最多 12 条，不计入范围外）。
- 「现在」线：铜色竖线 + 时间标签（轴底，避免遮挡首日标题/条）；范围不含 now 时隐藏。
- 统计：`范围内 / 逾期 / 置顶 / 范围外`（不再有「无日期」）；空状态区分「当前筛选下无带截止时间任务」与「此范围内没有任务」，并提供未来 3 天/本月快捷入口。

### 3.2 纵向（容器宽 <900px）：按天时间流水

- 按 **due 所在天** 分组（`今天 / 明天 / 后天 / 周X · 月日`），组头显示项数；今天组附「现在 HH:mm」；早于范围开始的分组加「逾期」徽标。
- 行：到期时刻（等宽数字）+ 置顶/循环/优先级标识 + 标题 + **创建→到期区间与时长**（如 `11月13日 10:42 → 11月16日 09:15 · 2.9 天`）+ 标签；完成后划线弱化。
- 与横向共用同一份数据（左侧筛选 + 显示已完成），无日期任务同样不出现；无横向滚动。

### 3.3 左侧筛选联动

- `collect()` 以 `todoStore.selectVisible(now).tasks` 为唯一数据源：切换左侧 **全部任务/今天/逾期/已完成**、清单、搜索后，时间线立即重绘（订阅 `todo:changed`，无重复 mount）。
- 「显示已完成」= `doc.settings.showCompleted`（与列表共享）；切换即 `updateSettings`，刷新后保持。
- 范围外计数、空状态、折叠提示均基于当前筛选后的任务集合计算。

### 3.4 范围框选与范围控件

- 指针在刻度区按下拖动 → 实时高亮（选区 + 起止时间气泡）；松开生效；拖动 <4 分钟视为误触；最小范围 15 分钟；双击刻度区/「重置」→ 未来 7 天；键盘 Esc 取消进行中的拖拽。
- 范围控件对齐（横向/纵向统一）：
  - 横向：开始/结束输入 **180×32 等宽等高**，预设组、显示已完成开关、扩展按钮均与输入**同一底部基线**（±2px），间距 10px；
  - 纵向：输入两列等宽网格、预设/开关/扩展按钮整行等宽铺满；`≤560px` 输入改为单列堆叠；不留横向溢出。
- 横向滚动容器聚焦后 ←/→ 滚动 160px；框选层可聚焦并带 `aria-label`。

## 4. 性能与动效

- 只渲染 **有 due 且区间与范围相交** 的任务（+最多 12 条范围左缘逾期）；渲染上限 220 条；泳道安全上限 20（超出折叠提示）。
- 重绘走 `requestAnimationFrame` 节流；`store.subscribe` / `todo:changed` 触发刷新；容器尺寸变化用 `ResizeObserver` 触发模式切换/重排。
- 500 条任务（仅部分到期）：mount/refresh 断言 <1200ms（布局只处理范围内任务）。
- 首次进入一次 orchestrated reveal：轴线 220ms 淡入、条 240ms 上移淡入（stagger 12ms）、现在线 260ms 缩放出现；仅标准模式；`data-lite=true` 或 `prefers-reduced-motion` 下全部关闭且无持续动画。
- Lite：去玻璃（`backdrop-filter`）/阴影/过渡；保留颜色与即时按压反馈。

## 5. 可访问性 / 响应式

- 所有任务条/行是 `<button>`，`aria-label` 含完整「创建 / 到期 / 时长 + 状态（置顶/循环/优先级/逾期/完成/取消）+ 是否被范围裁剪」；焦点环走 `:focus-visible`。
- 统计/图例为文本 + 图标（非唯一颜色编码）；条高 36px、触控目标 ≥36px；`(pointer:coarse)` 下输入 16px 防缩放。
- 容器宽断点 900 由 JS 测量容器（不猜设备）；390 移动端无横向溢出（e2e 断言）。

## 6. 验证

```bash
node --check js/todo-timeline.js        # 语法
node tools/e2e-timeline.js              # 57 条断言（mock 数据，不联网）
```

e2e 覆盖：动态加载资源 → mock 500 条数据（含 createdAt 分布/无日期/范围外/裁剪任务）→ mount/getState → 默认 7 天范围与统计 → 置顶·循环·逾期·完成标识 → **时长条宽度与（裁剪后）时长成比例、极短条最小宽度且右端锚定 due、左/右裁剪标记** → **范围控件等宽同基线（横向+纵向）** → 任务点击 → selectTask → 起止输入 → 预设 → **左侧视图/清单/搜索筛选联动（数量与内容变化）** → 框选（实时高亮+松开生效）→ 双击重置 → 显示已完成（与 settings 同步）→ refresh/新增任务 → 500 条性能护栏 → 390 纵向流水（按天分组/创建→到期区间/无横向溢出）→ **无日期任务不出现、无「无日期」区** → 页面内集成（「全景」挂载/「列表」unmount/`viewMode` 持久）→ unmount 清理 DOM。
**结果：58/58 通过，页面 console.error = 0。**（新增：默认范围覆盖最早 createdAt、默认条无裁剪、手动缩小后出现裁剪、重置恢复数据化范围）

截图（标准/浅色/Lite × 1440/390 + 页面内集成）→ `/tmp/nc-shots/v4/timeline/`：
`timeline-{standard,light,lite}-{1440,390}.png`、`inpage-timeline-standard-{1440,390}.png`。

同批回归：`bash tools/check.sh`（结果见交付报告）。

## 7. 已知限制（本版范围）

- **只读**：不支持在时间线上拖动改期/拉伸时长；改期回到列表或详情抽屉（A 的交互）。
- 重复任务只显示「循环」标识，不在时间线上展开重复实例（展开需要写 store 或只读投影，二期）。
- 时长条依赖 `createdAt`：历史数据若缺少创建时间则按 due 单点处理（最小宽度）；v1 迁移数据 createdAt 统一为迁移时间，条宽会偏短，属预期。
- 数据化默认范围可能较宽（最早任务越久越宽，最多 45+60 天），会横向滚动并定位到「现在」；更早于 `now-45d` 的开放任务作为左缘逾期固定展示。
- 泳道为区间贪心：同一时间开始的任务较多时会出现阶梯式堆叠（受 20 道上限保护并提示）；可通过缩小范围/筛选聚焦。
- 框选仅在刻度区；任务区不加拖动选择，避免与条点击冲突。
- 时钟推进不自动 tick 刷新「现在」线（避免常驻定时器/持续动画），刷新或数据变更时更新。
