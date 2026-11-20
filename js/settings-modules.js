/**
 * settings-modules.js — 设置面板的模块分区（待办 / 笔记本 / 邮箱维护 / nChat / Todo AI）
 * 随设置面板按需加载；由 NC.settingsModules.render(kind, container, deps) 调用。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    function render(kind, container, deps) {
        var util = deps.util;
        var ui = deps.ui;
        var toast = deps.toast;
        var setStatus = deps.setStatus;
        var button = deps.button;
        var field = deps.field;
        var input = deps.input;
        var switchField = deps.switchField;
        var segmented = deps.segmented;
        var rangeRow = deps.rangeRow;
        var moduleCard = deps.moduleCard;
        var moduleRows = deps.moduleRows;
        var modulePrefRow = deps.modulePrefRow;
        var openModule = deps.openModule;
        var renderSection = deps.renderSection;
        var store = deps.store;
        var ai = deps.ai;
        var prefGet = deps.prefGet;
        var prefSet = deps.prefSet;
        var PREF_KEYS = deps.PREF_KEYS;
        var readEmailData = deps.readEmailData;
        var renderEmailTransferCard = deps.renderEmailTransferCard;
        var exportNotes = deps.exportNotes;
        var importNotes = deps.importNotes;
        var renderNotesSnapshotList = deps.renderNotesSnapshotList;
        var exportEverything = deps.exportEverything;
        var EMAIL_DOC_KEY = deps.emailDocKey;
        var exportEmailJson = deps.exportEmailJson;
        var importEmailJson = deps.importEmailJson;

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

        if (kind === 'todo') renderTodoModule(container);
        else if (kind === 'notes') renderNotesModule(container);
        else if (kind === 'email') renderEmailModule(container);
        else if (kind === 'nchat') renderChatModule(container);
        else if (kind === 'todo-ai') renderTodoAi(container);
    }

    NC.settingsModules = { render: render };
})(window);
