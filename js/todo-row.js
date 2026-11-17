/**
 * todo-row.js — 待办「行渲染」：任务行 / 分组头 / 热区 / 内联编辑
 * 经典脚本，依赖 core.js（util）、icons.js、schema-todo.js。
 *
 * 从 todo-view.js 拆出（v5.9）：这一段只负责"把一条任务/一个分组变成 DOM 节点，
 * 并把数据变化同步到已有节点"，不涉及路由、搜索、拖拽与详情表单。
 * 共享的 DOM 引用、节点表、常量由 todo-view 通过 init(ctx) 注入，
 * 不新增任何全局可变状态。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var S = null;
    var inlineEdit = null;

    /** 由 todo-view.init() 调用一次 */
    function init(ctx) {
        S = ctx;
        return true;
    }

    function renderList(visible, ui, doc) {
        var items = S.buildItems(visible, ui, doc);
        var list = S.els.list;

        if (!items.length) {
            while (list.firstChild) list.removeChild(list.firstChild);
            clearNodeMap();
            list.hidden = true;
            S.els.empty.hidden = false;
            S.renderEmpty(visible, ui, doc);
            return;
        }
        list.hidden = false;
        S.els.empty.hidden = true;

        var seen = Object.create(null);
        var cursor = list.firstChild;
        items.forEach(function (item) {
            var existing = S.nodeMap[item.key];
            var el;
            if (existing) {
                el = existing;
                if (item.type === 'task') updateTaskNode(el, item.task, ui, doc);
                else updateGroupNode(el, item.group);
            } else {
                el = item.type === 'task' ? createTaskNode(item.task, ui, doc) : createGroupNode(item.group);
                S.nodeMap[item.key] = el;
                if (S.rendered.initialized) {
                    el.classList.add('is-new');
                    global.setTimeout(function () { el.classList.remove('is-new'); }, 320);
                }
            }
            seen[item.key] = true;
            if (el === cursor) {
                cursor = cursor.nextSibling;
            } else {
                list.insertBefore(el, cursor);
            }
        });
        while (cursor) {
            var next = cursor.nextSibling;
            list.removeChild(cursor);
            cursor = next;
        }
        Object.keys(S.nodeMap).forEach(function (key) {
            if (!seen[key]) delete S.nodeMap[key];
        });
        syncDraggable(visible && visible.sort === 'manual', list);
        applyRovingTabindex(ui);
    }

    var lastManual = null;
    /** 手动排序下才允许拖动行（其它排序拖了也会被 dragstart 拦掉，但不要显示可拖手感） */
    function syncDraggable(manual, list) {
        if (lastManual === manual) return;
        lastManual = manual;
        Array.prototype.forEach.call(list.querySelectorAll('.todo-item'), function (row) {
            if (manual) S.attr(row, 'draggable', 'true');
            else row.removeAttribute('draggable');
        });
    }

    function clearNodeMap() {
        Object.keys(S.nodeMap).forEach(function (key) { delete S.nodeMap[key]; });
    }

    function applyRovingTabindex(ui) {
        var hasSelected = false;
        Object.keys(S.nodeMap).forEach(function (key) {
            var el = S.nodeMap[key];
            if (!el || !el.classList || !el.classList.contains('todo-item')) return;
            var body = el.__refs ? el.__refs.body : el.querySelector('.todo-item__body');
            if (!body) return;
            var selected = !!ui.selectedId && el.getAttribute('data-id') === ui.selectedId;
            if (selected) hasSelected = true;
            body.tabIndex = selected ? 0 : -1;
        });
        if (!hasSelected) {
            /* 没有任何选中项：第一行可聚焦 */
            var list = S.els.list;
            var firstBody = list ? list.querySelector('.todo-item__body') : null;
            if (firstBody) firstBody.tabIndex = 0;
        }
    }

    /* ---- 任务行 ---- */
    function createTaskNode(task, ui, doc) {
        var li = S.node('li', 'todo-item');
        S.attr(li, 'data-id', task.id);
        if (lastManual === true) S.attr(li, 'draggable', 'true');
        li.setAttribute('role', 'listitem');

        var check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'nc-check todo-item__check';
        S.attr(check, 'aria-label', '完成任务：' + task.title);

        var body = S.node('button', 'todo-item__body');
        S.attr(body, 'type', 'button');
        S.attr(body, 'data-act', 'open');
        S.attr(body, 'aria-label', '查看任务：' + task.title);

        var titleline = S.node('span', 'todo-item__titleline');
        var pinMark = S.node('span', 'todo-item__pin');
        pinMark.appendChild(S.icon('flag', 12));
        S.attr(pinMark, 'aria-hidden', 'true');
        titleline.appendChild(pinMark);
        /* 循环图标在标题左侧（置顶图标之后）；无循环时 hidden 不占位 */
        var repeatMark = S.node('span', 'todo-item__repeat');
        repeatMark.appendChild(S.icon('refresh', 12));
        titleline.appendChild(repeatMark);
        var title = S.node('span', 'todo-item__title');
        titleline.appendChild(title);
        /* 标签移到行级右侧栏（贴着操作按钮左侧，垂直居中），标题行只保留 pin→repeat→title */
        var tags = S.node('span', 'todo-item__tags');

        var meta = S.node('span', 'todo-item__meta');
        var due = S.node('span', 'todo-item__due');
        var flag = S.node('span', 'todo-item__flag');
        var dot = S.node('span', 'todo-prio-dot');
        var prioText = S.node('span', 'todo-item__prio-text');
        flag.appendChild(dot);
        flag.appendChild(prioText);
        var listChip = S.node('span', 'todo-item__list');
        meta.appendChild(due);
        meta.appendChild(flag);
        meta.appendChild(listChip);

        body.appendChild(titleline);
        body.appendChild(meta);

        var acts = S.node('div', 'todo-item__actions');
        var pinBtn = S.node('button', 'nc-btn nc-btn--icon nc-btn--sm');
        S.attr(pinBtn, 'type', 'button');
        S.attr(pinBtn, 'data-act', 'pin');
        S.attr(pinBtn, 'aria-label', '置顶任务');
        pinBtn.appendChild(S.icon('flag', 14));
        acts.appendChild(pinBtn);
        var delBtn = S.node('button', 'nc-btn nc-btn--icon nc-btn--sm');
        S.attr(delBtn, 'type', 'button');
        S.attr(delBtn, 'data-act', 'delete');
        S.attr(delBtn, 'aria-label', '删除任务');
        delBtn.appendChild(S.icon('trash', 15));
        /* 回收站专用操作 */
        var restoreBtn = S.node('button', 'nc-btn nc-btn--icon nc-btn--sm');
        S.attr(restoreBtn, 'type', 'button');
        S.attr(restoreBtn, 'data-act', 'restore');
        S.attr(restoreBtn, 'aria-label', '恢复任务');
        S.attr(restoreBtn, 'title', '恢复任务');
        restoreBtn.appendChild(S.icon('refresh', 15));
        var purgeBtn = S.node('button', 'nc-btn nc-btn--icon nc-btn--sm');
        S.attr(purgeBtn, 'type', 'button');
        S.attr(purgeBtn, 'data-act', 'purge');
        S.attr(purgeBtn, 'aria-label', '彻底删除');
        S.attr(purgeBtn, 'title', '彻底删除（不可恢复）');
        purgeBtn.appendChild(S.icon('trash', 15));
        acts.appendChild(delBtn);
        acts.appendChild(restoreBtn);
        acts.appendChild(purgeBtn);

        li.appendChild(check);
        li.appendChild(body);
        li.appendChild(tags);
        li.appendChild(acts);
        li.__task = task;
        /* 句柄缓存：updateTaskNode 每行每帧要访问十来个后代元素，
         * 1000 行时 querySelector 会变成万级子树查询。建一次、存下来。 */
        li.__refs = {
            check: check,
            body: body,
            title: title,
            tags: tags,
            pinMark: pinMark,
            repeatMark: repeatMark,
            pinBtn: pinBtn,
            delBtn: delBtn,
            restoreBtn: restoreBtn,
            purgeBtn: purgeBtn,
            due: due,
            prioText: prioText,
            prioDot: dot,
            listChip: listChip,
            acts: acts
        };
        updateTaskNode(li, task, ui, doc);
        return li;
    }

    function updateTaskNode(li, task, ui, doc) {
        var now = Date.now();
        var done = task.status === 'done';
        var canceled = task.status === 'canceled';
        var classes = 'todo-item';
        if (done) classes += ' is-done';
        if (canceled) classes += ' is-canceled';
        if (task.pinned === true) classes += ' is-pinned';
        if (ui.selectedId === task.id) classes += ' is-selected';
        if (ui.editingId === task.id) classes += ' is-editing';
        if (ui.view === 'trash') classes += ' is-trash';
        if (!done && !canceled && task.due != null && task.due < now) classes += ' is-overdue';
        var heat = heatClass(task, now);
        if (heat) classes += ' ' + heat;
        li.className = classes;
        S.attr(li, 'data-heat', heat || '');
        S.attr(li, 'data-pinned', task.pinned === true ? 'true' : 'false');
        S.attr(li, 'data-id', task.id);
        S.attr(li, 'data-status', task.status);
        S.attr(li, 'data-priority', task.priority);
        li.__task = task;

        var refs = li.__refs;
        var trashView = ui.view === 'trash';
        var check = refs ? refs.check : li.querySelector('.todo-item__check');
        if (check) {
            check.checked = done;
            check.hidden = trashView;
            S.attr(check, 'aria-label', (done ? '取消完成：' : '完成任务：') + task.title);
        }
        /* 回收站只保留「恢复 / 彻底删除」，隐藏置顶/删除与完成 checkbox */
        if (refs) {
            refs.pinBtn.hidden = trashView;
            refs.delBtn.hidden = trashView;
            refs.restoreBtn.hidden = !trashView;
            refs.purgeBtn.hidden = !trashView;
        } else {
            ['[data-act="pin"]', '[data-act="delete"]'].forEach(function (selector) {
                var btn = li.querySelector(selector);
                if (btn) btn.hidden = trashView;
            });
            ['[data-act="restore"]', '[data-act="purge"]'].forEach(function (selector) {
                var btn = li.querySelector(selector);
                if (btn) btn.hidden = !trashView;
            });
        }
        var body = refs ? refs.body : li.querySelector('.todo-item__body');
        if (body) S.attr(body, 'aria-label', '查看任务：' + task.title);
        var title = refs ? refs.title : li.querySelector('.todo-item__title');
        if (title && title.textContent !== task.title) title.textContent = task.title;

        /* 标签：行级右侧栏；无标签 hidden 不占位 */
        var tagsWrap = refs ? refs.tags : li.querySelector('.todo-item__tags');
        if (tagsWrap) tagsWrap.hidden = task.tags.length === 0;
        var tagSig = task.tags.join('\u0001');
        if (tagsWrap && li.__tagSig !== tagSig) {
            li.__tagSig = tagSig;
            while (tagsWrap.firstChild) tagsWrap.removeChild(tagsWrap.firstChild);
            task.tags.slice(0, 3).forEach(function (tag) {
                tagsWrap.appendChild(S.node('span', 'todo-item__tag', tag));
            });
            if (task.tags.length > 3) tagsWrap.appendChild(S.node('span', 'todo-item__tag', '+' + (task.tags.length - 3)));
        }

        /* 置顶 / 循环标识 */
        var pinMark = refs ? refs.pinMark : li.querySelector('.todo-item__pin');
        if (pinMark) pinMark.hidden = task.pinned !== true;
        var repeatMark = refs ? refs.repeatMark : li.querySelector('.todo-item__repeat');
        if (repeatMark) {
            repeatMark.hidden = !task.recurrence;
            if (task.recurrence) {
                var freqLabel = S.RECURRENCE_LABELS[task.recurrence.freq] || '循环';
                S.attr(repeatMark, 'title', '循环：' + freqLabel);
                S.attr(repeatMark, 'aria-label', '循环任务：' + freqLabel);
            }
        }
        var pinBtn = refs ? refs.pinBtn : li.querySelector('.todo-item__actions [data-act="pin"]');
        if (pinBtn) {
            S.toggleClass(pinBtn, 'is-active', task.pinned === true);
            S.attr(pinBtn, 'aria-label', task.pinned ? '取消置顶' : '置顶任务');
            S.attr(pinBtn, 'title', task.pinned ? '取消置顶（P）' : '置顶（P）');
            S.attr(pinBtn, 'aria-pressed', task.pinned ? 'true' : 'false');
        }

        /* 截止时间 + 优先级 + 清单 */
        var dueEl = refs ? refs.due : li.querySelector('.todo-item__due');
        updateDueLabel(dueEl, task, now);
        var prioText = refs ? refs.prioText : li.querySelector('.todo-item__prio-text');
        if (prioText) {
            prioText.textContent = S.PRIORITY_LABELS[task.priority] || '普通';
            var prioDot = refs ? refs.prioDot : li.querySelector('.todo-prio-dot');
            if (prioDot) S.attr(prioDot, 'data-priority', task.priority);
        }
        var listChip = refs ? refs.listChip : li.querySelector('.todo-item__list');
        if (listChip) {
            var list = S.findList(doc, task.listId);
            var showList = doc.lists.length > 1 && !ui.listId;
            if (list && showList) {
                listChip.hidden = false;
                listChip.textContent = '';
                var listDot = S.node('span', 'todo-prio-dot');
                listDot.style.background = list.color || '#5b8cff';
                listChip.appendChild(listDot);
                listChip.appendChild(S.node('span', null, list.name));
            } else {
                listChip.hidden = true;
            }
        }
        syncEditingState(li, task, ui);
    }

    /**
     * 按「日历天」的到期热区：未完成且有 due。
     * 逾期 → heat-overdue（深红）；今天（同日历日且未逾期）→ heat-3（红）；
     * 明天 → heat-2（橙）；后天 → heat-1（黄）；>=3 个日历日外/完成/取消/无 due/回收站 → 不染色。
     */
    function heatClass(task, now) {
        if (!task || task.deletedAt || task.status !== 'open' || !S.util.isFiniteNum(task.due)) return '';
        var ts = S.util.isFiniteNum(now) ? now : Date.now();
        if (task.due < ts) return 'heat-overdue';
        var today = S.util.startOfDay(ts);
        var dueDay = S.util.startOfDay(task.due);
        var diff = Math.round((dueDay - today) / 86400000);
        if (diff <= 0) return 'heat-3';
        if (diff === 1) return 'heat-2';
        if (diff === 2) return 'heat-1';
        return '';
    }

    /** tick 时同步热区等级（跨 24/48/72h 边界时无需整树重建） */
    function syncHeatClass(li, task, now) {
        if (!li || !li.classList) return;
        var heat = heatClass(task, now);
        if (li.getAttribute('data-heat') === (heat || '')) return;
        li.classList.remove('heat-1', 'heat-2', 'heat-3', 'heat-overdue');
        if (heat) li.classList.add(heat);
        S.attr(li, 'data-heat', heat || '');
    }

    var WEEK_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    /**
     * 记录式 ledger 的左侧时间槽：bucket（今天/明天/周X/日期）+ clock（HH:mm）。
     * 时间语义统一走铜色（.tone-* 控制），不再渲染秒级图标，保持列对齐。
     */
    function updateDueLabel(dueEl, task, now) {
        if (!dueEl) return;
        if (!S.util.isFiniteNum(task.due)) {
            dueEl.hidden = true;
            dueEl.textContent = '';
            return;
        }
        dueEl.hidden = false;
        var meta = S.util.dueMeta(task.due, now);
        var tone = meta.tone === 'overdue' ? 'overdue' : meta.tone;
        var bucket;
        var clock = meta.timeLabel || '';
        var titleLabel = meta.label;

        if (task.status === 'done') {
            /* 完成项：时间槽改为「完成 + 完成时刻」，不再显示逾期语义 */
            tone = 'done';
            bucket = '完成';
            clock = S.util.isFiniteNum(task.completedAt) ? S.util.formatTime(task.completedAt) : (meta.timeLabel || '');
            titleLabel = '完成于 ' + S.util.formatDateTime(task.completedAt || Date.now());
        } else if (task.status === 'canceled') {
            tone = 'none';
            bucket = '取消';
            clock = meta.timeLabel || '';
            titleLabel = '已取消 · 原截止 ' + meta.label;
        } else if (tone === 'overdue') bucket = '逾期';
        else if (tone === 'today') bucket = '今天';
        else if (tone === 'tomorrow') bucket = '明天';
        else if (tone === 'soon') bucket = WEEK_SHORT[new Date(task.due).getDay()];
        else bucket = meta.dateLabel;

        if (!bucket || !clock) {
            dueEl.hidden = true;
            dueEl.textContent = '';
            return;
        }
        dueEl.className = 'todo-item__due tone-' + tone;
        var label = bucket + ' ' + clock;

        if (dueEl.__label !== label) {
            dueEl.__label = label;
            while (dueEl.firstChild) dueEl.removeChild(dueEl.firstChild);
            var bucketEl = document.createElement('span');
            bucketEl.className = 'todo-item__due-bucket';
            bucketEl.textContent = bucket;
            var clockEl = document.createElement('span');
            clockEl.className = 'todo-item__due-clock';
            clockEl.textContent = clock;
            dueEl.appendChild(bucketEl);
            dueEl.appendChild(clockEl);
        }
        S.attr(dueEl, 'title', titleLabel);
        S.attr(dueEl, 'aria-label', (task.status === 'done' ? '完成时间：' : '截止时间：') + label);
    }

    /* ---- 行内编辑 ---- */
    function syncEditingState(li, task, ui) {
        var editing = ui.editingId === task.id;
        var existing = li.__editInput;
        if (editing && !existing) {
            var input = document.createElement('input');
            input.type = 'text';
            input.className = 'nc-input todo-item__edit';
            input.value = task.title;
            S.attr(input, 'aria-label', '编辑任务标题');
            input.maxLength = 500;
            li.appendChild(input);
            li.__editInput = input;
            input.addEventListener('keydown', function (event) {
                if (event.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commitInlineEdit(task.id);
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelInlineEdit(task.id);
                }
            });
            input.addEventListener('blur', function () {
                if (inlineEdit && inlineEdit.id === task.id) commitInlineEdit(task.id);
            });
            inlineEdit = { id: task.id, input: input };
            global.setTimeout(function () {
                input.focus();
                input.select();
            }, 0);
        } else if (!editing && existing) {
            clearInlineEdit(li);
        }
    }

    function beginInlineEdit(id) {
        if (!id) return;
        S.store.startEdit(id);
        var li = S.nodeMap['t:' + id];
        if (li) {
            var input = li.__editInput;
            if (input) {
                input.focus();
                input.select();
            }
        }
    }

    function clearInlineEdit(li) {
        if (!li) return;
        if (li.__editInput) {
            if (li.__editInput.parentNode) li.__editInput.parentNode.removeChild(li.__editInput);
            li.__editInput = null;
        }
        if (inlineEdit && inlineEdit.id === li.getAttribute('data-id')) inlineEdit = null;
    }

    function commitInlineEdit(id) {
        if (!inlineEdit || inlineEdit.id !== id) return;
        var input = inlineEdit.input;
        var value = input.value.trim();
        var task = S.store.getTask(id);
        clearInlineEdit(S.nodeMap['t:' + id]);
        inlineEdit = null;
        if (!task) return;
        if (!value || value === task.title) {
            S.store.stopEdit();
            return;
        }
        S.store.updateTask(id, { title: value }, { label: '编辑标题' });
        S.store.stopEdit();
    }

    function cancelInlineEdit(id) {
        clearInlineEdit(S.nodeMap['t:' + id]);
        inlineEdit = null;
        S.store.stopEdit();
    }

    /* ---- 分组头 ---- */
    function createGroupNode(group) {
        var li = S.node('li', 'todo-group');
        S.attr(li, 'role', 'presentation');
        S.attr(li, 'data-group', group.key);
        if (group.danger) li.classList.add('is-danger');
        return updateGroupNode(li, group);
    }

    function updateGroupNode(li, group) {
        while (li.firstChild) li.removeChild(li.firstChild);
        S.attr(li, 'data-group', group.key);
        S.toggleClass(li, 'is-danger', !!group.danger);
        S.toggleClass(li, 'is-collapsed', group.collapsible && !group.expanded);
        if (group.collapsible) {
            var toggle = S.node('button', 'todo-group__toggle');
            S.attr(toggle, 'type', 'button');
            S.attr(toggle, 'data-act', 'toggle-completed');
            S.attr(toggle, 'aria-expanded', group.expanded ? 'true' : 'false');
            toggle.appendChild(S.icon('chevron-down', 13));
            toggle.appendChild(S.node('span', null, group.label));
            li.appendChild(toggle);
        } else {
            li.appendChild(S.node('span', 'todo-group__label', group.label));
        }
        li.appendChild(S.node('span', 'todo-group__count', String(group.count)));
        li.appendChild(S.node('span', 'todo-group__line'));
        return li;
    }
    NC.view = NC.view || {};
    NC.view.todoRow = {
        init: init,
        renderList: renderList,
        syncHeatClass: syncHeatClass,
        updateDueLabel: updateDueLabel,
        beginInlineEdit: beginInlineEdit
    };
})(window);
