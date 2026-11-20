/**
 * todo-composer.js — 待办创建区：快捷截止、草稿字段、标签、循环、AI 草稿
 * 从 todo-view.js 拆出；由 NC.todoComposer.create(deps) 创建实例。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    function create(deps) {
        var els = deps.els;
        var node = deps.node;
        var icon = deps.icon;
        var attr = deps.attr;
        var toggleClass = deps.toggleClass;
        var store = deps.store;
        var ui = deps.ui;
        var util = deps.util;
        var globalRef = deps.global;

        var composerTags = [];
        var pendingPasteText = '';
        var draftActive = false;
        var composerRecurrence = null;

        var QUICK_FALLBACK = [
            { kind: 'work-end', label: '下班前' },
            { kind: 'tomorrow', label: '明天前' },
            { kind: 'friday', label: '周五前' },
            { kind: 'next-week', label: '下周五前' },
            { kind: 'month-end', label: '月底前' },
            { kind: 'clear', label: '清除' }
        ];
        var RECURRENCE_OPTIONS = [
            { value: '', label: '不重复' },
            { value: 'daily', label: '每天' },
            { value: 'weekly', label: '每周' },
            { value: 'monthly', label: '每月' },
            { value: 'yearly', label: '每年' }
        ];

    function ensureQuickDue() {
        var host = els.composerExtra;
        if (!host) return;
        var wrap = document.getElementById('todo-quick-due');
        if (!wrap) {
            wrap = node('div', 'todo-quick-due todo-composer__field--wide');
            wrap.id = 'todo-quick-due';
            wrap.setAttribute('role', 'group');
            wrap.setAttribute('aria-label', '快捷截止时间');
            var head = node('div', 'todo-quick-due__head', '快捷时间');
            wrap.appendChild(head);
            var row = node('div', 'todo-quick-due__chips');
            var options = (NC.todoTime && NC.todoTime.OPTIONS) ? NC.todoTime.OPTIONS : QUICK_FALLBACK;
            options.forEach(function (option) {
                var chip = node('button', 'nc-chip todo-quick-chip', option.label);
                chip.type = 'button';
                attr(chip, 'data-quick-kind', option.kind);
                attr(chip, 'aria-pressed', 'false');
                if (option.kind === 'clear') toggleClass(chip, 'todo-quick-chip--danger', true);
                row.appendChild(chip);
            });
            wrap.appendChild(row);
            host.appendChild(wrap);
        }
        els.quickDue = wrap;
    }

    function ensureDraftFields() {
        var host = els.composerExtra;
        if (!host) return;

        if (!document.getElementById('todo-new-notes')) {
            var notesField = node('label', 'todo-composer__field todo-composer__field--wide');
            notesField.appendChild(node('span', 'todo-composer__fieldlabel', '任务详情'));
            var notes = document.createElement('textarea');
            notes.id = 'todo-new-notes';
            notes.className = 'nc-textarea todo-composer__notes';
            notes.rows = 2;
            notes.maxLength = 20000;
            notes.placeholder = '可选：详情、链接或备注';
            attr(notes, 'aria-label', '任务详情');
            notesField.appendChild(notes);
            host.appendChild(notesField);
        }
        if (!document.getElementById('todo-new-tags')) {
            var tagsField = node('label', 'todo-composer__field todo-composer__field--wide');
            tagsField.appendChild(node('span', 'todo-composer__fieldlabel', '标签'));
            var tagsInput = document.createElement('input');
            tagsInput.type = 'text';
            tagsInput.id = 'todo-new-tags';
            tagsInput.className = 'nc-input';
            tagsInput.maxLength = 400;
            tagsInput.placeholder = '逗号分隔，如：汇报, 安全';
            attr(tagsInput, 'aria-label', '任务标签');
            tagsField.appendChild(tagsInput);
            var chips = node('span', 'todo-composer__tagchips');
            chips.id = 'todo-new-tags-chips';
            tagsField.appendChild(chips);
            host.appendChild(tagsField);
        }
        if (!document.getElementById('todo-ai-draft') && els.composer) {
            var draft = node('div', 'todo-ai-draft');
            draft.id = 'todo-ai-draft';
            draft.hidden = true;
            draft.appendChild(icon('sparkles', 14));
            draft.appendChild(node('span', 'todo-ai-draft__text', 'AI 已识别，请确认后创建'));
            var dismiss = node('button', 'todo-ai-draft__dismiss');
            dismiss.type = 'button';
            attr(dismiss, 'aria-label', '隐藏 AI 提示');
            dismiss.appendChild(icon('x', 12));
            dismiss.addEventListener('click', function () { setDraftActive(false); });
            draft.appendChild(dismiss);
            els.composer.insertBefore(draft, els.composerExtra);
        }

        els.newNotes = document.getElementById('todo-new-notes');
        els.newTagsInput = document.getElementById('todo-new-tags');
        els.tagChips = document.getElementById('todo-new-tags-chips');
        els.aiDraft = document.getElementById('todo-ai-draft');
        renderComposerTags();
    }

    /* ---- 列表 / 全景模式切换（运行时注入，兼容 ntools.html 无此结构） ---- */
    function ensureRecurrenceField() {
        if (!els.composerExtra) return;
        if (document.getElementById('todo-new-recurrence')) {
            els.newRecurrence = document.getElementById('todo-new-recurrence');
            return;
        }
        var field = node('label', 'todo-composer__field');
        field.appendChild(node('span', 'todo-composer__fieldlabel', '重复'));
        var select = document.createElement('select');
        select.className = 'nc-select';
        select.id = 'todo-new-recurrence';
        attr(select, 'aria-label', '重复周期');
        RECURRENCE_OPTIONS.forEach(function (item) {
            var option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            select.appendChild(option);
        });
        select.addEventListener('change', function () { onComposerRecurrenceChange(select.value); });
        field.appendChild(select);
        els.composerExtra.appendChild(field);
        els.newRecurrence = select;
    }

    function onComposerRecurrenceChange(value) {
        composerRecurrence = value || null;
        if (!composerRecurrence) return;
        if (els.newDue && !els.newDue.value) {
            var ts = defaultDueForRecurrence();
            els.newDue.value = util.toDateTimeInputValue(ts);
            markQuickActive('');
            ui.toast('已为循环任务设置默认截止时间', { type: 'info', duration: 2600 });
        }
    }

    /** 循环任务缺 due 时的默认截止：今天下班时间（已过则当前时间），保证在 now 之后。 */
    function defaultDueForRecurrence() {
        var now = Date.now();
        var workEnd = '17:30';
        if (NC.todoTime && typeof NC.todoTime.getWorkEnd === 'function') workEnd = NC.todoTime.getWorkEnd();
        var parts = /^(\d{1,2}):(\d{2})$/.exec(workEnd) || [null, 17, 30];
        var todayEnd = util.startOfDay(now) + (parseInt(parts[1], 10) || 0) * 3600000 + (parseInt(parts[2], 10) || 0) * 60000;
        return todayEnd > now ? todayEnd : now + 5 * 60000;
    }

    function bindComposerExtras() {
        if (els.quickDue) {
            els.quickDue.addEventListener('click', function (event) {
                var chip = event.target.closest ? event.target.closest('[data-quick-kind]') : null;
                if (!chip) return;
                applyQuickDue(chip.getAttribute('data-quick-kind'));
            });
        }
        if (els.newDue) {
            var onDueChange = function () { clearQuickActive(); };
            els.newDue.addEventListener('input', onDueChange);
            els.newDue.addEventListener('change', onDueChange);
        }
        if (els.newTagsInput) {
            els.newTagsInput.addEventListener('keydown', function (event) {
                if (event.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                    event.preventDefault();
                    addTagsFromInput();
                } else if (event.key === 'Backspace' && !els.newTagsInput.value && composerTags.length) {
                    composerTags.pop();
                    renderComposerTags();
                }
            });
            els.newTagsInput.addEventListener('blur', addTagsFromInput);
            els.newTagsInput.addEventListener('change', addTagsFromInput);
        }
        if (els.tagChips) {
            els.tagChips.addEventListener('click', function (event) {
                var remove = event.target.closest ? event.target.closest('[data-draft-tag]') : null;
                if (!remove) return;
                var tag = remove.getAttribute('data-draft-tag');
                composerTags = composerTags.filter(function (item) { return item !== tag; });
                renderComposerTags();
            });
        }
        var longTextHinted = false;
        function showLongTextHint(text) {
            if (longTextHinted) return;
            longTextHinted = true;
            pendingPasteText = String(text).slice(0, 20000);
            ui.toast('粘贴的是长文本，可用 AI 识别提取待办', {
                type: 'info',
                duration: 6500,
                action: {
                    label: 'AI 识别',
                    onClick: function () {
                        if (NC.todoAi && typeof NC.todoAi.openDialog === 'function') {
                            NC.todoAi.openDialog(pendingPasteText);
                        } else {
                            ui.toast('AI 识别模块未加载', { type: 'warn' });
                        }
                    }
                }
            });
        }
        if (els.newTitle) {
            els.newTitle.addEventListener('input', function () {
                var value = String(els.newTitle.value || '');
                if (value.length > 120) showLongTextHint(value);
                else if (value.length <= 120) longTextHinted = false;
            });
            els.newTitle.addEventListener('paste', function (event) {
                var text = '';
                try {
                    var clipboard = event.clipboardData || global.clipboardData;
                    text = clipboard ? clipboard.getData('text') : '';
                } catch (err) { text = ''; }
                if (!text || text.length <= 120) return;
                showLongTextHint(text);
            });
        }
    }

    function applyQuickDue(kind) {
        if (!NC.todoTime || typeof NC.todoTime.computeQuickDue !== 'function') {
            ui.toast('快捷时间模块未加载（js/todo-time.js）', { type: 'warn' });
            return;
        }
        var ts = NC.todoTime.computeQuickDue(kind);
        if (kind === 'clear' || ts == null) {
            if (els.newDue) els.newDue.value = '';
            clearQuickActive();
            return;
        }
        if (els.newDue) els.newDue.value = util.toDateTimeInputValue(ts);
        markQuickActive(kind);
    }

    function markQuickActive(kind) {
        if (!els.quickDue) return;
        Array.prototype.forEach.call(els.quickDue.querySelectorAll('[data-quick-kind]'), function (chip) {
            var active = chip.getAttribute('data-quick-kind') === kind;
            toggleClass(chip, 'is-active', active);
            attr(chip, 'aria-pressed', active ? 'true' : 'false');
        });
    }

    /**
     * 当前 due 恰好等于某个快捷选项时高亮对应 chip（AI 草稿/手填共用）。
     */
    function syncQuickActiveFromDue() {
        if (!els.newDue || !els.newDue.value || !NC.todoTime ||
            typeof NC.todoTime.quickDueOptions !== 'function') {
            clearQuickActive();
            return;
        }
        var ts = util.parseDateTimeInputValue(els.newDue.value);
        if (!util.isFiniteNum(ts)) {
            clearQuickActive();
            return;
        }
        var options = NC.todoTime.quickDueOptions();
        var match = '';
        options.forEach(function (option) {
            if (option.kind !== 'clear' && option.ts === ts) match = option.kind;
        });
        if (match) markQuickActive(match);
        else clearQuickActive();
    }

    function clearQuickActive() {
        if (!els.quickDue) return;
        Array.prototype.forEach.call(els.quickDue.querySelectorAll('[data-quick-kind]'), function (chip) {
            toggleClass(chip, 'is-active', false);
            attr(chip, 'aria-pressed', 'false');
        });
    }

    /**
     * 快捷时间选项（添加页与详情页共用，含 kind/顺序/文案）。
     * @returns {Array<{kind:string,label:string,ts:number|null,text:string}>}
     */
    function quickDueOptionList() {
        if (NC.todoTime && typeof NC.todoTime.quickDueOptions === 'function') {
            return NC.todoTime.quickDueOptions();
        }
        return QUICK_FALLBACK.map(function (option) {
            return { kind: option.kind, label: option.label, ts: null, text: option.label };
        });
    }

    function applyQuickChipMeta(chip, option) {
        if (!chip || !option) return;
        var text = option.text || option.label;
        attr(chip, 'title', text);
        attr(chip, 'aria-label', option.kind === 'clear' ? '清除截止时间' : option.label + '：' + text);
    }

    /**
     * 详情页快捷时间与添加页保持一致：同一组 kind/顺序/文案，清除按钮同款危险色。
     */
    function syncDetailQuick(task) {
        if (!els.detailInner) return;
        var quick = els.detailInner.querySelector('.detail-quick');
        if (!quick) return;
        var options = quickDueOptionList();
        var activeKind = '';
        if (task && util.isFiniteNum(task.due)) {
            options.forEach(function (option) {
                if (option.kind !== 'clear' && option.ts === task.due) activeKind = option.kind;
            });
        }
        options.forEach(function (option) {
            var chip = quick.querySelector('[data-quick-kind="' + option.kind + '"]');
            if (!chip) return;
            applyQuickChipMeta(chip, option);
            toggleClass(chip, 'is-active', option.kind === activeKind);
            attr(chip, 'aria-pressed', option.kind === activeKind ? 'true' : 'false');
        });
    }

    function refreshDetailQuick() {
        if (!els.detailInner) return;
        var id = store.getUi().selectedId;
        var task = id ? store.getTask(id) : null;
        if (task) syncDetailQuick(task);
    }

    function refreshQuickDue() {
        if (!els.quickDue) return;
        var options = quickDueOptionList();
        options.forEach(function (option) {
            var chip = els.quickDue.querySelector('[data-quick-kind="' + option.kind + '"]');
            if (!chip) return;
            applyQuickChipMeta(chip, option);
        });
        refreshDetailQuick();
    }

    function addTagsFromInput() {
        if (!els.newTagsInput) return;
        var raw = String(els.newTagsInput.value || '').trim();
        if (!raw) return;
        raw.split(/[,，;；\s]+/).forEach(function (item) {
            var tag = item.trim().slice(0, 32);
            if (!tag || composerTags.indexOf(tag) > -1 || composerTags.length >= 20) return;
            composerTags.push(tag);
        });
        els.newTagsInput.value = '';
        renderComposerTags();
    }

    function renderComposerTags() {
        if (!els.tagChips) return;
        while (els.tagChips.firstChild) els.tagChips.removeChild(els.tagChips.firstChild);
        composerTags.forEach(function (tag) {
            var chip = node('span', 'todo-draft-tag');
            chip.appendChild(document.createTextNode(tag));
            var remove = node('button', 'todo-draft-tag__remove');
            remove.type = 'button';
            attr(remove, 'data-draft-tag', tag);
            attr(remove, 'aria-label', '移除标签：' + tag);
            remove.appendChild(icon('x', 10));
            chip.appendChild(remove);
            els.tagChips.appendChild(chip);
        });
        if (els.tagChips.parentNode) toggleClass(els.tagChips.parentNode, 'has-tags', composerTags.length > 0);
    }

    function resetComposerTags() {
        composerTags = [];
        if (els.newTagsInput) els.newTagsInput.value = '';
        renderComposerTags();
    }

    function setDraftActive(active) {
        draftActive = !!active;
        toggleClass(els.composer, 'is-ai-draft', draftActive);
        if (els.aiDraft) els.aiDraft.hidden = !draftActive;
    }

    /**
     * 从 AI 草稿中取合法的重复频率（白名单，只接受 UI 支持的四种）。
     * @param {*} value
     * @returns {string} '' 表示不重复
     */
    function draftRecurrenceFreq(value) {
        var freq = (value && typeof value === 'object' && typeof value.freq === 'string')
            ? value.freq.trim().toLowerCase()
            : '';
        return ['daily', 'weekly', 'monthly', 'yearly'].indexOf(freq) > -1 ? freq : '';
    }

    /**
     * 用 AI 识别的结果填充创建区（不创建任务）。
     * @param {{title,notes,due,dueAllDay,priority,tags,listName,recurrence}} data
     * @returns {boolean}
     */
    function applyDraft(data) {
        if (!data || typeof data !== 'object') return false;
        ensure();
        if (!els.newTitle) return false;
        if (deps.expandComposer) deps.expandComposer(true);
        els.newTitle.value = data.title != null ? String(data.title).slice(0, 500) : '';
        if (els.newNotes) els.newNotes.value = data.notes != null ? String(data.notes).slice(0, 20000) : '';
        if (els.newDue) els.newDue.value = util.isFiniteNum(data.due) ? util.toDateTimeInputValue(data.due) : '';
        if (els.newPriority && data.priority && ['low', 'normal', 'high', 'urgent'].indexOf(data.priority) > -1) {
            els.newPriority.value = data.priority;
        }
        /* 循环：AI 可能省略或返回非法值，一律按白名单处理，避免残留上一次草稿的重复设置 */
        var recurrenceFreq = draftRecurrenceFreq(data.recurrence);
        composerRecurrence = recurrenceFreq || null;
        if (els.newRecurrence) els.newRecurrence.value = recurrenceFreq;
        if (recurrenceFreq && els.newDue && !els.newDue.value) {
            els.newDue.value = util.toDateTimeInputValue(defaultDueForRecurrence());
        }
        var tags = Array.isArray(data.tags) ? data.tags : [];
        composerTags = tags.filter(function (tag) {
            return typeof tag === 'string' && tag.trim();
        }).map(function (tag) { return tag.trim().slice(0, 32); }).slice(0, 20);
        renderComposerTags();
        if (els.newList && data.listName) {
            var target = String(data.listName).trim().toLowerCase();
            Array.prototype.forEach.call(els.newList.options, function (option) {
                if (String(option.textContent).trim().toLowerCase() === target) els.newList.value = option.value;
            });
        }
        syncQuickActiveFromDue();
        setDraftActive(true);
        els.newTitle.focus();
        try {
            var length = els.newTitle.value.length;
            els.newTitle.setSelectionRange(length, length);
        } catch (err) { /* ignore */ }
        return true;
    }


        function ensure() {
            ensureQuickDue();
            ensureDraftFields();
            ensureRecurrenceField();
            bindComposerExtras();
            refreshQuickDue();
        }

        function reset() {
            resetComposerTags();
            clearQuickActive();
            setDraftActive(false);
            composerRecurrence = null;
            if (els.newRecurrence) els.newRecurrence.value = '';
        }

        return {
            ensure: ensure,
            applyDraft: applyDraft,
            refreshQuickDue: refreshQuickDue,
            getTags: function () { return composerTags.slice(); },
            quickDueOptionList: quickDueOptionList,
            applyQuickChipMeta: applyQuickChipMeta,
            syncDetailQuick: syncDetailQuick,
            defaultDueForRecurrence: defaultDueForRecurrence,
            getPendingPaste: function () { return pendingPasteText; },
            getRecurrence: function () { return composerRecurrence; },
            reset: reset,
            setDraftActive: setDraftActive
        };
    }

    NC.todoComposer = { create: create };
})(window);
