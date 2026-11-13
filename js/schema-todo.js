/**
 * schema-todo.js — Todo 文档 v2 校验 / 归一化 / v1 迁移 / 导入导出（纯函数）
 * 经典脚本，依赖 core.js（NC.util）。挂载：NC.schema.todo
 *
 * 契约（模块说明见 docs/architecture.md）：
 *   主键 ntools.todo.v2，迁移备份 ntools.todo.v1_backup，良好备份 ntools.todo.v2_backup，
 *   v1 旧键 ntools_todo（迁移后只读保留）。
 * 设计原则：
 *   - 任何函数都不 throw（导入脏数据、损坏数据都必须能被"消化"并汇报）；
 *   - 归一化输出永远满足文档形状，后续层无需再做防御性判断；
 *   - 纯函数，不读写 localStorage / DOM，便于 tests.html 单测。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var TOOL_VERSION = '2.0.0';
    var APP_NAME = 'nTools';

    var KEYS = {
        main: 'ntools.todo.v2',
        v1: 'ntools_todo',
        v1Backup: 'ntools.todo.v1_backup',
        backup: 'ntools.todo.v2_backup'
    };

    var LIMITS = {
        tasks: 5000,
        lists: 50,
        title: 500,
        notes: 20000,
        tags: 20,
        tagLength: 32,
        subtasks: 100,
        quarantine: 200,
        importBytes: 5 * 1024 * 1024,
        rawPreview: 400
    };

    var VIEWS = ['all', 'today', 'overdue', 'done'];
    var SORTS = ['smart', 'due', 'created', 'manual'];
    var STATUSES = ['open', 'done', 'canceled'];
    var PRIORITIES = ['low', 'normal', 'high', 'urgent'];
    var RECURRENCE_FREQ = ['daily', 'weekly', 'monthly', 'yearly'];
    var REMINDER_CHANNELS = ['inapp', 'sound', 'title'];
    var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    var COLOR_RE = /^#[0-9a-fA-F]{6}$/;
    var MAX_TS = 4102444800000; /* 2100-01-01 */

    var PRIORITY_WEIGHT = { urgent: 4, high: 3, normal: 2, low: 1 };

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */
    function nowTs() { return Date.now(); }

    function isNum(value) { return util.isFiniteNum(value); }

    function toText(value) {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' && isNum(value)) return String(value);
        return '';
    }

    function trimTo(value, max) {
        var text = toText(value).replace(/\r\n/g, '\n').trim();
        return text.length > max ? text.slice(0, max) : text;
    }

    function toTs(value, fallback) {
        return isNum(value) && value >= 0 && value <= MAX_TS ? Math.round(value) : fallback;
    }

    function toDue(value) {
        return isNum(value) && value > 0 && value <= MAX_TS ? Math.round(value) : null;
    }

    function clip(value, min, max) {
        var n = Math.round(Number(value));
        if (!isFinite(n)) return min;
        return Math.min(max, Math.max(min, n));
    }

    function clone(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (err) {
            return null;
        }
    }

    function newId(prefix) {
        return util.uid(prefix || 't');
    }

    function previewOf(value) {
        var text;
        try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch (err) { text = String(value); }
        if (text == null) return '';
        return text.length > LIMITS.rawPreview ? text.slice(0, LIMITS.rawPreview) + '…' : text;
    }

    function pushQuarantine(ctx, reason, value) {
        if (!ctx || !ctx.quarantine) return;
        if (ctx.quarantine.length >= LIMITS.quarantine) return;
        ctx.quarantine.push({ at: ctx.now, reason: reason, preview: previewOf(value) });
    }

    function pushIssue(issues, code, message, extra) {
        if (!issues) return;
        var entry = { code: code, message: message };
        if (extra) {
            if (extra.index != null) entry.index = extra.index;
            if (extra.field) entry.field = extra.field;
            if (extra.path) entry.path = extra.path;
        }
        issues.push(entry);
    }

    /* ------------------------------------------------------------------ *
     * 默认文档
     * ------------------------------------------------------------------ */
    function defaultList(ts) {
        ts = ts || nowTs();
        return {
            id: 'list_default',
            name: '待办',
            color: '#5b8cff',
            order: 0,
            archived: false,
            createdAt: ts,
            updatedAt: ts
        };
    }

    function defaultSettings() {
        return {
            defaultListId: 'list_default',
            view: 'all',
            sort: 'smart',
            showCompleted: true,
            reminderLeadMinutes: 15,
            compact: false,
            viewMode: 'list'
        };
    }

    function defaultMeta(ts) {
        ts = ts || nowTs();
        return {
            app: APP_NAME,
            appVersion: TOOL_VERSION,
            migratedFrom: null,
            migratedAt: null,
            quarantine: []
        };
    }

    function emptyDoc(ts) {
        ts = ts || nowTs();
        return {
            schemaVersion: 2,
            revision: 0,
            updatedAt: ts,
            lists: [defaultList(ts)],
            tasks: [],
            settings: defaultSettings(),
            meta: defaultMeta(ts)
        };
    }

    /* ------------------------------------------------------------------ *
     * 归一化：list / task / settings / meta / doc
     * ------------------------------------------------------------------ */
    function normalizeList(raw, ctx) {
        if (!util.isPlainObject(raw)) return null;
        var ts = ctx.now;
        var id = typeof raw.id === 'string' ? raw.id.trim() : '';
        if (!ID_RE.test(id) || ctx.listIds[id]) {
            id = util.uid('list');
            pushIssue(ctx.issues, 'list-id-fixed', '清单 ID 缺失或重复，已重新生成', { index: ctx.index });
        }
        var name = trimTo(raw.name, 60);
        if (!name) name = '未命名清单';
        var color = typeof raw.color === 'string' && COLOR_RE.test(raw.color) ? raw.color : '#5b8cff';
        var order = isNum(raw.order) ? raw.order : ctx.index;
        var createdAt = toTs(raw.createdAt, ts);
        return {
            id: id,
            name: name,
            color: color,
            order: order,
            archived: raw.archived === true,
            createdAt: createdAt,
            updatedAt: toTs(raw.updatedAt, createdAt)
        };
    }

    function normalizeTags(raw, issues, index) {
        if (!Array.isArray(raw)) return [];
        var seen = Object.create(null);
        var tags = [];
        raw.forEach(function (tag) {
            if (typeof tag !== 'string') return;
            var text = tag.trim().slice(0, LIMITS.tagLength);
            if (!text || seen[text]) return;
            seen[text] = true;
            tags.push(text);
        });
        if (tags.length > LIMITS.tags) {
            pushIssue(issues, 'tags-truncated', '标签超过 ' + LIMITS.tags + ' 个，已截断', { index: index });
            tags = tags.slice(0, LIMITS.tags);
        }
        return tags;
    }

    function normalizeSubtasks(raw, issues, index) {
        if (!Array.isArray(raw)) return [];
        var subtasks = [];
        raw.slice(0, LIMITS.subtasks).forEach(function (item, i) {
            if (!util.isPlainObject(item)) return;
            var title = trimTo(item.title, 200);
            if (!title) return;
            subtasks.push({
                id: typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : util.uid('st'),
                title: title,
                done: item.done === true,
                order: isNum(item.order) ? item.order : i
            });
        });
        if (raw.length > LIMITS.subtasks) {
            pushIssue(issues, 'subtasks-truncated', '子任务超过 ' + LIMITS.subtasks + ' 个，已截断', { index: index });
        }
        return subtasks;
    }

    function normalizeRecurrence(raw) {
        if (!util.isPlainObject(raw) || RECURRENCE_FREQ.indexOf(raw.freq) === -1) return null;
        var byWeekday = [];
        if (Array.isArray(raw.byWeekday)) {
            var seen = Object.create(null);
            raw.byWeekday.forEach(function (day) {
                var n = Math.round(Number(day));
                if (n >= 0 && n <= 6 && !seen[n]) { seen[n] = true; byWeekday.push(n); }
            });
        }
        return {
            freq: raw.freq,
            interval: clip(isNum(raw.interval) ? raw.interval : 1, 1, 99),
            byWeekday: byWeekday,
            until: toDue(raw.until),
            count: isNum(raw.count) ? clip(raw.count, 1, 1000) : null,
            lastMaterializedAt: toDue(raw.lastMaterializedAt),
            lastCompletedAt: toDue(raw.lastCompletedAt)
        };
    }

    function normalizeReminder(raw) {
        if (!util.isPlainObject(raw)) return null;
        var channels = [];
        if (Array.isArray(raw.channels)) {
            raw.channels.forEach(function (ch) {
                if (REMINDER_CHANNELS.indexOf(ch) > -1 && channels.indexOf(ch) === -1) channels.push(ch);
            });
        }
        if (!channels.length) channels = ['inapp'];
        return {
            leadMinutes: clip(isNum(raw.leadMinutes) ? raw.leadMinutes : 15, 0, 43200),
            firedAt: toDue(raw.firedAt),
            snoozeUntil: toDue(raw.snoozeUntil),
            channels: channels
        };
    }

    /**
     * @returns {object|null} 归一化后的任务；脏到无法救回时返回 null（调用方计入 quarantine）
     */
    function normalizeTask(raw, ctx) {
        if (!util.isPlainObject(raw)) {
            pushQuarantine(ctx, 'not-object', raw);
            pushIssue(ctx.issues, 'task-rejected', '非对象任务项，已隔离', { index: ctx.index });
            return null;
        }
        var now = ctx.now;
        var index = ctx.index;

        var notesRaw = raw.notes != null ? raw.notes : raw.content;
        if (notesRaw != null && typeof notesRaw !== 'string') {
            pushQuarantine(ctx, 'invalid-notes', notesRaw);
        }
        var notes = trimTo(notesRaw, LIMITS.notes);
        var rawTitle = raw.title != null ? raw.title : raw.name;
        if (rawTitle != null && typeof rawTitle !== 'string') {
            pushQuarantine(ctx, 'invalid-title-type', rawTitle);
            pushIssue(ctx.issues, 'title-coerced', '任务标题类型非法，已转为文本', { index: index });
        }
        var title = trimTo(rawTitle, LIMITS.title);
        if (!title && notes) {
            title = notes.split('\n')[0].slice(0, 120);
            pushQuarantine(ctx, 'title-from-notes', notes.slice(0, 120));
            pushIssue(ctx.issues, 'title-from-notes', '任务缺少标题，已用备注首行代替', { index: index });
        }
        if (!title) {
            pushQuarantine(ctx, 'empty-title', raw);
            pushIssue(ctx.issues, 'task-rejected', '任务缺少标题，已跳过', { index: index });
            return null;
        }

        var id = typeof raw.id === 'string' ? raw.id.trim() : (isNum(raw.id) ? String(raw.id) : '');
        if (!ID_RE.test(id) || ctx.ids[id]) {
            id = util.uid('t');
            pushIssue(ctx.issues, 'task-id-fixed', '任务 ID 缺失或重复，已重新生成', { index: index });
        }
        ctx.ids[id] = true;

        var listId = typeof raw.listId === 'string' ? raw.listId.trim() : '';
        if (!ctx.listIds[listId]) {
            if (listId) {
                pushIssue(ctx.issues, 'task-list-fixed', '任务引用的清单不存在，已归入默认清单', { index: index });
            }
            listId = ctx.defaultListId;
        }

        var status = raw.status;
        if (STATUSES.indexOf(status) === -1) {
            if (status === 'completed' || status === 'done') status = 'done';
            else if (raw.completed === true) status = 'done';
            else status = 'open';
        }

        var priority = PRIORITIES.indexOf(raw.priority) > -1 ? raw.priority : 'normal';
        if (raw.due != null && toDue(raw.due) == null) {
            pushQuarantine(ctx, 'invalid-due', raw.due);
            pushIssue(ctx.issues, 'due-dropped', '截止时间非法，已置空', { index: index });
        }
        var due = toDue(raw.due);
        var createdAt = toTs(raw.createdAt, now);
        var updatedAt = toTs(raw.updatedAt, createdAt);
        var completedAt = toTs(raw.completedAt, null);
        if (status === 'done' && completedAt == null) completedAt = null;
        if (status !== 'done') completedAt = null;

        return {
            id: id,
            listId: listId,
            title: title,
            notes: notes,
            status: status,
            priority: priority,
            pinned: raw.pinned === true,
            due: due,
            dueAllDay: raw.dueAllDay === true && due != null,
            tags: normalizeTags(raw.tags, ctx.issues, index),
            subtasks: normalizeSubtasks(raw.subtasks, ctx.issues, index),
            recurrence: normalizeRecurrence(raw.recurrence),
            reminder: normalizeReminder(raw.reminder),
            order: isNum(raw.order) ? raw.order : index * 1024,
            createdAt: createdAt,
            updatedAt: updatedAt,
            completedAt: completedAt,
            deletedAt: toTs(raw.deletedAt, null),
            source: trimTo(raw.source, 64) || 'manual'
        };
    }

    function normalizeSettings(raw, ctx) {
        var src = util.isPlainObject(raw) ? raw : {};
        var defaultListId = typeof src.defaultListId === 'string' && ctx.listIds[src.defaultListId]
            ? src.defaultListId : ctx.defaultListId;
        return {
            defaultListId: defaultListId,
            view: VIEWS.indexOf(src.view) > -1 ? src.view : 'all',
            sort: SORTS.indexOf(src.sort) > -1 ? src.sort : 'smart',
            showCompleted: src.showCompleted !== false,
            reminderLeadMinutes: clip(isNum(src.reminderLeadMinutes) ? src.reminderLeadMinutes : 15, 0, 43200),
            compact: src.compact === true,
            viewMode: src.viewMode === 'timeline' ? 'timeline' : 'list'
        };
    }

    function normalizeMeta(raw, ts, issues) {
        var src = util.isPlainObject(raw) ? raw : {};
        var quarantine = [];
        if (Array.isArray(src.quarantine)) {
            src.quarantine.slice(0, LIMITS.quarantine).forEach(function (item) {
                if (!util.isPlainObject(item)) return;
                quarantine.push({
                    at: toTs(item.at, ts),
                    reason: trimTo(item.reason, 200) || 'unknown',
                    preview: trimTo(item.preview, 400)
                });
            });
        }
        return {
            app: trimTo(src.app, 32) || APP_NAME,
            appVersion: trimTo(src.appVersion, 32) || TOOL_VERSION,
            migratedFrom: typeof src.migratedFrom === 'string' ? src.migratedFrom.slice(0, 32) : null,
            migratedAt: toTs(src.migratedAt, null),
            quarantine: quarantine
        };
    }

    /**
     * 归一化整个文档。永远返回 {doc, issues}，不 throw。
     * @param {*} raw
     * @param {{now?:number, source?:string}} [options]
     */
    function normalizeDoc(raw, options) {
        var opts = options || {};
        var ts = isNum(opts.now) ? opts.now : nowTs();
        var issues = [];
        var src = util.isPlainObject(raw) ? raw : {};
        var ctx = {
            now: ts,
            issues: issues,
            quarantine: [],
            ids: Object.create(null),
            listIds: Object.create(null),
            defaultListId: 'list_default'
        };

        /* 1. 清单 */
        var rawLists = Array.isArray(src.lists) ? src.lists : [];
        var lists = [];
        rawLists.slice(0, LIMITS.lists).forEach(function (item, index) {
            ctx.index = index;
            var list = normalizeList(item, ctx);
            if (!list) return;
            if (ctx.listIds[list.id]) {
                list.id = util.uid('list');
                pushIssue(issues, 'list-id-fixed', '清单 ID 重复，已重新生成', { index: index });
            }
            ctx.listIds[list.id] = true;
            lists.push(list);
        });
        if (!lists.length) lists.push(defaultList(ts));
        /* 默认清单必须存在（契约：默认清单 id 固定 list_default） */
        if (!lists.filter(function (l) { return l.id === 'list_default'; })[0]) {
            lists.unshift(defaultList(ts));
        }
        ctx.listIds.list_default = true;
        ctx.defaultListId = 'list_default';

        /* 2. 任务 */
        var rawTasks = Array.isArray(src.tasks) ? src.tasks : (Array.isArray(src.data) ? src.data : []);
        if (rawTasks.length > LIMITS.tasks) {
            pushIssue(issues, 'tasks-truncated', '任务超过 ' + LIMITS.tasks + ' 条，已截断', { index: LIMITS.tasks });
        }
        var tasks = [];
        rawTasks.slice(0, LIMITS.tasks).forEach(function (item, index) {
            ctx.index = index;
            var task = normalizeTask(item, ctx);
            if (task) tasks.push(task);
        });

        /* 3. order 规整：每个清单内按 order/createdAt 重新编号，保证手动排序稳定 */
        var grouped = Object.create(null);
        tasks.forEach(function (task) {
            if (!grouped[task.listId]) grouped[task.listId] = [];
            grouped[task.listId].push(task);
        });
        Object.keys(grouped).forEach(function (listId) {
            grouped[listId].sort(function (a, b) {
                if (a.order !== b.order) return a.order - b.order;
                return a.createdAt - b.createdAt;
            }).forEach(function (task, i) {
                task.order = i * 1024;
            });
        });

        /* 4. 设置 / meta / 版本（脏数据隔离记录合并进 meta.quarantine） */
        var settings = normalizeSettings(src.settings, ctx);
        var meta = normalizeMeta(src.meta, ts, issues);
        if (ctx.quarantine.length) {
            meta.quarantine = meta.quarantine.concat(ctx.quarantine).slice(0, LIMITS.quarantine);
        }
        var revision = isNum(src.revision) && src.revision >= 0 ? Math.round(src.revision) : 0;

        var doc = {
            schemaVersion: 2,
            revision: revision,
            updatedAt: toTs(src.updatedAt, ts),
            lists: lists,
            tasks: tasks,
            settings: settings,
            meta: meta
        };
        return { doc: doc, issues: issues };
    }

    /* ------------------------------------------------------------------ *
     * 结构校验（返回错误列表，不修改数据；用于 tests / 导入诊断）
     * ------------------------------------------------------------------ */
    function validate(doc) {
        var errors = [];
        function err(path, message) { errors.push({ path: path, message: message }); }

        if (!util.isPlainObject(doc)) { err('$', '文档必须是对象'); return { ok: false, errors: errors }; }
        if (doc.schemaVersion !== 2) err('$.schemaVersion', 'schemaVersion 必须为 2');
        if (!isNum(doc.revision) || doc.revision < 0) err('$.revision', 'revision 必须为非负数字');
        if (!isNum(doc.updatedAt)) err('$.updatedAt', 'updatedAt 必须为数字');
        if (!Array.isArray(doc.lists) || !doc.lists.length) err('$.lists', 'lists 必须为非空数组');
        if (!Array.isArray(doc.tasks)) err('$.tasks', 'tasks 必须为数组');

        var listIds = Object.create(null);
        (Array.isArray(doc.lists) ? doc.lists : []).forEach(function (list, i) {
            if (!util.isPlainObject(list)) { err('$.lists[' + i + ']', '清单必须是对象'); return; }
            if (typeof list.id !== 'string' || !ID_RE.test(list.id)) err('$.lists[' + i + '].id', '清单 id 非法');
            if (!list.name || typeof list.name !== 'string') err('$.lists[' + i + '].name', '清单 name 非法');
            listIds[list.id] = true;
        });
        if (!listIds.list_default) err('$.lists', '缺少默认清单 list_default');

        var taskIds = Object.create(null);
        (Array.isArray(doc.tasks) ? doc.tasks : []).forEach(function (task, i) {
            var base = '$.tasks[' + i + ']';
            if (!util.isPlainObject(task)) { err(base, '任务必须是对象'); return; }
            if (typeof task.id !== 'string' || !ID_RE.test(task.id)) err(base + '.id', 'id 非法');
            if (taskIds[task.id]) err(base + '.id', 'id 重复');
            taskIds[task.id] = true;
            if (!listIds[task.listId]) err(base + '.listId', 'listId 引用不存在的清单');
            if (typeof task.title !== 'string' || !task.title.trim()) err(base + '.title', 'title 不能为空');
            if (STATUSES.indexOf(task.status) === -1) err(base + '.status', 'status 非法');
            if (PRIORITIES.indexOf(task.priority) === -1) err(base + '.priority', 'priority 非法');
            if (!(task.due == null || isNum(task.due))) err(base + '.due', 'due 必须为数字或 null');
            if (task.pinned != null && typeof task.pinned !== 'boolean') err(base + '.pinned', 'pinned 必须为布尔');
            if (!Array.isArray(task.tags)) err(base + '.tags', 'tags 必须为数组');
            if (!Array.isArray(task.subtasks)) err(base + '.subtasks', 'subtasks 必须为数组');
            if (!isNum(task.createdAt) || !isNum(task.updatedAt)) err(base + '.updatedAt', '时间戳非法');
        });

        var settings = doc.settings;
        if (!util.isPlainObject(settings)) err('$.settings', 'settings 必须为对象');
        else {
            if (VIEWS.indexOf(settings.view) === -1) err('$.settings.view', 'view 非法');
            if (SORTS.indexOf(settings.sort) === -1) err('$.settings.sort', 'sort 非法');
            if (settings.viewMode != null && settings.viewMode !== 'list' && settings.viewMode !== 'timeline') err('$.settings.viewMode', 'viewMode 非法');
            if (!listIds[settings.defaultListId]) err('$.settings.defaultListId', 'defaultListId 引用不存在的清单');
        }
        return { ok: errors.length === 0, errors: errors };
    }

    /* ------------------------------------------------------------------ *
     * v1 迁移：数组 → v2 文档（幂等、脏数据进 quarantine）
     * ------------------------------------------------------------------ */
    function migrateV1(rawItems, now) {
        var ts = isNum(now) ? now : nowTs();
        var items = Array.isArray(rawItems) ? rawItems : (Array.isArray(rawItems && rawItems.data) ? rawItems.data : []);
        var quarantine = [];
        var issues = [];
        var staged = [];
        var usedIds = Object.create(null);

        if (items.length > LIMITS.tasks) {
            pushIssue(issues, 'tasks-truncated', 'v1 任务超过 ' + LIMITS.tasks + ' 条，已截断');
        }

        items.slice(0, LIMITS.tasks).forEach(function (item, index) {
            if (!util.isPlainObject(item)) {
                quarantine.push({ at: ts, reason: 'not-object', preview: previewOf(item) });
                return;
            }
            var notes = typeof item.content === 'string' ? item.content : '';
            if (item.content != null && typeof item.content !== 'string') {
                quarantine.push({ at: ts, reason: 'invalid-notes', preview: previewOf(item.content) });
            }
            if (item.title != null && typeof item.title !== 'string') {
                quarantine.push({ at: ts, reason: 'invalid-title-type', preview: previewOf(item.title) });
            }
            if (item.due != null && toDue(item.due) == null) {
                quarantine.push({ at: ts, reason: 'invalid-due', preview: previewOf(item.due) });
            }
            var title = '';
            if (typeof item.title === 'string') title = item.title.trim();
            else if (typeof item.title === 'number' && isFinite(item.title)) title = String(item.title);
            if (!title && !notes.trim()) {
                quarantine.push({ at: ts, reason: 'empty-title', preview: previewOf(item) });
                return;
            }
            if (!title) {
                title = notes.trim().split('\n')[0].slice(0, 120);
                pushIssue(issues, 'title-from-notes', 'v1 任务缺少标题，已用内容首行代替', { index: index });
            }

            var rawId = item.id != null ? String(item.id) : ('idx' + index);
            var safeId = rawId.replace(/[^A-Za-z0-9_-]/g, '');
            if (!safeId) safeId = 'idx' + index;
            var id = 'v1-' + safeId;
            if (usedIds[id]) id = id + '-' + index;
            usedIds[id] = true;

            var completed = item.completed === true;
            staged.push({
                id: id,
                listId: 'list_default',
                title: title,
                notes: notes,
                status: completed ? 'done' : 'open',
                priority: 'normal',
                pinned: false,
                due: toDue(item.due),
                dueAllDay: false,
                tags: [],
                subtasks: [],
                recurrence: null,
                reminder: null,
                order: index * 1024,
                createdAt: ts,
                updatedAt: ts,
                completedAt: null,
                deletedAt: null,
                source: 'migrated_v1'
            });
            if (toDue(item.due) == null && item.due != null) {
                pushIssue(issues, 'due-dropped', 'v1 任务截止时间非法，已置空', { index: index });
            }
        });

        var normalized = normalizeDoc({
            schemaVersion: 2,
            revision: 1,
            updatedAt: ts,
            lists: [defaultList(ts)],
            tasks: staged,
            settings: defaultSettings(),
            meta: {
                app: APP_NAME,
                appVersion: TOOL_VERSION,
                migratedFrom: 'v1',
                migratedAt: ts,
                quarantine: []
            }
        }, { now: ts });

        normalized.doc.meta.migratedFrom = 'v1';
        normalized.doc.meta.migratedAt = ts;
        normalized.doc.meta.quarantine = normalized.doc.meta.quarantine
            .concat(quarantine)
            .slice(0, LIMITS.quarantine);

        return {
            doc: normalized.doc,
            issues: issues.concat(normalized.issues),
            stats: {
                migrated: normalized.doc.tasks.length,
                quarantined: quarantine.length,
                total: items.length
            }
        };
    }

    /* ------------------------------------------------------------------ *
     * 导入解析：识别 v2 文档 / v1 数组 / 任务数组 / {data:[...]}
     * ------------------------------------------------------------------ */
    function detectArrayFormat(items) {
        if (!items.length) return 'empty';
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!util.isPlainObject(item)) continue;
            if (item.status != null || item.listId != null || item.priority != null ||
                item.createdAt != null || item.completedAt != null) {
                return 'tasks-array';
            }
            return 'v1-array';
        }
        return 'v1-array';
    }

    /**
     * @param {string} text 文件内容（JSON 字符串）
     * @returns {{ok:boolean, error?:string, doc?:object, format?:string, stats?:object, issues?:Array}}
     */
    function parseImport(text) {
        if (typeof text !== 'string') {
            return { ok: false, error: '文件内容无法读取' };
        }
        if (text.length > LIMITS.importBytes) {
            return { ok: false, error: '文件过大（上限 ' + Math.round(LIMITS.importBytes / 1024 / 1024) + ' MB）' };
        }
        var parsed = util.parseJSON(text, undefined);
        if (parsed === undefined) {
            return { ok: false, error: '不是有效的 JSON 文件' };
        }

        var format;
        var items = [];
        var rawDoc = null;

        if (Array.isArray(parsed)) {
            format = detectArrayFormat(parsed);
            items = parsed;
        } else if (util.isPlainObject(parsed)) {
            if (Array.isArray(parsed.tasks)) {
                format = 'v2-doc';
                rawDoc = parsed;
            } else if (Array.isArray(parsed.data)) {
                format = 'legacy-data';
                items = parsed.data;
            } else {
                return { ok: false, error: '未识别的备份格式（缺少 tasks 或 data 数组）' };
            }
        } else {
            return { ok: false, error: '未识别的备份格式' };
        }

        var normalized;
        var issues = [];
        var formatStats = {};
        if (rawDoc) {
            normalized = normalizeDoc(rawDoc);
            issues = normalized.issues;
            formatStats = { total: rawDoc.tasks.length, migrated: normalized.doc.tasks.length };
        } else if (format === 'tasks-array') {
            normalized = normalizeDoc({
                schemaVersion: 2,
                revision: 1,
                updatedAt: nowTs(),
                lists: [defaultList()],
                tasks: items,
                settings: defaultSettings()
            });
            issues = normalized.issues;
            formatStats = { total: items.length, migrated: normalized.doc.tasks.length };
        } else {
            var migrated = migrateV1(items);
            normalized = { doc: migrated.doc, issues: migrated.issues };
            formatStats = { total: items.length, migrated: migrated.doc.tasks.length, quarantined: migrated.stats.quarantined };
        }

        var valid = normalized.doc.tasks.length;
        var total = formatStats.total || 0;
        return {
            ok: true,
            doc: normalized.doc,
            format: format,
            issues: issues,
            stats: {
                total: total,
                valid: valid,
                rejected: Math.max(0, total - valid),
                lists: normalized.doc.lists.length,
                quarantined: normalized.doc.meta.quarantine.length
            }
        };
    }

    /* ------------------------------------------------------------------ *
     * 循环任务：推进下一次到期（纯函数，便于测试）
     * daily / weekly：按天/周推进；monthly / yearly：月末、闰年夹取。
     * 若算出的时间 <= now，继续前移直到未来（上限 1000 次防御）。
     * @returns {number|null} 下一次到期 epoch ms；无循环/超过 until 时返回 null
     * ------------------------------------------------------------------ */
    function advanceRecurrenceOnce(ts, recurrence) {
        var date = new Date(ts);
        var interval = isNum(recurrence.interval) ? clip(recurrence.interval, 1, 99) : 1;
        if (recurrence.freq === 'daily') {
            date.setDate(date.getDate() + interval);
            return date.getTime();
        }
        if (recurrence.freq === 'weekly') {
            date.setDate(date.getDate() + 7 * interval);
            return date.getTime();
        }
        if (recurrence.freq === 'monthly') {
            var day = date.getDate();
            date.setDate(1);
            date.setMonth(date.getMonth() + interval);
            var monthDays = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
            date.setDate(Math.min(day, monthDays));
            return date.getTime();
        }
        if (recurrence.freq === 'yearly') {
            var dayY = date.getDate();
            date.setDate(1);
            date.setFullYear(date.getFullYear() + interval);
            var yearDays = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
            date.setDate(Math.min(dayY, yearDays));
            return date.getTime();
        }
        return null;
    }

    function nextRecurrenceDue(recurrence, baseDue, now) {
        if (!util.isPlainObject(recurrence) || RECURRENCE_FREQ.indexOf(recurrence.freq) === -1) return null;
        var nowTs = isNum(now) ? now : nowTsDefault();
        var base = isNum(baseDue) ? baseDue : nowTs;
        var until = isNum(recurrence.until) ? recurrence.until : null;
        var next = advanceRecurrenceOnce(base, recurrence);
        var guard = 0;
        while (next != null && next <= nowTs && guard < 1000) {
            next = advanceRecurrenceOnce(next, recurrence);
            guard++;
        }
        if (next == null) return null;
        if (until != null && next > until) return null;
        return next;
    }

    function nowTsDefault() { return Date.now(); }

    /* ------------------------------------------------------------------ *
     * 合并：以当前为底，把导入文档并入（id 相同取 updatedAt 新者）
     * ------------------------------------------------------------------ */
    function mergeDocs(current, incoming, now) {
        var ts = isNum(now) ? now : nowTs();
        var base = normalizeDoc(current, { now: ts });
        var doc = clone(base.doc) || emptyDoc(ts);
        var inc = normalizeDoc(incoming, { now: ts }).doc;

        var listIndex = Object.create(null);
        doc.lists.forEach(function (list) { listIndex[list.id] = list; });
        inc.lists.forEach(function (list) {
            var existing = listIndex[list.id];
            if (!existing) {
                doc.lists.push(list);
                listIndex[list.id] = list;
            } else if (list.updatedAt > existing.updatedAt) {
                existing.name = list.name;
                existing.color = list.color;
                existing.archived = list.archived;
                existing.updatedAt = list.updatedAt;
            }
        });

        var taskIndex = Object.create(null);
        doc.tasks.forEach(function (task) { taskIndex[task.id] = task; });
        var added = 0;
        var updated = 0;
        inc.tasks.forEach(function (task) {
            var existing = taskIndex[task.id];
            if (!existing) {
                doc.tasks.push(task);
                taskIndex[task.id] = task;
                added++;
            } else if ((task.updatedAt || 0) >= (existing.updatedAt || 0)) {
                var pos = doc.tasks.indexOf(existing);
                if (pos > -1) doc.tasks[pos] = task;
                taskIndex[task.id] = task;
                updated++;
            }
        });

        var merged = normalizeDoc(doc, { now: ts });
        merged.doc.meta.quarantine = merged.doc.meta.quarantine
            .concat(inc.meta.quarantine)
            .slice(0, LIMITS.quarantine);
        merged.doc.revision = isNum(current && current.revision) ? current.revision : merged.doc.revision;
        merged.doc.settings = clone(base.doc.settings) || merged.doc.settings;
        return {
            doc: merged.doc,
            stats: { added: added, updated: updated, kept: doc.tasks.length - added - updated }
        };
    }

    /* ------------------------------------------------------------------ *
     * 导出
     * ------------------------------------------------------------------ */
    function exportDoc(doc, ts) {
        var normalized = normalizeDoc(doc, { now: isNum(ts) ? ts : nowTs() }).doc;
        return {
            schemaVersion: 2,
            app: APP_NAME,
            appVersion: TOOL_VERSION,
            exportedAt: isNum(ts) ? ts : nowTs(),
            lists: normalized.lists,
            tasks: normalized.tasks,
            settings: normalized.settings
        };
    }

    function exportJSON(doc, ts) {
        return JSON.stringify(exportDoc(doc, ts), null, 2);
    }

    /* ------------------------------------------------------------------ *
     * 选择器辅助（视图/提醒共用，保持纯函数）
     * ------------------------------------------------------------------ */
    function isActive(task) {
        return !!task && !task.deletedAt;
    }

    function isOpen(task) {
        return isActive(task) && task.status === 'open';
    }

    function isDone(task) {
        return isActive(task) && task.status === 'done';
    }

    function isFiniteDue(task) {
        return !!task && isNum(task.due);
    }

    function isOverdue(task, now) {
        if (!isOpen(task) || !isFiniteDue(task)) return false;
        return task.due < (isNum(now) ? now : nowTs());
    }

    function isToday(task, now) {
        if (!isActive(task) || !isFiniteDue(task)) return false;
        var ts = isNum(now) ? now : nowTs();
        return task.due >= util.startOfDay(ts) && task.due <= util.endOfDay(ts);
    }

    /**
     * 智能分组用的时间桶（已完成/删除任务由调用方处理）。
     * @returns {'overdue'|'today'|'tomorrow'|'later'|'none'}
     */
    function timeBucket(task, now) {
        var ts = isNum(now) ? now : nowTs();
        if (!isFiniteDue(task)) return 'none';
        if (task.due < ts) return 'overdue';
        if (task.due <= util.endOfDay(ts)) return 'today';
        if (util.dayDiff(ts, task.due) === 1) return 'tomorrow';
        return 'later';
    }

    function priorityWeight(priority) {
        return PRIORITY_WEIGHT[priority] || 2;
    }

    function docCounts(doc, now) {
        var ts = isNum(now) ? now : nowTs();
        var todayStart = util.startOfDay(ts);
        var todayEnd = util.endOfDay(ts);
        var weekStart = todayStart - ((new Date(todayStart).getDay() + 6) % 7) * 86400000;
        var counts = {
            open: 0, done: 0, canceled: 0, overdue: 0, today: 0, trash: 0,
            completedToday: 0, completedWeek: 0, byList: {}, total: 0
        };
        (doc && doc.tasks || []).forEach(function (task) {
            counts.total++;
            if (task.deletedAt) {
                counts.trash++;
                return;
            }
            counts.byList[task.listId] = counts.byList[task.listId] || { open: 0, total: 0 };
            counts.byList[task.listId].total++;
            if (task.status === 'done') {
                counts.done++;
                if (isNum(task.completedAt)) {
                    if (task.completedAt >= todayStart && task.completedAt <= todayEnd) counts.completedToday++;
                    if (task.completedAt >= weekStart) counts.completedWeek++;
                }
                return;
            }
            if (task.status === 'canceled') { counts.canceled++; return; }
            counts.open++;
            counts.byList[task.listId].open++;
            if (isFiniteDue(task)) {
                if (task.due < ts) counts.overdue++;
                if (task.due >= todayStart && task.due <= todayEnd) counts.today++;
            }
        });
        return counts;
    }

    /* ------------------------------------------------------------------ *
     * 导出 API
     * ------------------------------------------------------------------ */
    NC.schema = NC.schema || {};
    NC.schema.todo = {
        KEYS: KEYS,
        LIMITS: LIMITS,
        VIEWS: VIEWS,
        SORTS: SORTS,
        STATUSES: STATUSES,
        PRIORITIES: PRIORITIES,
        appVersion: TOOL_VERSION,
        defaultList: defaultList,
        defaultSettings: defaultSettings,
        emptyDoc: emptyDoc,
        newId: newId,
        normalizeDoc: normalizeDoc,
        normalizeTask: normalizeTask,
        validate: validate,
        migrateV1: migrateV1,
        parseImport: parseImport,
        mergeDocs: mergeDocs,
        exportDoc: exportDoc,
        exportJSON: exportJSON,
        clone: clone,
        previewOf: previewOf,
        isActive: isActive,
        isOpen: isOpen,
        isDone: isDone,
        isFiniteDue: isFiniteDue,
        isOverdue: isOverdue,
        isToday: isToday,
        timeBucket: timeBucket,
        nextRecurrenceDue: nextRecurrenceDue,
        advanceRecurrenceOnce: advanceRecurrenceOnce,
        priorityWeight: priorityWeight,
        docCounts: docCounts
    };
})(window);
