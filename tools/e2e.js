#!/usr/bin/env node
/**
 * tools/e2e.js — 关键交互端到端验收（CDP 无头 Chrome）
 *
 * 覆盖：
 *   nTools：空状态、新增、完成、搜索、视图切换、删除+撤销、键盘操作、数据持久化
 *   nChat：配置保存、主题/Lite、欢迎语、图片暂存、无配置发送提示
 *
 * 用法：node tools/e2e.js
 * 退出码：0 全部通过；1 有失败。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = path.resolve(__dirname, '..');
const PORT = 9500 + (process.pid % 200);
const URL_TODO = 'file://' + path.join(ROOT, 'ntools.html').split(path.sep).join('/');
const URL_CHAT = 'file://' + path.join(ROOT, 'index.html').split(path.sep).join('/');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Client {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.handlers = [];
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) reject(new Error(JSON.stringify(message.error)));
                else resolve(message.result);
                return;
            }
            this.handlers.forEach((handler) => handler(message));
        });
    }
    send(method, params) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params: params || {} }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error('CDP timeout ' + method));
                }
            }, 20000);
        });
    }
}

async function makePage(port) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    const client = new Client(ws);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    return client;
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
        throw new Error('evaluate failed: ' + (result.exceptionDetails.exception && result.exceptionDetails.exception.description || result.exceptionDetails.text));
    }
    return result.result.value;
}

async function navigate(client, url) {
    const loaded = new Promise((resolve) => {
        const handler = (message) => {
            if (message.method === 'Page.loadEventFired') {
                client.handlers = client.handlers.filter((h) => h !== handler);
                resolve();
            }
        };
        client.handlers.push(handler);
        setTimeout(resolve, 15000);
    });
    await client.send('Page.navigate', { url });
    await loaded;
    await waitFor(client, "typeof window.NC !== 'undefined'", 8000);
    await sleep(500);
}

async function waitFor(client, expression, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 5000)) {
        try {
            if (await evaluate(client, expression)) return true;
        } catch (err) { /* retry */ }
        await sleep(120);
    }
    return false;
}

async function click(client, selector) {
    await evaluate(client, `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    await sleep(280);
}

async function setValue(client, selector, value) {
    await evaluate(client, `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await sleep(120);
}

async function press(client, selector, key) {
    await evaluate(client, `(function(){
        var el = document.querySelector(${JSON.stringify(selector)}) || document.activeElement || document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
        return true;
    })()`);
    await sleep(260);
}

function makeReport() {
    const results = [];
    return {
        results,
        assert(name, pass, detail) {
            results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
            return !!pass;
        }
    };
}

async function runTodo(client, report) {
    await navigate(client, URL_TODO);
    await evaluate(client, 'localStorage.clear(); true;');
    await navigate(client, URL_TODO);
    await waitFor(client, "document.querySelector('#todo-empty') && !document.querySelector('#todo-empty').hidden", 5000);

    report.assert('空状态可见', await evaluate(client, "document.querySelector('#todo-empty') && !document.querySelector('#todo-empty').hidden"));
    report.assert('初始 0 项', await evaluate(client, "NC.store.todo.getDoc().tasks.length === 0"));

    // 新增
    await setValue(client, '#todo-new-title', '季度报表');
    await press(client, '#todo-new-title', 'Enter');
    await waitFor(client, "document.querySelectorAll('.todo-item').length === 1", 3000);
    const added = await evaluate(client, `(function(){
        var items = document.querySelectorAll('.todo-item');
        var doc = NC.store.todo.getDoc();
        return { items: items.length, title: items[0] ? items[0].textContent.indexOf('季度报表') > -1 : false,
                 stored: doc.tasks.length, ls: !!localStorage.getItem('ntools.todo.v2'),
                 state: items[0] ? items[0].getAttribute('data-status') : null };
    })()`);
    report.assert('新增任务渲染', added.items === 1 && added.title, JSON.stringify(added));
    report.assert('新增任务持久化', added.stored === 1 && added.ls, JSON.stringify(added));

    // 完成
    await click(client, '.todo-item__check');
    await sleep(300);
    const toggled = await evaluate(client, `(function(){
        var doc = NC.store.todo.getDoc();
        var counts = NC.store.todo.counts();
        return { status: doc.tasks[0] && doc.tasks[0].status, done: counts.done, open: counts.open };
    })()`);
    report.assert('勾选完成', toggled.status === 'done' && toggled.done === 1, JSON.stringify(toggled));

    // 取消完成
    await click(client, '.todo-item__check');
    await sleep(300);
    report.assert('取消完成', (await evaluate(client, 'NC.store.todo.getDoc().tasks[0].status')) === 'open');

    // 搜索
    await setValue(client, '#todo-search', '不存在关键字');
    await sleep(400);
    report.assert('搜索为空结果', (await evaluate(client, "document.querySelectorAll('.todo-item').length === 0")));
    await evaluate(client, `(function(){ var b = document.querySelector('#todo-search-clear'); if (b) b.click(); return true; })()`);
    await sleep(300);
    report.assert('清除搜索恢复', (await evaluate(client, "document.querySelectorAll('.todo-item').length === 1")));

    // 视图切换
    await click(client, '[data-view="done"]');
    await sleep(300);
    report.assert('已完成视图筛选', (await evaluate(client, "document.querySelectorAll('.todo-item').length === 0")));
    await click(client, '[data-view="all"]');
    await sleep(300);

    // 删除 + 撤销
    const deleteSelector = '.todo-item__actions [data-act="delete"], .todo-item [data-act="delete"]';
    await click(client, deleteSelector);
    await sleep(500);
    const deleted = await evaluate(client, `(function(){
        var doc = NC.store.todo.getDoc();
        var toast = document.querySelector('.nc-toast');
        return { tasks: doc.tasks.length, deleted: doc.tasks.filter(function(t){return !!t.deletedAt;}).length,
                 toast: toast ? toast.textContent : '' };
    })()`);
    report.assert('删除进入回收站/软删', deleted.deleted === 1, JSON.stringify(deleted));
    const undo = await evaluate(client, `(function(){
        var btn = document.querySelector('.nc-toast__action');
        if (!btn) return false;
        btn.click();
        return true;
    })()`);
    await sleep(400);
    const undone = await evaluate(client, `(function(){
        var doc = NC.store.todo.getDoc();
        return { tasks: doc.tasks.length, visible: document.querySelectorAll('.todo-item').length };
    })()`);
    report.assert('撤销恢复删除', undo && undone.tasks === 1 && undone.visible === 1, JSON.stringify(undone));

    // 键盘撤销（再删一次后 Ctrl+Z）
    await click(client, deleteSelector);
    await sleep(400);
    await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true;`);
    await sleep(400);
    const kbUndo = await evaluate(client, `(function(){
        var doc = NC.store.todo.getDoc();
        return { tasks: doc.tasks.length, deleted: doc.tasks.filter(function(t){return !!t.deletedAt;}).length };
    })()`);
    report.assert('Ctrl+Z 撤销', kbUndo.deleted === 0, JSON.stringify(kbUndo));

    // 刷新持久化
    await navigate(client, URL_TODO);
    await waitFor(client, "document.querySelectorAll('.todo-item').length === 1", 4000);
    report.assert('刷新后任务仍在', (await evaluate(client, "document.querySelectorAll('.todo-item').length === 1 && NC.store.todo.getDoc().tasks.length === 1")));

    // 筛选计数
    const counts = await evaluate(client, "JSON.stringify(NC.store.todo.counts())");
    report.assert('计数可用', counts.indexOf('"open":1') > -1, counts);
}

async function runChat(client, report) {
    await navigate(client, URL_CHAT);
    await evaluate(client, 'localStorage.clear(); true;');
    await navigate(client, URL_CHAT);
    await sleep(800);

    report.assert('欢迎语', await evaluate(client, "document.querySelectorAll('.message').length >= 1"));
    report.assert('默认配置已创建', await evaluate(client, "!!NC.store.settings.getConfig() && NC.store.settings.getConfig().modelId === 'gpt-4o'"));

    // 保存配置
    await evaluate(client, `(function(){ document.getElementById('toggle-settings-btn').click(); return true; })()`);
    await sleep(300);
    await setValue(client, '#config-name', '测试配置');
    await setValue(client, '#api-url', 'https://example.com/v1');
    await setValue(client, '#api-key', 'sk-test');
    await setValue(client, '#model-id', 'test-model');
    await click(client, '#save-settings-btn');
    await sleep(400);
    const saved = await evaluate(client, `(function(){
        var raw = localStorage.getItem('nchat-settings');
        var doc = raw ? JSON.parse(raw) : null;
        var cfg = doc && doc.configs ? doc.configs[0] : null;
        return { has: !!cfg, name: cfg && cfg.name, url: cfg && cfg.apiUrl, model: cfg && cfg.modelId,
                 version: doc && doc.version, title: document.getElementById('app-title').textContent };
    })()`);
    report.assert('配置保存到存储', saved.has && saved.name === '测试配置' && saved.model === 'test-model', JSON.stringify(saved));
    report.assert('标题同步配置名', saved.title.indexOf('测试配置') > -1, saved.title);

    // 主题切换
    await evaluate(client, `(function(){ document.getElementById('menu-btn').click(); return true; })()`);
    await sleep(200);
    await evaluate(client, `(function(){ document.getElementById('theme-toggle-btn').click(); return true; })()`);
    await sleep(300);
    const theme = await evaluate(client, `({ theme: document.documentElement.getAttribute('data-theme'), stored: localStorage.getItem('nchat-theme') })`);
    report.assert('主题切换并持久化', theme.theme === 'light' && theme.stored === 'light', JSON.stringify(theme));

    // Lite 切换
    await evaluate(client, `(function(){ document.getElementById('menu-btn').click(); return true; })()`);
    await sleep(200);
    await evaluate(client, `(function(){ document.getElementById('lite-mode-btn').click(); return true; })()`);
    await sleep(300);
    const lite = await evaluate(client, `({ lite: document.documentElement.getAttribute('data-lite'), stored: localStorage.getItem('nchat-lite-mode') })`);
    report.assert('Lite 切换并持久化', lite.lite === 'true' && lite.stored === 'true', JSON.stringify(lite));

    // 图片暂存（构造 File 走 input change）
    await evaluate(client, `(function(){
        var canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
        var ctx = canvas.getContext('2d'); ctx.fillStyle = '#5b8cff'; ctx.fillRect(0,0,64,64);
        return new Promise(function(resolve){
            canvas.toBlob(function(blob){
                var file = new File([blob], 'test.png', { type: 'image/png' });
                var dt = new DataTransfer(); dt.items.add(file);
                var input = document.getElementById('image-input');
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                resolve(true);
            }, 'image/png');
        });
    })()`);
    await waitFor(client, "document.querySelectorAll('#image-preview-container img').length > 0", 5000);
    report.assert('图片暂存预览', await evaluate(client, "document.querySelectorAll('#image-preview-container img').length > 0"));

    // 无 Key 发送提示（清空 key 后发送）
    await evaluate(client, `(function(){
        var raw = localStorage.getItem('nchat-settings'); var doc = JSON.parse(raw);
        doc.configs[0].apiKey = ''; localStorage.setItem('nchat-settings', JSON.stringify(doc));
        location.reload(); return true;
    })()`);
    await sleep(1800);
    await setValue(client, '#user-input', '测试消息');
    await evaluate(client, `(function(){ document.getElementById('send-btn').click(); return true; })()`);
    await sleep(600);
    const noKey = await evaluate(client, `(function(){
        var text = document.body.textContent || '';
        return { hint: text.indexOf('请先完成') > -1 || text.indexOf('API') > -1, msgs: document.querySelectorAll('.message').length };
    })()`);
    report.assert('缺配置发送有提示', noKey.hint, JSON.stringify(noKey));
}

async function runChatStreaming(client, report) {
    await navigate(client, URL_CHAT);
    await evaluate(client, `(function(){
        localStorage.clear();
        localStorage.setItem('nchat-settings', JSON.stringify({
            version: 2, currentId: 'cfg-mock-1',
            configs: [{ id: 'cfg-mock-1', name: 'Mock 配置', apiUrl: 'https://mock.local/v1',
                apiKey: 'sk-mock', modelId: 'mock-model', systemPrompt: '',
                enableAdvanced: false, temperature: 1, top_p: 0.95 }]
        }));
        return true;
    })()`);
    await navigate(client, URL_CHAT);
    await sleep(500);

    // mock 流式 SSE
    const mockOk = await evaluate(client, `(function(){
        window.__mockCalls = [];
        window.fetch = function (url, opts) {
            try { window.__mockCalls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null }); } catch (e) {}
            var enc = new TextEncoder();
            var chunks = [
                'data: {"choices":[{"delta":{"reasoning_content":"让我想想…"}}]}\\n\\n',
                'data: {"choices":[{"delta":{"content":"你好"}}]}\\n\\n',
                'data: {"choices":[{"delta":{"content":"，世界"}}]}\\n\\n',
                'data: {"choices":[{"delta":{"content":"！"}}]}\\n\\n',
                'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16}}\\n\\n',
                'data: [DONE]\\n\\n'
            ];
            var stream = new ReadableStream({ start: function (c) {
                var i = 0;
                var timer = setInterval(function () {
                    if (i >= chunks.length) { clearInterval(timer); try { c.close(); } catch (e) {} return; }
                    c.enqueue(enc.encode(chunks[i++]));
                }, 40);
            }});
            return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
        };
        return true;
    })()`);
    report.assert('mock fetch 注入', mockOk);

    await setValue(client, '#user-input', '测试流式');
    await evaluate(client, `(function(){ document.getElementById('send-btn').click(); return true; })()`);
    await waitFor(client, "document.querySelectorAll('.chat-msg--assistant').length >= 1", 6000);
    await sleep(900);

    const streamed = await evaluate(client, `(function(){
        var assistants = document.querySelectorAll('.chat-msg--assistant');
        var last = assistants[assistants.length - 1];
        var text = last ? last.textContent : '';
        var call = window.__mockCalls[0] || {};
        var payload = call.body || {};
        var whitelist = (payload.messages || []).every(function (m) {
            return Object.keys(m).sort().join(',') === 'content,role';
        });
        var details = last ? last.querySelector('details, .chat-reasoning') : null;
        return {
            text: text,
            hasContent: text.indexOf('你好，世界！') > -1,
            hasReasoning: !!details && text.indexOf('让我想想') > -1,
            hasStats: !!(last && last.querySelector('.chat-stats__btn')),
            domCount: document.querySelectorAll('.message').length,
            assistants: assistants.length,
            calls: (window.__mockCalls || []).length,
            errors: Array.prototype.map.call(document.querySelectorAll('.message.error'), function(e){ return e.textContent.slice(0,120); }),
            whitelist: whitelist,
            url: call.url,
            stream: payload.stream === true
        };
    })()`);
    report.assert('流式回复渲染', streamed.hasContent, JSON.stringify({ text: streamed.text.slice(0, 120), domCount: streamed.domCount, assistants: streamed.assistants, calls: streamed.calls, errors: streamed.errors }));
    report.assert('思考过程展示', streamed.hasReasoning);
    report.assert('统计入口存在', streamed.hasStats);
    report.assert('请求 payload 白名单', streamed.whitelist && streamed.stream, JSON.stringify({ whitelist: streamed.whitelist, stream: streamed.stream, url: streamed.url }));
    report.assert('请求 URL 正确', /\/chat\/completions$/.test(streamed.url || ''), streamed.url);

    // 停止生成
    await evaluate(client, `(function(){
        window.__mockInfinite = true;
        window.fetch = function (url, opts) {
            var enc = new TextEncoder();
            var stream = new ReadableStream({ start: function (c) {
                c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"持续输出中"}}]}\\n\\n'));
                window.__mockStopTimer = setInterval(function () {
                    try { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"…"}}]}\\n\\n')); } catch (e) { clearInterval(window.__mockStopTimer); }
                }, 120);
            }});
            return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
        };
        return true;
    })()`);
    await setValue(client, '#user-input', '测试停止');
    await evaluate(client, `(function(){ document.getElementById('send-btn').click(); return true; })()`);
    await sleep(600);
    const stopMode = await evaluate(client, "document.getElementById('send-btn').classList.contains('is-stop')");
    await evaluate(client, `(function(){ document.getElementById('send-btn').click(); return true; })()`);
    await sleep(700);
    const stopped = await evaluate(client, `(function(){
        var btn = document.getElementById('send-btn');
        var box = document.getElementById('user-input');
        return { stopMode: btn.classList.contains('is-stop'), disabled: box.disabled,
                 text: document.body.textContent.indexOf('持续输出中') > -1 };
    })()`);
    report.assert('流式时可停止', stopMode);
    report.assert('停止后恢复输入并保留内容', !stopped.stopMode && !stopped.disabled && stopped.text, JSON.stringify(stopped));
}

async function runTodoPerf(client, report) {
    await navigate(client, URL_TODO);
    await evaluate(client, 'localStorage.clear(); true;');
    await navigate(client, URL_TODO);
    await waitFor(client, "!!(window.NC && NC.store && NC.store.todo)", 5000);

    const perf = await evaluate(client, `(function(){
        var tasks = [];
        var now = Date.now();
        for (var i = 0; i < 500; i++) {
            tasks.push({
                id: 'perf-' + i, listId: 'list_default', title: '性能任务 ' + i,
                notes: '', status: 'open', priority: i % 4 === 0 ? 'high' : 'normal',
                due: now + (i % 30) * 86400000, dueAllDay: false, tags: [],
                subtasks: [], recurrence: null, reminder: null, order: i * 1024,
                createdAt: now, updatedAt: now, completedAt: null, deletedAt: null, source: 'perf'
            });
        }
        var start = performance.now();
        NC.store.todo.importDoc({
            schemaVersion: 2, revision: 1, updatedAt: now,
            lists: [{ id: 'list_default', name: '待办', color: '#5b8cff', order: 0, archived: false, createdAt: now, updatedAt: now }],
            tasks: tasks,
            settings: { defaultListId: 'list_default', view: 'all', sort: 'smart', showCompleted: true, reminderLeadMinutes: 15, compact: false },
            meta: { app: 'nTools', appVersion: '2.0.0', migratedFrom: null, migratedAt: null, quarantine: [] }
        }, 'replace');
        var elapsed = performance.now() - start;
        return { elapsed: elapsed, docTasks: NC.store.todo.getDoc().tasks.length, domItems: document.querySelectorAll('.todo-item').length };
    })()`);
    await sleep(500);
    const rendered = await evaluate(client, `({ dom: document.querySelectorAll('.todo-item').length, scrollTop: (document.getElementById('todo-scroll') || {}).scrollTop })`);
    report.assert('500 条任务导入', perf.docTasks === 500, JSON.stringify({ elapsed: Math.round(perf.elapsed), docTasks: perf.docTasks }));
    report.assert('500 条任务渲染', rendered.dom >= 500, 'dom=' + rendered.dom);
    report.assert('500 条渲染耗时 < 500ms', perf.elapsed < 500, Math.round(perf.elapsed) + 'ms');

    const searchPerf = await evaluate(client, `(function(){
        var start = performance.now();
        NC.store.todo.setSearch('性能任务 49');
        return performance.now() - start;
    })()`);
    await sleep(400);
    const searched = await evaluate(client, "document.querySelectorAll('.todo-item').length");
    report.assert('500 条搜索响应 < 300ms', searchPerf < 300, Math.round(searchPerf) + 'ms');
    report.assert('搜索命中合理', searched > 0 && searched < 50, 'items=' + searched);

    // 清理
    await evaluate(client, 'localStorage.clear(); true;');
}

async function runSecurity(client, report) {
    // ---- 配置导出默认脱敏 ----
    await navigate(client, URL_CHAT);
    await evaluate(client, `(function(){
        localStorage.clear();
        localStorage.setItem('nchat-settings', JSON.stringify({
            version: 2, currentId: 'cfg-sec-1',
            configs: [{ id: 'cfg-sec-1', name: '安全测试', apiUrl: 'https://mock.local/v1',
                apiKey: 'sk-secret', modelId: 'mock', systemPrompt: '',
                enableAdvanced: false, temperature: 1, top_p: 0.95 }]
        }));
        return true;
    })()`);
    await navigate(client, URL_CHAT);
    await sleep(600);
    const masked = await evaluate(client, `(function(){
        var plain = NC.store.settings.exportConfigs({ includeKey: false });
        var withKey = NC.store.settings.exportConfigs({ includeKey: true });
        var plainCfg = plain.configs[0] || {};
        var withKeyCfg = withKey.configs[0] || {};
        return {
            masked: !('apiKey' in plainCfg) || plainCfg.apiKey === '',
            included: withKeyCfg.apiKey === 'sk-secret',
            flags: [plain.keysIncluded, withKey.keysIncluded]
        };
    })()`);
    report.assert('导出配置默认脱敏', masked.masked && masked.flags[0] === false, JSON.stringify(masked));
    report.assert('显式包含密钥才导出', masked.included && masked.flags[1] === true, JSON.stringify(masked));

    // ---- 聊天 Markdown XSS（mock SSE 返回恶意内容） ----
    await evaluate(client, `(function(){
        window.__xss = 0;
        window.fetch = function () {
            var enc = new TextEncoder();
            var html = '安全测试 <img src=x onerror="window.__xss=1"> <script>window.__xss=2<\\/script> [链接](javascript:window.__xss=3) <b>粗体</b>';
            var chunk = 'data: ' + JSON.stringify({ choices: [{ delta: { content: html } }] }) + '\\n\\n';
            var stream = new ReadableStream({ start: function (c) {
                c.enqueue(enc.encode(chunk));
                c.enqueue(enc.encode('data: [DONE]\\n\\n'));
                try { c.close(); } catch (e) {}
            }});
            return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
        };
        var input = document.getElementById('user-input');
        input.value = '安全检查';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send-btn').click();
        return true;
    })()`);
    await waitFor(client, "document.querySelectorAll('.chat-msg--assistant').length >= 1", 6000);
    await sleep(700);
    const chatXss = await evaluate(client, `(function(){
        var md = document.querySelector('.chat-md');
        return {
            xss: window.__xss || 0,
            scripts: document.querySelectorAll('.chat-md script').length,
            onerrorImgs: document.querySelectorAll('.chat-md img[onerror]').length,
            jsLinks: document.querySelectorAll('.chat-md a[href^="javascript"]').length,
            text: md ? md.textContent.slice(0, 120) : ''
        };
    })()`);
    report.assert('聊天内容 XSS 被净化', chatXss.xss === 0 && chatXss.scripts === 0 && chatXss.onerrorImgs === 0 && chatXss.jsLinks === 0, JSON.stringify(chatXss));

    // ---- Todo 导入 XSS ----
    await navigate(client, URL_TODO);
    await evaluate(client, 'localStorage.clear(); true;');
    await navigate(client, URL_TODO);
    await waitFor(client, "!!(window.NC && NC.store && NC.store.todo)", 5000);
    const todoXss = await evaluate(client, `(function(){
        window.__xss = 0;
        var now = Date.now();
        NC.store.todo.importDoc({
            schemaVersion: 2, revision: 1, updatedAt: now,
            lists: [{ id: 'list_default', name: '待办', color: '#5b8cff', order: 0, archived: false, createdAt: now, updatedAt: now }],
            tasks: [{
                id: 'xss-task-1', listId: 'list_default',
                title: '<img src=x onerror="window.__xss=1">危险标题',
                notes: '<script>window.__xss=2<\\/script>',
                status: 'open', priority: 'normal', due: null, dueAllDay: false,
                tags: ['<svg onload=window.__xss=3>'], subtasks: [], recurrence: null, reminder: null,
                order: 1024, createdAt: now, updatedAt: now, completedAt: null, deletedAt: null, source: 'test'
            }],
            settings: {}, meta: { app: 'nTools', appVersion: '2.0.0', migratedFrom: null, migratedAt: null, quarantine: [] }
        }, 'replace');
        return true;
    })()`);
    await sleep(700);
    const todoResult = await evaluate(client, `(function(){
        var row = document.querySelector('.todo-item__title');
        return {
            xss: window.__xss || 0,
            imgs: document.querySelectorAll('.todo-item img, .todo-item svg[onload]').length,
            scripts: document.querySelectorAll('.todo-item script').length,
            text: row ? row.textContent.slice(0, 80) : '',
            textShowsRaw: row ? row.textContent.indexOf('<img') > -1 : false
        };
    })()`);
    report.assert('Todo 导入 XSS 被转义', todoResult.xss === 0 && todoResult.imgs === 0 && todoResult.scripts === 0, JSON.stringify(todoResult));
    report.assert('Todo 恶意标题按纯文本显示', todoResult.textShowsRaw, todoResult.text);

    // ---- Markdown 工具净化 ----
    await navigate(client, URL_TODO);
    await evaluate(client, `(function(){ var tab = document.querySelector('[data-tab="md"]'); if (tab) tab.click(); return true; })()`);
    await sleep(400);
    const mdReady = await evaluate(client, "!!document.getElementById('md-input')");
    if (mdReady) {
        await setValue(client, '#md-input', '# 安全测试\\n\\n<img src=x onerror="window.__xss=9">\\n\\n<script>window.__xss=10<\\/script>\\n\\n[x](javascript:window.__xss=11)');
        await sleep(700);
        const mdResult = await evaluate(client, `(function(){
            var preview = document.getElementById('md-preview');
            return {
                xss: window.__xss || 0,
                scripts: preview ? preview.querySelectorAll('script').length : -1,
                onerrorImgs: preview ? preview.querySelectorAll('img[onerror]').length : -1,
                jsLinks: preview ? preview.querySelectorAll('a[href^="javascript"]').length : -1,
                text: preview ? preview.textContent.slice(0, 80) : ''
            };
        })()`);
        report.assert('Markdown 工具 XSS 被净化', mdResult.xss === 0 && mdResult.scripts === 0 && mdResult.onerrorImgs === 0 && mdResult.jsLinks === 0, JSON.stringify(mdResult));
    } else {
        report.assert('Markdown 工具可打开', false, 'md-input 不存在');
    }

    // 清理
    await evaluate(client, 'localStorage.clear(); true;');
}

async function main() {
    if (!fs.existsSync(CHROME)) {
        console.error('Chrome not found: ' + CHROME);
        process.exit(2);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-e2e-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
        '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir,
        'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    const report = makeReport();
    let client = null;
    try {
        for (let i = 0; i < 150; i++) {
            try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (err) { await sleep(100); }
        }
        client = await makePage(PORT);
        console.log('— nTools 交互 —');
        await runTodo(client, report);
        console.log('— nChat 交互 —');
        await runChat(client, report);
        console.log('— nChat 流式（mock SSE） —');
        await runChatStreaming(client, report);
        console.log('— Todo 性能 —');
        await runTodoPerf(client, report);
        console.log('— 安全（XSS / 密钥脱敏） —');
        await runSecurity(client, report);
    } finally {
        if (client) { try { client.ws.close(); } catch (err) { /* ignore */ } }
        try { chrome.kill('SIGKILL'); } catch (err) { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }

    console.log('\n===== E2E 结果 =====');
    let failed = 0;
    report.results.forEach((item) => {
        if (!item.pass) failed++;
        console.log('  ' + (item.pass ? 'PASS' : 'FAIL') + '  ' + item.name + (item.detail ? '  → ' + item.detail : ''));
    });
    console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(3);
});
