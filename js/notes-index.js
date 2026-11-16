/**
 * notes-index.js — 笔记索引（内存派生，可随时从正文重建）
 * 经典脚本，依赖 core.js、schema-notes.js。挂载：NC.notesIndex
 *
 * 只读派生物，原则：**正文是唯一真源**。索引坏了不需要迁移，重建即可。
 * 维护的是：
 *   - 标题/正文/大纲/标签/链接（出链、入链、未解析链接）
 *   - 检索倒排（中文 bigram + 拉丁词）
 *
 * 不碰 DOM、不碰存储，便于单测与 bench。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    function schema() { return NC.schema && NC.schema.notes; }

    function create() {
        return {
            byId: new Map(),
            byTitle: new Map(),        // titleLower -> id
            contents: new Map(),       // id -> 正文（供片段与精确匹配）
            titles: new Map(),         // id -> 原标题
            updatedAt: new Map(),      // id -> updatedAt
            out: new Map(),            // id -> Set<targetId>（已解析）
            outUnresolved: new Map(),  // id -> Set<titleLower>
            inLinks: new Map(),        // id -> Set<sourceId>
            unresolved: new Map(),     // titleLower -> Set<sourceId>
            tags: new Map(),           // tagLower -> Set<id>
            tagDisplay: new Map(),     // tagLower -> 原文
            noteTags: new Map(),       // id -> [tagLower]
            tokens: new Map(),         // token -> Set<id>
            noteTokens: new Map(),     // id -> [token]
            headings: new Map(),       // id -> [{level,text,line}]
            links: new Map()           // id -> [{target,alias,anchor,isEmbed}]
        };
    }

    function ensureSet(map, key) {
        var set = map.get(key);
        if (!set) { set = new Set(); map.set(key, set); }
        return set;
    }

    function dropFromSet(map, key, value) {
        var set = map.get(key);
        if (!set) return;
        set.delete(value);
        if (!set.size) map.delete(key);
    }

    function addTo(map, key, value) {
        if (!key) return;
        ensureSet(map, key).add(value);
    }

    /* ------------------------------------------------------------------ *
     * 增删
     * ------------------------------------------------------------------ */
    function removeNote(index, id) {
        var tokens = index.noteTokens.get(id) || [];
        tokens.forEach(function (token) { dropFromSet(index.tokens, token, id); });
        index.noteTokens.delete(id);

        var targets = index.out.get(id);
        if (targets) {
            targets.forEach(function (targetId) { dropFromSet(index.inLinks, targetId, id); });
            index.out.delete(id);
        }
        var unresolved = index.outUnresolved.get(id);
        if (unresolved) {
            unresolved.forEach(function (titleLower) { dropFromSet(index.unresolved, titleLower, id); });
            index.outUnresolved.delete(id);
        }
        var tags = index.noteTags.get(id) || [];
        tags.forEach(function (tag) { dropFromSet(index.tags, tag, id); });
        index.noteTags.delete(id);

        var title = index.titles.get(id);
        if (title && index.byTitle.get(title.toLowerCase()) === id) index.byTitle.delete(title.toLowerCase());

        ['byId', 'contents', 'titles', 'updatedAt', 'headings', 'links'].forEach(function (key) {
            index[key].delete(id);
        });
    }

    function addNote(index, note, options) {
        if (!note || !note.id) return;
        var s = schema();
        if (!s) return;
        var opts = options || {};
        removeNote(index, note.id);

        index.byId.set(note.id, note);
        index.contents.set(note.id, note.content || '');
        index.titles.set(note.id, note.title || '');
        index.updatedAt.set(note.id, note.updatedAt || 0);
        if (note.title) index.byTitle.set(note.title.toLowerCase(), note.id);

        /* 检索 token：标题加权（重复计入，提升标题命中） */
        var tokens = s.tokenize((note.title || '') + '\n' + (note.content || ''));
        index.noteTokens.set(note.id, tokens);
        tokens.forEach(function (token) { addTo(index.tokens, token, note.id); });

        /* 链接 */
        var links = s.parseLinks(note.content || '');
        index.links.set(note.id, links);
        var resolved = new Set();
        var unresolved = new Set();
        links.forEach(function (link) {
            if (link.isEmbed || !link.target) return;
            var targetId = index.byTitle.get(link.target.toLowerCase());
            if (targetId) {
                resolved.add(targetId);
            } else {
                unresolved.add(link.target.toLowerCase());
            }
        });
        if (resolved.size) {
            index.out.set(note.id, resolved);
            resolved.forEach(function (targetId) { addTo(index.inLinks, targetId, note.id); });
        }
        if (unresolved.size) {
            index.outUnresolved.set(note.id, unresolved);
            unresolved.forEach(function (titleLower) { addTo(index.unresolved, titleLower, note.id); });
        }

        /* 标签 */
        var tags = s.parseTags(note.content || '');
        var tagKeys = [];
        tags.forEach(function (tag) {
            var key = tag.toLowerCase();
            if (tagKeys.indexOf(key) > -1) return;
            tagKeys.push(key);
            if (!index.tagDisplay.has(key)) index.tagDisplay.set(key, tag);
            addTo(index.tags, key, note.id);
        });
        if (tagKeys.length) index.noteTags.set(note.id, tagKeys);

        index.headings.set(note.id, s.extractHeadings(note.content || ''));

    }

    /**
     * 从笔记数组全量建索引。
     * 注意：必须建完所有笔记再 rebuildLinks —— 逐篇 addNote 时，
     * 先加入的笔记还不知道后面会出现的标题，`[[后出现的笔记]]` 会被当成未解析。
     */
    function build(notes) {
        var index = create();
        (Array.isArray(notes) ? notes : []).forEach(function (note) { addNote(index, note); });
        return rebuildLinks(index);
    }

    /**
     * 重建链接关系。当新增/重命名笔记后，别处指向它的 `[[标题]]` 会从
     * "未解析" 变成 "已解析"，需要重算一遍（只做链接，不碰 token）。
     */
    function rebuildLinks(index) {
        index.out = new Map();
        index.inLinks = new Map();
        index.outUnresolved = new Map();
        index.unresolved = new Map();
        index.links = new Map();
        var s = schema();
        if (!s) return index;
        index.byId.forEach(function (note, id) {
            var links = s.parseLinks(note.content || '');
            index.links.set(id, links);
            var resolved = new Set();
            var unresolved = new Set();
            links.forEach(function (link) {
                if (link.isEmbed || !link.target) return;
                var targetId = index.byTitle.get(link.target.toLowerCase());
                if (targetId) resolved.add(targetId);
                else unresolved.add(link.target.toLowerCase());
            });
            if (resolved.size) {
                index.out.set(id, resolved);
                resolved.forEach(function (targetId) { addTo(index.inLinks, targetId, id); });
            }
            if (unresolved.size) {
                index.outUnresolved.set(id, unresolved);
                unresolved.forEach(function (titleLower) { addTo(index.unresolved, titleLower, id); });
            }
        });
        return index;
    }

    /* ------------------------------------------------------------------ *
     * 查询
     * ------------------------------------------------------------------ */
    function listOf(map, id) {
        var set = map.get(id);
        return set ? Array.from(set) : [];
    }

    function backlinks(index, id) {
        return listOf(index.inLinks, id).map(function (sourceId) {
            return { id: sourceId, title: index.titles.get(sourceId) || '' };
        });
    }

    function outlinks(index, id) {
        return listOf(index.out, id).map(function (targetId) {
            return { id: targetId, title: index.titles.get(targetId) || '' };
        });
    }

    function unresolvedFor(index, id) {
        var set = index.outUnresolved.get(id);
        return set ? Array.from(set) : [];
    }

    function brokenLinks(index) {
        var out = [];
        index.unresolved.forEach(function (sources, titleLower) {
            var display = titleLower;
            /* 取一个实际写法做展示 */
            sources.forEach(function (sourceId) {
                var links = index.links.get(sourceId) || [];
                for (var i = 0; i < links.length; i += 1) {
                    if (links[i].target && links[i].target.toLowerCase() === titleLower) {
                        display = links[i].target;
                        break;
                    }
                }
            });
            out.push({ title: display, sources: Array.from(sources) });
        });
        out.sort(function (a, b) { return b.sources.length - a.sources.length; });
        return out;
    }

    function tagList(index) {
        var out = [];
        index.tags.forEach(function (ids, key) {
            out.push({ tag: index.tagDisplay.get(key) || key, key: key, count: ids.size });
        });
        out.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return a.tag.localeCompare(b.tag);
        });
        return out;
    }

    function snippetOf(text, needle) {
        var source = String(text || '');
        if (!needle) return '';
        var at = source.toLowerCase().indexOf(needle.toLowerCase());
        if (at === -1) {
            /* 退化为 token 命中位置 */
            var s = schema();
            var tokens = s ? s.tokenize(needle) : [];
            for (var i = 0; i < tokens.length && at === -1; i += 1) {
                at = source.toLowerCase().indexOf(tokens[i]);
            }
        }
        if (at === -1) return source.slice(0, 60);
        var from = Math.max(0, at - 24);
        var to = Math.min(source.length, at + needle.length + 36);
        return (from > 0 ? '…' : '') + source.slice(from, to).replace(/\s+/g, ' ') + (to < source.length ? '…' : '');
    }

    /**
     * 全文搜索。
     * @returns {Array<{id,title,score,snippet,match:'title'|'content'>}}
     */
    function search(index, query, options) {
        var opts = options || {};
        var limit = opts.limit || 40;
        var q = String(query == null ? '' : query).trim();
        if (!q) return [];
        var s = schema();
        if (!s) return [];
        var lower = q.toLowerCase();
        var tokens = s.tokenize(q);
        var hits = new Map();
        var candidates = new Set();

        tokens.forEach(function (token) {
            var ids = index.tokens.get(token);
            if (!ids) return;
            ids.forEach(function (id) {
                hits.set(id, (hits.get(id) || 0) + 1);
                candidates.add(id);
            });
        });
        index.titles.forEach(function (title, id) {
            if ((title || '').toLowerCase().indexOf(lower) > -1) candidates.add(id);
        });

        var results = [];
        candidates.forEach(function (id) {
            var title = index.titles.get(id) || '';
            var titleLower = title.toLowerCase();
            var score = 0;
            var match = 'content';
            if (titleLower === lower) { score = 100; match = 'title'; }
            else if (titleLower.indexOf(lower) === 0) { score = 80; match = 'title'; }
            else if (titleLower.indexOf(lower) > -1) { score = 60; match = 'title'; }
            var tokenHits = hits.get(id) || 0;
            score += Math.min(30, tokenHits * 6);
            if (!score) return;
            results.push({
                id: id,
                title: title,
                score: score,
                match: match,
                snippet: snippetOf(index.contents.get(id) || '', q),
                updatedAt: index.updatedAt.get(id) || 0
            });
        });

        results.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return b.updatedAt - a.updatedAt;
        });
        return results.slice(0, limit);
    }

    /* ------------------------------------------------------------------ *
     * 快速切换（标题模糊匹配）
     * ------------------------------------------------------------------ */
    function fuzzyScore(title, query) {
        if (!query) return 1;
        var target = title.toLowerCase();
        var q = query.toLowerCase();
        if (target === q) return 1000;
        if (target.indexOf(q) === 0) return 700 - target.length;
        var at = target.indexOf(q);
        if (at > -1) return 500 - at * 2 - target.length;

        /* 子序列匹配：连续命中加分 */
        var ti = 0;
        var qi = 0;
        var score = 0;
        var streak = 0;
        while (ti < target.length && qi < q.length) {
            if (target.charAt(ti) === q.charAt(qi)) {
                streak += 1;
                score += 4 + streak * 2;
                qi += 1;
            } else {
                streak = 0;
            }
            ti += 1;
        }
        if (qi < q.length) return 0;
        return score - target.length * 0.2;
    }

    function quickSwitch(index, query, options) {
        var opts = options || {};
        var limit = opts.limit || 20;
        var q = String(query == null ? '' : query).trim();
        var items = [];
        index.byId.forEach(function (note, id) {
            if (note.deletedAt) return;
            var score = fuzzyScore(note.title || '', q);
            if (q && !score) return;
            items.push({ id: id, title: note.title || '', score: score, updatedAt: note.updatedAt || 0 });
        });
        items.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return b.updatedAt - a.updatedAt;
        });
        return items.slice(0, limit);
    }

    function resolveTitle(index, title) {
        var s = schema();
        var key = s ? s.normalizeTitle(title) : String(title || '').trim();
        if (!key) return null;
        return index.byTitle.get(key.toLowerCase()) || null;
    }

    NC.notesIndex = {
        create: create,
        build: build,
        addNote: addNote,
        removeNote: removeNote,
        rebuildLinks: rebuildLinks,
        backlinks: backlinks,
        outlinks: outlinks,
        unresolvedFor: unresolvedFor,
        brokenLinks: brokenLinks,
        tagList: tagList,
        search: search,
        quickSwitch: quickSwitch,
        fuzzyScore: fuzzyScore,
        resolveTitle: resolveTitle
    };
})(window);
