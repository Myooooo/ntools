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
    var currentSection = 'profiles';
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

    function sectionMeta() {
        return [
            { id: 'profiles', title: '模型端点', desc: '聊天与 Todo AI 共用的 OpenAI 兼容端点', icon: 'layers' },
            { id: 'todo-ai', title: 'Todo AI', desc: '文本识别提示词与采样参数', icon: 'sparkles' },
            { id: 'general', title: '通用', desc: '主题、Light 性能模式、上下班时间', icon: 'settings' },
            { id: 'data', title: '数据', desc: '导入导出与本地数据清理', icon: 'download' },
            { id: 'about', title: '关于', desc: '版本、兼容性与快捷键', icon: 'info' }
        ].concat(sections);
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
        var number = util.e('input', {
            type: 'number', min: '0', max: '2', step: step,
            value: String(value), class: 'nc-input sp-range__number'
        });
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
        paintProgress();
        wrap.appendChild(label);
        wrap.appendChild(range);
        wrap.appendChild(number);
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
                ghost: true, small: true, icon: 'refresh',
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

        var name = input({ value: profile.name, maxlength: '60', placeholder: '例如：内网 GPT-4o' });
        var baseUrl = input({ value: profile.baseUrl, placeholder: 'https://api.openai.com/v1', spellcheck: 'false' });
        var modelId = input({ value: profile.modelId, placeholder: 'gpt-4o', spellcheck: 'false' });
        var apiKey = input({ value: profile.apiKey, type: 'password', placeholder: 'sk-...', autocomplete: 'new-password' });
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
        var promptField = field('聊天系统提示词', prompt, '只对 nChat 生效；Todo AI 使用独立提示词');
        promptField.classList.add('sp-form-full');
        form.appendChild(promptField);

        var temp = profile.temperature;
        var topP = profile.topP;
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
        var storageText = NC.storage.memoryMode()
            ? '不可用（内存模式，关闭页面后数据丢失）'
            : '可用（localStorage）';
        nowRow.appendChild(util.e('span', { class: 'sp-row__value' + (NC.storage.memoryMode() ? ' is-error' : ''), text: storageText }));
        rows.appendChild(nowRow);

        container.appendChild(rows);
    }

    /* ------------------------------------------------------------------ *
     * 分区：数据
     * ------------------------------------------------------------------ */
    function renderData(container) {
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: '数据' }));
        info.appendChild(util.e('p', { class: 'sp-section-desc', text: '所有数据仅保存在本机浏览器；导出时请注意密钥与隐私。' }));
        head.appendChild(info);
        container.appendChild(head);

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
        chatCard.appendChild(chatActions);
        container.appendChild(chatCard);
    }

    function exportEverything() {
        var payload = {
            app: 'nTools',
            exportedAt: new Date().toISOString(),
            llm: store().exportAll({ includeKeys: false }),
            todo: null
        };
        if (NC.store.todo && typeof NC.store.todo.exportData === 'function') {
            try { payload.todo = NC.store.todo.exportData(); } catch (err) { payload.todo = null; }
        }
        util.downloadBlob('ntools-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(payload, null, 2), 'application/json');
        toast('已导出（不含密钥）', 'success');
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
            ['存储模式', NC.storage.memoryMode() ? '内存模式' : 'localStorage']
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
        else if (id === 'todo-ai') renderTodoAi(wrap);
        else if (id === 'general') renderGeneral(wrap);
        else if (id === 'data') renderData(wrap);
        else if (id === 'about') renderAbout(wrap);
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
        sectionMeta().forEach(function (section) {
            var nav = util.e('button', { type: 'button', class: 'sp-nav', dataset: { section: section.id } });
            nav.appendChild(icons.el(section.icon, 16));
            var text = util.e('span', { class: 'sp-nav__text' });
            text.appendChild(util.e('span', { class: 'sp-nav__title', text: section.title }));
            text.appendChild(util.e('span', { class: 'sp-nav__desc', text: section.desc }));
            nav.appendChild(text);
            nav.addEventListener('click', function () { editingProfileId = null; renderSection(section.id); });
            navEl.appendChild(nav);
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
        renderSection(sectionId || currentSection || 'profiles', { silent: true });
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
            else if (currentSection === 'todo-ai') { /* 保持输入 */ }
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
        isOpen: function () { return open; }
    };
})(window);
