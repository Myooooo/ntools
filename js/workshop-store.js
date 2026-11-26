/**
 * workshop-store.js — 创意工坊状态层（应用 / 版本 / 参数 / 对话）
 * 挂载：NC.store.workshop
 *
 * 边界：不碰 DOM；所有读写通过 workshop-db，变更后 notify 视图层。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var state = {
        ready: false,
        mode: 'idb',
        apps: new Map(),
        versions: new Map(),   // appId -> [version]
        turns: new Map(),      // appId -> [turn]
        meta: { order: {}, pinned: {} },
        params: null,
        error: null
    };

    var listeners = [];
    var initPromise = null;

    function schema() { return NC.schema && NC.schema.workshop; }
    function db() { return NC.workshopDb; }

    function emit(reason, extra) {
        var payload = { reason: reason, mode: state.mode, count: state.apps.size };
        if (extra) Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
        listeners.slice().forEach(function (fn) {
            try { fn(payload); } catch (err) {
                if (global.console && global.console.warn) global.console.warn('[workshop] subscriber failed:', err && err.message);
            }
        });
        try { if (NC.events && NC.events.emit) NC.events.emit(NC.eventNames.workshopChanged, payload); } catch (err) { /* ignore */ }
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var i = listeners.indexOf(fn);
            if (i > -1) listeners.splice(i, 1);
        };
    }

    function toList(map, key) {
        var out = [];
        map.forEach(function (items) { out.push.apply(out, items); });
        void key;
        return out;
    }

    function groupBy(list, key) {
        var map = new Map();
        (list || []).forEach(function (item) {
            if (!item || !item[key]) return;
            var bucket = map.get(item[key]);
            if (!bucket) { bucket = []; map.set(item[key], bucket); }
            bucket.push(item);
        });
        return map;
    }

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function init() {
        if (initPromise) return initPromise;
        var s = schema();
        initPromise = db().open().then(function (mode) {
            state.mode = mode;
            return Promise.all([
                db().getAllApps(),
                db().getAllVersions(),
                db().getAllTurns(),
                db().getMeta('view'),
                db().getMeta('params')
            ]);
        }).then(function (results) {
            state.apps = new Map();
            (results[0] || []).forEach(function (app) {
                var normalized = s.normalizeApp(app);
                state.apps.set(normalized.id, normalized);
            });
            state.versions = groupBy(results[1], 'appId');
            state.versions.forEach(function (list) {
                list.sort(function (a, b) { return b.at - a.at; });
            });
            state.turns = groupBy(results[2], 'appId');
            state.turns.forEach(function (list) {
                list.sort(function (a, b) { return a.at - b.at; });
            });
            var view = results[3] || {};
            state.meta = {
                order: view && typeof view.order === 'object' && view.order ? view.order : {},
                pinned: view && typeof view.pinned === 'object' && view.pinned ? view.pinned : {}
            };
            state.params = s.normalizeParams(results[4] || {});
            state.ready = true;
            emit('init');
            return { mode: state.mode, apps: state.apps.size };
        }).catch(function (err) {
            state.error = err;
            state.ready = true;
            state.params = schema().defaultParams();
            emit('init-error', { error: err });
            return { mode: state.mode, apps: 0, error: err };
        });
        return initPromise;
    }

    /* ------------------------------------------------------------------ *
     * 列表 / 查询
     * ------------------------------------------------------------------ */
    function list() {
        var builtins = (NC.workshopBuiltin && NC.workshopBuiltin.ITEMS) || [];
        var apps = [];
        state.apps.forEach(function (app) { apps.push(app); });
        return schema().mergeList(builtins, apps, { order: state.meta.order, pinned: state.meta.pinned });
    }

    function getApp(id) { return state.apps.get(id) || null; }

    function getBuiltin(id) {
        return NC.workshopBuiltin && NC.workshopBuiltin.byId ? NC.workshopBuiltin.byId(id) : null;
    }

    function isBuiltin(id) {
        return !!(NC.workshopBuiltin && NC.workshopBuiltin.byId && NC.workshopBuiltin.byId(id));
    }

    /* ------------------------------------------------------------------ *
     * 应用 CRUD
     * ------------------------------------------------------------------ */
    function handlePersistError(op, err) {
        state.error = err || new Error(op || 'persist failed');
        var msg = (err && err.message) ? err.message : '数据保存失败';
        try {
            if (NC.events && NC.events.emit && NC.eventNames && NC.eventNames.workshopError) {
                NC.events.emit(NC.eventNames.workshopError, { op: op, error: err, message: msg });
            }
        } catch (e) { /* ignore */ }
    }

    function persistView() {
        return db().setMeta('view', { order: state.meta.order, pinned: state.meta.pinned })
            .catch(function (err) { handlePersistError('view', err); });
    }

    function nextAppOrder() {
        var max = 990;
        state.apps.forEach(function (app) {
            if (typeof app.order === 'number' && isFinite(app.order) && app.order > max) max = app.order;
        });
        Object.keys(state.meta.order || {}).forEach(function (id) {
            var val = state.meta.order[id];
            if (typeof val === 'number' && isFinite(val) && val > max) max = val;
        });
        return max + 10;
    }

    function createApp(input) {
        var s = schema();
        var data = input || {};
        if (state.apps.size >= s.LIMITS.apps) {
            return { ok: false, reason: 'limit', message: '最多保存 ' + s.LIMITS.apps + ' 个应用' };
        }
        var code = typeof data.code === 'string' ? data.code : '';
        if (code.length > s.LIMITS.appBytes) {
            return { ok: false, reason: 'too-big', message: '代码超过 ' + Math.round(s.LIMITS.appBytes / 1024) + 'KB 上限' };
        }
        var app = s.normalizeApp({
            id: s.newId('app'),
            title: data.title || '未命名应用',
            code: code,
            model: data.model || '',
            order: nextAppOrder()
        });
        state.apps.set(app.id, app);
        db().putApp(app).catch(function (err) { handlePersistError('createApp', err); });
        if (code) pushVersion(app.id, code, '初始版本');
        emit('app:create', { id: app.id });
        return { ok: true, app: app };
    }

    function renameApp(id, title) {
        var app = state.apps.get(id);
        if (!app) return false;
        var s = schema();
        app.title = s.normalizeTitle(title, app.title);
        app.updatedAt = Date.now();
        db().putApp(app).catch(function (err) { handlePersistError('renameApp', err); });
        emit('app:rename', { id: id });
        return true;
    }

    function updateCode(id, code, label) {
        var app = state.apps.get(id);
        if (!app) return { ok: false, reason: 'missing' };
        var s = schema();
        var next = typeof code === 'string' ? code : '';
        if (!next) return { ok: false, reason: 'empty' };
        if (next.length > s.LIMITS.appBytes) return { ok: false, reason: 'too-big' };
        app.code = next;
        app.updatedAt = Date.now();
        db().putApp(app).catch(function (err) { handlePersistError('updateCode', err); });
        return pushVersion(id, next, label || '调整');
    }

    function deleteApp(id) {
        if (!state.apps.has(id)) return false;
        state.apps.delete(id);
        state.versions.delete(id);
        state.turns.delete(id);
        delete state.meta.order[id];
        delete state.meta.pinned[id];
        persistView();
        db().deleteApp(id).catch(function (err) { handlePersistError('deleteApp', err); });
        emit('app:delete', { id: id });
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 置顶 / 排序
     * ------------------------------------------------------------------ */
    function setPinned(id, pinned) {
        if (!id) return false;
        var next = pinned === true;
        state.meta.pinned[id] = next;
        var app = state.apps.get(id);
        if (app && app.pinned !== next) {
            app.pinned = next;
            db().putApp(app).catch(function (err) { handlePersistError('setPinned', err); });
        }
        persistView();
        emit('view:pin', { id: id, pinned: next });
        return true;
    }

    function togglePinned(id) {
        return setPinned(id, !state.meta.pinned[id]);
    }

    /** 按给定 id 顺序写回 order（拖拽结束后调用一次） */
    function applyOrder(ids) {
        if (!Array.isArray(ids) || !ids.length) return false;
        state.meta.order = {};
        ids.forEach(function (id, index) {
            if (id) state.meta.order[id] = index * 10;
        });
        persistView();
        emit('view:order');
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 版本
     * ------------------------------------------------------------------ */
    function pushVersion(appId, code, label) {
        var s = schema();
        if (!appId || !code) return { ok: false, reason: 'empty' };
        var version = s.normalizeVersion({
            id: s.newId('ver'),
            appId: appId,
            code: code,
            label: label || '',
            at: Date.now()
        });
        var list = state.versions.get(appId);
        if (!list) { list = []; state.versions.set(appId, list); }
        list.unshift(version);
        while (list.length > s.LIMITS.versions) {
            var dropped = list.pop();
            db().deleteVersions([dropped.id]).catch(function (err) { handlePersistError('pruneVersions', err); });
        }
        db().putVersion(version).catch(function (err) { handlePersistError('pushVersion', err); });
        emit('version:push', { appId: appId, id: version.id });
        return { ok: true, version: version };
    }

    function listVersions(appId) {
        return (state.versions.get(appId) || []).slice();
    }

    function restoreVersion(appId, versionId) {
        var app = state.apps.get(appId);
        if (!app) return false;
        var version = (state.versions.get(appId) || []).filter(function (item) { return item.id === versionId; })[0];
        if (!version) return false;
        return updateCode(appId, version.code, '恢复版本').ok === true;
    }

    /* ------------------------------------------------------------------ *
     * 对话（多轮）
     * ------------------------------------------------------------------ */
    function addTurn(appId, role, text) {
        var s = schema();
        if (!appId || (role !== 'user' && role !== 'assistant')) return null;
        var turn = {
            id: s.newId('turn'),
            appId: appId,
            role: role,
            text: String(text == null ? '' : text).slice(0, 20000),
            at: Date.now()
        };
        var list = state.turns.get(appId);
        if (!list) { list = []; state.turns.set(appId, list); }
        list.push(turn);
        while (list.length > s.LIMITS.turns) {
            var dropped = list.shift();
            db().deleteTurns([dropped.id]).catch(function (err) { handlePersistError('pruneTurns', err); });
        }
        db().putTurn(turn).catch(function (err) { handlePersistError('addTurn', err); });
        return turn;
    }

    function listTurns(appId) {
        return (state.turns.get(appId) || []).slice();
    }

    function clearTurns(appId) {
        var list = state.turns.get(appId) || [];
        state.turns.delete(appId);
        db().deleteTurns(list.map(function (item) { return item.id; })).catch(function (err) { handlePersistError('clearTurns', err); });
    }

    /* ------------------------------------------------------------------ *
     * 参数
     * ------------------------------------------------------------------ */
    function getParams() {
        return schema().normalizeParams(state.params || {});
    }

    function setParams(patch) {
        var next = schema().normalizeParams(Object.assign({}, getParams(), patch || {}));
        state.params = next;
        db().setMeta('params', next).catch(function (err) { handlePersistError('setParams', err); });
        emit('params');
        return next;
    }

    function resetParams() {
        var keepEndpoint = getParams().endpointId || '';
        var next = schema().defaultParams();
        next.endpointId = keepEndpoint;
        return setParams(next);
    }

    /* ------------------------------------------------------------------ *
     * 统计 / 导出
     * ------------------------------------------------------------------ */
    function stats() {
        var appBytes = 0;
        state.apps.forEach(function (app) { appBytes += (app.code || '').length; });
        var versions = 0;
        var versionBytes = 0;
        state.versions.forEach(function (list) {
            versions += list.length;
            list.forEach(function (v) { versionBytes += (v.code || '').length; });
        });
        return {
            apps: state.apps.size,
            bytes: appBytes + versionBytes,
            appBytes: appBytes,
            versionBytes: versionBytes,
            versions: versions
        };
    }

    /** 从备份恢复：先写持久层再替换内存态（apps / versions / turns / 参数 / 排序） */
    function importData(data) {
        var s = schema();
        var incoming = data && typeof data === 'object' ? data : {};
        var apps = (Array.isArray(incoming.apps) ? incoming.apps : []).map(function (app) {
            return s.normalizeApp(app);
        });
        var versions = (Array.isArray(incoming.versions) ? incoming.versions : []).map(function (ver) {
            return s.normalizeVersion(ver);
        });
        var turns = (Array.isArray(incoming.turns) ? incoming.turns : []).filter(function (turn) {
            return turn && typeof turn === 'object' && turn.appId;
        });
        var view = incoming.view && typeof incoming.view === 'object' ? incoming.view : {};
        var meta = {
            order: view.order && typeof view.order === 'object' ? view.order : {},
            pinned: view.pinned && typeof view.pinned === 'object' ? view.pinned : {}
        };
        var params = s.normalizeParams(incoming.params || {});

        return db().replaceAll({
            apps: apps, versions: versions, turns: turns, view: meta, params: params
        }).then(function () {
            state.apps = new Map();
            apps.forEach(function (app) { state.apps.set(app.id, app); });
            state.versions = groupBy(versions, 'appId');
            state.versions.forEach(function (list) { list.sort(function (a, b) { return b.at - a.at; }); });
            state.turns = groupBy(turns, 'appId');
            state.turns.forEach(function (list) { list.sort(function (a, b) { return a.at - b.at; }); });
            state.meta = meta;
            state.params = params;
            emit('import');
            return { ok: true, apps: apps.length };
        }, function (err) {
            handlePersistError('importData', err);
            return { ok: false, error: err };
        });
    }

    function exportData() {
        return {
            apps: Array.from(state.apps.values()),
            versions: toList(state.versions),
            turns: toList(state.turns),
            view: { order: state.meta.order, pinned: state.meta.pinned },
            params: getParams()
        };
    }

    NC.store = NC.store || {};
    NC.store.workshop = {
        init: init,
        subscribe: subscribe,
        list: list,
        getApp: getApp,
        getBuiltin: getBuiltin,
        isBuiltin: isBuiltin,
        createApp: createApp,
        renameApp: renameApp,
        updateCode: updateCode,
        deleteApp: deleteApp,
        setPinned: setPinned,
        togglePinned: togglePinned,
        applyOrder: applyOrder,
        listVersions: listVersions,
        restoreVersion: restoreVersion,
        pushVersion: pushVersion,
        addTurn: addTurn,
        listTurns: listTurns,
        clearTurns: clearTurns,
        getParams: getParams,
        setParams: setParams,
        resetParams: resetParams,
        stats: stats,
        exportData: exportData,
        importData: importData,
        getMode: function () { return state.mode; },
        isReady: function () { return state.ready; }
    };
})(window);
