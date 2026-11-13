/**
 * todo.js — Todo 功能入口：提醒 ticker / 导入导出管道 / 快捷键 / 示例数据 / 标题角标 / AI 识别填充
 * 经典脚本，依赖 core / storage / ui / schema-todo / todo-store / todo-view。挂载：NC.tools.todo
 *
 * 说明：
 *   - 导入管道：读取文件 → schema.parseImport（形状识别/校验/归一）→ 预览（合法 n/拒收 m）
 *     → 合并 or 替换 → store 自动备份当前文档 → 落盘 → Toast（可撤销）；
 *   - 提醒：file:// 下 Notification 不可用，采用页内 Toast + 标题角标 + 逾期计数；
 *     ticker 对齐分钟边界，document.hidden 时暂停；
 *   - 快捷键：N / / / ? / ↑↓ / Space / Enter / E / Delete / Esc / Ctrl+Z / Ctrl+Shift+Z。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var ui = NC.ui;
    var icons = NC.icons;
    var storage = NC.storage;
    var schema = NC.schema.todo;
    var store = NC.store.todo;
    var view = NC.view.todo;

    var fileInput = null;
    var tickTimer = null;
    var sessionStart = Date.now();
    var fired = Object.create(null);
    var demoMode = false;
    var summaryShown = false;
    var errorToastAt = 0;

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function init() {
        fileInput = document.getElementById('todo-import-file');
        var params = parseQuery();
        demoMode = params.demo === '1';

        if (demoMode) {
            store.init({ demoDoc: buildDemoDoc(), demo: true });
        } else {
            store.init();
        }

        view.init({
            exportJson: exportJson,
            importJson: importJson,
            restoreBackup: restoreBackup,
            clearTrash: clearTrash,
            clearAll: clearAll,
            demo: loadDemo,
            help: openHelp,
            openAi: openAiDialog,
            setMode: setMode
        });
        view.setActions({
            exportJson: exportJson,
            importJson: importJson,
            restoreBackup: restoreBackup,
            clearTrash: clearTrash,
            clearAll: clearAll,
            demo: loadDemo,
            help: openHelp,
            openAi: openAiDialog,
            setMode: setMode
        });

        wireFileInput();
        wireEvents();
        initAiIntegration();
        updateChrome();
        fireOverdueSummary();
        if (demoMode) selectDemoTask();

        tick();
        scheduleTick();
        return true;
    }

    function parseQuery() {
        var result = { demo: null, theme: null, lite: null };
        try {
            var search = global.location.search || '';
            search.replace(/^\?/, '').split('&').forEach(function (pair) {
                if (!pair) return;
                var index = pair.indexOf('=');
                var key = decodeURIComponent(index > -1 ? pair.slice(0, index) : pair);
                var value = decodeURIComponent(index > -1 ? pair.slice(index + 1) : '1');
                result[key] = value;
            });
        } catch (err) { /* ignore */ }
        return result;
    }

    function wireEvents() {
        NC.events.on('todo:error', function (payload) {
            var now = Date.now();
            if (now - errorToastAt < 4000) return;
            errorToastAt = now;
            ui.toast((payload && payload.message) || '本地存储异常，修改可能无法保存', {
                type: 'error',
                duration: 5200,
                action: { label: '导出备份', onClick: exportJson }
            });
        });
        NC.events.on('storage:error', function () {
            /* 由 ntools-app 的常驻横幅负责，这里不重复提示 */
        });
        store.subscribe(function () {
            updateChrome();
        });
        NC.events.on('todo:recurred', function (payload) {
            if (!payload || !util.isFiniteNum(payload.nextDue)) return;
            ui.toast('循环任务已完成，下次到期 ' + util.formatDateTime(payload.nextDue), {
                type: 'success',
                duration: 4200
            });
        });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) tick();
            scheduleTick();
        });
        document.addEventListener('keydown', onGlobalKeydown);
    }

    /* ------------------------------------------------------------------ *
     * v3：AI 识别 + 快捷时间（入口与草稿填充）
     * ------------------------------------------------------------------ */
    function initAiIntegration() {
        refreshQuickDue();
        NC.events.on('llm:changed', function (payload) {
            if (payload && (payload.reason === 'work-end-time' || payload.reason === 'todo-ai')) {
                refreshQuickDue();
            }
        });
        NC.events.on('llm:profile-selected', function () {
            refreshQuickDue();
        });
    }

    function refreshQuickDue() {
        try {
            if (view && typeof view.refreshQuickDue === 'function') view.refreshQuickDue();
        } catch (err) { /* 快捷时间刷新失败不影响主流程 */ }
    }

    /**
     * 切换列表 / 全景模式（持久化到 todo settings.viewMode）。
     * @param {'list'|'timeline'} mode
     */
    function setMode(mode) {
        if (mode !== 'list' && mode !== 'timeline') return false;
        if (view && typeof view.setMode === 'function') return !!view.setMode(mode);
        store.updateSettings({ viewMode: mode });
        return true;
    }

    /**
     * 打开发 AI 识别弹窗。
     * @param {string} [prefill]
     * @returns {Object|null} ui.openModal 实例
     */
    function openAiDialog(prefill) {
        if (NC.todoAi && typeof NC.todoAi.openDialog === 'function') {
            return NC.todoAi.openDialog(prefill || '');
        }
        ui.toast('AI 识别模块未加载（js/todo-ai.js），请刷新页面重试', { type: 'warn' });
        return null;
    }

    /**
     * 用识别结果填充创建区（绝不自动创建；重复周期由 todo-view.applyDraft 按白名单填入）。
     * @param {{title,notes,due,dueAllDay,priority,tags,listName,recurrence}} data
     * @returns {boolean}
     */
    function fillDraft(data) {
        if (!data || typeof data !== 'object') return false;
        var filled = false;
        try {
            filled = !!(view && typeof view.applyDraft === 'function' && view.applyDraft(data));
        } catch (err) {
            filled = false;
        }
        if (!filled) {
            ui.toast('识别完成但无法填充表单，请重试或手动创建', { type: 'error' });
            return false;
        }
        ui.toast('已识别，请确认后创建', { type: 'success', duration: 4200 });
        NC.events.emit('todo:ai-filled', { data: data });
        return true;
    }

    function quickDueOptions(now) {
        if (NC.todoTime && typeof NC.todoTime.quickDueOptions === 'function') {
            return NC.todoTime.quickDueOptions(now);
        }
        return [];
    }

    /* ------------------------------------------------------------------ *
     * 标题角标 / 逾期计数
     * ------------------------------------------------------------------ */
    function updateChrome() {
        var counts = store.counts();
        var overdue = counts.overdue || 0;
        var title = overdue > 0 ? '(' + overdue + ') nTools · 待办' : 'nTools · 工具箱';
        if (document.title !== title) document.title = title;
        var badge = document.getElementById('nav-todo-badge');
        if (badge) {
            if (overdue > 0) {
                badge.hidden = false;
                badge.textContent = String(overdue);
                badge.classList.add('is-danger');
                badge.setAttribute('title', overdue + ' 项任务已逾期');
            } else {
                badge.hidden = true;
                badge.classList.remove('is-danger');
                badge.removeAttribute('title');
            }
        }
    }

    /* ------------------------------------------------------------------ *
     * 提醒 ticker（页内 Toast / 标题角标 / 逾期计数）
     * ------------------------------------------------------------------ */
    function scheduleTick() {
        if (tickTimer) global.clearTimeout(tickTimer);
        var now = Date.now();
        var wait = 60000 - (now % 60000) + 120; /* 对齐分钟边界 */
        tickTimer = global.setTimeout(function () {
            tickTimer = null;
            if (!document.hidden) tick();
            scheduleTick();
        }, wait);
    }

    function tick() {
        updateChrome();
        if (view && view.refreshTimes) view.refreshTimes();
        fireDueReminders();
    }

    function fireDueReminders() {
        if (demoMode) return;
        var now = Date.now();
        var tasks = store.getDoc().tasks;
        var due = [];
        tasks.forEach(function (task) {
            if (!schema.isOpen(task) || !util.isFiniteNum(task.due)) return;
            if (fired[task.id]) return;
            if (task.due > now) return;
            /* 仅提示本次会话打开后才到期的任务，避免开页刷屏 */
            if (task.due < sessionStart - 60000) return;
            fired[task.id] = true;
            due.push(task);
        });
        if (!due.length) return;
        var first = due[0];
        ui.toast(due.length === 1
            ? '任务到期：「' + first.title + '」'
            : '有 ' + due.length + ' 项任务已到期', {
            type: 'warn',
            duration: 6000,
            action: {
                label: '查看逾期',
                onClick: function () { store.setView('overdue'); }
            }
        });
    }

    function fireOverdueSummary() {
        if (demoMode || summaryShown) return;
        summaryShown = true;
        var counts = store.counts(true);
        if (!counts.overdue) return;
        global.setTimeout(function () {
            ui.toast('有 ' + counts.overdue + ' 项任务已逾期', {
                type: 'warn',
                duration: 5200,
                action: {
                    label: '查看',
                    onClick: function () { store.setView('overdue'); }
                }
            });
        }, 700);
    }

    function selectDemoTask() {
        /* 桌面宽屏才默认选中（详情面板常驻），移动端保持列表可见 */
        if (global.innerWidth <= 1100) return;
        var tasks = store.selectVisible().tasks;
        if (!tasks.length) return;
        var now = Date.now();
        var target = null;
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].status === 'open' && util.isFiniteNum(tasks[i].due) && tasks[i].due >= now) {
                target = tasks[i];
                break;
            }
        }
        if (!target) target = tasks[0];
        if (target) store.selectTask(target.id);
    }

    /* ------------------------------------------------------------------ *
     * 键盘快捷键
     * ------------------------------------------------------------------ */
    function isEditableTarget(target) {
        if (!target) return false;
        var tag = (target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        return !!target.isContentEditable;
    }

    function isTodoActive() {
        var page = document.getElementById('page-todo');
        return !!(page && page.classList.contains('is-active'));
    }

    function onGlobalKeydown(event) {
        var target = event.target;
        var editable = isEditableTarget(target);
        var ctrl = event.ctrlKey || event.metaKey;
        var key = event.key;

        if (ctrl && !event.altKey && (key === 'z' || key === 'Z')) {
            if (editable) return;
            if (!isTodoActive()) return;
            event.preventDefault();
            if (event.shiftKey) view.redoWithToast();
            else view.undoWithToast();
            return;
        }
        if (ctrl && !event.altKey && (key === 'y' || key === 'Y')) {
            if (editable) return;
            if (!isTodoActive()) return;
            event.preventDefault();
            view.redoWithToast();
            return;
        }
        if (!isTodoActive()) return;

        if (key === '?' || (key === '/' && event.shiftKey)) {
            if (editable) return;
            event.preventDefault();
            openHelp();
            return;
        }
        if (editable) {
            return;
        }
        if (key === 'p' || key === 'P') {
            event.preventDefault();
            var focusedRow = target.closest ? target.closest('.todo-item') : null;
            var pinId = store.getUi().selectedId || (focusedRow && focusedRow.getAttribute('data-id'));
            if (!pinId) {
                ui.toast('请先选择一项任务再置顶', { type: 'info', duration: 1800 });
                return;
            }
            if (view.togglePinWithFeedback) view.togglePinWithFeedback(pinId);
            return;
        }
        if (key === 'n' || key === 'N') {
            event.preventDefault();
            view.focusComposer();
            return;
        }
        if (key === '/') {
            event.preventDefault();
            var search = document.getElementById('todo-search');
            if (search) {
                search.focus();
                search.select();
            }
            return;
        }
        if (key === 'Escape') {
            var current = store.getUi();
            if (current.drawerOpen) {
                event.preventDefault();
                store.closeDrawer();
            } else if (current.search) {
                event.preventDefault();
                var searchEl = document.getElementById('todo-search');
                if (searchEl) searchEl.value = '';
                store.setSearch('');
            }
            return;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            var rows = document.querySelectorAll('#todo-list .todo-item__body');
            if (!rows.length) return;
            var inRow = target.closest && target.closest('.todo-item__body');
            if (inRow) return;
            event.preventDefault();
            var index = key === 'ArrowDown' ? 0 : rows.length - 1;
            rows[index].focus();
        }
    }

    /* ------------------------------------------------------------------ *
     * 导入 / 导出
     * ------------------------------------------------------------------ */
    function stamp() {
        var d = new Date();
        return d.getFullYear() + util.pad2(d.getMonth() + 1) + util.pad2(d.getDate()) +
            '-' + util.pad2(d.getHours()) + util.pad2(d.getMinutes());
    }

    function exportJson() {
        flushBeforeFile();
        var json = schema.exportJSON(store.getDoc());
        var filename = 'ntools-todo-' + stamp() + '.json';
        var ok = util.downloadBlob(filename, json, 'application/json');
        if (ok) {
            ui.toast('已导出 ' + filename, { type: 'success' });
        } else {
            showCopyFallback('导出失败，可复制以下 JSON 手动保存', json);
        }
    }

    function showCopyFallback(title, text) {
        var wrap = document.createElement('div');
        var textarea = document.createElement('textarea');
        textarea.className = 'nc-textarea todo-export-fallback';
        textarea.rows = 12;
        textarea.readOnly = true;
        textarea.value = text;
        wrap.appendChild(textarea);
        ui.openModal({
            title: title,
            content: wrap,
            size: 'lg',
            actions: [
                { label: '关闭' },
                {
                    label: '复制到剪贴板',
                    kind: 'primary',
                    onClick: function () {
                        util.copyText(text).then(function (ok) {
                            ui.toast(ok ? '已复制' : '复制失败，请手动选择复制', { type: ok ? 'success' : 'warn' });
                        });
                    }
                }
            ]
        });
    }

    function importJson() {
        if (fileInput) fileInput.click();
    }

    function wireFileInput() {
        if (!fileInput) return;
        fileInput.addEventListener('change', function () {
            var file = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            if (!file) return;
            if (file.size > schema.LIMITS.importBytes) {
                ui.alert('文件过大', '导入文件上限为 ' + Math.round(schema.LIMITS.importBytes / 1024 / 1024) + ' MB。');
                return;
            }
            var reader = new FileReader();
            reader.onerror = function () {
                ui.alert('读取失败', '无法读取该文件，请确认文件没有被其他程序占用。');
            };
            reader.onload = function (event) {
                var result = schema.parseImport(String(event.target.result || ''));
                if (!result.ok) {
                    ui.alert('导入失败', result.error || '文件格式不正确');
                    return;
                }
                previewImport(result, file.name);
            };
            reader.readAsText(file);
        });
    }

    function formatLabel(format) {
        var labels = {
            'v2-doc': 'v2 备份文档',
            'v1-array': 'v1 旧版数组',
            'legacy-data': '旧版 {data:[...]}',
            'tasks-array': '任务数组',
            'empty': '空数组'
        };
        return labels[format] || format || '未知格式';
    }

    function previewImport(result, filename) {
        var stats = result.stats;
        var content = document.createElement('div');
        content.className = 'import-preview';

        var summary = document.createElement('div');
        summary.className = 'import-preview__summary';
        var items = [
            ['文件', filename || '未知文件'],
            ['格式', formatLabel(result.format)],
            ['可导入任务', stats.valid + ' 条'],
            ['拒收/隔离', (stats.quarantined || stats.rejected || 0) + ' 条'],
            ['清单', stats.lists + ' 个']
        ];
        items.forEach(function (pair) {
            var row = document.createElement('div');
            row.className = 'import-preview__row';
            var key = document.createElement('span');
            key.className = 'import-preview__key';
            key.textContent = pair[0];
            var value = document.createElement('span');
            value.className = 'import-preview__value';
            value.textContent = pair[1];
            row.appendChild(key);
            row.appendChild(value);
            summary.appendChild(row);
        });
        content.appendChild(summary);

        if (result.issues && result.issues.length) {
            var issues = document.createElement('div');
            issues.className = 'import-preview__issues';
            var title = document.createElement('div');
            title.className = 'import-preview__issues-title';
            title.textContent = '数据修正提示（前 6 条）';
            issues.appendChild(title);
            var list = document.createElement('ul');
            result.issues.slice(0, 6).forEach(function (issue) {
                var li = document.createElement('li');
                li.textContent = (issue.index != null ? '第 ' + (issue.index + 1) + ' 条：' : '') + issue.message;
                list.appendChild(li);
            });
            issues.appendChild(list);
            content.appendChild(issues);
        }

        var note = document.createElement('p');
        note.className = 'import-preview__note';
        note.textContent = '导入前会自动备份当前数据（ntools.todo.v2_backup），合并导入按任务 ID 去重、较新的更新时间优先；替换导入会覆盖当前任务与清单。';
        content.appendChild(note);

        ui.openModal({
            title: '导入预览',
            content: content,
            size: 'lg',
            actions: [
                { label: '取消', kind: 'ghost' },
                {
                    label: '合并导入',
                    kind: 'primary',
                    onClick: function () { doImport(result, 'merge'); }
                },
                {
                    label: '替换现有数据',
                    kind: 'danger',
                    close: false,
                    onClick: function () {
                        return ui.confirm('将用导入文件替换当前全部任务与清单（已自动备份当前数据，可撤销）。确定继续吗？', {
                            danger: true,
                            confirmText: '确认替换'
                        }).then(function (ok) {
                            if (ok) doImport(result, 'replace');
                        });
                    }
                }
            ]
        });
    }

    function doImport(result, mode) {
        var imported = result.doc;
        var outcome = store.importDoc(imported, mode);
        var stats = (outcome && outcome.stats) || {};
        var message = mode === 'replace'
            ? '已替换为 ' + imported.tasks.length + ' 条任务'
            : '导入完成：新增 ' + (stats.added || 0) + ' 条，更新 ' + (stats.updated || 0) + ' 条';
        ui.toast(message, {
            type: 'success',
            duration: 5600,
            action: { label: '撤销', onClick: function () { view.undoWithToast(); } }
        });
        if (outcome && outcome.backup === false) {
            ui.toast('自动备份失败（存储空间不足），建议先导出当前数据', { type: 'warn', duration: 5000 });
        }
    }

    function restoreBackup() {
        if (!store.hasBackup()) {
            ui.toast('还没有可用备份（导入或清空前会自动生成）', { type: 'info' });
            return;
        }
        ui.confirm('恢复上次自动备份？当前数据会被替换（仍可撤销）。', { confirmText: '恢复备份' }).then(function (ok) {
            if (!ok) return;
            var result = store.restoreBackup();
            if (!result || !result.ok) {
                ui.alert('恢复失败', result && result.reason === 'none' ? '没有找到备份数据' : '备份数据已损坏，无法恢复');
                return;
            }
            ui.toast('已恢复备份：' + result.tasks + ' 条任务', {
                type: 'success',
                action: { label: '撤销', onClick: function () { view.undoWithToast(); } }
            });
        });
    }

    function clearTrash() {
        var count = store.counts(true).trash;
        if (!count) {
            ui.toast('回收站已经是空的', { type: 'info' });
            return;
        }
        ui.confirm('清空回收站中的 ' + count + ' 条任务？此操作仍可撤销，但撤销栈只保留最近操作。', {
            danger: true,
            confirmText: '清空回收站'
        }).then(function (ok) {
            if (!ok) return;
            store.clearTrash();
            ui.toast('回收站已清空', {
                type: 'success',
                action: { label: '撤销', onClick: function () { view.undoWithToast(); } }
            });
        });
    }

    function clearAll() {
        var total = store.getDoc().tasks.length;
        if (!total) {
            ui.toast('当前没有任务', { type: 'info' });
            return;
        }
        ui.confirm('清空全部 ' + total + ' 条任务？清空前会自动备份当前数据，且可撤销。', {
            danger: true,
            confirmText: '清空全部'
        }).then(function (ok) {
            if (!ok) return;
            var result = store.clearAllTasks();
            ui.toast('已清空全部任务', {
                type: 'success',
                action: { label: '撤销', onClick: function () { view.undoWithToast(); } }
            });
            if (result && result.backup === false) {
                ui.toast('自动备份失败，请及时导出数据', { type: 'warn' });
            }
        });
    }

    function loadDemo() {
        if (demoMode) {
            ui.toast('当前已是示例数据', { type: 'info' });
            return;
        }
        ui.confirm('载入示例数据会替换当前任务列表（会自动备份，且可撤销）。确定继续吗？', {
            confirmText: '载入示例'
        }).then(function (ok) {
            if (!ok) return;
            var outcome = store.importDoc(buildDemoDoc(), 'replace');
            ui.toast('已载入示例数据', {
                type: 'success',
                action: { label: '撤销', onClick: function () { view.undoWithToast(); } }
            });
            if (outcome) store.setView('all');
        });
    }

    function flushBeforeFile() {
        try { store.flush(); } catch (err) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ *
     * 帮助 / 快捷键说明
     * ------------------------------------------------------------------ */
    function openHelp() {
        var content = document.createElement('div');
        content.className = 'help-panel';

        var shortcuts = [
            ['N', '新建任务（聚焦输入框）'],
            ['/', '聚焦搜索'],
            ['↑ / ↓', '在任务间移动焦点（行内操作）'],
            ['Space', '完成 / 取消完成当前任务'],
            ['Enter', '打开当前任务详情'],
            ['E / 双击行', '行内编辑标题'],
            ['P', '置顶 / 取消置顶当前任务'],
            ['Delete', '删除当前任务（5 秒内可撤销）'],
            ['Esc', '关闭详情抽屉 / 清除搜索'],
            ['Ctrl + Z', '撤销上一步'],
            ['Ctrl + Shift + Z', '重做'],
            ['Alt + ↑ / ↓', '手动排序模式下调整顺序'],
            ['?', '打开本帮助']
        ];
        var table = document.createElement('div');
        table.className = 'help-shortcuts';
        shortcuts.forEach(function (pair) {
            var row = document.createElement('div');
            row.className = 'help-shortcuts__row';
            var key = document.createElement('span');
            key.className = 'help-shortcuts__key';
            key.textContent = pair[0];
            var label = document.createElement('span');
            label.className = 'help-shortcuts__label';
            label.textContent = pair[1];
            row.appendChild(key);
            row.appendChild(label);
            table.appendChild(row);
        });
        content.appendChild(table);

        var infoList = buildDataInfo();
        content.appendChild(infoList);

        ui.openModal({
            title: '快捷键与数据说明',
            content: content,
            size: 'lg',
            actions: [
                {
                    label: '导出备份',
                    kind: 'ghost',
                    close: false,
                    onClick: function () { exportJson(); }
                },
                { label: '知道了', kind: 'primary' }
            ]
        });
    }

    function buildDataInfo() {
        var doc = store.getDoc();
        var counts = store.counts(true);
        var wrap = document.createElement('div');
        wrap.className = 'help-data';
        var title = document.createElement('div');
        title.className = 'help-data__title';
        title.textContent = '数据与运行环境';
        wrap.appendChild(title);

        var env = NC.compat && NC.compat.features ? NC.compat.features : {};
        var rows = [
            ['数据版本', 'v2（schemaVersion ' + doc.schemaVersion + '）'],
            ['任务 / 清单', counts.total + ' 条任务 / ' + doc.lists.length + ' 个清单'],
            ['隔离脏数据', doc.meta.quarantine.length + ' 条（存于 meta.quarantine）'],
            ['存储位置', 'localStorage · ' + (storage.memoryMode() ? '不可用（内存模式，关闭页面即丢失）' : '已启用')],
            ['存储键', schema.KEYS.main],
            ['运行协议', env.protocol || 'unknown' + (env.fileProtocol ? '（本地文件）' : '')],
            ['内核', 'Chromium ' + (env.chromeVersion || 'unknown')],
            ['提醒方式', '页内提示 + 标题角标（file:// 下系统通知不可用，页面关闭后无法提醒）']
        ];
        rows.forEach(function (pair) {
            var row = document.createElement('div');
            row.className = 'help-data__row';
            var key = document.createElement('span');
            key.className = 'help-data__key';
            key.textContent = pair[0];
            var value = document.createElement('span');
            value.className = 'help-data__value';
            value.textContent = pair[1];
            row.appendChild(key);
            row.appendChild(value);
            wrap.appendChild(row);
        });
        return wrap;
    }

    /* ------------------------------------------------------------------ *
     * 示例数据（?demo=1 或菜单「载入示例数据」；demo 模式不落盘）
     * ------------------------------------------------------------------ */
    function buildDemoDoc() {
        var now = Date.now();
        var hour = 3600000;
        var day = 86400000;
        var today = util.startOfDay(now);
        var lists = [
            { id: 'list_default', name: '待办', color: '#5b8cff', order: 0 },
            { id: 'list_work', name: '工作', color: '#9a7bff', order: 1 },
            { id: 'list_life', name: '个人', color: '#3ddc97', order: 2 }
        ];
        var tasks = [
            {
                id: 'demo-1', listId: 'list_work', title: '提交季度安全巡检报告',
                notes: '汇总 9 个业务系统的检查结果，附整改清单与责任人。',
                status: 'open', priority: 'high', due: now - 2 * hour, tags: ['汇报', '安全'],
                createdAt: now - 3 * day, updatedAt: now - day
            },
            {
                id: 'demo-2', listId: 'list_default', title: '整理 nTools 重构验收清单',
                notes: '按验收清单核对 Todo P0 项：迁移、导入管道、三栏布局、快捷键、提醒。',
                status: 'open', priority: 'urgent', pinned: true, due: today + 18 * hour, tags: ['重构', '验收'],
                createdAt: now - 2 * day, updatedAt: now - 2 * hour
            },
            {
                id: 'demo-3', listId: 'list_work', title: '与兼容组对齐 Chromium 102 基线',
                notes: '确认 :has()、structuredClone、randomUUID 的可用性，补齐兼容性文档。',
                status: 'open', priority: 'normal', due: today + day + 10 * hour, tags: ['兼容'],
                createdAt: now - day, updatedAt: now - 3 * hour
            },
            {
                id: 'demo-4', listId: 'list_default', title: '修复 file:// 下通知权限降级',
                notes: '系统通知不可用，改为页内提示 + 标题角标。',
                status: 'done', priority: 'high', due: today + 9 * hour,
                completedAt: now - 3 * hour, tags: ['兼容'],
                createdAt: now - 2 * day, updatedAt: now - 3 * hour
            },
            {
                id: 'demo-5', listId: 'list_work', title: '准备麒麟环境现场验证脚本',
                notes: '检查存储可用性、下载、剪贴板、iframe 内嵌、datetime-local 控件差异。',
                status: 'open', priority: 'normal', due: today + 5 * day + 9 * hour, tags: ['兼容', '现场'],
                createdAt: now - day, updatedAt: now - day
            },
            {
                id: 'demo-6', listId: 'list_life', title: '整理本周会议纪要',
                notes: '周五前发到部门群，重点标注待办事项与截止时间。',
                status: 'open', priority: 'low', pinned: true, due: today + 20 * hour, tags: ['会议'],
                recurrence: { freq: 'weekly', interval: 1, byWeekday: [], until: null, count: null, lastMaterializedAt: null, lastCompletedAt: null },
                createdAt: now - 2 * day, updatedAt: now - 5 * hour
            },
            {
                id: 'demo-7', listId: 'list_default', title: '调研 IndexedDB 图片缓存的可行性',
                notes: '',
                status: 'open', priority: 'low', due: null, tags: ['调研'],
                createdAt: now - day, updatedAt: now - day
            },
            {
                id: 'demo-8', listId: 'list_default', title: '阅读验收清单并标注接口疑点',
                notes: '',
                status: 'done', priority: 'normal', due: today - day + 16 * hour,
                completedAt: today - day + 18 * hour, tags: ['重构'],
                createdAt: now - 3 * day, updatedAt: now - day
            },
            {
                id: 'demo-9', listId: 'list_work', title: '旧版待办数据迁移预演',
                notes: '用真实 v1 导出文件跑迁移，核对任务数、隔离条数与展示顺序。',
                status: 'canceled', priority: 'normal', due: null, tags: ['重构'],
                createdAt: now - 2 * day, updatedAt: now - day
            },
            {
                id: 'demo-10', listId: 'list_default', title: '废弃的临时任务',
                notes: '',
                status: 'open', priority: 'normal', due: null, tags: [],
                createdAt: now - day, updatedAt: now - day, deletedAt: now - 4 * hour
            },
            {
                id: 'demo-11', listId: 'list_work', title: '每日站会同步',
                notes: '每天 09:30 同步进度与阻塞项，站会控制在 10 分钟内。',
                status: 'open', priority: 'normal', due: today + day + 9.5 * hour, tags: ['站会'],
                recurrence: { freq: 'daily', interval: 1, byWeekday: [], until: null, count: null, lastMaterializedAt: null, lastCompletedAt: null },
                createdAt: now - 2 * day, updatedAt: now - hour
            },
            {
                id: 'demo-12', listId: 'list_life', title: '每月账单核对',
                notes: '核对水电、话费与订阅扣款，有异常及时标记。',
                status: 'open', priority: 'low', due: today + 3 * day + 20 * hour, tags: ['例行'],
                recurrence: { freq: 'monthly', interval: 1, byWeekday: [], until: null, count: null, lastMaterializedAt: null, lastCompletedAt: null },
                createdAt: now - 5 * day, updatedAt: now - 6 * hour
            }
        ];
        return {
            schemaVersion: 2,
            revision: 1,
            updatedAt: now,
            lists: lists,
            tasks: tasks,
            settings: {
                defaultListId: 'list_default',
                view: 'all',
                sort: 'smart',
                showCompleted: true,
                reminderLeadMinutes: 15,
                compact: false
            },
            meta: { app: 'nTools', appVersion: '2.0.0', migratedFrom: 'demo', migratedAt: now, quarantine: [] }
        };
    }

    /* ------------------------------------------------------------------ *
     * 对外 API（供 ntools-app 组合根调用）
     * ------------------------------------------------------------------ */
    NC.tools = NC.tools || {};
    NC.tools.todo = {
        init: init,
        exportToFile: exportJson,
        importFromFile: importJson,
        openHelp: openHelp,
        openAiDialog: openAiDialog,
        setMode: setMode,
        fillDraft: fillDraft,
        quickDueOptions: quickDueOptions,
        demoDoc: buildDemoDoc,
        isDemo: function () { return demoMode; },
        tick: tick
    };
})(window);
