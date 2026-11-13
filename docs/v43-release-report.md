# nTools v4.3 交付报告（品牌 / 行内细节 / 自检入口收纳）

> 日期：2026-11-13 ｜ 基线：Chromium 102 / 麒麟 ARM / `file://`
> 关联：[v4.2 交付报告](v42-release-report.md)、[timeline-view.md](timeline-view.md)

## 1. 需求对照

| # | 反馈 | 交付 |
|---|---|---|
| 1 | 左上角图标和 favicon 改为工具箱 | 新增 `toolbox` 线性图标并用于左上角 brand mark；新增 `img/favicon.svg`（仪器蓝圆角底 + 白色工具箱），替换原闪电 data-URI favicon；`checks/` 两页同步 favicon。 |
| 2 | 当前 Todo 行的标签会和右侧按钮重叠 | `.todo-item` 右侧 padding 54→92px（覆盖 3 个 26px 操作按钮 ≈80px + 10px 安全距）；`.todo-item__tags` 改 `flex:1 1 auto; min-width:0; overflow:hidden; max-width:52%`，标签过多时前 3 + `+N` 截断。实测 1440 深/浅/Lite：tags.right=968 < actions.left=978；390：310<319；320：240<249，且无横向溢出。 |
| 3 | 重复任务图标放到标题左侧；置顶时放在置顶图标右侧 | titleline DOM 顺序改为 `pin → repeat → title → tags`；无置顶时 repeat 位于标题最左，无循环时 repeat `hidden + display:none` 不占位；保留 `aria-label="循环任务：每天"` / `title`。 |
| 4 | 移除 index 等旧文件，test/compat 收进文件夹，入口集成到三点菜单和关于弹窗 | 删除 `index.html`、`tools/screenshot.sh`、`tools/shots-v3.sh`；`tests.html`/`compat-check.html` 移入 `checks/`，资产路径改 `../css|js`；`tools/verify.js`（3 页）、`run-tests.js`、`check.sh`、`settings-panel.js` 同步。左下角「⋮」菜单新增「兼容性自检」「回归测试」（带图标与提示），「关于 nTools」弹窗底部新增两个入口按钮。 |
| 5 | 详情右下角完成按钮改为保存 | 按钮改为「保存」（`data-act="detail-save"`），点击 `flushDetailEdits()` 提交 debounce 中的标题/备注/标签并显示绿色「已保存」+ toast，不关闭抽屉、不改变完成状态；左上角 checkbox 仍负责完成；回收站/已删除状态保存按钮隐藏。 |

## 2. 主要文件

| 文件 | 变更 |
|---|---|
| `js/icons.js` | 新增 `toolbox`、`shield` 图标 |
| `img/favicon.svg` | 新增工具箱 favicon |
| `ntools.html` | brand mark 用 toolbox；favicon/apple-touch-icon 指向 img/favicon.svg；版本 v4.3 |
| `js/ntools-app.js` | 菜单新增自检入口；关于弹窗新增两个按钮；`openSelfCheck()` 打开 `checks/...` |
| `css/tools.css` | 行右 padding 92px、tags 收缩/截断、详情保存态样式 |
| `js/todo-view.js` | titleline 顺序 pin→repeat→title→tags；详情「保存」按钮与 `flushDetailEdits` 反馈 |
| `checks/`（新） | `tests.html`、`compat-check.html` 及其 `../` 资产路径/favicon |
| `tools/verify.js` / `run-tests.js` / `check.sh` | 新页面路径与 3 页验收 |
| `tools/screenshot.sh` / `shots-v3.sh` / `index.html` | 删除（旧入口/旧截图脚本） |

## 3. 验收

| 检查 | 结果 |
|---|---|
| `bash tools/check.sh` | **7/7 全绿**（verify 3 页 / e2e / e2e-features 53 / e2e-timeline 58 / e2e-v41 / tests 81） |
| `node tools/verify.js` | ntools + checks/compat-check + checks/tests 全 PASS，console/资源 0 error |
| `node tools/run-tests.js` | checks/tests.html 81/81 |
| 手检 | brand 使用 toolbox SVG；favicon 指向 img/favicon.svg；循环图标在标题左、置顶+循环顺序正确；tags.right < actions.left（1440/390/320）；详情保存不关抽屉且 status 不变；菜单与关于弹窗入口存在并可打开 checks 页面；无 index/tests/compat 根路径残留 |
| 截图 | `/tmp/nc-shots/v43/final/`（brand / 菜单 / 关于 / 保存 / 行内）、`/tmp/nc-shots/task21/`（标签避让矩阵） |

## 4. 已知限制

- 行右 padding 92px 按“3 个操作按钮”预留；若后续行内按钮数量变化需同步调整。
- tags 52% 上限是视觉取舍；产品若希望标签优先占宽可去掉 max-width 仅保留 padding。
- `checks/` 页面为独立静态页，未做与 ntools 同一路由切换；通过菜单新标签打开，避免打断当前编辑。
- 历史 `docs/v2`、`docs/v3`、`docs/dev-contract*` 中仍保留旧文件名作为历史记录，未改写。
