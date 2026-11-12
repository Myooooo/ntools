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
            }, 180);
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
     * ------------------------------------------------------------------ */
    function openMenu(anchor, items, options) {
        var opts = options || {};
        var previousFocus = document.activeElement;
        var menu = document.createElement('div');
        menu.className = 'nc-menu';
        menu.setAttribute('role', 'menu');
        var buttons = [];
        var activeIndex = -1;

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

        function close() {
            if (!menu.parentNode) return;
            menu.parentNode.removeChild(menu);
            document.removeEventListener('mousedown', onOutside, true);
            document.removeEventListener('keydown', onKeydown, true);
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

        document.body.appendChild(menu);
        var rect = anchor.getBoundingClientRect();
        var menuRect = menu.getBoundingClientRect();
        var left = Math.min(Math.max(8, rect.right - menuRect.width), global.innerWidth - menuRect.width - 8);
        var top = rect.bottom + 6;
        if (top + menuRect.height > global.innerHeight - 8) {
            top = Math.max(8, rect.top - menuRect.height - 6);
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';

        setTimeout(function () {
            document.addEventListener('mousedown', onOutside, true);
            document.addEventListener('keydown', onKeydown, true);
        }, 0);
        menu.querySelector('.nc-menu__item:not(:disabled)') && menu.querySelector('.nc-menu__item:not(:disabled)').focus();
        return { el: menu, close: close };
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
        trapFocus: trapFocus,
        getFocusable: getFocusable,
        installGlobalErrorHandlers: installGlobalErrorHandlers,
        setBusy: setBusy
    };
})(window);
