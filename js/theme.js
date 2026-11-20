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
        var themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) themeMeta.setAttribute('content', next === 'light' ? '#f4f5f7' : '#0b0e13');
        events.emit(NC.eventNames.themeChanged, { theme: next });
        return next;
    }

    function applyLite(lite) {
        var next = !!lite;
        document.documentElement.setAttribute('data-lite', next ? 'true' : 'false');
        events.emit(NC.eventNames.liteChanged, { lite: next });
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
        var forcedFx = '';
        try {
            forcedFx = String((new URLSearchParams(global.location.search)).get('fx') || '');
        } catch (err) { forcedFx = ''; }
        if (forcedFx === 'lite' || forcedFx === 'full') {
            // 支持 ?fx=lite / ?fx=full 现场切换，不写入偏好
            applyLite(forcedFx === 'lite');
        } else if (storedLite === 'true' || storedLite === 'false') {
            applyLite(storedLite === 'true');
        } else {
            // 首次启动：内存 ≤4GB 或只有 2 核，默认 Lite；Safari 无 deviceMemory，不误判
            var weak = false;
            try {
                var mem = global.navigator && global.navigator.deviceMemory;
                var cores = global.navigator && global.navigator.hardwareConcurrency;
                weak = (typeof mem === 'number' && mem > 0 && mem <= 4) ||
                    (typeof cores === 'number' && cores > 0 && cores <= 2);
            } catch (err) { weak = false; }
            applyLite(weak);
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
