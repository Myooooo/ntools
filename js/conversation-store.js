/**
 * conversation-store.js — 会话状态 + 持久化（按 configId 分会话）
 * 经典脚本，依赖 core.js、storage.js、schema-chat.js。挂载到 NC.store.conversation。
 *
 * 存储键：nchat-conversation.v2
 * 形状：{version:2, sessions:{[configId]:{messages:[],updatedAt}}}
 * 迁移：旧键 nchat-conversation（消息数组）→ 当前 configId 会话；旧键只读保留，
 *       同时把原始字符串备份到 nchat-conversation.v1_backup。
 *
 * 配额策略：先写；若 QuotaExceeded，则从最旧会话/最旧消息开始把图片数据替换为占位文本
 *          后重试（最多 3 轮），并发出 conversation:degraded；仍失败则发 save-failed，
 *          当前页面仍可用（NC.storage 会保留内存副本）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var events = NC.events;
    var storage = NC.storage;

    var KEY = 'nchat-conversation.v2';
    var LEGACY_KEY = 'nchat-conversation';
    var LEGACY_BACKUP_KEY = 'nchat-conversation.v1_backup';
    var VERSION = 2;
    var SAVE_DELAY = 350;

    var state = { version: VERSION, sessions: Object.create(null) };
    var currentConfigId = null;
    var listeners = [];
    var lifecycleBound = false;

    var debouncedSave = util.debounce(function () { persist(); }, SAVE_DELAY);

    function schema() {
        return NC.schema && NC.schema.chat;
    }

    function normalizeDoc(raw) {
        var doc = { version: VERSION, sessions: Object.create(null) };
        var schemaChat = schema();
        if (util.isPlainObject(raw) && util.isPlainObject(raw.sessions)) {
            Object.keys(raw.sessions).forEach(function (configId) {
                var session = raw.sessions[configId];
                if (!util.isPlainObject(session)) return;
                var messages = schemaChat
                    ? schemaChat.normalizeConversation(session.messages)
                    : [];
                doc.sessions[configId] = {
                    messages: messages,
                    updatedAt: util.isFiniteNum(session.updatedAt) ? session.updatedAt : Date.now()
                };
            });
        } else if (Array.isArray(raw)) {
            // 兼容极端情况下写坏了形状的旧数据
            var legacyMessages = schemaChat ? schemaChat.normalizeConversation(raw) : [];
            if (legacyMessages.length) {
                doc.sessions.__legacy__ = { messages: legacyMessages, updatedAt: Date.now() };
            }
        }
        return doc;
    }

    function ensureSession(configId) {
        var id = configId || currentConfigId || 'default';
        if (!state.sessions[id]) {
            state.sessions[id] = { messages: [], updatedAt: Date.now() };
        }
        return state.sessions[id];
    }

    function currentSession() {
        return ensureSession(currentConfigId);
    }

    function touch() {
        currentSession().updatedAt = Date.now();
    }

    function messages() {
        return currentSession().messages;
    }

    function snapshot() {
        return messages().slice();
    }

    function notify(reason, extra) {
        var payload = {
            reason: reason,
            configId: currentConfigId,
            messages: snapshot(),
            sessionCount: Object.keys(state.sessions).length
        };
        if (extra) {
            Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
        }
        listeners.slice().forEach(function (fn) {
            try { fn(payload); } catch (err) { console.error('[NC] conversation subscriber error:', err); }
        });
        events.emit('conversation:changed', payload);
    }

    function scheduleSave() {
        debouncedSave();
    }

    /** 配额降级：从最旧会话/最旧消息开始清理图片数据，最多清理 20 处。 */
    function degradeImages() {
        var removed = 0;
        var configIds = Object.keys(state.sessions);
        for (var i = 0; i < configIds.length && removed < 20; i += 1) {
            var session = state.sessions[configIds[i]];
            for (var j = 0; j < session.messages.length && removed < 20; j += 1) {
                var message = session.messages[j];
                if (message.role !== 'user' || !Array.isArray(message.content)) continue;
                for (var k = 0; k < message.content.length && removed < 20; k += 1) {
                    var part = message.content[k];
                    if (part && part.type === 'image_url') {
                        message.content[k] = { type: 'text', text: '[图片已清理以节省本地空间]' };
                        removed += 1;
                    }
                }
            }
        }
        if (removed) {
            events.emit('conversation:degraded', { removed: removed });
        }
        return removed > 0;
    }

    function persist() {
        var result = null;
        for (var attempt = 0; attempt < 4; attempt += 1) {
            result = storage.set(KEY, state);
            if (result && result.ok) {
                events.emit('conversation:saved', { bytes: result.bytes || 0, memoryMode: !!result.memoryMode });
                return true;
            }
            if (!result || !result.quota) break;
            if (!degradeImages()) break;
        }
        events.emit('conversation:save-failed', {
            key: KEY,
            quota: !!(result && result.quota),
            error: (result && result.error) || null,
            memoryMode: !storage.available
        });
        return false;
    }

    function saveNow() {
        debouncedSave.cancel();
        return persist();
    }

    function bindLifecycle() {
        if (lifecycleBound) return;
        lifecycleBound = true;
        global.addEventListener('pagehide', function () { saveNow(); });
        global.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') saveNow();
        });
    }

    function init(configId) {
        currentConfigId = configId || null;
        var rawDoc = storage.get(KEY, null);
        var migrated = false;
        if (rawDoc != null) {
            state = normalizeDoc(rawDoc);
        } else {
            state = { version: VERSION, sessions: Object.create(null) };
            var legacyRaw = storage.getRaw(LEGACY_KEY);
            if (legacyRaw != null) {
                storage.setRaw(LEGACY_BACKUP_KEY, legacyRaw);
                var legacyData = util.parseJSON(legacyRaw, null);
                var legacyMessages = Array.isArray(legacyData) && schema()
                    ? schema().normalizeConversation(legacyData)
                    : [];
                if (legacyMessages.length) {
                    state.sessions[currentConfigId || 'legacy'] = {
                        messages: legacyMessages,
                        updatedAt: Date.now()
                    };
                    migrated = true;
                }
            }
        }
        if (!currentConfigId) {
            var ids = Object.keys(state.sessions);
            currentConfigId = ids.length ? ids[0] : 'default';
        }
        ensureSession(currentConfigId);
        bindLifecycle();
        if (migrated) saveNow();
        return snapshot();
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var index = listeners.indexOf(fn);
            if (index > -1) listeners.splice(index, 1);
        };
    }

    function getState() {
        var session = currentSession();
        return {
            configId: currentConfigId,
            messages: session.messages.slice(),
            updatedAt: session.updatedAt,
            sessionCount: Object.keys(state.sessions).length
        };
    }

    function append(message) {
        var schemaChat = schema();
        var normalized = schemaChat ? schemaChat.normalizeMessage(message) : message;
        if (!normalized) return null;
        currentSession().messages.push(normalized);
        touch();
        scheduleSave();
        notify('append', { message: normalized });
        return normalized;
    }

    function update(id, patch) {
        var list = currentSession().messages;
        var index = -1;
        for (var i = 0; i < list.length; i += 1) {
            if (list[i].id === id) { index = i; break; }
        }
        if (index === -1) return null;
        var message = list[index];
        if (!patch || typeof patch !== 'object') return message;
        if (typeof patch.content === 'string' || Array.isArray(patch.content)) message.content = patch.content;
        if (typeof patch.reasoning === 'string') message.reasoning = patch.reasoning;
        if (patch.stats && typeof patch.stats === 'object') message.stats = patch.stats;
        touch();
        scheduleSave();
        notify('update', { message: message });
        return message;
    }

    function remove(id) {
        var list = currentSession().messages;
        for (var i = 0; i < list.length; i += 1) {
            if (list[i].id === id) {
                var removed = list.splice(i, 1)[0];
                touch();
                scheduleSave();
                notify('remove', { message: removed, index: i });
                return { ok: true, index: i, message: removed };
            }
        }
        return { ok: false };
    }

    function truncateFrom(index) {
        var list = currentSession().messages;
        var start = Math.max(0, Math.min(index, list.length));
        var removed = list.splice(start);
        if (removed.length) {
            touch();
            scheduleSave();
            notify('truncate', { fromIndex: start, removed: removed.length });
        }
        return removed;
    }

    /** 整体替换（撤销/导入使用）；外部消息 id 重新生成。 */
    function setMessages(list) {
        var schemaChat = schema();
        var normalized = schemaChat && Array.isArray(list)
            ? schemaChat.normalizeConversation(list)
            : [];
        currentSession().messages = normalized;
        touch();
        scheduleSave();
        notify('replace', { messages: normalized });
        return snapshot();
    }

    function clear() {
        currentSession().messages = [];
        touch();
        notify('clear');
        saveNow();
    }

    function switchConfig(configId) {
        if (!configId || configId === currentConfigId) return snapshot();
        saveNow();
        currentConfigId = configId;
        ensureSession(configId);
        notify('switch');
        return snapshot();
    }

    function exportBackup() {
        var schemaChat = schema();
        return {
            version: VERSION,
            app: 'nChat',
            timestamp: new Date().toISOString(),
            configId: currentConfigId,
            conversation: schemaChat ? schemaChat.clone(snapshot()) : snapshot()
        };
    }

    function importBackup(raw) {
        var schemaChat = schema();
        var result = schemaChat
            ? schemaChat.normalizeBackup(raw)
            : { ok: false, messages: [], rejected: 0, reason: '校验模块未加载' };
        if (!result.ok) return result;
        currentSession().messages = result.messages;
        touch();
        saveNow();
        notify('import', { messages: result.messages });
        return result;
    }

    /** 导出 Markdown 文本（文件名由调用方生成）。 */
    function exportMarkdown() {
        var lines = [];
        lines.push('# nChat Conversation');
        lines.push('');
        lines.push('**Time:** ' + new Date().toLocaleString());
        lines.push('');
        lines.push('---');
        lines.push('');
        snapshot().forEach(function (message) {
            var role = message.role === 'user' ? '👤 User' : '🤖 Assistant';
            var content = '';
            if (message.role === 'user' && Array.isArray(message.content)) {
                var text = '';
                var images = 0;
                message.content.forEach(function (part) {
                    if (part.type === 'text') text += part.text;
                    else if (part.type === 'image_url') images += 1;
                });
                content = text + (images ? '\n\n*[Sent ' + images + ' images]*' : '');
            } else {
                content = typeof message.content === 'string' ? message.content : '';
            }
            lines.push('## ' + role);
            lines.push('');
            lines.push(content);
            lines.push('');
            lines.push('---');
            lines.push('');
        });
        return lines.join('\n');
    }

    /** 从存储重新加载（跨标签页/外部修改时使用）。 */
    function reload() {
        var rawDoc = storage.get(KEY, null);
        state = normalizeDoc(rawDoc);
        if (!currentConfigId) {
            var ids = Object.keys(state.sessions);
            currentConfigId = ids.length ? ids[0] : 'default';
        }
        ensureSession(currentConfigId);
        notify('external');
        return snapshot();
    }

    NC.store = NC.store || {};
    NC.store.conversation = {
        KEY: KEY,
        LEGACY_KEY: LEGACY_KEY,
        VERSION: VERSION,
        init: init,
        getState: getState,
        get messages() { return messages(); },
        subscribe: subscribe,
        append: append,
        update: update,
        remove: remove,
        truncateFrom: truncateFrom,
        setMessages: setMessages,
        clear: clear,
        saveNow: saveNow,
        switchConfig: switchConfig,
        exportBackup: exportBackup,
        importBackup: importBackup,
        exportMarkdown: exportMarkdown,
        reload: reload
    };
})(window);
