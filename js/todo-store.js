/**
 * todo-store.js — Todo 状态层（状态 + 持久化 + 撤销/重做 + 跨标签同步 + 选择器）
 * 经典脚本，依赖 core.js / storage.js；挂载：NC.store.todo
 *
 * 职责边界：
 *   - 只改内存文档与存储，不碰 DOM；
 *   - 所有写操作 → 撤销栈 → debounce 持久化 → emit('todo:changed')；
 *   - 外部数据（迁移/导入/备份恢复）先经 schema-todo 归一化再落盘；
 *   - 任何异常都不向上抛、不 console.error（验收要求页面无 console.error）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var storage = NC.storage;
    var events = NC.events;
    var schema = NC.schema.todo;

    var KEY = schema.KEYS.main;
    var BACKUP_KEY = schema.KEYS.backup;
    var V1_KEY = schema.KEYS.v1;
    var V1_BACKUP_KEY = schema.KEYS.v1Backup;
    var LEASE_KEY = 'ntools.todo.lease';
    var SAVE_DELAY = 250;
    var MAX_HISTORY = 20;
    var RETRY_MIN = 800;
    var RETRY_MAX = 15000;
    var SNAPSHOT_INTERVAL = 10 * 60 * 1000;
    var SNAPSHOT_EVERY_N_WRITES = 20;
    var TRASH_TTL = 30 * 24 * 60 * 60 * 1000;
    var LIST_COLORS = ['#5b8cff', '#9a7bff', '#3ddc97', '#f5c451', '#ff6b6b', '#5aa9e6', '#f5a04d', '#8b9bb4'];

    var state = {
        doc: schema.emptyDoc(),
        ui: {
            view: 'all',
            listId: null,
            search: '',
            selectedId: null,
            editingId: null,
            drawerOpen: false
        },
        demo: false,
        loaded: false,
        loadInfo: null,
        dirty: false,
        saveError: false,
        /* 只读：加载闸门（截断/未来版本）或另有窗口持有写权 */
        readOnly: false,
        readOnlyReason: null,
        readOnlyDetail: null,
        readOnlyRaw: null,
        lastSavedAt: 0,
        saveCount: 0,
        lastSnapshotAt: 0,
        snapshotAtSave: 0,
        snapshotInfo: null,
        retryDelay: 0
    };

    var listeners = [];
    var history = [];
    var redoStack = [];
    var saveTimer = null;
    var saveRetryTimer = null;
    var leaseProbeTimer = null;
    var warnedSave = false;
    var durabilityBound = false;
    var lifecycleBound = false;
    var externalUnsub = null;
    var leaseUnsub = null;
    var countsCache = { revision: -1, updatedAt: -1, value: null };

    /* ------------------------------------------------------------------ *
     * 通知 / 持久化
     * ------------------------------------------------------------------ */
    function notify(reason, extra) {
        countsCache.value = null;
        var snapshot = { doc: state.doc, ui: state.ui, reason: reason || 'change' };
        if (extra) {
            Object.keys(extra).forEach(function (key) { snapshot[key] = extra[key]; });
        }
        listeners.slice().forEach(function (fn) {
            try { fn(snapshot); } catch (err) { /* 视图错误不影响状态层 */ }
        });
        events.emit(NC.eventNames.todoChanged, snapshot);
    }

    function scheduleSave() {
        state.dirty = true;
        if (state.demo) return;
        if (state.readOnly) return;          // 只读时只积累 dirty，不写盘
        if (saveTimer) global.clearTimeout(saveTimer);
        saveTimer = global.setTimeout(function () {
            saveTimer = null;
            saveNow();
        }, SAVE_DELAY);
    }

    function clearRetry() {
        if (!saveRetryTimer) return;
        global.clearTimeout(saveRetryTimer);
        saveRetryTimer = null;
    }

    function scheduleRetry() {
        if (saveRetryTimer) return;
        if (state.demo || state.readOnly) return;
        state.retryDelay = state.retryDelay
            ? Math.min(Math.round(state.retryDelay * 2), RETRY_MAX)
            : RETRY_MIN;
        saveRetryTimer = global.setTimeout(function () {
            saveRetryTimer = null;
            if (state.readOnly || state.demo || !state.dirty) return;
            saveNow();
        }, state.retryDelay);
    }

    function emitSaveState() {
        var payload = saveState();
        events.emit(NC.eventNames.todoSavesate, payload);
        return payload;
    }

    /* ------------------------------------------------------------------ *
     * 单写者：同一时刻只允许一个窗口写这份数据
     * ------------------------------------------------------------------ */
    function durability() {
        return NC.durability || null;
    }

    function claimWrite() {
        var d = durability();
        if (!d || !d.lease) return true;
        if (d.lease.claim(LEASE_KEY)) return true;
        enterReadOnly('other-window', null);
        return false;
    }

    /** 初始化阶段使用：只取写权，不改只读状态（此时文档还没加载，横幅文案会不准） */
    function claimWriteQuiet() {
        var d = durability();
        if (!d || !d.lease) return true;
        return d.lease.claim(LEASE_KEY);
    }

    /* ------------------------------------------------------------------ *
     * 只读闸门
     * ------------------------------------------------------------------ */
    /* 只读镜像的复检：持有写权的窗口若被强杀（没机会发 pagehide），
     * 本窗口只靠 storage 事件是等不到通知的，会永久只读。每 3 秒复核一次租约。 */
    function stopLeaseProbe() {
        if (!leaseProbeTimer) return;
        global.clearInterval(leaseProbeTimer);
        leaseProbeTimer = null;
    }

    function startLeaseProbe() {
        stopLeaseProbe();
        if (state.demo || !global.setInterval) return;
        leaseProbeTimer = global.setInterval(function () {
            if (!state.readOnly || state.readOnlyReason !== 'other-window') {
                stopLeaseProbe();
                return;
            }
            var d = durability();
            if (!d || !d.lease) return;
            if (!d.lease.isOwner(LEASE_KEY)) return;
            exitReadOnly();
            if (state.dirty) saveNow();
        }, 3000);
    }

    function enterReadOnly(reason, detail) {
        var was = state.readOnly;
        state.readOnly = true;
        state.readOnlyReason = reason;
        state.readOnlyDetail = detail || null;
        clearRetry();
        if (!was) {
            notify('read-only', { reason: reason, detail: state.readOnlyDetail });
        }
        events.emit(NC.eventNames.todoReadonly, {
            reason: reason,
            detail: state.readOnlyDetail,
            message: readOnlyMessage(reason, detail)
        });
        if (reason === 'other-window') startLeaseProbe();
        else stopLeaseProbe();
        emitSaveState();
    }

    function readOnlyMessage(reason, detail) {
        if (reason === 'other-window') return '另一个窗口正在编辑待办，本窗口为只读镜像';
        if (reason === 'future-version') return '数据来自更新版本的 nTools，已进入只读模式以避免覆盖';
        if (reason === 'load-trimmed') {
            var n = detail && detail.issues ? detail.issues.length : 0;
            return '加载时检测到 ' + n + ' 处会导致数据减少的问题，已进入只读模式';
        }
        return '待办数据已进入只读模式';
    }

    function exitReadOnly() {
        stopLeaseProbe();
        if (!state.readOnly) return true;
        state.readOnly = false;
        state.readOnlyReason = null;
        state.readOnlyDetail = null;
        state.readOnlyRaw = null;
        notify('read-write', {});
        events.emit(NC.eventNames.todoReadonly, { reason: null, message: null });
        emitSaveState();
        return true;
    }

    /** 另一个窗口释放了写权 / 用户点击「接管编辑」 */
    function takeover() {
        stopLeaseProbe();
        var d = durability();
        if (d && d.lease && !d.lease.steal(LEASE_KEY)) return false;
        state.readOnly = false;
        state.readOnlyReason = null;
        state.readOnlyDetail = null;
        state.readOnlyRaw = null;
        events.emit(NC.eventNames.todoReadonly, { reason: null, message: null });
        emitSaveState();
        if (state.dirty) saveNow();
        return true;
    }

    /** 用户确认接受加载时的修剪：先落一份快照，再放开写入 */
    function acceptTrimmed() {
        if (!state.readOnly || state.readOnlyReason !== 'load-trimmed') return false;
        maybeSnapshot(true);
        var payload = state.readOnlyDetail && state.readOnlyDetail.issues;
        state.readOnly = false;
        state.readOnlyReason = null;
        state.readOnlyDetail = null;
        events.emit(NC.eventNames.todoReadonly, { reason: null, message: null });
        var ok = saveNow();
        if (!ok) enterReadOnly('save-failed', { issues: payload });
        return ok;
    }

    /** 原始（未修剪）数据的下载文本，用于"另存原始数据" */
    function originalRaw() {
        return state.readOnlyRaw || null;
    }

    /* ------------------------------------------------------------------ *
     * 写入
     * ------------------------------------------------------------------ */
    function saveNow() {
        if (state.demo) return false;
        if (state.readOnly) return false;
        if (saveTimer) {
            global.clearTimeout(saveTimer);
            saveTimer = null;
        }
        if (!claimWrite()) return false;

        var prevRev = util.isFiniteNum(state.doc.revision) ? state.doc.revision : 0;
        var prevUpdatedAt = state.doc.updatedAt;
        var nextRev = prevRev + 1;

        try {
            state.doc.revision = nextRev;
            state.doc.updatedAt = Date.now();
            // setVerified：写完读回比对，避免"以为存上了"
            var result = storage.setVerified(KEY, state.doc);
            if (!result || result.ok !== true) {
                state.doc.revision = prevRev;
                state.doc.updatedAt = prevUpdatedAt;
                state.saveError = true;
                state.dirty = true;
                clearRetry();
                scheduleRetry();
                if (!warnedSave) {
                    warnedSave = true;
                    events.emit(NC.eventNames.todoError, {
                        code: 'save-failed',
                        message: result && result.quota
                            ? '本地存储空间不足，修改暂存在内存中，请导出备份'
                            : '本地存储写入失败，修改暂存在内存中'
                    });
                }
                emitSaveState();
                return false;
            }
            state.saveError = false;
            state.dirty = false;
            state.retryDelay = 0;
            warnedSave = false;
            state.saveCount += 1;
            state.lastSavedAt = Date.now();
            clearRetry();
            maybeSnapshot();
            emitSaveState();
            return true;
        } catch (err) {
            state.doc.revision = prevRev;
            state.doc.updatedAt = prevUpdatedAt;
            state.saveError = true;
            state.dirty = true;
            scheduleRetry();
            emitSaveState();
            return false;
        }
    }

    /* ------------------------------------------------------------------ *
     * 环形快照
     * ------------------------------------------------------------------ */
    function maybeSnapshot(force) {
        var d = durability();
        if (!d || !d.snapshot) return;
        var now = Date.now();
        var due = !!force ||
            (now - state.lastSnapshotAt > SNAPSHOT_INTERVAL) ||
            (state.saveCount - state.snapshotAtSave >= SNAPSHOT_EVERY_N_WRITES);
        if (!due) return;
        state.lastSnapshotAt = now;
        state.snapshotAtSave = state.saveCount;
        d.snapshot.push('todo', state.doc, {
            tasks: state.doc.tasks.length,
            lists: state.doc.lists.length,
            revision: state.doc.revision
        }).then(function (res) {
            if (res && res.ok) {
                state.snapshotInfo = { at: now, slot: res.slot, backend: res.backend };
                events.emit(NC.eventNames.todoSnapshot, state.snapshotInfo);
            }
        }).catch(function () { /* 快照失败不阻断主流程 */ });
    }

    function listSnapshots() {
        var d = durability();
        if (!d || !d.snapshot) return Promise.resolve([]);
        return d.snapshot.list('todo');
    }

    function readSnapshot(slot) {
        var d = durability();
        if (!d || !d.snapshot) return Promise.resolve(null);
        return d.snapshot.read('todo', slot);
    }

    /**
     * 从快照恢复。恢复前先把"当前状态"也存一份，避免恢复错了无法回头。
     */
    function restoreSnapshot(slot) {
        return readSnapshot(slot).then(function (doc) {
            if (!doc) return { ok: false, reason: 'empty' };
            var normalized = schema.normalizeDoc(doc).doc;
            if (!normalized || !normalized.tasks) return { ok: false, reason: 'format' };
            maybeSnapshot(true);
            var before = schema.clone(state.doc);
            state.doc = normalized;
            var entry = {
                label: '从快照恢复',
                undo: function () { if (before) replaceDoc(schema.clone(before)); }
            };
            pushEntry(entry);
            ensureUi();
            notify('restore-snapshot', { tasks: normalized.tasks.length, slot: slot });
            saveNow();
            return { ok: true, tasks: normalized.tasks.length };
        }).catch(function () {
            return { ok: false, reason: 'exception' };
        });
    }

    function saveState() {
        return {
            ok: !state.saveError,
            dirty: state.dirty,
            readOnly: state.readOnly,
            reason: state.readOnlyReason,
            message: state.readOnly ? readOnlyMessage(state.readOnlyReason, state.readOnlyDetail) : '',
            retrying: !!saveRetryTimer,
            retryDelay: state.retryDelay,
            lastSavedAt: state.lastSavedAt,
            saveCount: state.saveCount,
            revision: state.doc ? state.doc.revision : 0,
            pending: typeof storage.hasPending === 'function' ? storage.hasPending(KEY) : false,
            memoryMode: typeof storage.memoryMode === 'function' ? storage.memoryMode() : !storage.available
        };
    }

    function bindDurability() {
        if (durabilityBound) return;
        durabilityBound = true;
        var d = durability();
        if (!d) return;
        d.snapshot.configure({ prefix: 'todo', slots: 3, namespace: 'todo' });
        if (leaseUnsub) leaseUnsub();
        leaseUnsub = d.lease.watch(LEASE_KEY, function (owner) {
            if (!owner && !state.readOnly) {
                enterReadOnly('other-window', null);
            } else if (owner && state.readOnly && state.readOnlyReason === 'other-window') {
                exitReadOnly();
                if (state.dirty) saveNow();
            }
        });
    }

    function flush() {
        if (state.dirty) saveNow();
    }

    /* ------------------------------------------------------------------ *
     * 加载 / 迁移
     * ------------------------------------------------------------------ */
    function adoptDoc(doc, reason, extra) {
        state.doc = doc;
        state.loaded = true;
        ensureUi();
        notify(reason || 'init', extra);
    }

    function ensureUi() {
        var doc = state.doc;
        if (!doc) return;
        if (state.ui.view === 'trash') return;
        var listIds = Object.create(null);
        doc.lists.forEach(function (list) { listIds[list.id] = true; });
        if (state.ui.listId && !listIds[state.ui.listId]) state.ui.listId = null;
        if (state.ui.selectedId && !findTask(state.ui.selectedId)) {
            state.ui.selectedId = null;
            state.ui.editingId = null;
            state.ui.drawerOpen = false;
        }
        if (doc.settings && !listIds[doc.settings.defaultListId]) {
            doc.settings.defaultListId = 'list_default';
        }
        if (schema.VIEWS.indexOf(state.ui.view) === -1 && state.ui.view !== 'trash') {
            state.ui.view = schema.VIEWS.indexOf(doc.settings.view) > -1 ? doc.settings.view : 'all';
        }
    }

    function loadFromRaw() {
        var info = { from: 'empty', migrated: 0, quarantined: 0, recovered: false };

        /* 1. 主文档 */
        var raw = storage.getRaw(KEY);
        if (raw != null) {
            var parsed = util.parseJSON(raw, undefined);
            if (parsed !== undefined) {
                if (Array.isArray(parsed) || (util.isPlainObject(parsed) && Array.isArray(parsed.data) && !Array.isArray(parsed.tasks))) {
                    /* 旧数组被写进了主键：按 v1 迁移 */
                    var migMain = schema.migrateV1(parsed);
                    info.from = 'main-legacy';
                    info.migrated = migMain.stats.migrated;
                    info.quarantined = migMain.doc.meta.quarantine.length;
                    adoptDoc(migMain.doc, 'init', { loadInfo: info });
                    saveNow();
                    return info;
                }
                if (util.isPlainObject(parsed) && (parsed.schemaVersion === 2 || Array.isArray(parsed.tasks))) {
                    var norm = schema.normalizeDoc(parsed);
                    info.from = parsed.schemaVersion === 2 ? 'v2' : 'v2-fallback';
                    info.migrated = norm.doc.tasks.length;
                    info.quarantined = norm.doc.meta.quarantine.length;
                    info.issues = norm.issues || [];
                    adoptDoc(norm.doc, 'init', { loadInfo: info });
                    /* 加载闸门：任何"会让数据变少"或"来自更高版本"的情况，先只读，
                     * 由用户决定「另存原始数据」还是「接受修剪」。绝不再自动写盘覆盖。 */
                    var future = util.isFiniteNum(parsed.schemaVersion) && parsed.schemaVersion > schema.DOC_VERSION;
                    var destructive = schema.destructiveIssues ? schema.destructiveIssues(norm.issues) : [];
                    if (future) {
                        state.readOnlyRaw = raw;
                        enterReadOnly('future-version', {
                            schemaVersion: parsed.schemaVersion,
                            readVersion: schema.DOC_VERSION,
                            issues: norm.issues || []
                        });
                    } else if (destructive.length) {
                        state.readOnlyRaw = raw;
                        enterReadOnly('load-trimmed', {
                            issues: destructive,
                            allIssues: norm.issues || []
                        });
                    }
                    return info;
                }
            }
            /* 损坏：备份原始字符串后继续找可用数据 */
            storage.backupCorrupted(KEY, raw);
        }

        /* 2. 上次良好备份 */
        var backupRaw = storage.getRaw(BACKUP_KEY);
        if (backupRaw != null) {
            var backupParsed = util.parseJSON(backupRaw, undefined);
            if (backupParsed !== undefined && util.isPlainObject(backupParsed) && Array.isArray(backupParsed.tasks)) {
                var backupNorm = schema.normalizeDoc(backupParsed);
                info.from = 'v2-backup';
                info.recovered = true;
                info.migrated = backupNorm.doc.tasks.length;
                adoptDoc(backupNorm.doc, 'init', { loadInfo: info });
                saveNow();
                return info;
            }
        }

        /* 3. v1 旧键 → 迁移 */
        var v1raw = storage.getRaw(V1_KEY);
        if (v1raw != null) {
            var v1parsed = util.parseJSON(v1raw, undefined);
            var v1Items = Array.isArray(v1parsed)
                ? v1parsed
                : (util.isPlainObject(v1parsed) && Array.isArray(v1parsed.data) ? v1parsed.data : null);
            if (v1Items) {
                if (storage.getRaw(V1_BACKUP_KEY) == null) {
                    storage.setRaw(V1_BACKUP_KEY, v1raw);
                }
                var mig = schema.migrateV1(v1Items);
                info.from = 'v1';
                info.migrated = mig.stats.migrated;
                info.quarantined = mig.doc.meta.quarantine.length;
                adoptDoc(mig.doc, 'init', { loadInfo: info });
                saveNow();
                return info;
            }
            storage.backupCorrupted(V1_KEY, v1raw);
        }

        /* 4. 全新 */
        state.doc = schema.emptyDoc();
        state.loaded = true;
        ensureUi();
        notify('init', { loadInfo: info });
        saveNow();
        return info;
    }

    /**
     * 回收站保留 30 天。超期任务在下一次启动时清理，并显式告知用户
     * （不静默删除，也不让它无限占用 3.5MB 预算）。
     */
    function purgeStaleTrash() {
        var cutoff = Date.now() - TRASH_TTL;
        var before = state.doc.tasks.length;
        state.doc.tasks = state.doc.tasks.filter(function (task) {
            return !(task && task.deletedAt && task.deletedAt < cutoff);
        });
        var removed = before - state.doc.tasks.length;
        if (removed > 0) {
            events.emit(NC.eventNames.todoTrashPurged, {
                removed: removed,
                days: Math.round(TRASH_TTL / 86400000),
                message: '已自动清理回收站中 ' + removed + ' 条超过 30 天的任务'
            });
        }
        return removed;
    }

    function init(options) {
        var opts = options || {};
        state.loaded = false;
        state.demo = !!opts.demo;
        state.readOnly = false;
        state.readOnlyReason = null;
        state.readOnlyDetail = null;
        state.readOnlyRaw = null;
        state.saveError = false;
        state.dirty = false;
        state.retryDelay = 0;
        clearRetry();
        history = [];
        redoStack = [];
        warnedSave = false;

        if (opts.demoDoc) {
            state.doc = schema.normalizeDoc(opts.demoDoc, { now: opts.now }).doc;
            state.demo = true;
            state.loaded = true;
            ensureUi();
            notify('init', { loadInfo: { from: 'demo', migrated: state.doc.tasks.length } });
            return;
        }

        /* 先取写权再加载：迁移/自动保存都属于"写"，不应在无写权时发生 */
        bindDurability();
        var owned = claimWriteQuiet();

        try {
            state.loadInfo = loadFromRaw();
        } catch (err) {
            /* 兜底：任何加载异常都退化为空文档 + 内存模式 */
            state.doc = schema.emptyDoc();
            state.loaded = true;
            state.saveError = true;
            ensureUi();
            notify('init', { loadInfo: { from: 'fallback' } });
            events.emit(NC.eventNames.todoError, { code: 'load-failed', message: '待办数据加载失败，已使用空白列表' });
        }

        if (externalUnsub) externalUnsub();
        externalUnsub = storage.onExternalChange(KEY, onExternalChange);

        if (!lifecycleBound) {
            lifecycleBound = true;
            global.addEventListener('pagehide', flush);
            document.addEventListener('visibilitychange', function () {
                if (document.hidden) flush();
            });
        }

        if (state.ui.view === 'trash') state.ui.view = 'all';
        if (state.ui.listId != null) state.ui.listId = null;
        /* 恢复上次视图（契约 settings.view 只允许 4 种） */
        var persistedView = state.doc.settings && schema.VIEWS.indexOf(state.doc.settings.view) > -1
            ? state.doc.settings.view : 'all';
        state.ui.view = persistedView;

        /* 写权在别的窗口：加载完成后进入只读镜像（此时文档已就绪，横幅文案才准） */
        if (!owned && !state.readOnly) enterReadOnly('other-window', null);

        if (!state.readOnly && purgeStaleTrash() > 0) {
            ensureUi();
            scheduleSave();
        }

        /* 循环任务：打开时把过期的 due 推到下一周期（每天/每周/每月/每年） */
        if (!state.readOnly) {
            try { refreshRecurringDue(Date.now()); } catch (err) { /* ignore */ }
            startRecurRefreshTimer();
        }

        notify('init', { loadInfo: state.loadInfo });
        emitSaveState();
        return state.loadInfo;
    }

    /* 每 5 分钟检查一次循环任务，跨天时列表里的到期时间会自动前进 */
    var recurTimer = null;
    function startRecurRefreshTimer() {
        if (recurTimer || !global.setInterval) return;
        recurTimer = global.setInterval(function () {
            if (state.readOnly || document.hidden) return;
            refreshRecurringDue(Date.now());
        }, 5 * 60 * 1000);
    }

    function onExternalChange(newValue) {
        if (newValue == null) {
            // 主键被清空（另一个窗口 reset）：不跟随，避免把自己也清掉
            return;
        }
        var parsed = util.parseJSON(newValue, undefined);
        if (parsed === undefined || !util.isPlainObject(parsed) || !Array.isArray(parsed.tasks)) return;
        var incoming = schema.normalizeDoc(parsed).doc;
        var incomingRev = util.isFiniteNum(incoming.revision) ? incoming.revision : 0;
        var localRev = util.isFiniteNum(state.doc.revision) ? state.doc.revision : 0;
        if (incomingRev <= localRev) return;

        /* 本地有未保存修改且外部版本更新：进入只读，禁止下一次写覆盖对方。
         * （有租约时通常走不到这里；这是租约失效/被强删时的兜底。） */
        if (state.dirty) {
            enterReadOnly('external-conflict', { remoteRevision: incomingRev });
            notify('external-conflict', { remoteRevision: incomingRev });
            return;
        }
        if (state.readOnly && state.readOnlyReason === 'load-trimmed') return;
        state.doc = incoming;
        ensureUi();
        notify('external', { remoteRevision: incomingRev });
        emitSaveState();
    }

    /* ------------------------------------------------------------------ *
     * 撤销 / 重做
     * ------------------------------------------------------------------ */
    function pushEntry(entry) {
        entry.token = entry.token || util.uid('undo');
        history.push(entry);
        if (history.length > MAX_HISTORY) history.shift();
        redoStack = [];
    }

    function applyEntry(entry, direction) {
        try {
            if (direction === 'undo') entry.undo();
            else entry.redo();
        } catch (err) {
            return false;
        }
        ensureUi();
        notify(direction === 'undo' ? 'undo' : 'redo', { label: entry.label });
        scheduleSave();
        return true;
    }

    function undo(token) {
        if (!history.length) return null;
        var index = history.length - 1;
        if (token) {
            index = -1;
            for (var i = history.length - 1; i >= 0; i--) {
                if (history[i].token === token) { index = i; break; }
            }
            if (index === -1) return null;
        }
        var entry = history[index];
        history.splice(index, 1);
        applyEntry(entry, 'undo');
        if (!token) redoStack.push(entry);
        return entry.label || '操作';
    }

    function redo() {
        if (!redoStack.length) return null;
        var entry = redoStack.pop();
        applyEntry(entry, 'redo');
        history.push(entry);
        return entry.label || '操作';
    }

    function canUndo() { return history.length > 0; }
    function canRedo() { return redoStack.length > 0; }
    function undoLabel() { return history.length ? history[history.length - 1].label : ''; }
    function redoLabel() { return redoStack.length ? redoStack[redoStack.length - 1].label : ''; }
    function lastUndoToken() { return history.length ? history[history.length - 1].token : null; }

    /* ------------------------------------------------------------------ *
     * 查询
     * ------------------------------------------------------------------ */
    function getDoc() { return state.doc; }
    function getUi() { return state.ui; }
    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var i = listeners.indexOf(fn);
            if (i > -1) listeners.splice(i, 1);
        };
    }

    function findTask(id) {
        var tasks = state.doc.tasks;
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].id === id) return tasks[i];
        }
        return null;
    }

    function taskIndex(id) {
        var tasks = state.doc.tasks;
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].id === id) return i;
        }
        return -1;
    }

    function findList(id) {
        var lists = state.doc.lists;
        for (var i = 0; i < lists.length; i++) {
            if (lists[i].id === id) return lists[i];
        }
        return null;
    }

    function currentListId() {
        var doc = state.doc;
        if (state.ui.listId && findList(state.ui.listId)) return state.ui.listId;
        if (findList(doc.settings.defaultListId)) return doc.settings.defaultListId;
        return doc.lists[0] ? doc.lists[0].id : 'list_default';
    }

    function counts(force) {
        var doc = state.doc;
        var revision = util.isFiniteNum(doc.revision) ? doc.revision : 0;
        if (!force && countsCache.revision === revision && countsCache.updatedAt === doc.updatedAt && countsCache.value) {
            return countsCache.value;
        }
        var value = schema.docCounts(doc, Date.now());
        value.byList = value.byList || {};
        countsCache = { revision: revision, updatedAt: doc.updatedAt, value: value };
        return value;
    }

    function matchesSearch(task, query) {
        if (!query) return true;
        var needle = query.toLowerCase();
        if (String(task.title).toLowerCase().indexOf(needle) > -1) return true;
        if (task.notes && String(task.notes).toLowerCase().indexOf(needle) > -1) return true;
        if (task.tags && task.tags.length) {
            for (var i = 0; i < task.tags.length; i++) {
                if (String(task.tags[i]).toLowerCase().indexOf(needle) > -1) return true;
            }
        }
        return false;
    }

    function statusRank(task) {
        if (task.deletedAt) return 3;
        if (task.status === 'done') return 2;
        if (task.status === 'canceled') return 1;
        return 0;
    }

    function comparePinned(a, b) {
        var pa = a.pinned === true ? 1 : 0;
        var pb = b.pinned === true ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return 0;
    }

    function compareSmart(a, b) {
        var pinned = comparePinned(a, b);
        if (pinned !== 0) return pinned;
        var ra = statusRank(a);
        var rb = statusRank(b);
        if (ra !== rb) return ra - rb;
        var da = a.due == null ? 1 : 0;
        var db = b.due == null ? 1 : 0;
        if (da !== db) return da - db;
        if (da === 0 && a.due !== b.due) return a.due - b.due;
        var pa = schema.priorityWeight(a.priority);
        var pb = schema.priorityWeight(b.priority);
        if (pa !== pb) return pb - pa;
        return (b.createdAt || 0) - (a.createdAt || 0);
    }

    function compareDue(a, b) {
        var pinned = comparePinned(a, b);
        if (pinned !== 0) return pinned;
        var da = a.due == null ? Infinity : a.due;
        var db = b.due == null ? Infinity : b.due;
        if (da !== db) return da - db;
        return compareSmart(a, b);
    }

    function compareCreated(a, b) {
        var pinned = comparePinned(a, b);
        if (pinned !== 0) return pinned;
        return (b.createdAt || 0) - (a.createdAt || 0);
    }

    function compareManual(a, b) {
        var pinned = comparePinned(a, b);
        if (pinned !== 0) return pinned;
        if (a.order !== b.order) return a.order - b.order;
        return (a.createdAt || 0) - (b.createdAt || 0);
    }

    function sortTasks(tasks, sort) {
        var comparator = compareSmart;
        if (sort === 'due') comparator = compareDue;
        else if (sort === 'created') comparator = compareCreated;
        else if (sort === 'manual') comparator = compareManual;
        return tasks.slice().sort(comparator);
    }

    /**
     * 当前视图可见任务（已排序）。视图/清单/搜索规则集中在这里，视图层只负责分组与渲染。
     */
    function selectVisible(now) {
        var ts = util.isFiniteNum(now) ? now : Date.now();
        var doc = state.doc;
        var ui = state.ui;
        var settings = doc.settings;
        var search = ui.search.trim();
        var tasks = doc.tasks.filter(function (task) {
            if (ui.view === 'trash') return !!task.deletedAt;
            if (task.deletedAt) return false;
            if (ui.listId && task.listId !== ui.listId) return false;
            if (search) return matchesSearch(task, search);

            if (ui.view === 'today') {
                return task.status === 'open' && schema.isToday(task, ts);
            }
            if (ui.view === 'week') {
                return task.status === 'open' && schema.isThisWeek(task, ts);
            }
            if (ui.view === 'overdue') {
                return schema.isOverdue(task, ts);
            }
            if (ui.view === 'none') {
                return task.status === 'open' && !util.isFiniteNum(task.due);
            }
            if (ui.view === 'done') {
                return task.status === 'done';
            }
            /* all */
            if (task.status === 'done' && !settings.showCompleted) return false;
            return true;
        });
        return {
            tasks: sortTasks(tasks, settings.sort),
            view: ui.view,
            listId: ui.listId,
            search: search,
            sort: settings.sort,
            showCompleted: settings.showCompleted
        };
    }

    function getTask(id) { return findTask(id); }

    /* ------------------------------------------------------------------ *
     * UI 状态
     * ------------------------------------------------------------------ */
    function setView(view) {
        var valid = schema.VIEWS.indexOf(view) > -1 || view === 'trash';
        if (!valid) return;
        state.ui.view = view;
        state.ui.listId = null;
        state.ui.selectedId = null;
        state.ui.editingId = null;
        state.ui.drawerOpen = false;
        if (schema.VIEWS.indexOf(view) > -1) {
            state.doc.settings.view = view;
            scheduleSave();
        }
        notify('ui:view', { view: view });
    }

    function setListFilter(listId) {
        state.ui.listId = listId || null;
        if (listId) state.ui.view = 'all';
        state.ui.selectedId = null;
        state.ui.editingId = null;
        state.ui.drawerOpen = false;
        notify('ui:list', { listId: state.ui.listId });
    }

    function setSort(sort) {
        if (schema.SORTS.indexOf(sort) === -1) return;
        state.doc.settings.sort = sort;
        notify('ui:sort', { sort: sort });
        scheduleSave();
    }

    function setSearch(query) {
        var next = String(query == null ? '' : query);
        if (state.ui.search === next) return;
        state.ui.search = next;
        state.ui.selectedId = null;
        state.ui.editingId = null;
        notify('ui:search', { search: next });
    }

    function toggleShowCompleted(force) {
        var value = typeof force === 'boolean' ? force : !state.doc.settings.showCompleted;
        state.doc.settings.showCompleted = value;
        notify('ui:completed', { showCompleted: value });
        scheduleSave();
    }

    function selectTask(id) {
        if (id && !findTask(id)) return;
        state.ui.selectedId = id || null;
        state.ui.editingId = null;
        if (id) state.ui.drawerOpen = true;
        notify('ui:select', { id: id || null });
    }

    function clearSelection() {
        state.ui.selectedId = null;
        state.ui.editingId = null;
        state.ui.drawerOpen = false;
        notify('ui:select', { id: null });
    }

    function openDrawer() {
        if (!state.ui.selectedId) return;
        state.ui.drawerOpen = true;
        notify('ui:drawer', { open: true });
    }

    function closeDrawer() {
        state.ui.drawerOpen = false;
        notify('ui:drawer', { open: false });
    }

    function startEdit(id) {
        if (!id || !findTask(id)) return;
        state.ui.selectedId = id;
        state.ui.editingId = id;
        notify('ui:edit', { id: id });
    }

    function stopEdit() {
        state.ui.editingId = null;
        notify('ui:edit', { id: null });
    }

    /* ------------------------------------------------------------------ *
     * 任务操作
     * ------------------------------------------------------------------ */
    function nextOrder(listId) {
        var max = -1024;
        state.doc.tasks.forEach(function (task) {
            if (task.listId === listId && util.isFiniteNum(task.order) && task.order > max) max = task.order;
        });
        return max + 1024;
    }

    function makeCtx() {
        var ids = Object.create(null);
        var listIds = Object.create(null);
        state.doc.tasks.forEach(function (task) { ids[task.id] = true; });
        state.doc.lists.forEach(function (list) { listIds[list.id] = true; });
        return {
            now: Date.now(),
            issues: [],
            quarantine: [],
            ids: ids,
            listIds: listIds,
            defaultListId: currentListId(),
            index: state.doc.tasks.length
        };
    }

    function addTask(input) {
        var data = input || {};
        var title = typeof data.title === 'string' ? data.title.trim() : '';
        if (!title) return null;
        /* 上限护栏：宁可拒绝新增，也不要造出一个"下次加载会被截断"的文档 */
        if (state.doc.tasks.length >= schema.LIMITS.tasks) {
            events.emit(NC.eventNames.todoLimit, {
                code: 'tasks',
                limit: schema.LIMITS.tasks,
                message: '任务已达 ' + schema.LIMITS.tasks + ' 条上限，请先清理已完成或回收站任务'
            });
            return null;
        }
        var ctx = makeCtx();
        var now = Date.now();
        var task = schema.normalizeTask({
            id: schema.newId('t'),
            title: title,
            notes: data.notes || '',
            status: 'open',
            priority: data.priority || 'normal',
            due: data.due != null ? data.due : null,
            pinned: data.pinned === true,
            recurrence: data.recurrence || null,
            listId: data.listId || ctx.defaultListId,
            tags: data.tags || [],
            order: nextOrder(data.listId || ctx.defaultListId),
            createdAt: now,
            updatedAt: now,
            source: 'manual'
        }, ctx);
        if (!task) return null;
        var index = state.doc.tasks.length;
        state.doc.tasks.push(task);
        pushEntry({
            label: '添加任务',
            undo: function () {
                var pos = taskIndex(task.id);
                if (pos > -1) state.doc.tasks.splice(pos, 1);
            },
            redo: function () {
                if (!findTask(task.id)) state.doc.tasks.splice(Math.min(index, state.doc.tasks.length), 0, task);
            }
        });
        state.ui.selectedId = null;
        notify('task:add', { id: task.id });
        scheduleSave();
        return task;
    }

    var UPDATABLE_FIELDS = ['title', 'notes', 'priority', 'due', 'dueAllDay', 'listId', 'tags', 'status', 'completedAt', 'reminder', 'pinned', 'recurrence'];

    function updateTask(id, patch, options) {
        var opts = options || {};
        var task = findTask(id);
        if (!task || !patch) return false;
        var before = schema.clone(task);
        if (!before) return false;

        var merged = schema.clone(task);
        var changed = false;
        UPDATABLE_FIELDS.forEach(function (field) {
            if (!Object.prototype.hasOwnProperty.call(patch, field)) return;
            merged[field] = patch[field];
            changed = true;
        });
        if (!changed) return false;

        var ctx = makeCtx();
        var next = schema.normalizeTask(merged, ctx);
        if (!next) return false;
        /* makeCtx 把自身 id 也标记为已占用，归一化会误判重复并换 id：这里强制保持原 id */
        next.id = id;

        /* 状态迁移语义 */
        if (next.status === 'done' && before.status !== 'done') {
            next.completedAt = util.isFiniteNum(patch.completedAt) ? patch.completedAt : Date.now();
        } else if (next.status !== 'done') {
            next.completedAt = null;
        }
        next.updatedAt = Date.now();
        next.createdAt = before.createdAt;
        next.order = before.order;
        next.deletedAt = before.deletedAt;
        if (!opts.silentTimestamp) next.updatedAt = Date.now();

        var pos = taskIndex(id);
        if (pos === -1) return false;
        state.doc.tasks[pos] = next;

        if (!opts.noUndo) {
            var after = schema.clone(next);
            pushEntry({
                label: opts.label || '编辑任务',
                undo: function () {
                    var at = taskIndex(id);
                    if (at > -1 && before) state.doc.tasks[at] = before;
                },
                redo: function () {
                    var at = taskIndex(id);
                    if (at > -1 && after) state.doc.tasks[at] = after;
                }
            });
        }
        notify('task:update', { id: id, fields: Object.keys(patch) });
        scheduleSave();
        return true;
    }

    function toggleTask(id) {
        var task = findTask(id);
        if (!task) return false;
        /* 取消完成：不前移、不触发循环 */
        if (task.status === 'done') {
            return updateTask(id, { status: 'open' }, { label: '取消完成' });
        }
        /* 循环任务：同一任务 due 前移到下一周期，status 回到 open（不生成副本） */
        var recurrence = task.recurrence;
        if (recurrence && typeof schema.nextRecurrenceDue === 'function') {
            var now = Date.now();
            var baseDue = util.isFiniteNum(task.due) ? task.due : now;
            var nextDue = schema.nextRecurrenceDue(recurrence, baseDue, now);
            if (nextDue != null) {
                var nextRecurrence = schema.clone(recurrence) || {};
                nextRecurrence.lastMaterializedAt = now;
                nextRecurrence.lastCompletedAt = now;
                var ok = updateTask(id, {
                    status: 'open',
                    due: nextDue,
                    recurrence: nextRecurrence
                }, { label: '完成循环任务' });
                if (ok) {
                    notify('task:recurred', { id: id, nextDue: nextDue });
                    events.emit(NC.eventNames.todoRecurred, {
                        id: id,
                        nextDue: nextDue,
                        freq: nextRecurrence.freq,
                        title: task.title
                    });
                }
                return ok;
            }
            /* until 到期/无下一次：退化为普通完成 */
        }
        return updateTask(id, { status: 'done' }, { label: '完成任务' });
    }

    /**
     * 循环任务到期时间随周期自动前移。
     * 规则：只看「未完成 + 有 due + due 已过去」的任务，按周期推到下一个仍 > now 的时间点。
     * 例：每天循环、11-05 17:30 到期，11-06 打开时应显示 11-06 17:30。
     * @returns {number} 被更新的任务数
     */
    function refreshRecurringDue(now) {
        var ts = util.isFiniteNum(now) ? now : Date.now();
        if (!schema || typeof schema.nextRecurrenceDue !== 'function') return 0;
        var changed = 0;
        var doc = state.doc;
        (doc.tasks || []).forEach(function (task, index) {
            if (!task || task.deletedAt || task.status !== 'open') return;
            if (!task.recurrence || !util.isFiniteNum(task.due)) return;
            if (task.due > ts) return;
            var next = schema.nextRecurrenceDue(task.recurrence, task.due, ts);
            if (next == null || next <= task.due) return;
            var copy = schema.clone(task);
            if (!copy) return;
            copy.due = next;
            copy.updatedAt = ts;
            doc.tasks[index] = copy;
            changed += 1;
        });
        if (changed) {
            doc.updatedAt = ts;
            notify('task:refresh-due', { count: changed });
            scheduleSave();
        }
        return changed;
    }

    /**
     * 置顶 / 取消置顶。
     * @returns {boolean|null} 新的 pinned 值；任务不存在返回 null
     */
    function togglePin(id) {
        var task = findTask(id);
        if (!task) return null;
        var next = !(task.pinned === true);
        var ok = updateTask(id, { pinned: next }, { label: next ? '置顶任务' : '取消置顶' });
        return ok ? next : null;
    }

    function deleteTask(id) {
        var task = findTask(id);
        if (!task) return null;
        if (task.deletedAt) return null;
        var before = schema.clone(task);
        task.deletedAt = Date.now();
        task.updatedAt = task.deletedAt;
        pushEntry({
            label: '删除任务',
            undo: function () {
                var current = findTask(id);
                if (current) current.deletedAt = null;
            },
            redo: function () {
                var current = findTask(id);
                if (current) current.deletedAt = Date.now();
            }
        });
        notify('task:delete', { id: id });
        scheduleSave();
        return { id: id, token: lastUndoToken(), title: before ? before.title : '' };
    }

    function restoreTask(id) {
        var task = findTask(id);
        if (!task || !task.deletedAt) return false;
        var before = task.deletedAt;
        task.deletedAt = null;
        task.updatedAt = Date.now();
        pushEntry({
            label: '恢复任务',
            undo: function () {
                var current = findTask(id);
                if (current) current.deletedAt = before;
            },
            redo: function () {
                var current = findTask(id);
                if (current) current.deletedAt = Date.now();
            }
        });
        notify('task:restore', { id: id });
        scheduleSave();
        return true;
    }

    function purgeTask(id) {
        var pos = taskIndex(id);
        if (pos === -1) return false;
        var removed = state.doc.tasks.splice(pos, 1)[0];
        pushEntry({
            label: '彻底删除',
            undo: function () {
                if (!findTask(id)) state.doc.tasks.splice(Math.min(pos, state.doc.tasks.length), 0, removed);
            },
            redo: function () {
                var at = taskIndex(id);
                if (at > -1) state.doc.tasks.splice(at, 1);
            }
        });
        if (state.ui.selectedId === id) {
            state.ui.selectedId = null;
            state.ui.editingId = null;
            state.ui.drawerOpen = false;
        }
        notify('task:purge', { id: id });
        scheduleSave();
        return true;
    }

    function clearTrash() {
        var trashed = state.doc.tasks.filter(function (task) { return !!task.deletedAt; });
        if (!trashed.length) return 0;
        var before = schema.clone(state.doc.tasks) || [];
        state.doc.tasks = state.doc.tasks.filter(function (task) { return !task.deletedAt; });
        pushEntry({
            label: '清空回收站',
            undo: function () { state.doc.tasks = schema.clone(before) || []; },
            redo: function () {
                state.doc.tasks = state.doc.tasks.filter(function (task) { return !task.deletedAt; });
            }
        });
        notify('task:clear-trash', { count: trashed.length });
        scheduleSave();
        return trashed.length;
    }

    function reorderTask(dragId, targetId, place) {
        var dragTask = findTask(dragId);
        var targetTask = findTask(targetId);
        if (!dragTask || !targetTask || dragId === targetId) return false;
        var beforeState = {};
        state.doc.tasks.forEach(function (task) {
            beforeState[task.id] = { order: task.order, listId: task.listId };
        });
        var listId = targetTask.listId;
        dragTask.listId = listId;
        var siblings = state.doc.tasks.filter(function (task) {
            return task.listId === listId && task.id !== dragId && !task.deletedAt;
        }).sort(compareManual);
        var targetIdx = siblings.indexOf(targetTask);
        if (targetIdx === -1) targetIdx = siblings.length - 1;
        var insertAt = place === 'after' ? targetIdx + 1 : targetIdx;
        siblings.splice(insertAt, 0, dragTask);
        siblings.forEach(function (task, i) { task.order = i * 1024; });
        dragTask.updatedAt = Date.now();

        var afterState = {};
        state.doc.tasks.forEach(function (task) {
            afterState[task.id] = { order: task.order, listId: task.listId };
        });
        pushEntry({
            label: '调整顺序',
            undo: function () { applyOrderState(beforeState); },
            redo: function () { applyOrderState(afterState); }
        });
        notify('task:reorder', { id: dragId, target: targetId });
        scheduleSave();
        return true;
    }

    function applyOrderState(map) {
        state.doc.tasks.forEach(function (task) {
            var item = map[task.id];
            if (!item) return;
            task.order = item.order;
            task.listId = item.listId;
        });
    }

    /* ------------------------------------------------------------------ *
     * 清单操作（低频，走快照式撤销）
     * ------------------------------------------------------------------ */
    function snapshotEntry(label) {
        var before = schema.clone(state.doc);
        return {
            label: label,
            undo: function () { if (before) replaceDoc(schema.clone(before)); },
            redo: function () { /* 由调用方在完成后写入 */ }
        };
    }

    function finalizeSnapshot(entry) {
        var after = schema.clone(state.doc);
        entry.redo = function () { if (after) replaceDoc(schema.clone(after)); };
        pushEntry(entry);
    }

    function replaceDoc(doc) {
        if (!doc) return;
        state.doc = doc;
        ensureUi();
        notify('replace');
        scheduleSave();
    }

    function addList(name) {
        var text = typeof name === 'string' ? name.trim().slice(0, 60) : '';
        if (!text) return null;
        if (state.doc.lists.length >= schema.LIMITS.lists) return null;
        var entry = snapshotEntry('新建清单');
        var now = Date.now();
        var count = state.doc.lists.length;
        var list = {
            id: schema.newId('list'),
            name: text,
            color: LIST_COLORS[count % LIST_COLORS.length],
            order: count,
            archived: false,
            createdAt: now,
            updatedAt: now
        };
        state.doc.lists.push(list);
        state.ui.listId = list.id;
        state.ui.view = 'all';
        finalizeSnapshot(entry);
        notify('list:add', { id: list.id });
        scheduleSave();
        return list;
    }

    function renameList(id, name) {
        var list = findList(id);
        var text = typeof name === 'string' ? name.trim().slice(0, 60) : '';
        if (!list || !text) return false;
        var entry = snapshotEntry('重命名清单');
        list.name = text;
        list.updatedAt = Date.now();
        finalizeSnapshot(entry);
        notify('list:rename', { id: id });
        scheduleSave();
        return true;
    }

    function deleteList(id) {
        if (id === 'list_default') return false;
        var list = findList(id);
        if (!list) return false;
        var entry = snapshotEntry('删除清单');
        var fallback = 'list_default';
        state.doc.tasks.forEach(function (task) {
            if (task.listId === id) {
                task.listId = fallback;
                task.updatedAt = Date.now();
            }
        });
        state.doc.lists = state.doc.lists.filter(function (item) { return item.id !== id; });
        if (state.ui.listId === id) state.ui.listId = null;
        if (state.doc.settings.defaultListId === id) state.doc.settings.defaultListId = fallback;
        state.doc.tasks.forEach(function (task) { task.listId = findList(task.listId) ? task.listId : fallback; });
        finalizeSnapshot(entry);
        notify('list:delete', { id: id });
        scheduleSave();
        return true;
    }

    function moveTaskToList(id, listId) {
        if (!findList(listId)) return false;
        var task = findTask(id);
        if (!task) return false;
        return updateTask(id, { listId: listId, order: nextOrder(listId) }, { label: '移动到清单' });
    }

    function updateSettings(patch) {
        if (!patch) return;
        var settings = state.doc.settings;
        if (patch.defaultListId != null && findList(patch.defaultListId)) settings.defaultListId = patch.defaultListId;
        if (patch.view != null && schema.VIEWS.indexOf(patch.view) > -1) settings.view = patch.view;
        if (patch.sort != null && schema.SORTS.indexOf(patch.sort) > -1) settings.sort = patch.sort;
        if (typeof patch.showCompleted === 'boolean') settings.showCompleted = patch.showCompleted;
        if (patch.reminderLeadMinutes != null) {
            settings.reminderLeadMinutes = util.clamp(patch.reminderLeadMinutes, 0, 43200);
        }
        if (typeof patch.compact === 'boolean') settings.compact = patch.compact;
        if (patch.viewMode === 'list' || patch.viewMode === 'timeline') settings.viewMode = patch.viewMode;
        notify('settings', patch);
        scheduleSave();
    }

    /* ------------------------------------------------------------------ *
     * 导入 / 导出 / 备份
     * ------------------------------------------------------------------ */
    function writeBackup() {
        // 破坏性操作前除了写 localStorage 备份，再打一份环形快照（IDB 优先）
        maybeSnapshot(true);
        try {
            var result = storage.setRaw(BACKUP_KEY, JSON.stringify(state.doc));
            return !!(result && result.ok);
        } catch (err) {
            return false;
        }
    }

    function hasBackup() { return storage.getRaw(BACKUP_KEY) != null; }

    function exportData() { return schema.exportDoc(state.doc); }

    function importDoc(incoming, mode) {
        var backupOk = writeBackup();
        var before = schema.clone(state.doc);
        var result;
        if (mode === 'replace') {
            var normalized = schema.normalizeDoc(incoming).doc;
            var doc = schema.normalizeDoc({
                schemaVersion: 2,
                revision: util.isFiniteNum(state.doc.revision) ? state.doc.revision : 0,
                updatedAt: Date.now(),
                lists: normalized.lists,
                tasks: normalized.tasks,
                settings: state.doc.settings,
                meta: {
                    app: 'nTools',
                    appVersion: schema.appVersion,
                    migratedFrom: normalized.meta.migratedFrom,
                    migratedAt: normalized.meta.migratedAt,
                    quarantine: normalized.meta.quarantine
                }
            }).doc;
            result = { added: doc.tasks.length, updated: 0, kept: 0 };
            state.doc = doc;
        } else {
            var merged = schema.mergeDocs(state.doc, incoming);
            state.doc = merged.doc;
            result = merged.stats;
        }
        var entry = {
            label: mode === 'replace' ? '替换导入' : '合并导入',
            undo: function () { if (before) replaceDoc(schema.clone(before)); }
        };
        var after = schema.clone(state.doc);
        entry.redo = function () { if (after) replaceDoc(schema.clone(after)); };
        pushEntry(entry);
        state.ui.selectedId = null;
        state.ui.editingId = null;
        state.ui.view = 'all';
        state.ui.listId = null;
        state.ui.search = '';
        ensureUi();
        notify('import', { mode: mode, stats: result });
        saveNow();
        return { stats: result, backup: backupOk, doc: state.doc };
    }

    function restoreBackup() {
        var raw = storage.getRaw(BACKUP_KEY);
        if (raw == null) return { ok: false, reason: 'none' };
        var parsed = util.parseJSON(raw, undefined);
        if (parsed === undefined) return { ok: false, reason: 'corrupt' };        var doc;
        if (Array.isArray(parsed) || (util.isPlainObject(parsed) && Array.isArray(parsed.data) && !Array.isArray(parsed.tasks))) {
            doc = schema.migrateV1(parsed).doc;
        } else if (util.isPlainObject(parsed) && (Array.isArray(parsed.tasks) || parsed.schemaVersion === 2)) {
            doc = schema.normalizeDoc(parsed).doc;
        } else {
            return { ok: false, reason: 'format' };
        }
        var before = schema.clone(state.doc);
        maybeSnapshot(true);          // 覆盖前先留一份当前状态
        state.doc = doc;
        var entry = {
            label: '恢复备份',
            undo: function () { if (before) replaceDoc(schema.clone(before)); }
        };
        var after = schema.clone(state.doc);
        entry.redo = function () { if (after) replaceDoc(schema.clone(after)); };
        pushEntry(entry);
        ensureUi();
        notify('restore-backup', { tasks: doc.tasks.length });
        saveNow();
        return { ok: true, tasks: doc.tasks.length };
    }

    function clearAllTasks() {
        var backupOk = writeBackup();
        var before = schema.clone(state.doc);
        state.doc.tasks = [];
        state.ui.selectedId = null;
        state.ui.editingId = null;
        state.ui.drawerOpen = false;
        state.ui.search = '';
        var entry = {
            label: '清空全部任务',
            undo: function () { if (before) replaceDoc(schema.clone(before)); }
        };
        var after = schema.clone(state.doc);
        entry.redo = function () { if (after) replaceDoc(schema.clone(after)); };
        pushEntry(entry);
        notify('clear-all', {});
        saveNow();
        return { backup: backupOk };
    }

    function resetDocument() {
        writeBackup();
        var before = schema.clone(state.doc);
        state.doc = schema.emptyDoc();
        var entry = {
            label: '重置数据',
            undo: function () { if (before) replaceDoc(schema.clone(before)); }
        };
        var after = schema.clone(state.doc);
        entry.redo = function () { if (after) replaceDoc(schema.clone(after)); };
        pushEntry(entry);
        ensureUi();
        notify('reset', {});
        saveNow();
    }

    /* ------------------------------------------------------------------ *
     * 汇总
     * ------------------------------------------------------------------ */
    function storageState() {
        return {
            available: !!storage.available,
            memoryMode: typeof storage.memoryMode === 'function' ? storage.memoryMode() : !storage.available,
            key: KEY,
            maxBytes: storage.maxBytes
        };
    }

    NC.store = NC.store || {};
    NC.store.todo = {
        KEY: KEY,
        BACKUP_KEY: BACKUP_KEY,
        LEASE_KEY: LEASE_KEY,
        V1_KEY: V1_KEY,
        init: init,
        subscribe: subscribe,
        getDoc: getDoc,
        getUi: getUi,
        getTask: getTask,
        counts: counts,
        refreshRecurringDue: refreshRecurringDue,
        selectVisible: selectVisible,
        setView: setView,
        setListFilter: setListFilter,
        setSort: setSort,
        setSearch: setSearch,
        toggleShowCompleted: toggleShowCompleted,
        selectTask: selectTask,
        clearSelection: clearSelection,
        openDrawer: openDrawer,
        closeDrawer: closeDrawer,
        startEdit: startEdit,
        stopEdit: stopEdit,
        addTask: addTask,
        updateTask: updateTask,
        toggleTask: toggleTask,
        togglePin: togglePin,
        deleteTask: deleteTask,
        restoreTask: restoreTask,
        purgeTask: purgeTask,
        clearTrash: clearTrash,
        reorderTask: reorderTask,
        addList: addList,
        renameList: renameList,
        deleteList: deleteList,
        moveTaskToList: moveTaskToList,
        updateSettings: updateSettings,
        exportData: exportData,
        importDoc: importDoc,
        restoreBackup: restoreBackup,
        hasBackup: hasBackup,
        clearAllTasks: clearAllTasks,
        resetDocument: resetDocument,
        undo: undo,
        redo: redo,
        canUndo: canUndo,
        canRedo: canRedo,
        undoLabel: undoLabel,
        redoLabel: redoLabel,
        flush: flush,
        saveNow: saveNow,
        storageState: storageState,
        /* 数据韧性 */
        isReadOnly: function () { return !!state.readOnly; },
        saveState: saveState,
        takeover: takeover,
        acceptTrimmed: acceptTrimmed,
        originalRaw: originalRaw,
        listSnapshots: listSnapshots,
        readSnapshot: readSnapshot,
        restoreSnapshot: restoreSnapshot,
        LIST_COLORS: LIST_COLORS
    };
})(window);
