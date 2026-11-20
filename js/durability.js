/**
 * durability.js — 数据韧性基础设施（经典脚本，依赖 core.js / storage.js）
 * 挂载：NC.durability
 *
 * 提供两件事，二者都只为"数据不丢"服务：
 *
 * 1) NC.durability.lease —— 单写者租约（single-writer lease）
 *    同一份数据在同一时刻只允许一个标签页写。其他标签页进入"只读镜像"，
 *    而不是各写各的、最后互相覆盖（file:// 下所有窗口共享一份 localStorage，
 *    分屏/双开是常态，这是最容易被忽略的丢数据路径）。
 *
 * 2) NC.durability.snapshot —— 环形快照（ring buffer）
 *    主数据之外保留 N 份历史副本，主键损坏或误操作时可回滚。
 *    IndexedDB 优先（不占 localStorage 配额），不可用时退化为
 *    localStorage 单槽 + 体积上限，再不行就禁用（绝不因此阻塞主流程）。
 *
 * 约定：本模块任何失败都不 throw 到调用方；返回 {ok:false, reason}。
 * 兼容：Chromium 102；只用 localStorage / IndexedDB / setTimeout / 无 await。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var storage = NC.storage;
    var events = NC.events;

    /* ================================================================== *
     * 标签页身份
     * 用 sessionStorage 保存：同一标签页刷新后身份不变（否则刷新后
     * 会被自己上一轮的租约挡住最多 TTL 毫秒），不同标签页互不相同。
     * ================================================================== */
    var TAB_KEY = 'ntools.tab-id';

    function readTabId() {
        var WINDOW_MARK = 'ntools-tab:';
        function valid(value) {
            return typeof value === 'string' && value.length >= 6 && value.length <= 64;
        }

        /* 1) sessionStorage：每标签页独立、刷新后保持，最理想 */
        try {
            var existing = global.sessionStorage && global.sessionStorage.getItem(TAB_KEY);
            if (valid(existing)) return existing;
            var id = util.uid('tab');
            if (global.sessionStorage) global.sessionStorage.setItem(TAB_KEY, id);
            if (valid(id)) return id;
        } catch (err) { /* 被策略禁用，继续降级 */ }

        /* 2) window.name：同一标签页刷新后保持、不同窗口互不影响。
         *    sessionStorage 被禁用时（部分信创策略会禁）靠它，否则每次刷新都会
         *    换一个新身份，导致刷新后莫名进入"只读镜像"。 */
        try {
            var named = String(global.name || '');
            if (named.indexOf(WINDOW_MARK) === 0 && valid(named.slice(WINDOW_MARK.length))) {
                return named.slice(WINDOW_MARK.length);
            }
            var fresh = util.uid('tab');
            global.name = WINDOW_MARK + fresh;
            return fresh;
        } catch (err) { /* 继续降级 */ }

        /* 3) 最后兜底：随机会话内有效（刷新会换身份，但不会崩） */
        return util.uid('tab');
    }

    var TAB_ID = readTabId();

    /* ================================================================== *
     * 单写者租约
     * 记录形如 {tabId, at}；超过 TTL 未续租视为过期（崩溃/强杀也能自愈）。
     * ================================================================== */
    var LEASE_TTL = 6000;
    var LEASE_RENEW = 2000;

    var renewTimers = Object.create(null);

    function leaseRecord(name) {
        var rec = null;
        try {
            rec = storage.get(name, null);
        } catch (err) {
            rec = null;
        }
        if (!util.isPlainObject(rec)) return null;
        if (typeof rec.tabId !== 'string' || !rec.tabId) return null;
        var at = util.isFiniteNum(rec.at) ? rec.at : 0;
        return {
            tabId: rec.tabId,
            at: at,
            expired: (Date.now() - at) > LEASE_TTL,
            mine: rec.tabId === TAB_ID
        };
    }

    function isOwner(name) {
        var rec = leaseRecord(name);
        if (!rec) return true;          // 无人持有 = 我可以写
        if (rec.expired) return true;   // 持有者失联 = 我可以接管
        return rec.mine;
    }

    /** 谁是当前持有者（用于 UI 文案）；返回 {tabId, mine, expired} | null */
    function holder(name) {
        return leaseRecord(name);
    }

    function startRenew(name) {
        if (renewTimers[name] || !global.setInterval) return;
        renewTimers[name] = global.setInterval(function () {
            var rec = leaseRecord(name);
            if (!rec) { stopRenew(name); return; }
            if (!rec.mine) { stopRenew(name); return; }
            storage.set(name, { tabId: TAB_ID, at: Date.now() });
        }, LEASE_RENEW);
    }

    function stopRenew(name) {
        if (!renewTimers[name]) return;
        try { global.clearInterval(renewTimers[name]); } catch (err) { /* ignore */ }
        delete renewTimers[name];
    }

    /** 尝试取得写权；返回 true 表示可以写 */
    function claim(name) {
        var rec = leaseRecord(name);
        if (rec && !rec.expired && !rec.mine) return false;
        var result = storage.set(name, { tabId: TAB_ID, at: Date.now() });
        if (!result || result.ok === false) {
            // 连租约都写不进去（配额满）：不阻断本地写入，但要让上层知道
            events.emit(NC.eventNames.leaseDegraded, { name: name, error: result && result.error });
        }
        startRenew(name);
        return true;
    }

    /** 强制夺取写权（用户显式点「接管编辑」时使用）。另一窗口会收到 storage 事件转为只读。 */
    function steal(name) {
        var result = storage.set(name, { tabId: TAB_ID, at: Date.now() });
        startRenew(name);
        return !!(result && result.ok !== false);
    }

    function release(name) {
        stopRenew(name);
        var rec = leaseRecord(name);
        if (rec && rec.mine) storage.remove(name);
    }

    function releaseAll() {
        Object.keys(renewTimers).forEach(release);
    }

    /** 监听租约变化；回调 (isOwner, name)。file:// 下若无 storage 事件则不会触发，
     *  此时写入前的 claim() 仍能兜底，不会造成覆盖。 */
    function watch(name, fn) {
        if (typeof fn !== 'function') return function () {};
        var off = storage.onExternalChange(name, function () {
            try { fn(isOwner(name), name); } catch (err) { /* ignore */ }
        });
        return off;
    }

    if (global.addEventListener) {
        global.addEventListener('pagehide', releaseAll);
        global.addEventListener('beforeunload', releaseAll);
    }

    /* ================================================================== *
     * 环形快照
     * ================================================================== */
    var SNAP_DB_PREFIX = 'ntools-durable-';
    var SNAP_STORE = 'snapshots';
    var LOCAL_FALLBACK_MAX_BYTES = 400 * 1024;

    var snapConfigs = Object.create(null);
    var DEFAULT_SNAP = { slots: 3, namespace: 'default' };

    function snapCfg(prefix) {
        var key = prefix || 'snap';
        if (!snapConfigs[key]) {
            snapConfigs[key] = {
                prefix: key,
                slots: DEFAULT_SNAP.slots,
                namespace: DEFAULT_SNAP.namespace,
                dbPromise: null,
                dbFailed: false,
                localOnly: false
            };
        }
        return snapConfigs[key];
    }

    function snapKey(cfg, slot) {
        return cfg.prefix + ':' + slot;
    }

    function localKey(cfg, slot) {
        return 'ntools.snap.' + cfg.prefix + '.' + slot;
    }

    function openDB(cfg) {
        if (cfg.dbPromise) return cfg.dbPromise;
        cfg.dbPromise = new Promise(function (resolve, reject) {
            if (cfg.localOnly || !global.indexedDB) {
                reject(new Error('idb unavailable'));
                return;
            }
            var request;
            try {
                request = global.indexedDB.open(SNAP_DB_PREFIX + cfg.namespace, 1);
            } catch (err) {
                reject(err);
                return;
            }
            request.onupgradeneeded = function (event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains(SNAP_STORE)) {
                    db.createObjectStore(SNAP_STORE, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            };
            request.onsuccess = function () {
                var db = request.result;
                db.onversionchange = function () {
                    try { db.close(); } catch (err) { /* ignore */ }
                    cfg.dbPromise = null;
                    cfg.localOnly = true;
                };
                resolve(db);
            };
            request.onerror = function () {
                cfg.dbFailed = true;
                cfg.dbPromise = null;
                reject(request.error || new Error('idb open failed'));
            };
            request.onblocked = function () {
                cfg.dbFailed = true;
                cfg.dbPromise = null;
                reject(new Error('idb blocked'));
            };
        });
        return cfg.dbPromise;
    }

    function idbTx(cfg, mode) {
        return openDB(cfg).then(function (db) {
            return db.transaction(SNAP_STORE, mode);
        });
    }

    function idbPut(cfg, record) {
        return idbTx(cfg, 'readwrite').then(function (tx) {
            return new Promise(function (resolve, reject) {
                tx.objectStore(SNAP_STORE).put(record);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('idb put failed')); };
                tx.onabort = function () { reject(tx.error || new Error('idb put aborted')); };
            });
        });
    }

    function idbAll(cfg) {
        return idbTx(cfg, 'readonly').then(function (tx) {
            return new Promise(function (resolve, reject) {
                var request = tx.objectStore(SNAP_STORE).getAll();
                request.onsuccess = function () { resolve(request.result || []); };
                request.onerror = function () { reject(request.error || new Error('idb read failed')); };
            });
        });
    }

    function idbGet(cfg, slot) {
        return idbTx(cfg, 'readonly').then(function (tx) {
            return new Promise(function (resolve, reject) {
                var request = tx.objectStore(SNAP_STORE).get(snapKey(cfg, slot));
                request.onsuccess = function () { resolve(request.result || null); };
                request.onerror = function () { reject(request.error || new Error('idb get failed')); };
            });
        });
    }

    function idbDelete(cfg, slot) {
        return idbTx(cfg, 'readwrite').then(function (tx) {
            return new Promise(function (resolve, reject) {
                tx.objectStore(SNAP_STORE).delete(snapKey(cfg, slot));
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('idb delete failed')); };
            });
        });
    }

    function localRecords(cfg) {
        var out = [];
        for (var i = 0; i < cfg.slots; i += 1) {
            var raw = storage.getRaw(localKey(cfg, i));
            if (raw == null) continue;
            var parsed = util.parseJSON(raw, null);
            if (parsed && parsed.doc) out.push(parsed);
        }
        return out;
    }

    function pickSlot(existing, slots) {
        if (existing.length < slots) {
            var used = Object.create(null);
            existing.forEach(function (item) { used[item.slot] = true; });
            for (var i = 0; i < slots; i += 1) {
                if (!used[i]) return i;
            }
        }
        var sorted = existing.slice().sort(function (a, b) {
            return (a.at || 0) - (b.at || 0);
        });
        return sorted[0].slot;
    }

    var snapSeq = 0;

    /**
     * 写入一份快照。
     * @param {string} prefix 命名空间（todo / chat-raw …）
     * @param {*} doc 可 JSON 序列化的文档
     * @param {Object} [summary] 展示用摘要
     * @returns {Promise<{ok:boolean, slot?:number, bytes?:number, reason?:string, backend?:string}>}
     */
    function push(prefix, doc, summary) {
        var cfg = snapCfg(prefix);
        var raw;
        try {
            raw = JSON.stringify(doc);
        } catch (err) {
            return Promise.resolve({ ok: false, reason: 'serialize' });
        }
        var bytes = raw.length;
        snapSeq += 1;

        function writeLocal() {
            if (bytes > LOCAL_FALLBACK_MAX_BYTES) {
                return { ok: false, reason: 'too-big' };
            }
            var existing = localRecords(cfg);
            var slot = pickSlot(existing, cfg.slots);
            var record = {
                key: localKey(cfg, slot), slot: slot, at: Date.now(), bytes: bytes,
                seq: snapSeq, summary: summary || null, doc: doc
            };
            var result = storage.setRaw(localKey(cfg, slot), JSON.stringify(record));
            if (!result || result.ok === false) return { ok: false, reason: 'quota' };
            return { ok: true, slot: slot, bytes: bytes, backend: 'local' };
        }

        return idbAll(cfg).then(function (all) {
            var existing = (all || []).filter(function (item) {
                return item && item.key && item.key.indexOf(cfg.prefix + ':') === 0;
            });
            var slot = pickSlot(existing, cfg.slots);
            var record = {
                key: snapKey(cfg, slot), slot: slot, at: Date.now(), bytes: bytes,
                seq: snapSeq, summary: summary || null, doc: doc
            };
            return idbPut(cfg, record).then(function () {
                return { ok: true, slot: slot, bytes: bytes, backend: 'idb' };
            });
        }).catch(function () {
            return writeLocal();
        });
    }

    function list(prefix) {
        var cfg = snapCfg(prefix);
        function shape(item) {
            return { slot: item.slot, at: item.at, bytes: item.bytes, summary: item.summary || null };
        }
        return idbAll(cfg).then(function (all) {
            var out = (all || []).filter(function (item) {
                return item && item.key && item.key.indexOf(cfg.prefix + ':') === 0;
            }).map(shape);
            return out.sort(function (a, b) { return b.at - a.at; });
        }).catch(function () {
            return localRecords(cfg).map(shape).sort(function (a, b) { return b.at - a.at; });
        });
    }

    function read(prefix, slot) {
        var cfg = snapCfg(prefix);
        return idbGet(cfg, slot).then(function (record) {
            return record && record.doc ? record.doc : null;
        }).catch(function () {
            var raw = storage.getRaw(localKey(cfg, slot));
            var parsed = raw ? util.parseJSON(raw, null) : null;
            return parsed && parsed.doc ? parsed.doc : null;
        });
    }

    function clear(prefix) {
        var cfg = snapCfg(prefix);
        var jobs = [];
        for (var i = 0; i < cfg.slots; i += 1) {
            jobs.push(idbDelete(cfg, i).catch(function () { return null; }));
            storage.remove(localKey(cfg, i));
        }
        return Promise.all(jobs).then(function () { return true; }).catch(function () { return false; });
    }

    function configure(options) {
        var opts = options || {};
        var cfg = snapCfg(typeof opts.prefix === 'string' && opts.prefix ? opts.prefix : undefined);
        if (util.isFiniteNum(opts.slots) && opts.slots > 0) cfg.slots = opts.slots;
        if (typeof opts.namespace === 'string' && opts.namespace) cfg.namespace = opts.namespace;
        return cfg;
    }

    function backend(prefix) {
        var cfg = snapCfg(prefix);
        if (cfg.dbFailed || cfg.localOnly) return 'local';
        if (cfg.dbPromise) return 'idb';
        return 'unknown';
    }


    /* ================================================================== *
     * 导出
     * ================================================================== */
    NC.durability = {
        tabId: TAB_ID,
        leaseTtl: LEASE_TTL,
        lease: {
            claim: claim,
            steal: steal,
            release: release,
            releaseAll: releaseAll,
            isOwner: isOwner,
            holder: holder,
            watch: watch
        },
        snapshot: {
            configure: configure,
            push: push,
            list: list,
            read: read,
            clear: clear,
            backend: backend
        }
    };
})(window);
