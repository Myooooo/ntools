/**
 * settings-workshop.js — 设置 → 创意工坊（生成参数）
 * 独立成文件，随设置面板按需加载；由 NC.settingsWorkshop.render(container, deps) 调用。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    function render(container, deps) {
        var util = deps.util;
        var ui = deps.ui;
        var toast = deps.toast;
        var setStatus = deps.setStatus;
        var moduleCard = deps.moduleCard;
        var moduleRows = deps.moduleRows;
        var button = deps.button;
        var switchField = deps.switchField;
        var segmented = deps.segmented;
        var openModule = deps.openModule;
        var renderSection = deps.renderSection;

var workshopLoading = false;

    function renderWorkshopParams(container) {
        var store = NC.store && NC.store.workshop;
        var schema = NC.schema && NC.schema.workshop;
        if (!store || !store.isReady()) {
            var loading = moduleCard('生成参数', '正在准备创意工坊数据…');
            container.appendChild(loading);
            if (NC.loadWorkshopBundle && !workshopLoading) {
                workshopLoading = true;
                NC.loadWorkshopBundle()
                    .then(function () { return NC.store.workshop.init(); })
                    .then(function () { workshopLoading = false; renderSection('workshop'); },
                        function () { workshopLoading = false; });
            }
            return;
        }

        var params = store.getParams();
        var defaults = schema.DEFAULT_PARAMS;


        /* 参数 */
        var card = moduleCard('生成参数', '只影响创意工坊的模型调用；nChat 使用「AI 端点」里的设置。');

        var endpointRow = util.e('div', { class: 'sp-row' });
        endpointRow.appendChild(util.e('span', { class: 'sp-row__label', text: '使用的端点' }));
        var endpointSelect = util.e('select', { class: 'nc-select sp-select--ws-endpoint' });
        endpointSelect.appendChild(util.e('option', { value: '', text: '跟随当前端点' }));
        var profiles = [];
        try { profiles = NC.store.llm.getProfiles() || []; } catch (err) { profiles = []; }
        profiles.forEach(function (profile) {
            var option = util.e('option', { value: profile.id, text: profile.name || profile.modelId || profile.id });
            if (profile.id === params.endpointId) option.selected = true;
            endpointSelect.appendChild(option);
        });
        endpointSelect.addEventListener('change', function () {
            store.setParams({ endpointId: endpointSelect.value });
            setStatus('已切换创意工坊端点');
        });
        endpointRow.appendChild(endpointSelect);
        card.appendChild(endpointRow);

        function numberRow(label, value, step, min, max, onCommit) {
            var row = util.e('div', { class: 'sp-row' });
            row.appendChild(util.e('span', { class: 'sp-row__label', text: label }));
            var input = util.e('input', { type: 'number', class: 'nc-input sp-number', value: String(value), step: String(step), min: String(min), max: String(max) });
            input.addEventListener('change', function () {
                var next = Number(input.value);
                if (!isFinite(next)) { input.value = String(value); return; }
                next = Math.min(max, Math.max(min, next));
                input.value = String(next);
                onCommit(next);
            });
            row.appendChild(input);
            card.appendChild(row);
            return input;
        }

        numberRow('temperature', params.temperature, 0.05, 0, 2, function (next) {
            store.setParams({ temperature: next });
            setStatus('temperature 已更新为 ' + next);
        });
        numberRow('top_p', params.topP, 0.05, 0, 1, function (next) {
            store.setParams({ topP: next });
            setStatus('top_p 已更新为 ' + next);
        });

        var networkRow = util.e('div', { class: 'sp-row' });
        networkRow.appendChild(util.e('span', { class: 'sp-row__label', text: '允许生成页联网' }));
        networkRow.appendChild(switchField('关闭后生成页的 fetch / 外链脚本一律被 CSP 拦截', params.allowNetwork !== false, function (checked) {
            store.setParams({ allowNetwork: checked });
            setStatus(checked ? '生成页可以访问网络' : '生成页已禁止联网');
        }));
        card.appendChild(networkRow);

        var reasonRow = util.e('div', { class: 'sp-row' });
        reasonRow.appendChild(util.e('span', { class: 'sp-row__label', text: '推理' }));
        reasonRow.appendChild(switchField('发送推理请求（关闭则不带推理字段）', params.reasoning, function (checked) {
            store.setParams({ reasoning: checked });
            renderSection('workshop');
        }));
        card.appendChild(reasonRow);

        var effortRow = util.e('div', { class: 'sp-row' });
        effortRow.appendChild(util.e('span', { class: 'sp-row__label', text: '推理强度' }));
        effortRow.appendChild(segmented([
            { value: 'low', label: '低' },
            { value: 'medium', label: '中' },
            { value: 'high', label: '高' }
        ], params.reasoning ? params.effort : '', function (next) {
            store.setParams({ effort: next });
            renderSection('workshop');
        }));
        card.appendChild(effortRow);

        function countRow(label, value, min, max, key, hint) {
            var row = util.e('div', { class: 'sp-row' });
            row.appendChild(util.e('span', { class: 'sp-row__label', text: label }));
            var wrap = util.e('div', { class: 'sp-row__control' });
            var input = util.e('input', { type: 'text', class: 'nc-input sp-count', value: schema.formatCount(value) });
            input.addEventListener('change', function () {
                var parsed = schema.parseCount(input.value, { min: min, max: max });
                if (parsed == null) {
                    input.classList.add('has-error');
                    toast('请输入 ' + schema.formatCount(min) + ' ~ ' + schema.formatCount(max) + ' 之间的数值（支持 k / m）', 'error');
                    input.value = schema.formatCount(store.getParams()[key]);
                    return;
                }
                input.classList.remove('has-error');
                input.value = schema.formatCount(parsed);
                var patch = {};
                patch[key] = parsed;
                store.setParams(patch);
                setStatus(label + ' 已更新为 ' + parsed.toLocaleString('zh-CN'));
            });
            wrap.appendChild(input);
            if (hint) wrap.appendChild(util.e('span', { class: 'sp-hint', text: hint }));
            row.appendChild(wrap);
            card.appendChild(row);
            return input;
        }

        countRow('输入上下文长度', params.contextLimit, 1024, schema.LIMITS.contextMax, 'contextLimit', '支持 k / m，例如 256k');
        countRow('输出长度', params.outputLimit, 256, schema.LIMITS.outputMax, 'outputLimit', '映射为 max_tokens，例如 25.6k');

        var bar = util.e('div', { class: 'sp-data-card__actions' });
        bar.appendChild(button('恢复默认设置', {
            small: true, ghost: true, icon: 'rotate-ccw',
            onClick: function () {
                ui.confirm('把创意工坊的全部生成参数恢复为默认值（不影响端点与已保存应用）？', {
                    title: '恢复默认设置', confirmText: '恢复默认'
                }).then(function (ok) {
                    if (!ok) return;
                    store.resetParams();
                    renderSection('workshop');
                    toast('已恢复默认参数', 'success');
                });
            }
        }));
        bar.appendChild(util.e('span', {
            class: 'sp-hint',
            text: '默认：temp ' + defaults.temperature + ' · top_p ' + defaults.topP +
                ' · 推理开（' + defaults.effort + '）· 输入 ' + schema.formatCount(defaults.contextLimit) +
                ' · 输出 ' + schema.formatCount(defaults.outputLimit)
        }));
        card.appendChild(bar);
        card.appendChild(util.e('p', {
            class: 'sp-hint',
            text: '部分网关不接受 reasoning_effort / max_tokens，首次报 400 时会自动去掉这些字段重试一次。'
        }));
        container.appendChild(card);

        /* 库状态 */
        var stats = store.stats();
        var status = moduleCard('模块状态', '内置工具随包发布、不可编辑；自定义应用保存在本机 IndexedDB。');
        moduleRows(status, [
            ['自定义应用', stats.apps + ' 个'],
            ['历史版本', stats.versions + ' 个'],
            ['代码占用', util.formatBytes(stats.bytes)],
            ['存储位置', store.getMode() === 'idb' ? 'IndexedDB（可用）' : 'localStorage 降级']
        ]);
        var statusBar = util.e('div', { class: 'sp-data-card__actions' });
        statusBar.appendChild(button('打开创意工坊', { small: true, primary: true, icon: 'wand', onClick: function () { openModule('workshop'); } }));
        status.appendChild(statusBar);
        container.appendChild(status);
    }

        renderWorkshopParams(container);
    }

    NC.settingsWorkshop = { render: render };
})(window);
