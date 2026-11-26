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
    var COLLAPSED_KEY = 'ntools.workshop.collapsed';
    var DRAFT_ID = '__ws_draft__';
    var DEFAULT_EMPTY_TITLE = '选择一个工具开始';
    var DEFAULT_EMPTY_HINT = '内置工具开箱即用；也可以新建一个只属于你的小应用。';

    var els = {};
    var store = null;
    var schema = null;
    var unsubscribe = null;
    var drag = { id: null, group: null };
    var host = null;
    var lastFailedPrompt = '';
    var sideRelease = null;
    var state = {
        initialized: false,
        activeId: null,
        filter: '',
        sideCollapsed: false,
        sideOpen: false,
        chatOpen: false,
        collapsedGroups: {},
        lastError: '',
        lastAllowNetwork: null
    };

    /* 草稿：未保存前只在内存里，点「保存」才落库 */
    var draft = {
        unsaved: false,
        appId: null,
        title: '',
        code: '',
        turns: [],
        streaming: false,
        controller: null,
        startedAt: 0,
        timer: null,
        genId: 0,
        dirty: false
    };

    function isDraftSelected() {
        return !!(draft.unsaved && !state.activeId);
    }

    function hasDraftItem() {
        return !!(draft.unsaved && (draft.code || draft.turns.length || draft.streaming));
    }

    function hasUnsavedDraft() {
        return !!(draft.unsaved && draft.dirty && draft.code);
    }

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
        return NC.prefs.get(ACTIVE_KEY, '');
    }
    function writeActive(id) {
        NC.prefs.set(ACTIVE_KEY, id || '');
    }
    function readCollapsedGroups() {
        var parsed = NC.util.parseJSON(NC.prefs.get(COLLAPSED_KEY, ''), null);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    function toggleGroup(key) {
        if (!key) return;
        state.collapsedGroups[key] = !state.collapsedGroups[key];
        NC.prefs.set(COLLAPSED_KEY, JSON.stringify(state.collapsedGroups));
        renderList();
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

    function visualGroupOf(item) {
        return (item && item.pinned ? 'pinned:' : 'free:') + ((item && item.kind) || 'custom');
    }

    function bindDrag(row, item) {
        row.draggable = true;
        row.addEventListener('dragstart', function (event) {
            drag.id = item.id;
            drag.group = visualGroupOf(item);
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
            drag.group = null;
        });
        row.addEventListener('dragover', function (event) {
            if (!drag.id || drag.group !== visualGroupOf(item) || drag.id === item.id) return;
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
            if (!drag.id || drag.group !== visualGroupOf(item) || drag.id === item.id) return;
            reorderWithin(item.kind || 'custom', drag.id, item.id, before);
            drag.id = null;
            drag.group = null;
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
                if (fromIndex > -1 && toIndex > -1 && !!list[fromIndex].pinned === !!list[toIndex].pinned) {
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
        var isActive = item.isDraft
            ? isDraftSelected()
            : (!isDraftSelected() && item.id === state.activeId);
        var row = document.createElement('div');
        row.className = 'ws-item' + (isActive ? ' is-active' : '') + (item.isDraft ? ' is-draft' : '');
        row.setAttribute('role', 'listitem');
        row.setAttribute('data-ws-id', item.id);

        var main = document.createElement('button');
        main.type = 'button';
        main.className = 'ws-item__main';
        main.setAttribute('data-ws-id', item.id);
        if (isActive) main.setAttribute('aria-current', 'true');

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
        desc.textContent = item.isDraft ? '未保存草稿' : (item.kind === 'builtin' ? (item.desc || '') : '自定义应用');
        text.appendChild(desc);
        main.appendChild(text);

        if (item.isDraft) {
            var draftFlags = document.createElement('span');
            draftFlags.className = 'ws-item__flags';
            var badge = document.createElement('span');
            badge.className = 'ws-item__badge';
            badge.textContent = '草稿';
            draftFlags.appendChild(badge);
            main.appendChild(draftFlags);
        } else if (item.pinned) {
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

        if (!item.isDraft) bindDrag(row, item);
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
        var customList = free.filter(function (item) { return item.kind === 'custom'; });
        if (hasDraftItem()) {
            var draftTitle = draft.title || '新应用';
            var draftFilter = state.filter.toLowerCase();
            if (!draftFilter || (draftTitle + ' 草稿 未保存').toLowerCase().indexOf(draftFilter) > -1) {
                customList.unshift({
                    id: DRAFT_ID,
                    title: draftTitle,
                    kind: 'custom',
                    category: 'custom',
                    desc: '未保存草稿',
                    icon: 'wand',
                    isDraft: true,
                    pinned: false
                });
            }
        }
        var groups = [];
        var pinned = items.filter(function (item) { return item.pinned; });
        if (pinned.length) groups.push({ key: 'pinned', label: '置顶', list: pinned });
        groups.push(
            { key: 'builtin', label: '内置', list: free.filter(function (item) { return item.kind === 'builtin'; }) },
            { key: 'custom', label: '自定义', list: customList }
        );
        var rendered = 0;
        groups.forEach(function (group) {
            if (state.filter && !group.list.length) return;
            var count = group.list.filter(function (x) { return !x.isDraft; }).length;
            var collapsible = group.key === 'builtin' || group.key === 'custom';
            var collapsed = collapsible && !state.filter && !!state.collapsedGroups[group.key];
            if (collapsible) {
                var toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'ws-group ws-group--toggle';
                toggle.setAttribute('data-ws-group', group.key);
                toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                var chev = document.createElement('span');
                chev.className = 'ws-group__chevron';
                chev.setAttribute('aria-hidden', 'true');
                chev.appendChild(icon('chevron-down', 12));
                var label = document.createElement('span');
                label.textContent = group.label + ' (' + count + ')';
                toggle.appendChild(chev);
                toggle.appendChild(label);
                toggle.addEventListener('click', function () { toggleGroup(group.key); });
                els.list.appendChild(toggle);
                if (collapsed) return;
            } else {
                var head = document.createElement('div');
                head.className = 'ws-group';
                head.setAttribute('role', 'presentation');
                head.textContent = group.label + ' (' + count + ')';
                els.list.appendChild(head);
            }
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
     * 预览（统一由 NC.previewHost 管理 blob / sandbox / 错误）
     * ------------------------------------------------------------------ */
    function clearFrame() {
        showSkeleton(false);
        state.lastAllowNetwork = null;
        if (host) host.clear();
    }

    /** 主题/ Lite 变化：优先 postMessage 热切换，失败才重载（避免生成页丢状态） */
    function syncFrameTheme(fromLoad) {
        if (!els.frame || els.frame.hidden) return;
        var item = currentItem();
        if (item && item.kind === 'builtin') {
            if (!host || !host.postTheme(currentTheme(), isLite())) reloadFrame();
            return;
        }
        if (!isDraftSelected() && !item) return;
        if (!host || !host.postTheme(currentTheme(), isLite())) {
            if (!fromLoad) reloadFrame();
        }
    }

    function showSkeleton(show) {
        if (!els.skeleton) return;
        if (show) els.skeleton.removeAttribute('hidden');
        else els.skeleton.setAttribute('hidden', '');
    }

    function setEmptyText(titleText, hintText) {
        if (!els.empty) return;
        var title = els.empty.querySelector('.ws-empty__title');
        var hint = els.empty.querySelector('.ws-empty__hint');
        if (title) title.textContent = titleText || DEFAULT_EMPTY_TITLE;
        if (hint) hint.textContent = hintText || DEFAULT_EMPTY_HINT;
    }

    function openBuiltin(item) {
        resetErrors();
        state.lastAllowNetwork = null;
        var src = item.file + '?theme=' + currentTheme() + '&lite=' + (isLite() ? '1' : '0');
        showSkeleton(true);
        if (host) host.mountUrl(src, { trusted: true });
        els.frame.title = (item.title || '工具') + ' · 预览';
        els.frame.style.height = '';
        els.frame.style.width = '';
        setHidden(els.empty, true);
    }

    function openCustom(item) {
        showSkeleton(false);
        resetErrors();
        var params = store.getParams();
        var allowNet = params.allowNetwork === true;
        state.lastAllowNetwork = allowNet;
        var html = schema.wrapHtml(item.code || '', {
            theme: currentTheme(),
            lite: isLite(),
            allowNetwork: allowNet,
            title: item.title
        });
        if (host) host.mountHtml(html, { trusted: false });
        els.frame.title = (item.title || '应用') + ' · 预览';
        els.frame.style.height = '';
        els.frame.style.width = '';
        setHidden(els.empty, true);
    }

    function openChatForError(message) {
        toggleErrors(false);
        var item = currentItem();
        if (isDraftSelected()) {
            showChat(true);
        } else if (item && item.kind === 'custom') {
            if (!state.chatOpen || draft.appId !== item.id) openChatForApp(item.id);
        } else {
            return;
        }
        if (els.prompt) {
            els.prompt.value = '请修复页面运行报错：\n' + String(message || '').slice(0, 300);
            els.prompt.focus();
        }
    }

    function renderErrors() {
        var errors = host ? host.getErrors() : [];
        if (els.errorsBtn) {
            els.errorsBtn.hidden = !errors.length;
            els.errorsBtn.setAttribute('aria-expanded', els.errorsPanel && !els.errorsPanel.hidden ? 'true' : 'false');
        }
        if (els.errorsCount) els.errorsCount.textContent = String(errors.length);
        if (els.errorsPanel && !errors.length) {
            els.errorsPanel.hidden = true;
            if (els.errorsBtn) els.errorsBtn.setAttribute('aria-expanded', 'false');
        }
        if (!els.errorsList) return;
        els.errorsList.textContent = '';
        var activeItem = currentItem();
        var canAiFix = isDraftSelected() || (activeItem && activeItem.kind === 'custom');
        errors.forEach(function (entry) {
            var row = document.createElement('div');
            row.className = 'ws-error-row';
            var text = document.createElement('span');
            text.textContent = entry.message;
            var foot = document.createElement('div');
            foot.className = 'ws-error-row__foot';
            var time = document.createElement('time');
            time.textContent = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
            foot.appendChild(time);
            if (canAiFix) {
                var fixBtn = document.createElement('button');
                fixBtn.type = 'button';
                fixBtn.className = 'ws-error-fix';
                fixBtn.textContent = '让 AI 修复';
                fixBtn.addEventListener('click', function () {
                    openChatForError(entry.message);
                });
                foot.appendChild(fixBtn);
            }
            row.appendChild(text);
            row.appendChild(foot);
            els.errorsList.appendChild(row);
        });
    }

    function resetErrors() {
        if (host) host.clearErrors();
        state.lastError = '';
        renderErrors();
    }

    function toggleErrors(show) {
        if (!els.errorsPanel) return;
        var next = typeof show === 'boolean' ? show : els.errorsPanel.hidden;
        if (next) els.errorsPanel.removeAttribute('hidden');
        else els.errorsPanel.setAttribute('hidden', '');
        if (els.errorsBtn) els.errorsBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    }

    function currentItem() {
        if (!state.activeId) return null;
        var all = store.list();
        for (var i = 0; i < all.length; i += 1) if (all[i].id === state.activeId) return all[i];
        return null;
    }

    function syncHeader() {
        if (isDraftSelected()) {
            if (els.title) els.title.textContent = draft.title || '新应用';
            if (els.kind) { els.kind.hidden = false; els.kind.textContent = '草稿'; }
            if (els.pin) { els.pin.disabled = true; els.pin.setAttribute('aria-pressed', 'false'); }
            if (els.reloadBtn) els.reloadBtn.hidden = !draft.code;
            if (els.versions) els.versions.hidden = true;
            if (els.editBtn) {
                els.editBtn.hidden = false;
                els.editBtn.setAttribute('aria-pressed', state.chatOpen ? 'true' : 'false');
            }
            if (els.sourceBtn) els.sourceBtn.hidden = !draft.code;
            if (els.exportBtn) els.exportBtn.hidden = !draft.code;
            if (els.save) els.save.hidden = draft.streaming || !draft.code;
            return;
        }
        var item = currentItem();
        if (!item) {
            if (els.title) els.title.textContent = '选择一个工具';
            if (els.kind) els.kind.hidden = true;
            if (els.pin) { els.pin.disabled = true; els.pin.setAttribute('aria-pressed', 'false'); }
            if (els.reloadBtn) els.reloadBtn.hidden = true;
            if (els.versions) els.versions.hidden = true;
            if (els.editBtn) { els.editBtn.hidden = true; els.editBtn.setAttribute('aria-pressed', 'false'); }
            if (els.sourceBtn) els.sourceBtn.hidden = true;
            if (els.exportBtn) els.exportBtn.hidden = true;
            if (els.save) els.save.hidden = true;
            return;
        }
        var isCustom = item.kind === 'custom';
        if (els.title) els.title.textContent = item.title;
        if (els.kind) { els.kind.hidden = false; els.kind.textContent = isCustom ? '自定义' : '内置'; }
        if (els.pin) { els.pin.disabled = false; els.pin.setAttribute('aria-pressed', item.pinned ? 'true' : 'false'); }
        if (els.reloadBtn) els.reloadBtn.hidden = false;
        /* 内置工具禁止展示版本历史按钮 */
        if (els.versions) els.versions.hidden = !(isCustom && store.listVersions(item.id).length > 0);
        if (els.editBtn) {
            els.editBtn.hidden = !isCustom;
            els.editBtn.setAttribute('aria-pressed', (isCustom && state.chatOpen) ? 'true' : 'false');
        }
        if (els.sourceBtn) els.sourceBtn.hidden = !(isCustom && item.code);
        if (els.exportBtn) els.exportBtn.hidden = !(isCustom && item.code);
        if (els.save) els.save.hidden = true;
    }

    function renderActive() {
        syncHeader();
        if (isDraftSelected()) {
            if (draft.code) {
                renderDraft();
            } else {
                clearFrame();
                setEmptyText('描述你想要的工具', '用一句话描述，例如「做一个番茄钟，25 分钟专注、结束提示音」。');
                setHidden(els.empty, false);
            }
            return;
        }
        var item = currentItem();
        if (!item) {
            setEmptyText(DEFAULT_EMPTY_TITLE, DEFAULT_EMPTY_HINT);
            clearFrame();
            setHidden(els.empty, false);
            return;
        }
        if (item.kind === 'builtin') openBuiltin(item);
        else openCustom(item);
    }

    function resetDraftState() {
        draft.genId += 1;
        if (draft.streaming) stopGeneration();
        stopTimer();
        draft.unsaved = false;
        draft.dirty = false;
        draft.appId = null;
        draft.title = '';
        draft.code = '';
        draft.turns = [];
        draft.streaming = false;
        draft.controller = null;
        draft.startedAt = 0;
    }

    function confirmLeaveDraft(actionText) {
        if (!hasUnsavedDraft()) return Promise.resolve(true);
        var verb = actionText || '离开';
        var title = draft.title || '未命名应用';
        if (!NC.ui || typeof NC.ui.openModal !== 'function') {
            return Promise.resolve(global.confirm ? global.confirm('「' + title + '」尚未保存，确定要' + verb + '吗？') : true);
        }
        return new Promise(function (resolve) {
            var settled = false;
            function finish(ok) {
                if (settled) return;
                settled = true;
                resolve(ok);
            }
            NC.ui.openModal({
                title: '保存当前草稿？',
                message: '「' + title + '」尚未保存到创意工坊，直接' + verb + '会丢失当前生成内容。',
                size: 'sm',
                actions: [
                    { label: '取消', kind: 'ghost', onClick: function () { finish(false); } },
                    {
                        label: '不保存并' + verb,
                        kind: 'danger',
                        onClick: function () {
                            resetDraftState();
                            renderList();
                            finish(true);
                        }
                    },
                    {
                        label: '保存并' + verb,
                        kind: 'primary',
                        onClick: function () {
                            var saved = saveDraft({ keepView: true });
                            finish(!!saved);
                        }
                    }
                ],
                onClose: function () { finish(false); }
            });
        });
    }

    function performSelectItem(id) {
        if (!id) return;
        if (id === DRAFT_ID) {
            if (draft.unsaved) {
                state.activeId = null;
                showChat(true);
                renderList();
                renderActive();
                if (state.sideOpen) toggleSide(false);
            }
            return;
        }
        if (state.activeId === id && !isDraftSelected()) {
            if (state.sideOpen) toggleSide(false);
            return;
        }
        if (draft.streaming) stopGeneration();
        resetDraftState();
        showChat(false);
        state.activeId = id;
        writeActive(id);
        renderList();
        renderActive();
        if (state.sideOpen) toggleSide(false);
    }

    function selectItem(id) {
        if (!id) return;
        if (id === DRAFT_ID) {
            performSelectItem(id);
            return;
        }
        if (hasUnsavedDraft()) {
            confirmLeaveDraft('切换').then(function (ok) {
                if (ok) performSelectItem(id);
            });
            return;
        }
        performSelectItem(id);
    }

    function reloadFrame() {
        if (isDraftSelected()) {
            if (!draft.code) return;
            state.lastError = '';
            renderDraft();
            return;
        }
        var item = currentItem();
        if (!item) return;
        state.lastError = '';
        renderActive();
    }

    function togglePin() {
        if (isDraftSelected()) return;
        var item = currentItem();
        if (!item) return;
        var nextPinned = !item.pinned;
        store.togglePinned(item.id);
        renderList();
        syncHeader();
        toast(nextPinned ? '已置顶' : '已取消置顶', 'success');
    }

    function applySideCollapsed(collapsed) {
        state.sideCollapsed = collapsed === true;
        if (els.shell) els.shell.classList.toggle('is-side-collapsed', state.sideCollapsed);
        if (els.sideOpen) els.sideOpen.setAttribute('aria-expanded', state.sideCollapsed ? 'false' : 'true');
        if (els.sideOpen) {
            els.sideOpen.setAttribute('aria-label', state.sideCollapsed ? '展开工具列表' : '收起工具列表');
            els.sideOpen.setAttribute('title', state.sideCollapsed ? '展开工具列表' : '收起工具列表');
        }
        NC.prefs.set('ntools.workshop.side', state.sideCollapsed ? '1' : '0');
    }

    function readSideCollapsed() {
        return NC.prefs.get('ntools.workshop.side', '0') === '1';
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

    function moveInList(item, delta) {
        var all = store.list();
        var sameGroup = all.filter(function (entry) {
            return entry.kind === item.kind && !!entry.pinned === !!item.pinned;
        });
        var index = -1;
        sameGroup.forEach(function (entry, i) { if (entry.id === item.id) index = i; });
        var target = sameGroup[index + delta];
        if (index < 0 || !target) return false;
        var ordered = [];
        ['builtin', 'custom'].forEach(function (kind) {
            var list = all.filter(function (entry) { return entry.kind === kind; });
            if (kind === item.kind) {
                var from = list.map(function (entry) { return entry.id; }).indexOf(item.id);
                var moved = list.splice(from, 1)[0];
                var to = list.map(function (entry) { return entry.id; }).indexOf(target.id);
                list.splice(delta > 0 ? to + 1 : to, 0, moved);
            }
            list.forEach(function (entry) { ordered.push(entry.id); });
        });
        return store.applyOrder(ordered);
    }

    function editCustomItem(id) {
        var open = function () {
            if (state.activeId !== id || isDraftSelected()) {
                performSelectItem(id);
            }
            openChatForApp(id);
        };
        if (hasUnsavedDraft()) {
            confirmLeaveDraft('编辑').then(function (ok) {
                if (ok) open();
            });
            return;
        }
        open();
    }

    function openItemMenu(item, anchor) {
        if (item.isDraft) {
            NC.ui.openMenu(anchor, [
                {
                    label: '保存草稿',
                    icon: 'check',
                    disabled: !draft.code,
                    onSelect: function () { saveDraft(); }
                },
                {
                    label: '放弃草稿',
                    icon: 'trash',
                    danger: true,
                    onSelect: function () {
                        NC.ui.confirm('放弃当前未保存的草稿「' + (draft.title || '新应用') + '」？', { title: '放弃草稿', confirmText: '放弃', danger: true })
                            .then(function (ok) {
                                if (!ok) return;
                                resetDraftState();
                                showChat(false);
                                var all = store.list();
                                state.activeId = all.length ? all[0].id : null;
                                writeActive(state.activeId || '');
                                renderList();
                                renderActive();
                                toast('已放弃草稿', 'info');
                            });
                    }
                }
            ]);
            return;
        }
        var items = [
            {
                label: item.pinned ? '取消置顶' : '置顶',
                icon: 'pin',
                onSelect: function () { store.togglePinned(item.id); renderList(); syncHeader(); }
            }
        ];
        items.push({
            label: '上移',
            icon: 'arrow-up-down',
            onSelect: function () { if (moveInList(item, -1)) renderList(); }
        });
        items.push({
            label: '下移',
            icon: 'arrow-up-down',
            onSelect: function () { if (moveInList(item, 1)) renderList(); }
        });
        if (item.kind === 'custom') {
            items.push({
                label: '编辑（对话调整）',
                icon: 'edit',
                onSelect: function () { editCustomItem(item.id); }
            });
            items.push({
                label: '重命名',
                icon: 'edit',
                onSelect: function () {
                    NC.ui.prompt({ title: '重命名应用', value: item.title, required: true, maxLength: 40, confirmText: '保存' })
                        .then(function (next) {
                            if (!next) return;
                            if (store.renameApp(item.id, next)) {
                                var renamed = store.getApp(item.id);
                                if (draft.appId === item.id && renamed) {
                                    draft.title = renamed.title;
                                }
                                renderList();
                                syncHeader();
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
                                var nextList = store.list();
                                resetDraftState();
                                showChat(false);
                                state.activeId = nextList.length ? nextList[0].id : null;
                                writeActive(state.activeId || '');
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
    /* ------------------------------------------------------------------ *
     * 生成草稿
     * ------------------------------------------------------------------ */
    /* ------------------------------------------------------------------ *
     * 模型端点：生成面板直接切换（与「设置 → 创意工坊」同一个参数）
     * ------------------------------------------------------------------ */
    function endpointProfiles() {
        try {
            return (NC.store && NC.store.llm && NC.store.llm.getProfiles) ? (NC.store.llm.getProfiles() || []) : [];
        } catch (err) { return []; }
    }

    function endpointLabel(profile) {
        if (!profile) return '';
        var name = profile.name || profile.id;
        return profile.modelId ? name + ' · ' + profile.modelId : String(name);
    }

    function profileReady(profile) {
        return !!(profile && (profile.baseUrl || profile.apiUrl) && profile.modelId);
    }

    function renderEndpointOptions() {
        if (!els.endpointSelect) return;
        var params = store.getParams();
        var profiles = endpointProfiles();
        var currentId = params.endpointId || '';
        if (currentId && !profiles.some(function (profile) { return profile.id === currentId; })) {
            currentId = '';
            store.setParams({ endpointId: '' });
        }
        els.endpointSelect.textContent = '';
        var follow = document.createElement('option');
        follow.value = '';
        var active = null;
        try {
            active = NC.store.llm && NC.store.llm.getChatConfig ? NC.store.llm.getChatConfig() : null;
        } catch (err) { active = null; }
        follow.textContent = active
            ? '跟随当前 · ' + (active.name || active.modelId || '默认') + (profileReady(active) ? '' : '（未配置）')
            : '跟随当前端点';
        follow.title = follow.textContent;
        els.endpointSelect.appendChild(follow);
        profiles.forEach(function (profile) {
            var option = document.createElement('option');
            option.value = profile.id;
            option.textContent = (profile.name || profile.modelId || profile.id) + (profileReady(profile) ? '' : '（未配置）');
            option.title = profileReady(profile) ? option.textContent : option.textContent + '：缺少 Base URL 或 Model ID';
            els.endpointSelect.appendChild(option);
        });
        var manage = document.createElement('option');
        manage.value = '__manage';
        manage.textContent = '管理端点…';
        els.endpointSelect.appendChild(manage);
        els.endpointSelect.value = currentId;
        els.endpointSelect.title = '生成使用的模型端点：' + (currentId
            ? (els.endpointSelect.options[els.endpointSelect.selectedIndex] || {}).textContent
            : '跟随 nChat 当前端点');
    }

    function onEndpointChange() {
        if (!els.endpointSelect) return;
        var value = els.endpointSelect.value;
        if (value === '__manage') {
            renderEndpointOptions();
            if (NC.openSettings) NC.openSettings('profiles');
            else if (NC.settingsPanel && NC.settingsPanel.open) NC.settingsPanel.open('profiles');
            return;
        }
        store.setParams({ endpointId: value });
        var label = value ? (els.endpointSelect.options[els.endpointSelect.selectedIndex] || {}).textContent : '跟随当前端点';
        toast('生成端点：' + label, 'success');
        els.endpointSelect.title = '生成使用的模型端点：' + label;
    }

    var chatHideTimer = null;

    function showChat(show) {
        state.chatOpen = !!show;
        syncHeader();
        if (!els.chat) return;
        if (show) {
            if (chatHideTimer) { global.clearTimeout(chatHideTimer); chatHideTimer = null; }
            renderEndpointOptions();
            els.chat.classList.add('is-closed');
            els.chat.removeAttribute('hidden');
            global.requestAnimationFrame(function () {
                global.requestAnimationFrame(function () { els.chat.classList.remove('is-closed'); });
            });
            return;
        }
        els.chat.classList.add('is-closed');
        if (chatHideTimer) global.clearTimeout(chatHideTimer);
        chatHideTimer = global.setTimeout(function () {
            els.chat.setAttribute('hidden', '');
            chatHideTimer = null;
        }, 280);
    }

    function clearChatLog() {
        if (els.chatLog) els.chatLog.textContent = '';
    }

    function appendChat(role, text, meta, action) {
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
        if (action && action.label) {
            var retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'nc-btn nc-btn--sm ws-msg__action';
            retry.textContent = action.label;
            retry.addEventListener('click', function () {
                item.remove();
                action.onClick();
            });
            item.appendChild(retry);
        }
        els.chatLog.appendChild(item);
        els.chatLog.scrollTop = els.chatLog.scrollHeight;
    }

    function retryLastGeneration() {
        if (!lastFailedPrompt || !els.prompt) return;
        els.prompt.value = lastFailedPrompt;
        generate();
    }

    function setChatHint(text) {
        if (els.chatHint) els.chatHint.textContent = text;
    }

    function deriveTitle(prompt) {
        var text = String(prompt || '').replace(/\s+/g, ' ').trim();
        if (!text) return '未命名应用';
        return text.length > 16 ? text.slice(0, 16) + '…' : text;
    }

    function performEnterDraft() {
        resetDraftState();
        draft.unsaved = true;
        draft.dirty = false;
        draft.appId = null;
        draft.title = '新应用';
        draft.code = '';
        draft.turns = [];
        state.activeId = null;
        if (els.loading) els.loading.hidden = true;
        if (els.prompt) {
            els.prompt.value = '';
            els.prompt.readOnly = false;
        }
        clearChatLog();
        setChatHint('Enter 发送 · Shift+Enter 换行');
        if (els.generateBtn) { els.generateBtn.disabled = false; els.generateBtn.textContent = '生成'; }
        appendChat('bot', '说说你想要的小工具：用来做什么、大概长什么样。我会直接生成一个可运行的单页应用。');
        renderList();
        renderActive();
        showChat(true);
        if (els.prompt) els.prompt.focus();
    }

    function enterDraft() {
        if (hasUnsavedDraft()) {
            confirmLeaveDraft('新建').then(function (ok) {
                if (ok) performEnterDraft();
            });
            return;
        }
        performEnterDraft();
    }

    /** 打开已保存的自定义应用的对话调整抽屉（不重载已在运行的预览，改动自动落库） */
    function openChatForApp(appId) {
        var app = store.getApp(appId);
        if (!app || app.kind !== 'custom') return false;
        if (draft.streaming) stopGeneration();
        draft.genId += 1;
        draft.unsaved = false;
        draft.dirty = false;
        draft.appId = appId;
        draft.title = app.title;
        draft.code = app.code || '';
        draft.turns = store.listTurns(appId).map(function (turn) {
            return { role: turn.role, content: turn.text };
        });
        clearChatLog();
        draft.turns.forEach(function (turn) {
            appendChat(turn.role === 'user' ? 'user' : 'bot', turn.content);
        });
        if (!draft.turns.length) {
            appendChat('bot', '这是你保存的应用。想改哪里直接说，比如「把主色换成蓝色」「加一个导出按钮」。');
        }
        if (els.prompt) { els.prompt.value = ''; els.prompt.readOnly = false; }
        setChatHint('Enter 发送 · Shift+Enter 换行');
        if (els.generateBtn) { els.generateBtn.disabled = false; els.generateBtn.textContent = '生成'; }
        showChat(true);
        if (els.prompt) els.prompt.focus();
        return true;
    }

    function openVersions(anchor) {
        var item = currentItem();
        if (!item || item.kind !== 'custom') return;
        var appId = item.id;
        var versions = store.listVersions(appId);
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
                    if (store.restoreVersion(appId, version.id)) {
                        var app = store.getApp(appId);
                        if (draft.appId === appId && app) draft.code = app.code;
                        if (app) openCustom(app);
                        syncHeader();
                        toast('已恢复到该版本', 'success');
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
        syncHeader();
        setChatHint(on ? '正在生成，可随时停止' : 'Enter 发送 · Shift+Enter 换行');
    }

    function stopGeneration() {
        if (draft.controller) {
            try { draft.controller.abort(); } catch (err) { /* ignore */ }
        }
    }

    function finishWithError(message, canRetry) {
        stopTimer();
        setStreaming(false);
        setLoading(false);
        var text = String(message || '生成失败');
        appendChat('error', text, null, canRetry && lastFailedPrompt
            ? { label: '重试', onClick: retryLastGeneration }
            : null);
        toast(text, 'error');
    }

    function finishWithCode(raw, seconds, prompt) {
        stopTimer();
        setStreaming(false);
        setLoading(false);
        var parsed = schema.extractHtml(raw);
        if (!parsed || !parsed.code) {
            appendChat('error', '模型没有返回可用的 HTML，请换个说法再试一次。', null, lastFailedPrompt
                ? { label: '重试', onClick: retryLastGeneration }
                : null);
            toast('模型没有返回可用的 HTML', 'error');
            return;
        }
        if (parsed.code.length > schema.LIMITS.appBytes) {
            appendChat('error', '生成的页面超过 ' + Math.round(schema.LIMITS.appBytes / 1024) + 'KB 上限，请缩小需求范围。');
            toast('生成内容超过体积上限', 'error');
            return;
        }
        draft.code = parsed.code;
        if (!draft.appId) {
            draft.dirty = true;
            draft.title = deriveTitle(prompt || draft.title);
            /* 标题优先用页面 <title> */
            var titleMatch = /<title[^>]*>([^<]{1,40})<\/title>/i.exec(parsed.code);
            if (titleMatch && titleMatch[1].trim()) draft.title = titleMatch[1].trim();
        }
        if (draft.appId) {
            var updated = store.updateCode(draft.appId, parsed.code, '对话调整');
            if (!updated || !updated.ok) {
                appendChat('error', '保存修改失败' + (updated && updated.reason === 'too-big' ? '：超过体积上限' : ''));
                toast('保存修改失败', 'error');
                return;
            }
            store.addTurn(draft.appId, 'user', prompt);
            store.addTurn(draft.appId, 'assistant', '已更新页面');
            draft.turns.push({ role: 'user', content: prompt });
            draft.turns.push({ role: 'assistant', content: '已更新页面' });
            renderDraft();
            renderList();
            syncHeader();
            appendChat('bot', '已改好，看看预览；不满意继续说。', '耗时 ' + seconds + 's');
            toast('已更新「' + draft.title + '」', 'success');
            return;
        }
        draft.turns.push({ role: 'user', content: prompt });
        draft.turns.push({ role: 'assistant', content: '已生成页面「' + draft.title + '」' });
        renderList();
        renderDraft();
        syncHeader();
        appendChat('bot', '已生成「' + draft.title + '」，可以直接在左侧使用；想改哪里，继续告诉我。', '耗时 ' + seconds + 's');
        toast('已生成「' + draft.title + '」，可继续调整或保存', 'success');
    }

    function renderDraft() {
        if (!draft.code || !els.frame) return;
        showSkeleton(false);
        resetErrors();
        var params = store.getParams();
        var allowNet = params.allowNetwork === true;
        state.lastAllowNetwork = allowNet;
        var html = schema.wrapHtml(draft.code, {
            theme: currentTheme(),
            lite: isLite(),
            allowNetwork: allowNet,
            title: draft.title
        });
        if (host) host.mountHtml(html, { trusted: false });
        els.frame.title = (draft.title || '创意工坊') + ' · 预览';
        setHidden(els.empty, true);
    }

    function buildMessages(prompt, code, params) {
        var sysMsg = {
            role: 'system',
            content: schema.buildSystemPrompt({ allowNetwork: !!(params && params.allowNetwork === true) })
        };
        var tail = [];
        draft.turns.forEach(function (turn) {
            tail.push({ role: turn.role, content: turn.content });
        });
        if (code) {
            tail.push({
                role: 'user',
                content: '当前页面完整 HTML：\n' + code + '\n\n请基于这个页面修改，并输出修改后的完整单页 HTML。'
            });
        }
        tail.push({ role: 'user', content: prompt });
        if (NC.api && typeof NC.api.trimMessagesForBudget === 'function') {
            var fitted = NC.api.trimMessagesForBudget(tail, { budget: 24000 });
            tail = fitted.messages;
        }
        return [sysMsg].concat(tail);
    }

    function generate() {
        if (draft.streaming) return;
        if (!isDraftSelected() && !draft.appId) {
            var active = currentItem();
            if (active && active.kind === 'custom') {
                draft.unsaved = false;
                draft.dirty = false;
                draft.appId = active.id;
                draft.title = active.title;
                draft.code = active.code || '';
                draft.turns = store.listTurns(active.id).map(function (turn) {
                    return { role: turn.role, content: turn.text };
                });
            } else {
                performEnterDraft();
            }
        }
        var prompt = els.prompt ? String(els.prompt.value || '').trim() : '';
        if (!prompt) {
            toast('先写一句你想要什么', 'warn');
            if (els.prompt) els.prompt.focus();
            return;
        }
        if (!NC.api || typeof NC.api.chat !== 'function') {
            finishWithError('对话 API 未加载，请刷新页面后重试', false);
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
            finishWithError('还没有可用的模型端点：请到「设置 → AI 端点」配置 Base URL 与 Model ID', false);
            return;
        }
        var runtime = Object.assign({}, config, {
            systemPrompt: '',
            temperature: params.temperature,
            top_p: params.topP,
            enableAdvanced: true,
            reasoning: params.reasoning !== false,
            reasoningEffort: params.reasoning !== false ? params.effort : ''
        });

        var genId = ++draft.genId;
        lastFailedPrompt = prompt;
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
        var messages = buildMessages(prompt, draft.code, params);
        renderList();
        NC.api.chat({
            config: runtime,
            messages: messages,
            maxTokens: params.outputLimit,
            signal: draft.controller ? draft.controller.signal : undefined,
            onDelta: function (text) {
                if (genId !== draft.genId) return;
                buffer += text;
            },
            onDone: function (result) {
                if (genId !== draft.genId) return;
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
                            if (!draft.appId) {
                                draft.dirty = true;
                                draft.turns.push({ role: 'user', content: prompt });
                                draft.turns.push({ role: 'assistant', content: '已停止，保留了已生成的部分' });
                            }
                            renderList();
                            renderDraft();
                            syncHeader();
                            appendChat('bot', '已停止，保留了已生成的部分，可以继续调整。', '耗时 ' + seconds + 's');
                            toast('已停止，保留已生成的部分', 'info');
                            return;
                        }
                    }
                    renderList();
                    appendChat('error', '已停止生成。');
                    toast('已停止生成', 'info');
                    return;
                }
                finishWithCode(buffer, seconds, prompt);
            },
            onError: function (error) {
                if (genId !== draft.genId) return;
                draft.controller = null;
                renderList();
                var message = error && error.message ? error.message : '生成失败，请检查网络或端点配置';
                if (error && error.type === 'abort') message = '已停止生成';
                finishWithError(message, !!lastFailedPrompt);
            }
        });
    }

    function safeFileName(name) {
        return String(name || 'workshop').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workshop';
    }

    function currentCode() {
        if ((isDraftSelected() || draft.appId) && draft.code) return { code: draft.code, title: draft.title };
        var item = currentItem();
        if (item && item.kind === 'custom' && item.code) return { code: item.code, title: item.title };
        return null;
    }

    function openSourceModal() {
        var target = currentCode();
        if (!target || !NC.ui || typeof NC.ui.openModal !== 'function') {
            toast('当前没有可查看的源码', 'warn');
            return;
        }
        var pre = document.createElement('pre');
        pre.className = 'ws-source-pre';
        pre.textContent = target.code;
        NC.ui.openModal({
            title: (target.title || '应用') + ' · HTML 源码',
            content: pre,
            size: 'lg',
            actions: [
                {
                    label: '复制源码',
                    kind: 'ghost',
                    onClick: function () {
                        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
                            global.navigator.clipboard.writeText(target.code)
                                .then(function () { toast('源码已复制', 'success'); })
                                .catch(function () { toast('复制失败', 'error'); });
                        } else {
                            toast('当前环境不支持剪贴板写入，请手动选择复制', 'info');
                        }
                    }
                },
                { label: '关闭', kind: 'primary' }
            ]
        });
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

    function saveDraft(options) {
        var opts = options || {};
        if (!draft.code) { toast('还没有生成内容', 'warn'); return false; }
        /* 已保存到创意工坊的应用：原地更新代码，绝不重复创建新应用 */
        if (draft.appId) {
            var updated = store.updateCode(draft.appId, draft.code, '手动保存');
            if (!updated || !updated.ok) {
                toast('保存修改失败' + (updated && updated.reason === 'too-big' ? '：超过体积上限' : ''), 'error');
                return false;
            }
            draft.dirty = false;
            syncHeader();
            renderList();
            toast('已保存修改', 'success');
            return true;
        }
        var created = store.createApp({ title: draft.title || '未命名应用', code: draft.code });
        if (!created || !created.ok) {
            toast(created && created.message ? created.message : '保存失败', 'error');
            return false;
        }
        var appId = created.app.id;
        draft.turns.forEach(function (turn) {
            if (turn.role === 'user' || turn.role === 'assistant') store.addTurn(appId, turn.role, turn.content);
        });
        draft.unsaved = false;
        draft.dirty = false;
        draft.appId = appId;
        state.activeId = appId;
        writeActive(appId);
        renderList();
        if (!opts.keepView) {
            showChat(false);
        } else {
            syncHeader();
        }
        toast('已保存到创意工坊', 'success');
        return true;
    }

    function bind() {
        if (els.newBtn) els.newBtn.addEventListener('click', enterDraft);
        if (els.generateBtn) els.generateBtn.addEventListener('click', generate);
        if (els.stopBtn) els.stopBtn.addEventListener('click', function () { stopGeneration(); });
        if (els.save) els.save.addEventListener('click', saveDraft);
        if (els.versions) els.versions.addEventListener('click', function () { openVersions(els.versions); });
        if (els.endpointSelect) els.endpointSelect.addEventListener('change', onEndpointChange);
        if (els.settingsBtn) {
            els.settingsBtn.addEventListener('click', function () {
                if (NC.openSettings) NC.openSettings('workshop');
                else if (NC.settingsPanel && typeof NC.settingsPanel.open === 'function') {
                    NC.settingsPanel.open('workshop');
                } else {
                    toast('设置面板未加载', 'error');
                }
            });
        }
        if (els.errorsBtn) {
            els.errorsBtn.addEventListener('click', function (event) {
                event.stopPropagation();
                toggleErrors();
            });
        }
        if (els.errorsClear) {
            els.errorsClear.addEventListener('click', function () {
                resetErrors();
                toast('已清除运行错误', 'success');
            });
        }
        if (els.chatClose) {
            els.chatClose.addEventListener('click', function () {
                if (draft.streaming) stopGeneration();
                showChat(false);
            });
        }
        if (els.prompt) {
            els.prompt.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter') return;
                if (event.shiftKey || event.isComposing) return;   // Shift+Enter 换行、输入法组词不触发
                event.preventDefault();
                generate();
            });
        }
        if (els.filter) {
            var timer = null;
            var syncFilterClear = function () {
                if (els.filterClear) els.filterClear.hidden = !state.filter;
            };
            els.filter.addEventListener('input', function () {
                state.filter = String(els.filter.value || '').trim();
                syncFilterClear();
                if (timer) global.clearTimeout(timer);
                timer = global.setTimeout(function () { timer = null; renderList(); }, 120);
            });
            if (els.filterClear) {
                els.filterClear.addEventListener('click', function () {
                    if (timer) { global.clearTimeout(timer); timer = null; }
                    els.filter.value = '';
                    state.filter = '';
                    syncFilterClear();
                    renderList();
                    els.filter.focus();
                });
            }
        }
        if (els.pin) els.pin.addEventListener('click', togglePin);
        if (els.reloadBtn) els.reloadBtn.addEventListener('click', reloadFrame);
        if (els.emptyNew) els.emptyNew.addEventListener('click', function () { if (els.newBtn) els.newBtn.click(); });
        if (els.emptyImport) els.emptyImport.addEventListener('click', function () { if (els.importFile) els.importFile.click(); });
        if (els.sideOpen) els.sideOpen.addEventListener('click', onSideToggle);
        if (els.sourceBtn) els.sourceBtn.addEventListener('click', openSourceModal);
        if (els.exportBtn) els.exportBtn.addEventListener('click', exportHtml);
        if (els.editBtn) {
            els.editBtn.addEventListener('click', function () {
                if (state.chatOpen) {
                    if (draft.streaming) stopGeneration();
                    showChat(false);
                    return;
                }
                if (isDraftSelected()) {
                    showChat(true);
                    return;
                }
                var item = currentItem();
                if (item && item.kind === 'custom') openChatForApp(item.id);
            });
        }
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
        document.addEventListener('click', function (event) {
            if (!els.errorsPanel || els.errorsPanel.hidden) return;
            if (els.errorsPanel.contains(event.target)) return;
            if (els.errorsBtn && els.errorsBtn.contains(event.target)) return;
            toggleErrors(false);
        });
        document.addEventListener('keydown', function (event) {
            var page = document.getElementById('page-workshop');
            if (!page || page.hasAttribute('hidden')) return;
            if (event.key !== 'Escape') return;
            if (els.errorsPanel && !els.errorsPanel.hidden) {
                event.preventDefault();
                toggleErrors(false);
                return;
            }
            if (state.sideOpen) {
                event.preventDefault();
                toggleSide(false);
            }
        });
        if (NC.events && NC.events.on) {
            NC.events.on(NC.eventNames.themeChanged, function () { syncFrameTheme(); });
            NC.events.on(NC.eventNames.liteChanged, function () { syncFrameTheme(); });
            NC.events.on(NC.eventNames.llmChanged, function () { renderEndpointOptions(); });
            NC.events.on(NC.eventNames.llmProfileSelected, function () { renderEndpointOptions(); });
            if (NC.eventNames.workshopError) {
                NC.events.on(NC.eventNames.workshopError, function (payload) {
                    toast(payload && payload.message ? payload.message : '创意工坊存储写入失败', 'error');
                });
            }
        }
        global.addEventListener('beforeunload', function (event) {
            if (!hasUnsavedDraft()) return;
            event.preventDefault();
            event.returnValue = '';
            return '';
        });
    }

    /* ------------------------------------------------------------------ *
     * 对外
     * ------------------------------------------------------------------ */
    function init() {
        if (state.initialized) return view.workshop;
        els = {
            shell: $('ws-shell'), side: document.querySelector('.ws-side'), list: $('ws-list'),
            filter: $('ws-filter'), filterClear: $('ws-filter-clear'),
            newBtn: $('ws-new-btn'), moreBtn: $('ws-more-btn'),
            sideOpen: $('ws-side-open'), sideClose: $('ws-side-close'),
            title: $('ws-title'), kind: $('ws-kind'),
            reloadBtn: $('ws-reload-btn'), pin: $('ws-pin-btn'),
            emptyNew: $('ws-empty-new'), emptyImport: $('ws-empty-import'),
            frame: $('ws-frame'), empty: $('ws-empty'), moduleNote: $('ws-module-note'),
            stage: $('ws-stage'), scrim: $('ws-scrim'),
            save: $('ws-save-btn'), sourceBtn: $('ws-source-btn'), exportBtn: $('ws-export-btn'),
            importFile: $('ws-import-file'),
            loading: $('ws-loading'), loadingText: $('ws-loading-text'), skeleton: $('ws-skeleton'),
            stopBtn: $('ws-stop-btn'), chat: $('ws-chat'), chatLog: $('ws-chat-log'),
            prompt: $('ws-prompt'), generateBtn: $('ws-generate-btn'), chatHint: $('ws-chat-hint'),
            chatClose: $('ws-chat-close'), versions: $('ws-versions-btn'),
            endpointSelect: $('ws-endpoint-select'), settingsBtn: $('ws-settings-btn'),
            editBtn: $('ws-edit-btn'), errorsBtn: $('ws-errors-btn'), errorsPanel: $('ws-errors-panel'),
            errorsList: $('ws-errors-list'), errorsCount: $('ws-errors-count'),
            errorsClear: $('ws-errors-clear')
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
            var reason = payload && payload.reason;
            if (reason === 'view:order' || reason === 'app:create' || reason === 'app:delete' ||
                reason === 'app:rename' || reason === 'view:pin' || reason === 'import') {
                if ((reason === 'app:delete' || reason === 'import') && !isDraftSelected() && state.activeId && !currentItem()) {
                    var nextList = store.list();
                    resetDraftState();
                    showChat(false);
                    state.activeId = nextList.length ? nextList[0].id : null;
                    writeActive(state.activeId || '');
                    renderList();
                    renderActive();
                    return;
                }
                renderList();
                syncHeader();
            }
            if (reason === 'params') {
                var allowNet = store.getParams().allowNetwork === true;
                if (state.lastAllowNetwork !== null && state.lastAllowNetwork !== allowNet) {
                    if (isDraftSelected() && draft.code) renderDraft();
                    else renderActive();
                }
            }
        });
        host = (NC.previewHost && typeof NC.previewHost.create === 'function')
            ? NC.previewHost.create(els.frame, {
                onError: function (entry) {
                    if (entry.message !== state.lastError) {
                        state.lastError = entry.message;
                        toast('页面脚本错误：' + entry.message.slice(0, 80), 'error');
                    }
                    renderErrors();
                },
                onReady: function () {
                    state.lastError = '';
                }
            })
            : null;
        bind();
        if (els.frame) els.frame.addEventListener('load', function () {
            showSkeleton(false);
            syncFrameTheme(true);
        });
        applySideCollapsed(readSideCollapsed());
        state.collapsedGroups = readCollapsedGroups();
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
        getActiveId: function () { return state.activeId; },
        getPreviewSource: function () { return host ? host.getSource() : ''; },
        hasUnsavedDraft: hasUnsavedDraft,
        confirmLeave: function () { return confirmLeaveDraft('离开'); }
    };
})(window);
