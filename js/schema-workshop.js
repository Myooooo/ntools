/**
 * schema-workshop.js — 创意工坊契约（纯函数）
 * 经典脚本，依赖 core.js（NC.util）。挂载：NC.schema.workshop
 *
 * 只做"数据形状 + 文本处理"，不碰 DOM / 存储：
 *   - 参数默认值与 k/m 单位解析
 *   - 模型输出 → 单文件 HTML 的提取与包装（CSP / 主题 / 高度与错误回传）
 *   - 应用、版本的归一化与上限
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var DOC_VERSION = 1;

    var LIMITS = {
        apps: 100,
        appBytes: 300 * 1024,        // 单个应用 HTML 上限 300KB
        totalBytes: 30 * 1024 * 1024,
        versions: 10,                 // 每个应用保留最近 10 版
        turns: 60,                    // 每应用保留最近 60 轮对话
        title: 60,
        contextMax: 2000000,
        outputMax: 200000,
        temperature: [0, 2],
        topP: [0, 1]
    };

    var DEFAULT_PARAMS = {
        temperature: 1,
        topP: 0.95,
        reasoning: true,
        effort: 'high',               // low | medium | high
        contextLimit: 256000,
        outputLimit: 25600,
        endpointId: ''
    };

    var EFFORTS = ['low', 'medium', 'high'];

    /* ------------------------------------------------------------------ *
     * 数字与单位
     * ------------------------------------------------------------------ */
    function isNum(n) { return typeof n === 'number' && isFinite(n); }

    /**
     * 解析带单位的数量：`256k` / `25.6k` / `1m` / `1.5M` / `256,000`。
     * @returns {number|null} 非法返回 null
     */
    function parseCount(input, options) {
        var opts = options || {};
        if (input == null || input === '') return opts.fallback == null ? null : opts.fallback;
        var raw = String(input).trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
        if (!raw) return opts.fallback == null ? null : opts.fallback;
        var match = /^(\d+(?:\.\d+)?)([km])?$/.exec(raw);
        if (!match) return null;
        var value = Number(match[1]);
        if (!isFinite(value)) return null;
        var unit = match[2];
        if (unit === 'k') value *= 1000;
        else if (unit === 'm') value *= 1000000;
        if (opts.integer !== false) value = Math.round(value);
        if (opts.min != null && value < opts.min) return null;
        if (opts.max != null && value > opts.max) return null;
        return value;
    }

    /** 显示用：1000 的整数倍压成 k / m，其余原样 */
    function formatCount(value) {
        var n = Number(value);
        if (!isFinite(n)) return '0';
        if (n >= 1000000 && n % 100000 === 0) return (n / 1000000) + 'm';
        if (n >= 10000 && n % 1000 === 0) return (n / 1000) + 'k';
        return String(Math.round(n));
    }

    function clamp(value, min, max) {
        if (!isNum(value)) return min;
        return Math.min(max, Math.max(min, value));
    }

    function normalizeParams(raw) {
        var src = raw && typeof raw === 'object' ? raw : {};
        var out = {
            temperature: DEFAULT_PARAMS.temperature,
            topP: DEFAULT_PARAMS.topP,
            reasoning: DEFAULT_PARAMS.reasoning,
            effort: DEFAULT_PARAMS.effort,
            contextLimit: DEFAULT_PARAMS.contextLimit,
            outputLimit: DEFAULT_PARAMS.outputLimit,
            endpointId: DEFAULT_PARAMS.endpointId
        };
        var temp = Number(src.temperature);
        if (isFinite(temp)) out.temperature = Math.round(clamp(temp, 0, 2) * 100) / 100;
        var topP = Number(src.topP != null ? src.topP : src.top_p);
        if (isFinite(topP)) out.topP = Math.round(clamp(topP, 0, 1) * 100) / 100;
        if (typeof src.reasoning === 'boolean') out.reasoning = src.reasoning;
        var effort = String(src.effort || '').toLowerCase();
        out.effort = EFFORTS.indexOf(effort) > -1 ? effort : DEFAULT_PARAMS.effort;
        var ctx = parseCount(src.contextLimit, { min: 1024, max: LIMITS.contextMax });
        if (ctx != null) out.contextLimit = ctx;
        var outLimit = parseCount(src.outputLimit, { min: 256, max: LIMITS.outputMax });
        if (outLimit != null) out.outputLimit = outLimit;
        out.endpointId = typeof src.endpointId === 'string' ? src.endpointId.trim() : '';
        return out;
    }

    function defaultParams() {
        var out = {};
        Object.keys(DEFAULT_PARAMS).forEach(function (key) { out[key] = DEFAULT_PARAMS[key]; });
        return out;
    }

    /* ------------------------------------------------------------------ *
     * 模型输出 → HTML
     * ------------------------------------------------------------------ */
    /**
     * 从模型回复里提取单文件 HTML。
     * 支持 ```html / ``` 围栏、前后有说明文字、直接以 <!DOCTYPE / <html 开头。
     * @returns {{code:string, fenced:boolean}|null}
     */
    function extractHtml(text) {
        var source = String(text == null ? '' : text).replace(/^\ufeff/, '');
        if (!source.trim()) return null;

        var fence = /```(?:html|HTML)\s*\n([\s\S]*?)```/.exec(source);
        if (fence && fence[1] && fence[1].trim()) {
            return { code: fence[1].trim(), fenced: true };
        }
        var generic = /```\s*\n([\s\S]*?)```/.exec(source);
        if (generic && generic[1] && /<([a-z!])[^>]*>/i.test(generic[1])) {
            return { code: generic[1].trim(), fenced: true };
        }
        var start = source.search(/<!doctype\s+html|<html[\s>]/i);
        if (start > -1) {
            var body = source.slice(start);
            var end = body.search(/<\/html\s*>/i);
            if (end > -1) body = body.slice(0, end + 7);
            return { code: body.trim(), fenced: false };
        }
        /* 兜底：模型只给了片段（有标签但不是完整文档）也接受，包装时补壳 */
        var tagStart = source.search(/<(?:div|section|main|body|style|script)\b/i);
        if (tagStart > -1) {
            var snippet = source.slice(tagStart);
            var close = snippet.lastIndexOf('</html>');
            if (close > -1) snippet = snippet.slice(0, close + 7);
            return { code: snippet.trim(), fenced: false };
        }
        return null;
    }

    function escapeAttr(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 沙箱文档里统一注入的主题变量（跟随主应用深/浅色） */
    function themeCss(theme) {
        var dark = theme !== 'light';
        var vars = dark
            ? { bg: '#0b0e13', panel: '#131922', text: '#edf1f7', text2: '#9aa7b8', line: 'rgba(255,255,255,.12)', accent: '#6ea8fe' }
            : { bg: '#f4f5f7', panel: '#ffffff', text: '#15181d', text2: '#56616f', line: 'rgba(0,0,0,.12)', accent: '#2a63c8' };
        return ':root{color-scheme:' + (dark ? 'dark' : 'light') + ';' +
            '--ws-bg:' + vars.bg + ';--ws-panel:' + vars.panel + ';--ws-text:' + vars.text + ';' +
            '--ws-text-2:' + vars.text2 + ';--ws-line:' + vars.line + ';--ws-accent:' + vars.accent + ';}' +
            'html,body{margin:0;padding:0;background:var(--ws-bg);color:var(--ws-text);' +
            "font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;}";
    }

    /** 高度 / 错误回传桥（注入到每个沙箱文档末尾） */
    function bridgeScript() {
        return '<script>(function(){' +
            'function h(){var d=document.documentElement,b=document.body;' +
            'var v=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);' +
            "try{parent.postMessage({type:'nc-ws-height',h:v},'*');}catch(e){}" +
            '}' +
            'try{if(window.ResizeObserver){new ResizeObserver(h).observe(document.documentElement);}' +
            'else{setInterval(h,600);}}catch(e){setInterval(h,600);}' +
            "window.addEventListener('load',h);setTimeout(h,60);setTimeout(h,400);" +
            "window.addEventListener('error',function(e){try{parent.postMessage({type:'nc-ws-error',message:String(e.message||'脚本错误')},'*');}catch(x){}});" +
            "window.addEventListener('unhandledrejection',function(e){var r=e.reason;try{parent.postMessage({type:'nc-ws-error',message:String((r&&r.message)||r||'Promise 错误')},'*');}catch(x){}});" +
            '})();</script>';
    }

    /**
     * 把模型产出的 HTML 包装成沙箱文档。
     * @param {string} code
     * @param {{theme?:string, allowNetwork?:boolean, title?:string}} [options]
     */
    function wrapHtml(code, options) {
        var opts = options || {};
        var allowNetwork = opts.allowNetwork !== false;
        var connect = allowNetwork ? 'http: https:' : "'none'";
        var source = String(code == null ? '' : code).trim();

        var csp = '<meta http-equiv="Content-Security-Policy" content="default-src ' + "'none'" + '; ' +
            'img-src data: blob: http: https:; media-src data: blob: http: https:; ' +
            'style-src ' + "'unsafe-inline'" + ' http: https:; ' +
            'script-src ' + "'unsafe-inline'" + ' http: https:; font-src data: http: https:; ' +
            'connect-src ' + connect + ';' + '">';
        var viewport = '<meta name="viewport" content="width=device-width,initial-scale=1">';
        var theme = '<style>' + themeCss(opts.theme) + '</style>';
        var bridge = bridgeScript();

        /* 完整文档：保留原有 head/body（样式与脚本都在），只补 CSP、主题与高度桥。
         * 之前只取 <body> 内层，导致模型写在 <head> 里的 <style>/<script> 被整段丢掉。 */
        if (/<html[\s>]/i.test(source)) {
            var doc = source.replace(/^\s*<!doctype[^>]*>/i, '');
            if (/<head[^>]*>/i.test(doc)) {
                doc = doc.replace(/<head([^>]*)>/i, '<head$1>' + csp + viewport + theme);
            } else {
                doc = doc.replace(/<html([^>]*)>/i, '<html$1><head>' + csp + viewport + theme + '</head>');
            }
            if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, bridge + '</body>');
            else doc += bridge;
            return '<!DOCTYPE html>' + doc;
        }
        /* 片段：套壳并保留片段里的 <style>/<script> */
        return '<!DOCTYPE html><html><head><meta charset="utf-8">' + viewport + csp +
            '<title>' + escapeAttr(opts.title || '创意工坊') + '</title>' + theme +
            '</head><body>' + source + bridge + '</body></html>';
    }

    function buildSystemPrompt(options) {
        var opts = options || {};
        var allowNetwork = opts.allowNetwork !== false;
        return [
            '你是 nTools 创意工坊的前端生成器。只输出一个完整可运行的单页 HTML 应用。',
            '硬性要求：',
            '1. 只输出一个 ```html 代码块，代码块外不要有任何解释文字。',
            '2. 所有 CSS 与 JavaScript 内联在同一个 HTML 文件里，不使用任何外部依赖、CDN 或外链资源。',
            '3. 图片只能用 data: URL 内联；字体用系统字体。',
            allowNetwork
                ? '4. 可以访问 http/https 接口，但必须处理失败与超时。'
                : '4. 不得发起任何网络请求（fetch/XHR/WebSocket 一律禁止）。',
            '5. 不要使用 top.location、parent、window.open、WebSocket；不要写 <script src> 或 <iframe>。',
            '6. 页面要自适应宽度 ≥ 720px，跟随深/浅色（可用 CSS 变量 --ws-bg/--ws-panel/--ws-text/--ws-accent），不要自动播放声音。',
            '7. 数据只放在内存或 sessionStorage；不要写入 localStorage。',
            '8. 需求不完整时先给一个可用的最小版本，不要反问。'
        ].join('\n');
    }

    /* ------------------------------------------------------------------ *
     * 应用 / 版本归一化
     * ------------------------------------------------------------------ */
    function newId(prefix) {
        return util && util.uid ? util.uid(prefix || 'ws') : (prefix || 'ws') + '-' + Date.now().toString(36);
    }

    function normalizeTitle(raw, fallback) {
        var text = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) text = fallback || '未命名应用';
        return text.length > LIMITS.title ? text.slice(0, LIMITS.title) : text;
    }

    function normalizeApp(raw, ctx) {
        var src = raw && typeof raw === 'object' ? raw : {};
        var now = ctx && isNum(ctx.now) ? ctx.now : Date.now();
        var code = typeof src.code === 'string' ? src.code : '';
        if (code.length > LIMITS.appBytes) code = code.slice(0, LIMITS.appBytes);
        return {
            id: typeof src.id === 'string' && src.id ? src.id : newId('app'),
            title: normalizeTitle(src.title, '未命名应用'),
            code: code,
            createdAt: isNum(src.createdAt) ? src.createdAt : now,
            updatedAt: isNum(src.updatedAt) ? src.updatedAt : now,
            order: isNum(src.order) ? src.order : 0,
            pinned: src.pinned === true,
            model: typeof src.model === 'string' ? src.model.slice(0, 80) : ''
        };
    }

    function normalizeVersion(raw) {
        var src = raw && typeof raw === 'object' ? raw : {};
        return {
            id: typeof src.id === 'string' && src.id ? src.id : newId('ver'),
            appId: typeof src.appId === 'string' ? src.appId : '',
            code: typeof src.code === 'string' ? src.code.slice(0, LIMITS.appBytes) : '',
            label: typeof src.label === 'string' ? src.label.slice(0, 40) : '',
            at: isNum(src.at) ? src.at : Date.now()
        };
    }

    /**
     * 合并「内置工具 + 自定义应用」，按 sort 得到列表。
     * @param {Array} builtins 注册表条目
     * @param {Array} apps 自定义应用
     * @param {{order?:Object, pinned?:Object, sort?:string}} prefs
     */
    function mergeList(builtins, apps, prefs) {
        var p = prefs || {};
        var orderMap = p.order || {};
        var pinMap = p.pinned || {};
        var list = [];
        (Array.isArray(builtins) ? builtins : []).forEach(function (item, index) {
            list.push({
                id: item.id,
                kind: 'builtin',
                category: item.category,
                title: item.title,
                desc: item.desc,
                icon: item.icon,
                file: item.file,
                order: isNum(orderMap[item.id]) ? orderMap[item.id] : item.order != null ? item.order : index,
                pinned: pinMap[item.id] === true
            });
        });
        (Array.isArray(apps) ? apps : []).forEach(function (app) {
            list.push({
                id: app.id,
                kind: 'custom',
                category: 'custom',
                title: app.title,
                desc: '自定义应用',
                icon: 'sparkles',
                code: app.code,
                order: isNum(orderMap[app.id]) ? orderMap[app.id] : (app.order != null ? app.order : 1000),
                pinned: app.pinned === true || pinMap[app.id] === true,
                updatedAt: app.updatedAt
            });
        });
        list.sort(function (a, b) {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            if (a.order !== b.order) return a.order - b.order;
            return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
        });
        return list;
    }

    NC.schema = NC.schema || {};
    NC.schema.workshop = {
        DOC_VERSION: DOC_VERSION,
        LIMITS: LIMITS,
        DEFAULT_PARAMS: DEFAULT_PARAMS,
        EFFORTS: EFFORTS,
        parseCount: parseCount,
        formatCount: formatCount,
        normalizeParams: normalizeParams,
        defaultParams: defaultParams,
        extractHtml: extractHtml,
        wrapHtml: wrapHtml,
        themeCss: themeCss,
        bridgeScript: bridgeScript,
        buildSystemPrompt: buildSystemPrompt,
        normalizeApp: normalizeApp,
        normalizeVersion: normalizeVersion,
        normalizeTitle: normalizeTitle,
        mergeList: mergeList,
        newId: newId
    };
})(window);
