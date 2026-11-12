/**
 * compat.js — 运行时能力检测（经典脚本，依赖 core.js）
 * 目标环境：奇安信可信浏览器 Chromium 102 / 麒麟 Linux / file:// 或内网静态托管。
 * 注意：所有能力必须"检测 + 降级"，不允许直接假设可用。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util || {};

    function parseChromeVersion() {
        var ua = global.navigator ? global.navigator.userAgent : '';
        var match = ua.match(/Chrome\/(\d+)/) || ua.match(/Chromium\/(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    }

    function probeStorage() {
        try {
            var key = '__nc_storage_probe__';
            global.localStorage.setItem(key, '1');
            var ok = global.localStorage.getItem(key) === '1';
            global.localStorage.removeItem(key);
            return ok;
        } catch (err) {
            return false;
        }
    }

    function supports(prop, value) {
        return !!(global.CSS && global.CSS.supports && global.CSS.supports(prop, value));
    }

    var chromeVersion = parseChromeVersion();
    var features = {
        chromeVersion: chromeVersion,
        secureContext: !!global.isSecureContext,
        protocol: (global.location && global.location.protocol) || '',
        storage: probeStorage(),
        clipboard: !!(global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText),
        execCommand: typeof document.execCommand === 'function',
        notification: 'Notification' in global,
        notificationPermission: ('Notification' in global) ? global.Notification.permission : 'unsupported',
        indexedDB: !!global.indexedDB,
        broadcastChannel: 'BroadcastChannel' in global,
        resizeObserver: 'ResizeObserver' in global,
        abortController: 'AbortController' in global,
        stream: !!(global.ReadableStream && global.TextDecoder),
        cryptoSubtle: !!(global.crypto && global.crypto.subtle),
        randomUUID: !!(global.crypto && typeof global.crypto.randomUUID === 'function'),
        requestAnimationFrame: !!global.requestAnimationFrame,
        pointerEvents: 'PointerEvent' in global,
        matchMedia: !!global.matchMedia,
        fileProtocol: (global.location && global.location.protocol === 'file:'),
        hover: !!(global.matchMedia && global.matchMedia('(hover: hover)').matches),
        reducedMotion: util.prefersReducedMotion ? util.prefersReducedMotion() : false,
        cssGap: supports('gap', '1px'),
        cssBackdrop: supports('backdrop-filter', 'blur(1px)') || supports('-webkit-backdrop-filter', 'blur(1px)'),
        cssFocusVisible: supports('selector(:focus-visible)', 'true')
    };

    if (!features.clipboard && global.navigator && global.navigator.clipboard) {
        // 非安全上下文时 navigator.clipboard 可能不存在或不可用，统一走兜底
        features.clipboard = false;
    }

    NC.compat = {
        features: features,
        has: function (name) { return !!features[name]; },
        /**
         * 首次加载时根据能力做最小适配：存储不可用 / 缺少硬件加速建议 Lite。
         * 页面可在自己的启动流程中调用。
         */
        bootstrap: function () {
            var root = document.documentElement;
            if (!features.storage) {
                root.setAttribute('data-storage', 'unavailable');
            }
            var liteStored = null;
            try { liteStored = global.localStorage.getItem('nchat-lite-mode'); } catch (err) { liteStored = null; }
            if (liteStored === null) {
                var lowEnd = (global.navigator && global.navigator.hardwareConcurrency && global.navigator.hardwareConcurrency <= 4);
                if (features.reducedMotion || lowEnd) {
                    root.setAttribute('data-lite', 'true');
                }
            }
            return features;
        }
    };

    NC.env.chrome = chromeVersion;
})(window);
