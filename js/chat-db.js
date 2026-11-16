/**
 * chat-db.js — nChat IndexedDB 持久层（无第三方依赖）
 * 经典脚本，挂载 NC.chatDb。
 *
 * DB：ntools-chat-<namespace>；namespace 存 localStorage（清空站点数据时自然换新库，
 *     避免旧测试数据串入新会话）。stores:
 *   sessions  keyPath id —— 完整会话（含消息树）
 *   meta      keyPath key —— migrated/activeByEndpoint 等
 *   files     keyPath id —— 附件 Blob（供后续文件附件使用）
 *
 * 所有 API 返回 Promise。IndexedDB 不可用时 open() reject，由 conversation-store
 * 回退到 localStorage v3；不会 throw 到页面。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var NS_KEY = 'nchat-db-namespace.v1';
    var DB_PREFIX = 'ntools-chat-';
    var DB_VERSION = 1;

    var namespace = null;
    var dbPromise = null;
    var opened = false;

    function readNamespace() {
        if (namespace) return namespace;
        var value = '';
        try { value = global.localStorage.getItem(NS_KEY) || ''; } catch (err) { value = ''; }
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(value)) {
            value = 'ns-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
            try { global.localStorage.setItem(NS_KEY, value); } catch (err) { /* ignore */ }
        }
        namespace = value;
        return namespace;
    }

    function dbName() { return DB_PREFIX + readNamespace(); }

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            var request;
            try {
                request = global.indexedDB.open(dbName(), DB_VERSION);
            } catch (err) {
                reject(err);
                return;
            }
            request.onupgradeneeded = function (event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
                if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
            };
            request.onsuccess = function () {
                var db = request.result;
                /* 另一个标签页要求升级/删除：关闭并让上层降级，而不是留着失效连接 */
                db.onversionchange = function () {
                    try { db.close(); } catch (err) { /* ignore */ }
                    opened = false;
                    dbPromise = null;
                    if (typeof onDegraded === 'function') onDegraded('versionchange');
                };
                opened = true;
                resolve(db);
            };
            request.onerror = function () {
                dbPromise = null;   // 允许下次重试，不要把失败永久缓存
                reject(request.error || new Error('IndexedDB open failed'));
            };
            request.onblocked = function () {
                dbPromise = null;
                reject(new Error('IndexedDB blocked'));
            };
        });
        return dbPromise;
    }

    var onDegraded = null;

    /** 注册降级回调（IndexedDB 不可用 / 版本变更时触发） */
    function setDegradedHandler(fn) {
        onDegraded = typeof fn === 'function' ? fn : null;
    }

    /** 主动丢弃缓存的连接，下次 open() 会重新打开 */
    function reset() {
        if (dbPromise) {
            dbPromise.then(function (db) { try { db.close(); } catch (err) { /* ignore */ } }, function () {});
        }
        dbPromise = null;
        opened = false;
    }

    function getAllSessions() {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('sessions', 'readonly');
                var request = tx.objectStore('sessions').getAll();
                request.onsuccess = function () { resolve(request.result || []); };
                request.onerror = function () { reject(request.error || new Error('IndexedDB read failed')); };
            });
        });
    }

    function putSession(session) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('sessions', 'readwrite');
                tx.objectStore('sessions').put(session);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB write failed')); };
                tx.onabort = function () { reject(tx.error || new Error('IndexedDB write aborted')); };
            });
        });
    }

    function putSessions(list) {
        if (!Array.isArray(list) || !list.length) return Promise.resolve(true);
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('sessions', 'readwrite');
                var store = tx.objectStore('sessions');
                list.forEach(function (session) { if (session && session.id) store.put(session); });
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB write failed')); };
                tx.onabort = function () { reject(tx.error || new Error('IndexedDB write aborted')); };
            });
        });
    }

    function replaceAllSessions(list) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('sessions', 'readwrite');
                var store = tx.objectStore('sessions');
                store.clear();
                (list || []).forEach(function (session) { if (session && session.id) store.put(session); });
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB replace failed')); };
                tx.onabort = function () { reject(tx.error || new Error('IndexedDB replace aborted')); };
            });
        });
    }

    function deleteSession(id) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('sessions', 'readwrite');
                tx.objectStore('sessions').delete(id);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB delete failed')); };
                tx.onabort = function () { reject(tx.error || new Error('IndexedDB delete aborted')); };
            });
        });
    }

    function deleteSessions(ids) {
        if (!Array.isArray(ids) || !ids.length) return Promise.resolve(true);
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('sessions', 'readwrite');
                var store = tx.objectStore('sessions');
                ids.forEach(function (id) { store.delete(id); });
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB delete failed')); };
                tx.onabort = function () { reject(tx.error || new Error('IndexedDB delete aborted')); };
            });
        });
    }

    function getMeta(key) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('meta', 'readonly');
                var request = tx.objectStore('meta').get(key);
                request.onsuccess = function () {
                    resolve(request.result ? request.result.value : null);
                };
                request.onerror = function () { reject(request.error || new Error('IndexedDB meta read failed')); };
            });
        });
    }

    function setMeta(key, value) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('meta', 'readwrite');
                tx.objectStore('meta').put({ key: key, value: value });
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB meta write failed')); };
                tx.onabort = function () { reject(tx.error || new Error('IndexedDB meta write aborted')); };
            });
        });
    }

    function putFile(id, blob, meta) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('files', 'readwrite');
                tx.objectStore('files').put({
                    id: id,
                    blob: blob,
                    name: (meta && meta.name) || '',
                    type: (meta && meta.type) || (blob && blob.type) || '',
                    size: (meta && meta.size) || (blob && blob.size) || 0
                });
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB file write failed')); };
            });
        });
    }

    function getFile(id) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('files', 'readonly');
                var request = tx.objectStore('files').get(id);
                request.onsuccess = function () { resolve(request.result || null); };
                request.onerror = function () { reject(request.error || new Error('IndexedDB file read failed')); };
            });
        });
    }

    function clearAll() {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(['sessions', 'meta', 'files'], 'readwrite');
                tx.objectStore('sessions').clear();
                tx.objectStore('meta').clear();
                tx.objectStore('files').clear();
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB clear failed')); };
            });
        });
    }

    NC.chatDb = {
        open: open,
        isOpen: function () { return opened; },
        namespace: readNamespace,
        getAllSessions: getAllSessions,
        putSession: putSession,
        putSessions: putSessions,
        replaceAllSessions: replaceAllSessions,
        deleteSession: deleteSession,
        deleteSessions: deleteSessions,
        reset: reset,
        setDegradedHandler: setDegradedHandler,
        getMeta: getMeta,
        setMeta: setMeta,
        putFile: putFile,
        getFile: getFile,
        clearAll: clearAll
    };
})(window);
