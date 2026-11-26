/**
 * settings-profiles.js — 设置 → 模型端点（列表 / 编辑 / 导入导出）
 * 随设置面板按需加载；由 NC.settingsProfiles.render(container, deps) 调用。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    function render(container, deps) {
        var util = deps.util;
        var ui = deps.ui;
        var toast = deps.toast;
        var setStatus = deps.setStatus;
        var field = deps.field;
        var input = deps.input;
        var button = deps.button;
        var switchField = deps.switchField;
        var segmented = deps.segmented;
        var rangeRow = deps.rangeRow;
        var store = deps.store;
        var ai = deps.ai;
        var renderSection = deps.renderSection;

function renderProfiles(container) {
        var doc = store().getState();
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: '模型端点' }));
        var currentProfile = doc.profiles.filter(function (item) { return item.id === doc.currentProfileId; })[0];
        info.appendChild(util.e('p', {
            class: 'sp-section-desc',
            text: '所有端点保存在本机，支持 OpenAI 与 BOCAI 两种 API 格式。共 ' + doc.profiles.length + ' 个端点' +
                (currentProfile ? '，当前使用「' + currentProfile.name + '」' : '') + '。'
        }));
        head.appendChild(info);
        var actions = util.e('div', { class: 'sp-section-actions' });
        actions.appendChild(button('新增端点', {
            primary: true, icon: 'plus', onClick: function () {
                var profile = store().addProfile({ name: '新端点 ' + (doc.profiles.length + 1) });
                if (profile) {
                    deps.setEditingId(profile.id);
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
            var editing = profile.id === deps.getEditingId();
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
                if (editing) { deps.setEditingId(null); renderSection('profiles'); return; }
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
                    deps.setEditingId(editing ? null : profile.id);
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
                        deps.setEditingId(null);
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
        deps.setEditingId(copy.id);
        renderSection('profiles');
        toast('已复制为「' + copy.name + '」，可直接修改名称', 'success');
        var body = deps.getBodyEl ? deps.getBodyEl() : deps.bodyEl;
        if (body && body.querySelector) {
            var editor = body.querySelector('.sp-profile-editor');
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
        form.appendChild(rangeRow('Temperature', temp, '0.1', function (v) { temp = v; }, { min: 0, max: 2 }));
        form.appendChild(rangeRow('Top P', topP, '0.05', function (v) { topP = v; }, { min: 0, max: 1 }));
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
            onClick: function () { deps.setEditingId(null); renderSection('profiles'); }
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
                deps.setEditingId(null);
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

        renderProfiles(container);
    }

    NC.settingsProfiles = { render: render };
})(window);
