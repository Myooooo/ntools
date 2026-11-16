/**
 * tooltip.js — v5.2 统一工具提示（经典脚本，无依赖）
 * 挂载：NC.tooltip
 *
 * 为什么不用原生 title：
 *  - 原生提示延迟约 1s、样式不可控、在深色/浅色下与 Precision Workbench 不一致；
 *  - 侧边栏收起后导航只剩图标，提示是唯一的文字出口，必须可靠、及时。
 *
 * 行为（对齐 apple-design / emil-design-eng）：
 *  - 首次悬停 550ms 后出现；任一提示刚消失后的 900ms 内，后续提示立即出现
 *    （相邻工具栏/导航连续浏览不被重复延迟拖慢）；
 *  - 指针按下、滚动、Esc、失焦、窗口失焦立即收起；
 *  - 键盘 focus-visible 立即出现，不依赖鼠标；
 *  - 出现时临时移除 title，避免原生提示叠一层；指针按下/离开时原样恢复；
 *  - 只在精确指针（hover:hover + pointer:fine）下启用，触屏不绑定。
 *
 * 兼容：Chromium 102；只用 pointerover/out/focusin/out + getBoundingClientRect，
 *       不依赖 Popover API / :has / ResizeObserver。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    var TIP_ID = 'nc-tip';
    var SHOW_DELAY = 550;
    var WARM_WINDOW = 900;
    var VIEWPORT_MARGIN = 8;
    var GAP = 8;

    /* 接管范围：显式 data-tip；原生交互控件（button/a/select/input/[role=button]）
     * 的 title；以及少数状态/会话标题节点。纯文本节点只在确实被截断时提示，
     * 避免“看到什么还提示什么”。要关闭某元素的提示，写 data-tip="none"。 */
    var SELECTOR = [
        '[data-tip]',
        '[data-nc-tip-active]',
        'button[title]',
        'a[title]',
        'select[title]',
        'input[title]',
        '[role="button"][title]',
        '[role="option"][title]',
        '.chat-profile-dot[title]',
        '.chat-profile-meta[title]',
        '.chat-session-title[title]',
        '.chat-session-item[title]',
        '.chat-session-item__title[title]'
    ].join(',');

    var tipEl = null;
    var current = null;
    var savedTitle = null;
    var savedDescribedBy = null;
    var showTimer = null;
    var lastHiddenAt = 0;
    var initialized = false;
    var bound = false;

    function finePointer() {
        if (!global.matchMedia) return true;
        try {
            return global.matchMedia('(hover: hover) and (pointer: fine)').matches;
        } catch (err) {
            return true;
        }
    }

    function now() {
        return Date.now();
    }

    function textOf(node) {
        if (!node || !node.getAttribute) return '';
        var text = node.getAttribute('data-tip');
        if (text == null || !String(text).replace(/\s+/g, ' ').trim()) {
            text = node.getAttribute('title');
        }
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function isTruncated(node) {
        if (!node) return false;
        if (node.scrollWidth > node.clientWidth + 1) return true;
        if (node.scrollHeight > node.clientHeight + 1) return true;
        return false;
    }

    function maybeTruncated(node) {
        if (!node) return false;
        if (isTruncated(node)) return true;
        var inner = node.querySelector ? node.querySelector('.chat-session-item__title') : null;
        return !!inner && isTruncated(inner);
    }

    function eligible(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.disabled) return false;
        if (node.getAttribute('data-tip') === 'none') return false;
        var text = textOf(node);
        if (!text) return false;
        // 纯文本元素只在确实被截断时提示，避免“看到什么还提示什么”的噪音
        var tag = node.tagName;
        var interactive = tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' ||
            tag === 'INPUT' || node.getAttribute('role') === 'button' ||
            node.getAttribute('role') === 'option';
        if (interactive) {
            // 下拉选项是高频面：只有标签被省略号截断时才提示，避免遮挡相邻选项
            if (node.getAttribute('role') === 'option') {
                var optionLabel = node.querySelector ? node.querySelector('.nc-select-pop__label') : null;
                return !!optionLabel && isTruncated(optionLabel);
            }
            if (node.classList.contains('chat-session-item')) return maybeTruncated(node);
            return true;
        }
        if (node.classList.contains('chat-profile-meta') ||
            node.classList.contains('chat-profile-dot')) {
            return true;
        }
        return maybeTruncated(node);
    }

    function fromSelector(target) {
        if (!target || !target.closest) return null;
        return target.closest(SELECTOR);
    }

    function ensureTip() {
        if (tipEl && document.documentElement.contains(tipEl)) return tipEl;
        tipEl = document.createElement('div');
        tipEl.id = TIP_ID;
        tipEl.className = 'nc-tip';
        tipEl.setAttribute('role', 'tooltip');
        tipEl.setAttribute('aria-hidden', 'true');
        document.body.appendChild(tipEl);
        return tipEl;
    }

    function restoreAnchor() {
        if (!current) return;
        try {
            if (savedTitle != null && !current.hasAttribute('title')) {
                current.setAttribute('title', savedTitle);
            }
            if (savedDescribedBy != null) {
                if (savedDescribedBy) current.setAttribute('aria-describedby', savedDescribedBy);
                else current.removeAttribute('aria-describedby');
            }
            current.removeAttribute('data-nc-tip-active');
        } catch (err) { /* ignore detached nodes */ }
        savedTitle = null;
        savedDescribedBy = null;
        current = null;
    }

    function cancelTimer() {
        if (showTimer) {
            clearTimeout(showTimer);
            showTimer = null;
        }
    }

    function hide() {
        cancelTimer();
        var wasOpen = !!(current || (tipEl && tipEl.classList.contains('is-open')));
        if (!wasOpen) {
            restoreAnchor();
            return;
        }
        if (tipEl) {
            tipEl.classList.remove('is-open');
            tipEl.setAttribute('aria-hidden', 'true');
        }
        lastHiddenAt = now();
        restoreAnchor();
    }

    function position(anchor) {
        var rect = anchor.getBoundingClientRect();
        var tipRect = tipEl.getBoundingClientRect();
        var width = tipRect.width;
        var height = tipRect.height;
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var inRail = !!(anchor.closest && anchor.closest('.tools-rail'));
        var placement = inRail ? 'right' : 'top';
        var left;
        var top;
        var origin;

        if (placement === 'right') {
            left = rect.right + 10;
            top = rect.top + rect.height / 2 - height / 2;
            if (left + width > vw - VIEWPORT_MARGIN) placement = 'top';
        }

        if (placement === 'right') {
            left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));
            top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - height - VIEWPORT_MARGIN));
            origin = '0 50%';
        } else {
            left = rect.left + rect.width / 2 - width / 2;
            top = rect.top - height - GAP;
            if (top < VIEWPORT_MARGIN) {
                placement = 'bottom';
                top = rect.bottom + GAP;
                origin = '50% 0';
            } else {
                origin = '50% 100%';
            }
            left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));
            top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - height - VIEWPORT_MARGIN));
        }

        tipEl.style.left = Math.round(left) + 'px';
        tipEl.style.top = Math.round(top) + 'px';
        tipEl.style.setProperty('--nc-tip-origin', origin);
        tipEl.setAttribute('data-placement', placement);
    }

    function show(anchor, viaPointer) {
        if (!anchor || !document.documentElement.contains(anchor)) return;
        var text = textOf(anchor);
        if (!text) return;
        // 已经在该锚点上（例如连续 focus 或程序化重复调用）：只重新定位，
        // 不重复记录 aria-describedby，避免恢复时把 nc-tip 残留在属性里。
        if (current === anchor) {
            position(anchor);
            return;
        }

        cancelTimer();
        ensureTip();
        if (current) hide();

        current = anchor;
        savedTitle = null;
        savedDescribedBy = anchor.getAttribute('aria-describedby');

        tipEl.textContent = text;
        tipEl.classList.remove('is-open');
        tipEl.setAttribute('aria-hidden', 'false');
        // visibility:hidden 仍可测量尺寸，先定位再触发过渡
        position(anchor);

        if (viaPointer) {
            // 出现后才移除 title：快速点击（<550ms）不会改动 DOM，
            // 原生提示也因为已经移除而不会叠在自定义提示上。
            var title = anchor.getAttribute('title');
            if (title != null) {
                savedTitle = title;
                anchor.removeAttribute('title');
            }
        }

        var describedBy = savedDescribedBy ? savedDescribedBy + ' ' + TIP_ID : TIP_ID;
        // 提示文本与可见文本/aria-label 完全相同时，不再重复挂 describedby，
        // 否则读屏会听到“复制，复制”。视觉提示仍然保留。
        var visibleText = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        var redundant = text === (anchor.getAttribute('aria-label') || '') || text === visibleText;
        if (!redundant) {
            anchor.setAttribute('aria-describedby', describedBy);
        }
        anchor.setAttribute('data-nc-tip-active', '');

        // 强制一次样式计算，让 opacity/transform 从关闭态开始（Lite 下无过渡）
        void tipEl.offsetWidth;
        tipEl.classList.add('is-open');
    }

    function schedule(anchor, viaPointer) {
        cancelTimer();
        if (current === anchor) return;
        var warm = (now() - lastHiddenAt) < WARM_WINDOW;
        var delay = warm ? 0 : SHOW_DELAY;
        showTimer = setTimeout(function () {
            showTimer = null;
            show(anchor, viaPointer);
        }, delay);
    }

    function onPointerOver(event) {
        var anchor = fromSelector(event.target);
        if (!anchor || !eligible(anchor)) return;
        if (event.relatedTarget && anchor.contains(event.relatedTarget)) return;
        if (current === anchor) return;
        schedule(anchor, true);
    }

    function onPointerOut(event) {
        var anchor = fromSelector(event.target);
        if (!anchor) return;
        if (event.relatedTarget && anchor.contains(event.relatedTarget)) return;
        if (current === anchor) hide();
        else cancelTimer();
    }

    function onPointerDown() {
        // 点击说明用户已经知道这是什么：立即收起并恢复 title
        hide();
    }

    function onFocusIn(event) {
        var anchor = fromSelector(event.target);
        if (!anchor || !eligible(anchor)) return;
        if (current === anchor) return;
        var keyboardFocus = false;
        try {
            keyboardFocus = !!(anchor.matches && anchor.matches(':focus-visible'));
        } catch (err) {
            keyboardFocus = true;
        }
        if (!keyboardFocus) return;
        cancelTimer();
        show(anchor, false);
    }

    function onFocusOut(event) {
        if (!current) return;
        if (event.relatedTarget && current.contains(event.relatedTarget)) return;
        hide();
    }

    function onKeyDown(event) {
        if (event.key === 'Escape' && current) hide();
    }

    function onScroll() {
        if (current) hide();
    }

    function onResize() {
        if (current) hide();
    }

    function onBlur() {
        if (current) hide();
    }

    function bind() {
        if (bound) return;
        bound = true;
        // capture：内部滚动容器也会触发，提示跟随指针位置失效时立即收起
        document.addEventListener('pointerover', onPointerOver, true);
        document.addEventListener('pointerout', onPointerOut, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('focusin', onFocusIn, true);
        document.addEventListener('focusout', onFocusOut, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('scroll', onScroll, true);
        global.addEventListener('resize', onResize);
        global.addEventListener('blur', onBlur);
    }

    function init() {
        if (initialized) return true;
        if (!document.body) return false;
        if (!finePointer()) {
            initialized = true;
            return false;
        }
        ensureTip();
        bind();
        initialized = true;
        return true;
    }

    NC.tooltip = {
        init: init,
        show: function (target) {
            if (target) show(target, false);
        },
        hide: hide,
        isOpen: function () {
            return !!(tipEl && tipEl.classList.contains('is-open'));
        },
        text: function () {
            return tipEl ? tipEl.textContent : '';
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);
