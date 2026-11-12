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

    function buildEndpoint(baseUrl) {
        var base = String(baseUrl == null ? '' : baseUrl).trim();
        if (!base) return '';
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
        return {
            baseUrl: baseUrl,
            apiKey: apiKey,
            modelId: modelId
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

    function readContent(data) {
        if (!data || typeof data !== 'object') return '';
        var choice = data.choices && data.choices[0];
        if (choice) {
            if (choice.message && choice.message.content != null) return normalizeContent(choice.message.content);
            if (choice.delta && choice.delta.content != null) return normalizeContent(choice.delta.content);
            if (choice.text != null) return String(choice.text);
        }
        if (typeof data.output_text === 'string') return data.output_text;
        return '';
    }

    function normalizeContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map(function (part) {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                return '';
            }).join('');
        }
        if (content == null) return '';
        return String(content);
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
        if (!messages.length) {
            return Promise.resolve({ ok: false, error: { type: 'config', message: '缺少要发送的内容' } });
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

        var url = buildEndpoint(profile.baseUrl);
        return global.fetch(url, {
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
                var content = readContent(data);
                if (!content) {
                    throw { __http: { type: 'parse', message: '模型返回为空或格式不受支持' } };
                }
                return {
                    ok: true,
                    text: content.length > MAX_RESPONSE_CHARS ? content.slice(0, MAX_RESPONSE_CHARS) : content,
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
        normalizeMessages: normalizeMessages
    };
})(window);
