/**
 * _shared.js — 内置工具的公共主题桥（v8）
 * 初始值：读取 ?theme=&lite=；之后监听父页 postMessage，不再 reload。
 * 独立打开（file://）时也能工作；父页消息必须来自 window.parent。
 */
(function () {
    'use strict';

    function apply(theme, lite) {
        document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
        document.documentElement.setAttribute('data-lite', lite ? 'true' : 'false');
    }

    var params = new URLSearchParams(location.search);
    apply(params.get('theme') || 'dark', params.get('lite') === '1');

    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        var data = event.data;
        if (!data || data.type !== 'nc-ws-theme') return;
        apply(data.theme, !!data.lite);
        try {
            window.parent.postMessage({ type: 'nc-ws-theme-ack', requestId: data.requestId || '' }, '*');
        } catch (err) { /* ignore */ }
    });
})();
