/**
 * storage.js — 安全存储适配层（经典脚本，依赖 core.js、compat.js）
 *
 * 目标：任何存储异常都不能造成白屏或卡死。
 * - localStorage 读取/写入/解析全部 try/catch；
 * - 损坏数据先备份原始字符串，再返回 fallback；
 * - 写入超过预算（默认 3.5MB）或 QuotaExceeded 时发出 quota:warning；
 * - 存储不可用时自动进入内存模式（memoryMode = true），并在 UI 上提示。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var events = NC.events;

    var PROBE_KEY = '__nc_storage_probe__';
    var MAX_BYTES = 3.5 * 1024 * 1024;

    var memory = Object.create(null);
    var available = (function () {
        try {
            global.localStorage.setItem(PROBE_KEY, '1');
            var ok = global.localStorage.getItem(PROBE_KEY) === '1';
            global.localStorage.removeItem(PROBE_KEY);
            return ok;
        } catch (err) {
            return false;
        }
    })();

    function memoryMode() { return !available; }

    function estimateBytes(value) {
        var text = typeof value === 'string' ? value : JSON.stringify(value);
        if (text == null) return 0;
        try {
            if (global.Blob) return new Blob([text]).size;
        } catch (err) { /* ignore */ }
        return text.length * 2;
    }

    function emitStorageError(kind, key, error) {
        events.emit(NC.eventNames.storageError, { kind: kind, key: key, error: error, memoryMode: !available });
    }

    /* 损坏备份最多保留 MAX_CORRUPT 份：备份是为了救命，不是为了吃满配额 */
    var MAX_CORRUPT = 3;

    function pruneCorrupted(key) {
        try {
            var prefix = key + '.corrupt.';
            var list = keys(prefix);
            if (list.length < MAX_CORRUPT) return;
            list.sort();
            var drop = list.slice(0, list.length - (MAX_CORRUPT - 1));
            drop.forEach(function (name) {
                try {
                    if (available) global.localStorage.removeItem(name);
                    delete memory[name];
                } catch (err) { /* ignore */ }
            });
        } catch (err) { /* ignore */ }
    }

    function backupCorrupted(key, raw) {
        try {
            if (raw == null) return;
            pruneCorrupted(key);
            var backupKey = key + '.corrupt.' + Date.now();
            if (available) global.localStorage.setItem(backupKey, raw);
            else memory[backupKey] = raw;
        } catch (err) {
            // 备份失败不阻断主流程
            console.warn('[NC] failed to backup corrupted storage:', key);
        }
    }

    function hasPending(key) {
        return Object.prototype.hasOwnProperty.call(memory, key);
    }

    /**
     * 读取原始串。优先返回"待落盘的内存副本"（写失败但已在内存里生效的新值），
     * 其次才是 localStorage。否则配额失败后读取会拿到旧值，造成内存与磁盘分叉。
     */
    function getRaw(key) {
        if (hasPending(key)) return memory[key];
        try {
            if (available) return global.localStorage.getItem(key);
            return null;
        } catch (err) {
            emitStorageError('read', key, err);
            return null;
        }
    }

    function setRaw(key, raw) {
        var size = estimateBytes(raw);
        if (size > MAX_BYTES) {
            events.emit(NC.eventNames.quotaWarning, { key: key, bytes: size, limit: MAX_BYTES, reason: 'budget' });
        }
        try {
            if (available) {
                global.localStorage.setItem(key, raw);
                delete memory[key];        // 已落盘：清掉待写副本
            } else {
                memory[key] = raw;         // 内存模式：这就是唯一副本，不能删
            }
            checkUsage();
            return { ok: true, bytes: size, memoryMode: !available };
        } catch (err) {
            // 写入失败时仍保留内存副本，保证当前会话可用（getRaw 会优先返回它）
            memory[key] = raw;
            var quota = !!(err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014));
            events.emit(quota ? NC.eventNames.quotaWarning : NC.eventNames.storageError, {
                key: key, bytes: size, limit: MAX_BYTES, error: err, memoryMode: !available
            });
            return { ok: false, error: err, quota: quota, bytes: size, memoryMode: !available };
        }
    }

    /**
     * 写入并读回校验：比对长度即可发现"写进去了但内容被截断/没写进去"的情况。
     * 对 localStorage 来说这是廉价的自证，避免"以为存上了"。
     */
    function setVerified(key, value) {
        var raw;
        try {
            raw = JSON.stringify(value);
        } catch (err) {
            emitStorageError('serialize', key, err);
            return { ok: false, error: err };
        }
        var result = setRaw(key, raw);
        if (!result || result.ok !== true) return result || { ok: false };
        var back = null;
        try {
            back = available ? global.localStorage.getItem(key) : memory[key];
        } catch (err) {
            back = null;
        }
        if (back !== raw) {
            var mismatch = new Error('read-back mismatch');
            result.ok = false;
            result.error = mismatch;
            result.mismatch = true;
            events.emit(NC.eventNames.storageError, { key: key, kind: 'verify', error: mismatch, memoryMode: !available });
        }
        return result;
    }

    function usageBytes() {
        if (!available) return 0;
        var used = 0;
        try {
            for (var i = 0; i < global.localStorage.length; i++) {
                var name = global.localStorage.key(i);
                var value = name ? global.localStorage.getItem(name) : null;
                used += estimateBytes(value || '') + estimateBytes(name || '');
            }
        } catch (err) { return 0; }
        return used;
    }

    /** 配额余量估算（0 表示已满或不可估算） */
    function remainingBytes() {
        return Math.max(0, MAX_BYTES - usageBytes());
    }

    /* 主动水位提醒：总占用达到预算 80% 时提示一次（降到 70% 以下后重新武装） */
    var nearLimitNotified = false;
    var usageCheckAt = 0;
    function checkUsage() {
        if (!available) return;
        var now = Date.now();
        if (now - usageCheckAt < 1500) return;
        usageCheckAt = now;
        var used = usageBytes();
        if (used >= MAX_BYTES * 0.8) {
            if (nearLimitNotified) return;
            nearLimitNotified = true;
            events.emit(NC.eventNames.quotaWarning, {
                reason: 'near-limit', used: used, limit: MAX_BYTES
            });
        } else if (used < MAX_BYTES * 0.7) {
            nearLimitNotified = false;
        }
    }

    function get(key, fallback) {
        var raw = getRaw(key);
        if (raw == null) return fallback;
        try {
            var parsed = JSON.parse(raw);
            return parsed == null ? fallback : parsed;
        } catch (err) {
            console.error('[NC] corrupted storage value:', key, err);
            backupCorrupted(key, raw);
            events.emit(NC.eventNames.storageCorrupt, { key: key, raw: raw });
            return fallback;
        }
    }

    function set(key, value) {
        var raw;
        try {
            raw = JSON.stringify(value);
        } catch (err) {
            emitStorageError('serialize', key, err);
            return { ok: false, error: err };
        }
        return setRaw(key, raw);
    }

    function remove(key) {
        try {
            if (available) global.localStorage.removeItem(key);
            delete memory[key];
            return true;
        } catch (err) {
            emitStorageError('remove', key, err);
            delete memory[key];
            return false;
        }
    }

    function has(key) {
        return getRaw(key) != null;
    }

    function keys(prefix) {
        var result = [];
        try {
            if (available) {
                for (var i = 0; i < global.localStorage.length; i++) {
                    var key = global.localStorage.key(i);
                    if (key && (!prefix || key.indexOf(prefix) === 0)) result.push(key);
                }
            } else {
                Object.keys(memory).forEach(function (key) {
                    if (!prefix || key.indexOf(prefix) === 0) result.push(key);
                });
            }
        } catch (err) {
            emitStorageError('keys', prefix || '', err);
        }
        return result;
    }

    /**
     * 跨标签页/跨窗口同步（file:// 与 http 均可用；文件源共享同一存储域）。
     * @returns {Function} 取消订阅
     */
    function onExternalChange(key, handler) {
        function listener(event) {
            if (event.key !== key) return;
            handler(event.newValue, event.oldValue);
        }
        global.addEventListener('storage', listener);
        return function () { global.removeEventListener('storage', listener); };
    }

    /**
     * 写入 JSON 前的体积预估（供上层做"导出/清理"引导）。
     */
    NC.storage = {
        available: available,
        memoryMode: memoryMode,
        maxBytes: MAX_BYTES,
        maxCorrupt: MAX_CORRUPT,
        get: get,
        set: set,
        getRaw: getRaw,
        setRaw: setRaw,
        setVerified: setVerified,
        remove: remove,
        has: has,
        keys: keys,
        estimateBytes: estimateBytes,
        usageBytes: usageBytes,
        remainingBytes: remainingBytes,
        hasPending: hasPending,
        onExternalChange: onExternalChange,
        backupCorrupted: backupCorrupted
    };

    if (!available) {
        console.warn('[NC] localStorage 不可用，已进入内存模式（本次修改不会保存）');
    }
})(window);
