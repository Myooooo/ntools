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
        return [
            { id: 'general', title: '通用', desc: '主题、Light 性能模式、上下班时间', icon: 'settings', group: 'core' },
            { id: 'profiles', title: 'AI 端点', desc: '聊天与 Todo AI 共用的 OpenAI 兼容端点', icon: 'layers', group: 'core' },
            { id: 'todo', title: '待办事项', desc: 'Todo AI 识别与列表行为', icon: 'check-circle', group: 'modules' },
            { id: 'email', title: '邮箱维护', desc: '邮箱数据用量与备份入口', icon: 'mail', group: 'modules' },
            { id: 'nchat', title: 'nChat', desc: '当前端点与聊天入口', icon: 'messages-square', group: 'modules' },
            { id: 'notes', title: '笔记本', desc: '笔记库状态、默认视图与导出', icon: 'notebook-text', group: 'modules' },
            { id: 'qr', title: '二维码生成', desc: '默认生成尺寸', icon: 'qr-code', group: 'modules' },
            { id: 'image', title: '图片处理', desc: 'Base64 导出的 JPEG 质量', icon: 'image', group: 'modules' },
            { id: 'data', title: '数据', desc: '导入导出与本地数据清理', icon: 'download', group: 'system' },
            { id: 'about', title: '关于', desc: '版本、兼容性与快捷键', icon: 'info', group: 'system' }
        ].concat(sections.map(function (section) {
            section.group = section.group || 'modules';
            return section;
        }));
    }

    function sectionGroup(id) {
        return id || 'modules';
    }

    /* 模块分区：保留入口，并给出「实时状态 + 实用默认值 + 快捷跳转」，
     * 不再显示「暂无可配置项」这种消极占位。 */
    var MODULE_TABS = ['notes', 'email', 'qr', 'image', 'nchat'];

    var PREF_KEYS = {
        qrSize: 'ntools.qr.size',
        imageQuality: 'ntools.image.quality',
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
     * 分区：模型端点
     * ------------------------------------------------------------------ */
    function renderProfiles(container) {
        var doc = store().getState();
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: '模型端点' }));
        var currentProfile = doc.profiles.filter(function (item) { return item.id === doc.currentProfileId; })[0];
        info.appendChild(util.e('p', {
            class: 'sp-section-desc',
            text: '所有端点保存在本机；聊天与 Todo AI 共用，支持 OpenAI 与 bocai 两种 API 格式。共 ' + doc.profiles.length + ' 个端点' +
                (currentProfile ? '，当前使用「' + currentProfile.name + '」' : '') + '。'
        }));
        head.appendChild(info);
        var actions = util.e('div', { class: 'sp-section-actions' });
        actions.appendChild(button('新增端点', {
            primary: true, icon: 'plus', onClick: function () {
                var profile = store().addProfile({ name: '新端点 ' + (doc.profiles.length + 1) });
                if (profile) {
                    editingProfileId = profile.id;
                    store().selectProfile(profile.id);
                    renderSection('profiles');
                    toast('已新增端点，请完善配置', 'success');
                }
            }
        }));
        head.appendChild(actions);
        container.appendChild(head);

        var list = util.e('div', { class: 'sp-profile-list' });
        if (!doc.profiles.length) {
            list.appendChild(util.e('div', { class: 'nc-empty__desc', text: '还没有端点，点击右上角新增。' }));
        }
        doc.profiles.forEach(function (profile) {
            var selected = profile.id === doc.currentProfileId;
            var editing = profile.id === editingProfileId;
            var item = util.e('div', { class: 'sp-profile' + (selected ? ' is-selected' : '') + (editing ? ' is-editing' : '') });
            var main = util.e('button', {
                type: 'button', class: 'sp-profile__main',
                'aria-pressed': selected ? 'true' : 'false'
            });
            main.appendChild(util.e('span', { class: 'sp-profile__dot' }));
            var text = util.e('span', { class: 'sp-profile__text' });
            text.appendChild(util.e('span', { class: 'sp-profile__name', text: profile.name }));
            var meta = util.e('span', { class: 'sp-profile__meta' });
            meta.appendChild(util.e('span', { class: 'sp-profile__meta-item', text: profile.modelId || '未填模型' }));
            meta.appendChild(util.e('span', { class: 'sp-profile__meta-item', text: profile.baseUrl || '未填地址' }));
            if (profile.apiFormat === 'bocai') {
                meta.appendChild(util.e('span', { class: 'sp-profile__meta-item sp-profile__meta-item--format', text: 'bocai 格式' }));
            }
            var metaItems = meta.querySelectorAll('.sp-profile__meta-item');
            if (metaItems[0]) metaItems[0].setAttribute('title', profile.modelId || '未填模型');
            if (metaItems[1]) metaItems[1].setAttribute('title', profile.baseUrl || '未填地址');
            if (metaItems[2] && profile.apiFormat === 'bocai') {
                metaItems[2].setAttribute('title', 'bocai：附带稳定 sessionId，不支持图片输入');
            }
            if (!profile.apiKey) {
                meta.appendChild(util.e('span', { class: 'sp-profile__meta-item is-warn', text: '未填写密钥' }));
            }
            text.appendChild(meta);
            main.appendChild(text);
            if (selected) main.appendChild(util.e('span', { class: 'nc-badge nc-badge--accent', text: '当前' }));
            main.addEventListener('click', function () {
                if (editing) { editingProfileId = null; renderSection('profiles'); return; }
                store().selectProfile(profile.id);
                toast('已切换到「' + profile.name + '」', 'success');
            });
            item.appendChild(main);
            var tools = util.e('div', {
                class: 'sp-profile__actions',
                role: 'group',
                'aria-label': '端点操作：' + profile.name
            });
            tools.appendChild(button('', {
                ghost: true, small: true, iconOnly: true, icon: 'copy', title: '复制端点',
                onClick: function () { duplicateProfile(profile); }
            }));
            tools.appendChild(button('', {
                ghost: true, small: true, iconOnly: true, icon: 'edit',
                title: editing ? '收起编辑' : '编辑端点',
                onClick: function () {
                    editingProfileId = editing ? null : profile.id;
                    renderSection('profiles');
                }
            }));
            tools.appendChild(button('', {
                ghost: true, small: true, iconOnly: true, icon: 'trash', title: '删除端点',
                onClick: function () {
                    if (doc.profiles.length <= 1) { toast('至少保留一个端点', 'warn'); return; }
                    ui.confirm('删除端点「' + profile.name + '」？该端点上的聊天记录会保留但不可见。', {
                        danger: true, confirmText: '删除'
                    }).then(function (ok) {
                        if (!ok) return;
                        store().removeProfile(profile.id);
                        editingProfileId = null;
                        renderSection('profiles');
                        toast('已删除端点', 'success');
                    });
                }
            }));
            item.appendChild(tools);
            list.appendChild(item);

            if (editing) {
                list.appendChild(renderProfileEditor(profile));
            }
        });
        container.appendChild(list);

        var footer = util.e('div', { class: 'sp-data-row' });
        footer.appendChild(button('导出端点配置', {
            ghost: true, small: true, icon: 'download',
            onClick: function () { exportProfiles(false); }
        }));
        footer.appendChild(button('导出（含密钥）', {
            ghost: true, small: true, icon: 'key',
            onClick: function () {
                ui.confirm('导出的文件将包含 API Key 明文，确认继续？', { danger: true, confirmText: '仍然导出' })
                    .then(function (ok) { if (ok) exportProfiles(true); });
            }
        }));
        footer.appendChild(button('导入配置', {
            ghost: true, small: true, icon: 'upload',
            onClick: function () { importProfiles(); }
        }));
        if (typeof store().importLegacy === 'function') {
            footer.appendChild(button('从旧 nChat 导入', {
                ghost: true, small: true, icon: 'upload',
                onClick: function () {
                    var result = store().importLegacy();
                    toast((result && result.message) || '没有可导入的旧 nChat 配置',
                        result && result.ok && (result.imported || result.updated) ? 'success' : 'info');
                    if (result && (result.imported || result.updated)) renderSection('profiles');
                }
            }));
        }
        container.appendChild(footer);
    }

    /**
     * 复制端点：沿用 baseUrl / apiKey / modelId / chatSystemPrompt /
     * temperature / topP / apiFormat，名称追加“副本”，并直接打开编辑。
     */
    function duplicateProfile(profile) {
        if (!profile) return;
        var suffix = ' 副本';
        var baseName = String(profile.name || '端点');
        var maxBase = 60 - suffix.length;
        if (baseName.length > maxBase) baseName = baseName.slice(0, maxBase);
        var copy = store().addProfile({
            name: baseName + suffix,
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            modelId: profile.modelId,
            apiFormat: profile.apiFormat === 'bocai' ? 'bocai' : 'openai',
            capabilities: profile.capabilities,
            chatSystemPrompt: profile.chatSystemPrompt,
            temperature: profile.temperature,
            topP: profile.topP
        });
        if (!copy) {
            toast('端点数量已达上限（30 个），请先删除不用的端点', 'warn');
            return;
        }
        editingProfileId = copy.id;
        renderSection('profiles');
        toast('已复制为「' + copy.name + '」，可直接修改名称', 'success');
        if (bodyEl && bodyEl.querySelector) {
            var editor = bodyEl.querySelector('.sp-profile-editor');
            if (editor && typeof editor.scrollIntoView === 'function') {
                try { editor.scrollIntoView({ block: 'nearest' }); } catch (err) { /* 老内核忽略参数 */ }
            }
        }
    }

    function renderProfileEditor(profile) {
        var wrap = util.e('div', { class: 'sp-profile-editor' });
        var form = util.e('div', { class: 'sp-form-grid' });

        var name = input({ value: profile.name, name: 'profile-name', maxlength: '60', placeholder: '例如：内网 GPT-4o' });
        var baseUrl = input({ value: profile.baseUrl, name: 'profile-base-url', placeholder: 'http://10.0.0.8:8000/v1', spellcheck: 'false' });
        var modelId = input({ value: profile.modelId, name: 'profile-model', placeholder: '例如 qwen2.5-72b-instruct', spellcheck: 'false' });
        var apiKey = input({ value: profile.apiKey, name: 'profile-api-key', type: 'password', placeholder: 'sk-...', autocomplete: 'new-password' });
        var apiFormat = util.e('select', { class: 'nc-select', name: 'apiFormat', 'aria-label': 'API 格式' });
        apiFormat.appendChild(util.e('option', { value: 'openai', text: 'openai（标准 OpenAI 兼容）' }));
        apiFormat.appendChild(util.e('option', { value: 'bocai', text: 'bocai（BOCAI 网关）' }));
        apiFormat.value = profile.apiFormat === 'bocai' ? 'bocai' : 'openai';
        var prompt = util.e('textarea', {
            class: 'nc-textarea sp-prompt', rows: '3',
            placeholder: '该端点的聊天系统提示词（可留空）'
        });
        prompt.value = profile.chatSystemPrompt || '';
        var keyWrap = util.e('div', { class: 'sp-key-row' });
        keyWrap.appendChild(apiKey);
        var reveal = button('', { ghost: true, small: true, iconOnly: true, icon: 'eye', title: '显示密钥' });
        reveal.addEventListener('click', function () {
            apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
        });
        keyWrap.appendChild(reveal);

        var baseField = field('Base URL', baseUrl,
            '只填 OpenAI 兼容 base 即可：可带 /v1，也可只填 host（https://host）；无需填写 /chat/completions');
        baseField.classList.add('sp-form-full');
        form.appendChild(field('端点名称', name));
        form.appendChild(field('Model ID', modelId));
        form.appendChild(baseField);
        form.appendChild(field('API 格式', apiFormat,
            'openai 保持标准请求字段；bocai 会附加稳定 sessionId，且不支持图片输入'));
        form.appendChild(field('API Key', keyWrap, '仅保存在本机 localStorage'));
        var caps = profile.capabilities || { vision: true, files: false, search: false, readUrl: false };
        var capsWrap = util.e('div', { class: 'sp-capabilities' });
        capsWrap.appendChild(switchField('图片输入', caps.vision !== false, function (v) { caps.vision = !!v; }));
        capsWrap.appendChild(switchField('文件附件', caps.files === true, function (v) { caps.files = !!v; }));
        var capsField = field('端点能力', capsWrap, '关闭图片输入后 nChat 会禁用图片选择/拖拽/粘贴；文件附件按文本发送');
        capsField.classList.add('sp-form-full');
        form.appendChild(capsField);

        var promptField = field('聊天系统提示词', prompt, '只对 nChat 生效；Todo AI 使用独立提示词');
        promptField.classList.add('sp-form-full');
        form.appendChild(promptField);

        var temp = profile.temperature;
        var topP = profile.topP;
        var advanced = profile.enableAdvanced !== false;
        var advancedRow = util.e('div', { class: 'sp-row sp-form-full' });
        advancedRow.appendChild(util.e('span', { class: 'sp-row__label', text: '采样参数' }));
        advancedRow.appendChild(switchField(
            '发送 temperature / top_p（推理类模型如 o1/o3/gpt-5 会自动跳过）',
            advanced,
            function (v) { advanced = !!v; }
        ));
        form.appendChild(advancedRow);
        form.appendChild(rangeRow('Temperature', temp, '0.1', function (v) { temp = v; }));
        form.appendChild(rangeRow('Top P', topP, '0.05', function (v) { topP = v; }));
        wrap.appendChild(form);

        var actions = util.e('div', { class: 'sp-editor-actions' });
        var status = util.e('span', { class: 'sp-editor-status' });
        actions.appendChild(status);
        actions.appendChild(button('测试连接', {
            ghost: true, small: true, icon: 'zap',
            onClick: function (event) {
                var btn = event.currentTarget;
                ui.setBusy(btn, true);
                status.textContent = '正在测试…';
                ai().testProfile({
                    id: profile.id,
                    baseUrl: baseUrl.value.trim(),
                    apiKey: apiKey.value.trim(),
                    modelId: modelId.value.trim(),
                    apiFormat: apiFormat.value
                }).then(function (result) {
                    ui.setBusy(btn, false);
                    status.textContent = result.message;
                    status.classList.toggle('is-error', !result.ok);
                });
            }
        }));
        actions.appendChild(button('取消', {
            ghost: true, small: true,
            onClick: function () { editingProfileId = null; renderSection('profiles'); }
        }));
        actions.appendChild(button('保存', {
            primary: true, small: true, icon: 'check',
            onClick: function () {
                store().updateProfile(profile.id, {
                    name: name.value,
                    baseUrl: baseUrl.value,
                    apiKey: apiKey.value,
                    modelId: modelId.value,
                    apiFormat: apiFormat.value,
                    capabilities: caps,
                    enableAdvanced: advanced,
                    chatSystemPrompt: prompt.value,
                    temperature: temp,
                    topP: topP
                });
                editingProfileId = null;
                renderSection('profiles');
                setStatus('已保存端点配置');
                toast('端点已保存', 'success');
            }
        }));
        wrap.appendChild(actions);
        return wrap;
    }

    function exportProfiles(includeKeys) {
        var data = store().exportAll({ includeKeys: includeKeys });
        var filename = 'ntools-llm-profiles-' + new Date().toISOString().slice(0, 10) + '.json';
        util.downloadBlob(filename, JSON.stringify(data, null, 2), 'application/json');
        toast('已导出端点配置', 'success');
    }

    function importProfiles() {
        var inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = '.json,application/json';
        inputEl.addEventListener('change', function () {
            var file = inputEl.files && inputEl.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (event) {
                var data = util.parseJSON(event.target.result, null);
                if (!data) { toast('文件格式无效', 'error'); return; }
                var result = store().importAll(data, { merge: true });
                if (!result.ok) { toast(result.message || '导入失败', 'error'); return; }
                renderSection('profiles');
                toast(result.message, 'success');
            };
            reader.readAsText(file);
        });
        inputEl.click();
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
        else if (id === 'qr') renderQrModule(container);
        else if (id === 'image') renderImageModule(container);
        else if (id === 'nchat') renderChatModule(container);
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

    function renderQrModule(container) {
        var prefs = moduleCard('默认尺寸', '新建二维码时预选的尺寸；生成页仍可随时改。');
        var current = prefGet(PREF_KEYS.qrSize, '256');
        if (['128', '256', '512'].indexOf(current) < 0) current = '256';
        modulePrefRow(prefs, '尺寸', [
            { value: '128', label: '128 px' },
            { value: '256', label: '256 px' },
            { value: '512', label: '512 px' }
        ], current, {
            key: PREF_KEYS.qrSize,
            onChange: function () { setStatus('已保存二维码默认尺寸'); }
        });
        container.appendChild(prefs);

        var actions = moduleCard('快捷操作');
        var bar = util.e('div', { class: 'sp-data-card__actions' });
        bar.appendChild(button('打开二维码工具', { small: true, icon: 'qr-code', onClick: function () { openModule('qr'); } }));
        actions.appendChild(bar);
        container.appendChild(actions);
    }

    function renderImageModule(container) {
        var prefs = moduleCard('导出质量', '转换为 Base64 时 JPEG 的编码质量。');
        var current = prefGet(PREF_KEYS.imageQuality, '0.92');
        if (['0.8', '0.92', '0.98'].indexOf(current) < 0) current = '0.92';
        modulePrefRow(prefs, 'JPEG 质量', [
            { value: '0.8', label: '紧凑 80%' },
            { value: '0.92', label: '标准 92%' },
            { value: '0.98', label: '高清 98%' }
        ], current, {
            key: PREF_KEYS.imageQuality,
            onChange: function () { setStatus('已保存 JPEG 质量'); }
        });
        container.appendChild(prefs);

        var actions = moduleCard('快捷操作');
        var bar = util.e('div', { class: 'sp-data-card__actions' });
        bar.appendChild(button('打开图片工具', { small: true, icon: 'image', onClick: function () { openModule('image'); } }));
        actions.appendChild(bar);
        actions.appendChild(util.e('p', {
            class: 'sp-hint',
            text: '支持 PNG / JPEG / WebP / GIF / BMP，单张上限 20 MB；压缩比例在页面内调整。'
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
        liteRow.appendChild(util.e('span', { class: 'sp-row__label', text: 'Light 模式' }));
        liteRow.appendChild(switchField('关闭高级动效与页面特效，优先性能', NC.theme.isLite(), function (checked) {
            NC.theme.setLite(checked);
            renderSection('general');
        }));
        rows.appendChild(liteRow);

        /* 启动时默认页面：选项即左侧导航的模块 */
        var startRow = util.e('div', { class: 'sp-row' });
        startRow.appendChild(util.e('span', { class: 'sp-row__label', text: '启动时默认页面' }));
        var startSelect = util.e('select', { class: 'nc-select sp-select--start' });
        var tabTitles = (typeof NC.tabTitles === 'function' ? NC.tabTitles() : null) || {
            todo: '待办事项', email: '邮箱维护', nchat: 'nChat', md: '笔记本', qr: '二维码生成', image: '图片处理'
        };
        var currentStart = typeof NC.getStartTab === 'function' ? NC.getStartTab() : 'todo';
        ['todo', 'email', 'nchat', 'md', 'qr', 'image'].forEach(function (tab) {
            if (!tabTitles[tab]) return;
            var option = util.e('option', { value: tab, text: tabTitles[tab] });
            if (tab === currentStart) option.selected = true;
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
    function backupStatusText(status) {
        var parts = [];
        if (status.lastAt) parts.push('上次 ' + util.formatDateTime(status.lastAt) + '（' + (status.lastKind === 'zip' ? '下载 ZIP' : '本机自动') + '）');
        else parts.push('还没有备份过');
        if (status.enabled && status.nextAt) {
            parts.push(status.due ? '已到备份时间' : '下次约 ' + util.formatDateTime(status.nextAt));
        } else if (!status.enabled) {
            parts.push('自动备份已关闭');
        }
        return parts.join('　');
    }

    function renderBackupCard() {
        var backup = NC.backup;
        var card = moduleCard('一键备份全部数据',
            '把待办、笔记（含图片）、聊天、邮箱、AI 端点与全部偏好打包成一个 ZIP；换一台机器解压后用 JSON 恢复即可完全重建。');
        if (!backup) {
            card.appendChild(util.e('p', { class: 'sp-hint', text: '备份模块未加载（js/backup.js）' }));
            return card;
        }
        var status = backup.status();

        var bar = util.e('div', { class: 'sp-data-card__actions' });
        var includeKeys = util.e('input', { type: 'checkbox', class: 'nc-check' });
        includeKeys.checked = backup.readCfg().includeKeys === true;
        includeKeys.addEventListener('change', function () {
            backup.writeCfg({ includeKeys: includeKeys.checked });
        });
        var keyLabel = util.e('label', { class: 'sp-check' });
        keyLabel.appendChild(includeKeys);
        keyLabel.appendChild(util.e('span', { text: '包含 API Key（会明文写入 ZIP）' }));

        bar.appendChild(button('立即备份并下载 ZIP', {
            primary: true, small: true, icon: 'download',
            onClick: function (event) {
                var btn = event.currentTarget;
                ui.setBusy(btn, true);
                backup.downloadZip({ includeKeys: includeKeys.checked }).then(function (res) {
                    ui.setBusy(btn, false);
                    toast('已生成备份 ' + Math.round(res.bytes / 1024) + ' KB', 'success');
                    renderSection('data');
                }, function (err) {
                    ui.setBusy(btn, false);
                    toast('备份失败：' + (err && err.message ? err.message : err), 'error');
                });
            }
        }));
        bar.appendChild(keyLabel);
        card.appendChild(bar);

        /* 自动备份 */
        var autoRow = util.e('div', { class: 'sp-row' });
        autoRow.appendChild(util.e('span', { class: 'sp-row__label', text: '自动备份' }));
        var interval = util.e('select', { class: 'nc-select sp-select--auto' });
        [
            { value: '0', label: '关闭' },
            { value: '6', label: '每 6 小时' },
            { value: '12', label: '每 12 小时' },
            { value: '24', label: '每 24 小时（默认）' },
            { value: '72', label: '每 3 天' }
        ].forEach(function (item) {
            var option = util.e('option', { value: item.value, text: item.label });
            if (String(status.intervalHours) === item.value) option.selected = true;
            interval.appendChild(option);
        });
        interval.addEventListener('change', function () {
            var next = backup.setIntervalHours(Number(interval.value));
            toast(next.enabled ? '自动备份已设为每 ' + next.intervalHours + ' 小时' : '已关闭自动备份', 'success');
            renderSection('data');
        });
        autoRow.appendChild(interval);
        card.appendChild(autoRow);
        card.appendChild(util.e('p', { class: 'sp-hint', text: backupStatusText(status) }));

        var autoBar = util.e('div', { class: 'sp-data-card__actions' });
        autoBar.appendChild(button('立即执行一次自动备份', {
            small: true, ghost: true, icon: 'refresh',
            onClick: function (event) {
                var btn = event.currentTarget;
                ui.setBusy(btn, true);
                backup.runAuto('manual').then(function (res) {
                    ui.setBusy(btn, false);
                    if (res && res.ok) { toast('已保存到本机自动备份', 'success'); renderSection('data'); }
                    else toast('自动备份失败：' + ((res && res.error && res.error.message) || '未知原因'), 'error');
                });
            }
        }));
        autoBar.appendChild(button('从备份 JSON 恢复', {
            small: true, ghost: true, icon: 'upload',
            onClick: restoreFromBackupFile
        }));
        card.appendChild(autoBar);
        card.appendChild(util.e('p', {
            class: 'sp-hint',
            text: '自动备份保存在本机 IndexedDB（保留最近 3 份），浏览器数据被清空时也会一起丢；重要数据请同时下载 ZIP 存到磁盘。'
        }));

        var list = util.e('div', { class: 'sp-snap-list' });
        list.appendChild(util.e('div', { class: 'sp-data-card__desc', text: '最近的自动备份' }));
        card.appendChild(list);
        backup.listAuto().then(function (items) {
            if (!items.length) {
                list.appendChild(util.e('div', { class: 'sp-hint', text: '还没有自动备份' }));
                return;
            }
            items.forEach(function (item) {
                var row = util.e('div', { class: 'sp-snap-row' });
                row.appendChild(util.e('span', { class: 'sp-snap-row__time', text: util.formatDateTime(item.at) }));
                row.appendChild(util.e('span', {
                    class: 'sp-snap-row__meta',
                    text: '笔记 ' + (item.notes || 0) + '　聊天 ' + (item.chats || 0)
                }));
                row.appendChild(button('恢复', {
                    small: true, ghost: true,
                    onClick: function () {
                        ui.confirm('用 ' + util.formatDateTime(item.at) + ' 的自动备份覆盖当前全部数据？恢复后页面会自动刷新。', {
                            title: '恢复自动备份', confirmText: '恢复并刷新', danger: true
                        }).then(function (ok) {
                            if (!ok) return;
                            backup.restoreAuto(item.id).then(function (res) {
                                toast('恢复完成：' + (res.done || []).join('、') + '，即将刷新…', 'success');
                                global.setTimeout(function () { global.location.reload(); }, 1200);
                            }, function (err) {
                                toast('恢复失败：' + (err && err.message ? err.message : err), 'error');
                            });
                        });
                    }
                }));
                row.appendChild(button('删除', {
                    small: true, ghost: true,
                    onClick: function () {
                        backup.deleteAuto(item.id).then(function () { renderSection('data'); });
                    }
                }));
                list.appendChild(row);
            });
        });
        return card;
    }

    function restoreFromBackupFile() {
        var inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = '.json,application/json';
        inputEl.addEventListener('change', function () {
            var file = inputEl.files && inputEl.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (event) {
                var raw = String(event.target.result || '');
                var data = util.parseJSON(raw, null);
                if (!data) { toast('不是有效的 JSON', 'error'); return; }
                var summary = describeBackupPayload(data);
                ui.confirm((summary || '备份内容未识别。') + '\n\n恢复会覆盖当前数据（端点/偏好一并还原），完成后页面会刷新。继续？', {
                    title: '从备份恢复', confirmText: '恢复并刷新', danger: true
                }).then(function (ok) {
                    if (!ok) return;
                    if (!NC.backup) { toast('备份模块未加载', 'error'); return; }
                    NC.backup.restoreFromJson(raw).then(function (res) {
                        toast('恢复完成：' + (res.done || []).join('、') + '，即将刷新…', 'success');
                        global.setTimeout(function () { global.location.reload(); }, 1200);
                    }, function (err) {
                        toast('恢复失败：' + (err && err.message ? err.message : err), 'error');
                    });
                });
            };
            reader.onerror = function () { toast('读取文件失败', 'error'); };
            reader.readAsText(file);
        });
        inputEl.click();
    }

    function describeBackupPayload(data) {
        var parts = [];
        if (data.todo && Array.isArray(data.todo.tasks)) parts.push('待办 ' + data.todo.tasks.length + ' 条');
        if (data.notes && Array.isArray(data.notes.notes)) parts.push('笔记 ' + data.notes.notes.length + ' 篇');
        if (data.chats && Array.isArray(data.chats.sessions)) parts.push('会话 ' + data.chats.sessions.length + ' 个');
        if (data.email && (data.email.groups || data.email.emails)) parts.push('邮箱 ' + ((data.email.emails || []).length) + ' 条');
        if (data.llm) parts.push('AI 端点');
        if (data.prefs && Object.keys(data.prefs).length) parts.push('偏好 ' + Object.keys(data.prefs).length + ' 项');
        return parts.length ? '备份包含：' + parts.join('；') + '。' : '';
    }

    /* ------------------------------------------------------------------ *
     * 邮箱 JSON 导出 / 导入（邮箱维护 tab 与数据 tab 共用）
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
                        events.emit('email:imported');
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
    function storageUsedBytes() {
        var total = 0;
        try {
            var keys = NC.storage && NC.storage.keys ? NC.storage.keys() : [];
            keys.forEach(function (key) {
                var raw = NC.storage.getRaw(key);
                if (raw) total += NC.storage.estimateBytes(raw);
            });
        } catch (err) { total = 0; }
        return total;
    }

    function renderStorageCard() {
        var card = moduleCard('本地存储', '浏览器配额约 3.5 MB；接近上限时请先导出备份，再清理历史版本。');
        var used = storageUsedBytes();
        var limit = (NC.storage && NC.storage.maxBytes) || 3.5 * 1024 * 1024;
        var pct = Math.min(100, Math.max(used > 0 ? 1 : 0, Math.round((used / limit) * 100)));

        var row = util.e('div', { class: 'sp-usage' });
        row.appendChild(util.e('span', {
            class: 'sp-usage__label',
            text: '已用 ' + util.formatBytes(used) + ' / ' + util.formatBytes(limit)
        }));
        row.appendChild(util.e('span', { class: 'sp-usage__value', text: pct + '%' }));
        card.appendChild(row);

        var bar = util.e('div', {
            class: 'nc-progress',
            role: 'progressbar',
            'aria-label': '本地存储占用',
            'aria-valuemin': '0',
            'aria-valuemax': '100',
            'aria-valuenow': String(pct)
        });
        if (pct >= 85) bar.classList.add('nc-progress--danger');
        else if (pct >= 60) bar.classList.add('nc-progress--warn');
        var fill = util.e('span', { class: 'nc-progress__bar' });
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        card.appendChild(bar);
        return card;
    }

    function renderData(container) {
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: '数据' }));
        info.appendChild(util.e('p', { class: 'sp-section-desc', text: '所有数据仅保存在本机浏览器；导出时请注意密钥与隐私。' }));
        head.appendChild(info);
        container.appendChild(head);

        container.appendChild(renderBackupCard());
        container.appendChild(renderStorageCard());

        var canExport = NC.store.todo && typeof NC.store.todo.exportData === 'function';
        var card = util.e('div', { class: 'sp-data-card' });
        card.appendChild(util.e('div', { class: 'sp-data-card__title', text: '待办数据' }));
        card.appendChild(util.e('div', { class: 'sp-data-card__desc', text: '导出 JSON（可重新导入）' }));
        var actions = util.e('div', { class: 'sp-data-card__actions' });
        actions.appendChild(button('导出待办', {
            small: true, icon: 'download',
            onClick: function () {
                if (canExport) NC.tools.todo.exportToFile();
                else toast('待办模块未加载', 'warn');
            }
        }));
        actions.appendChild(button('导入待办', {
            small: true, icon: 'upload',
            onClick: function () {
                var file = document.getElementById('todo-import-file');
                if (file) file.click();
                else toast('待办模块未加载', 'warn');
            }
        }));
        actions.appendChild(button('清空待办', {
            small: true, danger: true, icon: 'trash',
            onClick: function () {
                ui.confirm('清空所有待办任务？将先自动备份到本地。', { danger: true, confirmText: '清空' })
                    .then(function (ok) {
                        if (!ok) return;
                        if (NC.store.todo && NC.store.todo.resetDocument) {
                            NC.store.todo.resetDocument();
                            toast('待办已清空', 'success');
                        }
                    });
            }
        }));
        card.appendChild(actions);
        container.appendChild(card);

        /* ---- 笔记：导出 / 导入 / 附件清理 / 快照 ---- */
        var notesCard = util.e('div', { class: 'sp-data-card' });
        notesCard.appendChild(util.e('div', { class: 'sp-data-card__title', text: '笔记' }));
        notesCard.appendChild(util.e('div', {
            class: 'sp-data-card__desc',
            text: '文本可导出 JSON；ZIP 会连同图片一起打包。导入为覆盖式，导入前自动快照。'
        }));
        var notesActions = util.e('div', { class: 'sp-data-card__actions' });
        notesActions.appendChild(button('导出 JSON', {
            small: true, icon: 'download',
            onClick: function () { exportNotes('json'); }
        }));
        notesActions.appendChild(button('导出 ZIP（含图片）', {
            small: true, icon: 'download',
            onClick: function () { exportNotes('zip'); }
        }));
        notesActions.appendChild(button('导入笔记', {
            small: true, icon: 'upload',
            onClick: function () { importNotes(); }
        }));
        notesActions.appendChild(button('清理未引用图片', {
            small: true, ghost: true, icon: 'trash',
            onClick: function () {
                withNotesStore(function () {
                    var notesStore = NC.store && NC.store.notes;
                    if (!notesStore || !notesStore.pruneOrphanFiles) { toast('笔记模块未加载', 'warn'); return; }
                    var stats = notesStore.fileStats ? notesStore.fileStats() : { count: 0 };
                    ui.confirm('删除没有被任何笔记引用的图片（当前共 ' + stats.count + ' 张）？此操作不可撤销。', {
                        confirmText: '清理', danger: true
                    }).then(function (ok) {
                        if (!ok) return;
                        var removed = notesStore.pruneOrphanFiles();
                        toast(removed ? '已清理 ' + removed + ' 张未引用图片' : '没有需要清理的图片', 'success');
                        renderSection('data');
                    });
                });
            }
        }));
        notesCard.appendChild(notesActions);
        notesCard.appendChild(renderNotesSnapshotList());
        container.appendChild(notesCard);

        container.appendChild(renderEmailTransferCard());

        var chatCard = util.e('div', { class: 'sp-data-card' });
        chatCard.appendChild(util.e('div', { class: 'sp-data-card__title', text: '聊天记录' }));
        chatCard.appendChild(util.e('div', { class: 'sp-data-card__desc', text: '按端点分别保存，可导出备份。' }));
        var chatActions = util.e('div', { class: 'sp-data-card__actions' });
        chatActions.appendChild(button('清除聊天记录', {
            small: true, danger: true, icon: 'trash',
            onClick: function () {
                ui.confirm('清除当前端点的聊天记录？该操作不可撤销。', { danger: true, confirmText: '清除' })
                    .then(function (ok) {
                        if (!ok) return;
                        if (NC.chatEmbed && typeof NC.chatEmbed.clearConversation === 'function') {
                            NC.chatEmbed.clearConversation();
                        } else if (NC.store.conversation) {
                            NC.store.conversation.clear();
                            events.emit('conversation:changed', { messages: [] });
                        }
                        toast('聊天记录已清除', 'success');
                    });
            }
        }));
        chatActions.appendChild(button('导出全部本地数据', {
            small: true, icon: 'download',
            onClick: exportEverything
        }));
        chatActions.appendChild(button('从备份恢复', {
            small: true, icon: 'upload',
            onClick: importEverything
        }));
        chatCard.appendChild(chatActions);
        container.appendChild(chatCard);

        container.appendChild(renderSnapshotCard());
        container.appendChild(renderLegacyCard());
    }

    /* ------------------------------------------------------------------ *
     * 分区：数据 —— 历史版本数据清理
     * 迁移后旧键一直留着（为了可回退），但它们会实实在在占用 3.5MB 预算。
     * 这里只列出"确定可删"的旧键，并让用户显式确认后再删。
     * ------------------------------------------------------------------ */
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
                events.emit('email:imported');
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
    function renderSection(id, opts) {
        var silent = !!(opts && opts.silent);
        currentSection = id;
        Array.prototype.forEach.call(navEl.children, function (nav) {
            var active = nav.getAttribute('data-section') === id;
            nav.classList.toggle('is-active', active);
            if (active) nav.setAttribute('aria-current', 'page');
            else nav.removeAttribute('aria-current');
        });
        bodyEl.textContent = '';
        bodyEl.scrollTop = 0;
        var wrap = util.e('div', { class: 'sp-content' + (silent ? '' : ' nc-anim-in') });
        if (id === 'profiles') renderProfiles(wrap);
        else if (id === 'todo') renderTodoModule(wrap);
        else if (id === 'general') renderGeneral(wrap);
        else if (id === 'data') renderData(wrap);
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
        var backdrop = util.e('div', { class: 'settings-sheet__backdrop' });
        backdrop.addEventListener('click', close);
        sheet.appendChild(backdrop);

        var panel = util.e('div', { class: 'settings-sheet__panel' });
        var head = util.e('div', { class: 'settings-sheet__head' });
        head.appendChild(util.e('div', { class: 'settings-sheet__title', text: '设置' }));
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
        requestAnimationFrame(function () { sheet.classList.add('is-open'); });
        open = true;
        renderSection(sectionId || currentSection || 'general', { silent: true });
        releaseTrap = ui.trapFocus(sheet);
        setTimeout(function () {
            if (closeBtn) closeBtn.focus();
        }, 50);
    }

    function close() {
        if (!built || !open) return;
        open = false;
        sheet.classList.remove('is-open');
        if (releaseTrap) { releaseTrap(); releaseTrap = null; }
        setTimeout(function () {
            if (!open) sheet.hidden = true;
        }, 240);
        if (previousFocus && previousFocus.focus) {
            try { previousFocus.focus(); } catch (err) { /* ignore */ }
        }
    }

    function init() {
        if (NC._settingsPanelInit) return;
        NC._settingsPanelInit = true;
        var btn = document.getElementById('settings-btn');
        if (btn) {
            btn.addEventListener('click', function () { openSheet('profiles'); });
        }
        events.on('app:open-settings', function (payload) {
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
