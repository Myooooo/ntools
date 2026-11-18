/**
 * mail-select.js — 邮件页自绘下拉（独立文档，无主应用依赖）
 *
 * 原生 <select> 在 Chromium 下弹出的是系统列表，与 Precision Workbench 语言冲突。
 * 这里保留 <select> 作为值容器（.value 与 change 契约不变），
 * 视觉与交互交给 .msel 触发器 + .msel-pop 列表。
 */
(function (global) {
    'use strict';

    var POP_ID = 'mail-select-pop';
    var pop = null;
    var openState = null;

    function ensurePop() {
        if (pop && document.body.contains(pop)) return pop;
        pop = document.createElement('div');
        pop.id = POP_ID;
        pop.className = 'msel-pop';
        pop.hidden = true;
        pop.setAttribute('role', 'listbox');
        document.body.appendChild(pop);
        return pop;
    }

    function closePop() {
        if (!openState) return;
        var state = openState;
        openState = null;
        state.trigger.setAttribute('aria-expanded', 'false');
        state.wrap.classList.remove('is-open');
        if (pop) {
            pop.classList.remove('is-open');
            pop.hidden = true;
        }
    }

    function position(state) {
        var rect = state.trigger.getBoundingClientRect();
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var width = Math.max(rect.width, 160);
        var height = pop.offsetHeight || 220;
        var left = Math.max(8, Math.min(rect.left, vw - width - 8));
        var top = rect.bottom + 4;
        if (top + height > vh - 8) top = Math.max(8, rect.top - height - 4);
        pop.style.width = width + 'px';
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
    }

    function render(state) {
        var select = state.select;
        pop.textContent = '';
        Array.prototype.forEach.call(select.options, function (option, index) {
            if (option.disabled && !option.value) return;
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'msel-opt';
            row.setAttribute('role', 'option');
            row.setAttribute('data-index', String(index));
            if (index === select.selectedIndex) row.classList.add('is-selected');
            if (option.disabled) {
                row.disabled = true;
                row.classList.add('is-disabled');
            }
            var label = document.createElement('span');
            label.className = 'msel-opt__label';
            label.textContent = option.textContent;
            row.appendChild(label);
            if (index === select.selectedIndex) {
                var check = document.createElement('span');
                check.className = 'msel-opt__check';
                check.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
                row.appendChild(check);
            }
            row.addEventListener('click', function () {
                select.selectedIndex = index;
                try { select.dispatchEvent(new Event('change', { bubbles: true })); } catch (err) { /* ignore */ }
                sync(state);
                closePop();
                try { state.trigger.focus(); } catch (err) { /* ignore */ }
            });
            pop.appendChild(row);
        });
    }

    function open(state) {
        ensurePop();
        if (openState && openState !== state) closePop();
        openState = state;
        state.wrap.classList.add('is-open');
        state.trigger.setAttribute('aria-expanded', 'true');
        pop.hidden = false;
        render(state);
        position(state);
        pop.classList.add('is-open');
        var active = pop.querySelector('.msel-opt.is-selected') || pop.querySelector('.msel-opt');
        if (active) { try { active.focus(); } catch (err) { /* ignore */ } }
    }

    function sync(state) {
        var option = state.select.options[state.select.selectedIndex];
        state.label.textContent = option ? option.textContent : '';
        state.trigger.title = option ? option.textContent : '';
        /* 外部逻辑会给原生 select 加 filter-active / disabled，镜像到触发器 */
        state.wrap.classList.toggle('filter-active', state.select.classList.contains('filter-active'));
        state.trigger.disabled = !!state.select.disabled;
    }

    function enhance(select) {
        if (!select || select.getAttribute('data-msel') === '1') return null;
        if (select.multiple || select.size > 1) return null;
        select.setAttribute('data-msel', '1');
        /* 先取原始类名（之后会给 select 加 msel-native，不能复制到 wrapper） */
        var extra = String(select.className || '')
            .replace(/\bcontrol-select\b/g, '')
            .trim();
        select.classList.add('msel-native');
        select.setAttribute('tabindex', '-1');
        select.setAttribute('aria-hidden', 'true');

        var wrap = document.createElement('div');
        wrap.className = 'msel' + (extra ? ' ' + extra : '');
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);

        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'msel-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        var label = document.createElement('span');
        label.className = 'msel-trigger__label';
        var chev = document.createElement('span');
        chev.className = 'msel-trigger__chev';
        chev.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
        trigger.appendChild(label);
        trigger.appendChild(chev);
        wrap.appendChild(trigger);

        var state = { select: select, wrap: wrap, trigger: trigger, label: label };
        sync(state);

        var desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        try {
            Object.defineProperty(select, 'value', {
                configurable: true,
                get: function () { return desc.get.call(this); },
                set: function (v) { desc.set.call(this, v); sync(state); }
            });
        } catch (err) { /* ignore */ }

        select.addEventListener('change', function () { sync(state); });

        if (global.MutationObserver) {
            new global.MutationObserver(function () { sync(state); }).observe(select, {
                attributes: true,
                attributeFilter: ['class', 'disabled']
            });
        }

        trigger.addEventListener('click', function (event) {
            event.preventDefault();
            if (openState === state) closePop();
            else open(state);
        });
        trigger.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open(state);
            }
        });

        return state;
    }

    function enhanceAll(root) {
        var scope = root || document;
        var nodes = scope.querySelectorAll ? scope.querySelectorAll('select:not([data-msel])') : [];
        Array.prototype.forEach.call(nodes, function (select) {
            try { enhance(select); } catch (err) { /* ignore */ }
        });
    }

    document.addEventListener('mousedown', function (event) {
        if (!openState) return;
        if (pop && pop.contains(event.target)) return;
        if (openState.wrap.contains(event.target)) return;
        closePop();
    }, true);
    document.addEventListener('keydown', function (event) {
        if (!openState) return;
        if (event.key === 'Escape') { event.preventDefault(); closePop(); openState = null; }
    }, true);
    global.addEventListener('resize', function () { if (openState) position(openState); });
    document.addEventListener('scroll', function () { if (openState) position(openState); }, true);

    function init() {
        enhanceAll(document);
        if (global.MutationObserver) {
            new global.MutationObserver(function (mutations) {
                for (var i = 0; i < mutations.length; i += 1) {
                    var added = mutations[i].addedNodes;
                    for (var j = 0; j < added.length; j += 1) {
                        var node = added[j];
                        if (node.nodeType !== 1) continue;
                        if (node.tagName === 'SELECT') enhance(node);
                        else enhanceAll(node);
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})(window);
