/**
 * datetime-field.js — 自绘日期 / 时间字段（经典脚本，依赖 core.js、icons.js）
 * 挂载：NC.ui.dateTimeField(input, options) / NC.ui.enhanceDateTimeFields(root)
 *
 * 为什么不用原生 datetime-local：
 *  - Chromium 的日期弹层、日历按钮、时间微调都是系统样式，与工作台语言冲突；
 *  - 键盘可达性与可读格式也需要统一（11月18日 周二 18:00）。
 *
 * 约定（关键）：原生 <input> 仍留在 DOM 里作为**值容器**——
 *  - 保留 .value（YYYY-MM-DDTHH:mm / YYYY-MM-DD / HH:mm）与 input/change 事件；
 *  - 因此 todo-view / timeline / settings 的既有读写逻辑完全不用改；
 *  - 触发器只是视觉与交互层，可随时移除回退到原生控件。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var icons = NC.icons;

    var WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
    var WEEK_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    var popEl = null;
    var openState = null;
    var repositionBound = false;

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function inferMode(input) {
        var type = (input.getAttribute('type') || '').toLowerCase();
        if (type === 'datetime-local') return 'datetime';
        if (type === 'date') return 'date';
        if (type === 'time') return 'time';
        return null;
    }

    function parseValue(raw, mode) {
        var text = String(raw == null ? '' : raw).trim();
        if (!text) return null;
        var m;
        if (mode === 'time') {
            m = /^(\d{1,2}):(\d{2})/.exec(text);
            if (!m) return null;
            return { y: 0, mo: 0, d: 0, h: Math.min(23, Number(m[1])), mi: Math.min(59, Number(m[2])) };
        }
        m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(text);
        if (!m) return null;
        return {
            y: Number(m[1]),
            mo: Number(m[2]) - 1,
            d: Number(m[3]),
            h: m[4] != null ? Number(m[4]) : 18,
            mi: m[5] != null ? Number(m[5]) : 0
        };
    }

    function formatValue(parts, mode) {
        if (!parts) return '';
        if (mode === 'time') return pad2(parts.h) + ':' + pad2(parts.mi);
        var date = parts.y + '-' + pad2(parts.mo + 1) + '-' + pad2(parts.d);
        if (mode === 'date') return date;
        return date + 'T' + pad2(parts.h) + ':' + pad2(parts.mi);
    }

    function formatDisplay(parts, mode) {
        if (!parts) return '';
        if (mode === 'time') return pad2(parts.h) + ':' + pad2(parts.mi);
        var now = new Date();
        var week = WEEK_FULL[new Date(parts.y, parts.mo, parts.d).getDay()];
        var head = (parts.y !== now.getFullYear() ? parts.y + '年' : '') + (parts.mo + 1) + '月' + parts.d + '日 ' + week;
        if (mode === 'date') return head;
        return head + ' ' + pad2(parts.h) + ':' + pad2(parts.mi);
    }

    function todayParts() {
        var n = new Date();
        return { y: n.getFullYear(), mo: n.getMonth(), d: n.getDate(), h: 18, mi: 0 };
    }

    function sameDay(a, b) {
        return !!a && !!b && a.y === b.y && a.mo === b.mo && a.d === b.d;
    }

    function daysInMonth(y, mo) {
        return new Date(y, mo + 1, 0).getDate();
    }

    /* ------------------------------------------------------------------ *
     * 全局弹层（同一时刻只开一个）
     * ------------------------------------------------------------------ */
    function ensurePop() {
        if (popEl && document.documentElement.contains(popEl)) return popEl;
        popEl = util.e('div', {
            class: 'nc-dt__pop',
            role: 'dialog',
            'aria-modal': 'false',
            'aria-label': '选择日期与时间'
        });
        popEl.hidden = true;
        document.body.appendChild(popEl);
        return popEl;
    }

    function closePop(returnFocus) {
        var state = openState;
        if (!state) return;
        openState = null;
        if (popEl) {
            popEl.classList.remove('is-open');
            popEl.hidden = true;
        }
        state.trigger.setAttribute('aria-expanded', 'false');
        state.wrap.classList.remove('is-open');
        if (returnFocus) {
            try { state.trigger.focus(); } catch (err) { /* ignore */ }
        }
    }

    function positionPop(state) {
        if (!popEl || popEl.hidden) return;
        var rect = state.trigger.getBoundingClientRect();
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var width = popEl.offsetWidth || 300;
        var height = popEl.offsetHeight || 360;
        var left = Math.max(8, Math.min(rect.left, vw - width - 8));
        var top = rect.bottom + 6;
        var above = false;
        if (top + height > vh - 8) {
            var up = rect.top - height - 6;
            if (up >= 8) { top = up; above = true; }
            else top = Math.max(8, vh - height - 8);
        }
        popEl.style.left = Math.round(left) + 'px';
        popEl.style.top = Math.round(top) + 'px';
        popEl.setAttribute('data-placement', above ? 'above' : 'below');
        popEl.style.transformOrigin = above ? '50% 100%' : '50% 0';
    }

    function bindGlobal() {
        if (repositionBound) return;
        repositionBound = true;
        document.addEventListener('mousedown', function (event) {
            if (!openState) return;
            if (popEl && popEl.contains(event.target)) return;
            if (openState.wrap.contains(event.target)) return;
            closePop(false);
        }, true);
        document.addEventListener('keydown', function (event) {
            if (!openState) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closePop(true);
            }
        }, true);
        global.addEventListener('resize', function () { if (openState) positionPop(openState); });
        document.addEventListener('scroll', function () { if (openState) positionPop(openState); }, true);
    }

    /* ------------------------------------------------------------------ *
     * 弹层内容
     * ------------------------------------------------------------------ */
    function buildContent(state) {
        var mode = state.mode;
        var draft = state.draft || todayParts();
        popEl.textContent = '';

        /* 头部：月份切换 */
        if (mode !== 'time') {
            var head = util.e('div', { class: 'nc-dt__head' });
            var prev = util.e('button', { type: 'button', class: 'nc-dt__nav', 'aria-label': '上个月' });
            prev.appendChild(icons.el('chevron-left', 16));
            var next = util.e('button', { type: 'button', class: 'nc-dt__nav', 'aria-label': '下个月' });
            next.appendChild(icons.el('chevron-right', 16));
            var label = util.e('div', { class: 'nc-dt__label', text: draft.y + '年 ' + (draft.mo + 1) + '月' });
            prev.addEventListener('click', function () {
                state.viewMonth -= 1;
                if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear -= 1; }
                renderBody(state);
            });
            next.addEventListener('click', function () {
                state.viewMonth += 1;
                if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear += 1; }
                renderBody(state);
            });
            head.appendChild(prev);
            head.appendChild(label);
            head.appendChild(next);
            popEl.appendChild(head);

            /* 星期表头 */
            var week = util.e('div', { class: 'nc-dt__week', 'aria-hidden': 'true' });
            WEEK_LABELS.forEach(function (w) { week.appendChild(util.e('span', { text: w })); });
            popEl.appendChild(week);

            /* 日期网格 */
            var grid = util.e('div', { class: 'nc-dt__grid', role: 'grid' });
            var first = new Date(state.viewYear, state.viewMonth, 1);
            var startIdx = (first.getDay() + 6) % 7;
            var total = daysInMonth(state.viewYear, state.viewMonth);
            var today = todayParts();
            for (var i = 0; i < startIdx; i += 1) {
                grid.appendChild(util.e('span', { class: 'nc-dt__day is-blank' }));
            }
            for (var day = 1; day <= total; day += 1) {
                (function (d) {
                    var parts = { y: state.viewYear, mo: state.viewMonth, d: d, h: draft.h, mi: draft.mi };
                    var btn = util.e('button', {
                        type: 'button',
                        class: 'nc-dt__day',
                        text: String(d),
                        'aria-label': (state.viewMonth + 1) + '月' + d + '日 ' + WEEK_FULL[new Date(parts.y, parts.mo, d).getDay()]
                    });
                    if (sameDay(parts, today)) btn.classList.add('is-today');
                    if (sameDay(parts, state.draft)) {
                        btn.classList.add('is-selected');
                        btn.setAttribute('aria-pressed', 'true');
                    }
                    if (sameDay(parts, state.pendingFocusDay || state.draft)) btn.classList.add('is-focus-hint');
                    btn.addEventListener('click', function () {
                        state.draft = {
                            y: parts.y, mo: parts.mo, d: parts.d,
                            h: state.draft ? state.draft.h : 18,
                            mi: state.draft ? state.draft.mi : 0
                        };
                        if (state.mode === 'date') { commit(state); return; }
                        renderBody(state);
                        focusDay(state, d);
                    });
                    grid.appendChild(btn);
                })(day);
            }
            popEl.appendChild(grid);
        }

        /* 时间 */
        if (mode !== 'date') {
            var time = util.e('div', { class: 'nc-dt__time' });
            time.appendChild(stepper(state, 'h', '小时', 1, 23));
            time.appendChild(util.e('span', { class: 'nc-dt__colon', text: ':', 'aria-hidden': 'true' }));
            time.appendChild(stepper(state, 'mi', '分钟', 5, 59));
            popEl.appendChild(time);
        }

        /* 快捷项 */
        var presets = util.e('div', { class: 'nc-dt__presets' });
        var quick = mode === 'time'
            ? [{ label: '09:00', h: 9, mi: 0 }, { label: '12:00', h: 12, mi: 0 }, { label: '18:00', h: 18, mi: 0 }]
            : [{ label: '今天', offset: 0 }, { label: '明天', offset: 1 }, { label: '下周一', offset: -1 }];
        quick.forEach(function (item) {
            var chip = util.e('button', { type: 'button', class: 'nc-dt__chip', text: item.label });
            chip.addEventListener('click', function () {
                if (mode === 'time') {
                    state.draft = { y: 0, mo: 0, d: 0, h: item.h, mi: item.mi };
                    renderBody(state);
                    return;
                }
                var base = new Date();
                if (item.offset === -1) {
                    var delta = (8 - (base.getDay() || 7)) % 7;
                    base.setDate(base.getDate() + (delta === 0 ? 7 : delta));
                } else {
                    base.setDate(base.getDate() + item.offset);
                }
                state.viewYear = base.getFullYear();
                state.viewMonth = base.getMonth();
                state.draft = {
                    y: base.getFullYear(), mo: base.getMonth(), d: base.getDate(),
                    h: state.draft ? state.draft.h : 18,
                    mi: state.draft ? state.draft.mi : 0
                };
                renderBody(state);
            });
            presets.appendChild(chip);
        });
        popEl.appendChild(presets);

        /* 底部 */
        var foot = util.e('div', { class: 'nc-dt__foot' });
        var clear = util.e('button', { type: 'button', class: 'nc-btn nc-btn--sm nc-btn--ghost', text: '清除' });
        if (!state.draft) clear.disabled = true;
        clear.addEventListener('click', function () {
            state.draft = null;
            commit(state);
        });
        var done = util.e('button', { type: 'button', class: 'nc-btn nc-btn--sm nc-btn--primary', text: '完成' });
        done.addEventListener('click', function () { commit(state); });
        foot.appendChild(clear);
        foot.appendChild(util.e('span', { class: 'nc-dt__foot-gap' }));
        foot.appendChild(done);
        popEl.appendChild(foot);
    }

    function stepper(state, unit, label, step, max) {
        var wrap = util.e('div', { class: 'nc-dt__stepper' });
        var up = util.e('button', { type: 'button', class: 'nc-dt__step', 'aria-label': label + '加' });
        up.appendChild(icons.el('chevron-up', 14));
        var down = util.e('button', { type: 'button', class: 'nc-dt__step', 'aria-label': label + '减' });
        down.appendChild(icons.el('chevron-down', 14));
        var input = util.e('input', {
            class: 'nc-dt__num',
            type: 'text',
            inputmode: 'numeric',
            maxlength: '2',
            'aria-label': label,
            value: pad2(state.draft ? state.draft[unit] : (unit === 'h' ? 18 : 0))
        });
        function bump(delta) {
            var cur = Number(input.value) || 0;
            var next = cur + delta;
            if (next > max) next = 0;
            if (next < 0) next = max;
            input.value = pad2(next);
            applyTime(state, unit, next);
        }
        up.addEventListener('click', function () { bump(step); });
        down.addEventListener('click', function () { bump(-step); });
        input.addEventListener('input', function () {
            var digits = String(input.value || '').replace(/\D/g, '').slice(0, 2);
            input.value = digits;
            if (digits.length === 2) applyTime(state, unit, Math.min(max, Number(digits)));
        });
        input.addEventListener('blur', function () {
            var v = Math.min(max, Number(input.value) || 0);
            input.value = pad2(v);
            applyTime(state, unit, v);
        });
        wrap.appendChild(up);
        wrap.appendChild(input);
        wrap.appendChild(down);
        return wrap;
    }

    function applyTime(state, unit, value) {
        if (!state.draft) state.draft = todayParts();
        state.draft[unit] = value;
    }

    function focusDay(state, day) {
        if (!popEl) return;
        var nodes = popEl.querySelectorAll('.nc-dt__day:not(.is-blank)');
        for (var i = 0; i < nodes.length; i += 1) {
            if (nodes[i].textContent === String(day)) {
                try { nodes[i].focus(); } catch (err) { /* ignore */ }
                return;
            }
        }
    }

    function renderBody(state) {
        buildContent(state);
        positionPop(state);
        var selected = popEl.querySelector('.nc-dt__day.is-selected');
        if (selected) {
            try { selected.focus(); } catch (err) { /* ignore */ }
        }
    }

    function commit(state) {
        var value = state.draft ? formatValue(state.draft, state.mode) : '';
        state.setNative(value);
        state.syncText();
        closePop(true);
        dispatch(state.input, 'input');
        dispatch(state.input, 'change');
    }

    function dispatch(node, type) {
        try {
            node.dispatchEvent(new Event(type, { bubbles: true }));
        } catch (err) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ *
     * 增强单个输入
     * ------------------------------------------------------------------ */
    function enhance(input, options) {
        if (!input || input.getAttribute('data-nc-dt-ready') === '1') return null;
        var opts = options || {};
        var mode = opts.mode || inferMode(input);
        if (!mode) return null;
        var parent = input.parentNode;
        if (!parent) return null;

        input.setAttribute('data-nc-dt-ready', '1');
        input.setAttribute('tabindex', '-1');
        input.setAttribute('aria-hidden', 'true');
        input.classList.add('nc-dt__native');

        var wrap = util.e('div', { class: 'nc-dt', 'data-mode': mode });
        parent.insertBefore(wrap, input);
        wrap.appendChild(input);

        var trigger = util.e('button', {
            type: 'button',
            class: 'nc-dt__trigger',
            'aria-haspopup': 'dialog',
            'aria-expanded': 'false'
        });
        var text = util.e('span', { class: 'nc-dt__text' });
        var icon = util.e('span', { class: 'nc-dt__icon', 'aria-hidden': 'true' });
        icon.appendChild(icons.el(mode === 'time' ? 'clock' : 'calendar', 16));
        trigger.appendChild(icon);
        trigger.appendChild(text);
        wrap.appendChild(trigger);

        var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        function nativeValue() {
            try { return desc && desc.get ? desc.get.call(input) : input.value; } catch (err) { return ''; }
        }
        function setNative(v) {
            try {
                if (desc && desc.set) desc.set.call(input, v);
                else input.value = v;
            } catch (err) { input.setAttribute('value', v); }
        }

        var state = {
            input: input,
            wrap: wrap,
            trigger: trigger,
            text: text,
            mode: mode,
            draft: null,
            viewYear: 0,
            viewMonth: 0,
            setNative: setNative,
            syncText: function () {
                var parts = parseValue(nativeValue(), mode);
                var value = formatDisplay(parts, mode);
                text.textContent = value || (mode === 'time' ? '选择时间' : (mode === 'date' ? '选择日期' : '选择日期与时间'));
                wrap.classList.toggle('is-empty', !value);
                trigger.setAttribute('aria-label',
                    (value ? '当前' : '未设置') + (mode === 'time' ? '时间' : (mode === 'date' ? '日期' : '日期与时间')) +
                    (value ? '：' + value : '，点击选择'));
            }
        };
        state.syncText();

        /* 程序化赋值（todo-view / timeline 直接写 .value）时同步显示 */
        try {
            Object.defineProperty(input, 'value', {
                configurable: true,
                get: function () { return nativeValue(); },
                set: function (v) {
                    setNative(v);
                    state.syncText();
                    if (openState === state) {
                        state.draft = parseValue(nativeValue(), mode);
                        renderBody(state);
                    }
                }
            });
        } catch (err) { /* 老内核：退化为 change 时同步 */ }
        input.addEventListener('change', function () { state.syncText(); });

        trigger.addEventListener('click', function (event) {
            event.preventDefault();
            if (openState === state) { closePop(true); return; }
            openFor(state);
        });
        trigger.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openFor(state);
            }
        });

        input.__ncDateTime = state;
        return state;
    }

    function openFor(state) {
        if (openState && openState !== state) closePop(false);
        ensurePop();
        bindGlobal();
        openState = state;
        var parts = parseValue(state.input.value, state.mode) || null;
        state.draft = parts || (state.mode === 'time' ? { y: 0, mo: 0, d: 0, h: 18, mi: 0 } : null);
        var base = state.draft || todayParts();
        state.viewYear = base.y || new Date().getFullYear();
        state.viewMonth = base.mo || 0;
        popEl.hidden = false;
        state.trigger.setAttribute('aria-expanded', 'true');
        state.wrap.classList.add('is-open');
        buildContent(state);
        /* 先测量再定位，避免首帧抖动 */
        positionPop(state);
        popEl.classList.add('is-open');
        var selected = popEl.querySelector('.nc-dt__day.is-selected');
        if (selected) { try { selected.focus(); } catch (err) { /* ignore */ } }
    }

    /* ------------------------------------------------------------------ *
     * 批量增强
     * ------------------------------------------------------------------ */
    var SELECTOR = 'input[type="datetime-local"], input[type="date"], input[type="time"]';

    function enhanceDateTimeFields(root) {
        var scope = root || document;
        var nodes = scope.querySelectorAll(SELECTOR);
        Array.prototype.forEach.call(nodes, function (node) {
            try { enhance(node); } catch (err) { /* 单个失败不阻断其它 */ }
        });
    }

    var observer = null;
    function watch() {
        if (observer || !global.MutationObserver || !document.body) return;
        observer = new global.MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i += 1) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j += 1) {
                    var node = added[j];
                    if (node.nodeType !== 1) continue;
                    if (node.matches && node.matches(SELECTOR)) enhance(node);
                    else if (node.querySelectorAll) enhanceDateTimeFields(node);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function init() {
        enhanceDateTimeFields(document);
        watch();
    }

    NC.ui = NC.ui || {};
    NC.ui.dateTimeField = enhance;
    NC.ui.enhanceDateTimeFields = enhanceDateTimeFields;
    NC.ui.closeDateTimeField = function () { closePop(false); };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})(window);
