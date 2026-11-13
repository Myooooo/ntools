# nTools v4.7 交付报告（全景视图任务详情抽屉）

> 日期：2026-11-13 ｜ 基线：Chromium 102 / 麒麟 ARM / `file://`

## 1. 问题与根因

全景模式为了让时间线容器 ≥900px 触发横向时间轴，`.todo-shell.is-timeline` 使用两列布局并 `.todo-detail { display:none }`。`NC.timeline` 点击任务已正确调用 `NC.store.todo.selectTask(id)`（selectedId / drawerOpen 置位），但详情被 CSS 隐藏，用户看不到侧边详情栏。

## 2. 修复

| 项 | 实现 |
|---|---|
| 详情呈现 | timeline 模式下详情不再参与 grid：`position:fixed; right:0; top:0; bottom:0; width:min(380px,94vw); z-index: modal-15`，`translateX(102%) → .is-open 0`，220ms `ease-drawer`；fixed 脱离布局，**时间线容器宽度/横向模式完全不变**。 |
| 打开 | timeline 点击 `.tl-task` / `.tl-agenda__row` → `selectTask` → `syncDrawer` 判定 `overlay = mobile || viewMode==='timeline'`，打开覆盖抽屉并显示 scrim；点击另一任务保持打开、内容切换。 |
| 关闭 | X / 保存并关闭 / Esc / 点击 scrim / 删除自动关闭 → 220ms 滑出后 clearSelection；不叠加桌面 180ms 内容动画；scrim 延迟到滑出结束 hidden；关闭后时间线保持挂载、scrollLeft、横向/纵向模式与宽度不变。 |
| 响应式 | 1440 横向时间线 drawer 380px；390 纵向流水 drawer 94vw；Lite/reduced transition 0，即时完成。 |
| 交互保持 | 切列表/全景时 flush 编辑并收起覆盖层；详情编辑/保存/删除/置顶/重复等原逻辑不变。 |

主要文件：`css/tools.css`、`js/todo-view.js`、`tools/e2e-v41.js`（未改 `js/todo-timeline.js`）。

## 3. 验收

| 检查 | 结果 |
|---|---|
| `node tools/check.sh` | 7/7 全绿（verify 3 页 / e2e / e2e-features 53 / e2e-timeline 58 / e2e-v41 / tests 81） |
| `node tools/e2e-v41.js` | 全 PASS：时间线点击打开、宽度/横向不变、切任务、Esc/scrim/X 关闭后仍挂载且布局不变 |
| `node tools/e2e-timeline.js` | 58/58，console.error 0 |
| 自建 CDP | 6/6：390 覆盖抽屉、切换列表收起 + unmount、滚动/布局保持、Lite/reduced 即时、无页面错误 |
| 截图 | `/tmp/nc-shots/task29/`：1440 打开/关闭、浅色打开、390 纵向打开 |

## 4. 说明

- 覆盖层关闭后元素仍以 `translateX(102%)` 留在 DOM 以支持滑出过渡，因此不再用 `offsetParent` 判断关闭，而用 `.is-open` / rect 是否在视口外。
- timeline 覆盖层与移动端右侧抽屉共用 z-index/层级与交互规范；桌面全局详情列仍按 v4.6 动画编排。
- 真机需复核触屏 scrim 点击、软键盘遮挡与 reduced-motion。
