/**
 * todo-view.js — Todo 视图层（keyed diff / 事件委托 / 行内编辑 / 详情抽屉 / 筛选渲染）
 * 经典脚本，依赖 core / icons / ui / schema-todo / todo-store。挂载：NC.view.todo
 *
 * 规则：
 *   - 只读 store 快照，只写 DOM，不碰存储；
 *   - 用户数据一律 textContent / DOM API，禁止拼 innerHTML；
 *   - 行为绑定统一走事件委托 data-act，禁止内联 onclick；
 *   - 列表 keyed diff：按 id 复用节点，tick 只更新时间文本与计数。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var icons = NC.icons;
    var ui = NC.ui;
    var schema = NC.schema.todo;
    var store = NC.store.todo;

    var els = {};
    var actions = {};
    var nodeMap = Object.create(null); /* key -> node（任务行 + 分组头） */
    var rendered = {
        initialized: false,
        listsSig: '',
        composerSig: '',
        emptySig: '',
        detailId: null,
        detailSig: '',
        tickSig: '',
        viewSig: ''
    };
    var detailTimers = Object.create(null);
    var inlineEdit = null;
    var unsubscribe = null;
    var composerTags = [];
    var pendingPasteText = '';
    var draftActive = false;
    var extrasReady = false;

    var SORT_LABELS = { smart: '智能排序', due: '按截止时间', created: '按创建时间', manual: '手动排序' };
    var VIEW_LABELS = { all: '全部任务', today: '今天', overdue: '逾期', done: '已完成', trash: '回收站' };
    var BUCKET_LABELS = { overdue: '逾期', today: '今天', tomorrow: '明天', later: '以后', none: '无截止时间' };
    var BUCKET_ORDER = ['overdue', 'today', 'tomorrow', 'later', 'none'];
    var PRIORITY_LABELS = { low: '低', normal: '普通', high: '高', urgent: '紧急' };

    /* ------------------------------------------------------------------ *
     * DOM 小工具
     * ------------------------------------------------------------------ */
    function node(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = String(text);
        return el;
    }

    function icon(name, size) {
        return icons && icons.el ? icons.el(name, size || 14) : node('span');
    }

    function attr(el, name, value) {
        if (value == null || value === false) el.removeAttribute(name);
        else el.setAttribute(name, String(value));
        return el;
    }

    function hasClass(el, name) { return el && el.classList && el.classList.contains(name); }

    function toggleClass(el, name, force) {
        if (!el) return;
        if (typeof force === 'boolean') el.classList.toggle(name, force);
        else el.classList.toggle(name);
    }

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function init(options) {
        actions = options || {};
        cacheElements();
        if (!els.list || !store) return false;
        ensureExtras();
        bindStaticEvents();
        unsubscribe = store.subscribe(render);
        render({ reason: 'init' });
        global.addEventListener('resize', util.throttle(function () {
            syncDrawer(store.getUi());
            if (window.innerWidth <= 768) render({ reason: 'resize' });
        }, 180));
        return true;
    }

    function cacheElements() {
        els.page = document.getElementById('page-todo');
        els.list = document.getElementById('todo-list');
        els.scroll = document.getElementById('todo-scroll');
        els.empty = document.getElementById('todo-empty');
        els.search = document.getElementById('todo-search');
        els.searchClear = document.getElementById('todo-search-clear');
        els.sortBtn = document.getElementById('todo-sort-btn');
        els.sortLabel = document.getElementById('todo-sort-label');
        els.addBtn = document.getElementById('todo-add-btn');
        els.menuBtn = document.getElementById('todo-menu-btn');
        els.newTitle = document.getElementById('todo-new-title');
        els.newDue = document.getElementById('todo-new-due');
        els.newList = document.getElementById('todo-new-list');
        els.newPriority = document.getElementById('todo-new-priority');
        els.composer = document.getElementById('todo-composer');
        els.composerExtra = document.getElementById('todo-composer-extra');
        els.composerToggle = document.getElementById('todo-composer-toggle');
        els.newSubmit = document.getElementById('todo-new-submit');
        els.lists = document.getElementById('todo-lists');
        els.stats = document.getElementById('todo-stats');
        els.subtitle = document.getElementById('todo-subtitle');
        els.footCount = document.getElementById('todo-foot-count');
        els.detail = document.getElementById('todo-detail');
        els.detailInner = document.getElementById('todo-detail-inner');
        els.scrim = document.getElementById('todo-drawer-scrim');
        els.addListBtn = document.getElementById('todo-add-list-btn');
        els.views = els.page ? els.page.querySelector('.todo-views') : null;
        els.shell = els.page ? els.page.querySelector('.todo-shell') : null;
    }

    function bindStaticEvents() {
        /* 智能视图（左栏 + 移动端 chips 共用） */
        if (els.views) {
            els.views.addEventListener('click', function (event) {
                var viewBtn = event.target.closest('[data-view]');
                if (viewBtn) {
                    var view = viewBtn.getAttribute('data-view');
                    if (store.getUi().view === view && view !== 'trash') {
                        store.setView('all');
                    } else {
                        store.setView(view);
                    }
                    return;
                }
                var menuBtn = event.target.closest('[data-act="list-menu"]');
                if (menuBtn) {
                    event.stopPropagation();
                    openListMenu(menuBtn.getAttribute('data-list-id'), menuBtn);
                }
            });
        }

        if (els.lists) {
            els.lists.addEventListener('click', function (event) {
                var menuBtn = event.target.closest('[data-act="list-menu"]');
                if (menuBtn) {
                    event.stopPropagation();
                    openListMenu(menuBtn.getAttribute('data-list-id'), menuBtn);
                    return;
                }
                var item = event.target.closest('[data-list-id]');
                if (!item) return;
                var id = item.getAttribute('data-list-id');
                if (store.getUi().listId === id) store.setListFilter(null);
                else store.setListFilter(id);
            });
        }

        if (els.addListBtn) els.addListBtn.addEventListener('click', createListFlow);

        /* 搜索 */
        var commitSearch = util.debounce(function (value) {
            store.setSearch(value);
        }, 200);
        if (els.search) {
            els.search.addEventListener('input', function () {
                commitSearch(els.search.value);
                syncSearchClear();
            });
            els.search.addEventListener('keydown', function (event) {
                if (event.key === 'Escape') {
                    commitSearch.cancel();
                    els.search.value = '';
                    store.setSearch('');
                    syncSearchClear();
                    els.search.blur();
                } else if (event.key === 'Enter') {
                    commitSearch.flush();
                    var first = els.list ? els.list.querySelector('.todo-item__body') : null;
                    if (first) first.focus();
                }
            });
        }
        if (els.searchClear) {
            els.searchClear.addEventListener('click', function () {
                if (!els.search) return;
                els.search.value = '';
                store.setSearch('');
                syncSearchClear();
                els.search.focus();
            });
        }

        /* 排序 */
        if (els.sortBtn) {
            els.sortBtn.addEventListener('click', function () {
                openSortMenu(els.sortBtn);
            });
        }

        /* 新建按钮 / 菜单 */
        if (els.addBtn) {
            els.addBtn.addEventListener('click', function () { focusComposer(); });
        }
        if (els.menuBtn) {
            els.menuBtn.addEventListener('click', function () { openMoreMenu(els.menuBtn); });
        }

        /* 添加任务 */
        if (els.composer) {
            els.composer.addEventListener('submit', function (event) {
                event.preventDefault();
                submitComposer();
            });
        }
        if (els.newTitle) {
            els.newTitle.addEventListener('keydown', function (event) {
                if (event.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    submitComposer();
                }
            });
        }
        if (els.composerToggle) {
            els.composerToggle.addEventListener('click', function () {
                setComposerExpanded(!hasClass(els.composer, 'is-expanded'));
            });
        }

        /* 列表：点击 / 勾选 / 双击 / 键盘 */
        if (els.list) {
            els.list.addEventListener('click', onListClick);
            els.list.addEventListener('change', onListChange);
            els.list.addEventListener('dblclick', onListDblClick);
            els.list.addEventListener('keydown', onListKeydown);
            els.list.addEventListener('dragstart', onDragStart);
            els.list.addEventListener('dragover', onDragOver);
            els.list.addEventListener('dragleave', onDragLeave);
            els.list.addEventListener('drop', onDrop);
            els.list.addEventListener('dragend', onDragEnd);
        }

        /* 详情面板（事件委托） */
        if (els.detailInner) {
            els.detailInner.addEventListener('click', onDetailClick);
            els.detailInner.addEventListener('change', onDetailChange);
            els.detailInner.addEventListener('input', onDetailInput);
            els.detailInner.addEventListener('blur', onDetailBlur, true);
        }
        if (els.scrim) {
            els.scrim.addEventListener('click', function () { store.closeDrawer(); });
        }

        /* 空状态按钮 */
        if (els.empty) {
            els.empty.addEventListener('click', function (event) {
                var btn = event.target.closest('[data-act]');
                if (!btn) return;
                var act = btn.getAttribute('data-act');
                if (act === 'new') focusComposer();
                else if (act === 'clear-search') {
                    if (els.search) els.search.value = '';
                    store.setSearch('');
                    syncSearchClear();
                } else if (act === 'demo' && actions.demo) actions.demo();
                else if (act === 'clear-trash' && actions.clearTrash) actions.clearTrash();
            });
        }
    }

    /* ------------------------------------------------------------------ *
     * v3：AI 识别入口 / 快捷时间 chips / 草稿字段（运行时注入，不改 ntools.html）
     * ------------------------------------------------------------------ */
    var QUICK_FALLBACK = [
        { kind: 'work-end', label: '下班前' },
        { kind: 'tomorrow', label: '明天前' },
        { kind: 'friday', label: '周五前' },
        { kind: 'next-week', label: '下周前' },
        { kind: 'month-end', label: '月底前' },
        { kind: 'clear', label: '清除' }
    ];

    function ensureExtras() {
        if (extrasReady) return;
        extrasReady = true;
        ensureAiButton();
        ensureQuickDue();
        ensureDraftFields();
        bindComposerExtras();
        refreshQuickDue();
    }

    function ensureAiButton() {
        var existing = document.getElementById('todo-ai-btn');
        if (existing) {
            els.aiBtn = existing;
            return;
        }
        var actionsWrap = els.page ? els.page.querySelector('.tools-head__actions') : null;
        if (!actionsWrap) return;
        var button = node('button', 'nc-btn nc-btn--sm todo-ai-btn');
        button.type = 'button';
        button.id = 'todo-ai-btn';
        attr(button, 'aria-label', 'AI 识别长文本');
        attr(button, 'title', 'AI 识别：粘贴邮件/纪要，自动填写待办（不会自动创建）');
        button.appendChild(icon('sparkles', 15));
        var label = node('span', 'todo-ai-btn__text', 'AI 识别');
        button.appendChild(label);
        button.addEventListener('click', function () {
            if (NC.todoAi && typeof NC.todoAi.openDialog === 'function') {
                NC.todoAi.openDialog(pendingPasteText || '');
            } else {
                ui.toast('AI 识别模块未加载（js/todo-ai.js），请刷新页面重试', { type: 'warn' });
            }
        });
        actionsWrap.insertBefore(button, actionsWrap.firstChild);
        els.aiBtn = button;
    }

    function ensureQuickDue() {
        var host = els.composerExtra;
        if (!host) return;
        var wrap = document.getElementById('todo-quick-due');
        if (!wrap) {
            wrap = node('div', 'todo-quick-due todo-composer__field--wide');
            wrap.id = 'todo-quick-due';
            wrap.setAttribute('role', 'group');
            wrap.setAttribute('aria-label', '快捷截止时间');
            var head = node('div', 'todo-quick-due__head', '快捷时间');
            wrap.appendChild(head);
            var row = node('div', 'todo-quick-due__chips');
            var options = (NC.todoTime && NC.todoTime.OPTIONS) ? NC.todoTime.OPTIONS : QUICK_FALLBACK;
            options.forEach(function (option) {
                var chip = node('button', 'nc-chip todo-quick-chip', option.label);
                chip.type = 'button';
                attr(chip, 'data-quick-kind', option.kind);
                attr(chip, 'aria-pressed', 'false');
                row.appendChild(chip);
            });
            wrap.appendChild(row);
            host.appendChild(wrap);
        }
        els.quickDue = wrap;
    }

    function ensureDraftFields() {
        var host = els.composerExtra;
        if (!host) return;

        if (!document.getElementById('todo-new-notes')) {
            var notesField = node('label', 'todo-composer__field todo-composer__field--wide');
            notesField.appendChild(node('span', 'todo-composer__fieldlabel', '任务详情'));
            var notes = document.createElement('textarea');
            notes.id = 'todo-new-notes';
            notes.className = 'nc-textarea todo-composer__notes';
            notes.rows = 2;
            notes.maxLength = 20000;
            notes.placeholder = '可选：详情、链接或备注';
            attr(notes, 'aria-label', '任务详情');
            notesField.appendChild(notes);
            host.appendChild(notesField);
        }
        if (!document.getElementById('todo-new-tags')) {
            var tagsField = node('label', 'todo-composer__field todo-composer__field--wide');
            tagsField.appendChild(node('span', 'todo-composer__fieldlabel', '标签'));
            var tagsInput = document.createElement('input');
            tagsInput.type = 'text';
            tagsInput.id = 'todo-new-tags';
            tagsInput.className = 'nc-input';
            tagsInput.maxLength = 400;
            tagsInput.placeholder = '逗号分隔，如：汇报, 安全';
            attr(tagsInput, 'aria-label', '任务标签');
            tagsField.appendChild(tagsInput);
            var chips = node('span', 'todo-composer__tagchips');
            chips.id = 'todo-new-tags-chips';
            tagsField.appendChild(chips);
            host.appendChild(tagsField);
        }
        if (!document.getElementById('todo-ai-draft') && els.composer) {
            var draft = node('div', 'todo-ai-draft');
            draft.id = 'todo-ai-draft';
            draft.hidden = true;
            draft.appendChild(icon('sparkles', 14));
            draft.appendChild(node('span', 'todo-ai-draft__text', 'AI 已识别，请确认后创建'));
            var dismiss = node('button', 'todo-ai-draft__dismiss');
            dismiss.type = 'button';
            attr(dismiss, 'aria-label', '隐藏 AI 提示');
            dismiss.appendChild(icon('x', 12));
            dismiss.addEventListener('click', function () { setDraftActive(false); });
            draft.appendChild(dismiss);
            els.composer.insertBefore(draft, els.composerExtra);
        }

        els.newNotes = document.getElementById('todo-new-notes');
        els.newTagsInput = document.getElementById('todo-new-tags');
        els.tagChips = document.getElementById('todo-new-tags-chips');
        els.aiDraft = document.getElementById('todo-ai-draft');
        renderComposerTags();
    }

    function bindComposerExtras() {
        if (els.quickDue) {
            els.quickDue.addEventListener('click', function (event) {
                var chip = event.target.closest ? event.target.closest('[data-quick-kind]') : null;
                if (!chip) return;
                applyQuickDue(chip.getAttribute('data-quick-kind'));
            });
        }
        if (els.newDue) {
            var onDueChange = function () { clearQuickActive(); };
            els.newDue.addEventListener('input', onDueChange);
            els.newDue.addEventListener('change', onDueChange);
        }
        if (els.newTagsInput) {
            els.newTagsInput.addEventListener('keydown', function (event) {
                if (event.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                    event.preventDefault();
                    addTagsFromInput();
                } else if (event.key === 'Backspace' && !els.newTagsInput.value && composerTags.length) {
                    composerTags.pop();
                    renderComposerTags();
                }
            });
            els.newTagsInput.addEventListener('blur', addTagsFromInput);
            els.newTagsInput.addEventListener('change', addTagsFromInput);
        }
        if (els.tagChips) {
            els.tagChips.addEventListener('click', function (event) {
                var remove = event.target.closest ? event.target.closest('[data-draft-tag]') : null;
                if (!remove) return;
                var tag = remove.getAttribute('data-draft-tag');
                composerTags = composerTags.filter(function (item) { return item !== tag; });
                renderComposerTags();
            });
        }
        var longTextHinted = false;
        function showLongTextHint(text) {
            if (longTextHinted) return;
            longTextHinted = true;
            pendingPasteText = String(text).slice(0, 20000);
            ui.toast('粘贴的是长文本，可用 AI 识别提取待办', {
                type: 'info',
                duration: 6500,
                action: {
                    label: 'AI 识别',
                    onClick: function () {
                        if (NC.todoAi && typeof NC.todoAi.openDialog === 'function') {
                            NC.todoAi.openDialog(pendingPasteText);
                        } else {
                            ui.toast('AI 识别模块未加载', { type: 'warn' });
                        }
                    }
                }
            });
        }
        if (els.newTitle) {
            els.newTitle.addEventListener('input', function () {
                var value = String(els.newTitle.value || '');
                if (value.length > 120) showLongTextHint(value);
                else if (value.length <= 120) longTextHinted = false;
            });
            els.newTitle.addEventListener('paste', function (event) {
                var text = '';
                try {
                    var clipboard = event.clipboardData || global.clipboardData;
                    text = clipboard ? clipboard.getData('text') : '';
                } catch (err) { text = ''; }
                if (!text || text.length <= 120) return;
                showLongTextHint(text);
            });
        }
    }

    function applyQuickDue(kind) {
        if (!NC.todoTime || typeof NC.todoTime.computeQuickDue !== 'function') {
            ui.toast('快捷时间模块未加载（js/todo-time.js）', { type: 'warn' });
            return;
        }
        var ts = NC.todoTime.computeQuickDue(kind);
        if (kind === 'clear' || ts == null) {
            if (els.newDue) els.newDue.value = '';
            clearQuickActive();
            return;
        }
        if (els.newDue) els.newDue.value = util.toDateTimeInputValue(ts);
        markQuickActive(kind);
    }

    function markQuickActive(kind) {
        if (!els.quickDue) return;
        Array.prototype.forEach.call(els.quickDue.querySelectorAll('[data-quick-kind]'), function (chip) {
            var active = chip.getAttribute('data-quick-kind') === kind;
            toggleClass(chip, 'is-active', active);
            attr(chip, 'aria-pressed', active ? 'true' : 'false');
        });
    }

    /**
     * 当前 due 恰好等于某个快捷选项时高亮对应 chip（AI 草稿/手填共用）。
     */
    function syncQuickActiveFromDue() {
        if (!els.newDue || !els.newDue.value || !NC.todoTime ||
            typeof NC.todoTime.quickDueOptions !== 'function') {
            clearQuickActive();
            return;
        }
        var ts = util.parseDateTimeInputValue(els.newDue.value);
        if (!util.isFiniteNum(ts)) {
            clearQuickActive();
            return;
        }
        var options = NC.todoTime.quickDueOptions();
        var match = '';
        options.forEach(function (option) {
            if (option.kind !== 'clear' && option.ts === ts) match = option.kind;
        });
        if (match) markQuickActive(match);
        else clearQuickActive();
    }

    function clearQuickActive() {
        if (!els.quickDue) return;
        Array.prototype.forEach.call(els.quickDue.querySelectorAll('[data-quick-kind]'), function (chip) {
            toggleClass(chip, 'is-active', false);
            attr(chip, 'aria-pressed', 'false');
        });
    }

    function refreshQuickDue() {
        if (!els.quickDue) return;
        var options = (NC.todoTime && typeof NC.todoTime.quickDueOptions === 'function')
            ? NC.todoTime.quickDueOptions()
            : null;
        if (!options) return;
        options.forEach(function (option) {
            var chip = els.quickDue.querySelector('[data-quick-kind="' + option.kind + '"]');
            if (!chip) return;
            attr(chip, 'title', option.text);
            if (option.kind === 'clear') attr(chip, 'aria-label', '清除截止时间');
            else attr(chip, 'aria-label', option.label + '：' + option.text);
        });
    }

    function addTagsFromInput() {
        if (!els.newTagsInput) return;
        var raw = String(els.newTagsInput.value || '').trim();
        if (!raw) return;
        raw.split(/[,，;；\s]+/).forEach(function (item) {
            var tag = item.trim().slice(0, 32);
            if (!tag || composerTags.indexOf(tag) > -1 || composerTags.length >= 20) return;
            composerTags.push(tag);
        });
        els.newTagsInput.value = '';
        renderComposerTags();
    }

    function renderComposerTags() {
        if (!els.tagChips) return;
        while (els.tagChips.firstChild) els.tagChips.removeChild(els.tagChips.firstChild);
        composerTags.forEach(function (tag) {
            var chip = node('span', 'todo-draft-tag');
            chip.appendChild(document.createTextNode(tag));
            var remove = node('button', 'todo-draft-tag__remove');
            remove.type = 'button';
            attr(remove, 'data-draft-tag', tag);
            attr(remove, 'aria-label', '移除标签：' + tag);
            remove.appendChild(icon('x', 10));
            chip.appendChild(remove);
            els.tagChips.appendChild(chip);
        });
        if (els.tagChips.parentNode) toggleClass(els.tagChips.parentNode, 'has-tags', composerTags.length > 0);
    }

    function resetComposerTags() {
        composerTags = [];
        if (els.newTagsInput) els.newTagsInput.value = '';
        renderComposerTags();
    }

    function setDraftActive(active) {
        draftActive = !!active;
        toggleClass(els.composer, 'is-ai-draft', draftActive);
        if (els.aiDraft) els.aiDraft.hidden = !draftActive;
    }

    /**
     * 用 AI 识别的结果填充创建区（不创建任务）。
     * @param {{title,notes,due,dueAllDay,priority,tags,listName}} data
     * @returns {boolean}
     */
    function applyDraft(data) {
        if (!data || typeof data !== 'object') return false;
        ensureExtras();
        if (!els.newTitle) return false;
        setComposerExpanded(true);
        els.newTitle.value = data.title != null ? String(data.title).slice(0, 500) : '';
        if (els.newNotes) els.newNotes.value = data.notes != null ? String(data.notes).slice(0, 20000) : '';
        if (els.newDue) els.newDue.value = util.isFiniteNum(data.due) ? util.toDateTimeInputValue(data.due) : '';
        if (els.newPriority && data.priority && ['low', 'normal', 'high', 'urgent'].indexOf(data.priority) > -1) {
            els.newPriority.value = data.priority;
        }
        var tags = Array.isArray(data.tags) ? data.tags : [];
        composerTags = tags.filter(function (tag) {
            return typeof tag === 'string' && tag.trim();
        }).map(function (tag) { return tag.trim().slice(0, 32); }).slice(0, 20);
        renderComposerTags();
        if (els.newList && data.listName) {
            var target = String(data.listName).trim().toLowerCase();
            Array.prototype.forEach.call(els.newList.options, function (option) {
                if (String(option.textContent).trim().toLowerCase() === target) els.newList.value = option.value;
            });
        }
        syncQuickActiveFromDue();
        setDraftActive(true);
        els.newTitle.focus();
        try {
            var length = els.newTitle.value.length;
            els.newTitle.setSelectionRange(length, length);
        } catch (err) { /* ignore */ }
        return true;
    }

    function setActions(next) {
        if (!next) return;
        Object.keys(next).forEach(function (key) { actions[key] = next[key]; });
    }

    /* ------------------------------------------------------------------ *
     * 总渲染
     * ------------------------------------------------------------------ */
    function render(snapshot) {
        if (!els.list) return;
        var reason = (snapshot && snapshot.reason) || 'change';
        var doc = store.getDoc();
        var ui = store.getUi();
        var counts = store.counts(reason === 'tick' || reason === 'init');
        var visible = store.selectVisible();

        renderViewState(ui, counts, doc);
        renderLists(doc, ui, counts);
        renderComposer(doc, ui);
        renderList(visible, ui, doc);
        renderDetail(ui, doc, reason);
        renderStatusBar(visible, counts, ui, doc);
        syncSort(ui, doc);
        syncSearchClear();
        syncDrawer(ui);
        syncDetailColumn(ui);
        rendered.tickSig = bucketSignature(visible);
        rendered.initialized = true;
    }

    /* ------------------------------------------------------------------ *
     * 视图计数 / 清单
     * ------------------------------------------------------------------ */
    function renderViewState(ui, counts, doc) {
        var sig = [ui.view, ui.listId, counts.open, counts.today, counts.overdue, counts.done, counts.trash].join('|');
        if (rendered.viewSig === sig) return;
        rendered.viewSig = sig;
        if (!els.views) return;
        Array.prototype.forEach.call(els.views.querySelectorAll('[data-view]'), function (btn) {
            var view = btn.getAttribute('data-view');
            toggleClass(btn, 'is-active', ui.view === view && !ui.listId);
            var counter = btn.querySelector('[data-count]');
            if (counter) {
                var value = 0;
                if (view === 'all') value = counts.open;
                else if (view === 'today') value = counts.today;
                else if (view === 'overdue') value = counts.overdue;
                else if (view === 'done') value = counts.done;
                else if (view === 'trash') value = counts.trash;
                counter.textContent = String(value);
                toggleClass(counter, 'is-empty', value === 0);
                toggleClass(counter, 'is-danger', (view === 'overdue' || view === 'trash') && value > 0);
            }
        });
        if (els.stats) {
            els.stats.textContent = '今日完成 ' + counts.completedToday + '　本周完成 ' + counts.completedWeek;
        }
        if (els.subtitle) {
            var list = ui.listId ? findList(doc, ui.listId) : null;
            var parts = [counts.open + ' 项待办'];
            if (counts.overdue > 0) parts.push(counts.overdue + ' 项逾期');
            if (list) parts.unshift('清单：' + list.name);
            parts.push('今日完成 ' + counts.completedToday);
            els.subtitle.textContent = parts.join('　');
        }
    }

    function renderLists(doc, ui, counts) {
        if (!els.lists) return;
        var sig = doc.lists.map(function (list) {
            var c = counts.byList[list.id] ? counts.byList[list.id].open : 0;
            return list.id + ':' + list.name + ':' + list.color + ':' + c + ':' + list.archived;
        }).join('|') + '#' + (ui.listId || '');
        if (rendered.listsSig === sig) return;
        rendered.listsSig = sig;
        while (els.lists.firstChild) els.lists.removeChild(els.lists.firstChild);
        doc.lists.forEach(function (list) {
            if (list.archived) return;
            var row = node('div', 'todo-list-row');
            var button = node('button', 'todo-view-item');
            attr(button, 'type', 'button');
            attr(button, 'data-list-id', list.id);
            attr(button, 'title', list.name);
            if (ui.listId === list.id) button.classList.add('is-active');
            var dot = node('span', 'todo-list-dot');
            dot.style.background = list.color || '#5b8cff';
            var nameEl = node('span', 'todo-view-item__name', list.name);
            var count = counts.byList[list.id] ? counts.byList[list.id].open : 0;
            var counter = node('span', 'todo-view-item__count', String(count));
            toggleClass(counter, 'is-empty', count === 0);
            button.appendChild(dot);
            button.appendChild(nameEl);
            button.appendChild(counter);
            row.appendChild(button);
            var more = node('button', 'todo-list-row__more');
            attr(more, 'type', 'button');
            attr(more, 'data-act', 'list-menu');
            attr(more, 'data-list-id', list.id);
            attr(more, 'aria-label', '清单操作：' + list.name);
            more.appendChild(icon('more', 14));
            row.appendChild(more);
            els.lists.appendChild(row);
        });
    }

    function renderComposer(doc, ui) {
        if (!els.newList) return;
        var sig = doc.lists.map(function (list) { return list.id + ':' + list.name; }).join('|') + '#' + (ui.listId || '');
        if (rendered.composerSig !== sig) {
            rendered.composerSig = sig;
            var current = els.newList.value;
            while (els.newList.firstChild) els.newList.removeChild(els.newList.firstChild);
            doc.lists.forEach(function (list) {
                var option = document.createElement('option');
                option.value = list.id;
                option.textContent = list.name;
                els.newList.appendChild(option);
            });
            var preferred = ui.listId || doc.settings.defaultListId;
            if (findList(doc, preferred)) els.newList.value = preferred;
            else if (current && findList(doc, current)) els.newList.value = current;
        }
    }

    /* ------------------------------------------------------------------ *
     * 列表渲染（keyed diff）
     * ------------------------------------------------------------------ */
    function buildItems(visible, ui, doc) {
        var items = [];
        var tasks = visible.tasks;
        var now = Date.now();
        if (!tasks.length) return items;

        if (ui.view === 'trash') {
            items.push(makeGroupItem('trash', '回收站', tasks.length, false, false));
            tasks.forEach(function (task) { items.push(makeTaskItem(task)); });
            return items;
        }
        if (visible.search) {
            items.push(makeGroupItem('search', '搜索结果', tasks.length, false, false));
            tasks.forEach(function (task) { items.push(makeTaskItem(task)); });
            return items;
        }
        if (ui.view === 'done') {
            items.push(makeGroupItem('done', '已完成', tasks.length, false, false));
            tasks.forEach(function (task) { items.push(makeTaskItem(task)); });
            return items;
        }

        var open = [];
        var done = [];
        var canceled = [];
        tasks.forEach(function (task) {
            if (task.status === 'done') done.push(task);
            else if (task.status === 'canceled') canceled.push(task);
            else open.push(task);
        });
        var buckets = Object.create(null);
        open.forEach(function (task) {
            var bucket = schema.timeBucket(task, now);
            if (!buckets[bucket]) buckets[bucket] = [];
            buckets[bucket].push(task);
        });
        BUCKET_ORDER.forEach(function (bucket) {
            var list = buckets[bucket];
            if (!list || !list.length) return;
            items.push(makeGroupItem(bucket, BUCKET_LABELS[bucket], list.length, false, bucket === 'overdue'));
            list.forEach(function (task) { items.push(makeTaskItem(task)); });
        });
        if (canceled.length) {
            items.push(makeGroupItem('canceled', '已取消', canceled.length, false, false));
            canceled.forEach(function (task) { items.push(makeTaskItem(task)); });
        }
        if (done.length) {
            var expanded = !!visible.showCompleted;
            items.push(makeGroupItem('done', '已完成', done.length, true, false, expanded));
            if (expanded) done.forEach(function (task) { items.push(makeTaskItem(task)); });
        }
        return items;
    }

    function makeGroupItem(key, label, count, collapsible, danger, expanded) {
        return { type: 'group', key: 'g:' + key, group: { key: key, label: label, count: count, collapsible: !!collapsible, danger: !!danger, expanded: expanded !== false } };
    }

    function makeTaskItem(task) { return { type: 'task', key: 't:' + task.id, task: task }; }

    function renderList(visible, ui, doc) {
        var items = buildItems(visible, ui, doc);
        var list = els.list;

        if (!items.length) {
            while (list.firstChild) list.removeChild(list.firstChild);
            clearNodeMap();
            list.hidden = true;
            els.empty.hidden = false;
            renderEmpty(visible, ui, doc);
            return;
        }
        list.hidden = false;
        els.empty.hidden = true;

        var seen = Object.create(null);
        var cursor = list.firstChild;
        items.forEach(function (item) {
            var existing = nodeMap[item.key];
            var el;
            if (existing) {
                el = existing;
                if (item.type === 'task') updateTaskNode(el, item.task, ui, doc);
                else updateGroupNode(el, item.group);
            } else {
                el = item.type === 'task' ? createTaskNode(item.task, ui, doc) : createGroupNode(item.group);
                nodeMap[item.key] = el;
                if (rendered.initialized) {
                    el.classList.add('is-new');
                    global.setTimeout(function () { el.classList.remove('is-new'); }, 320);
                }
            }
            seen[item.key] = true;
            if (el === cursor) {
                cursor = cursor.nextSibling;
            } else {
                list.insertBefore(el, cursor);
            }
        });
        while (cursor) {
            var next = cursor.nextSibling;
            list.removeChild(cursor);
            cursor = next;
        }
        Object.keys(nodeMap).forEach(function (key) {
            if (!seen[key]) delete nodeMap[key];
        });
        applyRovingTabindex(ui);
    }

    function clearNodeMap() {
        Object.keys(nodeMap).forEach(function (key) { delete nodeMap[key]; });
    }

    function applyRovingTabindex(ui) {
        var hasSelected = false;
        Object.keys(nodeMap).forEach(function (key) {
            var el = nodeMap[key];
            if (!el || !el.classList || !el.classList.contains('todo-item')) return;
            var body = el.querySelector('.todo-item__body');
            if (!body) return;
            var selected = !!ui.selectedId && el.getAttribute('data-id') === ui.selectedId;
            if (selected) hasSelected = true;
            body.tabIndex = selected ? 0 : -1;
        });
        if (!hasSelected) {
            /* 没有任何选中项：第一行可聚焦 */
            var list = els.list;
            var firstBody = list ? list.querySelector('.todo-item__body') : null;
            if (firstBody) firstBody.tabIndex = 0;
        }
    }

    /* ---- 任务行 ---- */
    function createTaskNode(task, ui, doc) {
        var li = node('li', 'todo-item');
        attr(li, 'data-id', task.id);
        li.setAttribute('role', 'listitem');

        var check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'nc-check todo-item__check';
        attr(check, 'aria-label', '完成任务：' + task.title);

        var body = node('button', 'todo-item__body');
        attr(body, 'type', 'button');
        attr(body, 'data-act', 'open');
        attr(body, 'aria-label', '查看任务：' + task.title);

        var titleline = node('span', 'todo-item__titleline');
        var title = node('span', 'todo-item__title');
        titleline.appendChild(title);
        var tags = node('span', 'todo-item__titleline-tags');
        tags.className = 'todo-item__tags';
        titleline.appendChild(tags);

        var meta = node('span', 'todo-item__meta');
        var due = node('span', 'todo-item__due');
        var flag = node('span', 'todo-item__flag');
        var dot = node('span', 'todo-prio-dot');
        var prioText = node('span', 'todo-item__prio-text');
        flag.appendChild(dot);
        flag.appendChild(prioText);
        var listChip = node('span', 'todo-item__list');
        meta.appendChild(due);
        meta.appendChild(flag);
        meta.appendChild(listChip);

        body.appendChild(titleline);
        body.appendChild(meta);

        var acts = node('div', 'todo-item__actions');
        var editBtn = node('button', 'nc-btn nc-btn--icon nc-btn--sm');
        attr(editBtn, 'type', 'button');
        attr(editBtn, 'data-act', 'edit');
        attr(editBtn, 'aria-label', '编辑标题');
        editBtn.appendChild(icon('edit', 15));
        var delBtn = node('button', 'nc-btn nc-btn--icon nc-btn--sm');
        attr(delBtn, 'type', 'button');
        attr(delBtn, 'data-act', 'delete');
        attr(delBtn, 'aria-label', '删除任务');
        delBtn.appendChild(icon('trash', 15));
        acts.appendChild(editBtn);
        acts.appendChild(delBtn);

        li.appendChild(check);
        li.appendChild(body);
        li.appendChild(acts);
        li.__task = task;
        updateTaskNode(li, task, ui, doc);
        return li;
    }

    function updateTaskNode(li, task, ui, doc) {
        var now = Date.now();
        var done = task.status === 'done';
        var canceled = task.status === 'canceled';
        var classes = 'todo-item';
        if (done) classes += ' is-done';
        if (canceled) classes += ' is-canceled';
        if (ui.selectedId === task.id) classes += ' is-selected';
        if (ui.editingId === task.id) classes += ' is-editing';
        if (!done && !canceled && task.due != null && task.due < now) classes += ' is-overdue';
        li.className = classes;
        attr(li, 'data-id', task.id);
        attr(li, 'data-status', task.status);
        attr(li, 'data-priority', task.priority);
        li.__task = task;

        var check = li.querySelector('.todo-item__check');
        if (check) {
            check.checked = done;
            attr(check, 'aria-label', (done ? '取消完成：' : '完成任务：') + task.title);
        }
        var body = li.querySelector('.todo-item__body');
        if (body) attr(body, 'aria-label', '查看任务：' + task.title);
        var title = li.querySelector('.todo-item__title');
        if (title && title.textContent !== task.title) title.textContent = task.title;

        /* 标签 */
        var tagsWrap = li.querySelector('.todo-item__tags');
        var tagSig = task.tags.join('\u0001');
        if (tagsWrap && li.__tagSig !== tagSig) {
            li.__tagSig = tagSig;
            while (tagsWrap.firstChild) tagsWrap.removeChild(tagsWrap.firstChild);
            task.tags.slice(0, 3).forEach(function (tag) {
                tagsWrap.appendChild(node('span', 'todo-item__tag', tag));
            });
            if (task.tags.length > 3) tagsWrap.appendChild(node('span', 'todo-item__tag', '+' + (task.tags.length - 3)));
        }

        /* 截止时间 + 优先级 + 清单 */
        var dueEl = li.querySelector('.todo-item__due');
        updateDueLabel(dueEl, task, now);
        var prioText = li.querySelector('.todo-item__prio-text');
        if (prioText) {
            prioText.textContent = PRIORITY_LABELS[task.priority] || '普通';
            var prioDot = li.querySelector('.todo-prio-dot');
            if (prioDot) attr(prioDot, 'data-priority', task.priority);
        }
        var listChip = li.querySelector('.todo-item__list');
        if (listChip) {
            var list = findList(doc, task.listId);
            var showList = doc.lists.length > 1 && !ui.listId;
            if (list && showList) {
                listChip.hidden = false;
                listChip.textContent = '';
                var listDot = node('span', 'todo-prio-dot');
                listDot.style.background = list.color || '#5b8cff';
                listChip.appendChild(listDot);
                listChip.appendChild(node('span', null, list.name));
            } else {
                listChip.hidden = true;
            }
        }
        syncEditingState(li, task, ui);
    }

    var WEEK_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    /**
     * 记录式 ledger 的左侧时间槽：bucket（今天/明天/周X/日期）+ clock（HH:mm）。
     * 时间语义统一走铜色（.tone-* 控制），不再渲染秒级图标，保持列对齐。
     */
    function updateDueLabel(dueEl, task, now) {
        if (!dueEl) return;
        if (!util.isFiniteNum(task.due)) {
            dueEl.hidden = true;
            dueEl.textContent = '';
            return;
        }
        dueEl.hidden = false;
        var meta = util.dueMeta(task.due, now);
        var tone = meta.tone === 'overdue' ? 'overdue' : meta.tone;
        var bucket;
        var clock = meta.timeLabel || '';
        var titleLabel = meta.label;

        if (task.status === 'done') {
            /* 完成项：时间槽改为「完成 + 完成时刻」，不再显示逾期语义 */
            tone = 'done';
            bucket = '完成';
            clock = util.isFiniteNum(task.completedAt) ? util.formatTime(task.completedAt) : (meta.timeLabel || '');
            titleLabel = '完成于 ' + util.formatDateTime(task.completedAt || Date.now());
        } else if (task.status === 'canceled') {
            tone = 'none';
            bucket = '取消';
            clock = meta.timeLabel || '';
            titleLabel = '已取消 · 原截止 ' + meta.label;
        } else if (tone === 'overdue') bucket = '逾期';
        else if (tone === 'today') bucket = '今天';
        else if (tone === 'tomorrow') bucket = '明天';
        else if (tone === 'soon') bucket = WEEK_SHORT[new Date(task.due).getDay()];
        else bucket = meta.dateLabel;

        if (!bucket || !clock) {
            dueEl.hidden = true;
            dueEl.textContent = '';
            return;
        }
        dueEl.className = 'todo-item__due tone-' + tone;
        var label = bucket + ' ' + clock;

        if (dueEl.__label !== label) {
            dueEl.__label = label;
            while (dueEl.firstChild) dueEl.removeChild(dueEl.firstChild);
            var bucketEl = document.createElement('span');
            bucketEl.className = 'todo-item__due-bucket';
            bucketEl.textContent = bucket;
            var clockEl = document.createElement('span');
            clockEl.className = 'todo-item__due-clock';
            clockEl.textContent = clock;
            dueEl.appendChild(bucketEl);
            dueEl.appendChild(clockEl);
        }
        attr(dueEl, 'title', titleLabel);
        attr(dueEl, 'aria-label', (task.status === 'done' ? '完成时间：' : '截止时间：') + label);
    }

    /* ---- 行内编辑 ---- */
    function syncEditingState(li, task, ui) {
        var editing = ui.editingId === task.id;
        var existing = li.__editInput;
        if (editing && !existing) {
            var input = document.createElement('input');
            input.type = 'text';
            input.className = 'nc-input todo-item__edit';
            input.value = task.title;
            attr(input, 'aria-label', '编辑任务标题');
            input.maxLength = 500;
            li.appendChild(input);
            li.__editInput = input;
            input.addEventListener('keydown', function (event) {
                if (event.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commitInlineEdit(task.id);
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelInlineEdit(task.id);
                }
            });
            input.addEventListener('blur', function () {
                if (inlineEdit && inlineEdit.id === task.id) commitInlineEdit(task.id);
            });
            inlineEdit = { id: task.id, input: input };
            global.setTimeout(function () {
                input.focus();
                input.select();
            }, 0);
        } else if (!editing && existing) {
            clearInlineEdit(li);
        }
    }

    function beginInlineEdit(id) {
        if (!id) return;
        store.startEdit(id);
        var li = nodeMap['t:' + id];
        if (li) {
            var input = li.__editInput;
            if (input) {
                input.focus();
                input.select();
            }
        }
    }

    function clearInlineEdit(li) {
        if (!li) return;
        if (li.__editInput) {
            if (li.__editInput.parentNode) li.__editInput.parentNode.removeChild(li.__editInput);
            li.__editInput = null;
        }
        if (inlineEdit && inlineEdit.id === li.getAttribute('data-id')) inlineEdit = null;
    }

    function commitInlineEdit(id) {
        if (!inlineEdit || inlineEdit.id !== id) return;
        var input = inlineEdit.input;
        var value = input.value.trim();
        var task = store.getTask(id);
        clearInlineEdit(nodeMap['t:' + id]);
        inlineEdit = null;
        if (!task) return;
        if (!value || value === task.title) {
            store.stopEdit();
            return;
        }
        store.updateTask(id, { title: value }, { label: '编辑标题' });
        store.stopEdit();
    }

    function cancelInlineEdit(id) {
        clearInlineEdit(nodeMap['t:' + id]);
        inlineEdit = null;
        store.stopEdit();
    }

    /* ---- 分组头 ---- */
    function createGroupNode(group) {
        var li = node('li', 'todo-group');
        attr(li, 'role', 'presentation');
        attr(li, 'data-group', group.key);
        if (group.danger) li.classList.add('is-danger');
        return updateGroupNode(li, group);
    }

    function updateGroupNode(li, group) {
        while (li.firstChild) li.removeChild(li.firstChild);
        attr(li, 'data-group', group.key);
        toggleClass(li, 'is-danger', !!group.danger);
        toggleClass(li, 'is-collapsed', group.collapsible && !group.expanded);
        if (group.collapsible) {
            var toggle = node('button', 'todo-group__toggle');
            attr(toggle, 'type', 'button');
            attr(toggle, 'data-act', 'toggle-completed');
            attr(toggle, 'aria-expanded', group.expanded ? 'true' : 'false');
            toggle.appendChild(icon('chevron-down', 13));
            toggle.appendChild(node('span', null, group.label));
            li.appendChild(toggle);
        } else {
            li.appendChild(node('span', 'todo-group__label', group.label));
        }
        li.appendChild(node('span', 'todo-group__count', String(group.count)));
        li.appendChild(node('span', 'todo-group__line'));
        return li;
    }

    /* ---- 空状态 ---- */
    function renderEmpty(visible, ui, doc) {
        var sig = ui.view + '|' + visible.search + '|' + doc.tasks.length + '|' + (doc.tasks.filter(function (t) { return t.deletedAt; }).length);
        if (rendered.emptySig === sig) return;
        rendered.emptySig = sig;
        var wrap = els.empty;
        while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

        var variant = { icon: 'inbox', title: '还没有任务', desc: '按 N 或点击上方输入框创建第一项任务，也可以先载入示例数据。' };
        if (visible.search) {
            variant = { icon: 'search', title: '没有匹配的任务', desc: '换个关键词，或清除搜索查看全部任务。', action: 'clear-search', actionLabel: '清除搜索' };
        } else if (ui.view === 'today') {
            variant = { icon: 'calendar', title: '今天没有待办', desc: '今天空闲，可以安排一项新任务。', action: 'new', actionLabel: '新建任务' };
        } else if (ui.view === 'overdue') {
            variant = { icon: 'check-circle', title: '没有逾期任务', desc: '所有任务都按时完成，保持这个节奏。' };
        } else if (ui.view === 'done') {
            variant = { icon: 'sparkles', title: '还没有已完成任务', desc: '完成任务后会在这里归档。' };
        } else if (ui.view === 'trash') {
            variant = { icon: 'trash', title: '回收站为空', desc: '删除的任务会先进入回收站，可随时恢复。' };
        } else if (ui.listId) {
            variant = { icon: 'list', title: '这个清单还是空的', desc: '在上方输入框添加任务，或切换到全部任务。', action: 'new', actionLabel: '新建任务' };
        }

        var empty = node('div', 'nc-empty');
        var iconWrap = node('span', 'nc-empty__icon');
        iconWrap.appendChild(icon(variant.icon, 24));
        empty.appendChild(iconWrap);
        empty.appendChild(node('div', 'nc-empty__title', variant.title));
        empty.appendChild(node('div', 'nc-empty__desc', variant.desc));
        var actionsWrap = node('div', 'nc-empty__actions');
        if (variant.action === 'clear-search') {
            var clearBtn = node('button', 'nc-btn nc-btn--sm', '清除搜索');
            attr(clearBtn, 'type', 'button');
            attr(clearBtn, 'data-act', 'clear-search');
            actionsWrap.appendChild(clearBtn);
        } else if (variant.action === 'new') {
            var newBtn = node('button', 'nc-btn nc-btn--sm nc-btn--primary', '新建任务');
            attr(newBtn, 'type', 'button');
            attr(newBtn, 'data-act', 'new');
            actionsWrap.appendChild(newBtn);
        } else if (ui.view === 'all' && !visible.search && doc.tasks.length === 0) {
            var demoBtn = node('button', 'nc-btn nc-btn--sm', '载入示例数据');
            attr(demoBtn, 'type', 'button');
            attr(demoBtn, 'data-act', 'demo');
            var newBtn2 = node('button', 'nc-btn nc-btn--sm nc-btn--primary', '新建任务');
            attr(newBtn2, 'type', 'button');
            attr(newBtn2, 'data-act', 'new');
            actionsWrap.appendChild(demoBtn);
            actionsWrap.appendChild(newBtn2);
        }
        if (ui.view === 'trash' && doc.tasks.filter(function (t) { return t.deletedAt; }).length) {
            var clearTrashBtn = node('button', 'nc-btn nc-btn--sm nc-btn--danger', '清空回收站');
            attr(clearTrashBtn, 'type', 'button');
            attr(clearTrashBtn, 'data-act', 'clear-trash');
            actionsWrap.appendChild(clearTrashBtn);
        }
        if (actionsWrap.firstChild) empty.appendChild(actionsWrap);
        wrap.appendChild(empty);
    }

    /* ------------------------------------------------------------------ *
     * 底部状态栏 / 排序标签
     * ------------------------------------------------------------------ */
    function renderStatusBar(visible, counts, ui, doc) {
        if (!els.footCount) return;
        var total = visible.tasks.length;
        var text;
        if (visible.search) text = '匹配 ' + total + ' 项';
        else text = '共 ' + total + ' 项';
        if (ui.view === 'trash') text = '回收站 ' + total + ' 项';
        els.footCount.textContent = text;
    }

    function syncSort(ui, doc) {
        if (!els.sortLabel) return;
        var label = SORT_LABELS[doc.settings.sort] || SORT_LABELS.smart;
        if (els.sortLabel.textContent !== label) els.sortLabel.textContent = label;
        attr(els.sortBtn, 'data-sort', doc.settings.sort);
        attr(els.sortBtn, 'aria-label', '排序方式：' + label);
        attr(els.sortBtn, 'title', '排序方式：' + label);
    }

    function syncSearchClear() {
        if (!els.search || !els.searchClear) return;
        els.searchClear.hidden = !els.search.value;
    }

    function ensureSearchValue() {
        if (!els.search) return;
        var query = store.getUi().search;
        if (els.search.value !== query && document.activeElement !== els.search) {
            els.search.value = query;
        }
    }

    function findList(doc, id) {
        var lists = (doc && doc.lists) || [];
        for (var i = 0; i < lists.length; i++) {
            if (lists[i].id === id) return lists[i];
        }
        return null;
    }

    /* ------------------------------------------------------------------ *
     * tick：只更新时间文本与计数（分组变化时才整体重排）
     * ------------------------------------------------------------------ */
    function bucketSignature(visible) {
        if (!visible || !visible.tasks) return '';
        var now = Date.now();
        return visible.tasks.map(function (task) {
            return task.id + ':' + (task.status === 'open' ? schema.timeBucket(task, now) : task.status);
        }).join('|');
    }

    function refreshTimes() {
        if (!els.list) return;
        var visible = store.selectVisible();
        var signature = bucketSignature(visible);
        if (signature !== rendered.tickSig) {
            render({ reason: 'tick' });
            return;
        }
        var now = Date.now();
        visible.tasks.forEach(function (task) {
            var li = nodeMap['t:' + task.id];
            if (!li) return;
            li.__task = task;
            updateDueLabel(li.querySelector('.todo-item__due'), task, now);
        });
        /* 计数可能跨分钟变化 */
        var counts = store.counts(true);
        rendered.viewSig = '';
        renderViewState(store.getUi(), counts, store.getDoc());
        renderStatusBar(visible, counts, store.getUi(), store.getDoc());
        var detailTask = store.getUi().selectedId ? store.getTask(store.getUi().selectedId) : null;
        if (detailTask && rendered.detailId === detailTask.id) {
            var metaEl = els.detailInner ? els.detailInner.querySelector('[data-detail-meta]') : null;
            if (metaEl) metaEl.textContent = detailMetaText(detailTask);
        }
    }

    /* ------------------------------------------------------------------ *
     * 详情抽屉
     * ------------------------------------------------------------------ */
    function detailMetaText(task) {
        var parts = [];
        parts.push('创建 ' + util.formatDateTime(task.createdAt));
        if (util.isFiniteNum(task.updatedAt)) parts.push('更新 ' + util.formatDateTime(task.updatedAt));
        if (util.isFiniteNum(task.completedAt)) parts.push('完成 ' + util.formatDateTime(task.completedAt));
        if (task.deletedAt) parts.push('删除 ' + util.formatDateTime(task.deletedAt));
        return parts.join('　');
    }

    function renderDetail(ui, doc, reason) {
        if (!els.detailInner) return;
        var id = ui.selectedId;
        var task = id ? store.getTask(id) : null;
        if (!task) {
            if (rendered.detailId !== null || reason === 'init') {
                rendered.detailId = null;
                rendered.detailSig = '';
                while (els.detailInner.firstChild) els.detailInner.removeChild(els.detailInner.firstChild);
                els.detailInner.appendChild(buildDetailEmpty());
            }
            return;
        }
        if (rendered.detailId !== task.id) {
            rendered.detailId = task.id;
            rendered.detailSig = '';
            while (els.detailInner.firstChild) els.detailInner.removeChild(els.detailInner.firstChild);
            els.detailInner.appendChild(buildDetailForm(task, doc));
            syncDetailForm(task, doc, true);
        } else {
            syncDetailForm(task, doc, false);
        }
    }

    function buildDetailEmpty() {
        var empty = node('div', 'detail-empty');
        var inner = node('div', 'nc-empty');
        var iconWrap = node('span', 'nc-empty__icon');
        iconWrap.appendChild(icon('eye', 24));
        inner.appendChild(iconWrap);
        inner.appendChild(node('div', 'nc-empty__title', '未选择任务'));
        inner.appendChild(node('div', 'nc-empty__desc', '从左侧列表选择一项任务查看详情，或按 N 新建任务。'));
        empty.appendChild(inner);
        return empty;
    }

    function buildDetailForm(task, doc) {
        var form = node('form', 'detail-form');
        form.setAttribute('novalidate', 'novalidate');

        /* 头部 */
        var head = node('div', 'detail-head');
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'nc-check detail-check';
        attr(check, 'data-field', 'status');
        attr(check, 'aria-label', '标记完成');
        head.appendChild(check);

        var headText = node('div', 'detail-head__text');
        var title = document.createElement('textarea');
        title.className = 'detail-title';
        title.rows = 1;
        attr(title, 'data-field', 'title');
        attr(title, 'aria-label', '任务标题');
        title.maxLength = 500;
        headText.appendChild(title);
        var sub = node('div', 'detail-head__sub');
        var badge = node('span', 'nc-badge');
        attr(badge, 'data-detail-status', '');
        sub.appendChild(badge);
        var saveHint = node('span', 'detail-savehint');
        attr(saveHint, 'data-detail-saved', '');
        sub.appendChild(saveHint);
        headText.appendChild(sub);
        head.appendChild(headText);

        var close = node('button', 'nc-btn nc-btn--icon detail-close');
        attr(close, 'type', 'button');
        attr(close, 'data-act', 'detail-close');
        attr(close, 'aria-label', '关闭详情');
        close.appendChild(icon('x', 16));
        head.appendChild(close);
        form.appendChild(head);

        /* 时间 */
        var timeSection = node('div', 'detail-section');
        timeSection.appendChild(node('div', 'detail-section__label', '截止时间'));
        var dueField = node('div', 'detail-field');
        dueField.appendChild(node('label', 'nc-label', '时间'));
        var dueWrap = node('div');
        var dueRow = node('div', 'detail-due-row');
        var dueInput = document.createElement('input');
        dueInput.type = 'datetime-local';
        dueInput.className = 'nc-input';
        attr(dueInput, 'data-field', 'due');
        attr(dueInput, 'aria-label', '截止时间');
        dueRow.appendChild(dueInput);
        var dueClear = node('button', 'nc-btn nc-btn--icon nc-btn--sm');
        attr(dueClear, 'type', 'button');
        attr(dueClear, 'data-act', 'due-clear');
        attr(dueClear, 'aria-label', '清除截止时间');
        dueClear.appendChild(icon('x', 14));
        dueRow.appendChild(dueClear);
        dueWrap.appendChild(dueRow);
        var quick = node('div', 'detail-quick');
        [
            { label: '今天 18:00', ts: util.startOfDay(Date.now()) + 18 * 3600000 },
            { label: '明天 09:00', ts: util.startOfDay(Date.now()) + 86400000 + 9 * 3600000 },
            { label: '下周一 09:00', ts: nextMonday() }
        ].forEach(function (item) {
            var chip = node('button', 'nc-chip', item.label);
            attr(chip, 'type', 'button');
            attr(chip, 'data-act', 'due-quick');
            attr(chip, 'data-ts', item.ts);
            quick.appendChild(chip);
        });
        dueWrap.appendChild(quick);
        dueField.appendChild(dueWrap);
        timeSection.appendChild(dueField);
        form.appendChild(timeSection);

        /* 属性 */
        var propSection = node('div', 'detail-section');
        propSection.appendChild(node('div', 'detail-section__label', '属性'));

        var prioField = node('div', 'detail-field');
        prioField.appendChild(node('label', 'nc-label', '优先级'));
        var prioSelect = document.createElement('select');
        prioSelect.className = 'nc-select';
        attr(prioSelect, 'data-field', 'priority');
        attr(prioSelect, 'aria-label', '优先级');
        ['low', 'normal', 'high', 'urgent'].forEach(function (value) {
            var option = document.createElement('option');
            option.value = value;
            option.textContent = PRIORITY_LABELS[value];
            prioSelect.appendChild(option);
        });
        prioField.appendChild(prioSelect);
        propSection.appendChild(prioField);

        var listField = node('div', 'detail-field');
        listField.appendChild(node('label', 'nc-label', '清单'));
        var listSelect = document.createElement('select');
        listSelect.className = 'nc-select';
        attr(listSelect, 'data-field', 'listId');
        attr(listSelect, 'aria-label', '所属清单');
        doc.lists.forEach(function (list) {
            var option = document.createElement('option');
            option.value = list.id;
            option.textContent = list.name;
            listSelect.appendChild(option);
        });
        listField.appendChild(listSelect);
        propSection.appendChild(listField);
        form.appendChild(propSection);

        /* 备注 */
        var notesSection = node('div', 'detail-section');
        notesSection.appendChild(node('div', 'detail-section__label', '备注'));
        var notesField = node('div', 'detail-field detail-field--stack');
        var notes = document.createElement('textarea');
        notes.className = 'nc-textarea';
        attr(notes, 'data-field', 'notes');
        attr(notes, 'aria-label', '任务备注');
        attr(notes, 'placeholder', '补充说明、链接或子步骤…');
        notes.maxLength = 20000;
        notesField.appendChild(notes);
        notesSection.appendChild(notesField);
        form.appendChild(notesSection);

        /* 标签 */
        var tagSection = node('div', 'detail-section');
        tagSection.appendChild(node('div', 'detail-section__label', '标签'));
        var tagField = node('div', 'detail-field detail-field--stack');
        var tagInput = document.createElement('input');
        tagInput.type = 'text';
        tagInput.className = 'nc-input';
        attr(tagInput, 'data-field', 'tags');
        attr(tagInput, 'aria-label', '标签，用逗号分隔');
        attr(tagInput, 'placeholder', '例如：汇报, 例行（逗号分隔）');
        tagField.appendChild(tagInput);
        var tagWrap = node('div', 'detail-tags');
        attr(tagWrap, 'data-detail-tags', '');
        tagField.appendChild(tagWrap);
        tagSection.appendChild(tagField);
        form.appendChild(tagSection);

        /* 元信息 */
        var metaSection = node('div', 'detail-section');
        metaSection.appendChild(node('div', 'detail-section__label', '信息'));
        var meta = node('div', 'detail-meta');
        attr(meta, 'data-detail-meta', '');
        metaSection.appendChild(meta);
        var metaId = node('div', 'detail-meta');
        metaId.textContent = 'ID：' + task.id;
        metaSection.appendChild(metaId);
        form.appendChild(metaSection);

        /* 底部操作 */
        var foot = node('div', 'detail-foot');
        var deleteBtn = node('button', 'nc-btn nc-btn--sm nc-btn--danger');
        attr(deleteBtn, 'type', 'button');
        attr(deleteBtn, 'data-act', 'detail-delete');
        deleteBtn.appendChild(icon('trash', 14));
        deleteBtn.appendChild(node('span', null, '删除'));
        foot.appendChild(deleteBtn);
        var restoreBtn = node('button', 'nc-btn nc-btn--sm nc-btn--primary');
        attr(restoreBtn, 'type', 'button');
        attr(restoreBtn, 'data-act', 'detail-restore');
        restoreBtn.appendChild(icon('refresh', 14));
        restoreBtn.appendChild(node('span', null, '恢复'));
        foot.appendChild(restoreBtn);
        var purgeBtn = node('button', 'nc-btn nc-btn--sm nc-btn--danger');
        attr(purgeBtn, 'type', 'button');
        attr(purgeBtn, 'data-act', 'detail-purge');
        purgeBtn.appendChild(icon('trash', 14));
        purgeBtn.appendChild(node('span', null, '彻底删除'));
        foot.appendChild(purgeBtn);
        var spacer = node('span', 'detail-foot__spacer');
        foot.appendChild(spacer);
        var completeBtn = node('button', 'nc-btn nc-btn--sm');
        attr(completeBtn, 'type', 'button');
        attr(completeBtn, 'data-act', 'detail-toggle');
        completeBtn.appendChild(icon('check', 14));
        completeBtn.appendChild(node('span', null, '完成'));
        foot.appendChild(completeBtn);
        form.appendChild(foot);
        return form;
    }

    function nextMonday() {
        var base = util.startOfDay(Date.now()) + 86400000;
        while (new Date(base).getDay() !== 1) base += 86400000;
        return base + 9 * 3600000;
    }

    function syncDetailForm(task, doc, force) {
        var root = els.detailInner;
        if (!root) return;
        var titleEl = root.querySelector('[data-field="title"]');
        var notesEl = root.querySelector('[data-field="notes"]');
        var dueEl = root.querySelector('[data-field="due"]');
        var priorityEl = root.querySelector('[data-field="priority"]');
        var listEl = root.querySelector('[data-field="listId"]');
        var tagsEl = root.querySelector('[data-field="tags"]');
        var checkEl = root.querySelector('[data-field="status"]');
        var statusBadge = root.querySelector('[data-detail-status]');
        var savedEl = root.querySelector('[data-detail-saved]');
        var metaEl = root.querySelector('[data-detail-meta]');
        var tagWrap = root.querySelector('[data-detail-tags]');
        var deleteBtn = root.querySelector('[data-act="detail-delete"]');
        var restoreBtn = root.querySelector('[data-act="detail-restore"]');
        var purgeBtn = root.querySelector('[data-act="detail-purge"]');
        var completeBtn = root.querySelector('[data-act="detail-toggle"]');
        var form = root.querySelector('.detail-form');
        if (!form || !titleEl) return;

        var active = document.activeElement;
        if (force || active !== titleEl) {
            if (titleEl.value !== task.title) titleEl.value = task.title;
            autoGrow(titleEl);
        }
        if (force || active !== notesEl) {
            if (notesEl.value !== task.notes) notesEl.value = task.notes;
        }
        if (force || active !== dueEl) {
            var dueValue = util.isFiniteNum(task.due) ? util.toDateTimeInputValue(task.due) : '';
            if (dueEl.value !== dueValue) dueEl.value = dueValue;
        }
        if (priorityEl.value !== task.priority) priorityEl.value = task.priority;
        if (listEl.value !== task.listId) listEl.value = task.listId;
        if (force || active !== tagsEl) {
            if (tagsEl.value !== task.tags.join(', ')) tagsEl.value = task.tags.join(', ');
        }

        var done = task.status === 'done';
        if (checkEl.checked !== done) checkEl.checked = done;
        if (statusBadge) {
            statusBadge.textContent = task.deletedAt ? '已删除' : done ? '已完成' : task.status === 'canceled' ? '已取消' : '进行中';
            statusBadge.className = 'nc-badge ' + (task.deletedAt ? 'nc-badge--danger' : done ? 'nc-badge--success' : 'nc-badge--accent');
        }
        if (savedEl) savedEl.textContent = util.relativeTime(task.updatedAt, Date.now());
        if (metaEl) metaEl.textContent = detailMetaText(task);

        if (tagWrap) {
            var sig = task.tags.join('\u0001');
            if (tagWrap.__sig !== sig) {
                tagWrap.__sig = sig;
                while (tagWrap.firstChild) tagWrap.removeChild(tagWrap.firstChild);
                task.tags.forEach(function (tag) {
                    var chip = node('span', 'detail-tag', tag);
                    var remove = node('button');
                    attr(remove, 'type', 'button');
                    attr(remove, 'data-act', 'tag-remove');
                    attr(remove, 'data-tag', tag);
                    attr(remove, 'aria-label', '移除标签：' + tag);
                    remove.appendChild(icon('x', 12));
                    chip.appendChild(remove);
                    tagWrap.appendChild(chip);
                });
            }
        }

        if (deleteBtn) deleteBtn.hidden = !!task.deletedAt;
        if (restoreBtn) restoreBtn.hidden = !task.deletedAt;
        if (purgeBtn) purgeBtn.hidden = !task.deletedAt;
        if (completeBtn) {
            completeBtn.hidden = !!task.deletedAt;
            completeBtn.lastChild && (completeBtn.lastChild.textContent = done ? '取消完成' : '完成');
        }
        attr(checkEl, 'aria-label', done ? '取消完成任务' : '完成任务');
    }

    function autoGrow(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        var next = textarea.scrollHeight || 0;
        if (next < 32) next = 32;
        textarea.style.height = Math.min(140, next) + 'px';
    }

    function scheduleDetailSave(field, apply, wait) {
        if (detailTimers[field]) {
            global.clearTimeout(detailTimers[field]);
            detailTimers[field] = null;
        }
        detailTimers[field] = global.setTimeout(function () {
            detailTimers[field] = null;
            apply();
        }, wait || 450);
    }

    function onDetailInput(event) {
        var field = event.target.getAttribute && event.target.getAttribute('data-field');
        var id = store.getUi().selectedId;
        if (!field || !id) return;
        var task = store.getTask(id);
        if (!task) return;
        if (field === 'title') {
            autoGrow(event.target);
            var titleValue = event.target.value;
            scheduleDetailSave('title', function () {
                var value = titleValue.trim();
                if (!value) return;
                var current = store.getTask(id);
                if (!current || value === current.title) return;
                store.updateTask(id, { title: value }, { label: '编辑任务' });
            }, 500);
        } else if (field === 'notes') {
            var notesValue = event.target.value;
            scheduleDetailSave('notes', function () {
                store.updateTask(id, { notes: notesValue }, { label: '编辑备注' });
            }, 600);
        } else if (field === 'tags') {
            var tagsValue = event.target.value;
            scheduleDetailSave('tags', function () {
                var tags = tagsValue.split(/[,，\s]+/).filter(Boolean);
                store.updateTask(id, { tags: tags }, { label: '编辑标签' });
            }, 500);
        }
    }

    function onDetailChange(event) {
        var field = event.target.getAttribute && event.target.getAttribute('data-field');
        var id = store.getUi().selectedId;
        if (!field || !id || !store.getTask(id)) return;
        if (field === 'status') {
            store.toggleTask(id);
        } else if (field === 'priority') {
            store.updateTask(id, { priority: event.target.value }, { label: '修改优先级' });
        } else if (field === 'listId') {
            store.moveTaskToList(id, event.target.value);
        } else if (field === 'due') {
            var ts = util.parseDateTimeInputValue(event.target.value);
            store.updateTask(id, { due: ts }, { label: '修改截止时间' });
        }
    }

    function onDetailBlur(event) {
        var field = event.target.getAttribute && event.target.getAttribute('data-field');
        if (field === 'title') {
            var id = store.getUi().selectedId;
            if (!id) return;
            if (!event.target.value.trim()) {
                var task = store.getTask(id);
                if (task) event.target.value = task.title;
            }
        }
    }

    function onDetailClick(event) {
        var btn = event.target.closest('[data-act]');
        var id = store.getUi().selectedId;
        if (!btn) return;
        var act = btn.getAttribute('data-act');
        if (act === 'detail-close') {
            store.closeDrawer();
            return;
        }
        if (!id) return;
        if (act === 'detail-delete') {
            var task = store.getTask(id);
            var result = store.deleteTask(id);
            if (result && ui) {
                ui.toast('已删除「' + (task ? task.title : '任务') + '」', {
                    type: 'success',
                    duration: 5000,
                    action: { label: '撤销', onClick: function () { store.undo(result.token); } }
                });
            }
        } else if (act === 'detail-restore') {
            store.restoreTask(id);
            ui.toast('已恢复任务', { type: 'success' });
        } else if (act === 'detail-purge') {
            var current = store.getTask(id);
            ui.confirm('彻底删除后无法恢复，确定继续吗？', { danger: true, confirmText: '彻底删除' }).then(function (ok) {
                if (!ok) return;
                store.purgeTask(id);
                ui.toast('已彻底删除', { type: 'success' });
            });
        } else if (act === 'detail-toggle') {
            store.toggleTask(id);
        } else if (act === 'due-clear') {
            store.updateTask(id, { due: null }, { label: '清除截止时间' });
        } else if (act === 'due-quick') {
            var ts = Number(btn.getAttribute('data-ts'));
            if (!util.isFiniteNum(ts)) return;
            store.updateTask(id, { due: ts }, { label: '修改截止时间' });
        } else if (act === 'tag-remove') {
            var tag = btn.getAttribute('data-tag');
            var task2 = store.getTask(id);
            if (!task2) return;
            store.updateTask(id, { tags: task2.tags.filter(function (item) { return item !== tag; }) }, { label: '移除标签' });
        }
    }

    function syncDetailColumn(ui) {
        if (!els.shell) return;
        var wide = !global.matchMedia || !global.matchMedia('(max-width: 1100px)').matches;
        toggleClass(els.shell, 'is-detail-hidden', wide && !ui.selectedId);
    }

    function syncDrawer(ui) {
        if (!els.detail) return;
        var mobile = global.matchMedia ? global.matchMedia('(max-width: 1100px)').matches : false;
        var open = mobile && ui.drawerOpen && !!ui.selectedId;
        toggleClass(els.detail, 'is-open', open);
        if (els.scrim) {
            if (open) {
                els.scrim.hidden = false;
                global.requestAnimationFrame(function () { els.scrim.classList.add('is-open'); });
            } else {
                els.scrim.classList.remove('is-open');
                els.scrim.hidden = true;
            }
        }
    }

    /* ------------------------------------------------------------------ *
     * 列表交互
     * ------------------------------------------------------------------ */
    function rowFromEvent(event) {
        return event.target.closest ? event.target.closest('.todo-item') : null;
    }

    function onListClick(event) {
        var groupToggle = event.target.closest('[data-act="toggle-completed"]');
        if (groupToggle) {
            store.toggleShowCompleted();
            return;
        }
        if (event.target.closest('input')) return;
        var row = rowFromEvent(event);
        if (!row) return;
        var id = row.getAttribute('data-id');
        var actBtn = event.target.closest('[data-act]');
        var act = actBtn ? actBtn.getAttribute('data-act') : null;
        if (act === 'delete' && actBtn.closest('.todo-item__actions')) {
            deleteWithUndo(id);
            return;
        }
        if (act === 'edit' && actBtn.closest('.todo-item__actions')) {
            beginInlineEdit(id);
            return;
        }
        store.selectTask(id);
    }

    function onListDblClick(event) {
        var row = rowFromEvent(event);
        if (!row || event.target.closest('input') || event.target.closest('.todo-item__actions')) return;
        beginInlineEdit(row.getAttribute('data-id'));
    }

    function onListChange(event) {
        if (!event.target.classList || !event.target.classList.contains('todo-item__check')) return;
        var row = rowFromEvent(event);
        if (!row) return;
        store.toggleTask(row.getAttribute('data-id'));
    }

    function onListKeydown(event) {
        var row = rowFromEvent(event);
        var body = event.target.closest ? event.target.closest('.todo-item__body') : null;
        if (!row || !body) return;
        var id = row.getAttribute('data-id');
        var key = event.key;

        if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
            event.preventDefault();
            moveByKeyboard(id, key === 'ArrowUp' ? -1 : 1);
            return;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault();
            var siblings = Array.prototype.filter.call(els.list.querySelectorAll('.todo-item__body'), function (item) { return true; });
            var index = siblings.indexOf(body);
            var nextIndex = key === 'ArrowDown' ? Math.min(siblings.length - 1, index + 1) : Math.max(0, index - 1);
            if (siblings[nextIndex]) siblings[nextIndex].focus();
            return;
        }
        if (key === 'Home' || key === 'End') {
            event.preventDefault();
            var all = els.list.querySelectorAll('.todo-item__body');
            if (!all.length) return;
            (key === 'Home' ? all[0] : all[all.length - 1]).focus();
            return;
        }
        if (key === ' ' || key === 'Spacebar') {
            event.preventDefault();
            store.toggleTask(id);
            return;
        }
        if (key === 'Enter') {
            event.preventDefault();
            store.selectTask(id);
            return;
        }
        if (key === 'e' || key === 'E') {
            event.preventDefault();
            beginInlineEdit(id);
            return;
        }
        if (key === 'Delete' || key === 'Backspace') {
            event.preventDefault();
            deleteWithUndo(id);
            return;
        }
        if (key === 'Escape') {
            event.preventDefault();
            body.blur();
            return;
        }
    }

    function moveByKeyboard(id, direction) {
        if (store.getDoc().settings.sort !== 'manual') {
            ui.toast('切换到「手动排序」后可调整顺序', { type: 'info' });
            return;
        }
        var visible = store.selectVisible();
        var index = -1;
        visible.tasks.forEach(function (task, i) { if (task.id === id) index = i; });
        if (index === -1) return;
        var target = visible.tasks[index + direction];
        if (!target) return;
        store.reorderTask(id, target.id, direction > 0 ? 'after' : 'before');
        var body = els.list.querySelector('.todo-item[data-id="' + util.cssEscape(id) + '"] .todo-item__body');
        if (body) body.focus();
    }

    function deleteWithUndo(id) {
        if (!id) return;
        var task = store.getTask(id);
        var result = store.deleteTask(id);
        if (!result) return;
        ui.toast('已删除「' + (task ? task.title : '任务') + '」', {
            type: 'success',
            duration: 5000,
            action: { label: '撤销', onClick: function () { store.undo(result.token); } }
        });
    }

    /* ---- 拖拽排序（manual 模式） ---- */
    var dragState = null;

    function onDragStart(event) {
        if (store.getDoc().settings.sort !== 'manual') {
            event.preventDefault();
            return;
        }
        var row = rowFromEvent(event);
        if (!row) return;
        dragState = { id: row.getAttribute('data-id') };
        row.classList.add('is-dragging');
        try {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', dragState.id);
        } catch (err) { /* ignore */ }
    }

    function onDragOver(event) {
        if (!dragState) return;
        var row = rowFromEvent(event);
        if (!row || row.getAttribute('data-id') === dragState.id) return;
        event.preventDefault();
        Array.prototype.forEach.call(els.list.querySelectorAll('.todo-item.is-drop-target'), function (item) {
            item.classList.remove('is-drop-target');
        });
        var rect = row.getBoundingClientRect();
        var after = event.clientY > rect.top + rect.height / 2;
        row.classList.add('is-drop-target');
        row.__dropAfter = after;
    }

    function onDragLeave(event) {
        var row = rowFromEvent(event);
        if (row) {
            row.classList.remove('is-drop-target');
            row.__dropAfter = false;
        }
    }

    function onDrop(event) {
        if (!dragState) return;
        var row = rowFromEvent(event);
        if (!row) return;
        event.preventDefault();
        var targetId = row.getAttribute('data-id');
        var after = !!row.__dropAfter;
        row.classList.remove('is-drop-target');
        if (targetId !== dragState.id) store.reorderTask(dragState.id, targetId, after ? 'after' : 'before');
        dragState = null;
    }

    function onDragEnd() {
        if (dragState) {
            var dragging = els.list.querySelector('.todo-item.is-dragging');
            if (dragging) dragging.classList.remove('is-dragging');
        }
        dragState = null;
        Array.prototype.forEach.call(els.list.querySelectorAll('.is-drop-target'), function (item) {
            item.classList.remove('is-drop-target');
        });
    }

    /* ------------------------------------------------------------------ *
     * 菜单 / 清单
     * ------------------------------------------------------------------ */
    function openSortMenu(anchor) {
        var current = store.getDoc().settings.sort;
        ui.openMenu(anchor, schema.SORTS.map(function (sort) {
            return {
                label: SORT_LABELS[sort],
                icon: sort === 'smart' ? 'sparkles' : sort === 'due' ? 'clock' : sort === 'created' ? 'calendar' : 'drag',
                hint: current === sort ? '当前' : '',
                onSelect: function () { store.setSort(sort); }
            };
        }), {
            onClose: function () { attr(els.sortBtn, 'aria-expanded', 'false'); }
        });
        attr(els.sortBtn, 'aria-expanded', 'true');
    }

    function openMoreMenu(anchor) {
        var doc = store.getDoc();
        var uiState = store.getUi();
        var items = [
            { label: 'AI 识别长文本', icon: 'sparkles', hint: 'AI', onSelect: function () { actions.openAi && actions.openAi(); } },
            { type: 'divider' },
            { label: '导出 JSON', icon: 'download', onSelect: function () { actions.exportJson && actions.exportJson(); } },
            { label: '导入 JSON', icon: 'upload', onSelect: function () { actions.importJson && actions.importJson(); } },
            { label: '恢复上次备份', icon: 'refresh', disabled: !store.hasBackup(), onSelect: function () { actions.restoreBackup && actions.restoreBackup(); } },
            { type: 'divider' },
            { label: doc.settings.showCompleted ? '隐藏已完成' : '显示已完成', icon: 'eye', onSelect: function () { store.toggleShowCompleted(); } },
            { label: '清空回收站', icon: 'trash', disabled: !store.counts(true).trash, onSelect: function () { actions.clearTrash && actions.clearTrash(); } },
            { label: '清空全部任务', icon: 'trash', danger: true, onSelect: function () { actions.clearAll && actions.clearAll(); } },
            { type: 'divider' },
            { label: '撤销' + (store.canUndo() ? '：' + store.undoLabel() : ''), icon: 'arrow-left', disabled: !store.canUndo(), hint: 'Ctrl+Z', onSelect: function () { undoWithToast(); } },
            { label: '重做', icon: 'arrow-right', disabled: !store.canRedo(), hint: 'Ctrl+Shift+Z', onSelect: function () { redoWithToast(); } },
            { type: 'divider' },
            { label: '载入示例数据', icon: 'sparkles', onSelect: function () { actions.demo && actions.demo(); } },
            { label: '快捷键与帮助', icon: 'command', hint: '?', onSelect: function () { actions.help && actions.help(); } }
        ];
        ui.openMenu(anchor, items, {
            onClose: function () { attr(els.menuBtn, 'aria-expanded', 'false'); }
        });
        attr(els.menuBtn, 'aria-expanded', 'true');
    }

    function openListMenu(id, anchor) {
        var doc = store.getDoc();
        var list = findList(doc, id);
        if (!list) return;
        ui.openMenu(anchor, [
            { label: '重命名', icon: 'edit', onSelect: function () { renameListFlow(list); } },
            { label: '设为默认清单', icon: 'check', disabled: doc.settings.defaultListId === id, onSelect: function () { setDefaultList(list); } },
            { type: 'divider' },
            { label: '删除清单', icon: 'trash', danger: true, disabled: id === 'list_default', onSelect: function () { deleteListFlow(list); } }
        ]);
    }

    function createListFlow() {
        ui.prompt({ title: '新建清单', message: '输入清单名称', placeholder: '例如：工作、个人', required: true, confirmText: '创建' })
            .then(function (name) {
                if (name == null) return;
                var list = store.addList(name);
                if (!list) ui.toast('创建失败，清单数量已达上限', { type: 'error' });
            });
    }

    function renameListFlow(list) {
        ui.prompt({ title: '重命名清单', value: list.name, required: true, confirmText: '保存' }).then(function (name) {
            if (name == null) return;
            store.renameList(list.id, name);
        });
    }

    function deleteListFlow(list) {
        ui.confirm('删除清单「' + list.name + '」后，其中的任务会移动到默认清单。确定继续吗？', {
            danger: true,
            confirmText: '删除清单'
        }).then(function (ok) {
            if (!ok) return;
            store.deleteList(list.id);
            ui.toast('清单已删除，任务已移动到默认清单', { type: 'success' });
        });
    }

    function setDefaultList(list) {
        store.updateSettings({ defaultListId: list.id });
        ui.toast('已设为默认清单', { type: 'success' });
    }

    function undoWithToast() {
        var label = store.undo();
        if (label) ui.toast('已撤销：' + label, { type: 'info', duration: 2200 });
        else ui.toast('没有可撤销的操作', { type: 'warn', duration: 1800 });
    }

    function redoWithToast() {
        var label = store.redo();
        if (label) ui.toast('已重做：' + label, { type: 'info', duration: 2200 });
        else ui.toast('没有可重做的操作', { type: 'warn', duration: 1800 });
    }

    /* ------------------------------------------------------------------ *
     * 添加任务
     * ------------------------------------------------------------------ */
    function focusComposer() {
        setComposerExpanded(true);
        if (els.newTitle) {
            els.newTitle.focus();
            els.newTitle.select();
        }
    }

    /**
     * 展开/收起创建区的详细字段（桌面与移动一致）。
     */
    function setComposerExpanded(expanded) {
        if (!els.composer || !els.composerExtra) return;
        var next = !!expanded;
        toggleClass(els.composer, 'is-expanded', next);
        els.composerExtra.hidden = !next;
        attr(els.composerToggle, 'aria-expanded', next ? 'true' : 'false');
    }

    function submitComposer() {
        if (!els.newTitle) return;
        var title = els.newTitle.value.trim();
        if (!title) {
            els.newTitle.classList.add('has-error');
            els.newTitle.focus();
            ui.toast('请输入任务标题', { type: 'warn', duration: 2000 });
            global.setTimeout(function () { els.newTitle.classList.remove('has-error'); }, 1600);
            return;
        }
        var due = els.newDue && els.newDue.value ? util.parseDateTimeInputValue(els.newDue.value) : null;
        var listId = els.newList ? els.newList.value : null;
        var priority = els.newPriority ? els.newPriority.value : 'normal';
        var notes = els.newNotes ? String(els.newNotes.value || '').trim() : '';
        var tags = composerTags.slice(0, 20);
        var task = store.addTask({ title: title, notes: notes, due: due, listId: listId, priority: priority, tags: tags });
        if (!task) {
            ui.toast('添加失败，请检查输入', { type: 'error' });
            return;
        }
        els.newTitle.value = '';
        if (els.newDue) els.newDue.value = '';
        if (els.newNotes) els.newNotes.value = '';
        resetComposerTags();
        clearQuickActive();
        setDraftActive(false);
        els.newTitle.focus();
        if (hasClass(els.composer, 'is-expanded')) {
            /* 连续录入时保留清单/优先级，收起日期 */
            setComposerExpanded(false);
        }
    }

    /* ------------------------------------------------------------------ *
     * 导出
     * ------------------------------------------------------------------ */
    NC.view = NC.view || {};
    NC.view.todo = {
        init: init,
        render: render,
        refreshTimes: refreshTimes,
        setActions: setActions,
        focusComposer: focusComposer,
        setComposerExpanded: setComposerExpanded,
        applyDraft: applyDraft,
        ensureExtras: ensureExtras,
        refreshQuickDue: refreshQuickDue,
        getComposerTags: function () { return composerTags.slice(); },
        undoWithToast: undoWithToast,
        redoWithToast: redoWithToast,
        openMoreMenu: openMoreMenu,
        els: els,
        destroy: function () {
            if (unsubscribe) unsubscribe();
            unsubscribe = null;
        }
    };
})(window);
