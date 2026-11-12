/**
 * api.js — OpenAI 兼容接口：URL / payload 构造、SSE 流式请求、超时/中止/错误映射
 * 经典脚本，依赖 core.js、sse.js、schema-chat.js（可选）。挂载到 NC.api。
 *
 * 安全：payload 只发送 {role, content} 白名单字段；绝不把 reasoning/stats 回传给服务端。
 *
 * 测试接口（tests.html 使用）：
 *   buildUrl(base)                        → String（非法返回 ''）
 *   buildPayload({config, messages, stream, includeUsage}) → Object
 *   estimateTokens(text)                  → Number
 *   normalizeMessageForApi(msg)           → {role,content}|null
 *   createThinkFilter({onAnswer,onReasoning}) → {feed(text), end(), isThinking()}
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var DEFAULTS = {
        idleTimeout: 45000,
        maxBodyPreview: 2000
    };

    var IMAGE_FALLBACK_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;
    var CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

    function allowedImage(url) {
        var schema = NC.schema && NC.schema.chat;
        if (schema && schema.isAllowedImageUrl) return schema.isAllowedImageUrl(url);
        return typeof url === 'string' && IMAGE_FALLBACK_RE.test(url);
    }

    function normalizeUserContent(content) {
        if (typeof content === 'string') {
            return content ? [{ type: 'text', text: content }] : [];
        }
        if (!Array.isArray(content)) return [];
        var out = [];
        content.forEach(function (part) {
            if (!part || typeof part !== 'object') return;
            if (part.type === 'text' && typeof part.text === 'string' && part.text) {
                out.push({ type: 'text', text: part.text });
            } else if (part.type === 'image_url') {
                var url = part.image_url && typeof part.image_url === 'object' ? part.image_url.url : null;
                if (allowedImage(url)) out.push({ type: 'image_url', image_url: { url: url } });
            }
        });
        return out;
    }

    function normalizeMessageForApi(message) {
        if (!message || typeof message !== 'object') return null;
        var role = message.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;
        if (role === 'system') {
            var system = typeof message.content === 'string' ? message.content : '';
            return system ? { role: 'system', content: system } : null;
        }
        if (role === 'user') {
            var content = normalizeUserContent(message.content);
            return content.length ? { role: 'user', content: content } : null;
        }
        var answer = typeof message.content === 'string' ? message.content : '';
        return answer ? { role: 'assistant', content: answer } : null;
    }

    /** Base URL 归一化：去尾斜杠、必要时补 /chat/completions；非法返回 ''。 */
    function buildUrl(base) {
        if (typeof base !== 'string') return '';
        var value = base.trim();
        if (!value || /[\s\u0000-\u001f]/.test(value)) return '';
        value = value.replace(/\/+$/, '');
        if (!/\/chat\/completions$/i.test(value)) value += '/chat/completions';
        return value;
    }

    function buildPayload(options) {
        var opts = options || {};
        var config = opts.config || {};
        var messages = [];
        var systemPrompt = typeof config.systemPrompt === 'string' ? config.systemPrompt.trim() : '';
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        (Array.isArray(opts.messages) ? opts.messages : []).forEach(function (message) {
            var normalized = normalizeMessageForApi(message);
            if (normalized) messages.push(normalized);
        });
        var payload = {
            model: typeof config.modelId === 'string' ? config.modelId : '',
            messages: messages,
            stream: opts.stream !== false
        };
        if (config.enableAdvanced) {
            var temperature = Number(config.temperature);
            var topP = Number(config.top_p);
            if (isFinite(temperature) && temperature >= 0 && temperature <= 2) payload.temperature = temperature;
            if (isFinite(topP) && topP >= 0 && topP <= 2) payload.top_p = topP;
        }
        if (opts.stream !== false && opts.includeUsage) {
            payload.stream_options = { include_usage: true };
        }
        return payload;
    }

    function estimateTokens(value) {
        var text = value == null ? '' : String(value);
        if (!text) return 0;
        var cjk = 0;
        for (var i = 0; i < text.length; i += 1) {
            if (CJK_RE.test(text.charAt(i))) cjk += 1;
        }
        return Math.max(1, Math.ceil(cjk * 1.6 + (text.length - cjk) / 4));
    }

    function estimateMessagesTokens(messages) {
        if (!Array.isArray(messages)) return 0;
        var total = 0;
        messages.forEach(function (message) {
            if (!message) return;
            if (message.role === 'user' && Array.isArray(message.content)) {
                message.content.forEach(function (part) {
                    if (part && part.type === 'text') total += estimateTokens(part.text);
                    else if (part && part.type === 'image_url') total += 500;
                });
            } else {
                total += estimateTokens(message.content);
            }
            total += 4;
        });
        return total;
    }

    function computeStats(options) {
        var opts = options || {};
        var usage = opts.usage || {};
        var prompt = isFinite(usage.prompt) ? Math.max(0, Math.round(usage.prompt)) : 0;
        var completion = isFinite(usage.completion) ? Math.max(0, Math.round(usage.completion)) : 0;
        var total = isFinite(usage.total) ? Math.max(0, Math.round(usage.total)) : prompt + completion;
        var estimated = false;
        if (!prompt && !completion && !total) {
            estimated = true;
            prompt = estimateMessagesTokens(opts.messages);
            completion = estimateTokens(opts.content);
            total = prompt + completion;
        }
        var first = opts.firstTokenAt || opts.startedAt || 0;
        var end = opts.endedAt || Date.now();
        var duration = first ? Math.max(0, (end - first) / 1000) : 0;
        var rate = duration > 0 ? Math.max(0, (total - prompt) / duration) : 0;
        return {
            contextLength: prompt,
            outputLength: completion,
            totalLength: total,
            outputRate: Math.round(rate * 10) / 10,
            outputTime: Math.round(duration * 10) / 10,
            estimated: estimated
        };
    }

    function safeText(response, limit) {
        try {
            return response.text().then(function (text) {
                return String(text == null ? '' : text).slice(0, limit);
            }).catch(function () { return ''; });
        } catch (err) {
            return Promise.resolve('');
        }
    }

    function extractErrorMessage(body, statusText) {
        if (!body) return statusText || '请求失败';
        try {
            var data = JSON.parse(body);
            if (data && data.error) {
                if (typeof data.error === 'string' && data.error) return data.error;
                if (typeof data.error.message === 'string' && data.error.message) return data.error.message;
            }
            if (data && typeof data.message === 'string' && data.message) return data.message;
        } catch (err) { /* 非 JSON 错误体 */ }
        return body.slice(0, 300) || statusText || '请求失败';
    }

    function mapNetworkError(error) {
        var suffix = error && error.message ? '（' + error.message + '）' : '';
        var isFile = global.location && global.location.protocol === 'file:';
        if (isFile) {
            return '无法连接服务：可能网络不可达，或网关未放行 CORS（file:// 请求的 Origin 为 null）' + suffix;
        }
        return '网络错误或服务不可用' + suffix;
    }

    /**
     * 思考标签跨 chunk 状态机：处理 <think>…</think>，并把被 chunk 截断的半个标签留到下一
     * 个 chunk，避免标签碎片漏进正文/思考文本。结构化 reasoning_content 不经过本过滤器。
     */
    function createThinkFilter(handlers) {
        var h = handlers || {};
        var OPEN = '<think>';
        var CLOSE = '</think>';
        var inThink = false;
        var carry = '';

        function emit(fn, value) {
            if (!value || typeof fn !== 'function') return;
            fn(value);
        }

        function prefixSuffixLength(text, tag) {
            var max = Math.min(text.length, tag.length - 1);
            for (var len = max; len > 0; len -= 1) {
                if (text.slice(text.length - len) === tag.slice(0, len)) return len;
            }
            return 0;
        }

        function feed(text) {
            if (typeof text !== 'string' || !text) return;
            var buf = carry + text;
            carry = '';
            var guard = 0;
            while (buf && guard < 500) {
                guard += 1;
                if (inThink) {
                    var closeAt = buf.indexOf(CLOSE);
                    if (closeAt !== -1) {
                        emit(h.onReasoning, buf.slice(0, closeAt));
                        buf = buf.slice(closeAt + CLOSE.length);
                        inThink = false;
                        continue;
                    }
                    var keepClose = prefixSuffixLength(buf, CLOSE);
                    emit(h.onReasoning, keepClose ? buf.slice(0, buf.length - keepClose) : buf);
                    carry = keepClose ? buf.slice(buf.length - keepClose) : '';
                    buf = '';
                } else {
                    var openAt = buf.indexOf(OPEN);
                    if (openAt !== -1) {
                        emit(h.onAnswer, buf.slice(0, openAt));
                        buf = buf.slice(openAt + OPEN.length);
                        inThink = true;
                        continue;
                    }
                    var keepOpen = prefixSuffixLength(buf, OPEN);
                    emit(h.onAnswer, keepOpen ? buf.slice(0, buf.length - keepOpen) : buf);
                    carry = keepOpen ? buf.slice(buf.length - keepOpen) : '';
                    buf = '';
                }
            }
            if (buf) emit(inThink ? h.onReasoning : h.onAnswer, buf);
        }

        function end() {
            if (carry) emit(inThink ? h.onReasoning : h.onAnswer, carry);
            carry = '';
        }

        return {
            feed: feed,
            end: end,
            isThinking: function () { return inThink; }
        };
    }

    function call(fn, payload) {
        if (typeof fn !== 'function') return;
        try {
            fn(payload);
        } catch (err) {
            console.error('[NC] api callback error:', err);
        }
    }

    function normalizeUsage(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var prompt = Number(raw.prompt_tokens);
        var completion = Number(raw.completion_tokens);
        var total = Number(raw.total_tokens);
        if (!isFinite(prompt) && !isFinite(completion) && !isFinite(total)) return null;
        return {
            prompt: isFinite(prompt) ? prompt : 0,
            completion: isFinite(completion) ? completion : 0,
            total: isFinite(total) ? total : (isFinite(prompt) ? prompt : 0) + (isFinite(completion) ? completion : 0)
        };
    }

    /**
     * 单次流式请求（内部）。永不 reject；返回：
     * { ok, retryable?, aborted?, error?, stats?, usage?, timing?, finishReason?, content?, reasoning? }
     */
    async function streamOnce(options, includeUsage) {
        var opts = options || {};
        var config = opts.config || {};
        var url = buildUrl(config.apiUrl);
        if (!url) {
            return { ok: false, error: { type: 'config', message: 'Base URL 无效，请检查配置' } };
        }
        var model = typeof config.modelId === 'string' ? config.modelId.trim() : '';
        if (!model) {
            return { ok: false, error: { type: 'config', message: 'Model ID 未填写，请检查配置' } };
        }

        var hasAbort = typeof global.AbortController === 'function';
        var controller = hasAbort ? new global.AbortController() : null;
        var externalOff = null;
        var aborted = false;
        var timedOut = false;
        var idleTimer = null;
        var sawAnyData = false;
        var gotOutput = false;
        var usage = null;
        var firstTokenAt = 0;
        var startedAt = Date.now();
        var finishReason = null;
        var answerText = '';
        var reasoningText = '';

        function onExternalAbort() {
            aborted = true;
            if (controller) controller.abort();
        }

        function cleanup() {
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            if (opts.signal && externalOff) externalOff();
        }

        function resetIdle() {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(function () {
                timedOut = true;
                if (controller) controller.abort();
            }, DEFAULTS.idleTimeout);
        }

        function markOutput() {
            if (!firstTokenAt) firstTokenAt = Date.now();
            gotOutput = true;
        }

        var thinkFilter = createThinkFilter({
            onAnswer: function (text) {
                if (!text) return;
                answerText += text;
                markOutput();
                call(opts.onDelta, text);
            },
            onReasoning: function (text) {
                if (!text) return;
                reasoningText += text;
                markOutput();
                call(opts.onReasoning, text);
            }
        });

        var apiErrorMessage = '';
        var parser = null;

        function handleData(dataText) {
            sawAnyData = true;
            var json;
            try {
                json = JSON.parse(dataText);
            } catch (err) {
                return; // 单条坏事件不终止流
            }
            if (!json || typeof json !== 'object') return;
            var normalizedUsage = normalizeUsage(json.usage);
            if (normalizedUsage) {
                usage = normalizedUsage;
                call(opts.onUsage, normalizedUsage);
            }
            if (json.error) {
                apiErrorMessage = (json.error && json.error.message) || 'API 返回错误';
                return;
            }
            var choices = Array.isArray(json.choices) ? json.choices : [];
            var choice = choices[0];
            if (!choice) return;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            var delta = choice.delta || {};
            var reasoning = delta.reasoning_content != null ? delta.reasoning_content : delta.reasoning;
            if (typeof reasoning === 'string' && reasoning) {
                reasoningText += reasoning;
                markOutput();
                call(opts.onReasoning, reasoning);
            }
            if (typeof delta.content === 'string' && delta.content) {
                thinkFilter.feed(delta.content);
            }
        }

        parser = NC.sse.createParser({ onEvent: handleData });

        var requestHeaders = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
        };
        var apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
        if (apiKey) requestHeaders.Authorization = 'Bearer ' + apiKey;

        try {
            if (opts.signal) {
                if (opts.signal.aborted) {
                    aborted = true;
                    return { ok: true, aborted: true, usage: null, content: '', reasoning: '' };
                }
                opts.signal.addEventListener('abort', onExternalAbort);
                externalOff = function () { opts.signal.removeEventListener('abort', onExternalAbort); };
            }

            resetIdle();
            var response;
            try {
                response = await global.fetch(url, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(buildPayload({
                        config: config,
                        messages: opts.messages,
                        stream: true,
                        includeUsage: includeUsage
                    })),
                    signal: controller ? controller.signal : undefined
                });
            } catch (error) {
                if (aborted) return { ok: true, aborted: true, usage: null, content: '', reasoning: '' };
                if (timedOut) return { ok: false, error: { type: 'timeout', message: '请求超时：连接或首包超时' } };
                return { ok: false, error: { type: 'network', message: mapNetworkError(error), error: error } };
            }

            if (!response.ok) {
                var body = await safeText(response, DEFAULTS.maxBodyPreview);
                if (includeUsage && !gotOutput && (response.status === 400 || response.status === 422)) {
                    return { ok: false, retryable: true };
                }
                return {
                    ok: false,
                    error: {
                        type: 'http',
                        status: response.status,
                        statusText: response.statusText,
                        body: body,
                        message: extractErrorMessage(body, response.statusText)
                    }
                };
            }

            if (response.body && typeof response.body.getReader === 'function' && typeof global.TextDecoder === 'function') {
                var reader = response.body.getReader();
                var decoder = new global.TextDecoder('utf-8');
                // 兜底：即使 fetch 实现未把 signal 传播到 body 流，也主动取消读取
                var abortHook = function () {
                    aborted = true;
                    try { reader.cancel(); } catch (err) { /* ignore */ }
                };
                if (controller) controller.signal.addEventListener('abort', abortHook);
                try {
                    while (true) {
                        var chunk = await reader.read();
                        if (chunk.done) break;
                        resetIdle();
                        parser.feed(decoder.decode(chunk.value, { stream: true }));
                        if (parser.isDone() || apiErrorMessage) {
                            try { reader.cancel(); } catch (err) { /* ignore */ }
                            break;
                        }
                    }
                    if (!parser.isDone()) parser.end();
                } catch (error) {
                    if (timedOut) return { ok: false, error: { type: 'timeout', message: '请求超时：数据流中断' } };
                    if (aborted) return { ok: true, aborted: true, usage: usage, content: answerText, reasoning: reasoningText };
                    return { ok: false, error: { type: 'network', message: mapNetworkError(error), error: error } };
                } finally {
                    if (controller) controller.signal.removeEventListener('abort', abortHook);
                }
            } else {
                // 非流式回退：一次性读取后按 SSE 解析
                var fullText = await safeText(response, 8 * 1024 * 1024);
                parser.feed(fullText);
                parser.end();
            }

            thinkFilter.end();

            if (timedOut) return { ok: false, error: { type: 'timeout', message: '请求超时：长时间未收到数据' } };
            if (aborted) {
                return { ok: true, aborted: true, usage: usage, content: answerText, reasoning: reasoningText };
            }
            if (apiErrorMessage) return { ok: false, error: { type: 'api', message: apiErrorMessage } };
            if (!sawAnyData) return { ok: false, error: { type: 'empty', message: '服务端未返回有效的流式数据（可能是非 SSE 响应）' } };

            var endedAt = Date.now();
            var stats = computeStats({
                usage: usage,
                messages: opts.messages,
                content: answerText,
                firstTokenAt: firstTokenAt,
                startedAt: startedAt,
                endedAt: endedAt
            });
            return {
                ok: true,
                stats: stats,
                usage: usage,
                content: answerText,
                reasoning: reasoningText,
                finishReason: finishReason,
                timing: { startedAt: startedAt, firstTokenAt: firstTokenAt, endedAt: endedAt }
            };
        } finally {
            cleanup();
        }
    }

    /**
     * 发起流式对话。回调：onDelta(text) / onReasoning(text) / onUsage({prompt,completion,total})
     * onDone({aborted, stats, usage, content, reasoning, finishReason}) / onError({type,message,status,body})
     * @returns {{abort: Function}}
     */
    function chat(options) {
        var opts = options || {};
        var localController = typeof global.AbortController === 'function' ? new global.AbortController() : null;
        var abortedByCaller = false;
        var settled = false;

        function forwardAbort() {
            abortedByCaller = true;
            if (localController) localController.abort();
        }

        if (opts.signal) {
            if (opts.signal.aborted) forwardAbort();
            else opts.signal.addEventListener('abort', forwardAbort);
        }

        function settleDone(payload) {
            if (settled) return;
            settled = true;
            if (opts.signal) opts.signal.removeEventListener('abort', forwardAbort);
            call(opts.onDone, payload);
        }

        function settleError(payload) {
            if (settled) return;
            settled = true;
            if (opts.signal) opts.signal.removeEventListener('abort', forwardAbort);
            call(opts.onError, payload);
        }

        (async function run() {
            var signal = localController ? localController.signal : (opts.signal || null);
            var runOpts = {
                config: opts.config,
                messages: opts.messages,
                signal: signal,
                onDelta: function (text) { call(opts.onDelta, text); },
                onReasoning: function (text) { call(opts.onReasoning, text); },
                onUsage: function (usage) { call(opts.onUsage, usage); }
            };
            var result = await streamOnce(runOpts, true);
            if (result && result.retryable) {
                result = await streamOnce(runOpts, false);
            }
            if (settled) return;
            if (!result) {
                settleError({ type: 'unknown', message: '请求失败（未知错误）' });
                return;
            }
            if (result.ok) {
                settleDone({
                    aborted: !!result.aborted,
                    stats: result.stats || null,
                    usage: result.usage || null,
                    content: result.content || '',
                    reasoning: result.reasoning || '',
                    finishReason: result.finishReason || null,
                    timing: result.timing || null
                });
            } else {
                settleError(result.error || { type: 'unknown', message: '请求失败' });
            }
        })();

        return {
            abort: function () {
                forwardAbort();
            }
        };
    }

    NC.api = {
        DEFAULTS: DEFAULTS,
        chat: chat,
        buildUrl: buildUrl,
        buildPayload: buildPayload,
        estimateTokens: estimateTokens,
        estimateMessagesTokens: estimateMessagesTokens,
        computeStats: computeStats,
        normalizeMessageForApi: normalizeMessageForApi,
        normalizeUserContent: normalizeUserContent,
        createThinkFilter: createThinkFilter
    };
})(window);
