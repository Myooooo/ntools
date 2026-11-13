/**
 * email-tab.js — 邮件管理动态 tab
 * 页面内容从 GitHub 实时拉取（不在本仓库提交 email-manager.html），
 * 以 sandbox iframe srcdoc 方式嵌入；不读写本地数据，不引入构建依赖。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var SOURCE = 'https://raw.githubusercontent.com/Myooooo/email-manager/master/email-manager.html';
    var SOURCE_BASE = 'https://raw.githubusercontent.com/Myooooo/email-manager/master/';
    var GITHUB_PAGE = 'https://github.com/Myooooo/email-manager/blob/master/email-manager.html';
    var state = { inited: false, loading: false, html: '', loadedAt: 0 };

    function byId(id) { return document.getElementById(id); }

    function setStatus(text) {
        var el = byId('email-status');
        if (el) el.textContent = text || '';
    }

    function showState(title, desc) {
        var box = byId('email-state');
        var frame = byId('email-frame');
        if (!box) return;
        box.hidden = false;
        if (frame) frame.hidden = true;
        var titleEl = box.querySelector('.email-state__title');
        var descEl = box.querySelector('.email-state__desc');
        if (titleEl) titleEl.textContent = title;
        if (descEl) descEl.textContent = desc;
    }

    function hideState() {
        var box = byId('email-state');
        var frame = byId('email-frame');
        if (box) box.hidden = true;
        if (frame) frame.hidden = false;
    }

    function withBase(html) {
        if (/<base\b/i.test(html)) return html;
        var tag = '<base href="' + SOURCE_BASE + '">';
        if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, function (m) { return m + tag; });
        return tag + html;
    }

    function load(force) {
        if (state.loading) return Promise.resolve(false);
        var frame = byId('email-frame');
        if (!frame) return Promise.resolve(false);
        state.loading = true;
        setStatus('正在从 GitHub 获取…');
        if (!state.html) showState('正在加载邮件管理…', '首次打开会从 GitHub 获取最新页面。');

        var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
        var timer = controller ? global.setTimeout(function () { try { controller.abort(); } catch (e) { /* ignore */ } }, 15000) : null;
        var url = SOURCE + '?t=' + Date.now();
        return global.fetch(url, {
            method: 'GET',
            cache: 'no-store',
            signal: controller ? controller.signal : undefined
        }).then(function (response) {
            if (!response.ok) {
                var error = new Error('HTTP ' + response.status);
                error.status = response.status;
                throw error;
            }
            return response.text();
        }).then(function (html) {
            if (!html || !String(html).trim()) throw new Error('返回内容为空');
            if (html !== state.html) {
                state.html = html;
                frame.srcdoc = withBase(String(html));
            }
            state.loadedAt = Date.now();
            state.loading = false;
            hideState();
            setStatus('已更新 · ' + new Date(state.loadedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
            return true;
        }).catch(function (error) {
            state.loading = false;
            var status = error && error.status ? 'HTTP ' + error.status : (error && error.name === 'AbortError' ? '请求超时' : '网络不可达');
            setStatus('加载失败 · ' + status);
            showState('邮件管理加载失败', '无法从 GitHub 获取页面（' + status + '）。请确认仓库/文件可公开访问，或点击右上角「刷新」重试。');
            return false;
        }).finally(function () {
            if (timer) global.clearTimeout(timer);
        });
    }

    function init() {
        if (state.inited) return;
        state.inited = true;
        var refresh = byId('email-refresh-btn');
        if (refresh) {
            refresh.addEventListener('click', function () { load(true); });
        }
    }

    function activate() {
        init();
        load(false);
    }

    NC.emailTab = {
        init: init,
        activate: activate,
        refresh: function () { return load(true); },
        source: SOURCE
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})(window);
