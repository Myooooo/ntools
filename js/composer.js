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

    var options = {};
    var state = {
        busy: false,
        composing: false,
        images: []
    };
    var el = {};

    function schema() {
        return NC.schema && NC.schema.chat;
    }

    function maxImages() {
        var schemaChat = schema();
        return schemaChat && schemaChat.LIMITS ? Math.min(5, schemaChat.LIMITS.images || 5) : MAX_IMAGES;
    }

    function renderPreviews() {
        if (!el.previews) return;
        el.previews.textContent = '';
        state.images.forEach(function (image) {
            var item = util.e('div', { class: 'chat-preview', dataset: { id: image.id } });
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

    function removeImage(id) {
        state.images = state.images.filter(function (image) { return String(image.id) !== String(id); });
        renderPreviews();
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

    function onFilesChanged() {
        if (!el.file) return;
        var files = Array.prototype.slice.call(el.file.files || []);
        el.file.value = '';
        if (!files.length) return;
        var images = files.filter(function (file) { return /^image\//.test(file.type || ''); });
        if (!images.length) {
            if (typeof options.onError === 'function') options.onError('请选择图片文件');
            return;
        }
        var room = maxImages() - state.images.length;
        if (room <= 0) {
            ui.alert('图片数量超出限制', '最多上传 ' + maxImages() + ' 张图片，请先移除已选图片。');
            return;
        }
        if (images.length > room) {
            ui.alert('图片数量超出限制', '最多上传 ' + maxImages() + ' 张图片，已自动保留前 ' + room + ' 张。');
            images = images.slice(0, room);
        }
        var chain = Promise.resolve();
        images.forEach(function (file) {
            chain = chain.then(function () {
                return compressImage(file).then(function (dataUrl) {
                    state.images.push({ id: util.uid('img'), dataUrl: dataUrl, name: file.name || 'image' });
                    renderPreviews();
                }).catch(function () {
                    if (typeof options.onError === 'function') options.onError('图片处理失败：' + (file.name || ''));
                });
            });
        });
        chain.then(function () { renderPreviews(); });
    }

    function setBusy(busy) {
        state.busy = !!busy;
        if (el.send) {
            el.send.classList.toggle('is-stop', state.busy);
            el.send.setAttribute('aria-label', state.busy ? '停止生成' : '发送');
            el.send.setAttribute('title', state.busy ? '停止生成' : '发送');
        }
        if (el.inputArea) el.inputArea.classList.toggle('is-busy', state.busy);
    }

    function handleSendOrStop() {
        if (state.busy) {
            if (typeof options.onStop === 'function') options.onStop();
            return;
        }
        var text = el.textarea ? el.textarea.value : '';
        text = text.replace(/\r\n/g, '\n').trim();
        var images = state.images.map(function (image) { return image.dataUrl; });
        if (!text && !images.length) {
            if (el.textarea) el.textarea.focus();
            return;
        }
        if (typeof options.onSend === 'function') options.onSend({ text: text, images: images });
    }

    function onKeyDown(event) {
        if (event.isComposing || state.composing || event.keyCode === 229) return;
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        if (!state.busy) handleSendOrStop();
    }

    function clear() {
        if (el.textarea) el.textarea.value = '';
        state.images = [];
        renderPreviews();
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
        var mobile = !!(global.matchMedia && global.matchMedia('(max-width: 768px)').matches);
        el.textarea.placeholder = mobile
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
        if (!el.textarea || !el.send) return;

        el.send.addEventListener('click', handleSendOrStop);
        if (el.upload && el.file) {
            el.upload.addEventListener('click', function () { el.file.click(); });
            el.file.addEventListener('change', onFilesChanged);
        }
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
        renderPreviews();
        autoGrow();
        updatePlaceholder();
        if (global.matchMedia) {
            var mq = global.matchMedia('(max-width: 768px)');
            if (mq.addEventListener) mq.addEventListener('change', updatePlaceholder);
            else if (mq.addListener) mq.addListener(updatePlaceholder);
        }
    }

    NC.view = NC.view || {};
    NC.view.composer = {
        init: init,
        setBusy: setBusy,
        clear: clear,
        focus: focus,
        setValue: setValue,
        getValue: function () { return el.textarea ? el.textarea.value : ''; },
        getImages: function () { return state.images.map(function (image) { return image.dataUrl; }); },
        removeImage: removeImage,
        handleSendOrStop: handleSendOrStop,
        addFiles: onFilesChanged,
        get stagedImages() { return state.images.slice(); }
    };
})(window);
