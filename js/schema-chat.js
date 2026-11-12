/**
 * schema-chat.js — 聊天页数据校验 / 归一化 / 迁移（纯函数，无 DOM、无网络）
 * 经典脚本，依赖 core.js（NC.util）。挂载到 NC.schema.chat。
 *
 * 设计原则：任何外部数据（localStorage、备份文件、导入配置、API 返回）在落盘/渲染前
 * 必须经过本文件归一化；本文件所有函数都不得 throw，非法输入返回空值/默认值。
 *
 * 测试接口（tests.html 使用）：
 *   normalizeConfig(raw)               → config 对象
 *   normalizeConfigs(raw, fallbackName)→ config[]
 *   normalizeSettingsDoc(raw)          → {doc:{version,currentId,configs}, migrated:Boolean, reason}
 *   normalizeMessage(raw)              → message|null（保留合法 id）
 *   normalizeConversation(raw)         → message[]（id 全部重新生成）
 *   normalizeBackup(raw)               → {ok, messages, rejected, reason}
 *   sanitizeApiUrl(value)              → 合法 url 字符串 | null
 *   isAllowedImageUrl(url)             → Boolean
 *   estimateStats(...)                 （由 api.js 暴露，见 NC.api.estimateTokens）
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var VERSION = 2;

    var WHITELIST = ['id', 'name', 'apiUrl', 'apiKey', 'modelId', 'systemPrompt',
        'enableAdvanced', 'temperature', 'top_p'];

    var DEFAULTS = {
        name: '默认配置',
        apiUrl: 'https://api.openai.com/v1',
        apiKey: '',
        modelId: 'gpt-4o',
        systemPrompt: '',
        enableAdvanced: false,
        temperature: 1.0,
        top_p: 0.95
    };

    var LIMITS = {
        configs: 50,
        name: 80,
        model: 120,
        url: 500,
        key: 512,
        system: 20000,
        messages: 1000,
        text: 200000,
        imageChars: 4000000,
        images: 5,
        stats: 10000000
    };

    var IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;
    var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

    function isAllowedImageUrl(url) {
        if (typeof url !== 'string') return false;
        var value = url.trim();
        if (!value || value.length > LIMITS.imageChars) return false;
        return IMAGE_RE.test(value);
    }

    /**
     * Base URL 校验：仅 http/https、无用户名密码、无控制字符；缺协议时按 https 处理。
     * @returns {string|null} 归一化后的 URL（去尾部斜杠）；非法返回 null
     */
    function sanitizeApiUrl(value) {
        if (typeof value !== 'string') return null;
        var raw = value.trim();
        if (!raw || raw.length > LIMITS.url) return null;
        if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
        var candidate = raw;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) candidate = 'https://' + candidate;
        var parsed;
        if (typeof global.URL === 'function') {
            try { parsed = new global.URL(candidate); } catch (err) { return null; }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
            if (parsed.username || parsed.password) return null;
            return parsed.href.replace(/\/+$/, '');
        }
        // 极老内核兜底：正则粗校验
        var m = /^(https?):\/\/([^\s/:?#]+)(:[0-9]+)?([^\s?#]*)(\?[^\s#]*)?(#[^\s]*)?$/i.exec(candidate);
        if (!m) return null;
        return (m[1] + '://' + m[2] + (m[3] || '') + (m[4] || '') + (m[5] || '')).replace(/\/+$/, '');
    }

    function text(value, limit) {
        if (value == null) return '';
        if (typeof value === 'string') return value.length > limit ? value.slice(0, limit) : value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return '';
    }

    function bool(value, fallback) {
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === 1) return true;
        if (value === 'false' || value === 0) return false;
        return !!fallback;
    }

    function num(value, fallback, min, max) {
        var n = typeof value === 'number' ? value : parseFloat(value);
        if (!isFinite(n)) n = fallback;
        if (n < min) n = min;
        if (n > max) n = max;
        return n;
    }

    function tokenNum(value, fallback) {
        var n = num(value, fallback, 0, LIMITS.stats);
        return Math.round(n);
    }

    function id(value, prefix) {
        if (typeof value === 'string' && ID_RE.test(value)) return value;
        return util.uid(prefix || 'id');
    }

    function clone(value) {
        if (value == null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(clone);
        var out = {};
        Object.keys(value).forEach(function (key) { out[key] = clone(value[key]); });
        return out;
    }

    /* ------------------------------------------------------------------ *
     * 配置
     * ------------------------------------------------------------------ */
    function normalizeConfig(raw) {
        var src = util.isPlainObject(raw) ? raw : {};
        return {
            id: id(src.id, 'cfg'),
            name: text(src.name, LIMITS.name).trim() || '未命名配置',
            apiUrl: sanitizeApiUrl(src.apiUrl) || '',
            apiKey: text(src.apiKey, LIMITS.key).trim(),
            modelId: text(src.modelId, LIMITS.model).trim(),
            systemPrompt: text(src.systemPrompt, LIMITS.system),
            enableAdvanced: bool(src.enableAdvanced, false),
            temperature: num(src.temperature, DEFAULTS.temperature, 0, 2),
            top_p: num(src.top_p, DEFAULTS.top_p, 0, 2)
        };
    }

    function createDefaultConfig(name) {
        var config = normalizeConfig({
            name: name || DEFAULTS.name,
            apiUrl: DEFAULTS.apiUrl,
            modelId: DEFAULTS.modelId,
            systemPrompt: DEFAULTS.systemPrompt,
            enableAdvanced: DEFAULTS.enableAdvanced,
            temperature: DEFAULTS.temperature,
            top_p: DEFAULTS.top_p
        });
        config.name = name || DEFAULTS.name;
        return config;
    }

    function normalizeConfigs(raw, fallbackName) {
        var list = Array.isArray(raw) ? raw : [];
        var out = [];
        var seen = Object.create(null);
        list.slice(0, LIMITS.configs).forEach(function (item) {
            var config = normalizeConfig(item);
            if (seen[config.id]) config.id = util.uid('cfg');
            seen[config.id] = true;
            out.push(config);
        });
        if (!out.length) out.push(createDefaultConfig(fallbackName || DEFAULTS.name));
        return out;
    }

    /**
     * 配置文档迁移：支持 v2 {version,currentId,configs}、旧形状 {currentId,configs}、
     * 更旧单配置 {apiUrl,apiKey,modelId,systemPrompt}、纯数组。
     * @returns {{doc:{version:Number,currentId:String,configs:Array}, migrated:Boolean, reason:String}}
     */
    function normalizeSettingsDoc(raw) {
        var migrated = false;
        var configs = [];
        var currentId = null;
        if (Array.isArray(raw)) {
            configs = normalizeConfigs(raw);
            migrated = true;
        } else if (util.isPlainObject(raw)) {
            if (Array.isArray(raw.configs)) {
                configs = normalizeConfigs(raw.configs);
                currentId = typeof raw.currentId === 'string' ? raw.currentId : null;
                if (raw.version !== VERSION) migrated = true;
            } else if (raw.apiUrl || raw.apiKey || raw.modelId || raw.systemPrompt) {
                var legacy = normalizeConfig(raw);
                legacy.name = '旧配置备份';
                configs = [legacy];
                currentId = legacy.id;
                migrated = true;
            } else {
                configs = normalizeConfigs([]);
                migrated = true;
            }
        } else {
            configs = normalizeConfigs([]);
            migrated = raw != null;
        }
        var exists = configs.some(function (config) { return config.id === currentId; });
        if (!exists) currentId = configs[0].id;
        return {
            doc: { version: VERSION, currentId: currentId, configs: configs },
            migrated: migrated,
            reason: migrated ? 'shape' : ''
        };
    }

    /* ------------------------------------------------------------------ *
     * 会话消息
     * ------------------------------------------------------------------ */
    function normalizeUserContent(raw) {
        if (typeof raw === 'string') {
            var only = text(raw, LIMITS.text);
            return only ? [{ type: 'text', text: only }] : [];
        }
        if (!Array.isArray(raw)) return [];
        var out = [];
        var images = 0;
        raw.slice(0, 16).forEach(function (part) {
            if (!util.isPlainObject(part)) return;
            if (part.type === 'text' && typeof part.text === 'string' && part.text) {
                out.push({ type: 'text', text: text(part.text, LIMITS.text) });
            } else if (part.type === 'image_url' && images < 5) {
                var urlValue = util.isPlainObject(part.image_url) ? part.image_url.url : null;
                if (isAllowedImageUrl(urlValue)) {
                    out.push({ type: 'image_url', image_url: { url: urlValue.trim() } });
                    images += 1;
                }
            }
        });
        return out;
    }

    function normalizeStats(raw) {
        if (!util.isPlainObject(raw)) return null;
        var keys = ['contextLength', 'outputLength', 'totalLength', 'outputRate', 'outputTime'];
        var out = {};
        var found = false;
        keys.forEach(function (key) {
            if (util.isFiniteNum(raw[key]) && raw[key] >= 0) {
                found = true;
                out[key] = (key === 'outputRate' || key === 'outputTime')
                    ? Math.round(num(raw[key], 0, 0, LIMITS.stats) * 10) / 10
                    : tokenNum(raw[key], 0);
            }
        });
        if (typeof raw.estimated === 'boolean') out.estimated = raw.estimated;
        return found ? out : null;
    }

    /** 保留合法 id（用于 store 内部可信数据）。外部数据请用 normalizeConversation。 */
    function normalizeMessage(raw) {
        if (!util.isPlainObject(raw)) return null;
        var role = raw.role;
        if (role !== 'user' && role !== 'assistant') return null;
        var message = {
            id: id(raw.id, 'msg'),
            role: role,
            createdAt: util.isFiniteNum(raw.createdAt) ? raw.createdAt : Date.now()
        };
        if (role === 'user') {
            message.content = normalizeUserContent(raw.content);
            if (!message.content.length) return null;
        } else {
            message.content = text(raw.content, LIMITS.text);
            var reasoning = text(raw.reasoning, LIMITS.text);
            if (reasoning) message.reasoning = reasoning;
            var stats = normalizeStats(raw.stats);
            if (stats) message.stats = stats;
        }
        return message;
    }

    /** 外部来源消息：id 一律重新生成，避免选择器注入 / 重复 id。 */
    function normalizeConversation(raw) {
        if (!Array.isArray(raw)) return [];
        var out = [];
        raw.slice(0, LIMITS.messages).forEach(function (item) {
            var message = normalizeMessage(item);
            if (!message) return;
            message.id = util.uid('msg');
            out.push(message);
        });
        return out;
    }

    /**
     * 备份归一化：兼容 {conversation:[...]}、{messages:[...]}、{data:[...]}、纯数组。
     * @returns {{ok:Boolean, messages:Array, rejected:Number, reason:String}}
     */
    function normalizeBackup(raw) {
        var data = raw;
        if (typeof raw === 'string') data = util.parseJSON(raw, null);
        if (data == null) {
            return { ok: false, messages: [], rejected: 0, reason: '无法解析备份文件' };
        }
        var list = null;
        if (Array.isArray(data)) list = data;
        else if (util.isPlainObject(data)) {
            if (Array.isArray(data.conversation)) list = data.conversation;
            else if (Array.isArray(data.messages)) list = data.messages;
            else if (Array.isArray(data.data)) list = data.data;
        }
        if (!list) {
            return { ok: false, messages: [], rejected: 0, reason: '无效的备份文件格式' };
        }
        var messages = normalizeConversation(list);
        var rejected = Math.max(0, list.length - messages.length);
        if (list.length > 0 && messages.length === 0) {
            return { ok: false, messages: [], rejected: rejected, reason: '备份中没有可用消息' };
        }
        return { ok: true, messages: messages, rejected: rejected, reason: '' };
    }

    NC.schema = NC.schema || {};
    NC.schema.chat = {
        VERSION: VERSION,
        WHITELIST: WHITELIST,
        DEFAULTS: DEFAULTS,
        LIMITS: LIMITS,
        clone: clone,
        text: text,
        isAllowedImageUrl: isAllowedImageUrl,
        sanitizeApiUrl: sanitizeApiUrl,
        createDefaultConfig: createDefaultConfig,
        normalizeConfig: normalizeConfig,
        normalizeConfigs: normalizeConfigs,
        normalizeSettingsDoc: normalizeSettingsDoc,
        normalizeUserContent: normalizeUserContent,
        normalizeStats: normalizeStats,
        normalizeMessage: normalizeMessage,
        normalizeConversation: normalizeConversation,
        normalizeBackup: normalizeBackup
    };
})(window);
