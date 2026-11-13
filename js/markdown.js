/**
 * markdown.js — 实时 Markdown 工具（经典脚本，依赖 core.js / ui.js / storage.js、
 * js/marked.min.js、js/purify.min.js）
 *
 * 页面接线（见 docs/architecture.md）：
 *   #md-input(textarea) #md-preview(div) #md-export(button)
 *   #md-import(input[type=file]) #md-import-btn(button) #md-stats(span)
 * 使用：ntools-app.js 调用 NC.tools.markdown.init()；DOM ready 后也会自动初始化（幂等）。
 * 安全：预览必须 DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } })。
 * 持久化：ntools_md（raw 字符串，兼容 v1 数据），输入 200ms 防抖。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var tools = NC.tools = NC.tools || {};

    var IDS = {
        input: ['md-input'],
        preview: ['md-preview', 'md-output'],
        exportBtn: ['md-export'],
        importInput: ['md-import'],
        importBtn: ['md-import-btn'],
        stats: ['md-stats']
    };

    var STORAGE_KEY = 'ntools_md';
    var DEBOUNCE_WAIT = 200;
    var MAX_IMPORT_BYTES = 5 * 1024 * 1024;
    var RENDER_CHAR_LIMIT = 400000;
    var DEFAULT_TEXT = '# 欢迎使用 nTools Markdown\n\n在左侧输入 Markdown，右侧实时预览；内容自动保存在本机（`ntools_md`）。\n\n' +
        '- 支持标题、列表、表格、代码块、链接\n' +
        '- 可导入/导出 `.md` 文件\n';

    var state = {
        initialized: false,
        dirty: false,
        warnedStorage: false,
        warnedMissingLib: false
    };
    var els = {};
    var debouncedCommit = null;

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */
    function pick(ids) {
        for (var i = 0; i < ids.length; i++) {
            var node = document.getElementById(ids[i]);
            if (node) return node;
        }
        return null;
    }

    function toast(message, type) {
        if (NC.ui && NC.ui.toast) return NC.ui.toast(message, { type: type || 'info' });
        if (global.console) global.console.log('[markdown] ' + message);
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function stamp() {
        var d = new Date();
        return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
            pad2(d.getHours()) + pad2(d.getMinutes());
    }

    function getValue() {
        return els.input && typeof els.input.value === 'string' ? els.input.value : '';
    }

    /* ------------------------------------------------------------------ *
     * 预览渲染
     * ------------------------------------------------------------------ */
    function postProcess() {
        if (!els.preview) return;
        var links = els.preview.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href') || '';
            if (/^https?:/i.test(href)) {
                links[i].setAttribute('target', '_blank');
                links[i].setAttribute('rel', 'noopener noreferrer');
            }
        }
        // 外链图片不加 referrer，避免内网页面把访问痕迹带到外部站点
        var images = els.preview.querySelectorAll('img[src]');
        for (var j = 0; j < images.length; j++) {
            var src = images[j].getAttribute('src') || '';
            if (/^https?:/i.test(src)) {
                images[j].setAttribute('referrerpolicy', 'no-referrer');
                images[j].setAttribute('loading', 'lazy');
            }
        }
    }

    function renderNow() {
        if (!els.preview) return;
        var text = getValue();
        if (!text || !text.trim()) {
            els.preview.innerHTML = '<p class="nc-field-hint">在左侧输入 Markdown，这里实时预览。</p>';
            return;
        }
        if (typeof global.marked === 'undefined' || typeof global.DOMPurify === 'undefined') {
            els.preview.textContent = 'Markdown 组件未加载（需要 js/marked.min.js 与 js/purify.min.js）';
            if (!state.warnedMissingLib) {
                state.warnedMissingLib = true;
                toast('Markdown 组件未加载，无法渲染预览', 'error');
            }
            return;
        }
        var source = text;
        var truncated = false;
        if (source.length > RENDER_CHAR_LIMIT) {
            source = source.slice(0, RENDER_CHAR_LIMIT);
            truncated = true;
        }
        try {
            if (global.marked.setOptions) {
                global.marked.setOptions({ gfm: true, breaks: true });
            }
            var html = global.marked.parse(source);
            var clean = global.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
            els.preview.innerHTML = clean;
            if (truncated) {
                var note = document.createElement('p');
                note.className = 'nc-field-hint';
                note.textContent = '文档过大，预览仅渲染前 ' + RENDER_CHAR_LIMIT + ' 个字符（保存/导出不受影响）。';
                els.preview.appendChild(note);
            }
            postProcess();
        } catch (err) {
            els.preview.textContent = '渲染失败：' + (err && err.message ? err.message : String(err));
        }
    }

    function updateStats() {
        if (!els.stats) return;
        var text = getValue();
        var chars = text.length;
        var lines = text ? text.split(/\r\n|\r|\n/).length : 0;
        els.stats.textContent = chars + ' 字符　' + lines + ' 行';
    }

    /* ------------------------------------------------------------------ *
     * 持久化
     * ------------------------------------------------------------------ */
    function saveNow() {
        var value = getValue();
        var res = null;
        if (NC.storage && NC.storage.setRaw) {
            res = NC.storage.setRaw(STORAGE_KEY, value);
        } else {
            try {
                global.localStorage.setItem(STORAGE_KEY, value);
                res = { ok: true };
            } catch (err) {
                res = { ok: false };
            }
        }
        var ok = !!(res && res.ok !== false);
        if (!ok && !state.warnedStorage) {
            state.warnedStorage = true;
            toast('本地存储不可用：本文档不会被保存，请及时导出 .md', 'warn');
        }
        return ok;
    }

    function commit() {
        renderNow();
        saveNow();
    }

    function scheduleCommit() {
        if (debouncedCommit) debouncedCommit();
    }

    function flushCommit() {
        if (debouncedCommit && debouncedCommit.flush) debouncedCommit.flush();
        else commit();
    }

    /* ------------------------------------------------------------------ *
     * 导入 / 导出
     * ------------------------------------------------------------------ */
    function applyImportedText(text) {
        if (!els.input) return;
        els.input.value = text;
        renderNow();
        updateStats();
        saveNow();
        state.dirty = false;
    }

    function handleImportFile(file) {
        if (!file) return;
        if (file.size > MAX_IMPORT_BYTES) {
            toast('文件过大（>5MB），建议拆分后再导入', 'warn');
            return;
        }
        var reader = new FileReader();
        reader.onload = function () {
            applyImportedText(String(reader.result == null ? '' : reader.result));
            toast('已导入：' + (file.name || 'markdown'), 'success');
        };
        reader.onerror = function () { toast('读取文件失败', 'error'); };
        try {
            reader.readAsText(file, 'utf-8');
        } catch (err) {
            toast('读取文件失败', 'error');
        }
    }

    function exportMarkdown() {
        var text = getValue();
        if (!text.trim()) {
            toast('当前文档为空，无法导出', 'warn');
            return false;
        }
        var heading = (text.match(/^#\s+(.+)$/m) || [])[1];
        var base = heading ? heading.trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) : 'document';
        var filename = base + '-' + stamp() + '.md';
        var ok = false;
        if (NC.util && NC.util.downloadBlob) {
            ok = NC.util.downloadBlob(filename, text, 'text/markdown;charset=utf-8');
        } else {
            try {
                var link = document.createElement('a');
                link.href = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text);
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                global.setTimeout(function () { if (link.parentNode) link.parentNode.removeChild(link); }, 1200);
                ok = true;
            } catch (err) {
                ok = false;
            }
        }
        toast(ok ? '已导出 ' + filename : '导出失败，请尝试复制全文手动保存', ok ? 'success' : 'error');
        return ok;
    }

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function init() {
        if (state.initialized) return api;

        els.input = pick(IDS.input);
        els.preview = pick(IDS.preview);
        els.exportBtn = pick(IDS.exportBtn);
        els.importInput = pick(IDS.importInput);
        els.importBtn = pick(IDS.importBtn);
        els.stats = pick(IDS.stats);

        if (!els.input && !els.preview) return api; // 未加载该工具面板

        debouncedCommit = (NC.util && NC.util.debounce)
            ? NC.util.debounce(commit, DEBOUNCE_WAIT)
            : null;

        if (els.input) {
            // 恢复本地内容（raw 字符串，兼容 v1）；没有则给示例文档，但不立即写盘
            var raw = null;
            if (NC.storage && NC.storage.getRaw) raw = NC.storage.getRaw(STORAGE_KEY);
            else {
                try { raw = global.localStorage.getItem(STORAGE_KEY); } catch (err) { raw = null; }
            }
            els.input.value = (raw == null || raw === '') ? DEFAULT_TEXT : raw;
            els.input.addEventListener('input', function () {
                state.dirty = true;
                updateStats();
                scheduleCommit();
            });
            els.input.addEventListener('blur', function () {
                if (state.dirty) flushCommit();
            });
            els.input.addEventListener('keydown', function (event) {
                var key = event.key || '';
                if ((key === 's' || key === 'S') && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    flushCommit();
                    toast('已保存到本机', 'success');
                }
            });
        }

        if (els.importBtn && els.importInput) {
            els.importBtn.addEventListener('click', function () { els.importInput.click(); });
        }
        if (els.importInput) {
            els.importInput.addEventListener('change', function () {
                var file = els.importInput.files && els.importInput.files[0];
                handleImportFile(file);
                els.importInput.value = '';
            });
        }
        if (els.exportBtn) {
            els.exportBtn.addEventListener('click', exportMarkdown);
        }
        if (global.addEventListener) {
            global.addEventListener('pagehide', function () {
                if (state.dirty) flushCommit();
            });
            document.addEventListener('visibilitychange', function () {
                if (document.hidden && state.dirty) flushCommit();
            });
        }

        state.initialized = true;
        renderNow();
        updateStats();
        return api;
    }

    var api = {
        init: init,
        render: renderNow,
        saveNow: saveNow,
        exportMarkdown: exportMarkdown,
        importText: function (text) { applyImportedText(String(text == null ? '' : text)); },
        getValue: getValue
    };

    tools.markdown = api;

    // 自动初始化（幂等）
    if (NC.util && NC.util.ready) NC.util.ready(function () { init(); });
    else global.setTimeout(function () { init(); }, 0);
})(window);
