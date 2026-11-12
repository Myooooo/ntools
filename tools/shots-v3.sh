#!/usr/bin/env bash
# ============================================================================
# tools/shots-v3.sh — v3 新功能截图（Chrome for Testing headless + CDP 驱动）
#
# 输出（默认 /tmp/nc-shots-v3/，深色/浅色各一份）：
#   nchat-<theme>.png               原生聊天 tab（#page-nchat）
#   settings-models-<theme>.png     设置面板：模型端点
#   settings-todo-ai-<theme>.png    设置面板：Todo AI
#   todo-ai-dialog-<theme>.png      Todo AI 识别弹窗
#   quick-due-<theme>.png           创建区快捷时间 chips（展开详细选项）
#
# 用法：
#   tools/shots-v3.sh                 # 输出到 /tmp/nc-shots-v3
#   tools/shots-v3.sh /tmp/my-v3      # 指定输出目录
#   CHROME_BIN=/path/to/chrome tools/shots-v3.sh
#
# 说明：截图需要点击 tab/打开面板等交互，故用一段内嵌 Node 脚本通过 CDP 驱动；
#       脚本使用临时 profile，不影响本机浏览器数据，可重复执行。
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/nc-shots-v3}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing}"

if [ ! -x "$CHROME" ]; then
    for candidate in \
        "/Applications/Chromium.app/Contents/MacOS/Chromium" \
        "/opt/homebrew/bin/chromium" \
        "$(command -v chromium 2>/dev/null || true)" \
        "$(command -v google-chrome 2>/dev/null || true)"
    do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then CHROME="$candidate"; break; fi
    done
fi
if [ ! -x "$CHROME" ]; then
    echo "错误：找不到 Chrome/Chromium。可用 CHROME_BIN=/path/to/chrome 指定。" >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "错误：需要 Node 18+ 运行内嵌 CDP 驱动。" >&2
    exit 1
fi

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nc-shots-v3.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/driver.js" <<'NODE'
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.NC_CHROME;
const ROOT = process.env.NC_ROOT;
const OUT = process.env.NC_OUT;
const URL_NTOOLS = 'file://' + path.join(ROOT, 'ntools.html').split(path.sep).join('/');
const PORT = 9900 + (process.pid % 90);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const manifest = [];

function fileUrl(target) {
    return 'file://' + path.join(ROOT, target).split(path.sep).join('/');
}

class Client {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
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
                if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); }
            }, 25000);
        });
    }
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
        throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text);
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
    for (let i = 0; i < 60; i++) {
        try { if (await evaluate(client, "typeof window.NC !== 'undefined'")) return; } catch (err) { /* retry */ }
        await sleep(120);
    }
}

async function waitFor(client, expression, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 4000)) {
        try { if (await evaluate(client, expression)) return true; } catch (err) { /* retry */ }
        await sleep(120);
    }
    return false;
}

async function click(client, selector) {
    return evaluate(client, `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
}

async function clickButtonText(client, text, scopeSelector) {
    return evaluate(client, `(function(){
        var scope = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : 'document'} || document;
        var buttons = Array.prototype.slice.call(scope.querySelectorAll('button, [role="button"]'));
        var target = buttons.filter(function(btn){ return (btn.textContent || '').indexOf(${JSON.stringify(text)}) > -1; })[0];
        if (!target) return false;
        target.click();
        return true;
    })()`);
}

async function setValue(client, selector, value) {
    return evaluate(client, `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
}

async function shot(client, name) {
    const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    manifest.push(name);
    console.log('OK    ' + file);
}

async function setTheme(client, theme) {
    await evaluate(client, `(function(){
        try { if (window.NC && NC.theme) NC.theme.set(${JSON.stringify(theme)}); } catch (err) {}
        document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
        document.documentElement.setAttribute('data-lite', 'false');
        window.scrollTo(0, 0);
        return true;
    })()`);
    await sleep(450);
}

/* ---------------- 场景 ---------------- */
async function sceneChat(client, theme) {
    await click(client, '[data-tab="nchat"]');
    await waitFor(client, "!!document.getElementById('chat-app') && !document.getElementById('page-nchat').hidden", 8000);
    // 等聊天初始化（有端点下拉或编辑器就绪均可）
    await waitFor(client, "!!document.querySelector('#chat-profile-select') || !!document.getElementById('user-input')", 8000);
    await sleep(600);
    await setTheme(client, theme);
    await shot(client, 'nchat-' + theme + '.png');
}

async function openSettings(client, section) {
    await click(client, '#settings-btn');
    await waitFor(client, "!!document.querySelector('#settings-sheet') && !document.querySelector('#settings-sheet').hidden", 5000);
    if (section) {
        await evaluate(client, `(function(){ var n = document.querySelector('.sp-nav[data-section="${section}"]'); if (n) n.click(); return true; })()`);
        await sleep(500);
    }
}

async function closeSettings(client) {
    await evaluate(client, "(function(){ var b = document.querySelector('.settings-sheet__head button'); if (b) b.click(); return true; })()");
    await sleep(400);
}

async function sceneSettings(client, theme, section, name) {
    await openSettings(client, section);
    await setTheme(client, theme);
    await sleep(300);
    await shot(client, name + '-' + theme + '.png');
    await closeSettings(client);
}

async function sceneTodoAiDialog(client, theme) {
    await evaluate(client, "(function(){ var tab = document.querySelector('[data-tab=\"todo\"]'); if (tab) tab.click(); return true; })()");
    await waitFor(client, "!!window.NC && !!NC.todoAi", 6000);
    await sleep(400);
    const entry = await evaluate(client, `(function(){
        var candidates = ['#todo-ai-btn', '[data-act="ai"]', '.todo-composer__ai', '#todo-ai'];
        for (var i = 0; i < candidates.length; i++) { if (document.querySelector(candidates[i])) { document.querySelector(candidates[i]).click(); return 'selector'; } }
        var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
        var byText = buttons.filter(function(btn){ return (btn.textContent || '').indexOf('AI 识别') > -1; })[0];
        if (byText) { byText.click(); return 'text'; }
        return 'api';
    })()`);
    if (entry === 'api') await evaluate(client, 'NC.todoAi.openDialog(); true;');
    await waitFor(client, "!!document.querySelector('.nc-modal')", 5000);
    await evaluate(client, `(function(){
        var modal = document.querySelector('.nc-modal');
        var area = modal && modal.querySelector('textarea');
        if (!area) return false;
        area.value = '请帮我整理这封邮件里的待办：\\n周五下班前提交 Q2 季度报告，附上数据表；优先级高，标签：工作、报告。\\n—— 来自王经理的邮件';
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    await sleep(400);
    await setTheme(client, theme);
    await shot(client, 'todo-ai-dialog-' + theme + '.png');
    // 关闭弹窗
    await evaluate(client, `(function(){
        var modal = document.querySelector('.nc-modal');
        var overlay = document.querySelector('.nc-modal-overlay');
        var cancel = modal && Array.prototype.slice.call(modal.querySelectorAll('button'))
            .filter(function(btn){ return /取消|关闭/.test(btn.textContent || ''); })[0];
        if (cancel) { cancel.click(); return true; }
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        return true;
    })()`);
    await sleep(350);
}

async function sceneQuickDue(client, theme) {
    await evaluate(client, "(function(){ var tab = document.querySelector('[data-tab=\"todo\"]'); if (tab) tab.click(); return true; })()");
    await sleep(500);
    await click(client, '#todo-composer-toggle');
    await sleep(350);
    await evaluate(client, "(function(){ var el = document.getElementById('todo-composer-extra'); if (el) el.hidden = false; return true; })()");
    // 让 chips 与输入框有内容观感
    await setValue(client, '#todo-new-title', '准备周会材料');
    await sleep(300);
    await setTheme(client, theme);
    await shot(client, 'quick-due-' + theme + '.png');
    await setValue(client, '#todo-new-title', '');
}

async function main() {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-shots-v3-profile-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
        '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
        let ready = false;
        for (let i = 0; i < 200; i++) {
            try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); ready = true; break; }
            catch (err) { await sleep(100); }
        }
        if (!ready) throw new Error('Chrome debugging port not ready');
        const target = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        const client = new Client(ws);
        await client.send('Runtime.enable');
        await client.send('Page.enable');
        await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

        for (const theme of ['dark', 'light']) {
            await navigate(client, URL_NTOOLS);
            await evaluate(client, 'localStorage.clear(); true;');
            await navigate(client, URL_NTOOLS);
            await sleep(800);

            await sceneChat(client, theme);
            await sceneSettings(client, theme, 'profiles', 'settings-models');
            await sceneSettings(client, theme, 'todo-ai', 'settings-todo-ai');
            await sceneTodoAiDialog(client, theme);
            await sceneQuickDue(client, theme);
        }
        fs.writeFileSync(path.join(OUT, 'manifest.txt'), manifest.join('\n') + '\n');
        try { ws.close(); } catch (err) { /* ignore */ }
        console.log('共生成 ' + manifest.length + ' 张 → ' + OUT);
        process.exit(0);
    } catch (err) {
        console.error('截图失败: ' + (err && err.stack ? err.stack : err));
        process.exit(1);
    } finally {
        try { chrome.kill('SIGKILL'); } catch (err) { /* ignore */ }
        try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
}

main();
NODE

echo "浏览器: $CHROME"
echo "输出目录: $OUT"
NC_CHROME="$CHROME" NC_ROOT="$ROOT" NC_OUT="$OUT" node "$TMP_DIR/driver.js"
status=$?
echo "--------------------------------------------"
if [ "$status" -ne 0 ]; then
    echo "截图失败（可能 v3 依赖尚未就位）" >&2
    exit "$status"
fi
echo "完成 → $OUT"
exit 0
