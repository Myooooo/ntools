# Todo「全景时间线」视图（v4.8）

> 归属：`js/todo-timeline.js` + `css/timeline.css`（独立模块，只读 store；由 `NC.tools.todo.setMode('timeline')` 与 `#todo-timeline` 容器接线）。
> 基线：经典脚本 IIFE / Chromium 102 / 麒麟 ARM / `file://`；无色盲依赖；Lite 为减法。
> v4.8 变更：默认隐藏已完成；默认聚焦窗口 5 天；`range` 变为「聚焦/缩放窗口」，画布独立延伸到最晚任务（右侧无空白）；预设/框选后按选中天数铺满视口，仍可向右滚到最晚任务。

## 1. 调研与交互借鉴（2–3 个产品）

| 产品 | 关键交互 | 本项目采纳 |
|---|---|---|
| **Asana Timeline** | 时间线任务条表示起止区间（甘特逻辑）；可按 *时 / 日 / 周 / 月 / 季 / 半年 / 年* 缩放；横向拖动查看长周期，可框选一段日期聚焦 | ① 条 = createdAt → due 的时长条；② **range 作为缩放窗口**（选中天数铺满视口）；③ 横向滚动 + 刻度区拖拽框选范围 |
| **Google Calendar（周视图）** | 周视图网格 + 红色"当前时间"线，只出现在今天这一列；今天列高亮 | 「现在」指示线（铜色 `--nc-warning`）；今天列淡蓝底 + 「今天」徽标 |
| **Todoist（Calendar layout / Upcoming）** | 周/3 天/月布局；移动端竖屏显示 3 天、横屏显示周；Upcoming 汇总未来 7 天，可前后翻周/回到今天 | ① 默认聚焦 **5 天**；② 预设「未来 3 天 / 本周 / 本月 / 重置」；③ **<900 容器宽切换纵向按天流水**；④ 只读，不支持拖拽改期 |

引用：
- Asana 官方帮助（时间线缩放粒度）：https://help.asana.com/hc/ko/articles/22972075358107
- Asana Timeline 交互中文资料（横向拖拽 + 日期范围框选）：https://www.php.cn/faq/2696325.html （二手资料，仅作参考）
- Google Calendar 视图说明（周视图红色"现在"线）：https://support.georgiacyber.org/hc/en-us/articles/14667428658455-Google-Calendar-Views （帮助中心镜像，仅作参考）
- Todoist Calendar layout（周/3 天/月、移动端方向自适应）：https://www.todoist.com/zh-CN/help/todoist/features/use-the-calendar-layout-in-todoist-lPHRQTu0o
- Todoist Upcoming（未来 7 天、前后翻周、Today）：https://get.todoist.help/hc/en-us/articles/360000031019-Plan-your-week-with-the-Upcoming-view

## 2. API（`NC.timeline`）

| 方法 | 说明 |
|---|---|
| `mount(container[, options])` | 挂载到容器；重复调用会先 unmount；`options.showCompleted` 仅首次显式覆盖时间线本地开关（之后由容器内开关控制）。返回 `boolean` |
| `unmount()` | 解除 store 订阅 / ResizeObserver / 事件，移除 DOM；**范围与「显示已完成」仅保留在模块内存**（跨 mount 保留） |
| `refresh()` | 强制重绘（store 变更也会自动订阅重绘，无需重复 mount） |
| `getState()` | `{mounted, mode:'h'|'v', width, range, rangeDays, dayWidth, displayStart, displayEnd, showCompleted, counts:{total,withDue,inRange,outRange,visible,hiddenDone,latestDue,overdue,pinned,rendered,hiddenOverlap}}` |
| `setRange(start, end)` / `getRange()` | 设置/读取聚焦窗口（epoch ms；非法或 span<15min 会被归一） |
| `presetRange(id)` | `next3`（现在→+3 天）/ `week`（本周一→周日）/ `month`（本月）/ `reset`（今天 00:00→+5 天） |
| `defaultRange()` / `isMounted()` | 默认 5 天聚焦窗口 / 挂载状态 |

**数据契约（只读）**：
- 数据源 = `NC.store.todo.selectVisible(now).tasks`（尊重左侧 **全部/今天/逾期/已完成** 视图、`listId` 清单、`search` 搜索），再过滤 `deletedAt`；任务点击 → `NC.store.todo.selectTask(id)`，模块不写 store。
- 时间线只处理 `due` 为 epoch ms 的任务；**无日期任务完全不纳入**（不渲染、不计数、不出现「无日期」区域）。
- **「显示已完成」默认关闭**且为时间线本地开关（不修改 `doc.settings.showCompleted`，列表页默认不受影响）；打开后显示已完成/已取消并弱化。
- 时长条起点 `task.createdAt`、终点 `task.due`（`createdAt > due` 的脏数据按 due 单点处理）。

## 3. 视图规则

### 3.1 横向（容器宽 ≥900px）：聚焦窗口 + 画布延伸到最晚任务

- **默认聚焦窗口**：`今天 00:00 → +5 天`（不再把最早 createdAt 拉进默认范围）；打开时 `scrollLeft=0`，现在线在首屏可见。无数据时同样回退 5 天窗口。
- **range = 聚焦/缩放窗口**：`dayWidth = 视口宽度 / range 天数`，选中天数**正好铺满视口**；切换预设/框选/日期后 `scrollLeft` 回到范围开始。预设语义：「未来 3 天」= 现在→+3 天；「本周」= 周一 00:00→周日 23:59；「本月」= 本月 1 日→月末；「重置」= 默认 5 天窗口。
- **画布（display）与 range 解耦**：
  - `displayStart = range.start`，`displayEnd = max(range.end, 最晚可见任务 due + 16px)`；
  - 画布宽度按 `displayEnd-displayStart` 与 `pxPerMs = 视口宽 / range 跨度` 计算：**右端≈最晚任务 + 16px**，无多余空白；向右滚动可看到范围外任务，最后一个任务后无超长空白带；
  - 若最晚任务早于 range.end，画布结束取 `range.end`（默认仍展示完整 5 天，右端可留日历空白，但不是超长空白带）。
- **时长条**：
  - 位置/宽度 = `[max(createdAt, displayStart), min(due, displayEnd)]` 映射；`createdAt < displayStart` 时条从左缘开始并显示左缘裁剪标记；`due > displayEnd` 才裁右缘（默认不会出现，因画布覆盖最晚任务）；
  - 极短任务最小可视宽度 **48px（44–56 区间）**，右端锚定 due；
  - 条内按宽度分三档：`10:42 → 10:45 · 3 分钟` / `10:45 · 3 分钟` / 仅到期时刻；`title`/`aria-label` 含完整「创建/到期/时长 + 状态 + 是否被裁剪」；
  - 分道：按 `[start,end]` 区间贪心（间隔 ≥6px）；泳道安全上限 60（极端重叠折叠提示）。
- 标识：置顶=旗帜；循环=刷新图标；逾期=感叹号+危险色；完成/取消（开关打开时）=弱化/删除线；早于画布起点的开放任务固定左缘（最多 12 条）。
- 「现在」线：铜色竖线 + 时间标签（落在刻度区）；范围不含现在时隐藏。
- 统计：`范围内`（聚焦窗口内可见任务）/ `逾期` / `置顶` / `范围外`（窗口外但仍可滚动查看的可见任务；不再有「无日期」）。空状态区分「无带截止任务」「只有已完成/已取消」「窗口内没有任务」。
- 「扩展至全部」：把聚焦窗口扩到当前筛选下所有可见任务的最小起点→最晚 due，仍按选择天数缩放。

### 3.2 纵向（容器宽 <900px）：按天时间流水

- 按 **due 所在天** 分组（`今天 / 明天 / 后天 / 周X · 月日`），组头显示项数；今天组附「现在 HH:mm」；早于范围起点的开放任务显示「逾期」徽标组。
- 行：到期时刻（等宽数字）+ 置顶/循环/优先级标识 + 标题 + **创建→到期区间与时长** + 标签；完成后划线弱化。
- 默认同样隐藏已完成/已取消；只展示聚焦窗口内可见任务 + 左缘逾期；无横向滚动。

### 3.3 筛选与状态

- `collect()` 以 `todoStore.selectVisible(now)` 为唯一数据源，左侧视图/清单/搜索变化立即重绘（订阅 `todo:changed`）。
- 「显示已完成」= 时间线本地状态（默认 false）；切换只影响时间线，不写列表设置。已完成/已取消默认完全不渲染。
- 范围外计数 = 当前可见但 due 不在聚焦窗口内的任务数（仍可在右侧画布滚动看到）。

### 3.4 范围框选与范围控件

- 指针在刻度区按下拖动 → 实时高亮（选区 + 起止时间气泡）；松开生效；拖动 <4 分钟视为误触；最小范围 15 分钟；双击刻度区/「重置」→ 回到默认 5 天窗口；Esc 取消进行中的拖拽。
- **框选坐标按画布 display 窗口映射**（不是按 range 比例）：画布很长时，在可见区内框选得到的仍是可见时间范围，不会被压缩成几分钟。
- 范围控件对齐：横向输入 180×32 等宽等高、与预设/开关/扩展按钮同底部基线；纵向两列等宽网格、≤560px 单列堆叠，无横向溢出。

## 4. 性能与动效

- 渲染当前筛选下所有可见 due 任务（画布延伸到最晚任务；上限 600 条护栏），只有 due 在画布外才不渲染；早于起点的开放任务固定左缘（≤12）。
- 重绘走 `requestAnimationFrame` 节流；`ResizeObserver` 触发模式切换/重排；范围变化后重置滚动位置。
- 500 条任务（其中约 495 条可见）下 refresh 断言 <1200ms（实测通常个位数~十几 ms 量级，布局只处理范围内+画布内任务）。
- 首次进入一次 orchestrated reveal：轴线 220ms 淡入、条 240ms 上移淡入（stagger 12ms）、现在线缩放出现；仅标准模式；`data-lite=true` / `prefers-reduced-motion` 下关闭。

## 5. 可访问性 / 响应式

- 任务条/行是 `<button>`，`aria-label` 含完整创建/到期/时长/状态/裁剪信息；焦点环走 `:focus-visible`。
- 统计/图例为文本+图标；条高 36px、触控目标 ≥36px；`(pointer:coarse)` 输入 16px。
- 容器宽断点 900 由 JS 测量容器；390 移动端无横向溢出（e2e 断言）。

## 6. 验证

```bash
node --check js/todo-timeline.js
node tools/e2e-timeline.js     # 67 条断言（mock 数据，不联网）
```

e2e 覆盖：动态加载资源 → mock 500 条 → mount/getState → **默认 5 天窗口/视口铺满/初始定位** → **默认隐藏已完成（开关打开出现、关闭消失）** → 置顶/循环/逾期/裁剪标识 → 时长条宽度比例/最短宽度 → **画布右端≈最晚任务（16px）与滚到最右可见** → 起止输入 → **预设按天数缩放且仍可滚到最晚任务** → 左侧视图/清单/搜索联动 → **框选（实时高亮、按画布映射、松开生效、双击重置）** → refresh/新增任务 → 500 条性能护栏 → 390 纵向流水（按天分组/创建→到期/无溢出）→ 页面内集成（全景挂载/切回卸载/viewMode）→ unmount 清理。
**结果：67/67 通过，页面 console.error = 0。**

截图（标准/浅色/Lite × 1440/390 × 默认/最右/未来 3 天/本周）→ `/tmp/nc-shots/v48/timeline/`：
`timeline-{standard,light,lite}-{1440,390}-{default,rightmost,next3,week}.png`（24 张 + 页面内集成 2 张）。

同批回归：`bash tools/check.sh` 7/7 全绿（见交付报告）。

## 7. 已知限制（本版范围）

- **只读**：不支持在轴上拖动改期/拉伸时长；改期回列表或详情抽屉。
- 默认窗口固定 5 天（今天 00:00 起），早于今天创建的任务条默认从左侧裁剪（左缘裁剪标记），属于聚焦窗口语义；「扩展至全部」可把窗口扩到最早任务。
- 画布可能很长（最晚任务很远时），横向滚动条会相应变长；这是"可滚到最晚任务"的代价，正常数据通常只延长数天。
- 渲染上限 600 条可见任务；更多任务时需用筛选/缩小范围（护栏提示）。
- 重复任务只显示「循环」标识，不展开重复实例；无日期任务始终不显示。
- 时钟推进不自动 tick 刷新「现在」线（避免常驻定时器），刷新或数据变更时更新。
