/**
 * settings-store.js — 多配置状态与持久化
 * 经典脚本，依赖 core.js、storage.js、schema-chat.js。挂载到 NC.store.settings。
 *
 * 存储键：nchat-settings（形状保持 {currentId, configs}，内部 version:2）
 * 迁移：旧形状（无 version / 旧单配置）通过 schema.normalizeSettingsDoc 归一；
 *       迁移前把原始字符串备份到 nchat-settings.v1_backup，绝不删除原数据。
 * 事件：settings:changed {reason,currentId,configs,config}
 *       config:switched {configId,config}
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var events = NC.events;
    var storage = NC.storage;

    var KEY = 'nchat-settings';
    var LEGACY_BACKUP_KEY = 'nchat-settings.v1_backup';
    var VERSION = 2;

    var state = { version: VERSION, currentId: null, configs: [] };
    var listeners = [];

    function schema() {
        return NC.schema && NC.schema.chat;
    }

    function clone(value) {
        var schemaChat = schema();
        if (schemaChat && schemaChat.clone) return schemaChat.clone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function currentIndex() {
        for (var i = 0; i < state.configs.length; i += 1) {
            if (state.configs[i].id === state.currentId) return i;
        }
        return -1;
    }

    function getConfig() {
        var index = currentIndex();
        return index === -1 ? null : clone(state.configs[index]);
    }

    function notify(reason) {
        var payload = {
            reason: reason,
            currentId: state.currentId,
            configs: clone(state.configs),
            config: getConfig()
        };
        listeners.slice().forEach(function (fn) {
            try { fn(payload); } catch (err) { console.error('[NC] settings subscriber error:', err); }
        });
        events.emit('settings:changed', payload);
        if (reason === 'select' || reason === 'create' || reason === 'remove' || reason === 'restore' || reason === 'import') {
            events.emit('config:switched', { configId: state.currentId, config: getConfig() });
        }
    }

    function persist() {
        var result = storage.set(KEY, state);
        if (!result || !result.ok) {
            events.emit('settings:save-failed', {
                error: (result && result.error) || null,
                quota: !!(result && result.quota),
                memoryMode: !storage.available
            });
            return false;
        }
        return true;
    }

    function init() {
        var raw = storage.get(KEY, null);
        var schemaChat = schema();
        if (raw == null) {
            state = {
                version: VERSION,
                currentId: null,
                configs: schemaChat ? [schemaChat.createDefaultConfig('默认配置')] : []
            };
            state.currentId = state.configs.length ? state.configs[0].id : null;
        } else {
            var normalized = schemaChat
                ? schemaChat.normalizeSettingsDoc(raw)
                : { doc: { version: VERSION, currentId: null, configs: [] }, migrated: true };
            state = normalized.doc;
            if (normalized.migrated) {
                storage.setRaw(LEGACY_BACKUP_KEY, JSON.stringify(raw));
            }
        }
        persist();
        return getState();
    }

    function getState() {
        return {
            version: VERSION,
            currentId: state.currentId,
            configs: clone(state.configs)
        };
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var index = listeners.indexOf(fn);
            if (index > -1) listeners.splice(index, 1);
        };
    }

    function select(id) {
        var schemaChat = schema();
        if (typeof id !== 'string' || !schemaChat) return null;
        var exists = state.configs.some(function (config) { return config.id === id; });
        if (!exists) return null;
        if (state.currentId === id) return getConfig();
        state.currentId = id;
        persist();
        notify('select');
        return getConfig();
    }

    function create(name) {
        var schemaChat = schema();
        if (!schemaChat) return null;
        var config = schemaChat.createDefaultConfig(name || ('新配置 ' + (state.configs.length + 1)));
        state.configs.push(config);
        state.currentId = config.id;
        persist();
        notify('create');
        return clone(config);
    }

    function remove(id) {
        if (state.configs.length <= 1) {
            return { ok: false, reason: '至少保留一个配置' };
        }
        var before = state.currentId;
        var next = state.configs.filter(function (config) { return config.id !== id; });
        if (next.length === state.configs.length) {
            return { ok: false, reason: '配置不存在' };
        }
        state.configs = next;
        if (!next.some(function (config) { return config.id === state.currentId; })) {
            state.currentId = next[0].id;
        }
        persist();
        notify(state.currentId === before ? 'save' : 'remove');
        return { ok: true };
    }

    /** 保存当前配置（patch 只接受白名单字段；id 不可改）。 */
    function save(patch) {
        var schemaChat = schema();
        var index = currentIndex();
        if (index === -1 || !schemaChat) return null;
        var base = clone(state.configs[index]);
        if (patch && typeof patch === 'object') {
            schemaChat.WHITELIST.forEach(function (key) {
                if (key === 'id') return;
                if (Object.prototype.hasOwnProperty.call(patch, key)) base[key] = patch[key];
            });
        }
        var normalized = schemaChat.normalizeConfig(base);
        normalized.id = state.configs[index].id;
        state.configs[index] = normalized;
        persist();
        notify('save');
        return clone(normalized);
    }

    function exportConfigs(options) {
        var opts = options || {};
        var includeKey = !!opts.includeKey;
        var configs = state.configs.map(function (config) {
            var copy = clone(config);
            if (!includeKey) delete copy.apiKey;
            return copy;
        });
        return {
            version: VERSION,
            app: 'nChat',
            exportedAt: new Date().toISOString(),
            currentId: state.currentId,
            configs: configs,
            keysIncluded: includeKey
        };
    }

    /**
     * 导入配置：支持 {configs:[...]}、纯数组、旧版单配置对象。
     * 注意：默认导出的文件不含 apiKey，导入后需要用户重新填写。
     */
    function importConfigs(text) {
        var schemaChat = schema();
        if (!schemaChat) return { ok: false, reason: '校验模块未加载' };
        var data = typeof text === 'string' ? util.parseJSON(text, null) : text;
        if (data == null) return { ok: false, reason: '无法解析配置文件' };
        var rawConfigs = null;
        var preferredId = null;
        if (Array.isArray(data)) {
            rawConfigs = data;
        } else if (util.isPlainObject(data)) {
            if (Array.isArray(data.configs)) {
                rawConfigs = data.configs;
                preferredId = typeof data.currentId === 'string' ? data.currentId : null;
            } else if (data.apiUrl || data.apiKey || data.modelId || data.systemPrompt) {
                rawConfigs = [data];
            }
        }
        if (!rawConfigs) return { ok: false, reason: '配置文件中没有可用的配置' };
        var configs = schemaChat.normalizeConfigs(rawConfigs);
        state.configs = configs;
        var exists = configs.some(function (config) { return config.id === preferredId; });
        state.currentId = exists ? preferredId : configs[0].id;
        persist();
        notify('import');
        return { ok: true, count: configs.length };
    }

    /** 整体恢复（导入撤销使用）。 */
    function restore(snapshot) {
        var schemaChat = schema();
        if (!snapshot || !schemaChat) return false;
        state.configs = schemaChat.normalizeConfigs(snapshot.configs);
        var exists = state.configs.some(function (config) { return config.id === snapshot.currentId; });
        state.currentId = exists ? snapshot.currentId : state.configs[0].id;
        persist();
        notify('restore');
        return true;
    }

    NC.store = NC.store || {};
    NC.store.settings = {
        KEY: KEY,
        LEGACY_BACKUP_KEY: LEGACY_BACKUP_KEY,
        VERSION: VERSION,
        init: init,
        getState: getState,
        getConfig: getConfig,
        subscribe: subscribe,
        select: select,
        create: create,
        remove: remove,
        save: save,
        exportConfigs: exportConfigs,
        importConfigs: importConfigs,
        restore: restore
    };
})(window);
