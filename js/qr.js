/**
 * qr.js — 二维码工具（经典脚本，依赖 core.js / ui.js / js/qrcode.min.js）
 *
 * 页面接线（见 docs/architecture.md）：
 *   #qr-input(input) #qr-size(select) #qr-generate(button)
 *   #qr-download(button) #qr-output(div) #qr-placeholder(div)
 * 使用：ntools-app.js 调用 NC.tools.qr.init()；本文件也会在 DOM ready 后自动初始化（幂等）。
 * 约定：无内联事件；生成失败/内容为空统一走 NC.ui.toast，不弹 alert。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var tools = NC.tools = NC.tools || {};

    var IDS = {
        input: ['qr-input', 'qr-text'],
        size: ['qr-size'],
        generate: ['qr-generate'],
        download: ['qr-download'],
        output: ['qr-output', 'qrcode'],
        placeholder: ['qr-placeholder']
    };

    var MIN_SIZE = 96;
    var MAX_SIZE = 1024;
    var DEFAULT_SIZE = 256;

    var state = {
        initialized: false,
        text: '',
        size: DEFAULT_SIZE,
        dataUrl: ''
    };
    var els = {};

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

    function clamp(value, min, max) {
        if (NC.util && NC.util.clamp) return NC.util.clamp(value, min, max);
        var n = Number(value);
        if (!isFinite(n)) n = min;
        return Math.min(max, Math.max(min, n));
    }

    function toast(message, type) {
        if (NC.ui && NC.ui.toast) return NC.ui.toast(message, { type: type || 'info' });
        if (global.console) global.console.log('[qr] ' + message);
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function stamp() {
        var d = new Date();
        return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
            pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    function clearOutput() {
        if (!els.output) return;
        while (els.output.firstChild) els.output.removeChild(els.output.firstChild);
    }

    function setOutputVisible(visible) {
        if (els.placeholder) els.placeholder.hidden = !!visible;
        if (els.output) els.output.hidden = !visible;
    }

    function updateDownloadState() {
        if (!els.download) return;
        els.download.disabled = !state.dataUrl;
        if (state.dataUrl) els.download.removeAttribute('aria-disabled');
        else els.download.setAttribute('aria-disabled', 'true');
    }

    function readSize() {
        var raw = els.size ? els.size.value : DEFAULT_SIZE;
        var n = parseInt(raw, 10);
        if (!isFinite(n) || n <= 0) n = DEFAULT_SIZE;
        return Math.round(clamp(n, MIN_SIZE, MAX_SIZE));
    }

    function dataUrlToBlob(dataUrl) {
        var parts = String(dataUrl).split(',');
        var header = parts[0] || '';
        var match = header.match(/:(.*?);/);
        var mime = match ? match[1] : 'image/png';
        var binary = global.atob(parts[1] || '');
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    /* ------------------------------------------------------------------ *
     * 生成 / 下载
     * ------------------------------------------------------------------ */
    function captureDataUrl(callback, retries) {
        var attempt = retries == null ? 6 : retries;
        var canvas = els.output ? els.output.querySelector('canvas') : null;
        var img = els.output ? els.output.querySelector('img') : null;
        var dataUrl = '';
        if (canvas && typeof canvas.toDataURL === 'function') {
            try { dataUrl = canvas.toDataURL('image/png'); } catch (err) { dataUrl = ''; }
        }
        if (!dataUrl && img && img.src && img.src.indexOf('data:image') === 0) dataUrl = img.src;
        if (!dataUrl && attempt > 0) {
            global.setTimeout(function () { captureDataUrl(callback, attempt - 1); }, 60);
            return;
        }
        callback(dataUrl);
    }

    function generate() {
        if (!state.initialized) init();
        if (!els.output) return false;

        var text = els.input && typeof els.input.value === 'string' ? els.input.value.trim() : '';
        if (!text) {
            toast('请输入要生成二维码的内容', 'warn');
            if (els.input) els.input.focus();
            return false;
        }
        if (typeof global.QRCode === 'undefined') {
            toast('二维码组件未加载（js/qrcode.min.js）', 'error');
            return false;
        }

        var size = readSize();
        clearOutput();
        try {
            new global.QRCode(els.output, {
                text: text,
                width: size,
                height: size,
                colorDark: '#0b0f16',
                colorLight: '#ffffff',
                correctLevel: global.QRCode.CorrectLevel ? global.QRCode.CorrectLevel.M : 2
            });
        } catch (err) {
            clearOutput();
            setOutputVisible(false);
            state.dataUrl = '';
            updateDownloadState();
            toast('生成失败：内容可能过长，请缩短后重试', 'error');
            return false;
        }

        captureDataUrl(function (dataUrl) {
            if (!dataUrl) {
                setOutputVisible(false);
                state.dataUrl = '';
                updateDownloadState();
                toast('生成失败，请缩短内容后重试', 'error');
                return;
            }
            state.text = text;
            state.size = size;
            state.dataUrl = dataUrl;
            setOutputVisible(true);
            if (els.output) els.output.setAttribute('aria-label', '二维码：' + text);
            updateDownloadState();
        });
        return true;
    }

    function download() {
        if (!state.dataUrl) {
            toast('请先生成二维码', 'warn');
            return false;
        }
        var filename = 'qrcode-' + stamp() + '.png';
        var ok = false;
        try {
            if (NC.util && NC.util.downloadBlob) {
                ok = NC.util.downloadBlob(filename, dataUrlToBlob(state.dataUrl));
            } else {
                var link = document.createElement('a');
                link.href = state.dataUrl;
                link.download = filename;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                global.setTimeout(function () {
                    if (link.parentNode) link.parentNode.removeChild(link);
                }, 1200);
                ok = true;
            }
        } catch (err) {
            ok = false;
        }
        toast(ok ? '已触发下载，请到浏览器下载目录查看' : '下载失败，可右键二维码图片另存为',
            ok ? 'success' : 'error');
        return ok;
    }

    /* ------------------------------------------------------------------ *
     * 初始化
     * ------------------------------------------------------------------ */
    function init() {
        if (state.initialized) return api;

        els.input = pick(IDS.input);
        els.size = pick(IDS.size);
        els.generate = pick(IDS.generate);
        els.download = pick(IDS.download);
        els.output = pick(IDS.output);
        els.placeholder = pick(IDS.placeholder);

        if (!els.output && !els.generate) return api; // 未加载该工具面板

        if (els.generate) els.generate.addEventListener('click', generate);
        if (els.download) els.download.addEventListener('click', download);
        if (els.size) {
            els.size.addEventListener('change', function () {
                if (state.dataUrl || (els.input && els.input.value.trim())) generate();
            });
        }
        if (els.input) {
            els.input.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter' && event.keyCode !== 13) return;
                if (event.isComposing || event.keyCode === 229) return; // 中文输入法选词
                event.preventDefault();
                generate();
            });
        }

        state.initialized = true;
        setOutputVisible(false);
        updateDownloadState();
        return api;
    }

    var api = {
        init: init,
        generate: generate,
        download: download,
        getState: function () {
            return { text: state.text, size: state.size, dataUrl: state.dataUrl, initialized: state.initialized };
        }
    };

    tools.qr = api;

    // 自动初始化（幂等）：外壳即使忘记调用 init() 也不会白屏
    if (NC.util && NC.util.ready) NC.util.ready(function () { init(); });
    else global.setTimeout(function () { init(); }, 0);
})(window);
