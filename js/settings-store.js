/**
 * settings-store.js — v3 适配层：把全局端点数据 NC.store.llm 适配为聊天侧 settings 接口
 * 经典脚本，依赖 core.js、llm-store.js。挂载：NC.store.settings
 *
 * v3 变更：不再直接读写 nchat-settings（旧键由 llm-store.js 在首次启动时一次性迁移），
 * 本文件只读 NC.store.llm，并把 llm 事件桥接为聊天侧事件：
 *   llm:changed            → settings:changed {reason,currentId,configs,config}
 *   当前端点变化（任意原因） → config:switched    {configId,config}
 *
 * API（兼容 v2 聊天调用方）：
 *   init() → state | getState() | getConfig(profileId?) | getProfiles() | getCurrentProfile()
 *   subscribe(fn) → off | select(profileId) | selectProfile 同义
 * 说明：不做任何持久化写入；所有写操作由 NC.store.llm / 设置面板负责。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var events = NC.events;

    var listeners = [];
    var bridged = false;
    var lastCurrentId = null;
    var initialized = false;

    function llm() {
        return NC.store && NC.store.llm ? NC.store.llm : null;
    }

    function buildConfigs() {
        var store = llm();
        if (!store) return [];
        return store.getProfiles().map(function (profile) {
            return {
                id: profile.id,
                name: profile.name,
                apiUrl: profile.baseUrl,
                apiKey: profile.apiKey,
                modelId: profile.modelId,
                systemPrompt: profile.chatSystemPrompt || '',
                enableAdvanced: true,
                temperature: profile.temperature,
                top_p: profile.topP
            };
        });
    }

    /** 聊天请求配置（NC.api.chat 使用的形状）；不存在返回 null。 */
    function getConfig(profileId) {
        var store = llm();
        if (!store || typeof store.getChatConfig !== 'function') return null;
        return store.getChatConfig(profileId);
    }

    function getState() {
        var store = llm();
        if (!store) {
            return { version: 1, currentId: null, configs: [], profiles: [] };
        }
        var state = store.getState();
        return {
            version: 1,
            currentId: state.currentProfileId,
            configs: buildConfigs(),
            profiles: state.profiles,
            todoAi: state.todoAi,
            workEndTime: state.workEndTime
        };
    }

    function emit(reason) {
        var state = getState();
        var payload = {
            reason: reason || 'change',
            currentId: state.currentId,
            configs: state.configs,
            config: getConfig()
        };
        listeners.slice().forEach(function (fn) {
            try { fn(payload); } catch (err) { console.error('[NC] settings subscriber error:', err); }
        });
        events.emit('settings:changed', payload);
    }

    function bindBridge() {
        if (bridged) return;
        var store = llm();
        if (!store || typeof store.subscribe !== 'function') return;
        bridged = true;
        store.subscribe(function (payload) {
            var reason = (payload && payload.reason) || 'change';
            emit(reason);
            var current = getState().currentId;
            if (current !== lastCurrentId) {
                lastCurrentId = current;
                events.emit('config:switched', { configId: current, config: getConfig() });
            }
        });
    }

    function init() {
        var store = llm();
        if (!store) {
            console.warn('[NC] settings 适配层：NC.store.llm 未就绪');
            return getState();
        }
        store.init();
        bindBridge();
        lastCurrentId = getState().currentId;
        initialized = true;
        return getState();
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var index = listeners.indexOf(fn);
            if (index > -1) listeners.splice(index, 1);
        };
    }

    function select(profileId) {
        var store = llm();
        if (!store || typeof store.selectProfile !== 'function') return null;
        if (!store.selectProfile(profileId)) return null;
        return getConfig(profileId);
    }

    NC.store = NC.store || {};
    NC.store.settings = {
        VERSION: 1,
        init: init,
        isInitialized: function () { return initialized; },
        getState: getState,
        getConfig: getConfig,
        getProfiles: function () {
            var store = llm();
            return store ? store.getProfiles() : [];
        },
        getCurrentProfile: function () {
            var store = llm();
            return store ? store.getCurrentProfile() : null;
        },
        subscribe: subscribe,
        select: select,
        selectProfile: select
    };
})(window);
