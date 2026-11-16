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
    var endSentinel = null;
    var followObserver = null;
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
        var clean = sanitizeHtml(html);
        /* 净化后为空且原文非空：说明整段被裁掉了，退回转义文本而不是空白 */
        return clean || util.escapeHtml(source);
    }

    /** 净化一段 HTML（与 renderMarkdown 同一口径） */
    function sanitizeHtml(html) {
        try {
            if (global.DOMPurify && typeof global.DOMPurify.sanitize === 'function') {
                return global.DOMPurify.sanitize(html, {
                    USE_PROFILES: { html: true },
                    ADD_ATTR: ['target', 'rel'],
                    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'video', 'audio', 'input', 'button', 'select', 'textarea'],
                    FORBID_ATTR: ['style']
                });
            }
        } catch (err) { /* 落到原文转义 */ }
        return html;
    }

    /** 单块装饰：外链、图片降级、表格包裹、代码/公式增强。作用于某一个容器。 */
    function decorate(el) {
        if (!el) return;
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
        if (NC.mdEnhance && typeof NC.mdEnhance.enhance === 'function') {
            NC.mdEnhance.enhance(el);
        }
    }

    function renderMarkdownInto(el, text) {
        el.__mdStream = null;
        el.innerHTML = renderMarkdown(text);
        decorate(el);
    }

    /**
     * 流式增量渲染。
     *
     * 用 marked.lexer 把当前全文切成块，已结束的块只渲染一次，只有"最后一块"
     * 每次重渲——否则每 60ms 一次全量 parse+DOMPurify+innerHTML 会让流式成本
     * 随文本长度二次增长（弱机上表现为"越写越卡"）。
     *
     * 结构：[已完成节点…] [尾块节点…] <!--marker-->
     * 尾块每次 flush 先删除再重建；marker 始终留在末尾。
     */
    function renderMarkdownStreaming(el, text) {
        var source = typeof text === 'string' ? text : '';
        var marked = global.marked;
        if (!marked || typeof marked.lexer !== 'function' || typeof marked.parser !== 'function' || !source) {
            renderMarkdownInto(el, source);
            return;
        }
        var state = el.__mdStream;
        if (state && state.text === source) return;

        var tokens;
        try {
            tokens = marked.lexer(source);
        } catch (err) {
            renderMarkdownInto(el, source);
            return;
        }
        if (!Array.isArray(tokens)) {
            renderMarkdownInto(el, source);
            return;
        }
        var finalCount = Math.max(0, tokens.length - 1);

        /* token 数量回退（解析器合并）或首次渲染：重建骨架 */
        if (!state || state.finalCount > finalCount) {
            el.textContent = '';
            state = {
                marker: document.createComment('md-tail'),
                done: 0,
                finalCount: 0,
                text: ''
            };
            el.appendChild(state.marker);
            el.__mdStream = state;
        }

        /* 清空尾块 */
        while (state.marker.nextSibling) {
            state.marker.parentNode.removeChild(state.marker.nextSibling);
        }

        function buildBlock(token) {
            var html;
            try {
                html = sanitizeHtml(marked.parser([token]));
            } catch (err) {
                return null;
            }
            if (!html) return null;
            var box = document.createElement('div');
            box.innerHTML = html;
            decorate(box);
            var frag = document.createDocumentFragment();
            while (box.firstChild) frag.appendChild(box.firstChild);
            return frag.childNodes.length ? frag : null;
        }

        /* 新完成的块只渲染一次 */
        for (var i = state.done; i < finalCount; i += 1) {
            var chunk = buildBlock(tokens[i]);
            if (chunk) el.insertBefore(chunk, state.marker);
        }
        state.done = finalCount;

        /* 尾块每次重建：结构是 [已完成…][marker][尾块…]，
         * 尾块必须落在 marker 之后，下一次才能用 marker.nextSibling 整段清掉。 */
        var tail = tokens.length ? buildBlock(tokens[tokens.length - 1]) : null;
        if (tail) el.appendChild(tail);

        state.finalCount = finalCount;
        state.text = source;
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

    function buildVersionControls(message) {
        var store = NC.store && NC.store.conversation;
        if (!store || typeof store.getVersions !== 'function') return null;
        var versions = store.getVersions(message.id);
        if (!versions || !versions.ids || versions.ids.length < 2) return null;
        var wrap = util.e('div', { class: 'chat-versions', role: 'group', 'aria-label': '切换回复版本' });
        var prev = util.e('button', {
            type: 'button',
            class: 'chat-versions__btn',
            title: '上一版本',
            'aria-label': '上一版本',
            'data-action': 'version-prev'
        });
        prev.appendChild(icons.el('chevron-left', 14));
        if (versions.index <= 0) { prev.disabled = true; }
        var label = util.e('span', { class: 'chat-versions__label', text: (versions.index + 1) + ' / ' + versions.ids.length });
        var next = util.e('button', {
            type: 'button',
            class: 'chat-versions__btn',
            title: '下一版本',
            'aria-label': '下一版本',
            'data-action': 'version-next'
        });
        next.appendChild(icons.el('chevron-right', 14));
        if (versions.index >= versions.ids.length - 1) { next.disabled = true; }
        wrap.appendChild(prev);
        wrap.appendChild(label);
        wrap.appendChild(next);
        return wrap;
    }

    function buildFooter(message) {
        var footer = util.e('div', { class: 'chat-msg__actions' });
        var statsWrap = buildStatsButton(message);
        if (statsWrap) footer.appendChild(statsWrap);
        var versionWrap = buildVersionControls(message);
        if (versionWrap) footer.appendChild(versionWrap);
        footer.appendChild(createIconButton('copy', 'copy', '复制', false));
        footer.appendChild(createIconButton('refresh', 'regenerate', '重新生成', true));
        footer.appendChild(createIconButton('edit', 'edit', '编辑', true));
        footer.appendChild(createIconButton('trash', 'delete', '删除', true));
        return footer;
    }

    function reasoningLabel(message) {
        var time = message.reasoningTime;
        if (message.reasoningStreaming) return '思考中…';
        if (time != null && isFinite(Number(time))) {
            return '思考过程 ' + Number(time).toFixed(1) + 's';
        }
        return '思考过程';
    }

    /** 当前是否应跳过位移动画（Lite / reduced-motion）。 */
    function prefersReducedMotionNow() {
        try {
            if (document.documentElement.getAttribute('data-lite') === 'true') return true;
            return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (err) {
            return false;
        }
    }

    /**
     * 思考过程展开/收起：details 原生切换太快且无法过渡关闭，
     * 这里接管 click，用 max-height/opacity 做 180ms 的双向过渡（tokens 驱动）。
     * 流式追加（程序化 details.open=true）不播动画，保持即时。
     */
    function setReasoningOpen(details, open) {
        var body = details.querySelector('.chat-reasoning__body');
        if (!body) {
            details.open = open;
            return;
        }
        if (details.__ncAnimBusy) return;
        if (prefersReducedMotionNow()) {
            details.open = open;
            return;
        }
        details.__ncAnimBusy = true;
        if (open) {
            var target = Math.max(1, Math.min(body.scrollHeight || 0, 240));
            details.open = true;
            body.style.overflow = 'hidden';
            body.style.maxHeight = '0px';
            body.style.opacity = '0';
            body.style.transform = 'translateY(-2px)';
            void body.offsetHeight; // force reflow so the transition starts from 0
            body.style.transition = 'max-height var(--nc-dur) var(--nc-ease-out), opacity var(--nc-dur-fast) var(--nc-ease-out), transform var(--nc-dur-fast) var(--nc-ease-out)';
            body.style.maxHeight = target + 'px';
            body.style.opacity = '1';
            body.style.transform = 'none';
        } else {
            var height = body.scrollHeight || 0;
            body.style.overflow = 'hidden';
            body.style.maxHeight = height + 'px';
            body.style.opacity = '1';
            void body.offsetHeight;
            body.style.transition = 'max-height var(--nc-dur) var(--nc-ease-out), opacity var(--nc-dur-fast) var(--nc-ease-out), transform var(--nc-dur-fast) var(--nc-ease-out)';
            body.style.maxHeight = '0px';
            body.style.opacity = '0';
            body.style.transform = 'translateY(-2px)';
        }
        setTimeout(function () {
            details.__ncAnimBusy = false;
            if (!open) details.open = false;
            body.style.transition = '';
            body.style.maxHeight = '';
            body.style.overflow = '';
            body.style.opacity = '';
            body.style.transform = '';
        }, open ? 200 : 190);
    }

    function bindReasoningToggle(details) {
        var summary = details.querySelector('.chat-reasoning__summary');
        if (!summary || summary.__ncReasoningBound) return;
        summary.__ncReasoningBound = true;
        summary.addEventListener('click', function (event) {
            event.preventDefault();
            setReasoningOpen(details, !details.open);
        });
    }

    function ensureReasoning(article) {
        var existing = article.querySelector('.chat-reasoning');
        if (existing) return existing;
        var details = util.e('details', { class: 'chat-reasoning' });
        details.appendChild(util.e('summary', {
            class: 'chat-reasoning__summary',
            text: '思考中…'
        }));
        var body = util.e('div', { class: 'chat-reasoning__body chat-md' });
        details.appendChild(body);
        bindReasoningToggle(details);
        var bubble = article.querySelector('.chat-msg__bubble');
        bubble.insertBefore(details, bubble.firstChild);
        return details;
    }

    function formatAttachmentSize(size) {
        var n = Number(size) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function downloadAttachment(attachment) {
        try {
            var blob = new Blob([attachment.text || ''], { type: attachment.type || 'text/plain;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = attachment.name || 'attachment.txt';
            document.body.appendChild(link);
            link.click();
            link.parentNode.removeChild(link);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1200);
        } catch (err) { /* ignore */ }
    }

    function renderAttachments(el, message) {
        var list = Array.isArray(message.attachments) ? message.attachments : [];
        if (!list.length) return;
        var box = util.e('div', { class: 'chat-attachments', 'aria-label': '附件' });
        list.forEach(function (attachment) {
            if (!attachment || !attachment.name) return;
            var button = util.e('button', {
                type: 'button',
                class: 'chat-attachment',
                title: '下载附件：' + attachment.name,
                'aria-label': '下载附件：' + attachment.name
            });
            button.appendChild(icons.el('file', 12));
            button.appendChild(util.e('span', { class: 'chat-attachment__name', text: attachment.name }));
            if (attachment.size) {
                button.appendChild(util.e('span', { class: 'chat-attachment__size', text: formatAttachmentSize(attachment.size) }));
            }
            button.addEventListener('click', function () { downloadAttachment(attachment); });
            box.appendChild(button);
        });
        if (box.children.length) el.appendChild(box);
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
        renderAttachments(el, message);
    }

    function renderAssistantContent(el, message) {
        if (typeof message.content === 'string' && message.content) {
            if (message.streaming === true) renderMarkdownStreaming(el, message.content);
            else renderMarkdownInto(el, message.content);
        } else {
            el.__mdStream = null;
            el.textContent = '';
        }
    }

    function createMessageElement(message) {
        var role = message.role === 'user' ? 'user' : 'assistant';
        var article = util.e('article', {
            class: 'chat-msg chat-msg--' + role + ' message',
            dataset: { id: message.id },
            'aria-label': role === 'user' ? '你的消息' : '助手消息'
        });
        // 访谈记录式角色刻度：只在助手消息左侧保留「助手」刻度；
        // 用户消息靠右侧蓝块表达角色，不再在最左 gutter 放「你」（避免标签与内容脱节）。
        if (role === 'assistant') {
            article.appendChild(util.e('span', {
                class: 'chat-msg__role',
                'aria-hidden': 'true',
                text: '助手'
            }));
        }
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
            if (message.reasoningStreaming === true) renderMarkdownStreaming(body, message.reasoning);
            else renderMarkdownInto(body, message.reasoning);
            var summary = details.querySelector('.chat-reasoning__summary');
            summary.textContent = reasoningLabel(message);
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

    function setFollow(next) {
        next = !!next;
        if (next === autoFollow) return;
        autoFollow = next;
        notifyFollow();
    }

    function setupFollowWatcher() {
        if (!container) return;
        // 底部哨兵 + IntersectionObserver：不读 scrollHeight/scrollTop（避免流式期间
        // 每帧强制布局），80px rootMargin 与原来的“距底 80px 算跟随”一致。
        if (followObserver) {
            followObserver.disconnect();
            followObserver = null;
        }
        if (endSentinel && endSentinel.parentNode) {
            endSentinel.parentNode.removeChild(endSentinel);
        }
        endSentinel = null;

        if (typeof global.IntersectionObserver !== 'function') {
            // 老内核降级：用原滚动阈值（passive，仍有节流）
            container.addEventListener('scroll', util.throttle(updateFollow, 90), { passive: true });
            return;
        }

        endSentinel = util.e('div', { class: 'chat-end-sentinel', 'aria-hidden': 'true' });
        container.appendChild(endSentinel);

        followObserver = new global.IntersectionObserver(function (entries) {
            var entry = entries && entries[0];
            if (!entry || entry.target !== endSentinel) return;
            // 面板隐藏（切到其他 tab）时高度为 0，不据此改写跟随状态
            if (!container.clientHeight) return;
            setFollow(entry.isIntersecting);
        }, {
            root: container,
            rootMargin: '0px 0px 80px 0px',
            threshold: 0
        });
        followObserver.observe(endSentinel);
    }

    function notifyFollow() {
        if (typeof options.onFollowChange === 'function') options.onFollowChange(autoFollow);
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
    var lightboxHideTimer = null;

    function openLightbox(src, alt) {
        if (!lightboxEl || !lightboxImg || !src) return;
        if (lightboxHideTimer) { clearTimeout(lightboxHideTimer); lightboxHideTimer = null; }
        lightboxEl.classList.remove('is-closing');
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
        lightboxEl.classList.add('is-closing');
        lightboxImg.removeAttribute('src');
        if (lightboxHideTimer) { clearTimeout(lightboxHideTimer); lightboxHideTimer = null; }
        if (prefersReducedMotionNow()) {
            lightboxEl.hidden = true;
            lightboxEl.classList.remove('is-closing');
        } else {
            // 等 opacity 过渡完成后再 hidden，避免退出被瞬间裁切
            lightboxHideTimer = setTimeout(function () {
                lightboxHideTimer = null;
                lightboxEl.hidden = true;
                lightboxEl.classList.remove('is-closing');
            }, 180);
        }
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
        if (action === 'version-prev' || action === 'version-next') {
            var store = NC.store && NC.store.conversation;
            if (!store || typeof store.getVersions !== 'function') return;
            var versions = store.getVersions(id);
            if (!versions || !versions.ids || versions.ids.length < 2) return;
            var nextIndex = versions.index + (action === 'version-prev' ? -1 : 1);
            if (nextIndex < 0 || nextIndex >= versions.ids.length) return;
            store.selectVersion(versions.ids[nextIndex]);
            if (NC.chat && NC.chat.controller) {
                NC.chat.controller.renderConversation('');
            }
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
        '把这段会议纪要整理成待办',
        '检查这份接口文档有没有歧义',
        '为季度报告列一个提纲'
    ];

    function ensureEmptyEl() {
        if (emptyEl && emptyEl.parentNode) return emptyEl;
        emptyEl = util.e('div', { class: 'chat-welcome message', hidden: true });
        var inner = util.e('div', { class: 'chat-welcome__inner' });

        var head = util.e('div', { class: 'chat-welcome__head' });
        head.appendChild(util.e('span', { class: 'chat-welcome__mark', 'aria-hidden': 'true' }, [icons.el('sparkles', 15)]));
        head.appendChild(util.e('p', { class: 'chat-welcome__title' }));
        inner.appendChild(head);

        // Lead / Support 两拍：标题行先到，说明 + 建议列表 + 快捷键作为一组随后进入；
        // 容器本身不播第二次动画，避免“父容器 + 子项”双重入场。
        var body = util.e('div', { class: 'chat-welcome__body' });
        body.appendChild(util.e('p', {
            class: 'chat-welcome__hint',
            text: '对话与系统提示词按端点隔离，记录只保存在本机。'
        }));

        var suggestions = util.e('div', {
            class: 'chat-suggest',
            role: 'group',
            'aria-label': '建议问题'
        });
        WELCOME_SUGGESTIONS.forEach(function (prompt) {
            var item = util.e('button', {
                type: 'button',
                class: 'chat-suggest__item'
            }, [
                util.e('span', { class: 'chat-suggest__label', text: prompt }),
                util.e('span', { class: 'chat-suggest__arrow', 'aria-hidden': 'true' }, [icons.el('chevron-right', 14)])
            ]);
            item.addEventListener('click', function () {
                if (typeof options.onSuggestion === 'function') options.onSuggestion(prompt);
            });
            suggestions.appendChild(item);
        });
        body.appendChild(suggestions);

        var foot = util.e('div', { class: 'chat-welcome__foot' });
        foot.appendChild(util.e('kbd', { class: 'nc-kbd', text: 'Enter' }));
        foot.appendChild(util.e('span', { text: '发送' }));
        foot.appendChild(util.e('kbd', { class: 'nc-kbd', text: 'Shift + Enter' }));
        foot.appendChild(util.e('span', { text: '换行' }));
        body.appendChild(foot);
        inner.appendChild(body);

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
            if (message.reasoningStreaming === true) renderMarkdownStreaming(body, message.reasoning);
            else renderMarkdownInto(body, message.reasoning);
            var summary = details.querySelector('.chat-reasoning__summary');
            if (message.reasoningStreaming) {
                summary.textContent = '思考中…';
                details.open = true;
            } else {
                summary.textContent = reasoningLabel(message);
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
        article.classList.add('is-entering');
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
                    summary.textContent = '思考中…';
                    details.open = true;
                } else {
                    summary.textContent = reasoningLabel(message);
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
                setTimeout(finish, 150);
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
        /* 流式期间 DOM 每 60ms 重写一次，暂时关掉 select 增强观察器 */
        if (NC.ui && typeof NC.ui.pauseSelectObserver === 'function') {
            if (streaming) NC.ui.pauseSelectObserver();
            else NC.ui.resumeSelectObserver();
        }
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
        listEl = util.e('div', { class: 'chat-list' });
        container.appendChild(listEl);
        setupFollowWatcher();

        util.delegate(container, 'click', '.chat-msg__action', function (event, button) {
            var article = button.closest('.chat-msg');
            var id = article && article.getAttribute('data-id');
            var action = button.getAttribute('data-action');
            if (id && action) handleAction(action, id, button);
        });

        util.delegate(container, 'click', '.chat-versions__btn', function (event, button) {
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
        if (lightboxEl) {
            lightboxEl.classList.add('chat-lightbox');
            lightboxEl.hidden = true;
            lightboxEl.classList.remove('is-open');
            if (!lightboxEl.getAttribute('role')) lightboxEl.setAttribute('role', 'dialog');
            if (!lightboxEl.getAttribute('aria-label')) lightboxEl.setAttribute('aria-label', '图片预览');
            lightboxEl.addEventListener('click', function (event) {
                if (event.target === lightboxEl) closeLightbox();
            });
        }
        if (lightboxImg && !lightboxImg.getAttribute('alt')) lightboxImg.setAttribute('alt', '图片预览');
        var lightboxClose = document.getElementById('lightbox-close');
        if (lightboxClose) {
            lightboxClose.classList.add('chat-lightbox__close');
            lightboxClose.addEventListener('click', closeLightbox);
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
        renderInto: renderMarkdownInto,
        renderStreaming: renderMarkdownStreaming,
        openLightbox: openLightbox,
        closeLightbox: closeLightbox,
        getCopyText: getCopyText
    };
})(window);
