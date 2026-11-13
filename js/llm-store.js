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
        'dueAllDay（boolean）、priority（low|normal|high|urgent）、tags（0-5 个字符串）、listName（可选）、',
        'recurrence（循环规则，null 或 {"freq":"daily"|"weekly"|"monthly"|"yearly","interval":1}）。',
        '当前时间：{{NOW}}（{{WEEKDAY}}，时区 {{TZ}}），下班时间 {{WORK_END}}。',
        '相对时间（如“明天下班前”“周五前”“月底前”）请换算成具体时间；无法判断 due 时给 null。',
        '识别“每天/每周/每月/每年/工作日每天”等循环语义时填写 recurrence（工作日每天按 daily，interval 固定为 1）；一次性任务 recurrence 为 null。'
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
            legacyMerged: false,
            legacyMergedAt: null,
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
            apiFormat: 'openai',
            chatSystemPrompt: '',
            temperature: 1,
            topP: 0.95,
            createdAt: now,
            updatedAt: now
        };
        return applyProfilePatch(profile, partial || {}, true);
    }

    /** API 格式：openai（默认）/ bocai；未知值一律回落 openai。 */
    function normalizeApiFormat(value) {
        var text = value == null ? '' : String(value).trim().toLowerCase();
        return text === 'bocai' ? 'bocai' : 'openai';
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
        if ('apiFormat' in src) profile.apiFormat = normalizeApiFormat(src.apiFormat);
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
            apiFormat: normalizeApiFormat(src.apiFormat || src.api_format || 'openai'),
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
        // 旧 nChat 配置一次性合并标记：normalize 必须保留，避免每次启动重复导入，
        // 也避免用户手动删除旧端点后又被复活。
        doc.legacyMerged = src.legacyMerged === true;
        doc.legacyMergedAt = util.isFiniteNum(src.legacyMergedAt) ? src.legacyMergedAt : null;
        doc.updatedAt = util.isFiniteNum(src.updatedAt) ? src.updatedAt : Date.now();
        return doc;
    }

    /* ------------------------------------------------------------------ *
     * 旧 nChat 配置（nchat-settings）一次性合并
     * 兼容两种旧形状：{currentId, configs:[...]} 与单对象 {apiUrl,...}。
     * 字段映射：apiUrl→baseUrl、systemPrompt→chatSystemPrompt、top_p→topP。
     * 去重：优先 id；其次 baseUrl+modelId（若现有的是“默认端点”占位则采纳旧 id，
     * 以保留旧会话的 session key）。合并只补空字段，不覆盖用户新配置。
     * ------------------------------------------------------------------ */
    function normalizeLegacyConfigs(raw) {
        if (!raw || typeof raw !== 'object') return { configs: [], currentId: null };
        if (Array.isArray(raw)) return { configs: raw, currentId: null };
        var list = Array.isArray(raw.configs) ? raw.configs : null;
        if (!list) {
            // 更旧的单对象格式（没有 configs 包裹）
            if (raw.apiUrl || raw.baseUrl || raw.apiKey || raw.modelId || raw.systemPrompt) {
                list = [raw];
            } else {
                list = [];
            }
        }
        return {
            configs: list.slice(0, 30),
            currentId: typeof raw.currentId === 'string' ? raw.currentId : null
        };
    }

    function profilePairKey(profile) {
        return String(profile.baseUrl || '') + '\u0000' + String(profile.modelId || '');
    }

    function isPristineDefaultProfile(profile) {
        return !!profile &&
            profile.name === '默认端点' &&
            !profile.apiKey &&
            !profile.chatSystemPrompt &&
            profile.baseUrl === 'https://api.openai.com/v1' &&
            profile.modelId === 'gpt-4o';
    }

    /** 只补空字段，不覆盖用户现有配置；force=true 用于“默认占位采纳旧配置”。 */
    function mergeProfileFields(target, source, force) {
        if (!target || !source) return;
        if (source.apiKey && (force || !target.apiKey)) target.apiKey = source.apiKey;
        if (source.chatSystemPrompt && (force || !target.chatSystemPrompt)) target.chatSystemPrompt = source.chatSystemPrompt;
        if (source.modelId && (force || !target.modelId)) target.modelId = source.modelId;
        if (source.baseUrl && (force || !target.baseUrl)) target.baseUrl = source.baseUrl;
        if (source.name && (force || !target.name || target.name === '新端点' || target.name === '默认端点')) {
            target.name = source.name;
        }
        if (force) {
            if (util.isFiniteNum(source.temperature)) target.temperature = clampNum(source.temperature, target.temperature, 0, 2);
            if (util.isFiniteNum(source.topP)) target.topP = clampNum(source.topP, target.topP, 0, 2);
        }
        target.updatedAt = Date.now();
    }

    /**
     * 把 legacy 配置合并进 doc（就地修改）。返回 {added,updated,skipped,currentMapped}。
     */
    function mergeLegacyIntoState(doc, legacyRaw) {
        var parsed = normalizeLegacyConfigs(legacyRaw);
        var result = { added: 0, updated: 0, skipped: 0, currentMapped: null };
        if (!parsed.configs.length) return result;

        var byId = Object.create(null);
        var byPair = Object.create(null);
        doc.profiles.forEach(function (profile) {
            byId[profile.id] = profile;
            byPair[profilePairKey(profile)] = profile;
        });

        var currentRaw = null;
        var mappedByIndex = [];
        parsed.configs.forEach(function (raw, index) {
            if (!raw || typeof raw !== 'object') { mappedByIndex.push(null); return; }
            if (parsed.currentId && raw.id === parsed.currentId) currentRaw = raw;
            var candidate = normalizeProfile(raw, doc.profiles.length + index);
            if (!raw.name) {
                candidate.name = parsed.configs.length === 1
                    ? 'nChat 旧端点'
                    : 'nChat 端点 ' + (index + 1);
            }
            var existing = byId[candidate.id];
            if (existing) {
                mergeProfileFields(existing, candidate);
                mappedByIndex.push(existing);
                result.updated += 1;
                return;
            }
            var pair = profilePairKey(candidate);
            var match = byPair[pair];
            if (match) {
                if (isPristineDefaultProfile(match) && match.id !== candidate.id) {
                    // 默认占位端点：采纳旧 id 与旧数据，让旧 nchat-conversation 会话可继续读取
                    var oldId = match.id;
                    mergeProfileFields(match, candidate, true);
                    match.id = candidate.id;
                    match.createdAt = candidate.createdAt;
                    delete byId[oldId];
                    byId[match.id] = match;
                    if (doc.currentProfileId === oldId) doc.currentProfileId = match.id;
                } else {
                    mergeProfileFields(match, candidate);
                }
                mappedByIndex.push(match);
                result.updated += 1;
                return;
            }
            if (doc.profiles.length >= 30) { mappedByIndex.push(null); result.skipped += 1; return; }
            doc.profiles.push(candidate);
            byId[candidate.id] = candidate;
            byPair[pair] = candidate;
            mappedByIndex.push(candidate);
            result.added += 1;
        });

        // currentId：优先按 id，其次按当前项对应的 baseUrl+modelId 找到合并后的 profile；
        // 单配置旧格式没有 currentId 时，默认把唯一合并项设为当前。
        var mapped = null;
        if (parsed.currentId) {
            if (byId[parsed.currentId]) {
                mapped = byId[parsed.currentId];
            } else if (currentRaw) {
                var currentCandidate = normalizeProfile(currentRaw, 0);
                mapped = byPair[profilePairKey(currentCandidate)] || null;
            }
        } else if (parsed.configs.length === 1) {
            mapped = mappedByIndex[0] || null;
        }
        if (mapped) {
            doc.currentProfileId = mapped.id;
            result.currentMapped = mapped.id;
        }
        if (doc.todoAi && doc.todoAi.profileId && !doc.profiles.some(function (p) { return p.id === doc.todoAi.profileId; })) {
            doc.todoAi.profileId = null;
        }
        return result;
    }

    var state = defaults();
    var listeners = [];
    var initialized = false;
    var loadInfo = { migratedFrom: null, profiles: 0, legacyMerged: false, legacyProfiles: 0 };

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
            loadInfo = {
                migratedFrom: null,
                profiles: state.profiles.length,
                legacyMerged: !!state.legacyMerged
            };
            // KEY 已存在（例如已自动生成默认端点）时，仍需一次性读取旧 nchat-settings，
            // 否则用户会“看不到旧 nChat 端点”。legacyMerged 标记保证只合并一次。
            if (!state.legacyMerged) {
                var pendingLegacy = storage.get(LEGACY_KEY, null);
                if (pendingLegacy) {
                    var merged = mergeLegacyIntoState(state, pendingLegacy);
                    state.legacyMerged = true;
                    state.legacyMergedAt = Date.now();
                    loadInfo = {
                        migratedFrom: 'nchat-settings-merge',
                        profiles: state.profiles.length,
                        legacyMerged: true,
                        legacyProfiles: merged.added + merged.updated
                    };
                    persist();
                }
            }
        } else {
            var legacy = storage.get(LEGACY_KEY, null);
            if (legacy) {
                state = normalizeDoc(legacy);
                state.todoAi = normalizeTodoAi(null);
                state.legacyMerged = true;
                state.legacyMergedAt = Date.now();
                loadInfo = {
                    migratedFrom: 'nchat-settings',
                    profiles: state.profiles.length,
                    legacyMerged: true,
                    legacyProfiles: state.profiles.length
                };
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
            apiFormat: normalizeApiFormat(profile.apiFormat),
            sessionId: profile.id,
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
            legacyMerged: state.legacyMerged === true,
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
            state.legacyMerged = true;
            state.legacyMergedAt = state.legacyMergedAt || Date.now();
            commit('import-merge');
            return { ok: true, imported: imported, rejected: 0, message: '已合并 ' + imported + ' 个端点' };
        }
        state = incoming;
        state.legacyMerged = true;
        state.legacyMergedAt = Date.now();
        if (!findProfile(state.currentProfileId)) state.currentProfileId = state.profiles[0].id;
        commit('import-replace');
        return { ok: true, imported: state.profiles.length, rejected: 0, message: '已导入 ' + state.profiles.length + ' 个端点' };
    }

    function reset() {
        state = defaults();
        state.currentProfileId = state.profiles[0].id;
        // 用户显式重置 = 不再需要旧 nChat 端点，标记避免下次启动又把 legacy 合并回来
        state.legacyMerged = true;
        state.legacyMergedAt = Date.now();
        commit('reset');
        return true;
    }

    /**
     * 显式“从旧 nChat 重新导入”入口（设置面板/调试可用）。
     * 启动时已自动合并过；此方法允许用户主动再合并一次（重复项按规则去重）。
     */
    function importLegacy() {
        ensure();
        var legacy = storage.get(LEGACY_KEY, null);
        if (!legacy) {
            return { ok: false, imported: 0, updated: 0, skipped: 0, message: '没有可导入的旧 nChat 配置' };
        }
        var merged = mergeLegacyIntoState(state, legacy);
        state.legacyMerged = true;
        state.legacyMergedAt = Date.now();
        commit('legacy-import');
        return {
            ok: true,
            imported: merged.added,
            updated: merged.updated,
            skipped: merged.skipped,
            currentProfileId: state.currentProfileId,
            message: '已合并 ' + (merged.added + merged.updated) + ' 个旧 nChat 端点'
        };
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
        importLegacy: importLegacy,
        reset: reset,
        subscribe: subscribe,
        getLoadInfo: function () { return loadInfo; },
        getLegacyMerged: function () { ensure(); return state.legacyMerged === true; }
    };
})(window);
