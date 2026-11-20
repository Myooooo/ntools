/**
 * prefs.js — 视图层统一的偏好读写（挂载 NC.prefs）
 *
 * 目的：视图不直接碰 localStorage；读写走 NC.storage 的 raw 通道，
 * 保持与历史数据完全相同的字符串格式（'1' / 'light' / JSON 文本）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    function storage() { return NC.storage || null; }

    function rawGet(key) {
        try {
            var s = storage();
            if (s && typeof s.getRaw === 'function') return s.getRaw(key);
            return global.localStorage.getItem(key);
        } catch (err) { return null; }
    }

    function rawSet(key, value) {
        try {
            var s = storage();
            if (s && typeof s.setRaw === 'function') {
                var result = s.setRaw(key, String(value));
                return !result || result.ok !== false;
            }
            global.localStorage.setItem(key, String(value));
            return true;
        } catch (err) { return false; }
    }

    function get(key, fallback) {
        var value = rawGet(key);
        return value == null ? fallback : value;
    }

    function set(key, value) {
        return rawSet(key, value);
    }

    function remove(key) {
        try {
            var s = storage();
            if (s && typeof s.remove === 'function') return s.remove(key);
            global.localStorage.removeItem(key);
            return true;
        } catch (err) { return false; }
    }

    function getJSON(key, fallback) {
        var value = rawGet(key);
        if (value == null) return fallback;
        try { return JSON.parse(value); } catch (err) { return fallback; }
    }

    NC.prefs = {
        get: get,
        set: set,
        remove: remove,
        getJSON: getJSON,
        raw: rawGet,
        setRaw: rawSet
    };
})(window);
