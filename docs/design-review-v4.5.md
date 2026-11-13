# v4.5 设计复检：nChat 聊天域 + 设置端点列表

> 范围：nChat 工具栏 / 端点下拉与元信息 / 状态点 / 切换反馈 / 欢迎态 / 消息记录 / composer / 系统提示词 sheet / 焦点与 hover / Lite / 390 移动；设置面板「模型端点」列表（只审不改）。
> 依据：`frontend-design`（避免模板化视觉、类型与对齐、克制用色）、`apple-design`（小面积材质、层级与留白、reduced-motion）、`emil-design-eng`（对比度、hover 门控、focus、时长曲线、不要在同一个容器上叠加表演）。
> 设计方向延续 `docs/design-direction-v4.md` 的 **Precision Workbench**：石墨/纸面、发丝线、仪器蓝、铜色仅时间语义、系统字体栈、body 13.5–14px / 1.55。
> 未改 `css/tools.css`、`css/settings.css`、`js/settings-panel.js`（设置列表建议仅报告，见 §4）。

## 1. 复检方法

- 用现有真实数据（旧 nChat 合并后的端点、长模型名、主机名、深浅/Lite/390）截图对照，逐项回答三个问题：**层级是否由一字号/对齐建立而非卡片堆叠**、**主操作是否唯一且清晰**、**小字号/状态色在浅色与 Lite 下是否仍可读**。
- 只对聊天域落地改动；设置面板的问题进入 Lead 清单。
- 截图：`/tmp/nc-shots/v4.5/v45-*.png`（见 §6）。

## 2. 设计决策摘要（与 v4 方向一致，v4.5 只做收口）

| 维度 | 决策 |
| --- | --- |
| 色彩 | 仪器蓝是唯一强调；用户消息在浅色为 accent 实色+反色字、深色为 accent-soft；铜色不进入聊天 |
| 类型 | 端点选择 13.5/600（主信息）；模型 ID 用 mono 11.5；主机名 11.5 次信息；正文 13.5/1.55 |
| 层级 | 工具栏 = 端点（主）→ 模型/主机（次）→ 操作（第三层，发丝分隔）；消息 = 角色刻度 + 正文，无气泡堆叠 |
| 材质 | 工具栏/输入 dock 小面积玻璃（Lite 实色）；列表/记录无阴影 |
| 动效 | 切换/浮层 140–220ms，ease-out；Lite/reduced 关闭位移，保留即时状态 |
| 反模板 | 无 `A · B · C` 中点串、无满屏渐变、无同半径卡片套件；元信息用列与发丝线表达 |

## 3. 聊天域 Before / After（本轮已实施）

| Before | After | Why |
| --- | --- | --- |
| 工具栏端点选择 500 字重、`--nc-text-2`，与普通下拉无差别；模型与主机只靠 gap 分隔 | 端点选择 600 字重、`--nc-text`；模型 mono；主机前加 1px 发丝分隔（`css/chat.css:1858-1876`） | 工具栏的第一信息应是“在跟哪个端点说话”，层级靠字重/分隔而不是再加装饰 |
| 操作区与端点区之间无结构分隔 | `.chat-toolbar__actions` 左侧 1px 发丝线（≤768 去掉）（`css/chat.css:1879-1885,1917-1922`） | 把“切换端点”和“设置/菜单”分成两个功能区，不靠空白猜 |
| 状态点 6px、无说明；缺 Key 只能从引导条推断 | 7px 语义点 + `title`（已就绪/缺少 Key/未配置）（`js/chat-embed.js:177-213`），引导条仍保留 | 状态点是小面积的“仪器指示灯”，必须可解释 |
| 切换端点后只有内容硬切，屏幕阅读器无反馈；流式中切换可能把旧回复写进新会话 | 增加 `aria-live` 播报区 + 聊天内切换 toast + 工具栏 140ms 淡化（`js/chat-embed.js:215-236,374-422`）；流式中切换先 stop→等 finalize→再切会话（`js/chat-embed.js:394-422,424+`） | 反馈要发生在动作发生的同一时刻；跨端点写入是正确性问题，不只是动效 |
| 浅色下 composer placeholder 用 text-3，输入区提示偏淡 | placeholder 提升为 text-2 @0.82（`css/chat.css:1899-1902`） | 小字号提示也是需要读的文本 |
| 系统提示词 sheet 头部与正文之间直接堆叠，sub 用 text-3 | 头部下加发丝线；sub 提升 text-2（`css/chat.css:1905-1913`） | Sheet 是“检查器”，头/体分区要明确；说明文字要可读 |
| 端点下拉 focus 仅有边框变色 | `:focus-visible` 加 3px accent-faint 环（`css/chat.css:1848-1853`） | 键盘用户需要明确的焦点位置 |
| 切换端点时没有“正在切换”的中间状态 | `.is-switching` 让端点信息降到 55% 再恢复（140ms；Lite/reduced 无过渡）（`css/chat.css:1887-1897,1929-1941`） | 状态变化要被看见，但不能用整页动画 |
| 旧 nChat 端点合并后用户只看到配置“突然出现” | 首次合并给出一次成功 toast：「已从旧 nChat 配置合并 N 个端点」（`js/chat-embed.js` init 段） | 数据迁移是低频高影响动作，需要一次可见确认 |
| 旧配置迁移后名称可能是“端点 2” | legacy 无名称时命名为「nChat 旧端点 / nChat 端点 N」（`js/llm-store.js` merge 段） | 迁移产物要能被用户认出来 |

### 3.1 欢迎态 / 消息 / composer / Lite（复核结论）

| 项 | 结论 |
| --- | --- |
| 欢迎态 | 沿用 v4 的“工作台说明 + 发丝建议列表 + kbd 快捷键”；v4.1 的 Lead/Support 两拍入场保留；本轮只把 hint 提到 text-2（`css/chat.css` `.chat-welcome__hint`）。不引入大图标/大留白。 |
| 消息记录 | 助手全宽 + 左侧“助手”刻度、用户右侧 accent 块；操作按钮 hover/focus 显现，触屏常显（v4 已实现）。本轮不改 DOM 契约。 |
| Composer | 发丝线 dock + 柔和 focus + 单色 accent 发送；本轮只提高 placeholder 对比度。 |
| Lite | 玻璃→实色、阴影→无、位移动画→关；切换反馈不做透明度过渡（`css/chat.css:1929-1941`）。 |

## 4. 设置面板「模型端点」列表审查（Lead 域，仅报告）

现状（截图 `v45-settings-profiles-{dark,light}-1440.png`）：行内 dot + 名称 + 模型/URL + 当前 badge + 行内编辑/删除，选中行左侧 2px accent 刻度，结构整体符合 Precision Workbench。

| Before | 建议 After | Why |
| --- | --- | --- |
| 行元信息是 `model · url` 的 2px 圆点分隔（`css/settings.css:818-850`） | 与聊天工具栏一致：模型（mono）+ 1px 发丝/10px 间距 + URL；或两列网格 | 设计方向明确禁止中点串作为元信息；同一产品内两种分隔语法会显得拼装 |
| `.sp-profile__meta` 用 `--nc-text-3`（`css/settings.css:818-826`） | 提升为 `--nc-text-2`；URL 保留次级色 | 浅色下 text-3 用于 11.5px 元信息对比不足（约 3:1） |
| 模型/URL 同一行 flex-wrap，URL 极长时换行且与下一行对齐不稳定 | 两列：模型固定宽度，URL `min-width:0` + ellipsis；超长时单行截断并用 title 提供全文 | 端点列表是“表格化检查器”，列对齐比换行更重要 |
| 区标题下没有端点数量 | 在 desc/subtitle 里补「共 N 个端点」 | 工作台页面头条需要关键数字（设计方向 §2.3） |
| 旧 nChat 配置只能靠启动自动合并，没有手动入口 | 在「数据」或「模型端点」区增加次要按钮「从旧 nChat 导入端点」，调用 `NC.store.llm.importLegacy()` 并 toast 返回结果 | 自动合并是一次性的；给需要恢复的用户一个显式路径（API 已实现，见 §5） |
| 行高随 actions 显隐/编辑态变化（未选中行与选中行高度不同） | 行高固定（actions 区域预留空间或 overlay）；编辑态单独展开 | 列表跳读时行高稳定有助于扫视 |
| 已做得好的：状态 dot、当前 badge、hover/focus 才显示操作、触屏常显、删除二次确认、密钥可显示 | 保持 | 与聊天域同一套 hover/focus 规则 |

> 如需我代为修改 `settings.css` / `settings-panel.js`，请明确授权；本轮未改。

## 5. 旧 nChat 端点兼容（功能实现摘要）

- **KEY 已存在也合并**：`llm-store.init()` 在已存在 `ntools.llm.v1` 且 `legacyMerged !== true` 时读取 `nchat-settings`，一次合并后写 `legacyMerged:true / legacyMergedAt`；`normalizeDoc` 保留标记，刷新不再导入。
- **两种旧形状**：`{currentId, configs[]}` 与单对象 `{apiUrl, apiKey, modelId, systemPrompt, temperature, top_p}`；字段归一 `apiUrl→baseUrl`、`systemPrompt→chatSystemPrompt`、`top_p→topP`。
- **去重**：先按 id；再按 `baseUrl+modelId`。若匹配的是“默认端点”占位（默认名/无 Key/无提示词），采纳旧 id 与旧数据以保留旧 `nchat-conversation` 的 session key；否则只补空字段，不覆盖用户新配置。
- **当前端点**：`currentId` 对应项按 id→pair 映射后设为当前；单对象无 currentId 时默认设为当前。
- **不复活**：`reset()`、`importAll()` 都会置 `legacyMerged=true`；删除合并后的端点刷新不会重新导入。
- **显式入口**：`NC.store.llm.importLegacy()` 供设置面板/调试使用（返回 `{ok, imported, updated, skipped, currentProfileId, message}`）；建议 Lead 接一个按钮（见 §4）。
- **不再产生副作用**：无 legacy 或无 llm 时行为不变（`KEY` 缺省→旧迁移路径保留；`KEY` 存在且无 legacy→仅多一次安全读取）。

## 6. 验收与截图

- `node --check js/*.js`：通过。
- `node tools/verify.js ntools.html` / `index.html`：全 PASS。
- `node tools/e2e-features.js`：53/53 PASS；`node tools/e2e-v41.js`：全 PASS。
- 自测：
  - legacy 兼容用例 17/17（KEY 存在+legacy 合并、旧 id 保留、currentId、聊天下拉/meta、只导入一次、删除不复活、无 legacy 不变、KEY 缺省迁移、单对象字段映射、pair 去重不覆盖新 Key、显式 importLegacy）。
  - v4.5 端点/切换 QA 10/10（工具栏层级/meta 两列无中点/状态点 title/aria-live/发丝分隔；流式中切换：旧会话保留已生成内容、新会话为空、无残留 typing/流式、播报更新、切换瞬间未提前切会话）。
- 截图（`/tmp/nc-shots/v4.5/`）：`v45-legacy-merged-dark-1440.png`、`v45-legacy-chat-dark-1440.png`、`v45-switch-feedback-dark-1440.png`、`v45-chat-light-1440.png`、`v45-chat-lite-dark-1440.png`、`v45-chat-dark-390.png`、`v45-settings-profiles-dark-1440.png`、`v45-settings-profiles-light-1440.png`、`v45-welcome-dark-1440.png`、`v45-welcome-lite-dark-1440.png`。

## 7. 未覆盖 / 需真机确认

- 1440 之外的 125%/150% 系统缩放下，工具栏模型/主机列与 390 下拉宽度的实际断行。
- 触屏真机（奇安信/麒麟）上端点切换 toast 与软键盘同时出现时的输入 dock 位置。
- 旧 nChat 用户真实数据里可能存在非标准 `configs`（缺失 id、字符串 id、超长 systemPrompt）；当前归一已覆盖，但建议在现场用一份真实旧配置跑一次迁移。
