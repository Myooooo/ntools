/**
 * conversation-store.js — nChat v3 会话/消息树存储（保留 v2 API 兼容）
 * 经典脚本，依赖 core.js、storage.js、schema-chat.js。挂载：NC.store.conversation
 *
 * v3 变化：
 *  - 一个端点下可以有多条会话（session），会话有标题/时间/端点；
 *  - 消息从线性数组升级为树：parentId + selectedChildId，支持编辑/重新生成/版本切换；
 *  - 主存储 IndexedDB（NC.chatDb，sessions 表）；IndexedDB 不可用时回退
 *    nchat-conversation.v3 localStorage；
 *  - 旧 nchat-conversation.v3 / v2 / v1 首次启动自动迁移到 IndexedDB，旧键只读保留；
 *  - 旧 v2：每个端点一条“旧会话”，线性消息补 parent 链。
 *
 * 兼容：保持 messages getter、append/update/remove/truncateFrom/setMessages/clear/
 * switchConfig/exportBackup/importBackup/exportMarkdown/subscribe/saveNow 语义，
 * 让现有 chat-embed/controller/message-view 可以渐进接入。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var events = NC.events;
    var storage = NC.storage;

    var KEY = 'nchat-conversation.v3';
    var V2_KEY = 'nchat-conversation.v2';
    var LEGACY_KEY = 'nchat-conversation';
    var VERSION = 3;
    var SAVE_DELAY = 300;
    var MAX_SESSIONS = 100;
    var MAX_MESSAGES = 1000;

    var state = { version: VERSION, activeByEndpoint: Object.create(null), sessions: [] };
    var currentConfigId = null;
    var currentSessionId = null;
    var listeners = [];
    var lifecycleBound = false;
    var lastSig = '';
    var savedSig = Object.create(null);
    var db = null;
    var ready = false;
    var useLocal = false;
    var initPromise = null;
    var bootError = null;

    var debouncedSave = util.debounce(function () { flush(); }, SAVE_DELAY);

    function schema() { return NC.schema && NC.schema.chat; }

    function clone(value) {
        if (schema() && schema().clone) return schema().clone(value);
        try { return JSON.parse(JSON.stringify(value)); } catch (err) { return value; }
    }

    function endpointName(id) {
        try {
            var llm = NC.store && NC.store.llm;
            if (llm && typeof llm.getProfile === 'function') {
                var profile = llm.getProfile(id);
                if (profile && profile.name) return profile.name;
            }
        } catch (err) { /* ignore */ }
        return '旧会话';
    }

    function deriveTitle(messages, fallback) {
        for (var i = 0; i < messages.length; i += 1) {
            var message = messages[i];
            if (message.role !== 'user') continue;
            var text = '';
            if (Array.isArray(message.content)) {
                text = message.content.filter(function (part) { return part && part.type === 'text'; })
                    .map(function (part) { return part.text || ''; }).join(' ');
            } else {
                text = typeof message.content === 'string' ? message.content : '';
            }
            text = text.replace(/\s+/g, ' ').trim();
            if (text) return text.length > 26 ? text.slice(0, 26) + '…' : text;
        }
        return fallback || '新对话';
    }

    function genId(prefix) {
        return util.uid(prefix || 's') + '_' + Math.random().toString(36).slice(2, 7);
    }

    /* ------------------------------------------------------------------ *
     * 消息树归一化 / 可见路径
     * ------------------------------------------------------------------ */
    function normalizeTree(rawMessages) {
        var list = Array.isArray(rawMessages) ? rawMessages.slice(0, MAX_MESSAGES) : [];
        var schemaChat = schema();
        var out = [];
        var ids = Object.create(null);
        var previousId = null;
        list.forEach(function (raw) {
            var message = schemaChat ? schemaChat.normalizeMessage(raw) : raw;
            if (!message || !message.role) return;
            if (ids[message.id]) message.id = util.uid('msg');
            ids[message.id] = true;
            var parent = raw && typeof raw.parentId === 'string' ? raw.parentId : null;
            if (parent && !ids[parent]) parent = previousId;
            if (message.role === 'assistant' && !parent && previousId) parent = previousId;
            message.parentId = parent || null;
            message.selectedChildId = null;
            out.push(message);
            previousId = message.id;
        });
        // 保证每个父节点的 selectedChildId 指向最后一个孩子（没有显式选择时）
        var lastChild = Object.create(null);
        var firstChild = Object.create(null);
        out.forEach(function (message) {
            if (!message.parentId) return;
            firstChild[message.parentId] = firstChild[message.parentId] || message.id;
            lastChild[message.parentId] = message.id;
        });
        var rawSelected = Object.create(null);
        list.forEach(function (raw) {
            if (raw && typeof raw.id === 'string' && typeof raw.selectedChildId === 'string') {
                rawSelected[raw.id] = raw.selectedChildId;
            }
        });
        out.forEach(function (message) {
            var selected = rawSelected[message.id];
            var valid = selected && ids[selected] && out.some(function (item) {
                return item.id === selected && item.parentId === message.id;
            });
            message.selectedChildId = valid ? selected : (lastChild[message.id] || null);
        });
        return out;
    }

    function childrenMap(session) {
        var map = Object.create(null);
        session.messages.forEach(function (message) {
            var key = message.parentId || '';
            if (!map[key]) map[key] = [];
            map[key].push(message);
        });
        return map;
    }

    function visibleMessages(session) {
        if (!session) return [];
        var map = childrenMap(session);
        var roots = map[''] || [];
        if (!roots.length) return [];
        var current = roots[0];
        if (session.selectedRootId) {
            roots.some(function (root) {
                if (root.id === session.selectedRootId) { current = root; return true; }
                return false;
            });
        }
        var out = [];
        var guard = 0;
        var visited = Object.create(null);
        while (current && !visited[current.id] && guard < MAX_MESSAGES) {
            guard += 1;
            visited[current.id] = true;
            out.push(current);
            var children = map[current.id] || [];
            if (!children.length) break;
            var chosen = null;
            if (current.selectedChildId) {
                for (var i = 0; i < children.length; i += 1) {
                    if (children[i].id === current.selectedChildId) { chosen = children[i]; break; }
                }
            }
            current = chosen || children[children.length - 1];
        }
        return out;
    }

    function allMessages(session) { return session ? session.messages.slice() : []; }

    function versionsOf(session, id) {
        if (!session) return [];
        var target = null;
        session.messages.forEach(function (message) { if (message.id === id) target = message; });
        if (!target) return [];
        return session.messages.filter(function (message) { return message.parentId === target.parentId; });
    }

    /* ------------------------------------------------------------------ *
     * 会话归一化 / 迁移
     * ------------------------------------------------------------------ */
    function normalizeSession(raw, fallbackEndpoint) {
        if (!util.isPlainObject(raw)) return null;
        var messages = normalizeTree(raw.messages);
        var roots = messages.filter(function (message) { return !message.parentId; });
        var selectedRootId = typeof raw.selectedRootId === 'string' ? raw.selectedRootId : (roots.length ? roots[0].id : null);
        var id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw.id) ? raw.id : genId('s');
        var createdAt = util.isFiniteNum(raw.createdAt) ? raw.createdAt : Date.now();
        var updatedAt = util.isFiniteNum(raw.updatedAt) ? raw.updatedAt : createdAt;
        var title = typeof raw.title === 'string' && raw.title.trim()
            ? raw.title.trim().slice(0, 80)
            : deriveTitle(messages, '新对话');
        return {
            id: id,
            title: title,
            endpointId: typeof raw.endpointId === 'string' && raw.endpointId ? raw.endpointId : (fallbackEndpoint || 'default'),
            createdAt: createdAt,
            updatedAt: updatedAt,
            selectedRootId: selectedRootId,
            messages: messages
        };
    }

    function normalizeDoc(raw) {
        var doc = { version: VERSION, activeByEndpoint: Object.create(null), sessions: [] };
        if (!util.isPlainObject(raw)) return doc;
        if (util.isPlainObject(raw.activeByEndpoint)) {
            Object.keys(raw.activeByEndpoint).forEach(function (key) {
                var value = raw.activeByEndpoint[key];
                if (typeof value === 'string') doc.activeByEndpoint[key] = value;
            });
        }
        if (Array.isArray(raw.sessions)) {
            raw.sessions.slice(0, MAX_SESSIONS).forEach(function (item) {
                var session = normalizeSession(item);
                if (session) doc.sessions.push(session);
            });
        }
        return doc;
    }

    function migrateFromV2(raw) {
        var doc = { version: VERSION, activeByEndpoint: Object.create(null), sessions: [] };
        var sessions = raw && util.isPlainObject(raw.sessions) ? raw.sessions : null;
        var schemaChat = schema();
        if (sessions) {
            Object.keys(sessions).forEach(function (configId) {
                var old = sessions[configId];
                if (!util.isPlainObject(old)) return;
                var messages = schemaChat ? schemaChat.normalizeConversation(old.messages) : [];
                // 线性消息补 parent 链
                messages.forEach(function (message, index) {
                    message.parentId = index > 0 ? messages[index - 1].id : null;
                    message.selectedChildId = null;
                });
                messages.forEach(function (message, index) {
                    if (index < messages.length - 1) message.selectedChildId = messages[index + 1].id;
                });
                var session = normalizeSession({
                    id: genId('s'),
                    title: deriveTitle(messages, '旧会话 · ' + endpointName(configId)),
                    endpointId: configId,
                    createdAt: old.updatedAt || Date.now(),
                    updatedAt: old.updatedAt || Date.now(),
                    messages: messages
                });
                if (session) {
                    doc.sessions.push(session);
                    doc.activeByEndpoint[configId] = session.id;
                }
            });
        } else if (Array.isArray(raw)) {
            var legacy = schemaChat ? schemaChat.normalizeConversation(raw) : [];
            legacy.forEach(function (message, index) {
                message.parentId = index > 0 ? legacy[index - 1].id : null;
                message.selectedChildId = null;
            });
            legacy.forEach(function (message, index) {
                if (index < legacy.length - 1) message.selectedChildId = legacy[index + 1].id;
            });
            if (legacy.length) {
                var sessionL = normalizeSession({
                    id: genId('s'),
                    title: deriveTitle(legacy, '旧会话'),
                    endpointId: 'default',
                    messages: legacy
                });
                if (sessionL) {
                    doc.sessions.push(sessionL);
                    doc.activeByEndpoint.default = sessionL.id;
                }
            }
        }
        return doc;
    }

    /** 读取旧的 localStorage 数据（v3 / v2 / v1），用于一次性迁移。 */
    function readLegacyDoc() {
        var saved = storage.get(KEY, null);
        if (saved && util.isPlainObject(saved)) {
            var doc = normalizeDoc(saved);
            if (doc.sessions.length) return { doc: doc, source: 'v3' };
        }
        var v2 = storage.get(V2_KEY, null);
        if (v2) {
            var migrated = migrateFromV2(v2);
            if (migrated.sessions.length) return { doc: migrated, source: 'v2' };
        }
        var legacy = storage.get(LEGACY_KEY, null);
        if (legacy) {
            var migratedLegacy = migrateFromV2(legacy);
            if (migratedLegacy.sessions.length) return { doc: migratedLegacy, source: 'v1' };
        }
        return { doc: { version: VERSION, activeByEndpoint: Object.create(null), sessions: [] }, source: 'none' };
    }

    function loadLocalFallback() {
        var legacy = readLegacyDoc();
        state = legacy.doc;
        if (!state.sessions.length) {
            state = { version: VERSION, activeByEndpoint: Object.create(null), sessions: [] };
        }
    }

    function applyLoadedSessions(sessions, activeMap, source) {
        var doc = { version: VERSION, activeByEndpoint: Object.create(null), sessions: [] };
        (sessions || []).forEach(function (raw) {
            var session = normalizeSession(raw);
            if (session) doc.sessions.push(session);
        });
        if (util.isPlainObject(activeMap)) {
            Object.keys(activeMap).forEach(function (key) {
                if (typeof activeMap[key] === 'string') doc.activeByEndpoint[key] = activeMap[key];
            });
        }
        state = doc;
        markAllSaved();
        if (source) bootError = null;
    }

    function ensureActiveMap() {
        state.sessions.forEach(function (session) {
            if (!state.activeByEndpoint[session.endpointId]) {
                state.activeByEndpoint[session.endpointId] = session.id;
            }
        });
    }

    function finishBoot() {
        ready = true;
        ensureActiveMap();
        currentConfigId = currentConfigId || 'default';
        var session = ensureSessionForEndpoint(currentConfigId);
        currentSessionId = session ? session.id : null;
        if (currentSessionId) state.activeByEndpoint[currentConfigId] = currentSessionId;
        lastSig = '';
        notify('init');
        return visibleMessages(currentSession());
    }

    function bootWithLocal() {
        useLocal = true;
        db = null;
        loadLocalFallback();
        return finishBoot();
    }

    /**
     * 加载期截断保护：会话数/消息数超上限时，先把"未截断的原始数据"存进快照，
     * 再让内存使用修剪后的版本。这样即使后续保存覆盖，原始数据仍可找回。
     */
    function guardTruncation(rawSessions) {
        if (!Array.isArray(rawSessions)) return;
        var overSessions = rawSessions.length > MAX_SESSIONS;
        var overMessages = 0;
        rawSessions.forEach(function (item) {
            if (item && Array.isArray(item.messages) && item.messages.length > MAX_MESSAGES) {
                overMessages += 1;
            }
        });
        if (!overSessions && !overMessages) return;
        var d = NC.durability;
        if (d && d.snapshot) {
            d.snapshot.configure({ prefix: 'chat-raw', slots: 2, namespace: 'chat' });
            d.snapshot.push('chat-raw', rawSessions, {
                sessions: rawSessions.length,
                overMessages: overMessages,
                maxSessions: MAX_SESSIONS,
                maxMessages: MAX_MESSAGES
            });
        }
        events.emit(NC.eventNames.conversationTruncatedOnLoad, {
            sessions: rawSessions.length,
            overMessages: overMessages,
            maxSessions: MAX_SESSIONS,
            maxMessages: MAX_MESSAGES
        });
    }

    function boot(configId) {
        currentConfigId = configId || currentConfigId || 'default';
        if (!NC.chatDb || typeof NC.chatDb.open !== 'function') {
            return Promise.resolve(bootWithLocal());
        }
        return NC.chatDb.open().then(function () {
            db = NC.chatDb;
            if (typeof db.setDegradedHandler === 'function') {
                db.setDegradedHandler(function (reason) {
                    events.emit(NC.eventNames.conversationStorageFallback, { reason: 'degraded:' + reason });
                    useLocal = true;
                    db = null;
                    persistLocal();
                });
            }
            return db.getAllSessions();
        }).then(function (sessions) {
            guardTruncation(sessions);
            return db.getMeta('activeByEndpoint').then(function (activeMap) {
                // 没有任何 IDB 会话时，从旧 localStorage 迁移一次。
                if (!sessions || !sessions.length) {
                    var legacy = readLegacyDoc();
                    if (legacy.doc.sessions.length) {
                        return db.replaceAllSessions(legacy.doc.sessions).then(function () {
                            return db.setMeta('activeByEndpoint', legacy.doc.activeByEndpoint).then(function () {
                                applyLoadedSessions(legacy.doc.sessions, legacy.doc.activeByEndpoint, legacy.source);
                                return true;
                            });
                        });
                    }
                }
                applyLoadedSessions(sessions, activeMap, 'idb');
                return true;
            });
        }).then(function () {
            // 迁移后 active 可能为空；确保当前端点会话。
            return finishBoot();
        }).catch(function (err) {
            bootError = err;
            events.emit(NC.eventNames.conversationStorageFallback, { reason: err && err.message ? err.message : String(err) });
            return bootWithLocal();
        });
    }

    /* ------------------------------------------------------------------ *
     * 持久化 / 通知
     * ------------------------------------------------------------------ */
    function snapshot() {
        return {
            version: VERSION,
            activeByEndpoint: clone(state.activeByEndpoint),
            sessions: clone(state.sessions)
        };
    }

    function persistLocal() {
        try {
            var result = storage.set(KEY, snapshot());
            if (result && result.ok === false) {
                events.emit(NC.eventNames.conversationSaveFailed, { reason: result.quota ? 'quota' : 'unknown' });
            }
        } catch (err) {
            events.emit(NC.eventNames.conversationSaveFailed, { reason: 'exception' });
        }
    }

    function persist() {
        if (useLocal) {
            persistLocal();
            return;
        }
        scheduleSave();
    }

    function scheduleSave() { debouncedSave(); }

    /**
     * 会话签名：任一会话的消息数/更新时间/选中根变化即视为脏会话。
     * 只写脏会话，而不是每次 clear + 全量重写整个库（写放大 + 双窗口互相覆盖）。
     */
    function sessionSig(session) {
        return (session.updatedAt || 0) + '|' +
            (session.messages ? session.messages.length : 0) + '|' +
            (session.selectedRootId || '') + '|' +
            (session.title || '');
    }

    function markAllSaved() {
        savedSig = Object.create(null);
        state.sessions.forEach(function (session) {
            savedSig[session.id] = sessionSig(session);
        });
    }

    function flush() {
        if (NC.durability && NC.durability.lease) {
            if (!NC.durability.lease.claim('ntools.chat.lease')) {
                events.emit(NC.eventNames.conversationSaveFailed, { reason: 'other-window' });
                return Promise.resolve(false);
            }
        }
        if (useLocal) {
            persistLocal();
            return Promise.resolve(true);
        }
        if (!ready || !db) return Promise.resolve(false);

        var toPut = [];
        var seen = Object.create(null);
        state.sessions.forEach(function (session) {
            seen[session.id] = true;
            if (savedSig[session.id] !== sessionSig(session)) toPut.push(session);
        });
        var toDelete = Object.keys(savedSig).filter(function (id) { return !seen[id]; });
        var active = clone(state.activeByEndpoint);

        return Promise.resolve(true).then(function () {
            if (!toPut.length && !toDelete.length) return true;
            var put = toPut.length && typeof db.putSessions === 'function'
                ? db.putSessions(toPut)
                : Promise.resolve(true);
            return put.then(function () {
                if (!toDelete.length) return true;
                if (typeof db.deleteSessions === 'function') return db.deleteSessions(toDelete);
                return Promise.all(toDelete.map(function (id) { return db.deleteSession(id); }));
            });
        }).then(function () {
            toPut.forEach(function (session) { savedSig[session.id] = sessionSig(session); });
            toDelete.forEach(function (id) { delete savedSig[id]; });
            return db.setMeta('activeByEndpoint', active);
        }).then(function () {
            lastSig = '';
            return true;
        }).catch(function (err) {
            events.emit(NC.eventNames.conversationSaveFailed, {
                reason: err && (err.name === 'QuotaExceededError') ? 'quota' : 'exception'
            });
            return false;
        });
    }

    function notify(reason, extra) {
        var payload = {
            reason: reason,
            configId: currentConfigId,
            sessionId: currentSessionId,
            messages: visibleMessages(currentSession()),
            session: summaryOf(currentSession()),
            sessions: getSessions()
        };
        if (extra) {
            Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
        }
        var sig = currentSessionId + '|' + (payload.messages.length) + '|' + (payload.session ? payload.session.updatedAt : 0) + '|' + reason;
        if (sig === lastSig && reason !== 'init') return;
        lastSig = sig;
        listeners.slice().forEach(function (fn) {
            try { fn(payload); } catch (err) { console.error('[NC] conversation subscriber error:', err); }
        });
        events.emit(NC.eventNames.conversationChanged, payload);
    }

    /* ------------------------------------------------------------------ *
     * 会话操作
     * ------------------------------------------------------------------ */
    function currentSession() {
        for (var i = 0; i < state.sessions.length; i += 1) {
            if (state.sessions[i].id === currentSessionId) return state.sessions[i];
        }
        return null;
    }

    function summaryOf(session) {
        if (!session) return null;
        return {
            id: session.id,
            title: session.title,
            endpointId: session.endpointId,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messages.length
        };
    }

    function getSessions() {
        return state.sessions
            .filter(function (session) { return session.endpointId === currentConfigId; })
            .sort(function (a, b) { return b.updatedAt - a.updatedAt; })
            .map(summaryOf);
    }

    function getAllSessions() {
        return state.sessions.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; }).map(summaryOf);
    }

    function createSession(options) {
        var opts = options || {};
        var endpointId = opts.endpointId || currentConfigId || 'default';
        var session = {
            id: genId('s'),
            title: opts.title || '新对话',
            endpointId: endpointId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: []
        };
        state.sessions.unshift(session);
        if (state.sessions.length > MAX_SESSIONS) state.sessions.length = MAX_SESSIONS;
        currentConfigId = endpointId;
        currentSessionId = session.id;
        state.activeByEndpoint[endpointId] = session.id;
        persist();
        notify('session:create', { session: summaryOf(session) });
        return summaryOf(session);
    }

    function selectSession(id) {
        var target = null;
        state.sessions.forEach(function (session) { if (session.id === id) target = session; });
        if (!target) return false;
        currentSessionId = target.id;
        currentConfigId = target.endpointId;
        state.activeByEndpoint[currentConfigId] = target.id;
        persist();
        notify('session:select');
        return true;
    }

    function deleteSession(id) {
        var index = -1;
        state.sessions.forEach(function (session, i) { if (session.id === id) index = i; });
        if (index === -1) return false;
        var removed = state.sessions[index];
        state.sessions.splice(index, 1);
        var remaining = state.sessions.filter(function (session) { return session.endpointId === removed.endpointId; })
            .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        if (currentSessionId === id) {
            if (remaining.length) {
                currentSessionId = remaining[0].id;
                state.activeByEndpoint[removed.endpointId] = currentSessionId;
            } else {
                var created = createSession({ endpointId: removed.endpointId });
                currentSessionId = created.id;
            }
        }
        persist();
        notify('session:delete', { id: id });
        return true;
    }

    function renameSession(id, title) {
        var target = null;
        state.sessions.forEach(function (session) { if (session.id === id) target = session; });
        if (!target) return false;
        var next = typeof title === 'string' ? title.trim().slice(0, 80) : '';
        if (!next) return false;
        target.title = next;
        target.updatedAt = Date.now();
        persist();
        notify('session:rename', { id: id, title: next });
        return true;
    }

    function ensureSessionForEndpoint(endpointId) {
        var sessions = state.sessions.filter(function (session) { return session.endpointId === endpointId; });
        if (sessions.length) {
            var activeId = state.activeByEndpoint[endpointId];
            var active = sessions.filter(function (session) { return session.id === activeId; })[0];
            if (active) return active;
            return sessions.sort(function (a, b) { return b.updatedAt - a.updatedAt; })[0];
        }
        var created = createSession({ endpointId: endpointId });
        return currentSession();
    }

    /* ------------------------------------------------------------------ *
     * 旧 API：消息 / 端点
     * ------------------------------------------------------------------ */
    function init(configId) {
        if (!lifecycleBound) {
            lifecycleBound = true;
            if (global.addEventListener) {
                global.addEventListener('pagehide', function () { saveNow(); });
                /* 切走/最小化时就落盘：pagehide 时发起异步 IndexedDB 事务可能来不及提交 */
                document.addEventListener('visibilitychange', function () {
                    if (document.hidden) saveNow();
                });
                global.addEventListener('storage', function (event) {
                    if (event && (event.key === KEY || event.key === 'nchat-db-namespace.v1')) reload();
                });
            }
        }
        if (initPromise) return initPromise;
        currentConfigId = configId || currentConfigId || 'default';
        initPromise = Promise.resolve(boot(currentConfigId));
        return initPromise;
    }

    function whenReady() {
        if (ready) return Promise.resolve(true);
        return initPromise ? initPromise.then(function () { return true; }) : Promise.reject(new Error('conversation not initialized'));
    }

    function getState() {
        return {
            version: VERSION,
            configId: currentConfigId,
            sessionId: currentSessionId,
            session: summaryOf(currentSession()),
            sessions: getSessions(),
            messages: visibleMessages(currentSession())
        };
    }

    function messages() { return visibleMessages(currentSession()); }

    function append(input) {
        var session = currentSession();
        if (!session) return null;
        var schemaChat = schema();
        var message = schemaChat ? schemaChat.normalizeMessage(input) : input;
        if (!message || !session.messages.length && message.role === 'assistant') return null;
        var explicitParent = input && Object.prototype.hasOwnProperty.call(input, 'parentId')
            ? input.parentId
            : undefined;
        if (explicitParent === undefined) {
            var visible = visibleMessages(session);
            explicitParent = visible.length ? visible[visible.length - 1].id : null;
        }
        if (explicitParent) {
            var parent = null;
            session.messages.forEach(function (item) { if (item.id === explicitParent) parent = item; });
            if (!parent) explicitParent = null;
        }
        message.parentId = explicitParent || null;
        message.selectedChildId = null;
        if (!message.parentId) session.selectedRootId = message.id;
        // 助手消息的父节点（用户消息）选中这个新回答
        var parentMessage = null;
        session.messages.forEach(function (item) { if (item.id === explicitParent) parentMessage = item; });
        if (parentMessage) {
            parentMessage.selectedChildId = message.id;
            parentMessage.updatedAt = Date.now();
        }
        session.messages.push(message);
        if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
        session.updatedAt = Date.now();
        if (!session.title || session.title === '新对话') {
            session.title = deriveTitle(session.messages, session.title);
        }
        state.activeByEndpoint[session.endpointId] = session.id;
        scheduleSave();
        notify('message:append', { id: message.id });
        return clone(message);
    }

    function findMessage(id) {
        var session = currentSession();
        if (!session) return null;
        var found = null;
        session.messages.forEach(function (message) { if (message.id === id) found = message; });
        return found;
    }

    function update(id, patch) {
        var message = findMessage(id);
        if (!message) return null;
        var next = patch || {};
        ['content', 'reasoning', 'reasoningTime', 'stats', 'status', 'error', 'usage', 'model', 'thinking', 'search', 'latestReminder', 'attachments'].forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(next, key)) message[key] = next[key];
        });
        message.updatedAt = Date.now();
        var session = currentSession();
        if (session) session.updatedAt = Date.now();
        scheduleSave();
        notify('message:update', { id: id });
        return clone(message);
    }

    function remove(id) {
        var session = currentSession();
        if (!session) return { ok: false };
        var removed = Object.create(null);
        removed[id] = true;
        // 收集子树：反复扫描父链
        var changed = true;
        while (changed) {
            changed = false;
            session.messages.forEach(function (message) {
                if (message.parentId && removed[message.parentId] && !removed[message.id]) {
                    removed[message.id] = true;
                    changed = true;
                }
            });
        }
        var parent = null;
        session.messages.forEach(function (message) { if (removed[message.id]) parent = message.parentId || parent; });
        var before = session.messages.length;
        session.messages = session.messages.filter(function (message) { return !removed[message.id]; });
        if (parent) {
            var parentMessage = null;
            session.messages.forEach(function (message) { if (message.id === parent) parentMessage = message; });
            if (parentMessage) {
                var siblings = session.messages.filter(function (message) { return message.parentId === parent; });
                parentMessage.selectedChildId = siblings.length ? siblings[siblings.length - 1].id : null;
            }
        } else {
            var roots = session.messages.filter(function (message) { return !message.parentId; });
            if (roots.length) session.selectedRootId = roots[roots.length - 1].id;
        }
        if (session.messages.length === before) return { ok: false };
        session.updatedAt = Date.now();
        scheduleSave();
        notify('message:remove', { id: id });
        return { ok: true };
    }

    function truncateFrom(index) {
        var visible = messages();
        var target = visible[index];
        if (!target) return;
        remove(target.id);
    }

    function setMessages(list) {
        var session = currentSession();
        if (!session) return false;
        var normalized = normalizeTree(list);
        session.messages = normalized;
        var roots = normalized.filter(function (message) { return !message.parentId; });
        session.selectedRootId = roots.length ? roots[0].id : null;
        session.updatedAt = Date.now();
        scheduleSave();
        notify('messages:set');
        return true;
    }

    function clear() {
        var session = currentSession();
        if (!session) return false;
        session.messages = [];
        session.updatedAt = Date.now();
        scheduleSave();
        notify('clear');
        return true;
    }

    function selectVersion(id) {
        var session = currentSession();
        var target = findMessage(id);
        if (!session || !target) return false;
        var parent = target.parentId || null;
        if (parent) {
            var parentMessage = findMessage(parent);
            if (parentMessage) parentMessage.selectedChildId = id;
        } else {
            session.selectedRootId = id;
        }
        session.updatedAt = Date.now();
        scheduleSave();
        notify('version:select', { id: id });
        return true;
    }

    function getVersions(id) {
        var session = currentSession();
        if (!session) return { ids: [], index: -1 };
        var target = findMessage(id);
        if (!target) return { ids: [], index: -1 };
        var siblings = session.messages.filter(function (message) {
            if (target.parentId) return message.parentId === target.parentId;
            return !message.parentId;
        });
        var ids = siblings.map(function (message) { return message.id; });
        return { ids: ids, index: ids.indexOf(id) };
    }

    function getPathTo(id) {
        var visible = messages();
        var out = [];
        for (var i = 0; i < visible.length; i += 1) {
            out.push(visible[i]);
            if (visible[i].id === id) break;
        }
        return out;
    }

    function switchConfig(configId) {
        currentConfigId = configId || currentConfigId || 'default';
        var session = ensureSessionForEndpoint(currentConfigId);
        currentSessionId = session ? session.id : null;
        state.activeByEndpoint[currentConfigId] = currentSessionId;
        persist();
        notify('config:switch');
        return messages();
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var index = listeners.indexOf(fn);
            if (index > -1) listeners.splice(index, 1);
        };
    }

    function saveNow() {
        if (debouncedSave && debouncedSave.cancel) {
            try { debouncedSave.cancel(); } catch (err) { /* ignore */ }
        }
        return flush();
    }

    function reload() {
        if (!ready) return messages();
        var endpoint = currentConfigId;
        if (!db) {
            loadLocalFallback();
            finishBoot();
            notify('external');
            return messages();
        }
        return db.getAllSessions().then(function (sessions) {
            return db.getMeta('activeByEndpoint').then(function (activeMap) {
                applyLoadedSessions(sessions, activeMap, 'external');
                currentConfigId = endpoint || currentConfigId || 'default';
                var session = ensureSessionForEndpoint(currentConfigId);
                currentSessionId = session ? session.id : null;
                notify('external');
                return messages();
            });
        }).catch(function () { return messages(); });
    }

    /** 整库导出（含每个会话的完整消息），用于全量备份 */
    function exportAllSessions() {
        return {
            version: VERSION,
            app: 'nTools',
            exportedAt: new Date().toISOString(),
            activeByEndpoint: clone(state.activeByEndpoint),
            sessions: state.sessions.map(function (session) {
                return {
                    id: session.id,
                    title: session.title,
                    endpointId: session.endpointId,
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                    selectedRootId: session.selectedRootId,
                    messages: clone(session.messages)
                };
            })
        };
    }

    /**
     * 整库导入（替换）。先备份当前状态到 localStorage 回退键，再写入。
     * @returns {Promise<{ok:boolean, sessions?:number, reason?:string}>}
     */
    function importAllSessions(raw) {
        var data = raw;
        if (typeof raw === 'string') data = util.parseJSON(raw, null);
        if (!util.isPlainObject(data) || !Array.isArray(data.sessions)) {
            return Promise.resolve({ ok: false, reason: 'format' });
        }
        var incoming = [];
        data.sessions.forEach(function (item) {
            var session = normalizeSession(item);
            if (session) incoming.push(session);
        });
        if (!incoming.length) return Promise.resolve({ ok: false, reason: 'empty' });
        var previous = { version: VERSION, activeByEndpoint: clone(state.activeByEndpoint), sessions: clone(state.sessions) };
        try {
            if (NC.durability && NC.durability.snapshot) {
                NC.durability.snapshot.configure({ prefix: 'chat-preimport', slots: 2, namespace: 'chat' });
                NC.durability.snapshot.push('chat-preimport', previous, { sessions: state.sessions.length });
            }
        } catch (err) { /* 尽力而为，绝不把 IDB 全量聊天塞进 localStorage 撑爆配额 */ }

        state.sessions = incoming;
        if (util.isPlainObject(data.activeByEndpoint)) {
            state.activeByEndpoint = Object.create(null);
            Object.keys(data.activeByEndpoint).forEach(function (key) {
                if (typeof data.activeByEndpoint[key] === 'string') {
                    state.activeByEndpoint[key] = data.activeByEndpoint[key];
                }
            });
        }
        ensureActiveMap();
        currentSessionId = state.activeByEndpoint[currentConfigId] || (incoming[0] ? incoming[0].id : null);
        if (currentSessionId) currentConfigId = (currentSession() || {}).endpointId || currentConfigId;
        var job = useLocal || !db
            ? Promise.resolve(true)
            : db.replaceAllSessions(state.sessions).then(function () {
                return db.setMeta('activeByEndpoint', clone(state.activeByEndpoint));
            });
        return job.then(function () {
            markAllSaved();
            notify('import-all', { sessions: incoming.length });
            return { ok: true, sessions: incoming.length };
        }).catch(function (err) {
            return { ok: false, reason: err && err.message ? err.message : 'write-failed' };
        });
    }

    function exportBackup() {
        var session = currentSession();
        return {
            version: VERSION,
            app: 'nTools',
            exportedAt: new Date().toISOString(),
            session: summaryOf(session),
            messages: clone(session ? session.messages : [])
        };
    }

    function importBackup(raw) {
        var schemaChat = schema();
        var data = raw;
        if (typeof raw === 'string') data = util.parseJSON(raw, null);
        var list = null;
        if (Array.isArray(data)) list = data;
        else if (util.isPlainObject(data)) {
            if (Array.isArray(data.messages)) list = data.messages;
            else if (Array.isArray(data.conversation)) list = data.conversation;
        }
        if (!list) return { ok: false, reason: '无效的备份文件格式' };
        var normalized = schemaChat ? schemaChat.normalizeConversation(list) : list;
        if (!normalized.length) return { ok: false, reason: '备份中没有可用消息' };
        normalized.forEach(function (message, index) {
            message.parentId = index > 0 ? normalized[index - 1].id : null;
            message.selectedChildId = index < normalized.length - 1 ? normalized[index + 1].id : null;
        });
        var session = currentSession();
        if (!session) {
            var created = createSession();
            session = currentSession();
        }
        session.messages = normalized;
        if (!session.title || session.title === '新对话') session.title = deriveTitle(normalized, session.title);
        session.updatedAt = Date.now();
        persist();
        notify('import');
        return { ok: true, imported: normalized.length, messages: normalized };
    }

    function exportMarkdown() {
        var session = currentSession();
        var lines = [];
        lines.push('# ' + (session ? session.title : 'nChat 对话'));
        lines.push('');
        visibleMessages(session).forEach(function (message) {
            var role = message.role === 'user' ? 'User' : 'Assistant';
            var content = '';
            if (Array.isArray(message.content)) {
                var texts = message.content.filter(function (part) { return part && part.type === 'text'; })
                    .map(function (part) { return part.text || ''; });
                content = texts.join('\n');
                var images = message.content.filter(function (part) { return part && part.type === 'image_url'; }).length;
                if (images) content += (content ? '\n' : '') + '[' + images + ' images]';
            } else {
                content = typeof message.content === 'string' ? message.content : '';
            }
            if (message.attachments && message.attachments.length) {
                content += (content ? '\n\n' : '') + message.attachments.map(function (file) {
                    return '[附件：' + (file.name || '附件') + ']';
                }).join('\n');
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

    NC.store = NC.store || {};
    NC.store.conversation = {
        KEY: KEY,
        V2_KEY: V2_KEY,
        VERSION: VERSION,
        init: init,
        whenReady: whenReady,
        isReady: function () { return ready; },
        getStorageInfo: function () {
            return {
                mode: useLocal ? 'localStorage' : 'indexedDB',
                ready: ready,
                error: bootError ? String(bootError.message || bootError) : null
            };
        },
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
        exportAllSessions: exportAllSessions,
        importAllSessions: importAllSessions,
        importBackup: importBackup,
        exportMarkdown: exportMarkdown,
        reload: reload,
        /* v3 会话 API */
        getSessions: getSessions,
        getAllSessions: getAllSessions,
        getActiveSession: function () { return summaryOf(currentSession()); },
        createSession: createSession,
        selectSession: selectSession,
        deleteSession: deleteSession,
        renameSession: renameSession,
        selectVersion: selectVersion,
        getVersions: getVersions,
        getPathTo: getPathTo,
        getVisibleMessages: function () { return messages(); },
        getAllMessages: function () { return allMessages(currentSession()); }
    };
})(window);
