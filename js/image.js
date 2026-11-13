/**
 * image.js — 图片 ⇄ Base64 工具（经典脚本，依赖 core.js / ui.js）
 *
 * 页面接线（见 docs/architecture.md）：
 *   #img-dropzone #img-file(input[type=file]) #img-preview(img)
 *   #img-scale(range) #img-scale-label #img-res-original #img-res-target
 *   #img-convert(button) #img-output(textarea) #img-copy(button) #img-restore(button)
 * 使用：ntools-app.js 调用 NC.tools.image.init()；DOM ready 后也会自动初始化（幂等）。
 * 约定：缩放宽高 Math.max(1, …)；复制统一走 NC.util.copyText；无内联事件。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var tools = NC.tools = NC.tools || {};

    var IDS = {
        dropzone: ['img-dropzone'],
        file: ['img-file'],
        preview: ['img-preview'],
        scale: ['img-scale'],
        scaleLabel: ['img-scale-label', 'scale-label'],
        resOriginal: ['img-res-original', 'res-original'],
        resTarget: ['img-res-target', 'res-target'],
        convert: ['img-convert'],
        output: ['img-output', 'base64-output'],
        copy: ['img-copy'],
        restore: ['img-restore']
    };

    var MAX_FILE_BYTES = 20 * 1024 * 1024;
    var MAX_DIMENSION = 8192;
    var MAX_PIXELS = 24 * 1000 * 1000;
    var JPEG_QUALITY = 0.92;
    var ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

    var state = {
        initialized: false,
        image: null,        // 已加载的 Image 对象
        dataUrl: '',        // 当前源图 dataURL
        mime: 'image/png',
        origW: 0,
        origH: 0,
        targetW: 0,
        targetH: 0,
        output: ''
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

    function toast(message, type) {
        if (NC.ui && NC.ui.toast) return NC.ui.toast(message, { type: type || 'info' });
        if (global.console) global.console.log('[image] ' + message);
    }

    function formatBytes(bytes) {
        if (NC.util && NC.util.formatBytes) return NC.util.formatBytes(bytes);
        var n = Number(bytes) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    function currentScale() {
        var raw = els.scale ? parseInt(els.scale.value, 10) : 100;
        if (!isFinite(raw)) raw = 100;
        return Math.min(200, Math.max(1, raw));
    }

    function targetSize() {
        var pct = currentScale();
        var w = Math.max(1, Math.round(state.origW * pct / 100));
        var h = Math.max(1, Math.round(state.origH * pct / 100));
        if (w > MAX_DIMENSION) w = MAX_DIMENSION;
        if (h > MAX_DIMENSION) h = MAX_DIMENSION;
        if (w * h > MAX_PIXELS) {
            var ratio = Math.sqrt(MAX_PIXELS / (w * h));
            w = Math.max(1, Math.round(w * ratio));
            h = Math.max(1, Math.round(h * ratio));
        }
        return { w: w, h: h, pct: pct };
    }

    function setPreviewVisible(visible) {
        if (!els.preview) return;
        els.preview.hidden = !visible;
    }

    function resetOutput(placeholder) {
        state.output = '';
        if (els.output) els.output.value = placeholder || '';
    }

    /* ------------------------------------------------------------------ *
     * 信息展示
     * ------------------------------------------------------------------ */
    function updateInfo() {
        var pct = currentScale();
        var size = targetSize();
        state.targetW = size.w;
        state.targetH = size.h;

        if (els.scaleLabel) els.scaleLabel.textContent = pct + '%';
        if (els.resOriginal) {
            els.resOriginal.textContent = state.origW > 0 ? state.origW + ' × ' + state.origH : '—';
        }
        if (els.resTarget) {
            els.resTarget.textContent = state.origW > 0 ? size.w + ' × ' + size.h : '—';
        }
    }

    /* ------------------------------------------------------------------ *
     * 加载图片
     * ------------------------------------------------------------------ */
    function pickMime(fileType) {
        var type = String(fileType || '').toLowerCase();
        for (var i = 0; i < ALLOWED_MIME.length; i++) {
            if (ALLOWED_MIME[i] === type) return type === 'image/jpg' ? 'image/jpeg' : type;
        }
        return 'image/png';
    }

    function loadFile(file) {
        if (!file) return;
        if (!/^image\//i.test(file.type || '')) {
            toast('请选择图片文件（PNG/JPEG/WebP/GIF/BMP）', 'warn');
            return;
        }
        if (file.size > MAX_FILE_BYTES) {
            toast('图片过大（>20MB），请先压缩再试', 'warn');
            return;
        }
        var mime = pickMime(file.type);
        var reader = new FileReader();
        reader.onload = function () {
            var dataUrl = String(reader.result == null ? '' : reader.result);
            var image = new Image();
            image.onload = function () {
                state.image = image;
                state.dataUrl = dataUrl;
                state.mime = mime;
                state.origW = image.naturalWidth || image.width || 0;
                state.origH = image.naturalHeight || image.height || 0;
                if (els.preview) {
                    els.preview.src = dataUrl;
                    els.preview.alt = file.name ? ('图片预览：' + file.name) : '图片预览';
                    setPreviewVisible(true);
                }
                if (els.scale) els.scale.value = 100;
                resetOutput('点击“转 Base64”生成结果');
                updateInfo();
                toast('已载入图片 ' + state.origW + ' × ' + state.origH, 'success');
            };
            image.onerror = function () { toast('无法解析该图片', 'error'); };
            image.src = dataUrl;
        };
        reader.onerror = function () { toast('读取图片失败', 'error'); };
        try {
            reader.readAsDataURL(file);
        } catch (err) {
            toast('读取图片失败', 'error');
        }
    }

    /* ------------------------------------------------------------------ *
     * 图片 → Base64
     * ------------------------------------------------------------------ */
    function convert() {
        if (!state.image) {
            toast('请先选择或拖入图片', 'warn');
            return false;
        }
        var size = targetSize();
        var canvas = document.createElement('canvas');
        canvas.width = size.w;
        canvas.height = size.h;
        var ctx = canvas.getContext('2d');
        if (!ctx) {
            toast('浏览器不支持 Canvas，无法转换', 'error');
            return false;
        }
        if (state.mime === 'image/jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        try {
            ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);
        } catch (err) {
            toast('绘制图片失败，请更换图片重试', 'error');
            return false;
        }
        var dataUrl = '';
        try {
            dataUrl = canvas.toDataURL(state.mime, JPEG_QUALITY);
        } catch (err) {
            // 部分内核在图片过大时 toDataURL 会失败
            toast('生成 Base64 失败：图片可能过大', 'error');
            return false;
        }
        state.output = dataUrl;
        if (els.output) els.output.value = dataUrl;
        updateInfo();
        toast('已生成 Base64（' + size.w + ' × ' + size.h + '，' + formatBytes(dataUrl.length) + '）', 'success');
        return true;
    }

    /* ------------------------------------------------------------------ *
     * Base64 → 图片 / 复制
     * ------------------------------------------------------------------ */
    function restore() {
        var raw = els.output ? String(els.output.value || '').trim() : '';
        if (!raw) {
            toast('请先粘贴或生成 Base64 内容', 'warn');
            return false;
        }
        if (!/^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(raw)) {
            toast('不是有效的图片 Base64（需以 data:image/...;base64, 开头）', 'error');
            return false;
        }
        var image = new Image();
        image.onload = function () {
            state.image = image;
            state.dataUrl = raw;
            state.mime = (raw.match(/^data:(image\/[^;]+);/i) || [])[1] || 'image/png';
            state.origW = image.naturalWidth || image.width || 0;
            state.origH = image.naturalHeight || image.height || 0;
            state.output = raw;
            if (els.preview) {
                els.preview.src = raw;
                els.preview.alt = 'Base64 还原的图片';
                setPreviewVisible(true);
            }
            if (els.scale) els.scale.value = 100;
            updateInfo();
            toast('已还原为图片 ' + state.origW + ' × ' + state.origH, 'success');
        };
        image.onerror = function () { toast('无法解析该 Base64 图片数据', 'error'); };
        image.src = raw;
        return true;
    }

    function copyOutput() {
        var value = els.output ? String(els.output.value || '') : '';
        if (!value) {
            toast('还没有可复制的内容，请先生成 Base64', 'warn');
            return false;
        }
        var promise = (NC.util && NC.util.copyText)
            ? NC.util.copyText(value)
            : Promise.resolve(false);
        promise.then(function (ok) {
            if (ok) {
                toast('已复制到剪贴板', 'success');
                return;
            }
            toast('复制失败，可能是权限限制；可在下方文本框中手动全选复制', 'warn');
        }, function () {
            toast('复制失败，请手动全选复制', 'error');
        });
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 拖拽 / 初始化
     * ------------------------------------------------------------------ */
    function bindDropzone() {
        var zone = els.dropzone;
        if (!zone) return;

        zone.addEventListener('click', function (event) {
            if (!els.file) return;
            if (event.target === els.file) return;
            els.file.click();
        });
        zone.addEventListener('keydown', function (event) {
            if (!els.file) return;
            if (event.key === 'Enter' || event.key === ' ' || event.keyCode === 13 || event.keyCode === 32) {
                event.preventDefault();
                els.file.click();
            }
        });
        ['dragenter', 'dragover'].forEach(function (type) {
            zone.addEventListener(type, function (event) {
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                zone.classList.add('is-dragover');
            });
        });
        ['dragleave', 'dragend'].forEach(function (type) {
            zone.addEventListener(type, function () { zone.classList.remove('is-dragover'); });
        });
        zone.addEventListener('drop', function (event) {
            event.preventDefault();
            zone.classList.remove('is-dragover');
            var files = event.dataTransfer && event.dataTransfer.files;
            if (files && files.length) loadFile(files[0]);
        });
    }

    function init() {
        if (state.initialized) return api;

        els.dropzone = pick(IDS.dropzone);
        els.file = pick(IDS.file);
        els.preview = pick(IDS.preview);
        els.scale = pick(IDS.scale);
        els.scaleLabel = pick(IDS.scaleLabel);
        els.resOriginal = pick(IDS.resOriginal);
        els.resTarget = pick(IDS.resTarget);
        els.convert = pick(IDS.convert);
        els.output = pick(IDS.output);
        els.copy = pick(IDS.copy);
        els.restore = pick(IDS.restore);

        if (!els.dropzone && !els.output && !els.convert) return api; // 未加载该工具面板

        bindDropzone();
        if (els.file) {
            els.file.addEventListener('change', function () {
                var files = els.file.files;
                if (files && files.length) loadFile(files[0]);
                els.file.value = '';
            });
        }
        if (els.scale) {
            els.scale.addEventListener('input', updateInfo);
            els.scale.addEventListener('change', updateInfo);
        }
        if (els.convert) els.convert.addEventListener('click', convert);
        if (els.copy) els.copy.addEventListener('click', copyOutput);
        if (els.restore) els.restore.addEventListener('click', restore);
        if (els.dropzone && !els.dropzone.hasAttribute('tabindex') && !els.dropzone.getAttribute('role')) {
            els.dropzone.setAttribute('tabindex', '0');
            els.dropzone.setAttribute('role', 'button');
        }

        state.initialized = true;
        setPreviewVisible(false);
        updateInfo();
        return api;
    }

    var api = {
        init: init,
        loadFile: loadFile,
        convert: convert,
        restore: restore,
        copyOutput: copyOutput,
        updateInfo: updateInfo,
        getState: function () {
            return {
                initialized: state.initialized,
                origW: state.origW,
                origH: state.origH,
                targetW: state.targetW,
                targetH: state.targetH,
                hasImage: !!state.image,
                outputLength: state.output.length
            };
        }
    };

    tools.image = api;

    // 自动初始化（幂等）
    if (NC.util && NC.util.ready) NC.util.ready(function () { init(); });
    else global.setTimeout(function () { init(); }, 0);
})(window);
