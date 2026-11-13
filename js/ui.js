/**
 * ui.js — 统一 UI 原语：模态框 / 确认 / 提示 / Toast / 菜单 / 全局错误
 * 经典脚本，依赖 core.js、icons.js。样式见 css/components.css（nc- 前缀）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var icons = NC.icons;
    var events = NC.events;

    var FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function getFocusable(container) {
        return Array.prototype.filter.call(container.querySelectorAll(FOCUSABLE), function (node) {
            return node.offsetParent !== null || node === document.activeElement;
        });
    }

    function trapFocus(container) {
        function onKeydown(event) {
            if (event.key !== 'Tab') return;
            var nodes = getFocusable(container);
            if (!nodes.length) { event.preventDefault(); return; }
            var first = nodes[0];
            var last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
        container.addEventListener('keydown', onKeydown);
        return function () { container.removeEventListener('keydown', onKeydown); };
    }

    /* ------------------------------------------------------------------ *
     * 模态框
     * ------------------------------------------------------------------ */
    var openStack = [];

    function normalizeAction(action) {
        if (typeof action === 'string') return { label: action };
        return action || {};
    }

    /**
     * openModal({ title, message, content, actions, dismissible, size, onClose })
     * 返回 { el, close }
     */
    function openModal(options) {
        var opts = options || {};
        closeActiveSelect(false);
        var previousFocus = document.activeElement;
        var overlay = document.createElement('div');
        overlay.className = 'nc-modal-overlay';
        overlay.setAttribute('role', 'presentation');

        var card = document.createElement('div');
        card.className = 'nc-modal' + (opts.size ? ' nc-modal--' + opts.size : '');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');

        var titleId = util.uid('nc-modal-title');
        var bodyId = util.uid('nc-modal-body');

        if (opts.title) {
            var head = document.createElement('div');
            head.className = 'nc-modal__head';
            var title = document.createElement('h2');
            title.className = 'nc-modal__title';
            title.id = titleId;
            title.textContent = String(opts.title);
            head.appendChild(title);
            card.appendChild(head);
            card.setAttribute('aria-labelledby', titleId);
        }

        var body = document.createElement('div');
        body.className = 'nc-modal__body';
        body.id = bodyId;
        if (opts.message) {
            var message = document.createElement('p');
            message.className = 'nc-modal__message';
            message.textContent = String(opts.message);
            body.appendChild(message);
        }
        if (opts.content && opts.content.nodeType) body.appendChild(opts.content);
        if (opts.content && typeof opts.content === 'string') {
            var contentWrap = document.createElement('div');
            contentWrap.className = 'nc-modal__content';
            contentWrap.innerHTML = opts.content; // 仅允许调用方传入可信静态模板
            body.appendChild(contentWrap);
        }
        card.setAttribute('aria-describedby', bodyId);
        card.appendChild(body);

        var actions = (opts.actions || []).map(normalizeAction);
        if (!actions.length) actions = [{ label: '好的', kind: 'primary' }];
        var foot = document.createElement('div');
        foot.className = 'nc-modal__foot';

        function close(result) {
            if (!overlay.parentNode) return;
            overlay.classList.remove('show');
            var releaseTrap = overlay.__releaseTrap;
            if (releaseTrap) releaseTrap();
            setTimeout(function () {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 240);
            var index = openStack.indexOf(instance);
            if (index > -1) openStack.splice(index, 1);
            if (previousFocus && previousFocus.focus) {
                try { previousFocus.focus(); } catch (err) { /* ignore */ }
            }
            if (opts.onClose) opts.onClose(result);
        }

        var instance = { el: overlay, close: close };

        actions.forEach(function (action, index) {
            var button = document.createElement('button');
            button.type = 'button';
            var kind = action.kind || (index === actions.length - 1 ? 'primary' : 'ghost');
            button.className = 'nc-btn nc-btn--' + kind;
            button.textContent = String(action.label || '确定');
            button.addEventListener('click', function () {
                var shouldClose = action.close !== false;
                var result = action.onClick ? action.onClick(instance) : undefined;
                if (result && typeof result.then === 'function') {
                    button.disabled = true;
                    button.classList.add('is-loading');
                    result.then(function () {
                        button.disabled = false;
                        button.classList.remove('is-loading');
                        if (shouldClose) close();
                    }, function () {
                        button.disabled = false;
                        button.classList.remove('is-loading');
                    });
                } else if (shouldClose) {
                    close();
                }
            });
            foot.appendChild(button);
        });
        card.appendChild(foot);

        overlay.appendChild(card);
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay && opts.dismissible !== false) close(false);
        });
        overlay.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && opts.dismissible !== false) {
                event.stopPropagation();
                close(false);
            }
        });

        document.body.appendChild(overlay);
        overlay.__releaseTrap = trapFocus(card);
        openStack.push(instance);
        requestAnimationFrame(function () { overlay.classList.add('show'); });

        var focusTarget = opts.initialFocus && opts.initialFocus.nodeType
            ? opts.initialFocus
            : getFocusable(card).filter(function (node) { return node.classList.contains('nc-btn--primary'); })[0];
        (focusTarget || getFocusable(card)[0] || card).focus();

        return instance;
    }

    function confirm(message, options) {
        var opts = options || {};
        return new Promise(function (resolve) {
            var settled = false;
            openModal({
                title: opts.title || '请确认',
                message: message,
                size: opts.size,
                dismissible: opts.dismissible !== false,
                actions: [
                    { label: opts.cancelText || '取消', kind: 'ghost', onClick: function () { settled = true; resolve(false); } },
                    {
                        label: opts.confirmText || '确定',
                        kind: opts.danger ? 'danger' : 'primary',
                        onClick: function (instance) {
                            if (opts.onConfirm) {
                                var result = opts.onConfirm(instance);
                                settled = true;
                                resolve(result === undefined ? true : result);
                                return result;
                            }
                            settled = true;
                            resolve(true);
                        }
                    }
                ],
                onClose: function () {
                    if (!settled) resolve(false);
                }
            });
        });
    }

    function alert(title, message) {
        return new Promise(function (resolve) {
            openModal({
                title: title || '提示',
                message: message,
                actions: [{ label: '好的', kind: 'primary', onClick: function () { resolve(); } }],
                onClose: function () { resolve(); }
            });
        });
    }

    function prompt(options) {
        var opts = typeof options === 'string' ? { title: options } : (options || {});
        return new Promise(function (resolve) {
            var wrap = document.createElement('div');
            var field = document.createElement(opts.multiline ? 'textarea' : 'input');
            field.className = 'nc-input nc-input--block';
            if (opts.multiline) field.rows = opts.rows || 4;
            else field.type = 'text';
            field.value = opts.value || '';
            if (opts.placeholder) field.placeholder = opts.placeholder;
            if (opts.maxLength) field.maxLength = opts.maxLength;
            wrap.appendChild(field);
            if (opts.hint) {
                var hint = document.createElement('div');
                hint.className = 'nc-field-hint';
                hint.textContent = opts.hint;
                wrap.appendChild(hint);
            }
            var settled = false;
            var modal = openModal({
                title: opts.title || '输入',
                content: wrap,
                initialFocus: field,
                actions: [
                    { label: opts.cancelText || '取消', kind: 'ghost', onClick: function () { settled = true; resolve(null); } },
                    {
                        label: opts.confirmText || '确定',
                        kind: 'primary',
                        onClick: function () {
                            var value = field.value.trim();
                            if (opts.required && !value) {
                                field.classList.add('has-error');
                                field.focus();
                                return Promise.reject(new Error('required'));
                            }
                            settled = true;
                            resolve(value);
                        }
                    }
                ],
                onClose: function () { if (!settled) resolve(null); }
            });
            field.addEventListener('input', function () { field.classList.remove('has-error'); });
            if (!opts.multiline) {
                field.addEventListener('keydown', function (event) {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        var buttons = modal.el.querySelectorAll('.nc-modal__foot .nc-btn');
                        if (buttons.length) buttons[buttons.length - 1].click();
                    }
                });
            }
        });
    }

    /* ------------------------------------------------------------------ *
     * Toast（含撤销操作）
     * ------------------------------------------------------------------ */
    var toastContainer = null;

    function ensureToastContainer() {
        if (toastContainer && toastContainer.parentNode) return toastContainer;
        toastContainer = document.createElement('div');
        toastContainer.className = 'nc-toasts';
        toastContainer.setAttribute('aria-live', 'polite');
        toastContainer.setAttribute('aria-atomic', 'false');
        document.body.appendChild(toastContainer);
        return toastContainer;
    }

    function toast(message, options) {
        var opts = options || {};
        var type = opts.type || 'info';
        var duration = opts.duration == null ? 3200 : opts.duration;
        var container = ensureToastContainer();
        var item = document.createElement('div');
        item.className = 'nc-toast nc-toast--' + type;
        item.setAttribute('role', type === 'error' ? 'alert' : 'status');

        var iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'alert' : type === 'warn' ? 'alert' : 'info';
        if (icons) {
            var iconEl = icons.el(iconName, 16);
            iconEl.classList.add('nc-toast__icon');
            item.appendChild(iconEl);
        }

        var text = document.createElement('div');
        text.className = 'nc-toast__text';
        text.textContent = String(message == null ? '' : message);
        item.appendChild(text);

        var timer = null;
        function dismiss() {
            if (!item.parentNode) return;
            clearTimeout(timer);
            item.classList.add('is-leaving');
            setTimeout(function () {
                if (item.parentNode) item.parentNode.removeChild(item);
            }, 180);
        }
        function startTimer() {
            if (duration > 0) timer = setTimeout(dismiss, duration);
        }

        if (opts.action && typeof opts.action.onClick === 'function') {
            var actionBtn = document.createElement('button');
            actionBtn.type = 'button';
            actionBtn.className = 'nc-toast__action';
            actionBtn.textContent = opts.action.label || '撤销';
            actionBtn.addEventListener('click', function () {
                dismiss();
                opts.action.onClick();
            });
            item.appendChild(actionBtn);
        }

        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'nc-toast__close';
        closeBtn.setAttribute('aria-label', '关闭提示');
        closeBtn.innerHTML = icons ? icons.svg('x', 14) : '×';
        closeBtn.addEventListener('click', dismiss);
        item.appendChild(closeBtn);

        item.addEventListener('mouseenter', function () { clearTimeout(timer); });
        item.addEventListener('mouseleave', startTimer);

        container.appendChild(item);
        requestAnimationFrame(function () { item.classList.add('show'); });
        startTimer();
        return dismiss;
    }

    /* ------------------------------------------------------------------ *
     * 轻量弹出菜单
     * 约束：同一时刻只允许一个菜单；重复点击同一触发按钮为开/关；关闭有退出动画。
     * ------------------------------------------------------------------ */
    var activeMenu = null;
    var MENU_EXIT_MS = 140;

    function removeClosingMenus() {
        var nodes = document.querySelectorAll('.nc-menu.is-closing');
        Array.prototype.forEach.call(nodes, function (node) {
            if (node.parentNode) node.parentNode.removeChild(node);
        });
    }

    function closeActiveMenu() {
        if (activeMenu) {
            var instance = activeMenu;
            activeMenu = null;
            instance.close();
        }
    }

    function openMenu(anchor, items, options) {
        if (!anchor) return { el: null, close: function () {} };
        var opts = options || {};
        closeActiveSelect(false);

        // 重复点击同一个触发按钮：关闭，不再叠一层菜单
        var sameTrigger = activeMenu && activeMenu.anchor === anchor;
        closeActiveMenu();
        if (sameTrigger && opts.toggle !== false) {
            return { el: null, close: function () {} };
        }
        removeClosingMenus();

        var previousFocus = document.activeElement;
        var menu = document.createElement('div');
        menu.className = 'nc-menu';
        menu.setAttribute('role', 'menu');
        var buttons = [];
        var activeIndex = -1;
        var closed = false;

        (items || []).forEach(function (item) {
            if (item.type === 'divider') {
                var divider = document.createElement('div');
                divider.className = 'nc-menu__divider';
                menu.appendChild(divider);
                return;
            }
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'nc-menu__item' + (item.danger ? ' is-danger' : '');
            button.setAttribute('role', 'menuitem');
            if (item.disabled) button.disabled = true;
            if (item.icon && icons) {
                var iconEl = icons.el(item.icon, 16);
                iconEl.classList.add('nc-menu__icon');
                button.appendChild(iconEl);
            }
            var label = document.createElement('span');
            label.className = 'nc-menu__label';
            label.textContent = String(item.label);
            button.appendChild(label);
            if (item.hint) {
                var hint = document.createElement('span');
                hint.className = 'nc-menu__hint';
                hint.textContent = String(item.hint);
                button.appendChild(hint);
            }
            button.addEventListener('click', function () {
                close();
                if (item.onSelect) item.onSelect();
            });
            menu.appendChild(button);
            buttons.push(button);
        });

        function setActive(index) {
            if (!buttons.length) return;
            activeIndex = (index + buttons.length) % buttons.length;
            buttons.forEach(function (button, i) {
                button.classList.toggle('is-active', i === activeIndex);
            });
            buttons[activeIndex].focus();
        }

        function detachListeners() {
            document.removeEventListener('mousedown', onOutside, true);
            document.removeEventListener('keydown', onKeydown, true);
            global.removeEventListener('resize', onViewportChange);
            global.removeEventListener('scroll', onViewportChange, true);
        }

        function close() {
            if (closed) return;
            closed = true;
            detachListeners();
            if (activeMenu === instance) activeMenu = null;
            menu.classList.remove('is-open');
            menu.classList.add('is-closing');
            setTimeout(function () {
                if (menu.parentNode) menu.parentNode.removeChild(menu);
            }, MENU_EXIT_MS);
            if (previousFocus && previousFocus.focus) {
                try { previousFocus.focus(); } catch (err) { /* ignore */ }
            }
            if (opts.onClose) opts.onClose();
        }

        function onOutside(event) {
            if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
        }

        function onKeydown(event) {
            if (event.key === 'Escape') { event.preventDefault(); close(); }
            else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(activeIndex + 1); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex - 1); }
        }

        function onViewportChange(event) {
            // 输入框/页面滚轮造成的滚动不关闭；只处理窗口尺寸变化与滚动容器变化
            if (event && event.type === 'scroll') {
                if (menu.contains(event.target)) return;
            }
            close();
        }

        var instance;
        document.body.appendChild(menu);
        var rect = anchor.getBoundingClientRect();
        var menuRect = menu.getBoundingClientRect();
        var left = Math.min(Math.max(8, rect.right - menuRect.width), global.innerWidth - menuRect.width - 8);
        var top = rect.bottom + 6;
        var flipped = false;
        if (top + menuRect.height > global.innerHeight - 8) {
            top = Math.max(8, rect.top - menuRect.height - 6);
            flipped = true;
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';

        // 来源明确的缩放起点：菜单从触发按钮的方向展开，而不是从中心
        var originX = (left + menuRect.width / 2) < (rect.left + rect.width / 2) ? 'left' : 'right';
        menu.style.setProperty('--nc-menu-origin', originX + ' ' + (flipped ? 'bottom' : 'top'));

        instance = { el: menu, close: close, anchor: anchor };
        activeMenu = instance;

        setTimeout(function () {
            if (closed) return;
            document.addEventListener('mousedown', onOutside, true);
            document.addEventListener('keydown', onKeydown, true);
            global.addEventListener('resize', onViewportChange);
            global.addEventListener('scroll', onViewportChange, true);
        }, 0);
        var firstItem = menu.querySelector('.nc-menu__item:not(:disabled)');
        if (firstItem) firstItem.focus();
        return instance;
    }

    /* ------------------------------------------------------------------ *
     * 自定义下拉框
     * 原生 <select> 保留在 DOM（id/class/aria/事件与 options/value 不变），
     * 视觉触发层覆盖在原生 select 之上；浮层 append body + fixed，避免
     * overflow:hidden 容器裁剪。所有状态用 class transition 驱动，不用
     * keyframes，也不使用 transition:all。
     * ------------------------------------------------------------------ */
    var SELECT_EXIT_MS = 130;
    var activeSelect = null;
    var selectSeq = 0;
    var selectObserver = null;
    var selectInitialized = false;

    function selectMotionReduced() {
        try {
            if (document.documentElement.getAttribute('data-lite') === 'true') return true;
            return !!(util && util.prefersReducedMotion && util.prefersReducedMotion());
        } catch (err) {
            return false;
        }
    }

    function closestEl(node, selector) {
        if (!node) return null;
        if (node.closest) return node.closest(selector);
        var current = node;
        while (current && current.nodeType === 1) {
            if (current.matches && current.matches(selector)) return current;
            current = current.parentNode;
        }
        return null;
    }

    function optionText(option) {
        if (!option) return '';
        var text = option.textContent;
        if (text == null || !String(text).replace(/\s+/g, ' ').trim()) {
            text = option.label || option.value || '';
        }
        return String(text).replace(/\s+/g, ' ').trim();
    }

    function optionDisabled(option) {
        if (!option) return true;
        if (option.disabled) return true;
        var parent = option.parentNode;
        return !!(parent && parent.tagName === 'OPTGROUP' && parent.disabled);
    }

    function selectLabel(select) {
        var aria = select.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();
        var labelledby = select.getAttribute('aria-labelledby');
        if (labelledby) {
            var parts = labelledby.split(/\s+/).map(function (id) {
                var node = document.getElementById(id);
                return node ? (node.textContent || '').trim() : '';
            }).filter(Boolean);
            if (parts.length) return parts.join(' ');
        }
        var id = select.id;
        if (id) {
            var nodes = document.querySelectorAll('label[for]');
            for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].getAttribute('for') === id) return (nodes[i].textContent || '').trim();
            }
        }
        var parentLabel = closestEl(select, 'label');
        if (parentLabel) {
            var named = parentLabel.querySelector('.todo-composer__fieldlabel, .sp-label, .nc-label');
            if (named) return (named.textContent || '').trim();
            return (parentLabel.textContent || '').trim();
        }
        var fieldWrap = closestEl(select, '.detail-field, .nc-field');
        if (fieldWrap) {
            var fieldLabel = fieldWrap.querySelector('.nc-label, .sp-label, label');
            if (fieldLabel) return (fieldLabel.textContent || '').trim();
        }
        return '选项';
    }

    function syncSelect(state) {
        if (!state || !state.select) return;
        var select = state.select;
        var option = select.options.length ? select.options[select.selectedIndex] : null;
        var label = option ? optionText(option) : (select.getAttribute('data-placeholder') || '');
        state.text.textContent = label;
        state.trigger.setAttribute('data-value', select.value == null ? '' : String(select.value));
        state.trigger.classList.toggle('is-placeholder', !option && !!label);
        var title = select.getAttribute('title') || (option && option.getAttribute('title')) || '';
        if (title) state.trigger.setAttribute('title', title);
        else state.trigger.removeAttribute('title');
        state.wrap.classList.toggle('is-disabled', !!select.disabled);
        if (select.disabled && state.list) closeSelect(state, false);
        if (state.list) renderSelectOptions(state);
    }

    function emitSelectEvents(select) {
        var types = ['input', 'change'];
        types.forEach(function (type) {
            var event;
            try {
                event = new global.Event(type, { bubbles: true });
            } catch (err) {
                event = document.createEvent('HTMLEvents');
                event.initEvent(type, true, false);
            }
            select.dispatchEvent(event);
        });
    }

    function removeClosingSelects() {
        Array.prototype.forEach.call(document.querySelectorAll('.nc-select-pop.is-closing'), function (node) {
            if (node.parentNode) node.parentNode.removeChild(node);
        });
    }

    function closeActiveSelect(focusBack) {
        if (activeSelect) closeSelect(activeSelect, !!focusBack);
    }

    function closeSelect(state, focusBack) {
        if (!state || !state.list) return;
        var select = state.select;
        var pop = state.list;
        state.list = null;
        state.optionEls = [];
        state.activeIndex = -1;
        state.wrap.classList.remove('is-open');
        if (activeSelect === state) {
            activeSelect = null;
            document.removeEventListener('mousedown', onSelectOutside, true);
            document.removeEventListener('keydown', onSelectKeydown, true);
            global.removeEventListener('resize', onSelectViewportChange);
            document.removeEventListener('scroll', onSelectViewportChange, true);
        }
        pop.classList.remove('is-open');
        pop.classList.add('is-closing');
        var wait = selectMotionReduced() ? 0 : SELECT_EXIT_MS;
        setTimeout(function () {
            if (pop.parentNode) pop.parentNode.removeChild(pop);
        }, wait);
        if (focusBack && select && !select.disabled) focusElement(select, true);
    }

    function findInitialIndex(state, mode) {
        var options = state.select.options;
        var i;
        if (!options.length) return -1;
        if (mode === 'first') {
            for (i = 0; i < options.length; i++) {
                if (!optionDisabled(options[i])) return i;
            }
            return -1;
        }
        if (mode === 'last') {
            for (i = options.length - 1; i >= 0; i--) {
                if (!optionDisabled(options[i])) return i;
            }
            return -1;
        }
        var selected = state.select.selectedIndex;
        if (selected >= 0 && selected < options.length && !optionDisabled(options[selected])) return selected;
        for (i = 0; i < options.length; i++) {
            if (!optionDisabled(options[i])) return i;
        }
        return -1;
    }

    function focusElement(node, preventScroll) {
        if (!node || typeof node.focus !== 'function') return;
        try {
            node.focus({ preventScroll: !!preventScroll });
        } catch (err) {
            try { node.focus(); } catch (ignore) { /* ignore */ }
        }
    }

    function scrollRowIntoView(state, row) {
        if (!state.list || !row) return;
        var list = state.list;
        var top = row.offsetTop;
        var bottom = top + row.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) {
            list.scrollTop = bottom - list.clientHeight;
        }
    }

    function setActiveOption(state, index, focus) {
        if (!state || !state.list) return false;
        var option = state.select.options[index];
        if (!option || optionDisabled(option)) return false;
        state.activeIndex = index;
        Array.prototype.forEach.call(state.optionEls, function (row) {
            if (row) row.classList.remove('is-active');
        });
        var row = state.optionEls[index];
        if (!row) return false;
        row.classList.add('is-active');
        if (focus) {
            focusElement(row, true);
            scrollRowIntoView(state, row);
        }
        return true;
    }

    function moveSelectActive(state, delta) {
        var options = state.select.options;
        var count = options.length;
        if (!count) return;
        var index = state.activeIndex;
        if (index < 0 || index >= count) index = delta > 0 ? -1 : 0;
        for (var step = 0; step < count; step++) {
            index = (index + delta + count) % count;
            if (!optionDisabled(options[index])) {
                setActiveOption(state, index, true);
                return;
            }
        }
    }

    function chooseSelectOption(state, index) {
        if (!state || !state.select) return;
        var select = state.select;
        var option = select.options[index];
        if (!option || optionDisabled(option)) return;
        state.activeIndex = index;
        if (select.selectedIndex !== index) {
            select.selectedIndex = index;
            emitSelectEvents(select);
        }
        syncSelect(state);
        closeSelect(state, true);
    }

    function renderSelectOptions(state) {
        var list = state.list;
        if (!list) return;
        var hadFocus = list.contains(document.activeElement);
        var optionEls = [];
        list.textContent = '';

        function addOption(option) {
            var index = option.index;
            var row = document.createElement('div');
            row.className = 'nc-select-pop__option';
            row.id = list.id + '-option-' + index;
            row.setAttribute('role', 'option');
            row.setAttribute('tabindex', '-1');
            row.setAttribute('data-index', String(index));
            row.setAttribute('aria-selected', option.selected ? 'true' : 'false');
            if (option.selected) row.classList.add('is-selected');
            if (optionDisabled(option)) {
                row.classList.add('is-disabled');
                row.setAttribute('aria-disabled', 'true');
            }
            var check = document.createElement('span');
            check.className = 'nc-select-pop__check';
            check.setAttribute('aria-hidden', 'true');
            if (option.selected && icons) check.appendChild(icons.el('check', 14));
            row.appendChild(check);
            var label = document.createElement('span');
            label.className = 'nc-select-pop__label';
            label.textContent = optionText(option);
            row.title = label.textContent;
            row.appendChild(label);
            row.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                chooseSelectOption(state, index);
            });
            list.appendChild(row);
            optionEls[index] = row;
        }

        Array.prototype.forEach.call(state.select.children, function (child) {
            if (!child || child.nodeType !== 1) return;
            if (child.tagName === 'OPTGROUP') {
                var groupLabel = child.getAttribute('label') || child.label || '';
                if (groupLabel) {
                    var group = document.createElement('div');
                    group.className = 'nc-select-pop__group';
                    group.textContent = groupLabel;
                    list.appendChild(group);
                }
                Array.prototype.forEach.call(child.children, function (option) {
                    if (option.tagName === 'OPTION') addOption(option);
                });
            } else if (child.tagName === 'OPTION') {
                addOption(child);
            }
        });

        if (!optionEls.length) {
            var empty = document.createElement('div');
            empty.className = 'nc-select-pop__empty';
            empty.textContent = '暂无选项';
            list.appendChild(empty);
        }

        state.optionEls = optionEls;
        if (state.activeIndex >= 0 && state.optionEls[state.activeIndex]) {
            state.optionEls[state.activeIndex].classList.add('is-active');
            if (hadFocus) {
                focusElement(state.optionEls[state.activeIndex], true);
                scrollRowIntoView(state, state.optionEls[state.activeIndex]);
            }
        }
    }

    function positionSelectList(state) {
        if (!state || !state.list) return;
        var list = state.list;
        var rect = state.wrap.getBoundingClientRect();
        var vw = global.innerWidth || document.documentElement.clientWidth || 0;
        var vh = global.innerHeight || document.documentElement.clientHeight || 0;
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
            closeSelect(state, false);
            return;
        }
        var width = Math.max(140, Math.min(rect.width, vw - 16));
        list.style.width = width + 'px';
        list.style.maxHeight = Math.min(320, vh - 16) + 'px';
        var listHeight = list.offsetHeight;
        var spaceBelow = vh - rect.bottom - 8;
        var spaceAbove = rect.top - 8;
        var openAbove = listHeight > spaceBelow && spaceAbove > spaceBelow;
        var available = Math.max(80, openAbove ? spaceAbove : spaceBelow);
        if (listHeight > available) {
            list.style.maxHeight = available + 'px';
            listHeight = list.offsetHeight;
        }
        var top = openAbove ? rect.top - listHeight - 4 : rect.bottom + 4;
        top = Math.max(8, Math.min(top, vh - listHeight - 8));
        var left = Math.min(Math.max(8, rect.left), Math.max(8, vw - width - 8));
        list.style.left = left + 'px';
        list.style.top = top + 'px';
        list.classList.toggle('is-above', openAbove);
        var anchorCenter = rect.left + rect.width / 2;
        var listCenter = left + width / 2;
        list.style.transformOrigin = (listCenter < anchorCenter ? 'right' : 'left') + ' ' + (openAbove ? 'bottom' : 'top');
    }

    function onSelectOutside(event) {
        var state = activeSelect;
        if (!state || !state.list) return;
        var target = event.target;
        if (!target) return;
        if (state.list.contains(target) || state.wrap.contains(target)) return;
        // 关联 <label>（for= 或包裹 select）视为控件本身：
        // 让随后的 label 激活只触发一次 toggle，而不是「关掉再打开」。
        var label = closestEl(target, 'label');
        if (label && (label.control === state.select ||
            (state.select.id && label.getAttribute('for') === state.select.id) ||
            label.contains(state.select))) {
            return;
        }
        closeSelect(state, false);
    }

    function onSelectKeydown(event) {
        var state = activeSelect;
        if (!state || !state.list) return;
        var key = event.key;
        if (key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeSelect(state, true);
            return;
        }
        if (key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            closeSelect(state, true);
            return;
        }
        if (key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            moveSelectActive(state, 1);
            return;
        }
        if (key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            moveSelectActive(state, -1);
            return;
        }
        if (key === 'Home') {
            event.preventDefault();
            event.stopPropagation();
            var first = findInitialIndex(state, 'first');
            if (first >= 0) setActiveOption(state, first, true);
            return;
        }
        if (key === 'End') {
            event.preventDefault();
            event.stopPropagation();
            var last = findInitialIndex(state, 'last');
            if (last >= 0) setActiveOption(state, last, true);
            return;
        }
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            event.preventDefault();
            event.stopPropagation();
            chooseSelectOption(state, state.activeIndex);
            return;
        }
        // 列表打开期间不把方向键/字母键泄漏给页面快捷键
        event.stopPropagation();
    }

    function onSelectViewportChange(event) {
        var state = activeSelect;
        if (!state || !state.list) return;
        if (event && event.type === 'scroll' && event.target && state.list.contains(event.target)) return;
        positionSelectList(state);
    }

    function openSelect(state, mode) {
        var select = state.select;
        if (!select || select.disabled) return;
        if (!select.isConnected && !document.documentElement.contains(select)) return;
        if (activeSelect === state && state.list) return;
        // 程序化 value 变化不一定有 change 事件：打开前再对齐一次视觉文案
        syncSelect(state);
        if (activeSelect) closeSelect(activeSelect, false);
        removeClosingSelects();
        if (activeMenu) closeActiveMenu();

        var pop = document.createElement('div');
        pop.className = 'nc-select-pop';
        pop.id = 'nc-select-pop-' + (++selectSeq);
        pop.setAttribute('role', 'listbox');
        pop.setAttribute('aria-label', selectLabel(select));
        pop.setAttribute('tabindex', '-1');
        try {
            // 浮层在 body 下，不继承控件字号；跟随触发层，避免小控件配大字菜单
            pop.style.fontSize = getComputedStyle(state.trigger).fontSize;
        } catch (err) { /* ignore */ }
        state.list = pop;
        state.optionEls = [];
        state.activeIndex = -1;
        document.body.appendChild(pop);
        renderSelectOptions(state);
        positionSelectList(state);
        void pop.offsetWidth;
        pop.classList.add('is-open');
        state.wrap.classList.add('is-open');
        activeSelect = state;

        document.addEventListener('mousedown', onSelectOutside, true);
        document.addEventListener('keydown', onSelectKeydown, true);
        global.addEventListener('resize', onSelectViewportChange);
        document.addEventListener('scroll', onSelectViewportChange, true);

        var initial = findInitialIndex(state, mode === 'last' ? 'last' : 'selected');
        if (initial >= 0) {
            setActiveOption(state, initial, true);
        } else {
            focusElement(pop, true);
        }
    }

    function toggleSelect(state) {
        if (!state) return;
        if (activeSelect === state && state.list) {
            closeSelect(state, true);
            return;
        }
        openSelect(state);
    }

    function enhanceSelect(select) {
        if (!select || select.tagName !== 'SELECT') return null;
        if (select.__ncSelect) return select.__ncSelect;
        if (select.getAttribute('data-nc-select-enhanced') === '1') return select.__ncSelect || null;
        if (select.getAttribute('data-nc-select-skip') === '1') return null;
        if (select.multiple) return null;
        var size = parseInt(select.getAttribute('size'), 10);
        if (!isNaN(size) && size > 1) return null;
        if (closestEl(select, '.nc-select-pop')) return null;
        if (!select.parentNode) return null;

        select.setAttribute('data-nc-select-enhanced', '1');

        var wrap = document.createElement('span');
        wrap.className = 'nc-select-wrap';
        wrap.setAttribute('data-nc-select-wrap', '1');
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);

        var trigger = document.createElement('span');
        trigger.className = 'nc-select__trigger nc-select';
        trigger.setAttribute('aria-hidden', 'true');

        var textEl = document.createElement('span');
        textEl.className = 'nc-select__text';
        trigger.appendChild(textEl);

        var chevron = icons && icons.el ? icons.el('chevron-down', 14) : null;
        if (chevron) {
            chevron.classList.add('nc-select__chevron');
            trigger.appendChild(chevron);
        } else {
            var fallbackChevron = document.createElement('span');
            fallbackChevron.className = 'nc-select__chevron nc-select__chevron--text';
            fallbackChevron.textContent = '▾';
            fallbackChevron.setAttribute('aria-hidden', 'true');
            trigger.appendChild(fallbackChevron);
        }
        wrap.appendChild(trigger);

        var state = {
            select: select,
            wrap: wrap,
            trigger: trigger,
            text: textEl,
            list: null,
            optionEls: [],
            activeIndex: -1,
            lastTouchAt: 0,
            sync: function () { syncSelect(state); },
            open: function (mode) { openSelect(state, mode); },
            close: function (focusBack) { closeSelect(state, focusBack); }
        };
        select.__ncSelect = state;

        // 程序化 .value 赋值不会触发 change：包一层实例访问器，立即同步触发层。
        // 原生属性描述符仍负责真实值，读取与表单提交行为不变。
        try {
            var proto = global.HTMLSelectElement && global.HTMLSelectElement.prototype;
            var descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.get && descriptor.set) {
                Object.defineProperty(select, 'value', {
                    configurable: true,
                    enumerable: false,
                    get: function () { return descriptor.get.call(this); },
                    set: function (value) {
                        descriptor.set.call(this, value);
                        syncSelect(state);
                    }
                });
            }
        } catch (err) { /* 访问器不可用则退回 change/open 时同步 */ }

        select.addEventListener('change', function () { syncSelect(state); });
        select.addEventListener('input', function () { syncSelect(state); });
        select.addEventListener('mousedown', function (event) {
            if (select.disabled) return;
            event.preventDefault();
            focusElement(select, true);
        });
        select.addEventListener('click', function (event) {
            if (select.disabled) return;
            if (Date.now() - (state.lastTouchAt || 0) < 700) {
                event.preventDefault();
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            toggleSelect(state);
        });
        select.addEventListener('keydown', function (event) {
            if (select.disabled) return;
            var key = event.key;
            if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' ||
                key === ' ' || key === 'Spacebar' || key === 'F4') {
                event.preventDefault();
                event.stopPropagation();
                openSelect(state, key === 'ArrowUp' ? 'last' : 'selected');
            }
        });
        select.addEventListener('touchstart', function (event) {
            if (select.disabled) return;
            if (event.touches && event.touches.length > 1) return;
            event.preventDefault();
            state.lastTouchAt = Date.now();
            focusElement(select, true);
            toggleSelect(state);
        }, { passive: false });

        var optionObserver = new MutationObserver(function () {
            syncSelect(state);
        });
        optionObserver.observe(select, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['disabled', 'selected', 'value', 'label', 'title']
        });
        state.optionObserver = optionObserver;

        syncSelect(state);
        return state;
    }

    function enhanceSelects(root) {
        var scope = root || document;
        if (!scope || !scope.querySelectorAll) return;
        if (scope.tagName === 'SELECT') {
            enhanceSelect(scope);
            return;
        }
        var nodes = scope.querySelectorAll('select:not([data-nc-select-enhanced])');
        Array.prototype.forEach.call(nodes, function (select) {
            try { enhanceSelect(select); } catch (err) { /* 单个 select 失败不阻断其它 */ }
        });
    }

    function startSelectObserver() {
        if (selectObserver || !document.body || !global.MutationObserver) return;
        selectObserver = new MutationObserver(function (mutations) {
            Array.prototype.forEach.call(mutations, function (mutation) {
                try {
                    if (mutation.type === 'attributes') {
                        var owner = mutation.target;
                        if (owner && owner.tagName !== 'SELECT') owner = closestEl(owner, 'select');
                        if (owner && owner.__ncSelect) owner.__ncSelect.sync();
                        return;
                    }
                    if (mutation.addedNodes && mutation.addedNodes.length) {
                        Array.prototype.forEach.call(mutation.addedNodes, function (node) {
                            if (!node || node.nodeType !== 1) return;
                            if (node.tagName === 'SELECT') enhanceSelect(node);
                            else if (node.querySelector && node.querySelector('select:not([data-nc-select-enhanced])')) {
                                enhanceSelects(node);
                            }
                        });
                    }
                    if (mutation.removedNodes && mutation.removedNodes.length && activeSelect) {
                        Array.prototype.forEach.call(mutation.removedNodes, function (node) {
                            if (node && node.nodeType === 1 && node.contains && node.contains(activeSelect.select)) {
                                closeSelect(activeSelect, false);
                            }
                        });
                    }
                } catch (err) { /* 观察器回调不冒泡错误 */ }
            });
        });
        selectObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['disabled', 'title', 'aria-label', 'aria-labelledby', 'multiple', 'size', 'data-placeholder']
        });
    }

    function initSelectEnhancer() {
        if (selectInitialized) return;
        selectInitialized = true;
        enhanceSelects(document);
        startSelectObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSelectEnhancer, { once: true });
    } else {
        initSelectEnhancer();
    }

    /* ------------------------------------------------------------------ *
     * 全局错误兜底
     * ------------------------------------------------------------------ */
    function installGlobalErrorHandlers() {
        global.addEventListener('error', function (event) {
            if (event && event.target && event.target !== global) return; // 资源加载错误单独处理
            console.error('[NC] uncaught error:', event.error || event.message);
            events.emit('app:error', { error: event.error, message: event.message });
        });
        global.addEventListener('unhandledrejection', function (event) {
            console.error('[NC] unhandled rejection:', event.reason);
            events.emit('app:error', { error: event.reason, message: String(event.reason) });
        });
    }

    function setBusy(button, busy) {
        if (!button) return;
        if (busy) {
            button.setAttribute('data-was-disabled', button.disabled ? '1' : '0');
            button.disabled = true;
            button.classList.add('is-loading');
            button.setAttribute('aria-busy', 'true');
        } else {
            if (button.getAttribute('data-was-disabled') === '0') button.disabled = false;
            button.classList.remove('is-loading');
            button.removeAttribute('aria-busy');
            button.removeAttribute('data-was-disabled');
        }
    }

    NC.ui = {
        openModal: openModal,
        confirm: confirm,
        alert: alert,
        prompt: prompt,
        toast: toast,
        openMenu: openMenu,
        enhanceSelect: enhanceSelect,
        enhanceSelects: enhanceSelects,
        closeSelect: closeActiveSelect,
        trapFocus: trapFocus,
        getFocusable: getFocusable,
        installGlobalErrorHandlers: installGlobalErrorHandlers,
        setBusy: setBusy
    };
})(window);
