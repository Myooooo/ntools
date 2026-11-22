/* pwa-head.js — 仅在 HTTP(S) 下挂 manifest；file:// 不请求，避免 CORS 噪声 */
(function () {
    'use strict';
    var protocol = location.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return;
    if (document.querySelector('link[rel="manifest"]')) return;
    var link = document.createElement('link');
    link.rel = 'manifest';
    link.href = 'manifest.webmanifest';
    document.head.appendChild(link);
})();
