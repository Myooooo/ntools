/**
 * todo-timeline.js — Todo「全景时间线」独立视图（经典脚本，无构建链）
 *
 * 挂载：NC.timeline.mount(container[, options]) / unmount() / refresh()
 * 数据：只读 NC.store.todo（getDoc / getUi / subscribe）；任务点击 → NC.store.todo.selectTask(id)，
 *       本模块不修改 store 数据。
 * 集成：A 的 NC.tools.todo.setMode('timeline') 在切到时间线时调用 mount(#todo-timeline)，
 *       切回列表时调用 unmount()；DOM 容器由 ntools.html 提供。
 *
 * 视图：
 *  - ≥900px（容器宽）：横向时间轴（可横向滚动），日/小时刻度随范围自适应，任务按 due 放置、
 *    重叠自动分道，含「现在」线、置顶/逾期/优先级/循环/完成状态标识。
 *  - <900px：纵向时间流水（按天分组）+ 范围控件，避免横向挤压。
 *  - 范围框选：刻度区指针拖拽框选（实时高亮、松开生效），双击/重置恢复默认；
 *    起止 datetime-local 输入 + 预设（未来 3 天 / 本周 / 本月）。
 *  - 性能：只渲染 due 且在范围内的任务；rAF 节流重绘；渲染数量上限保护；Lite/reduced-motion 关闭动效。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    /* ------------------------------------------------------------------ *
     * 常量与状态
     * ------------------------------------------------------------------ */
    var DAY = 86400000;
    var HOUR = 3600000;
    var MINUTE = 60000;
    var DEFAULT_DAYS = 7;          // 默认向前看 7 天
    var MAX_DEFAULT_LOOKBACK = 45 * DAY;   // 默认范围向左最多回看 45 天
    var MAX_DEFAULT_SPAN = 60 * DAY;       // 数据化默认范围最大跨度 60 天
    var MIN_SPAN = 15 * MINUTE;
    var HORIZONTAL_MIN_WIDTH = 900;
    var MAX_RENDER = 220;          // 单次渲染任务上限（护栏；正常范围远小于此）
    var MAX_LANES = 60;            // 泳道安全上限（数据化默认范围可能包含更多任务；极端数据折叠提示）
    var AXIS_H = 54;               // 刻度区高度
    var LANE_H = 46;               // 每条泳道高度
    var CHIP_H = 36;               // 任务 chip 高度
    var BAR_MIN_W = 48;            // 极短任务的最小可视宽度（右端锚定 due）
    var BAR_GAP = 6;               // 分道时条与条之间的最小间隙
    var REVEAL_MS = 520;

    var PRESETS = [
        { id: 'next3', label: '未来 3 天' },
        { id: 'week', label: '本周' },
        { id: 'month', label: '本月' },
        { id: 'reset', label: '重置' }
    ];

    var refs = {
        container: null,
        root: null,
        head: null,
        rangeLabel: null,
        startInput: null,
        endInput: null,
        presetWrap: null,
        showDoneInput: null,
        statsWrap: null,
        body: null,
        canvas: null,
        axis: null,
        brushLayer: null,
        brushLive: null,
        brushTip: null,
        chips: null,
        nowLine: null,
        agenda: null,
        empty: null
    };

    var state = {
        mounted: false,
        mode: 'h',
        width: 0,
        range: null,
        showCompleted: true,
        selectedId: null,
        offStore: null,
        resizeObserver: null,
        rafId: null,
        pendingForce: false,
        revealDone: false,
        revealTimer: null,
        lastData: null,
        brush: null,
        mountCount: 0
    };

    var memory = {
        range: null       // 范围仅内存持久化：跨 mount 保留
    };

    /* ------------------------------------------------------------------ *
     * 小工具（优先复用 NC.util，保持模块可独立测试）
     * ------------------------------------------------------------------ */
    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

    function isFiniteNum(value) { return typeof value === 'number' && isFinite(value); }

    function rafThrottle(fn) {
        var scheduled = false;
        var lastArgs = null;
        return function () {
            lastArgs = arguments;
            if (scheduled) return;
            scheduled = true;
            (global.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); })(function () {
                scheduled = false;
                fn.apply(null, lastArgs || []);
            });
        };
    }

    function icon(name, size) {
        if (NC.icons && typeof NC.icons.el === 'function') {
            try {
                var node = NC.icons.el(name, size || 14);
                if (node) return node;
            } catch (err) { /* fallback */ }
        }
        var span = document.createElement('span');
        span.className = 'tl-glyph tl-glyph--' + name;
        span.setAttribute('aria-hidden', 'true');
        span.textContent = name === 'flag' ? '⚑' : name === 'refresh' ? '↻' : name === 'alert' ? '!' : '•';
        return span;
    }

    function node(tag, className, text) {
        var element = document.createElement(tag);
        if (className) element.className = className;
        if (text != null) element.textContent = String(text);
        return element;
    }

    function clear(element) {
        if (!element) return;
        while (element.firstChild) element.removeChild(element.firstChild);
    }

    function attr(element, name, value) {
        if (value == null || value === false) element.removeAttribute(name);
        else element.setAttribute(name, String(value));
        return element;
    }

    /* ------------------------------------------------------------------ *
     * 时间/范围
     * ------------------------------------------------------------------ */
    function startOfDay(ts) {
        var date = new Date(ts);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    }

    function endOfDay(ts) { return startOfDay(ts) + DAY - 1; }

    function addDays(ts, days) {
        var date = new Date(ts);
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), 0, 0).getTime();
    }

    function startOfWeekMonday(ts) {
        var date = new Date(startOfDay(ts));
        var weekday = date.getDay(); // 0=周日
        var delta = weekday === 0 ? -6 : 1 - weekday;
        return addDays(date.getTime(), delta);
    }

    function startOfMonth(ts) {
        var date = new Date(ts);
        return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0).getTime();
    }

    function endOfMonth(ts) {
        var date = new Date(ts);
        return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    }

    function formatTime(ts) {
        var date = new Date(ts);
        return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    function formatDateShort(ts) {
        var date = new Date(ts);
        return (date.getMonth() + 1) + '月' + date.getDate() + '日';
    }

    function formatDateTimeInput(ts) {
        var date = new Date(ts);
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
            'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    function parseDateTimeInput(value) {
        if (!value) return null;
        var ts = new Date(value).getTime();
        return isFiniteNum(ts) ? ts : null;
    }

    function weekdayLabel(ts) {
        return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(ts).getDay()];
    }

    function dayTitle(ts, now) {
        var today = startOfDay(now == null ? Date.now() : now);
        var target = startOfDay(ts);
        var diff = Math.round((target - today) / DAY);
        var date = new Date(ts);
        var label = (date.getMonth() + 1) + '月' + date.getDate() + '日';
        if (diff === 0) return '今天 · ' + label;
        if (diff === 1) return '明天 · ' + label;
        if (diff === 2) return '后天 · ' + label;
        return weekdayLabel(ts) + ' · ' + label;
    }

    function formatRange(range) {
        if (!range) return '';
        var span = range.end - range.start;
        var days = span / DAY;
        var daysLabel = days >= 1 ? (Math.round(days * 10) / 10) + ' 天' : Math.round(span / HOUR) + ' 小时';
        return formatDateShort(range.start) + ' ' + formatTime(range.start) + ' – ' +
            formatDateShort(range.end) + ' ' + formatTime(range.end) + '（' + daysLabel + '）';
    }

    function normalizeRange(start, end) {
        var a = Number(start);
        var b = Number(end);
        if (!isFiniteNum(a) || !isFiniteNum(b)) return null;
        if (b < a) { var swap = a; a = b; b = swap; }
        if (b - a < MIN_SPAN) b = a + MIN_SPAN;
        return { start: Math.round(a), end: Math.round(b) };
    }

    /**
     * 当前左侧筛选（selectVisible）后的任务集合；时间线只关心有 due 的任务。
     * @returns {{tasks: Array, withDue: Array}}
     */
    function filteredDueTasks(now) {
        var todoStore = store();
        var ts = isFiniteNum(now) ? now : Date.now();
        var empty = { tasks: [], withDue: [] };
        if (!todoStore || typeof todoStore.getDoc !== 'function') return empty;
        var doc = todoStore.getDoc();
        var filtered = [];
        if (typeof todoStore.selectVisible === 'function') {
            var selected = todoStore.selectVisible(ts);
            filtered = (selected && Array.isArray(selected.tasks)) ? selected.tasks : [];
        } else {
            filtered = Array.isArray(doc && doc.tasks) ? doc.tasks : [];
        }
        var tasks = filtered.filter(function (task) { return task && !task.deletedAt; });
        var withDue = tasks.filter(function (task) { return isFiniteNum(task.due); });
        return { tasks: tasks, withDue: withDue };
    }

    /**
     * 数据化默认范围：
     *  start = 当前筛选后最早 createdAt（向下取整到小时），且不早于 now-45d；
     *  end   = max(now+7d, 起点+7d, 起点窗口内任务的最晚 due)，上限 start+60d；
     *  无任何可推导的 createdAt/due 时回退 now → now+7d。
     * 让「创建→到期」时长条默认完整显示（只有用户手动缩小范围才出现裁剪标记）。
     */
    function dataDefaultRange(now) {
        var current = isFiniteNum(now) ? now : Date.now();
        var withDue = filteredDueTasks(current).withDue;
        if (!withDue.length) return normalizeRange(current, current + DEFAULT_DAYS * DAY);
        var forward = current + DEFAULT_DAYS * DAY;
        var earliest = Infinity;
        var latestDue = forward;
        withDue.forEach(function (task) {
            var interval = taskInterval(task);
            if (interval.start < earliest) earliest = interval.start;
            // “主要 due”：起点落在默认前向窗口内的任务，其到期时间要完整纳入默认范围
            if (interval.start <= forward && task.due > latestDue) latestDue = task.due;
        });
        var start = Math.floor(Math.min(earliest, current) / HOUR) * HOUR;
        start = Math.max(start, current - MAX_DEFAULT_LOOKBACK);
        var end = Math.max(latestDue, forward, start + DEFAULT_DAYS * DAY);
        end = Math.min(end, start + MAX_DEFAULT_SPAN);
        return normalizeRange(start, end);
    }

    function defaultRange(now) {
        return dataDefaultRange(now);
    }

    function presetRange(id, now) {
        var current = isFiniteNum(now) ? now : Date.now();
        if (id === 'next3') return normalizeRange(current, current + 3 * DAY);
        if (id === 'week') return normalizeRange(startOfWeekMonday(current), endOfDay(addDays(startOfWeekMonday(current), 6)));
        if (id === 'month') return normalizeRange(startOfMonth(current), endOfMonth(current));
        return defaultRange(current);
    }

    function ensureRange() {
        if (state.range) return state.range;
        if (memory.range) state.range = normalizeRange(memory.range.start, memory.range.end) || defaultRange();
        else state.range = defaultRange();
        return state.range;
    }

    function setRange(range, options) {
        var next = normalizeRange(range && range.start, range && range.end);
        if (!next) return false;
        var opts = options || {};
        state.range = next;
        memory.range = { start: next.start, end: next.end };
        if (opts.scrollToStart) state.scrollToStart = true;
        render(true);
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 数据读取（只读）
     * ------------------------------------------------------------------ */
    function store() {
        return (NC.store && NC.store.todo) ? NC.store.todo : null;
    }

    function priorityWeight(priority) {
        if (priority === 'urgent') return 4;
        if (priority === 'high') return 3;
        if (priority === 'low') return 1;
        return 2;
    }

    function formatDuration(ms) {
        var value = Number(ms);
        if (!isFinite(value) || value <= 0) return '0 分钟';
        var minutes = Math.round(value / MINUTE);
        if (minutes < 60) return Math.max(1, minutes) + ' 分钟';
        var hours = value / HOUR;
        if (hours < 24) return (Math.round(hours * 10) / 10) + ' 小时';
        return (Math.round((hours / 24) * 10) / 10) + ' 天';
    }

    function formatDateTimeFull(ts) {
        var date = new Date(ts);
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
            ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    /** 任务时间区间：createdAt → due（异常时回退到 due 单点） */
    function taskInterval(task) {
        var due = task.due;
        var start = isFiniteNum(task.createdAt) ? task.createdAt : due;
        if (start > due) start = due;
        return { start: start, end: due };
    }

    function byIntervalStart(a, b) {
        var ia = taskInterval(a);
        var ib = taskInterval(b);
        if (ia.start !== ib.start) return ia.start - ib.start;
        if (ia.end !== ib.end) return ia.end - ib.end;
        if ((a.pinned === true) !== (b.pinned === true)) return a.pinned ? -1 : 1;
        return priorityWeight(b.priority) - priorityWeight(a.priority);
    }

    function taskBadges(task, now) {
        var badges = [];
        if (task.pinned === true || task.pin === true) badges.push('pin');
        if (task.recurrence) badges.push('repeat');
        if (task.status === 'open' && isFiniteNum(task.due) && task.due < now) badges.push('overdue');
        return badges;
    }

    function collect() {
        var todoStore = store();
        var now = Date.now();
        var range = ensureRange();
        var base = {
            now: now,
            range: range,
            showCompleted: true,
            total: 0, withDue: 0, inRange: 0, visible: 0, outRange: 0,
            overdue: 0, pinned: 0, hiddenDone: 0,
            visibleItems: [], inRangeTasks: [], nextOut: null
        };
        if (!todoStore || typeof todoStore.getDoc !== 'function') return base;
        var doc = todoStore.getDoc();
        base.showCompleted = (typeof state.localShowCompleted === 'boolean')
            ? state.localShowCompleted
            : !!(doc && doc.settings && doc.settings.showCompleted !== false);

        // 左侧视图/清单/搜索/状态筛选：以 store 的 selectVisible 为准（全部/今天/逾期/已完成 + listId + search）
        var pack = filteredDueTasks(now);
        var tasks = pack.tasks;
        var withDue = pack.withDue;
        base.total = tasks.length;
        // 时间线只关心有 due 的任务；无日期任务完全不纳入（不统计、不展示）
        base.withDue = withDue.length;

        var inRange = [];
        var edgeOverdue = [];
        withDue.forEach(function (task) {
            var interval = taskInterval(task);
            if (interval.end < range.start) {
                if (task.status === 'open') edgeOverdue.push(task);
                return;
            }
            if (interval.start > range.end) return;
            inRange.push(task);
        });
        inRange.sort(byIntervalStart);
        edgeOverdue.sort(function (a, b) { return a.due - b.due; });
        edgeOverdue = edgeOverdue.slice(0, 12);

        // “显示已完成”与 doc.settings.showCompleted 同步；view=done 时仍显示已完成
        var visible = inRange.filter(function (task) {
            var finished = task.status === 'done' || task.status === 'canceled';
            return base.showCompleted || !finished;
        });
        var items = visible.map(function (task) { return { task: task, edge: false }; });
        edgeOverdue.forEach(function (task) { items.push({ task: task, edge: true }); });

        base.inRangeTasks = inRange;
        base.inRange = inRange.length;
        base.visibleItems = items;
        base.visible = items.length;
        base.edgeOverdue = edgeOverdue.length;
        base.hiddenDone = inRange.length - visible.length;
        base.outRange = Math.max(0, withDue.length - inRange.length - edgeOverdue.length);
        base.overdue = items.filter(function (item) { return item.task.status === 'open' && item.task.due < now; }).length;
        base.pinned = items.filter(function (item) { return item.task.pinned === true || item.task.pin === true; }).length;
        withDue.forEach(function (task) {
            if (task.due < range.start) {
                if (!base.nextOut || task.due > base.nextOut.due) base.nextOut = task;
            } else if (task.due > range.end) {
                if (!base.nextOut || task.due < base.nextOut.due) base.nextOut = task;
            }
        });
        return base;
    }

    /* ------------------------------------------------------------------ *
     * 渲染：骨架
     * ------------------------------------------------------------------ */
    function buildSkeleton() {
        var root = node('div', 'tl-root');
        root.setAttribute('data-timeline', 'root');

        var head = node('div', 'tl-head');
        var titleRow = node('div', 'tl-title-row');
        var titles = node('div', 'tl-titles');
        titles.appendChild(node('h2', 'tl-title', '全景时间线'));
        var rangeLabel = node('div', 'tl-range-label');
        titles.appendChild(rangeLabel);
        titleRow.appendChild(titles);
        var statsWrap = node('div', 'tl-stats');
        titleRow.appendChild(statsWrap);
        head.appendChild(titleRow);

        var controls = node('div', 'tl-controls');
        var rangeGroup = node('div', 'tl-range-group');
        var startField = node('label', 'tl-field');
        startField.appendChild(node('span', 'tl-field__label', '开始'));
        var startInput = node('input', 'nc-input tl-field__input');
        attr(startInput, 'type', 'datetime-local');
        attr(startInput, 'step', '900');
        attr(startInput, 'aria-label', '时间线开始时间');
        startField.appendChild(startInput);
        var endField = node('label', 'tl-field');
        endField.appendChild(node('span', 'tl-field__label', '结束'));
        var endInput = node('input', 'nc-input tl-field__input');
        attr(endInput, 'type', 'datetime-local');
        attr(endInput, 'step', '900');
        attr(endInput, 'aria-label', '时间线结束时间');
        endField.appendChild(endInput);
        rangeGroup.appendChild(startField);
        rangeGroup.appendChild(endField);
        controls.appendChild(rangeGroup);

        var presetWrap = node('div', 'tl-presets');
        PRESETS.forEach(function (preset) {
            var button = node('button', 'nc-btn nc-btn--sm tl-preset', preset.label);
            attr(button, 'type', 'button');
            attr(button, 'data-preset', preset.id);
            presetWrap.appendChild(button);
        });
        controls.appendChild(presetWrap);

        var extra = node('div', 'tl-extra');
        var showDoneLabel = node('label', 'nc-switch tl-switch');
        var showDoneInput = node('input');
        attr(showDoneInput, 'type', 'checkbox');
        attr(showDoneInput, 'aria-label', '显示已完成和已取消任务');
        showDoneInput.checked = true;
        showDoneLabel.appendChild(showDoneInput);
        showDoneLabel.appendChild(node('span', 'nc-switch__track'));
        showDoneLabel.appendChild(node('span', 'tl-switch__text', '显示已完成'));
        extra.appendChild(showDoneLabel);
        var fitButton = node('button', 'nc-btn nc-btn--ghost nc-btn--sm', '扩展至全部');
        attr(fitButton, 'type', 'button');
        attr(fitButton, 'data-action', 'fit-all');
        extra.appendChild(fitButton);
        controls.appendChild(extra);
        head.appendChild(controls);

        var legend = node('div', 'tl-legend');
        head.appendChild(legend);
        root.appendChild(head);

        var body = node('div', 'tl-body');
        // 横向
        var hWrap = node('div', 'tl-hnc');
        var scroll = node('div', 'tl-scroll');
        var canvas = node('div', 'tl-canvas');
        var axis = node('div', 'tl-axis');
        var brushLayer = node('div', 'tl-brush-layer');
        attr(brushLayer, 'role', 'application');
        attr(brushLayer, 'tabindex', '0');
        attr(brushLayer, 'aria-label', '时间范围框选：在刻度区按住拖动选择起止时间，双击恢复默认范围');
        var brushLive = node('div', 'tl-brush-live');
        attr(brushLive, 'hidden', 'hidden');
        var brushTip = node('div', 'tl-brush-tip');
        attr(brushTip, 'hidden', 'hidden');
        var chips = node('div', 'tl-chips');
        var nowLine = node('div', 'tl-now');
        attr(nowLine, 'hidden', 'hidden');
        canvas.appendChild(axis);
        canvas.appendChild(brushLayer);
        canvas.appendChild(chips);
        canvas.appendChild(nowLine);
        brushLayer.appendChild(brushLive);
        brushLayer.appendChild(brushTip);
        scroll.appendChild(canvas);
        hWrap.appendChild(scroll);
        body.appendChild(hWrap);
        // 纵向
        var agenda = node('div', 'tl-agenda');
        attr(agenda, 'hidden', 'hidden');
        body.appendChild(agenda);
        // 空状态
        var empty = node('div', 'tl-empty');
        attr(empty, 'hidden', 'hidden');
        body.appendChild(empty);
        root.appendChild(body);

        var foot = node('div', 'tl-foot', '拖动刻度区框选时间范围 · 双击刻度区重置 · 点击任务查看详情');
        root.appendChild(foot);

        refs.root = root;
        refs.head = head;
        refs.rangeLabel = rangeLabel;
        refs.startInput = startInput;
        refs.endInput = endInput;
        refs.presetWrap = presetWrap;
        refs.showDoneInput = showDoneInput;
        refs.statsWrap = statsWrap;
        refs.legend = legend;
        refs.body = body;
        refs.hWrap = hWrap;
        refs.scroll = scroll;
        refs.canvas = canvas;
        refs.axis = axis;
        refs.brushLayer = brushLayer;
        refs.brushLive = brushLive;
        refs.brushTip = brushTip;
        refs.chips = chips;
        refs.nowLine = nowLine;
        refs.agenda = agenda;
        refs.empty = empty;
        refs.fitButton = fitButton;

        return root;
    }

    /* ------------------------------------------------------------------ *
     * 渲染：工具栏 / 统计
     * ------------------------------------------------------------------ */
    function updateToolbar(data) {
        var range = data.range;
        if (refs.rangeLabel) refs.rangeLabel.textContent = formatRange(range);
        if (refs.startInput) refs.startInput.value = formatDateTimeInput(range.start);
        if (refs.endInput) refs.endInput.value = formatDateTimeInput(range.end);
        if (refs.showDoneInput) refs.showDoneInput.checked = !!data.showCompleted;
        if (refs.statsWrap) {
            clear(refs.statsWrap);
            refs.statsWrap.appendChild(statPill('范围内', data.inRange, 'accent'));
            if (data.overdue) refs.statsWrap.appendChild(statPill('逾期', data.overdue, 'danger'));
            if (data.pinned) refs.statsWrap.appendChild(statPill('置顶', data.pinned, 'warning'));
            if (data.outRange) refs.statsWrap.appendChild(statPill('范围外', data.outRange, 'muted'));
        }
        if (refs.legend) {
            clear(refs.legend);
            var items = [
                { cls: 'is-pinned', text: '置顶', icon: 'flag' },
                { cls: 'is-recurring', text: '循环', icon: 'refresh' },
                { cls: 'is-overdue', text: '逾期', icon: 'alert' },
                { cls: 'is-down', text: '已完成（弱化）', icon: 'check' }
            ];
            items.forEach(function (item) {
                var span = node('span', 'tl-legend__item ' + item.cls);
                span.appendChild(icon(item.icon, 12));
                span.appendChild(node('span', null, item.text));
                refs.legend.appendChild(span);
            });
            var barItem = node('span', 'tl-legend__item tl-legend__item--duration');
            barItem.appendChild(icon('clock', 12));
            barItem.appendChild(node('span', null, '条长 = 创建 → 到期'));
            refs.legend.appendChild(barItem);
            var rangeItem = node('span', 'tl-legend__item tl-legend__item--range');
            rangeItem.appendChild(icon('filter', 12));
            rangeItem.appendChild(node('span', null, '拖拽刻度区框选范围'));
            refs.legend.appendChild(rangeItem);
        }
        // 预设 active
        if (refs.presetWrap) {
            var now = Date.now();
            Array.prototype.forEach.call(refs.presetWrap.children, function (button) {
                var id = button.getAttribute('data-preset');
                var match = false;
                if (id && id !== 'reset') {
                    var preset = presetRange(id, now);
                    match = preset && Math.abs(preset.start - range.start) < MINUTE && Math.abs(preset.end - range.end) < MINUTE;
                }
                button.classList.toggle('is-active', !!match);
            });
        }
    }

    function statPill(label, value, tone) {
        var span = node('span', 'tl-stat tl-stat--' + tone);
        span.appendChild(node('span', 'tl-stat__value', value));
        span.appendChild(node('span', 'tl-stat__label', label));
        return span;
    }

    /* ------------------------------------------------------------------ *
     * 渲染：横向时间轴
     * ------------------------------------------------------------------ */
    function pickDayWidth(spanDays) {
        if (spanDays <= 0.4) return 520;   // ≤~10h：小时为主
        if (spanDays <= 1.2) return 340;
        if (spanDays <= 3.5) return 240;
        if (spanDays <= 7.5) return 168;
        if (spanDays <= 14.5) return 118;
        if (spanDays <= 45) return 66;
        return 40;
    }

    function formatTick(ts, stepHours) {
        var date = new Date(ts);
        if (stepHours >= 24) return (date.getMonth() + 1) + '/' + date.getDate();
        return pad2(date.getHours()) + ':00';
    }

    function renderHorizontal(data) {
        var range = data.range;
        var span = range.end - range.start;
        var spanDays = span / DAY;
        var dayWidth = pickDayWidth(spanDays);
        var canvasWidth = Math.max(320, Math.round(spanDays * dayWidth));
        var viewportWidth = (refs.scroll && refs.scroll.clientWidth) || state.width || 0;
        canvasWidth = Math.max(canvasWidth, viewportWidth);
        var pxPerMs = canvasWidth / span;
        var now = Date.now();

        refs.canvas.style.width = canvasWidth + 'px';
        refs.canvas.style.setProperty('--tl-axis-h', AXIS_H + 'px');
        refs.canvas.classList.add('tl-canvas--h');
        clear(refs.axis);
        clear(refs.chips);

        // 天网格 + 刻度
        var firstDay = startOfDay(range.start);
        var lastDay = startOfDay(range.end);
        var dayCells = [];
        var cursor = firstDay;
        var guard = 0;
        while (cursor <= lastDay && guard++ < 400) {
            dayCells.push(cursor);
            cursor = addDays(cursor, 1);
        }
        var tickMode = spanDays <= 1.4 ? 'hour' : (dayWidth >= 200 ? 'halfday' : 'day');
        var labelStep = spanDays > 45 ? 7 : (spanDays > 21 ? 3 : (spanDays > 10 ? 2 : 1));
        var sparseTicks = dayWidth < 70;
        dayCells.forEach(function (dayStart, dayIndex) {
            var left = (dayStart - range.start) * pxPerMs;
            var width = Math.min(DAY, range.end - dayStart) * pxPerMs;
            if (width <= 0) return;
            var band = node('div', 'tl-dayband' + (dayCells.indexOf(dayStart) % 2 ? ' is-alt' : ''));
            band.style.left = left + 'px';
            band.style.width = width + 'px';
            var isToday = startOfDay(dayStart) === startOfDay(now);
            if (isToday) band.classList.add('is-today');
            refs.canvas.appendChild(band);

            var cell = node('div', 'tl-daycell' + (isToday ? ' is-today' : ''));
            cell.style.left = left + 'px';
            cell.style.width = width + 'px';
            var head = node('div', 'tl-daycell__head');
            var showLabel = dayIndex % labelStep === 0 || isToday || dayIndex === dayCells.length - 1;
            if (showLabel) {
                var dayDate = new Date(dayStart);
                var labelText = (labelStep > 1 && !isToday)
                    ? (dayDate.getMonth() + 1) + '/' + dayDate.getDate()
                    : dayTitle(dayStart, now);
                head.appendChild(node('span', 'tl-daycell__title', labelText));
            }
            cell.appendChild(head);
            if (!sparseTicks) {
                var ticks = node('div', 'tl-daycell__ticks');
                var stepHours = tickMode === 'hour' ? 3 : (tickMode === 'halfday' ? 12 : 24);
                for (var hour = 0; hour < 24; hour += stepHours) {
                    var tickTs = dayStart + hour * HOUR;
                    if (tickTs < range.start || tickTs > range.end) continue;
                    var tick = node('div', 'tl-tick');
                    tick.style.left = (((tickTs - dayStart) / DAY) * 100) + '%';
                    tick.appendChild(node('span', 'tl-tick__label', formatTick(tickTs, stepHours)));
                    ticks.appendChild(tick);
                }
                cell.appendChild(ticks);
            }
            refs.axis.appendChild(cell);
        });

        // 现在线
        var nowInside = now >= range.start && now <= range.end;
        if (nowInside) {
            refs.nowLine.removeAttribute('hidden');
            refs.nowLine.style.left = Math.round((now - range.start) * pxPerMs) + 'px';
            refs.nowLine.setAttribute('data-time', '现在 ' + formatTime(now));
        } else {
            refs.nowLine.setAttribute('hidden', 'hidden');
        }

        // 时长条：createdAt → due（按比例尺计算宽度，裁剪到当前范围）
        var visible = data.visibleItems.slice(0, MAX_RENDER);
        var bars = [];
        visible.forEach(function (item) {
            var task = item.task;
            var interval = taskInterval(task);
            var clipStart = interval.start < range.start;
            var clipEnd = interval.end > range.end;
            var startClamped = Math.min(Math.max(interval.start, range.start), range.end);
            var endClamped = Math.min(Math.max(interval.end, range.start), range.end);
            var x1 = (startClamped - range.start) * pxPerMs;
            var x2 = (endClamped - range.start) * pxPerMs;
            if (item.edge) {
                x1 = 0;
                x2 = Math.min(BAR_MIN_W, canvasWidth);
                clipStart = true;
                clipEnd = true;
            }
            if (!item.edge && interval.start > range.end) return;
            if (!item.edge && interval.end < range.start) return;
            var width = x2 - x1;
            var shortBar = width < BAR_MIN_W;
            if (shortBar) {
                width = BAR_MIN_W;
                x1 = x2 - BAR_MIN_W;          // 右端锚定 due
                if (x1 < 0) {
                    x1 = 0;
                    clipStart = true;
                }
            }
            if (x2 > canvasWidth) {
                x2 = canvasWidth;
                width = Math.min(width, canvasWidth - x1);
                clipEnd = true;
            }
            bars.push({
                task: task, x: x1, width: Math.max(BAR_MIN_W, width),
                clipStart: clipStart, clipEnd: clipEnd,
                shortBar: shortBar || item.edge, edge: item.edge
            });
        });
        // 区间贪心分道：[start, end) 不重叠（含最小间隙）
        bars.sort(function (a, b) { return a.x - b.x || a.width - b.width; });
        var laneEnds = [];
        var laneCount = 0;
        var hiddenOverlap = 0;
        bars.forEach(function (bar) {
            var lane = -1;
            for (var index = 0; index < laneEnds.length; index += 1) {
                if (laneEnds[index] + BAR_GAP <= bar.x) { lane = index; break; }
            }
            if (lane === -1) {
                if (laneEnds.length >= MAX_LANES) {
                    // 泳道已满：折叠而不是无限阶梯，避免同起点任务把视图撑成楼梯
                    bar.hidden = true;
                    hiddenOverlap += 1;
                    return;
                }
                lane = laneEnds.length;
                laneEnds.push(0);
            }
            laneEnds[lane] = bar.x + bar.width;
            laneCount = Math.max(laneCount, lane + 1);
            bar.lane = lane;
        });

        var canvasHeight = AXIS_H + Math.max(1, laneCount) * LANE_H + 18;
        refs.canvas.style.height = canvasHeight + 'px';

        var renderedCount = 0;
        bars.forEach(function (bar, index) {
            if (bar.hidden) return;
            renderedCount += 1;
            var chip = buildBar(bar.task, now, bar);
            chip.style.left = Math.max(0, Math.round(bar.x)) + 'px';
            chip.style.top = (AXIS_H + bar.lane * LANE_H + 5) + 'px';
            chip.style.width = Math.round(bar.width) + 'px';
            chip.style.setProperty('--tl-chip-i', Math.min(index, 20));
            refs.chips.appendChild(chip);
        });
        state.lastRendered = renderedCount;
        state.lastHiddenOverlap = hiddenOverlap;

        // 范围变化/首次挂载：把视口滚到「现在」附近，避免默认范围很长时打开停在空白左缘
        var rangeKey = range.start + ':' + range.end;
        if (state.lastRangeKey !== rangeKey) {
            state.lastRangeKey = rangeKey;
            if (now >= range.start && now <= range.end && refs.scroll) {
                var viewport = refs.scroll.clientWidth || 0;
                var nowX = (now - range.start) * pxPerMs;
                refs.scroll.scrollLeft = Math.max(0, Math.round(nowX - Math.max(120, viewport * 0.28)));
            }
        }

        var emptyText = null;
        if (!bars.length) {
            if (data.withDue === 0) emptyText = '当前筛选下还没有带截止时间的任务。在列表视图给任务设置截止时间后，这里会自动出现。';
            else emptyText = '此范围内没有任务。可拖拽刻度区或使用预设调整范围。';
        }
        showEmpty(emptyText);
        var note = null;
        if (hiddenOverlap > 0) note = '有 ' + hiddenOverlap + ' 项重叠任务暂未显示，可缩小时间范围或使用左侧筛选查看。';
        if (data.visible > MAX_RENDER) note = '任务较多，当前仅显示前 ' + MAX_RENDER + ' 项；缩小范围可看到全部。';
        if (data.outRange && !renderedCount) note = '当前筛选下范围外还有 ' + data.outRange + ' 项任务，点击「扩展至全部」查看。';
        showNote(note);
    }

    function buildBar(task, now, info) {
        var interval = taskInterval(task);
        var chip = node('button', 'tl-task tl-bar');
        chip.classList.add('is-prio-' + (task.priority || 'normal'));
        if (info.edge) chip.classList.add('is-edge-overdue');
        if (info.clipStart) chip.classList.add('is-clip-start');
        if (info.clipEnd) chip.classList.add('is-clip-end');
        if (info.shortBar) chip.classList.add('is-short');
        chip.classList.add(info.width < 70 ? 'is-tiny' : (info.width < 132 ? 'is-narrow' : 'is-wide'));
        if (state.selectedId && task.id === state.selectedId) chip.classList.add('is-selected');
        if (task.status === 'done') chip.classList.add('is-done');
        if (task.status === 'canceled') chip.classList.add('is-canceled');
        if (task.status === 'open' && task.due < now) chip.classList.add('is-overdue');
        if (task.pinned === true || task.pin === true) chip.classList.add('is-pinned');
        if (task.recurrence) chip.classList.add('is-recurring');

        attr(chip, 'type', 'button');
        attr(chip, 'data-id', task.id);
        attr(chip, 'data-start', String(interval.start));
        attr(chip, 'data-end', String(interval.end));
        attr(chip, 'data-due', String(task.due));
        attr(chip, 'data-duration', String(Math.max(0, interval.end - interval.start)));
        attr(chip, 'data-clip-start', info.clipStart ? 'true' : 'false');
        attr(chip, 'data-clip-end', info.clipEnd ? 'true' : 'false');
        attr(chip, 'data-short', info.shortBar ? 'true' : 'false');

        var aria = '创建 ' + formatDateTimeFull(interval.start) + ' → 到期 ' + formatDateTimeFull(interval.end) +
            '（时长 ' + formatDuration(interval.end - interval.start) + '）｜' + task.title;
        if (task.pinned === true || task.pin === true) aria += '，置顶';
        if (task.recurrence) aria += '，循环任务';
        if (task.priority === 'high' || task.priority === 'urgent') aria += '，' + (task.priority === 'urgent' ? '紧急' : '高优先级');
        if (task.status === 'open' && task.due < now) aria += '，已逾期';
        if (task.status === 'done') aria += '，已完成';
        if (task.status === 'canceled') aria += '，已取消';
        if (info.clipStart || info.clipEnd) aria += '，部分时间在可视范围外';
        attr(chip, 'aria-label', aria + '（点击查看详情）');
        attr(chip, 'title', aria);

        var top = node('span', 'tl-bar__top');
        top.appendChild(node('span', 'tl-bar__title', task.title));
        var flags = node('span', 'tl-bar__flags');
        if (task.pinned === true || task.pin === true) {
            var pin = node('span', 'tl-task__flag is-pin');
            pin.appendChild(icon('flag', 12));
            flags.appendChild(pin);
        }
        if (task.recurrence) {
            var repeat = node('span', 'tl-task__flag is-repeat');
            repeat.appendChild(icon('refresh', 12));
            flags.appendChild(repeat);
        }
        if (task.status === 'open' && task.due < now) {
            var overdue = node('span', 'tl-task__flag is-overdue');
            overdue.appendChild(icon('alert', 12));
            flags.appendChild(overdue);
        }
        top.appendChild(flags);
        chip.appendChild(top);

        var meta = node('span', 'tl-bar__meta');
        var startText = formatTime(interval.start);
        if (info.clipStart) startText = formatDateShort(interval.start) + ' ' + startText;
        meta.appendChild(node('span', 'tl-bar__start', startText));
        meta.appendChild(node('span', 'tl-bar__arrow', '→'));
        var dueText = formatTime(task.due);
        if (info.clipEnd) dueText = formatDateShort(task.due) + ' ' + dueText;
        meta.appendChild(node('span', 'tl-bar__due', dueText));
        meta.appendChild(node('span', 'tl-bar__dur', formatDuration(interval.end - interval.start)));
        chip.appendChild(meta);
        return chip;
    }

    /* ------------------------------------------------------------------ *
     * 渲染：纵向时间流水
     * ------------------------------------------------------------------ */
    function renderVertical(data) {
        clear(refs.agenda);
        var agenda = refs.agenda;
        var range = data.range;
        var now = Date.now();
        var items = data.visibleItems.slice(0, MAX_RENDER);
        var groups = [];
        var byDay = Object.create(null);
        items.forEach(function (item) {
            var key = startOfDay(item.task.due);
            if (!byDay[key]) { byDay[key] = []; groups.push(key); }
            byDay[key].push(item);
        });
        groups.sort(function (a, b) { return a - b; });
        refs.agenda.classList.toggle('tl-agenda--empty', groups.length === 0);

        groups.forEach(function (dayStart) {
            var group = node('section', 'tl-agenda__group');
            if (dayStart === startOfDay(now)) group.classList.add('is-today');
            var head = node('header', 'tl-agenda__head');
            head.appendChild(node('h3', 'tl-agenda__day', dayTitle(dayStart, now)));
            head.appendChild(node('span', 'tl-agenda__count', byDay[dayStart].length + ' 项'));
            if (dayStart < startOfDay(range.start)) {
                head.appendChild(node('span', 'tl-agenda__overdue-tag', '逾期'));
            }
            if (dayStart === startOfDay(now)) {
                head.appendChild(node('span', 'tl-agenda__now', '现在 ' + formatTime(now)));
            }
            group.appendChild(head);
            var list = node('div', 'tl-agenda__list');
            byDay[dayStart].forEach(function (item) {
                var task = item.task;
                var interval = taskInterval(task);
                var row = node('button', 'tl-agenda__row');
                attr(row, 'type', 'button');
                attr(row, 'data-id', task.id);
                attr(row, 'data-start', String(interval.start));
                attr(row, 'data-end', String(interval.end));
                if (task.status === 'done') row.classList.add('is-done');
                if (task.status === 'canceled') row.classList.add('is-canceled');
                if (task.pinned === true || task.pin === true) row.classList.add('is-pinned');
                if (task.status === 'open' && task.due < now) row.classList.add('is-overdue');
                if (state.selectedId && task.id === state.selectedId) row.classList.add('is-selected');
                if (item.edge) row.classList.add('is-edge-overdue');

                var aria = '创建 ' + formatDateTimeFull(interval.start) + ' → 到期 ' + formatDateTimeFull(interval.end) +
                    '（时长 ' + formatDuration(interval.end - interval.start) + '）｜' + task.title;
                attr(row, 'aria-label', aria + '（点击查看详情）');
                attr(row, 'title', aria);

                row.appendChild(node('span', 'tl-agenda__time', formatTime(task.due)));
                var flags = node('span', 'tl-agenda__flags');
                if (task.pinned === true || task.pin === true) flags.appendChild(icon('flag', 12));
                if (task.recurrence) flags.appendChild(icon('refresh', 12));
                if (task.priority === 'urgent' || task.priority === 'high') {
                    var dot = node('span', 'tl-agenda__prio');
                    dot.setAttribute('data-priority', task.priority);
                    flags.appendChild(dot);
                }
                row.appendChild(flags);

                var body = node('span', 'tl-agenda__body');
                body.appendChild(node('span', 'tl-agenda__title', task.title));
                var rangeText = formatDateShort(interval.start) + ' ' + formatTime(interval.start) + ' → ' +
                    formatDateShort(interval.end) + ' ' + formatTime(interval.end) + ' · ' + formatDuration(interval.end - interval.start);
                body.appendChild(node('span', 'tl-agenda__range', rangeText));
                row.appendChild(body);

                if (item.edge) row.appendChild(node('span', 'tl-agenda__tag tl-agenda__tag--overdue', '逾期'));
                else if (task.tags && task.tags.length) row.appendChild(node('span', 'tl-agenda__tag', task.tags[0]));
                list.appendChild(row);
            });
            group.appendChild(list);
            agenda.appendChild(group);
        });

        var emptyText = null;
        if (!items.length) {
            emptyText = data.withDue === 0
                ? '当前筛选下还没有带截止时间的任务。在列表视图给任务设置截止时间后，这里会自动出现。'
                : '此范围内没有任务。可调整起止时间或使用预设调整范围。';
        }
        showEmpty(emptyText);
        showNote(data.visible > MAX_RENDER ? '任务较多，当前仅显示前 ' + MAX_RENDER + ' 项；缩小范围可看到全部。' : null);
    }

    /* ------------------------------------------------------------------ *
     * 渲染：无日期 / 空状态 / 提示
     * ------------------------------------------------------------------ */
    function showEmpty(text) {
        var empty = refs.empty;
        if (!text) { empty.setAttribute('hidden', 'hidden'); return; }
        empty.removeAttribute('hidden');
        clear(empty);
        empty.appendChild(icon('calendar', 22));
        empty.appendChild(node('p', 'tl-empty__text', text));
        var actions = node('div', 'tl-empty__actions');
        var next3 = node('button', 'nc-btn nc-btn--sm', '未来 3 天');
        attr(next3, 'type', 'button');
        attr(next3, 'data-preset', 'next3');
        actions.appendChild(next3);
        var month = node('button', 'nc-btn nc-btn--ghost nc-btn--sm', '本月');
        attr(month, 'type', 'button');
        attr(month, 'data-preset', 'month');
        actions.appendChild(month);
        empty.appendChild(actions);
    }

    function showNote(text) {
        var note = refs.root.querySelector('.tl-note');
        if (!text) {
            if (note) note.setAttribute('hidden', 'hidden');
            return;
        }
        if (!note) {
            note = node('div', 'tl-note');
            refs.body.appendChild(note);
        }
        note.removeAttribute('hidden');
        note.textContent = text;
    }

    /* ------------------------------------------------------------------ *
     * 主渲染（rAF 节流）
     * ------------------------------------------------------------------ */
    var scheduleRender = rafThrottle(function () { render(false); });

    function render(force) {
        if (!state.mounted || !refs.root) return;
        var data = collect();
        state.lastData = data;
        state.showCompleted = data.showCompleted;
        var todoStore = store();
        var ui = todoStore && typeof todoStore.getUi === 'function' ? todoStore.getUi() : null;
        state.selectedId = ui ? ui.selectedId : null;

        var width = (refs.container || state.container || {}).clientWidth || global.innerWidth || 0;
        state.width = width;
        state.mode = width >= HORIZONTAL_MIN_WIDTH ? 'h' : 'v';
        refs.root.setAttribute('data-mode', state.mode);
        refs.root.classList.toggle('tl--horizontal', state.mode === 'h');
        refs.root.classList.toggle('tl--vertical', state.mode === 'v');
        if (state.mode === 'h') {
            refs.hWrap.removeAttribute('hidden');
            refs.agenda.setAttribute('hidden', 'hidden');
        } else {
            refs.hWrap.setAttribute('hidden', 'hidden');
            refs.agenda.removeAttribute('hidden');
        }

        updateToolbar(data);
        if (state.mode === 'h') renderHorizontal(data);
        else renderVertical(data);
        if (force) refs.root.setAttribute('data-rendered', String(Date.now()));
    }

    function scheduleReveal() {
        if (state.revealDone) return;
        var lite = global.document && global.document.documentElement.getAttribute('data-lite') === 'true';
        var reduce = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (lite || reduce) { state.revealDone = true; return; }
        state.revealDone = true;
        refs.root.classList.add('tl--reveal');
        (global.requestAnimationFrame || setTimeout)(function () { refs.root.classList.add('tl--reveal-in'); }, 1);
        state.revealTimer = setTimeout(function () {
            refs.root.classList.remove('tl--reveal');
            refs.root.classList.remove('tl--reveal-in');
        }, REVEAL_MS + 120);
    }

    /* ------------------------------------------------------------------ *
     * 范围框选
     * ------------------------------------------------------------------ */
    function xToTime(clientX) {
        var rect = refs.brushLayer.getBoundingClientRect();
        var width = rect.width || 1;
        var ratio = clamp((clientX - rect.left) / width, 0, 1);
        var range = ensureRange();
        return range.start + ratio * (range.end - range.start);
    }

    function updateBrushPreview(startTs, endTs) {
        var range = ensureRange();
        var span = range.end - range.start;
        var rect = refs.brushLayer.getBoundingClientRect();
        var width = rect.width || 1;
        var left = clamp((startTs - range.start) / span * width, 0, width);
        var right = clamp((endTs - range.start) / span * width, 0, width);
        if (right < left) { var swap = left; left = right; right = swap; }
        refs.brushLive.removeAttribute('hidden');
        refs.brushLive.style.left = Math.round(left) + 'px';
        refs.brushLive.style.width = Math.max(2, Math.round(right - left)) + 'px';
        refs.brushTip.removeAttribute('hidden');
        refs.brushTip.style.left = Math.round(clamp(left, 0, width - 150)) + 'px';
        refs.brushTip.textContent = formatDateShort(startTs) + ' ' + formatTime(startTs) + ' – ' +
            formatDateShort(endTs) + ' ' + formatTime(endTs);
    }

    function hideBrushPreview() {
        refs.brushLive.setAttribute('hidden', 'hidden');
        refs.brushTip.setAttribute('hidden', 'hidden');
    }

    function onBrushPointerDown(event) {
        if (event.button != null && event.button !== 0) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        state.brush = { start: xToTime(event.clientX), moved: false, pointerId: event.pointerId };
        if (refs.brushLayer.setPointerCapture && event.pointerId != null) {
            try { refs.brushLayer.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
        }
        updateBrushPreview(state.brush.start, state.brush.start);
        refs.brushLayer.classList.add('is-dragging');
    }

    function onBrushPointerMove(event) {
        if (!state.brush) return;
        event.preventDefault();
        var current = xToTime(event.clientX);
        if (Math.abs(current - state.brush.start) > 2 * MINUTE) state.brush.moved = true;
        updateBrushPreview(state.brush.start, current);
    }

    function onBrushPointerUp(event) {
        if (!state.brush) return;
        var brush = state.brush;
        state.brush = null;
        refs.brushLayer.classList.remove('is-dragging');
        hideBrushPreview();
        if (event && event.clientX != null) {
            var end = xToTime(event.clientX);
            if (!brush.moved && Math.abs(end - brush.start) < 4 * MINUTE) return;
            var range = normalizeRange(Math.min(brush.start, end), Math.max(brush.start, end));
            if (range && range.end - range.start >= MIN_SPAN) setRange(range);
            return;
        }
        var fallback = normalizeRange(brush.start, brush.start + HOUR);
        if (fallback) setRange(fallback);
    }

    function applyInputs() {
        var start = parseDateTimeInput(refs.startInput.value);
        var end = parseDateTimeInput(refs.endInput.value);
        if (!isFiniteNum(start) || !isFiniteNum(end)) {
            setStatus('起止时间格式无效', 'error');
            syncInputsToRange();
            return;
        }
        var range = normalizeRange(start, end);
        if (!range || range.end - range.start < MIN_SPAN) {
            setStatus('结束时间需晚于开始时间至少 15 分钟', 'error');
            syncInputsToRange();
            return;
        }
        setRange(range);
        setStatus('范围已更新：' + formatRange(range), 'ok');
    }

    function syncInputsToRange() {
        var range = ensureRange();
        refs.startInput.value = formatDateTimeInput(range.start);
        refs.endInput.value = formatDateTimeInput(range.end);
    }

    function setStatus(text, tone) {
        var status = refs.root.querySelector('.tl-status');
        if (!status) {
            status = node('div', 'tl-status');
            refs.head.appendChild(status);
        }
        status.textContent = text || '';
        status.className = 'tl-status tl-status--' + (tone || 'ok');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        if (status.timer) clearTimeout(status.timer);
        if (text) status.timer = setTimeout(function () { status.textContent = ''; }, 2600);
    }

    function fitAll() {
        var todoStore = store();
        if (!todoStore || typeof todoStore.getDoc !== 'function') return;
        var tasks = filteredDueTasks(Date.now()).withDue;
        if (!tasks.length) { setStatus('当前筛选下还没有带截止时间的任务', 'error'); return; }
        var min = taskInterval(tasks[0]).start;
        var max = tasks[0].due;
        tasks.forEach(function (task) {
            var interval = taskInterval(task);
            if (interval.start < min) min = interval.start;
            if (task.due > max) max = task.due;
        });
        var start = startOfDay(min) - 2 * HOUR;
        var end = endOfDay(max) + 2 * HOUR;
        if (end - start > 366 * DAY) end = start + 366 * DAY;
        setRange(normalizeRange(start, end));
        setStatus('已扩展到全部任务范围（' + formatRange({ start: start, end: end }) + '）', 'ok');
    }

    function handlePreset(id) {
        if (id === 'fit-all') { fitAll(); return; }
        if (id === 'reset') {
            setRange(defaultRange());
            setStatus('已恢复数据化默认范围（含创建时间）', 'ok');
            return;
        }
        var preset = presetRange(id);
        if (preset) {
            setRange(preset);
            setStatus('已切换到' + (id === 'next3' ? '未来 3 天' : id === 'week' ? '本周' : '本月'), 'ok');
        }
    }

    /* ------------------------------------------------------------------ *
     * 事件绑定
     * ------------------------------------------------------------------ */
    function bindEvents() {
        var root = refs.root;

        refs.startInput.addEventListener('change', applyInputs);
        refs.endInput.addEventListener('change', applyInputs);
        refs.showDoneInput.addEventListener('change', function () {
            var next = !!refs.showDoneInput.checked;
            var todoStore = store();
            if (todoStore && typeof todoStore.updateSettings === 'function') {
                // 与列表共享同一份设置，避免两套状态不一致
                todoStore.updateSettings({ showCompleted: next });
            } else {
                state.localShowCompleted = next;
                render(true);
            }
        });
        refs.presetWrap.addEventListener('click', function (event) {
            var button = event.target && event.target.closest('button[data-preset]');
            if (button) handlePreset(button.getAttribute('data-preset'));
        });
        refs.fitButton.addEventListener('click', fitAll);
        root.addEventListener('click', function (event) {
            var preset = event.target && event.target.closest('[data-preset]');
            if (preset && !event.target.closest('.tl-preset')) { handlePreset(preset.getAttribute('data-preset')); return; }
            var taskNode = event.target && event.target.closest('[data-id]');
            if (!taskNode) return;
            var id = taskNode.getAttribute('data-id');
            if (!id) return;
            var todoStore = store();
            if (todoStore && typeof todoStore.selectTask === 'function') todoStore.selectTask(id);
            var chip = taskNode.classList && taskNode.classList.contains('tl-task') ? taskNode : null;
            if (chip) chip.classList.add('is-selected');
        });

        refs.brushLayer.addEventListener('pointerdown', onBrushPointerDown);
        refs.brushLayer.addEventListener('pointermove', onBrushPointerMove);
        refs.brushLayer.addEventListener('pointerup', onBrushPointerUp);
        refs.brushLayer.addEventListener('pointercancel', function () {
            state.brush = null;
            refs.brushLayer.classList.remove('is-dragging');
            hideBrushPreview();
        });
        refs.brushLayer.addEventListener('dblclick', function (event) {
            event.preventDefault();
            setRange(defaultRange());
            setStatus('已恢复数据化默认范围（含创建时间）', 'ok');
        });
        refs.brushLayer.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;
            state.brush = null;
            hideBrushPreview();
        });

        // 键盘导航：横向滚动容器聚焦时方向键滚动
        refs.scroll.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                refs.scroll.scrollLeft += event.key === 'ArrowLeft' ? -160 : 160;
            }
        });
        refs.scroll.setAttribute('tabindex', '0');
        refs.scroll.setAttribute('aria-label', '时间轴（可横向滚动）');
    }

    function bindStore() {
        var todoStore = store();
        if (!todoStore) return;
        if (typeof todoStore.subscribe === 'function') {
            state.offStore = todoStore.subscribe(function () { scheduleRender(); });
        } else if (NC.events) {
            state.offStore = NC.events.on('todo:changed', function () { scheduleRender(); });
        }
    }

    function bindResize() {
        if (typeof global.ResizeObserver === 'function' && refs.container) {
            state.resizeObserver = new global.ResizeObserver(function () {
                scheduleRender();
            });
            state.resizeObserver.observe(refs.container);
        } else {
            state.onWindowResize = function () { scheduleRender(); };
            global.addEventListener('resize', state.onWindowResize);
        }
    }

    function hitThemeRefresh() {
        if (!state.mounted) return;
        // 主题/Lite 变化只影响动效与颜色（CSS 处理），布局无需重排；选中态与时间无关。
        render(true);
    }

    /* ------------------------------------------------------------------ *
     * 公共 API
     * ------------------------------------------------------------------ */
    function mount(container, options) {
        var target = typeof container === 'string' ? global.document.querySelector(container) : container;
        if (!target) {
            if (global.console) global.console.warn('[NC.timeline] mount: 容器不存在');
            return false;
        }
        if (state.mounted) unmount();
        var opts = options || {};
        state.container = target;
        refs.container = target;
        state.mounted = true;
        state.mountCount += 1;
        if (typeof opts.showCompleted === 'boolean') state.localShowCompleted = opts.showCompleted;
        ensureRange();
        clear(target);
        var root = buildSkeleton();
        target.appendChild(root);
        refs.root = root;
        bindEvents();
        bindStore();
        bindResize();
        if (NC.events) {
            state.offTheme = NC.events.on('theme:changed', hitThemeRefresh);
            state.offLite = NC.events.on('lite:changed', hitThemeRefresh);
        }
        render(true);
        scheduleReveal();
        if (refs.scroll && state.scrollToStart) {
            refs.scroll.scrollLeft = 0;
            state.scrollToStart = false;
        }
        return true;
    }

    function unmount() {
        if (!state.mounted) return false;
        state.mounted = false;
        if (state.rafId) { (global.cancelAnimationFrame || clearTimeout)(state.rafId); state.rafId = null; }
        if (state.offStore) { try { state.offStore(); } catch (err) { /* ignore */ } state.offStore = null; }
        if (state.offTheme) { try { state.offTheme(); } catch (err) { /* ignore */ } state.offTheme = null; }
        if (state.offLite) { try { state.offLite(); } catch (err) { /* ignore */ } state.offLite = null; }
        if (state.resizeObserver) { try { state.resizeObserver.disconnect(); } catch (err) { /* ignore */ } state.resizeObserver = null; }
        if (state.onWindowResize) { global.removeEventListener('resize', state.onWindowResize); state.onWindowResize = null; }
        if (state.revealTimer) { clearTimeout(state.revealTimer); state.revealTimer = null; }
        if (refs.root && refs.root.parentNode) refs.root.parentNode.removeChild(refs.root);
        refs.root = null;
        refs.container = null;
        state.container = null;
        state.brush = null;
        return true;
    }

    function refresh() {
        if (!state.mounted) return false;
        render(true);
        return true;
    }

    function getState() {
        var data = state.lastData ? {
            inRange: state.lastData.inRange,
            visible: state.lastData.visible,
            outRange: state.lastData.outRange,
            total: state.lastData.total,
            withDue: state.lastData.withDue,
            overdue: state.lastData.overdue,
            pinned: state.lastData.pinned,
            rendered: typeof state.lastRendered === 'number' ? state.lastRendered : null,
            hiddenOverlap: typeof state.lastHiddenOverlap === 'number' ? state.lastHiddenOverlap : 0
        } : null;
        return {
            mounted: state.mounted,
            mode: state.mode,
            width: state.width,
            range: state.range ? { start: state.range.start, end: state.range.end } : null,
            showCompleted: state.showCompleted,
            counts: data
        };
    }

    NC.timeline = {
        mount: mount,
        unmount: unmount,
        refresh: refresh,
        getState: getState,
        // 以下为测试/集成便利方法（不改变业务数据）
        setRange: function (start, end) { return setRange({ start: start, end: end }); },
        getRange: function () { return state.range ? { start: state.range.start, end: state.range.end } : null; },
        presetRange: function (id) { var range = presetRange(id); setRange(range); return range; },
        defaultRange: function () { return defaultRange(); },
        isMounted: function () { return state.mounted; }
    };
})(window);
