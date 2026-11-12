#!/usr/bin/env node
/**
 * tools/run-tests.js — 无头运行 tests.html 并输出断言结果
 * 依赖 Node 18+ 内置 fetch/WebSocket 与 Chrome for Testing。
 * 用法：node tools/run-tests.js [--verbose]
 * 退出码：0 全部通过 / 1 有失败 / 2 环境错误
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = path.resolve(__dirname, '..');
const PORT = 9700 + (process.pid % 150);
const URL_TESTS = 'file://' + path.join(ROOT, 'tests.html').split(path.sep).join('/');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    if (!fs.existsSync(CHROME)) {
        console.error('Chrome not found: ' + CHROME + '（可用 CHROME 环境变量指定）');
        process.exit(2);
    }
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tests-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let client = null;
    try {
        let ready = false;
        for (let i = 0; i < 150; i++) {
            try {
                await fetch(`http://127.0.0.1:${PORT}/json/version`);
                ready = true;
                break;
            } catch (err) {
                await sleep(100);
            }
        }
        if (!ready) throw new Error('Chrome debugging port not ready');

        const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });

        let id = 0;
        const pending = new Map();
        const consoleErrors = [];
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.method === 'Runtime.exceptionThrown') {
                consoleErrors.push((message.params.exceptionDetails.exception || {}).description || message.params.exceptionDetails.text);
            }
            if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
                consoleErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
            }
            if (message.id && pending.has(message.id)) {
                const { resolve, reject } = pending.get(message.id);
                pending.delete(message.id);
                if (message.error) reject(new Error(JSON.stringify(message.error)));
                else resolve(message.result);
            }
        });
        const send = (method, params) => new Promise((resolve, reject) => {
            const requestId = ++id;
            pending.set(requestId, { resolve, reject });
            ws.send(JSON.stringify({ id: requestId, method, params: params || {} }));
            setTimeout(() => {
                if (pending.has(requestId)) {
                    pending.delete(requestId);
                    reject(new Error('CDP timeout: ' + method));
                }
            }, 20000);
        });
        const evaluate = async (expression) => {
            const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (result.exceptionDetails) {
                throw new Error((result.exceptionDetails.exception || {}).description || result.exceptionDetails.text);
            }
            return result.result.value;
        };

        await send('Runtime.enable');
        await send('Page.enable');
        const loaded = new Promise((resolve) => {
            const handler = (event) => {
                if (JSON.parse(event.data).method === 'Page.loadEventFired') resolve();
            };
            ws.addEventListener('message', handler);
            setTimeout(resolve, 15000);
        });
        await send('Page.navigate', { url: URL_TESTS });
        await loaded;

        let report = null;
        for (let i = 0; i < 60; i++) {
            await sleep(150);
            report = await evaluate('window.__TEST_REPORT || null').catch(() => null);
            if (report && report.total > 0) break;
        }

        if (!report) {
            console.error('未获取到 tests.html 的断言报告（页面可能未完成）');
            process.exit(1);
        }
        if (process.argv.indexOf('--verbose') > -1 && report.failures) {
            report.failures.forEach((failure) => console.log('  FAIL  ' + failure));
        }
        console.log('tests.html: 通过 ' + report.pass + ' / 失败 ' + report.fail + ' / 跳过 ' + report.skip +
            '（共 ' + report.total + '，' + Math.round(report.elapsed) + 'ms）');
        if (consoleErrors.length) {
            console.log('页面 console.error: ' + consoleErrors.length + ' 条');
            consoleErrors.slice(0, 5).forEach((error) => console.log('  - ' + String(error).slice(0, 200)));
        }
        client = { ws };
        const failed = report.fail > 0 || consoleErrors.length > 0;
        process.exit(failed ? 1 : 0);
    } catch (err) {
        console.error('运行失败:', err.message);
        process.exit(2);
    } finally {
        if (client) { try { client.ws.close(); } catch (err) { /* ignore */ } }
        try { chrome.kill('SIGKILL'); } catch (err) { /* ignore */ }
        try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
})();
