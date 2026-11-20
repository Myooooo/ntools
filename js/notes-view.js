/**
 * notes-view.js — 笔记界面（三栏：笔记栏 / 编辑·阅读 / 信息面板）
 * 经典脚本，依赖 core.js、ui.js、icons.js、schema-notes.js、notes-store.js、marked、DOMPurify。
 * 挂载：NC.view.notes
 *
 * 边界：只做 DOM 与交互，所有数据变更都走 NC.store.notes；订阅 store 的通知重渲染。
 * 阶段 1 范围：笔记库骨架、编辑/阅读切换、大纲与统计、回收站、窄屏抽屉。
 * 双向链接渲染在阶段 2 接入（本文件已预留 renderMarkdown 的扩展点）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var view = NC.view = NC.view || {};
    var util = NC.util;

    var TREE_LIMIT = 300;
    var EDIT_COMMIT_DELAY = 400;
    var RENDER_CHAR_LIMIT = 400000;

    var els = {};
    var store = null;
    var schema = null;
    var unsubscribe = null;
    var commitTimer = null;
    var modeEnterTimer = null;
    var renderTick = null;
    var bound = false;

    var state = {
        filter: '',
        mode: 'edit',          // 'edit' | 'read'
        infoOpen: false,
        sideOpen: false,
        sideCollapsed: false,
        trashView: false,
        collapsed: Object.create(null),
        tagFilter: '',
        searchResults: null,   // null=普通列表；数组=搜索结果
        applying: false,       // 回填 DOM 时抑制 input 事件
        pendingId: null,
        lastRenderedId: null
    };

    /* ------------------------------------------------------------------ *
     * 基础工具
     * ------------------------------------------------------------------ */
    function $(id) { return document.getElementById(id); }
    function pick(ids) {
        for (var i = 0; i < ids.length; i += 1) {
            var node = document.getElementById(ids[i]);
            if (node) return node;
        }
        return null;
    }

    function toast(message, type) {
        if (NC.ui && NC.ui.toast) NC.ui.toast(message, { type: type || 'info' });
    }

    function icon(name, size) {
        if (NC.icons && NC.icons.el) return NC.icons.el(name, size || 15);
        var span = document.createElement('span');
        return span;
    }

    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function escapeAttr(text) { return escapeHtml(text).replace(/`/g, '&#96;'); }

    function setHidden(node, hidden) {
        if (!node) return;
        if (hidden) node.setAttribute('hidden', '');
        else node.removeAttribute('hidden');
    }

    function fmtTime(ts) {
        if (!ts) return '—';
        var d = new Date(ts);
        var now = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
        var yesterday = new Date(now.getTime() - 86400000);
        if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + hm;
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    }

    function fmtDate(ts) {
        if (!ts) return '—';
        var d = new Date(ts);
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /* ------------------------------------------------------------------ *
     * Markdown 渲染（阶段 2 会在这里加 wikilink 扩展）
     * ------------------------------------------------------------------ */
    var extensionsInstalled = false;

    /** [[标题]] / [[标题|别名]] / [[标题#小节]] / ![[图片]] 渲染成可点击的 span */
    function ensureMarkedExtensions() {
        if (extensionsInstalled) return;
        if (!global.marked || typeof global.marked.use !== 'function') return;
        extensionsInstalled = true;
        global.marked.use({
            extensions: [{
                name: 'noteWikiLink',
                level: 'inline',
                start: function (src) {
                    var i = src.indexOf('[[');
                    return i < 0 ? undefined : i;
                },
                tokenizer: function (src) {
                    var match = /^(!?)\[\[([^\[\]\n]{1,300})\]\]/.exec(src);
                    if (!match) return undefined;
                    var inner = match[2];
                    var alias = '';
                    var anchor = '';
                    var pipe = inner.indexOf('|');
                    if (pipe > -1) { alias = inner.slice(pipe + 1).trim(); inner = inner.slice(0, pipe); }
                    var hash = inner.indexOf('#');
                    if (hash > -1) { anchor = inner.slice(hash + 1).trim(); inner = inner.slice(0, hash); }
                    return {
                        type: 'noteWikiLink',
                        raw: match[0],
                        target: inner.trim(),
                        alias: alias,
                        anchor: anchor,
                        embed: match[1] === '!'
                    };
                },
                renderer: function (token) {
                    var label = token.alias || token.target || token.anchor || '';
                    var resolvedId = (store && token.target) ? store.resolveTitle(token.target) : null;
                    var cls = (token.embed ? 'note-embed' : 'note-link') + (resolvedId ? '' : ' is-unresolved');
                    var hint = resolvedId ? '' : '未创建，点击新建';
                    if (token.embed) {
                        return '<span class="note-embed" data-file="' + escapeAttr(token.target) + '">' +
                            escapeHtml(token.target) + '</span>';
                    }
                    return '<span class="' + cls + '" role="link" tabindex="0"' +
                        ' data-note="' + escapeAttr(token.target) + '"' +
                        (token.anchor ? ' data-anchor="' + escapeAttr(token.anchor) + '"' : '') +
                        (resolvedId ? ' data-id="' + escapeAttr(resolvedId) + '"' : '') +
                        (hint ? ' title="' + escapeAttr(hint) + '"' : '') +
                        '>' + escapeHtml(label) + '</span>';
                }
            }]
        });
    }

    /** 把 ![[文件名]] 的占位换成真实 Blob 图片 */
    function hydrateEmbeds(host) {
        if (!host || !store) return;
        var slots = host.querySelectorAll('.note-embed[data-file]');
        for (var i = 0; i < slots.length; i += 1) {
            (function (slot) {
                var name = slot.getAttribute('data-file');
                var record = store.resolveFile(name);
                if (!record) return;
                store.getFileUrl(record.id).then(function (url) {
                    if (!url || !slot.parentNode) return;
                    var img = document.createElement('img');
                    img.src = url;
                    img.alt = name;
                    img.loading = 'lazy';
                    img.className = 'note-img';
                    slot.parentNode.replaceChild(img, slot);
                });
            })(slots[i]);
        }
    }

    function renderMarkdown(host, text) {
        if (!host) return;
        var source = String(text == null ? '' : text);
        if (!source.trim()) {
            host.innerHTML = '<p class="nc-field-hint">这篇笔记还是空的，切到编辑模式开始写。</p>';
            return;
        }
        var truncated = false;
        if (source.length > RENDER_CHAR_LIMIT) {
            source = source.slice(0, RENDER_CHAR_LIMIT);
            truncated = true;
        }
        try {
            ensureMarkedExtensions();
            if (global.marked && global.marked.setOptions) {
                global.marked.setOptions({ gfm: true, breaks: true });
            }
            var html = global.marked ? global.marked.parse(source) : source;
            if (global.DOMPurify) {
                html = global.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
            }
            host.innerHTML = html;
            if (truncated) {
                var note = document.createElement('p');
                note.className = 'nc-field-hint';
                note.textContent = '笔记过大，预览仅渲染前 ' + RENDER_CHAR_LIMIT + ' 个字符（保存不受影响）。';
                host.appendChild(note);
            }
            var links = host.querySelectorAll('a[href]');
            for (var i = 0; i < links.length; i += 1) {
                if (/^https?:/i.test(links[i].getAttribute('href') || '')) {
                    links[i].setAttribute('target', '_blank');
                    links[i].setAttribute('rel', 'noopener noreferrer');
                }
            }
            hydrateEmbeds(host);
            var images = host.querySelectorAll('img[src]');
            for (var j = 0; j < images.length; j += 1) {
                if (/^https?:/i.test(images[j].getAttribute('src') || '')) {
                    images[j].setAttribute('referrerpolicy', 'no-referrer');
                    images[j].setAttribute('loading', 'lazy');
                }
            }
            if (NC.mdEnhance && typeof NC.mdEnhance.enhance === 'function') {
                NC.mdEnhance.enhance(host);
            }
        } catch (err) {
            host.textContent = '渲染失败：' + (err && err.message ? err.message : String(err));
        }
    }

    /* ------------------------------------------------------------------ *
     * 侧栏树
     * ------------------------------------------------------------------ */
    function noteRow(note) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'notes-row';
        row.setAttribute('role', 'treeitem');
        row.setAttribute('data-note-id', note.id);
        if (note.id === store.getActiveId()) {
            row.classList.add('is-active');
            row.setAttribute('aria-selected', 'true');
        }
        if (note.starred) {
            var star = document.createElement('span');
            star.className = 'notes-row__star';
            star.appendChild(icon('star', 14));
            row.appendChild(star);
        }
        var label = document.createElement('span');
        label.className = 'notes-row__label';
        label.textContent = note.title || '未命名笔记';
        row.appendChild(label);
        var meta = document.createElement('span');
        meta.className = 'notes-row__meta';
        meta.textContent = note.deletedAt ? fmtTime(note.deletedAt) : fmtTime(note.updatedAt);
        row.appendChild(meta);

        if (!note.deletedAt) {
            var more = document.createElement('button');
            more.type = 'button';
            more.className = 'notes-row__more';
            more.setAttribute('aria-label', '笔记操作：' + (note.title || '未命名笔记'));
            more.appendChild(icon('more', 14));
            more.addEventListener('click', function (event) {
                event.stopPropagation();
                openNoteMenu(note, more);
            });
            row.appendChild(more);
        }

        row.addEventListener('click', function () {
            selectNote(note.id);
            if (state.sideOpen) toggleSide(false);
        });
        return row;
    }

    /** 行内重命名：把标题替换成输入框，回车提交、Esc 取消 */
    function startRowRename(rowEl, note) {
        var label = rowEl.querySelector('.notes-row__label');
        if (!label || rowEl.querySelector('.notes-inline-input')) return;
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'notes-inline-input';
        input.value = note.title || '';
        input.maxLength = 200;
        label.textContent = '';
        label.appendChild(input);
        var done = false;
        var finish = function (commit) {
            if (done) return;
            done = true;
            var value = String(input.value || '').trim();
            if (commit && value && value !== note.title) {
                state.selfEdit = true;
                var res = store.renameNote(note.id, value);
                state.selfEdit = false;
                if (res && res.relinked) toast('已同步更新 ' + res.relinked + ' 处引用', 'success');
            }
            renderTree();
            renderActive({ syncEditor: false });
        };
        input.addEventListener('click', function (event) { event.stopPropagation(); });
        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') { event.preventDefault(); finish(true); }
            else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', function () { finish(true); });
        input.focus();
        input.select();
    }

    function openNoteMenu(note, anchor) {
        var rowEl = anchor && anchor.closest ? anchor.closest('.notes-row') : null;
        NC.ui.openMenu(anchor, [
            {
                label: '重命名',
                icon: 'edit',
                onSelect: function () { if (rowEl) startRowRename(rowEl, note); }
            },
            {
                label: note.starred ? '取消星标' : '加星标',
                icon: 'star',
                onSelect: function () {
                    store.updateNote(note.id, { starred: !note.starred });
                    renderTree();
                }
            },
            {
                label: '删除',
                icon: 'trash',
                danger: true,
                onSelect: function () {
                    store.deleteNote(note.id);
                    toast('已移入回收站', 'success');
                    renderTree();
                }
            }
        ]);
    }

    function searchRow(item) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'notes-row notes-row--result';
        row.setAttribute('data-note-id', item.id);
        if (item.id === store.getActiveId()) row.classList.add('is-active');
        var label = document.createElement('span');
        label.className = 'notes-row__label';
        label.textContent = item.title || '未命名笔记';
        row.appendChild(label);
        if (item.snippet) {
            var snippet = document.createElement('span');
            snippet.className = 'notes-row__snippet';
            var text = item.snippet;
            var at = text.toLowerCase().indexOf(String(state.filter || '').toLowerCase());
            if (at > -1 && state.filter) {
                snippet.appendChild(document.createTextNode(text.slice(0, at)));
                var mark = document.createElement('mark');
                mark.textContent = text.slice(at, at + state.filter.length);
                snippet.appendChild(mark);
                snippet.appendChild(document.createTextNode(text.slice(at + state.filter.length)));
            } else {
                snippet.textContent = text;
            }
            row.appendChild(snippet);
        }
        row.addEventListener('click', function () {
            selectNote(item.id);
            if (state.sideOpen) toggleSide(false);
        });
        return row;
    }

    /** 分组标题：名称 + 右侧计数（结构化两列，不用「A · N」中点串） */
    function groupTitle(text, count) {
        var head = document.createElement('div');
        head.className = 'notes-group';
        head.appendChild(util.e('span', { class: 'notes-group__label', text: text }));
        if (count != null) {
            head.appendChild(util.e('span', { class: 'notes-group__count', text: String(count) }));
        }
        return head;
    }

    /** 树里的行内输入：回车提交、Esc 取消、失焦提交 */
    var inlineInput = null;

    function closeInlineInput() {
        if (inlineInput && inlineInput.parentNode) inlineInput.parentNode.removeChild(inlineInput.wrap);
        inlineInput = null;
    }

    function openInlineInput(options) {
        closeInlineInput();
        var opts = options || {};
        var wrap = document.createElement('div');
        wrap.className = 'notes-row notes-row--inline';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'notes-inline-input';
        input.placeholder = opts.placeholder || '';
        input.value = opts.value || '';
        input.maxLength = 60;
        wrap.appendChild(input);
        if (opts.after && opts.after.parentNode) opts.after.parentNode.insertBefore(wrap, opts.after.nextSibling);
        else if (els.tree) els.tree.appendChild(wrap);
        inlineInput = { wrap: wrap, input: input };
        var done = false;
        var finish = function (commit) {
            if (done) return;
            done = true;
            var value = String(input.value || '').trim();
            closeInlineInput();
            if (commit && value) opts.onCommit(value);
        };
        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') { event.preventDefault(); finish(true); }
            else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', function () { finish(true); });
        input.focus();
        input.select();
        return wrap;
    }

    function folderRow(folder, count) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'notes-row notes-row--folder';
        row.setAttribute('data-folder-id', folder.id);
        row.setAttribute('aria-expanded', state.collapsed[folder.id] ? 'false' : 'true');
        var chev = document.createElement('span');
        chev.className = 'notes-row__chev';
        chev.appendChild(icon(state.collapsed[folder.id] ? 'chevron-right' : 'chevron-down', 13));
        row.appendChild(chev);
        var label = document.createElement('span');
        label.className = 'notes-row__label';
        label.textContent = folder.name;
        row.appendChild(label);
        var meta = document.createElement('span');
        meta.className = 'notes-row__meta';
        meta.textContent = String(count);
        row.appendChild(meta);
        row.addEventListener('click', function () {
            state.collapsed[folder.id] = !state.collapsed[folder.id];
            renderTree();
        });

        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'notes-row__more';
        more.setAttribute('aria-label', '文件夹操作');
        more.appendChild(icon('more', 13));
        more.addEventListener('click', function (event) {
            event.stopPropagation();
            openFolderMenu(folder, more);
        });
        row.appendChild(more);
        return row;
    }

    function openFolderMenu(folder, anchor) {
        NC.ui.openMenu(anchor, [
            {
                label: '重命名',
                icon: 'edit',
                onSelect: function () {
                    openInlineInput({
                        value: folder.name,
                        placeholder: '文件夹名称',
                        onCommit: function (value) {
                            store.renameFolder(folder.id, value);
                            renderTree();
                        }
                    });
                }
            },
            {
                label: '删除文件夹',
                icon: 'trash',
                danger: true,
                onSelect: function () {
                    var count = 0;
                    store.quickSwitch('').forEach(function (item) {
                        var note = store.getNote(item.id);
                        if (note && note.folderId === folder.id) count += 1;
                    });
                    NC.ui.confirm(
                        '删除文件夹「' + folder.name + '」？里面的 ' + count + ' 篇笔记会移到未分组，不会被删除。',
                        { confirmText: '删除文件夹', danger: true }
                    ).then(function (ok) {
                        if (!ok) return;
                        store.deleteFolder(folder.id);
                        renderTree();
                    });
                }
            }
        ]);
    }

    function matchesFilter(note) {
        if (!state.filter) return true;
        return (note.title || '').toLowerCase().indexOf(state.filter) > -1;
    }

    function renderTree() {
        if (!els.tree) return;
        els.tree.textContent = '';

        /* 有搜索词时只显示搜索结果 */
        if (state.filter) {
            var results = storageSearch(state.filter);
            els.tree.appendChild(groupTitle('搜索结果', results.length));
            if (!results.length) {
                var noResult = document.createElement('div');
                noResult.className = 'notes-tree__empty';
                noResult.textContent = '没有匹配「' + state.filter + '」的笔记';
                els.tree.appendChild(noResult);
                return;
            }
            results.forEach(function (item) { els.tree.appendChild(searchRow(item)); });
            return;
        }

        var all = store.quickSwitch('');
        var live = [];
        var trashed = [];
        var allowed = state.tagFilter ? new Set(store.notesWithTag(state.tagFilter)) : null;
        all.forEach(function (item) {
            var note = store.getNote(item.id);
            if (!note) return;
            if (note.deletedAt) trashed.push(note);
            else if (!allowed || allowed.has(note.id)) live.push(note);
        });

        if (state.trashView) {
            els.tree.appendChild(groupTitle('回收站', trashed.length));
            if (!trashed.length) {
                var emptyTrash = document.createElement('div');
                emptyTrash.className = 'notes-tree__empty';
                emptyTrash.textContent = '回收站是空的';
                els.tree.appendChild(emptyTrash);
                return;
            }
            trashed.slice(0, TREE_LIMIT).forEach(function (note) { els.tree.appendChild(noteRow(note)); });
            return;
        }

        if (state.tagFilter) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'notes-row notes-row--filter';
            chip.appendChild(icon('tag', 13));
            var chipLabel = document.createElement('span');
            chipLabel.className = 'notes-row__label';
            chipLabel.textContent = '#' + state.tagFilter;
            chip.appendChild(chipLabel);
            var clear = document.createElement('span');
            clear.className = 'notes-row__meta';
            clear.textContent = '清除';
            chip.appendChild(clear);
            chip.addEventListener('click', function () {
                state.tagFilter = '';
                renderTree();
            });
            els.tree.appendChild(chip);
        }

        var starred = [];
        var loose = [];
        var byFolder = Object.create(null);
        live.forEach(function (note) {
            if (note.starred) starred.push(note);
            if (note.folderId) (byFolder[note.folderId] = byFolder[note.folderId] || []).push(note);
            else loose.push(note);
        });

        if (starred.length) {
            els.tree.appendChild(groupTitle('星标'));
            starred.slice(0, 50).forEach(function (note) { els.tree.appendChild(noteRow(note)); });
        }

        els.tree.appendChild(groupTitle('全部笔记', live.length));
        loose.slice(0, TREE_LIMIT).forEach(function (note) { els.tree.appendChild(noteRow(note)); });
        if (live.length > TREE_LIMIT) {
            var more = document.createElement('div');
            more.className = 'notes-tree__empty';
            more.textContent = '仅显示前 ' + TREE_LIMIT + ' 篇，可用上方搜索框筛选';
            els.tree.appendChild(more);
        }

        var folders = store.getFolders();
        els.tree.appendChild(groupTitle('文件夹'));
        {
            folders.forEach(function (folder) {
                var list = byFolder[folder.id] || [];
                els.tree.appendChild(folderRow(folder, list.length));
                if (!state.collapsed[folder.id]) {
                    list.slice(0, TREE_LIMIT).forEach(function (note) { els.tree.appendChild(noteRow(note)); });
                }
            });
        }
        var addFolder = document.createElement('button');
        addFolder.type = 'button';
        addFolder.className = 'notes-row notes-row--add';
        addFolder.appendChild(icon('plus', 12));
        var addLabel = document.createElement('span');
        addLabel.className = 'notes-row__label';
        addLabel.textContent = '新建文件夹';
        addFolder.appendChild(addLabel);
        addFolder.addEventListener('click', function () {
            openInlineInput({
                placeholder: '文件夹名称，回车创建',
                after: addFolder,
                onCommit: function (value) {
                    var folder = store.createFolder(value);
                    if (folder) renderTree();
                }
            });
        });
        els.tree.appendChild(addFolder);

        var tags = store.tags();
        if (tags.length) {
            els.tree.appendChild(groupTitle('标签'));
            tags.slice(0, 30).forEach(function (tag) {
                var row = document.createElement('button');
                row.type = 'button';
                row.className = 'notes-row notes-row--tag' + (state.tagFilter === tag.key ? ' is-active' : '');
                row.appendChild(icon('tag', 12));
                var label = document.createElement('span');
                label.className = 'notes-row__label';
                label.textContent = tag.tag;
                row.appendChild(label);
                var meta = document.createElement('span');
                meta.className = 'notes-row__meta';
                meta.textContent = String(tag.count);
                row.appendChild(meta);
                row.addEventListener('click', function () {
                    state.tagFilter = state.tagFilter === tag.key ? '' : tag.key;
                    state.trashView = false;
                    renderTree();
                });
                els.tree.appendChild(row);
            });
        }

        if (trashed.length) {
            var trashRow = document.createElement('button');
            trashRow.type = 'button';
            trashRow.className = 'notes-row notes-row--trash';
            trashRow.appendChild(icon('trash', 13));
            var trashLabel = document.createElement('span');
            trashLabel.className = 'notes-row__label';
            trashLabel.textContent = '回收站';
            trashRow.appendChild(trashLabel);
            var trashMeta = document.createElement('span');
            trashMeta.className = 'notes-row__meta';
            trashMeta.textContent = String(trashed.length);
            trashRow.appendChild(trashMeta);
            trashRow.addEventListener('click', function () {
                state.trashView = true;
                renderTree();
            });
            els.tree.appendChild(trashRow);
        }

        if (!live.length && !trashed.length && !tags.length) {
            var hint = document.createElement('div');
            hint.className = 'notes-tree__empty';
            hint.textContent = '还没有笔记，点上方「新建」';
            els.tree.appendChild(hint);
        }
    }

    /** 带缓存与上限的全文搜索（空查询不查） */
    var searchCache = { query: '', at: 0, results: [] };
    function storageSearch(query) {
        var now = Date.now();
        if (searchCache.query === query && now - searchCache.at < 800) return searchCache.results;
        var results = store.search(query);
        searchCache = { query: query, at: now, results: results };
        return results;
    }

    /* ------------------------------------------------------------------ *
     * 主区
     * ------------------------------------------------------------------ */
    function applyMode() {
        var read = state.mode === 'read';
        setHidden(els.editor, read);
        setHidden(els.preview, !read);
        syncModeSeg();
        if (read) {
            var note = store.getActiveNote();
            renderMarkdown(els.preview, note ? note.content : '');
        }
    }

    /** 分段控制器与 state.mode 同步（编辑 / 阅读） */
    function syncModeSeg() {
        if (!els.modeSeg) return;
        var buttons = els.modeSeg.querySelectorAll('.nc-seg__btn');
        for (var i = 0; i < buttons.length; i += 1) {
            var active = buttons[i].getAttribute('data-mode') === state.mode;
            buttons[i].classList.toggle('is-active', active);
            buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
        }
    }

    /** 搜索框有内容时才显示清除按钮 */
    function syncFilterClear() {
        if (!els.filterClear) return;
        var has = !!(els.filter && String(els.filter.value || '').length);
        els.filterClear.hidden = !has;
    }

    function renderStatus() {
        var note = store.getActiveNote();
        var chars = note ? (note.content || '').length : 0;
        var lines = note && note.content ? note.content.split(/\r\n|\r|\n/).length : 0;
        if (els.stats) {
            var charNode = els.stats.querySelector('[data-stat="chars"]');
            var lineNode = els.stats.querySelector('[data-stat="lines"]');
            if (charNode && lineNode) {
                charNode.textContent = chars + ' 字';
                lineNode.textContent = lines + ' 行';
            } else {
                els.stats.textContent = chars + ' 字　' + lines + ' 行';
            }
        }
        var info = store.saveState();
        if (!els.save) return;
        els.save.classList.remove('is-error', 'is-pending');
        if (info.readOnly) {
            els.save.textContent = '只读镜像';
            els.save.classList.add('is-error');
        } else if (info.ok === false) {
            els.save.textContent = '保存失败，重试中…';
            els.save.classList.add('is-error');
        } else if (info.pending > 0) {
            els.save.textContent = '保存中…';
            els.save.classList.add('is-pending');
        } else {
            els.save.textContent = info.saveCount ? '已保存　' + fmtTime(info.lastSavedAt) : '已就绪';
        }
    }

    function renderOutline(note) {
        if (!els.infoBody) return;
        var box = document.createElement('div');
        box.className = 'notes-section';
        var title = document.createElement('div');
        title.className = 'notes-section__title';
        title.textContent = '大纲';
        box.appendChild(title);
        var headings = note ? (store.headings(note.id) || []) : [];
        if (!headings.length) {
            var none = document.createElement('div');
            none.className = 'notes-meta-row';
            none.textContent = '还没有标题';
            box.appendChild(none);
        } else {
            headings.forEach(function (head) {
                var item = document.createElement('button');
                item.type = 'button';
                item.className = 'notes-outline__item';
                item.setAttribute('data-level', String(head.level));
                item.textContent = head.text;
                item.addEventListener('click', function () { jumpToHeading(head); });
                box.appendChild(item);
            });
        }
        return box;
    }

    function renderMeta(note) {
        var box = document.createElement('div');
        box.className = 'notes-section';
        var title = document.createElement('div');
        title.className = 'notes-section__title';
        title.textContent = '统计';
        box.appendChild(title);
        var rows = [
            ['字数', String(note ? (note.content || '').length : 0)],
            ['修订', String(note ? (note.revision || 0) : 0)],
            ['创建', note ? fmtDate(note.createdAt) : '—'],
            ['更新', note ? fmtDate(note.updatedAt) : '—']
        ];
        rows.forEach(function (pair) {
            var row = document.createElement('div');
            row.className = 'notes-meta-row';
            var key = document.createElement('span');
            key.textContent = pair[0];
            var value = document.createElement('span');
            value.textContent = pair[1];
            row.appendChild(key);
            row.appendChild(value);
            box.appendChild(row);
        });
        return box;
    }

    function linkSection(title, items, emptyText, options) {
        var opts = options || {};
        var box = document.createElement('div');
        box.className = 'notes-section';
        var head = document.createElement('div');
        head.className = 'notes-section__title';
        head.appendChild(util.e('span', { text: title }));
        if (items.length) {
            head.appendChild(util.e('span', { class: 'notes-section__count', text: String(items.length) }));
        }
        box.appendChild(head);
        if (!items.length) {
            var none = document.createElement('div');
            none.className = 'notes-meta-row';
            none.textContent = emptyText;
            box.appendChild(none);
            return box;
        }
        items.slice(0, 30).forEach(function (item) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'notes-link-row' + (opts.unresolved ? ' is-unresolved' : '');
            row.textContent = item.title || '未命名';
            row.addEventListener('click', function () {
                if (opts.unresolved) openWikiLink(item.title, '');
                else selectNote(item.id);
            });
            box.appendChild(row);
        });
        return box;
    }

    function renderInfo() {
        if (!els.infoBody || !state.infoOpen) return;
        var note = store.getActiveNote();
        els.infoBody.textContent = '';
        els.infoBody.appendChild(renderMeta(note));
        els.infoBody.appendChild(renderOutline(note));
        els.infoBody.appendChild(renderGraph(note));
        if (note) {
            els.infoBody.appendChild(linkSection('反向链接', store.backlinks(note.id), '还没有笔记链接到这里'));
            els.infoBody.appendChild(linkSection('出链', store.outlinks(note.id), '还没有链接到其它笔记'));
            var unresolved = store.unresolved(note.id);
            if (unresolved && unresolved.length) {
                els.infoBody.appendChild(linkSection('未创建的链接', unresolved.map(function (title) {
                    return { title: title };
                }), '', { unresolved: true }));
            }
        }
    }

    function jumpToAnchor(anchorText) {
        if (!anchorText || !els.preview) return;
        if (state.mode !== 'read') {
            state.mode = 'read';
            applyMode();
        }
        var nodes = els.preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (var i = 0; i < nodes.length; i += 1) {
            if ((nodes[i].textContent || '').trim() === anchorText) {
                nodes[i].scrollIntoView({ block: 'start', behavior: 'smooth' });
                return;
            }
        }
    }

    /** 打开 [[标题]]：不存在就地创建；可选跳到 #小节 */
    function openWikiLink(title, anchorText) {
        var target = String(title || '').trim();
        if (!target) {
            if (anchorText) jumpToAnchor(anchorText);
            return;
        }
        var id = store.resolveTitle(target);
        if (!id) {
            var note = store.createNote({ title: target });
            if (!note) return;
            toast('已新建「' + note.title + '」', 'success');
            id = note.id;
        }
        selectNote(id);
        if (anchorText) {
            global.setTimeout(function () { jumpToAnchor(anchorText); }, 60);
        }
    }

    function jumpToHeading(head) {
        if (state.mode !== 'read') {
            state.mode = 'read';
            applyMode();
        }
        var nodes = els.preview ? els.preview.querySelectorAll('h1, h2, h3, h4, h5, h6') : [];
        var index = (store.headings(store.getActiveId()) || []).indexOf(head);
        if (index > -1 && nodes[index]) {
            nodes[index].scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    }

    function renderActive(options) {
        var opts = options || {};
        var note = store.getActiveNote();
        var has = !!note;
        setHidden(els.empty, has);
        if (els.editor) els.editor.disabled = !has || store.isReadOnly();
        if (els.title) els.title.disabled = !has || store.isReadOnly();

        state.applying = true;
        var syncInputs = opts.syncEditor !== false;
        if (has && syncInputs) {
            if (els.title && els.title.value !== note.title) els.title.value = note.title;
            if (els.editor && els.editor.value !== (note.content || '')) els.editor.value = note.content || '';
        } else if (!has) {
            if (els.title) els.title.value = '';
            if (els.editor) els.editor.value = '';
        }
        state.applying = false;

        var changed = state.lastRenderedId !== (note ? note.id : null);
        state.lastRenderedId = note ? note.id : null;

        applyMode();
        if (!has) {
            if (els.preview) els.preview.textContent = '';
        }
        if (!opts.contentOnly || changed) {
            renderStatus();
            renderInfo();
        } else {
            renderStatus();
        }
    }

    /* ------------------------------------------------------------------ *
     * 交互
     * ------------------------------------------------------------------ */
    function selectNote(id) {
        commitNow();
        if (!store.setActive(id)) return;
        state.lastRenderedId = null;
        renderActive();
        if (state.mode === 'edit' && els.editor) els.editor.focus();
    }

    function scheduleCommit() {
        if (commitTimer) global.clearTimeout(commitTimer);
        commitTimer = global.setTimeout(function () {
            commitTimer = null;
            commitNow();
        }, EDIT_COMMIT_DELAY);
    }

    function commitNow() {
        if (commitTimer) { global.clearTimeout(commitTimer); commitTimer = null; }
        var id = store.getActiveId();
        if (!id || state.applying) return;
        var note = store.getNote(id);
        if (!note) return;
        var content = els.editor ? els.editor.value : '';
        if (content === note.content) return;
        state.selfEdit = true;
        store.updateNote(id, { content: content });
        state.selfEdit = false;
        renderStatus();
    }

    function canAnimateMode() {
        if (document.documentElement.getAttribute('data-lite') === 'true') return false;
        return !(NC.util && NC.util.prefersReducedMotion && NC.util.prefersReducedMotion());
    }

    /** 编辑/阅读切换：方向性淡入 + 8px 位移 + 0.996 缩放。 */
    function playModeEnter(prev, next) {
        if (!canAnimateMode() || !els.editor || !els.preview) return;
        var target = next === 'read' ? els.preview : els.editor;
        if (!target || target.hidden) return;
        var direction = prev === 'edit' && next === 'read' ? 'next' : 'prev';
        [els.editor, els.preview].forEach(function (node) {
            node.classList.remove('nc-view-enter', 'nc-view-enter--next', 'nc-view-enter--prev');
        });
        /* 强制一次样式计算，快速连续切换也能从起点重播 */
        void target.offsetWidth;
        target.classList.add('nc-view-enter', 'nc-view-enter--' + direction);
        if (modeEnterTimer) global.clearTimeout(modeEnterTimer);
        modeEnterTimer = global.setTimeout(function () {
            modeEnterTimer = null;
            [els.editor, els.preview].forEach(function (node) {
                node.classList.remove('nc-view-enter', 'nc-view-enter--next', 'nc-view-enter--prev');
            });
        }, 260);
    }

    function toggleMode(force, options) {
        acHide();
        var prev = state.mode;
        state.mode = typeof force === 'string' ? force : (state.mode === 'read' ? 'edit' : 'read');
        if (state.mode === 'read') commitNow();
        applyMode();
        var animate = !options || options.animate !== false;
        if (prev !== state.mode && animate) playModeEnter(prev, state.mode);
    }

    var SIDE_KEY = 'ntools.notes.side';

    function isNarrowNotes() {
        return !!(global.matchMedia && global.matchMedia('(max-width: 1100px)').matches);
    }

    function readSideCollapsed() {
        return NC.prefs.get(SIDE_KEY, '0') === '1';
    }

    function saveSideCollapsed() {
        NC.prefs.set(SIDE_KEY, state.sideCollapsed ? '1' : '0');
    }

    function syncSideButton() {
        if (!els.sideOpen) return;
        var expanded = isNarrowNotes() ? state.sideOpen : !state.sideCollapsed;
        var label = expanded ? '收起笔记列表' : '打开笔记列表';
        els.sideOpen.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        els.sideOpen.setAttribute('aria-label', label);
        els.sideOpen.setAttribute('title', label);
    }

    /** 桌面：折叠/展开左栏；移动：抽屉开合。与 nChat / 工坊一致。 */
    function applySideState() {
        if (!els.shell) return;
        if (isNarrowNotes()) {
            els.shell.classList.remove('is-side-collapsed');
            els.shell.classList.toggle('is-side-open', state.sideOpen);
        } else {
            els.shell.classList.remove('is-side-open');
            state.sideOpen = false;
            els.shell.classList.toggle('is-side-collapsed', !!state.sideCollapsed);
        }
        syncSideButton();
    }

    function toggleSide(force) {
        if (!isNarrowNotes()) return;
        state.sideOpen = typeof force === 'boolean' ? force : !state.sideOpen;
        applySideState();
    }

    function onSideButton() {
        if (isNarrowNotes()) {
            toggleSide(!state.sideOpen);
            return;
        }
        state.sideCollapsed = !state.sideCollapsed;
        saveSideCollapsed();
        applySideState();
    }

    var infoHideTimer = null;

    function toggleInfo(force) {
        var next = typeof force === 'boolean' ? force : !state.infoOpen;
        if (infoHideTimer) { global.clearTimeout(infoHideTimer); infoHideTimer = null; }
        state.infoOpen = next;
        if (els.shell) els.shell.classList.toggle('is-info-open', next);
        if (els.infoBtn) {
            els.infoBtn.classList.toggle('is-active', next);
            els.infoBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
        }
        if (!els.info) return;
        els.info.classList.remove('is-opening', 'is-closing');
        if (next) {
            setHidden(els.info, false);
            /* 强制一次样式计算，让 180ms 过渡从关闭态开始 */
            void els.info.offsetWidth;
            els.info.classList.add('is-opening');
            renderInfo();
            return;
        }
        if (els.info.hidden) return;
        /* Lite / reduced-motion：即时收起，不等待过渡 */
        var instant = document.documentElement.getAttribute('data-lite') === 'true' ||
            (NC.util && NC.util.prefersReducedMotion && NC.util.prefersReducedMotion());
        if (instant) {
            setHidden(els.info, true);
            return;
        }
        els.info.classList.add('is-closing');
        infoHideTimer = global.setTimeout(function () {
            infoHideTimer = null;
            els.info.classList.remove('is-closing', 'is-opening');
            if (!state.infoOpen) setHidden(els.info, true);
        }, 150);
    }

    function newNote() {
        if (store.isReadOnly()) { toast('当前为只读镜像，无法新建', 'warning'); return; }
        var note = store.createNote({ title: '未命名笔记' });
        if (!note) return;
        state.trashView = false;
        state.mode = 'edit';
        state.lastRenderedId = null;
        renderActive();
        renderTree();
        if (els.title) {
            els.title.focus();
            els.title.select();
        }
    }

    function removeActive() {
        var note = store.getActiveNote();
        if (!note) return;
        if (note.deletedAt) {
            NC.ui.confirm('彻底删除「' + note.title + '」？此操作不可恢复。', { confirmText: '彻底删除', danger: true })
                .then(function (ok) {
                    if (!ok) return;
                    store.purgeNote(note.id);
                    toast('已彻底删除', 'success');
                });
            return;
        }
        store.deleteNote(note.id);
        toast('已移入回收站（Ctrl+Z 可撤销）', 'success');
    }

    function openMoreMenu() {
        var note = store.getActiveNote();
        if (!note) return;
        var items = [];
        items.push({
            label: note.starred ? '取消星标' : '加星标',
            icon: 'star',
            onSelect: function () { store.updateNote(note.id, { starred: !note.starred }); }
        });
        items.push({
            label: '导出 .md',
            icon: 'download',
            onSelect: function () { exportNote(note); }
        });
        items.push({
            label: '复制标题链接',
            icon: 'link',
            onSelect: function () {
                var text = '[[' + note.title + ']]';
                NC.util.copyText(text).then(function (ok) {
                    toast(ok ? '已复制 ' + text : text, ok ? 'success' : 'info');
                });
            }
        });
        var folders = store.getFolders();
        if (folders.length && !note.deletedAt) {
            folders.slice(0, 6).forEach(function (folder) {
                if (folder.id === note.folderId) return;
                items.push({
                    label: '移到「' + folder.name + '」',
                    icon: 'folder',
                    onSelect: function () { store.moveNote(note.id, folder.id); renderTree(); }
                });
            });
            if (note.folderId) {
                items.push({
                    label: '移出文件夹',
                    icon: 'folder',
                    onSelect: function () { store.moveNote(note.id, null); renderTree(); }
                });
            }
        }
        if (note.deletedAt) {
            items.push({ label: '恢复', icon: 'rotate-ccw', onSelect: function () { store.restoreNote(note.id); toast('已恢复', 'success'); } });
            items.push({ label: '彻底删除', icon: 'trash', danger: true, onSelect: removeActive });
        } else {
            items.push({ label: '删除', icon: 'trash', danger: true, onSelect: removeActive });
        }
        NC.ui.openMenu(els.moreBtn, items);
    }

    function exportNote(note) {
        try {
            var blob = new Blob([note.content || ''], { type: 'text/markdown;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = (note.title || 'note').replace(/[\\/:*?"<>|]/g, '_') + '.md';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            global.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            toast('已导出 .md', 'success');
        } catch (err) {
            toast('导出失败：' + (err && err.message ? err.message : err), 'error');
        }
    }

    /* ------------------------------------------------------------------ *
     * 导出 / 导入（单篇、整库 JSON、整库 ZIP）
     * ------------------------------------------------------------------ */
    function downloadBlob(blob, filename) {
        try {
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            global.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            return true;
        } catch (err) {
            toast('下载失败：' + (err && err.message ? err.message : err), 'error');
            return false;
        }
    }

    function stampName(ext) {
        var d = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return 'ntools-notes-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
            '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.' + ext;
    }

    function exportAllJson() {
        return store.flush().then(function () {
            var bundle = store.exportBundle();
            var text = JSON.stringify(bundle, null, 2);
            downloadBlob(new Blob([text], { type: 'application/json;charset=utf-8' }), stampName('json'));
            toast('已导出 ' + bundle.notes.length + ' 篇笔记（JSON）', 'success');
        });
    }

    function exportAllZip() {
        if (!NC.zip) { toast('打包模块未加载', 'error'); return; }
        return store.flush().then(function () {
            var bundle = store.exportBundle();
            var used = Object.create(null);
            var files = bundle.notes.map(function (note) {
                var base = (note.title || '未命名笔记').replace(/[\\/:*?"<>|]/g, '_');
                var name = base + '.md';
                var n = 2;
                while (used[name]) { name = base + '-' + n + '.md'; n += 1; }
                used[name] = 1;
                return { name: name, data: note.content || '' };
            });
            files.push({ name: '_ntools-notes.json', data: JSON.stringify(bundle, null, 2) });
            var db = NC.notesDb;
            var listFiles = (db && typeof db.getAllFiles === 'function') ? db.getAllFiles() : Promise.resolve([]);
            return listFiles.then(function (records) {
                var images = (records || []).filter(function (rec) { return rec && rec.blob && rec.name; });
                return Promise.all(images.map(function (rec) {
                    if (!rec.blob.arrayBuffer) return null;
                    return rec.blob.arrayBuffer().then(function (buffer) {
                        return { name: '图片/' + rec.name, data: new Uint8Array(buffer) };
                    }).catch(function () { return null; });
                })).then(function (pairs) {
                    var entries = files.concat(pairs.filter(Boolean));
                    var bytes = NC.zip.build(entries);
                    downloadBlob(new Blob([bytes], { type: 'application/zip' }), stampName('zip'));
                    toast('已导出 ' + bundle.notes.length + ' 篇' +
                        (pairs.length ? ' + ' + pairs.length + ' 张图片' : '') + '（ZIP）', 'success');
                });
            });
        });
    }

    function importJsonFile(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            var raw = String(reader.result || '');
            var parsed = null;
            try {
                parsed = NC.schema.notes.parseImport(raw);
            } catch (err) {
                toast('导入失败：无法解析 JSON', 'error');
                return;
            }
            if (!parsed || !parsed.doc) {
                toast('导入失败：不是有效的笔记备份', 'error');
                return;
            }
            var incoming = parsed.doc.notes.length;
            var existing = store.quickSwitch('').length;
            NC.ui.confirm(
                '导入 ' + incoming + ' 篇笔记（当前 ' + existing + ' 篇）。\n' +
                '确定会替换当前全部笔记，替换前会自动快照，可用撤销恢复。',
                { confirmText: '替换导入', danger: true }
            ).then(function (ok) {
                if (!ok) return;
                store.importVault(raw, { mode: 'replace' }).then(function (res) {
                    if (res && res.ok) toast('已导入 ' + res.added + ' 篇', 'success');
                    else toast('导入未完成：' + ((res && res.reason) || '未知原因'), 'error');
                    state.trashView = false;
                    state.filter = '';
                    if (els.filter) els.filter.value = '';
                    refresh();
                });
            });
        };
        reader.onerror = function () { toast('读取文件失败', 'error'); };
        reader.readAsText(file);
    }

    /** 打开本地 .md/.txt：以文件名建一篇新笔记，正文照搬 */
    function openLocalTextFile(file) {
        if (!file) return;
        if (store.isReadOnly()) { toast('当前为只读镜像，无法新建', 'warning'); return; }
        if (file.size > 8 * 1024 * 1024) { toast('文件超过 8MB，请拆分后再导入', 'error'); return; }
        var reader = new FileReader();
        reader.onload = function () {
            var text = String(reader.result || '');
            var rawName = file.name || '未命名';
            var title = rawName.replace(/\.[^.]+$/, '') || rawName;
            var note = store.createNote({ title: title });
            if (!note) { toast('新建笔记失败（可能已达数量上限）', 'error'); return; }
            store.updateNote(note.id, { content: text });
            state.mode = 'edit';
            state.trashView = false;
            state.filter = '';
            if (els.filter) els.filter.value = '';
            selectNote(note.id);
            renderTree();
            toast('已从「' + rawName + '」新建笔记', 'success');
        };
        reader.onerror = function () { toast('读取文件失败', 'error'); };
        reader.readAsText(file, 'utf-8');
    }

    function openLibraryMenu() {
        var items = [
            { label: '导入笔记（JSON）…', icon: 'upload', onSelect: function () { if (els.importFile) els.importFile.click(); } },
            { label: '导出全部（JSON）', icon: 'download', onSelect: exportAllJson },
            { label: '导出全部（ZIP，含图片）', icon: 'download', onSelect: exportAllZip }
        ];
        var trashCount = 0;
        store.quickSwitch('').forEach(function (item) {
            var note = store.getNote(item.id);
            if (note && note.deletedAt) trashCount += 1;
        });
        if (trashCount) {
            items.push({
                label: '清空回收站（' + trashCount + '）',
                icon: 'trash',
                danger: true,
                onSelect: function () {
                    NC.ui.confirm('彻底删除回收站里的 ' + trashCount + ' 篇笔记？清空前的自动快照仍可恢复。',
                        { confirmText: '清空回收站', danger: true }).then(function (ok) {
                        if (!ok) return;
                        var removed = store.clearTrash();
                        toast('已清空 ' + removed + ' 篇', 'success');
                    });
                }
            });
        }
        NC.ui.openMenu(els.dbBtn, items);
    }

    /* ------------------------------------------------------------------ *
     * 局部关系图（±1 跳，确定性径向布局，不做力导向）
     * ------------------------------------------------------------------ */
    function renderGraph(note) {
        var box = document.createElement('div');
        box.className = 'notes-section';
        var title = document.createElement('div');
        title.className = 'notes-section__title';
        title.textContent = '关系图';
        box.appendChild(title);
        if (!note) return box;

        var neighbours = [];
        var seen = Object.create(null);
        store.outlinks(note.id).concat(store.backlinks(note.id)).forEach(function (item) {
            if (!item.id || item.id === note.id || seen[item.id]) return;
            seen[item.id] = 1;
            neighbours.push(item);
        });
        neighbours = neighbours.slice(0, 12);

        if (!neighbours.length) {
            var empty = document.createElement('div');
            empty.className = 'notes-meta-row';
            empty.textContent = '还没有关联笔记';
            box.appendChild(empty);
            return box;
        }

        /* 逻辑坐标固定 480×360；按 devicePixelRatio 放大位图，避免 HiDPI 下发虚 */
        var LOGICAL_W = 480;
        var LOGICAL_H = 360;
        var dpr = Math.min(2, Math.max(1, global.devicePixelRatio || 1));
        var canvas = document.createElement('canvas');
        canvas.className = 'notes-graph';
        canvas.width = Math.round(LOGICAL_W * dpr);
        canvas.height = Math.round(LOGICAL_H * dpr);
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', '当前笔记的关系图');
        box.appendChild(canvas);

        var ctx = canvas.getContext ? canvas.getContext('2d') : null;
        if (!ctx) return box;
        if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        var styles = global.getComputedStyle ? global.getComputedStyle(document.documentElement) : null;
        var color = function (name, fallback) {
            var value = styles ? styles.getPropertyValue(name) : '';
            return (value && value.trim()) || fallback;
        };
        var accent = color('--nc-accent', '#6ea8fe');
        var text3 = color('--nc-text-3', '#7f8c9b');
        var surface = color('--nc-surface', '#131922');
        var border = color('--nc-border-strong', 'rgba(255,255,255,.14)');

        var w = LOGICAL_W;
        var h = LOGICAL_H;
        var cx = w / 2;
        var cy = h / 2;
        var radius = Math.min(w, h) / 2 - 46;
        var points = neighbours.map(function (item, index) {
            var angle = (Math.PI * 2 * index) / neighbours.length - Math.PI / 2;
            return { id: item.id, title: item.title, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
        });

        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = 2;
        ctx.strokeStyle = border;
        points.forEach(function (point) {
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
        });

        ctx.font = '20px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        points.forEach(function (point) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, 15, 0, Math.PI * 2);
            ctx.fillStyle = surface;
            ctx.fill();
            ctx.strokeStyle = accent;
            ctx.stroke();
            ctx.fillStyle = text3;
            var label = point.title.length > 8 ? point.title.slice(0, 7) + '…' : point.title;
            ctx.fillText(label, point.x, point.y + 26);
        });

        ctx.beginPath();
        ctx.arc(cx, cy, 20, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '600 20px system-ui, sans-serif';
        var own = note.title.length > 6 ? note.title.slice(0, 5) + '…' : note.title;
        ctx.fillText(own, cx, cy + 28);

        canvas.addEventListener('click', function (event) {
            var rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            var scaleX = LOGICAL_W / rect.width;
            var scaleY = LOGICAL_H / rect.height;
            var x = (event.clientX - rect.left) * scaleX;
            var y = (event.clientY - rect.top) * scaleY;
            for (var i = 0; i < points.length; i += 1) {
                var dx = x - points[i].x;
                var dy = y - points[i].y;
                if (dx * dx + dy * dy <= 24 * 24) {
                    selectNote(points[i].id);
                    return;
                }
            }
        });
        return box;
    }

    /* ------------------------------------------------------------------ *
     * 编辑增强：列表续行、缩进、包裹、图片粘贴
     * ------------------------------------------------------------------ */
    function insertText(text) {
        var ed = els.editor;
        if (!ed) return;
        ed.focus();
        var ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch (err) { ok = false; }
        if (!ok) {
            var start = ed.selectionStart;
            ed.value = ed.value.slice(0, start) + text + ed.value.slice(ed.selectionEnd);
            ed.setSelectionRange(start + text.length, start + text.length);
        }
        if (!state.applying) {
            scheduleCommit();
            renderStatus();
            acUpdate();
        }
    }

    function wrapSelection(before, after) {
        var ed = els.editor;
        if (!ed) return;
        var start = ed.selectionStart;
        var end = ed.selectionEnd;
        var selected = ed.value.slice(start, end);
        var placeholder = selected || '文本';
        ed.setSelectionRange(start, end);
        insertText(before + placeholder + after);
        ed.setSelectionRange(start + before.length, start + before.length + placeholder.length);
    }

    function linePrefixInfo() {
        var ed = els.editor;
        var pos = ed.selectionStart;
        if (pos !== ed.selectionEnd) return null;
        var lineStart = ed.value.lastIndexOf('\n', pos - 1) + 1;
        var line = ed.value.slice(lineStart, pos);
        var bullet = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?/.exec(line);
        if (bullet) {
            return {
                kind: 'bullet',
                lineStart: lineStart,
                lineLength: line.length,
                prefix: bullet[1] + bullet[2] + ' ' + (bullet[3] ? '[ ] ' : ''),
                body: line.slice(bullet[0].length)
            };
        }
        var ordered = /^(\s*)(\d+)\.\s+/.exec(line);
        if (ordered) {
            return {
                kind: 'ordered',
                lineStart: lineStart,
                lineLength: line.length,
                prefix: ordered[1] + (parseInt(ordered[2], 10) + 1) + '. ',
                body: line.slice(ordered[0].length)
            };
        }
        return null;
    }

    function handleEnter() {
        var info = linePrefixInfo();
        if (!info) return false;
        if (!info.body.trim()) {
            /* 空列表项：回车结束列表 */
            els.editor.setSelectionRange(info.lineStart, els.editor.selectionStart);
            insertText('');
            return true;
        }
        insertText('\n' + info.prefix);
        return true;
    }

    function handleTab(shift) {
        var ed = els.editor;
        var start = ed.selectionStart;
        if (shift) {
            var lineStart = ed.value.lastIndexOf('\n', start - 1) + 1;
            var head = ed.value.slice(lineStart, start);
            var trimmed = head.replace(/ {1,2}$/, '');
            if (trimmed !== head) {
                ed.setSelectionRange(lineStart + trimmed.length, start);
                insertText('');
              }
            return true;
        }
        insertText('  ');
        return true;
    }

    function handleEditorKey(event) {
        if (state.mode !== 'edit' || store.isReadOnly()) return false;
        var meta = event.ctrlKey || event.metaKey;
        if (event.key === 'Enter' && !event.shiftKey && !meta) return handleEnter();
        if (event.key === 'Tab') { event.preventDefault(); return handleTab(event.shiftKey); }
        if (meta && (event.key === 'b' || event.key === 'B')) { event.preventDefault(); wrapSelection('**', '**'); return true; }
        if (meta && (event.key === 'i' || event.key === 'I')) { event.preventDefault(); wrapSelection('*', '*'); return true; }
        if (meta && event.key === '`') { event.preventDefault(); wrapSelection('`', '`'); return true; }
        return false;
    }

    function handleImageFile(file) {
        if (!file) return;
        var type = file.type || 'image/png';
        var ext = (type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
        var stamp = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        var name = 'image-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
            '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + '.' + ext;
        var saved = store.addImage(file, name);
        if (!saved) return;
        insertText('![[' + saved + ']]');
        toast('已插入图片 ' + saved, 'success');
        if (state.mode === 'read') { state.mode = 'edit'; applyMode(); }
    }

    /* ------------------------------------------------------------------ *
     * 快速切换（Ctrl+O）
     * ------------------------------------------------------------------ */
    var palette = { open: false, items: [], index: 0 };

    function paletteClose() {
        palette.open = false;
        palette.items = [];
        palette.index = 0;
        if (paletteTrapRelease) { paletteTrapRelease(); paletteTrapRelease = null; }
        if (els.palette) els.palette.hidden = true;
    }

    function paletteRender() {
        if (!els.paletteList) return;
        els.paletteList.textContent = '';
        if (!palette.items.length) {
            var empty = document.createElement('div');
            empty.className = 'notes-palette__empty';
            empty.textContent = '没有匹配的笔记';
            els.paletteList.appendChild(empty);
            return;
        }
        palette.items.forEach(function (item, index) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'notes-palette__item' + (index === palette.index ? ' is-active' : '');
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', index === palette.index ? 'true' : 'false');
            var label = document.createElement('span');
            if (item.kind === 'create') {
                label.textContent = item.label;
            } else {
                var title = item.title || '';
                var at = paletteQuery ? title.toLowerCase().indexOf(paletteQuery.toLowerCase()) : -1;
                if (at > -1) {
                    label.appendChild(document.createTextNode(title.slice(0, at)));
                    var mark = document.createElement('mark');
                    mark.textContent = title.slice(at, at + paletteQuery.length);
                    label.appendChild(mark);
                    label.appendChild(document.createTextNode(title.slice(at + paletteQuery.length)));
                } else {
                    label.textContent = title;
                }
            }
            row.appendChild(label);
            var hint = document.createElement('span');
            hint.className = 'notes-palette__hint';
            hint.textContent = item.kind === 'create' ? '新建' : fmtTime(item.updatedAt);
            row.appendChild(hint);
            row.addEventListener('mousedown', function (event) {
                event.preventDefault();
                paletteAccept(index);
            });
            els.paletteList.appendChild(row);
        });
    }

    var paletteQuery = '';

    function paletteUpdate(query) {
        paletteQuery = String(query || '');
        var list = store.quickSwitch(paletteQuery).slice(0, 12).map(function (item) {
            return { kind: 'note', id: item.id, title: item.title, updatedAt: item.updatedAt };
        });
        if (paletteQuery && !list.length) {
            list.push({ kind: 'create', label: '新建「' + paletteQuery + '」', title: paletteQuery });
        }
        palette.items = list;
        palette.index = 0;
        paletteRender();
    }

    function paletteAccept(index) {
        var item = palette.items[typeof index === 'number' ? index : palette.index];
        if (!item) return;
        if (item.kind === 'create') {
            var note = store.createNote({ title: item.title });
            paletteClose();
            if (note) {
                selectNote(note.id);
                if (els.title) { els.title.focus(); els.title.select(); }
            }
            return;
        }
        paletteClose();
        selectNote(item.id);
    }

    var paletteTrapRelease = null;

    function paletteOpen() {
        if (!els.palette) return;
        palette.open = true;
        els.palette.hidden = false;
        if (NC.ui && NC.ui.trapFocus) paletteTrapRelease = NC.ui.trapFocus(els.palette);
        if (els.paletteInput) {
            els.paletteInput.value = '';
            els.paletteInput.focus();
        }
        paletteUpdate('');
    }

    /* ------------------------------------------------------------------ *
     * [[ 与 # 的自动补全
     * ------------------------------------------------------------------ */
    var ac = { open: false, items: [], index: 0, ctx: null, el: null };

    function acHide() {
        ac.open = false;
        ac.items = [];
        ac.index = 0;
        ac.ctx = null;
        if (ac.el && ac.el.parentNode) ac.el.parentNode.removeChild(ac.el);
        ac.el = null;
    }

    function acBuildItems(ctx) {
        if (!ctx) return [];
        if (ctx.type === 'link') {
            var list = store.quickSwitch(ctx.query).slice(0, 7).map(function (item) {
                return { kind: 'note', label: item.title, title: item.title };
            });
            var exact = list.some(function (item) { return item.title.toLowerCase() === ctx.query.toLowerCase(); });
            if (ctx.query && !exact) {
                /* 有候选时把「新建」放最后，默认选中第一条已有笔记；没有候选时才放到第一位 */
                var create = { kind: 'create', label: '新建「' + ctx.query + '」', title: ctx.query, hint: '新建笔记' };
                if (list.length) list.push(create);
                else list.push(create);
            }
            return list;
        }
        var query = ctx.query.toLowerCase();
        return store.tags().filter(function (tag) {
            return !query || tag.tag.toLowerCase().indexOf(query) > -1;
        }).slice(0, 8).map(function (tag) {
            return { kind: 'tag', label: '#' + tag.tag, tag: tag.tag, hint: String(tag.count) + ' 篇' };
        });
    }

    function acPosition() {
        if (!els.editor || !ac.el) return;
        var caret = els.editor.selectionStart || 0;
        var preview = caretCoordinates(els.editor, caret);
        var host = els.body || els.editor.parentNode;
        var width = ac.el.offsetWidth || 200;
        var height = ac.el.offsetHeight || 0;
        var left = Math.min(preview.left, Math.max(0, (host.clientWidth || 400) - width - 8));
        var top = preview.top + preview.lineHeight;
        if (els.editor.clientHeight && top + height > els.editor.clientHeight) {
            top = Math.max(0, preview.top - height - 4);
        }
        ac.el.style.left = Math.max(0, left) + 'px';
        ac.el.style.top = Math.max(0, top) + 'px';
    }

    /** 用镜像 div 量光标坐标（textarea 没有原生 API） */
    function caretCoordinates(textarea, index) {
        var style = global.getComputedStyle(textarea);
        var mirror = document.createElement('div');
        var props = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
            'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth',
            'borderLeftWidth', 'boxSizing', 'tabSize'];
        mirror.style.position = 'absolute';
        mirror.style.visibility = 'hidden';
        mirror.style.top = '0';
        mirror.style.left = '0';
        mirror.style.whiteSpace = 'pre-wrap';
        mirror.style.wordWrap = 'break-word';
        mirror.style.width = textarea.clientWidth + 'px';
        props.forEach(function (name) { mirror.style[name] = style[name]; });
        mirror.textContent = textarea.value.slice(0, index);
        var marker = document.createElement('span');
        marker.textContent = textarea.value.slice(index) || '.';
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        var lineHeight = parseFloat(style.lineHeight) || 20;
        var rect = mirror.getBoundingClientRect();
        var markRect = marker.getBoundingClientRect();
        var left = markRect.left - rect.left;
        var top = markRect.top - rect.top;
        document.body.removeChild(mirror);

        /* 转成相对 .notes-body 的坐标 */
        var bodyEl = els.body || textarea.parentNode;
        var bodyRect = bodyEl.getBoundingClientRect();
        var areaRect = textarea.getBoundingClientRect();
        return {
            left: areaRect.left - bodyRect.left + left - textarea.scrollLeft,
            top: areaRect.top - bodyRect.top + top - textarea.scrollTop,
            lineHeight: lineHeight
        };
    }

    function acRender() {
        if (!ac.el) {
            ac.el = document.createElement('div');
            ac.el.className = 'notes-ac';
            ac.el.setAttribute('role', 'listbox');
            (els.body || els.editor.parentNode).appendChild(ac.el);
        }
        ac.el.textContent = '';
        ac.items.forEach(function (item, index) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'notes-ac__item' + (index === ac.index ? ' is-active' : '');
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', index === ac.index ? 'true' : 'false');
            var label = document.createElement('span');
            label.textContent = item.label;
            row.appendChild(label);
            if (item.hint) {
                var hint = document.createElement('span');
                hint.className = 'notes-ac__hint';
                hint.textContent = item.hint;
                row.appendChild(hint);
            }
            row.addEventListener('mousedown', function (event) {
                event.preventDefault();     // 保持 textarea 焦点
                acAccept(index);
            });
            ac.el.appendChild(row);
        });
        acPosition();
    }

    function acUpdate() {
        if (!els.editor || !schema || typeof schema.linkContextAt !== 'function') return;
        if (state.mode !== 'edit' || store.isReadOnly()) { acHide(); return; }
        var value = els.editor.value;
        var caret = els.editor.selectionStart || 0;
        var ctx = schema.linkContextAt(value, caret);
        if (!ctx) { acHide(); return; }
        var items = acBuildItems(ctx);
        if (!items.length) { acHide(); return; }
        ac.open = true;
        ac.ctx = ctx;
        ac.items = items;
        if (ac.index >= items.length) ac.index = 0;
        acRender();
    }

    function acAccept(index) {
        if (!ac.open || !ac.ctx) return;
        var item = ac.items[typeof index === 'number' ? index : ac.index];
        if (!item) return;
        var ctx = ac.ctx;
        var value = els.editor.value;
        var insert;
        if (item.kind === 'tag') insert = '#' + item.tag + ' ';
        else insert = '[[' + item.title + ']] ';
        els.editor.value = value.slice(0, ctx.start) + insert + value.slice(ctx.end);
        var caret = ctx.start + insert.length;
        els.editor.setSelectionRange(caret, caret);
        acHide();
        scheduleCommit();
        renderStatus();
        els.editor.focus();
    }

    function acKey(event) {
        if (!ac.open) return false;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            ac.index = (ac.index + 1) % ac.items.length;
            acRender();
            return true;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            ac.index = (ac.index - 1 + ac.items.length) % ac.items.length;
            acRender();
            return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            acAccept();
            return true;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            acHide();
            return true;
        }
        return false;
    }

    /* ------------------------------------------------------------------ *
     * 事件绑定
     * ------------------------------------------------------------------ */
    function bindEvents() {
        if (bound) return;
        bound = true;

        if (els.newBtn) els.newBtn.addEventListener('click', newNote);
        if (els.dbBtn) els.dbBtn.addEventListener('click', openLibraryMenu);
        if (els.openFileBtn && els.openFile) {
            els.openFileBtn.addEventListener('click', function () { els.openFile.click(); });
            els.openFile.addEventListener('change', function () {
                var file = els.openFile.files && els.openFile.files[0];
                els.openFile.value = '';
                openLocalTextFile(file);
            });
        }
        if (els.importFile) {
            els.importFile.addEventListener('change', function () {
                var file = els.importFile.files && els.importFile.files[0];
                els.importFile.value = '';
                importJsonFile(file);
            });
        }

        if (els.filter) {
            var filterTimer = null;
            els.filter.addEventListener('input', function () {
                state.filter = String(els.filter.value || '').trim().toLowerCase();
                state.trashView = false;
                syncFilterClear();
                if (filterTimer) global.clearTimeout(filterTimer);
                filterTimer = global.setTimeout(function () {
                    filterTimer = null;
                    renderTree();
                }, 120);
            });
        }

        if (els.editor) {
            els.editor.addEventListener('input', function () {
                if (state.applying) return;
                if (state.mode === 'read') { state.mode = 'edit'; applyMode(); }
                scheduleCommit();
                renderStatus();
                acUpdate();
            });
            els.editor.addEventListener('keydown', function (event) {
                if (acKey(event)) return;
                if (handleEditorKey(event)) return;
                if (event.key === 'Escape') acHide();
            });
            els.editor.addEventListener('paste', function (event) {
                var items = event.clipboardData && event.clipboardData.items;
                if (!items) return;
                for (var i = 0; i < items.length; i += 1) {
                    if (items[i].kind === 'file' && String(items[i].type || '').indexOf('image/') === 0) {
                        var file = items[i].getAsFile();
                        if (!file) continue;
                        event.preventDefault();
                        handleImageFile(file);
                        return;
                    }
                }
            });
            els.editor.addEventListener('dragover', function (event) { event.preventDefault(); });
            els.editor.addEventListener('drop', function (event) {
                var files = event.dataTransfer && event.dataTransfer.files;
                if (!files || !files.length) return;
                for (var i = 0; i < files.length; i += 1) {
                    if (String(files[i].type || '').indexOf('image/') !== 0) continue;
                    event.preventDefault();
                    handleImageFile(files[i]);
                    return;
                }
            });
            els.editor.addEventListener('click', acUpdate);
            els.editor.addEventListener('blur', function () {
                commitNow();
                global.setTimeout(acHide, 120);
            });
            els.editor.addEventListener('scroll', acPosition);
        }

        if (els.title) {
            var commitTitle = function () {
                var id = store.getActiveId();
                if (!id) return;
                var value = String(els.title.value || '').trim();
                var note = store.getNote(id);
                if (!note || value === note.title) return;
                state.selfEdit = true;
                var res = store.renameNote(id, value);
                state.selfEdit = false;
                if (res && res.relinked) toast('已同步更新 ' + res.relinked + ' 处引用', 'success');
                renderTree();
            };
            els.title.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commitTitle();
                    if (els.editor) els.editor.focus();
                }
            });
            els.title.addEventListener('blur', commitTitle);
        }

        if (els.modeSeg) {
            els.modeSeg.addEventListener('click', function (event) {
                var btn = event.target && event.target.closest ? event.target.closest('.nc-seg__btn') : null;
                if (!btn) return;
                var mode = btn.getAttribute('data-mode');
                if (!mode || mode === state.mode) return;
                /* 键盘触发（detail=0）不播内容动画，点击分段控件才播 */
                toggleMode(mode, { animate: event.detail !== 0 });
            });
        }
        if (els.filterClear) {
            els.filterClear.addEventListener('click', function () {
                if (els.filter) { els.filter.value = ''; els.filter.focus(); }
                state.filter = '';
                state.trashView = false;
                syncFilterClear();
                renderTree();
            });
        }
        if (els.emptyNew) els.emptyNew.addEventListener('click', function () { newNote(); });
        if (els.emptyPalette) els.emptyPalette.addEventListener('click', function () { paletteOpen(); });
        NC.events.on('theme:changed', function () {
            if (state.infoOpen) renderInfo();
        });
        if (els.infoBtn) els.infoBtn.addEventListener('click', function () { toggleInfo(); });
        if (els.infoClose) els.infoClose.addEventListener('click', function () { toggleInfo(false); });
        if (els.moreBtn) els.moreBtn.addEventListener('click', openMoreMenu);
        if (els.sideOpen) els.sideOpen.addEventListener('click', onSideButton);
        if (els.sideClose) els.sideClose.addEventListener('click', function () { toggleSide(false); });
        if (els.scrim) els.scrim.addEventListener('click', function () { toggleSide(false); toggleInfo(false); });
        global.addEventListener('resize', function () { applySideState(); });

        if (els.palette) {
            els.palette.addEventListener('mousedown', function (event) {
                if (event.target === els.palette) paletteClose();
            });
            if (els.paletteInput) {
                els.paletteInput.addEventListener('input', function () {
                    paletteUpdate(els.paletteInput.value);
                });
                els.paletteInput.addEventListener('keydown', function (event) {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        if (!palette.items.length) return;
                        palette.index = (palette.index + 1) % palette.items.length;
                        paletteRender();
                    } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        if (!palette.items.length) return;
                        palette.index = (palette.index - 1 + palette.items.length) % palette.items.length;
                        paletteRender();
                    } else if (event.key === 'Enter') {
                        event.preventDefault();
                        paletteAccept();
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        paletteClose();
                    }
                });
            }
        }

        if (els.preview) {
            els.preview.addEventListener('click', function (event) {
                var link = event.target && event.target.closest ? event.target.closest('[data-note]') : null;
                if (!link) return;
                event.preventDefault();
                openWikiLink(link.getAttribute('data-note'), link.getAttribute('data-anchor') || '');
            });
            els.preview.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                var link = event.target && event.target.closest ? event.target.closest('[data-note]') : null;
                if (!link) return;
                event.preventDefault();
                openWikiLink(link.getAttribute('data-note'), link.getAttribute('data-anchor') || '');
            });
        }

        document.addEventListener('keydown', function (event) {
            var page = document.getElementById('page-md');
            if (!page || page.hasAttribute('hidden')) return;
            var meta = event.ctrlKey || event.metaKey;
            if (!meta) return;
            var key = event.key.toLowerCase();
            if (key === 'o' && !event.shiftKey) { event.preventDefault(); paletteOpen(); }
            else if (key === 'f' && event.shiftKey) {
                event.preventDefault();
                if (els.filter) { els.filter.focus(); els.filter.select(); }
            }
            else if (key === 'n' && !event.shiftKey) { event.preventDefault(); newNote(); }
            else if (key === 'e') { event.preventDefault(); toggleMode(undefined, { animate: false }); }
            else if (key === 's') { event.preventDefault(); commitNow(); store.flush(); toast('已保存', 'success'); }
            else if (key === 'z' && !event.shiftKey) { event.preventDefault(); var label = store.undo(); if (label) toast('已撤销：' + label); }
            else if (key === 'z' && event.shiftKey) { event.preventDefault(); var redoLabel = store.redo(); if (redoLabel) toast('已重做：' + redoLabel); }
        });

        /* 只读 / 保存错误提示 */
        NC.events.on('notes:readonly', function (payload) {
            toast(payload.message || '已进入只读模式', 'warning');
            renderActive();
            renderStatus();
        });
        NC.events.on('notes:error', function (payload) {
            toast(payload.message || '笔记操作失败', 'error');
            renderStatus();
        });
        NC.events.on('notes:savestate', function () { renderStatus(); });
    }

    function cacheEls() {
        els.shell = $('notes-shell');
        els.tree = $('notes-tree');
        els.filter = $('notes-filter');
        els.newBtn = $('notes-new-btn');
        els.title = $('notes-title');
        els.body = $('notes-body');
        els.editor = $('notes-editor');
        els.preview = $('notes-preview');
        els.empty = $('notes-empty');
        els.stats = $('notes-stats');
        els.save = $('notes-save');
        els.modeSeg = $('notes-mode-seg');
        els.filterClear = $('notes-filter-clear');
        els.emptyNew = $('notes-empty-new');
        els.emptyPalette = $('notes-empty-palette');
        els.infoBtn = $('notes-info-btn');
        els.infoClose = $('notes-info-close');
        els.moreBtn = $('notes-more-btn');
        els.info = $('notes-info');
        els.infoBody = $('notes-info-body');
        els.sideOpen = $('notes-side-open');
        els.sideClose = $('notes-side-close');
        els.scrim = $('notes-scrim');
        els.moduleNote = $('notes-module-note');
        els.dbBtn = $('notes-db-btn');
        els.importFile = $('notes-import-file');
        els.openFileBtn = $('notes-open-file-btn');
        els.openFile = $('notes-open-file');
        els.palette = $('notes-palette');
        els.paletteInput = $('notes-palette-input');
        els.paletteList = $('notes-palette-list');
    }

    function scheduleRender(payload) {
        if (renderTick) return;
        renderTick = global.requestAnimationFrame(function () {
            renderTick = null;
            renderTree();
            if (payload && payload.reason === 'read-only') renderActive();
            else renderStatus();
        });
    }

    /* ------------------------------------------------------------------ *
     * 对外 API
     * ------------------------------------------------------------------ */
    function init() {
        if (state.initialized) return NC.view.notes;
        cacheEls();
        state.sideCollapsed = readSideCollapsed();
        try {
            var prefMode = NC.prefs.get('ntools.notes.mode', '');
            if (prefMode === 'read' || prefMode === 'edit') state.mode = prefMode;
        } catch (err) { /* ignore */ }
        store = NC.store && NC.store.notes;
        schema = NC.schema && NC.schema.notes;
        if (!store || !schema) {
            if (els.moduleNote) {
                els.moduleNote.hidden = false;
                els.moduleNote.textContent = '笔记模块未加载（js/notes-store.js），界面已就绪。';
            }
            return null;
        }
        if (unsubscribe) unsubscribe();
        unsubscribe = store.subscribe(function (payload) {
            state.handlerHits = (state.handlerHits || 0) + 1;
            var activeId = store.getActiveId();
            var wholeList = payload && (payload.reason === 'active' || payload.reason === 'init' ||
                payload.reason === 'migrate' || payload.reason === 'vault:import' || payload.reason === 'reset');
            var touchesActive = payload && payload.id && payload.id === activeId;
            /* 只有"本视图自己写的"才不回填输入框；别的来源（切笔记、导入、撤销）必须回填，
             * 否则界面会停在上一条笔记的内容上。 */
            var selfDriven = state.selfEdit === true;
            if (wholeList || touchesActive) {
                renderActive({ syncEditor: !selfDriven });
            } else {
                renderStatus();
            }
            scheduleRender(payload);
        });
        bindEvents();
        applySideState();
        state.initialized = true;

        store.init().then(function () {
            var activeId = store.getActiveId();
            if (!activeId) {
                var first = store.quickSwitch('');
                if (first.length) {
                    store.setActive(first[0].id);
                }
            }
            state.lastRenderedId = null;
            renderTree();
            renderActive();
            if (els.tree && !store.quickSwitch('').length) newNote();
        }).catch(function (err) {
            toast('笔记库加载失败：' + (err && err.message ? err.message : err), 'error');
        });
        return NC.view.notes;
    }

    function refresh() {
        renderTree();
        renderActive();
    }

    function focusNote(id) {
        if (!id) return;
        selectNote(id);
    }

    view.notes = {
        init: init,
        refresh: refresh,
        focusNote: focusNote,
        toggleMode: toggleMode,
        newNote: newNote,
        getMode: function () { return state.mode; },
        isReady: function () { return !!state.initialized; },
        diagnostics: function () {
            return {
                handlerHits: state.handlerHits || 0,
                mode: state.mode,
                lastRenderedId: state.lastRenderedId,
                applying: state.applying,
                listeners: store && store.listenerCount ? store.listenerCount() : -1
            };
        }
    };
})(window);
