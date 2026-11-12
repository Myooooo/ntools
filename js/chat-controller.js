/**
 * chat-controller.js — 聊天页控制器（组合根的业务编排）
 * 经典脚本，依赖 core.js、ui.js、api.js、conversation-store.js、message-view.js、composer.js。
 * 挂载到 NC.chat.controller。
 *
 * 职责：发送/停止/流式草稿/统计收尾/错误保底；消息的重新生成、编辑、删除（含确认与撤销）；
 *       会话导出/备份/恢复/清空。所有持久化经由 conversation-store，所有 DOM 经由 message-view。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var ui = NC.ui;

    var deps = null;
    var WELCOME = '你好，有什么可以帮你？';
    var CLEARED = '新对话已开始。';

    var stream = {
        active: false,
        added: false,
        controller: null,
        draft: null,
        startedAt: 0,
        firstTokenAt: 0,
        thinkStart: 0,
        usage: null,
        flush: null
    };

    function settings() { return deps.settings; }

    /** 打开全局设置面板（v3）；旧页面若注入 settingsView 则回退到它。 */
    function openSettings(sectionId) {
        if (typeof deps.openSettings === 'function') {
            try { deps.openSettings(sectionId || 'profiles'); } catch (err) { /* ignore */ }
            return;
        }
        if (deps.settingsView && typeof deps.settingsView.open === 'function') {
            deps.settingsView.open();
        } else if (NC.settingsPanel && typeof NC.settingsPanel.open === 'function') {
            NC.settingsPanel.open(sectionId || 'profiles');
        }
    }

    function conversation() { return deps.conversation; }
    function messages() { return deps.messages; }
    function composer() { return deps.composer; }

    /* ------------------------------------------------------------------ *
     * 首屏 / 会话切换
     * ------------------------------------------------------------------ */
    function renderConversation(emptyText) {
        var list = conversation().messages;
        messages().renderAll(list);
        messages().clearErrors();
        messages().setEmpty(list.length ? '' : (emptyText || WELCOME));
        messages().scrollToBottom(true);
    }

    /* ------------------------------------------------------------------ *
     * 发送 / 流式
     * ------------------------------------------------------------------ */
    function send(payload) {
        if (stream.active) return;
        var config = settings().getConfig();
        if (!config) return;
        if (!config.apiKey || !config.apiUrl || !config.modelId) {
            ui.toast('请先在「设置 → 模型端点」中配置 Base URL / API Key / Model ID', { type: 'warn', duration: 4500 });
            openSettings();
            return;
        }
        var parts = [];
        if (payload && payload.text) parts.push({ type: 'text', text: payload.text });
        ((payload && payload.images) || []).forEach(function (url) {
            parts.push({ type: 'image_url', image_url: { url: url } });
        });
        if (!parts.length) return;
        var stored = conversation().append({ role: 'user', content: parts });
        if (!stored) {
            ui.toast('消息格式无效，未发送', { type: 'error' });
            return;
        }
        messages().add(stored);
        messages().clearErrors();
        composer().clear();
        runStream(config);
    }

    function runStream(config) {
        stream.active = true;
        stream.added = false;
        stream.draft = null;
        stream.usage = null;
        stream.startedAt = Date.now();
        stream.firstTokenAt = 0;
        stream.thinkStart = 0;
        stream.controller = new AbortController();
        stream.flush = util.throttle(renderDraft, 60);

        var history = conversation().messages.map(function (message) {
            return { role: message.role, content: message.content };
        });
        composer().setBusy(true);
        messages().setStreaming(true);
        messages().setTyping(true);
        messages().setEmpty('');
        NC.api.chat({
            config: config,
            messages: history,
            signal: stream.controller.signal,
            onDelta: onDelta,
            onReasoning: onReasoning,
            onUsage: function (usage) { stream.usage = usage; },
            onDone: onDone,
            onError: onError
        });
    }

    function ensureDraft() {
        if (stream.draft) return;
        stream.draft = {
            id: util.uid('msg'),
            role: 'assistant',
            content: '',
            reasoning: '',
            createdAt: Date.now(),
            streaming: true
        };
    }

    function pushDraft() {
        ensureDraft();
        if (stream.added) return;
        stream.added = true;
        messages().setTyping(false);
        messages().add(stream.draft);
        renderDraft();
    }

    function onDelta(text) {
        if (!text) return;
        ensureDraft();
        if (stream.draft.reasoning && stream.draft.reasoningTime == null && stream.thinkStart) {
            stream.draft.reasoningTime = (Date.now() - stream.thinkStart) / 1000;
        }
        stream.draft.content += text;
        if (!stream.firstTokenAt) stream.firstTokenAt = Date.now();
        pushDraft();
        stream.flush();
    }

    function onReasoning(text) {
        if (!text) return;
        ensureDraft();
        if (!stream.thinkStart) stream.thinkStart = Date.now();
        stream.draft.reasoning = (stream.draft.reasoning || '') + text;
        stream.draft.reasoningStreaming = true;
        pushDraft();
        stream.flush();
    }

    function renderDraft() {
        var draft = stream.draft;
        if (!draft || !stream.added) return;
        messages().update(draft.id, {
            content: draft.content,
            reasoning: draft.reasoning,
            reasoningStreaming: !!draft.reasoning && !draft.content,
            reasoningTime: draft.reasoningTime != null ? draft.reasoningTime : null
        });
    }

    function stop() {
        if (!stream.active || !stream.controller) return;
        stream.controller.abort();
    }

    function onDone(result) {
        finalizeStream(result, !!(result && result.aborted));
    }

    function finalizeStream(result, aborted) {
        var draft = stream.draft;
        var content = draft ? draft.content : '';
        var reasoning = draft ? (draft.reasoning || '') : '';
        var endedAt = Date.now();

        messages().setTyping(false);
        messages().setStreaming(false);
        composer().setBusy(false);
        stream.active = false;
        stream.controller = null;

        if (!draft || (!content.trim() && !reasoning.trim())) {
            if (stream.added && draft) messages().remove(draft.id);
            stream.draft = null;
            stream.added = false;
            if (aborted) ui.toast('已停止生成', { type: 'info' });
            else messages().addError('请求失败：未收到有效内容');
            composer().focus();
            return;
        }

        var stats = result && result.stats;
        if (!stats) {
            stats = NC.api.computeStats({
                usage: result ? result.usage : null,
                messages: conversation().messages,
                content: content,
                firstTokenAt: stream.firstTokenAt,
                startedAt: stream.startedAt,
                endedAt: endedAt
            });
        }
        var reasoningTime = draft.reasoningTime;
        if (reasoningTime == null && reasoning && stream.thinkStart) {
            reasoningTime = (endedAt - stream.thinkStart) / 1000;
        }
        var finalMessage = {
            id: draft.id,
            role: 'assistant',
            content: content,
            createdAt: draft.createdAt,
            stats: stats
        };
        if (reasoning) {
            finalMessage.reasoning = reasoning;
            finalMessage.reasoningTime = reasoningTime;
        }
        conversation().append(finalMessage);
        messages().update(draft.id, {
            content: content,
            reasoning: finalMessage.reasoning || null,
            reasoningStreaming: false,
            reasoningTime: reasoningTime == null ? null : reasoningTime,
            stats: stats,
            streaming: false
        });
        conversation().saveNow();
        stream.draft = null;
        stream.added = false;
        composer().focus();
        if (aborted) ui.toast('已停止生成，已保留当前内容', { type: 'info' });
    }

    function onError(error) {
        var draft = stream.draft;
        var partial = draft && draft.content;
        messages().setTyping(false);
        messages().setStreaming(false);
        composer().setBusy(false);
        stream.active = false;
        stream.controller = null;
        if (stream.added && partial) {
            var keep = { id: draft.id, role: 'assistant', content: draft.content, createdAt: draft.createdAt };
            if (draft.reasoning) {
                keep.reasoning = draft.reasoning;
                keep.reasoningTime = draft.reasoningTime;
            }
            conversation().append(keep);
            messages().update(draft.id, {
                streaming: false,
                reasoningStreaming: false,
                reasoning: keep.reasoning || null,
                reasoningTime: keep.reasoningTime != null ? keep.reasoningTime : null
            });
            conversation().saveNow();
        } else if (stream.added && draft) {
            messages().remove(draft.id);
        }
        stream.draft = null;
        stream.added = false;
        var message = (error && error.message) || '未知错误';
        messages().addError('请求失败：' + message);
        composer().focus();
    }

    function isStreaming() {
        return stream.active;
    }

    /* ------------------------------------------------------------------ *
     * 消息操作
     * ------------------------------------------------------------------ */
    function indexOfMessage(id) {
        var list = conversation().messages;
        for (var i = 0; i < list.length; i += 1) {
            if (list[i].id === id) return i;
        }
        return -1;
    }

    function regenerate(id) {
        if (stream.active) return;
        var list = conversation().messages;
        var index = indexOfMessage(id);
        if (index === -1) return;
        var target = list[index];
        var truncateIndex = target.role === 'user' ? index + 1 : index;
        var removed = list.length - truncateIndex;
        var start = function () {
            conversation().truncateFrom(truncateIndex);
            renderConversation('');
            runStream(settings().getConfig());
        };
        if (removed > 0) {
            ui.confirm('重新生成将删除该消息之后的 ' + removed + ' 条消息，且无法恢复。是否继续？', {
                title: '重新生成',
                confirmText: '重新生成',
                danger: true
            }).then(function (ok) { if (ok) start(); });
        } else {
            start();
        }
    }

    function deleteMessage(id) {
        if (stream.active) return;
        var snapshot = conversation().messages.slice();
        var result = conversation().remove(id);
        if (!result.ok) return;
        messages().remove(id);
        ui.toast('消息已删除', {
            type: 'info',
            duration: 6500,
            action: {
                label: '撤销',
                onClick: function () {
                    conversation().setMessages(snapshot);
                    renderConversation('');
                }
            }
        });
    }

    function textOfUserMessage(message) {
        if (Array.isArray(message.content)) {
            return message.content.filter(function (part) { return part.type === 'text'; })
                .map(function (part) { return part.text; }).join('\n');
        }
        return typeof message.content === 'string' ? message.content : '';
    }

    function promptText(title, value, rows) {
        return new Promise(function (resolve) {
            var textarea = util.e('textarea', { class: 'nc-textarea', rows: rows || 6 });
            textarea.value = value;
            ui.openModal({
                title: title,
                size: 'lg',
                content: textarea,
                initialFocus: textarea,
                actions: [
                    { label: '取消', kind: 'ghost', onClick: function () { resolve(null); } },
                    { label: '保存', kind: 'primary', onClick: function () { resolve(textarea.value); } }
                ],
                onClose: function () { resolve(null); }
            });
        });
    }

    function editMessage(id) {
        if (stream.active) return;
        var list = conversation().messages;
        var index = indexOfMessage(id);
        if (index === -1) return;
        var message = list[index];
        var isUser = message.role === 'user';
        var original = isUser ? textOfUserMessage(message) : message.content;
        promptText('编辑消息', original, isUser ? 5 : 8).then(function (value) {
            if (value == null || value === original) return;
            if (isUser && !value.trim()) {
                ui.toast('消息内容不能为空', { type: 'warn' });
                return;
            }
            var later = list.length - index - 1;
            var apply = function () {
                if (isUser) {
                    var parts = (Array.isArray(message.content) ? message.content : []).map(function (part) {
                        return part.type === 'text' ? { type: 'text', text: value } : part;
                    });
                    if (!parts.some(function (part) { return part.type === 'text'; })) {
                        parts.unshift({ type: 'text', text: value });
                    }
                    conversation().update(id, { content: parts });
                    messages().update(id, { content: parts });
                    conversation().truncateFrom(index + 1);
                    renderConversation('');
                    runStream(settings().getConfig());
                } else {
                    conversation().update(id, { content: value });
                    messages().update(id, { content: value });
                    conversation().saveNow();
                }
            };
            if (later > 0) {
                ui.confirm('编辑后需要基于新内容重新生成，该消息之后的 ' + later + ' 条消息会被删除。是否继续？', {
                    title: '编辑消息',
                    confirmText: '保存并继续',
                    danger: true
                }).then(function (ok) { if (ok) apply(); });
            } else {
                apply();
            }
        });
    }

    /* ------------------------------------------------------------------ *
     * 会话文件 / 清空
     * ------------------------------------------------------------------ */
    function timestamp() {
        return new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    }

    function exportMarkdown() {
        if (!conversation().messages.length) {
            ui.toast('当前没有可导出的对话', { type: 'warn' });
            return;
        }
        var ok = util.downloadBlob('nchat_' + timestamp() + '.md', conversation().exportMarkdown(), 'text/markdown');
        ui.toast(ok ? '已导出对话 Markdown' : '导出失败', { type: ok ? 'success' : 'error' });
    }

    function backupConversation() {
        if (!conversation().messages.length) {
            ui.toast('当前没有可备份的对话', { type: 'warn' });
            return;
        }
        var data = conversation().exportBackup();
        var ok = util.downloadBlob('nchat_backup_' + timestamp() + '.json', JSON.stringify(data, null, 2), 'application/json');
        ui.toast(ok ? '已备份当前对话' : '备份失败', { type: ok ? 'success' : 'error' });
    }

    function confirmRestore(text) {
        var parsed = util.parseJSON(text, null);
        if (parsed == null) {
            ui.toast('恢复失败：无法解析备份文件', { type: 'error' });
            return;
        }
        ui.confirm('恢复备份将替换当前对话（当前 ' + conversation().messages.length + ' 条消息），是否继续？', {
            title: '恢复对话',
            confirmText: '恢复',
            danger: true
        }).then(function (ok) {
            if (!ok) return;
            var snapshot = conversation().messages.slice();
            var result = conversation().importBackup(text);
            if (!result.ok) {
                ui.toast('恢复失败：' + (result.reason || '未知错误'), { type: 'error' });
                return;
            }
            renderConversation('');
            ui.toast('对话已恢复（' + result.messages.length + ' 条消息）', {
                type: 'success',
                duration: 6000,
                action: {
                    label: '撤销',
                    onClick: function () {
                        conversation().setMessages(snapshot);
                        renderConversation('');
                    }
                }
            });
        });
    }

    function restoreFile(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function (event) { confirmRestore(String(event.target.result || '')); };
        reader.onerror = function () { ui.toast('读取备份文件失败', { type: 'error' }); };
        reader.readAsText(file);
    }

    function clearConversation() {
        if (stream.active) {
            ui.toast('请先停止当前生成', { type: 'warn' });
            return;
        }
        var snapshot = conversation().messages.slice();
        ui.confirm('确定要清除当前对话吗？本地保存的会话记录也会被清空。', {
            title: '清除对话',
            confirmText: '清除',
            danger: true
        }).then(function (ok) {
            if (!ok) return;
            conversation().clear();
            messages().renderAll([]);
            messages().setEmpty(CLEARED);
            ui.toast('对话已清除', {
                type: 'success',
                duration: 6500,
                action: {
                    label: '撤销',
                    onClick: function () {
                        conversation().setMessages(snapshot);
                        renderConversation('');
                    }
                }
            });
        });
    }

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function init(options) {
        deps = options || {};

        var map = {
            'export-conversation-btn': exportMarkdown,
            'backup-conversation-btn': backupConversation,
            'restore-conversation-btn': function () {
                var input = document.getElementById('restore-conversation-input');
                if (input) input.click();
            },
            'clear-chat-btn': clearConversation
        };
        Object.keys(map).forEach(function (id) {
            var button = document.getElementById(id);
            if (button) button.addEventListener('click', map[id]);
        });

        var restoreInput = document.getElementById('restore-conversation-input');
        if (restoreInput) {
            restoreInput.addEventListener('change', function (event) {
                var file = event.target.files && event.target.files[0];
                event.target.value = '';
                restoreFile(file);
            });
        }

        var jumpBtn = document.getElementById('jump-bottom-btn');
        if (jumpBtn) {
            jumpBtn.addEventListener('click', function () {
                messages().scrollToBottom(true);
                jumpBtn.hidden = true;
            });
        }
    }

    NC.chat = NC.chat || {};
    NC.chat.controller = {
        init: init,
        send: send,
        stop: stop,
        isStreaming: isStreaming,
        renderConversation: renderConversation,
        regenerate: regenerate,
        editMessage: editMessage,
        deleteMessage: deleteMessage,
        exportMarkdown: exportMarkdown,
        backupConversation: backupConversation,
        restoreFile: restoreFile,
        clear: clearConversation,
        setJumpVisible: function (visible) {
            var button = document.getElementById('jump-bottom-btn');
            if (button) button.hidden = !!visible;
        }
    };
})(window);
