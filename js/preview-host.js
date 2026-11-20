/**
 * preview-host.js — 创意工坊预览宿主
 * 挂载：NC.previewHost
 *
 * 统一负责：blob 生命周期、iframe sandbox、主题消息、错误收集。
 * 约束：生成物（不可信）永远不允许 allow-same-origin；内置工具（可信）才开。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    var SANDBOX_TRUSTED = 'allow-scripts allow-forms allow-modals allow-same-origin';
    var SANDBOX_UNTRUSTED = 'allow-scripts allow-forms allow-modals';
    var MAX_ERRORS = 20;

    function create(frame, options) {
        var opts = options || {};
        var onError = typeof opts.onError === 'function' ? opts.onError : function () {};
        var onReady = typeof opts.onReady === 'function' ? opts.onReady : function () {};
        var objectUrl = null;
        var source = '';
        var kind = 'none';
        var trusted = false;
        var ready = false;
        var errors = [];

        function revoke() {
            if (!objectUrl) return;
            try { global.URL.revokeObjectURL(objectUrl); } catch (err) { /* ignore */ }
            objectUrl = null;
        }

        function setSandbox(isTrusted) {
            trusted = isTrusted === true;
            if (frame) frame.setAttribute('sandbox', trusted ? SANDBOX_TRUSTED : SANDBOX_UNTRUSTED);
        }

        function mountHtml(html, flags) {
            if (!frame) return;
            var f = flags || {};
            source = String(html == null ? '' : html);
            kind = 'html';
            ready = false;
            revoke();
            setSandbox(f.trusted === true);
            frame.removeAttribute('srcdoc');
            var blob = null;
            try { blob = new Blob([source], { type: 'text/html;charset=utf-8' }); } catch (err) { blob = null; }
            if (blob && global.URL && typeof global.URL.createObjectURL === 'function') {
                objectUrl = global.URL.createObjectURL(blob);
                frame.src = objectUrl;
            } else {
                frame.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(source);
            }
            frame.hidden = false;
        }

        function mountUrl(url, flags) {
            if (!frame) return;
            var f = flags || {};
            source = '';
            kind = 'url';
            ready = false;
            revoke();
            setSandbox(f.trusted === true);
            frame.removeAttribute('srcdoc');
            frame.src = url;
            frame.hidden = false;
        }

        function clear() {
            revoke();
            source = '';
            kind = 'none';
            ready = false;
            if (!frame) return;
            frame.removeAttribute('src');
            frame.removeAttribute('srcdoc');
            frame.hidden = true;
        }

        function reload() {
            if (!frame || kind === 'none') return;
            if (kind === 'url') {
                var current = frame.getAttribute('src');
                if (current) frame.src = current;
                return;
            }
            mountHtml(source, { trusted: trusted });
        }

        function postTheme(theme, lite) {
            if (!frame || kind === 'none') return false;
            try {
                frame.contentWindow.postMessage({ type: 'nc-ws-theme', theme: theme, lite: !!lite }, '*');
                return true;
            } catch (err) {
                return false;
            }
        }

        function pushError(message) {
            var entry = { message: String(message || '脚本错误'), at: Date.now() };
            errors.unshift(entry);
            if (errors.length > MAX_ERRORS) errors.length = MAX_ERRORS;
            try { onError(entry, errors.slice()); } catch (err) { /* ignore */ }
        }

        function handleMessage(event) {
            if (!frame || !event || event.source !== frame.contentWindow) return;
            var data = event.data;
            if (!data || typeof data !== 'object') return;
            if (data.type === 'nc-ws-error') {
                pushError(data.message);
            } else if (data.type === 'nc-ws-ready') {
                if (ready) return;
                ready = true;
                try { onReady(); } catch (err) { /* ignore */ }
            }
        }

        function release() { revoke(); }

        global.addEventListener('message', handleMessage);
        global.addEventListener('pagehide', release);
        global.addEventListener('beforeunload', release);

        return {
            mountHtml: mountHtml,
            mountUrl: mountUrl,
            clear: clear,
            reload: reload,
            postTheme: postTheme,
            getSource: function () { return kind === 'html' ? source : ''; },
            getKind: function () { return kind; },
            isTrusted: function () { return trusted; },
            isReady: function () { return ready; },
            getErrors: function () { return errors.slice(); },
            clearErrors: function () { errors = []; },
            release: release,
            destroy: function () {
                global.removeEventListener('message', handleMessage);
                global.removeEventListener('pagehide', release);
                global.removeEventListener('beforeunload', release);
                clear();
            }
        };
    }

    NC.previewHost = { create: create };
})(window);
