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
# v4.5 设计 QA 模式（全页面回归截图 + 设计自检）：
#   NC_SHOT_MODE=qa tools/design-shots.sh /tmp/nc-shots/v45/qa
#   输出：5 tab × 深/浅 × 标准/Lite × 1440/1024/390，以及 todo 详情/回收站/热区/
#         侧栏收起/hover、chat welcome/端点/legacy 等状态图；另写 qa-report.json。
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
const MODE = process.env.NC_SHOT_MODE || 'design';
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

async function dismissToasts(client) {
    await evaluate(client, `(function(){
        var wrap = document.querySelector('.nc-toasts');
        if (wrap) wrap.textContent = '';
        return true;
    })()`);
    await sleep(120);
}

async function shot(client, name, opts) {
    if (MODE === 'qa' && !(opts && opts.keepToast)) await dismissToasts(client);
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


/* ==================================================================== *
 * v4.5 QA 模式：全页面截图 + 设计自检（只读）
 * ==================================================================== */
const QA = { mode: 'qa', checks: [], issues: [], observations: [], extras: [], shots: [], startedAt: new Date().toISOString() };

function qaCheck(name, ok, detail) {
    QA.checks.push({ name: name, ok: !!ok, detail: detail == null ? '' : String(detail) });
    if (!ok) QA.issues.push({ name: name, detail: detail == null ? '' : String(detail) });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail == null ? '' : '  → ' + detail));
}

async function setViewport(client, width, height, mobile) {
    await client.send('Emulation.setDeviceMetricsOverride', {
        width: width, height: height, deviceScaleFactor: 1, mobile: !!mobile,
        screenWidth: width, screenHeight: height
    });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 });
    await sleep(280);
}

async function applyMode(client, theme, lite) {
    await evaluate(client, `(function(){
        try {
            if (window.NC && NC.theme) {
                NC.theme.set(${JSON.stringify(theme === 'lite' ? 'dark' : theme)});
                NC.theme.setLite(${theme === 'lite' ? 'true' : 'false'} || ${!!lite});
            }
        } catch (err) {}
        document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme === 'lite' ? 'dark' : theme)});
        document.documentElement.setAttribute('data-lite', ${lite ? 'true' : 'false'});
        window.scrollTo(0, 0);
        return true;
    })()`);
    await sleep(420);
}

async function clickTab(client, tab) {
    await evaluate(client, `(function(){
        var t = document.querySelector('[data-tab="${tab}"]');
        if (t) t.click();
        window.scrollTo(0, 0);
        return true;
    })()`);
    if (tab === 'nchat') {
        await waitFor(client, "!!(window.NC && NC.chatEmbed && NC.chatEmbed.isReady && NC.chatEmbed.isReady())", 12000);
    }
    await sleep(520);
}

function qaTodoDoc(now) {
    const h = 3600000;
    const mk = (id, patch) => Object.assign({
        id: id, listId: 'list_default', title: '时间线任务 ' + id, notes: '',
        status: 'open', priority: 'normal', due: null, dueAllDay: false, tags: [],
        subtasks: [], recurrence: null, reminder: null, order: 0,
        createdAt: now - 6 * 3600000, updatedAt: now, completedAt: null, deletedAt: null, source: 'qa'
    }, patch);
    const tasks = [
        mk('qa-pin', { title: '提交季度报告并同步华东供应商排期', priority: 'high', pinned: true, due: now + 2 * h, tags: ['工作', '报告', '季度'], order: 0 }),
        mk('qa-today', { title: '安全巡检整改复核', priority: 'urgent', due: new Date(now).setHours(18, 30, 0, 0), tags: ['安全'], order: 1024 }),
        mk('qa-tomorrow', { title: '整理本周会议纪要并归档', due: now + 26 * h, tags: ['会议'], order: 2048 }),
        mk('qa-after', { title: '核对供应商合规材料', due: now + 50 * h, priority: 'low', order: 3072 }),
        mk('qa-overdue', { title: '处理逾期的安全巡检整改', priority: 'urgent', due: now - 26 * h, tags: ['安全'], order: 4096 }),
        mk('qa-done', { title: '提交上周周报', status: 'done', completedAt: now - h, due: now - 2 * h, order: 5120 }),
        mk('qa-recur', {
            title: '每周合规巡检复盘', priority: 'high', due: now + 6 * h, tags: ['合规'], order: 6144,
            recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], until: null, count: null, lastMaterializedAt: now }
        }),
        mk('qa-long', {
            title: '与华东区域三家供应商确认第四季度交付排期，并同步采购、法务、财务三个部门的审批节点与应急预案（含备选供应商与到货缓冲）',
            due: now + 3 * h, tags: ['采购', '法务', '财务', '交付', '供应商', '审批', '例会', '季度'], order: 7168
        }),
        mk('qa-trash-1', { title: '已删除的旧版排期表', deletedAt: now - h, due: now - 86400000, order: 8192 }),
        mk('qa-trash-2', { title: '误建的测试任务', deletedAt: now - 2 * h, due: null, order: 9216 }),
        mk('qa-trash-3', { title: '作废的供应商拜访', deletedAt: now - 3 * h, due: now - 2 * 86400000, status: 'canceled', order: 10240 })
    ];
    return {
        schemaVersion: 2, revision: 1, updatedAt: now,
        lists: [
            { id: 'list_default', name: '待办', color: '#6EA8FE', order: 0, archived: false, createdAt: now, updatedAt: now },
            { id: 'list_week', name: '本周重点', color: '#D8B06A', order: 1, archived: false, createdAt: now, updatedAt: now }
        ],
        tasks: tasks,
        settings: { defaultListId: 'list_default', view: 'all', sort: 'smart', showCompleted: true, reminderLeadMinutes: 15, compact: false },
        meta: { app: 'nTools', appVersion: '4.5.0', migratedFrom: null, migratedAt: null, quarantine: [] }
    };
}

const QA_LLM = {
    version: 1,
    profiles: [
        { id: 'p-demo-1', name: '内网 GPT-4o', baseUrl: 'https://llm-gateway.internal.example.com/v1', apiKey: 'sk-demo', modelId: 'gpt-4o', chatSystemPrompt: '', temperature: 1, topP: 0.95, createdAt: Date.now(), updatedAt: Date.now() },
        { id: 'p-demo-2', name: '内网 DeepSeek', baseUrl: 'https://llm-gateway.internal.example.com/v1', apiKey: 'sk-demo', modelId: 'deepseek-chat', chatSystemPrompt: '', temperature: 0.8, topP: 0.9, createdAt: Date.now(), updatedAt: Date.now() }
    ],
    currentProfileId: 'p-demo-1',
    todoAi: { profileId: null, systemPrompt: '你是待办事项提取助手。请从用户提供的文本中提取一项待办任务，并只输出 JSON 对象。', temperature: 0.2, topP: 0.9 },
    workEndTime: '17:30', updatedAt: Date.now()
};

function qaConversation(now) {
    return {
        version: 2,
        sessions: {
            'p-demo-1': {
                updatedAt: now,
                messages: [
                    { id: 'q1', role: 'user', createdAt: now - 6000, content: [{ type: 'text', text: '帮我总结一下这周供应商会议的三条结论。' }] },
                    { id: 'q2', role: 'assistant', createdAt: now - 5000, content: '本周供应商会议的三条结论：\n\n1. **交付节奏**：华东区三家供应商按 11 月 15 日、11 月 30 日两批到货。\n2. **合规材料**：营业执照、授权书、质检报告需在 11 月 10 日前补齐。\n3. **风险预案**：若第二批延误，启用备选供应商并顺延两周。\n\n需要我把这些结论转成待办吗？' },
                    { id: 'q3', role: 'user', createdAt: now - 4000, content: [{ type: 'text', text: '好的，转成待办，截止放到月底前。' }] },
                    { id: 'q4', role: 'assistant', createdAt: now - 3000, content: '已整理为三条待办，可在「待办」页查看：\n\n- 确认华东区两批到货排期（高）\n- 收齐供应商合规材料（高）\n- 制定第二批延误的备选预案（中）' }
                ]
            }
        }
    };
}

async function seedQaData(client) {
    const now = Date.now();
    return evaluate(client, `(function(){
        localStorage.setItem('ntools.todo.v2', JSON.stringify(${JSON.stringify(qaTodoDoc(now))}));
        localStorage.setItem('ntools.llm.v1', JSON.stringify(${JSON.stringify(QA_LLM)}));
        localStorage.setItem('nchat-conversation.v2', JSON.stringify(${JSON.stringify(qaConversation(now))}));
        localStorage.setItem('nchat-theme', 'dark');
        localStorage.setItem('nchat-lite-mode', 'false');
        localStorage.removeItem('ntools.rail-collapsed');
        return true;
    })()`);
}

async function seedLegacyData(client) {
    const now = Date.now();
    const llm = Object.assign({}, QA_LLM, { profiles: [QA_LLM.profiles[0]], currentProfileId: 'p-demo-1' });
    return evaluate(client, `(function(){
        localStorage.setItem('ntools.todo.v2', JSON.stringify(${JSON.stringify(qaTodoDoc(now))}));
        localStorage.setItem('ntools.llm.v1', JSON.stringify(${JSON.stringify(llm)}));
        localStorage.setItem('nchat-settings', JSON.stringify({
            currentId: 'legacy-1',
            configs: [
                { id: 'legacy-1', name: '旧 nChat 配置', apiUrl: 'https://legacy-gateway.internal.example.com/v1', apiKey: 'sk-legacy-demo', modelId: 'gpt-3.5-turbo' }
            ]
        }));
        localStorage.setItem('nchat-conversation.v2', JSON.stringify(${JSON.stringify(qaConversation(now))}));
        return true;
    })()`);
}

async function openTodoDetail(client) {
    await evaluate(client, `(function(){
        var row = document.querySelector('.todo-item');
        if (!row) return false;
        row.click();
        return true;
    })()`);
    return waitFor(client, "!!document.querySelector('.todo-detail') && !document.querySelector('.todo-shell').classList.contains('is-detail-hidden') && document.querySelector('.todo-detail').getBoundingClientRect().width > 0", 5000);
}

async function closeTodoDetail(client) {
    await evaluate(client, `(function(){
        NC.store.todo.clearSelection();
        return true;
    })()`);
    await sleep(350);
}

async function runQaMatrix(client) {
    const tabs = [
        { name: 'todo', tab: 'todo' }, { name: 'chat', tab: 'nchat' },
        { name: 'qr', tab: 'qr' }, { name: 'md', tab: 'md' }, { name: 'image', tab: 'image' }
    ];
    const viewports = [
        { width: 1440, height: 900, mobile: false },
        { width: 1024, height: 768, mobile: false },
        { width: 390, height: 844, mobile: true }
    ];
    for (const theme of ['dark', 'light']) {
        for (const lite of [false, true]) {
            const modeName = theme + '-' + (lite ? 'lite' : 'std');
            for (const vp of viewports) {
                await setViewport(client, vp.width, vp.height, vp.mobile);
                await navigate(client, URL_NTOOLS);
                await seedQaData(client);
                await client.send('Page.reload', { ignoreCache: true });
                await sleep(2500);
                await applyMode(client, theme, lite);
                for (const item of tabs) {
                    await clickTab(client, item.tab);
                    await shot(client, item.name + '-' + modeName + '-' + vp.width + '.png');
                }
            }
        }
    }
}

function qaAlignmentScript(tab) {
    return `(function(){
        function info(el){ if (!el) return null; var r = el.getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + r.height/2, w: r.width, h: r.height }; }
        var out = [];
        function pair(name, a, b, tol){
            var ia = info(a), ib = info(b);
            if (!ia || !ib) { out.push({ name: 'observe:' + name, ok: true, delta: null, detail: 'n/a（该页面无对应元素）' }); return; }
            var delta = Math.abs(ia.cy - ib.cy);
            out.push({ name: name, ok: delta <= (tol || 1.5), delta: Math.round(delta*10)/10, detail: JSON.stringify({a: ia.cy, b: ib.cy}) });
        }
        if (${JSON.stringify(tab)} === 'todo') {
            var rows = Array.prototype.slice.call(document.querySelectorAll('.todo-item')).slice(0, 6);
            rows.forEach(function(row, index){
                var tag = row.querySelector('.todo-item__tag');
                var action = row.querySelector('.todo-item__actions button');
                var title = row.querySelector('.todo-item__title');
                var due = row.querySelector('.todo-item__due');
                // 任务要求：tag / 行操作按钮中线一致（行右列）
                if (tag && action) pair('todo行' + index + ' 标签/操作按钮中线', tag, action, 1.5);
                if (title && due) out.push({ name: 'observe:todo行' + index + ' 标题/到期列中线差', ok: true, delta: Math.round(Math.abs(info(title).cy - info(due).cy) * 10) / 10, detail: 'title first line vs two-line due column' });
            });
            // 观察项：右列（tag/操作）按行居中，标题在首行 → 基线天然相差 ~8-9px
            var firstTitle = document.querySelector('.todo-item__title');
            var firstTag = document.querySelector('.todo-item__tag');
            var firstAction = document.querySelector('.todo-item__actions button');
            if (firstTitle && (firstTag || firstAction)) {
                var t = info(firstTitle), r = info(firstTag || firstAction);
                out.push({ name: 'observe:todo右列与标题首行中线差', ok: true, delta: Math.round(Math.abs(t.cy - r.cy) * 10) / 10, detail: 'row-center trailing column vs first-line title' });
            }
            var headTitle = document.querySelector('.tools-page.is-active .tools-title');
            var seg = document.querySelector('.todo-mode-seg');
            pair('页头标题/模式切换中线', headTitle, seg, 3);
        }
        if (${JSON.stringify(tab)} === 'nchat') {
            var send = document.getElementById('send-btn');
            var input = document.getElementById('user-input');
            pair('chat 发送按钮/输入区中线', send, input, 4);
            var select = document.getElementById('chat-profile-select');
            var meta = document.getElementById('chat-profile-meta');
            pair('chat 端点/元信息中线', select, meta, 4);
        }
        if (${JSON.stringify(tab)} === 'qr' || ${JSON.stringify(tab)} === 'md' || ${JSON.stringify(tab)} === 'image') {
            var title = document.querySelector('.tools-page.is-active .tools-title');
            var actions = document.querySelector('.tools-page.is-active .tools-head__actions');
            var it = info(title), ia = info(actions);
            if (it && ia) out.push({ name: 'observe:' + ${JSON.stringify(tab)} + ' 页头标题/操作区中线差', ok: true, delta: Math.round(Math.abs(it.cy - ia.cy) * 10) / 10, detail: 'page header title vs actions block' });
            else out.push({ name: 'observe:' + ${JSON.stringify(tab)} + ' 页头无操作区', ok: true, delta: null, detail: 'n/a' });
        }
        return out;
    })()`;
}

function qaContrastScript() {
    return `(function(){
        function rgba(str){
            var m = String(str || '').match(/rgba?\\(([^)]+)\\)/);
            if (!m) return null;
            var p = m[1].split(',').map(function(v){ return parseFloat(v); });
            return { r:p[0], g:p[1], b:p[2], a:p.length > 3 ? p[3] : 1 };
        }
        function blend(fg, bg){ if (!fg) return null; var a = fg.a; return { r: fg.r*a + bg.r*(1-a), g: fg.g*a + bg.g*(1-a), b: fg.b*a + bg.b*(1-a), a: 1 }; }
        function lum(c){ function ch(v){ v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); } return 0.2126*ch(c.r)+0.7152*ch(c.g)+0.0722*ch(c.b); }
        function solidBg(el){ var node = el; while (node) { var bg = rgba(getComputedStyle(node).backgroundColor); if (bg && bg.a >= 0.99) return bg; node = node.parentElement; } return { r: 11, g: 14, b: 19, a: 1 }; }
        function ratio(fgStr, el){
            var fg = rgba(fgStr); var bg = solidBg(el); if (!fg) return null;
            var fgc = blend(fg, bg); var l1 = lum(fgc), l2 = lum(bg);
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        }
        var out = [];
        function sample(name, el, min){
            if (!el) return;
            var rect0 = el.getBoundingClientRect();
            if (rect0.width < 1 || rect0.height < 1) return;
            var cs = getComputedStyle(el);
            var r = ratio(cs.color, el);
            var fsz = parseFloat(cs.fontSize) || 14;
            var bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
            var large = fsz >= 24 || (fsz >= 18.66 && bold);
            var need = min || (large ? 3 : 4.5);
            out.push({ name: name, ratio: r == null ? null : Math.round(r*100)/100, ok: r != null && r >= need, min: need });
        }
        sample('todo 标题/行底', document.querySelector('.todo-item__title'));
        sample('todo 到期时间/行底', document.querySelector('.todo-item__due-clock') || document.querySelector('.todo-item__due'));
        sample('todo 标签/标签底', document.querySelector('.todo-item__tag'), 4.5);
        sample('todo 视图计数/侧栏', document.querySelector('.todo-view-item__count'));
        sample('侧栏导航文字', document.querySelector('.tools-nav__label'));
        sample('页面标题', document.querySelector('.tools-page.is-active .tools-title'), 3);
        var chatText = document.querySelector('.chat-msg--assistant .chat-msg__content') || document.querySelector('.chat-msg--assistant');
        sample('chat 助手正文', chatText);
        sample('chat 元信息', document.querySelector('.chat-msg__meta') || document.querySelector('.chat-msg__role'));
        sample('chat 输入占位/输入底', document.getElementById('user-input'), 3);
        return out;
    })()`;
}

async function qaRunAlignmentOnly(client, tab) {
    const alignment = await evaluate(client, qaAlignmentScript(tab));
    (alignment || []).forEach((item) => {
        if (item.name.indexOf('observe:') === 0) { QA.observations.push({ name: item.name, delta: item.delta, detail: item.detail }); return; }
        qaCheck('对齐 · ' + item.name, item.ok, item.delta == null ? item.detail : 'deltaY=' + item.delta);
    });
    return alignment;
}

async function qaRunAlignmentAndContrast(client, tab) {
    await qaRunAlignmentOnly(client, tab);
    const contrast = await evaluate(client, qaContrastScript());
    (contrast || []).forEach((item) => qaCheck('对比度 · ' + item.name, item.ok, item.ratio == null ? 'missing' : item.ratio + ':1（≥' + item.min + ':1）'));
}

async function qaCheckLite(client) {
    await applyMode(client, 'dark', false);
    const std = await evaluate(client, `(function(){
        function pick(sel, prop){ var el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; }
        return {
            railBlur: pick('.tools-rail', 'backdropFilter'),
            railShadow: pick('.tools-rail', 'boxShadow'),
            toolbarBlur: pick('.chat-toolbar', 'backdropFilter'),
            composerBg: pick('.todo-composer', 'backgroundColor'),
            animations: document.getAnimations().length
        };
    })()`);
    await applyMode(client, 'dark', true);
    const lite = await evaluate(client, `(function(){
        function pick(sel, prop){ var el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; }
        return {
            railBlur: pick('.tools-rail', 'backdropFilter'),
            railShadow: pick('.tools-rail', 'boxShadow'),
            toolbarBlur: pick('.chat-toolbar', 'backdropFilter'),
            composerBg: pick('.todo-composer', 'backgroundColor'),
            animations: document.getAnimations().length
        };
    })()`);
    const blurOk = [lite.railBlur, lite.toolbarBlur].every((v) => !v || v === 'none');
    qaCheck('Lite 减法 · 玻璃/backdrop-filter 关闭', blurOk, JSON.stringify({ standard: { rail: std.railBlur, toolbar: std.toolbarBlur }, lite: { rail: lite.railBlur, toolbar: lite.toolbarBlur } }));
    qaCheck('Lite 减法 · 无持续动画', (lite.animations || 0) === 0, 'standard=' + std.animations + ' lite=' + lite.animations);
    function shadowIsHairline(value) {
        if (!value || value === 'none') return true;
        var layers = String(value).split(/,(?![^()]*\))/);
        return layers.every(function(layer){
            var m = layer.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px/);
            if (!m) return true;
            return parseFloat(m[3]) === 0 && Math.abs(parseFloat(m[1])) <= 1 && Math.abs(parseFloat(m[2])) <= 1;
        });
    }
    qaCheck('Lite 减法 · 阴影收敛为发丝/无阴影', shadowIsHairline(lite.railShadow), 'std=' + std.railShadow + ' lite=' + lite.railShadow);
    await applyMode(client, 'dark', false);
}

async function qaCheckFocus(client) {
    await evaluate(client, "(function(){ document.body.focus(); return true; })()");
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(250);
    const focus = await evaluate(client, `(function(){
        var el = document.activeElement;
        if (!el || el === document.body) return { found: false };
        var cs = getComputedStyle(el);
        return {
            found: true, tag: el.tagName, cls: (el.className || '').toString().slice(0, 60),
            outline: cs.outlineWidth + ' ' + cs.outlineStyle, shadow: cs.boxShadow
        };
    })()`);
    qaCheck('键盘焦点可见', focus.found && (focus.outline.indexOf('0px') !== 0 || focus.shadow !== 'none'), JSON.stringify(focus));
}

async function qaCheckHover(client) {
    // ① 非激活导航项：hover 背景应变化
    const nav = await evaluate(client, `(function(){
        var el = document.querySelector('.tools-nav__item:not(.is-active)') || document.querySelector('.tools-nav__item');
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2, bg: getComputedStyle(el).backgroundColor };
    })()`);
    if (!nav) { qaCheck('hover 反馈 · 导航项', false, 'missing'); }
    else {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nav.x, y: nav.y });
        await sleep(320);
        const after = await evaluate(client, "(function(){ var el = document.querySelector('.tools-nav__item:not(.is-active)') || document.querySelector('.tools-nav__item'); return el ? getComputedStyle(el).backgroundColor : null; })()");
        qaCheck('hover 反馈 · 导航项背景变化', after && after !== nav.bg, JSON.stringify({ before: nav.bg, after: after }));
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
        await sleep(200);
    }
    // ② 待办行：hover 应显现行操作按钮（opacity 0 → 1）
    const row = await evaluate(client, `(function(){
        var el = document.querySelector('.todo-item');
        if (!el) return null;
        var actions = el.querySelector('.todo-item__actions');
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2, opacity: actions ? getComputedStyle(actions).opacity : null };
    })()`);
    if (!row || row.opacity == null) { qaCheck('hover 显现行内操作', false, 'missing'); return; }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    await sleep(380);
    const rowHover = await evaluate(client, `(function(){
        var el = document.querySelector('.todo-item .todo-item__actions');
        return el ? { opacity: getComputedStyle(el).opacity, actionsDisplay: getComputedStyle(el).display } : null;
    })()`);
    qaCheck('hover 显现行内操作（opacity 0→1）', rowHover && parseFloat(rowHover.opacity) > parseFloat(row.opacity || '0') + 0.3,
        JSON.stringify({ before: row.opacity, after: rowHover && rowHover.opacity, actionsDisplay: rowHover && rowHover.actionsDisplay }));
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await sleep(200);
}

async function qaCheckStickyFooter(client) {
    const opened = await openTodoDetail(client);
    if (!opened) { qaCheck('详情粘性 footer', false, '详情未打开'); return; }
    const result = await evaluate(client, `(function(){
        var foot = document.querySelector('.detail-foot');
        var inner = document.querySelector('.todo-detail__inner') || document.querySelector('.todo-detail');
        if (!foot || !inner) return { ok: false, reason: 'missing' };
        var before = foot.getBoundingClientRect();
        inner.scrollTop = inner.scrollHeight;
        var after = foot.getBoundingClientRect();
        var hostRect = inner.getBoundingClientRect();
        var cs = getComputedStyle(foot);
        return {
            position: cs.position,
            beforeBottom: Math.round(before.bottom), afterBottom: Math.round(after.bottom),
            hostBottom: Math.round(hostRect.bottom), viewportBottom: window.innerHeight,
            visibleAfterScroll: after.top >= 0 && after.bottom <= window.innerHeight + 1
        };
    })()`);
    qaCheck('详情粘性 footer（滚动后可达）', result.position === 'sticky' && result.visibleAfterScroll,
        JSON.stringify(result));
    await closeTodoDetail(client);
}

async function qaCheckOverflow(client) {
    const tabs = ['todo', 'nchat', 'qr', 'md', 'image'];
    for (const vp of [{ width: 1440, height: 900, mobile: false }, { width: 1024, height: 768, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        await setViewport(client, vp.width, vp.height, vp.mobile);
        for (const tab of tabs) {
            await clickTab(client, tab);
            const result = await evaluate(client, `(function(){
                return {
                    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    body: document.body.scrollWidth - document.body.clientWidth
                };
            })()`);
            qaCheck('无横向溢出 · ' + tab + ' @' + vp.width, result.doc <= 1 && result.body <= 1, JSON.stringify(result));
        }
    }
    await setViewport(client, 390, 844, true);
    await clickTab(client, 'todo');
    await evaluate(client, "(function(){ NC.store.todo.setView('trash'); return true; })()");
    await sleep(500);
    const trashOverflow = await evaluate(client, `(function(){ return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    qaCheck('无横向溢出 · 回收站 @390', trashOverflow.doc <= 1, JSON.stringify(trashOverflow));
    await evaluate(client, "(function(){ NC.store.todo.setView('all'); return true; })()");
    await setViewport(client, 1440, 900, false);
}

async function qaCheckMobile(client) {
    await setViewport(client, 390, 844, true);
    await clickTab(client, 'todo');
    const mobile = await evaluate(client, `(function(){
        var vp = (document.querySelector('meta[name=viewport]') || {}).content || '';
        var theme = document.querySelector('meta[name=theme-color]');
        var small = [];
        Array.prototype.forEach.call(document.querySelectorAll('.todo-item__actions button, .tools-nav__item, .chat-toolbar button'), function(el){
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && (r.width < 28 || r.height < 28)) small.push({ cls: (el.className || '').toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
        });
        return {
            viewport: vp,
            themeColor: theme ? theme.getAttribute('content') : null,
            smallTargets: small.slice(0, 5),
            tapHighlight: getComputedStyle(document.documentElement).webkitTapHighlightColor
        };
    })()`);
    qaCheck('移动端 viewport-fit', /viewport-fit=cover/.test(mobile.viewport), mobile.viewport);
    qaCheck('theme-color 存在', !!mobile.themeColor, mobile.themeColor);
    await applyMode(client, 'light', false);
    const lightThemeColor = await evaluate(client, "(function(){ var m = document.querySelector('meta[name=theme-color]'); return m ? m.getAttribute('content') : null; })()");
    await applyMode(client, 'dark', false);
    qaCheck('theme-color 随主题切换', lightThemeColor && lightThemeColor !== mobile.themeColor, JSON.stringify({ dark: mobile.themeColor, light: lightThemeColor }));
    qaCheck('触控目标 ≥28px', mobile.smallTargets.length === 0, JSON.stringify(mobile.smallTargets));
    await setViewport(client, 1440, 900, false);
}

async function runQaExtras(client) {
    const extras = [];
    // ---- todo：详情打开/关闭、回收站、热区、侧栏收起/hover ----
    await setViewport(client, 1440, 900, false);
    await navigate(client, URL_NTOOLS);
    await seedQaData(client);
    await client.send('Page.reload', { ignoreCache: true });
    await sleep(2500);
    await applyMode(client, 'dark', false);
    await clickTab(client, 'todo');
    await shot(client, 'todo-heat-dark-std-1440.png');
    await applyMode(client, 'light', false);
    await shot(client, 'todo-heat-light-std-1440.png');
    await applyMode(client, 'dark', false);

    const detailOpened = await openTodoDetail(client);
    await sleep(500);
    await shot(client, 'todo-detail-open-dark-std-1440.png');
    await applyMode(client, 'light', false);
    await shot(client, 'todo-detail-open-light-std-1440.png');
    await applyMode(client, 'dark', false);
    await closeTodoDetail(client);
    await shot(client, 'todo-detail-closed-dark-std-1440.png');

    await evaluate(client, "(function(){ NC.store.todo.setView('trash'); return true; })()");
    await sleep(600);
    await shot(client, 'todo-trash-dark-std-1440.png');
    await applyMode(client, 'light', false);
    await shot(client, 'todo-trash-light-std-1440.png');
    await applyMode(client, 'dark', false);
    const trashInfo = await evaluate(client, `(function(){
        function visible(sel){ return Array.prototype.filter.call(document.querySelectorAll(sel), function(el){ return el.offsetParent !== null && el.getBoundingClientRect().width > 0; }).length; }
        var rows = document.querySelectorAll('.todo-item.is-trash');
        var clear = document.getElementById('todo-trash-clear');
        return {
            rows: rows.length,
            restoreVisible: visible('.todo-item.is-trash [data-act="restore"]'),
            purgeVisible: visible('.todo-item.is-trash [data-act="purge"]'),
            editVisible: visible('.todo-item.is-trash [data-act="edit"]'),
            pinVisible: visible('.todo-item.is-trash [data-act="pin"]'),
            clearVisible: !!clear && !clear.hidden
        };
    })()`);
    extras.push({ name: '回收站行操作/清空按钮', value: trashInfo });
    await setViewport(client, 390, 844, true);
    await sleep(500);
    await shot(client, 'todo-trash-dark-std-390.png');
    await setViewport(client, 1440, 900, false);
    await evaluate(client, "(function(){ NC.store.todo.setView('all'); return true; })()");
    await sleep(400);

    // 侧栏收起（logo 正常 / hover 展开按钮）
    await evaluate(client, "(function(){ var b = document.getElementById('rail-toggle-btn'); if (b) b.click(); return true; })()");
    await sleep(600);
    await shot(client, 'todo-rail-collapsed-dark-std-1440.png');
    const brandRect = await evaluate(client, "(function(){ var el = document.querySelector('.tools-rail__brand'); var r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()");
    const toggleBefore = await evaluate(client, "(function(){ var el = document.querySelector('.tools-rail__toggle'); return el ? getComputedStyle(el).opacity : null; })()");
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brandRect.x, y: brandRect.y });
    await sleep(400);
    const toggleAfter = await evaluate(client, "(function(){ var el = document.querySelector('.tools-rail__toggle'); return el ? getComputedStyle(el).opacity : null; })()");
    await shot(client, 'todo-rail-hover-dark-std-1440.png');
    const railInfo = await evaluate(client, `(function(){
        var app = document.querySelector('.tools-app');
        var rail = document.querySelector('.tools-rail');
        var toggle = document.querySelector('.tools-rail__toggle');
        return { collapsed: app.classList.contains('is-rail-collapsed'), railWidth: Math.round(rail.getBoundingClientRect().width), toggleOpacity: toggle ? getComputedStyle(toggle).opacity : null, toggleBeforeHover: ${JSON.stringify(null)} };
    })()`);
    railInfo.toggleOpacityBeforeHover = toggleBefore;
    railInfo.toggleOpacityAfterHover = toggleAfter;
    extras.push({ name: '侧栏收起态', value: railInfo });
    qaCheck('侧栏收起态 · 宽度 68px', railInfo.collapsed && railInfo.railWidth <= 72, JSON.stringify(railInfo));
    qaCheck('侧栏 logo hover 显现展开按钮', parseFloat(toggleBefore) < parseFloat(toggleAfter) || parseFloat(toggleAfter) > 0.9, JSON.stringify({ before: toggleBefore, after: toggleAfter }));
    await evaluate(client, "(function(){ var b = document.getElementById('rail-toggle-btn'); if (b) b.click(); return true; })()");
    await sleep(500);

    // ---- chat：welcome / messages / 端点下拉（focus） / legacy ----
    await evaluate(client, "(function(){ localStorage.removeItem('nchat-conversation.v2'); return true; })()");
    await client.send('Page.reload', { ignoreCache: true });
    await sleep(2600);
    await clickTab(client, 'nchat');
    await applyMode(client, 'dark', false);
    await shot(client, 'chat-welcome-dark-std-1440.png');
    await applyMode(client, 'light', false);
    await shot(client, 'chat-welcome-light-std-1440.png');
    await applyMode(client, 'lite', false);
    await shot(client, 'chat-welcome-lite-1440.png');
    await applyMode(client, 'dark', false);

    // messages + endpoint focus
    await seedQaData(client);
    await client.send('Page.reload', { ignoreCache: true });
    await sleep(2600);
    await clickTab(client, 'nchat');
    await shot(client, 'chat-toast-overlap-dark-std-1440.png', { keepToast: true });
    await shot(client, 'chat-messages-dark-std-1440.png');
    await evaluate(client, "(function(){ var s = document.getElementById('chat-profile-select'); if (s) { s.focus(); } return true; })()");
    await sleep(300);
    await shot(client, 'chat-endpoint-focus-dark-std-1440.png');
    await setViewport(client, 390, 844, true);
    await sleep(500);
    await shot(client, 'chat-endpoint-390.png');
    await setViewport(client, 1440, 900, false);

    // legacy 端点合并后：聊天工具栏 + 设置面板模型列表
    await seedLegacyData(client);
    await client.send('Page.reload', { ignoreCache: true });
    await sleep(2800);
    await clickTab(client, 'nchat');
    const legacyInfo = await evaluate(client, `(function(){
        var sel = document.getElementById('chat-profile-select');
        var options = sel ? Array.prototype.map.call(sel.options, function(o){ return { value: o.value, text: o.textContent }; }) : [];
        var current = sel ? sel.value : null;
        var meta = (document.getElementById('chat-profile-meta') || {}).textContent || '';
        return { options: options, current: current, meta: meta, count: options.length };
    })()`);
    extras.push({ name: 'chat legacy 端点', value: legacyInfo });
    await shot(client, 'chat-legacy-endpoints-dark-std-1440.png');
    await applyMode(client, 'light', false);
    await shot(client, 'chat-legacy-endpoints-light-std-1440.png');
    await applyMode(client, 'dark', false);
    await openSettings(client, 'profiles');
    await shot(client, 'settings-models-legacy-dark-std-1440.png');
    await closeSettings(client);

    QA.extras = extras;
    return extras;
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


async function runQa(client) {
    console.log('== QA 模式：全页面矩阵截图 ==');
    await runQaMatrix(client);
    console.log('== QA 模式：状态截图（todo/chat） ==');
    await runQaExtras(client);

    console.log('== QA 模式：设计自检 ==');
    await setViewport(client, 1440, 900, false);
    await navigate(client, URL_NTOOLS);
    await seedQaData(client);
    await client.send('Page.reload', { ignoreCache: true });
    await sleep(2600);
    await applyMode(client, 'dark', false);
    await clickTab(client, 'todo');
    await qaRunAlignmentAndContrast(client, 'todo');
    await qaCheckLite(client);
    await clickTab(client, 'todo');
    await qaCheckFocus(client);
    await qaCheckHover(client);
    await qaCheckStickyFooter(client);
    await qaCheckOverflow(client);
    await qaCheckMobile(client);

    // 浅色对比度（同一 todo 页）
    await applyMode(client, 'light', false);
    await clickTab(client, 'todo');
    await qaRunAlignmentAndContrast(client, 'todo');

    // 工具页页头（标题/操作区）对齐
    await applyMode(client, 'dark', false);
    for (const tab of ['qr', 'md', 'image']) {
        await clickTab(client, tab);
        await qaRunAlignmentOnly(client, tab);
    }

    // chat 域对齐/对比度 + 深/浅
    await applyMode(client, 'dark', false);
    await clickTab(client, 'nchat');
    await qaRunAlignmentAndContrast(client, 'nchat');
    await applyMode(client, 'light', false);
    await qaRunAlignmentAndContrast(client, 'nchat');
    await applyMode(client, 'dark', false);

    QA.viewports = [1440, 1024, 390];
    QA.finishedAt = new Date().toISOString();
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

        if (MODE === 'qa') {
            await runQa(client);
            fs.mkdirSync(OUT, { recursive: true });
            fs.writeFileSync(path.join(OUT, 'manifest.txt'), manifest.join('\n') + '\n');
            fs.writeFileSync(path.join(OUT, 'qa-report.json'), JSON.stringify(QA, null, 2));
            try { ws.close(); } catch (err) { /* ignore */ }
            console.log('QA 截图 ' + manifest.filter((line) => !/\tSKIP/.test(line)).length + ' 张；自检 ' + QA.checks.length + ' 项（失败 ' + QA.issues.length + '）→ ' + OUT);
            process.exit(0);
        }
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
if [ "${NC_SHOT_MODE:-design}" = "qa" ]; then
    echo "模式: QA（v4.5 设计复检截图 + 自检）"
else
    echo "场景: ${NC_SHOT_SCENARIOS:-todo,chat,settings-models,settings-todo-ai,ai-dialog,command-palette}"
fi
NC_CHROME="$CHROME" NC_ROOT="$ROOT" NC_OUT="$OUT" NC_SHOT_MODE="${NC_SHOT_MODE:-design}" node "$TMP_DIR/driver.js"
status=$?
echo "--------------------------------------------"
if [ "$status" -ne 0 ]; then
    echo "截图失败（v4 依赖可能尚未就位）" >&2
    exit "$status"
fi
echo "完成 → $OUT"
exit 0
