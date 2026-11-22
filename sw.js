/* nTools Service Worker — 离线壳 + 静态缓存
 * 更新：修改 CACHE_VERSION；SW 更新后由 js/pwa.js 提示刷新。
 * 只缓存同源 GET 静态资源；AI API 等跨域请求不经过缓存。
 */
'use strict';

var CACHE_VERSION = 'ntools-v9.0.0';
var CACHE_NAME = CACHE_VERSION;
var CORE_ASSETS = [
    './css/base.css',
    './css/chat-sessions.css',
    './css/chat.css',
    './css/components.css',
    './css/email-tab.css',
    './css/interaction.css',
    './css/katex.min.css',
    './css/mail.css',
    './css/materials.css',
    './css/rail.css',
    './css/settings.css',
    './css/timeline.css',
    './css/tokens.css',
    './css/tools.css',
    './css/workshop.css',
    './img/apple-touch-icon.png',
    './img/favicon.svg',
    './img/pwa-192.png',
    './img/pwa-512.png',
    './img/pwa-maskable-512.png',
    './js/ai.js',
    './js/api.js',
    './js/backup.js',
    './js/chat-controller.js',
    './js/chat-db.js',
    './js/chat-embed.js',
    './js/chat-sessions.js',
    './js/compat.js',
    './js/composer.js',
    './js/conversation-store.js',
    './js/core.js',
    './js/datetime-field.js',
    './js/durability.js',
    './js/event-names.js',
    './js/icons.js',
    './js/katex.min.js',
    './js/llm-store.js',
    './js/mail/email-manager.html',
    './js/mail/mail-app.js',
    './js/mail/mail-icons.js',
    './js/mail/mail-select.js',
    './js/markdown-enhance.js',
    './js/marked.min.js',
    './js/message-view.js',
    './js/modules.js',
    './js/notes-db.js',
    './js/notes-index.js',
    './js/notes-store.js',
    './js/notes-view.js',
    './js/ntools-app.js',
    './js/polyfills.js',
    './js/pwa.js',
    './js/prefs.js',
    './js/preview-host.js',
    './js/purify.min.js',
    './js/qrcode.min.js',
    './js/refs.js',
    './js/schema-chat.js',
    './js/schema-notes.js',
    './js/schema-todo.js',
    './js/schema-workshop.js',
    './js/settings-data.js',
    './js/settings-modules.js',
    './js/settings-panel.js',
    './js/settings-profiles.js',
    './js/settings-store.js',
    './js/settings-view.js',
    './js/settings-workshop.js',
    './js/sse.js',
    './js/storage.js',
    './js/theme-boot.js',
    './js/theme.js',
    './js/todo-ai.js',
    './js/todo-composer.js',
    './js/todo-row.js',
    './js/todo-store.js',
    './js/todo-time.js',
    './js/todo-timeline-host.js',
    './js/todo-timeline.js',
    './js/todo-view.js',
    './js/todo.js',
    './js/tooltip.js',
    './js/ui.js',
    './js/workshop-builtin.js',
    './js/workshop-db.js',
    './js/workshop-store.js',
    './js/workshop-view.js',
    './js/workshop/builtin/_shared.js',
    './js/workshop/builtin/color-contrast.html',
    './js/workshop/builtin/countdown.html',
    './js/workshop/builtin/image.html',
    './js/workshop/builtin/json-tool.html',
    './js/workshop/builtin/picker.html',
    './js/workshop/builtin/pomodoro.html',
    './js/workshop/builtin/qr.html',
    './js/workshop/builtin/salary.html',
    './js/workshop/builtin/timer.html',
    './js/workshop/builtin/unit-convert.html',
    './js/workshop/builtin/web.html',
    './js/workshop/builtin/world-clock.html',
    './js/zip.js',
    './manifest.webmanifest',
    './ntools.html'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function (cache) { return cache.addAll(CORE_ASSETS); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(keys.map(function (key) {
                    if (key !== CACHE_NAME) return caches.delete(key);
                    return null;
                }));
            })
            .then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;
    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.headers.get('range')) return;

    /* HTML 导航：网络优先；离线回退到同路径缓存，再回退到应用壳 */
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(function (response) {
                    if (response && response.ok) {
                        var copy = response.clone();
                        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
                    }
                    return response;
                })
                .catch(function () {
                    return caches.match(request, { ignoreSearch: true })
                        .then(function (hit) { return hit || caches.match('./ntools.html'); });
                })
        );
        return;
    }

    /* 静态资源：缓存优先，失败再网络并写回 */
    event.respondWith(
        caches.match(request).then(function (hit) {
            if (hit) return hit;
            return fetch(request).then(function (response) {
                if (response && response.ok && response.type === 'basic') {
                    var copy = response.clone();
                    caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
                }
                return response;
            }).catch(function () {
                return caches.match(request, { ignoreSearch: true }).then(function (cached) {
                    return cached || new Response('Offline', {
                        status: 504,
                        statusText: 'Offline',
                        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                    });
                });
            });
        })
    );
});
