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
    var CATEGORY_ORDER = ['office', 'fun', 'custom'];

    var els = {};
    var store = null;
    var schema = null;
    var unsubscribe = null;
    var drag = { id: null, category: null };
    var state = {
        initialized: false,
        activeId: null,
        filter: '',
        focus: false,
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
        var groups = ['office', 'fun', 'custom'];
        var ordered = [];
        groups.forEach(function (cat) {
            var list = all.filter(function (entry) { return (entry.category || 'custom') === cat; });
            if (cat === category) {
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

        bindDrag(row, item);
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
        if (draft.active) return;
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
        if (draft.streaming) stopGeneration();
        draft.active = false;
        showChat(false);
        if (els.save) els.save.hidden = true;
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
            if (hint) hint.textContent = '在右侧写一句话，例如「做一个番茄钟，25 分钟专注、结束提示音」。';
        }
        if (els.title) els.title.textContent = '新应用';
        if (els.kind) { els.kind.hidden = false; els.kind.textContent = '草稿'; }
        if (els.pin) { els.pin.disabled = true; els.pin.setAttribute('aria-pressed', 'false'); }
        if (els.save) els.save.hidden = true;
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
            frame: $('ws-frame'), empty: $('ws-empty'), moduleNote: $('ws-module-note'),
            save: $('ws-save-btn'), loading: $('ws-loading'), loadingText: $('ws-loading-text'),
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
