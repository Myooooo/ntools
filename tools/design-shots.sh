#!/usr/bin/env bash
# ============================================================================
# tools/design-shots.sh — v4 设计验收截图归档（标准 / 浅色 / Lite × 桌面 / 移动）
#
# 输出（默认 /tmp/nc-shots/v4/design/）：
#   <scenario>-<theme>-<width>.png
#   scenario: todo | chat | settings-models | settings-todo-ai | ai-dialog | command-palette
#   theme   : standard（深色）| light（浅色）| lite（深色 + Lite）
#   width   : 1440（桌面）| 390（移动）
#   另含 manifest.txt 清单。
#
# 用法：
#   tools/design-shots.sh                # 输出到 /tmp/nc-shots/v4/design
#   tools/design-shots.sh /tmp/my-v4     # 指定输出目录
#   CHROME_BIN=/path/to/chrome tools/design-shots.sh
#   NC_SHOT_SCENARIOS=todo,chat tools/design-shots.sh   # 只跑部分场景（调试用）
#
# 说明：场景需要点击/打开面板，故用一段内嵌 Node CDP 驱动；临时 profile，
#       重复执行会覆盖同名文件；命令面板不存在时自动跳过（记录在 manifest）。
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/nc-shots/v4/design}"
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
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nc-design-shots.XXXXXX")"
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
const PORT = 9820 + (process.pid % 120);
const SCENARIOS = (process.env.NC_SHOT_SCENARIOS || 'todo,chat,settings-models,settings-todo-ai,ai-dialog,command-palette')
    .split(',').map((item) => item.trim()).filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const manifest = [];

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

async function waitFor(client, expression, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 5000)) {
        try { if (await evaluate(client, expression)) return true; } catch (err) { /* retry */ }
        await sleep(120);
    }
    return false;
}

async function navigate(client, url) {
    const loaded = new Promise((resolve) => {
        const handler = (message) => {
            if (message.method !== 'Page.loadEventFired') return;
            client.handlers = (client.handlers || []).filter((item) => item !== handler);
            resolve();
        };
        client.handlers = client.handlers || [];
        client.handlers.push(handler);
        setTimeout(resolve, 15000);
    });
    // Client 需要在构造时注册通用 handler 分发
    await client.send('Page.navigate', { url });
    await loaded;
    for (let i = 0; i < 80; i++) {
        try { if (await evaluate(client, "typeof window.NC !== 'undefined'")) return; } catch (err) { /* retry */ }
        await sleep(120);
    }
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

async function shot(client, name) {
    const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    manifest.push(name);
    console.log('OK    ' + file);
}

async function applyTheme(client, theme) {
    await evaluate(client, `(function(){
        var mode = ${JSON.stringify(theme)};
        try {
            if (window.NC && NC.theme) {
                NC.theme.set(mode === 'light' ? 'light' : 'dark');
                NC.theme.setLite(mode === 'lite');
            }
        } catch (err) {}
        document.documentElement.setAttribute('data-theme', mode === 'light' ? 'light' : 'dark');
        document.documentElement.setAttribute('data-lite', mode === 'lite' ? 'true' : 'false');
        window.scrollTo(0, 0);
        return true;
    })()`);
    await sleep(500);
}

/* ---------------- 演示数据（温和、真实，不代表最坏数据） ---------------- */
function seedDemoData(client) {
    const now = Date.now();
    const todo = {
        schemaVersion: 2, revision: 1, updatedAt: now,
        lists: [
            { id: 'list_default', name: '待办', color: '#6EA8FE', order: 0, archived: false, createdAt: now, updatedAt: now },
            { id: 'list_week', name: '本周重点', color: '#D8B06A', order: 1, archived: false, createdAt: now, updatedAt: now }
        ],
        tasks: [
            { id: 'demo-1', listId: 'list_default', title: '提交季度报告并同步华东供应商排期', notes: '', status: 'open', priority: 'high', due: now + 2 * 3600000, dueAllDay: false, tags: ['工作', '报告'], subtasks: [], recurrence: null, reminder: null, order: 0, createdAt: now, updatedAt: now, completedAt: null, deletedAt: null, source: 'demo' },
            { id: 'demo-2', listId: 'list_week', title: '安全巡检整改复核', notes: '', status: 'open', priority: 'urgent', due: now + 86400000, dueAllDay: false, tags: ['安全'], subtasks: [], recurrence: null, reminder: null, order: 1024, createdAt: now, updatedAt: now, completedAt: null, deletedAt: null, source: 'demo' },
            { id: 'demo-3', listId: 'list_default', title: '整理本周会议纪要并归档', notes: '', status: 'done', priority: 'normal', due: now - 3600000, dueAllDay: false, tags: [], subtasks: [], recurrence: null, reminder: null, order: 2048, createdAt: now, updatedAt: now, completedAt: now - 1800000, deletedAt: null, source: 'demo' }
        ],
        settings: { defaultListId: 'list_default', view: 'all', sort: 'smart', showCompleted: true, reminderLeadMinutes: 15, compact: false },
        meta: { app: 'nTools', appVersion: '4.0.0', migratedFrom: null, migratedAt: null, quarantine: [] }
    };
    const llm = {
        version: 1,
        profiles: [
            { id: 'p-demo-1', name: '内网 GPT-4o', baseUrl: 'https://llm-gateway.internal.example.com/v1', apiKey: 'sk-demo', modelId: 'gpt-4o', chatSystemPrompt: '', temperature: 1, topP: 0.95, createdAt: now, updatedAt: now },
            { id: 'p-demo-2', name: '内网 DeepSeek', baseUrl: 'https://llm-gateway.internal.example.com/v1', apiKey: 'sk-demo', modelId: 'deepseek-chat', chatSystemPrompt: '', temperature: 0.8, topP: 0.9, createdAt: now, updatedAt: now }
        ],
        currentProfileId: 'p-demo-1',
        todoAi: { profileId: null, systemPrompt: '你是待办事项提取助手。请从用户提供的文本中提取一项待办任务，并只输出 JSON 对象。', temperature: 0.2, topP: 0.9 },
        workEndTime: '17:30',
        updatedAt: now
    };
    const conversation = {
        version: 2,
        sessions: {
            'p-demo-1': {
                updatedAt: now,
                messages: [
                    { id: 'm1', role: 'user', createdAt: now - 6000, content: [{ type: 'text', text: '帮我总结一下这周供应商会议的三条结论。' }] },
                    { id: 'm2', role: 'assistant', createdAt: now - 5000, content: '本周供应商会议的三条结论：\n\n1. **交付节奏**：华东区三家供应商按 11 月 15 日、11 月 30 日两批到货。\n2. **合规材料**：营业执照、授权书、质检报告需在 11 月 10 日前补齐。\n3. **风险预案**：若第二批延误，启用备选供应商并顺延两周。\n\n需要我把这些结论转成待办吗？' },
                    { id: 'm3', role: 'user', createdAt: now - 4000, content: [{ type: 'text', text: '好的，转成待办，截止放到月底前。' }] },
                    { id: 'm4', role: 'assistant', createdAt: now - 3000, content: '已整理为三条待办，可在「待办」页查看：\n\n- 确认华东区两批到货排期（高）\n- 收齐供应商合规材料（高）\n- 制定第二批延误的备选预案（中）' }
                ]
            }
        }
    };
    return evaluate(client, `(function(){
        localStorage.setItem('ntools.todo.v2', JSON.stringify(${JSON.stringify(todo)}));
        localStorage.setItem('ntools.llm.v1', JSON.stringify(${JSON.stringify(llm)}));
        localStorage.setItem('nchat-conversation.v2', JSON.stringify(${JSON.stringify(conversation)}));
        localStorage.setItem('nchat-theme', 'dark');
        localStorage.setItem('nchat-lite-mode', 'false');
        return true;
    })()`);
}

/* ---------------- 场景 ---------------- */
async function sceneTodo(client, theme, width) {
    await evaluate(client, "(function(){ var t = document.querySelector('[data-tab=\"todo\"]'); if (t) t.click(); window.scrollTo(0,0); return true; })()");
    await sleep(500);
    await applyTheme(client, theme);
    await shot(client, 'todo-' + theme + '-' + width + '.png');
}

async function sceneChat(client, theme, width) {
    await evaluate(client, "(function(){ var t = document.querySelector('[data-tab=\"nchat\"]'); if (t) t.click(); return true; })()");
    await waitFor(client, "!!(window.NC && NC.chatEmbed && NC.chatEmbed.isReady && NC.chatEmbed.isReady())", 12000);
    await sleep(700);
    await applyTheme(client, theme);
    await shot(client, 'chat-' + theme + '-' + width + '.png');
}

async function openSettings(client, section) {
    await click(client, '#settings-btn');
    await waitFor(client, "!!document.querySelector('#settings-sheet') && !document.querySelector('#settings-sheet').hidden", 6000);
    await evaluate(client, `(function(){ var n = document.querySelector('.sp-nav[data-section="${section}"]'); if (n) n.click(); return true; })()`);
    await sleep(500);
}

async function closeSettings(client) {
    await evaluate(client, "(function(){ var b = document.querySelector('.settings-sheet__head button'); if (b) b.click(); return true; })()");
    await sleep(350);
}

async function sceneSettings(client, theme, width, section, name) {
    await openSettings(client, section);
    await applyTheme(client, theme);
    await sleep(300);
    await shot(client, name + '-' + theme + '-' + width + '.png');
    await closeSettings(client);
}

async function sceneAiDialog(client, theme, width) {
    await evaluate(client, "(function(){ var t = document.querySelector('[data-tab=\"todo\"]'); if (t) t.click(); return true; })()");
    await sleep(400);
    // 有配置文件略：直接打开弹窗并填入真实感文本
    const opened = await click(client, '#todo-ai-btn');
    if (!opened) {
        await evaluate(client, "try { NC.todoAi.openDialog(); } catch (err) {} true;");
    }
    await waitFor(client, "!!document.querySelector('.nc-modal')", 6000);
    await evaluate(client, `(function(){
        var modal = document.querySelector('.nc-modal');
        var area = modal && modal.querySelector('textarea');
        if (area) {
            area.value = '王经理好，关于华东区四季度交付：\\n1）11 月 15 日与 11 月 30 日两批到货，需采购与法务在 11 月 10 日前完成合同与合规材料确认；\\n2）若第二批延误，启用备选供应商并顺延两周；\\n3）月底前完成排期复核与风险预案。\\n请帮我整理成待办。';
            area.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
    })()`);
    await sleep(400);
    await applyTheme(client, theme);
    await shot(client, 'ai-dialog-' + theme + '-' + width + '.png');
    await evaluate(client, `(function(){
        var modal = document.querySelector('.nc-modal');
        var cancel = modal && Array.prototype.slice.call(modal.querySelectorAll('button')).filter(function(b){ return /取消|关闭/.test(b.textContent); })[0];
        if (cancel) { cancel.click(); return true; }
        var overlay = document.querySelector('.nc-modal-overlay');
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        return true;
    })()`);
    await sleep(350);
}

async function sceneCommandPalette(client, theme, width) {
    // 尝试多种常见入口：Ctrl/Cmd+K、按钮/占位提示
    await evaluate(client, "(function(){ document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true; })()");
    await sleep(500);
    let visible = await evaluate(client, `(function(){
        var nodes = document.querySelectorAll('.command-palette, .cmdk, [data-command-palette], .nc-command');
        for (var i = 0; i < nodes.length; i++) {
            var r = nodes[i].getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && getComputedStyle(nodes[i]).visibility !== 'hidden') return true;
        }
        return false;
    })()`);
    if (!visible) {
        // 尝试点击搜索类按钮
        const opened = await evaluate(client, `(function(){
            var buttons = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]'));
            var target = buttons.filter(function(btn){ return /搜索|命令|Ctrl/.test((btn.getAttribute('title') || '') + (btn.textContent || '')); })[0];
            if (!target) return false;
            target.click();
            return true;
        })()`);
        if (opened) {
            await sleep(600);
            visible = await evaluate(client, `(function(){
                var nodes = document.querySelectorAll('.command-palette, .cmdk, [data-command-palette], .nc-command, [role="dialog"]');
                for (var i = 0; i < nodes.length; i++) {
                    var r = nodes[i].getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return true;
                }
                return false;
            })()`);
        }
    }
    if (!visible) {
        manifest.push('command-palette-' + theme + '-' + width + '.png\tSKIP（当前版本未提供命令面板）');
        console.log('SKIP  command-palette-' + theme + '-' + width + '.png（当前版本未提供命令面板）');
        return;
    }
    await applyTheme(client, theme);
    await shot(client, 'command-palette-' + theme + '-' + width + '.png');
    await evaluate(client, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;");
    await sleep(300);
}

async function main() {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-design-shots-profile-'));
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
        await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });

        const themes = ['standard', 'light', 'lite'];
        const widths = [{ width: 1440, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }];

        for (const theme of themes) {
            for (const viewport of widths) {
                await client.send('Emulation.setDeviceMetricsOverride', {
                    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
                    screenWidth: viewport.width, screenHeight: viewport.height
                });
                await client.send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 });
                await navigate(client, URL_NTOOLS);
                await seedDemoData(client);
                await client.send('Page.reload', { ignoreCache: true });
                await sleep(2600);
                await applyTheme(client, theme);
                const width = viewport.width;
                for (const scenario of SCENARIOS) {
                    if (scenario === 'todo') await sceneTodo(client, theme, width);
                    else if (scenario === 'chat') await sceneChat(client, theme, width);
                    else if (scenario === 'settings-models') await sceneSettings(client, theme, width, 'profiles', 'settings-models');
                    else if (scenario === 'settings-todo-ai') await sceneSettings(client, theme, width, 'todo-ai', 'settings-todo-ai');
                    else if (scenario === 'ai-dialog') await sceneAiDialog(client, theme, width);
                    else if (scenario === 'command-palette') await sceneCommandPalette(client, theme, width);
                }
            }
        }
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'manifest.txt'), manifest.join('\n') + '\n');
        try { ws.close(); } catch (err) { /* ignore */ }
        console.log('共归档 ' + manifest.filter((line) => !/\tSKIP/.test(line)).length + ' 张 → ' + OUT);
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
echo "场景: ${NC_SHOT_SCENARIOS:-todo,chat,settings-models,settings-todo-ai,ai-dialog,command-palette}"
NC_CHROME="$CHROME" NC_ROOT="$ROOT" NC_OUT="$OUT" node "$TMP_DIR/driver.js"
status=$?
echo "--------------------------------------------"
if [ "$status" -ne 0 ]; then
    echo "截图失败（v4 依赖可能尚未就位）" >&2
    exit "$status"
fi
echo "完成 → $OUT"
exit 0
