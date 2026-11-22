/**
 * pwa.js — 注册 Service Worker 与更新提示
 * 只在 HTTPS/localhost 生效；file:// 下直接跳过。
 */
(function (global) {
    'use strict';
    if (!('serviceWorker' in navigator)) return;
    var protocol = global.location && global.location.protocol;
    if (protocol !== 'https:' && protocol !== 'http:') return;
    var host = (global.location && global.location.hostname) || '';
    var local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (protocol === 'http:' && !local) return;

    var refreshing = false;
    var hadController = !!navigator.serviceWorker.controller;
    var updateNotified = false;

    function notifyUpdate(registration) {
        if (!registration || !registration.waiting || updateNotified) return;
        if (!navigator.serviceWorker.controller) return;
        updateNotified = true;
        if (global.NC && NC.ui && typeof NC.ui.toast === 'function') {
            NC.ui.toast('新版本已就绪，刷新后生效', {
                type: 'info',
                duration: 10000,
                action: {
                    label: '刷新',
                    onClick: function () {
                        try { registration.waiting.postMessage({ type: 'SKIP_WAITING' }); }
                        catch (err) { global.location.reload(); }
                    }
                }
            });
        }
    }

    navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || refreshing) return;
        refreshing = true;
        global.location.reload();
    });

    function register() {
        navigator.serviceWorker.register('./sw.js', {
            scope: './',
            updateViaCache: 'none'
        }).then(function (registration) {
            notifyUpdate(registration);
            registration.addEventListener('updatefound', function () {
                var worker = registration.installing;
                if (!worker) return;
                worker.addEventListener('statechange', function () {
                    if (worker.state === 'installed') notifyUpdate(registration);
                });
            });
            if (registration.update) registration.update().catch(function () { /* ignore */ });
        }).catch(function (err) {
            if (global.console && console.warn) console.warn('[pwa] service worker registration failed', err);
        });
    }

    if (document.readyState === 'complete') register();
    else global.addEventListener('load', register, { once: true });
})(window);
