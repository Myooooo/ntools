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
        connectTimeout: 20000,      // 建立连接（拿到响应头）
        firstEventTimeout: 60000,   // 拿到响应头到首个 SSE 事件（适配内网推理模型长 prefill）
        idleTimeout: 60000,         // 事件之间的最大静默
        maxDuration: 600000,        // 单次请求总时长上限（10 分钟，适配长推理链）
        maxRawJsonBytes: 8 * 1024 * 1024,
        maxRetries: 2,              // 仅对"尚未产出任何内容"的 429/5xx/网络抖动作退避重试
        retryBaseDelay: 500,
        maxBodyPreview: 2000
    };

    var API_FORMAT_OPENAI = 'openai';
    var API_FORMAT_BOCAI = 'bocai';

    /**
     * 内嵌思考块标签对。参考 bocai-code 的 dsml.py：
     * <think>、<thinking>、<reasoning>、<｜DSML｜thinking>（全角竖线），
     * 另外兼容半角竖线写法。匹配大小写不敏感。
     */
    var THINK_PAIRS = [
        { open: '<think>', close: '</think>' },
        { open: '<thinking>', close: '</thinking>' },
        { open: '<\uff5cDSML\uff5cthinking>', close: '</\uff5cDSML\uff5cthinking>' },
        { open: '<|DSML|thinking>', close: '</|DSML|thinking>' },
        { open: '<reasoning>', close: '</reasoning>' }
    ];
    var THINK_OPENERS = THINK_PAIRS.map(function (pair) { return pair.open; });
    var THINK_CLOSER_BY_OPEN = Object.create(null);
    THINK_PAIRS.forEach(function (pair) { THINK_CLOSER_BY_OPEN[pair.open.toLowerCase()] = pair.close; });

    var IMAGE_FALLBACK_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;
    var CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

    /** 端点 API 格式归一化：仅 openai / bocai，其它一律回落 openai。 */
    function normalizeApiFormat(value) {
        var text = value == null ? '' : String(value).trim().toLowerCase();
        return text === API_FORMAT_BOCAI ? API_FORMAT_BOCAI : API_FORMAT_OPENAI;
    }

    function isBocai(config) {
        return normalizeApiFormat(config && config.apiFormat) === API_FORMAT_BOCAI;
    }

    /** 消息中是否含图片内容块（用于 bocai 格式的前置拒绝）。 */
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

    function bocaiImageError() {
        return {
            type: 'unsupported',
            message: '当前端点 API 格式为 bocai，参考实现不支持图片输入；请改用 openai 格式端点，或移除图片后重试'
        };
    }

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
            if (!content.length) return null;
            /* 纯文本一律发字符串：OpenAI 允许 content 为 parts 数组，但很多内网网关
             * （以及部分国产模型）只接受字符串，收到数组会直接 400。
             * 只有真的带图片时才用多模态数组，此时网关本就必须支持 parts。 */
            var hasImage = false;
            for (var i = 0; i < content.length; i += 1) {
                if (content[i] && content[i].type === 'image_url') { hasImage = true; break; }
            }
            if (!hasImage) {
                var textParts = [];
                content.forEach(function (part) {
                    if (part && part.type === 'text' && part.text) textParts.push(part.text);
                });
                var text = textParts.join('\n');
                return text ? { role: 'user', content: text } : null;
            }
            return { role: 'user', content: content };
        }
        var answer = typeof message.content === 'string' ? message.content : '';
        return answer ? { role: 'assistant', content: answer } : null;
    }

    /**
     * Base URL 归一化：去尾斜杠、必要时补 /chat/completions；非法返回 ''。
     * 支持只填 host（https://host）、带 /v1 的 base（https://host/v1），
     * 也兼容用户直接粘贴完整 /chat/completions（不会重复追加）。
     */
    function buildUrl(base) {
        var schemaChat = NC.schema && NC.schema.chat;
        if (schemaChat && typeof schemaChat.resolveChatEndpoint === 'function') {
            return schemaChat.resolveChatEndpoint(base);
        }
        /* 兜底（schema 未加载时）：至少不要把 query 拼进 pathname */
        if (typeof base !== 'string') return '';
        var value = base.trim();
        if (!value || /[\s\u0000-\u001f]/.test(value)) return '';
        var cut = value.indexOf('?');
        var path = cut === -1 ? value : value.slice(0, cut);
        var query = cut === -1 ? '' : value.slice(cut);
        path = path.replace(/\/+$/, '');
        if (!/\/chat\/completions$/i.test(path)) path += '/chat/completions';
        return path + query;
    }

    /* 推理类模型不接受 temperature/top_p（传了会 400），按 modelId 前缀/后缀跳过 */
    var NO_SAMPLING_RE = /^(o1|o3|o4|gpt-5)([-.]|$)|reasoner$/i;

    function supportsSampling(modelId) {
        var model = typeof modelId === 'string' ? modelId.trim() : '';
        if (!model) return false;
        return !NO_SAMPLING_RE.test(model);
    }

    function readSessionId(config) {
        var source = config || {};
        var candidate = typeof source.sessionId === 'string' ? source.sessionId.trim() : '';
        if (!candidate && typeof source.id === 'string') candidate = source.id.trim();
        if (!candidate && typeof source.profileId === 'string') candidate = source.profileId.trim();
        return candidate;
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
        if (config.enableAdvanced && supportsSampling(config.modelId)) {
            var temperature = Number(config.temperature);
            var topP = Number(config.top_p);
            if (isFinite(temperature) && temperature >= 0 && temperature <= 2) payload.temperature = temperature;
            if (isFinite(topP) && topP >= 0 && topP <= 1) payload.top_p = topP;
        }
        if (opts.stream !== false && opts.includeUsage) {
            payload.stream_options = { include_usage: true };
        }
        /* 创意工坊等场景需要限制输出长度；部分网关不认识该字段，外层会按 400 重试 */
        var maxTokens = Number(opts.maxTokens);
        if (!opts.dropOptional && isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = Math.round(maxTokens);
        /* 推理强度：只在显式打开推理时发送，关闭则完全不出现相关字段 */
        if (!opts.dropOptional && config.reasoning !== false) {
            var effort = String(config.reasoningEffort || '').toLowerCase();
            if (effort === 'low' || effort === 'medium' || effort === 'high') payload.reasoning_effort = effort;
        }
        // bocai：在标准 OpenAI body 上追加稳定会话键（参考实现用服务端 sessionId
        // 维持多轮身份）。openai 格式保持字段完全不变。
        if (isBocai(config)) {
            var sessionId = readSessionId(config);
            if (sessionId) payload.sessionId = sessionId;
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

    /**
     * 上下文预算裁剪：从最老的整轮开始丢，保证列表仍以 user 开头。
     * 不改变最后一条（就是本次要发的内容）。
     * @returns {{messages:Array, trimmed:number, tokens:number, budget:number, over:boolean}}
     */
    function trimMessagesForBudget(messages, options) {
        var opts = options || {};
        var budget = util.isFiniteNum(opts.budget) && opts.budget > 0 ? opts.budget : 32000;
        var list = Array.isArray(messages) ? messages.slice() : [];
        var tokens = estimateMessagesTokens(list);
        var trimmed = 0;
        if (tokens <= budget) {
            return { messages: list, trimmed: 0, tokens: tokens, budget: budget, over: false };
        }
        while (list.length > 1 && tokens > budget) {
            list.shift();
            trimmed += 1;
            tokens = estimateMessagesTokens(list);
        }
        while (list.length > 1 && list[0].role !== 'user') {
            list.shift();
            trimmed += 1;
            tokens = estimateMessagesTokens(list);
        }
        return {
            messages: list,
            trimmed: trimmed,
            tokens: estimateMessagesTokens(list),
            budget: budget,
            over: tokens > budget
        };
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

    function readRetryAfter(response) {
        try {
            if (!response || !response.headers || typeof response.headers.get !== 'function') return 0;
            var raw = response.headers.get('retry-after');
            if (!raw) return 0;
            var secs = parseInt(raw, 10);
            if (isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30000);
            var when = Date.parse(raw);
            if (isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 30000);
        } catch (err) { /* ignore */ }
        return 0;
    }

    /**
     * 只对"尚未产出任何内容"的瞬时错误重试：
     * 429 / 5xx / 408 / 网络抖动。已开始输出的错误重试会造成重复消息。
     */
    function isRetryableError(result) {
        if (!result || result.ok) return false;
        var error = result.error || {};
        if (error.partial) return false;
        if (error.type === 'network') return true;
        if (error.type === 'http') {
            return error.status === 429 || error.status === 408 || error.status >= 500;
        }
        return false;
    }

    function sleepWithAbort(ms, signal) {
        return new Promise(function (resolve) {
            var done = false;
            function finish() {
                if (done) return;
                done = true;
                resolve();
            }
            var timer = setTimeout(finish, ms);
            if (signal) {
                if (signal.aborted) { clearTimeout(timer); finish(); return; }
                signal.addEventListener('abort', function () { clearTimeout(timer); finish(); }, { once: true });
            }
        });
    }

    var CONTEXT_HINT_RE = /context|maximum length|too long|token limit|reduce the length/i;

    function extractErrorMessage(body, statusText) {
        if (!body) return statusText || '请求失败';
        if (CONTEXT_HINT_RE.test(body)) {
            return '上下文长度超出服务端上限：请新建会话，或在设置中调低上下文预算后重试（原文：' +
                String(body).replace(/\s+/g, ' ').slice(0, 160) + '）';
        }
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
     * 思考标签跨 chunk 状态机：处理 <think> / <thinking> / <reasoning> /
     * <｜DSML｜thinking>，并把被 chunk 截断的半个标签留到下一个 chunk，
     * 避免标签碎片漏进正文/思考文本。结构化 reasoning_content 不经过本过滤器。
     * 未闭合的思考块在 end() 时整体归入 reasoning；未闭合的开标签碎片归入正文。
     */
    function createThinkFilter(handlers) {
        var h = handlers || {};
        var inThink = false;
        var activeCloser = '';
        var carry = '';

        function emit(fn, value) {
            if (!value || typeof fn !== 'function') return;
            fn(value);
        }

        function findMarker(buffer, markers) {
            var lower = buffer.toLowerCase();
            var found = -1;
            var foundMarker = '';
            for (var i = 0; i < markers.length; i += 1) {
                var marker = markers[i];
                var at = lower.indexOf(marker.toLowerCase());
                if (at !== -1 && (found === -1 || at < found)) {
                    found = at;
                    foundMarker = marker;
                }
            }
            return found === -1 ? null : { index: found, marker: foundMarker };
        }

        function prefixSuffixLength(text, markers) {
            var lower = text.toLowerCase();
            var maximum = 0;
            for (var i = 0; i < markers.length; i += 1) {
                var marker = markers[i].toLowerCase();
                var max = Math.min(text.length, marker.length - 1);
                for (var len = max; len > 0; len -= 1) {
                    if (lower.slice(lower.length - len) === marker.slice(0, len)) {
                        maximum = Math.max(maximum, len);
                        break;
                    }
                }
            }
            return maximum;
        }

        function feed(text) {
            if (typeof text !== 'string' || !text) return;
            var buf = carry + text;
            carry = '';
            var guard = 0;
            while (buf && guard < 500) {
                guard += 1;
                if (inThink) {
                    var closer = findMarker(buf, [activeCloser]);
                    if (closer) {
                        emit(h.onReasoning, buf.slice(0, closer.index));
                        buf = buf.slice(closer.index + closer.marker.length);
                        inThink = false;
                        activeCloser = '';
                        continue;
                    }
                    var keepClose = prefixSuffixLength(buf, [activeCloser]);
                    emit(h.onReasoning, keepClose ? buf.slice(0, buf.length - keepClose) : buf);
                    carry = keepClose ? buf.slice(buf.length - keepClose) : '';
                    buf = '';
                } else {
                    var opener = findMarker(buf, THINK_OPENERS);
                    if (opener) {
                        emit(h.onAnswer, buf.slice(0, opener.index));
                        buf = buf.slice(opener.index + opener.marker.length);
                        inThink = true;
                        activeCloser = THINK_CLOSER_BY_OPEN[opener.marker.toLowerCase()] || '</think>';
                        continue;
                    }
                    var keepOpen = prefixSuffixLength(buf, THINK_OPENERS);
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

    /**
     * 归一化 content 字符串/数组/对象，返回 {text, reasoning}。
     * 兼容 OpenAI 多模态 content part、reasoning/thinking 类型 part、
     * 以及 output_text / summary / value 等兼容字段。
     */
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
            if (reasoningKind) {
                return { text: '', reasoning: parsedValue.reasoning + parsedValue.text };
            }
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

    /**
     * 读取一条 choice 的正文/思考片段。流式优先 delta，非流式用 message；
     * 兼容 choices[0].text 与 delta.text 回退，以及 reasoning_content /
     * reasoning / thinking / reasoning_details 字段。
     */
    function readChoiceFragments(choice, source) {
        var delta = source || {};
        var parsed = contentParts(delta.content);
        var text = parsed.text;
        var reasoning = parsed.reasoning;
        if (!text) {
            var fallbackValue = delta.text != null ? delta.text : (choice ? choice.text : '');
            var fallback = contentParts(fallbackValue);
            text = fallback.text;
            reasoning += fallback.reasoning;
        }
        var seen = [];
        ['reasoning_content', 'reasoning', 'thinking', 'thinking_content', 'reasoning_details'].forEach(function (key) {
            if (!delta || !(key in delta)) return;
            var part = contentParts(delta[key]);
            var fragment = part.reasoning + part.text;
            if (fragment && seen.indexOf(fragment) === -1) {
                seen.push(fragment);
                reasoning += fragment;
            }
        });
        return { text: text, reasoning: reasoning };
    }

    function extractApiError(error) {
        if (typeof error === 'string' && error) return error;
        if (error && typeof error.message === 'string' && error.message) return error.message;
        if (error && typeof error.detail === 'string' && error.detail) return error.detail;
        return 'API 返回错误';
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
        if (isBocai(config) && hasImageContent(opts.messages)) {
            return { ok: false, error: bocaiImageError() };
        }

        var hasAbort = typeof global.AbortController === 'function';
        var controller = hasAbort ? new global.AbortController() : null;
        var externalOff = null;
        var aborted = false;
        var timedOut = false;
        var timeoutPhase = '';
        var phaseTimer = null;
        var maxTimer = null;
        var sawAnyData = false;
        var gotOutput = false;
        var usage = null;
        var firstTokenAt = 0;
        var startedAt = Date.now();
        var finishReason = null;
        var answerText = '';
        var reasoningText = '';
        var structuredReasoningSeen = false;

        function onExternalAbort() {
            aborted = true;
            if (controller) controller.abort();
        }

        function cleanup() {
            if (phaseTimer) { clearTimeout(phaseTimer); phaseTimer = null; }
            if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
            if (opts.signal && externalOff) externalOff();
        }

        function clearPhase() {
            if (phaseTimer) { clearTimeout(phaseTimer); phaseTimer = null; }
        }

        function armTimer(phase, ms) {
            clearPhase();
            timeoutPhase = phase;
            phaseTimer = setTimeout(function () {
                timedOut = true;
                if (controller) controller.abort();
            }, ms);
        }

        function armIdle() {
            armTimer('idle', DEFAULTS.idleTimeout);
        }

        function timeoutMessage() {
            var secs = function (ms) { return Math.round(ms / 1000) + ' 秒'; };
            if (timeoutPhase === 'connect') {
                return '连接超时：' + secs(DEFAULTS.connectTimeout) + '内未建立连接，请检查网关地址与网络';
            }
            if (timeoutPhase === 'first-event') {
                return '首包超时：' + secs(DEFAULTS.firstEventTimeout) + '内未收到任何数据';
            }
            if (timeoutPhase === 'max') {
                return '总时长超时：超过' + secs(DEFAULTS.maxDuration) + '仍未结束，已中止';
            }
            return '数据流中断：' + secs(DEFAULTS.idleTimeout) + '未收到新数据';
        }

        function markOutput() {
            if (!firstTokenAt) firstTokenAt = Date.now();
            gotOutput = true;
        }

        /* 标记"已经吐过内容"：这类错误绝不能重试，否则会产生重复消息 */
        function errorResult(error) {
            if (answerText || reasoningText) error.partial = true;
            return { ok: false, error: error };
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
                // 原生 reasoning_content 已存在时，不再重复上报内嵌思考块
                if (structuredReasoningSeen) return;
                reasoningText += text;
                markOutput();
                call(opts.onReasoning, text);
            }
        });

        var apiErrorMessage = '';
        var parser = null;

        function emitStructuredReasoning(fragment) {
            if (!fragment) return;
            structuredReasoningSeen = true;
            reasoningText += fragment;
            markOutput();
            call(opts.onReasoning, fragment);
        }

        function handleJson(json) {
            sawAnyData = true;
            if (!json || typeof json !== 'object') return;
            var normalizedUsage = normalizeUsage(json.usage);
            if (normalizedUsage) {
                usage = normalizedUsage;
                call(opts.onUsage, normalizedUsage);
            }
            if (json.error) {
                apiErrorMessage = extractApiError(json.error);
                return;
            }
            var choices = Array.isArray(json.choices) ? json.choices : [];
            var choice = choices[0];
            if (choice) {
                if (choice.finish_reason) finishReason = choice.finish_reason;
                var source;
                if (choice.delta && typeof choice.delta === 'object') source = choice.delta;
                else if (choice.message && typeof choice.message === 'object') source = choice.message;
                else source = choice;
                var fragments = readChoiceFragments(choice, source);
                emitStructuredReasoning(fragments.reasoning);
                if (fragments.text) thinkFilter.feed(fragments.text);
                return;
            }
            // 无 choices 的兼容形状：顶层 output_text
            var output = contentParts(json.output_text);
            if (!output.text) {
                // 网关包装：{ data | result | response: { choices / content … } }
                var nestedKeys = ['data', 'result', 'response'];
                for (var ni = 0; ni < nestedKeys.length; ni += 1) {
                    var nested = json[nestedKeys[ni]];
                    if (nested && typeof nested === 'object') {
                        var inner = contentParts(nested.output_text);
                        if (!inner.text) {
                            var innerChoice = nested.choices && nested.choices[0];
                            if (innerChoice) {
                                var innerSource = innerChoice.message || innerChoice.delta || innerChoice;
                                inner = contentParts(innerSource && innerSource.content);
                                if (!inner.text && innerSource && innerSource.text != null) inner = contentParts(innerSource.text);
                            }
                        }
                        if (inner.text) { output = inner; break; }
                    }
                }
                // 末级兜底：顶层直接给文本字段
                if (!output.text) {
                    var textKeys = ['answer', 'content', 'text', 'output', 'response', 'message'];
                    for (var ti = 0; ti < textKeys.length; ti += 1) {
                        var value = json[textKeys[ti]];
                        if (typeof value === 'string' && value.trim()) { output = contentParts(value); break; }
                    }
                }
            }
            emitStructuredReasoning(output.reasoning);
            if (output.text) thinkFilter.feed(output.text);
        }

        function handleData(dataText) {
            var json;
            try {
                json = JSON.parse(dataText);
            } catch (err) {
                sawAnyData = true; // 单条坏事件不终止流
                return;
            }
            handleJson(json);
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

            armTimer('connect', DEFAULTS.connectTimeout);
            maxTimer = setTimeout(function () {
                timedOut = true;
                timeoutPhase = 'max';
                if (controller) controller.abort();
            }, DEFAULTS.maxDuration);
            var response;
            try {
                response = await global.fetch(url, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(buildPayload({
                        config: config,
                        messages: opts.messages,
                        stream: true,
                        includeUsage: includeUsage,
                        maxTokens: opts.maxTokens,
                        dropOptional: opts.dropOptional === true
                    })),
                    signal: controller ? controller.signal : undefined
                });
            } catch (error) {
                if (aborted) return { ok: true, aborted: true, usage: null, content: '', reasoning: '' };
                if (timedOut) return errorResult({ type: 'timeout', message: timeoutMessage(), phase: timeoutPhase });
                return errorResult({ type: 'network', message: mapNetworkError(error), error: error });
            }

            if (!response.ok) {
                var body = await safeText(response, DEFAULTS.maxBodyPreview);
                if (includeUsage && !gotOutput && (response.status === 400 || response.status === 422)) {
                    return { ok: false, retryable: true };
                }
                return errorResult({
                    type: 'http',
                    status: response.status,
                    statusText: response.statusText,
                    body: body,
                    retryAfter: readRetryAfter(response),
                    message: extractErrorMessage(body, response.statusText)
                });
            }

            // 部分兼容网关忽略 stream:true，直接返回 application/json；
            // 此时按一次性响应解析，避免产生“非 SSE 响应”的误报。
            var contentType = '';
            try {
                if (response.headers && typeof response.headers.get === 'function') {
                    contentType = String(response.headers.get('content-type') || '');
                }
            } catch (headerErr) {
                contentType = '';
            }
            var jsonMode = false;
            var rawJsonMode = false;
            if (/application\/json/i.test(contentType)) {
                var jsonText = await safeText(response, 8 * 1024 * 1024);
                var jsonBody = null;
                try { jsonBody = JSON.parse(jsonText); } catch (parseErr) { jsonBody = null; }
                if (jsonBody) {
                    handleJson(jsonBody);
                    jsonMode = true;
                    clearPhase();
                }
            }

            if (!jsonMode && response.body && typeof response.body.getReader === 'function' && typeof global.TextDecoder === 'function') {
                armTimer('first-event', DEFAULTS.firstEventTimeout);
                var reader = response.body.getReader();
                var decoder = new global.TextDecoder('utf-8');
                // 兜底：即使 fetch 实现未把 signal 传播到 body 流，也主动取消读取
                var abortHook = function () {
                    aborted = true;
                    try { reader.cancel(); } catch (err) { /* ignore */ }
                };
                if (controller) controller.signal.addEventListener('abort', abortHook);
                try {
                    /* 首个分片嗅探：部分内网网关忽略 stream:true，直接用 text/plain 回一整个 JSON。
                     * 这类响应里没有 data: 行，如果硬按 SSE 解析会一直等不到事件直到超时。 */
                    var sniffed = false;
                    var rawJson = '';
                    while (true) {
                        var chunk = await reader.read();
                        if (chunk.done) break;
                        armIdle();
                        var textChunk = decoder.decode(chunk.value, { stream: true });
                        if (!sniffed) {
                            var head = textChunk.replace(/^\ufeff/, '').replace(/^\s+/, '');
                            if (head.length > 0) {
                                sniffed = true;
                                var first = head.charAt(0);
                                if (first === '{' || first === '[') {
                                    rawJsonMode = true;
                                    jsonMode = true;
                                }
                            } else {
                                continue;
                            }
                        }
                        if (rawJsonMode) {
                            if (rawJson.length + textChunk.length > DEFAULTS.maxRawJsonBytes) {
                                try { reader.cancel(); } catch (err) { /* ignore */ }
                                return errorResult({ type: 'parse', message: '服务端返回 JSON 体积超过上限（8MB）' });
                            }
                            rawJson += textChunk;
                            continue;
                        }
                        parser.feed(textChunk);
                        if (parser.isDone() || apiErrorMessage) {
                            try { reader.cancel(); } catch (err) { /* ignore */ }
                            break;
                        }
                    }
                    var tailChunk = decoder.decode();
                    if (tailChunk) {
                        if (rawJsonMode) rawJson += tailChunk;
                        else if (!parser.isDone()) parser.feed(tailChunk);
                    }
                    if (rawJsonMode) {
                        var parsedWhole = null;
                        try { parsedWhole = JSON.parse(rawJson.replace(/^\ufeff/, '').trim()); } catch (parseErr3) { parsedWhole = null; }
                        if (parsedWhole) {
                            handleJson(parsedWhole);
                            clearPhase();
                        }
                    } else if (!parser.isDone()) {
                        parser.end();
                    }
                } catch (error) {
                    if (timedOut) return errorResult({ type: 'timeout', message: timeoutMessage(), phase: timeoutPhase });
                    if (aborted) return { ok: true, aborted: true, usage: usage, content: answerText, reasoning: reasoningText };
                    return errorResult({ type: 'network', message: mapNetworkError(error), error: error });
                } finally {
                    if (controller) controller.signal.removeEventListener('abort', abortHook);
                }
            } else if (!jsonMode) {
                // 非流式回退：一次性读取后按 SSE 解析；若实际是 JSON 则按一次性响应处理
                var fullText = await safeText(response, 8 * 1024 * 1024);
                var trimmed = fullText.replace(/^\ufeff/, '').trim();
                if (trimmed.charAt(0) === '{') {
                    var fallbackJson = null;
                    try { fallbackJson = JSON.parse(trimmed); } catch (parseErr2) { fallbackJson = null; }
                    if (fallbackJson) {
                        handleJson(fallbackJson);
                        jsonMode = true;
                    }
                }
                if (!jsonMode) {
                    parser.feed(fullText);
                    parser.end();
                }
            }

            thinkFilter.end();

            if (timedOut) return { ok: false, error: { type: 'timeout', message: timeoutMessage(), phase: timeoutPhase } };
            if (aborted) {
                return { ok: true, aborted: true, usage: usage, content: answerText, reasoning: reasoningText };
            }
            if (apiErrorMessage) return errorResult({ type: 'api', message: apiErrorMessage });
            if (!sawAnyData) return errorResult({ type: 'empty', message: '服务端未返回有效的流式数据（可能是非 SSE 响应）' });

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
                onUsage: function (usage) { call(opts.onUsage, usage); },
                maxTokens: opts.maxTokens
            };
            var includeUsage = true;
            var result = await streamOnce(runOpts, includeUsage);
            /* 兼容：网关不认 stream_options / max_tokens / reasoning_effort 时，
             * 去掉这些可选字段重来一次（推理字段最容易触发 400/422） */
            if (result && result.retryable) {
                includeUsage = false;
                if (opts.maxTokens || (opts.config && opts.config.reasoningEffort)) runOpts.dropOptional = true;
                result = await streamOnce(runOpts, includeUsage);
            }
            /* 瞬时错误退避重试：只在"一个字都没吐出来"时进行 */
            var attempt = 0;
            while (!abortedByCaller && !settled && isRetryableError(result) && attempt < DEFAULTS.maxRetries) {
                attempt += 1;
                var hinted = result && result.error && util.isFiniteNum(result.error.retryAfter)
                    ? result.error.retryAfter
                    : 0;
                var delay = hinted || Math.min(DEFAULTS.retryBaseDelay * Math.pow(2, attempt - 1), 8000);
                await sleepWithAbort(delay, signal);
                if (abortedByCaller || settled) break;
                result = await streamOnce(runOpts, includeUsage);
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
        API_FORMAT_OPENAI: API_FORMAT_OPENAI,
        API_FORMAT_BOCAI: API_FORMAT_BOCAI,
        THINK_PAIRS: THINK_PAIRS,
        chat: chat,
        buildUrl: buildUrl,
        buildPayload: buildPayload,
        supportsSampling: supportsSampling,
        isRetryableError: isRetryableError,
        readRetryAfter: readRetryAfter,
        extractErrorMessage: extractErrorMessage,
        normalizeApiFormat: normalizeApiFormat,
        hasImageContent: hasImageContent,
        isAllowedImageUrl: allowedImage,
        contentParts: contentParts,
        readChoiceFragments: readChoiceFragments,
        estimateTokens: estimateTokens,
        estimateMessagesTokens: estimateMessagesTokens,
        trimMessagesForBudget: trimMessagesForBudget,
        computeStats: computeStats,
        normalizeMessageForApi: normalizeMessageForApi,
        normalizeUserContent: normalizeUserContent,
        createThinkFilter: createThinkFilter
    };
})(window);
