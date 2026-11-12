/**
 * theme.js — 主题 / Lite 模式管理（经典脚本，依赖 core.js、storage.js）
 * 状态持久化键：nchat-theme（light|dark）、nchat-lite-mode（'true'|'false'）
 * 事件：theme:changed {theme}、lite:changed {lite}
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var events = NC.events;
    var storage = NC.storage;
    var util = NC.util;

    var THEME_KEY = 'nchat-theme';
    var LITE_KEY = 'nchat-lite-mode';
    var systemQuery = global.matchMedia ? global.matchMedia('(prefers-color-scheme: light)') : null;
    var themeManuallySet = false;

    function isLite() {
        return document.documentElement.getAttribute('data-lite') === 'true';
    }

    function isLight() {
        return document.documentElement.getAttribute('data-theme') === 'light';
    }

    function applyTheme(theme) {
        var next = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        document.documentElement.style.colorScheme = next;
        events.emit('theme:changed', { theme: next });
        return next;
    }

    function applyLite(lite) {
        var next = !!lite;
        document.documentElement.setAttribute('data-lite', next ? 'true' : 'false');
        events.emit('lite:changed', { lite: next });
        return next;
    }

    function setTheme(theme) {
        themeManuallySet = true;
        var next = applyTheme(theme);
        storage.setRaw(THEME_KEY, next);
        return next;
    }

    function toggleTheme() {
        return setTheme(isLight() ? 'dark' : 'light');
    }

    function setLite(lite) {
        var next = applyLite(lite);
        storage.setRaw(LITE_KEY, next ? 'true' : 'false');
        return next;
    }

    function toggleLite() {
        return setLite(!isLite());
    }

    function init() {
        var storedTheme = storage.getRaw(THEME_KEY);
        if (storedTheme === 'light' || storedTheme === 'dark') {
            themeManuallySet = true;
            applyTheme(storedTheme);
        } else {
            applyTheme(isLight() ? 'light' : 'dark');
        }
        var storedLite = storage.getRaw(LITE_KEY);
        if (storedLite === 'true' || storedLite === 'false') {
            applyLite(storedLite === 'true');
        } else {
            applyLite(isLite());
        }
        if (systemQuery) {
            var listener = function () {
                if (!themeManuallySet) applyTheme(systemQuery.matches ? 'light' : 'dark');
            };
            if (systemQuery.addEventListener) systemQuery.addEventListener('change', listener);
            else if (systemQuery.addListener) systemQuery.addListener(listener);
        }
        if (!util.prefersReducedMotion()) return;
        // 系统级减少动效：仅在不支持 CSS 媒体查询的极端内核下兜底
        return;
    }

    NC.theme = {
        init: init,
        set: setTheme,
        toggle: toggleTheme,
        setLite: setLite,
        toggleLite: toggleLite,
        isLite: isLite,
        isLight: isLight,
        themeKey: THEME_KEY,
        liteKey: LITE_KEY
    };
})(window);
