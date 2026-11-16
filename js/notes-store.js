/**
 * notes-store.js — 笔记状态层（CRUD / 租约 / 防抖落盘 / 撤销 / 快照 / 索引联动）
 * 经典脚本，依赖 core.js、storage.js、durability.js、schema-notes.js、notes-index.js、notes-db.js。
 * 挂载：NC.store.notes
 *
 * 边界（与 todo-store 一致）：不碰 DOM，只改内存态与存储，通过 subscribe/emit 通知视图。
 *
 * 关键约定：
 *   - 正文与标题是唯一真源；index 是派生，任何一步都能 build 重建；
 *   - 每篇写入后读回比对 revision（写后校验），失败保持 dirty 并退避重试；
 *   - 单写者租约：第二个窗口只读镜像，3 秒轮询复核（持有者被强杀能自动恢复）；
 *   - 破坏性操作（批量导入/清空回收站/重置）先打整库快照。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var events = NC.events;

    var LEASE_KEY = 'ntools.notes.lease';
    var SNAPSHOT_PREFIX = 'notes';
    var SAVE_DELAY = 300;
    var RETRY_MIN = 800;
    var RETRY_MAX = 15000;
    var MAX_HISTORY = 20;
    var TRASH_TTL = 30 * 24 * 60 * 60 * 1000;
    var SEARCH_LIMIT = 40;

    var state = {
        ready: false,
        loadError: null,
        mode: 'idb',
        notes: new Map(),        // id -> note
        folders: new Map(),      // id -> folder
        activeId: null,
        index: null,
        readOnly: false,
        readOnlyReason: null,
        dirty: Object.create(null),
        saveError: false,
        lastSavedAt: 0,
        saveCount: 0,
        retryDelay: 0,
        collapsed: Object.create(null)
    };

    var listeners = [];
    var history = [];
    var redoStack = [];
    var saveTimer = null;
    var retryTimer = null;
    var leaseTimer = null;
    var initPromise = null;
    var warnedSave = false;

    function schema() { return NC.schema && NC.schema.notes; }
    function indexer() { return NC.notesIndex; }
    function db() { return NC.notesDb; }
    function durability() { return NC.durability; }

    /* ------------------------------------------------------------------ *
     * 通知
     * ------------------------------------------------------------------ */
    function summaries() {
        var list = [];
        state.notes.forEach(function (note) { list.push(note); });
        list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        return list.map(function (note) {
            return {
                id: note.id,
                title: note.title,
                folderId: note.folderId,
                updatedAt: note.updatedAt,
                createdAt: note.createdAt,
                starred: note.starred === true,
                deletedAt: note.deletedAt || null,
                chars: (note.content || '').length
            };
        });
    }

    function folderList() {
        var list = [];
        state.folders.forEach(function (folder) { list.push(folder); });
        list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
        return list;
    }

    function notify(reason, extra) {
        var payload = {
            reason: reason,
            notes: summaries(),
            folders: folderList(),
            activeId: state.activeId,
            mode: state.mode,
            readOnly: state.readOnly
        };
        if (extra) Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
        listeners.slice().forEach(function (fn) {
            try {
                fn(payload);
            } catch (err) {
                /* 视图异常不影响状态层，但必须留下痕迹，否则排查时一片空白 */
                if (global.console && global.console.warn) {
                    global.console.warn('[notes] subscriber failed:', err && err.message ? err.message : err);
                }
            }
        });
        events.emit('notes:changed', payload);
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var i = listeners.indexOf(fn);
            if (i > -1) listeners.splice(i, 1);
        };
    }

    /* ------------------------------------------------------------------ *
     * 租约（单写者）
     * ------------------------------------------------------------------ */
    function claimLease(quiet) {
        var d = durability();
        if (!d || !d.lease) return true;
        if (d.lease.claim(LEASE_KEY)) {
            stopLeaseProbe();
            if (state.readOnly) {
                state.readOnly = false;
                state.readOnlyReason = null;
                notify('read-write');
            }
            return true;
        }
        if (!quiet) enterReadOnly('other-window');
        return false;
    }

    function enterReadOnly(reason) {
        if (state.readOnly && state.readOnlyReason === reason) return;
        state.readOnly = true;
        state.readOnlyReason = reason;
        if (reason === 'other-window') startLeaseProbe();
        notify('read-only', { message: readOnlyMessage(reason) });
        events.emit('notes:readonly', { reason: reason, message: readOnlyMessage(reason) });
    }

    function readOnlyMessage(reason) {
        if (reason === 'other-window') return '另一个窗口正在编辑笔记，本窗口为只读镜像';
        if (reason === 'future-version') return '笔记数据来自更新版本，已进入只读模式';
        if (reason === 'load-trimmed') return '加载时检测到数据被裁剪，已进入只读模式';
        return '笔记库已进入只读模式';
    }

    function startLeaseProbe() {
        stopLeaseProbe();
        if (!global.setInterval) return;
        leaseTimer = global.setInterval(function () {
            if (!state.readOnly || state.readOnlyReason !== 'other-window') { stopLeaseProbe(); return; }
            var d = durability();
            if (!d || !d.lease) return;
            if (!d.lease.isOwner(LEASE_KEY)) return;
            state.readOnly = false;
            state.readOnlyReason = null;
            stopLeaseProbe();
            notify('read-write');
            flush();
        }, 3000);
    }

    function stopLeaseProbe() {
        if (!leaseTimer) return;
        global.clearInterval(leaseTimer);
        leaseTimer = null;
    }

    /** 用户在只读镜像里点「接管编辑」 */
    function takeover() {
        var d = durability();
        if (d && d.lease && !d.lease.steal(LEASE_KEY)) return false;
        state.readOnly = false;
        state.readOnlyReason = null;
        stopLeaseProbe();
        notify('read-write');
        if (Object.keys(state.dirty).length) flush();
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 落盘
     * ------------------------------------------------------------------ */
    function scheduleSave() {
        if (state.readOnly) return;
        if (saveTimer) global.clearTimeout(saveTimer);
        saveTimer = global.setTimeout(function () {
            saveTimer = null;
            flush();
        }, SAVE_DELAY);
    }

    function clearRetry() {
        if (!retryTimer) return;
        global.clearTimeout(retryTimer);
        retryTimer = null;
    }

    function scheduleRetry() {
        if (retryTimer || state.readOnly) return;
        state.retryDelay = state.retryDelay
            ? Math.min(Math.round(state.retryDelay * 2), RETRY_MAX)
            : RETRY_MIN;
        retryTimer = global.setTimeout(function () {
            retryTimer = null;
            if (!state.readOnly) flush();
        }, state.retryDelay);
    }

    function saveState() {
        return {
            ok: !state.saveError,
            readOnly: state.readOnly,
            reason: state.readOnlyReason,
            message: state.readOnly ? readOnlyMessage(state.readOnlyReason) : '',
            mode: state.mode,
            pending: Object.keys(state.dirty).length,
            saveCount: state.saveCount,
            lastSavedAt: state.lastSavedAt,
            retrying: !!retryTimer
        };
    }

    function flush() {
        if (state.readOnly) return Promise.resolve(false);
        if (!state.ready) return Promise.resolve(false);
        var ids = Object.keys(state.dirty);
        if (!ids.length) return Promise.resolve(true);
        if (!claimLease(true)) { enterReadOnly('other-window'); return Promise.resolve(false); }

        var notes = ids.map(function (id) { return state.notes.get(id); }).filter(Boolean);
        ids.forEach(function (id) { delete state.dirty[id]; });

        return db().putNotes(notes).then(function () {
            /* 写后校验：逐篇读回比对 revision */
            return Promise.all(notes.map(function (note) {
                return db().getNote(note.id).then(function (saved) {
                    return !!saved && saved.revision === note.revision;
                });
            }));
        }).then(function (checks) {
            var ok = checks.every(function (item) { return item; });
            if (!ok) throw new Error('写入校验失败');
            state.saveError = false;
            state.retryDelay = 0;
            state.saveCount += 1;
            state.lastSavedAt = Date.now();
            clearRetry();
            warnedSave = false;
            events.emit('notes:savestate', saveState());
            return true;
        }).catch(function (err) {
            notes.forEach(function (note) { state.dirty[note.id] = 1; });
            state.saveError = true;
            scheduleRetry();
            if (!warnedSave) {
                warnedSave = true;
                events.emit('notes:error', {
                    code: 'save-failed',
                    message: '笔记保存失败，修改暂存在内存中：' + (err && err.message ? err.message : err)
                });
            }
            events.emit('notes:savestate', saveState());
            return false;
        });
    }

    /* ------------------------------------------------------------------ *
     * 撤销
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
            return true;
        } catch (err) {
            return false;
        }
    }

    function undo() {
        if (!history.length) return null;
        var entry = history.pop();
        if (!applyEntry(entry, 'undo')) return null;
        redoStack.push(entry);
        notify('undo', { label: entry.label });
        scheduleSave();
        return entry.label || '操作';
    }

    function redo() {
        if (!redoStack.length) return null;
        var entry = redoStack.pop();
        if (!applyEntry(entry, 'redo')) return null;
        history.push(entry);
        notify('redo', { label: entry.label });
        scheduleSave();
        return entry.label || '操作';
    }

    /* ------------------------------------------------------------------ *
     * 索引
     * ------------------------------------------------------------------ */
    function rebuildIndex() {
        var list = [];
        state.notes.forEach(function (note) { list.push(note); });
        state.index = indexer().build(list);
    }

    function touchIndex(note, structural) {
        if (!state.index) return;
        indexer().addNote(state.index, note);
        if (structural) indexer().rebuildLinks(state.index);
    }

    /* ------------------------------------------------------------------ *
     * CRUD
     * ------------------------------------------------------------------ */
    function usedTitles(excludeId) {
        var used = new Set();
        state.notes.forEach(function (note, id) {
            if (excludeId && id === excludeId) return;
            used.add((note.title || '').toLowerCase());
        });
        return used;
    }

    function touch(note, reason, structural) {
        note.updatedAt = Date.now();
        note.revision = (note.revision || 0) + 1;
        state.notes.set(note.id, note);
        state.dirty[note.id] = 1;
        touchIndex(note, structural);
        notify(reason || 'note:update', { id: note.id });
        scheduleSave();
        claimLease(true);
        return note;
    }

    function getNote(id) { return state.notes.get(id) || null; }
    function getActiveNote() { return state.notes.get(state.activeId) || null; }

    function setActive(id) {
        if (id && !state.notes.has(id)) return false;
        state.activeId = id || null;
        db().setMeta('activeNoteId', state.activeId).catch(function () { /* ignore */ });
        notify('active', { id: state.activeId });
        return true;
    }

    function createNote(options) {
        var opts = options || {};
        if (state.readOnly) return null;
        var s = schema();
        var title = s.uniqueTitle(opts.title || '未命名笔记', usedTitles());
        var now = Date.now();
        var note = {
            id: s.newId('n'),
            title: title,
            content: typeof opts.content === 'string' ? opts.content : '',
            folderId: opts.folderId || null,
            createdAt: now,
            updatedAt: now,
            revision: 0,
            starred: false,
            deletedAt: null
        };
        state.notes.set(note.id, note);
        state.dirty[note.id] = 1;
        state.activeId = note.id;
        touchIndex(note, true);
        notify('note:create', { id: note.id });
        scheduleSave();
        claimLease(true);
        return note;
    }

    function updateNote(id, patch) {
        var note = state.notes.get(id);
        if (!note || state.readOnly) return null;
        var s = schema();
        var next = patch || {};
        var structural = false;
        if (typeof next.content === 'string' && next.content !== note.content) {
            note.content = next.content;
            structural = true;
        }
        if (typeof next.title === 'string') {
            var title = s.uniqueTitle(s.normalizeTitle(next.title) || '未命名笔记', usedTitles(id));
            if (title !== note.title) {
                note.title = title;
                structural = true;
            }
        }
        if (Object.prototype.hasOwnProperty.call(next, 'folderId')) {
            note.folderId = next.folderId || null;
        }
        if (typeof next.starred === 'boolean') note.starred = next.starred;
        return touch(note, 'note:update', structural);
    }

    /** 重命名并同步更新所有指向它的 [[旧标题]]；返回更新了几处引用 */
    function renameNote(id, title, options) {
        var note = state.notes.get(id);
        if (!note || state.readOnly) return { ok: false, relinked: 0 };
        var opts = options || {};
        var s = schema();
        var before = note.title;
        var target = s.uniqueTitle(s.normalizeTitle(title) || '未命名笔记', usedTitles(id));
        if (target === before) return { ok: true, relinked: 0, title: target };

        var relinked = 0;
        if (opts.relink !== false) {
            state.notes.forEach(function (other) {
                if (other.id === id) return;
                var content = other.content || '';
                if (content.indexOf('[[' + before) === -1) return;
                var updated = content.replace(/\[\[\s*([^[\]|#\n]+?)\s*(\|[^[\]\n]*)?(\#[^[\]\n]*)?\]\]/g, function (raw, name, alias, anchor) {
                    var plain = String(name).trim();
                    if (plain.toLowerCase() !== before.toLowerCase()) return raw;
                    relinked += 1;
                    return '[[' + target + (alias || '') + (anchor || '') + ']]';
                });
                if (updated !== content) {
                    other.content = updated;
                    other.updatedAt = Date.now();
                    other.revision = (other.revision || 0) + 1;
                    state.dirty[other.id] = 1;
                }
            });
        }
        note.title = target;
        touch(note, 'note:rename', true);
        if (relinked) {
            rebuildIndex();
            notify('note:relink', { id: id, relinked: relinked });
        }
        return { ok: true, relinked: relinked, title: target };
    }

    function deleteNote(id) {
        var note = state.notes.get(id);
        if (!note || state.readOnly) return false;
        var before = note.deletedAt;
        note.deletedAt = Date.now();
        touch(note, 'note:delete', false);
        pushEntry({
            label: '删除笔记「' + note.title + '」',
            undo: function () {
                note.deletedAt = before;
                touch(note, 'note:restore', false);
            },
            redo: function () {
                note.deletedAt = Date.now();
                touch(note, 'note:delete', false);
            }
        });
        if (state.activeId === id) setActive(null);
        return true;
    }

    function restoreNote(id) {
        var note = state.notes.get(id);
        if (!note || state.readOnly) return false;
        note.deletedAt = null;
        touch(note, 'note:restore', false);
        return true;
    }

    function purgeNote(id) {
        var note = state.notes.get(id);
        if (!note || state.readOnly) return false;
        maybeSnapshot(true);
        state.notes.delete(id);
        delete state.dirty[id];
        if (state.activeId === id) state.activeId = null;
        indexer().removeNote(state.index, id);
        db().deleteNote(id).catch(function () { /* ignore */ });
        notify('note:purge', { id: id });
        db().setMeta('activeNoteId', state.activeId).catch(function () { /* ignore */ });
        return true;
    }

    function clearTrash() {
        if (state.readOnly) return 0;
        var ids = [];
        state.notes.forEach(function (note, id) { if (note.deletedAt) ids.push(id); });
        if (!ids.length) return 0;
        maybeSnapshot(true);
        ids.forEach(function (id) {
            state.notes.delete(id);
            delete state.dirty[id];
            db().deleteNote(id).catch(function () { /* ignore */ });
        });
        rebuildIndex();
        notify('trash:clear', { removed: ids.length });
        return ids.length;
    }

    /* ------------------------------------------------------------------ *
     * 文件夹
     * ------------------------------------------------------------------ */
    function createFolder(name) {
        if (state.readOnly) return null;
        var s = schema();
        var folder = {
            id: s.newId('f'),
            name: s.normalizeTitle(name) || '未命名文件夹',
            order: state.folders.size * 1024,
            createdAt: Date.now()
        };
        state.folders.set(folder.id, folder);
        db().putFolder(folder).catch(function () { /* ignore */ });
        notify('folder:create', { id: folder.id });
        return folder;
    }

    function renameFolder(id, name) {
        var folder = state.folders.get(id);
        if (!folder || state.readOnly) return false;
        folder.name = schema().normalizeTitle(name) || folder.name;
        db().putFolder(folder).catch(function () { /* ignore */ });
        notify('folder:rename', { id: id });
        return true;
    }

    function deleteFolder(id) {
        var folder = state.folders.get(id);
        if (!folder || state.readOnly) return false;
        state.folders.delete(id);
        state.notes.forEach(function (note) {
            if (note.folderId === id) note.folderId = null;
        });
        db().deleteFolder(id).catch(function () { /* ignore */ });
        notify('folder:delete', { id: id });
        return true;
    }

    function moveNote(id, folderId) {
        var note = state.notes.get(id);
        if (!note || state.readOnly) return false;
        var before = note.folderId;
        note.folderId = folderId || null;
        touch(note, 'note:move', false);
        pushEntry({
            label: '移动笔记',
            undo: function () { note.folderId = before; touch(note, 'note:move', false); },
            redo: function () { note.folderId = folderId || null; touch(note, 'note:move', false); }
        });
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 查询（转发给索引）
     * ------------------------------------------------------------------ */
    function search(query) { return state.index ? indexer().search(state.index, query, { limit: SEARCH_LIMIT }) : []; }
    function quickSwitch(query) { return state.index ? indexer().quickSwitch(state.index, query, { limit: 20 }) : []; }
    function backlinks(id) { return state.index ? indexer().backlinks(state.index, id) : []; }
    function outlinks(id) { return state.index ? indexer().outlinks(state.index, id) : []; }
    function tags() { return state.index ? indexer().tagList(state.index) : []; }
    function brokenLinks() { return state.index ? indexer().brokenLinks(state.index) : []; }
    function unresolved(id) { return state.index ? indexer().unresolvedTitles(state.index, id) : []; }
    function headings(id) {
        return (state.index && state.index.headings.get(id)) || [];
    }
    function resolveTitle(title) { return state.index ? indexer().resolveTitle(state.index, title) : null; }

    /* ------------------------------------------------------------------ *
     * 快照 / 导入导出
     * ------------------------------------------------------------------ */
    function maybeSnapshot(force) {
        var d = durability();
        var s = schema();
        if (!d || !d.snapshot || !s) return;
        d.snapshot.configure({ prefix: SNAPSHOT_PREFIX, slots: 3, namespace: 'notes' });
        d.snapshot.push(SNAPSHOT_PREFIX, s.exportVault(exportVault()), {
            notes: state.notes.size,
            folders: state.folders.size
        });
        if (!force) return;
    }

    function exportVault() {
        return {
            notes: Array.from(state.notes.values()),
            folders: folderList()
        };
    }

    function exportBundle() {
        var s = schema();
        return s.exportVault(s.normalizeVault(exportVault()).doc);
    }

    /**
     * 导入整库。
     * @param {string|object} raw
     * @param {{mode:'replace'|'merge'}} [options]
     */
    function importVault(raw, options) {
        var opts = options || {};
        var s = schema();
        var parsed = s.parseImport(raw);
        if (!parsed.doc) {
            return Promise.resolve({ ok: false, reason: 'format', issues: parsed.issues || [] });
        }
        if (state.readOnly) return Promise.resolve({ ok: false, reason: 'read-only' });
        maybeSnapshot(true);

        var incoming = parsed.doc;
        var added = 0;
        var updated = 0;
        if (opts.mode === 'merge') {
            incoming.folders.forEach(function (folder) {
                if (!state.folders.has(folder.id)) state.folders.set(folder.id, folder);
            });
            incoming.notes.forEach(function (note) {
                var exist = state.notes.get(note.id);
                if (!exist) {
                    state.notes.set(note.id, note);
                    state.dirty[note.id] = 1;
                    added += 1;
                } else if ((note.updatedAt || 0) > (exist.updatedAt || 0)) {
                    state.notes.set(note.id, note);
                    state.dirty[note.id] = 1;
                    updated += 1;
                }
            });
        } else {
            state.notes = new Map();
            state.folders = new Map();
            state.dirty = Object.create(null);
            incoming.notes.forEach(function (note) {
                state.notes.set(note.id, note);
                state.dirty[note.id] = 1;
                added += 1;
            });
            incoming.folders.forEach(function (folder) { state.folders.set(folder.id, folder); });
            state.activeId = null;
        }
        rebuildIndex();
        notify('vault:import', { added: added, updated: updated });
        return flush().then(function (ok) {
            return { ok: ok, added: added, updated: updated, issues: parsed.issues || [] };
        });
    }

    function resetAll() {
        if (state.readOnly) return Promise.resolve(false);
        maybeSnapshot(true);
        return db().clearAll().then(function () {
            state.notes = new Map();
            state.folders = new Map();
            state.dirty = Object.create(null);
            state.activeId = null;
            history = [];
            redoStack = [];
            rebuildIndex();
            notify('reset');
            return true;
        });
    }

    /* ------------------------------------------------------------------ *
     * 加载 / 迁移
     * ------------------------------------------------------------------ */
    function adoptNotes(notes, folders) {
        state.notes = new Map();
        notes.forEach(function (note) { state.notes.set(note.id, note); });
        state.folders = new Map();
        (folders || []).forEach(function (folder) { state.folders.set(folder.id, folder); });
        rebuildIndex();
    }

    function purgeStaleTrash() {
        var cutoff = Date.now() - TRASH_TTL;
        var removed = [];
        state.notes.forEach(function (note, id) {
            if (note.deletedAt && note.deletedAt < cutoff) removed.push(id);
        });
        removed.forEach(function (id) {
            state.notes.delete(id);
            delete state.dirty[id];
            db().deleteNote(id).catch(function () { /* ignore */ });
            if (state.activeId === id) state.activeId = null;
        });
        if (removed.length) {
            events.emit('notes:trash-purged', { removed: removed.length });
        }
        return removed.length;
    }

    function migrateLegacy() {
        var s = schema();
        var raw = null;
        try {
            raw = global.localStorage.getItem(s.KEYS.legacyMd);
        } catch (err) { raw = null; }
        if (!raw || !String(raw).trim()) return null;
        var note = s.migrateLegacyMarkdown(raw);
        if (!note) return null;
        note.revision = 1;
        state.notes.set(note.id, note);
        state.dirty[note.id] = 1;
        return note;
    }

    function init(options) {
        if (initPromise) return initPromise;
        var opts = options || {};
        var s = schema();
        initPromise = db().open().then(function (mode) {
            state.mode = mode;
            return Promise.all([db().getAllNotes(), db().getAllFolders(), db().getMeta('activeNoteId')]);
        }).then(function (results) {
            var rawNotes = results[0] || [];
            var folders = results[1] || [];
            var activeId = results[2] || null;

            var normalized = s.normalizeVault({ schemaVersion: 1, notes: rawNotes, folders: folders });
            var issues = normalized.issues || [];
            var destructive = s.destructiveIssues(issues);

            adoptNotes(normalized.doc.notes, normalized.doc.folders);
            state.activeId = activeId && state.notes.has(activeId) ? activeId : null;

            /* 迁移旧的单文档 Markdown：仅在库为空时做一次 */
            if (!state.notes.size) {
                var legacy = migrateLegacy();
                if (legacy) {
                    state.activeId = legacy.id;
                    rebuildIndex();   // 迁移直接改了 notes，必须重建索引
                    notify('migrate', { id: legacy.id });
                }
            }
            purgeStaleTrash();

            state.ready = true;
            state.lastSavedAt = Date.now();

            if (destructive.length) {
                enterReadOnly('load-trimmed');
            } else if (!claimLease(true)) {
                enterReadOnly('other-window');
            }

            if (Object.keys(state.dirty).length) flush();
            notify('init', { issues: issues });
            return {
                mode: state.mode,
                notes: state.notes.size,
                folders: state.folders.size,
                activeId: state.activeId,
                issues: issues,
                readOnly: state.readOnly
            };
        }).catch(function (err) {
            state.ready = true;
            state.loadError = err;
            state.mode = db().getMode ? db().getMode() : 'local';
            notify('init-error', { error: err });
            events.emit('notes:error', { code: 'load-failed', message: '笔记库加载失败：' + (err && err.message ? err.message : err) });
            return { mode: state.mode, notes: 0, folders: 0, activeId: null, error: err };
        });
        return initPromise;
    }

    function bindLifecycle() {
        if (state.lifecycleBound) return;
        state.lifecycleBound = true;
        if (!global.addEventListener) return;
        global.addEventListener('pagehide', function () { flush(); });
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) flush();
        });
    }

    NC.store = NC.store || {};
    NC.store.notes = {
        LEASE_KEY: LEASE_KEY,
        init: function (options) {
            bindLifecycle();
            return init(options);
        },
        subscribe: subscribe,
        listenerCount: function () { return listeners.length; },
        isReady: function () { return state.ready; },
        getMode: function () { return state.mode; },
        getActiveId: function () { return state.activeId; },
        getActiveNote: getActiveNote,
        getNote: getNote,
        getFolders: function () { return folderList(); },
        setActive: setActive,
        createNote: createNote,
        updateNote: updateNote,
        renameNote: renameNote,
        deleteNote: deleteNote,
        restoreNote: restoreNote,
        purgeNote: purgeNote,
        clearTrash: clearTrash,
        createFolder: createFolder,
        renameFolder: renameFolder,
        deleteFolder: deleteFolder,
        moveNote: moveNote,
        search: search,
        quickSwitch: quickSwitch,
        backlinks: backlinks,
        outlinks: outlinks,
        tags: tags,
        brokenLinks: brokenLinks,
        unresolved: unresolved,
        headings: headings,
        resolveTitle: resolveTitle,
        exportBundle: exportBundle,
        importVault: importVault,
        resetAll: resetAll,
        flush: flush,
        saveState: saveState,
        takeover: takeover,
        isReadOnly: function () { return state.readOnly; },
        undo: undo,
        redo: redo,
        canUndo: function () { return history.length > 0; },
        canRedo: function () { return redoStack.length > 0; }
    };
})(window);
