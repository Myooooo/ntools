/**
 * core.js — 命名空间、事件总线、通用工具
 * 经典脚本（无 import/export）。依赖：无。
 * 约定：所有模块通过 window.NC 暴露；页面按 HTML 中顺序加载。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    NC.version = '3.0.0';
    NC.env = {
        page: 'unknown',
        chrome: 0,
        secure: !!global.isSecureContext,
        protocol: (global.location && global.location.protocol) || ''
    };
    NC.debug = false;

    NC.log = function () {
        if (!NC.debug || !global.console) return;
        console.log.apply(console, ['[NC]'].concat(Array.prototype.slice.call(arguments)));
    };

    /* ------------------------------------------------------------------ *
     * 事件总线
     * ------------------------------------------------------------------ */
    NC.events = (function () {
        var map = Object.create(null);

        function on(type, fn) {
            if (typeof fn !== 'function') return function () {};
            if (!map[type]) map[type] = [];
            map[type].push(fn);
            return function () { off(type, fn); };
        }

        function off(type, fn) {
            var list = map[type];
            if (!list) return;
            var i = list.indexOf(fn);
            if (i > -1) list.splice(i, 1);
        }

        function once(type, fn) {
            var unbind = on(type, function (payload) {
                unbind();
                fn(payload);
            });
            return unbind;
        }

        function emit(type, payload) {
            var list = map[type];
            if (!list || !list.length) return;
            list.slice().forEach(function (fn) {
                try {
                    fn(payload);
                } catch (err) {
                    console.error('[NC] event handler error (' + type + '):', err);
                }
            });
        }

        return {
            on: on,
            off: off,
            once: once,
            emit: emit,
            clear: function (type) {
                if (type) delete map[type];
                else map = Object.create(null);
            }
        };
    })();

    /* ------------------------------------------------------------------ *
     * 安全渲染 / DOM 工具
     * ------------------------------------------------------------------ */
    var ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return ESCAPE_MAP[ch];
        });
    }

    function appendChildren(node, children) {
        if (children == null) return;
        if (typeof children === 'string' || typeof children === 'number') {
            node.appendChild(document.createTextNode(String(children)));
            return;
        }
        if (Array.isArray(children)) {
            children.forEach(function (child) { appendChildren(node, child); });
            return;
        }
        if (children.nodeType) node.appendChild(children);
    }

    /**
     * 创建元素：e('button', { class: 'nc-btn', text: '保存', on: { click: fn } }, ['文本或子节点'])
     * 注意：仅 `html` 字段允许写 innerHTML，且只允许传入可信静态模板；
     * 用户数据一律走 text / appendChildren。
     */
    function e(tag, props, children) {
        var node = document.createElement(tag || 'div');
        if (props) {
            Object.keys(props).forEach(function (key) {
                var value = props[key];
                if (value == null || value === false) return;
                if (key === 'class' || key === 'className') {
                    node.className = String(value);
                } else if (key === 'text') {
                    node.textContent = String(value);
                } else if (key === 'html') {
                    node.innerHTML = String(value);
                } else if (key === 'dataset') {
                    Object.keys(value).forEach(function (dataKey) {
                        node.setAttribute('data-' + dataKey, String(value[dataKey]));
                    });
                } else if (key === 'style' && typeof value === 'object') {
                    Object.keys(value).forEach(function (styleKey) {
                        node.style.setProperty(styleKey, String(value[styleKey]));
                    });
                } else if (key === 'on' && typeof value === 'object') {
                    Object.keys(value).forEach(function (eventName) {
                        node.addEventListener(eventName, value[eventName]);
                    });
                } else if (typeof value === 'boolean' || typeof value === 'number') {
                    if (key in node) {
                        try { node[key] = value; } catch (err) { node.setAttribute(key, String(value)); }
                    } else {
                        node.setAttribute(key, String(value));
                    }
                } else if (key in node && typeof value !== 'string') {
                    try { node[key] = value; } catch (err) { node.setAttribute(key, String(value)); }
                } else if (key in node && ['value', 'type', 'placeholder', 'title', 'checked', 'disabled', 'selected', 'href', 'target', 'rel', 'maxLength', 'rows', 'cols', 'min', 'max', 'step', 'accept', 'autocomplete', 'spellcheck'].indexOf(key) > -1) {
                    try { node[key] = value; } catch (err) { node.setAttribute(key, String(value)); }
                } else {
                    node.setAttribute(key, String(value));
                }
            });
        }
        appendChildren(node, children);
        return node;
    }

    function delegate(root, eventType, selector, handler) {
        if (!root) return function () {};
        var listener = function (event) {
            var target = event.target;
            var matched = target && target.closest ? target.closest(selector) : null;
            if (matched && root.contains(matched)) handler(event, matched);
        };
        root.addEventListener(eventType, listener);
        return function () { root.removeEventListener(eventType, listener); };
    }

    /* ------------------------------------------------------------------ *
     * 基础工具
     * ------------------------------------------------------------------ */
    function uid(prefix) {
        return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    function cssEscape(value) {
        if (global.CSS && CSS.escape) return CSS.escape(String(value));
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    function clamp(value, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = min;
        return Math.min(max, Math.max(min, n));
    }

    function isFiniteNum(value) {
        return typeof value === 'number' && isFinite(value);
    }

    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function toInt(value, fallback) {
        var n = parseInt(value, 10);
        return isFinite(n) ? n : fallback;
    }

    function toNum(value, fallback) {
        var n = parseFloat(value);
        return isFinite(n) ? n : fallback;
    }

    function debounce(fn, wait) {
        var timer = null;
        function debounced() {
            var args = arguments, self = this;
            clearTimeout(timer);
            timer = setTimeout(function () {
                timer = null;
                fn.apply(self, args);
            }, wait || 150);
        }
        debounced.cancel = function () { clearTimeout(timer); timer = null; };
        debounced.flush = function () {
            if (timer) {
                clearTimeout(timer);
                timer = null;
                fn();
            }
        };
        return debounced;
    }

    function throttle(fn, wait) {
        var last = 0, timer = null, lastArgs = null, lastSelf = null;
        return function () {
            var now = Date.now();
            var remain = (wait || 100) - (now - last);
            lastArgs = arguments;
            lastSelf = this;
            if (remain <= 0) {
                last = now;
                fn.apply(lastSelf, lastArgs);
            } else if (!timer) {
                timer = setTimeout(function () {
                    timer = null;
                    last = Date.now();
                    fn.apply(lastSelf, lastArgs);
                }, remain);
            }
        };
    }

    function rafThrottle(fn) {
        var scheduled = false, lastArgs = null, lastSelf = null;
        return function () {
            lastArgs = arguments;
            lastSelf = this;
            if (scheduled) return;
            scheduled = true;
            (global.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); })(function () {
                scheduled = false;
                fn.apply(lastSelf, lastArgs);
            });
        };
    }

    function onceEvent(node, type, handler, options) {
        node.addEventListener(type, function fn(event) {
            node.removeEventListener(type, fn, options);
            handler(event);
        }, options);
    }

    /* ------------------------------------------------------------------ *
     * 剪贴板 / 下载
     * ------------------------------------------------------------------ */
    function copyText(text) {
        var value = String(text == null ? '' : text);
        if (global.navigator && navigator.clipboard && navigator.clipboard.writeText && global.isSecureContext) {
            return navigator.clipboard.writeText(value).then(function () {
                return true;
            }).catch(function () {
                return fallbackCopy(value);
            });
        }
        return Promise.resolve(fallbackCopy(value));
    }

    function fallbackCopy(value) {
        try {
            var textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.setAttribute('readonly', 'readonly');
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            textarea.style.top = '0';
            document.body.appendChild(textarea);
            textarea.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(textarea);
            return ok;
        } catch (err) {
            return false;
        }
    }

    /**
     * 触发下载。延迟吊销 ObjectURL，避免部分浏览器取消下载。
     * @param {string} filename
     * @param {Blob|string} data
     * @param {string} [mime]
     */
    function downloadBlob(filename, data, mime) {
        try {
            var blob = (data instanceof Blob) ? data : new Blob([data], { type: mime || 'application/octet-stream' });
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            setTimeout(function () {
                try { document.body.removeChild(link); } catch (err) { /* ignore */ }
                URL.revokeObjectURL(url);
            }, 1500);
            return true;
        } catch (err) {
            console.error('[NC] download failed', err);
            return false;
        }
    }

    function formatBytes(bytes) {
        var n = Number(bytes) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    /* ------------------------------------------------------------------ *
     * 日期与时间（本地时区，epoch ms 存储）
     * ------------------------------------------------------------------ */
    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function startOfDay(ts) {
        var d = new Date(ts || Date.now());
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    function endOfDay(ts) {
        return startOfDay(ts) + 86400000 - 1;
    }

    function dayDiff(fromTs, toTs) {
        return Math.round((startOfDay(toTs) - startOfDay(fromTs)) / 86400000);
    }

    function isSameDay(a, b) {
        return startOfDay(a) === startOfDay(b);
    }

    function formatTime(ts) {
        var d = new Date(ts);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function formatDate(ts, withYear) {
        var d = new Date(ts);
        return (withYear ? d.getFullYear() + '-' : '') + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function formatDateTime(ts) {
        if (!isFiniteNum(ts)) return '';
        return formatDate(ts, true) + ' ' + formatTime(ts);
    }

    /**
     * 面向待办的日期标签：
     * { tone: 'overdue'|'today'|'tomorrow'|'soon'|'later'|'none', label, dateLabel, timeLabel }
     */
    function dueMeta(ts, now) {
        if (!isFiniteNum(ts)) {
            return { tone: 'none', label: '无截止时间', dateLabel: '', timeLabel: '' };
        }
        var current = now || Date.now();
        var diff = dayDiff(current, ts);
        var time = formatTime(ts);
        var dateLabel = formatDate(ts, new Date(ts).getFullYear() !== new Date(current).getFullYear());
        if (ts < current) {
            var overdueDays = dayDiff(ts, current);
            var overdueLabel = overdueDays <= 0 ? '已逾期' : '逾期 ' + overdueDays + ' 天';
            return { tone: 'overdue', label: overdueLabel + ' · ' + time, dateLabel: dateLabel, timeLabel: time };
        }
        if (diff === 0) return { tone: 'today', label: '今天 ' + time, dateLabel: dateLabel, timeLabel: time };
        if (diff === 1) return { tone: 'tomorrow', label: '明天 ' + time, dateLabel: dateLabel, timeLabel: time };
        if (diff <= 7) return { tone: 'soon', label: diff + ' 天后 ' + time, dateLabel: dateLabel, timeLabel: time };
        return { tone: 'later', label: dateLabel + ' ' + time, dateLabel: dateLabel, timeLabel: time };
    }

    function toDateTimeInputValue(ts) {
        if (!isFiniteNum(ts)) return '';
        var d = new Date(ts);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
            'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function parseDateTimeInputValue(value) {
        if (!value) return null;
        var ts = new Date(value).getTime();
        return isFiniteNum(ts) ? ts : null;
    }

    function relativeTime(ts, now) {
        if (!isFiniteNum(ts)) return '';
        var diff = ts - (now || Date.now());
        var abs = Math.abs(diff);
        var suffix = diff >= 0 ? '后' : '前';
        if (abs < 60000) return diff >= 0 ? '即将' : '刚刚';
        if (abs < 3600000) return Math.floor(abs / 60000) + ' 分钟' + suffix;
        if (abs < 86400000) return Math.floor(abs / 3600000) + ' 小时' + suffix;
        if (abs < 86400000 * 30) return Math.floor(abs / 86400000) + ' 天' + suffix;
        return formatDate(ts, true) + suffix;
    }

    function prefersReducedMotion() {
        return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function parseJSON(text, fallback) {
        try {
            var value = JSON.parse(text);
            return value == null ? fallback : value;
        } catch (err) {
            return fallback;
        }
    }

    function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    NC.util = {
        escapeHtml: escapeHtml,
        escapeAttr: escapeHtml,
        e: e,
        delegate: delegate,
        uid: uid,
        cssEscape: cssEscape,
        clamp: clamp,
        isFiniteNum: isFiniteNum,
        isPlainObject: isPlainObject,
        toInt: toInt,
        toNum: toNum,
        debounce: debounce,
        throttle: throttle,
        rafThrottle: rafThrottle,
        onceEvent: onceEvent,
        copyText: copyText,
        downloadBlob: downloadBlob,
        formatBytes: formatBytes,
        pad2: pad2,
        startOfDay: startOfDay,
        endOfDay: endOfDay,
        dayDiff: dayDiff,
        isSameDay: isSameDay,
        formatTime: formatTime,
        formatDate: formatDate,
        formatDateTime: formatDateTime,
        dueMeta: dueMeta,
        toDateTimeInputValue: toDateTimeInputValue,
        parseDateTimeInputValue: parseDateTimeInputValue,
        relativeTime: relativeTime,
        prefersReducedMotion: prefersReducedMotion,
        parseJSON: parseJSON,
        ready: ready
    };
})(window);
