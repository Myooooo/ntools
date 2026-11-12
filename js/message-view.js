/**
 * message-view.js — 聊天消息渲染与交互
 * 经典脚本，依赖 core.js、icons.js、schema-chat.js、marked、DOMPurify。
 * 挂载到 NC.view.messages。
 *
 * 职责边界：只读消息快照、只写 DOM；不读写 localStorage、不发请求。
 * 操作按钮通过回调交给组合根：onCopy/onRegenerate/onEdit/onDelete。
 *
 * 安全：用户文本一律 textContent；Markdown 一律 DOMPurify.sanitize；
 *       外部链接 target=_blank + rel=noopener；远程图片降级为链接（防追踪）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var icons = NC.icons;

    var container = null;
    var listEl = null;
    var options = {};
    var dataById = Object.create(null);
    var elById = Object.create(null);
    var order = [];
    var errorEls = [];
    var streaming = false;
    var typingEl = null;
    var emptyEl = null;
    var emptyText = '';
    var autoFollow = true;
    var lightboxEl = null;
    var lightboxImg = null;
    var lightboxPrevFocus = null;
    var markedConfigured = false;

    var ACTION_LABELS = {
        copy: '复制',
        regenerate: '重新生成',
        edit: '编辑',
        delete: '删除'
    };

    function schema() {
        return NC.schema && NC.schema.chat;
    }

    function configureMarked() {
        if (markedConfigured) return;
        markedConfigured = true;
        if (global.marked && typeof global.marked.setOptions === 'function') {
            global.marked.setOptions({ breaks: true, gfm: true });
        }
    }

    /** Markdown → 已净化 HTML 字符串。测试/外部可直接调用。 */
    function renderMarkdown(text) {
        configureMarked();
        var source = typeof text === 'string' ? text : '';
        if (!source) return '';
        var html;
        try {
            html = global.marked && typeof global.marked.parse === 'function'
                ? global.marked.parse(source)
                : util.escapeHtml(source);
        } catch (err) {
            html = util.escapeHtml(source);
        }
        try {
            if (global.DOMPurify && typeof global.DOMPurify.sanitize === 'function') {
                html = global.DOMPurify.sanitize(html, {
                    ADD_ATTR: ['target', 'rel'],
                    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'video', 'audio', 'input', 'button', 'select', 'textarea'],
                    FORBID_ATTR: ['style']
                });
            }
        } catch (err) {
            html = util.escapeHtml(source);
        }
        return html;
    }

    function renderMarkdownInto(el, text) {
        el.innerHTML = renderMarkdown(text);
        var links = el.querySelectorAll('a[href]');
        Array.prototype.forEach.call(links, function (link) {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
            link.classList.add('chat-link');
        });
        var images = el.querySelectorAll('img');
        Array.prototype.forEach.call(images, function (img) {
            var src = img.getAttribute('src') || '';
            if (!/^data:image\//i.test(src)) {
                var fallback = document.createElement('a');
                fallback.href = src;
                fallback.target = '_blank';
                fallback.rel = 'noopener noreferrer';
                fallback.className = 'chat-link';
                fallback.textContent = '[图片]';
                img.parentNode.replaceChild(fallback, img);
                return;
            }
            img.classList.add('chat-md__img');
            img.setAttribute('loading', 'lazy');
            img.setAttribute('referrerpolicy', 'no-referrer');
            if (!img.getAttribute('alt')) img.setAttribute('alt', '图片');
        });
        var tables = el.querySelectorAll('table');
        Array.prototype.forEach.call(tables, function (table) {
            if (table.parentNode && table.parentNode.classList.contains('chat-table-wrap')) return;
            var wrap = document.createElement('div');
            wrap.className = 'chat-table-wrap';
            table.parentNode.insertBefore(wrap, table);
            wrap.appendChild(table);
        });
    }

    /* ------------------------------------------------------------------ *
     * 基础结构
     * ------------------------------------------------------------------ */
    function messageEl(id) {
        return elById[id] || null;
    }

    function contentEl(article) {
        return article ? article.querySelector('.chat-msg__content') : null;
    }

    function createIconButton(name, action, label, mutating) {
        var button = util.e('button', {
            type: 'button',
            class: 'chat-msg__action',
            title: label,
            'aria-label': label,
            dataset: { action: action, mutating: mutating ? 'true' : 'false' }
        }, [icons.el(name, 16)]);
        return button;
    }

    function buildStatsButton(message) {
        var stats = message.stats;
        if (!stats) return null;
        var wrap = util.e('div', { class: 'chat-stats' });
        var button = util.e('button', {
            type: 'button',
            class: 'chat-msg__action chat-stats__btn',
            title: '性能统计',
            'aria-label': '查看性能统计',
            'aria-expanded': 'false'
        }, [icons.el('info', 16)]);
        var panel = util.e('div', { class: 'chat-stats__panel', role: 'group', 'aria-label': '性能统计' });

        function row(label, value) {
            panel.appendChild(util.e('div', { class: 'chat-stats__row' }, [
                util.e('span', { class: 'chat-stats__label', text: label }),
                util.e('span', { class: 'chat-stats__value', text: value })
            ]));
        }
        row('Prompt', (stats.contextLength || 0) + ' tokens');
        row('Output', (stats.outputLength || 0) + ' tokens');
        row('Total', (stats.totalLength || 0) + ' tokens');
        row('Rate', (stats.outputRate || 0) + ' t/s');
        if (stats.outputTime) row('Time', stats.outputTime + ' s');
        if (stats.estimated) {
            panel.appendChild(util.e('div', { class: 'chat-stats__hint', text: '※ 部分数值为估算' }));
        }
        button.addEventListener('click', function (event) {
            event.stopPropagation();
            var open = !wrap.classList.contains('is-open');
            closeAllStats();
            wrap.classList.toggle('is-open', open);
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
            var article = wrap.closest('.chat-msg');
            if (article) article.classList.toggle('has-open-stats', open);
        });
        wrap.appendChild(button);
        wrap.appendChild(panel);
        return wrap;
    }

    function buildFooter(message) {
        var footer = util.e('div', { class: 'chat-msg__actions' });
        var statsWrap = buildStatsButton(message);
        if (statsWrap) footer.appendChild(statsWrap);
        footer.appendChild(createIconButton('copy', 'copy', '复制', false));
        footer.appendChild(createIconButton('refresh', 'regenerate', '重新生成', true));
        footer.appendChild(createIconButton('edit', 'edit', '编辑', true));
        footer.appendChild(createIconButton('trash', 'delete', '删除', true));
        return footer;
    }

    function ensureReasoning(article) {
        var existing = article.querySelector('.chat-reasoning');
        if (existing) return existing;
        var details = util.e('details', { class: 'chat-reasoning' });
        details.appendChild(util.e('summary', {
            class: 'chat-reasoning__summary',
            text: '正在思考...'
        }));
        var body = util.e('div', { class: 'chat-reasoning__body chat-md' });
        details.appendChild(body);
        var bubble = article.querySelector('.chat-msg__bubble');
        bubble.insertBefore(details, bubble.firstChild);
        return details;
    }

    function renderUserContent(el, message) {
        el.textContent = '';
        var parts = Array.isArray(message.content) ? message.content : [];
        var texts = [];
        var images = [];
        parts.forEach(function (part) {
            if (!part || typeof part !== 'object') return;
            if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
            else if (part.type === 'image_url' && part.image_url) images.push(part.image_url.url);
        });
        if (texts.length) {
            el.appendChild(util.e('div', { class: 'chat-msg__text', text: texts.join('\n\n') }));
        }
        if (images.length) {
            var box = util.e('div', { class: 'chat-images' });
            var imageSchema = schema();
            images.forEach(function (url) {
                var allowed = imageSchema ? imageSchema.isAllowedImageUrl(url) : /^data:image\//i.test(url);
                if (!allowed) return;
                var button = util.e('button', {
                    type: 'button',
                    class: 'chat-image',
                    title: '查看图片',
                    'aria-label': '查看图片'
                });
                var img = util.e('img', {
                    class: 'chat-image__img',
                    alt: '用户发送的图片',
                    loading: 'lazy'
                });
                img.src = url;
                button.appendChild(img);
                button.addEventListener('click', function () { openLightbox(url, '用户发送的图片'); });
                box.appendChild(button);
            });
            el.appendChild(box);
        }
    }

    function renderAssistantContent(el, message) {
        if (typeof message.content === 'string' && message.content) {
            renderMarkdownInto(el, message.content);
        } else {
            el.textContent = '';
        }
    }

    function createMessageElement(message) {
        var role = message.role === 'user' ? 'user' : 'assistant';
        var article = util.e('article', {
            class: 'chat-msg chat-msg--' + role + ' message',
            dataset: { id: message.id }
        });
        var bubble = util.e('div', { class: 'chat-msg__bubble' });
        article.appendChild(bubble);
        var content = util.e('div', { class: 'chat-msg__content' });
        if (role === 'user') {
            content.classList.add('chat-msg__content--plain');
            renderUserContent(content, message);
        } else {
            content.classList.add('chat-md');
            renderAssistantContent(content, message);
        }
        bubble.appendChild(content);
        bubble.appendChild(util.e('span', { class: 'chat-caret', 'aria-hidden': 'true' }));
        if (role === 'assistant' && message.reasoning) {
            var details = ensureReasoning(article);
            var body = details.querySelector('.chat-reasoning__body');
            renderMarkdownInto(body, message.reasoning);
            var summary = details.querySelector('.chat-reasoning__summary');
            summary.textContent = message.reasoningTime != null
                ? '已思考 (用时 ' + Number(message.reasoningTime).toFixed(1) + ' 秒)'
                : '已思考';
            details.open = false;
        }
        bubble.appendChild(buildFooter(message));
        if (message.streaming) {
            article.classList.add('is-streaming');
            setMutatingDisabled(article, true);
        }
        return article;
    }

    function setMutatingDisabled(article, disabled) {
        var buttons = article.querySelectorAll('[data-mutating="true"]');
        Array.prototype.forEach.call(buttons, function (button) { button.disabled = !!disabled; });
    }

    function nearBottom() {
        if (!container) return true;
        return container.scrollHeight - container.scrollTop - container.clientHeight <= 80;
    }

    function notifyFollow() {
        if (typeof options.onFollowChange === 'function') options.onFollowChange(nearBottom());
    }

    function updateFollow() {
        var next = nearBottom();
        if (next !== autoFollow) {
            autoFollow = next;
            notifyFollow();
        }
    }

    function scrollToBottom(force) {
        if (!container) return;
        if (!force && !autoFollow) return;
        (global.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
            container.scrollTop = container.scrollHeight;
        });
    }

    /* ------------------------------------------------------------------ *
     * 灯箱 / 统计浮层 / 操作
     * ------------------------------------------------------------------ */
    function openLightbox(src, alt) {
        if (!lightboxEl || !lightboxImg || !src) return;
        lightboxPrevFocus = document.activeElement;
        lightboxImg.src = src;
        lightboxImg.alt = alt || '图片预览';
        lightboxEl.hidden = false;
        (global.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
            lightboxEl.classList.add('is-open');
        });
        var closeBtn = document.getElementById('lightbox-close');
        if (closeBtn) closeBtn.focus();
    }

    function closeLightbox() {
        if (!lightboxEl || lightboxEl.hidden) return;
        lightboxEl.classList.remove('is-open');
        lightboxEl.hidden = true;
        lightboxImg.removeAttribute('src');
        if (lightboxPrevFocus && lightboxPrevFocus.focus) {
            try { lightboxPrevFocus.focus(); } catch (err) { /* ignore */ }
        }
        lightboxPrevFocus = null;
    }

    function closeAllStats(except) {
        var wraps = listEl ? listEl.querySelectorAll('.chat-stats.is-open') : [];
        Array.prototype.forEach.call(wraps, function (wrap) {
            if (wrap === except) return;
            wrap.classList.remove('is-open');
            var button = wrap.querySelector('.chat-stats__btn');
            if (button) button.setAttribute('aria-expanded', 'false');
            var article = wrap.closest('.chat-msg');
            if (article) article.classList.remove('has-open-stats');
        });
    }

    function getCopyText(message) {
        if (message.role === 'user' && Array.isArray(message.content)) {
            return message.content.filter(function (part) {
                return part && part.type === 'text';
            }).map(function (part) { return part.text; }).join('\n');
        }
        return typeof message.content === 'string' ? message.content : '';
    }

    function flashCopied(button) {
        if (!button) return;
        button.innerHTML = '';
        button.appendChild(icons.el('check', 16));
        button.classList.add('is-success');
        button.setAttribute('aria-label', '已复制');
        setTimeout(function () {
            if (!button.parentNode) return;
            button.innerHTML = '';
            button.appendChild(icons.el('copy', 16));
            button.classList.remove('is-success');
            button.setAttribute('aria-label', '复制');
        }, 1600);
    }

    function handleAction(action, id, button) {
        var message = dataById[id];
        if (!message) return;
        if (action === 'copy') {
            var text = getCopyText(message);
            var result;
            try {
                result = typeof options.onCopy === 'function' ? options.onCopy(text, message) : false;
            } catch (err) {
                result = false;
            }
            Promise.resolve(result).then(function (ok) {
                if (ok) flashCopied(button);
                else if (typeof options.onError === 'function') options.onError('复制失败');
            }, function () {
                if (typeof options.onError === 'function') options.onError('复制失败');
            });
            return;
        }
        var callbackMap = {
            regenerate: options.onRegenerate,
            edit: options.onEdit,
            delete: options.onDelete
        };
        if (typeof callbackMap[action] === 'function') callbackMap[action](id, message);
    }

    /* ------------------------------------------------------------------ *
     * 空状态 / 输入中提示 / 错误
     * ------------------------------------------------------------------ */
    var WELCOME_SUGGESTIONS = [
        '帮我总结一段文字',
        '写一个提取 JSON 字段的函数',
        '解释一个技术概念'
    ];

    function ensureEmptyEl() {
        if (emptyEl && emptyEl.parentNode) return emptyEl;
        emptyEl = util.e('div', { class: 'chat-welcome message', hidden: true });
        var inner = util.e('div', { class: 'chat-welcome__inner' });
        inner.appendChild(util.e('div', { class: 'chat-welcome__icon' }, [icons.el('sparkles', 26)]));
        inner.appendChild(util.e('p', { class: 'chat-welcome__title' }));
        inner.appendChild(util.e('p', {
            class: 'chat-welcome__hint',
            text: '本地运行 · 支持多配置、图片对话与思考过程'
        }));
        var chips = util.e('div', { class: 'chat-welcome__chips' });
        WELCOME_SUGGESTIONS.forEach(function (prompt) {
            var chip = util.e('button', { type: 'button', class: 'chat-chip', text: prompt });
            chip.addEventListener('click', function () {
                if (typeof options.onSuggestion === 'function') options.onSuggestion(prompt);
            });
            chips.appendChild(chip);
        });
        inner.appendChild(chips);
        emptyEl.appendChild(inner);
        listEl.appendChild(emptyEl);
        return emptyEl;
    }

    function syncEmpty() {
        if (!container) return;
        var el = ensureEmptyEl();
        var count = Object.keys(elById).length;
        if (!emptyText || count > 0 || errorEls.length > 0) {
            el.hidden = true;
            return;
        }
        el.querySelector('.chat-welcome__title').textContent = emptyText;
        el.hidden = false;
    }

    function setEmpty(text) {
        emptyText = text || '';
        syncEmpty();
    }

    function ensureTypingEl() {
        if (typingEl && typingEl.parentNode) return typingEl;
        typingEl = util.e('div', {
            class: 'chat-typing',
            role: 'status',
            'aria-label': '正在生成回复'
        }, [
            util.e('span', {}), util.e('span', {}), util.e('span', {})
        ]);
        listEl.appendChild(typingEl);
        return typingEl;
    }

    function setTyping(on) {
        if (!container) return;
        var el = ensureTypingEl();
        el.hidden = !on;
        if (on) scrollToBottom(false);
    }

    function addError(text) {
        if (!container) return;
        var article = util.e('div', { class: 'chat-msg chat-msg--error message', role: 'alert' });
        var bubble = util.e('div', { class: 'chat-msg__bubble' });
        var content = util.e('div', { class: 'chat-msg__content', text: String(text == null ? '' : text) });
        bubble.appendChild(content);
        article.appendChild(bubble);
        container.appendChild(article);
        errorEls.push(article);
        syncEmpty();
        scrollToBottom(false);
    }

    function clearErrors() {
        errorEls.forEach(function (el) {
            if (el.parentNode) el.parentNode.removeChild(el);
        });
        errorEls = [];
    }

    /* ------------------------------------------------------------------ *
     * 列表渲染
     * ------------------------------------------------------------------ */
    function updateMessageElement(article, message) {
        var content = contentEl(article);
        if (message.role === 'user') {
            content.classList.add('chat-msg__content--plain');
            renderUserContent(content, message);
        } else {
            content.classList.add('chat-md');
            renderAssistantContent(content, message);
        }
        var oldFooter = article.querySelector('.chat-msg__actions');
        var newFooter = buildFooter(message);
        if (oldFooter) oldFooter.parentNode.replaceChild(newFooter, oldFooter);
        else article.querySelector('.chat-msg__bubble').appendChild(newFooter);
        if (message.reasoning) {
            var details = ensureReasoning(article);
            var body = details.querySelector('.chat-reasoning__body');
            renderMarkdownInto(body, message.reasoning);
            var summary = details.querySelector('.chat-reasoning__summary');
            if (message.reasoningStreaming) {
                summary.textContent = '正在思考...';
                details.open = true;
            } else {
                summary.textContent = message.reasoningTime != null
                    ? '已思考 (用时 ' + Number(message.reasoningTime).toFixed(1) + ' 秒)'
                    : '已思考';
                details.open = false;
            }
        } else {
            var existing = article.querySelector('.chat-reasoning');
            if (existing) existing.parentNode.removeChild(existing);
        }
        article.classList.toggle('is-streaming', !!message.streaming);
        if (streaming) setMutatingDisabled(article, true);
    }

    function add(message) {
        if (!container || !message || !message.id) return null;
        clearErrors();
        var article = createMessageElement(message);
        dataById[message.id] = message;
        elById[message.id] = article;
        if (order.indexOf(message.id) === -1) order.push(message.id);
        listEl.appendChild(article);
        syncEmpty();
        scrollToBottom(false);
        return article;
    }

    function update(id, patch) {
        var message = dataById[id];
        if (!message) return;
        if (patch && typeof patch === 'object') {
            Object.keys(patch).forEach(function (key) { message[key] = patch[key]; });
        }
        var article = messageEl(id);
        if (!article) return;
        var streamingFlag = streaming || !!message.streaming;
        var content = contentEl(article);
        if (patch && (patch.content !== undefined || patch.reasoning !== undefined
            || patch.reasoningStreaming !== undefined || patch.reasoningTime !== undefined
            || patch.stats !== undefined)) {
            if (message.role === 'user') {
                renderUserContent(content, message);
            } else {
                renderAssistantContent(content, message);
            }
            if (patch.stats !== undefined) {
                var footer = article.querySelector('.chat-msg__actions');
                if (footer) {
                    var newFooter = buildFooter(message);
                    footer.parentNode.replaceChild(newFooter, footer);
                    if (streamingFlag) setMutatingDisabled(article, true);
                }
            }
            if (typeof message.reasoning === 'string' && message.reasoning) {
                var details = ensureReasoning(article);
                var body = details.querySelector('.chat-reasoning__body');
                renderMarkdownInto(body, message.reasoning);
                var summary = details.querySelector('.chat-reasoning__summary');
                if (message.reasoningStreaming) {
                    summary.textContent = '正在思考...';
                    details.open = true;
                } else {
                    summary.textContent = message.reasoningTime != null
                        ? '已思考 (用时 ' + Number(message.reasoningTime).toFixed(1) + ' 秒)'
                        : '已思考';
                    if (message.streaming !== true) details.open = false;
                }
            } else {
                var staleReasoning = article.querySelector('.chat-reasoning');
                if (staleReasoning && staleReasoning.parentNode) {
                    staleReasoning.parentNode.removeChild(staleReasoning);
                }
            }
        }
        if (patch && patch.streaming !== undefined) {
            article.classList.toggle('is-streaming', !!message.streaming);
            setMutatingDisabled(article, streamingFlag);
        }
        if (patch && (patch.content !== undefined || patch.reasoning !== undefined)) {
            scrollToBottom(false);
        }
    }

    function remove(id) {
        var article = messageEl(id);
        if (article) {
            var finish = function () {
                if (article.parentNode) article.parentNode.removeChild(article);
                delete elById[id];
            };
            var lite = document.documentElement.getAttribute('data-lite') === 'true';
            if (!lite && util.prefersReducedMotion && !util.prefersReducedMotion()) {
                article.classList.add('nc-list-leave');
                setTimeout(finish, 130);
            } else {
                finish();
            }
        }
        delete dataById[id];
        syncEmpty();
        var index = order.indexOf(id);
        if (index > -1) order.splice(index, 1);
    }

    function renderAll(messages) {
        if (!container) return;
        clearErrors();
        var list = Array.isArray(messages) ? messages : [];
        var seen = Object.create(null);
        dataById = Object.create(null);
        order = [];
        list.forEach(function (message) {
            if (!message || !message.id) return;
            seen[message.id] = true;
            order.push(message.id);
            dataById[message.id] = message;
            var article = elById[message.id];
            if (!article) {
                article = createMessageElement(message);
                elById[message.id] = article;
            } else {
                updateMessageElement(article, message);
            }
            listEl.appendChild(article);
        });
        Object.keys(elById).forEach(function (id) {
            if (!seen[id]) {
                var article = elById[id];
                if (article.parentNode) article.parentNode.removeChild(article);
                delete elById[id];
            }
        });
        syncEmpty();
        if (streaming) {
            Object.keys(elById).forEach(function (id) { setMutatingDisabled(elById[id], true); });
        }
        scrollToBottom(true);
    }

    function setStreaming(on) {
        streaming = !!on;
        if (!container) return;
        container.classList.toggle('is-streaming', streaming);
        container.setAttribute('aria-busy', streaming ? 'true' : 'false');
        Object.keys(elById).forEach(function (id) {
            setMutatingDisabled(elById[id], streaming);
        });
    }

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function init(containerEl, opts) {
        container = containerEl;
        options = opts || {};
        dataById = Object.create(null);
        elById = Object.create(null);
        order = [];
        errorEls = [];
        container.classList.add('chat-scroll');
        container.textContent = '';
        listEl = util.e('div', { class: 'chat-list', role: 'list' });
        container.appendChild(listEl);

        container.addEventListener('scroll', util.throttle(updateFollow, 90));

        util.delegate(container, 'click', '.chat-msg__action', function (event, button) {
            var article = button.closest('.chat-msg');
            var id = article && article.getAttribute('data-id');
            var action = button.getAttribute('data-action');
            if (id && action) handleAction(action, id, button);
        });

        document.addEventListener('click', function (event) {
            var target = event.target;
            if (!target || !target.closest) return;
            if (target.closest('.chat-stats')) return;
            closeAllStats();
        });

        lightboxEl = document.getElementById('image-lightbox');
        lightboxImg = document.getElementById('lightbox-img');
        var lightboxClose = document.getElementById('lightbox-close');
        if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
        if (lightboxEl) {
            lightboxEl.addEventListener('click', function (event) {
                if (event.target === lightboxEl) closeLightbox();
            });
        }

        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;
            if (lightboxEl && !lightboxEl.hidden) closeLightbox();
            else closeAllStats();
        });

        ensureEmptyEl();
        setEmpty('你好，有什么可以帮你？');
        notifyFollow();
    }

    NC.view = NC.view || {};
    NC.view.messages = {
        init: init,
        renderAll: renderAll,
        add: add,
        update: update,
        remove: remove,
        setStreaming: setStreaming,
        setTyping: setTyping,
        setEmpty: setEmpty,
        addError: addError,
        clearErrors: clearErrors,
        scrollToBottom: scrollToBottom,
        renderMarkdown: renderMarkdown,
        openLightbox: openLightbox,
        closeLightbox: closeLightbox,
        getCopyText: getCopyText
    };
})(window);
