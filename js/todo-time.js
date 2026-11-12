/**
 * todo-time.js — Todo 快捷时间（纯函数 + llm-store workEnd 读取）
 * 经典脚本，依赖 core.js；可选依赖 llm-store.js（取下班时间）。挂载：NC.todoTime
 *
 * 规则（docs/dev-contract-v3.md §5.2，workEnd 默认 17:30）：
 *   work-end   下班前：工作日且未过 → 今天 workEnd；已过 / 周末 → 下一工作日 workEnd
 *   tomorrow   明天前：明天 workEnd
 *   friday     周五前：本周五 workEnd；已过 → 下周五 workEnd
 *   next-week  下周前：下周一 09:00
 *   month-end  月底前：本月最后一天 workEnd；已过则下月最后一天 workEnd
 *   clear      清除：null
 * 所有函数不 throw；日期一律用本地时区（与 Todo due 存储 epoch ms 一致）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var DEFAULT_WORK_END = '17:30';
    var NEXT_WEEK_HOUR = 9;
    var DAY_MS = 86400000;

    /**
     * 快捷选项顺序与文案（UI 与测试共用）。
     */
    var OPTIONS = [
        { kind: 'work-end', label: '下班前' },
        { kind: 'tomorrow', label: '明天前' },
        { kind: 'friday', label: '周五前' },
        { kind: 'next-week', label: '下周前' },
        { kind: 'month-end', label: '月底前' },
        { kind: 'clear', label: '清除' }
    ];
    var KINDS = OPTIONS.map(function (item) { return item.kind; });

    var WORK_END_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

    /* ------------------------------------------------------------------ *
     * 基础工具
     * ------------------------------------------------------------------ */
    function isNum(value) { return util.isFiniteNum(value); }

    function startOfDay(ts) {
        var d = new Date(isNum(ts) ? ts : Date.now());
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    /** 以「日」为单位加天数（避免 DST 下 86400000 造成的跨日误差）。 */
    function addDays(dayStart, days) {
        var d = new Date(dayStart);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
    }

    function weekday(dayStart) {
        return new Date(dayStart).getDay(); /* 0=周日 ... 6=周六 */
    }

    function isWeekend(dayStart) {
        var day = weekday(dayStart);
        return day === 0 || day === 6;
    }

    function nextWorkday(dayStart) {
        var cursor = dayStart;
        for (var i = 0; i < 8; i++) {
            cursor = addDays(cursor, 1);
            if (!isWeekend(cursor)) return cursor;
        }
        return cursor;
    }

    function parseWorkEnd(workEnd) {
        var match = WORK_END_RE.exec(String(workEnd == null ? '' : workEnd).trim());
        if (!match) return { hour: 17, minute: 30 };
        return { hour: parseInt(match[1], 10), minute: parseInt(match[2], 10) };
    }

    function atWorkEnd(dayStart, workEnd) {
        var parts = parseWorkEnd(workEnd);
        var d = new Date(dayStart);
        d.setHours(parts.hour, parts.minute, 0, 0);
        return d.getTime();
    }

    function atHour(dayStart, hour) {
        var d = new Date(dayStart);
        d.setHours(hour, 0, 0, 0);
        return d.getTime();
    }

    function monthEnd(dayStart) {
        var d = new Date(dayStart);
        return new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
    }

    function nextMonthEnd(dayStart) {
        var d = new Date(dayStart);
        return new Date(d.getFullYear(), d.getMonth() + 2, 0).getTime();
    }

    /**
     * 读取全局下班时间（llm-store 可用时优先，否则默认 17:30）。
     */
    function getWorkEnd() {
        try {
            if (NC.store && NC.store.llm && typeof NC.store.llm.getWorkEndTime === 'function') {
                var value = NC.store.llm.getWorkEndTime();
                if (typeof value === 'string' && WORK_END_RE.test(value)) return value;
            }
        } catch (err) { /* 存储未就绪时使用默认值 */ }
        return DEFAULT_WORK_END;
    }

    /**
     * 计算快捷时间。
     * @param {string} kind 'work-end'|'tomorrow'|'friday'|'next-week'|'month-end'|'clear'
     * @param {number} [now] 参考时间（默认 Date.now()）
     * @param {string} [workEnd] 'HH:mm'（默认读 llm-store，再默认 17:30）
     * @returns {number|null} epoch ms；未知 kind/clear 返回 null
     */
    function computeQuickDue(kind, now, workEnd) {
        if (KINDS.indexOf(kind) === -1) return null;
        if (kind === 'clear') return null;

        var current = isNum(now) ? now : Date.now();
        var end = WORK_END_RE.test(String(workEnd == null ? '' : workEnd).trim())
            ? String(workEnd).trim()
            : getWorkEnd();
        var today = startOfDay(current);

        if (kind === 'work-end') {
            if (!isWeekend(today) && current <= atWorkEnd(today, end)) {
                return atWorkEnd(today, end);
            }
            return atWorkEnd(nextWorkday(today), end);
        }

        if (kind === 'tomorrow') {
            return atWorkEnd(addDays(today, 1), end);
        }

        if (kind === 'friday') {
            var day = weekday(today); /* 0=周日 ... 5=周五 6=周六 */
            var offset = (5 - day + 7) % 7; /* 距离本周五的天数（周日按已过本周五处理 → 5） */
            var friday = addDays(today, offset);
            if (current <= atWorkEnd(friday, end)) return atWorkEnd(friday, end);
            return atWorkEnd(addDays(friday, 7), end);
        }

        if (kind === 'next-week') {
            var day2 = weekday(today);
            var toMonday = (8 - day2) % 7; /* 周一 → 7；周二 → 6；周日 → 1 */
            if (toMonday === 0) toMonday = 7;
            return atHour(addDays(today, toMonday), NEXT_WEEK_HOUR);
        }

        if (kind === 'month-end') {
            var lastDay = monthEnd(today);
            var value = atWorkEnd(lastDay, end);
            if (current <= value) return value;
            return atWorkEnd(nextMonthEnd(today), end);
        }

        return null;
    }

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */
    var WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    function pad2(n) { return util.pad2 ? util.pad2(n) : (n < 10 ? '0' + n : String(n)); }

    function timeLabel(ts) {
        var d = new Date(ts);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function dateLabel(ts, now) {
        var current = startOfDay(isNum(now) ? now : Date.now());
        var target = startOfDay(ts);
        var diff = Math.round((target - current) / DAY_MS);
        var d = new Date(ts);
        var month = pad2(d.getMonth() + 1);
        var day = pad2(d.getDate());
        if (diff === 0) return '今天';
        if (diff === 1) return '明天';
        if (diff === -1) return '昨天';
        if (diff > 1 && diff <= 6) return WEEK_LABELS[d.getDay()];
        if (d.getFullYear() !== new Date(current).getFullYear()) {
            return d.getFullYear() + '-' + month + '-' + day;
        }
        return month + '-' + day;
    }

    /**
     * 便捷文案：如「今天 17:30」「周五 17:30」「下周一 09:00」「10-31 17:30」。
     */
    function describe(ts, now) {
        if (!isNum(ts)) return '无截止时间';
        var current = isNum(now) ? now : Date.now();
        return dateLabel(ts, current) + ' ' + timeLabel(ts);
    }

    /**
     * 生成 UI 需要的选项列表。
     * @param {number} [now]
     * @param {string} [workEnd] 可选，默认读 llm-store
     * @returns {Array<{kind:string,label:string,ts:number|null,text:string}>}
     */
    function quickDueOptions(now, workEnd) {
        var current = isNum(now) ? now : Date.now();
        var end = workEnd || getWorkEnd();
        return OPTIONS.map(function (option) {
            var ts = option.kind === 'clear' ? null : computeQuickDue(option.kind, current, end);
            return {
                kind: option.kind,
                label: option.label,
                ts: ts,
                text: option.kind === 'clear' ? '清除截止时间' : describe(ts, current)
            };
        });
    }

    /**
     * 给定日期 + 下班时间，返回「自定义 due」的展示文案（详情抽屉可复用）。
     */
    function describeDue(ts, now) {
        return describe(ts, now);
    }

    NC.todoTime = {
        DEFAULT_WORK_END: DEFAULT_WORK_END,
        OPTIONS: OPTIONS,
        KINDS: KINDS,
        getWorkEnd: getWorkEnd,
        computeQuickDue: computeQuickDue,
        quickDueOptions: quickDueOptions,
        describe: describe,
        describeDue: describeDue
    };
})(window);
