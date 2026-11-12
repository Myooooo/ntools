/**
 * app.js — 聊天页组合根：初始化 stores/views/controller，wire 菜单/主题/存储提示，首屏渲染。
 * 业务编排见 js/chat-controller.js（NC.chat.controller）。
 */
(function (global) {
    'use strict';

    var NC = global.NC;
    var events = NC.events;
    var ui = NC.ui;

    var settings;
    var conversation;
    var messages;
    var composer;
    var settingsView;
    var controller;

    var WELCOME = '你好，有什么可以帮你？';

    NC.util.ready(init);

    function init() {
        NC.compat.bootstrap();
        ui.installGlobalErrorHandlers();
        NC.theme.init();

        settings = NC.store.settings;
        conversation = NC.store.conversation;
        controller = NC.chat.controller;
        settings.init();
        conversation.init(settings.getState().currentId);

        messages = NC.view.messages;
        composer = NC.view.composer;
        settingsView = NC.view.settings;

        controller.init({ settings, conversation, messages, composer, settingsView });
        messages.init(document.getElementById('chat-container'), {
            onCopy: function (text) { return NC.util.copyText(text); },
            onRegenerate: controller.regenerate,
            onEdit: controller.editMessage,
            onDelete: controller.deleteMessage,
            onFollowChange: function (nearBottom) { controller.setJumpVisible(nearBottom); },
            onSuggestion: function (prompt) { composer.setValue(prompt); },
            onError: function (message) { ui.toast(message, { type: 'error' }); }
        });
        composer.init({
            onSend: controller.send,
            onStop: controller.stop,
            onError: function (message) { ui.toast(message, { type: 'error' }); },
            onPreviewImage: function (src) { messages.openLightbox(src, '待发送图片'); }
        });
        settingsView.init();

        wireMenus();
        wireTheme();
        wireStorage();

        events.on('config:switched', onConfigSwitched);
        events.on('settings:changed', updateTitle);

        controller.renderConversation(WELCOME);
        updateTitle();
        updateThemeLabels();
        controller.setJumpVisible(true);
        composer.focus();
    }

    function onConfigSwitched() {
        if (!settings || !conversation) return;
        conversation.switchConfig(settings.getState().currentId);
        controller.renderConversation(WELCOME);
        updateTitle();
        composer.focus();
    }

    function updateTitle() {
        var config = settings ? settings.getConfig() : null;
        var name = config && config.name ? config.name : '未命名配置';
        var title = 'nChat | ' + name;
        var titleEl = document.getElementById('app-title');
        if (titleEl) titleEl.textContent = title;
        document.title = title;
    }

    /* ------------------------------------------------------------------ *
     * 菜单 / 主题
     * ------------------------------------------------------------------ */
    function wireMenus() {
        var menuBtn = document.getElementById('menu-btn');
        var menu = document.getElementById('main-menu');
        if (!menuBtn || !menu) return;

        function close() {
            menu.classList.remove('is-open');
            menu.setAttribute('aria-hidden', 'true');
            menuBtn.setAttribute('aria-expanded', 'false');
        }
        function open() {
            menu.classList.add('is-open');
            menu.setAttribute('aria-hidden', 'false');
            menuBtn.setAttribute('aria-expanded', 'true');
            var first = menu.querySelector('.chat-menu__item');
            if (first) first.focus();
        }
        menuBtn.addEventListener('click', function (event) {
            event.stopPropagation();
            if (menu.classList.contains('is-open')) close();
            else open();
        });
        document.addEventListener('click', function (event) {
            if (!menu.classList.contains('is-open')) return;
            var target = event.target;
            if (!target || !target.closest) return;
            if (target.closest('#main-menu') || target.closest('#menu-btn')) return;
            close();
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && menu.classList.contains('is-open')) {
                close();
                menuBtn.focus();
            }
        });
        menu.addEventListener('click', function (event) {
            var item = event.target && event.target.closest ? event.target.closest('.chat-menu__item') : null;
            if (item) close();
        });
    }

    function setMenuLabel(id, label) {
        var button = document.getElementById(id);
        var span = button ? button.querySelector('.chat-menu__label') : null;
        if (span) span.textContent = label;
    }

    function updateThemeLabels() {
        setMenuLabel('theme-toggle-btn', NC.theme.isLight() ? '深色模式' : '浅色模式');
        setMenuLabel('lite-mode-btn', NC.theme.isLite() ? '完整模式' : 'Lite 模式');
    }

    function wireTheme() {
        var themeBtn = document.getElementById('theme-toggle-btn');
        var liteBtn = document.getElementById('lite-mode-btn');
        if (themeBtn) {
            themeBtn.addEventListener('click', function () {
                NC.theme.toggle();
                updateThemeLabels();
            });
        }
        if (liteBtn) {
            liteBtn.addEventListener('click', function () {
                NC.theme.toggleLite();
                updateThemeLabels();
            });
        }
        events.on('theme:changed', updateThemeLabels);
        events.on('lite:changed', updateThemeLabels);
    }

    /* ------------------------------------------------------------------ *
     * 存储 / 配额提示
     * ------------------------------------------------------------------ */
    function wireStorage() {
        var banner = document.getElementById('storage-banner');
        var timer = null;
        function show(message, tone) {
            if (!banner) return;
            banner.textContent = message;
            banner.hidden = false;
            banner.classList.toggle('is-warn', tone !== 'info');
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () { banner.hidden = true; }, 9000);
        }
        events.on('quota:warning', NC.util.throttle(function () {
            show('本地存储空间不足，正在尝试清理旧图片以继续保存…', 'warn');
        }, 5000));
        events.on('conversation:degraded', function (payload) {
            show('本地空间不足：已将 ' + payload.removed + ' 张旧图片替换为占位文本，以节省存储空间。', 'warn');
        });
        events.on('conversation:save-failed', function () {
            show('自动保存失败：当前对话仅保留在本页面，请及时导出备份。', 'warn');
        });
        events.on('settings:save-failed', function () {
            show('配置保存失败，请检查本地存储空间。', 'warn');
        });
        events.on('storage:error', NC.util.throttle(function () {
            show('本地存储写入失败，本次修改可能无法保存。', 'warn');
        }, 5000));
        if (NC.storage && !NC.storage.available) {
            show('本地存储不可用：本次修改不会被保存。', 'warn');
        }
    }
})(window);
