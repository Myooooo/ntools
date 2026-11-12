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
        events.emit('storage:error', { kind: kind, key: key, error: error, memoryMode: !available });
    }

    function backupCorrupted(key, raw) {
        try {
            if (raw == null) return;
            if (available) {
                var backupKey = key + '.corrupt.' + Date.now();
                global.localStorage.setItem(backupKey, raw);
            } else {
                memory[key + '.corrupt.' + Date.now()] = raw;
            }
        } catch (err) {
            // 备份失败不阻断主流程
            console.warn('[NC] failed to backup corrupted storage:', key);
        }
    }

    function getRaw(key) {
        try {
            if (available) return global.localStorage.getItem(key);
            return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
        } catch (err) {
            emitStorageError('read', key, err);
            return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
        }
    }

    function setRaw(key, raw) {
        var size = estimateBytes(raw);
        if (size > MAX_BYTES) {
            events.emit('quota:warning', { key: key, bytes: size, limit: MAX_BYTES, reason: 'budget' });
        }
        try {
            if (available) global.localStorage.setItem(key, raw);
            else memory[key] = raw;
            return { ok: true, bytes: size, memoryMode: !available };
        } catch (err) {
            // 写入失败时仍保留内存副本，保证当前会话可用
            memory[key] = raw;
            var quota = !!(err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014));
            events.emit(quota ? 'quota:warning' : 'storage:error', {
                key: key, bytes: size, limit: MAX_BYTES, error: err, memoryMode: !available
            });
            return { ok: false, error: err, quota: quota, bytes: size, memoryMode: !available };
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
            events.emit('storage:corrupt', { key: key, raw: raw });
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
        get: get,
        set: set,
        getRaw: getRaw,
        setRaw: setRaw,
        remove: remove,
        has: has,
        keys: keys,
        estimateBytes: estimateBytes,
        onExternalChange: onExternalChange,
        backupCorrupted: backupCorrupted
    };

    if (!available) {
        console.warn('[NC] localStorage 不可用，已进入内存模式（本次修改不会保存）');
    }
})(window);
