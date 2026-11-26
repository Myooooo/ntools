/**
 * backup.js — 全量备份 / 自动备份 / 恢复（经典脚本，依赖 core/schema/zip）
 * 挂载：NC.backup
 *
 * 设计目标：**换一台机器能完全重建**。一个 ZIP 里包含：
 *   ntools-backup.json   结构化数据（待办 / 聊天 / 邮箱 / 端点 / 笔记正文 / 偏好）
 *   notes/<标题>.md      每篇笔记的纯文本副本（人可读、可单独取用）
 *   files/<文件名>        笔记图片附件（二进制原样）
 *   README.txt           恢复说明
 *
 * 自动备份：没有静默落盘的权限，所以自动备份写到本机 IndexedDB（环形 3 份），
 * 并在设置里提示"建议同时下载 ZIP 存到磁盘"。若 IndexedDB 写不进去，退回提醒用户手动备份。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var util = NC.util;

    var CFG_KEY = 'ntools.backup.cfg';
    var DB_NAME = 'ntools-backup';
    var DB_VERSION = 1;
    var STORE = 'backups';
    var MAX_AUTO = 3;
    var DEFAULT_INTERVAL_HOURS = 24;

    /* 仅导出明确白名单内的界面偏好键，杜绝 ntools.llm.v1（含 API Key）、损坏备份或租约键泄漏进 prefs */
    var PREF_ALLOW = [
        'nchat-theme',
        'nchat-lite-mode',
        'nchat-sessions-collapsed',
        'ntools.rail-collapsed',
        'ntools.startTab',
        'ntools.todo.defaultView',
        'ntools.notes.mode',
        'ntools.notes.side',
        'ntools.notes.welcomeSeeded',
        'ntools.workshop.active',
        'ntools.workshop.collapsed',
        'ntools.workshop.side',
        'boc_email_system_theme',
        'ws-salary-v2',
        'ws-worldclock-v2',
        'ws-countdown',
        'ws-picker-v2',
        'ws-unit',
        'ws-web-requests-v1',
        'ws-calc-v1'
    ];

    var running = null;
    var timer = null;

    function nowTs() { return Date.now(); }

    function readCfg() {
        var cfg = util.parseJSON(global.localStorage.getItem(CFG_KEY), null);
        var out = {
            intervalHours: DEFAULT_INTERVAL_HOURS,
            enabled: true,
            includeKeys: false,
            lastAt: 0,
            lastKind: ''
        };
        if (cfg && typeof cfg === 'object') {
            if (util.isFiniteNum(cfg.intervalHours) && cfg.intervalHours >= 0) out.intervalHours = cfg.intervalHours;
            if (typeof cfg.enabled === 'boolean') out.enabled = cfg.enabled;
            if (typeof cfg.includeKeys === 'boolean') out.includeKeys = cfg.includeKeys;
            if (util.isFiniteNum(cfg.lastAt)) out.lastAt = cfg.lastAt;
            if (typeof cfg.lastKind === 'string') out.lastKind = cfg.lastKind;
        }
        return out;
    }

    function writeCfg(patch) {
        var cfg = readCfg();
        Object.keys(patch || {}).forEach(function (key) { cfg[key] = patch[key]; });
        try { global.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (err) { /* ignore */ }
        return cfg;
    }

    /* ------------------------------------------------------------------ *
     * 数据收集
     * ------------------------------------------------------------------ */
    function ensureChat() {
        var conv = NC.store && NC.store.conversation;
        function initConv() {
            var store = NC.store && NC.store.conversation;
            if (!store || typeof store.init !== 'function') return Promise.resolve(false);
            if (store.isReady && store.isReady()) return Promise.resolve(true);
            var pid = null;
            try { pid = NC.store.llm && NC.store.llm.getState ? NC.store.llm.getState().currentProfileId : null; } catch (err) { pid = null; }
            return Promise.resolve(store.init(pid || 'chat-default')).then(function () { return true; }, function () { return false; });
        }
        if (conv && typeof conv.exportAllSessions === 'function') {
            return initConv();
        }
        if (typeof NC.loadChatBundle !== 'function') return Promise.resolve(false);
        return NC.loadChatBundle().then(initConv, function () { return false; });
    }

    function ensureNotes() {
        if (NC.store && NC.store.notes && NC.store.notes.isReady && NC.store.notes.isReady()) {
            return Promise.resolve(true);
        }
        if (typeof NC.loadNotesBundle !== 'function') return Promise.resolve(false);
        return NC.loadNotesBundle().then(function () {
            if (NC.store && NC.store.notes && NC.store.notes.init) NC.store.notes.init();
            return new Promise(function (resolve) {
                var tries = 40;
                (function wait() {
                    var ready = NC.store && NC.store.notes && NC.store.notes.isReady && NC.store.notes.isReady();
                    if (ready || tries <= 0) { resolve(!!ready); return; }
                    tries -= 1;
                    global.setTimeout(wait, 120);
                })();
            });
        }, function () { return false; });
    }

    function ensureWorkshop() {
        if (NC.store && NC.store.workshop && NC.store.workshop.isReady && NC.store.workshop.isReady()) {
            return Promise.resolve(true);
        }
        if (typeof NC.loadWorkshopBundle !== 'function') return Promise.resolve(false);
        return NC.loadWorkshopBundle().then(function () {
            return NC.store.workshop.init();
        }).then(function () { return true; }, function () { return false; });
    }

    function collectPrefs() {
        var out = {};
        try {
            PREF_ALLOW.forEach(function (key) {
                var value = global.localStorage.getItem(key);
                if (value == null || value.length > 32 * 1024) return;
                out[key] = value;
            });
        } catch (err) { /* ignore */ }
        return out;
    }

    function readEmailDoc() {
        try {
            var raw = global.localStorage.getItem('ntools.email.v1');
            var doc = raw ? util.parseJSON(raw, null) : null;
            if (doc && typeof doc === 'object' && Array.isArray(doc.groups) && Array.isArray(doc.emails)) {
                return { schemaVersion: doc.schemaVersion || 1, revision: doc.revision || 0, groups: doc.groups, emails: doc.emails };
            }
            var groups = util.parseJSON(global.localStorage.getItem('boc_email_system_groups_v1'), null);
            var emails = util.parseJSON(global.localStorage.getItem('boc_email_system_emails_v1'), null);
            if (Array.isArray(groups) || Array.isArray(emails)) {
                return { schemaVersion: 1, revision: 0, groups: Array.isArray(groups) ? groups : [], emails: Array.isArray(emails) ? emails : [] };
            }
        } catch (err) { /* ignore */ }
        return null;
    }

    /**
     * 收集全量数据（结构化 + 图片 Blob 分开返回）
     * @param {{includeKeys?:boolean}} [options]
     * @returns {Promise<{payload:Object, files:Array<{name:string,type:string,blob:Blob}>}>}
     */
    function collect(options) {
        var opts = options || {};
        var includeKeys = opts.includeKeys === true;
        var payload = {
            app: 'nTools',
            kind: 'backup-all',
            schemaVersion: 1,
            version: NC.version || '',
            exportedAt: new Date().toISOString(),
            todo: null,
            chats: null,
            email: null,
            notes: null,
            llm: null,
            prefs: collectPrefs()
        };
        var files = [];

        return Promise.all([ensureChat(), ensureNotes(), ensureWorkshop()]).then(function () {
            try {
                if (NC.store && NC.store.todo && typeof NC.store.todo.exportData === 'function') {
                    payload.todo = NC.store.todo.exportData();
                }
            } catch (err) { payload.todo = null; }
            try {
                if (NC.store && NC.store.conversation && typeof NC.store.conversation.exportAllSessions === 'function') {
                    payload.chats = NC.store.conversation.exportAllSessions();
                }
            } catch (err) { payload.chats = null; }
            try {
                if (NC.store && NC.store.llm && typeof NC.store.llm.exportAll === 'function') {
                    payload.llm = NC.store.llm.exportAll({ includeKeys: includeKeys });
                }
            } catch (err) { payload.llm = null; }
            payload.email = readEmailDoc();
            try {
                if (NC.store && NC.store.notes && typeof NC.store.notes.exportBundle === 'function') {
                    payload.notes = NC.store.notes.exportBundle();
                }
            } catch (err) { payload.notes = null; }
            try {
                if (NC.store && NC.store.workshop && typeof NC.store.workshop.exportData === 'function') {
                    payload.workshop = NC.store.workshop.exportData();
                }
            } catch (err) { payload.workshop = null; }
            if (!NC.notesDb || typeof NC.notesDb.getAllFiles !== 'function') return [];
            return NC.notesDb.getAllFiles();
        }).then(function (records) {
            (records || []).forEach(function (record) {
                if (!record || !record.blob || !record.name) return;
                files.push({ name: record.name, type: record.type || record.blob.type || '', blob: record.blob });
            });
            return { payload: payload, files: files };
        });
    }

    /* ------------------------------------------------------------------ *
     * ZIP
     * ------------------------------------------------------------------ */
    function safeName(name) {
        return String(name || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    }

    function ensureZip() {
        if (NC.zip) return Promise.resolve(true);
        if (!util || typeof util.loadScript !== 'function') return Promise.reject(new Error('加载器不可用'));
        return util.loadScript('js/zip.js').then(function () { return !!NC.zip; });
    }

    function buildZip(bundle, options) {
        var payloadBundle = bundle;
        return ensureZip().then(function (ok) {
            if (!ok) throw new Error('zip 模块未加载');
            return doBuildZip(payloadBundle, options);
        });
    }

    function entryBytes(entry) {
        if (typeof entry.data === 'string') {
            try { return new TextEncoder().encode(entry.data); } catch (err) { return null; }
        }
        return entry.data || null;
    }

    function sha256Hex(bytes) {
        var subtle = global.crypto && global.crypto.subtle;
        if (!subtle || !bytes) return Promise.resolve(null);
        return subtle.digest('SHA-256', bytes).then(function (buffer) {
            var view = new Uint8Array(buffer);
            var out = '';
            for (var i = 0; i < view.length; i += 1) out += (view[i] + 256).toString(16).slice(1);
            return out;
        }).catch(function () { return null; });
    }

    function buildManifest(entries, payload) {
        return Promise.all(entries.map(function (entry) {
            var bytes = entryBytes(entry);
            return sha256Hex(bytes).then(function (hash) {
                var item = { name: entry.name, size: bytes ? bytes.length : 0 };
                if (hash) item.sha256 = hash;
                return item;
            });
        })).then(function (files) {
            var hasHash = files.some(function (item) { return !!item.sha256; });
            return JSON.stringify({
                app: 'nTools',
                kind: 'backup-manifest',
                exportedAt: payload.exportedAt,
                version: payload.version,
                algorithm: hasHash ? 'sha256' : 'none',
                files: files
            }, null, 2);
        });
    }

    function doBuildZip(bundle, options) {
        var opts = options || {};
        if (!NC.zip) return Promise.reject(new Error('zip 模块未加载'));
        var payload = bundle.payload;
        var files = bundle.files || [];
        var entries = [];
        var used = Object.create(null);
        entries.push({ name: 'ntools-backup.json', data: JSON.stringify(payload, null, 2) });

        var noteList = (payload.notes && payload.notes.notes) || [];
        noteList.forEach(function (note) {
            var base = safeName(note.title || '未命名笔记');
            var name = 'notes/' + base + '.md';
            var n = 2;
            while (used[name]) { name = 'notes/' + base + '-' + n + '.md'; n += 1; }
            used[name] = 1;
            entries.push({ name: name, data: String(note.content || '') });
        });

        var workshopApps = (payload.workshop && Array.isArray(payload.workshop.apps)) ? payload.workshop.apps : [];
        workshopApps.forEach(function (app) {
            var code = typeof app.code === 'string' ? app.code : '';
            if (!code) return;
            var wbase = safeName(app.title || '未命名应用');
            var wname = 'workshop/' + wbase + '.html';
            var wn = 2;
            while (used[wname]) { wname = 'workshop/' + wbase + '-' + wn + '.html'; wn += 1; }
            used[wname] = 1;
            entries.push({ name: wname, data: code });
        });

        return Promise.all(files.map(function (file) {
            if (!file.blob || !file.blob.arrayBuffer) return null;
            return file.blob.arrayBuffer().then(function (buffer) {
                return { name: 'files/' + safeName(file.name), data: new Uint8Array(buffer) };
            }).catch(function () { return null; });
        })).then(function (extra) {
            var allEntries = entries.concat(extra.filter(Boolean));
            return buildManifest(allEntries, payload).then(function (manifest) {
                allEntries.push({ name: 'manifest.json', data: manifest });
                allEntries.push({
                    name: 'README.txt',
                    data: [
                        'nTools 全量备份',
                        '导出时间：' + payload.exportedAt,
                        '版本：' + payload.version,
                        '',
                        '文件说明：',
                        '  ntools-backup.json  结构化备份（待办 / 聊天 / 邮箱 / 端点 / 笔记正文 / 偏好）',
                        '  notes/*.md          每篇笔记的纯文本副本',
                        '  files/*             笔记里的图片附件',
                        '  workshop/*.html     创意工坊里保存的自定义应用',
                        '  manifest.json       文件清单 / 大小 / SHA-256 校验和',
                        '',
                        '恢复：打开 nTools → 设置 → 数据 → 从备份恢复（选择 ntools-backup.json）。',
                        '注意：JSON 里若包含 API Key，请妥善保管该压缩包。',
                        ''
                    ].join('\n')
                });
                if (opts.asBlob && typeof NC.zip.buildBlob === 'function') {
                    return NC.zip.buildBlob(allEntries);
                }
                return NC.zip.build(allEntries);
            });
        });
    }

    function stamp() {
        var d = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
    }

    /** 立即备份并下载 ZIP（零拷贝 Blob，降低 ARM 弱机内存峰值） */
    function downloadZip(options) {
        var opts = options || {};
        return collect({ includeKeys: opts.includeKeys === true }).then(function (bundle) {
            return buildZip(bundle, { asBlob: true }).then(function (result) {
                var name = 'ntools-backup-' + stamp() + '.zip';
                var blob = (result instanceof Blob) ? result : new Blob([result], { type: 'application/zip' });
                var ok = util.downloadBlob(name, blob, 'application/zip');
                if (!ok) throw new Error('浏览器阻止了下载');
                writeCfg({ lastAt: nowTs(), lastKind: 'zip' });
                return { ok: true, bytes: blob.size, name: name };
            });
        });
    }

    /* ------------------------------------------------------------------ *
     * 自动备份（IndexedDB 环形）
     * ------------------------------------------------------------------ */
    var dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            var request;
            try { request = global.indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
            request.onupgradeneeded = function (event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
            };
            request.onsuccess = function () {
                var db = request.result;
                db.onversionchange = function () {
                    try { db.close(); } catch (err) { /* ignore */ }
                    dbPromise = null;
                };
                resolve(db);
            };
            request.onerror = function () { dbPromise = null; reject(request.error || new Error('open failed')); };
            request.onblocked = function () { dbPromise = null; reject(new Error('blocked')); };
        });
        return dbPromise;
    }

    function withStore(mode, work) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, mode);
                var store = tx.objectStore(STORE);
                var box = { value: null };
                try { box.value = work(store); } catch (err) { reject(err); return; }
                tx.oncomplete = function () { resolve(box.value); };
                tx.onerror = function () { reject(tx.error || new Error('tx failed')); };
                tx.onabort = function () { reject(tx.error || new Error('tx aborted')); };
            });
        });
    }

    function listAuto() {
        return withStore('readonly', function (store) {
            var box = { value: [] };
            var req = store.openCursor ? store.openCursor() : store.getAll();
            req.onsuccess = function () {
                if (store.openCursor) {
                    var cursor = req.result;
                    if (cursor) {
                        var item = cursor.value;
                        if (item) {
                            box.value.push({ id: item.id, at: item.at, kind: item.kind || 'auto', notes: item.notes, chats: item.chats, bytes: item.bytes });
                        }
                        cursor.continue();
                    } else {
                        box.value.sort(function (a, b) { return b.at - a.at; });
                    }
                } else {
                    box.value = (req.result || []).map(function (item) {
                        return { id: item.id, at: item.at, kind: item.kind || 'auto', notes: item.notes, chats: item.chats, bytes: item.bytes };
                    }).sort(function (a, b) { return b.at - a.at; });
                }
            };
            return box;
        }).then(function (box) { return (box && box.value) || []; });
    }

    function pruneAuto() {
        return listAuto().then(function (items) {
            var extra = items.slice(MAX_AUTO);
            return Promise.all(extra.map(function (item) {
                return withStore('readwrite', function (store) { store.delete(item.id); });
            }));
        });
    }

    /** 自动备份到本机 IndexedDB */
    function runAuto(reason) {
        if (running) return running;
        running = collect({ includeKeys: false }).then(function (bundle) {
            var payloadBytes = 0;
            try { payloadBytes = JSON.stringify(bundle.payload).length; } catch (err) { payloadBytes = 0; }
            var fileBytes = (bundle.files || []).reduce(function (sum, f) { return sum + (f && f.blob ? (f.blob.size || 0) : 0); }, 0);
            var record = {
                id: 'auto-' + nowTs(),
                at: nowTs(),
                kind: reason || 'auto',
                payload: bundle.payload,
                files: bundle.files,
                notes: bundle.payload.notes ? bundle.payload.notes.notes.length : 0,
                chats: bundle.payload.chats && bundle.payload.chats.sessions ? bundle.payload.chats.sessions.length : 0,
                bytes: payloadBytes + fileBytes
            };
            return withStore('readwrite', function (store) { store.put(record); }).then(function () {
                writeCfg({ lastAt: nowTs(), lastKind: reason || 'auto' });
                return pruneAuto().then(function () { return { ok: true, at: record.at }; });
            });
        }).catch(function (err) {
            return { ok: false, error: err };
        }).then(function (result) {
            running = null;
            return result;
        });
        return running;
    }

    function readAuto(id) {
        return withStore('readonly', function (store) {
            var box = { value: null };
            var req = store.get(id);
            req.onsuccess = function () { box.value = req.result || null; };
            return box;
        }).then(function (box) { return (box && box.value) || null; });
    }

    /* ------------------------------------------------------------------ *
     * 恢复
     * ------------------------------------------------------------------ */
    function applyPrefs(prefs) {
        if (!prefs || typeof prefs !== 'object') return 0;
        var count = 0;
        Object.keys(prefs).forEach(function (key) {
            if (PREF_ALLOW.indexOf(key) === -1) return;
            try {
                global.localStorage.setItem(key, String(prefs[key]));
                count += 1;
            } catch (err) { /* ignore */ }
        });
        return count;
    }

    function applyEmail(email) {
        if (!email || (!email.groups && !email.emails)) return false;
        try {
            var prev = global.localStorage.getItem('ntools.email.v1');
            if (prev) global.localStorage.setItem('ntools.email.v1.preimport', prev);
            var prevRev = 0;
            try { var parsed = util.parseJSON(prev, null); prevRev = parsed && util.isFiniteNum(parsed.revision) ? parsed.revision : 0; } catch (err) { prevRev = 0; }
            global.localStorage.setItem('ntools.email.v1', JSON.stringify({
                schemaVersion: 1,
                revision: prevRev + 1,
                updatedAt: nowTs(),
                groups: Array.isArray(email.groups) ? email.groups : [],
                emails: Array.isArray(email.emails) ? email.emails : []
            }));
            If_emitEmail();
            return true;
        } catch (err) { return false; }
    }

    function If_emitEmail() {
        try { if (NC.events && NC.events.emit) NC.events.emit(NC.eventNames.emailImported); } catch (err) { /* ignore */ }
    }

    /** 从结构化备份恢复（先自动打一份「恢复前快照」） */
    function restorePayload(payload, options) {
        return runAuto('pre-restore').then(function () {
            return applyPayload(payload, options);
        }, function () {
            return applyPayload(payload, options);
        });
    }

    /** 实际恢复逻辑（payload 与 ZIP 里的 ntools-backup.json 同构） */
    function applyPayload(payload, options) {
        var opts = options || {};
        if (!payload || typeof payload !== 'object') return Promise.reject(new Error('备份内容无效'));
        var done = [];
        var failed = [];

        var prefCount = applyPrefs(payload.prefs);
        if (prefCount) done.push('偏好 ' + prefCount + ' 项');

        if (payload.email) { if (applyEmail(payload.email)) done.push('邮箱'); else failed.push('邮箱'); }

        if (payload.llm && NC.store && NC.store.llm && NC.store.llm.importAll) {
            try {
                var llmRes = NC.store.llm.importAll(payload.llm, { merge: false });
                if (llmRes && llmRes.ok) done.push('AI 端点'); else failed.push('AI 端点');
            } catch (err) { failed.push('AI 端点'); }
        }

        if (payload.todo && NC.store && NC.store.todo && NC.store.todo.importDoc) {
            try {
                if (NC.store.todo.isReadOnly && NC.store.todo.isReadOnly()) failed.push('待办（只读）');
                else { NC.store.todo.importDoc(payload.todo, 'replace'); done.push('待办'); }
            } catch (err) { failed.push('待办'); }
        }

        return ensureChat().then(function () {
            var sessions = payload.chats && Array.isArray(payload.chats.sessions) ? payload.chats.sessions : null;
            if (!sessions || !sessions.length) return null;   // 空备份不算失败
            if (!(NC.store && NC.store.conversation && NC.store.conversation.importAllSessions)) {
                failed.push('聊天');
                return null;
            }
            return NC.store.conversation.importAllSessions(payload.chats).then(function (res) {
                if (res && res.ok) done.push('聊天'); else failed.push('聊天');
            }, function () { failed.push('聊天'); });
        }).then(function () {
            return ensureNotes();
        }).then(function () {
            if (payload.notes && NC.store && NC.store.notes && NC.store.notes.importVault) {
                return NC.store.notes.importVault(payload.notes, { mode: 'replace' }).then(function (res) {
                    if (res && res.ok) done.push('笔记'); else failed.push('笔记');
                }, function () { failed.push('笔记'); });
            }
        }).then(function () {
            return opts.files && opts.files.length ? restoreFiles(opts.files) : null;
        }).then(function (fileCount) {
            if (fileCount) done.push('图片 ' + fileCount + ' 张');
            return restoreWorkshop(payload.workshop, done, failed);
        }).then(function () {
            return { ok: failed.length === 0, done: done, failed: failed };
        });
    }

    function restoreWorkshop(workshop, done, failed) {
        if (!workshop || (!workshop.apps && !workshop.versions)) return Promise.resolve(null);
        var store = NC.store && NC.store.workshop;
        if (!store || !store.importData) {
            return ensureWorkshop().then(function (ok) {
                if (!ok || !NC.store.workshop.importData) { failed.push('创意工坊'); return null; }
                return NC.store.workshop.importData(workshop).then(function (res) {
                    if (res && res.ok) done.push('创意工坊 ' + res.apps + ' 个应用');
                    else failed.push('创意工坊');
                }, function () { failed.push('创意工坊'); });
            });
        }
        return store.importData(workshop).then(function (res) {
            if (res && res.ok) done.push('创意工坊 ' + res.apps + ' 个应用');
            else failed.push('创意工坊');
        }, function () { failed.push('创意工坊'); });
    }

    function restoreFiles(files) {
        if (!NC.notesDb || typeof NC.notesDb.putFile !== 'function') return 0;
        var list = [];
        return Promise.all((files || []).map(function (file) {
            if (!file || !file.blob || !file.name) return null;
            var id = 'img-restore-' + Math.random().toString(36).slice(2, 10);
            var meta = { id: id, name: file.name, type: file.type || '', size: file.blob.size || 0 };
            list.push(meta);
            return NC.notesDb.putFile(id, file.blob, meta).catch(function () { return null; });
        })).then(function () {
            if (list.length) {
                return NC.notesDb.setMeta('files', list).then(function () { return list.length; }, function () { return list.length; });
            }
            return 0;
        });
    }

    function restoreAuto(id) {
        return readAuto(id).then(function (record) {
            if (!record || !record.payload) throw new Error('备份不存在');
            return restorePayload(record.payload, { files: record.files || [] });
        });
    }

    function deleteAuto(id) {
        return withStore('readwrite', function (store) { store.delete(id); });
    }

    /** 从 JSON 文件内容恢复（ZIP 内的 ntools-backup.json 或旧版全量备份都可） */
    function restoreFromJson(raw) {
        var data = typeof raw === 'string' ? util.parseJSON(raw, null) : raw;
        if (!data || typeof data !== 'object') return Promise.reject(new Error('不是有效的 JSON 备份'));
        if (data.kind === 'backup-all' || data.kind === 'full-backup' || data.todo || data.chats || data.notes || data.workshop) {
            var payload = data.kind === 'backup-all' ? data : {
                app: 'nTools', kind: 'backup-all', exportedAt: data.exportedAt || '',
                todo: data.todo, chats: data.chats, email: data.email, notes: data.notes || null,
                llm: data.llm, workshop: data.workshop || null, prefs: data.prefs || {}
            };
            return restorePayload(payload, {});
        }
        return Promise.reject(new Error('备份格式不受支持'));
    }

    /* ------------------------------------------------------------------ *
     * 调度
     * ------------------------------------------------------------------ */
    function status() {
        var cfg = readCfg();
        var intervalMs = Math.max(0, cfg.intervalHours) * 3600 * 1000;
        return {
            enabled: cfg.enabled && cfg.intervalHours > 0,
            intervalHours: cfg.intervalHours,
            includeKeys: cfg.includeKeys,
            lastAt: cfg.lastAt,
            lastKind: cfg.lastKind,
            nextAt: cfg.intervalHours > 0 ? cfg.lastAt + intervalMs : 0,
            due: cfg.enabled && cfg.intervalHours > 0 && (nowTs() - cfg.lastAt >= intervalMs)
        };
    }

    function setIntervalHours(hours) {
        var value = Number(hours);
        if (!isFinite(value) || value < 0) return status();
        writeCfg({ intervalHours: value });
        return status();
    }

    function tick() {
        var cfg = readCfg();
        if (!cfg.enabled || cfg.intervalHours <= 0) return;
        var intervalMs = cfg.intervalHours * 3600 * 1000;
        if (nowTs() - cfg.lastAt < intervalMs) return;
        runAuto('auto').then(function (res) {
            if (!res || !res.ok) {
                try {
                    NC.ui.toast('自动备份失败，请到「设置 → 数据」手动备份', { type: 'error', duration: 8000 });
                } catch (err) { /* ignore */ }
                return;
            }
            try {
                NC.ui.toast('已完成自动备份（保存在本机）', {
                    type: 'success',
                    duration: 8000,
                    action: {
                        label: '下载 ZIP',
                        onClick: function () { downloadZip({ includeKeys: false }).catch(function () { /* ignore */ }); }
                    }
                });
            } catch (err) { /* ignore */ }
        });
    }

    function startScheduler() {
        if (timer || !global.setInterval) return;
        timer = global.setInterval(tick, 60 * 1000);
        global.setTimeout(tick, 12 * 1000);   // 启动后稍等再检查，避免拖慢首屏
    }

    NC.backup = {
        collect: collect,
        buildZip: buildZip,
        downloadZip: downloadZip,
        runAuto: runAuto,
        listAuto: listAuto,
        readAuto: readAuto,
        restoreAuto: restoreAuto,
        deleteAuto: deleteAuto,
        restorePayload: restorePayload,
        restoreFromJson: restoreFromJson,
        status: status,
        setIntervalHours: setIntervalHours,
        readCfg: readCfg,
        writeCfg: writeCfg,
        startScheduler: startScheduler,
        readEmailDoc: readEmailDoc
    };
})(window);
