/**
 * ai.js — 一次性（非流式）模型调用与 JSON 提取
 * 经典脚本，依赖 core.js。挂载：NC.ai
 *
 * 用途：Todo 文本识别、设置面板“测试连接”等短任务；聊天流式仍走 NC.api.chat。
 * 所有失败都以 {ok:false,error} 返回，不向上 throw，不产生 console.error。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var DEFAULT_TIMEOUT = 60000;
    var MAX_RESPONSE_CHARS = 200000;

    var THINK_PAIRS = [
        { open: '<think>', close: '</think>' },
        { open: '<thinking>', close: '</thinking>' },
        { open: '<\uff5cDSML\uff5cthinking>', close: '</\uff5cDSML\uff5cthinking>' },
        { open: '<|DSML|thinking>', close: '</|DSML|thinking>' },
        { open: '<reasoning>', close: '</reasoning>' }
    ];

    function normalizeApiFormat(value) {
        var text = value == null ? '' : String(value).trim().toLowerCase();
        return text === 'bocai' ? 'bocai' : 'openai';
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 剥离 content 中内嵌的思考块（<think>/<thinking>/<reasoning>/｜DSML｜thinking）。
     * 未闭合的思考块从开标签处截断；思考正文单独返回，供调用方记录/调试。
     */
    function stripThinkTags(value) {
        var text = typeof value === 'string' ? value : String(value == null ? '' : value);
        var reasoning = '';
        THINK_PAIRS.forEach(function (pair) {
            var re = new RegExp(escapeRegExp(pair.open) + '\\s*([\\s\\S]*?)\\s*' + escapeRegExp(pair.close), 'gi');
            text = text.replace(re, function (match, inner) {
                if (inner) reasoning += inner;
                return '';
            });
            // 未闭合：开标签到文本结尾全部视为思考内容
            var lower = text.toLowerCase();
            var openAt = lower.indexOf(pair.open.toLowerCase());
            if (openAt !== -1) {
                var tail = text.slice(openAt + pair.open.length);
                if (tail) reasoning += tail;
                text = text.slice(0, openAt);
            }
        });
        // 残留的孤立闭合标签不应出现在正文
        THINK_PAIRS.forEach(function (pair) {
            text = text.replace(new RegExp(escapeRegExp(pair.close), 'gi'), '');
        });
        return { text: text.trim(), reasoning: reasoning.trim() };
    }

    function contentParts(value) {
        if (typeof value === 'string') return { text: value, reasoning: '' };
        if (value == null) return { text: '', reasoning: '' };
        if (Array.isArray(value)) {
            var texts = [];
            var reasons = [];
            value.forEach(function (part) {
                var parsed = contentParts(part);
                texts.push(parsed.text);
                reasons.push(parsed.reasoning);
            });
            return { text: texts.join(''), reasoning: reasons.join('') };
        }
        if (typeof value === 'object') {
            var kind = String(value.type == null ? '' : value.type).toLowerCase().replace(/-/g, '_');
            var raw = value.text;
            if (raw == null) raw = value.content;
            if (raw == null) raw = value.value;
            if (raw == null) raw = value.output_text;
            if (raw == null) raw = value.summary;
            if (raw == null) raw = value.delta;
            var parsedValue = contentParts(raw);
            var reasoningKind = kind.indexOf('reasoning') === 0 || kind.indexOf('thinking') === 0 ||
                kind === 'analysis' || kind === 'reasoning_text';
            if (reasoningKind) return { text: '', reasoning: parsedValue.reasoning + parsedValue.text };
            if (!parsedValue.text && !parsedValue.reasoning) {
                var keys = ['thinking', 'reasoning', 'reasoning_content'];
                for (var i = 0; i < keys.length; i += 1) {
                    if (keys[i] in value) {
                        var nested = contentParts(value[keys[i]]);
                        return { text: '', reasoning: nested.reasoning + nested.text };
                    }
                }
            }
            return parsedValue;
        }
        return { text: String(value), reasoning: '' };
    }

    function hasImageContent(messages) {
        if (!Array.isArray(messages)) return false;
        for (var i = 0; i < messages.length; i += 1) {
            var message = messages[i];
            if (!message || !Array.isArray(message.content)) continue;
            for (var j = 0; j < message.content.length; j += 1) {
                var part = message.content[j];
                if (part && typeof part === 'object' && part.type === 'image_url') return true;
            }
        }
        return false;
    }

    function buildEndpoint(baseUrl) {
        var base = String(baseUrl == null ? '' : baseUrl).trim();
        if (!base || /[\s\u0000-\u001f]/.test(base)) return '';
        base = base.replace(/\/+$/, '');
        if (/\/chat\/completions$/i.test(base)) return base;
        return base + '/chat/completions';
    }

    function normalizeMessages(options) {
        var opts = options || {};
        var list = [];
        if (opts.systemPrompt) {
            list.push({ role: 'system', content: String(opts.systemPrompt) });
        }
        if (Array.isArray(opts.messages) && opts.messages.length) {
            opts.messages.forEach(function (message) {
                if (!message || !message.role) return;
                if (message.role === 'system') {
                    if (message.content) list.push({ role: 'system', content: String(message.content) });
                    return;
                }
                if (message.role === 'user' || message.role === 'assistant') {
                    list.push({ role: message.role, content: message.content });
                }
            });
        } else if (opts.userText != null && String(opts.userText).length) {
            list.push({ role: 'user', content: String(opts.userText) });
        }
        return list;
    }

    function readProfile(options) {
        var opts = options || {};
        var source = opts.profile || opts.config || {};
        var baseUrl = source.baseUrl || source.apiUrl || '';
        var apiKey = source.apiKey || '';
        var modelId = source.modelId || source.model || '';
        var sessionId = source.sessionId || source.id || source.profileId || '';
        return {
            id: source.id || source.profileId || '',
            baseUrl: baseUrl,
            apiKey: apiKey,
            modelId: modelId,
            apiFormat: normalizeApiFormat(source.apiFormat || source.api_format),
            sessionId: String(sessionId || '')
        };
    }

    function extractErrorBody(text) {
        if (!text) return '';
        var trimmed = String(text).trim();
        try {
            var data = JSON.parse(trimmed);
            var error = data && data.error;
            if (typeof error === 'string') return error.slice(0, 500);
            if (error && error.message) return String(error.message).slice(0, 500);
            if (data && data.message) return String(data.message).slice(0, 500);
        } catch (err) { /* 非 JSON 错误体 */ }
        return trimmed.slice(0, 500);
    }

    function mapHttpError(status, text) {
        var detail = extractErrorBody(text);
        if (status === 401 || status === 403) {
            return { type: 'auth', message: '鉴权失败（HTTP ' + status + '）：请检查 API Key' + (detail ? '；' + detail : ''), status: status };
        }
        if (status === 404) {
            return { type: 'config', message: '接口不存在（HTTP 404）：请检查 Base URL 与 Model ID' + (detail ? '；' + detail : ''), status: status };
        }
        if (status === 429) {
            return { type: 'rate', message: '请求过于频繁或额度不足（HTTP 429）' + (detail ? '；' + detail : ''), status: status };
        }
        return { type: 'server', message: '服务错误（HTTP ' + status + '）' + (detail ? '：' + detail : ''), status: status };
    }

    /**
     * 从非流式响应中读取正文/思考。兼容：
     * - choices[0].message / choices[0].delta / choices[0].text；
     * - content 为字符串或多模态/推理 part 数组；
     * - reasoning_content / reasoning / thinking / reasoning_details；
     * - 顶层 output_text；
     * 最后剥离 content 中内嵌的思考标签。
     */
    function readResponseContent(data) {
        if (!data || typeof data !== 'object') return { text: '', reasoning: '' };
        var choice = data.choices && data.choices[0];
        if (choice) {
            var source = (choice.message && typeof choice.message === 'object')
                ? choice.message
                : ((choice.delta && typeof choice.delta === 'object') ? choice.delta : choice);
            var parsed = contentParts(source.content);
            if (!parsed.text) {
                var fallbackValue = source.text != null ? source.text : choice.text;
                var fallback = contentParts(fallbackValue);
                parsed.text = fallback.text;
                parsed.reasoning += fallback.reasoning;
            }
            var seen = [];
            ['reasoning_content', 'reasoning', 'thinking', 'thinking_content', 'reasoning_details'].forEach(function (key) {
                if (!source || !(key in source)) return;
                var part = contentParts(source[key]);
                var fragment = part.reasoning + part.text;
                if (fragment && seen.indexOf(fragment) === -1) {
                    seen.push(fragment);
                    parsed.reasoning += fragment;
                }
            });
            var stripped = stripThinkTags(parsed.text);
            return { text: stripped.text, reasoning: parsed.reasoning + stripped.reasoning };
        }
        if (data.output_text != null) {
            var output = contentParts(data.output_text);
            var cleaned = stripThinkTags(output.text);
            return { text: cleaned.text, reasoning: output.reasoning + cleaned.reasoning };
        }
        return { text: '', reasoning: '' };
    }

    function readUsage(data) {
        var usage = data && data.usage;
        if (!usage || typeof usage !== 'object') return null;
        return {
            promptTokens: Number(usage.prompt_tokens) || 0,
            completionTokens: Number(usage.completion_tokens) || 0,
            totalTokens: Number(usage.total_tokens) || 0
        };
    }

    /**
     * 一次性补全。
     * @returns Promise<{ok:true,text,usage,latencyMs}|{ok:false,error}>
     */
    function complete(options) {
        var opts = options || {};
        var profile = readProfile(opts);
        var messages = normalizeMessages(opts);
        var started = Date.now();

        if (!profile.baseUrl) {
            return Promise.resolve({ ok: false, error: { type: 'config', message: '未配置模型端点（Base URL）' } });
        }
        if (!profile.modelId) {
            return Promise.resolve({ ok: false, error: { type: 'config', message: '未配置 Model ID' } });
        }
        var endpoint = buildEndpoint(profile.baseUrl);
        if (!endpoint) {
            return Promise.resolve({ ok: false, error: { type: 'config', message: 'Base URL 无效，请检查配置' } });
        }
        if (!messages.length) {
            return Promise.resolve({ ok: false, error: { type: 'config', message: '缺少要发送的内容' } });
        }
        if (profile.apiFormat === 'bocai' && hasImageContent(messages)) {
            return Promise.resolve({
                ok: false,
                error: {
                    type: 'unsupported',
                    message: '当前端点 API 格式为 bocai，参考实现不支持图片输入；请改用 openai 格式端点，或移除图片后重试'
                }
            });
        }

        var payload = {
            model: profile.modelId,
            messages: messages,
            stream: false
        };
        var temperature = Number(opts.temperature);
        var topP = Number(opts.topP);
        if (isFinite(temperature)) payload.temperature = Math.min(2, Math.max(0, temperature));
        if (isFinite(topP)) payload.top_p = Math.min(2, Math.max(0, topP));
        if (profile.apiFormat === 'bocai' && profile.sessionId) payload.sessionId = profile.sessionId;

        var headers = { 'Content-Type': 'application/json' };
        if (profile.apiKey) headers.Authorization = 'Bearer ' + profile.apiKey;

        var controller = new AbortController();
        var timedOut = false;
        var abortByCaller = false;
        var timeoutMs = opts.timeoutMs == null ? DEFAULT_TIMEOUT : opts.timeoutMs;
        var timer = null;
        if (timeoutMs > 0) {
            timer = setTimeout(function () {
                timedOut = true;
                try { controller.abort(); } catch (err) { /* ignore */ }
            }, timeoutMs);
        }
        var onCallerAbort = null;
        if (opts.signal) {
            if (opts.signal.aborted) {
                abortByCaller = true;
                try { controller.abort(); } catch (err) { /* ignore */ }
            } else if (typeof opts.signal.addEventListener === 'function') {
                onCallerAbort = function () {
                    abortByCaller = true;
                    try { controller.abort(); } catch (err) { /* ignore */ }
                };
                opts.signal.addEventListener('abort', onCallerAbort);
            }
        }

        function cleanup() {
            if (timer) clearTimeout(timer);
            if (onCallerAbort && opts.signal && typeof opts.signal.removeEventListener === 'function') {
                opts.signal.removeEventListener('abort', onCallerAbort);
            }
        }

        return global.fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        }).then(function (response) {
            return response.text().then(function (text) {
                if (!response.ok) {
                    throw { __http: mapHttpError(response.status, text) };
                }
                var data = null;
                try {
                    data = JSON.parse(text);
                } catch (err) {
                    throw { __http: { type: 'parse', message: '返回内容不是合法 JSON（可能是网关错误页）' } };
                }
                var content = readResponseContent(data);
                if (!content.text) {
                    throw { __http: { type: 'parse', message: '模型返回为空或格式不受支持' } };
                }
                return {
                    ok: true,
                    text: content.text.length > MAX_RESPONSE_CHARS ? content.text.slice(0, MAX_RESPONSE_CHARS) : content.text,
                    reasoning: content.reasoning,
                    usage: readUsage(data),
                    latencyMs: Date.now() - started,
                    raw: data
                };
            });
        }).catch(function (error) {
            if (error && error.__http) {
                return { ok: false, error: error.__http, latencyMs: Date.now() - started };
            }
            if (abortByCaller || (error && error.name === 'AbortError')) {
                if (timedOut) {
                    return { ok: false, error: { type: 'timeout', message: '请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）' }, latencyMs: Date.now() - started };
                }
                return { ok: false, error: { type: 'aborted', message: '请求已取消' }, latencyMs: Date.now() - started };
            }
            if (timedOut) {
                return { ok: false, error: { type: 'timeout', message: '请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）' }, latencyMs: Date.now() - started };
            }
            return {
                ok: false,
                error: { type: 'network', message: '网络请求失败：' + ((error && error.message) || '未知错误') + '（file:// 下请确认网关 CORS 放行 Origin: null）' },
                latencyMs: Date.now() - started
            };
        }).then(function (result) {
            cleanup();
            return result;
        }, function (error) {
            cleanup();
            return { ok: false, error: { type: 'network', message: '网络请求失败：' + ((error && error.message) || '未知错误') } };
        });
    }

    /**
     * 从模型输出中提取第一个 JSON 对象/数组（容忍 ```json 围栏、前后说明文字）。
     * @returns {Object|Array|null}
     */
    function extractJson(text) {
        if (text == null) return null;
        var source = String(text);
        if (!source.trim()) return null;

        // 1) 优先代码围栏
        var fence = source.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
        if (fence && fence[1]) {
            var fenced = tryParse(fence[1].trim());
            if (fenced !== undefined) return fenced;
        }
        // 2) 整段就是 JSON
        var whole = tryParse(source.trim());
        if (whole !== undefined) return whole;
        // 3) 扫描第一个平衡对象/数组（字符串与转义感知）
        var start = -1;
        for (var i = 0; i < source.length; i += 1) {
            var ch = source.charAt(i);
            if (ch === '{' || ch === '[') {
                start = i;
                break;
            }
        }
        if (start === -1) return null;
        var open = source.charAt(start);
        var close = open === '{' ? '}' : ']';
        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var j = start; j < source.length; j += 1) {
            var c = source.charAt(j);
            if (inString) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') inString = false;
                continue;
            }
            if (c === '"') { inString = true; continue; }
            if (c === open) depth += 1;
            else if (c === close) {
                depth -= 1;
                if (depth === 0) {
                    var slice = source.slice(start, j + 1);
                    var parsed = tryParse(slice);
                    return parsed === undefined ? null : parsed;
                }
            }
        }
        return null;
    }

    function tryParse(text) {
        try {
            var value = JSON.parse(text);
            return value == null ? undefined : value;
        } catch (err) {
            return undefined;
        }
    }

    function testProfile(profile) {
        return complete({
            profile: profile,
            systemPrompt: '你是连通性测试助手。',
            userText: '请只回复：ok',
            temperature: 0,
            topP: 0.1,
            timeoutMs: 20000
        }).then(function (result) {
            if (!result.ok) {
                return { ok: false, latencyMs: result.latencyMs, message: result.error.message };
            }
            return {
                ok: true,
                latencyMs: result.latencyMs,
                message: '连接成功（' + Math.round(result.latencyMs) + ' ms）：' + String(result.text).trim().slice(0, 60)
            };
        });
    }

    NC.ai = {
        DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
        complete: complete,
        extractJson: extractJson,
        testProfile: testProfile,
        buildEndpoint: buildEndpoint,
        normalizeMessages: normalizeMessages,
        normalizeApiFormat: normalizeApiFormat,
        stripThinkTags: stripThinkTags,
        hasImageContent: hasImageContent,
        contentParts: contentParts,
        readResponseContent: readResponseContent
    };
})(window);
