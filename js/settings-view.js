/**
 * settings-view.js — 设置面板 / 配置选择 / 配置导入导出
 * 经典脚本，依赖 core.js、icons.js、ui.js、schema-chat.js、settings-store.js。
 * 挂载到 NC.view.settings。
 *
 * 安全：导出配置默认剔除 API Key（用户需在模态框中显式选择"含密钥导出"）；
 *       导入的配置会经过 schema 归一化，API Key 缺失时提示重新填写。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var icons = NC.icons;
    var ui = NC.ui;
    var events = NC.events;

    var el = {};
    var initialized = false;
    var statusTimer = null;
    var menuOpen = false;
    var panelOpen = false;

    function schema() { return NC.schema && NC.schema.chat; }
    function store() { return NC.store.settings; }

    function toast(message, type) {
        ui.toast(message, { type: type || 'info' });
    }

    function setStatus(text, isError) {
        if (!el.saveStatus) return;
        el.saveStatus.textContent = text;
        el.saveStatus.classList.toggle('is-error', !!isError);
        el.saveStatus.classList.add('is-visible');
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(function () {
            if (el.saveStatus) el.saveStatus.classList.remove('is-visible');
        }, 2200);
    }

    /* ------------------------------------------------------------------ *
     * 表单同步
     * ------------------------------------------------------------------ */
    function refreshConfigSelect() {
        if (!el.select) return;
        var state = store().getState();
        el.select.textContent = '';
        state.configs.forEach(function (config) {
            el.select.appendChild(util.e('option', { value: config.id, text: config.name || '未命名配置' }));
        });
        el.select.value = state.currentId;
    }

    function syncAdvanced(open) {
        if (el.advancedContainer) {
            el.advancedContainer.classList.toggle('is-open', !!open);
            el.advancedContainer.setAttribute('aria-hidden', open ? 'false' : 'true');
        }
        if (el.advancedToggle) {
            el.advancedToggle.classList.toggle('is-open', !!open);
            el.advancedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
    }

    function syncForm() {
        var config = store().getConfig();
        if (!config) return;
        if (el.name) el.name.value = config.name || '';
        if (el.url) el.url.value = config.apiUrl || '';
        if (el.key) el.key.value = config.apiKey || '';
        if (el.model) el.model.value = config.modelId || '';
        if (el.system) el.system.value = config.systemPrompt || '';
        if (el.tempInput) el.tempInput.value = config.temperature;
        if (el.tempSlider) el.tempSlider.value = config.temperature;
        if (el.toppInput) el.toppInput.value = config.top_p;
        if (el.toppSlider) el.toppSlider.value = config.top_p;
        syncAdvanced(!!config.enableAdvanced);
        refreshConfigSelect();
        populateConfigMenu();
        if (el.url) el.url.classList.remove('has-error');
    }

    function populateConfigMenu() {
        if (!el.configMenu) return;
        var state = store().getState();
        el.configMenu.textContent = '';
        state.configs.forEach(function (config) {
            var active = config.id === state.currentId;
            var button = util.e('button', {
                type: 'button',
                class: 'chat-menu__item' + (active ? ' is-active' : ''),
                role: 'menuitem',
                title: config.name || '未命名配置',
                'aria-current': active ? 'true' : 'false'
            }, [
                util.e('span', { class: 'chat-menu__icon' }, [icons.el(active ? 'check' : 'folder', 15)]),
                util.e('span', { class: 'chat-menu__label nc-truncate', text: config.name || '未命名配置' }),
                util.e('span', { class: 'chat-menu__hint', text: config.modelId || '' })
            ]);
            button.addEventListener('click', function () {
                closeConfigMenu();
                chooseConfig(config.id);
            });
            el.configMenu.appendChild(button);
        });
    }

    /* ------------------------------------------------------------------ *
     * 菜单 / 面板开关
     * ------------------------------------------------------------------ */
    function openConfigMenu() {
        if (!el.configMenu || !el.titleWrapper) return;
        populateConfigMenu();
        el.configMenu.classList.add('is-open');
        el.configMenu.setAttribute('aria-hidden', 'false');
        el.titleWrapper.setAttribute('aria-expanded', 'true');
        menuOpen = true;
        var first = el.configMenu.querySelector('.chat-menu__item');
        if (first) first.focus();
    }

    function closeConfigMenu() {
        if (!el.configMenu) return;
        el.configMenu.classList.remove('is-open');
        el.configMenu.setAttribute('aria-hidden', 'true');
        if (el.titleWrapper) el.titleWrapper.setAttribute('aria-expanded', 'false');
        menuOpen = false;
    }

    function openPanel() {
        if (!el.panel) return;
        syncForm();
        el.panel.classList.add('is-open');
        el.panel.setAttribute('aria-hidden', 'false');
        if (el.toggleBtn) el.toggleBtn.setAttribute('aria-expanded', 'true');
        panelOpen = true;
    }

    function closePanel() {
        if (!el.panel) return;
        el.panel.classList.remove('is-open');
        el.panel.setAttribute('aria-hidden', 'true');
        if (el.toggleBtn) {
            el.toggleBtn.setAttribute('aria-expanded', 'false');
            try { el.toggleBtn.focus(); } catch (err) { /* ignore */ }
        }
        panelOpen = false;
    }

    function togglePanel() {
        if (panelOpen) closePanel();
        else openPanel();
    }

    function chooseConfig(id) {
        saveForm(true);
        store().select(id);
        syncForm();
        setStatus('已切换配置');
    }

    /* ------------------------------------------------------------------ *
     * 表单动作
     * ------------------------------------------------------------------ */
    function collectPatch() {
        var schemaChat = schema();
        var rawUrl = el.url ? el.url.value.trim() : '';
        var apiUrl = schemaChat ? (schemaChat.sanitizeApiUrl(rawUrl) || '') : rawUrl;
        return {
            name: el.name ? el.name.value.trim() : '',
            apiUrl: apiUrl,
            apiKey: el.key ? el.key.value.trim() : '',
            modelId: el.model ? el.model.value.trim() : '',
            systemPrompt: el.system ? el.system.value : '',
            enableAdvanced: !!(el.advancedContainer && el.advancedContainer.classList.contains('is-open')),
            temperature: el.tempInput ? parseFloat(el.tempInput.value) : 1,
            top_p: el.toppInput ? parseFloat(el.toppInput.value) : 0.95
        };
    }

    function saveForm(silent) {
        var schemaChat = schema();
        var rawUrl = el.url ? el.url.value.trim() : '';
        if (rawUrl && schemaChat && !schemaChat.sanitizeApiUrl(rawUrl)) {
            if (!silent) {
                if (el.url) el.url.classList.add('has-error');
                setStatus('Base URL 格式无效', true);
                toast('Base URL 格式无效，请填写 http(s) 地址', 'error');
            }
            return false;
        }
        store().save(collectPatch());
        if (el.url) el.url.classList.remove('has-error');
        if (!silent) setStatus('已保存');
        syncForm();
        return true;
    }

    function addConfig() {
        saveForm(true);
        store().create();
        syncForm();
        setStatus('已新建配置');
        if (el.name) el.name.focus();
    }

    function deleteConfig() {
        var config = store().getConfig();
        ui.confirm('确定要删除配置「' + (config ? config.name : '') + '」吗？该配置的 API Key 等设置将一并移除。', {
            title: '删除配置',
            confirmText: '删除',
            danger: true
        }).then(function (ok) {
            if (!ok) return;
            var result = store().remove(store().getState().currentId);
            if (!result.ok) {
                toast(result.reason || '删除失败', 'warn');
                return;
            }
            syncForm();
            setStatus('已删除配置');
            if (el.panel) el.panel.focus();
        });
    }

    /* ------------------------------------------------------------------ *
     * 导入 / 导出
     * ------------------------------------------------------------------ */
    function downloadSettings(includeKey) {
        var data = store().exportConfigs({ includeKey: !!includeKey });
        var ok = util.downloadBlob('nchat-settings.json', JSON.stringify(data, null, 2), 'application/json');
        if (!ok) {
            toast('导出失败：无法触发下载', 'error');
            return;
        }
        toast(includeKey ? '已导出配置（含 API Key，请妥善保管）' : '已导出配置（不含 API Key）', 'success');
    }

    function exportSettings() {
        ui.openModal({
            title: '导出配置',
            message: '为保护密钥，导出的配置文件默认不包含 API Key。选择"含密钥导出"会让密钥以明文写入文件，仅建议在受控设备间使用。',
            size: 'sm',
            actions: [
                { label: '取消', kind: 'ghost' },
                { label: '含密钥导出', kind: 'danger', onClick: function () { downloadSettings(true); } },
                { label: '不含密钥导出（推荐）', kind: 'primary', onClick: function () { downloadSettings(false); } }
            ]
        });
    }

    function importSettingsFile(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function (event) {
            var text = String(event.target.result || '');
            var parsed = util.parseJSON(text, null);
            if (parsed == null) {
                toast('导入失败：无法解析配置文件', 'error');
                return;
            }
            var count = Array.isArray(parsed.configs) ? parsed.configs.length : 1;
            ui.confirm('导入将替换当前全部配置（共 ' + count + ' 个）。' + (Array.isArray(parsed.configs) ? '' : '（检测到旧版单配置格式，将作为新配置加入）'), {
                title: '导入配置',
                confirmText: '导入',
                danger: true
            }).then(function (ok) {
                if (!ok) return;
                var snapshot = store().getState();
                var result = store().importConfigs(text);
                if (!result.ok) {
                    toast('导入失败：' + (result.reason || '未知错误'), 'error');
                    return;
                }
                syncForm();
                setStatus('已导入 ' + result.count + ' 个配置');
                ui.toast('配置已导入' + (parsed.keysIncluded === false ? '；备份不含 API Key，请重新填写' : ''), {
                    type: 'success',
                    duration: 5200,
                    action: {
                        label: '撤销',
                        onClick: function () {
                            store().restore(snapshot);
                            syncForm();
                            toast('已撤销导入', 'info');
                        }
                    }
                });
            });
        };
        reader.onerror = function () { toast('读取文件失败', 'error'); };
        reader.readAsText(file);
    }

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function bindSliderSync(rangeEl, numberEl) {
        if (!rangeEl || !numberEl) return;
        rangeEl.addEventListener('input', function () { numberEl.value = rangeEl.value; });
        numberEl.addEventListener('input', function () {
            var value = util.clamp(numberEl.value, 0, 2);
            rangeEl.value = value;
        });
        numberEl.addEventListener('change', function () {
            numberEl.value = util.clamp(numberEl.value, 0, 2);
            rangeEl.value = numberEl.value;
        });
    }

    function init() {
        if (initialized) return;
        initialized = true;
        el.panel = document.getElementById('settings-panel');
        el.toggleBtn = document.getElementById('toggle-settings-btn');
        el.select = document.getElementById('config-select');
        el.addBtn = document.getElementById('add-config-btn');
        el.delBtn = document.getElementById('delete-config-btn');
        el.name = document.getElementById('config-name');
        el.url = document.getElementById('api-url');
        el.key = document.getElementById('api-key');
        el.model = document.getElementById('model-id');
        el.system = document.getElementById('system-prompt');
        el.advancedToggle = document.getElementById('advanced-toggle-btn');
        el.advancedContainer = document.getElementById('advanced-settings-container');
        el.tempSlider = document.getElementById('temp-slider');
        el.tempInput = document.getElementById('temp-input');
        el.toppSlider = document.getElementById('topp-slider');
        el.toppInput = document.getElementById('topp-input');
        el.saveBtn = document.getElementById('save-settings-btn');
        el.saveStatus = document.getElementById('save-status');
        el.importBtn = document.getElementById('import-settings-btn');
        el.importInput = document.getElementById('import-settings-input');
        el.exportBtn = document.getElementById('export-settings-btn');
        el.titleWrapper = document.getElementById('title-wrapper');
        el.configMenu = document.getElementById('config-dropdown-menu');
        el.closeBtn = document.getElementById('settings-close-btn');

        if (el.toggleBtn) el.toggleBtn.addEventListener('click', togglePanel);
        if (el.closeBtn) el.closeBtn.addEventListener('click', closePanel);
        if (el.titleWrapper) {
            el.titleWrapper.addEventListener('click', function (event) {
                event.stopPropagation();
                if (menuOpen) closeConfigMenu();
                else openConfigMenu();
            });
        }
        if (el.select) {
            el.select.addEventListener('change', function (event) {
                chooseConfig(event.target.value);
            });
        }
        if (el.addBtn) el.addBtn.addEventListener('click', addConfig);
        if (el.delBtn) el.delBtn.addEventListener('click', deleteConfig);
        if (el.saveBtn) el.saveBtn.addEventListener('click', function () { saveForm(false); });
        if (el.advancedToggle) {
            el.advancedToggle.addEventListener('click', function () {
                syncAdvanced(!el.advancedContainer.classList.contains('is-open'));
            });
        }
        bindSliderSync(el.tempSlider, el.tempInput);
        bindSliderSync(el.toppSlider, el.toppInput);
        if (el.importBtn && el.importInput) {
            el.importBtn.addEventListener('click', function () { el.importInput.click(); });
            el.importInput.addEventListener('change', function (event) {
                var file = event.target.files && event.target.files[0];
                event.target.value = '';
                importSettingsFile(file);
            });
        }
        if (el.exportBtn) el.exportBtn.addEventListener('click', exportSettings);

        [el.name, el.url, el.key, el.model, el.system].forEach(function (field) {
            if (!field) return;
            field.addEventListener('input', function () {
                if (!field.classList.contains('has-error')) setStatus('未保存的修改');
            });
        });

        document.addEventListener('click', function (event) {
            if (!menuOpen) return;
            var target = event.target;
            if (!target || !target.closest) return;
            if (target.closest('#config-dropdown-menu') || target.closest('#title-wrapper')) return;
            closeConfigMenu();
        });
        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;
            if (menuOpen) {
                event.preventDefault();
                closeConfigMenu();
            } else if (panelOpen) {
                event.preventDefault();
                closePanel();
            }
        });

        store().subscribe(function (payload) {
            if (payload.reason === 'select' || payload.reason === 'create'
                || payload.reason === 'remove' || payload.reason === 'import'
                || payload.reason === 'restore') {
                syncForm();
            }
        });
        syncForm();
    }

    NC.view = NC.view || {};
    NC.view.settings = {
        init: init,
        open: openPanel,
        close: closePanel,
        syncForm: syncForm,
        refreshConfigSelect: refreshConfigSelect,
        populateConfigMenu: populateConfigMenu
    };
})(window);
