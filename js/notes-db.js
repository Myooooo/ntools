/**
 * notes-db.js — 笔记库持久层（IndexedDB 主 / localStorage 降级）
 * 经典脚本，依赖 core.js、schema-notes.js。挂载：NC.notesDb
 *
 * 两种后端暴露**完全相同的异步接口**，上层 notes-store 不需要知道自己跑在哪：
 *   idb   —— 库 `ntools-notes` v1，stores：notes / folders / files / meta
 *   local —— 单键 `ntools.notes.fallback.v1`，每次整库序列化（有篇数/体积上限）
 *
 * 约定：
 *   - 所有方法返回 Promise，失败 reject（由上层决定降级或提示）；
 *   - IndexedDB 打不开时 open() reject，并**不永久缓存失败**，下次可重试；
 *   - files 存 Blob，只在 idb 后端可用（降级时上层关闭图片粘贴）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    var DB_NAME = 'ntools-notes';
    var DB_VERSION = 1;
    var FALLBACK_KEY = 'ntools.notes.fallback.v1';

    var STORES = {
        notes: 'notes',
        folders: 'folders',
        files: 'files',
        meta: 'meta'
    };

    var mode = 'idb';          // 'idb' | 'local'
    var dbPromise = null;
    var opened = false;

    function schema() { return NC.schema && NC.schema.notes; }

    function fallbackLimits() {
        var s = schema();
        return (s && s.LIMITS) || { fallbackNotes: 200, fallbackBytes: 1.5 * 1024 * 1024 };
    }

    /* ================================================================== *
     * IndexedDB 后端
     * ================================================================== */
    function openIdb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            var request;
            try {
                request = global.indexedDB.open(DB_NAME, DB_VERSION);
            } catch (err) { reject(err); return; }
            request.onupgradeneeded = function (event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains(STORES.notes)) db.createObjectStore(STORES.notes, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORES.folders)) db.createObjectStore(STORES.folders, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORES.files)) db.createObjectStore(STORES.files, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'key' });
            };
            request.onsuccess = function () {
                var db = request.result;
                db.onversionchange = function () {
                    try { db.close(); } catch (err) { /* ignore */ }
                    dbPromise = null;
                    opened = false;
                };
                opened = true;
                resolve(db);
            };
            request.onerror = function () {
                dbPromise = null;            // 允许下次重试
                reject(request.error || new Error('IndexedDB open failed'));
            };
            request.onblocked = function () {
                dbPromise = null;
                reject(new Error('IndexedDB blocked'));
            };
        });
        return dbPromise;
    }

    function tx(storeName, writeMode, work) {
        return openIdb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var transaction = db.transaction(storeName, writeMode ? 'readwrite' : 'readonly');
                var store = transaction.objectStore(storeName);
                var result;
                try {
                    result = work(store);
                } catch (err) {
                    reject(err);
                    return;
                }
                transaction.oncomplete = function () { resolve(result); };
                transaction.onerror = function () { reject(transaction.error || new Error('transaction failed')); };
                transaction.onabort = function () { reject(transaction.error || new Error('transaction aborted')); };
            });
        });
    }

    function getAllFrom(storeName) {
        return tx(storeName, false, function (store) {
            var request = store.getAll();
            var box = { value: [] };
            request.onsuccess = function () { box.value = request.result || []; };
            /* oncomplete 之后再取值 */
            return box;
        }).then(function (box) { return box.value || []; });
    }

    /* ================================================================== *
     * localStorage 降级后端
     * ================================================================== */
    function readFallback() {
        try {
            var raw = global.localStorage.getItem(FALLBACK_KEY);
            if (!raw) return { schemaVersion: 1, notes: [], folders: [], meta: {} };
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return { schemaVersion: 1, notes: [], folders: [], meta: {} };
            if (!Array.isArray(parsed.notes)) parsed.notes = [];
            if (!Array.isArray(parsed.folders)) parsed.folders = [];
            if (!parsed.meta || typeof parsed.meta !== 'object') parsed.meta = {};
            return parsed;
        } catch (err) {
            return { schemaVersion: 1, notes: [], folders: [], meta: {} };
        }
    }

    function writeFallback(doc) {
        var limits = fallbackLimits();
        var json;
        try {
            json = JSON.stringify(doc);
        } catch (err) {
            return Promise.reject(err);
        }
        if (doc.notes.length > limits.fallbackNotes) {
            return Promise.reject(new Error('降级模式下最多保存 ' + limits.fallbackNotes + ' 篇笔记'));
        }
        if (json.length > limits.fallbackBytes) {
            return Promise.reject(new Error('降级模式下总容量上限约 ' +
                Math.round(limits.fallbackBytes / 1024) + ' KB'));
        }
        try {
            global.localStorage.setItem(FALLBACK_KEY, json);
            if (global.localStorage.getItem(FALLBACK_KEY) !== json) {
                return Promise.reject(new Error('写入校验失败'));
            }
            return Promise.resolve(true);
        } catch (err) {
            return Promise.reject(err);
        }
    }

    /* ================================================================== *
     * 统一接口
     * ================================================================== */
    function open() {
        return openIdb().then(function () {
            mode = 'idb';
            return 'idb';
        }).catch(function (err) {
            mode = 'local';
            return 'local';
        });
    }

    function getMode() { return mode; }
    function isOpen() { return mode === 'idb' ? opened : true; }

    function getAllNotes() {
        if (mode === 'local') return Promise.resolve(readFallback().notes);
        return getAllFrom(STORES.notes);
    }

    function getAllFolders() {
        if (mode === 'local') return Promise.resolve(readFallback().folders);
        return getAllFrom(STORES.folders);
    }

    function putNote(note) {
        if (!note || !note.id) return Promise.reject(new Error('note.id required'));
        if (mode === 'local') {
            var doc = readFallback();
            var index = -1;
            for (var i = 0; i < doc.notes.length; i += 1) {
                if (doc.notes[i].id === note.id) { index = i; break; }
            }
            if (index > -1) doc.notes[index] = note;
            else doc.notes.push(note);
            return writeFallback(doc);
        }
        return tx(STORES.notes, true, function (store) { store.put(note); });
    }

    function getNote(id) {
        if (!id) return Promise.resolve(null);
        if (mode === 'local') {
            var doc = readFallback();
            for (var i = 0; i < doc.notes.length; i += 1) {
                if (doc.notes[i].id === id) return Promise.resolve(doc.notes[i]);
            }
            return Promise.resolve(null);
        }
        return tx(STORES.notes, false, function (store) {
            var request = store.get(id);
            var box = { value: null };
            request.onsuccess = function () { box.value = request.result || null; };
            return box;
        }).then(function (box) { return box.value; });
    }

    function putNotes(list) {
        if (!Array.isArray(list) || !list.length) return Promise.resolve(true);
        if (mode === 'local') {
            var doc = readFallback();
            var map = Object.create(null);
            doc.notes.forEach(function (note) { map[note.id] = note; });
            list.forEach(function (note) { if (note && note.id) map[note.id] = note; });
            doc.notes = Object.keys(map).map(function (id) { return map[id]; });
            return writeFallback(doc);
        }
        return tx(STORES.notes, true, function (store) {
            list.forEach(function (note) { if (note && note.id) store.put(note); });
        });
    }

    function deleteNote(id) {
        if (mode === 'local') {
            var doc = readFallback();
            doc.notes = doc.notes.filter(function (note) { return note.id !== id; });
            return writeFallback(doc);
        }
        return tx(STORES.notes, true, function (store) { store.delete(id); });
    }

    function putFolder(folder) {
        if (!folder || !folder.id) return Promise.reject(new Error('folder.id required'));
        if (mode === 'local') {
            var doc = readFallback();
            var index = -1;
            for (var i = 0; i < doc.folders.length; i += 1) {
                if (doc.folders[i].id === folder.id) { index = i; break; }
            }
            if (index > -1) doc.folders[index] = folder;
            else doc.folders.push(folder);
            return writeFallback(doc);
        }
        return tx(STORES.folders, true, function (store) { store.put(folder); });
    }

    function deleteFolder(id) {
        if (mode === 'local') {
            var doc = readFallback();
            doc.folders = doc.folders.filter(function (folder) { return folder.id !== id; });
            return writeFallback(doc);
        }
        return tx(STORES.folders, true, function (store) { store.delete(id); });
    }

    function getMeta(key) {
        if (mode === 'local') {
            var doc = readFallback();
            return Promise.resolve(doc.meta && Object.prototype.hasOwnProperty.call(doc.meta, key) ? doc.meta[key] : null);
        }
        return tx(STORES.meta, false, function (store) {
            var request = store.get(key);
            var box = { value: null };
            request.onsuccess = function () { box.value = request.result ? request.result.value : null; };
            return box;
        }).then(function (box) { return box.value; });
    }

    function setMeta(key, value) {
        if (mode === 'local') {
            var doc = readFallback();
            doc.meta[key] = value;
            return writeFallback(doc);
        }
        return tx(STORES.meta, true, function (store) { store.put({ key: key, value: value }); });
    }

    function putFile(id, blob, meta) {
        if (mode !== 'idb') return Promise.reject(new Error('当前为降级模式，不支持图片附件'));
        return tx(STORES.files, true, function (store) {
            store.put({
                id: id,
                blob: blob,
                name: (meta && meta.name) || '',
                type: (meta && meta.type) || (blob && blob.type) || '',
                size: (meta && meta.size) || (blob && blob.size) || 0
            });
        });
    }

    function getFile(id) {
        if (mode !== 'idb') return Promise.resolve(null);
        return tx(STORES.files, false, function (store) {
            var request = store.get(id);
            var box = { value: null };
            request.onsuccess = function () { box.value = request.result || null; };
            return box;
        }).then(function (box) { return box.value; });
    }

    function deleteFile(id) {
        if (mode !== 'idb') return Promise.resolve(true);
        return tx(STORES.files, true, function (store) { store.delete(id); });
    }

    function clearAll() {
        if (mode === 'local') {
            try { global.localStorage.removeItem(FALLBACK_KEY); } catch (err) { /* ignore */ }
            return Promise.resolve(true);
        }
        return openIdb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var transaction = db.transaction([STORES.notes, STORES.folders, STORES.files, STORES.meta], 'readwrite');
                transaction.objectStore(STORES.notes).clear();
                transaction.objectStore(STORES.folders).clear();
                transaction.objectStore(STORES.files).clear();
                transaction.objectStore(STORES.meta).clear();
                transaction.oncomplete = function () { resolve(true); };
                transaction.onerror = function () { reject(transaction.error || new Error('clear failed')); };
            });
        });
    }

    NC.notesDb = {
        DB_NAME: DB_NAME,
        DB_VERSION: DB_VERSION,
        FALLBACK_KEY: FALLBACK_KEY,
        STORES: STORES,
        open: open,
        isOpen: isOpen,
        getMode: getMode,
        getAllNotes: getAllNotes,
        getAllFolders: getAllFolders,
        getNote: getNote,
        putNote: putNote,
        putNotes: putNotes,
        deleteNote: deleteNote,
        putFolder: putFolder,
        deleteFolder: deleteFolder,
        getMeta: getMeta,
        setMeta: setMeta,
        putFile: putFile,
        getFile: getFile,
        deleteFile: deleteFile,
        clearAll: clearAll
    };
})(window);
