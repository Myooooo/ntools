#!/usr/bin/env node
/**
 * tools/e2e-features.js — v3 新功能端到端验收（CDP 无头 Chrome，mock fetch，不联网）
 *
 * 覆盖（验收清单 §6；模块说明见 docs/architecture.md）：
 *   1. 设置面板：新增端点 → 保存 → 端点下拉同步 → 设为当前 → 刷新持久
 *   2. 原生聊天：#page-nchat 无 iframe；mock SSE 流式/停止；切换端点会话隔离；
 *      系统提示词进入请求 payload
 *   3. Todo AI：mock 返回 JSON → 打开识别 → 粘贴邮件 → 识别 → 表单填充（标题/详情/截止/标签）
 *      → 未自动创建 → 编辑标题后手动创建成功
 *   4. 快捷时间：下班前/明天前/周五前/下周前/月底前填充正确；设置改下班时间后重新计算生效
 *   5. 全程无 console.error / 未捕获异常
 *
 * 用法：node tools/e2e-features.js [--verbose]
 * 退出码：0 全部通过；1 有失败；2 环境错误。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = path.resolve(__dirname, '..');
const PORT = 9800 + (process.pid % 120);
const URL_NTOOLS = 'file://' + path.join(ROOT, 'ntools.html').split(path.sep).join('/');
const VERBOSE = process.argv.indexOf('--verbose') > -1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 极简 CDP 客户端
 * ------------------------------------------------------------------ */
class Client {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.handlers = [];
        this.consoleErrors = [];
        this.failedRequests = [];
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) reject(new Error(JSON.stringify(message.error)));
                else resolve(message.result);
                return;
            }
            if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
                this.consoleErrors.push((message.params.args || [])
                    .map((arg) => arg.value || arg.description || '').join(' ').slice(0, 400));
            }
            if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                this.consoleErrors.push('exception: ' + ((details.exception && details.exception.description) || details.text || '').slice(0, 400));
            }
            if (message.method === 'Network.loadingFailed' && !String(message.params.errorText).includes('ERR_ABORTED')) {
                this.failedRequests.push(message.params.errorText + ' ' + (message.params.type || ''));
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
            }, 25000);
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
    await client.send('Network.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    return client;
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
        throw new Error('evaluate failed: ' + ((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text));
    }
    return result.result.value;
}

async function navigate(client, url) {
    const loaded = new Promise((resolve) => {
        const handler = (message) => {
            if (message.method !== 'Page.loadEventFired') return;
            client.handlers = client.handlers.filter((item) => item !== handler);
            resolve();
        };
        client.handlers.push(handler);
        setTimeout(resolve, 15000);
    });
    await client.send('Page.navigate', { url });
    await loaded;
    await waitFor(client, "typeof window.NC !== 'undefined'", 8000);
    await sleep(350);
}

async function waitFor(client, expression, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 6000)) {
        try {
            if (await evaluate(client, expression)) return true;
        } catch (err) { /* retry */ }
        await sleep(120);
    }
    return false;
}

async function click(client, selector) {
    const ok = await evaluate(client, `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
    })()`);
    await sleep(260);
    return ok;
}

async function clickButtonText(client, text, scopeSelector) {
    const ok = await evaluate(client, `(function(){
        var scope = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : 'document'};
        if (!scope) return false;
        var buttons = Array.prototype.slice.call(scope.querySelectorAll('button, [role="button"]'));
        var target = buttons.filter(function(btn){ return (btn.textContent || '').indexOf(${JSON.stringify(text)}) > -1 && !btn.disabled; })[0];
        if (!target) return false;
        target.click();
        return true;
    })()`);
    await sleep(260);
    return ok;
}

async function setValue(client, selector, value) {
    const ok = await evaluate(client, `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await sleep(150);
    return ok;
}

async function selectValue(client, selector, value) {
    const ok = await evaluate(client, `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await sleep(320);
    return ok;
}

async function press(client, selector, key) {
    await evaluate(client, `(function(){
        var el = document.querySelector(${JSON.stringify(selector)}) || document.activeElement || document.body;
        var event = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        return true;
    })()`);
    await sleep(220);
}

/* ------------------------------------------------------------------ *
 * Mock fetch（页面级注入，不发真实请求）
 * ------------------------------------------------------------------ */
function mockChatStreamScript(chunks) {
    return `(function(){
        window.__mockCalls = window.__mockCalls || [];
        window.fetch = function (url, opts) {
            try {
                window.__mockCalls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
            } catch (err) {}
            var enc = new TextEncoder();
            var parts = ${JSON.stringify(chunks)};
            var stream = new ReadableStream({ start: function (controller) {
                var i = 0;
                var timer = setInterval(function () {
                    if (i >= parts.length) { clearInterval(timer); try { controller.close(); } catch (e) {} return; }
                    try { controller.enqueue(enc.encode(parts[i++])); } catch (e) { clearInterval(timer); }
                }, 35);
            }});
            return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
        };
        return true;
    })()`;
}

function mockInfiniteStreamScript() {
    return `(function(){
        window.__mockCalls = window.__mockCalls || [];
        window.fetch = function (url, opts) {
            try { window.__mockCalls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null }); } catch (err) {}
            var enc = new TextEncoder();
            var stream = new ReadableStream({ start: function (controller) {
                controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"持续输出"}}]}\\n\\n'));
                window.__mockStopTimer = setInterval(function () {
                    try { controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"…"}}]}\\n\\n')); }
                    catch (err) { clearInterval(window.__mockStopTimer); }
                }, 110);
            }});
            return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
        };
        return true;
    })()`;
}

function mockAiJsonScript(payload) {
    return `(function(){
        window.__mockCalls = window.__mockCalls || [];
        window.fetch = function (url, opts) {
            try { window.__mockCalls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null }); } catch (err) {}
            var out = JSON.stringify({ choices: [{ message: { content: ${JSON.stringify(payload)} } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
            return Promise.resolve(new Response(out, { status: 200, headers: { 'Content-Type': 'application/json' } }));
        };
        return true;
    })()`;
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */
function makeReport() {
    const results = [];
    return {
        results,
        assert(name, pass, detail) {
            results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
            return !!pass;
        },
        summary() {
            const failed = results.filter((item) => !item.pass);
            results.forEach((item) => {
                if (item.pass || VERBOSE) {
                    console.log('  ' + (item.pass ? 'PASS' : 'FAIL') + '  ' + item.name + (item.detail ? '  → ' + item.detail : ''));
                }
            });
            return failed.length;
        }
    };
}

/* ------------------------------------------------------------------ *
 * 流程：设置面板
 * ------------------------------------------------------------------ */
async function flowSettings(client, report) {
    console.log('\n— 设置面板：新增端点 / 保存 / 设为当前 / 持久化 / 下拉同步 —');
    await navigate(client, URL_NTOOLS);
    await evaluate(client, 'localStorage.clear(); true;');
    await navigate(client, URL_NTOOLS);
    await waitFor(client, "!!window.NC && !!NC.settingsPanel", 8000);

    report.assert('设置入口存在', await evaluate(client, "!!document.getElementById('settings-btn')"));
    await click(client, '#settings-btn');
    await waitFor(client, "!!document.querySelector('#settings-sheet') && !document.querySelector('#settings-sheet').hidden", 4000);
    report.assert('设置面板可打开', await evaluate(client, "!!document.querySelector('#settings-sheet.is-open') || !document.querySelector('#settings-sheet').hidden"));
    const navs = await evaluate(client, "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.sp-nav'), function(n){return n.getAttribute('data-section');}))");
    const navList = JSON.parse(navs);
    report.assert('设置分区齐全', navList.length >= 5 && navList.indexOf('profiles') > -1 && navList.indexOf('todo-ai') > -1 && navList.indexOf('general') > -1, navs);

    await evaluate(client, "(function(){ var n=document.querySelector('.sp-nav[data-section=\"profiles\"]'); if(n) n.click(); return true; })()");
    await sleep(400);
    const baseCount = await evaluate(client, 'NC.store.llm.getProfiles().length');
    report.assert('初始端点数量', baseCount >= 1, 'count=' + baseCount);

    const addClicked = await clickButtonText(client, '新增端点', '.settings-sheet__body');
    report.assert('新增端点按钮可点击', addClicked);
    await waitFor(client, "!!document.querySelector('.sp-profile-editor')", 4000);
    report.assert('端点编辑表单出现', await evaluate(client, "!!document.querySelector('.sp-profile-editor')"));

    const fill = await evaluate(client, `(function(){
        var editor = document.querySelector('.sp-profile-editor');
        if (!editor) return false;
        var inputs = editor.querySelectorAll('input');
        var fields = {
            name: editor.querySelector('input[placeholder*="内网"]'),
            model: editor.querySelector('input[placeholder="gpt-4o"]'),
            baseUrl: editor.querySelector('input[placeholder*="api.openai.com"]'),
            apiKey: editor.querySelector('input[type="password"]'),
            prompt: editor.querySelector('textarea.sp-prompt')
        };
        if (!fields.name || !fields.model || !fields.baseUrl || !fields.apiKey) return false;
        fields.name.value = '内网端点E2E';
        fields.model.value = 'mock-model-e2e';
        fields.baseUrl.value = 'https://mock.local/v1';
        fields.apiKey.value = 'sk-mock-e2e';
        if (fields.prompt) fields.prompt.value = 'E2E 系统提示词';
        [fields.name, fields.model, fields.baseUrl, fields.apiKey, fields.prompt].forEach(function(el){
            if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        return true;
    })()`);
    report.assert('端点表单填充', fill);
    const saved = await clickButtonText(client, '保存', '.sp-profile-editor');
    report.assert('保存按钮可点击', saved);
    await sleep(500);

    const profileState = await evaluate(client, `(function(){
        var store = NC.store.llm;
        var profiles = store.getProfiles();
        var found = profiles.filter(function(p){ return p.name === '内网端点E2E'; })[0] || null;
        return { count: profiles.length, found: found, current: store.getState().currentProfileId };
    })()`);
    report.assert('新增端点已保存', profileState.count === baseCount + 1 && !!profileState.found,
        JSON.stringify({ count: profileState.count, name: profileState.found && profileState.found.name }));
    if (profileState.found) {
        report.assert('端点字段正确',
            profileState.found.baseUrl === 'https://mock.local/v1' &&
            profileState.found.modelId === 'mock-model-e2e' &&
            profileState.found.apiKey === 'sk-mock-e2e' &&
            profileState.found.chatSystemPrompt === 'E2E 系统提示词',
            JSON.stringify({ baseUrl: profileState.found.baseUrl, modelId: profileState.found.modelId }));
    }

    // 设为当前：点击该端点的 .sp-profile__main
    const setCurrent = await evaluate(client, `(function(){
        var name = '内网端点E2E';
        var rows = Array.prototype.slice.call(document.querySelectorAll('.sp-profile'));
        var row = rows.filter(function(item){ return (item.textContent || '').indexOf(name) > -1; })[0];
        if (!row) return false;
        var main = row.querySelector('.sp-profile__main');
        if (!main) return false;
        main.click();
        return true;
    })()`);
    await sleep(500);
    report.assert('设为当前端点点可点击', setCurrent);
    const currentId = await evaluate(client, 'NC.store.llm.getState().currentProfileId');
    report.assert('设为当前端点生效', !!profileState.found && currentId === profileState.found.id, 'current=' + currentId);

    // 端点下拉同步（切到 nchat tab）
    await evaluate(client, "(function(){ var b=document.querySelector('.settings-sheet__head button'); if(b) b.click(); return true; })()");
    await sleep(350);
    await click(client, '[data-tab="nchat"]');
    const chatReady = await waitFor(client, "!!window.NC && !!NC.chatEmbed && !!document.getElementById('chat-profile-select') && document.getElementById('chat-profile-select').options.length > 0", 10000);
    report.assert('原生聊天初始化', chatReady);
    const selectInfo = await evaluate(client, `(function(){
        var select = document.getElementById('chat-profile-select');
        if (!select) return null;
        return {
            count: select.options.length,
            names: Array.prototype.map.call(select.options, function(o){ return o.textContent; }),
            value: select.value
        };
    })()`);
    report.assert('端点下拉与数据同步', !!selectInfo && selectInfo.count === profileState.count,
        JSON.stringify(selectInfo));
    report.assert('端点下拉包含新增名称', !!selectInfo && selectInfo.names.join('|').indexOf('内网端点E2E') > -1,
        selectInfo && selectInfo.names.join('|'));

    // 刷新持久化
    await navigate(client, URL_NTOOLS);
    await waitFor(client, "!!window.NC && !!NC.store.llm", 8000);
    const persisted = await evaluate(client, `(function(){
        var store = NC.store.llm;
        var profiles = store.getProfiles();
        var current = store.getState().currentProfileId;
        var found = profiles.filter(function(p){ return p.name === '内网端点E2E'; })[0] || null;
        return { count: profiles.length, current: current, foundId: found && found.id, raw: !!localStorage.getItem('ntools.llm.v1') };
    })()`);
    report.assert('刷新后端点数持久', persisted.count === profileState.count && persisted.raw, JSON.stringify(persisted));
    report.assert('刷新后当前端点持久', !!profileState.found && persisted.current === profileState.found.id);
}

/* ------------------------------------------------------------------ *
 * 流程：原生聊天（mock SSE / 停止 / 端点隔离 / 系统提示词 payload）
 * ------------------------------------------------------------------ */
async function flowChat(client, report) {
    console.log('\n— 原生聊天：无 iframe / 流式 / 停止 / 端点隔离 / 系统提示词 payload —');
    await navigate(client, URL_NTOOLS);
    await waitFor(client, "!!window.NC && !!NC.store.llm && NC.store.llm.getProfiles().length >= 2", 8000);
    await click(client, '[data-tab="nchat"]');
    const ready = await waitFor(client, "!!window.NC.chatEmbed && document.getElementById('chat-profile-select') && document.getElementById('chat-profile-select').options.length >= 2", 12000);
    report.assert('聊天面板就绪', ready);

    const embed = await evaluate(client, `(function(){
        var page = document.getElementById('page-nchat');
        return {
            page: !!page,
            iframes: page ? page.querySelectorAll('iframe').length : -1,
            chatApp: !!document.getElementById('chat-app'),
            hasInput: !!document.getElementById('user-input'),
            hasSend: !!document.getElementById('send-btn'),
            hasContainer: !!document.getElementById('chat-container')
        };
    })()`);
    report.assert('#page-nchat 无 iframe', embed.page && embed.iframes === 0, JSON.stringify(embed));
    report.assert('原生聊天 DOM 完整', embed.chatApp && embed.hasInput && embed.hasSend && embed.hasContainer);

    // 系统提示词：写入当前端点
    const promptClicked = await click(client, '#chat-system-prompt-btn');
    await waitFor(client, "!!document.querySelector('#chat-system-prompt-sheet') && !document.querySelector('#chat-system-prompt-sheet').hidden", 4000);
    report.assert('系统提示词面板可打开', promptClicked && await evaluate(client, "!document.querySelector('#chat-system-prompt-sheet').hidden"));
    await setValue(client, '#chat-system-prompt-input', 'E2E 系统提示词：只回答重点');
    await click(client, '#chat-system-prompt-save');
    await sleep(400);
    const promptSaved = await evaluate(client, `(function(){
        var store = NC.store.llm;
        var profile = store.getCurrentProfile();
        return { text: profile && profile.chatSystemPrompt, hidden: document.querySelector('#chat-system-prompt-sheet').hidden };
    })()`);
    report.assert('系统提示词写入当前端点', promptSaved.text === 'E2E 系统提示词：只回答重点', JSON.stringify(promptSaved));
    if (!promptSaved.hidden) {
        await click(client, '#chat-system-prompt-cancel');
        await sleep(200);
    }

    // mock SSE 流式
    const mockOk = await evaluate(client, mockChatStreamScript([
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"，世界！"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n',
        'data: [DONE]\n\n'
    ]));
    report.assert('mock 流式 fetch 注入', mockOk);
    await setValue(client, '#user-input', 'E2E 流式测试');
    await click(client, '#send-btn');
    const streamedOk = await waitFor(client, "document.querySelectorAll('.chat-msg--assistant').length >= 1 && document.getElementById('chat-container').textContent.indexOf('你好，世界！') > -1", 8000);
    const streamInfo = await evaluate(client, `(function(){
        var calls = window.__mockCalls || [];
        var call = calls[0] || {};
        var payload = call.body || {};
        var messages = payload.messages || [];
        var system = messages.filter(function(m){ return m.role === 'system'; })[0] || null;
        return {
            calls: calls.length,
            content: document.getElementById('chat-container').textContent,
            system: system ? system.content : null,
            whitelist: messages.every(function(m){ var keys = Object.keys(m).sort().join(','); return keys === 'content,role'; }),
            stream: payload.stream === true,
            url: call.url || ''
        };
    })()`);
    report.assert('流式回复渲染', streamedOk, streamInfo.content.slice(0, 100));
    report.assert('系统提示词进入 payload', streamInfo.system === 'E2E 系统提示词：只回答重点', JSON.stringify({ system: streamInfo.system }));
    report.assert('payload 白名单与 stream', streamInfo.whitelist && streamInfo.stream);
    report.assert('请求 URL 正确', /\/chat\/completions$/.test(streamInfo.url), streamInfo.url);

    // 停止生成
    await evaluate(client, mockInfiniteStreamScript());
    await setValue(client, '#user-input', 'E2E 停止测试');
    await click(client, '#send-btn');
    await sleep(650);
    const stopMode = await evaluate(client, "document.getElementById('send-btn').classList.contains('is-stop') || document.getElementById('send-btn').getAttribute('data-mode') === 'stop'");
    await click(client, '#send-btn');
    await sleep(700);
    const stopped = await evaluate(client, `(function(){
        return {
            inputEnabled: !document.getElementById('user-input').disabled,
            text: document.getElementById('chat-container').textContent.indexOf('持续输出') > -1
        };
    })()`);
    report.assert('流式时可停止', stopMode);
    report.assert('停止后输入恢复且保留内容', stopped.inputEnabled && stopped.text, JSON.stringify(stopped));

    // 端点会话隔离
    const isolation = await evaluate(client, `(function(){
        var store = NC.store.llm;
        var profiles = store.getProfiles();
        var current = store.getState().currentProfileId;
        var other = profiles.filter(function(p){ return p.id !== current; })[0];
        return { current: current, otherId: other ? other.id : null, otherName: other ? other.name : null };
    })()`);
    if (isolation.otherId) {
        await selectValue(client, '#chat-profile-select', isolation.otherId);
        await sleep(700);
        const switchedEmpty = await evaluate(client, "document.getElementById('chat-container').textContent.indexOf('你好，世界！') === -1");
        report.assert('切换端点后为独立会话（旧内容不可见）', switchedEmpty);
        // 在另一个端点发送消息
        await evaluate(client, mockChatStreamScript(['data: {"choices":[{"delta":{"content":"另一端点回复"}}]}\n\n', 'data: [DONE]\n\n']));
        await setValue(client, '#user-input', '端点B测试');
        await click(client, '#send-btn');
        await waitFor(client, "document.getElementById('chat-container').textContent.indexOf('另一端点回复') > -1", 8000);
        // 切回原端点，旧会话仍在
        await selectValue(client, '#chat-profile-select', isolation.current);
        await sleep(800);
        const backText = await evaluate(client, "document.getElementById('chat-container').textContent");
        report.assert('切回原端点恢复其会话', backText.indexOf('你好，世界！') > -1 && backText.indexOf('另一端点回复') === -1,
            backText.slice(0, 160));
    } else {
        report.assert('端点隔离（需要至少 2 个端点）', false, '缺少第二个端点');
    }
}

/* ------------------------------------------------------------------ *
 * 流程：Todo AI
 * ------------------------------------------------------------------ */
const AI_PAYLOAD = {
    title: '提交季度报告',
    notes: '来自邮件的任务详情：整理 Q2 数据，周五前发给领导。',
    due: '2026-05-22T17:30',
    dueAllDay: false,
    priority: 'high',
    tags: ['工作', '报告'],
    listName: null
};

async function flowTodoAi(client, report) {
    console.log('\n— Todo AI：识别 → 表单填充 → 未自动创建 → 编辑后创建 —');
    await navigate(client, URL_NTOOLS);
    await waitFor(client, "!!window.NC && !!NC.todoAi", 8000);
    await evaluate(client, 'localStorage.removeItem("ntools.todo.v2"); localStorage.removeItem("ntools_todo"); localStorage.removeItem("ntools.todo.v2_backup"); true;');
    await navigate(client, URL_NTOOLS);
    await click(client, '[data-tab="todo"]');
    await waitFor(client, "!!window.NC.tools && !!NC.tools.todo", 8000);
    await sleep(500);

    const aiEntry = await evaluate(client, `(function(){
        var candidates = ['#todo-ai-btn', '[data-act="ai"]', '.todo-composer__ai', '#todo-ai'];
        for (var i = 0; i < candidates.length; i++) {
            var el = document.querySelector(candidates[i]);
            if (el) return { found: true, selector: candidates[i], text: (el.textContent || '').trim() };
        }
        var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
        var byText = buttons.filter(function(btn){ return (btn.textContent || '').indexOf('AI 识别') > -1; })[0];
        if (byText) return { found: true, selector: 'text', text: (byText.textContent || '').trim() };
        return { found: false };
    })()`);
    report.assert('Todo AI 入口存在', aiEntry.found, JSON.stringify(aiEntry));

    if (aiEntry.found) {
        if (aiEntry.selector === 'text') {
            await clickButtonText(client, 'AI 识别');
        } else {
            await click(client, aiEntry.selector);
        }
    } else {
        await evaluate(client, 'NC.todoAi.openDialog(); true;');
    }
    await waitFor(client, "!!document.querySelector('.nc-modal') || !!document.querySelector('[role=\"dialog\"]')", 5000);
    report.assert('Todo AI 弹窗打开', await evaluate(client, "!!document.querySelector('.nc-modal-overlay, .nc-modal')"));

    const injected = await evaluate(client, mockAiJsonScript(JSON.stringify(AI_PAYLOAD)));
    report.assert('mock AI 响应注入', injected);

    const dialogInputSet = await evaluate(client, `(function(){
        var modal = document.querySelector('.nc-modal') || document.querySelector('[role="dialog"]');
        if (!modal) return false;
        var area = modal.querySelector('textarea');
        if (!area) return false;
        area.focus();
        area.value = '请帮我：周五下班前提交季度报告，整理 Q2 数据。这是会议纪要……';
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    report.assert('识别弹窗可输入文本', dialogInputSet);
    const identifyClicked = await clickButtonText(client, '识别', '.nc-modal') || await clickButtonText(client, '开始识别', '.nc-modal');
    report.assert('识别按钮可点击', identifyClicked);
    await waitFor(client, "!document.querySelector('.nc-modal-overlay') && !document.querySelector('.nc-modal')", 10000);
    await sleep(600);

    const filled = await evaluate(client, `(function(){
        var doc = NC.store.todo ? NC.store.todo.getDoc() : null;
        var title = document.getElementById('todo-new-title');
        var due = document.getElementById('todo-new-due');
        var extra = document.getElementById('todo-composer-extra');
        var priority = document.getElementById('todo-new-priority');
        var notes = document.getElementById('todo-new-notes');
        var tags = document.getElementById('todo-new-tags');
        var chips = document.getElementById('todo-new-tags-chips');
        var bodyText = document.body.textContent || '';
        return {
            title: title ? title.value : null,
            due: due ? due.value : null,
            extraVisible: extra ? !extra.hidden : false,
            priority: priority ? priority.value : null,
            notes: notes ? notes.value : null,
            tags: tags ? tags.value : null,
            chips: chips ? chips.textContent : '',
            tasks: doc ? doc.tasks.length : -1,
            items: document.querySelectorAll('.todo-item').length,
            hasTag: bodyText.indexOf('工作') > -1 && bodyText.indexOf('报告') > -1,
            body: bodyText.slice(0, 200)
        };
    })()`);
    report.assert('表单标题已填充', !!filled.title && filled.title.indexOf('季度报告') > -1, String(filled.title));
    report.assert('表单截止已填充', !!filled.due && filled.due.indexOf('2026-05-22T17:30') === 0, String(filled.due));
    report.assert('表单详情已填充', !!filled.notes && filled.notes.indexOf('Q2') > -1, String(filled.notes).slice(0, 80));
    report.assert('表单标签已填充', (String(filled.tags || '') + filled.chips).indexOf('工作') > -1 &&
        (String(filled.tags || '') + filled.chips).indexOf('报告') > -1,
        JSON.stringify({ tags: filled.tags, chips: filled.chips }));
    report.assert('详细面板展开 + 优先级', filled.extraVisible && filled.priority === 'high', JSON.stringify({ extra: filled.extraVisible, priority: filled.priority }));
    report.assert('标签已填充', filled.hasTag, filled.body);
    report.assert('AI 识别不自动创建任务', filled.tasks === 0 && filled.items === 0, JSON.stringify({ tasks: filled.tasks, items: filled.items }));

    // 编辑标题后手动创建
    await setValue(client, '#todo-new-title', 'E2E 手动创建的任务');
    await evaluate(client, "document.getElementById('todo-new-submit').click(); true;");
    await sleep(700);
    const created = await evaluate(client, `(function(){
        var doc = NC.store.todo ? NC.store.todo.getDoc() : null;
        var items = document.querySelectorAll('.todo-item');
        return {
            tasks: doc ? doc.tasks.length : -1,
            items: items.length,
            title: items[0] ? (doc.tasks[0] || {}).title || items[0].textContent : '',
            due: doc && doc.tasks[0] ? doc.tasks[0].due : null
        };
    })()`);
    report.assert('编辑后手动创建成功', created.tasks === 1 && created.title.indexOf('E2E 手动创建的任务') > -1,
        JSON.stringify({ tasks: created.tasks, title: created.title, due: created.due }));
}

/* ------------------------------------------------------------------ *
 * 流程：快捷时间
 * ------------------------------------------------------------------ */
const QUICK_KINDS = [
    { kind: 'work-end', label: '下班前' },
    { kind: 'tomorrow', label: '明天前' },
    { kind: 'friday', label: '周五前' },
    { kind: 'next-week', label: '下周前' },
    { kind: 'month-end', label: '月底前' }
];

async function flowQuickDue(client, report) {
    console.log('\n— 快捷时间：chips 填充 / 改下班时间后重算 —');
    await navigate(client, URL_NTOOLS);
    await waitFor(client, "!!window.NC && !!NC.todoTime && !!NC.store.llm", 8000);
    await click(client, '[data-tab="todo"]');
    await waitFor(client, "!!window.NC.tools && !!NC.tools.todo", 8000);

    // 展开详细选项
    const toggle = await click(client, '#todo-composer-toggle');
    await sleep(300);
    report.assert('创建面板可展开', toggle && await evaluate(client, "(function(){ var el=document.getElementById('todo-composer-extra'); return !!el && !el.hidden; })()"));

    const chipInfo = await evaluate(client, `(function(){
        var chips = Array.prototype.slice.call(document.querySelectorAll('#todo-quick-due button, .todo-quick-due button, [data-quick-due]'));
        return {
            count: chips.length,
            labels: chips.map(function(el){ return (el.textContent || '').trim(); }),
            kinds: chips.map(function(el){ return el.getAttribute('data-kind') || el.getAttribute('data-quick-due') || ''; })
        };
    })()`);
    report.assert('快捷时间 chips 存在', chipInfo.count >= 5, JSON.stringify(chipInfo));

    const workEnd = await evaluate(client, 'NC.store.llm.getWorkEndTime()');
    const now = await evaluate(client, 'Date.now()');
    for (const item of QUICK_KINDS) {
        const expected = await evaluate(client, `(function(){
            var ts = NC.todoTime.computeQuickDue(${JSON.stringify(item.kind)}, ${now}, ${JSON.stringify(workEnd)});
            return ts == null ? null : NC.util.toDateTimeInputValue(ts);
        })()`);
        const clicked = await clickButtonText(client, item.label, '#todo-composer-extra') || await clickButtonText(client, item.label);
        await sleep(250);
        const value = await evaluate(client, "document.getElementById('todo-new-due').value");
        report.assert('快捷时间「' + item.label + '」填充正确', clicked && value === expected,
            JSON.stringify({ clicked, value, expected }));
        // 清除，避免下一条受组件状态影响（清除 chip）
        await clickButtonText(client, '清除', '#todo-composer-extra');
        await sleep(150);
    }

    // 修改下班时间后重新计算
    await click(client, '#settings-btn');
    await waitFor(client, "!!document.querySelector('#settings-sheet') && !document.querySelector('#settings-sheet').hidden", 4000);
    await evaluate(client, "(function(){ var n=document.querySelector('.sp-nav[data-section=\"general\"]'); if(n) n.click(); return true; })()");
    await sleep(400);
    await setValue(client, '.sp-time', '18:00');
    await sleep(400);
    const newWorkEnd = await evaluate(client, 'NC.store.llm.getWorkEndTime()');
    report.assert('设置面板可修改下班时间', newWorkEnd === '18:00', newWorkEnd);
    await evaluate(client, "(function(){ var b=document.querySelector('.settings-sheet__head button'); if(b) b.click(); return true; })()");
    await sleep(400);

    const expectedAfter = await evaluate(client, `(function(){
        var ts = NC.todoTime.computeQuickDue('work-end', Date.now(), '18:00');
        return ts == null ? null : NC.util.toDateTimeInputValue(ts);
    })()`);
    await clickButtonText(client, '下班前', '#todo-composer-extra');
    await sleep(300);
    const afterValue = await evaluate(client, "document.getElementById('todo-new-due').value");
    report.assert('改下班时间后「下班前」重新计算', afterValue === expectedAfter, JSON.stringify({ afterValue, expectedAfter }));

    // 复位
    await evaluate(client, "NC.store.llm.setWorkEndTime('17:30'); true;");
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
    if (!fs.existsSync(CHROME)) {
        console.error('Chrome not found: ' + CHROME + '\n可用 CHROME 环境变量指定。');
        process.exit(2);
    }
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-e2e-features-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
        '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let client = null;
    const report = makeReport();
    const startedAt = Date.now();
    try {
        let ready = false;
        for (let i = 0; i < 200; i++) {
            try {
                await fetch('http://127.0.0.1:' + PORT + '/json/version');
                ready = true;
                break;
            } catch (err) { await sleep(100); }
        }
        if (!ready) throw new Error('Chrome debugging port not ready');
        client = await makePage(PORT);

        // 缺失依赖时快速失败并给出可读原因
        await navigate(client, URL_NTOOLS);
        const deps = await evaluate(client, `(function(){
            return {
                nc: !!window.NC,
                llm: !!(window.NC && NC.store && NC.store.llm),
                ai: !!(window.NC && NC.ai),
                todoAi: !!(window.NC && NC.todoAi),
                todoTime: !!(window.NC && NC.todoTime),
                chatEmbed: !!(window.NC && NC.chatEmbed),
                settingsPanel: !!(window.NC && NC.settingsPanel),
                llmScripts: Array.prototype.map.call(document.querySelectorAll('script[src]'), function(s){ return s.getAttribute('src'); })
                    .filter(function(src){ return src.indexOf('todo-ai') > -1 || src.indexOf('todo-time') > -1 || src.indexOf('chat-embed') > -1; })
            };
        })()`);
        const missing = ['llm', 'ai', 'todoAi', 'todoTime', 'chatEmbed', 'settingsPanel'].filter((key) => !deps[key]);
        if (missing.length) {
            console.error('\nv3 依赖尚未就位，跳过 E2E：缺少 ' + missing.join(', '));
            console.error('已加载 v3 脚本: ' + JSON.stringify(deps.llmScripts));
            process.exit(1);
        }

        await flowSettings(client, report);
        await flowChat(client, report);
        await flowTodoAi(client, report);
        await flowQuickDue(client, report);
    } catch (err) {
        report.assert('E2E 运行未抛异常', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
    } finally {
        const elapsed = Date.now() - startedAt;
        const failed = report.summary();
        const consoleErrors = client ? client.consoleErrors : [];
        const failedRequests = client ? client.failedRequests.filter((item) => !/data:|blob:/.test(item)) : [];
        if (consoleErrors.length) {
            failedRequests.push.apply(failedRequests, []);
            console.log('\n页面 console.error / 未捕获异常（' + consoleErrors.length + '）：');
            consoleErrors.slice(0, 10).forEach((item) => console.log('  - ' + item));
        } else {
            console.log('\n页面 console.error：0');
        }
        if (failedRequests.length) {
            console.log('网络失败（mock 之外出现即异常）：');
            failedRequests.slice(0, 10).forEach((item) => console.log('  - ' + item));
        }
        const total = report.results.length;
        console.log('\n结果: ' + (total - failed) + '/' + total + ' 通过，' + failed + ' 失败，耗时 ' + elapsed + 'ms' +
            (consoleErrors.length ? '，console.error ' + consoleErrors.length + ' 条' : ''));
        try { chrome.kill('SIGKILL'); } catch (err) { /* ignore */ }
        try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
        if (client) { try { client.ws.close(); } catch (err) { /* ignore */ } }
        process.exit(failed === 0 && consoleErrors.length === 0 && failedRequests.length === 0 ? 0 : 1);
    }
}

main();
