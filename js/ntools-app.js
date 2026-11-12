/**
 * ntools-app.js — nTools 组合根：tab 路由 / 主题 / Lite / 菜单 / 模块接线与降级 / 存储横幅
 * 经典脚本（最后加载），依赖 core / compat / icons / storage / ui / theme 与各页面模块。
 * 规则：只做装配，不写业务；叶子模块缺失时不阻断任何其它模块。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var icons = NC.icons;
    var ui = NC.ui;

    var TABS = ['todo', 'qr', 'md', 'image', 'nchat'];
    var PAGE_TITLES = {
        todo: '待办事项',
        qr: '二维码生成',
        md: 'Markdown 渲染',
        image: '图片与 Base64',
        nchat: 'nChat'
    };
    var currentTab = 'todo';
    var bannerTimer = null;
    var lastErrorToast = 0;
    var iframeLoaded = false;

    /* ------------------------------------------------------------------ *
     * 启动
     * ------------------------------------------------------------------ */
    function init() {
        NC.env.page = 'tools';
        try {
            hydrateIcons(document);
            if (typeof NC.compat.bootstrap === 'function') NC.compat.bootstrap();
            if (typeof NC.ui.installGlobalErrorHandlers === 'function') NC.ui.installGlobalErrorHandlers();
        } catch (err) { /* 基础设施错误不阻断页面 */ }

        initTheme();
        bindNav();
        bindAppMenu();
        bindBanner();
        bindTabsShortcut();
        bindGlobalEvents();
        applyUrlOverrides();

        /* 待办为核心模块，单独 try/catch（叶子模块失败不影响它） */
        initTodo();

        /* 工具叶子模块：由 platform-compat 提供，缺失时降级展示说明 */
        initLeafModule('qr', 'page-qr', 'qr-module-note');
        initLeafModule('markdown', 'page-md', 'md-module-note');
        initLeafModule('image', 'page-image', 'image-module-note');

        routeFromHash(true);
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 图标水合：把 [data-icon="name"] 替换为内联 SVG
     * ------------------------------------------------------------------ */
    function hydrateIcons(root) {
        if (!icons || !icons.el) return;
        Array.prototype.forEach.call((root || document).querySelectorAll('[data-icon]'), function (el) {
            var name = el.getAttribute('data-icon');
            if (!name) return;
            var size = parseInt(el.getAttribute('data-icon-size'), 10) || 18;
            try {
                var svg = icons.el(name, size);
                if (svg) {
                    el.textContent = '';
                    el.appendChild(svg);
                    el.removeAttribute('data-icon');
                }
            } catch (err) { /* 图标失败不影响功能 */ }
        });
    }

    /* ------------------------------------------------------------------ *
     * 主题 / Lite
     * ------------------------------------------------------------------ */
    function initTheme() {
        try {
            NC.theme.init();
        } catch (err) { /* ignore */ }
        updateThemeButtons();
        NC.events.on('theme:changed', function () {
            updateThemeButtons();
        });
        NC.events.on('lite:changed', function () {
            updateThemeButtons();
        });
        var toggle = document.getElementById('theme-toggle-btn');
        if (toggle) {
            toggle.addEventListener('click', function () {
                NC.theme.toggle();
            });
        }
    }

    function updateThemeButtons() {
        var toggle = document.getElementById('theme-toggle-btn');
        if (!toggle || !icons) return;
        var light = NC.theme.isLight();
        var name = light ? 'moon' : 'sun';
        var label = light ? '切换到深色主题' : '切换到浅色主题';
        toggle.textContent = '';
        toggle.appendChild(icons.el(name, 18));
        toggle.setAttribute('aria-label', label);
        toggle.setAttribute('title', label);
    }

    /* ------------------------------------------------------------------ *
     * 顶部导航 / tab 路由
     * ------------------------------------------------------------------ */
    function normalizeTab(raw) {
        if (!raw) return null;
        var value = String(raw).replace(/^#/, '').toLowerCase();
        if (value === 'markdown') value = 'md';
        if (value === 'img' || value === 'image-tool') value = 'image';
        if (value === 'chat') value = 'nchat';
        return TABS.indexOf(value) > -1 ? value : null;
    }

    function bindNav() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (link) {
            link.addEventListener('click', function (event) {
                event.preventDefault();
                switchTab(link.getAttribute('data-tab'), true);
            });
        });
        global.addEventListener('hashchange', function () {
            var tab = normalizeTab(global.location.hash);
            if (tab && tab !== currentTab) switchTab(tab, false);
        });
    }

    function switchTab(tab, updateHash) {
        var target = normalizeTab(tab);
        if (!target) return;
        currentTab = target;

        Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (link) {
            var active = link.getAttribute('data-tab') === target;
            link.classList.toggle('is-active', active);
            if (active) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });

        Array.prototype.forEach.call(document.querySelectorAll('.tools-page'), function (page) {
            var active = page.getAttribute('data-page') === target;
            page.classList.toggle('is-active', active);
            if (active) page.removeAttribute('hidden');
            else page.setAttribute('hidden', '');
        });

        if (updateHash) setHash(target);
        if (target === 'nchat') ensureIframe();
        if (target === 'todo' && NC.view && NC.view.todo && NC.view.todo.render) {
            /* 回到待办时刷新时间标签，确保跨分钟准确 */
            NC.view.todo.refreshTimes();
        }
    }

    function setHash(tab) {
        try {
            var next = '#' + tab;
            if (global.location.hash === next) return;
            if (global.history && global.history.replaceState) {
                global.history.replaceState(null, '', next);
            } else {
                global.location.hash = tab;
            }
        } catch (err) { /* file:// 下 replaceState 失败时忽略 */ }
    }

    function routeFromHash(firstLoad) {
        var tab = normalizeTab(global.location.hash) || 'todo';
        switchTab(tab, false);
        if (firstLoad && !global.location.hash) setHash(tab);
    }

    function bindTabsShortcut() {
        document.addEventListener('keydown', function (event) {
            if (!event.altKey || event.ctrlKey || event.metaKey) return;
            var index = parseInt(event.key, 10);
            if (!isFinite(index) || index < 1 || index > TABS.length) return;
            event.preventDefault();
            switchTab(TABS[index - 1], true);
        });
    }

    /* ------------------------------------------------------------------ *
     * iframe 懒加载（只加载一次）
     * ------------------------------------------------------------------ */
    function ensureIframe() {
        if (iframeLoaded) return;
        var frame = document.getElementById('nchat-frame');
        if (!frame) return;
        var src = frame.getAttribute('data-src') || frame.getAttribute('src');
        if (!src) return;
        frame.setAttribute('src', src);
        iframeLoaded = true;
    }

    /* ------------------------------------------------------------------ *
     * 应用菜单（主题 / Lite / 帮助 / 关于）
     * ------------------------------------------------------------------ */
    function bindAppMenu() {
        var btn = document.getElementById('app-menu-btn');
        if (!btn) return;
        btn.addEventListener('click', function () {
            ui.openMenu(btn, [
                {
                    label: NC.theme.isLight() ? '切换到深色主题' : '切换到浅色主题',
                    icon: NC.theme.isLight() ? 'moon' : 'sun',
                    onSelect: function () { NC.theme.toggle(); }
                },
                {
                    label: NC.theme.isLite() ? '关闭 Lite 模式' : '开启 Lite 模式',
                    icon: 'zap',
                    hint: NC.theme.isLite() ? '已开启' : '',
                    onSelect: function () {
                        var next = NC.theme.toggleLite();
                        ui.toast(next ? '已开启 Lite 模式：关闭动画与毛玻璃' : '已关闭 Lite 模式', {
                            type: 'info',
                            duration: 2200
                        });
                    }
                },
                { type: 'divider' },
                {
                    label: '快捷键与帮助',
                    icon: 'command',
                    hint: '?',
                    onSelect: function () {
                        if (NC.tools.todo && NC.tools.todo.openHelp) NC.tools.todo.openHelp();
                        else showFallbackHelp();
                    }
                },
                {
                    label: '关于 nTools',
                    icon: 'info',
                    onSelect: openAbout
                }
            ]);
        });
    }

    function showFallbackHelp() {
        ui.openModal({
            title: '快捷键与帮助',
            message: '切换到「待办」标签后按 ? 查看完整快捷键说明。',
            actions: [{ label: '好的', kind: 'primary' }]
        });
    }

    function openAbout() {
        var wrap = document.createElement('div');
        wrap.className = 'about-panel';
        var features = (NC.compat && NC.compat.features) || {};
        var counts = NC.store && NC.store.todo ? NC.store.todo.counts(true) : null;
        var rows = [
            ['版本', 'nTools ' + (NC.version || '2.0.0')],
            ['运行方式', (features.fileProtocol ? '本地文件 file://' : (features.protocol || '未知协议')) + ' · 无后端'],
            ['内核', 'Chromium ' + (features.chromeVersion || '未知')],
            ['存储', features.storage ? 'localStorage 可用' : '不可用（内存模式）'],
            ['主题', (NC.theme.isLight() ? '浅色' : '深色') + (NC.theme.isLite() ? ' · Lite' : '')],
            ['待办数据', counts ? (counts.total + ' 条任务 / ' + counts.trash + ' 条回收站') : '未加载']
        ];
        rows.forEach(function (pair) {
            var row = document.createElement('div');
            row.className = 'about-panel__row';
            var key = document.createElement('span');
            key.className = 'about-panel__key';
            key.textContent = pair[0];
            var value = document.createElement('span');
            value.className = 'about-panel__value';
            value.textContent = pair[1];
            row.appendChild(key);
            row.appendChild(value);
            wrap.appendChild(row);
        });
        var note = document.createElement('p');
        note.className = 'about-panel__note';
        note.textContent = '所有数据仅保存在本机浏览器，不会上传网络。建议定期在「待办 → 更多」中导出 JSON 备份。';
        wrap.appendChild(note);
        ui.openModal({
            title: '关于 nTools',
            content: wrap,
            size: 'sm',
            actions: [{ label: '知道了', kind: 'primary' }]
        });
    }

    /* ------------------------------------------------------------------ *
     * 存储告警横幅
     * ------------------------------------------------------------------ */
    function bindBanner() {
        var close = document.getElementById('app-banner-close');
        if (close) {
            close.addEventListener('click', function () { hideBanner(); });
        }
        var action = document.getElementById('app-banner-action');
        if (action) {
            action.addEventListener('click', function () {
                if (typeof action.__onClick === 'function') action.__onClick();
            });
        }
        /* 存储不可用：常驻提示 */
        if (NC.compat && NC.compat.features && !NC.compat.features.storage) {
            showBanner('本地存储不可用：本次修改仅保存在当前会话，关闭页面后会丢失。', {
                persistent: true,
                actionLabel: '导出待办备份',
                onAction: exportTodoBackup
            });
        }
        NC.events.on('quota:warning', function () {
            showBanner('本地存储空间接近上限（3.5 MB），建议导出备份并清理旧任务。', {
                actionLabel: '导出待办备份',
                onAction: exportTodoBackup
            });
        });
        NC.events.on('storage:error', function () {
            showBanner('本地存储读写异常，修改可能无法保存，请及时导出备份。', {
                actionLabel: '导出待办备份',
                onAction: exportTodoBackup
            });
        });
        NC.events.on('storage:corrupt', function () {
            showBanner('检测到损坏的本地数据，已备份原始内容并尝试恢复。', {});
        });
    }

    function exportTodoBackup() {
        if (NC.tools.todo && NC.tools.todo.exportToFile) NC.tools.todo.exportToFile();
        else ui.toast('待办模块未就绪，暂时无法导出', { type: 'warn' });
    }

    function showBanner(message, options) {
        var opts = options || {};
        var banner = document.getElementById('app-banner');
        var text = document.getElementById('app-banner-text');
        var action = document.getElementById('app-banner-action');
        if (!banner || !text) return;
        banner.hidden = false;
        text.textContent = message;
        if (action) {
            if (opts.actionLabel && typeof opts.onAction === 'function') {
                action.hidden = false;
                action.textContent = opts.actionLabel;
                action.__onClick = opts.onAction;
            } else {
                action.hidden = true;
                action.__onClick = null;
            }
        }
        var close = document.getElementById('app-banner-close');
        if (close) close.hidden = !!opts.persistent;
        if (bannerTimer) global.clearTimeout(bannerTimer);
        if (!opts.persistent) {
            bannerTimer = global.setTimeout(function () { hideBanner(); }, 9000);
        }
    }

    function hideBanner() {
        var banner = document.getElementById('app-banner');
        if (banner) banner.hidden = true;
        if (bannerTimer) {
            global.clearTimeout(bannerTimer);
            bannerTimer = null;
        }
    }

    /* ------------------------------------------------------------------ *
     * 模块接线
     * ------------------------------------------------------------------ */
    function initTodo() {
        try {
            if (NC.tools && NC.tools.todo && typeof NC.tools.todo.init === 'function') {
                NC.tools.todo.init();
            } else {
                showBanner('待办模块未加载（js/todo.js），页面其它工具仍可使用。', { persistent: true });
            }
        } catch (err) {
            showBanner('待办模块初始化失败，其它工具仍可使用。可刷新页面重试。', { persistent: true });
        }
    }

    function initLeafModule(name, pageId, noteId) {
        var panel = document.getElementById(pageId);
        var note = document.getElementById(noteId);
        var module = NC.tools && NC.tools[name];
        if (module && typeof module.init === 'function') {
            try {
                module.init();
                if (note) note.hidden = true;
                if (panel) panel.setAttribute('data-module', 'ready');
                return true;
            } catch (err) {
                /* 模块内部错误：降级提示，不影响其它工具 */
            }
        }
        if (panel) panel.setAttribute('data-module', 'missing');
        if (note) {
            note.hidden = false;
            note.textContent = '该工具模块尚未加载（js/' + (name === 'markdown' ? 'markdown' : name) + '.js），界面已就绪，模块就位后刷新页面即可使用。';
        }
        return false;
    }

    /* ------------------------------------------------------------------ *
     * URL 覆盖（仅用于验收截图 / 调试：?theme=light&lite=1）
     * ------------------------------------------------------------------ */
    function applyUrlOverrides() {
        try {
            var search = global.location.search || '';
            if (!search) return;
            var params = {};
            search.replace(/^\?/, '').split('&').forEach(function (pair) {
                if (!pair) return;
                var index = pair.indexOf('=');
                params[decodeURIComponent(index > -1 ? pair.slice(0, index) : pair)] =
                    decodeURIComponent(index > -1 ? pair.slice(index + 1) : '1');
            });
            if (params.theme === 'light' || params.theme === 'dark') NC.theme.set(params.theme);
            if (params.lite === '1') NC.theme.setLite(true);
            if (params.lite === '0') NC.theme.setLite(false);
        } catch (err) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ *
     * 全局事件：错误提示（限流） + 首屏可见性
     * ------------------------------------------------------------------ */
    function bindGlobalEvents() {
        NC.events.on('app:error', function (payload) {
            var now = Date.now();
            if (now - lastErrorToast < 5000) return;
            lastErrorToast = now;
            ui.toast('页面出现错误，可刷新重试（详情见控制台）', { type: 'error', duration: 4000 });
            if (NC.debug && global.console && payload) {
                global.console.warn('[nTools] app:error', payload);
            }
        });
    }

    /* ------------------------------------------------------------------ *
     * 启动：defer 脚本在 DOM 解析完成后执行，直接初始化即可
     * ------------------------------------------------------------------ */
    try {
        init();
    } catch (err) {
        /* 组合根兜底：任何初始化异常都不能白屏 */
        var banner = document.getElementById('app-banner');
        var text = document.getElementById('app-banner-text');
        if (banner && text) {
            banner.hidden = false;
            text.textContent = '页面初始化出现异常，部分工具可能不可用，请刷新重试。';
        }
    }
})(window);
