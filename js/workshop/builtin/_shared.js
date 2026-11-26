/**
 * _shared.js — 内置工具的公共主题桥（v8）
 * 初始值：读取 ?theme=&lite=；之后监听父页 postMessage，不再 reload。
 * 独立打开（file://）时也能工作；父页消息必须来自 window.parent。
 */
(function () {
    'use strict';

    function apply(theme, lite) {
        document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
        document.documentElement.setAttribute('data-lite', lite ? 'true' : 'false');
    }

    var params = new URLSearchParams(location.search);
    apply(params.get('theme') || 'dark', params.get('lite') === '1');

    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        var data = event.data;
        if (!data || data.type !== 'nc-ws-theme') return;
        apply(data.theme, !!data.lite);
        try {
            window.parent.postMessage({ type: 'nc-ws-theme-ack', requestId: data.requestId || '' }, '*');
        } catch (err) { /* ignore */ }
    });
})();

/* ==========================================================================
 * v8.1 自绘 select：保留原生 <select> 作为值源，视觉与交互由 trigger/list 接管
 * ========================================================================== */
(function () {
    'use strict';
    if (window.__toolSelectInit) return;
    window.__toolSelectInit = true;

    var openState = null;
    var listSeq = 0;

    function selectedText(select) {
        var option = select.options[select.selectedIndex];
        return option ? String(option.textContent || '') : '';
    }

    function sync(select) {
        if (!select._tselect) return;
        var state = select._tselect;
        state.label.textContent = selectedText(select);
        state.trigger.disabled = !!select.disabled;
        if (!select.disabled) state.trigger.removeAttribute('aria-disabled');
        else state.trigger.setAttribute('aria-disabled', 'true');
    }

    function close() {
        if (!openState) return;
        var state = openState;
        openState = null;
        state.trigger.setAttribute('aria-expanded', 'false');
        state.list.classList.remove('is-open');
        document.removeEventListener('pointerdown', state.onOutside, true);
        document.removeEventListener('keydown', state.onKey, true);
        window.removeEventListener('resize', state.onViewport);
        window.removeEventListener('scroll', state.onViewport, true);
        setTimeout(function () {
            if (state.list.parentNode) state.list.parentNode.removeChild(state.list);
        }, 130);
    }

    function choose(state, optionEl, value) {
        if (state.select.value !== value) {
            state.select.value = value;
            state.select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        sync(state.select);
        close();
        state.trigger.focus();
    }

    function open(state) {
        if (openState === state) {
            close();
            return;
        }
        close();
        var select = state.select;
        sync(select);
        var options = Array.prototype.slice.call(select.options).filter(function (option) {
            return !option.hidden;
        });
        var list = document.createElement('div');
        list.className = 'tselect__list';
        list.id = 'tselect-list-' + (++listSeq);
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', select.getAttribute('aria-label') || '选项');
        var optionEls = [];

        options.forEach(function (option) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'tselect__option';
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', option.index === select.selectedIndex ? 'true' : 'false');
            item.disabled = !!option.disabled;
            item.textContent = String(option.textContent || '');
            item.addEventListener('click', function () {
                choose(state, item, option.value);
            });
            list.appendChild(item);
            optionEls.push(item);
        });

        if (!optionEls.length) {
            var empty = document.createElement('div');
            empty.className = 'tselect__option';
            empty.textContent = '暂无可选项';
            list.appendChild(empty);
        }

        document.body.appendChild(list);
        var rect = state.trigger.getBoundingClientRect();
        var estimated = Math.min(260, optionEls.length * 32 + 12);
        var top = rect.bottom + 4;
        if (top + estimated > window.innerHeight - 8) {
            top = Math.max(8, rect.top - estimated - 4);
        }
        list.style.left = Math.max(8, rect.left) + 'px';
        list.style.top = top + 'px';
        list.style.width = Math.max(120, Math.min(rect.width, window.innerWidth - 16)) + 'px';
        void list.offsetWidth;
        list.classList.add('is-open');
        state.trigger.setAttribute('aria-expanded', 'true');

        function onOutside(event) {
            if (list.contains(event.target) || state.trigger.contains(event.target)) return;
            close();
        }
        function onKey(event) {
            var current = optionEls.indexOf(document.activeElement);
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
                state.trigger.focus();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                var delta = event.key === 'ArrowDown' ? 1 : -1;
                var next = current < 0 ? (delta > 0 ? 0 : optionEls.length - 1) : (current + delta + optionEls.length) % optionEls.length;
                if (optionEls[next]) optionEls[next].focus();
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                var target = event.key === 'Home' ? 0 : optionEls.length - 1;
                if (optionEls[target]) optionEls[target].focus();
            } else if ((event.key === 'Enter' || event.key === ' ') && current > -1) {
                event.preventDefault();
                optionEls[current].click();
            } else if (event.key === 'Tab') {
                close();
            }
        }
        function onViewport(event) {
            if (event && event.type === 'scroll' && list.contains(event.target)) return;
            close();
        }

        state.list = list;
        state.onOutside = onOutside;
        state.onKey = onKey;
        state.onViewport = onViewport;
        openState = state;
        setTimeout(function () {
            document.addEventListener('pointerdown', onOutside, true);
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('resize', onViewport);
            window.addEventListener('scroll', onViewport, true);
        }, 0);

        var selectedIndex = -1;
        options.forEach(function (option, index) {
            if (option.index === select.selectedIndex) selectedIndex = index;
        });
        var focusTarget = optionEls[selectedIndex > -1 ? selectedIndex : 0];
        if (focusTarget) focusTarget.focus();
    }

    function enhance(select) {
        if (!select || select._tselect) return;
        if (select.multiple || Number(select.size) > 1) return;
        var rect = select.getBoundingClientRect();
        if (rect.width < 8) return;
        var parent = select.parentNode;
        if (!parent) return;
        var parentWidth = parent.clientWidth || rect.width;
        var block = rect.width >= parentWidth - 4 || getComputedStyle(select).width === '100%';

        var wrap = document.createElement('span');
        wrap.className = 'tselect' + (block ? ' is-block' : '');
        if (!block) wrap.style.width = Math.max(64, Math.round(rect.width)) + 'px';
        parent.insertBefore(wrap, select);
        wrap.appendChild(select);
        select.classList.add('tselect__native');
        select.setAttribute('aria-hidden', 'true');
        select.tabIndex = -1;

        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'tselect__trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        var label = document.createElement('span');
        label.className = 'tselect__label';
        var caret = document.createElement('span');
        caret.className = 'tselect__caret';
        caret.setAttribute('aria-hidden', 'true');
        trigger.appendChild(label);
        trigger.appendChild(caret);
        var labelledBy = select.getAttribute('aria-label');
        if (labelledBy) trigger.setAttribute('aria-label', labelledBy);
        else {
            var labelText = '';
            try {
                var labels = select.labels;
                if (labels && labels.length) labelText = labels[0].textContent;
            } catch (err) { labelText = ''; }
            if (labelText) trigger.setAttribute('aria-label', labelText.trim());
        }
        wrap.appendChild(trigger);

        var state = { select: select, trigger: trigger, label: label, list: null };
        select._tselect = state;
        sync(select);

        trigger.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            if (select.disabled) return;
            open(state);
        });
        trigger.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open(state);
            }
        });
        select.addEventListener('change', function () { sync(select); });
        // 点击 label 仍可能聚焦原生 select：把焦点交回 trigger 并打开
        select.addEventListener('focus', function () {
            if (select.disabled) return;
            trigger.focus();
            open(state);
        });
        try {
            new MutationObserver(function () { sync(select); }).observe(select, {
                childList: true, subtree: true, characterData: true
            });
        } catch (err) { /* ignore */ }
        try {
            var valDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
            if (valDesc && valDesc.get && valDesc.set) {
                Object.defineProperty(select, 'value', {
                    configurable: true,
                    get: function () { return valDesc.get.call(this); },
                    set: function (v) { valDesc.set.call(this, v); sync(this); }
                });
            }
            var idxDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
            if (idxDesc && idxDesc.get && idxDesc.set) {
                Object.defineProperty(select, 'selectedIndex', {
                    configurable: true,
                    get: function () { return idxDesc.get.call(this); },
                    set: function (v) { idxDesc.set.call(this, v); sync(this); }
                });
            }
        } catch (err) { /* ignore */ }
    }

    function enhanceAll(root) {
        var scope = root || document;
        Array.prototype.forEach.call(scope.querySelectorAll('select'), enhance);
    }

    window.ncBuiltinSyncSelect = sync;
    window.ncBuiltinEnhanceSelects = enhanceAll;

    var sharedAudioCtx = null;
    window.ncBuiltinPlayBeep = function (kind) {
        try {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
            if (sharedAudioCtx.state === 'suspended' && sharedAudioCtx.resume) {
                sharedAudioCtx.resume().catch(function () {});
            }
            var seq = kind === 'focus'
                ? [[523, 0, 0.2], [659, 0.2, 0.35]]
                : (kind === 'break'
                    ? [[659, 0, 0.16], [784, 0.16, 0.16], [1046, 0.32, 0.35]]
                    : [[880, 0, 0.24], [880, 0.26, 0.24], [1046, 0.52, 0.4]]);
            var base = sharedAudioCtx.currentTime;
            seq.forEach(function (note) {
                var osc = sharedAudioCtx.createOscillator();
                var gain = sharedAudioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = note[0];
                gain.gain.setValueAtTime(0.08, base + note[1]);
                gain.gain.exponentialRampToValueAtTime(0.001, base + note[1] + note[2]);
                osc.connect(gain);
                gain.connect(sharedAudioCtx.destination);
                osc.start(base + note[1]);
                osc.stop(base + note[1] + note[2]);
            });
        } catch (err) { /* ignore */ }
    };

    window.ncBuiltinCopy = function (text) {
        var value = String(text == null ? '' : text);
        function fallback() {
            try {
                var area = document.createElement('textarea');
                area.value = value;
                area.setAttribute('readonly', 'readonly');
                area.style.position = 'fixed';
                area.style.left = '-9999px';
                area.style.top = '0';
                document.body.appendChild(area);
                area.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(area);
                return ok;
            } catch (err) { return false; }
        }
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
            return navigator.clipboard.writeText(value).then(function () { return true; }).catch(fallback);
        }
        return Promise.resolve(fallback());
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { enhanceAll(); });
    } else {
        enhanceAll();
    }
})();
