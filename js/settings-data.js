/**
 * settings-data.js — 设置 → 数据（一键备份 / 恢复 / 存储用量 / 待办与笔记导入导出）
 * 随设置面板按需加载；由 NC.settingsData.render(container, deps) 调用。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    function render(container, deps) {
        var util = deps.util;
        var ui = deps.ui;
        var toast = deps.toast;
        var button = deps.button;
        var moduleCard = deps.moduleCard;
        var moduleRows = deps.moduleRows;
        var openModule = deps.openModule;
        var renderSection = deps.renderSection;
        var global = deps.global;
        var renderEmailTransferCard = deps.renderEmailTransferCard;
        var renderSnapshotCard = deps.renderSnapshotCard;
        var renderLegacyCard = deps.renderLegacyCard;
        var exportNotes = deps.exportNotes;
        var importNotes = deps.importNotes;
        var withNotesStore = deps.withNotesStore;
        var renderNotesSnapshotList = deps.renderNotesSnapshotList;
        var exportEverything = deps.exportEverything;
        var importEverything = deps.importEverything;

    function backupStatusText(status) {
        var parts = [];
        if (status.lastAt) parts.push('上次 ' + util.formatDateTime(status.lastAt) + '（' + (status.lastKind === 'zip' ? '下载 ZIP' : '本机自动') + '）');
        else parts.push('还没有备份过');
        if (status.enabled && status.nextAt) {
            parts.push(status.due ? '已到备份时间' : '下次约 ' + util.formatDateTime(status.nextAt));
        } else if (!status.enabled) {
            parts.push('自动备份已关闭');
        }
        return parts.join('　');
    }

    function renderBackupCard() {
        var backup = NC.backup;
        var card = moduleCard('一键备份全部数据',
            '把待办、笔记（含图片）、聊天、邮箱、AI 端点与全部偏好打包成一个 ZIP；换一台机器解压后用 JSON 恢复即可完全重建。');
        if (!backup) {
            card.appendChild(util.e('p', { class: 'sp-hint', text: '备份模块未加载（js/backup.js）' }));
            return card;
        }
        var status = backup.status();

        var bar = util.e('div', { class: 'sp-data-card__actions' });
        var includeKeys = util.e('input', { type: 'checkbox', class: 'nc-check' });
        includeKeys.checked = backup.readCfg().includeKeys === true;
        includeKeys.addEventListener('change', function () {
            backup.writeCfg({ includeKeys: includeKeys.checked });
        });
        var keyLabel = util.e('label', { class: 'sp-check' });
        keyLabel.appendChild(includeKeys);
        keyLabel.appendChild(util.e('span', { text: '包含 API Key（会明文写入 ZIP）' }));

        bar.appendChild(button('立即备份并下载 ZIP', {
            primary: true, small: true, icon: 'download',
            onClick: function (event) {
                var btn = event.currentTarget;
                ui.setBusy(btn, true);
                backup.downloadZip({ includeKeys: includeKeys.checked }).then(function (res) {
                    ui.setBusy(btn, false);
                    toast('已生成备份 ' + Math.round(res.bytes / 1024) + ' KB', 'success');
                    renderSection('data');
                }, function (err) {
                    ui.setBusy(btn, false);
                    toast('备份失败：' + (err && err.message ? err.message : err), 'error');
                });
            }
        }));
        bar.appendChild(keyLabel);
        card.appendChild(bar);

        /* 自动备份 */
        var autoRow = util.e('div', { class: 'sp-row' });
        autoRow.appendChild(util.e('span', { class: 'sp-row__label', text: '自动备份' }));
        var interval = util.e('select', { class: 'nc-select sp-select--auto' });
        [
            { value: '0', label: '关闭' },
            { value: '6', label: '每 6 小时' },
            { value: '12', label: '每 12 小时' },
            { value: '24', label: '每 24 小时（默认）' },
            { value: '72', label: '每 3 天' }
        ].forEach(function (item) {
            var option = util.e('option', { value: item.value, text: item.label });
            if (String(status.intervalHours) === item.value) option.selected = true;
            interval.appendChild(option);
        });
        interval.addEventListener('change', function () {
            var next = backup.setIntervalHours(Number(interval.value));
            toast(next.enabled ? '自动备份已设为每 ' + next.intervalHours + ' 小时' : '已关闭自动备份', 'success');
            renderSection('data');
        });
        autoRow.appendChild(interval);
        card.appendChild(autoRow);
        card.appendChild(util.e('p', { class: 'sp-hint', text: backupStatusText(status) }));

        var autoBar = util.e('div', { class: 'sp-data-card__actions' });
        autoBar.appendChild(button('立即执行一次自动备份', {
            small: true, ghost: true, icon: 'refresh',
            onClick: function (event) {
                var btn = event.currentTarget;
                ui.setBusy(btn, true);
                backup.runAuto('manual').then(function (res) {
                    ui.setBusy(btn, false);
                    if (res && res.ok) { toast('已保存到本机自动备份', 'success'); renderSection('data'); }
                    else toast('自动备份失败：' + ((res && res.error && res.error.message) || '未知原因'), 'error');
                });
            }
        }));
        autoBar.appendChild(button('从备份 JSON 恢复', {
            small: true, ghost: true, icon: 'upload',
            onClick: restoreFromBackupFile
        }));
        card.appendChild(autoBar);
        card.appendChild(util.e('p', {
            class: 'sp-hint',
            text: '自动备份保存在本机 IndexedDB（保留最近 3 份），浏览器数据被清空时也会一起丢；重要数据请同时下载 ZIP 存到磁盘。'
        }));

        var list = util.e('div', { class: 'sp-snap-list' });
        list.appendChild(util.e('div', { class: 'sp-data-card__desc', text: '最近的自动备份' }));
        card.appendChild(list);
        backup.listAuto().then(function (items) {
            if (!items.length) {
                list.appendChild(util.e('div', { class: 'sp-hint', text: '还没有自动备份' }));
                return;
            }
            items.forEach(function (item) {
                var row = util.e('div', { class: 'sp-snap-row' });
                row.appendChild(util.e('span', { class: 'sp-snap-row__time', text: util.formatDateTime(item.at) }));
                row.appendChild(util.e('span', {
                    class: 'sp-snap-row__meta',
                    text: '笔记 ' + (item.notes || 0) + '　聊天 ' + (item.chats || 0)
                }));
                row.appendChild(button('恢复', {
                    small: true, ghost: true,
                    onClick: function () {
                        ui.confirm('用 ' + util.formatDateTime(item.at) + ' 的自动备份覆盖当前全部数据？恢复后页面会自动刷新。', {
                            title: '恢复自动备份', confirmText: '恢复并刷新', danger: true
                        }).then(function (ok) {
                            if (!ok) return;
                            backup.restoreAuto(item.id).then(function (res) {
                                finishRestore(res);
                            }, function (err) {
                                toast('恢复失败：' + (err && err.message ? err.message : err), 'error');
                            });
                        });
                    }
                }));
                row.appendChild(button('删除', {
                    small: true, ghost: true,
                    onClick: function () {
                        backup.deleteAuto(item.id).then(function () { renderSection('data'); });
                    }
                }));
                list.appendChild(row);
            });
        });
        return card;
    }

    function restoreReport(result) {
        var done = (result && result.done || []).join('、') || '无';
        var failed = (result && result.failed || []).join('、') || '无';
        return '已恢复：' + done + '\n未恢复：' + failed + '\n\n恢复前已自动保存一份本机快照，可在「最近的自动备份」里找回。';
    }

    function finishRestore(result) {
        ui.alert('恢复完成', restoreReport(result)).then(function () {
            global.location.reload();
        });
    }

    function restoreFromBackupFile() {
        var inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = '.json,application/json';
        inputEl.addEventListener('change', function () {
            var file = inputEl.files && inputEl.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (event) {
                var raw = String(event.target.result || '');
                var data = util.parseJSON(raw, null);
                if (!data) { toast('不是有效的 JSON', 'error'); return; }
                var summary = describeBackupPayload(data);
                ui.confirm((summary || '备份内容未识别。') + '\n\n恢复会覆盖当前数据（端点/偏好一并还原），完成后页面会刷新。继续？', {
                    title: '从备份恢复', confirmText: '恢复并刷新', danger: true
                }).then(function (ok) {
                    if (!ok) return;
                    if (!NC.backup) { toast('备份模块未加载', 'error'); return; }
                    NC.backup.restoreFromJson(raw).then(function (res) {
                        finishRestore(res);
                    }, function (err) {
                        toast('恢复失败：' + (err && err.message ? err.message : err), 'error');
                    });
                });
            };
            reader.onerror = function () { toast('读取文件失败', 'error'); };
            reader.readAsText(file);
        });
        inputEl.click();
    }

    function describeBackupPayload(data) {
        var parts = [];
        if (data.todo && Array.isArray(data.todo.tasks)) parts.push('待办 ' + data.todo.tasks.length + ' 条');
        if (data.notes && Array.isArray(data.notes.notes)) parts.push('笔记 ' + data.notes.notes.length + ' 篇');
        if (data.chats && Array.isArray(data.chats.sessions)) parts.push('会话 ' + data.chats.sessions.length + ' 个');
        if (data.email && (data.email.groups || data.email.emails)) parts.push('邮箱 ' + ((data.email.emails || []).length) + ' 条');
        if (data.workshop && Array.isArray(data.workshop.apps)) parts.push('工坊应用 ' + data.workshop.apps.length + ' 个');
        if (data.llm) parts.push('AI 端点');
        if (data.prefs && Object.keys(data.prefs).length) parts.push('偏好 ' + Object.keys(data.prefs).length + ' 项');
        return parts.length ? '备份包含：' + parts.join('；') + '。' : '';
    }

    /* ------------------------------------------------------------------ *
     * 邮箱 JSON 导出 / 导入（邮箱维护 tab 与数据 tab 共用）
     * ------------------------------------------------------------------ */
    function storageUsedBytes() {
        var total = 0;
        try {
            var keys = NC.storage && NC.storage.keys ? NC.storage.keys() : [];
            keys.forEach(function (key) {
                var raw = NC.storage.getRaw(key);
                if (raw) total += NC.storage.estimateBytes(raw);
            });
        } catch (err) { total = 0; }
        return total;
    }

    function renderStorageCard() {
        var card = moduleCard('本地存储', '浏览器配额约 3.5 MB；接近上限时请先导出备份，再清理历史版本。');
        var used = storageUsedBytes();
        var limit = (NC.storage && NC.storage.maxBytes) || 3.5 * 1024 * 1024;
        var pct = Math.min(100, Math.max(used > 0 ? 1 : 0, Math.round((used / limit) * 100)));

        var row = util.e('div', { class: 'sp-usage' });
        row.appendChild(util.e('span', {
            class: 'sp-usage__label',
            text: '已用 ' + util.formatBytes(used) + ' / ' + util.formatBytes(limit)
        }));
        row.appendChild(util.e('span', { class: 'sp-usage__value', text: pct + '%' }));
        card.appendChild(row);

        var bar = util.e('div', {
            class: 'nc-progress',
            role: 'progressbar',
            'aria-label': '本地存储占用',
            'aria-valuemin': '0',
            'aria-valuemax': '100',
            'aria-valuenow': String(pct)
        });
        if (pct >= 85) bar.classList.add('nc-progress--danger');
        else if (pct >= 60) bar.classList.add('nc-progress--warn');
        var fill = util.e('span', { class: 'nc-progress__bar' });
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        card.appendChild(bar);
        return card;
    }

    function renderData(container) {
        var head = util.e('div', { class: 'sp-section-head' });
        var info = util.e('div', {});
        info.appendChild(util.e('h2', { class: 'sp-section-title', text: '数据' }));
        info.appendChild(util.e('p', { class: 'sp-section-desc', text: '所有数据仅保存在本机浏览器；导出时请注意密钥与隐私。' }));
        head.appendChild(info);
        container.appendChild(head);

        container.appendChild(renderBackupCard());
        container.appendChild(renderStorageCard());

        var canExport = NC.store.todo && typeof NC.store.todo.exportData === 'function';
        var card = util.e('div', { class: 'sp-data-card' });
        card.appendChild(util.e('div', { class: 'sp-data-card__title', text: '待办数据' }));
        card.appendChild(util.e('div', { class: 'sp-data-card__desc', text: '导出 JSON（可重新导入）' }));
        var actions = util.e('div', { class: 'sp-data-card__actions' });
        actions.appendChild(button('导出待办', {
            small: true, icon: 'download',
            onClick: function () {
                if (canExport) NC.tools.todo.exportToFile();
                else toast('待办模块未加载', 'warn');
            }
        }));
        actions.appendChild(button('导入待办', {
            small: true, icon: 'upload',
            onClick: function () {
                var file = document.getElementById('todo-import-file');
                if (file) file.click();
                else toast('待办模块未加载', 'warn');
            }
        }));
        actions.appendChild(button('清空待办', {
            small: true, danger: true, icon: 'trash',
            onClick: function () {
                ui.confirm('清空所有待办任务？将先自动备份到本地。', { danger: true, confirmText: '清空' })
                    .then(function (ok) {
                        if (!ok) return;
                        if (NC.store.todo && NC.store.todo.resetDocument) {
                            NC.store.todo.resetDocument();
                            toast('待办已清空', 'success');
                        }
                    });
            }
        }));
        card.appendChild(actions);
        container.appendChild(card);

        /* ---- 笔记：导出 / 导入 / 附件清理 / 快照 ---- */
        var notesCard = util.e('div', { class: 'sp-data-card' });
        notesCard.appendChild(util.e('div', { class: 'sp-data-card__title', text: '笔记' }));
        notesCard.appendChild(util.e('div', {
            class: 'sp-data-card__desc',
            text: '文本可导出 JSON；ZIP 会连同图片一起打包。导入为覆盖式，导入前自动快照。'
        }));
        var notesActions = util.e('div', { class: 'sp-data-card__actions' });
        notesActions.appendChild(button('导出 JSON', {
            small: true, icon: 'download',
            onClick: function () { exportNotes('json'); }
        }));
        notesActions.appendChild(button('导出 ZIP（含图片）', {
            small: true, icon: 'download',
            onClick: function () { exportNotes('zip'); }
        }));
        notesActions.appendChild(button('导入笔记', {
            small: true, icon: 'upload',
            onClick: function () { importNotes(); }
        }));
        notesActions.appendChild(button('清理未引用图片', {
            small: true, ghost: true, icon: 'trash',
            onClick: function () {
                withNotesStore(function () {
                    var notesStore = NC.store && NC.store.notes;
                    if (!notesStore || !notesStore.pruneOrphanFiles) { toast('笔记模块未加载', 'warn'); return; }
                    var stats = notesStore.fileStats ? notesStore.fileStats() : { count: 0 };
                    ui.confirm('删除没有被任何笔记引用的图片（当前共 ' + stats.count + ' 张）？此操作不可撤销。', {
                        confirmText: '清理', danger: true
                    }).then(function (ok) {
                        if (!ok) return;
                        var removed = notesStore.pruneOrphanFiles();
                        toast(removed ? '已清理 ' + removed + ' 张未引用图片' : '没有需要清理的图片', 'success');
                        renderSection('data');
                    });
                });
            }
        }));
        notesCard.appendChild(notesActions);
        notesCard.appendChild(renderNotesSnapshotList());
        container.appendChild(notesCard);

        container.appendChild(renderEmailTransferCard());

        var chatCard = util.e('div', { class: 'sp-data-card' });
        chatCard.appendChild(util.e('div', { class: 'sp-data-card__title', text: '聊天记录' }));
        chatCard.appendChild(util.e('div', { class: 'sp-data-card__desc', text: '按端点分别保存，可导出备份。' }));
        var chatActions = util.e('div', { class: 'sp-data-card__actions' });
        chatActions.appendChild(button('清除聊天记录', {
            small: true, danger: true, icon: 'trash',
            onClick: function () {
                ui.confirm('清除当前端点的聊天记录？该操作不可撤销。', { danger: true, confirmText: '清除' })
                    .then(function (ok) {
                        if (!ok) return;
                        if (NC.chatEmbed && typeof NC.chatEmbed.clearConversation === 'function') {
                            NC.chatEmbed.clearConversation();
                        } else if (NC.store.conversation) {
                            NC.store.conversation.clear();
                            events.emit(NC.eventNames.conversationChanged, { messages: [] });
                        }
                        toast('聊天记录已清除', 'success');
                    });
            }
        }));
        chatActions.appendChild(button('导出全部本地数据', {
            small: true, icon: 'download',
            onClick: exportEverything
        }));
        chatActions.appendChild(button('从备份恢复', {
            small: true, icon: 'upload',
            onClick: importEverything
        }));
        chatCard.appendChild(chatActions);
        container.appendChild(chatCard);

        container.appendChild(renderSnapshotCard());
        container.appendChild(renderLegacyCard());
    }

    /* ------------------------------------------------------------------ *
     * 分区：数据 —— 历史版本数据清理
     * 迁移后旧键一直留着（为了可回退），但它们会实实在在占用 3.5MB 预算。
     * 这里只列出"确定可删"的旧键，并让用户显式确认后再删。
     * ------------------------------------------------------------------ */

        renderData(container);
    }

    NC.settingsData = { render: render };
})(window);
