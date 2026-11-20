/**
 * settings-panel.js — nTools 全局设置面板（模型端点 / Todo AI / 通用 / 数据 / 关于）
 * 经典脚本，依赖 core / icons / ui / llm-store / ai（可选 schema-chat）。
 * 挂载：NC.settingsPanel
 *
 * 交互：右侧 Sheet 滑入；分区导航；Esc / 遮罩关闭；焦点陷阱；字段即时保存并给出状态。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var icons = NC.icons;
    var ui = NC.ui;
    var events = NC.events;

    var sheet = null;
    var bodyEl = null;
    var navEl = null;
    var closeBtn = null;
    var statusEl = null;
    var statusTimer = null;
    var releaseTrap = null;
    var previousFocus = null;
    var currentSection = 'general';
    var editingProfileId = null;
    var sections = [];
    var built = false;
    var open = false;
    var pickerBtn = null;
    var pickerLabel = null;
    var settleTimer = null;

    function store() { return NC.store && NC.store.llm; }
    function ai() { return NC.ai; }

    function toast(message, type) { ui.toast(message, { type: type || 'info' }); }

    function setStatus(message, isError) {
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.classList.toggle('is-error', !!isError);
        statusEl.classList.add('is-visible');
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(function () {
            statusEl.classList.remove('is-visible');
        }, 2400);
    }

    /* 分区导航分组：10 个入口按「核心 / 工作台模块 / 系统」分三组，扫读更快 */
    var NAV_GROUPS = [
        { id: 'core', title: '核心' },
        { id: 'modules', title: '工作台模块' },
        { id: 'system', title: '系统' }
    ];

    function sectionMeta() {
        var moduleSections = (NC.modules && NC.modules.settingsSections)
            ? NC.modules.settingsSections()
            : [
                { id: 'todo', title: '待办事项', desc: 'Todo AI 识别与列表行为', icon: 'check-circle', group: 'modules' },
                { id: 'email', title: '邮箱维护', desc: '邮箱数据用量与备份入口', icon: 'mail', group: 'modules' },
                { id: 'notes', title: '笔记本', desc: '笔记库状态、默认视图与导出', icon: 'notebook-text', group: 'modules' },
                { id: 'nchat', title: 'nChat', desc: '当前端点与聊天入口', icon: 'messages-square', group: 'modules' },
                { id: 'workshop', title: '创意工坊', desc: '生成参数、内置工具与库用量', icon: 'wand', group: 'modules' }
            ];
        return [
            { id: 'general', title: '通用', desc: '主题、模式等基础设置', icon: 'settings', group: 'core' },
            { id: 'profiles', title: 'AI 端点', desc: 'OpenAI 或 BOCAI 兼容端点', icon: 'layers', group: 'core' }
        ].concat(moduleSections).concat([
            { id: 'data', title: '数据', desc: '备份、导入导出与本地数据清理', icon: 'download', group: 'system' },
            { id: 'about', title: '关于', desc: '版本、兼容性与快捷键', icon: 'info', group: 'system' }
        ]).concat(sections.map(function (section) {
            section.group = section.group || 'modules';
            return section;
        }));
    }

    function sectionGroup(id) {
        return id || 'modules';
    }

    /* 模块分区：保留入口，并给出「实时状态 + 实用默认值 + 快捷跳转」，
     * 不再显示「暂无可配置项」这种消极占位。 */
    var MODULE_TABS = ['notes', 'email', 'nchat', 'workshop'];

    var PREF_KEYS = {
        notesMode: 'ntools.notes.mode'
    };

    function prefGet(key, fallback) {
        try {
            var raw = global.localStorage.getItem(key);
            return raw == null ? fallback : raw;
        } catch (err) { return fallback; }
    }

    function prefSet(key, value) {
        try {
            global.localStorage.setItem(key, String(value));
            return true;
        } catch (err) { return false; }
    }

    /* ------------------------------------------------------------------ *
     * 基础组件
     * ------------------------------------------------------------------ */
    function field(labelText, control, hint) {
        var wrap = util.e('label', { class: 'sp-field' });
        wrap.appendChild(util.e('span', { class: 'sp-label', text: labelText }));
        wrap.appendChild(control);
        if (hint) wrap.appendChild(util.e('span', { class: 'sp-hint', text: hint }));
        return wrap;
    }

    function input(props) {
        return util.e('input', Object.assign({ class: 'nc-input', type: 'text', autocomplete: 'off' }, props || {}));
    }

    function button(label, opts) {
        var options = opts || {};
        var btn = util.e('button', {
            type: 'button',
            class: 'nc-btn' +
                (options.primary ? ' nc-btn--primary' : '') +
                (options.danger ? ' nc-btn--danger' : '') +
                (options.small ? ' nc-btn--sm' : '') +
                (options.ghost ? ' nc-btn--ghost' : '') +
                (options.iconOnly ? ' nc-btn--icon' : ''),
            text: label
        });
        if (options.icon && icons) {
            btn.textContent = '';
            btn.appendChild(icons.el(options.icon, options.iconSize || 15));
            if (!options.iconOnly && label) btn.appendChild(util.e('span', { text: label }));
        }
        if (options.onClick) btn.addEventListener('click', options.onClick);
        if (options.title) {
            btn.title = options.title;
            if (options.iconOnly || !label) btn.setAttribute('aria-label', options.title);
        }
        if (options.iconOnly && !options.title) btn.setAttribute('aria-label', label || '操作');
        return btn;
    }

    function switchField(labelText, checked, onChange) {
        var wrap = util.e('label', { class: 'nc-switch sp-switch' });
        var inputEl = util.e('input', { type: 'checkbox' });
        inputEl.checked = !!checked;
        inputEl.addEventListener('change', function () { onChange(inputEl.checked); });
        wrap.appendChild(inputEl);
        wrap.appendChild(util.e('span', { class: 'nc-switch__track' }));
        wrap.appendChild(util.e('span', { text: labelText }));
        return wrap;
    }

    function segmented(options, value, onChange) {
        var wrap = util.e('div', { class: 'nc-seg', role: 'group' });
        options.forEach(function (option) {
            var active = option.value === value;
            var btn = util.e('button', {
                type: 'button',
                class: 'nc-seg__btn' + (active ? ' is-active' : ''),
                text: option.label
            });
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.addEventListener('click', function () { onChange(option.value); });
            wrap.appendChild(btn);
        });
        return wrap;
    }

    function rangeRow(labelText, value, step, onChange) {
        var wrap = util.e('div', { class: 'sp-range' });
        var label = util.e('span', { class: 'sp-label sp-range__label', text: labelText });
        var range = util.e('input', {
            type: 'range', min: '0', max: '2', step: step,
            value: String(value), class: 'sp-range__input'
        });
        var numberBox = util.e('div', { class: 'nc-number sp-range__number' });
        var minus = util.e('button', {
            type: 'button', class: 'nc-number__btn',
            'aria-label': labelText + '减小', title: '减小'
        });
        minus.appendChild(icons.el('minus', 14));
        var number = util.e('input', {
            type: 'number', min: '0', max: '2', step: step,
            value: String(value), class: 'nc-number__input',
            'aria-label': labelText
        });
        var plus = util.e('button', {
            type: 'button', class: 'nc-number__btn',
            'aria-label': labelText + '增大', title: '增大'
        });
        plus.appendChild(icons.el('plus', 14));
        numberBox.appendChild(minus);
        numberBox.appendChild(number);
        numberBox.appendChild(plus);
        function paintProgress() {
            var min = Number(range.min) || 0;
            var max = Number(range.max) || 100;
            var current = Number(range.value) || 0;
            var pct = max > min ? ((current - min) / (max - min)) * 100 : 0;
            range.style.setProperty('--sp-range-progress', Math.max(0, Math.min(100, pct)) + '%');
        }
        function sync(source) {
            var v = Math.min(2, Math.max(0, Number(source.value) || 0));
            range.value = v;
            number.value = v;
            paintProgress();
            onChange(v);
        }
        range.addEventListener('input', function () { sync(range); });
        number.addEventListener('change', function () { sync(number); });
        function nudge(delta) {
            var next = Math.min(2, Math.max(0, Math.round((Number(number.value) || 0) + delta) * 100) / 100);
            number.value = String(next);
            sync(number);
        }
        minus.addEventListener('click', function () { nudge(-Number(step) || -0.01); });
        plus.addEventListener('click', function () { nudge(Number(step) || 0.01); });
        paintProgress();
        wrap.appendChild(label);
        wrap.appendChild(range);
        wrap.appendChild(numberBox);
        return wrap;
    }

    /* ------------------------------------------------------------------ *
     * 分区：Todo AI
     * ------------------------------------------------------------------ */
    /** 待办 tab：模块说明 + 原有 Todo AI 设置 */
    function renderTodoModule(container) {
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: '待办' }));
        info.appendChild(util.e('p', {
            class: 'sp-section-desc',
            text: '列表、回收站与快捷键使用默认值；下列配置只影响「从文本识别任务」。'
        }));
        head.appendChild(info);
        container.appendChild(head);
        var viewCard = moduleCard('默认视图', '打开待办事项时默认显示的视图；页面内仍可随时切换。');
        var viewRow = util.e('div', { class: 'sp-row' });
        viewRow.appendChild(util.e('span', { class: 'sp-row__label', text: '默认视图' }));
        var currentView = NC.prefs && NC.prefs.get ? NC.prefs.get('ntools.todo.defaultView', 'list') : 'list';
        if (currentView !== 'timeline') currentView = 'list';
        viewRow.appendChild(segmented([
            { value: 'list', label: '列表' },
            { value: 'timeline', label: '全景' }
        ], currentView, function (next) {
            if (NC.prefs && NC.prefs.set) NC.prefs.set('ntools.todo.defaultView', next);
            try {
                if (NC.store && NC.store.todo && NC.store.todo.updateSettings) {
                    NC.store.todo.updateSettings({ viewMode: next });
                }
            } catch (err) { /* ignore */ }
            setStatus(next === 'timeline' ? '打开待办时默认显示全景' : '打开待办时默认显示列表');
            toast(next === 'timeline' ? '默认视图：全景' : '默认视图：列表', 'success');
        }));
        viewCard.appendChild(viewRow);
        container.appendChild(viewCard);

        renderTodoAi(container);
    }

    /** 模块 tab：实时状态 + 默认偏好 + 快捷操作 */
    function renderModuleTab(container, id) {
        var meta = sectionMeta().filter(function (item) { return item.id === id; })[0] || {};
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: meta.title || id }));
        info.appendChild(util.e('p', { class: 'sp-section-desc', text: meta.desc || '' }));
        head.appendChild(info);
        container.appendChild(head);

        if (id === 'notes') renderNotesModule(container);
        else if (id === 'email') renderEmailModule(container);
        else if (id === 'nchat') renderChatModule(container);
        else if (id === 'workshop') {
            if (NC.settingsWorkshop && typeof NC.settingsWorkshop.render === 'function') {
                NC.settingsWorkshop.render(container, {
                    util: util, ui: ui, toast: toast, setStatus: setStatus,
                    moduleCard: moduleCard, moduleRows: moduleRows, button: button,
                    switchField: switchField, segmented: segmented,
                    openModule: openModule, renderSection: renderSection
                });
            } else {
                container.appendChild(util.e('p', { class: 'sp-hint', text: '创意工坊设置模块未加载' }));
            }
        }
    }

    function moduleCard(title, desc) {
        var card = util.e('div', { class: 'sp-data-card' });
        card.appendChild(util.e('div', { class: 'sp-data-card__title', text: title }));
        if (desc) card.appendChild(util.e('div', { class: 'sp-data-card__desc', text: desc }));
        return card;
    }

    function moduleRows(card, pairs) {
        var rows = util.e('div', { class: 'sp-rows' });
        pairs.forEach(function (pair) {
            var row = util.e('div', { class: 'sp-row' });
            row.appendChild(util.e('span', { class: 'sp-row__label', text: pair[0] }));
            row.appendChild(util.e('span', { class: 'sp-row__value', text: pair[1] }));
            rows.appendChild(row);
        });
        card.appendChild(rows);
        return rows;
    }

    function modulePrefRow(card, label, options, value, onChange) {
        var row = util.e('div', { class: 'sp-row' });
        row.appendChild(util.e('span', { class: 'sp-row__label', text: label }));
        row.appendChild(segmented(options, value, function (next) {
            prefSet(onChange && onChange.key ? onChange.key : '', next);
            onChange.onChange(next);
        }));
        card.appendChild(row);
        return row;
    }

    function openModule(tab) {
        close();
        if (NC.switchTab) NC.switchTab(tab, true);
    }

    function renderNotesModule(container) {
        var notesStore = NC.store && NC.store.notes;
        var ready = !!(notesStore && notesStore.isReady && notesStore.isReady());
        var count = 0;
        var folders = 0;
        var engine = '尚未加载';
        try {
            if (ready) {
                count = notesStore.quickSwitch('').length;
                folders = (notesStore.getFolders() || []).length;
                var st = notesStore.saveState ? notesStore.saveState() : {};
                engine = st.mode === 'idb' ? 'IndexedDB' : 'localStorage 降级';
                if (st.readOnly) engine += ' · 只读镜像';
            }
        } catch (err) { /* ignore */ }

        var status = moduleCard('模块状态', '打开一次「笔记」后这里会显示真实用量。');
        moduleRows(status, [
            ['笔记', ready ? count + ' 篇' : '尚未加载'],
            ['文件夹', ready ? folders + ' 个' : '—'],
            ['存储', engine]
        ]);
        container.appendChild(status);

        var prefs = moduleCard('默认偏好', '打开笔记时使用的初始视图（可随时用 Ctrl+E 切换）。');
        var current = prefGet(PREF_KEYS.notesMode, 'edit') === 'read' ? 'read' : 'edit';
        modulePrefRow(prefs, '打开时', [
            { value: 'edit', label: '编辑' },
            { value: 'read', label: '阅读' }
        ], current, {
            key: PREF_KEYS.notesMode,
            onChange: function () { setStatus('已保存笔记默认视图'); }
        });
        container.appendChild(prefs);

        var actions = moduleCard('快捷操作');
        var bar = util.e('div', { class: 'sp-data-card__actions' });
        bar.appendChild(button('打开笔记', { small: true, icon: 'notebook-text', onClick: function () { openModule('md'); } }));
        bar.appendChild(button('导出 JSON', {
            small: true, ghost: true, icon: 'download',
            onClick: function () { exportNotes('json'); }
        }));
        bar.appendChild(button('导出 ZIP（含图片）', {
            small: true, ghost: true, icon: 'download',
            onClick: function () { exportNotes('zip'); }
        }));
        actions.appendChild(bar);
        container.appendChild(actions);
    }

    function renderEmailModule(container) {
        var doc = readEmailData();
        var groups = doc && Array.isArray(doc.groups) ? doc.groups.length : 0;
        var emails = doc && Array.isArray(doc.emails) ? doc.emails.length : 0;
        var bytes = 0;
        try {
            var raw = global.localStorage.getItem(EMAIL_DOC_KEY);
            bytes = raw ? raw.length : 0;
        } catch (err) { bytes = 0; }

        var status = moduleCard('模块状态', '邮件数据保存在本机单文档 ntools.email.v1，写后校验。');
        moduleRows(status, [
            ['邮箱地址', emails + ' 条'],
            ['分组', groups + ' 个'],
            ['占用', util.formatBytes(bytes)]
        ]);
        container.appendChild(status);

        var actions = moduleCard('快捷操作');
        var bar = util.e('div', { class: 'sp-data-card__actions' });
        bar.appendChild(button('打开邮件', { small: true, icon: 'mail', onClick: function () { openModule('email'); } }));
        bar.appendChild(button('导出邮箱 JSON', { small: true, ghost: true, icon: 'download', onClick: exportEmailJson }));
        bar.appendChild(button('导入邮箱 JSON', { small: true, ghost: true, icon: 'upload', onClick: importEmailJson }));
        actions.appendChild(bar);
        actions.appendChild(util.e('p', {
            class: 'sp-hint',
            text: '导出的 JSON 只包含分组与地址，可单独迁移；整体备份与恢复在邮件页「备份恢复」里。'
        }));
        container.appendChild(actions);
    }

    function renderChatModule(container) {
        var doc = store().getState();
        var profile = doc.profiles.filter(function (item) { return item.id === doc.currentProfileId; })[0];
        var status = moduleCard('模块状态', '聊天与 Todo AI 共用同一个当前端点。');
        moduleRows(status, [
            ['当前端点', profile ? profile.name : '未配置'],
            ['模型', profile && profile.modelId ? profile.modelId : '—'],
            ['图片输入', profile && profile.capabilities && profile.capabilities.vision === false ? '已关闭' : '已开启'],
            ['会话存储', NC.store.conversation && NC.store.conversation.getStorageInfo
                ? (NC.store.conversation.getStorageInfo().mode === 'indexedDB' ? 'IndexedDB' : 'localStorage')
                : '首次进入 nChat 后可用']
        ]);
        container.appendChild(status);

        var actions = moduleCard('快捷操作');
        var bar = util.e('div', { class: 'sp-data-card__actions' });
        bar.appendChild(button('打开 nChat', { small: true, icon: 'sparkles', onClick: function () { openModule('nchat'); } }));
        bar.appendChild(button('配置端点', {
            small: true, ghost: true, icon: 'layers',
            onClick: function () { editingProfileId = null; renderSection('profiles'); }
        }));
        bar.appendChild(button('系统提示词', {
            small: true, ghost: true, icon: 'edit',
            onClick: function () {
                close();
                if (NC.view && NC.view.chatPrompt && NC.view.chatPrompt.open) {
                    NC.view.chatPrompt.open(NC.chatEmbed ? NC.chatEmbed.getCurrentProfileId() : null);
                } else {
                    toast('先打开一次 nChat，再设置系统提示词', 'info');
                }
            }
        }));
        actions.appendChild(bar);
        container.appendChild(actions);
    }

    function appendInfoLine(card, text) {
        var line = util.e('div', { class: 'sp-row' });
        line.appendChild(util.e('span', { class: 'sp-row__label', text: '当前' }));
        line.appendChild(util.e('span', { class: 'sp-row__value', text: text }));
        card.appendChild(line);
    }

    function reportNotesUsage(card) {
        var notesStore = NC.store && NC.store.notes;
        if (!notesStore || !notesStore.saveState) {
            appendInfoLine(card, '笔记模块尚未加载（打开一次「笔记」页后再看）');
            return;
        }
        var state = {};
        try { state = notesStore.saveState() || {}; } catch (err) { state = {}; }
        var count = 0;
        try { count = notesStore.quickSwitch('').length; } catch (err) { count = 0; }
        appendInfoLine(card, count + ' 篇 · 存储 ' + (state.mode === 'idb' ? 'IndexedDB' : 'localStorage 降级') +
            (state.readOnly ? ' · 只读镜像' : ''));
    }

    function reportEmailUsage(card) {
        var raw = null;
        try { raw = global.localStorage.getItem('ntools.email.v1'); } catch (err) { raw = null; }
        if (!raw) { appendInfoLine(card, '还没有邮件数据'); return; }
        var doc = null;
        try { doc = JSON.parse(raw); } catch (err) { doc = null; }
        var groups = doc && Array.isArray(doc.groups) ? doc.groups.length : 0;
        var emails = doc && Array.isArray(doc.emails) ? doc.emails.length : 0;
        appendInfoLine(card, emails + ' 个邮箱 · ' + groups + ' 个分组 · ' + Math.round(raw.length / 1024) + ' KB');
    }

    function renderTodoAi(container) {
        var doc = store().getState();
        var todoAi = doc.todoAi;
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: 'Todo AI 识别' }));
        info.appendChild(util.e('p', { class: 'sp-section-desc', text: '粘贴工作邮件/会议纪要时，用该配置提取任务字段。' }));
        head.appendChild(info);
        container.appendChild(head);

        var form = util.e('div', { class: 'sp-form-grid' });
        var profileSelect = util.e('select', { class: 'nc-select' });
        profileSelect.appendChild(util.e('option', { value: '', text: '跟随当前端点（推荐）' }));
        doc.profiles.forEach(function (profile) {
            profileSelect.appendChild(util.e('option', { value: profile.id, text: profile.name }));
        });
        profileSelect.value = todoAi.profileId || '';
        form.appendChild(field('使用端点', profileSelect, '留空则使用聊天页当前端点'));

        var prompt = util.e('textarea', { class: 'nc-textarea sp-prompt sp-prompt--tall', rows: '8', spellcheck: 'false' });
        prompt.value = todoAi.systemPrompt;
        var promptField = field('系统提示词', prompt,
            '可用占位符：{{NOW}} 当前时间、{{DATE}} 日期、{{WEEKDAY}} 星期、{{TZ}} 时区、{{WORK_END}} 下班时间（调用时自动替换）');
        promptField.classList.add('sp-form-full');
        form.appendChild(promptField);

        var temp = todoAi.temperature;
        var topP = todoAi.topP;
        form.appendChild(rangeRow('Temperature', temp, '0.1', function (v) { temp = v; }));
        form.appendChild(rangeRow('Top P', topP, '0.05', function (v) { topP = v; }));
        container.appendChild(form);

        var preview = util.e('div', { class: 'sp-prompt-preview' });
        function updatePreview() {
            var text = prompt.value;
            var now = new Date();
            var weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
            var tz = '本地';
            try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (err) { /* ignore */ }
            var sample = text
                .replace(/\{\{NOW\}\}/g, util.formatDateTime(now.getTime()))
                .replace(/\{\{DATE\}\}/g, util.formatDate(now.getTime(), true))
                .replace(/\{\{WEEKDAY\}\}/g, weekday)
                .replace(/\{\{TZ\}\}/g, tz)
                .replace(/\{\{WORK_END\}\}/g, store().getWorkEndTime());
            preview.textContent = sample;
        }
        prompt.addEventListener('input', updatePreview);
        updatePreview();
        preview.classList.add('sp-form-full');
        container.appendChild(util.e('div', { class: 'sp-preview-label', text: '调用时的提示词预览（每次调用会注入最新时间）' }));
        container.appendChild(preview);

        var actions = util.e('div', { class: 'sp-editor-actions' });
        actions.appendChild(button('恢复默认提示词', {
            ghost: true, small: true,
            onClick: function () {
                prompt.value = store().DEFAULT_TODO_PROMPT;
                updatePreview();
                toast('已填入默认提示词，保存后生效', 'info');
            }
        }));
        actions.appendChild(button('保存', {
            primary: true, small: true, icon: 'check',
            onClick: function () {
                store().setTodoAi({
                    profileId: profileSelect.value || null,
                    systemPrompt: prompt.value,
                    temperature: temp,
                    topP: topP
                });
                setStatus('已保存 Todo AI 配置');
                toast('Todo AI 配置已保存', 'success');
            }
        }));
        container.appendChild(actions);
    }

    /* ------------------------------------------------------------------ *
     * 分区：通用
     * ------------------------------------------------------------------ */
    function renderGeneral(container) {
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: '通用' }));
        info.appendChild(util.e('p', { class: 'sp-section-desc', text: '外观与工作习惯设置。' }));
        head.appendChild(info);
        container.appendChild(head);

        var rows = util.e('div', { class: 'sp-rows' });

        var themeRow = util.e('div', { class: 'sp-row' });
        themeRow.appendChild(util.e('span', { class: 'sp-row__label', text: '主题' }));
        themeRow.appendChild(segmented([
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' }
        ], NC.theme.isLight() ? 'light' : 'dark', function (value) {
            NC.theme.set(value);
            renderSection('general');
        }));
        rows.appendChild(themeRow);

        var liteRow = util.e('div', { class: 'sp-row' });
        liteRow.appendChild(util.e('span', { class: 'sp-row__label', text: 'Lite 模式' }));
        liteRow.appendChild(switchField('关闭模糊、阴影与位移动画，优先性能', NC.theme.isLite(), function (checked) {
            NC.theme.setLite(checked);
            renderSection('general');
        }));
        rows.appendChild(liteRow);

        /* 启动时默认页面：选项即左侧导航的模块 */
        var startRow = util.e('div', { class: 'sp-row' });
        startRow.appendChild(util.e('span', { class: 'sp-row__label', text: '启动时默认页面' }));
        var startSelect = util.e('select', { class: 'nc-select sp-select--start' });
        var tabTitles = (typeof NC.tabTitles === 'function' ? NC.tabTitles() : null) || {
            todo: '待办事项', email: '邮箱维护', nchat: 'nChat', md: '笔记本', workshop: '创意工坊'
        };
        var currentStart = typeof NC.getStartTab === 'function' ? NC.getStartTab() : 'todo';
        var startOptions = (NC.modules && NC.modules.startOptions)
            ? NC.modules.startOptions()
            : ['todo', 'email', 'md', 'nchat', 'workshop'].map(function (tab) {
                return { id: tab, label: tabTitles[tab] || tab };
            });
        startOptions.forEach(function (entry) {
            if (!tabTitles[entry.id]) return;
            var option = util.e('option', { value: entry.id, text: entry.label || tabTitles[entry.id] });
            if (entry.id === currentStart) option.selected = true;
            startSelect.appendChild(option);
        });
        startSelect.addEventListener('change', function () {
            if (typeof NC.setStartTab !== 'function') return;
            NC.setStartTab(startSelect.value);
            var label = tabTitles[startSelect.value] || startSelect.value;
            setStatus('启动页面已设为「' + label + '」');
            toast('下次启动将打开「' + label + '」', 'success');
        });
        var startWrap = util.e('div', { class: 'sp-row__control' });
        startWrap.appendChild(startSelect);
        startWrap.appendChild(util.e('span', { class: 'sp-hint', text: '打开 ntools.html 且地址栏没有 #标签 时生效（默认待办事项）' }));
        startRow.appendChild(startWrap);
        rows.appendChild(startRow);

        var workEnd = util.e('input', { type: 'time', class: 'nc-input sp-time', value: store().getWorkEndTime() });
        workEnd.addEventListener('change', function () {
            if (store().setWorkEndTime(workEnd.value)) {
                setStatus('下班时间已更新为 ' + workEnd.value);
                toast('下班时间：' + workEnd.value, 'success');
            } else {
                toast('时间格式无效', 'error');
                workEnd.value = store().getWorkEndTime();
            }
        });
        var workRow = util.e('div', { class: 'sp-row' });
        workRow.appendChild(util.e('span', { class: 'sp-row__label', text: '下班时间' }));
        var workWrap = util.e('div', { class: 'sp-row__control' });
        workWrap.appendChild(workEnd);
        workWrap.appendChild(util.e('span', { class: 'sp-hint', text: '影响 Todo 快捷时间「下班前 / 明天前 / 周五前 / 月底前」' }));
        workRow.appendChild(workWrap);
        rows.appendChild(workRow);

        var nowRow = util.e('div', { class: 'sp-row' });
        nowRow.appendChild(util.e('span', { class: 'sp-row__label', text: '本地存储' }));
        var chatStorage = NC.store.conversation && NC.store.conversation.getStorageInfo
            ? NC.store.conversation.getStorageInfo()
            : null;
        var storageText = NC.storage.memoryMode()
            ? '不可用（内存模式，关闭页面后数据丢失）'
            : (chatStorage && chatStorage.mode === 'indexedDB' ? '可用（IndexedDB）' : '可用（localStorage）');
        nowRow.appendChild(util.e('span', { class: 'sp-row__value' + (NC.storage.memoryMode() ? ' is-error' : ''), text: storageText }));
        rows.appendChild(nowRow);

        container.appendChild(rows);
    }

    /* ------------------------------------------------------------------ *
     * 分区：数据
     * ------------------------------------------------------------------ */
    /* ---------------- 笔记数据辅助 ---------------- */
    function ensureNotesReady(cb) {
        var notesStore = NC.store && NC.store.notes;
        if (notesStore && notesStore.isReady && notesStore.isReady()) { cb(notesStore); return; }
        if (typeof NC.loadNotesBundle !== 'function') { cb(null); return; }
        toast('正在准备笔记数据…', 'info');
        NC.loadNotesBundle().then(function () {
            if (NC.store.notes && NC.store.notes.init) NC.store.notes.init();
            var wait = function (tries) {
                var ready = NC.store.notes && NC.store.notes.isReady && NC.store.notes.isReady();
                if (ready || tries <= 0) { cb(ready ? NC.store.notes : null); return; }
                setTimeout(function () { wait(tries - 1); }, 120);
            };
            wait(40);
        }, function () { cb(null); });
    }

    function exportNotes(kind) {
        ensureNotesReady(function (notesStore) {
            if (!notesStore) { toast('笔记模块加载失败', 'error'); return; }
            if (kind === 'zip') {
                if (!NC.zip) { toast('打包模块未加载', 'error'); return; }
                var bundle = notesStore.exportBundle();
                var files = (bundle.notes || []).map(function (note) {
                    return { name: (note.title || '未命名') + '.md', data: note.content || '' };
                });
                files.push({ name: '_ntools-notes.json', data: JSON.stringify(bundle, null, 2) });
                notesStore.flush().then(function () {
                    return NC.notesDb && NC.notesDb.getAllFiles ? NC.notesDb.getAllFiles() : [];
                }).then(function (records) {
                    var images = (records || []).filter(function (r) { return r && r.blob && r.name; });
                    return Promise.all(images.map(function (r) {
                        if (!r.blob.arrayBuffer) return null;
                        return r.blob.arrayBuffer().then(function (buf) {
                            return { name: '图片/' + r.name, data: new Uint8Array(buf) };
                        }).catch(function () { return null; });
                    })).then(function (pairs) {
                        var bytes = NC.zip.build(files.concat(pairs.filter(Boolean)));
                        var ok = util.downloadBlob('ntools-notes-' + Date.now() + '.zip',
                            new Blob([bytes], { type: 'application/zip' }), 'application/zip');
                        if (ok) toast('已导出 ' + (bundle.notes || []).length + ' 篇笔记（含图片）', 'success');
                        else toast('导出失败：浏览器阻止了下载', 'error');
                    });
                });
                return;
            }
            notesStore.flush().then(function () {
                var bundle = notesStore.exportBundle();
                var ok = util.downloadBlob('ntools-notes-' + Date.now() + '.json',
                    JSON.stringify(bundle, null, 2), 'application/json');
                toast(ok ? '已导出 ' + (bundle.notes || []).length + ' 篇笔记' : '导出失败：浏览器阻止了下载', ok ? 'success' : 'error');
            });
        });
    }

    function importNotes() {
        var inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = '.json,application/json';
        inputEl.addEventListener('change', function () {
            var file = inputEl.files && inputEl.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (event) {
                var raw = String(event.target.result || '');
                var parsed = null;
                try { parsed = NC.schema.notes.parseImport(raw); } catch (err) { parsed = null; }
                if (!parsed || !parsed.doc) { toast('不是有效的笔记备份', 'error'); return; }
                ensureNotesReady(function (notesStore) {
                    if (!notesStore) { toast('笔记模块加载失败', 'error'); return; }
                    var current = 0;
                    try { current = notesStore.quickSwitch('').length; } catch (err) { current = 0; }
                    ui.confirm('将导入 ' + parsed.doc.notes.length + ' 篇笔记（当前 ' + current + ' 篇），覆盖现有笔记。导入前会自动快照。', {
                        title: '导入笔记', confirmText: '覆盖导入', danger: true
                    }).then(function (ok) {
                        if (!ok) return;
                        notesStore.importVault(raw, { mode: 'replace' }).then(function (res) {
                            if (res && res.ok) {
                                toast('已导入 ' + res.added + ' 篇', 'success');
                                if (NC.view.notes && NC.view.notes.refresh) NC.view.notes.refresh();
                                renderSection('data');
                            } else {
                                toast('导入未完成：' + ((res && res.reason) || '未知原因'), 'error');
                            }
                        });
                    });
                });
            };
            reader.onerror = function () { toast('读取文件失败', 'error'); };
            reader.readAsText(file);
        });
        inputEl.click();
    }

    function renderNotesSnapshotList() {
        var box = util.e('div', { class: 'sp-snap-list' });
        var title = util.e('div', { class: 'sp-data-card__desc', text: '最近的笔记快照（导入 / 清空回收站前自动生成）' });
        box.appendChild(title);
        var durability = NC.durability;
        if (!durability || !durability.snapshot) {
            box.appendChild(util.e('div', { class: 'sp-hint', text: '快照模块未加载' }));
            return box;
        }
        durability.snapshot.list('notes').then(function (items) {
            if (!items || !items.length) {
                box.appendChild(util.e('div', { class: 'sp-hint', text: '还没有快照（首次执行破坏性操作后生成）' }));
                return;
            }
            items.forEach(function (item) {
                var row = util.e('div', { class: 'sp-snap-row' });
                row.appendChild(util.e('span', { class: 'sp-snap-row__time', text: util.formatDateTime(item.at) }));
                var count = item.summary && util.isFiniteNum(item.summary.notes) ? item.summary.notes + ' 篇' : '';
                row.appendChild(util.e('span', { class: 'sp-snap-row__meta', text: count }));
                row.appendChild(button('恢复', {
                    small: true, ghost: true,
                    onClick: function () {
                        ui.confirm('用这份快照覆盖当前全部笔记？当前状态会先自动再存一份快照。', {
                            title: '恢复笔记快照', confirmText: '恢复', danger: true
                        }).then(function (ok) {
                            if (!ok) return;
                            durability.snapshot.read('notes', item.slot).then(function (doc) {
                                if (!doc || !Array.isArray(doc.notes)) { toast('快照不可用', 'error'); return; }
                                ensureNotesReady(function (notesStore) {
                                    if (!notesStore) { toast('笔记模块加载失败', 'error'); return; }
                                    notesStore.importVault(doc, { mode: 'replace' }).then(function (res) {
                                        if (res && res.ok) {
                                            toast('已恢复 ' + res.added + ' 篇笔记', 'success');
                                            if (NC.view.notes && NC.view.notes.refresh) NC.view.notes.refresh();
                                            renderSection('data');
                                        } else {
                                            toast('恢复失败', 'error');
                                        }
                                    });
                                });
                            });
                        });
                    }
                }));
                box.appendChild(row);
            });
        }).catch(function () {
            box.appendChild(util.e('div', { class: 'sp-hint', text: '快照读取失败' }));
        });
        return box;
    }

    /* ------------------------------------------------------------------ *
     * 一键备份（数据页顶部）
     * ------------------------------------------------------------------ */
    function exportEmailJson() {
        var doc = readEmailData();
        if (!doc) { toast('还没有邮件数据可导出', 'warn'); return; }
        var payload = {
            app: 'nTools',
            kind: 'email-backup',
            exportedAt: new Date().toISOString(),
            groups: doc.groups || [],
            emails: doc.emails || []
        };
        var name = 'ntools-email-' + new Date().toISOString().slice(0, 10) + '.json';
        var ok = util.downloadBlob(name, JSON.stringify(payload, null, 2), 'application/json');
        toast(ok ? '已导出 ' + (payload.emails.length) + ' 个邮箱地址' : '导出失败：浏览器阻止了下载', ok ? 'success' : 'error');
    }

    function importEmailJson() {
        var inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = '.json,application/json';
        inputEl.addEventListener('change', function () {
            var file = inputEl.files && inputEl.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (event) {
                var data = util.parseJSON(String(event.target.result || ''), null);
                if (!data || !Array.isArray(data.groups) || !Array.isArray(data.emails)) {
                    toast('不是有效的邮箱备份（需要 groups / emails 两个数组）', 'error');
                    return;
                }
                var current = readEmailData();
                var currentCount = current && Array.isArray(current.emails) ? current.emails.length : 0;
                ui.confirm('导入 ' + data.emails.length + ' 个邮箱地址、' + data.groups.length + ' 个分组（当前 ' + currentCount + ' 个）。将覆盖现有邮箱数据，覆盖前会留一份 .preimport 备份。', {
                    title: '导入邮箱数据', confirmText: '覆盖导入', danger: true
                }).then(function (ok) {
                    if (!ok) return;
                    try {
                        var prev = global.localStorage.getItem(EMAIL_DOC_KEY);
                        if (prev) global.localStorage.setItem(EMAIL_DOC_KEY + '.preimport', prev);
                        var rev = 0;
                        try { var parsed = util.parseJSON(prev, null); rev = parsed && util.isFiniteNum(parsed.revision) ? parsed.revision : 0; } catch (err) { rev = 0; }
                        global.localStorage.setItem(EMAIL_DOC_KEY, JSON.stringify({
                            schemaVersion: 1,
                            revision: rev + 1,
                            updatedAt: Date.now(),
                            groups: data.groups,
                            emails: data.emails
                        }));
                        events.emit(NC.eventNames.emailImported);
                        toast('已导入 ' + data.emails.length + ' 个邮箱地址', 'success');
                        renderSection('email');
                    } catch (err) {
                        toast('导入失败：本地存储写入失败', 'error');
                    }
                });
            };
            reader.onerror = function () { toast('读取文件失败', 'error'); };
            reader.readAsText(file);
        });
        inputEl.click();
    }

    function renderEmailTransferCard() {
        var card = moduleCard('邮箱数据（JSON）', '导出的 JSON 只包含分组与地址，可单独迁移到另一台机器。');
        var bar = util.e('div', { class: 'sp-data-card__actions' });
        bar.appendChild(button('导出邮箱 JSON', { small: true, icon: 'download', onClick: exportEmailJson }));
        bar.appendChild(button('导入邮箱 JSON', { small: true, ghost: true, icon: 'upload', onClick: importEmailJson }));
        card.appendChild(bar);
        return card;
    }

    /** 本地存储用量（所有 NC.storage 键的近似字节数） */
    var LEGACY_KEYS = [
        { key: 'ntools_todo', label: '待办 v1 旧数据' },
        { key: 'ntools.todo.v1_backup', label: '待办 v1 迁移备份' },
        { key: 'nchat-conversation', label: '聊天 v1 旧数据' },
        { key: 'nchat-conversation.v2', label: '聊天 v2 旧数据' },
        { key: 'nchat-settings', label: '旧 nChat 端点配置' },
        { key: 'boc_email_system_groups_v1', label: '邮件旧分组键' },
        { key: 'boc_email_system_emails_v1', label: '邮件旧地址键' }
    ];

    function listLegacyEntries() {
        var out = [];
        LEGACY_KEYS.forEach(function (item) {
            var raw = null;
            try { raw = global.localStorage.getItem(item.key); } catch (err) { raw = null; }
            if (raw == null) return;
            out.push({ key: item.key, label: item.label, bytes: raw.length });
        });
        try {
            NC.storage.keys().forEach(function (name) {
                if (!name || name.indexOf('.corrupt.') === -1) return;
                var raw = global.localStorage.getItem(name);
                out.push({ key: name, label: '损坏数据备份', bytes: raw ? raw.length : 0 });
            });
        } catch (err) { /* ignore */ }
        return out;
    }

    function renderLegacyCard() {
        var card = util.e('div', { class: 'sp-data-card' });
        card.appendChild(util.e('div', { class: 'sp-data-card__title', text: '历史版本数据' }));
        card.appendChild(util.e('div', {
            class: 'sp-data-card__desc',
            text: '迁移到新格式后保留的旧键，占用的仍是同一份本地存储配额。确认新数据无误后可清理。'
        }));

        var listEl = util.e('div', { class: 'sp-snap-list' });
        card.appendChild(listEl);

        function renderList() {
            listEl.textContent = '';
            var entries = listLegacyEntries();
            if (!entries.length) {
                listEl.appendChild(util.e('div', { class: 'sp-hint', text: '没有需要清理的旧数据' }));
                return;
            }
            var total = 0;
            entries.forEach(function (item) {
                total += item.bytes;
                var row = util.e('div', { class: 'sp-snap-row' });
                row.appendChild(util.e('span', { class: 'sp-snap-row__time', text: item.label }));
                row.appendChild(util.e('span', { class: 'sp-snap-row__meta', text: util.formatBytes(item.bytes) }));
                listEl.appendChild(row);
            });
            listEl.appendChild(util.e('div', {
                class: 'sp-hint',
                text: '合计约 ' + util.formatBytes(total) + '，共 ' + entries.length + ' 个旧键'
            }));

            var actions = util.e('div', { class: 'sp-data-card__actions' });
            actions.appendChild(button('清理旧数据', {
                small: true, danger: true, icon: 'trash',
                onClick: function () {
                    ui.confirm(
                        '将删除 ' + entries.length + ' 个历史键（约 ' + util.formatBytes(total) + '）。' +
                        '它们只用于回退到旧版本，删除后不可恢复。建议先「导出全部本地数据」。',
                        { title: '清理历史版本数据', confirmText: '删除', danger: true }
                    ).then(function (ok) {
                        if (!ok) return;
                        var removed = 0;
                        entries.forEach(function (item) {
                            try { global.localStorage.removeItem(item.key); removed += 1; } catch (err) { /* ignore */ }
                        });
                        toast('已清理 ' + removed + ' 个历史键', 'success');
                        renderList();
                    });
                }
            }));
            listEl.appendChild(actions);
        }

        renderList();
        return card;
    }

    /* ------------------------------------------------------------------ *
     * 分区：数据 —— 环形快照恢复
     * ------------------------------------------------------------------ */
    function renderSnapshotCard() {
        var card = util.e('div', { class: 'sp-data-card' });
        card.appendChild(util.e('div', { class: 'sp-data-card__title', text: '待办快照' }));
        card.appendChild(util.e('div', {
            class: 'sp-data-card__desc',
            text: '自动保留最近 3 份待办快照（约每 10 分钟或每 20 次保存一次），主数据损坏时可回滚。'
        }));
        var listEl = util.e('div', { class: 'sp-snap-list' });
        card.appendChild(listEl);

        var store = NC.store.todo;
        if (!store || typeof store.listSnapshots !== 'function') {
            listEl.appendChild(util.e('div', { class: 'sp-hint', text: '待办模块未加载' }));
            return card;
        }

        function renderList() {
            listEl.textContent = '';
            store.listSnapshots().then(function (items) {
                if (!items || !items.length) {
                    listEl.appendChild(util.e('div', { class: 'sp-hint', text: '还没有快照（首次自动保存后生成）' }));
                    return;
                }
                items.forEach(function (item) {
                    var row = util.e('div', { class: 'sp-snap-row' });
                    var when = util.formatDateTime(item.at);
                    var count = item.summary && util.isFiniteNum(item.summary.tasks) ? item.summary.tasks + ' 条任务' : '';
                    row.appendChild(util.e('span', { class: 'sp-snap-row__time', text: when }));
                    row.appendChild(util.e('span', { class: 'sp-snap-row__meta', text: count }));
                    row.appendChild(button('恢复', {
                        small: true, ghost: true,
                        onClick: function () {
                            ui.confirm('用 ' + when + ' 的快照覆盖当前待办？当前状态会先自动存一份快照。', {
                                title: '恢复快照',
                                confirmText: '恢复',
                                danger: true
                            }).then(function (ok) {
                                if (!ok) return;
                                store.restoreSnapshot(item.slot).then(function (res) {
                                    if (res && res.ok) {
                                        toast('已恢复 ' + res.tasks + ' 条任务', 'success');
                                        renderSection('data');
                                    } else {
                                        toast('恢复失败：' + ((res && res.reason) || '未知原因'), 'error');
                                    }
                                });
                            });
                        }
                    }));
                    listEl.appendChild(row);
                });
            }).catch(function () {
                listEl.appendChild(util.e('div', { class: 'sp-hint', text: '快照读取失败' }));
            });
        }

        renderList();
        return card;
    }

    var EMAIL_DOC_KEY = 'ntools.email.v1';
    var LEGACY_EMAIL_KEYS = { groups: 'boc_email_system_groups_v1', emails: 'boc_email_system_emails_v1' };

    function readEmailData() {
        try {
            var doc = util.parseJSON(global.localStorage.getItem(EMAIL_DOC_KEY), null);
            if (doc && util.isPlainObject(doc) && Array.isArray(doc.groups) && Array.isArray(doc.emails)) {
                return { schemaVersion: doc.schemaVersion || 1, groups: doc.groups, emails: doc.emails };
            }
            /* 尚未迁移到 v1 文档时，回退读两个旧键 */
            var groups = util.parseJSON(global.localStorage.getItem(LEGACY_EMAIL_KEYS.groups), null);
            var emails = util.parseJSON(global.localStorage.getItem(LEGACY_EMAIL_KEYS.emails), null);
            if (Array.isArray(groups) || Array.isArray(emails)) {
                return {
                    groups: Array.isArray(groups) ? groups : [],
                    emails: Array.isArray(emails) ? emails : []
                };
            }
        } catch (err) { /* ignore */ }
        return null;
    }

    /**
     * 聊天栈是懒加载的。导出/导入全量备份前必须先把它拉起来，
     * 否则"全量备份"会静默漏掉聊天记录——这正是数据安全最不该出现的行为。
     */
    function withChatStore(fn) {
        var store = NC.store && NC.store.conversation;
        if (store && typeof store.exportAllSessions === 'function') return fn();
        if (typeof NC.loadChatBundle !== 'function') return fn();
        toast('正在准备聊天数据…', 'info');
        NC.loadChatBundle().then(function () { fn(); }, function () { fn(); });
    }

    /** 笔记栈也是懒加载的：导出/导入前必须拉起来，否则会静默漏掉笔记 */
    function withNotesStore(fn) {
        var notesStore = NC.store && NC.store.notes;
        if (notesStore && notesStore.isReady && notesStore.isReady()) return fn();
        if (typeof NC.loadNotesBundle !== 'function') return fn();
        NC.loadNotesBundle().then(function () {
            if (NC.store.notes && NC.store.notes.init) NC.store.notes.init();
            fn();
        }, function () { fn(); });
    }

    function exportEverything() {
        withChatStore(function () {
            withNotesStore(doExportEverything);
        });
    }

    /** 收集全量备份负载（导出与测试共用一份逻辑，避免两处漂移） */
    function collectBackup() {
        var payload = {
            app: 'nTools',
            kind: 'full-backup',
            version: NC.version,
            exportedAt: new Date().toISOString(),
            llm: store().exportAll({ includeKeys: false }),
            todo: null,
            chats: null,
            email: null,
            notes: null
        };
        if (NC.store.todo && typeof NC.store.todo.exportData === 'function') {
            try { payload.todo = NC.store.todo.exportData(); } catch (err) { payload.todo = null; }
        }
        if (NC.store.conversation && typeof NC.store.conversation.exportAllSessions === 'function') {
            try { payload.chats = NC.store.conversation.exportAllSessions(); } catch (err) { payload.chats = null; }
        }
        payload.email = readEmailData();
        if (NC.store.notes && typeof NC.store.notes.exportBundle === 'function') {
            try { payload.notes = NC.store.notes.exportBundle(); } catch (err) { payload.notes = null; }
        }
        return payload;
    }

    function doExportEverything() {
        var payload = collectBackup();
        var json = JSON.stringify(payload, null, 2);
        var name = 'ntools-backup-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') + '.json';
        var ok = util.downloadBlob(name, json, 'application/json');
        if (!ok) {
            ui.openModal({
                title: '导出失败',
                message: '浏览器阻止了自动下载。下面是备份内容，请手动复制保存。',
                size: 'lg',
                content: util.e('textarea', { class: 'nc-input', rows: 12, value: json, readonly: true })
            });
            return;
        }
        var notesCount = payload.notes && payload.notes.notes ? payload.notes.notes.length : 0;
        toast('已导出全量备份（不含密钥）' + (notesCount ? '，含笔记 ' + notesCount + ' 篇' : ''), 'success');
    }

    function importEverything() {
        var inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = '.json,application/json';
        inputEl.addEventListener('change', function () {
            var file = inputEl.files && inputEl.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (event) {
                var data = util.parseJSON(event.target.result, null);
                if (!util.isPlainObject(data)) {
                    toast('文件不是有效的 JSON 备份', 'error');
                    return;
                }
                var summary = describeBackup(data);
                if (!summary.ok) {
                    toast('备份格式不完整：' + summary.reason, 'error');
                    return;
                }
                ui.confirm(summary.text + '\n\n导入会覆盖现有的待办、聊天与邮件数据（端点配置为合并）。继续？', {
                    title: '从备份恢复',
                    confirmText: '导入并覆盖',
                    danger: true
                }).then(function (ok) {
                    if (ok) applyBackup(data);
                });
            };
            reader.onerror = function () { toast('读取文件失败', 'error'); };
            reader.readAsText(file);
        });
        inputEl.click();
    }

    function describeBackup(data) {
        var parts = [];
        var hasAny = false;
        if (data.todo && Array.isArray(data.todo.tasks)) {
            parts.push('待办 ' + data.todo.tasks.length + ' 条');
            hasAny = true;
        }
        if (data.chats && Array.isArray(data.chats.sessions)) {
            var msgCount = 0;
            data.chats.sessions.forEach(function (s) { msgCount += (s.messages || []).length; });
            parts.push('会话 ' + data.chats.sessions.length + ' 个 / 消息 ' + msgCount + ' 条');
            hasAny = true;
        }
        if (data.email && (data.email.groups || data.email.emails)) {
            var g = (data.email.groups || []).length;
            var e = (data.email.emails || []).length;
            parts.push('邮件分组 ' + g + ' 个 / 地址 ' + e + ' 条');
            hasAny = true;
        }
        if (data.notes && Array.isArray(data.notes.notes)) {
            parts.push('笔记 ' + data.notes.notes.length + ' 篇' +
                (data.notes.folders ? ' / 文件夹 ' + data.notes.folders.length : ''));
            hasAny = true;
        }
        if (data.llm) {
            var p = data.llm.profiles || (data.llm.state && data.llm.state.profiles) || [];
            parts.push('端点 ' + p.length + ' 个（合并）');
            hasAny = true;
        }
        if (!hasAny) return { ok: false, reason: '没有可导入的数据段', text: '' };
        return { ok: true, text: '备份包含：' + parts.join('；') + '。' };
    }

    function applyBackup(data, chatLoaded) {
        /* 聊天栈懒加载：先拉起来再恢复聊天记录，失败也只尝试一次，避免死循环 */
        if (!chatLoaded && data.chats && Array.isArray(data.chats.sessions) &&
            !(NC.store && NC.store.conversation)) {
            withChatStore(function () { applyBackup(data, true); });
            return;
        }
        var done = [];
        var failed = [];
        var todoStore = NC.store.todo;
        if (data.todo && Array.isArray(data.todo.tasks) && todoStore && todoStore.importDoc) {
            try {
                if (todoStore.isReadOnly && todoStore.isReadOnly()) {
                    failed.push('待办处于只读状态');
                } else {
                    todoStore.importDoc(data.todo, 'replace');
                    done.push('待办');
                }
            } catch (err) { failed.push('待办'); }
        }
        if (data.email && (data.email.groups || data.email.emails)) {
            try {
                var prevEmail = util.parseJSON(global.localStorage.getItem(EMAIL_DOC_KEY), null);
                if (prevEmail) {
                    /* 覆盖前留一份，误导入可回退 */
                    global.localStorage.setItem(EMAIL_DOC_KEY + '.preimport', JSON.stringify(prevEmail));
                }
                var prevRev = prevEmail && util.isFiniteNum(prevEmail.revision) ? prevEmail.revision : 0;
                global.localStorage.setItem(EMAIL_DOC_KEY, JSON.stringify({
                    schemaVersion: 1,
                    revision: prevRev + 1,
                    updatedAt: Date.now(),
                    groups: Array.isArray(data.email.groups) ? data.email.groups : [],
                    emails: Array.isArray(data.email.emails) ? data.email.emails : []
                }));
                done.push('邮件');
                events.emit(NC.eventNames.emailImported);
            } catch (err) { failed.push('邮件'); }
        }
        if (data.llm) {
            try {
                var result = store().importAll(data.llm, { merge: true });
                if (result && result.ok) done.push('端点');
                else failed.push('端点');
            } catch (err) { failed.push('端点'); }
        }
        var restoreNotesThen = function (next) {
            if (!data.notes || !Array.isArray(data.notes.notes)) { next(); return; }
            withNotesStore(function () {
                var notesStore = NC.store && NC.store.notes;
                if (!notesStore || !notesStore.importVault) { failed.push('笔记'); next(); return; }
                notesStore.importVault(data.notes, { mode: 'replace' }).then(function (res) {
                    if (res && res.ok) done.push('笔记');
                    else failed.push('笔记');
                    if (NC.view && NC.view.notes && NC.view.notes.refresh) {
                        try { NC.view.notes.refresh(); } catch (err) { /* ignore */ }
                    }
                    next();
                }).catch(function () { failed.push('笔记'); next(); });
            });
        };

        var finishChats = function () {
            restoreNotesThen(function () {
                toast(
                    '导入完成：' + (done.length ? done.join('、') : '无') +
                    (failed.length ? '；失败：' + failed.join('、') : ''),
                    failed.length ? 'warn' : 'success'
                );
                renderSection('data');
            });
        };
        if (data.chats && Array.isArray(data.chats.sessions) &&
            NC.store.conversation && NC.store.conversation.importAllSessions) {
            NC.store.conversation.importAllSessions(data.chats).then(function (res) {
                if (res && res.ok) done.push('会话');
                else failed.push('会话');
                if (NC.chatEmbed && NC.chatEmbed.renderConversation) {
                    try { NC.chatEmbed.renderConversation(''); } catch (err) { /* ignore */ }
                }
                finishChats();
            }).catch(function () {
                failed.push('会话');
                finishChats();
            });
            return;
        }
        finishChats();
    }

    /* ------------------------------------------------------------------ *
     * 分区：关于
     * ------------------------------------------------------------------ */
    function renderAbout(container) {
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: '关于 nTools' }));
        info.appendChild(util.e('p', { class: 'sp-section-desc', text: '本地优先的 AI 聊天与效率工具，无服务器、无构建链。' }));
        head.appendChild(info);
        container.appendChild(head);

        var rows = util.e('div', { class: 'sp-rows' });
        [['版本', 'v' + (NC.version || '2.0.0')],
            ['浏览器内核', 'Chromium ' + ((NC.compat && NC.compat.features.chromeVersion) || '未知')],
            ['运行协议', (global.location && global.location.protocol) || ''],
            ['存储模式', NC.storage.memoryMode() ? '内存模式' : 'localStorage / IndexedDB']
        ].forEach(function (item) {
            var row = util.e('div', { class: 'sp-row' });
            row.appendChild(util.e('span', { class: 'sp-row__label', text: item[0] }));
            row.appendChild(util.e('span', { class: 'sp-row__value', text: item[1] }));
            rows.appendChild(row);
        });
        container.appendChild(rows);

        var links = util.e('div', { class: 'sp-about-actions' });
        links.appendChild(button('兼容性自检', {
            small: true, ghost: true, icon: 'external',
            onClick: function () { global.open('checks/compat-check.html', '_blank'); }
        }));
        links.appendChild(button('快捷键与帮助', {
            small: true, ghost: true, icon: 'command',
            onClick: function () {
                close();
                if (NC.tools.todo && NC.tools.todo.openHelp) NC.tools.todo.openHelp();
            }
        }));
        container.appendChild(links);
        container.appendChild(util.e('p', {
            class: 'sp-hint',
            text: '提示：Chrome 102 / 麒麟 ARM / file:// 均可运行；如遇网络失败请检查内网网关 CORS（Origin: null）。'
        }));
    }

    /* ------------------------------------------------------------------ *
     * 渲染与开关
     * ------------------------------------------------------------------ */
    function dataDeps() {
        return {
            util: util, ui: ui, toast: toast, button: button,
            moduleCard: moduleCard, moduleRows: moduleRows,
            openModule: openModule, renderSection: renderSection,
            global: global,
            renderEmailTransferCard: renderEmailTransferCard,
            renderSnapshotCard: renderSnapshotCard,
            renderLegacyCard: renderLegacyCard,
            exportNotes: exportNotes, importNotes: importNotes, withNotesStore: withNotesStore,
            renderNotesSnapshotList: renderNotesSnapshotList,
            exportEverything: exportEverything, importEverything: importEverything
        };
    }

    function profileDeps() {
        return {
            util: util, ui: ui, toast: toast, setStatus: setStatus,
            field: field, input: input, button: button,
            switchField: switchField, segmented: segmented, rangeRow: rangeRow,
            store: store, ai: ai, renderSection: renderSection,
            getEditingId: function () { return editingProfileId; },
            setEditingId: function (value) { editingProfileId = value; }
        };
    }

    function renderSection(id, opts) {
        var silent = !!(opts && opts.silent);
        currentSection = id;
        Array.prototype.forEach.call(navEl.children, function (nav) {
            var active = nav.getAttribute('data-section') === id;
            nav.classList.toggle('is-active', active);
            if (active) nav.setAttribute('aria-current', 'page');
            else nav.removeAttribute('aria-current');
        });
        if (pickerLabel) {
            var currentMeta = sectionMeta().filter(function (item) { return item.id === id; })[0];
            pickerLabel.textContent = currentMeta ? currentMeta.title : '设置';
        }
        /* 移动端：把当前分区滚进视野，避免“当前项在屏外” */
        var activeNav = navEl.querySelector('.sp-nav.is-active');
        if (activeNav && navEl.scrollWidth > navEl.clientWidth + 1) {
            var targetLeft = activeNav.offsetLeft - (navEl.clientWidth - activeNav.offsetWidth) / 2;
            try {
                navEl.scrollTo({ left: Math.max(0, targetLeft), behavior: (NC.theme && NC.theme.isLite()) ? 'auto' : 'smooth' });
            } catch (err) {
                navEl.scrollLeft = Math.max(0, targetLeft);
            }
        }
        bodyEl.textContent = '';
        bodyEl.scrollTop = 0;
        var wrap = util.e('div', { class: 'sp-content' + (silent ? '' : ' nc-anim-in') });
        if (id === 'profiles') {
            if (NC.settingsProfiles && typeof NC.settingsProfiles.render === 'function') {
                NC.settingsProfiles.render(wrap, profileDeps());
            } else {
                wrap.appendChild(util.e('p', { class: 'sp-hint', text: '端点设置模块未加载' }));
            }
        }
        else if (id === 'todo') renderTodoModule(wrap);
        else if (id === 'general') renderGeneral(wrap);
        else if (id === 'data') {
            if (NC.settingsData && typeof NC.settingsData.render === 'function') {
                NC.settingsData.render(wrap, dataDeps());
            } else {
                wrap.appendChild(util.e('p', { class: 'sp-hint', text: '数据设置模块未加载' }));
            }
        }
        else if (id === 'about') renderAbout(wrap);
        else if (MODULE_TABS.indexOf(id) > -1) renderModuleTab(wrap, id);
        else {
            var custom = sections.filter(function (section) { return section.id === id; })[0];
            if (custom && custom.render) custom.render(wrap, { store: store(), ui: ui, toast: toast });
        }
        bodyEl.appendChild(wrap);
    }

    function build() {
        if (built) return;
        var existing = document.getElementById('settings-sheet');
        if (existing) {
            sheet = existing;
        } else {
            sheet = util.e('section', {
                id: 'settings-sheet', class: 'settings-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置', hidden: true
            });
            document.body.appendChild(sheet);
        }
        sheet.textContent = '';
        var backdrop = util.e('div', { class: 'settings-sheet__backdrop nc-material-scrim' });
        backdrop.addEventListener('click', close);
        sheet.appendChild(backdrop);

        var panel = util.e('div', { class: 'settings-sheet__panel nc-material-sheet' });
        var head = util.e('div', { class: 'settings-sheet__head' });
        head.appendChild(util.e('div', { class: 'settings-sheet__title', text: '设置' }));
        pickerBtn = util.e('button', { type: 'button', class: 'settings-sheet__picker', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': '切换设置分区' });
        pickerLabel = util.e('span', { class: 'settings-sheet__picker-label', text: '通用' });
        pickerBtn.appendChild(pickerLabel);
        pickerBtn.appendChild(icons.el('chevron-down', 14));
        pickerBtn.addEventListener('click', function () {
            var items = sectionMeta().map(function (section) {
                return {
                    label: section.title,
                    icon: section.icon,
                    hint: section.id === currentSection ? '当前' : '',
                    onSelect: function () { editingProfileId = null; renderSection(section.id); }
                };
            });
            ui.openMenu(pickerBtn, items);
        });
        head.appendChild(pickerBtn);
        closeBtn = button('', { ghost: true, small: true, iconOnly: true, icon: 'x', iconSize: 16, title: '关闭设置' });
        closeBtn.classList.add('settings-sheet__close');
        closeBtn.setAttribute('aria-label', '关闭设置');
        closeBtn.addEventListener('click', close);
        head.appendChild(closeBtn);
        panel.appendChild(head);

        var layout = util.e('div', { class: 'settings-sheet__layout' });
        navEl = util.e('nav', { class: 'settings-sheet__nav', 'aria-label': '设置分区' });
        var allSections = sectionMeta();
        NAV_GROUPS.forEach(function (group) {
            var items = allSections.filter(function (section) { return sectionGroup(section.group) === group.id; });
            if (!items.length) return;
            navEl.appendChild(util.e('div', { class: 'sp-nav-group', text: group.title, 'aria-hidden': 'true' }));
            items.forEach(function (section) {
                var nav = util.e('button', { type: 'button', class: 'sp-nav', dataset: { section: section.id } });
                nav.appendChild(icons.el(section.icon, 16));
                var text = util.e('span', { class: 'sp-nav__text' });
                text.appendChild(util.e('span', { class: 'sp-nav__title', text: section.title }));
                text.appendChild(util.e('span', { class: 'sp-nav__desc', text: section.desc }));
                nav.appendChild(text);
                nav.addEventListener('click', function () { editingProfileId = null; renderSection(section.id); });
                navEl.appendChild(nav);
            });
        });
        layout.appendChild(navEl);

        var main = util.e('div', { class: 'settings-sheet__main' });
        bodyEl = util.e('div', { class: 'settings-sheet__body nc-scroll' });
        main.appendChild(bodyEl);
        statusEl = util.e('span', { class: 'settings-sheet__status', role: 'status', 'aria-live': 'polite' });
        main.appendChild(statusEl);
        layout.appendChild(main);
        panel.appendChild(layout);
        sheet.appendChild(panel);

        sheet.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') { event.stopPropagation(); close(); }
        });
        built = true;
    }

    function openSheet(sectionId) {
        build();
        previousFocus = document.activeElement;
        sheet.hidden = false;
        sheet.classList.remove('is-closing');
        // 强制提交初始态，保证第一帧有 0 的起点
        void sheet.offsetWidth;
        sheet.classList.add('is-open');
        open = true;
        renderSection(sectionId || currentSection || 'general', { silent: true });
        releaseTrap = ui.trapFocus(sheet);
        setTimeout(function () {
            if (closeBtn) {
                try { closeBtn.focus({ preventScroll: true }); } catch (err) { closeBtn.focus(); }
            }
        }, 120);
        // 等面板落位后再加一层柔和模糊，避免 transform 动画期间逐帧重算
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(function () {
            settleTimer = null;
            if (open) sheet.classList.add('is-settled');
        }, 360);
    }

    function finishClose() {
        if (open) return;
        sheet.hidden = true;
        sheet.classList.remove('is-closing', 'is-settled');
    }

    function close() {
        if (!built || !open) return;
        open = false;
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        sheet.classList.remove('is-settled');
        sheet.classList.add('is-closing');
        sheet.classList.remove('is-open');
        if (releaseTrap) { releaseTrap(); releaseTrap = null; }
        var panel = sheet.querySelector('.settings-sheet__panel');
        var done = false;
        function onEnd(event) {
            if (done || event.target !== panel) return;
            if (event.propertyName !== 'opacity' && event.propertyName !== 'transform') return;
            done = true;
            panel.removeEventListener('transitionend', onEnd);
            finishClose();
        }
        if (panel) panel.addEventListener('transitionend', onEnd);
        setTimeout(function () {
            if (done) return;
            done = true;
            if (panel) panel.removeEventListener('transitionend', onEnd);
            finishClose();
        }, 300);
        if (previousFocus && previousFocus.focus) {
            try { previousFocus.focus({ preventScroll: true }); } catch (err) { previousFocus.focus(); }
        }
    }

    function init() {
        if (NC._settingsPanelInit) return;
        NC._settingsPanelInit = true;
        var btn = document.getElementById('settings-btn');
        if (btn && btn.getAttribute('data-nc-settings-lazy') !== '1') {
            btn.addEventListener('click', function () { openSheet('profiles'); });
        }
        events.on(NC.eventNames.appOpenSettings, function (payload) {
            openSheet(payload && payload.section);
        });
        // 端点变化时刷新（若设置面板打开且处于端点/Todo AI 分区）
        store().subscribe(function () {
            if (!open) return;
            if (currentSection === 'profiles' && !editingProfileId) renderSection('profiles');
            else if (currentSection === 'todo') { /* 保持输入 */ }
        });
    }

    function registerSection(section) {
        if (!section || !section.id || typeof section.render !== 'function') return false;
        if (sections.some(function (item) { return item.id === section.id; })) return false;
        sections.push({
            id: section.id,
            title: section.title || section.id,
            desc: section.desc || '',
            icon: section.icon || 'info',
            order: section.order || 99,
            render: section.render
        });
        sections.sort(function (a, b) { return a.order - b.order; });
        built = false;
        return true;
    }

    NC.settingsPanel = {
        init: init,
        open: openSheet,
        close: close,
        registerSection: registerSection,
        renderSection: renderSection,
        isOpen: function () { return open; },
        collectBackup: collectBackup,
        describeBackup: describeBackup
    };
})(window);
