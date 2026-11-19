/**
 * workshop-view.js — 创意工坊界面（列表 + 沙箱预览）
 * 挂载：NC.view.workshop
 *
 * 范围：内置工具（两类）与自定义应用的列表、沙箱预览、自然语言生成草稿、
 * 多轮调整与版本回退、置顶 / 拖拽排序 / 重命名 / 删除、聚焦模式与窄屏抽屉。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var view = NC.view = NC.view || {};

    var ACTIVE_KEY = 'ntools.workshop.active';

    var els = {};
    var store = null;
    var schema = null;
    var unsubscribe = null;
    var drag = { id: null, category: null };
    var sideRelease = null;
    var state = {
        initialized: false,
        activeId: null,
        filter: '',
        sideCollapsed: false,
        sideOpen: false,
        lastError: ''
    };

    /* 草稿：未保存前只在内存里，点「保存」才落库 */
    var draft = {
        active: false,
        appId: null,
        title: '',
        code: '',
        turns: [],
        streaming: false,
        controller: null,
        startedAt: 0,
        timer: null
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

    function isLite() {
        return !!(NC.theme && NC.theme.isLite && NC.theme.isLite());
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

    function clearDropMarks() {
        Array.prototype.forEach.call(els.list ? els.list.querySelectorAll('.ws-item') : [], function (row) {
            row.classList.remove('is-drop-before', 'is-drop-after');
        });
    }

    function bindDrag(row, item) {
        row.draggable = true;
        row.addEventListener('dragstart', function (event) {
            drag.id = item.id;
            drag.category = item.category;
            row.classList.add('is-dragging');
            try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.id);
            } catch (err) { /* ignore */ }
        });
        row.addEventListener('dragend', function () {
            row.classList.remove('is-dragging');
            clearDropMarks();
            drag.id = null;
            drag.category = null;
        });
        row.addEventListener('dragover', function (event) {
            if (!drag.id || drag.category !== item.category || drag.id === item.id) return;
            event.preventDefault();
            var rect = row.getBoundingClientRect();
            var before = event.clientY < rect.top + rect.height / 2;
            row.classList.toggle('is-drop-before', before);
            row.classList.toggle('is-drop-after', !before);
        });
        row.addEventListener('dragleave', function () {
            row.classList.remove('is-drop-before', 'is-drop-after');
        });
        row.addEventListener('drop', function (event) {
            event.preventDefault();
            var before = row.classList.contains('is-drop-before');
            clearDropMarks();
            if (!drag.id || drag.category !== item.category || drag.id === item.id) return;
            reorderWithin(item.category, drag.id, item.id, before);
            drag.id = null;
            drag.category = null;
        });
    }

    /** 同分类内拖拽排序；写入 order 后按「分类顺序 + 组内顺序」落库 */
    function reorderWithin(category, fromId, toId, before) {
        var all = store.list();
        var groups = ['builtin', 'custom'];
        var ordered = [];
        groups.forEach(function (groupKey) {
            var list = all.filter(function (entry) { return (entry.kind || 'custom') === groupKey; });
            if (groupKey === category) {
                var fromIndex = -1;
                var toIndex = -1;
                list.forEach(function (entry, index) {
                    if (entry.id === fromId) fromIndex = index;
                    if (entry.id === toId) toIndex = index;
                });
                if (fromIndex > -1 && toIndex > -1) {
                    var moved = list.splice(fromIndex, 1)[0];
                    toIndex = list.map(function (entry) { return entry.id; }).indexOf(toId);
                    if (toIndex < 0) toIndex = list.length;
                    list.splice(before ? toIndex : toIndex + 1, 0, moved);
                }
            }
            list.forEach(function (entry) { ordered.push(entry.id); });
        });
        if (store.applyOrder(ordered)) {
            renderList();
            toast('顺序已更新', 'success');
        }
    }

    function itemRow(item) {
        var row = document.createElement('div');
        row.className = 'ws-item' + (item.id === state.activeId ? ' is-active' : '');
        row.setAttribute('role', 'listitem');
        row.setAttribute('data-ws-id', item.id);

        var main = document.createElement('button');
        main.type = 'button';
        main.className = 'ws-item__main';
        main.setAttribute('data-ws-id', item.id);
        if (item.id === state.activeId) main.setAttribute('aria-current', 'true');

        var iconBox = document.createElement('span');
        iconBox.className = 'ws-item__icon';
        iconBox.appendChild(icon(item.icon || 'sparkles', 16));
        main.appendChild(iconBox);

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
        main.appendChild(text);

        if (item.pinned) {
            var flags = document.createElement('span');
            flags.className = 'ws-item__flags';
            flags.appendChild(icon('pin', 12));
            main.appendChild(flags);
        }

        row.appendChild(main);

        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'ws-item__more';
        more.setAttribute('aria-label', item.title + ' 操作');
        more.appendChild(icon('more', 14));
        more.addEventListener('click', function (event) {
            event.stopPropagation();
            openItemMenu(item, more);
        });
        row.appendChild(more);

        bindDrag(row, item);
        // 行本身也可点（padding/空白区域），键盘仍走 main 按钮的 click 冒泡
        row.addEventListener('click', function (event) {
            if (event.target && event.target.closest && event.target.closest('.ws-item__more')) return;
            selectItem(item.id);
        });
        return row;
    }

    function renderList() {
        if (!els.list) return;
        els.list.textContent = '';
        var items = groupedItems();
        var free = items.filter(function (item) { return !item.pinned; });
        var groups = [];
        var pinned = items.filter(function (item) { return item.pinned; });
        if (pinned.length) groups.push({ key: 'pinned', label: '置顶', list: pinned });
        groups.push(
            { key: 'builtin', label: '内置', list: free.filter(function (item) { return item.kind === 'builtin'; }) },
            { key: 'custom', label: '自定义', list: free.filter(function (item) { return item.kind === 'custom'; }) }
        );
        var rendered = 0;
        groups.forEach(function (group) {
            if (state.filter && !group.list.length) return;
            var head = document.createElement('div');
            head.className = 'ws-group';
            head.setAttribute('role', 'presentation');
            head.textContent = group.label;
            els.list.appendChild(head);
            if (group.key === 'custom' && !group.list.length && !state.filter) {
                var empty = document.createElement('div');
                empty.className = 'ws-empty-list';
                empty.textContent = '还没有自定义应用。点「新建」生成，或从菜单导入 HTML。';
                els.list.appendChild(empty);
                return;
            }
            group.list.forEach(function (item) {
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

        // 保持当前工具在列表视野内（不滚动页面）
        var activeRow = els.list.querySelector('.ws-item.is-active');
        if (activeRow) {
            var top = activeRow.offsetTop;
            var bottom = top + activeRow.offsetHeight;
            if (top < els.list.scrollTop) els.list.scrollTop = Math.max(0, top - 8);
            else if (bottom > els.list.scrollTop + els.list.clientHeight) {
                els.list.scrollTop = bottom - els.list.clientHeight + 8;
            }
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

    var themeSeq = 0;

    /** 主题/ Lite 变化：内置工具只发消息（不重载），自定义应用仍重载 */
    function syncFrameTheme(fromLoad) {
        var item = currentItem();
        if (!item || !els.frame || els.frame.hidden) return;
        if (item.kind !== 'builtin') {
            // 自定义应用的主题在 wrapHtml 时烘焙；只有主题变化才 reload，
            // 不能在 iframe load 时 reload（会无限循环）
            if (!fromLoad) reloadFrame();
            return;
        }
        try {
            els.frame.contentWindow.postMessage({
                type: 'nc-ws-theme',
                theme: currentTheme(),
                lite: isLite(),
                requestId: String(++themeSeq)
            }, '*');
        } catch (err) {
            reloadFrame();
        }
    }

    function openBuiltin(item) {
        if (!els.frame) return;
        els.frame.removeAttribute('srcdoc');
        els.frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-same-origin');
        var src = item.file + '?theme=' + currentTheme() + '&lite=' + (isLite() ? '1' : '0');
        setHidden(els.frame, false);
        els.frame.style.height = '';
        els.frame.style.width = '';
        els.frame.title = (item.title || '工具') + ' · 预览';
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
        els.frame.style.height = '';
        els.frame.style.width = '';
        els.frame.title = (item.title || '工具') + ' · 预览';
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
        if (draft.active) return;
        var item = currentItem();
        if (els.title) els.title.textContent = item ? item.title : '选择一个工具';
        if (els.kind) {
            if (item) {
                els.kind.hidden = false;
                els.kind.textContent = item.kind === 'builtin' ? '内置' : '自定义';
            } else {
                els.kind.hidden = true;
            }
        }
        if (els.pin) els.pin.setAttribute('aria-pressed', item && item.pinned ? 'true' : 'false');
        if (els.exportBtn) els.exportBtn.hidden = !(item && item.kind === 'custom' && item.code);
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
        if (draft.streaming) stopGeneration();
        draft.active = false;
        showChat(false);
        if (els.save) els.save.hidden = true;
        if (els.exportBtn) els.exportBtn.hidden = true;
        if (els.pin) els.pin.disabled = false;
        state.activeId = id;
        writeActive(id);
        renderList();
        var item = currentItem();
        if (item && item.kind === 'custom') {
            enterEdit(id);
        } else {
            renderActive();
        }
        if (state.sideOpen) toggleSide(false);
    }

    function reloadFrame() {
        var item = currentItem();
        if (!item) return;
        state.lastError = '';
        renderActive();
    }

    function togglePin() {
        if (draft.active) return;
        var item = currentItem();
        if (!item) return;
        store.togglePinned(item.id);
        renderList();
        if (els.pin) els.pin.setAttribute('aria-pressed', store.list().filter(function (x) { return x.id === item.id; })[0].pinned ? 'true' : 'false');
        toast(item.pinned ? '已取消置顶' : '已置顶', 'success');
    }

    function applySideCollapsed(collapsed) {
        state.sideCollapsed = collapsed === true;
        if (els.shell) els.shell.classList.toggle('is-side-collapsed', state.sideCollapsed);
        if (els.sideOpen) els.sideOpen.setAttribute('aria-expanded', state.sideCollapsed ? 'false' : 'true');
        if (els.sideOpen) {
            els.sideOpen.setAttribute('aria-label', state.sideCollapsed ? '展开工具列表' : '收起工具列表');
            els.sideOpen.setAttribute('title', state.sideCollapsed ? '展开工具列表' : '收起工具列表');
        }
        try { global.localStorage.setItem('ntools.workshop.side', state.sideCollapsed ? '1' : '0'); } catch (err) { /* ignore */ }
    }

    function readSideCollapsed() {
        try { return global.localStorage.getItem('ntools.workshop.side') === '1'; } catch (err) { return false; }
    }

    function isNarrow() {
        return global.innerWidth <= 1100;
    }

    function onSideToggle() {
        if (isNarrow()) toggleSide(true);
        else applySideCollapsed(!state.sideCollapsed);
    }

    function toggleSide(force) {
        state.sideOpen = typeof force === 'boolean' ? force : !state.sideOpen;
        if (els.shell) els.shell.classList.toggle('is-side-open', state.sideOpen);
        if (els.scrim) els.scrim.hidden = !state.sideOpen;
        if (els.sideOpen) els.sideOpen.setAttribute('aria-expanded', state.sideOpen ? 'true' : 'false');
        if (state.sideOpen) {
            sideRelease = NC.ui.trapFocus(els.side);
        } else if (sideRelease) {
            sideRelease();
            sideRelease = null;
        }
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
                label: '编辑（对话调整）',
                icon: 'edit',
                onSelect: function () { selectItem(item.id); }
            });
            items.push({
                label: '重命名',
                icon: 'edit',
                onSelect: function () {
                    NC.ui.prompt({ title: '重命名应用', value: item.title, required: true, maxLength: 40, confirmText: '保存' })
                        .then(function (next) {
                            if (!next) return;
                            if (store.renameApp(item.id, next)) {
                                if (state.activeId === item.id) {
                                    draft.title = store.getApp(item.id).title;
                                    if (els.title) els.title.textContent = draft.title;
                                }
                                renderList();
                                toast('已重命名', 'success');
                            }
                        });
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
                // v8：预览恒为 100% 视口，工具内部滚动；不再按内容高度撑开
                return;
            } else if (data.type === 'nc-ws-error') {
                var message = String(data.message || '页面脚本错误');
                if (message && message !== state.lastError) {
                    state.lastError = message;
                    toast('页面脚本错误：' + message.slice(0, 80), 'error');
                }
            }
        });
    }

    /* ------------------------------------------------------------------ *
     * 生成草稿
     * ------------------------------------------------------------------ */
    function showChat(show) {
        if (!els.chat) return;
        if (show) els.chat.removeAttribute('hidden');
        else els.chat.setAttribute('hidden', '');
    }

    function clearChatLog() {
        if (els.chatLog) els.chatLog.textContent = '';
    }

    function appendChat(role, text, meta) {
        if (!els.chatLog) return;
        var item = document.createElement('div');
        item.className = 'ws-msg ws-msg--' + role;
        item.textContent = text;
        if (meta) {
            var span = document.createElement('span');
            span.className = 'ws-msg__meta';
            span.textContent = meta;
            item.appendChild(span);
        }
        els.chatLog.appendChild(item);
        els.chatLog.scrollTop = els.chatLog.scrollHeight;
    }

    function setChatHint(text) {
        if (els.chatHint) els.chatHint.textContent = text;
    }

    function deriveTitle(prompt) {
        var text = String(prompt || '').replace(/\s+/g, ' ').trim();
        if (!text) return '未命名应用';
        return text.length > 16 ? text.slice(0, 16) + '…' : text;
    }

    function enterDraft() {
        if (draft.streaming) stopGeneration();
        draft.active = true;
        draft.appId = null;
        draft.title = '新应用';
        draft.code = '';
        draft.turns = [];
        state.activeId = null;
        writeActive('');
        renderList();
        showChat(true);
        clearFrame();
        setHidden(els.empty, false);
        if (els.empty) {
            var title = els.empty.querySelector('.ws-empty__title');
            var hint = els.empty.querySelector('.ws-empty__hint');
            if (title) title.textContent = '描述你想要的工具';
            if (hint) hint.textContent = '用一句话描述，例如「做一个番茄钟，25 分钟专注、结束提示音」。';
        }
        if (els.title) els.title.textContent = '新应用';
        if (els.kind) { els.kind.hidden = false; els.kind.textContent = '草稿'; }
        if (els.pin) { els.pin.disabled = true; els.pin.setAttribute('aria-pressed', 'false'); }
        if (els.save) els.save.hidden = true;
        if (els.exportBtn) els.exportBtn.hidden = true;
        if (els.versions) els.versions.hidden = true;
        if (els.loading) els.loading.hidden = true;
        if (els.prompt) {
            els.prompt.value = '';
            els.prompt.readOnly = false;
            els.prompt.focus();
        }
        clearChatLog();
        setChatHint('Ctrl+Enter 生成');
        if (els.generateBtn) { els.generateBtn.disabled = false; els.generateBtn.textContent = '生成'; }
        appendChat('bot', '说说你想要的小工具：用来做什么、大概长什么样。我会直接生成一个可运行的单页应用。');
    }

    /** 打开已保存的自定义应用：进入可对话调整的编辑态（改动自动落库） */
    function enterEdit(appId) {
        var app = store.getApp(appId);
        if (!app) return false;
        if (draft.streaming) stopGeneration();
        draft.active = true;
        draft.appId = appId;
        draft.title = app.title;
        draft.code = app.code || '';
        draft.turns = store.listTurns(appId).map(function (turn) {
            return { role: turn.role, content: turn.text };
        });
        state.activeId = appId;
        writeActive(appId);
        showChat(true);
        clearChatLog();
        draft.turns.forEach(function (turn) {
            appendChat(turn.role === 'user' ? 'user' : 'bot', turn.content);
        });
        if (!draft.turns.length) {
            appendChat('bot', '这是你保存的应用。想改哪里直接说，比如「把主色换成蓝色」「加一个导出按钮」。');
        }
        if (els.title) els.title.textContent = app.title;
        if (els.kind) { els.kind.hidden = false; els.kind.textContent = '自定义'; }
        if (els.pin) els.pin.disabled = false;
        if (els.save) els.save.hidden = true;
        if (els.versions) els.versions.hidden = store.listVersions(appId).length === 0;
        if (els.exportBtn) els.exportBtn.hidden = !app.code;
        if (els.prompt) { els.prompt.value = ''; els.prompt.readOnly = false; }
        setChatHint('Ctrl+Enter 发送修改');
        renderDraft();
        renderList();
        return true;
    }

    function openVersions(anchor) {
        if (!draft.appId) return;
        var versions = store.listVersions(draft.appId);
        if (!versions.length) { toast('还没有历史版本', 'info'); return; }
        var items = versions.map(function (version, index) {
            var time = new Date(version.at);
            var pad = function (n) { return n < 10 ? '0' + n : String(n); };
            return {
                label: (index === 0 ? '当前 · ' : '') + pad(time.getMonth() + 1) + '-' + pad(time.getDate()) +
                    ' ' + pad(time.getHours()) + ':' + pad(time.getMinutes()) + ' · ' + (version.label || '版本'),
                icon: index === 0 ? 'check' : 'repeat',
                onSelect: function () {
                    if (index === 0) return;
                    if (store.restoreVersion(draft.appId, version.id)) {
                        var app = store.getApp(draft.appId);
                        draft.code = app ? app.code : draft.code;
                        renderDraft();
                        toast('已恢复到该版本', 'success');
                        if (els.versions) els.versions.hidden = false;
                        renderList();
                    } else {
                        toast('恢复失败', 'error');
                    }
                }
            };
        });
        NC.ui.openMenu(anchor, items);
    }

    function setLoading(show, text) {
        if (!els.loading) return;
        if (els.stage) els.stage.setAttribute('aria-busy', show ? 'true' : 'false');
        if (show) {
            els.loading.hidden = false;
            if (text && els.loadingText) els.loadingText.textContent = text;
        } else {
            els.loading.hidden = true;
        }
    }

    function elapsedText() {
        var seconds = Math.max(0, Math.round((Date.now() - draft.startedAt) / 1000));
        return seconds + 's';
    }

    function stopTimer() {
        if (draft.timer) { global.clearInterval(draft.timer); draft.timer = null; }
    }

    function setStreaming(on) {
        draft.streaming = on;
        if (els.prompt) els.prompt.readOnly = on;
        if (els.generateBtn) {
            els.generateBtn.disabled = on;
            els.generateBtn.textContent = on ? '生成中…' : '生成';
        }
        if (els.save) els.save.hidden = on || !draft.code;
        setChatHint(on ? '正在生成，可随时停止' : 'Ctrl+Enter 生成');
    }

    function stopGeneration() {
        if (draft.controller) {
            try { draft.controller.abort(); } catch (err) { /* ignore */ }
        }
    }

    function finishWithError(message) {
        stopTimer();
        setStreaming(false);
        setLoading(false);
        var text = String(message || '生成失败');
        appendChat('error', text);
        toast(text, 'error');
    }

    function finishWithCode(raw, seconds, prompt) {
        stopTimer();
        setStreaming(false);
        setLoading(false);
        var parsed = schema.extractHtml(raw);
        if (!parsed || !parsed.code) {
            appendChat('error', '模型没有返回可用的 HTML，请换个说法再试一次。');
            toast('模型没有返回可用的 HTML', 'error');
            return;
        }
        if (parsed.code.length > schema.LIMITS.appBytes) {
            appendChat('error', '生成的页面超过 ' + Math.round(schema.LIMITS.appBytes / 1024) + 'KB 上限，请缩小需求范围。');
            toast('生成内容超过体积上限', 'error');
            return;
        }
        draft.code = parsed.code;
        if (!draft.appId) draft.title = deriveTitle(prompt || draft.title);
        /* 标题优先用页面 <title> */
        var titleMatch = /<title[^>]*>([^<]{1,40})<\/title>/i.exec(parsed.code);
        if (titleMatch && titleMatch[1].trim()) draft.title = titleMatch[1].trim();
        if (draft.appId) {
            var updated = store.updateCode(draft.appId, parsed.code, '对话调整');
            if (!updated || !updated.ok) {
                appendChat('error', '保存修改失败' + (updated && updated.reason === 'too-big' ? '：超过体积上限' : ''));
                toast('保存修改失败', 'error');
                return;
            }
            store.addTurn(draft.appId, 'user', prompt);
            store.addTurn(draft.appId, 'assistant', '已更新页面');
            if (els.title) els.title.textContent = draft.title;
            if (els.versions) els.versions.hidden = false;
            renderDraft();
            renderList();
            appendChat('bot', '已改好，看看预览；不满意继续说。', '耗时 ' + seconds + 's');
            toast('已更新「' + draft.title + '」', 'success');
            return;
        }
        draft.turns.push({ role: 'assistant', content: '已生成页面「' + draft.title + '」' });
        if (els.title) els.title.textContent = draft.title;
        if (els.save) els.save.hidden = false;
        if (els.exportBtn) els.exportBtn.hidden = false;
        renderDraft();
        appendChat('bot', '已生成「' + draft.title + '」，可以直接在左侧使用；想改哪里，继续告诉我。', '耗时 ' + seconds + 's');
        toast('已生成「' + draft.title + '」，可继续调整或保存', 'success');
    }

    function renderDraft() {
        if (!draft.code || !els.frame) return;
        els.frame.removeAttribute('src');
        els.frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
        els.frame.srcdoc = schema.wrapHtml(draft.code, {
            theme: currentTheme(),
            allowNetwork: true,
            title: draft.title
        });
        setHidden(els.frame, false);
        setHidden(els.empty, true);
    }

    function buildMessages(prompt, code) {
        var messages = [{
            role: 'system',
            content: schema.buildSystemPrompt({ allowNetwork: true })
        }];
        draft.turns.forEach(function (turn) {
            messages.push({ role: turn.role, content: turn.content });
        });
        if (code) {
            messages.push({
                role: 'user',
                content: '当前页面完整 HTML：\n' + code + '\n\n请基于这个页面修改，并输出修改后的完整单页 HTML。'
            });
        }
        messages.push({ role: 'user', content: prompt });
        return messages;
    }

    function generate() {
        if (draft.streaming) return;
        if (!draft.active) enterDraft();
        var prompt = els.prompt ? String(els.prompt.value || '').trim() : '';
        if (!prompt) {
            toast('先写一句你想要什么', 'warn');
            if (els.prompt) els.prompt.focus();
            return;
        }
        if (!NC.api || typeof NC.api.chat !== 'function') {
            finishWithError('对话 API 未加载，请刷新页面后重试');
            return;
        }
        var params = store.getParams();
        var config = null;
        try {
            config = NC.store.llm && NC.store.llm.getChatConfig
                ? NC.store.llm.getChatConfig(params.endpointId || undefined)
                : null;
        } catch (err) { config = null; }
        if (!config || !config.apiUrl || !config.modelId) {
            finishWithError('还没有可用的模型端点：请到「设置 → AI 端点」配置 Base URL 与 Model ID');
            return;
        }
        var runtime = Object.assign({}, config, {
            temperature: params.temperature,
            top_p: params.topP,
            enableAdvanced: true,
            reasoning: params.reasoning !== false,
            reasoningEffort: params.reasoning !== false ? params.effort : ''
        });

        appendChat('user', prompt);
        if (els.prompt) els.prompt.value = '';
        draft.startedAt = Date.now();
        setStreaming(true);
        setLoading(true, '正在理解需求… · 0s');
        var buffer = '';
        var lastText = '';
        draft.timer = global.setInterval(function () {
            var seconds = elapsedText();
            var size = buffer.length ? ' · ' + (buffer.length / 1024).toFixed(1) + 'KB' : '';
            var text = (buffer.length ? '正在编写页面…' : '正在理解需求…') + ' · ' + seconds + size;
            if (text !== lastText && els.loadingText) { els.loadingText.textContent = text; lastText = text; }
        }, 500);

        draft.controller = global.AbortController ? new global.AbortController() : null;
        var messages = buildMessages(prompt, draft.code);
        draft.turns.push({ role: 'user', content: prompt });
        NC.api.chat({
            config: runtime,
            messages: messages,
            maxTokens: params.outputLimit,
            signal: draft.controller ? draft.controller.signal : undefined,
            onDelta: function (text) { buffer += text; },
            onDone: function (result) {
                draft.controller = null;
                var seconds = Math.max(1, Math.round((Date.now() - draft.startedAt) / 1000));
                if (result && result.aborted) {
                    stopTimer();
                    setStreaming(false);
                    setLoading(false);
                    if (buffer.trim()) {
                        var partial = schema.extractHtml(buffer);
                        if (partial && partial.code) {
                            draft.code = partial.code;
                            renderDraft();
                            if (els.save) els.save.hidden = false;
                            appendChat('bot', '已停止，保留了已生成的部分，可以继续调整。', '耗时 ' + seconds + 's');
                            toast('已停止，保留已生成的部分', 'info');
                            return;
                        }
                    }
                    appendChat('error', '已停止生成。');
                    toast('已停止生成', 'info');
                    return;
                }
                finishWithCode(buffer, seconds, prompt);
            },
            onError: function (error) {
                draft.controller = null;
                var message = error && error.message ? error.message : '生成失败，请检查网络或端点配置';
                if (error && error.type === 'abort') message = '已停止生成';
                finishWithError(message);
            }
        });
    }

    function safeFileName(name) {
        return String(name || 'workshop').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workshop';
    }

    function currentCode() {
        if (draft.active && draft.code) return { code: draft.code, title: draft.title };
        var item = currentItem();
        if (item && item.kind === 'custom' && item.code) return { code: item.code, title: item.title };
        return null;
    }

    function exportHtml() {
        var target = currentCode();
        if (!target) { toast('当前没有可导出的页面', 'warn'); return; }
        var ok = NC.util.downloadBlob(safeFileName(target.title) + '.html', target.code, 'text/html;charset=utf-8');
        toast(ok ? '已导出 ' + safeFileName(target.title) + '.html' : '导出失败：浏览器阻止了下载', ok ? 'success' : 'error');
    }

    function importHtml(event) {
        var input = event && event.target ? event.target : els.importFile;
        var file = input && input.files ? input.files[0] : null;
        if (input) input.value = '';
        if (!file) return;
        var limit = schema.LIMITS.appBytes;
        if (file.size > limit) {
            toast('文件超过 ' + Math.round(limit / 1024) + 'KB 上限', 'error');
            return;
        }
        var reader = new FileReader();
        reader.onload = function (e) {
            var code = String(e.target.result || '');
            if (!code.trim()) { toast('文件是空的', 'error'); return; }
            var title = String(file.name || '').replace(/\.html?$/i, '').replace(/[_-]+/g, ' ').trim() || '导入的应用';
            var created = store.createApp({ title: title, code: code });
            if (!created || !created.ok) {
                toast(created && created.message ? created.message : '导入失败', 'error');
                return;
            }
            selectItem(created.app.id);
            toast('已导入「' + created.app.title + '」', 'success');
        };
        reader.onerror = function () { toast('读取文件失败', 'error'); };
        reader.readAsText(file);
    }

    function saveDraft() {
        if (!draft.code) { toast('还没有生成内容', 'warn'); return; }
        var created = store.createApp({ title: draft.title || '未命名应用', code: draft.code });
        if (!created || !created.ok) {
            toast(created && created.message ? created.message : '保存失败', 'error');
            return;
        }
        var appId = created.app.id;
        draft.turns.forEach(function (turn) {
            if (turn.role === 'user' || turn.role === 'assistant') store.addTurn(appId, turn.role, turn.content);
        });
        draft.active = false;
        showChat(false);
        selectItem(appId);
        toast('已保存到创意工坊', 'success');
    }

    function bind() {
        if (els.newBtn) els.newBtn.addEventListener('click', enterDraft);
        if (els.generateBtn) els.generateBtn.addEventListener('click', generate);
        if (els.stopBtn) els.stopBtn.addEventListener('click', function () { stopGeneration(); });
        if (els.save) els.save.addEventListener('click', saveDraft);
        if (els.versions) els.versions.addEventListener('click', function () { openVersions(els.versions); });
        if (els.chatClose) {
            els.chatClose.addEventListener('click', function () {
                if (draft.streaming) stopGeneration();
                showChat(false);
            });
        }
        if (els.prompt) {
            els.prompt.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    generate();
                }
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
        if (els.emptyNew) els.emptyNew.addEventListener('click', function () { if (els.newBtn) els.newBtn.click(); });
        if (els.emptyImport) els.emptyImport.addEventListener('click', function () { if (els.importFile) els.importFile.click(); });
        if (els.sideOpen) els.sideOpen.addEventListener('click', onSideToggle);
        if (els.exportBtn) els.exportBtn.addEventListener('click', exportHtml);
        if (els.importFile) els.importFile.addEventListener('change', importHtml);
        if (els.sideClose) els.sideClose.addEventListener('click', function () { toggleSide(false); });
        if (els.scrim) els.scrim.addEventListener('click', function () { toggleSide(false); });
        if (els.moreBtn) {
            els.moreBtn.addEventListener('click', function () {
                NC.ui.openMenu(els.moreBtn, [
                    {
                        label: '导入 HTML',
                        icon: 'upload',
                        onSelect: function () { if (els.importFile) els.importFile.click(); }
                    },
                    {
                        label: '导出当前 HTML',
                        icon: 'download',
                        onSelect: exportHtml
                    },
                    {
                        label: '重新加载预览',
                        icon: 'refresh',
                        onSelect: reloadFrame
                    }
                ]);
            });
        }
        document.addEventListener('keydown', function (event) {
            var page = document.getElementById('page-workshop');
            if (!page || page.hasAttribute('hidden')) return;
            if (event.key !== 'Escape') return;
            if (state.sideOpen) {
                event.preventDefault();
                toggleSide(false);
            }
        });
        if (NC.events && NC.events.on) {
            NC.events.on('theme:changed', function () { syncFrameTheme(); });
            NC.events.on('lite:changed', function () { syncFrameTheme(); });
        }
    }

    /* ------------------------------------------------------------------ *
     * 对外
     * ------------------------------------------------------------------ */
    function init() {
        if (state.initialized) return view.workshop;
        els = {
            shell: $('ws-shell'), side: document.querySelector('.ws-side'), list: $('ws-list'), filter: $('ws-filter'),
            newBtn: $('ws-new-btn'), moreBtn: $('ws-more-btn'),
            sideOpen: $('ws-side-open'), sideClose: $('ws-side-close'),
            title: $('ws-title'), kind: $('ws-kind'),
            reloadBtn: $('ws-reload-btn'), pin: $('ws-pin-btn'),
            emptyNew: $('ws-empty-new'), emptyImport: $('ws-empty-import'),
            frame: $('ws-frame'), empty: $('ws-empty'), moduleNote: $('ws-module-note'),
            stage: $('ws-stage'), scrim: $('ws-scrim'),
            save: $('ws-save-btn'), exportBtn: $('ws-export-btn'), importFile: $('ws-import-file'),
            loading: $('ws-loading'), loadingText: $('ws-loading-text'),
            stopBtn: $('ws-stop-btn'), chat: $('ws-chat'), chatLog: $('ws-chat-log'),
            prompt: $('ws-prompt'), generateBtn: $('ws-generate-btn'), chatHint: $('ws-chat-hint'),
            chatClose: $('ws-chat-close'), versions: $('ws-versions-btn')
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
        if (els.frame) els.frame.addEventListener('load', function () { syncFrameTheme(true); });
        applySideCollapsed(readSideCollapsed());
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
