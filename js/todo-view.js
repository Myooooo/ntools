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
    var detailPending = Object.create(null);
    var unsubscribe = null;
    var timelineHost = null;
    var composer = null;
    var extrasReady = false;
    var timelineMounted = false;
    var timelineTried = false;
    var timelineAssetsRequested = false;
    var timelineAssetsFailed = false;
    var modeEnterTimer = null;
    var detailClosing = false;
    var detailClosingId = null;
    var detailAnimTimer = null;
    var detailOpenTimer = null;
    var lastDetailAnimId = null;

    var SORT_LABELS = { smart: '智能排序', due: '按截止时间', created: '按创建时间', manual: '手动排序' };
    var VIEW_LABELS = { all: '全部任务', today: '今天', week: '本周', overdue: '逾期', none: '无截止时间', done: '已完成', trash: '回收站' };
    var BUCKET_LABELS = { overdue: '逾期', today: '今天', tomorrow: '明天', later: '以后', none: '无截止时间' };
    var BUCKET_ORDER = ['overdue', 'today', 'tomorrow', 'later', 'none'];
    var PRIORITY_LABELS = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
    var RECURRENCE_LABELS = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' };
    var RECURRENCE_OPTIONS = [
        { value: '', label: '不重复' },
        { value: 'daily', label: '每天' },
        { value: 'weekly', label: '每周' },
        { value: 'monthly', label: '每月' },
        { value: 'yearly', label: '每年' }
    ];

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
        timelineHost = (NC.todoTimelineHost && typeof NC.todoTimelineHost.create === 'function')
            ? NC.todoTimelineHost.create({ els: els, node: node, toggleClass: toggleClass, store: store })
            : null;
        composer = (NC.todoComposer && typeof NC.todoComposer.create === 'function')
            ? NC.todoComposer.create({
                els: els, node: node, icon: icon, attr: attr, toggleClass: toggleClass,
                store: store, ui: ui, util: util, global: global,
                expandComposer: setComposerExpanded
            })
            : null;
        /* 应用「默认视图」偏好：每次进入待办都以设置为准（页面内切换仍会持久化当前选择） */
        try {
            var prefView = NC.prefs && NC.prefs.get ? NC.prefs.get('ntools.todo.defaultView', 'list') : 'list';
            if (prefView !== 'timeline') prefView = 'list';
            if (store.getDoc().settings.viewMode !== prefView) {
                store.updateSettings({ viewMode: prefView });
            }
        } catch (err) { /* ignore */ }
        bindRowModule();
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

    /**
     * 把行渲染模块需要的共享引用注入进去（todo-row.js）。
     * 只传对象引用与纯函数，不传可变标量，避免两处状态不同步。
     */
    function bindRowModule() {
        var row = NC.view && NC.view.todoRow;
        if (!row || typeof row.init !== 'function') {
            throw new Error('todo-row.js 未加载');
        }
        row.init({
            els: els,
            nodeMap: nodeMap,
            rendered: rendered,
            store: store,
            util: util,
            node: node,
            attr: attr,
            icon: icon,
            toggleClass: toggleClass,
            findList: findList,
            buildItems: buildItems,
            renderEmpty: renderEmpty,
            PRIORITY_LABELS: PRIORITY_LABELS,
            RECURRENCE_LABELS: RECURRENCE_LABELS
        });
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
        els.mainpane = els.page ? els.page.querySelector('.todo-mainpane') : null;
        els.hints = els.page ? els.page.querySelector('.todo-foot__hints') : null;
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

        /* Esc 关闭详情（捕获阶段，早于 todo.js 的全局 Esc；输入框内不拦截） */
        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape' || event.isComposing) return;
            var ui = store.getUi();
            if (!ui.selectedId) return;
            var active = document.activeElement;
            if (active && active.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
            event.preventDefault();
            if (!detailClosing) closeDetailAnimated();
        }, true);

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
            /* 详情列从 display:none 展开时宽度才可测；宽度变化后重算标题高度 */
            if (global.ResizeObserver) {
                var lastDetailWidth = -1;
                var detailObserver = new global.ResizeObserver(function (entries) {
                    var width = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0;
                    if (!width || Math.abs(width - lastDetailWidth) < 1) return;
                    lastDetailWidth = width;
                    var titleEl = els.detailInner.querySelector('[data-field="title"]');
                    if (titleEl) autoGrow(titleEl);
                });
                detailObserver.observe(els.detailInner);
            }
        }
        if (els.scrim) {
            els.scrim.addEventListener('click', function () {
                flushDetailEdits();
                closeDetailAnimated();
            });
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
        { kind: 'next-week', label: '下周五前' },
        { kind: 'month-end', label: '月底前' },
        { kind: 'clear', label: '清除' }
    ];

    function ensureExtras() {
        if (extrasReady) return;
        extrasReady = true;
        ensureAiButton();
        ensureModeSwitch();
        if (timelineHost) timelineHost.ensure();
        ensureTrashClearButton();
        ensureFooterHints();
        if (composer) composer.ensure();
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
                NC.todoAi.openDialog(composer ? composer.getPendingPaste() : '');
            } else {
                ui.toast('AI 识别模块未加载（js/todo-ai.js），请刷新页面重试', { type: 'warn' });
            }
        });
        actionsWrap.insertBefore(button, actionsWrap.firstChild);
        els.aiBtn = button;
    }

    function ensureModeSwitch() {
        if (!els.page || document.getElementById('todo-mode-seg')) {
            els.modeSeg = document.getElementById('todo-mode-seg');
            return;
        }
        /* seg 挂在 .tools-head__text（主区左缘固定），不随 mainpane 宽度变化 */
        var headText = els.page.querySelector('.tools-head__text');
        var actionsWrap = els.page.querySelector('.tools-head__actions');
        if (!headText && !actionsWrap) return;
        var seg = node('div', 'nc-seg todo-mode-seg');
        seg.id = 'todo-mode-seg';
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', '视图模式');
        [
            { mode: 'list', label: '列表' },
            { mode: 'timeline', label: '全景' }
        ].forEach(function (item) {
            var btn = node('button', 'nc-seg__btn', item.label);
            btn.type = 'button';
            attr(btn, 'data-mode', item.mode);
            btn.addEventListener('click', function (event) {
                /* 键盘激活（detail=0）不播内容动画 */
                setMode(item.mode, { animate: event.detail !== 0 });
            });
            seg.appendChild(btn);
        });
        if (headText) {
            var subtitle = headText.querySelector('.tools-subtitle');
            if (subtitle && subtitle.parentNode === headText) headText.insertBefore(seg, subtitle);
            else headText.appendChild(seg);
        } else {
            actionsWrap.insertBefore(seg, actionsWrap.firstChild);
        }
        els.modeSeg = seg;
    }

    function canAnimateMode() {
        if (NC.theme && typeof NC.theme.isLite === 'function' && NC.theme.isLite()) return false;
        if (util.prefersReducedMotion && util.prefersReducedMotion()) return false;
        return true;
    }

    /** 新视图方向性淡入 + 8px 位移 + 0.996 缩放（标准模式；Lite/reduced 即时）。 */
    function playModeEnter(toMode) {
        if (!els.mainpane || !canAnimateMode()) return;
        var direction = toMode === 'timeline' ? 'is-mode-entering--next' : 'is-mode-entering--prev';
        els.mainpane.classList.remove(
            'is-mode-entering',
            'is-mode-entering--next',
            'is-mode-entering--prev'
        );
        /* 强制一次样式计算，快速连续切换也能从起点重播 */
        void els.mainpane.offsetWidth;
        els.mainpane.classList.add('is-mode-entering', direction);
        if (modeEnterTimer) global.clearTimeout(modeEnterTimer);
        modeEnterTimer = global.setTimeout(function () {
            modeEnterTimer = null;
            if (els.mainpane) {
                els.mainpane.classList.remove(
                    'is-mode-entering',
                    'is-mode-entering--next',
                    'is-mode-entering--prev'
                );
            }
        }, 280);
    }

    function setSegActive(mode) {
        if (!els.modeSeg) return;
        Array.prototype.forEach.call(els.modeSeg.querySelectorAll('[data-mode]'), function (btn) {
            var active = btn.getAttribute('data-mode') === mode;
            toggleClass(btn, 'is-active', active);
            attr(btn, 'aria-pressed', active ? 'true' : 'false');
        });
    }

    /**
     * 切换列表/全景。状态同步提交（seg active / mount 立即生效），
     * 新视图内容再做 180ms 淡入（等效交叉淡入，避免延迟导致状态不一致）。
     * @param {'list'|'timeline'} mode
     * @param {{animate?:boolean}} [options]
     */
    function setMode(mode, options) {
        if (mode !== 'list' && mode !== 'timeline') return false;
        var opts = options || {};
        if (store.getDoc().settings.viewMode === mode) return true;
        /* 切换前先提交未落库的详情编辑，并收起列表检查器/全景覆盖层 */
        flushDetailEdits();
        if (store.getUi().selectedId || store.getUi().drawerOpen) store.clearSelection();
        setSegActive(mode);
        store.updateSettings({ viewMode: mode });
        if (opts.animate !== false) playModeEnter(mode);
        return true;
    }

    function syncModeSeg(doc) {
        if (!els.modeSeg) return;
        setSegActive(doc.settings.viewMode === 'timeline' ? 'timeline' : 'list');
    }

    /* ---- 回收站页头「清空回收站」按钮（有任务时显示） ---- */
    function ensureTrashClearButton() {
        if (!els.page || document.getElementById('todo-trash-clear')) {
            els.trashClear = document.getElementById('todo-trash-clear');
            return;
        }
        var actionsWrap = els.page.querySelector('.tools-head__actions');
        if (!actionsWrap) return;
        var btn = node('button', 'nc-btn nc-btn--sm nc-btn--danger todo-trash-clear');
        btn.type = 'button';
        btn.id = 'todo-trash-clear';
        attr(btn, 'data-act', 'clear-trash');
        attr(btn, 'aria-label', '清空回收站');
        attr(btn, 'title', '清空回收站');
        btn.appendChild(icon('trash', 14));
        var text = node('span', 'todo-trash-clear__text', '清空回收站');
        btn.appendChild(text);
        btn.hidden = true;
        btn.addEventListener('click', function () {
            if (actions.clearTrash) actions.clearTrash();
            else {
                ui.confirm('清空回收站中的任务？此操作不可撤销。', { danger: true, confirmText: '清空回收站' }).then(function (ok) {
                    if (!ok) return;
                    store.clearTrash();
                    ui.toast('回收站已清空', { type: 'success' });
                });
            }
        });
        actionsWrap.appendChild(btn);
        els.trashClear = btn;
    }

    function syncTrashClearButton(ui, counts) {
        if (!els.trashClear) return;
        var show = ui.view === 'trash' && counts && counts.trash > 0;
        els.trashClear.hidden = !show;
        if (els.mainpane) toggleClass(els.mainpane, 'is-trash-view', ui.view === 'trash');
    }

    /* ---- 底部快捷键提示：把 N / 补进静态提示条 ---- */
    function ensureFooterHints() {
        if (!els.hints || document.getElementById('todo-hint-new')) return;
        var newHint = node('span', null);
        newHint.id = 'todo-hint-new';
        newHint.appendChild(node('kbd', 'nc-kbd', 'N'));
        newHint.appendChild(document.createTextNode(' 新建'));
        var searchHint = node('span', null);
        searchHint.id = 'todo-hint-search';
        searchHint.appendChild(node('kbd', 'nc-kbd', '/'));
        searchHint.appendChild(document.createTextNode(' 搜索'));
        els.hints.insertBefore(searchHint, els.hints.firstChild);
        els.hints.insertBefore(newHint, els.hints.firstChild);
    }

    /* ---- 创建区「重复」选择 ---- */
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
        syncTrashClearButton(ui, counts);
        renderLists(doc, ui, counts);
        renderComposer(doc, ui);
        /* 全景模式下任务列表被 CSS 隐藏：跳过 diff，避免同一份数据渲染两遍。
         * 切回列表时 render() 会照常走一次完整 diff，数据不会过期。 */
        if (!timelineHost || !timelineHost.isMode(doc)) renderList(visible, ui, doc);
        renderDetail(ui, doc, reason);
        syncDetailAnimation(ui);
        autoCloseMissingDetail(ui);
        renderStatusBar(visible, counts, ui, doc);
        syncSort(ui, doc);
        syncSearchClear();
        syncDrawer(ui);
        syncDetailColumn(ui);
        if (timelineHost) timelineHost.sync(doc, ui);
        syncModeSeg(doc, ui);
        rendered.tickSig = bucketSignature(visible);
        rendered.initialized = true;
    }

    /* ------------------------------------------------------------------ *
     * 视图计数 / 清单
     * ------------------------------------------------------------------ */
    function renderViewState(ui, counts, doc) {
        var sig = [ui.view, ui.listId, counts.open, counts.today, counts.week, counts.overdue, counts.none, counts.done, counts.trash].join('|');
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
                else if (view === 'week') value = counts.week;
                else if (view === 'overdue') value = counts.overdue;
                else if (view === 'none') value = counts.none;
                else if (view === 'done') value = counts.done;
                else if (view === 'trash') value = counts.trash;
                counter.textContent = String(value);
                toggleClass(counter, 'is-empty', value === 0);
                toggleClass(counter, 'is-danger', (view === 'overdue' || view === 'trash') && value > 0);
            }
        });
        if (els.stats) {
            var todayStat = els.stats.querySelector('[data-stat="today"]');
            var weekStat = els.stats.querySelector('[data-stat="week"]');
            if (todayStat && weekStat) {
                todayStat.textContent = '今日完成 ' + counts.completedToday;
                weekStat.textContent = '本周完成 ' + counts.completedWeek;
            } else {
                els.stats.textContent = '今日完成 ' + counts.completedToday + '　本周完成 ' + counts.completedWeek;
            }
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

        /* 置顶分组：最顶部，且不与后续分组重复（回收站视图不做置顶分区） */
        var pinned = [];
        var rest = [];
        if (ui.view === 'trash') {
            rest = tasks;
        } else {
            tasks.forEach(function (task) {
                if (task.pinned === true) pinned.push(task);
                else rest.push(task);
            });
        }
        if (pinned.length) {
            items.push(makeGroupItem('pinned', '置顶', pinned.length, false, false));
            pinned.forEach(function (task) { items.push(makeTaskItem(task)); });
        }
        if (!rest.length) return items;

        if (ui.view === 'trash') {
            items.push(makeGroupItem('trash', '回收站', rest.length, false, false));
            rest.forEach(function (task) { items.push(makeTaskItem(task)); });
            return items;
        }
        if (visible.search) {
            items.push(makeGroupItem('search', '搜索结果', rest.length, false, false));
            rest.forEach(function (task) { items.push(makeTaskItem(task)); });
            return items;
        }
        if (ui.view === 'done') {
            items.push(makeGroupItem('done', '已完成', rest.length, false, false));
            rest.forEach(function (task) { items.push(makeTaskItem(task)); });
            return items;
        }

        var open = [];
        var done = [];
        var canceled = [];
        rest.forEach(function (task) {
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
        } else if (!visible.showCompleted && !visible.search && ui.view !== 'done') {
            /* 折叠状态下 store 会把已完成任务过滤掉，这里补回一个只有计数的分组头，
             * 否则整组消失、刷新后也无法再展开。 */
            var doneCount = 0;
            (doc.tasks || []).forEach(function (task) {
                if (!task || task.deletedAt || task.status !== 'done') return;
                if (ui.listId && task.listId !== ui.listId) return;
                doneCount += 1;
            });
            if (doneCount) items.push(makeGroupItem('done', '已完成', doneCount, true, false, false));
        }
        return items;
    }

    function makeGroupItem(key, label, count, collapsible, danger, expanded) {
        return { type: 'group', key: 'g:' + key, group: { key: key, label: label, count: count, collapsible: !!collapsible, danger: !!danger, expanded: expanded !== false } };
    }

    function makeTaskItem(task) { return { type: 'task', key: 't:' + task.id, task: task }; }

    /* 行渲染已拆到 todo-row.js：这里只做转发，调用点保持不变。 */
    function rowApi() { return NC.view && NC.view.todoRow; }

    function renderList(visible, ui, doc) {
        var row = rowApi();
        if (!row || typeof row.renderList !== 'function') return false;
        return row.renderList(visible, ui, doc);
    }

    function syncHeatClass(li, task, now) {
        var row = rowApi();
        if (!row || typeof row.syncHeatClass !== 'function') return false;
        return row.syncHeatClass(li, task, now);
    }

    function updateDueLabel(el, task, now) {
        var row = rowApi();
        if (!row || typeof row.updateDueLabel !== 'function') return false;
        return row.updateDueLabel(el, task, now);
    }

    /* 行内编辑入口：todo-row 拆出后必须在这里转发，否则点击「编辑」会 ReferenceError */
    function beginInlineEdit(id) {
        var row = rowApi();
        if (row && typeof row.beginInlineEdit === 'function') return row.beginInlineEdit(id);
        /* 兜底：至少让 store 进入编辑态，下一次渲染仍会生成输入框 */
        if (store && typeof store.startEdit === 'function') return store.startEdit(id);
        return false;
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
        } else if (ui.view === 'week') {
            variant = { icon: 'calendar', title: '本周没有待办', desc: '本周还没有安排任务，可以从今天开始规划。', action: 'new', actionLabel: '新建任务' };
        } else if (ui.view === 'none') {
            variant = { icon: 'inbox', title: '没有无截止时间的任务', desc: '这个视图只显示未设置截止时间的待办。' };
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
            updateDueLabel(li.__refs ? li.__refs.due : li.querySelector('.todo-item__due'), task, now);
            syncHeatClass(li, task, now);
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
            if (composer) composer.syncDetailQuick(detailTask);
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
        var repeatBadge = node('span', 'nc-badge nc-badge--accent');
        attr(repeatBadge, 'data-detail-repeat', '');
        repeatBadge.hidden = true;
        sub.appendChild(repeatBadge);
        var saveHint = node('span', 'detail-savehint');
        attr(saveHint, 'data-detail-saved', '');
        attr(saveHint, 'aria-live', 'polite');
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
        var dueClear = node('button', 'nc-btn nc-btn--icon nc-btn--sm detail-due-clear');
        attr(dueClear, 'type', 'button');
        attr(dueClear, 'data-act', 'due-clear');
        attr(dueClear, 'aria-label', '清除截止时间');
        attr(dueClear, 'title', '清除截止时间');
        dueClear.appendChild(icon('x', 14));
        dueRow.appendChild(dueClear);
        dueWrap.appendChild(dueRow);
        var quick = node('div', 'detail-quick');
        var quickOptions = composer ? composer.quickDueOptionList() : [];
        quickOptions.forEach(function (option) {
            if (option.kind === 'clear') return;   // 与日期右侧的 × 重复
            var chip = node('button', 'nc-chip todo-quick-chip', option.label);
            attr(chip, 'type', 'button');
            attr(chip, 'data-act', 'due-quick');
            attr(chip, 'data-quick-kind', option.kind);
            attr(chip, 'aria-pressed', 'false');
            if (option.kind === 'clear') toggleClass(chip, 'todo-quick-chip--danger', true);
            if (composer) composer.applyQuickChipMeta(chip, option);
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

        var repeatField = node('div', 'detail-field');
        repeatField.appendChild(node('label', 'nc-label', '重复'));
        var repeatSelect = document.createElement('select');
        repeatSelect.className = 'nc-select';
        attr(repeatSelect, 'data-field', 'recurrence');
        attr(repeatSelect, 'aria-label', '重复周期');
        RECURRENCE_OPTIONS.forEach(function (item) {
            var option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            repeatSelect.appendChild(option);
        });
        repeatField.appendChild(repeatSelect);
        propSection.appendChild(repeatField);
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
        var pinBtn = node('button', 'nc-btn nc-btn--sm');
        attr(pinBtn, 'type', 'button');
        attr(pinBtn, 'data-act', 'detail-pin');
        pinBtn.appendChild(icon('pin', 14));
        pinBtn.appendChild(node('span', null, '置顶'));
        foot.appendChild(pinBtn);
        var deleteBtn = node('button', 'nc-btn nc-btn--sm nc-btn--danger');
        attr(deleteBtn, 'type', 'button');
        attr(deleteBtn, 'data-act', 'detail-delete');
        deleteBtn.appendChild(icon('trash', 14));
        deleteBtn.appendChild(node('span', null, '删除'));
        foot.appendChild(deleteBtn);
        var restoreBtn = node('button', 'nc-btn nc-btn--sm nc-btn--primary');
        attr(restoreBtn, 'type', 'button');
        attr(restoreBtn, 'data-act', 'detail-restore');
        restoreBtn.appendChild(icon('rotate-ccw', 16));
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
        var saveBtn = node('button', 'nc-btn nc-btn--sm');
        attr(saveBtn, 'type', 'button');
        attr(saveBtn, 'data-act', 'detail-save');
        attr(saveBtn, 'aria-label', '保存任务详情');
        saveBtn.appendChild(icon('check', 14));
        saveBtn.appendChild(node('span', null, '保存'));
        foot.appendChild(saveBtn);
        form.appendChild(foot);
        return form;
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
        var saveBtn = root.querySelector('[data-act="detail-save"]');
        var pinBtn = root.querySelector('[data-act="detail-pin"]');
        var repeatSelect = root.querySelector('[data-field="recurrence"]');
        var repeatBadge = root.querySelector('[data-detail-repeat]');
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
        if (composer) composer.syncDetailQuick(task);
        if (priorityEl.value !== task.priority) priorityEl.value = task.priority;
        if (listEl.value !== task.listId) listEl.value = task.listId;
        if (repeatSelect) {
            var recurrenceValue = task.recurrence ? task.recurrence.freq : '';
            if (repeatSelect.value !== recurrenceValue) repeatSelect.value = recurrenceValue;
        }
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

        if (repeatBadge) {
            if (task.recurrence) {
                repeatBadge.hidden = false;
                repeatBadge.textContent = '循环：' + (RECURRENCE_LABELS[task.recurrence.freq] || '自定义');
            } else {
                repeatBadge.hidden = true;
            }
        }
        if (pinBtn) {
            pinBtn.hidden = !!task.deletedAt;
            toggleClass(pinBtn, 'is-active', task.pinned === true);
            pinBtn.lastChild && (pinBtn.lastChild.textContent = task.pinned ? '取消置顶' : '置顶');
            attr(pinBtn, 'aria-label', task.pinned ? '取消置顶' : '置顶任务');
            attr(pinBtn, 'aria-pressed', task.pinned ? 'true' : 'false');
        }
        if (deleteBtn) deleteBtn.hidden = !!task.deletedAt;
        if (restoreBtn) restoreBtn.hidden = !task.deletedAt;
        if (purgeBtn) purgeBtn.hidden = !task.deletedAt;
        if (saveBtn) {
            /* 保存按钮只管保存；完成由左上角 checkbox 负责；已删除任务按原逻辑不显示 */
            saveBtn.hidden = !!task.deletedAt;
        }
        attr(checkEl, 'aria-label', done ? '取消完成任务' : '完成任务');
    }

    function autoGrow(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        var next = textarea.scrollHeight || 0;
        if (next < 32) next = 32;
        /* 标题换行后完整展开：不再截到 140px；详情面板自身可滚动 */
        textarea.style.height = (next + 2) + 'px';
    }

    function scheduleDetailSave(field, apply, wait) {
        if (detailPending[field]) {
            global.clearTimeout(detailPending[field].timer);
            detailPending[field] = null;
        }
        var timer = global.setTimeout(function () {
            delete detailPending[field];
            apply();
        }, wait || 450);
        detailPending[field] = { timer: timer, apply: apply };
    }

    /** 切换视图模式 / 关闭抽屉前，先把详情里尚未落库的 debounce 编辑立即提交。 */
    function flushDetailEdits() {
        Object.keys(detailPending).forEach(function (field) {
            var item = detailPending[field];
            if (!item) return;
            global.clearTimeout(item.timer);
            delete detailPending[field];
            try { item.apply(); } catch (err) { /* ignore */ }
        });
        detailTimers = Object.create(null);
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
            toggleTaskWithFeedback(id);
        } else if (field === 'priority') {
            store.updateTask(id, { priority: event.target.value }, { label: '修改优先级' });
        } else if (field === 'listId') {
            store.moveTaskToList(id, event.target.value);
        } else if (field === 'due') {
            var ts = util.parseDateTimeInputValue(event.target.value);
            store.updateTask(id, { due: ts }, { label: '修改截止时间' });
        } else if (field === 'recurrence') {
            var freq = event.target.value;
            if (!freq) {
                store.updateTask(id, { recurrence: null }, { label: '取消重复' });
                return;
            }
            var current = store.getTask(id);
            var patch = {
                recurrence: {
                    freq: freq,
                    interval: 1,
                    byWeekday: [],
                    until: null,
                    count: null,
                    lastMaterializedAt: null,
                    lastCompletedAt: null
                }
            };
            if (current && !util.isFiniteNum(current.due)) {
                patch.due = composer ? composer.defaultDueForRecurrence() : null;
                ui.toast('已为循环任务设置默认截止时间', { type: 'info', duration: 2600 });
            }
            store.updateTask(id, patch, { label: '设置重复' });
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
            /* 先提交未落库编辑，再走收起动画（结束后清空选中） */
            flushDetailEdits();
            closeDetailAnimated();
            return;
        }
        if (!id) return;
        if (act === 'detail-delete') {
            /* 删除后自动收起详情（动画结束再删除/提示） */
            closeDetailAnimated(function () {
                var task = store.getTask(id);
                var result = store.deleteTask(id);
                if (result && ui) {
                    ui.toast('已删除「' + (task ? task.title : '任务') + '」', {
                        type: 'success',
                        duration: 5000,
                        action: { label: '撤销', onClick: function () { store.undo(result.token); } }
                    });
                }
            });
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
        } else if (act === 'detail-save') {
            saveDetailWithFeedback(id);
        } else if (act === 'detail-toggle') {
            /* 兼容旧按钮：仍按完成/取消完成处理 */
            toggleTaskWithFeedback(id);
        } else if (act === 'detail-pin') {
            togglePinWithFeedback(id);
        } else if (act === 'due-clear') {
            store.updateTask(id, { due: null }, { label: '清除截止时间' });
        } else if (act === 'due-quick') {
            var kind = btn.getAttribute('data-quick-kind');
            if (!kind) {
                /* 兼容旧详情 DOM（data-ts 静态快捷按钮） */
                var legacyTs = Number(btn.getAttribute('data-ts'));
                if (!util.isFiniteNum(legacyTs)) return;
                store.updateTask(id, { due: legacyTs }, { label: '修改截止时间' });
                return;
            }
            if (!NC.todoTime || typeof NC.todoTime.computeQuickDue !== 'function') {
                ui.toast('快捷时间模块未加载（js/todo-time.js）', { type: 'warn' });
                return;
            }
            if (kind === 'clear') {
                store.updateTask(id, { due: null }, { label: '清除截止时间' });
                return;
            }
            var ts = NC.todoTime.computeQuickDue(kind);
            if (!util.isFiniteNum(ts)) return;
            store.updateTask(id, { due: ts }, { label: '修改截止时间' });
        } else if (act === 'tag-remove') {
            var tag = btn.getAttribute('data-tag');
            var task2 = store.getTask(id);
            if (!task2) return;
            store.updateTask(id, { tags: task2.tags.filter(function (item) { return item !== tag; }) }, { label: '移除标签' });
        }
    }

    /**
     * 保存详情并关闭：先提交 debounce 中的编辑，再清空选中/关闭详情。
     * 不改变完成状态（完成由左上角 checkbox 负责）。
     */
    function saveDetailWithFeedback(id) {
        var task = store.getTask(id);
        if (!task) return;
        flushDetailEdits();
        /* toast 等关闭动画结束后再出现 */
        closeDetailAnimated(function () {
            ui.toast('已保存并关闭', { type: 'success', duration: 1800 });
        });
    }

    /* ---- 详情展开/收起动画编排 ---- */
    function canAnimateDetail() {
        if (NC.theme && typeof NC.theme.isLite === 'function' && NC.theme.isLite()) return false;
        if (util.prefersReducedMotion && util.prefersReducedMotion()) return false;
        return true;
    }

    function isMobileDetail() {
        return global.matchMedia ? global.matchMedia('(max-width: 1100px)').matches : false;
    }

    function playDetailOpen() {
        if (!els.detail || !canAnimateDetail()) return;
        /* 移动端 / timeline 覆盖抽屉本身有 220ms 滑入，不再叠加内容动画 */
        if (isMobileDetail() || store.getDoc().settings.viewMode === 'timeline') return;
        els.detail.classList.remove('is-detail-opening');
        void els.detail.offsetWidth;
        els.detail.classList.add('is-detail-opening');
        if (detailOpenTimer) global.clearTimeout(detailOpenTimer);
        detailOpenTimer = global.setTimeout(function () {
            detailOpenTimer = null;
            if (els.detail) els.detail.classList.remove('is-detail-opening');
        }, 230);
    }

    function cancelDetailClose() {
        if (detailAnimTimer) {
            global.clearTimeout(detailAnimTimer);
            detailAnimTimer = null;
        }
        detailClosing = false;
        detailClosingId = null;
        if (els.detail) {
            els.detail.classList.remove('is-detail-closing', 'is-detail-leaving');
            els.detail.style.removeProperty('--nc-detail-leave-w');
        }
    }

    /** 关闭详情：桌面内容先 140ms 退出动画再 clearSelection（列收起）；移动端等抽屉 220ms 滑出后再隐藏 scrim/清空。 */
    function closeDetailAnimated(after) {
        if (!els.detail) {
            store.clearSelection();
            if (after) after();
            return;
        }
        if (!canAnimateDetail() || !els.detail.offsetParent) {
            cancelDetailClose();
            els.detail.classList.remove('is-detail-opening');
            store.clearSelection();
            if (after) after();
            return;
        }
        if (detailClosing) return;
        detailClosing = true;
        detailClosingId = store.getUi().selectedId;
        els.detail.classList.remove('is-detail-opening');
        var overlay = isMobileDetail() || store.getDoc().settings.viewMode === 'timeline';
        if (overlay) {
            /* 抽屉滑出：立即移除 open 触发 transform 过渡；scrim 保持到结束后再 hidden */
            els.detail.classList.remove('is-open');
            if (els.scrim) els.scrim.classList.remove('is-open');
            detailAnimTimer = global.setTimeout(function () {
                detailAnimTimer = null;
                if (els.scrim) els.scrim.hidden = true;
                detailClosing = false;
                detailClosingId = null;
                store.clearSelection();
                if (after) after();
            }, 230);
        } else {
            /* 桌面：先把面板转成覆盖层（视觉位置不变），立刻收起栅格列，
               列表在面板下方展开、被面板遮住；面板再滑出淡出。
               这样宽度变化发生在遮罩之下，避免“内容刚淡出、宽度突然一跳”。 */
            var leaveWidth = els.detail.offsetWidth;
            els.detail.style.setProperty('--nc-detail-leave-w', leaveWidth + 'px');
            els.detail.classList.add('is-detail-leaving');
            els.detail.classList.add('is-detail-closing');
            if (els.shell) els.shell.classList.add('is-detail-hidden');
            detailAnimTimer = global.setTimeout(function () {
                detailAnimTimer = null;
                if (els.detail) {
                    els.detail.classList.remove('is-detail-closing', 'is-detail-leaving');
                    els.detail.style.removeProperty('--nc-detail-leave-w');
                }
                detailClosing = false;
                detailClosingId = null;
                store.clearSelection();
                if (after) after();
            }, 170);
        }
    }

    function syncDetailAnimation(ui) {
        if (!els.detail) return;
        if (!ui.selectedId) {
            lastDetailAnimId = null;
            return;
        }
        if (detailClosing && ui.selectedId !== detailClosingId) {
            cancelDetailClose();
        }
        if (!detailClosing && ui.selectedId !== lastDetailAnimId) {
            lastDetailAnimId = ui.selectedId;
            playDetailOpen();
        }
    }

    /** 任务被删除/彻底移除时，详情自动收起（trash 视图内查看已删除任务除外）。 */
    function autoCloseMissingDetail(ui) {
        if (!ui.selectedId || detailClosing) return;
        var task = store.getTask(ui.selectedId);
        if (!task) {
            closeDetailAnimated();
            return;
        }
        if (task.deletedAt && ui.view !== 'trash') closeDetailAnimated();
    }

    function syncDetailColumn(ui) {
        if (!els.shell) return;
        var wide = !global.matchMedia || !global.matchMedia('(max-width: 1100px)').matches;
        toggleClass(els.shell, 'is-detail-hidden', wide && !ui.selectedId);
    }

    function syncDrawer(ui) {
        if (!els.detail) return;
        var mobile = global.matchMedia ? global.matchMedia('(max-width: 1100px)').matches : false;
        var timeline = store.getDoc().settings.viewMode === 'timeline';
        var overlay = mobile || timeline;
        var open = overlay && ui.drawerOpen && !!ui.selectedId;
        toggleClass(els.detail, 'is-open', open);
        if (els.scrim) {
            if (open) {
                els.scrim.hidden = false;
                global.requestAnimationFrame(function () { els.scrim.classList.add('is-open'); });
            } else {
                els.scrim.classList.remove('is-open');
                /* 覆盖层关闭动画进行中：等抽屉滑出结束再 hidden（避免 scrim 先消失） */
                if (!(detailClosing && overlay)) els.scrim.hidden = true;
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
            /* 折叠：先让已完成行淡出，再真正移除（展开时新行自带 is-new 动画） */
            if (store.getDoc().settings.showCompleted) {
                var doneRows = [];
                Object.keys(nodeMap).forEach(function (key) {
                    var el = nodeMap[key];
                    if (el && el.classList && el.classList.contains('todo-item') &&
                        el.getAttribute('data-status') === 'done') {
                        doneRows.push(el);
                    }
                });
                if (doneRows.length) {
                    doneRows.forEach(function (el) { el.classList.add('is-collapsing'); });
                    global.setTimeout(function () { store.toggleShowCompleted(); }, 150);
                    return;
                }
            }
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
        if (act === 'pin' && actBtn.closest('.todo-item__actions')) {
            togglePinWithFeedback(id);
            return;
        }
        if (act === 'restore' && actBtn.closest('.todo-item__actions')) {
            if (store.restoreTask(id)) ui.toast('已恢复任务', { type: 'success', duration: 1800 });
            return;
        }
        if (act === 'purge' && actBtn.closest('.todo-item__actions')) {
            var purging = store.getTask(id);
            ui.confirm('彻底删除后无法恢复，确定继续吗？', { danger: true, confirmText: '彻底删除' }).then(function (ok) {
                if (!ok) return;
                store.purgeTask(id);
                ui.toast('已彻底删除「' + (purging ? purging.title : '任务') + '」', { type: 'success' });
            });
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
        toggleTaskWithFeedback(row.getAttribute('data-id'));
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
            toggleTaskWithFeedback(id);
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

    function toggleTaskWithFeedback(id) {
        var before = store.getTask(id);
        if (!before) return;
        var beforeStatus = before.status;
        var ok = store.toggleTask(id);
        if (!ok) return;
        var after = store.getTask(id);
        /* 普通完成：给一次短暂的完成动效（高频列表不做 stagger） */
        if (after && beforeStatus !== 'done' && after.status === 'done') {
            var li = nodeMap['t:' + id];
            if (li) {
                li.classList.add('is-completing');
                global.setTimeout(function () { li.classList.remove('is-completing'); }, 260);
            }
        }
    }

    function togglePinWithFeedback(id) {
        if (!id) return;
        var pinned = store.togglePin(id);
        if (pinned == null) return;
        ui.toast(pinned ? '已置顶' : '已取消置顶', { type: 'success', duration: 1600 });
        var li = nodeMap['t:' + id];
        if (li) {
            li.classList.add('is-repinned');
            global.setTimeout(function () { li.classList.remove('is-repinned'); }, 260);
        }
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
            { label: '恢复上次备份', icon: 'rotate-ccw', disabled: !store.hasBackup(), onSelect: function () { actions.restoreBackup && actions.restoreBackup(); } },
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
        var tags = composer ? composer.getTags().slice(0, 20) : [];
        var recurrence = composer && composer.getRecurrence() ? {
            freq: composer.getRecurrence(),
            interval: 1,
            byWeekday: [],
            until: null,
            count: null,
            lastMaterializedAt: null,
            lastCompletedAt: null
        } : null;
        var task = store.addTask({
            title: title,
            notes: notes,
            due: due,
            listId: listId,
            priority: priority,
            tags: tags,
            recurrence: recurrence
        });
        if (!task) {
            ui.toast('添加失败，请检查输入', { type: 'error' });
            return;
        }
        els.newTitle.value = '';
        if (els.newDue) els.newDue.value = '';
        if (els.newNotes) els.newNotes.value = '';
        if (composer) composer.reset();
        if (els.newRecurrence) els.newRecurrence.value = '';
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
        applyDraft: function (data) { return composer ? composer.applyDraft(data) : false; },
        ensureExtras: ensureExtras,
        refreshQuickDue: function () { if (composer) composer.refreshQuickDue(); },
        getComposerTags: function () { return composer ? composer.getTags() : []; },
        togglePinWithFeedback: togglePinWithFeedback,
        flushDetailEdits: flushDetailEdits,
        toggleTaskWithFeedback: toggleTaskWithFeedback,
        setMode: setMode,
        applyMode: function () { if (timelineHost) timelineHost.sync(store.getDoc(), store.getUi()); },
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
