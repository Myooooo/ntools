#!/usr/bin/env node
/**
 * tools/verify.js — 无依赖 CDP 验收工具（Node 18+ / Chrome for Testing）
 *
 * 功能：
 *  1. 逐个打开 index.html / ntools.html / compat-check.html / tests.html
 *  2. 捕获 console.error、未捕获异常、资源加载失败
 *  3. 执行页面内断言（DOM/迁移/主题/关键文本）
 *  4. 输出深/浅/Lite × 桌面/移动截图到 /tmp/nc-shots/
 *
 * 用法：
 *   node tools/verify.js                 # 全量
 *   node tools/verify.js index.html      # 指定页面
 * 退出码：0 = 全部通过；1 = 有失败
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = path.resolve(__dirname, '..');
const PORT = 9333 + (process.pid % 200);
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/nc-shots';
const PAGES = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['index.html', 'ntools.html', 'compat-check.html', 'tests.html'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileUrl(name) {
    return 'file://' + path.join(ROOT, name).split(path.sep).join('/');
}

async function waitForPort(url, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.json();
        } catch (err) { /* retry */ }
        await sleep(100);
    }
    throw new Error('Chrome debugging port not ready: ' + url);
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.events = [];
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
            this.events.push(message);
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
                    reject(new Error('CDP timeout: ' + method));
                }
            }, 20000);
        });
    }

    once(method, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.handlers = this.handlers.filter((h) => h !== handler);
                reject(new Error('event timeout: ' + method));
            }, timeoutMs || 15000);
            const handler = (message) => {
                if (message.method !== method) return;
                clearTimeout(timer);
                this.handlers = this.handlers.filter((h) => h !== handler);
                resolve(message.params);
            };
            this.handlers.push(handler);
        });
    }

    close() {
        try { this.ws.close(); } catch (err) { /* ignore */ }
    }
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
    });
    if (result.exceptionDetails) {
        throw new Error('page evaluate failed: ' + (result.exceptionDetails.exception && result.exceptionDetails.exception.description || result.exceptionDetails.text));
    }
    return result.result.value;
}

async function waitFor(client, expression, timeoutMs) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < (timeoutMs || 4000)) {
        try {
            last = await evaluate(client, expression);
            if (last) return last;
        } catch (err) {
            last = null;
        }
        await sleep(150);
    }
    return last;
}

async function runPage(browserJson, pageName) {
    const url = fileUrl(pageName);
    const errors = [];
    const failedRequests = [];
    let client = null;
    const report = { page: pageName, url, checks: [], errors, failedRequests, shots: [] };

    try {
        const targetRes = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
        const target = await targetRes.json();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        client = new Cdp(ws);

        client.handlers.push((message) => {
            if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                errors.push('exception: ' + (details.exception && details.exception.description || details.text));
            }
            if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
                const text = (message.params.args || []).map((arg) => arg.value || arg.description || '').join(' ');
                errors.push('console.error: ' + text);
            }
            if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
                errors.push('log.error: ' + message.params.entry.text + ' @' + (message.params.entry.url || ''));
            }
            if (message.method === 'Network.loadingFailed' && !message.params.errorText.includes('ERR_ABORTED')) {
                failedRequests.push(message.params.errorText + ' type=' + message.params.type);
            }
        });

        await client.send('Runtime.enable');
        await client.send('Log.enable');
        await client.send('Page.enable');
        await client.send('Network.enable');
        await client.send('Emulation.setDeviceMetricsOverride', {
            width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
        });

        const loaded = client.once('Page.loadEventFired', 20000);
        await client.send('Page.navigate', { url });
        await loaded;
        await waitFor(client, "typeof window.NC !== 'undefined' && !!window.NC.version", 6000);
        await sleep(300);

        if (pageName === 'index.html') {
            report.checks.push(await checkRedirect(client));
        } else {
            report.checks.push(await checkGeneric(client, pageName));
            if (pageName === 'ntools.html') report.checks.push(await checkNtools(client));
            if (pageName === 'compat-check.html') report.checks.push(await checkCompat(client));
            if (pageName === 'tests.html') report.checks.push(await checkTests(client));
        }

        // 主题 & 截图
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        const base = pageName.replace(/\.html$/, '');
        await capture(client, `${base}-dark-1440.png`, url, { theme: 'dark', lite: false, width: 1440, height: 900, mobile: false });
        report.shots.push(path.join(SHOT_DIR, `${base}-dark-1440.png`));
        if (pageName !== 'tests.html') {
            await capture(client, `${base}-light-1440.png`, url, { theme: 'light', lite: false, width: 1440, height: 900, mobile: false });
            await capture(client, `${base}-dark-390.png`, url, { theme: 'dark', lite: false, width: 390, height: 844, mobile: true });
            if (pageName === 'index.html' || pageName === 'ntools.html') {
                await capture(client, `${base}-lite-1440.png`, url, { theme: 'dark', lite: true, width: 1440, height: 900, mobile: false });
            }
            report.shots.push(path.join(SHOT_DIR, `${base}-light-1440.png`));
            report.shots.push(path.join(SHOT_DIR, `${base}-dark-390.png`));
        }

        // 只保留最近一次导航的错误（重新截图可能刷新，改为记录在 capture 中）
        report.errors = errors;
        report.failedRequests = failedRequests;
    } catch (err) {
        errors.push('runner: ' + err.message);
        report.errors = errors;
    } finally {
        if (client) client.close();
    }
    return report;
}

async function capture(client, filename, url, opts) {
    await client.send('Emulation.setDeviceMetricsOverride', {
        width: opts.width,
        height: opts.height,
        deviceScaleFactor: 1,
        mobile: !!opts.mobile
    });
    await client.send('Page.navigate', { url });
    await client.once('Page.loadEventFired', 15000).catch(() => null);
    await sleep(400);
    await evaluate(client, `(function(){
        document.documentElement.setAttribute('data-theme', '${opts.theme}');
        document.documentElement.setAttribute('data-lite', '${opts.lite ? 'true' : 'false'}');
        window.scrollTo(0, 0);
        return true;
    })()`);
    await sleep(250);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(SHOT_DIR, filename), Buffer.from(shot.data, 'base64'));
}

async function checkGeneric(client, pageName) {
    const result = await evaluate(client, `(function(){
        var style = getComputedStyle(document.body);
        return {
            title: document.title,
            nc: (typeof window.NC !== 'undefined') ? window.NC.version : null,
            ready: document.readyState,
            bodyBg: style.backgroundColor,
            bodyFont: style.fontFamily,
            scripts: Array.prototype.map.call(document.querySelectorAll('script[src]'), function(s){ return s.getAttribute('src'); }),
            theme: document.documentElement.getAttribute('data-theme'),
            lite: document.documentElement.getAttribute('data-lite'),
            viewport: (document.querySelector('meta[name=viewport]') || {}).content || ''
        };
    })()`);
    const checks = [];
    checks.push({ name: 'NC 命名空间', pass: !!result.nc, detail: result.nc || 'missing' });
    checks.push({ name: '页面标题', pass: !!result.title, detail: result.title });
    checks.push({ name: '主题已应用', pass: !!result.theme, detail: result.theme + '/' + result.lite });
    if (pageName === 'index.html') {
        checks.push({ name: 'viewport 允许缩放', pass: result.viewport.indexOf('user-scalable=no') === -1, detail: result.viewport });
    }
    return { block: pageName, checks: checks };
}

async function checkRedirect(client) {
    const result = await evaluate(client, `(function(){
        return {
            href: location.href,
            title: document.title,
            hasToolsApp: !!document.getElementById('tools-app'),
            hasChat: !!document.getElementById('page-nchat')
        };
    })()`);
    return {
        block: 'index(redirect)',
        checks: [
            { name: '旧入口自动跳转', pass: /ntools\.html#nchat/.test(result.href), detail: result.href.slice(-40) },
            { name: '跳转到 nTools 聊天', pass: result.hasToolsApp && result.hasChat && result.title.indexOf('nTools') > -1, detail: result.title }
        ]
    };
}

async function checkNtools(client) {
    const result = await evaluate(client, `(function(){
        var tabs = document.querySelectorAll('[data-tab]');
        var panels = document.querySelectorAll('[data-panel], .tab-panel');
        var list = document.querySelector('#todo-list, .todo-list');
        var items = document.querySelectorAll('.todo-item');
        var legacyInline = Array.prototype.some.call(document.querySelectorAll('script'), function(s){ return !s.src && s.textContent.trim().length > 0; });
        return { tabs: tabs.length, panels: panels.length, hasList: !!list, items: items.length, legacyInline: legacyInline };
    })()`);
    const checks = [];
    checks.push({ name: '工具页 5 个 tab', pass: result.tabs >= 5, detail: String(result.tabs) });
    checks.push({ name: '工具面板存在', pass: result.panels >= 5, detail: String(result.panels) });
    checks.push({ name: '待办列表容器', pass: result.hasList, detail: result.hasList ? 'ok' : 'missing' });
    checks.push({ name: '无内联业务脚本', pass: !result.legacyInline, detail: result.legacyInline ? 'found inline script' : 'clean' });

    // nchat 原生 tab：无 iframe、聊天就绪、设置面板可打开
    try {
        await evaluate(client, `(function(){ var tab=document.querySelector('[data-tab="nchat"]'); if(tab) tab.click(); return true; })()`);
        const chatReady = await (async () => {
            for (let i = 0; i < 30; i++) {
                const ready = await evaluate(client, `!!(window.NC && NC.chatEmbed && NC.chatEmbed.isReady && NC.chatEmbed.isReady())`);
                if (ready) return true;
                await sleep(150);
            }
            return false;
        })();
        const chatState = await evaluate(client, `(function(){
            return {
                iframes: document.querySelectorAll('#page-nchat iframe').length,
                chatApp: !!document.getElementById('chat-app'),
                input: !!document.getElementById('user-input'),
                send: !!document.getElementById('send-btn'),
                profiles: document.querySelectorAll('#chat-profile-select option').length
            };
        })()`);
        checks.push({ name: 'nChat 原生嵌入（无 iframe）', pass: chatState.iframes === 0 && chatState.chatApp, detail: JSON.stringify(chatState) });
        checks.push({ name: '聊天面板就绪', pass: chatReady && chatState.input && chatState.send && chatState.profiles > 0, detail: JSON.stringify(chatState) });

        // 设置面板
        await evaluate(client, `(function(){ NC.settingsPanel.open('profiles'); return true; })()`);
        await sleep(400);
        const settings = await evaluate(client, `(function(){
            var sheet = document.getElementById('settings-sheet');
            return { open: !!sheet && !sheet.hidden && sheet.classList.contains('is-open'), sections: document.querySelectorAll('#settings-sheet .sp-nav').length };
        })()`);
        checks.push({ name: '全局设置面板', pass: settings.open && settings.sections >= 5, detail: JSON.stringify(settings) });
        await evaluate(client, `(function(){ NC.settingsPanel.close(); return true; })()`);
        await sleep(250);
        // 回到待办，保持后续截图默认状态
        await evaluate(client, `(function(){ var tab=document.querySelector('[data-tab="todo"]'); if(tab) tab.click(); return true; })()`);
        await sleep(200);
    } catch (err) {
        checks.push({ name: 'nChat 原生 / 设置面板检查', pass: false, detail: err.message });
    }

    // v1 迁移端到端
    try {
        await evaluate(client, `(function(){
            localStorage.removeItem('ntools.todo.v2');
            localStorage.removeItem('ntools.todo.v2_backup');
            localStorage.removeItem('ntools.todo.v1_backup');
            localStorage.setItem('ntools_todo', JSON.stringify([
                { id: 1700000000000, title: '迁移测试任务', content: '详情', due: Date.now() + 3600000, completed: false },
                { id: 'bad', title: 12, content: null, due: 'oops', completed: true },
                null
            ]));
            return true;
        })()`);
        const refresh = client.once('Page.loadEventFired', 15000);
        await client.send('Page.reload', { ignoreCache: true });
        await refresh;
        await waitFor(client, "document.querySelectorAll('.todo-item').length > 0", 5000);
        await sleep(250);
        const migrated = await evaluate(client, `(function(){
            var doc = null;
            try { doc = JSON.parse(localStorage.getItem('ntools.todo.v2')); } catch (e) {}
            var items = document.querySelectorAll('.todo-item');
            var text = document.body.textContent || '';
            return {
                hasDoc: !!(doc && doc.schemaVersion === 2),
                tasks: doc && doc.tasks ? doc.tasks.length : -1,
                domItems: items.length,
                textHasTitle: text.indexOf('迁移测试任务') > -1,
                v1Kept: !!localStorage.getItem('ntools_todo'),
                quarantine: doc && doc.meta && doc.meta.quarantine ? doc.meta.quarantine.length : 0
            };
        })()`);
        checks.push({ name: 'v1→v2 迁移写入', pass: migrated.hasDoc && migrated.tasks >= 1, detail: JSON.stringify(migrated) });
        checks.push({ name: '迁移后渲染任务', pass: migrated.textHasTitle && migrated.domItems >= 1, detail: 'dom=' + migrated.domItems });
        checks.push({ name: 'v1 旧键保留', pass: migrated.v1Kept, detail: String(migrated.v1Kept) });
        checks.push({ name: '脏数据隔离', pass: migrated.quarantine >= 1, detail: 'quarantine=' + migrated.quarantine });
        // 清理测试数据，避免影响后续截图
        await evaluate(client, `(function(){ localStorage.removeItem('ntools_todo'); localStorage.removeItem('ntools.todo.v2'); localStorage.removeItem('ntools.todo.v1_backup'); localStorage.removeItem('ntools.todo.v2_backup'); return true; })()`);
        const reload = client.once('Page.loadEventFired', 15000);
        await client.send('Page.reload', { ignoreCache: true });
        await reload;
        await sleep(600);
    } catch (err) {
        checks.push({ name: 'v1→v2 迁移端到端', pass: false, detail: err.message });
    }
    return { block: 'ntools', checks: checks };
}

async function checkIndex(client) {
    const ids = ['app-title', 'chat-container', 'user-input', 'send-btn', 'settings-panel', 'main-menu', 'config-select', 'toggle-settings-btn'];
    const result = await evaluate(client, `(function(){
        var ids = ${JSON.stringify(ids)};
        var missing = ids.filter(function(id){ return !document.getElementById(id); });
        return {
            missing: missing,
            messages: document.querySelectorAll('.message').length,
            hasCssVars: !!getComputedStyle(document.documentElement).getPropertyValue('--nc-accent').trim()
        };
    })()`);
    return {
        block: 'index',
        checks: [
            { name: '聊天页关键 DOM', pass: result.missing.length === 0, detail: result.missing.length ? 'missing: ' + result.missing.join(',') : 'ok' },
            { name: '欢迎消息渲染', pass: result.messages >= 1, detail: 'messages=' + result.messages },
            { name: '设计令牌生效', pass: result.hasCssVars, detail: String(result.hasCssVars) }
        ]
    };
}

async function checkCompat(client) {
    const result = await evaluate(client, `(function(){
        var text = document.body.textContent || '';
        return { len: text.length, hasChrome: text.indexOf('Chromium') > -1 || text.indexOf('Chrome') > -1, tables: document.querySelectorAll('table, .compat-row, .nc-card').length };
    })()`);
    return {
        block: 'compat-check',
        checks: [
            { name: '自检内容渲染', pass: result.len > 200, detail: 'text=' + result.len },
            { name: '包含内核信息', pass: result.hasChrome, detail: String(result.hasChrome) }
        ]
    };
}

async function checkTests(client) {
    const result = await evaluate(client, `(function(){
        var text = document.body.textContent || '';
        var fail = 0;
        document.querySelectorAll('[data-result="fail"], .fail, .test-fail').forEach(function(el){ fail++; });
        return { textLen: text.length, fail: fail, passText: text.indexOf('通过') > -1 };
    })()`);
    return {
        block: 'tests',
        checks: [
            { name: '测试页渲染', pass: result.textLen > 100, detail: 'text=' + result.textLen },
            { name: '无红色失败项', pass: result.fail === 0, detail: 'fail=' + result.fail }
        ]
    };
}

async function main() {
    if (!fs.existsSync(CHROME)) {
        console.error('Chrome not found: ' + CHROME + '\n可通过 CHROME 环境变量指定。');
        process.exit(2);
    }
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cdp-'));
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=' + PORT,
        '--user-data-dir=' + userDir,
        'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let reports = [];
    try {
        const version = await waitForPort(`http://127.0.0.1:${PORT}/json/version`, 15000);
        console.log('Chrome: ' + (version.Browser || 'unknown'));
        for (const page of PAGES) {
            if (!fs.existsSync(path.join(ROOT, page))) {
                reports.push({ page, skipped: true, reason: 'file not found', checks: [], errors: [], failedRequests: [], shots: [] });
                continue;
            }
            process.stdout.write('· ' + page + ' ... ');
            const report = await runPage(version, page);
            reports.push(report);
            const bad = report.errors.length + report.checks.reduce((sum, block) => sum + block.checks.filter((check) => !check.pass).length, 0);
            console.log(bad === 0 ? 'OK' : bad + ' issue(s)');
        }
    } finally {
        try { chrome.kill('SIGKILL'); } catch (err) { /* ignore */ }
        try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }

    console.log('\n===== 验收报告 =====');
    let failed = 0;
    for (const report of reports) {
        console.log('\n[' + report.page + ']' + (report.skipped ? ' SKIP (' + report.reason + ')' : ''));
        for (const block of report.checks) {
            for (const check of block.checks) {
                if (!check.pass) failed++;
                console.log('  ' + (check.pass ? 'PASS' : 'FAIL') + '  ' + check.name + '  → ' + check.detail);
            }
        }
        if (report.errors.length) {
            failed += report.errors.length;
            report.errors.forEach((error) => console.log('  FAIL  page error → ' + error));
        }
        if (report.failedRequests && report.failedRequests.length) {
            report.failedRequests.forEach((request) => console.log('  WARN  request failed → ' + request));
        }
        if (report.shots && report.shots.length) {
            console.log('  shots: ' + report.shots.join(', '));
        }
    }
    fs.writeFileSync('/tmp/nc-verify.json', JSON.stringify(reports, null, 2));
    console.log('\n结果: ' + (failed === 0 ? '全部通过' : failed + ' 项失败') + '（详情 /tmp/nc-verify.json）');
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(3);
});
