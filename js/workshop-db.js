/**
 * workshop-db.js — 创意工坊持久层（IndexedDB 主 / localStorage 降级）
 * 挂载：NC.workshopDb
 *
 * 库：ntools-workshop v1
 *   apps      keyPath id   用户保存的应用
 *   versions  keyPath id   每个应用的版本快照（环形 10）
 *   turns     keyPath id   生成对话历史（按 appId 过滤）
 *   meta      keyPath key  参数 / 排序 / 置顶
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    var DB_NAME = 'ntools-workshop';
    var DB_VERSION = 1;
    var FALLBACK_KEY = 'ntools.workshop.fallback.v1';
    var STORES = { apps: 'apps', versions: 'versions', turns: 'turns', meta: 'meta' };

    var mode = 'idb';
    var dbPromise = null;

    function openIdb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            var request;
            try { request = global.indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
            request.onupgradeneeded = function (event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains(STORES.apps)) db.createObjectStore(STORES.apps, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORES.versions)) db.createObjectStore(STORES.versions, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORES.turns)) db.createObjectStore(STORES.turns, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'key' });
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { dbPromise = null; reject(request.error || new Error('open failed')); };
            request.onblocked = function () { dbPromise = null; reject(new Error('blocked')); };
        });
        return dbPromise;
    }

    function tx(storeName, write, work) {
        return openIdb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var transaction = db.transaction(storeName, write ? 'readwrite' : 'readonly');
                var store = transaction.objectStore(storeName);
                var box = { value: null };
                try { box.value = work(store); } catch (err) { reject(err); return; }
                transaction.oncomplete = function () { resolve(box.value); };
                transaction.onerror = function () { reject(transaction.error || new Error('tx failed')); };
                transaction.onabort = function () { reject(transaction.error || new Error('tx aborted')); };
            });
        });
    }

    function getAll(storeName) {
        return tx(storeName, false, function (store) {
            var box = { value: [] };
            var request = store.getAll();
            request.onsuccess = function () { box.value = request.result || []; };
            return box;
        }).then(function (box) { return (box && box.value) || []; });
    }

    /* ------------------------------------------------------------------ *
     * localStorage 降级
     * ------------------------------------------------------------------ */
    function readFallback() {
        try {
            var parsed = JSON.parse(global.localStorage.getItem(FALLBACK_KEY) || 'null');
            if (!parsed || typeof parsed !== 'object') throw new Error('empty');
            return {
                apps: Array.isArray(parsed.apps) ? parsed.apps : [],
                versions: Array.isArray(parsed.versions) ? parsed.versions : [],
                turns: Array.isArray(parsed.turns) ? parsed.turns : [],
                meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}
            };
        } catch (err) {
            return { apps: [], versions: [], turns: [], meta: {} };
        }
    }

    function writeFallback(doc) {
        var json;
        try { json = JSON.stringify(doc); } catch (err) { return Promise.reject(err); }
        if (json.length > 2 * 1024 * 1024) return Promise.reject(new Error('降级模式容量上限 2MB'));
        try {
            global.localStorage.setItem(FALLBACK_KEY, json);
            return Promise.resolve(true);
        } catch (err) {
            return Promise.reject(err);
        }
    }

    /* ------------------------------------------------------------------ *
     * 统一接口
     * ------------------------------------------------------------------ */
    function open() {
        return openIdb().then(function () { mode = 'idb'; return 'idb'; })
            .catch(function () { mode = 'local'; return 'local'; });
    }

    function getMode() { return mode; }

    function getAllApps() {
        if (mode === 'local') return Promise.resolve(readFallback().apps);
        return getAll(STORES.apps);
    }

    function putApp(app) {
        if (mode === 'local') {
            var doc = readFallback();
            var index = -1;
            for (var i = 0; i < doc.apps.length; i += 1) if (doc.apps[i].id === app.id) { index = i; break; }
            if (index > -1) doc.apps[index] = app; else doc.apps.push(app);
            return writeFallback(doc);
        }
        return tx(STORES.apps, true, function (store) { store.put(app); });
    }

    function deleteApp(id) {
        if (mode === 'local') {
            var doc = readFallback();
            doc.apps = doc.apps.filter(function (app) { return app.id !== id; });
            doc.versions = doc.versions.filter(function (ver) { return ver.appId !== id; });
            doc.turns = doc.turns.filter(function (turn) { return turn.appId !== id; });
            return writeFallback(doc);
        }
        return tx(STORES.apps, true, function (store) { store.delete(id); }).then(function () {
            return Promise.all([
                getAll(STORES.versions).then(function (versions) {
                    var mine = versions.filter(function (ver) { return ver.appId === id; });
                    return tx(STORES.versions, true, function (store) { mine.forEach(function (ver) { store.delete(ver.id); }); });
                }),
                getAll(STORES.turns).then(function (turns) {
                    var mine = turns.filter(function (turn) { return turn.appId === id; });
                    return tx(STORES.turns, true, function (store) { mine.forEach(function (turn) { store.delete(turn.id); }); });
                })
            ]);
        }).then(function () { return true; });
    }

    function getAllVersions() {
        if (mode === 'local') return Promise.resolve(readFallback().versions);
        return getAll(STORES.versions);
    }

    function putVersion(version) {
        if (mode === 'local') {
            var doc = readFallback();
            doc.versions.push(version);
            return writeFallback(doc);
        }
        return tx(STORES.versions, true, function (store) { store.put(version); });
    }

    function deleteVersions(ids) {
        if (!ids || !ids.length) return Promise.resolve(true);
        if (mode === 'local') {
            var doc = readFallback();
            doc.versions = doc.versions.filter(function (ver) { return ids.indexOf(ver.id) === -1; });
            return writeFallback(doc);
        }
        return tx(STORES.versions, true, function (store) { ids.forEach(function (id) { store.delete(id); }); });
    }

    function getAllTurns() {
        if (mode === 'local') return Promise.resolve(readFallback().turns);
        return getAll(STORES.turns);
    }

    function putTurn(turn) {
        if (mode === 'local') {
            var doc = readFallback();
            doc.turns.push(turn);
            return writeFallback(doc);
        }
        return tx(STORES.turns, true, function (store) { store.put(turn); });
    }

    function deleteTurns(ids) {
        if (!ids || !ids.length) return Promise.resolve(true);
        if (mode === 'local') {
            var doc = readFallback();
            doc.turns = doc.turns.filter(function (turn) { return ids.indexOf(turn.id) === -1; });
            return writeFallback(doc);
        }
        return tx(STORES.turns, true, function (store) { ids.forEach(function (id) { store.delete(id); }); });
    }

    function getMeta(key) {
        if (mode === 'local') {
            var doc = readFallback();
            return Promise.resolve(doc.meta && key in doc.meta ? doc.meta[key] : null);
        }
        return tx(STORES.meta, false, function (store) {
            var box = { value: null };
            var request = store.get(key);
            request.onsuccess = function () { box.value = request.result ? request.result.value : null; };
            return box;
        }).then(function (box) { return box ? box.value : null; });
    }

    function setMeta(key, value) {
        if (mode === 'local') {
            var doc = readFallback();
            doc.meta[key] = value;
            return writeFallback(doc);
        }
        return tx(STORES.meta, true, function (store) { store.put({ key: key, value: value }); });
    }

    NC.workshopDb = {
        DB_NAME: DB_NAME,
        FALLBACK_KEY: FALLBACK_KEY,
        open: open,
        getMode: getMode,
        getAllApps: getAllApps,
        putApp: putApp,
        deleteApp: deleteApp,
        getAllVersions: getAllVersions,
        putVersion: putVersion,
        deleteVersions: deleteVersions,
        getAllTurns: getAllTurns,
        putTurn: putTurn,
        deleteTurns: deleteTurns,
        getMeta: getMeta,
        setMeta: setMeta
    };
})(window);
