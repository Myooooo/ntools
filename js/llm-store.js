/**
 * llm-store.js — 全局大模型端点（profile）与 AI 偏好的唯一数据源
 * 经典脚本，依赖 core.js / storage.js；可选依赖 schema-chat.js（有则用其 URL 校验）。
 * 挂载：NC.store.llm
 *
 * 设计：
 * - 存储键 ntools.llm.v1；首次启动迁移旧 nchat-settings（{currentId, configs[]} 或单配置对象）。
 * - 端点 profile：{id,name,baseUrl,apiKey,modelId,chatSystemPrompt,temperature,topP,createdAt,updatedAt}
 * - 全局偏好：todoAi{profileId,systemPrompt,temperature,topP}、workEndTime。
 * - 写操作立即持久化并 emit（llm:changed / llm:profile-selected）；所有函数不 throw。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var storage = NC.storage;
    var events = NC.events;

    var KEY = 'ntools.llm.v1';
    var LEGACY_KEY = 'nchat-settings';
    var VERSION = 1;

    var DEFAULT_TODO_PROMPT = [
        '你是待办事项提取助手。请从用户提供的文本中提取一项待办任务，并只输出 JSON 对象，不要输出解释。',
        '字段：title（≤80字）、notes（≤1000字）、due（YYYY-MM-DDTHH:mm 本地时间，无法判断为 null）、',
        'dueAllDay（boolean）、priority（low|normal|high|urgent）、tags（0-5 个字符串）、listName（可选）。',
        '当前时间：{{NOW}}（{{WEEKDAY}}，时区 {{TZ}}），下班时间 {{WORK_END}}。',
        '相对时间（如“明天下班前”“周五前”“月底前”）请换算成具体时间；无法判断 due 时给 null。'
    ].join('');

    function defaults() {
        return {
            version: VERSION,
            profiles: [newProfile({
                name: '默认端点',
                baseUrl: 'https://api.openai.com/v1',
                modelId: 'gpt-4o'
            })],
            currentProfileId: null,
            todoAi: {
                profileId: null,
                systemPrompt: DEFAULT_TODO_PROMPT,
                temperature: 0.2,
                topP: 0.9
            },
            workEndTime: '17:30',
            updatedAt: Date.now()
        };
    }

    function newProfile(partial) {
        var now = Date.now();
        var profile = {
            id: util.uid('p'),
            name: '新端点',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: '',
            modelId: 'gpt-4o',
            chatSystemPrompt: '',
            temperature: 1,
            topP: 0.95,
            createdAt: now,
            updatedAt: now
        };
        return applyProfilePatch(profile, partial || {}, true);
    }

    function str(value, fallback) {
        if (value == null) return fallback;
        return String(value);
    }

    function trimStr(value, fallback, max) {
        var text = str(value, fallback).trim();
        return max && text.length > max ? text.slice(0, max) : text;
    }

    function clampNum(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    function sanitizeUrl(value) {
        var text = trimStr(value, '', 500);
        if (!text) return '';
        if (NC.schema && NC.schema.chat && typeof NC.schema.chat.sanitizeApiUrl === 'function') {
            var clean = NC.schema.chat.sanitizeApiUrl(text);
            if (clean) return clean;
        }
        // 兜底：只允许 http/https
        try {
            var url = new URL(text.indexOf('://') === -1 ? 'https://' + text : text);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
            return url.href.replace(/\/+$/, '');
        } catch (err) {
            return '';
        }
    }

    function validTime(value) {
        return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    }

    function applyProfilePatch(profile, patch, creating) {
        var src = patch || {};
        if ('name' in src) profile.name = trimStr(src.name, profile.name, 60) || profile.name;
        if ('baseUrl' in src) profile.baseUrl = sanitizeUrl(src.baseUrl);
        if ('apiKey' in src) profile.apiKey = trimStr(src.apiKey, '', 2048);
        if ('modelId' in src) profile.modelId = trimStr(src.modelId, '', 120);
        if ('chatSystemPrompt' in src) profile.chatSystemPrompt = trimStr(src.chatSystemPrompt, '', 20000);
        if ('temperature' in src) profile.temperature = clampNum(src.temperature, profile.temperature, 0, 2);
        if ('topP' in src) profile.topP = clampNum(src.topP, profile.topP, 0, 2);
        if (creating && !('name' in src)) profile.name = '新端点';
        profile.updatedAt = Date.now();
        return profile;
    }

    function normalizeProfile(raw, index) {
        var now = Date.now();
        var src = (raw && typeof raw === 'object') ? raw : {};
        var profile = {
            id: typeof src.id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(src.id) ? src.id : util.uid('p'),
            name: trimStr(src.name, '端点 ' + ((index || 0) + 1), 60),
            baseUrl: sanitizeUrl(src.baseUrl || src.apiUrl || 'https://api.openai.com/v1'),
            apiKey: trimStr(src.apiKey, '', 2048),
            modelId: trimStr(src.modelId, 'gpt-4o', 120),
            chatSystemPrompt: trimStr(src.chatSystemPrompt || src.systemPrompt || '', '', 20000),
            temperature: clampNum(src.temperature, 1, 0, 2),
            topP: clampNum(src.topP != null ? src.topP : src.top_p, 0.95, 0, 2),
            createdAt: util.isFiniteNum(src.createdAt) ? src.createdAt : now,
            updatedAt: util.isFiniteNum(src.updatedAt) ? src.updatedAt : now
        };
        if (!profile.baseUrl) profile.baseUrl = 'https://api.openai.com/v1';
        return profile;
    }

    function normalizeTodoAi(raw) {
        var src = (raw && typeof raw === 'object') ? raw : {};
        return {
            profileId: (typeof src.profileId === 'string' && src.profileId) ? src.profileId : null,
            systemPrompt: trimStr(src.systemPrompt, DEFAULT_TODO_PROMPT, 20000) || DEFAULT_TODO_PROMPT,
            temperature: clampNum(src.temperature, 0.2, 0, 2),
            topP: clampNum(src.topP != null ? src.topP : src.top_p, 0.9, 0, 2)
        };
    }

    function normalizeDoc(raw) {
        var src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        var doc = defaults();
        var list = Array.isArray(src.profiles) ? src.profiles : null;
        if (!list && Array.isArray(src.configs)) list = src.configs;
        if (list) {
            var seen = Object.create(null);
            doc.profiles = list.slice(0, 30).map(function (item, index) {
                var profile = normalizeProfile(item, index);
                if (seen[profile.id]) profile.id = util.uid('p');
                seen[profile.id] = true;
                return profile;
            });
        }
        if (!doc.profiles.length) {
            doc.profiles = [newProfile({ name: '默认端点', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o' })];
        }
        var current = src.currentProfileId || src.currentId || '';
        doc.currentProfileId = doc.profiles.some(function (p) { return p.id === current; })
            ? current
            : doc.profiles[0].id;
        doc.todoAi = normalizeTodoAi(src.todoAi);
        if (doc.todoAi.profileId && !doc.profiles.some(function (p) { return p.id === doc.todoAi.profileId; })) {
            doc.todoAi.profileId = null;
        }
        doc.workEndTime = validTime(src.workEndTime) ? src.workEndTime : '17:30';
        doc.updatedAt = util.isFiniteNum(src.updatedAt) ? src.updatedAt : Date.now();
        return doc;
    }

    var state = defaults();
    var listeners = [];
    var initialized = false;
    var loadInfo = { migratedFrom: null, profiles: 0 };

    function snapshot() {
        return util.parseJSON(JSON.stringify(state), normalizeDoc({}));
    }

    function notify(reason, extra) {
        var payload = { state: snapshot(), reason: reason || 'change' };
        if (extra) {
            Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
        }
        listeners.slice().forEach(function (fn) {
            try { fn(payload); } catch (err) { /* 视图异常不影响数据层 */ }
        });
        events.emit('llm:changed', payload);
    }

    function persist() {
        state.updatedAt = Date.now();
        var result = storage.set(KEY, state);
        if (!result || result.ok === false) {
            events.emit('llm:error', {
                message: result && result.quota ? '本地存储空间不足，端点配置暂存内存' : '端点配置保存失败'
            });
        }
        return result;
    }

    function commit(reason, extra) {
        persist();
        notify(reason, extra);
    }

    /* ------------------------------------------------------------------ *
     * 初始化 / 迁移
     * ------------------------------------------------------------------ */
    function init() {
        if (initialized) return snapshot();
        var saved = storage.get(KEY, null);
        if (saved && typeof saved === 'object') {
            state = normalizeDoc(saved);
            loadInfo = { migratedFrom: null, profiles: state.profiles.length };
        } else {
            var legacy = storage.get(LEGACY_KEY, null);
            if (legacy) {
                state = normalizeDoc(legacy);
                state.todoAi = normalizeTodoAi(null);
                loadInfo = { migratedFrom: 'nchat-settings', profiles: state.profiles.length };
                persist();
            } else {
                state = defaults();
                state.currentProfileId = state.profiles[0].id;
                persist();
            }
        }
        initialized = true;
        notify('init');
        return snapshot();
    }

    function ensure() {
        if (!initialized) init();
        return state;
    }

    function findProfile(id) {
        ensure();
        for (var i = 0; i < state.profiles.length; i++) {
            if (state.profiles[i].id === id) return state.profiles[i];
        }
        return null;
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var index = listeners.indexOf(fn);
            if (index > -1) listeners.splice(index, 1);
        };
    }

    function getState() { ensure(); return snapshot(); }
    function getProfiles() { return snapshot().profiles; }
    function getProfile(id) {
        ensure();
        var profile = findProfile(id);
        return profile ? snapshotProfile(profile) : null;
    }
    function snapshotProfile(profile) {
        return profile ? util.parseJSON(JSON.stringify(profile), null) : null;
    }
    function getCurrentProfile() {
        ensure();
        return snapshotProfile(findProfile(state.currentProfileId) || state.profiles[0]);
    }

    function selectProfile(id) {
        ensure();
        if (!findProfile(id)) return false;
        if (state.currentProfileId === id) return true;
        state.currentProfileId = id;
        commit('select-profile');
        events.emit('llm:profile-selected', { profileId: id, profile: getProfile(id) });
        return true;
    }

    function addProfile(partial) {
        ensure();
        if (state.profiles.length >= 30) return null;
        var profile = normalizeProfile(newProfile(partial), state.profiles.length);
        state.profiles.push(profile);
        if (!state.currentProfileId) state.currentProfileId = profile.id;
        commit('add-profile', { profileId: profile.id });
        return snapshotProfile(profile);
    }

    function updateProfile(id, patch) {
        ensure();
        var profile = findProfile(id);
        if (!profile) return null;
        applyProfilePatch(profile, patch || {});
        commit('update-profile', { profileId: id });
        return snapshotProfile(profile);
    }

    function removeProfile(id) {
        ensure();
        if (state.profiles.length <= 1) return false;
        var index = -1;
        state.profiles.forEach(function (profile, i) { if (profile.id === id) index = i; });
        if (index === -1) return false;
        state.profiles.splice(index, 1);
        if (state.currentProfileId === id) state.currentProfileId = state.profiles[0].id;
        if (state.todoAi.profileId === id) state.todoAi.profileId = null;
        commit('remove-profile', { profileId: id });
        return true;
    }

    function setChatSystemPrompt(profileId, text) {
        return updateProfile(profileId, { chatSystemPrompt: text });
    }

    function getChatConfig(profileId) {
        ensure();
        var profile = findProfile(profileId || state.currentProfileId);
        if (!profile) return null;
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
    }

    function getTodoAi() {
        ensure();
        return util.parseJSON(JSON.stringify(state.todoAi), normalizeTodoAi(null));
    }

    function setTodoAi(patch) {
        ensure();
        var next = normalizeTodoAi({
            profileId: ('profileId' in (patch || {})) ? patch.profileId : state.todoAi.profileId,
            systemPrompt: ('systemPrompt' in (patch || {})) ? patch.systemPrompt : state.todoAi.systemPrompt,
            temperature: ('temperature' in (patch || {})) ? patch.temperature : state.todoAi.temperature,
            topP: ('topP' in (patch || {})) ? patch.topP : state.todoAi.topP
        });
        if (next.profileId && !findProfile(next.profileId)) next.profileId = null;
        state.todoAi = next;
        commit('todo-ai');
        return getTodoAi();
    }

    function getWorkEndTime() {
        ensure();
        return state.workEndTime;
    }

    function setWorkEndTime(value) {
        ensure();
        if (!validTime(value)) return false;
        if (state.workEndTime === value) return true;
        state.workEndTime = value;
        commit('work-end-time');
        return true;
    }

    function exportAll(options) {
        ensure();
        var includeKeys = !!(options && options.includeKeys);
        var profiles = state.profiles.map(function (profile) {
            var copy = snapshotProfile(profile);
            if (!includeKeys) delete copy.apiKey;
            return copy;
        });
        return {
            version: VERSION,
            app: 'nTools',
            exportedAt: new Date().toISOString(),
            profiles: profiles,
            currentProfileId: state.currentProfileId,
            todoAi: getTodoAi(),
            workEndTime: state.workEndTime,
            keysIncluded: includeKeys
        };
    }

    function importAll(raw, options) {
        var data = (typeof raw === 'string') ? util.parseJSON(raw, null) : raw;
        if (!data || typeof data !== 'object') {
            return { ok: false, imported: 0, rejected: 0, message: '文件格式无效' };
        }
        var incoming = normalizeDoc(data);
        var merge = !!(options && options.merge);
        if (merge) {
            var byId = Object.create(null);
            state.profiles.forEach(function (profile) { byId[profile.id] = profile; });
            var imported = 0;
            incoming.profiles.forEach(function (profile) {
                if (byId[profile.id]) {
                    applyProfilePatch(byId[profile.id], profile);
                } else {
                    state.profiles.push(profile);
                }
                imported += 1;
            });
            if (incoming.todoAi) state.todoAi = normalizeTodoAi(incoming.todoAi);
            if (data.workEndTime && validTime(data.workEndTime)) state.workEndTime = data.workEndTime;
            commit('import-merge');
            return { ok: true, imported: imported, rejected: 0, message: '已合并 ' + imported + ' 个端点' };
        }
        state = incoming;
        if (!findProfile(state.currentProfileId)) state.currentProfileId = state.profiles[0].id;
        commit('import-replace');
        return { ok: true, imported: state.profiles.length, rejected: 0, message: '已导入 ' + state.profiles.length + ' 个端点' };
    }

    function reset() {
        state = defaults();
        state.currentProfileId = state.profiles[0].id;
        commit('reset');
        return true;
    }

    NC.store = NC.store || {};
    NC.store.llm = {
        KEY: KEY,
        LEGACY_KEY: LEGACY_KEY,
        VERSION: VERSION,
        DEFAULT_TODO_PROMPT: DEFAULT_TODO_PROMPT,
        init: init,
        getState: getState,
        getProfiles: getProfiles,
        getProfile: getProfile,
        getCurrentProfile: getCurrentProfile,
        selectProfile: selectProfile,
        addProfile: addProfile,
        updateProfile: updateProfile,
        removeProfile: removeProfile,
        setChatSystemPrompt: setChatSystemPrompt,
        getChatConfig: getChatConfig,
        getTodoAi: getTodoAi,
        setTodoAi: setTodoAi,
        getWorkEndTime: getWorkEndTime,
        setWorkEndTime: setWorkEndTime,
        exportAll: exportAll,
        importAll: importAll,
        reset: reset,
        subscribe: subscribe,
        getLoadInfo: function () { return loadInfo; }
    };
})(window);
