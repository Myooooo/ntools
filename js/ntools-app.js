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

    var TABS = (NC.modules && NC.modules.tabIds) ? NC.modules.tabIds() : ['todo', 'email', 'md', 'nchat', 'workshop'];
    var PAGE_TITLES = (NC.modules && NC.modules.pageTitles) ? NC.modules.pageTitles() : {
        todo: '待办事项',
        email: '邮箱维护',
        md: '笔记本',
        nchat: 'nChat',
        workshop: '创意工坊'
    };
    var currentTab = 'todo';
    var bannerTimer = null;
    var lastErrorToast = 0;
    var chatInited = false;

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

        syncVersionLabel();
        initTheme();
        initLlmAndSettings();
        bindLazySettingsButton();
        initRail();
        bindNav();
        bindAppMenu();
        bindBanner();
        bindDurabilityBar();
        bindEmailFrame();
        bindTabsShortcut();
        bindGlobalEvents();
        applyUrlOverrides();

        /* 待办为核心模块，单独 try/catch（叶子模块失败不影响它） */
        initTodo();

        /* 工具叶子模块：由 platform-compat 提供，缺失时降级展示说明 */

        routeFromHash(true);
        maybeAutoLite();

        /* 全量自动备份调度（默认 24h；到点写一份本机快照） */
        try {
            if (NC.backup && typeof NC.backup.startScheduler === 'function') NC.backup.startScheduler();
        } catch (err) { /* ignore */ }
        NC.ready = true;
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 弱机自动 Lite
     * 首屏初始化超过 400ms 且用户从未手动选过 Lite → 自动开启（可在设置里关掉）。
     * 只做一次：一旦写入偏好，后续就以用户/既有设置为准。
     * ------------------------------------------------------------------ */
    function maybeAutoLite() {
        try {
            if (!global.localStorage) return;
            if (NC.prefs.raw('nchat-lite-mode') !== null) return;
            if (NC.theme.isLite()) return;
            var elapsed = Date.now() - (NC.bootAt || Date.now());
            if (elapsed < 400) return;
            NC.theme.setLite(true);
            NC.log('auto-lite: boot took ' + elapsed + 'ms');
        } catch (err) { /* ignore */ }
    }

    /* 版本号单一来源：页面只写占位，实际值来自 NC.version，避免两处漂移 */
    function syncVersionLabel() {
        var el = document.getElementById('rail-version');
        if (!el || !NC.version) return;
        var short = String(NC.version).split('.').slice(0, 2).join('.');
        el.textContent = 'v' + short;
        el.title = '版本 ' + NC.version;
    }

    /* ------------------------------------------------------------------ *
     * 图标水合：把 [data-icon="name"] 替换为内联 SVG
     * ------------------------------------------------------------------ */
    function hydrateIcons(root) {
        if (!icons || !icons.el) return;
        Array.prototype.forEach.call((root || document).querySelectorAll('[data-icon]'), function (el) {
            var name = el.getAttribute('data-icon');
            if (!name) return;
            var size = parseInt(el.getAttribute('data-icon-size'), 10) || 16;
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
     * 可收起侧边栏（仅桌面；移动端为顶部栏）
     * ------------------------------------------------------------------ */
    var RAIL_KEY = 'ntools.rail-collapsed';

    var COMPACT_QUERY = '(max-width: 1100px)';

    function initRail() {
        var app = document.getElementById('tools-app');
        var btn = document.getElementById('rail-toggle-btn');
        if (!app || !btn) return;

        /* manual：用户显式选择（持久化）；compact：窗口窄，强制图标态（不持久化）。
         * 两者取或——1080p 左右分屏时不占掉 196px，回到宽屏又恢复用户的选择。 */
        var manual = false;
        var mq = global.matchMedia ? global.matchMedia(COMPACT_QUERY) : null;

        function isCompact() {
            return !!(mq && mq.matches);
        }

        function apply(collapsed) {
            app.classList.toggle('is-rail-collapsed', !!collapsed);
            btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            btn.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
            btn.title = collapsed ? '展开侧边栏' : '收起侧边栏';
        }

        function applyEffective() {
            apply(manual || isCompact());
            app.classList.toggle('is-compact', isCompact());
        }

        manual = NC.prefs.get(RAIL_KEY, '0') === '1';
        applyEffective();

        if (mq) {
            var onChange = function () { applyEffective(); };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        }

        btn.addEventListener('click', function (event) {
            manual = !manual;
            applyEffective();
            NC.prefs.set(RAIL_KEY, manual ? '1' : '0');
            /* 鼠标点击后释放焦点：否则收起态按钮会一直以“聚焦/悬浮”浮在 logo 上 */
            if (event && event.detail > 0) {
                btn.blur();
            }
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
        NC.events.on(NC.eventNames.themeChanged, function () {
            updateThemeButtons();
        });
        NC.events.on(NC.eventNames.liteChanged, function () {
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
        /* 旧的 #image / #qr 深链合并到创意工坊 */
        if (value === 'img' || value === 'image-tool' || value === 'image' || value === 'qr') value = 'workshop';
        if (value === 'chat') value = 'nchat';
        return TABS.indexOf(value) > -1 ? value : null;
    }

    function bindNav() {
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && NC.ui && NC.ui.closeAllPopovers) NC.ui.closeAllPopovers('hidden');
        });
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

    var switchingTabGuard = false;

    function switchTab(tab, updateHash) {
        var target = normalizeTab(tab);
        if (!target) return;
        if (currentTab === 'workshop' && target !== 'workshop' &&
            NC.view && NC.view.workshop && typeof NC.view.workshop.confirmLeave === 'function') {
            if (switchingTabGuard) return;
            switchingTabGuard = true;
            NC.view.workshop.confirmLeave().then(function (ok) {
                switchingTabGuard = false;
                if (ok) {
                    applySwitchTab(target, updateHash);
                } else if (!updateHash) {
                    setHash('workshop');
                }
            }, function () {
                switchingTabGuard = false;
            });
            return;
        }
        applySwitchTab(target, updateHash);
    }

    function applySwitchTab(target, updateHash) {
        // 切页前先关掉菜单/下拉/工具提示，避免浮层悬在新页面上
        if (NC.ui && NC.ui.closeAllPopovers) NC.ui.closeAllPopovers('route');
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
        if (target === 'email' && typeof emailFrameState.ensureLoaded === 'function') emailFrameState.ensureLoaded();
        if (target === 'nchat') initChat();
        if (target === 'md') initNotes();
        if (target === 'workshop') initWorkshop();
        if (target === 'todo' && NC.view && NC.view.todo && NC.view.todo.render) {
            /* 回到待办时刷新时间标签，确保跨分钟准确 */
            NC.view.todo.refreshTimes();
        }
    }

    /* 供设置面板等模块跳转 tab */
    NC.switchTab = switchTab;

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

    /* 启动时默认页面：存 ntools.startTab，取值必须是 TABS 之一 */
    var START_TAB_KEY = 'ntools.startTab';
    function readStartTab() {
        var value = '';
        value = String(NC.prefs.get(START_TAB_KEY, ''));
        return TABS.indexOf(value) > -1 ? value : 'todo';
    }
    function writeStartTab(tab) {
        var next = TABS.indexOf(tab) > -1 ? tab : 'todo';
        return NC.prefs.set(START_TAB_KEY, next);
    }
    NC.getStartTab = readStartTab;
    NC.setStartTab = writeStartTab;
    NC.tabTitles = function () { return Object.assign({}, PAGE_TITLES); };

    function routeFromHash(firstLoad) {
        var fromHash = normalizeTab(global.location.hash);
        var tab = fromHash || (firstLoad ? readStartTab() : 'todo') || 'todo';
        /* 首次进入不再把 tab 写进地址栏：否则刷新会带着 #tab，把「启动时默认页面」永久覆盖掉。
         * 用户主动点导航时仍然会写 hash（switchTab(tab, true)）。 */
        switchTab(tab, false);
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
     * 全局端点 / 设置面板 / 原生聊天（懒加载）
     * ------------------------------------------------------------------ */
    /* 设置面板（约 116KB）按需加载：首屏不解析，第一次打开时注入 */
    var settingsPromise = null;
    var settingsLoaded = false;

    function loadSettingsBundle() {
        if (settingsLoaded) return Promise.resolve(true);
        if (settingsPromise) return settingsPromise;
        var util = NC.util;
        if (!util || typeof util.loadScript !== 'function') return Promise.reject(new Error('loader unavailable'));
        settingsPromise = util.loadScript('js/settings-panel.js').then(function () {
            return util.loadScript('js/settings-modules.js').catch(function () { return null; });
        }).then(function () {
            return util.loadScript('js/settings-profiles.js').catch(function () { return null; });
        }).then(function () {
            return util.loadScript('js/settings-data.js').catch(function () { return null; });
        }).then(function () {
            return util.loadScript('js/settings-workshop.js').catch(function () { return null; });
        }).then(function () {
            settingsLoaded = true;
            if (NC.settingsPanel && typeof NC.settingsPanel.init === 'function') NC.settingsPanel.init();
            return true;
        }, function (err) {
            settingsPromise = null;
            throw err;
        });
        return settingsPromise;
    }

    function openSettings(section) {
        return loadSettingsBundle().then(function () {
            if (NC.settingsPanel && typeof NC.settingsPanel.open === 'function') {
                NC.settingsPanel.open(section || 'general');
            }
        }, function (err) {
            if (NC.ui && NC.ui.toast) {
                NC.ui.toast('设置面板加载失败：' + (err && err.message ? err.message : err), { type: 'error' });
            }
        });
    }

    NC.openSettings = openSettings;
    NC.loadSettingsBundle = loadSettingsBundle;

    /* 兼容：懒加载完成前，旧的同步调用先走存根，加载完成后由真实面板覆盖 */
    if (!NC.settingsPanel) {
        NC.settingsPanel = {
            open: function (section) { return openSettings(section); },
            close: function () { /* 面板尚未加载，无需关闭 */ },
            isOpen: function () { return false; }
        };
    }

    /* 设置按钮先绑定一次，避免面板未加载时点击无反应；面板加载后会跳过重复绑定 */
    function bindLazySettingsButton() {
        var btn = document.getElementById('settings-btn');
        if (!btn) return;
        btn.setAttribute('data-nc-settings-lazy', '1');
        btn.addEventListener('click', function () { openSettings('profiles'); });
    }

    function initLlmAndSettings() {
        try {
            if (NC.store && NC.store.llm && typeof NC.store.llm.init === 'function') {
                NC.store.llm.init();
            }
        } catch (err) {
            showBanner('端点配置加载失败，聊天与 Todo AI 可能不可用。', { persistent: true });
        }
    }

    /* 聊天栈（约 250KB）首屏不加载：只在第一次进 nChat 时按序注入。
     * 弱机上这能省掉首屏 20% 的解析量。 */
    var CHAT_SCRIPTS = [
        'js/sse.js',
        'js/api.js',
        'js/chat-db.js',
        'js/conversation-store.js',
        'js/settings-store.js',
        'js/message-view.js',
        'js/composer.js',
        'js/settings-view.js',
        'js/chat-controller.js',
        'js/chat-sessions.js',
        'js/chat-embed.js'
    ];
    var chatBundlePromise = null;

    function loadChatBundle() {
        if (chatBundlePromise) return chatBundlePromise;
        var util = NC.util;
        if (!util || typeof util.loadScript !== 'function') {
            return Promise.reject(new Error('loader unavailable'));
        }
        chatBundlePromise = CHAT_SCRIPTS.reduce(function (chain, src) {
            return chain.then(function () { return util.loadScript(src); });
        }, Promise.resolve());
        return chatBundlePromise;
    }

    /* 笔记栈（约 80KB）同样首发不加载：第一次进「笔记」页才注入。
     * 顺序有依赖：schema-notes → notes-index → notes-db → notes-store → notes-view */
    var NOTES_SCRIPTS = [
        'js/schema-notes.js',
        'js/notes-index.js',
        'js/notes-db.js',
        'js/notes-store.js',
        'js/zip.js',
        'js/notes-view.js'
    ];
    var notesBundlePromise = null;
    var notesInited = false;

    function loadNotesBundle() {
        if (notesBundlePromise) return notesBundlePromise;
        var util = NC.util;
        if (!util || typeof util.loadScript !== 'function') {
            return Promise.reject(new Error('loader unavailable'));
        }
        notesBundlePromise = NOTES_SCRIPTS.reduce(function (chain, src) {
            return chain.then(function () { return util.loadScript(src); });
        }, Promise.resolve());
        return notesBundlePromise;
    }

    function initNotes() {
        if (notesInited) return;
        notesInited = true;
        loadNotesBundle().then(function () {
            var view = NC.view && NC.view.notes;
            if (view && typeof view.init === 'function') view.init();
        }).catch(function (err) {
            notesInited = false;
            var note = document.getElementById('notes-module-note');
            if (note) {
                note.hidden = false;
                note.textContent = '笔记模块加载失败（js/notes-*.js），请检查文件是否齐全后刷新：' +
                    (err && err.message ? err.message : err);
            }
        });
    }

    NC.initNotes = initNotes;

    /* 创意工坊栈（约 90KB）同样按需加载 */
    var WORKSHOP_SCRIPTS = [
        'js/sse.js',
        'js/api.js',
        'js/schema-workshop.js',
        'js/workshop-builtin.js',
        'js/workshop-db.js',
        'js/workshop-store.js',
        'js/preview-host.js',
        'js/workshop-view.js'
    ];
    var workshopBundlePromise = null;
    var workshopInited = false;

    function loadWorkshopBundle() {
        if (workshopBundlePromise) return workshopBundlePromise;
        var util = NC.util;
        if (!util || typeof util.loadScript !== 'function') return Promise.reject(new Error('loader unavailable'));
        workshopBundlePromise = WORKSHOP_SCRIPTS.reduce(function (chain, src) {
            return chain.then(function () { return util.loadScript(src); });
        }, Promise.resolve());
        return workshopBundlePromise;
    }

    function initWorkshop() {
        if (workshopInited) return;
        workshopInited = true;
        loadWorkshopBundle().then(function () {
            var v = NC.view && NC.view.workshop;
            if (v && typeof v.init === 'function') v.init();
        }).catch(function (err) {
            workshopInited = false;
            var note = document.getElementById('ws-module-note');
            if (note) {
                note.hidden = false;
                note.textContent = '创意工坊模块加载失败（js/workshop-*.js）：' +
                    (err && err.message ? err.message : err);
            }
        });
    }

    NC.initWorkshop = initWorkshop;
    NC.loadWorkshopBundle = loadWorkshopBundle;
    NC.loadNotesBundle = loadNotesBundle;

    /* 供设置面板使用：导出/导入全量备份前，确保聊天栈已就绪 */
    NC.loadChatBundle = loadChatBundle;

    function setChatBoot(text) {
        var page = document.getElementById('page-nchat');
        if (!page) return;
        var el = document.getElementById('chat-boot');
        if (text == null) {
            if (el) el.hidden = true;
            return;
        }
        if (!el) {
            el = document.createElement('div');
            el.id = 'chat-boot';
            el.className = 'chat-boot';
            el.setAttribute('role', 'status');
            page.appendChild(el);
        }
        el.textContent = text;
        el.hidden = false;
    }

    function initChat() {
        if (chatInited) return;
        if (chatBundlePromise && !isChatReady()) return;   // 正在加载，避免重复进入

        function isChatReady() {
            return !!(NC.chatEmbed && typeof NC.chatEmbed.init === 'function');
        }

        function boot() {
            try {
                var ok = NC.chatEmbed.init();
                if (ok !== false) {
                    chatInited = true;
                } else {
                    showBanner('聊天模块尚未就绪，稍后重新切换到 nChat 标签重试。', { persistent: false });
                }
            } catch (err) {
                showBanner('聊天初始化失败，其它工具仍可使用。', { persistent: true });
            }
        }

        if (isChatReady()) {
            setChatBoot(null);
            boot();
            return;
        }
        setChatBoot('正在加载聊天模块…');
        loadChatBundle().then(function () {
            setChatBoot(null);
            if (isChatReady()) {
                boot();
            } else {
                showBanner('聊天模块未加载（js/chat-embed.js），其它工具仍可使用。', { persistent: true });
            }
        }).catch(function () {
            chatBundlePromise = null;   // 允许下次切回 nChat 时重试
            setChatBoot(null);
            showBanner('聊天模块加载失败，其它工具仍可使用。可刷新页面重试。', { persistent: true });
        });
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
                        ui.toast(next ? '已开启 Lite 模式：关闭模糊与重动效' : '已关闭 Lite 模式', {
                            type: 'info',
                            duration: 2200
                        });
                    }
                },
                { type: 'divider' },
                {
                    label: '设置',
                    icon: 'settings',
                    hint: '模型 · AI',
                    onSelect: function () {
                        if (NC.openSettings) NC.openSettings('profiles');
                        else ui.toast('设置面板未加载', { type: 'warn' });
                    }
                },
                {
                    label: '快捷键与帮助',
                    icon: 'command',
                    hint: '?',
                    onSelect: function () {
                        if (NC.tools.todo && NC.tools.todo.openHelp) NC.tools.todo.openHelp();
                        else showFallbackHelp();
                    }
                },
                { type: 'divider' },
                {
                    label: '兼容性自检',
                    icon: 'shield',
                    hint: '部署前',
                    onSelect: function () { openSelfCheck('compat'); }
                },
                {
                    label: '回归测试',
                    icon: 'check-circle',
                    hint: '自检',
                    onSelect: function () { openSelfCheck('tests'); }
                },
                {
                    label: '关于 nTools',
                    icon: 'info',
                    onSelect: openAbout
                }
            ]);
        });
    }

    /* ------------------------------------------------------------------ *
     * 工具自检入口：兼容性自检 / 回归测试（已收纳到 checks/）
     * ------------------------------------------------------------------ */
    var SELF_CHECK_PAGES = {
        compat: 'checks/compat-check.html',
        tests: 'checks/tests.html'
    };

    function openSelfCheck(page) {
        var url = SELF_CHECK_PAGES[page] || SELF_CHECK_PAGES.compat;
        try {
            var win = global.open(url, '_blank');
            if (!win) global.location.href = url;
        } catch (err) {
            global.location.href = url;
        }
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
            ['版本', 'nTools ' + (NC.version || '4.5.0')],
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
        note.textContent = '除你主动发送给所选模型端点的内容（消息正文与附件）外，所有数据仅保存在本机浏览器。建议定期在「设置 → 数据」导出备份。';
        wrap.appendChild(note);
        ui.openModal({
            title: '关于 nTools',
            content: wrap,
            size: 'sm',
            actions: [
                { label: '兼容性自检', kind: 'outline', onClick: function () { openSelfCheck('compat'); } },
                { label: '回归测试', kind: 'outline', onClick: function () { openSelfCheck('tests'); } },
                { label: '知道了', kind: 'primary' }
            ]
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
        NC.events.on(NC.eventNames.quotaWarning, function () {
            showBanner('本地存储空间接近上限（3.5 MB），建议导出备份并清理旧任务。', {
                actionLabel: '导出待办备份',
                onAction: exportTodoBackup
            });
        });
        NC.events.on(NC.eventNames.storageError, function () {
            showBanner('本地存储读写异常，修改可能无法保存，请及时导出备份。', {
                actionLabel: '导出待办备份',
                onAction: exportTodoBackup
            });
        });
        NC.events.on(NC.eventNames.storageCorrupt, function () {
            showBanner('检测到损坏的本地数据，已备份原始内容并尝试恢复。', {});
        });
    }

    function exportTodoBackup() {
        if (NC.tools.todo && NC.tools.todo.exportToFile) NC.tools.todo.exportToFile();
        else ui.toast('待办模块未就绪，暂时无法导出', { type: 'warn' });
    }

    /* ------------------------------------------------------------------ *
     * 邮件 iframe：握手 + 未加载引导 + 存储告警
     * iframe 失败时不触发 error 事件（file:// 下尤其如此），所以用
     * 页面主动 postMessage 握手 + 超时兜底来判断，而不是猜 contentDocument。
     * ------------------------------------------------------------------ */
    var emailFrameState = { ready: false, timer: null, loadedOnce: false, ensureLoaded: null };

    function bindEmailFrame() {
        var frame = document.getElementById('email-frame');
        var missing = document.getElementById('email-missing');
        if (!frame || !missing) return;
        var EMAIL_SRC = frame.getAttribute('data-src') || 'js/mail/email-manager.html';

        function showMissing(show) {
            missing.hidden = !show;
            frame.style.visibility = show ? 'hidden' : '';
        }

        function armTimeout() {
            if (emailFrameState.timer) global.clearTimeout(emailFrameState.timer);
            emailFrameState.timer = global.setTimeout(function () {
                if (!emailFrameState.ready) showMissing(true);
            }, 5000);
        }

        function ensureLoaded() {
            if (emailFrameState.loadedOnce) return;
            emailFrameState.loadedOnce = true;
            emailFrameState.ready = false;
            showMissing(false);
            frame.src = EMAIL_SRC;
            armTimeout();
        }
        emailFrameState.ensureLoaded = ensureLoaded;

        function reload() {
            if (!emailFrameState.loadedOnce) {
                if (currentTab !== 'email') return;
                ensureLoaded();
                return;
            }
            emailFrameState.ready = false;
            showMissing(false);
            frame.src = EMAIL_SRC + '?r=' + Date.now();
            armTimeout();
        }

        /* 主题与 Lite 由主应用统一控制：邮件页不再自己选主题 */
        function postTheme() {
            try {
                if (!emailFrameState.loadedOnce || !frame.contentWindow) return;
                frame.contentWindow.postMessage({
                    type: 'ntools-theme',
                    theme: NC.theme.isLight() ? 'light' : 'dark',
                    lite: NC.theme.isLite()
                }, '*');
            } catch (err) { /* ignore */ }
        }

        frame.addEventListener('load', postTheme);
        NC.events.on(NC.eventNames.themeChanged, postTheme);
        NC.events.on(NC.eventNames.liteChanged, postTheme);

        global.addEventListener('message', function (event) {
            var data = event.data;
            if (!data || typeof data !== 'object') return;
            if (event.source !== frame.contentWindow) return;

            if (data.type === 'ntools-email-theme-request') {
                postTheme();
                return;
            }
            if (data.type === 'ntools-email-ready') {
                postTheme();
                emailFrameState.ready = true;
                if (emailFrameState.timer) global.clearTimeout(emailFrameState.timer);
                showMissing(false);
                if (data.storage === false) {
                    showBanner('邮件管理无法访问本地存储：修改不会被保存。', { persistent: true });
                }
                return;
            }
            if (data.type === 'ntools-email-save' && data.ok === false) {
                showBanner(
                    data.conflict
                        ? '邮件数据已被其他窗口更新，本窗口的修改未保存；请点「重试加载」刷新邮件页后再改。'
                        : (data.quota
                            ? '邮件数据保存失败：本地存储空间不足，请先在邮件页导出备份。'
                            : '邮件数据保存失败，最后一次修改可能未落盘。'),
                    { persistent: true }
                );
            }
        });

        var retry = document.getElementById('email-retry-btn');
        if (retry) retry.addEventListener('click', reload);
        var dismiss = document.getElementById('email-dismiss-btn');
        if (dismiss) dismiss.addEventListener('click', function () { showMissing(false); });

        NC.events.on(NC.eventNames.emailImported, reload);
    }

    /* ------------------------------------------------------------------ *
     * 数据韧性条：保存失败 / 只读镜像 / 加载闸门
     * 与顶栏 banner 不同，这里不自动消失——它描述的是一个持续存在的状态。
     * ------------------------------------------------------------------ */
    var durabilityView = {
        bar: null,
        text: null,
        actions: null,
        readonly: null,
        save: null,
        rendered: false
    };

    function bindDurabilityBar() {
        durabilityView.bar = document.getElementById('durability-bar');
        durabilityView.text = document.getElementById('durability-text');
        durabilityView.actions = document.getElementById('durability-actions');
        if (!durabilityView.bar || !durabilityView.text || !durabilityView.actions) return;

        NC.events.on(NC.eventNames.todoReadonly, function (payload) {
            durabilityView.readonly = payload && payload.reason ? payload : null;
            renderDurability();
        });
        NC.events.on(NC.eventNames.todoSavesate, function (payload) {
            durabilityView.save = payload || null;
            renderDurability();
        });
        NC.events.on(NC.eventNames.storageError, function () { renderDurability(); });
        NC.events.on(NC.eventNames.quotaWarning, function () { renderDurability(); });
        NC.events.on(NC.eventNames.todoLimit, function (payload) {
            ui.toast((payload && payload.message) || '已达数据上限', { type: 'warn', duration: 4200 });
        });
        NC.events.on(NC.eventNames.conversationTruncatedOnLoad, function (payload) {
            var p = payload || {};
            ui.toast(
                '聊天记录超出上限（会话 ' + p.sessions + ' / 单会话消息上限 ' + p.maxMessages +
                '），未截断的原始数据已存入快照，可在设置 → 数据 中恢复',
                { type: 'warn', duration: 6000 }
            );
        });
        NC.events.on(NC.eventNames.todoTrashPurged, function (payload) {
            ui.toast((payload && payload.message) || '已清理回收站旧任务', { type: 'info', duration: 4200 });
        });
        renderDurability();
    }

    function durabilityButton(label, kind, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nc-btn nc-btn--sm' + (kind === 'primary' ? ' nc-btn--primary' : ' nc-btn--ghost');
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function todoStore() {
        return NC.store && NC.store.todo ? NC.store.todo : null;
    }

    function saveOriginalTodo() {
        var store = todoStore();
        var raw = store && store.originalRaw ? store.originalRaw() : null;
        if (!raw) {
            ui.toast('没有可导出的原始数据', { type: 'warn' });
            return;
        }
        util.downloadBlob(
            'ntools-todo-original-' + new Date().toISOString().slice(0, 10) + '.json',
            raw,
            'application/json'
        );
        ui.toast('已导出加载时的原始数据', { type: 'success' });
    }

    function renderDurability() {
        var view = durabilityView;
        if (!view.bar) return;
        var store = todoStore();
        var save = view.save || (store && store.saveState ? store.saveState() : null);
        var ro = view.readonly;

        view.actions.textContent = '';
        view.bar.classList.remove('is-warning');

        if (ro && ro.reason) {
            var message = ro.message || '待办数据已进入只读模式';
            view.bar.classList.toggle('is-warning', ro.reason === 'other-window');
            view.text.textContent = message;

            if (ro.reason === 'other-window') {
                view.actions.appendChild(durabilityButton('接管编辑', 'primary', function () {
                    if (store && store.takeover && store.takeover()) {
                        ui.toast('已接管编辑', { type: 'success' });
                    } else {
                        ui.toast('接管失败：另一个窗口仍在编辑', { type: 'warn' });
                    }
                }));
            } else if (ro.reason === 'load-trimmed' || ro.reason === 'future-version') {
                view.actions.appendChild(durabilityButton('另存原始数据', 'ghost', saveOriginalTodo));
                if (ro.reason === 'load-trimmed') {
                    view.actions.appendChild(durabilityButton('接受修剪', 'primary', function () {
                        confirmTrim(store);
                    }));
                }
            } else if (ro.reason === 'external-conflict') {
                view.actions.appendChild(durabilityButton('另存本地修改', 'ghost', exportTodoBackup));
                view.actions.appendChild(durabilityButton('以对方为准', 'primary', function () {
                    if (store && store.init) {
                        store.init();
                        ui.toast('已重新加载存储中的数据', { type: 'success' });
                    }
                }));
            } else if (ro.reason === 'save-failed') {
                view.actions.appendChild(durabilityButton('导出备份', 'primary', exportTodoBackup));
            }
            showDurability(true);
            return;
        }

        if (save && (save.saveError || save.retrying || (save.ok === false))) {
            view.bar.classList.add('is-warning');
            var retry = save.retrying && save.retryDelay ? '（' + Math.round(save.retryDelay / 1000) + ' 秒后重试）' : '';
            view.text.textContent = '待办数据保存失败' + retry + '：修改暂存在内存中，请尽快导出备份。';
            view.actions.appendChild(durabilityButton('导出备份', 'primary', exportTodoBackup));
            view.actions.appendChild(durabilityButton('立即重试', 'ghost', function () {
                if (store && store.saveNow) {
                    var ok = store.saveNow();
                    ui.toast(ok ? '已保存' : '仍然失败，请导出备份', { type: ok ? 'success' : 'error' });
                }
            }));
            showDurability(true);
            return;
        }

        showDurability(false);
    }

    function confirmTrim(store) {
        ui.confirm(
            '加载时有部分数据因超出上限或缺少标题被丢弃。接受后将以修剪后的数据覆盖存储，原始数据可从「另存原始数据」恢复。建议先导出一份。',
            { title: '接受修剪并继续编辑', confirmText: '接受修剪', danger: true }
        ).then(function (ok) {
            if (!ok) return;
            var done = store && store.acceptTrimmed ? store.acceptTrimmed() : false;
            ui.toast(done ? '已接受修剪并保存' : '保存失败，请导出备份', { type: done ? 'success' : 'error' });
        });
    }

    function showDurability(visible) {
        var bar = durabilityView.bar;
        if (!bar) return;
        if (!visible) {
            if (!bar.hidden) {
                bar.hidden = true;
                document.documentElement.removeAttribute('data-durability');
            }
            return;
        }
        if (bar.hidden) bar.hidden = false;
        document.documentElement.setAttribute('data-durability', 'on');
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
        NC.events.on(NC.eventNames.appError, function (payload) {
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
