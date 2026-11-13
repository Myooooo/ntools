/**
 * chat-embed.js — v3 原生聊天组合根（nTools #page-nchat）
 * 经典脚本，依赖 core.js / ui.js / llm-store.js / settings-panel.js /
 *   settings-store.js（适配层）/ conversation-store.js / message-view.js /
 *   composer.js / settings-view.js（系统提示词 sheet）/ chat-controller.js。
 * 挂载：NC.chatEmbed
 *
 * 约定：NC.chatEmbed.init() 幂等、懒加载；由 ntools-app 首次切到 #nchat 时调用。
 * 如果依赖尚未就绪返回 false（调用方下次重试），绝不 throw。
 *
 * 职责：
 *  - 端点下拉（NC.store.llm profiles）与端点切换（独立会话 + 独立系统提示词）；
 *  - 初始化 messages / composer / controller，并注入 openSettings（全局设置面板）；
 *  - 系统提示词快捷面板（NC.view.chatPrompt）与聊天菜单；
 *  - 无端点 / 缺 Key 时的可操作引导。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var events = NC.events;
    var ui = NC.ui;

    var WELCOME = '你好，有什么可以帮你？';

    var initialized = false;
    var store = null;
    var adapter = null;
    var conversation = null;
    var messages = null;
    var composer = null;
    var controller = null;
    var promptSheet = null;
    var currentProfileId = null;

    var el = {};
    var menuOpen = false;
    var menuHideTimer = null;
    var guide = null;
    var switchToastFromChat = false;
    var switchingTimer = null;

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function init() {
        if (initialized) return true;
        var app = document.getElementById('chat-app');
        var container = document.getElementById('chat-container');
        if (!app || !container) return false;
        if (!NC.store || !NC.store.llm || typeof NC.store.llm.init !== 'function') return false;
        if (!NC.store.settings || typeof NC.store.settings.init !== 'function') return false;
        if (!NC.store.conversation || !NC.view || !NC.view.messages || !NC.view.composer || !NC.chat || !NC.chat.controller) {
            return false;
        }

        store = NC.store.llm;
        adapter = NC.store.settings;
        conversation = NC.store.conversation;
        messages = NC.view.messages;
        composer = NC.view.composer;
        controller = NC.chat.controller;
        promptSheet = NC.view.chatPrompt || null;

        cacheDom();
        try {
            store.init();
            adapter.init();
            if (promptSheet && typeof promptSheet.init === 'function') promptSheet.init();
            currentProfileId = store.getState().currentProfileId || null;
            conversation.init(currentProfileId || 'chat-default');
        } catch (err) {
            console.error('[NC] chatEmbed 初始化失败：', err);
            return false;
        }

        initMessages();
        initComposer();
        initController();
        buildGuide();
        bindToolbar();
        bindLlmEvents();
        renderProfiles();
        updateGuide();
        controller.renderConversation(WELCOME);
        updateMeta();
        // 首次从旧 nChat 配置自动合并端点后，给用户一次可见确认（仅当次加载）
        var loadInfo = store.getLoadInfo ? store.getLoadInfo() : null;
        if (loadInfo && loadInfo.migratedFrom === 'nchat-settings-merge' && loadInfo.legacyProfiles > 0) {
            ui.toast('已从旧 nChat 配置合并 ' + loadInfo.legacyProfiles + ' 个端点', {
                type: 'success',
                duration: 4200
            });
        }
        initialized = true;
        return true;
    }

    function cacheDom() {
        el.app = document.getElementById('chat-app');
        el.toolbar = el.app.querySelector('.chat-toolbar');
        el.profileSelect = document.getElementById('chat-profile-select');
        el.profileMeta = document.getElementById('chat-profile-meta');
        el.profileDot = document.getElementById('chat-profile-dot');
        el.systemPromptBtn = document.getElementById('chat-system-prompt-btn');
        el.menuBtn = document.getElementById('chat-menu-btn');
        el.menu = document.getElementById('chat-menu');
        el.jump = document.getElementById('jump-bottom-btn');
        if (!document.getElementById('chat-embed-live')) {
            el.live = util.e('div', {
                id: 'chat-embed-live',
                class: 'nc-sr-only',
                role: 'status',
                'aria-live': 'polite',
                'aria-atomic': 'true'
            });
            el.app.appendChild(el.live);
        } else {
            el.live = document.getElementById('chat-embed-live');
        }
    }

    function initMessages() {
        messages.init(document.getElementById('chat-container'), {
            onCopy: function (text) { return util.copyText(text); },
            onRegenerate: controller.regenerate,
            onEdit: controller.editMessage,
            onDelete: controller.deleteMessage,
            onFollowChange: function (nearBottom) { controller.setJumpVisible(nearBottom); },
            onSuggestion: function (prompt) { composer.setValue(prompt); },
            onError: function (message) { ui.toast(message, { type: 'error' }); }
        });
    }

    function initComposer() {
        composer.init({
            onSend: controller.send,
            onStop: controller.stop,
            onError: function (message) { ui.toast(message, { type: 'error' }); },
            onPreviewImage: function (src) { messages.openLightbox(src, '待发送图片'); }
        });
    }

    function initController() {
        controller.init({
            settings: adapter,
            conversation: conversation,
            messages: messages,
            composer: composer,
            openSettings: openSettings
        });
    }

    /* ------------------------------------------------------------------ *
     * 端点下拉 / 元信息 / 引导
     * ------------------------------------------------------------------ */
    function renderProfiles() {
        if (!el.profileSelect) return;
        var state = store.getState();
        var profiles = state.profiles || [];
        el.profileSelect.textContent = '';
        profiles.forEach(function (profile) {
            el.profileSelect.appendChild(util.e('option', {
                value: profile.id,
                text: profile.name || '未命名端点'
            }));
        });
        if (state.currentProfileId) el.profileSelect.value = state.currentProfileId;
        el.profileSelect.disabled = profiles.length === 0;
        updateMeta();
    }

    function currentProfile() {
        if (!store) return null;
        return store.getProfile(currentProfileId) || store.getCurrentProfile();
    }

    function hostOf(url) {
        if (!url) return '';
        var text = String(url).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
        return text.split('/')[0].split('?')[0];
    }

    function updateMeta() {
        var profile = currentProfile();
        if (el.profileMeta) {
            el.profileMeta.textContent = '';
            if (!profile) {
                el.profileMeta.textContent = '未配置端点';
                el.profileMeta.removeAttribute('title');
            } else {
                // v4：元信息拆成两列（模型 / 主机），不再使用“A · B”中点串
                var model = profile.modelId || '未设置 Model';
                var host = hostOf(profile.baseUrl);
                el.profileMeta.appendChild(util.e('span', { class: 'chat-meta__model', text: model }));
                if (host) {
                    el.profileMeta.appendChild(util.e('span', { class: 'chat-meta__host', text: host }));
                }
                el.profileMeta.setAttribute('title', host ? model + '  ' + host : model);
            }
        }
        if (el.profileDot) {
            el.profileDot.classList.remove('is-ready', 'is-warn', 'is-off');
            if (!profile) {
                el.profileDot.classList.add('is-off');
                el.profileDot.title = '未配置端点';
            } else if (profile.apiKey && profile.baseUrl && profile.modelId) {
                el.profileDot.classList.add('is-ready');
                el.profileDot.title = '端点已就绪';
            } else {
                el.profileDot.classList.add('is-warn');
                el.profileDot.title = '端点缺少 API Key 或 Base URL';
            }
        }
        if (el.profileSelect) {
            el.profileSelect.title = profile
                ? '当前端点：' + (profile.name || '未命名') + '（点击切换）'
                : '还没有可用端点';
        }
    }

    function announce(text) {
        if (!el.live) return;
        el.live.textContent = '';
        (global.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
            if (el.live) el.live.textContent = text;
        });
    }

    function flashSwitching() {
        if (!el.toolbar) return;
        if (switchingTimer) clearTimeout(switchingTimer);
        el.toolbar.classList.add('is-switching');
        switchingTimer = setTimeout(function () {
            switchingTimer = null;
            if (el.toolbar) el.toolbar.classList.remove('is-switching');
        }, 240);
    }

    function buildGuide() {
        if (!el.app || !el.toolbar) return;
        guide = util.e('div', { class: 'chat-embed-guide', hidden: true });
        var text = util.e('span', { class: 'chat-embed-guide__text' });
        var button = util.e('button', {
            type: 'button',
            class: 'nc-btn nc-btn--primary nc-btn--sm',
            text: '打开设置'
        });
        button.addEventListener('click', function () { openSettings('profiles'); });
        guide.appendChild(text);
        guide.appendChild(button);
        el.toolbar.parentNode.insertBefore(guide, el.toolbar.nextSibling);
        guide.__text = text;
    }

    function updateGuide() {
        if (!guide) return;
        var profile = currentProfile();
        if (!profile) {
            guide.__text.textContent = '还没有可用的模型端点：请先在「设置 → 模型端点」中添加端点。';
            guide.hidden = false;
            return;
        }
        if (!profile.baseUrl || !profile.modelId) {
            guide.__text.textContent = '端点「' + (profile.name || '未命名') + '」缺少 Base URL 或 Model ID，请先在设置中补全。';
            guide.hidden = false;
            return;
        }
        if (!profile.apiKey) {
            guide.__text.textContent = '端点「' + (profile.name || '未命名') + '」尚未填写 API Key，发送消息前请先在设置中配置。';
            guide.hidden = false;
            return;
        }
        guide.hidden = true;
    }

    /* ------------------------------------------------------------------ *
     * 工具栏 / 菜单
     * ------------------------------------------------------------------ */
    function bindToolbar() {
        if (el.profileSelect) {
            el.profileSelect.addEventListener('change', function () {
                var id = el.profileSelect.value;
                switchToastFromChat = true;
                var ok = store.selectProfile(id);
                switchToastFromChat = false;
                if (!ok) renderProfiles();
            });
        }
        if (el.systemPromptBtn) {
            el.systemPromptBtn.addEventListener('click', function () {
                if (!promptSheet) {
                    ui.toast('系统提示词面板未加载', 'warn');
                    return;
                }
                promptSheet.open(currentProfileId);
            });
        }
        if (el.menuBtn && el.menu) {
            el.menuBtn.addEventListener('click', function (event) {
                event.stopPropagation();
                if (menuOpen) closeMenu();
                else openMenu();
            });
            document.addEventListener('click', function (event) {
                if (!menuOpen) return;
                var target = event.target;
                if (!target || !target.closest) return;
                if (target.closest('#chat-menu') || target.closest('#chat-menu-btn')) return;
                closeMenu();
            });
            document.addEventListener('keydown', function (event) {
                if (event.key !== 'Escape' || !menuOpen) return;
                closeMenu();
                try { el.menuBtn.focus(); } catch (err) { /* ignore */ }
            });
            el.menu.addEventListener('click', function (event) {
                var item = event.target && event.target.closest ? event.target.closest('.chat-menu__item') : null;
                if (item) closeMenu();
            });
        }
    }

    /**
     * 聊天菜单：#chat-menu 是唯一静态节点，打开期间禁止重复打开；
     * 关闭时先收起（140ms transition）再 hidden，避免退出被裁切；
     * 快速重复点击会取消退出定时器，不会出现“叠一层菜单”或卡在中间态。
     */
    function openMenu() {
        if (!el.menu || menuOpen) return;
        if (menuHideTimer) {
            clearTimeout(menuHideTimer);
            menuHideTimer = null;
        }
        el.menu.hidden = false;
        menuOpen = true;
        // 从 hidden 切换后强制一次 reflow，让 140ms 过渡从初始态开始
        void el.menu.offsetWidth;
        el.menu.classList.add('is-open');
        if (el.menuBtn) el.menuBtn.setAttribute('aria-expanded', 'true');
        var first = el.menu.querySelector('.chat-menu__item');
        if (first) {
            try { first.focus(); } catch (err) { /* ignore */ }
        }
    }

    function closeMenu() {
        if (!el.menu) return;
        if (el.menuBtn) el.menuBtn.setAttribute('aria-expanded', 'false');
        if (!menuOpen) {
            if (menuHideTimer) {
                clearTimeout(menuHideTimer);
                menuHideTimer = null;
                el.menu.hidden = true;
            }
            return;
        }
        menuOpen = false;
        el.menu.classList.remove('is-open');
        if (NC.util.prefersReducedMotion && NC.util.prefersReducedMotion()) {
            el.menu.hidden = true;
            return;
        }
        if (document.documentElement.getAttribute('data-lite') === 'true') {
            el.menu.hidden = true;
            return;
        }
        if (menuHideTimer) clearTimeout(menuHideTimer);
        menuHideTimer = setTimeout(function () {
            menuHideTimer = null;
            if (!menuOpen) el.menu.hidden = true;
        }, 160);
    }

    /* ------------------------------------------------------------------ *
     * 端点切换 / llm 事件
     * ------------------------------------------------------------------ */
    var pendingSwitch = null;
    var pendingSwitchTimer = null;

    function applyProfileSwitch(profileId, wantToast) {
        if (!profileId) return;
        currentProfileId = profileId;
        flashSwitching();
        clearStagedImages();
        conversation.switchConfig(currentProfileId);
        controller.renderConversation(WELCOME);
        renderProfiles();
        updateGuide();
        var profile = store.getProfile(currentProfileId);
        if (profile) {
            announce('已切换到端点：' + profile.name);
            // 聊天页自己切换时给 toast；设置面板切换已有自己的 toast，避免双提示
            if (wantToast) {
                ui.toast('已切换端点：' + profile.name, { type: 'info', duration: 1600 });
            }
        }
        if (composer && typeof composer.focus === 'function') composer.focus();
    }

    function waitForIdleThenSwitch() {
        if (pendingSwitchTimer) clearTimeout(pendingSwitchTimer);
        var deadline = Date.now() + 3000;
        (function tick() {
            if (!pendingSwitch) return;
            var streaming = controller && typeof controller.isStreaming === 'function' && controller.isStreaming();
            if (!streaming) {
                var target = pendingSwitch;
                pendingSwitch = null;
                pendingSwitchTimer = null;
                if (target.id && target.id !== currentProfileId) {
                    applyProfileSwitch(target.id, target.toast);
                } else {
                    renderProfiles();
                    updateGuide();
                }
                return;
            }
            if (Date.now() > deadline) {
                pendingSwitch = null;
                pendingSwitchTimer = null;
                renderProfiles();
                updateGuide();
                return;
            }
            pendingSwitchTimer = setTimeout(tick, 100);
        })();
    }

    function bindLlmEvents() {
        events.on('config:switched', function (payload) {
            if (!payload || !payload.configId) return;
            if (payload.configId === currentProfileId) {
                renderProfiles();
                updateGuide();
                return;
            }
            var wantToast = switchToastFromChat;
            // 流式生成中切换端点：先停止旧流，等 finalize 写入旧会话后再切，
            // 避免助手回复被写进新端点的会话。
            if (controller && typeof controller.isStreaming === 'function' && controller.isStreaming()) {
                pendingSwitch = { id: payload.configId, toast: wantToast };
                if (typeof controller.stop === 'function') controller.stop();
                if (wantToast) ui.toast('正在停止当前生成并切换端点…', { type: 'info', duration: 1600 });
                waitForIdleThenSwitch();
                return;
            }
            applyProfileSwitch(payload.configId, wantToast);
        });
        events.on('llm:changed', function () {
            renderProfiles();
            updateGuide();
        });
    }

    function clearStagedImages() {
        if (!composer || typeof composer.removeImage !== 'function') return;
        var images = composer.stagedImages || [];
        images.forEach(function (image) {
            if (image && image.id != null) composer.removeImage(image.id);
        });
    }

    function openSettings(sectionId) {
        if (NC.settingsPanel && typeof NC.settingsPanel.open === 'function') {
            try {
                NC.settingsPanel.open(sectionId || 'profiles');
                return;
            } catch (err) { /* fallback */ }
        }
        ui.toast('全局设置面板尚未就绪，请刷新页面重试', 'warn');
    }

    /* ------------------------------------------------------------------ *
     * 对外接口
     * ------------------------------------------------------------------ */
    NC.chatEmbed = {
        init: init,
        isReady: function () { return initialized; },
        getCurrentProfileId: function () { return currentProfileId; },
        openSettings: openSettings,
        refreshProfiles: function () {
            renderProfiles();
            updateGuide();
        }
    };
})(window);
