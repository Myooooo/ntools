/**
 * todo-ai.js — Todo 大模型识别（文本 → 待办草稿，只填充不创建）
 * 经典脚本，依赖 core / ui / icons / llm-store / ai（可选）。挂载：NC.todoAi
 *
 * 契约（docs/dev-contract-v3.md §5.1）：
 *   buildSystemPrompt(now?, profile?)：每次调用注入 {{NOW}}/{{DATE}}/{{WEEKDAY}}/{{TZ}}/{{WORK_END}}
 *   parseText(text, {signal})：NC.ai.complete 非流式调用 → extractJson → 归一 data
 *   openDialog()：粘贴长文本 → 识别（loading、防误触关闭）→ 关闭 → NC.tools.todo.fillDraft(data)
 * 原则：绝不自动创建任务；解析失败不写任何数据；不产生 console.error。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var events = NC.events;

    var WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    var PRIORITIES = ['low', 'normal', 'high', 'urgent'];
    var MAX_TEXT = 20000;
    var MAX_TITLE = 80;
    var MAX_NOTES = 1000;
    var MAX_TAGS = 5;
    var MAX_TAG_LENGTH = 32;
    var MAX_LIST_NAME = 60;
    var REQUEST_TIMEOUT = 60000;

    var DEFAULT_PROMPT = [
        '你是待办事项提取助手。请从用户提供的文本中提取一项待办任务，并只输出 JSON 对象，不要输出解释。',
        '字段：title（≤80字）、notes（≤1000字）、due（YYYY-MM-DDTHH:mm 本地时间，无法判断为 null）、',
        'dueAllDay（boolean）、priority（low|normal|high|urgent）、tags（0-5 个字符串）、listName（可选）。',
        '当前时间：{{NOW}}（{{WEEKDAY}}，时区 {{TZ}}），下班时间 {{WORK_END}}。',
        '相对时间（如“明天下班前”“周五前”“月底前”）请换算成具体时间；无法判断 due 时给 null。'
    ].join('\n');

    var openInstance = null;

    /* ------------------------------------------------------------------ *
     * llm-store 访问（全部兜底，不 throw）
     * ------------------------------------------------------------------ */
    function llmStore() {
        return (NC.store && NC.store.llm) ? NC.store.llm : null;
    }

    function getTodoAiConfig() {
        var store = llmStore();
        try {
            if (store && typeof store.getTodoAi === 'function') {
                var cfg = store.getTodoAi();
                if (cfg && typeof cfg === 'object') return cfg;
            }
        } catch (err) { /* ignore */ }
        return {
            profileId: null,
            systemPrompt: DEFAULT_PROMPT,
            temperature: 0.2,
            topP: 0.9
        };
    }

    function getWorkEndTime(fallbackProfile) {
        if (fallbackProfile && typeof fallbackProfile.workEndTime === 'string' &&
            /^([01]\d|2[0-3]):[0-5]\d$/.test(fallbackProfile.workEndTime)) {
            return fallbackProfile.workEndTime;
        }
        var store = llmStore();
        try {
            if (store && typeof store.getWorkEndTime === 'function') {
                var value = store.getWorkEndTime();
                if (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
            }
        } catch (err) { /* ignore */ }
        return '17:30';
    }

    function pad2(n) { return util.pad2 ? util.pad2(n) : (n < 10 ? '0' + n : String(n)); }

    function formatDateOnly(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function formatHourMinute(date) {
        return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    function formatNow(date) {
        return formatDateOnly(date) + ' ' + formatHourMinute(date);
    }

    function getTimeZone() {
        try {
            if (global.Intl && global.Intl.DateTimeFormat) {
                var zone = global.Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (zone) return zone;
            }
        } catch (err) { /* ignore */ }
        return '本地时区';
    }

    /* ------------------------------------------------------------------ *
     * 端点解析
     * ------------------------------------------------------------------ */
    /**
     * @returns {{profile:Object|null, cfg:Object, configured:boolean, reason:string}}
     */
    function resolveTarget() {
        var cfg = getTodoAiConfig();
        var store = llmStore();
        var profile = null;
        try {
            if (store && cfg.profileId && typeof store.getProfile === 'function') {
                profile = store.getProfile(cfg.profileId);
            }
            if (!profile && store && typeof store.getCurrentProfile === 'function') {
                profile = store.getCurrentProfile();
            }
        } catch (err) { /* ignore */ }
        var reason = '';
        if (!store) reason = '大模型配置尚未加载（js/llm-store.js）';
        else if (!profile) reason = '还没有可用的模型端点，请先在「设置 → 模型端点」中配置';
        else if (!profile.baseUrl) reason = '所选端点缺少 Base URL，请在设置中补全';
        else if (!profile.modelId) reason = '所选端点缺少 Model ID，请在设置中补全';
        return {
            profile: profile,
            cfg: cfg,
            configured: !reason,
            reason: reason
        };
    }

    function describeTarget(target) {
        var info = target || resolveTarget();
        var profile = info.profile;
        return {
            configured: !!info.configured,
            name: profile ? (profile.name || '未命名端点') : '未配置',
            modelId: profile ? (profile.modelId || '未设置模型') : '—',
            baseUrl: profile ? (profile.baseUrl || '') : '',
            reason: info.reason || ''
        };
    }

    function isConfigured() {
        return resolveTarget().configured;
    }

    /* ------------------------------------------------------------------ *
     * 系统提示词
     * ------------------------------------------------------------------ */
    /**
     * 生成系统提示词：每次调用重新注入当前时间（不缓存、不写死时间）。
     * @param {number} [now] epoch ms
     * @param {Object} [profile] 可选端点（可带 workEndTime 覆盖）
     */
    function buildSystemPrompt(now, profile) {
        var cfg = getTodoAiConfig();
        var template = (typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.trim())
            ? cfg.systemPrompt
            : DEFAULT_PROMPT;
        var date = new Date(util.isFiniteNum(now) ? now : Date.now());
        var workEnd = getWorkEndTime(profile);
        var replaced = template
            .replace(/\{\{NOW\}\}/g, formatNow(date))
            .replace(/\{\{DATE\}\}/g, formatDateOnly(date))
            .replace(/\{\{WEEKDAY\}\}/g, WEEKDAYS[date.getDay()])
            .replace(/\{\{TZ\}\}/g, getTimeZone())
            .replace(/\{\{WORK_END\}\}/g, workEnd);
        if (!/只输出\s*JSON|仅输出\s*JSON|JSON\s*对象|JSON\s*格式/.test(replaced)) {
            replaced += '\n只输出 JSON 对象，不要输出任何解释或 Markdown 代码围栏。';
        }
        return replaced;
    }

    /* ------------------------------------------------------------------ *
     * 归一化
     * ------------------------------------------------------------------ */
    function trimText(value, max) {
        var text = value == null ? '' : String(value);
        text = text.replace(/\r\n/g, '\n').trim();
        return max && text.length > max ? text.slice(0, max) : text;
    }

    function localTimestamp(year, month, day, hour, minute) {
        var date = new Date(year, month - 1, day, hour || 0, minute || 0, 0, 0);
        /* 校验非法日期（如 2026-02-30 会被 Date 滚动到 3 月） */
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
            return null;
        }
        return date.getTime();
    }

    function normalizeDue(value) {
        if (value == null || value === '') return null;
        if (util.isFiniteNum(value)) {
            var numeric = Number(value);
            return numeric > 100000000000 && numeric < 4102444800000 ? Math.round(numeric) : null;
        }
        var text = String(value).trim();
        if (!text) return null;
        /* 形如 2026-11-12T18:30 / 2026-11-12 18:30 / 2026-11-12 */
        var match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::\d{2})?)?/.exec(text);
        if (match) {
            var hour = match[4] == null ? 0 : parseInt(match[4], 10);
            var minute = match[5] == null ? 0 : parseInt(match[5], 10);
            if (hour > 23 || minute > 59) return null;
            var local = localTimestamp(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10), hour, minute);
            if (local != null) return local;
        }
        var parsed = Date.parse(text);
        return isFinite(parsed) ? parsed : null;
    }

    function normalizePriority(value) {
        if (value == null) return 'normal';
        var text = String(value).trim().toLowerCase();
        if (PRIORITIES.indexOf(text) > -1) return text;
        if (/urgent|紧急|最高|p0|立即/.test(text)) return 'urgent';
        if (/high|重要|高|p1/.test(text)) return 'high';
        if (/low|低|不急|p3/.test(text)) return 'low';
        return 'normal';
    }

    function normalizeTags(value) {
        var source = [];
        if (Array.isArray(value)) source = value;
        else if (typeof value === 'string') source = value.split(/[,，;；\s]+/);
        var tags = [];
        var seen = Object.create(null);
        source.forEach(function (item) {
            if (item == null) return;
            var tag = trimText(item, MAX_TAG_LENGTH);
            if (!tag || seen[tag]) return;
            seen[tag] = true;
            tags.push(tag);
        });
        return tags.slice(0, MAX_TAGS);
    }

    function firstLine(text, max) {
        var normalized = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
        if (!normalized) return '';
        var line = normalized.split('\n')[0].trim();
        /* 去掉邮件常见前缀（Re: / FW: / 主题：等）与编号 */
        line = line.replace(/^(re|fw|fwd)\s*[:：]\s*/i, '').replace(/^(主题|标题|任务|待办)\s*[:：]\s*/i, '');
        if (line.length > max) line = line.slice(0, max);
        return line;
    }

    /**
     * 归一模型返回的 JSON（纯函数，便于测试）。
     * @param {*} raw
     * @param {string} [sourceText] 原文（title 缺失时兜底）
     * @returns {{title,notes,due,dueAllDay,priority,tags,listName}}
     */
    function normalizeData(raw, sourceText) {
        var src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        var title = trimText(src.title != null ? src.title : src.name, MAX_TITLE);
        if (!title) title = firstLine(sourceText, MAX_TITLE);
        var notes = trimText(src.notes != null ? src.notes : (src.content != null ? src.content : ''), MAX_NOTES);
        var due = normalizeDue(src.due);
        return {
            title: title,
            notes: notes,
            due: due,
            dueAllDay: due != null && src.dueAllDay === true,
            priority: normalizePriority(src.priority),
            tags: normalizeTags(src.tags),
            listName: trimText(src.listName, MAX_LIST_NAME)
        };
    }

    /* ------------------------------------------------------------------ *
     * 一次性识别
     * ------------------------------------------------------------------ */
    function normalizeError(error) {
        if (!error || typeof error !== 'object') {
            return { type: 'parse', message: '识别失败，请重试' };
        }
        return {
            type: error.type || 'server',
            message: error.message || '识别失败，请重试',
            status: error.status
        };
    }

    /**
     * @param {string} text 邮件/纪要等长文本
     * @param {{signal?:AbortSignal}} [options]
     * @returns {Promise<{ok:true,data:object,usage?:object,latencyMs?:number,raw?:string}|{ok:false,error:object}>}
     */
    function parseText(text, options) {
        var opts = options || {};
        var source = trimText(text, MAX_TEXT);
        if (!source) {
            return Promise.resolve({
                ok: false,
                error: { type: 'config', message: '请先粘贴要识别的文本' }
            });
        }
        if (!NC.ai || typeof NC.ai.complete !== 'function') {
            return Promise.resolve({
                ok: false,
                error: { type: 'config', message: '模型调用模块未加载（js/ai.js），请刷新页面重试' }
            });
        }
        var target = resolveTarget();
        if (!target.configured) {
            return Promise.resolve({
                ok: false,
                error: { type: 'config', message: target.reason }
            });
        }
        var profile = target.profile;
        var cfg = target.cfg;
        var systemPrompt = buildSystemPrompt(Date.now(), profile);
        var request = {
            profile: profile,
            systemPrompt: systemPrompt,
            userText: source,
            timeoutMs: REQUEST_TIMEOUT
        };
        if (util.isFiniteNum(cfg.temperature)) request.temperature = cfg.temperature;
        if (util.isFiniteNum(cfg.topP)) request.topP = cfg.topP;
        if (opts.signal) request.signal = opts.signal;
        if (NC.debug) NC.log('todoAi.request', { systemPrompt: systemPrompt, chars: source.length });

        return NC.ai.complete(request).then(function (result) {
            if (!result || result.ok !== true) {
                return { ok: false, error: normalizeError(result && result.error) };
            }
            var rawText = String(result.text || '');
            var json = (typeof NC.ai.extractJson === 'function')
                ? NC.ai.extractJson(rawText)
                : null;
            if (!json || typeof json !== 'object' || Array.isArray(json)) {
                return {
                    ok: false,
                    error: { type: 'parse', message: '识别结果格式异常，可重试' },
                    raw: rawText
                };
            }
            var data = normalizeData(json, source);
            if (!data.title) {
                return {
                    ok: false,
                    error: { type: 'parse', message: '未能识别出任务标题，可补充文本后重试' },
                    raw: rawText
                };
            }
            return {
                ok: true,
                data: data,
                usage: result.usage || null,
                latencyMs: result.latencyMs,
                raw: rawText
            };
        }, function () {
            return { ok: false, error: { type: 'network', message: '识别请求失败，请重试' } };
        });
    }

    /* ------------------------------------------------------------------ *
     * 识别弹窗
     * ------------------------------------------------------------------ */
    function buildDialogContent(prefill) {
        var wrap = document.createElement('div');
        wrap.className = 'todo-ai-dialog';

        var lead = document.createElement('p');
        lead.className = 'todo-ai-dialog__lead';
        lead.textContent = '粘贴邮件、会议纪要或聊天记录，AI 会提取标题、详情、截止时间、优先级与标签。识别结果只会填充创建表单，需要你确认后手动创建。';
        wrap.appendChild(lead);

        var textarea = document.createElement('textarea');
        textarea.id = 'todo-ai-text';
        textarea.className = 'nc-textarea todo-ai-textarea';
        textarea.rows = 9;
        textarea.maxLength = MAX_TEXT;
        textarea.placeholder = '粘贴工作邮件 / 会议纪要 / 长文本…\n例如：张总，麻烦本周五下班前把三季度安全巡检报告发我，附整改清单。';
        textarea.setAttribute('aria-label', '待识别的长文本');
        if (prefill) textarea.value = String(prefill).slice(0, MAX_TEXT);
        wrap.appendChild(textarea);

        var target = resolveTarget();
        var info = describeTarget(target);
        var meta = document.createElement('div');
        meta.className = 'todo-ai-dialog__meta';

        var badge = document.createElement('span');
        badge.className = 'nc-badge ' + (info.configured ? 'nc-badge--accent' : 'nc-badge--warning');
        badge.textContent = info.configured
            ? (info.name + ' · ' + info.modelId)
            : '未配置模型端点';
        meta.appendChild(badge);

        var timeoutBadge = document.createElement('span');
        timeoutBadge.className = 'nc-badge';
        timeoutBadge.textContent = '超时 ' + Math.round(REQUEST_TIMEOUT / 1000) + 's';
        meta.appendChild(timeoutBadge);

        var hint = document.createElement('span');
        hint.className = 'todo-ai-dialog__hint';
        hint.textContent = info.configured
            ? '文本会发送给所选端点，不会写入本地存储以外的位置。'
            : (info.reason || '请先在设置中配置模型端点。');
        meta.appendChild(hint);
        wrap.appendChild(meta);

        var error = document.createElement('div');
        error.className = 'todo-ai-error';
        error.hidden = true;
        error.setAttribute('role', 'alert');
        wrap.appendChild(error);

        return {
            node: wrap,
            textarea: textarea,
            error: error,
            target: target,
            loading: false,
            buttons: null
        };
    }

    function setDialogLoading(instance, refs, loading) {
        refs.loading = !!loading;
        if (refs.textarea) refs.textarea.disabled = !!loading;
        var overlay = instance && instance.el;
        if (!overlay) return;

        /* 识别按钮：自定义「识别中」+ spinner（NC.ui 对 text node 的 is-loading 会与文字重叠） */
        var recognizeBtn = refs.recognizeButton;
        if (recognizeBtn) {
            if (loading && !refs.recognizeLoading) {
                refs.recognizeLoading = true;
                refs.recognizeText = String(recognizeBtn.textContent || '识别');
                recognizeBtn.classList.add('is-todo-loading');
                recognizeBtn.textContent = '';
                var spinner = document.createElement('span');
                spinner.className = 'nc-spinner';
                recognizeBtn.appendChild(spinner);
                var loadingText = document.createElement('span');
                loadingText.textContent = '识别中';
                recognizeBtn.appendChild(loadingText);
            } else if (!loading && refs.recognizeLoading) {
                refs.recognizeLoading = false;
                recognizeBtn.classList.remove('is-todo-loading');
                recognizeBtn.textContent = refs.recognizeText || '识别';
            }
        }

        var buttons = overlay.querySelectorAll('.nc-modal__foot .nc-btn');
        if (!refs.buttons) {
            refs.buttons = [];
            Array.prototype.forEach.call(buttons, function (button) {
                refs.buttons.push({ el: button, disabled: button.disabled });
            });
        }
        Array.prototype.forEach.call(buttons, function (button) {
            if (loading) button.disabled = true;
        });
        if (!loading) {
            refs.buttons.forEach(function (item) {
                if (item.el && item.el.parentNode) item.el.disabled = item.disabled;
            });
            refs.buttons = null;
        }
        overlay.classList.toggle('is-busy', !!loading);
        if (loading && refs.error) refs.error.hidden = true;
    }

    function showError(refs, error) {
        if (!refs || !refs.error) return;
        var info = normalizeError(error);
        var suffix = '';
        if (info.type === 'auth') suffix = '（请在设置 → 模型端点检查 API Key）';
        else if (info.type === 'config') suffix = '';
        else if (info.type === 'network') suffix = '（file:// 下需网关放行 CORS Origin: null）';
        else if (info.type === 'timeout') suffix = '，可稍后重试';
        refs.error.textContent = info.message + suffix;
        refs.error.hidden = false;
    }

    function clearError(refs) {
        if (refs && refs.error) {
            refs.error.hidden = true;
            refs.error.textContent = '';
        }
    }

    function openSettings() {
        try {
            if (NC.settingsPanel && typeof NC.settingsPanel.open === 'function') {
                NC.settingsPanel.open('todo-ai');
                return true;
            }
            if (NC.settingsPanel && typeof NC.settingsPanel.open === 'function') {
                NC.settingsPanel.open();
                return true;
            }
        } catch (err) { /* ignore */ }
        if (NC.ui && NC.ui.toast) {
            NC.ui.toast('设置面板尚未就绪，可在侧栏「设置」中配置 Todo AI', { type: 'info' });
        }
        return false;
    }

    function runRecognize(instance, refs) {
        if (refs.loading) return Promise.resolve(false);
        clearError(refs);
        var text = refs.textarea ? refs.textarea.value : '';
        if (!String(text).trim()) {
            showError(refs, { type: 'config', message: '请先粘贴要识别的文本' });
            if (refs.textarea) refs.textarea.focus();
            return Promise.resolve(false);
        }
        var controller = null;
        try {
            controller = new global.AbortController();
        } catch (err) { controller = null; }
        refs.abortController = controller;
        setDialogLoading(instance, refs, true);
        var startedAt = Date.now();
        return parseText(text, controller ? { signal: controller.signal } : {}).then(function (result) {
            setDialogLoading(instance, refs, false);
            if (!result || result.ok !== true) {
                showError(refs, result && result.error);
                return false;
            }
            if (result.data && result.data.dueAllDay && util.isFiniteNum(result.data.due)) {
                /* 全天任务：UI 只有 datetime-local，用下班时间表示"当天截止" */
                var dueDate = new Date(result.data.due);
                var workEnd = getWorkEndTime();
                var parts = /^(\d{1,2}):(\d{2})$/.exec(workEnd) || [null, 17, 30];
                dueDate.setHours(parseInt(parts[1], 10) || 0, parseInt(parts[2], 10) || 0, 0, 0);
                result.data.due = dueDate.getTime();
            }
            var filled = false;
            try {
                if (NC.tools && NC.tools.todo && typeof NC.tools.todo.fillDraft === 'function') {
                    filled = NC.tools.todo.fillDraft(result.data);
                }
            } catch (err) {
                filled = false;
            }
            if (!filled) {
                showError(refs, { type: 'parse', message: '识别完成但无法填充到表单，请重试或手动创建' });
                return false;
            }
            if (refs.abortController) refs.abortController = null;
            var elapsed = Date.now() - startedAt;
            if (NC.debug) NC.log('todoAi.done', elapsed + 'ms');
            if (instance && typeof instance.close === 'function') instance.close();
            return true;
        });
    }

    /**
     * 打开识别弹窗。
     * @param {string|{text?:string}} [prefill]
     */
    function openDialog(prefill) {
        if (!NC.ui || typeof NC.ui.openModal !== 'function') return null;
        if (openInstance) {
            var existing = openInstance;
            try {
                var refs = existing.__refs;
                if (refs && refs.textarea) {
                    if (typeof prefill === 'string' && prefill && !refs.textarea.value) refs.textarea.value = prefill;
                    refs.textarea.focus();
                }
            } catch (err) { /* ignore */ }
            return existing;
        }
        var initialText = typeof prefill === 'string'
            ? prefill
            : (prefill && prefill.text ? prefill.text : '');
        var refs = buildDialogContent(initialText);
        var target = refs.target;
        var actions = [
            { label: '取消', kind: 'ghost' }
        ];
        if (!target.configured) {
            actions.push({
                label: '打开设置',
                kind: 'outline',
                close: false,
                onClick: function () {
                    openSettings();
                    return false;
                }
            });
        }
        actions.push({
            label: '识别',
            kind: 'primary',
            close: false,
            onClick: function (instance) {
                runRecognize(instance, refs);
                return undefined;
            }
        });

        var instance = NC.ui.openModal({
            title: 'AI 识别待办',
            content: refs.node,
            size: 'lg',
            dismissible: true,
            initialFocus: refs.textarea,
            actions: actions,
            onClose: function () {
                if (refs.abortController) {
                    try { refs.abortController.abort(); } catch (err) { /* ignore */ }
                    refs.abortController = null;
                }
                openInstance = null;
            }
        });
        instance.__refs = refs;
        try {
            var footButtons = instance.el.querySelectorAll('.nc-modal__foot .nc-btn');
            refs.recognizeButton = footButtons.length ? footButtons[footButtons.length - 1] : null;
        } catch (err) { refs.recognizeButton = null; }
        openInstance = instance;

        /* loading 期间拦截 Esc / 遮罩点击，防止误关闭 */
        if (instance.el) {
            instance.el.addEventListener('click', function (event) {
                if (!refs.loading) return;
                event.stopPropagation();
                event.preventDefault();
            }, true);
            instance.el.addEventListener('keydown', function (event) {
                if (!refs.loading) return;
                if (event.key === 'Escape' || event.key === 'Enter') {
                    event.stopPropagation();
                    if (event.key === 'Escape') event.preventDefault();
                }
            }, true);
        }

        /* Ctrl/Cmd + Enter 快捷识别 */
        if (refs.textarea) {
            refs.textarea.addEventListener('keydown', function (event) {
                if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key === 'N' || event.key === 'n')) {
                    event.preventDefault();
                    var instance2 = openInstance;
                    if (instance2) {
                        var footButtons = instance2.el.querySelectorAll('.nc-modal__foot .nc-btn');
                        if (footButtons.length) footButtons[footButtons.length - 1].click();
                    }
                }
            });
        }
        return instance;
    }

    /* ------------------------------------------------------------------ *
     * 对外 API
     * ------------------------------------------------------------------ */
    NC.todoAi = {
        DEFAULT_PROMPT: DEFAULT_PROMPT,
        PLACEHOLDERS: ['{{NOW}}', '{{DATE}}', '{{WEEKDAY}}', '{{TZ}}', '{{WORK_END}}'],
        buildSystemPrompt: buildSystemPrompt,
        normalizeData: normalizeData,
        normalizeDue: normalizeDue,
        parseText: parseText,
        openDialog: openDialog,
        isConfigured: isConfigured,
        describeTarget: describeTarget,
        getWorkEndTime: getWorkEndTime
    };

    events.emit('todo-ai:ready', {});
})(window);
