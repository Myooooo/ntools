/**
 * composer.js — 输入区：发送/停止、IME 守卫、图片选择与压缩、预览管理
 * 经典脚本，依赖 core.js、icons.js、ui.js。挂载到 NC.view.composer。
 *
 * 行为契约：
 * - Enter 发送 / Shift+Enter 换行；中文输入法组合态 Enter 不发送；
 * - 空白且无图片不发送；
 * - 图片最多 5 张、最长边 1024、JPEG 质量 0.8；
 * - 流式期间不锁定输入框（可继续输入/选图），发送按钮切换为停止。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;
    var icons = NC.icons;
    var ui = NC.ui;

    var MAX_IMAGES = 5;
    var MAX_EDGE = 1024;
    var JPEG_QUALITY = 0.8;
    var MAX_FILES = 3;
    var MAX_FILE_CHARS = 50000;
    var MAX_TOTAL_FILE_CHARS = 100000;

    var options = {};
    var state = {
        busy: false,
        composing: false,
        images: [],
        files: [],
        capabilities: { vision: true, files: false },
        enteringId: null,
        leaving: Object.create(null)
    };
    var el = {};

    function schema() {
        return NC.schema && NC.schema.chat;
    }

    function visionEnabled() {
        return !state.capabilities || state.capabilities.vision !== false;
    }

    function filesEnabled() {
        return !!(state.capabilities && state.capabilities.files);
    }

    function isTextFile(file) {
        var type = String(file && file.type || '').toLowerCase();
        if (type.indexOf('text/') === 0) return true;
        if (type === 'application/json' || type === 'application/xml' || type === 'application/x-yaml') return true;
        return /\.(txt|md|markdown|json|csv|log|ya?ml|xml|html?|css|js|ts|tsx|jsx|py|java|go|rs|sh|ini|conf)$/i.test(file && file.name || '');
    }

    function formatBytes(size) {
        var n = Number(size) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function readTextFile(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(new Error('read-error')); };
            reader.readAsText(file);
        });
    }

    function maxImages() {
        var schemaChat = schema();
        return schemaChat && schemaChat.LIMITS ? Math.min(5, schemaChat.LIMITS.images || 5) : MAX_IMAGES;
    }

    function prefersReducedMotionNow() {
        try {
            if (document.documentElement.getAttribute('data-lite') === 'true') return true;
            return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (err) {
            return false;
        }
    }

    function renderPreviews() {
        if (!el.previews) return;
        el.previews.textContent = '';
        state.images.forEach(function (image) {
            var item = util.e('div', { class: 'chat-preview', dataset: { id: image.id } });
            if (state.enteringId != null && String(image.id) === String(state.enteringId)) {
                item.classList.add('is-entering');
                state.enteringId = null;
            }
            var img = util.e('img', {
                class: 'chat-preview__img',
                alt: '待发送图片',
                title: '点击预览'
            });
            img.src = image.dataUrl;
            img.addEventListener('click', function () {
                if (typeof options.onPreviewImage === 'function') options.onPreviewImage(image.dataUrl);
            });
            var removeBtn = util.e('button', {
                type: 'button',
                class: 'chat-preview__remove',
                title: '移除图片',
                'aria-label': '移除图片',
                dataset: { id: image.id }
            }, [icons.el('x', 12)]);
            item.appendChild(img);
            item.appendChild(removeBtn);
            el.previews.appendChild(item);
        });
        el.previews.hidden = state.images.length === 0;
    }

    function renderFilePreviews() {
        if (!el.files) return;
        el.files.textContent = '';
        state.files.forEach(function (file) {
            var chip = util.e('span', { class: 'chat-file-chip', dataset: { id: file.id } });
            chip.appendChild(util.e('span', { class: 'chat-file-chip__icon' }, [icons.el('file', 13)]));
            var meta = util.e('span', { class: 'chat-file-chip__meta' });
            meta.appendChild(util.e('span', { class: 'chat-file-chip__name', text: file.name }));
            meta.appendChild(util.e('span', { class: 'chat-file-chip__size', text: formatBytes(file.size) }));
            chip.appendChild(meta);
            var remove = util.e('button', {
                type: 'button',
                class: 'chat-file-chip__remove',
                title: '移除附件',
                'aria-label': '移除附件：' + file.name
            }, [icons.el('x', 11)]);
            remove.addEventListener('click', function () { removeFile(file.id); });
            chip.appendChild(remove);
            el.files.appendChild(chip);
        });
        el.files.hidden = state.files.length === 0;
    }

    function removeFile(id) {
        var key = String(id);
        state.files = state.files.filter(function (file) { return String(file.id) !== key; });
        renderFilePreviews();
    }

    function removeImage(id) {
        var key = String(id);
        if (state.leaving[key]) return;
        if (prefersReducedMotionNow()) {
            state.images = state.images.filter(function (image) { return String(image.id) !== key; });
            renderPreviews();
            return;
        }
        var node = null;
        if (el.previews) {
            Array.prototype.forEach.call(el.previews.children, function (child) {
                if (!node && child.getAttribute('data-id') === key) node = child;
            });
        }
        state.leaving[key] = true;
        if (node) node.classList.add('is-leaving');
        global.setTimeout(function () {
            delete state.leaving[key];
            state.images = state.images.filter(function (image) { return String(image.id) !== key; });
            renderPreviews();
        }, 130);
    }

    function autoGrow() {
        if (!el.textarea) return;
        el.textarea.style.height = 'auto';
        var next = Math.min(el.textarea.scrollHeight || 0, 200);
        el.textarea.style.height = next + 'px';
    }

    function readFile(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function (event) { resolve(event.target.result); };
            reader.onerror = function () { reject(new Error('read-error')); };
            reader.readAsDataURL(file);
        });
    }

    /** 压缩：最长边 1024，JPEG 0.8；失败时回退原图 dataURL。 */
    function compressImage(file) {
        return readFile(file).then(function (dataUrl) {
            return new Promise(function (resolve) {
                var image = new Image();
                image.onload = function () {
                    try {
                        var width = image.width;
                        var height = image.height;
                        if (width > MAX_EDGE || height > MAX_EDGE) {
                            if (width > height) {
                                height = Math.round((height / width) * MAX_EDGE);
                                width = MAX_EDGE;
                            } else {
                                width = Math.round((width / height) * MAX_EDGE);
                                height = MAX_EDGE;
                            }
                        }
                        width = Math.max(1, width);
                        height = Math.max(1, height);
                        var canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        var ctx = canvas.getContext('2d');
                        ctx.drawImage(image, 0, 0, width, height);
                        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
                    } catch (err) {
                        resolve(dataUrl);
                    }
                };
                image.onerror = function () { resolve(dataUrl); };
                image.src = dataUrl;
            });
        });
    }

    function addFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) return;
        var images = files.filter(function (file) { return /^image\//.test(file.type || ''); });
        var docs = files.filter(function (file) { return !/^image\//.test(file.type || ''); });

        if (images.length && !visionEnabled()) {
            ui.toast('当前端点未开启图片输入', { type: 'warn' });
        }
        if (docs.length && !filesEnabled()) {
            ui.toast('当前端点未开启文件附件', { type: 'warn' });
        }
        images = visionEnabled() ? images : [];
        docs = filesEnabled() ? docs : [];

        // 文本附件：只读入本地文本，发送时作为上下文附加，不直接上传二进制
        var docRoom = MAX_FILES - state.files.length;
        if (docs.length && docRoom <= 0) {
            ui.alert('附件数量超出限制', '最多添加 ' + MAX_FILES + ' 个文件附件，请先移除已选附件。');
            docs = [];
        }
        if (docs.length > docRoom) {
            ui.alert('附件数量超出限制', '最多添加 ' + MAX_FILES + ' 个文件附件，已自动保留前 ' + docRoom + ' 个。');
            docs = docs.slice(0, Math.max(0, docRoom));
        }
        var totalChars = state.files.reduce(function (sum, file) { return sum + (file.text || '').length; }, 0);
        var chain = Promise.resolve();
        docs.forEach(function (file) {
            chain = chain.then(function () {
                if (!isTextFile(file)) {
                    if (typeof options.onError === 'function') options.onError('仅支持文本类附件：' + (file.name || ''));
                    return;
                }
                if (file.size > 600 * 1024) {
                    ui.alert('附件过大', '「' + (file.name || '附件') + '」超过 600KB，请精简后再试。');
                    return;
                }
                return readTextFile(file).then(function (text) {
                    var body = String(text || '').slice(0, MAX_FILE_CHARS);
                    if (!body.trim()) {
                        if (typeof options.onError === 'function') options.onError('附件内容为空：' + (file.name || ''));
                        return;
                    }
                    var room = MAX_TOTAL_FILE_CHARS - totalChars;
                    if (room <= 0) {
                        ui.alert('附件总长度超限', '文本附件合计最多 ' + MAX_TOTAL_FILE_CHARS + ' 字符。');
                        return;
                    }
                    body = body.slice(0, room);
                    totalChars += body.length;
                    var attachment = {
                        id: util.uid('file'),
                        name: String(file.name || '附件').slice(0, 160),
                        size: file.size || body.length,
                        type: file.type || '',
                        text: body
                    };
                    state.files.push(attachment);
                    renderFilePreviews();
                }).catch(function () {
                    if (typeof options.onError === 'function') options.onError('附件读取失败：' + (file.name || ''));
                });
            });
        });

        var roomImages = maxImages() - state.images.length;
        if (images.length && roomImages <= 0) {
            ui.alert('图片数量超出限制', '最多上传 ' + maxImages() + ' 张图片，请先移除已选图片。');
            images = [];
        }
        if (images.length > roomImages) {
            ui.alert('图片数量超出限制', '最多上传 ' + maxImages() + ' 张图片，已自动保留前 ' + roomImages + ' 张。');
            images = images.slice(0, Math.max(0, roomImages));
        }
        images.forEach(function (file) {
            chain = chain.then(function () {
                return compressImage(file).then(function (dataUrl) {
                    var image = { id: util.uid('img'), dataUrl: dataUrl, name: file.name || 'image' };
                    state.images.push(image);
                    state.enteringId = image.id;
                    renderPreviews();
                }).catch(function () {
                    if (typeof options.onError === 'function') options.onError('图片处理失败：' + (file.name || ''));
                });
            });
        });
    }

    function onFilesChanged() {
        if (!el.file) return;
        var files = Array.prototype.slice.call(el.file.files || []);
        el.file.value = '';
        addFiles(files);
    }

    function bindDropAndPaste() {
        if (el.inputArea) {
            ['dragenter', 'dragover'].forEach(function (name) {
                el.inputArea.addEventListener(name, function (event) {
                    if (!event.dataTransfer) return;
                    var types = Array.prototype.slice.call(event.dataTransfer.types || []);
                    if (types.indexOf('Files') === -1) return;
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                });
            });
            el.inputArea.addEventListener('drop', function (event) {
                if (!event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return;
                event.preventDefault();
                addFiles(event.dataTransfer.files);
            });
        }
        if (el.textarea) {
            el.textarea.addEventListener('paste', function (event) {
                var data = event.clipboardData;
                if (!data) return;
                var files = [];
                Array.prototype.forEach.call(data.items || [], function (item) {
                    if (!item || item.kind !== 'file') return;
                    var file = item.getAsFile();
                    if (!file) return;
                    if (/^image\//.test(item.type || '') || filesEnabled()) files.push(file);
                });
                if (!files.length) return;
                event.preventDefault();
                addFiles(files);
            });
        }
    }

    function setCapabilities(caps) {
        state.capabilities = {
            vision: !caps || caps.vision !== false,
            files: !!(caps && caps.files)
        };
        var canUpload = state.capabilities.vision || state.capabilities.files;
        if (el.upload) {
            el.upload.disabled = !canUpload;
            el.upload.classList.toggle('is-disabled', !canUpload);
            var uploadTitle = '当前端点未开启图片/文件输入';
            if (state.capabilities.vision && state.capabilities.files) uploadTitle = '上传图片或文本附件';
            else if (state.capabilities.vision) uploadTitle = '上传图片';
            else if (state.capabilities.files) uploadTitle = '上传文本附件';
            el.upload.setAttribute('title', uploadTitle);
            el.upload.setAttribute('aria-disabled', canUpload ? 'false' : 'true');
        }
        if (el.file) {
            var accepts = [];
            if (state.capabilities.vision) accepts.push('image/*');
            if (state.capabilities.files) accepts.push('.txt,.md,.markdown,.json,.csv,.log,.yml,.yaml,.xml');
            el.file.setAttribute('accept', accepts.join(','));
        }
        if (!state.capabilities.vision) {
            state.images = [];
            renderPreviews();
        }
        if (!state.capabilities.files) {
            state.files = [];
            renderFilePreviews();
        }
    }

    function setBusy(busy) {
        state.busy = !!busy;
        if (el.send) {
            el.send.classList.toggle('is-stop', state.busy);
            el.send.setAttribute('aria-label', state.busy ? '停止生成' : '发送');
            el.send.setAttribute('title', state.busy ? '停止生成' : '发送');
        }
        if (el.inputArea) el.inputArea.classList.toggle('is-busy', state.busy);
        /* 生成期间禁用输入：只能点「停止」打断（readOnly 保留焦点与选区，不会闪一下灰） */
        if (el.textarea) {
            el.textarea.readOnly = state.busy;
            el.textarea.setAttribute('aria-readonly', state.busy ? 'true' : 'false');
            el.textarea.classList.toggle('is-readonly', state.busy);
        }
    }

    function handleSendOrStop() {
        if (state.busy) {
            if (typeof options.onStop === 'function') options.onStop();
            return;
        }
        var text = el.textarea ? el.textarea.value : '';
        text = text.replace(/\r\n/g, '\n').trim();
        var images = state.images.map(function (image) { return image.dataUrl; });
        var files = state.files.map(function (file) {
            return { id: file.id, name: file.name, size: file.size, type: file.type, text: file.text };
        });
        if (!text && !images.length && !files.length) {
            if (el.textarea) el.textarea.focus();
            return;
        }
        if (typeof options.onSend === 'function') options.onSend({ text: text, images: images, files: files });
    }

    function onKeyDown(event) {
        if (event.isComposing || state.composing || event.keyCode === 229) return;
        /* 生成中不接受回车：发送/停止只走按钮，避免误触把回复打断 */
        if (state.busy) return;
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        if (!state.busy) handleSendOrStop();
    }

    function clear() {
        if (el.textarea) el.textarea.value = '';
        state.images = [];
        state.files = [];
        renderPreviews();
        renderFilePreviews();
        autoGrow();
        focus();
    }

    function focus() {
        if (el.textarea) {
            try { el.textarea.focus(); } catch (err) { /* ignore */ }
        }
    }

    function setValue(value) {
        if (!el.textarea) return;
        el.textarea.value = value == null ? '' : String(value);
        autoGrow();
        focus();
    }

    function updatePlaceholder() {
        if (!el.textarea) return;
        var width = el.inputArea && el.inputArea.clientWidth ? el.inputArea.clientWidth : 0;
        var compact = width
            ? width < 560
            : !!(global.matchMedia && global.matchMedia('(max-width: 768px)').matches);
        el.textarea.placeholder = compact
            ? '输入消息…'
            : '输入消息，Enter 发送，Shift + Enter 换行';
    }

    function init(opts) {
        options = opts || {};
        el.inputArea = document.getElementById('input-area-container');
        el.textarea = document.getElementById('user-input');
        el.send = document.getElementById('send-btn');
        el.upload = document.getElementById('upload-btn');
        el.file = document.getElementById('image-input');
        el.previews = document.getElementById('image-preview-container');
        el.files = document.getElementById('file-preview-container');
        if (!el.textarea || !el.send) return;

        el.send.addEventListener('click', handleSendOrStop);
        if (el.upload && el.file) {
            el.upload.addEventListener('click', function () { el.file.click(); });
            el.file.addEventListener('change', onFilesChanged);
        }
        el.textarea.setAttribute('enterkeyhint', 'send');
        el.textarea.addEventListener('keydown', onKeyDown);
        el.textarea.addEventListener('input', autoGrow);
        el.textarea.addEventListener('compositionstart', function () { state.composing = true; });
        el.textarea.addEventListener('compositionend', function () { state.composing = false; });
        if (el.previews) {
            el.previews.addEventListener('click', function (event) {
                var button = event.target && event.target.closest ? event.target.closest('.chat-preview__remove') : null;
                if (button) removeImage(button.getAttribute('data-id'));
            });
        }
        bindDropAndPaste();
        renderPreviews();
        renderFilePreviews();
        autoGrow();
        updatePlaceholder();
        if (el.inputArea && global.ResizeObserver) {
            try {
                var observer = new global.ResizeObserver(updatePlaceholder);
                observer.observe(el.inputArea);
            } catch (err) { /* ignore */ }
        }
        if (global.addEventListener) {
            global.addEventListener('resize', updatePlaceholder);
        }
    }

    NC.view = NC.view || {};
    NC.view.composer = {
        init: init,
        setBusy: setBusy,
        setCapabilities: setCapabilities,
        clear: clear,
        focus: focus,
        setValue: setValue,
        getValue: function () { return el.textarea ? el.textarea.value : ''; },
        getImages: function () { return state.images.map(function (image) { return image.dataUrl; }); },
        getFiles: function () {
            return state.files.map(function (file) {
                return { id: file.id, name: file.name, size: file.size, type: file.type, text: file.text };
            });
        },
        clearFiles: function () {
            state.files = [];
            renderFilePreviews();
        },
        removeImage: removeImage,
        handleSendOrStop: handleSendOrStop,
        addFiles: addFiles,
        removeFile: removeFile,
        get stagedImages() { return state.images.slice(); }
    };
})(window);
