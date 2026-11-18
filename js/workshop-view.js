/**
 * workshop-view.js — 创意工坊界面（列表 + 沙箱预览）
 * 挂载：NC.view.workshop
 *
 * 阶段 1 范围：内置工具列表（分两类）、沙箱打开与高度自适应、置顶、专注模式、
 * 窄屏抽屉、搜索。生成对话 / 自定义应用管理在后续阶段接入。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var view = NC.view = NC.view || {};

    var ACTIVE_KEY = 'ntools.workshop.active';
    var CATEGORY_ORDER = ['office', 'fun', 'custom'];

    var els = {};
    var store = null;
    var schema = null;
    var unsubscribe = null;
    var state = {
        initialized: false,
        activeId: null,
        filter: '',
        focus: false,
        sideOpen: false,
        lastError: ''
    };

    function $(id) { return document.getElementById(id); }
    function icon(name, size) {
        if (NC.icons && NC.icons.el) return NC.icons.el(name, size || 15);
        return document.createElement('span');
    }
    function toast(message, type) {
        if (NC.ui && NC.ui.toast) NC.ui.toast(message, { type: type || 'info' });
    }
    function setHidden(node, hidden) {
        if (!node) return;
        if (hidden) node.setAttribute('hidden', '');
        else node.removeAttribute('hidden');
    }
    function readActive() {
        try { return global.localStorage.getItem(ACTIVE_KEY) || ''; } catch (err) { return ''; }
    }
    function writeActive(id) {
        try { global.localStorage.setItem(ACTIVE_KEY, id || ''); } catch (err) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ *
     * 列表
     * ------------------------------------------------------------------ */
    function currentTheme() {
        return NC.theme && NC.theme.isLight && NC.theme.isLight() ? 'light' : 'dark';
    }

    function groupedItems() {
        var all = store.list();
        var filter = state.filter.toLowerCase();
        if (filter) {
            all = all.filter(function (item) {
                return (item.title + ' ' + (item.desc || '')).toLowerCase().indexOf(filter) > -1;
            });
        }
        return all;
    }

    function itemRow(item) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'ws-item' + (item.id === state.activeId ? ' is-active' : '');
        row.setAttribute('role', 'listitem');
        row.setAttribute('data-ws-id', item.id);

        var iconBox = document.createElement('span');
        iconBox.className = 'ws-item__icon';
        iconBox.appendChild(icon(item.icon || 'sparkles', 15));
        row.appendChild(iconBox);

        var text = document.createElement('span');
        text.className = 'ws-item__text';
        var title = document.createElement('span');
        title.className = 'ws-item__title';
        title.textContent = item.title;
        text.appendChild(title);
        var desc = document.createElement('span');
        desc.className = 'ws-item__desc';
        desc.textContent = item.kind === 'builtin' ? (item.desc || '') : '自定义应用';
        text.appendChild(desc);
        row.appendChild(text);

        if (item.pinned) {
            var flags = document.createElement('span');
            flags.className = 'ws-item__flags';
            flags.appendChild(icon('pin', 12));
            row.appendChild(flags);
        }

        var more = document.createElement('span');
        more.className = 'ws-item__more';
        more.setAttribute('role', 'button');
        more.setAttribute('aria-label', item.title + ' 操作');
        more.appendChild(icon('more', 13));
        more.addEventListener('click', function (event) {
            event.stopPropagation();
            openItemMenu(item, more);
        });
        row.appendChild(more);

        row.addEventListener('click', function () { selectItem(item.id); });
        return row;
    }

    function renderList() {
        if (!els.list) return;
        els.list.textContent = '';
        var items = groupedItems();
        var byCategory = Object.create(null);
        items.forEach(function (item) {
            var key = CATEGORY_ORDER.indexOf(item.category) > -1 ? item.category : 'custom';
            (byCategory[key] = byCategory[key] || []).push(item);
        });

        var labels = { office: '办公实用', fun: '效率趣味', custom: '自定义' };
        var rendered = 0;
        CATEGORY_ORDER.forEach(function (category) {
            var list = byCategory[category];
            if (category === 'custom' && (!list || !list.length)) {
                var group = document.createElement('div');
                group.className = 'ws-group';
                group.textContent = labels[category];
                els.list.appendChild(group);
                var empty = document.createElement('div');
                empty.className = 'ws-empty-list';
                empty.textContent = '还没有自定义应用。点「新建」用一句话生成一个。';
                els.list.appendChild(empty);
                return;
            }
            if (!list || !list.length) return;
            var head = document.createElement('div');
            head.className = 'ws-group';
            head.textContent = labels[category];
            els.list.appendChild(head);
            list.forEach(function (item) {
                els.list.appendChild(itemRow(item));
                rendered += 1;
            });
        });

        if (!rendered && state.filter) {
            var noResult = document.createElement('div');
            noResult.className = 'ws-empty-list';
            noResult.textContent = '没有匹配「' + state.filter + '」的工具';
            els.list.appendChild(noResult);
        }
    }

    /* ------------------------------------------------------------------ *
     * 预览
     * ------------------------------------------------------------------ */
    function clearFrame() {
        if (!els.frame) return;
        els.frame.removeAttribute('src');
        els.frame.removeAttribute('srcdoc');
        setHidden(els.frame, true);
    }

    function openBuiltin(item) {
        if (!els.frame) return;
        els.frame.removeAttribute('srcdoc');
        els.frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-same-origin');
        var src = item.file + '?theme=' + currentTheme();
        setHidden(els.frame, false);
        els.frame.src = src;
        setHidden(els.empty, true);
    }

    function openCustom(item) {
        if (!els.frame) return;
        els.frame.removeAttribute('src');
        els.frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
        var html = schema.wrapHtml(item.code || '', {
            theme: currentTheme(),
            allowNetwork: true,
            title: item.title
        });
        setHidden(els.frame, false);
        els.frame.srcdoc = html;
        setHidden(els.empty, true);
    }

    function currentItem() {
        if (!state.activeId) return null;
        var all = store.list();
        for (var i = 0; i < all.length; i += 1) if (all[i].id === state.activeId) return all[i];
        return null;
    }

    function renderActive() {
        var item = currentItem();
        if (els.title) els.title.textContent = item ? item.title : '创意工坊';
        if (els.kind) {
            if (item) {
                els.kind.hidden = false;
                els.kind.textContent = item.kind === 'builtin' ? '内置' : '自定义';
            } else {
                els.kind.hidden = true;
            }
        }
        if (els.pin) els.pin.setAttribute('aria-pressed', item && item.pinned ? 'true' : 'false');
        if (!item) {
            clearFrame();
            setHidden(els.empty, false);
            return;
        }
        if (item.kind === 'builtin') openBuiltin(item);
        else openCustom(item);
    }

    function selectItem(id) {
        if (!id) return;
        state.activeId = id;
        writeActive(id);
        renderList();
        renderActive();
        if (state.sideOpen) toggleSide(false);
    }

    function reloadFrame() {
        var item = currentItem();
        if (!item) return;
        state.lastError = '';
        renderActive();
    }

    function togglePin() {
        var item = currentItem();
        if (!item) return;
        store.togglePinned(item.id);
        renderList();
        if (els.pin) els.pin.setAttribute('aria-pressed', store.list().filter(function (x) { return x.id === item.id; })[0].pinned ? 'true' : 'false');
        toast(item.pinned ? '已取消置顶' : '已置顶', 'success');
    }

    function toggleFocus(force) {
        state.focus = typeof force === 'boolean' ? force : !state.focus;
        if (els.shell) els.shell.classList.toggle('is-focus', state.focus);
        if (els.focusBtn) els.focusBtn.setAttribute('aria-pressed', state.focus ? 'true' : 'false');
    }

    function toggleSide(force) {
        state.sideOpen = typeof force === 'boolean' ? force : !state.sideOpen;
        if (els.shell) els.shell.classList.toggle('is-side-open', state.sideOpen);
    }

    function openItemMenu(item, anchor) {
        var items = [
            {
                label: item.pinned ? '取消置顶' : '置顶',
                icon: 'pin',
                onSelect: function () { store.togglePinned(item.id); renderList(); }
            }
        ];
        if (item.kind === 'custom') {
            items.push({
                label: '重命名',
                icon: 'edit',
                onSelect: function () {
                    /* 阶段 4 换成行内输入；先用系统 prompt 兜底 */
                    var next = global.prompt ? global.prompt('新的名称', item.title) : null;
                    if (next && String(next).trim()) {
                        store.renameApp(item.id, next);
                        renderList();
                        renderActive();
                    }
                }
            });
            items.push({
                label: '删除',
                icon: 'trash',
                danger: true,
                onSelect: function () {
                    NC.ui.confirm('删除「' + item.title + '」？删除后不可恢复。', { title: '删除应用', confirmText: '删除', danger: true })
                        .then(function (ok) {
                            if (!ok) return;
                            store.deleteApp(item.id);
                            if (state.activeId === item.id) {
                                state.activeId = null;
                                writeActive('');
                                renderActive();
                            }
                            renderList();
                            toast('已删除', 'success');
                        });
                }
            });
        } else {
            items.push({ label: '内置工具，不可编辑或删除', icon: 'info', onSelect: function () {} });
        }
        NC.ui.openMenu(anchor, items);
    }

    /* ------------------------------------------------------------------ *
     * 事件
     * ------------------------------------------------------------------ */
    function bindFrameMessages() {
        global.addEventListener('message', function (event) {
            var data = event.data;
            if (!data || typeof data !== 'object') return;
            if (!els.frame || event.source !== els.frame.contentWindow) return;
            if (data.type === 'nc-ws-height') {
                var h = Math.max(120, Math.min(4000, Number(data.h) || 0));
                if (h) els.frame.style.height = h + 'px';
                els.frame.style.width = '100%';
            } else if (data.type === 'nc-ws-error') {
                var message = String(data.message || '页面脚本错误');
                if (message && message !== state.lastError) {
                    state.lastError = message;
                    toast('页面脚本错误：' + message.slice(0, 80), 'error');
                }
            }
        });
    }

    function bind() {
        if (els.newBtn) {
            els.newBtn.addEventListener('click', function () {
                toast('自然语言生成将在下一阶段接入', 'info');
            });
        }
        if (els.filter) {
            var timer = null;
            els.filter.addEventListener('input', function () {
                state.filter = String(els.filter.value || '').trim();
                if (timer) global.clearTimeout(timer);
                timer = global.setTimeout(function () { timer = null; renderList(); }, 120);
            });
        }
        if (els.pin) els.pin.addEventListener('click', togglePin);
        if (els.reloadBtn) els.reloadBtn.addEventListener('click', reloadFrame);
        if (els.focusBtn) els.focusBtn.addEventListener('click', function () { toggleFocus(); });
        if (els.sideOpen) els.sideOpen.addEventListener('click', function () { toggleSide(true); });
        if (els.sideClose) els.sideClose.addEventListener('click', function () { toggleSide(false); });
        if (els.moreBtn) {
            els.moreBtn.addEventListener('click', function () {
                NC.ui.openMenu(els.moreBtn, [
                    {
                        label: '重新加载全部',
                        icon: 'refresh',
                        onSelect: function () { reloadFrame(); }
                    },
                    {
                        label: '专注模式',
                        icon: 'external',
                        onSelect: function () { toggleFocus(); }
                    }
                ]);
            });
        }
        document.addEventListener('keydown', function (event) {
            var page = document.getElementById('page-workshop');
            if (!page || page.hasAttribute('hidden')) return;
            if (event.key === 'Escape' && state.focus) {
                event.preventDefault();
                toggleFocus(false);
            }
        });
        if (NC.events && NC.events.on) {
            NC.events.on('theme:changed', function () { reloadFrame(); });
        }
    }

    /* ------------------------------------------------------------------ *
     * 对外
     * ------------------------------------------------------------------ */
    function init() {
        if (state.initialized) return view.workshop;
        els = {
            shell: $('ws-shell'), side: null, list: $('ws-list'), filter: $('ws-filter'),
            newBtn: $('ws-new-btn'), moreBtn: $('ws-more-btn'),
            sideOpen: $('ws-side-open'), sideClose: $('ws-side-close'),
            title: $('ws-title'), kind: $('ws-kind'),
            reloadBtn: $('ws-reload-btn'), pin: $('ws-pin-btn'), focusBtn: $('ws-focus-btn'),
            frame: $('ws-frame'), empty: $('ws-empty'), moduleNote: $('ws-module-note')
        };
        store = NC.store && NC.store.workshop;
        schema = NC.schema && NC.schema.workshop;
        if (!store || !schema) {
            if (els.moduleNote) {
                els.moduleNote.hidden = false;
                els.moduleNote.textContent = '创意工坊模块未加载（js/workshop-*.js），界面已就绪。';
            }
            return null;
        }
        if (unsubscribe) unsubscribe();
        unsubscribe = store.subscribe(function (payload) {
            if (!state.initialized) return;
            if (payload && (payload.reason === 'view:order' || payload.reason === 'app:create' ||
                payload.reason === 'app:delete' || payload.reason === 'app:rename' || payload.reason === 'view:pin')) {
                renderList();
            }
        });
        bind();
        bindFrameMessages();
        state.initialized = true;
        store.init().then(function () {
            renderList();
            var previous = readActive();
            var all = store.list();
            var exists = all.some(function (item) { return item.id === previous; });
            if (exists) {
                state.activeId = previous;
            } else if (all.length) {
                state.activeId = all[0].id;
                writeActive(state.activeId);
            }
            renderList();
            renderActive();
        });
        return view.workshop;
    }

    view.workshop = {
        init: init,
        refresh: function () { renderList(); renderActive(); },
        isReady: function () { return state.initialized; },
        select: selectItem,
        getActiveId: function () { return state.activeId; }
    };
})(window);
