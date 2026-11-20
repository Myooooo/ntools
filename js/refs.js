/**
 * refs.js — 笔记 / 待办引用解析与渲染（挂载 NC.refs）
 *
 * 语法：
 *   [[笔记标题]] / [[笔记标题|别名]] / [[笔记标题#小节]]
 *   [[note:<id>|标题]] / [[todo:<id>|标题]]
 *   ![[...]] 仍由笔记视图处理（图片 / 嵌入）
 *
 * 渲染输出只依赖 DOMPurify 允许的标签，点击/勾选通过 bind() 事件委托处理。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    var REF_RE = /^(!?)\[\[([^\[\]\n]{1,300})\]\]/;

    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(text) {
        return escapeHtml(text).replace(/`/g, '&#96;');
    }

    function parseRef(raw) {
        var match = REF_RE.exec(String(raw || ''));
        if (!match) return null;
        var inner = match[2];
        var alias = '';
        var anchor = '';
        var pipe = inner.indexOf('|');
        if (pipe > -1) { alias = inner.slice(pipe + 1).trim(); inner = inner.slice(0, pipe); }
        var hash = inner.indexOf('#');
        if (hash > -1) { anchor = inner.slice(hash + 1).trim(); inner = inner.slice(0, hash); }
        var target = inner.trim();
        if (!target) return null;
        var type = 'note';
        var id = '';
        if (/^todo:/i.test(target)) { type = 'todo'; id = target.slice(5).trim(); }
        else if (/^note:/i.test(target)) { type = 'note'; id = target.slice(5).trim(); }
        return {
            raw: match[0],
            embed: match[1] === '!',
            type: type,
            id: id,
            target: target,
            title: id ? '' : target,
            alias: alias,
            anchor: anchor
        };
    }

    function parse(text) {
        var source = String(text == null ? '' : text);
        var out = [];
        var re = /!?\[\[([^\[\]\n]{1,300})\]\]/g;
        var m;
        while ((m = re.exec(source))) {
            var ref = parseRef(m[0]);
            if (!ref) continue;
            ref.index = m.index;
            ref.end = m.index + m[0].length;
            out.push(ref);
        }
        return out;
    }

    function ctxStores(ctx) {
        ctx = ctx || {};
        return {
            notes: ctx.notes || (NC.store && NC.store.notes) || null,
            todo: ctx.todo || (NC.store && NC.store.todo) || null
        };
    }

    function resolve(ref, ctx) {
        var stores = ctxStores(ctx);
        if (!ref) return null;
        if (ref.type === 'todo') {
            if (!stores.todo || !ref.id || typeof stores.todo.getTask !== 'function') return null;
            var task = stores.todo.getTask(ref.id);
            if (!task) return { missing: true, type: 'todo', id: ref.id, title: ref.alias || '已删除的待办' };
            return {
                type: 'todo', id: task.id, title: task.title || ref.alias || '未命名待办',
                done: !!task.completedAt, deleted: !!task.deletedAt, task: task
            };
        }
        if (!stores.notes) return null;
        var note = null;
        if (ref.id) {
            note = typeof stores.notes.getNote === 'function' ? stores.notes.getNote(ref.id) : null;
        } else if (ref.title && typeof stores.notes.resolveTitle === 'function') {
            var id = stores.notes.resolveTitle(ref.title);
            note = id && stores.notes.getNote ? stores.notes.getNote(id) : null;
        }
        if (!note) return { missing: true, type: 'note', id: ref.id, title: ref.alias || (ref.title || '未找到笔记') };
        return {
            type: 'note', id: note.id, title: note.title || ref.title || '未命名笔记',
            deleted: !!note.deletedAt, note: note
        };
    }

    function chipHtml(ref, ctx) {
        var resolved = resolve(ref, ctx) || { missing: true, type: ref.type, title: ref.alias || ref.target };
        var label = escapeHtml(ref.alias || resolved.title || ref.target || '');
        if (ref.type === 'todo') {
            var deleted = !resolved || resolved.missing || resolved.deleted;
            var done = !!(resolved && resolved.done);
            var cls = 'nc-ref nc-ref--todo' + (done ? ' is-done' : '') + (deleted ? ' is-missing' : '');
            var title = deleted ? '待办已删除' : (done ? '已完成，点击取消' : '点击标记完成');
            return '<label class="' + cls + '" data-ref-todo="' + escapeAttr(resolved.id || ref.id) + '" title="' + escapeAttr(title) + '">' +
                '<input type="checkbox" data-ref-toggle="' + escapeAttr(resolved.id || ref.id) + '"' +
                (done ? ' checked' : '') + (deleted ? ' disabled' : '') + '>' +
                '<span class="nc-ref__label">' + label + '</span></label>';
        }
        var missing = !resolved || resolved.missing || resolved.deleted;
        var noteCls = 'nc-ref nc-ref--note' + (missing ? ' is-missing' : '');
        var noteTitle = missing ? '笔记不存在或已删除' : ('打开笔记：' + (resolved.title || ref.title || ''));
        return '<span class="' + noteCls + '" role="link" tabindex="0" data-ref-note="' +
            escapeAttr(resolved.id || ref.id || '') + '" data-ref-title="' + escapeAttr(ref.title || '') +
            '" title="' + escapeAttr(noteTitle) + '">' + label + '</span>';
    }

    function ensureExtension() {
        if (NC.refs._installed) return;
        if (!global.marked || typeof global.marked.use !== 'function') return;
        NC.refs._installed = true;
        global.marked.use({
            extensions: [{
                name: 'ncRefs',
                level: 'inline',
                start: function (src) {
                    var a = src.indexOf('[[');
                    var b = src.indexOf('![[', a < 0 ? 0 : a);
                    if (a < 0 && b < 0) return undefined;
                    if (a < 0) return b;
                    if (b < 0) return a;
                    return Math.min(a, b);
                },
                tokenizer: function (src) {
                    var match = REF_RE.exec(src);
                    if (!match) return undefined;
                    var ref = parseRef(match[0]);
                    if (!ref) return undefined;
                    return { type: 'ncRef', raw: match[0], ref: ref };
                },
                renderer: function (token) {
                    if (token.ref.embed) {
                        return '<span class="note-embed" data-file="' + escapeAttr(token.ref.target) + '">' + escapeHtml(token.ref.target) + '</span>';
                    }
                    return chipHtml(token.ref, NC.refs._context);
                }
            }]
        });
    }

    function renderMarkdown(host, text, ctx, handlers) {
        if (!host) return '';
        ensureExtension();
        NC.refs._context = ctx || {};
        var source = String(text == null ? '' : text);
        var html = source;
        try {
            if (global.marked) {
                if (global.marked.setOptions) global.marked.setOptions({ gfm: true, breaks: true });
                html = global.marked.parse(source);
            }
            if (global.DOMPurify) html = global.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
        } catch (err) {
            html = '<p class="nc-field-hint">Markdown 渲染失败：' + escapeHtml(err && err.message ? err.message : err) + '</p>';
        } finally {
            NC.refs._context = null;
        }
        host.innerHTML = html;
        if (handlers) bind(host, handlers);
        return html;
    }

    function bind(host, handlers) {
        if (!host || host.__ncRefsBound) return;
        host.__ncRefsBound = true;
        host.addEventListener('click', function (event) {
            var note = event.target.closest ? event.target.closest('.nc-ref--note') : null;
            if (note) {
                event.preventDefault();
                if (note.classList.contains('is-missing')) return;
                if (handlers && typeof handlers.openNote === 'function') {
                    handlers.openNote(note.getAttribute('data-ref-note') || '', note.getAttribute('data-ref-title') || '');
                }
            }
        });
        host.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            var note = event.target.closest ? event.target.closest('.nc-ref--note') : null;
            if (!note) return;
            event.preventDefault();
            note.click();
        });
        host.addEventListener('change', function (event) {
            var box = event.target;
            if (!box || !box.getAttribute || !box.getAttribute('data-ref-toggle')) return;
            if (handlers && typeof handlers.toggleTodo === 'function') {
                handlers.toggleTodo(box.getAttribute('data-ref-toggle'), box.checked);
            }
        });
    }

    NC.refs = {
        parse: parse,
        parseRef: parseRef,
        resolve: resolve,
        chipHtml: chipHtml,
        renderMarkdown: renderMarkdown,
        bind: bind,
        escapeHtml: escapeHtml
    };
})(window);
