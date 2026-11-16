/**
 * schema-notes.js — 笔记库校验 / 归一化 / 迁移 / 解析（纯函数）
 * 经典脚本，依赖 core.js（NC.util）。挂载：NC.schema.notes
 *
 * 设计原则（与 schema-todo 一致）：
 *   - 任何函数都不 throw：脏数据、损坏数据都必须能被"消化"并汇报 issues；
 *   - 纯函数：不读写 localStorage / IndexedDB / DOM，便于 tests.html 单测；
 *   - 正文是唯一真源，链接/标签/标题/分词都是可以从正文重算的派生物。
 *
 * 关键实现：`maskCode()` —— 把围栏代码块、行内代码、HTML 注释替换成**等长空格**，
 * 之后所有正则都跑在遮罩串上，位置可直接映射回原文。这样既能跳过代码里的
 * `[[...]]`，又不需要写完整的 Markdown 词法器。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var DOC_VERSION = 1;
    var APP_NAME = 'nTools';

    var KEYS = {
        legacyMd: 'ntools_md',
        fallback: 'ntools.notes.fallback.v1'
    };

    var LIMITS = {
        notes: 2000,
        folders: 200,
        title: 200,
        content: 1024 * 1024,          // 单篇正文 1MB
        folderName: 60,
        tag: 40,
        tagsPerNote: 100,
        linksPerNote: 500,
        fallbackNotes: 200,
        fallbackBytes: 1.5 * 1024 * 1024,
        importBytes: 50 * 1024 * 1024,
        searchResults: 100
    };

    /* 会让数据变少的 issue：加载时命中就必须先问用户，不能自动覆盖 */
    var DESTRUCTIVE_ISSUES = {
        'notes-truncated': 1,
        'note-rejected': 1,
        'content-truncated': 1
    };

    var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    var MAX_TS = 4102444800000; /* 2100-01-01 */

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */
    function nowTs() { return Date.now(); }

    function isNum(value) { return util && util.isFiniteNum ? util.isFiniteNum(value) : (typeof value === 'number' && isFinite(value)); }

    function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

    function toTs(value, fallback) {
        var n = Number(value);
        if (!isNum(n) || n < 0 || n > MAX_TS) return fallback;
        return Math.round(n);
    }

    function newId(prefix) {
        return util && util.uid ? util.uid(prefix) : (prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
    }

    function clip(value, limit) {
        var text = String(value == null ? '' : value);
        return text.length > limit ? text.slice(0, limit) : text;
    }

    function pushIssue(issues, code, message, extra) {
        if (!issues) return;
        var entry = { code: code, message: message };
        if (extra) {
            Object.keys(extra).forEach(function (key) { entry[key] = extra[key]; });
        }
        issues.push(entry);
    }

    function isDestructiveCode(code) {
        return !!(code && DESTRUCTIVE_ISSUES[code]);
    }

    function destructiveIssues(issues) {
        if (!Array.isArray(issues)) return [];
        return issues.filter(function (item) { return item && isDestructiveCode(item.code); });
    }

    /* ------------------------------------------------------------------ *
     * 代码遮罩
     * ------------------------------------------------------------------ */
    function spaces(length) {
        var out = '';
        for (var i = 0; i < length; i += 1) out += ' ';
        return out;
    }

    /** 遮掉一行里的行内代码与 HTML 注释（保持长度不变） */
    function maskInline(line) {
        var chars = line.split('');
        var n = chars.length;
        var i = 0;
        while (i < n) {
            var ch = chars[i];
            if (ch === '`') {
                var run = 1;
                while (i + run < n && chars[i + run] === '`') run += 1;
                var j = i + run;
                var close = -1;
                while (j < n) {
                    if (chars[j] === '`') {
                        var run2 = 1;
                        while (j + run2 < n && chars[j + run2] === '`') run2 += 1;
                        if (run2 === run) { close = j; break; }
                        j += run2;
                    } else {
                        j += 1;
                    }
                }
                if (close === -1) { i += run; continue; }
                for (var k = i; k < close + run; k += 1) chars[k] = ' ';
                i = close + run;
                continue;
            }
            if (ch === '<' && line.substr(i, 4) === '<!--') {
                var end = line.indexOf('-->', i + 4);
                if (end === -1) {
                    for (var k2 = i; k2 < n; k2 += 1) chars[k2] = ' ';
                    break;
                }
                for (var k3 = i; k3 < end + 3; k3 += 1) chars[k3] = ' ';
                i = end + 3;
                continue;
            }
            i += 1;
        }
        return chars.join('');
    }

    /**
     * 把代码区域替换为等长空格。返回与原文**等长**的字符串，
     * 因此遮罩串上的匹配位置可以直接拿去切原文。
     */
    function maskCode(text) {
        var source = String(text == null ? '' : text);
        if (!source) return '';
        var lines = source.split('\n');
        var out = [];
        var inFence = false;
        var fenceChar = '';
        var fenceLen = 0;

        for (var i = 0; i < lines.length; i += 1) {
            var line = lines[i];
            var open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
            if (inFence) {
                if (open && open[1].charAt(0) === fenceChar && open[1].length >= fenceLen) {
                    inFence = false;
                    fenceChar = '';
                    fenceLen = 0;
                }
                out.push(spaces(line.length));
                continue;
            }
            if (open) {
                inFence = true;
                fenceChar = open[1].charAt(0);
                fenceLen = open[1].length;
                out.push(spaces(line.length));
                continue;
            }
            out.push(maskInline(line));
        }
        return out.join('\n');
    }

    /* ------------------------------------------------------------------ *
     * 标题 / 标签
     * ------------------------------------------------------------------ */
    function normalizeTitle(raw) {
        var text = String(raw == null ? '' : raw)
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/[[\]|#]/g, ' ')       // 标题里不允许出现链接分隔符
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) return '';
        return text.length > LIMITS.title ? text.slice(0, LIMITS.title).trim() : text;
    }

    /** 在已占用的标题集合里取一个不冲突的标题：标题 / 标题 2 / 标题 3 … */
    function uniqueTitle(title, usedLower) {
        var base = normalizeTitle(title) || '未命名笔记';
        if (!usedLower || typeof usedLower.has !== 'function') return base;
        if (!usedLower.has(base.toLowerCase())) return base;
        for (var n = 2; n < 10000; n += 1) {
            var candidate = base + ' ' + n;
            if (!usedLower.has(candidate.toLowerCase())) return candidate;
        }
        return base + ' ' + newId('n');
    }

    function normalizeTag(raw) {
        var text = String(raw == null ? '' : raw).trim().replace(/^#+/, '');
        text = text.replace(/\s+/g, '-').replace(/[^\w\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af/-]/g, '');
        if (!text) return '';
        return text.length > LIMITS.tag ? text.slice(0, LIMITS.tag) : text;
    }

    var TAG_RE = /(^|[\s(（[【>,，。；;:：、])#([A-Za-z0-9_\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af][A-Za-z0-9_\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af/-]{0,39})/g;

    function parseTags(text) {
        var source = String(text == null ? '' : text);
        if (!source) return [];
        var mask = maskCode(source);
        var out = [];
        var seen = Object.create(null);
        TAG_RE.lastIndex = 0;
        var match;
        while ((match = TAG_RE.exec(mask)) !== null) {
            var tag = normalizeTag(match[2]);
            if (!tag) continue;
            var key = tag.toLowerCase();
            if (seen[key]) continue;
            seen[key] = 1;
            out.push(tag);
            if (out.length >= LIMITS.tagsPerNote) break;
        }
        return out;
    }

    /* ------------------------------------------------------------------ *
     * Wikilink
     * ------------------------------------------------------------------ */
    var LINK_RE = /(!?)\[\[([^[\]\n]{1,300})\]\]/g;

    /**
     * 解析正文里的 [[...]]。
     * @returns {Array<{raw,target,alias,anchor,isEmbed,start,end}>}
     */
    function parseLinks(text) {
        var source = String(text == null ? '' : text);
        if (!source || source.indexOf('[[') === -1) return [];
        var mask = maskCode(source);
        var out = [];
        LINK_RE.lastIndex = 0;
        var match;
        while ((match = LINK_RE.exec(mask)) !== null) {
            var raw = source.slice(match.index, match.index + match[0].length);
            var inner = match[2];
            var alias = '';
            var anchor = '';
            var pipe = inner.indexOf('|');
            if (pipe > -1) {
                alias = inner.slice(pipe + 1).trim();
                inner = inner.slice(0, pipe);
            }
            var hash = inner.indexOf('#');
            if (hash > -1) {
                anchor = inner.slice(hash + 1).trim();
                inner = inner.slice(0, hash);
            }
            var target = normalizeTitle(inner);
            if (!target && !anchor) continue;
            out.push({
                raw: raw,
                target: target,
                alias: alias,
                anchor: anchor,
                isEmbed: match[1] === '!',
                start: match.index,
                end: match.index + match[0].length
            });
            if (out.length >= LIMITS.linksPerNote) break;
        }
        return out;
    }

    /* ------------------------------------------------------------------ *
     * 大纲 / 标题提取
     * ------------------------------------------------------------------ */
    function extractHeadings(text) {
        var source = String(text == null ? '' : text);
        if (!source) return [];
        var mask = maskCode(source);
        var lines = mask.split('\n');
        var out = [];
        for (var i = 0; i < lines.length; i += 1) {
            var match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
            if (!match) continue;
            var rawLine = source.split('\n')[i] || '';
            out.push({
                level: match[1].length,
                text: match[2].trim(),
                line: i,
                raw: rawLine
            });
            if (out.length >= 500) break;
        }
        return out;
    }

    /** 首个一级标题；没有则退到任意级别标题；再没有返回 '' */
    function firstHeadingTitle(text) {
        var headings = extractHeadings(text);
        if (!headings.length) return '';
        for (var i = 0; i < headings.length; i += 1) {
            if (headings[i].level === 1) return normalizeTitle(headings[i].text);
        }
        return normalizeTitle(headings[0].text);
    }

    /* ------------------------------------------------------------------ *
     * 分词（检索用）
     * ------------------------------------------------------------------ */
    var CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
    var LATIN_RE = /[a-z0-9][a-z0-9_+#.-]*/g;

    /**
     * 检索分词：中文按 bigram（两字窗口），单字直接成词；拉丁按词。
     * 返回去重后的 token 数组（小写）。
     */
    function tokenize(text) {
        var source = String(text == null ? '' : text).toLowerCase();
        if (!source) return [];
        var tokens = Object.create(null);
        var latin = source.match(LATIN_RE) || [];
        for (var i = 0; i < latin.length; i += 1) {
            var word = latin[i].replace(/^[.+-]+|[.+-]+$/g, '');
            if (!word) continue;
            if (word.length >= 2 || /[0-9]/.test(word)) tokens[word] = 1;
        }
        var cjk = source.match(CJK_RUN_RE) || [];
        for (var j = 0; j < cjk.length; j += 1) {
            var run = cjk[j];
            if (run.length === 1) { tokens[run] = 1; continue; }
            for (var k = 0; k < run.length - 1; k += 1) tokens[run.slice(k, k + 2)] = 1;
        }
        return Object.keys(tokens);
    }

    /* ------------------------------------------------------------------ *
     * 归一化
     * ------------------------------------------------------------------ */
    function emptyVault(now) {
        return {
            schemaVersion: DOC_VERSION,
            updatedAt: isNum(now) ? now : nowTs(),
            notes: [],
            folders: []
        };
    }

    function normalizeFolder(raw, ctx) {
        if (!isPlainObject(raw)) return null;
        var used = ctx.folderIds;
        var id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
        if (!id || used[id]) {
            id = newId('f');
            pushIssue(ctx.issues, 'folder-id-fixed', '文件夹 ID 缺失或重复，已重新生成');
        }
        used[id] = 1;
        var name = normalizeTitle(raw.name) || '未命名文件夹';
        if (name.length > LIMITS.folderName) name = name.slice(0, LIMITS.folderName);
        return {
            id: id,
            name: name,
            parentId: null,
            order: isNum(raw.order) ? Math.round(raw.order) : ctx.index * 1024,
            createdAt: toTs(raw.createdAt, ctx.now)
        };
    }

    function normalizeNote(raw, ctx) {
        if (!isPlainObject(raw)) {
            pushIssue(ctx.issues, 'note-rejected', '非对象笔记，已丢弃');
            return null;
        }
        var usedIds = ctx.noteIds;
        var id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
        if (!id || usedIds[id]) {
            id = newId('n');
            pushIssue(ctx.issues, 'note-id-fixed', '笔记 ID 缺失或重复，已重新生成');
        }
        usedIds[id] = 1;

        var content = typeof raw.content === 'string' ? raw.content : (typeof raw.text === 'string' ? raw.text : '');
        if (content.length > LIMITS.content) {
            content = content.slice(0, LIMITS.content);
            pushIssue(ctx.issues, 'content-truncated', '单篇正文超过 ' + LIMITS.content + ' 字符，已截断', { id: id });
        }

        var title = normalizeTitle(raw.title);
        if (!title) {
            title = firstHeadingTitle(content) || '未命名笔记';
        }
        title = uniqueTitle(title, ctx.titleKeys);
        ctx.titleKeys.add(title.toLowerCase());

        var folderId = typeof raw.folderId === 'string' && ctx.folderIds[raw.folderId] ? raw.folderId : null;

        return {
            id: id,
            title: title,
            content: content,
            folderId: folderId,
            createdAt: toTs(raw.createdAt, ctx.now),
            updatedAt: toTs(raw.updatedAt, ctx.now),
            revision: isNum(raw.revision) && raw.revision >= 0 ? Math.round(raw.revision) : 0,
            starred: raw.starred === true,
            deletedAt: isNum(raw.deletedAt) && raw.deletedAt > 0 ? toTs(raw.deletedAt, null) : null
        };
    }

    /**
     * 归一化整库。永远返回 {doc, issues}，不 throw。
     * @param {*} raw
     * @param {{now?:number}} [options]
     */
    function normalizeVault(raw, options) {
        var opts = options || {};
        var now = isNum(opts.now) ? opts.now : nowTs();
        var issues = [];
        var src = isPlainObject(raw) ? raw : {};
        var ctx = {
            now: now,
            issues: issues,
            index: 0,
            folderIds: Object.create(null),
            noteIds: Object.create(null),
            titleKeys: new Set()
        };

        var rawFolders = Array.isArray(src.folders) ? src.folders : [];
        if (rawFolders.length > LIMITS.folders) {
            pushIssue(issues, 'folders-truncated', '文件夹超过 ' + LIMITS.folders + ' 个，已截断');
        }
        var folders = [];
        rawFolders.slice(0, LIMITS.folders).forEach(function (item, index) {
            ctx.index = index;
            var folder = normalizeFolder(item, ctx);
            if (folder) folders.push(folder);
        });

        var rawNotes = Array.isArray(src.notes) ? src.notes : [];
        if (rawNotes.length > LIMITS.notes) {
            pushIssue(issues, 'notes-truncated', '笔记超过 ' + LIMITS.notes + ' 篇，已截断', { index: LIMITS.notes });
        }
        var notes = [];
        rawNotes.slice(0, LIMITS.notes).forEach(function (item) {
            var note = normalizeNote(item, ctx);
            if (note) notes.push(note);
        });

        if (!notes.length && rawNotes.length) {
            pushIssue(issues, 'note-rejected-all', '全部笔记都无法识别，已丢弃');
        }

        return {
            doc: {
                schemaVersion: DOC_VERSION,
                updatedAt: toTs(src.updatedAt, now),
                notes: notes,
                folders: folders
            },
            issues: issues
        };
    }

    /* ------------------------------------------------------------------ *
     * 迁移 / 导入导出
     * ------------------------------------------------------------------ */
    /** 旧的单文档 Markdown（ntools_md）→ 一篇笔记 */
    function migrateLegacyMarkdown(text, now) {
        var content = typeof text === 'string' ? text : '';
        if (!content.trim()) return null;
        var title = firstHeadingTitle(content) || 'Markdown 草稿';
        return normalizeVault({
            schemaVersion: DOC_VERSION,
            notes: [{
                id: 'n-legacy-md',
                title: title,
                content: content,
                createdAt: isNum(now) ? now : nowTs(),
                updatedAt: isNum(now) ? now : nowTs()
            }]
        }).doc.notes[0] || null;
    }

    function exportVault(doc) {
        var source = isPlainObject(doc) ? doc : emptyVault();
        return {
            app: APP_NAME,
            kind: 'notes-vault',
            schemaVersion: DOC_VERSION,
            exportedAt: new Date().toISOString(),
            notes: (source.notes || []).map(function (note) {
                return {
                    id: note.id,
                    title: note.title,
                    content: note.content,
                    folderId: note.folderId,
                    createdAt: note.createdAt,
                    updatedAt: note.updatedAt,
                    starred: note.starred === true,
                    deletedAt: note.deletedAt || null
                };
            }),
            folders: (source.folders || []).map(function (folder) {
                return { id: folder.id, name: folder.name, order: folder.order, createdAt: folder.createdAt };
            })
        };
    }

    /**
     * 解析导入内容：接受 {notes:[...]} / 整库导出 / 纯笔记数组。
     * @returns {{doc, issues}|{doc:null, issues}}
     */
    function parseImport(raw) {
        var data = raw;
        if (typeof raw === 'string') {
            try { data = JSON.parse(raw); } catch (err) { return { doc: null, issues: [{ code: 'invalid-json', message: 'JSON 解析失败' }] }; }
        }
        if (Array.isArray(data)) {
            return normalizeVault({ notes: data });
        }
        if (!isPlainObject(data)) {
            return { doc: null, issues: [{ code: 'invalid-shape', message: '导入内容不是对象或数组' }] };
        }
        if (Array.isArray(data.notes)) return normalizeVault(data);
        if (Array.isArray(data.data)) return normalizeVault({ notes: data.data });
        return { doc: null, issues: [{ code: 'no-notes', message: '导入内容里没有 notes 数组' }] };
    }

    function estimateBytes(doc) {
        try {
            return JSON.stringify(doc).length;
        } catch (err) {
            return 0;
        }
    }

    NC.schema = NC.schema || {};
    NC.schema.notes = {
        DOC_VERSION: DOC_VERSION,
        LIMITS: LIMITS,
        KEYS: KEYS,
        DESTRUCTIVE_ISSUES: DESTRUCTIVE_ISSUES,
        newId: newId,
        emptyVault: emptyVault,
        normalizeTitle: normalizeTitle,
        uniqueTitle: uniqueTitle,
        normalizeTag: normalizeTag,
        normalizeNote: normalizeNote,
        normalizeFolder: normalizeFolder,
        normalizeVault: normalizeVault,
        maskCode: maskCode,
        parseLinks: parseLinks,
        parseTags: parseTags,
        extractHeadings: extractHeadings,
        firstHeadingTitle: firstHeadingTitle,
        tokenize: tokenize,
        migrateLegacyMarkdown: migrateLegacyMarkdown,
        exportVault: exportVault,
        parseImport: parseImport,
        estimateBytes: estimateBytes,
        isDestructiveCode: isDestructiveCode,
        destructiveIssues: destructiveIssues
    };
})(window);
