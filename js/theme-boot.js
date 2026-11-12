/**
 * theme-boot.js — 阻塞式主题引导（<1KB），必须在 CSS 后、其他脚本前同步加载，避免 FOUC。
 * 仅负责：读取本地主题/Lite 偏好，写入 <html data-theme data-lite>。
 */
(function () {
    'use strict';
    var root = document.documentElement;
    var theme = null;
    var lite = null;
    try {
        theme = localStorage.getItem('nchat-theme');
        lite = localStorage.getItem('nchat-lite-mode');
    } catch (err) { /* 存储不可用时使用默认值 */ }

    if (theme !== 'light' && theme !== 'dark') {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) theme = 'light';
        else theme = 'dark';
    }

    if (lite === null || lite === undefined || lite === '') {
        lite = 'false';
        try {
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) lite = 'true';
        } catch (err) { /* ignore */ }
    } else {
        lite = (lite === 'true') ? 'true' : 'false';
    }

    root.setAttribute('data-theme', theme);
    root.setAttribute('data-lite', lite);
    root.style.colorScheme = theme;
})();
