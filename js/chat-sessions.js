/**
 * chat-sessions.js — nChat v5 会话栏
 * 经典脚本，依赖 core.js、ui.js、icons.js、conversation-store.js。
 * 只负责会话列表 UI 与交互；消息渲染/流式由 chat-embed/controller 负责。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var ui = NC.ui;
    var icons = NC.icons;
    var KEY_COLLAPSED = 'nchat-sessions-collapsed';

    var els = {};
    var opts = {};
    var initialized = false;
    var unsub = null;

    function store() { return NC.store && NC.store.conversation; }
    function isMobile() {
        return !!(global.matchMedia && global.matchMedia('(max-width: 900px)').matches);
    }
    function app() { return document.getElementById('chat-app'); }
    function streaming() {
        return !!(NC.chat && NC.chat.controller && NC.chat.controller.isStreaming && NC.chat.controller.isStreaming());
    }
    function guardStreaming() {
        if (!streaming()) return false;
        ui.toast('正在生成回复，请先停止或等待完成后再切换会话', { type: 'info', duration: 2600 });
        return true;
    }

    function readCollapsed() {
        try { return global.localStorage.getItem(KEY_COLLAPSED) === '1'; } catch (err) { return false; }
    }
    function saveCollapsed(value) {
        try { global.localStorage.setItem(KEY_COLLAPSED, value ? '1' : '0'); } catch (err) { /* ignore */ }
    }

    function setAria(expanded) {
        if (els.toggle) els.toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function desktopCollapsed() {
        return !!(app() && app().classList.contains('is-sessions-collapsed'));
    }

    function applyDesktop(collapsed) {
        var root = app();
        if (!root) return;
        root.classList.toggle('is-sessions-collapsed', !!collapsed);
        root.classList.remove('is-sessions-open');
        if (els.scrim) {
            els.scrim.hidden = true;
            els.scrim.classList.remove('is-open');
        }
        setAria(!collapsed);
        saveCollapsed(collapsed);
    }

    function openMobile() {
        var root = app();
        if (!root) return;
        root.classList.add('is-sessions-open');
        root.classList.remove('is-sessions-collapsed');
        if (els.scrim) {
            els.scrim.hidden = false;
            global.requestAnimationFrame(function () { els.scrim.classList.add('is-open'); });
        }
        setAria(true);
    }

    function closeMobile() {
        var root = app();
        if (!root) return;
        root.classList.remove('is-sessions-open');
        if (els.scrim) {
            els.scrim.classList.remove('is-open');
            global.setTimeout(function () { if (root && !root.classList.contains('is-sessions-open') && els.scrim) els.scrim.hidden = true; }, 220);
        }
        setAria(false);
    }

    function toggle() {
        if (isMobile()) {
            if (app() && app().classList.contains('is-sessions-open')) closeMobile();
            else openMobile();
            return;
        }
        applyDesktop(!desktopCollapsed());
    }

    function dateGroup(ts) {
        var now = Date.now();
        var today = util.startOfDay(now);
        var day = util.startOfDay(ts);
        if (day === today) return { key: 'today', label: '今天' };
        if (day === today - 86400000) return { key: 'yesterday', label: '昨天' };
        return { key: 'earlier', label: '更早' };
    }

    function timeLabel(ts) {
        var date = new Date(ts);
        if (util.startOfDay(ts) === util.startOfDay(Date.now())) {
            return ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2);
        }
        return (date.getMonth() + 1) + '/' + date.getDate();
    }

    function menuFor(session, anchor) {
        ui.openMenu(anchor, [
            {
                label: '重命名',
                icon: 'edit',
                onSelect: function () { rename(session); }
            },
            {
                label: '删除会话',
                icon: 'trash',
                danger: true,
                onSelect: function () { remove(session); }
            }
        ]);
    }

    function rename(session) {
        ui.prompt({
            title: '重命名会话',
            value: session.title,
            placeholder: '会话名称',
            maxLength: 80,
            required: true,
            confirmText: '保存'
        }).then(function (title) {
            if (!title) return;
            if (store().renameSession(session.id, title)) {
                refresh();
                refreshTitle();
            }
        });
    }

    function remove(session) {
        if (session.id === store().getState().sessionId && guardStreaming()) return;
        ui.confirm('删除会话「' + session.title + '」？该会话的消息将一并删除。', {
            danger: true,
            confirmText: '删除'
        }).then(function (ok) {
            if (!ok) return;
            store().deleteSession(session.id);
            var active = store().getActiveSession();
            if (opts.onSelect) opts.onSelect(active ? active.id : null, { deleted: true });
            refresh();
            refreshTitle();
        });
    }

    function select(id) {
        if (guardStreaming()) return;
        var state = store().getState();
        if (state.sessionId === id) {
            if (isMobile()) closeMobile();
            return;
        }
        if (opts.onSelect) opts.onSelect(id, {});
        refresh();
        refreshTitle();
        if (isMobile()) closeMobile();
    }

    function newSession() {
        if (guardStreaming()) return;
        var created = store().createSession();
        if (!created) return;
        if (opts.onSelect) opts.onSelect(created.id, { created: true });
        refresh();
        refreshTitle();
        if (isMobile()) closeMobile();
        if (NC.view && NC.view.composer) NC.view.composer.focus();
    }

    function renderList() {
        if (!els.list) return;
        var state = store().getState();
        var sessions = state.sessions || [];
        els.list.textContent = '';
        if (!sessions.length) {
            els.list.appendChild(util.e('div', {
                class: 'chat-session-empty',
                text: '还没有会话。点击上方「新对话」开始。'
            }));
            return;
        }
        var groups = [];
        var byKey = Object.create(null);
        sessions.forEach(function (session) {
            var group = dateGroup(session.updatedAt || session.createdAt);
            if (!byKey[group.key]) {
                byKey[group.key] = { key: group.key, label: group.label, items: [] };
                groups.push(byKey[group.key]);
            }
            byKey[group.key].items.push(session);
        });
        groups.forEach(function (group) {
            var wrap = util.e('div', { class: 'chat-session-group' });
            wrap.appendChild(util.e('div', { class: 'chat-session-group__label', text: group.label }));
            group.items.forEach(function (session) {
                var row = util.e('div', {
                    class: 'chat-session-row' + (session.id === state.sessionId ? ' is-active' : ''),
                    role: 'listitem'
                });
                var button = util.e('button', {
                    type: 'button',
                    class: 'chat-session-item',
                    title: session.title,
                    'aria-current': session.id === state.sessionId ? 'page' : null
                });
                button.appendChild(util.e('span', {
                    class: 'chat-session-item__title',
                    text: session.title || '新对话'
                }));
                button.appendChild(util.e('span', {
                    class: 'chat-session-item__time',
                    text: timeLabel(session.updatedAt || session.createdAt)
                }));
                button.addEventListener('click', function () { select(session.id); });
                row.appendChild(button);
                var more = util.e('button', {
                    type: 'button',
                    class: 'chat-session-more',
                    title: '会话操作',
                    'aria-label': '会话操作：' + (session.title || '新对话')
                });
                if (icons) more.appendChild(icons.el('more', 15));
                more.addEventListener('click', function (event) {
                    event.stopPropagation();
                    menuFor(session, more);
                });
                row.appendChild(more);
                wrap.appendChild(row);
            });
            els.list.appendChild(wrap);
        });
    }

    function refreshTitle() {
        var active = store().getActiveSession();
        if (els.title) els.title.textContent = active ? active.title : '新对话';
        if (els.renameBtn) els.renameBtn.hidden = !active;
        if (els.title) els.title.title = active ? active.title : '';
    }

    function refresh() {
        renderList();
        refreshTitle();
    }

    function init(options) {
        if (initialized) return true;
        opts = options || {};
        els.list = document.getElementById('chat-sessions-list');
        els.toggle = document.getElementById('chat-sessions-toggle-btn');
        els.collapse = document.getElementById('chat-sessions-collapse');
        els.scrim = document.getElementById('chat-sessions-scrim');
        els.newBtn = document.getElementById('chat-new-session');
        els.title = document.getElementById('chat-session-title');
        els.renameBtn = document.getElementById('chat-session-rename-btn');
        if (!els.list || !els.toggle || !app()) return false;

        els.toggle.addEventListener('click', toggle);
        if (els.collapse) els.collapse.addEventListener('click', function () {
            if (isMobile()) closeMobile();
            else applyDesktop(true);
        });
        if (els.scrim) els.scrim.addEventListener('click', closeMobile);
        if (els.newBtn) els.newBtn.addEventListener('click', newSession);
        if (els.renameBtn) {
            els.renameBtn.addEventListener('click', function () {
                var active = store().getActiveSession();
                if (active) rename(active);
            });
        }
        global.addEventListener('resize', function () {
            if (!isMobile()) {
                var root = app();
                if (root) root.classList.remove('is-sessions-open');
                if (els.scrim) els.scrim.hidden = true;
            }
        });
        if (!isMobile()) applyDesktop(readCollapsed());
        else setAria(false);

        if (typeof store().subscribe === 'function') {
            unsub = store().subscribe(function (payload) {
                if (!payload) return;
                refresh();
            });
        }
        refresh();
        initialized = true;
        return true;
    }

    NC.chatSessions = {
        init: init,
        refresh: refresh,
        refreshTitle: refreshTitle,
        open: function () { if (isMobile()) openMobile(); else applyDesktop(false); },
        close: function () { if (isMobile()) closeMobile(); else applyDesktop(true); },
        toggle: toggle,
        destroy: function () {
            if (unsub) unsub();
            unsub = null;
            initialized = false;
        }
    };
})(window);
