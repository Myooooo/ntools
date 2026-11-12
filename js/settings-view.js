/**
 * settings-view.js — v3：聊天系统提示词快捷面板（sheet）
 * 经典脚本，依赖 core.js、icons.js、ui.js、llm-store.js。挂载：NC.view.chatPrompt
 *
 * 说明：v2 的「设置面板」已由 Lead 的全局设置面板（NC.settingsPanel）取代；
 * 本文件只保留聊天页快捷入口，读写当前端点的 profile.chatSystemPrompt。
 *
 * DOM（ntools.html #page-nchat，契约 §4.1）：
 *   #chat-system-prompt-sheet #chat-system-prompt-input #chat-system-prompt-save
 *   #chat-system-prompt-reset #chat-system-prompt-cancel #chat-system-prompt-profile
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var ui = NC.ui;
    var events = NC.events;

    var el = {};
    var initialized = false;
    var opened = false;
    var activeProfileId = null;
    var releaseTrap = null;
    var closeTimer = null;

    function llm() { return NC.store && NC.store.llm ? NC.store.llm : null; }

    function toast(message, type) {
        ui.toast(message, { type: type || 'success' });
    }

    function profileLabel(profile) {
        if (!profile) return '未选择端点';
        return profile.name + (profile.modelId ? ' · ' + profile.modelId : '');
    }

    function currentProfile() {
        var store = llm();
        if (!store) return null;
        return store.getProfile(activeProfileId) || store.getCurrentProfile();
    }

    function syncProfileLabel() {
        if (!el.profile) return;
        el.profile.textContent = profileLabel(currentProfile());
    }

    function open(profileId) {
        if (!el.sheet) return false;
        var store = llm();
        if (!store) {
            toast('端点数据尚未就绪，请稍后重试', 'warn');
            return false;
        }
        activeProfileId = typeof profileId === 'string' && profileId
            ? profileId
            : store.getState().currentProfileId;
        var profile = store.getProfile(activeProfileId) || store.getCurrentProfile();
        if (!profile) {
            toast('请先在设置中添加模型端点', 'warn');
            return false;
        }
        activeProfileId = profile.id;
        if (el.input) el.input.value = profile.chatSystemPrompt || '';
        syncProfileLabel();
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        el.sheet.hidden = false;
        opened = true;
        (global.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
            el.sheet.classList.add('is-open');
        });
        if (el.input) {
            try { el.input.focus(); } catch (err) { /* ignore */ }
            try { el.input.setSelectionRange(el.input.value.length, el.input.value.length); } catch (err) { /* ignore */ }
        }
        if (ui && typeof ui.trapFocus === 'function' && !releaseTrap) {
            releaseTrap = ui.trapFocus(el.sheet);
        }
        return true;
    }

    function close() {
        if (!el.sheet || !opened) return;
        opened = false;
        el.sheet.classList.remove('is-open');
        if (releaseTrap) { releaseTrap(); releaseTrap = null; }
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(function () {
            if (!opened && el.sheet) el.sheet.hidden = true;
        }, 180);
    }

    function save(options) {
        var store = llm();
        var opts = options || {};
        if (!store || !activeProfileId) {
            toast('保存失败：端点数据未就绪', 'error');
            return false;
        }
        var value = el.input ? el.input.value : '';
        var profile = store.setChatSystemPrompt(activeProfileId, value);
        if (!profile) {
            toast('保存失败：端点不存在', 'error');
            return false;
        }
        syncProfileLabel();
        if (!opts.silent) {
            toast(value.trim() ? '系统提示词已保存，下一条消息生效' : '已清空当前端点的系统提示词');
        }
        return true;
    }

    function reset() {
        if (el.input) el.input.value = '';
        save({ silent: true });
        toast('已清空当前端点的系统提示词');
        if (el.input) {
            try { el.input.focus(); } catch (err) { /* ignore */ }
        }
    }

    function bind() {
        if (el.save) el.save.addEventListener('click', function () { save(); close(); });
        if (el.cancel) el.cancel.addEventListener('click', close);
        if (el.reset) el.reset.addEventListener('click', reset);
        if (el.sheet) {
            el.sheet.addEventListener('click', function (event) {
                if (event.target === el.sheet) close();
            });
            el.sheet.addEventListener('keydown', function (event) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    save();
                    close();
                }
            });
        }
        events.on('llm:changed', function () {
            if (!opened) return;
            var store = llm();
            if (!store) return;
            var profile = store.getProfile(activeProfileId);
            if (!profile) {
                // 当前端点被删除：切到新的当前端点，避免保存到不存在的端点
                activeProfileId = store.getState().currentProfileId;
                profile = store.getCurrentProfile();
                if (profile && el.input) el.input.value = profile.chatSystemPrompt || '';
            }
            syncProfileLabel();
        });
    }

    function init() {
        if (initialized) return true;
        el.sheet = document.getElementById('chat-system-prompt-sheet');
        if (!el.sheet) return false;
        el.input = document.getElementById('chat-system-prompt-input');
        el.save = document.getElementById('chat-system-prompt-save');
        el.reset = document.getElementById('chat-system-prompt-reset');
        el.cancel = document.getElementById('chat-system-prompt-cancel');
        el.profile = document.getElementById('chat-system-prompt-profile');
        bind();
        initialized = true;
        return true;
    }

    NC.view = NC.view || {};
    NC.view.chatPrompt = {
        init: init,
        open: open,
        close: close,
        save: save,
        reset: reset,
        isOpen: function () { return opened; },
        getActiveProfileId: function () { return activeProfileId; }
    };
})(window);
