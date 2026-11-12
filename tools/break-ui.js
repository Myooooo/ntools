#!/usr/bin/env node
/**
 * tools/break-ui.js — v4 最坏数据 / 响应式 / 移动端原生 审计（只读，不改业务代码）
 *
 * 做什么：
 *  1. 用 CDP 打开 ntools.html，通过 localStorage 注入"最坏但可信"的数据：
 *     超长任务标题、无空格长 URL、20 个标签、长清单名、长端点名/Base URL、500 条列表、
 *     长聊天代码块/无空格长串。
 *  2. 在 1440 / 1024 / 768 / 320 宽 + 根字号 200%（模拟放大 200%）下巡检：
 *     - document.scrollWidth > clientWidth（页面横向溢出）
 *     - 元素越出视口 / 内容被 overflow 裁切且无省略号
 *     - 操作按钮被裁切/推走（不可达）
 *     - 列表行高被撑破、tag chips 撑高
 *  3. 移动端原生检查（代码 + 计算样式）：viewport-fit / theme-color / tap-highlight /
 *     overscroll / touch-action / 粗指针输入 16px / hover 门控 / safe-area / 100dvh。
 *  4. 输出问题表 + /tmp/nc-shots/v4/break/ 截图 + report.json/md。
 *
 * 用法：node tools/break-ui.js [--verbose]
 * 退出码：0 = 巡检执行完成（发现问题不影响退出码，审计工具）；2 = 环境/启动失败。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.BREAK_OUT || '/tmp/nc-shots/v4/break';
const PORT = 9600 + (process.pid % 180);
const VERBOSE = process.argv.indexOf('--verbose') > -1;
const URL_NTOOLS = 'file://' + path.join(ROOT, 'ntools.html').split(path.sep).join('/');
const VIEWPORTS = [
    { width: 1440, height: 900, label: '1440' },
    { width: 1024, height: 768, label: '1024' },
    { width: 768, height: 900, label: '768' },
    { width: 320, height: 740, label: '320' }
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 最坏但可信的数据
 * ------------------------------------------------------------------ */
const LONG_TITLE = '与华东区域三家供应商确认第四季度交付排期，并同步采购、法务、财务三个部门的审批节点与应急预案（含备选供应商与到货缓冲）';
const LONG_LIST_NAME = '华东区生产环境与灾备切换演练（2026 年第四季度）专项清单';
const LONG_URL = 'https://intranet.northwind-industries-holdings.example.com/portal/knowledge-base/operations/2026-q4/supplier-onboarding-and-compliance-checklists';
const LONG_TOKEN = 'SUPPLIER-ONBOARDING-CHECKLIST-2026Q4-REVISION-FINAL-APPROVED-BY-LEGAL-AND-FINANCE-DEPARTMENT';
const TAGS_20 = ['采购', '法务', '财务', '交付', '供应商', '审批', '例会', '季度', '预算', '合同',
    '风控', '合规', '审计', '培训', '招聘', '文档', '复盘', 'Q4', '紧急', '华东'];
const LONG_PROFILE_NAME = '华东区生产环境 · OpenAI 兼容网关（备用线路 / 灾备）';
const LONG_BASE_URL = 'https://llm-gateway.prod.northwind-industries-holdings.example.com/openai-compatible/v1';

function buildTodoDoc() {
    const now = Date.now();
    const lists = [
        { id: 'list_default', name: '待办', color: '#6EA8FE', order: 0, archived: false, createdAt: now, updatedAt: now },
        { id: 'list_long', name: LONG_LIST_NAME, color: '#D8B06A', order: 1, archived: false, createdAt: now, updatedAt: now },
        { id: 'list_one', name: 'J', color: '#45D6A0', order: 2, archived: false, createdAt: now, updatedAt: now }
    ];
    const tasks = [];
    const push = (task) => tasks.push(Object.assign({
        id: 'break-' + tasks.length,
        listId: 'list_default',
        title: '任务 ' + tasks.length,
        notes: '',
        status: 'open',
        priority: 'normal',
        due: null,
        dueAllDay: false,
        tags: [],
        subtasks: [],
        recurrence: null,
        reminder: null,
        order: tasks.length * 1024,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        deletedAt: null,
        source: 'break-ui'
    }, task));

    // 1) 超长中文标题（可信：真实会议排期）
    push({ title: LONG_TITLE, priority: 'high', due: now + 3 * 3600000, listId: 'list_long' });
    // 2) 无空格长 URL + 无空格长 token（备注）
    push({
        title: '核对供应商合规清单链接',
        notes: '参考链接：' + LONG_URL + '\n工单编号：' + LONG_TOKEN,
        tags: ['文档', '合规'],
        priority: 'urgent',
        due: now + 86400000
    });
    // 3) 20 个标签
    push({ title: '季度供应商例会材料准备', tags: TAGS_20.slice(), listId: 'list_long' });
    // 4) 混合语言 + emoji + 长姓名
    push({
        title: 'Aleksandra Wiśniewska-Kowalczyk 与张伟确认越南、泰国交付风险复盘 😀😀',
        tags: ['复盘', '风险'],
        notes: 'Emoji 与越南语/泰语混排：Nguyễn Thị Hồng / กิตติพงษ์ / 😀😀😀',
        due: now + 5 * 86400000
    });
    // 5) 单字母标题（空态/最小数据）
    push({ title: 'Jo', listId: 'list_one' });
    // 6) 已完成 / 逾期（用于时间列与颜色语义）
    push({ title: '提交上周周报', status: 'done', completedAt: now - 3600000, due: now - 86400000 });
    push({ title: '处理逾期安全巡检整改', priority: 'urgent', due: now - 2 * 3600000 });
    // 7) 500 条总量：其余用真实感标题填充（含少量长标题、长标签）
    const fillers = ['同步周会纪要', '更新知识库文档', '确认设备到货时间', '整理审计材料', '跟进合同用印流程',
        '核对预算执行情况', '准备季度复盘会', '回复供应商邮件', '检查账号权限', '更新排班表'];
    while (tasks.length < 500) {
        const index = tasks.length;
        push({
            title: fillers[index % fillers.length] + '（' + (index + 1) + '）',
            tags: index % 7 === 0 ? TAGS_20.slice(0, 6) : (index % 3 === 0 ? ['工作'] : []),
            status: index % 11 === 0 ? 'done' : 'open',
            priority: index % 7 === 0 ? 'high' : 'normal',
            due: index % 5 === 0 ? now + index * 3600000 : null,
            listId: index % 9 === 0 ? 'list_long' : 'list_default'
        });
    }
    return {
        schemaVersion: 2,
        revision: 1,
        updatedAt: now,
        lists: lists,
        tasks: tasks,
        settings: {
            defaultListId: 'list_default',
            view: 'all',
            sort: 'smart',
            showCompleted: true,
            reminderLeadMinutes: 15,
            compact: false
        },
        meta: { app: 'nTools', appVersion: '4.0.0', migratedFrom: null, migratedAt: null, quarantine: [] }
    };
}

function buildLlmDoc() {
    const now = Date.now();
    return {
        version: 1,
        profiles: [{
            id: 'p-break-1',
            name: LONG_PROFILE_NAME,
            baseUrl: LONG_BASE_URL,
            apiKey: 'sk-' + LONG_TOKEN,
            modelId: 'gpt-4o-compatible-internal-2026-q4',
            chatSystemPrompt: '你是一个简洁、专业的中文助手。' + '回答控制在三句话以内。'.repeat(6),
            temperature: 1,
            topP: 0.95,
            createdAt: now,
            updatedAt: now
        }, {
            id: 'p-break-2',
            name: '内网备用节点',
            baseUrl: 'https://backup.example.internal/v1',
            apiKey: 'sk-backup',
            modelId: 'backup-model',
            chatSystemPrompt: '',
            temperature: 0.7,
            topP: 0.9,
            createdAt: now,
            updatedAt: now
        }],
        currentProfileId: 'p-break-1',
        todoAi: { profileId: null, systemPrompt: '测试提示 {{NOW}}', temperature: 0.2, topP: 0.9 },
        workEndTime: '17:30',
        updatedAt: now
    };
}

function buildConversationDoc() {
    const now = Date.now();
    const codeBlock = Array.from({ length: 14 }, (_, i) => '    const row' + i + ' = buildRow({ id: "supplier-' + i + '", name: "华东供应链节点 ' + i + '" });').join('\n');
    return {
        version: 2,
        sessions: {
            'p-break-1': {
                updatedAt: now,
                messages: [
                    {
                        id: 'm-user-1', role: 'user', createdAt: now - 5000,
                        content: [{ type: 'text', text: '帮我检查这段 SSE 解析代码，并给出一个不用正则的替代实现；顺便说明 ' + LONG_URL + ' 这个链接里的清单是否适用。' }]
                    },
                    {
                        id: 'm-assistant-1', role: 'assistant', createdAt: now - 4000,
                        content: '下面是一个逐行状态机实现（节选）：\n\n```js\n' + codeBlock + '\n```\n\n' +
                            '另外注意无空格长串：' + LONG_TOKEN + LONG_TOKEN.slice(0, 60) + '\n\n' +
                            '以及一大段满宽中文用于测试行宽与换行：' + '这是一段很长的中文说明，用于验证聊天正文在窄屏与 200% 缩放下的换行行为是否正常，不允许出现横向滚动。'.repeat(3) + ' 😀😀',
                        reasoning: '先确认 SSE 的 CRLF、多行 data 与跨 chunk 边界，再给出状态机实现。'
                    },
                    {
                        id: 'm-user-2', role: 'user', createdAt: now - 3000,
                        content: [{ type: 'text', text: '第二个问题：' + LONG_TOKEN }]
                    },
                    {
                        id: 'm-assistant-2', role: 'assistant', createdAt: now - 2000,
                        content: '收到。' + '这是一条用于测试密集消息列表的长回复。'.repeat(8)
                    }
                ]
            }
        }
    };
}

/* ------------------------------------------------------------------ *
 * CDP
 * ------------------------------------------------------------------ */
class Client {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.handlers = [];
        this.consoleErrors = [];
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
                this.consoleErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' ').slice(0, 300));
            }
            if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                this.consoleErrors.push('exception: ' + ((details.exception && details.exception.description) || details.text || '').slice(0, 300));
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
            }, 30000);
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
    return client;
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
        throw new Error('evaluate failed: ' + ((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text));
    }
    return result.result.value;
}

async function waitFor(client, expression, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 8000)) {
        try { if (await evaluate(client, expression)) return true; } catch (err) { /* retry */ }
        await sleep(120);
    }
    return false;
}

async function navigate(client, url) {
    const loaded = new Promise((resolve) => {
        const handler = (message) => {
            if (message.method !== 'Page.loadEventFired') return;
            client.handlers = client.handlers.filter((item) => item !== handler);
            resolve();
        };
        client.handlers.push(handler);
        setTimeout(resolve, 20000);
    });
    await client.send('Page.navigate', { url });
    await loaded;
    await waitFor(client, "typeof window.NC !== 'undefined'", 10000);
    await sleep(400);
}

async function setMetrics(client, width, height, mobile) {
    await client.send('Emulation.setDeviceMetricsOverride', {
        width: width, height: height, deviceScaleFactor: 1, mobile: !!mobile,
        screenWidth: width, screenHeight: height
    });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 });
    await sleep(250);
}

async function setRootScale(client, percent) {
    // 用根字号模拟 200% 放大（字体变大、盒子不随之变大，正是 break-ui 想测的场景）
    await evaluate(client, `(function(){
        if (${percent} === 100) document.documentElement.style.removeProperty('font-size');
        else document.documentElement.style.fontSize = '${percent}%';
        window.scrollTo(0, 0);
        return true;
    })()`);
    await sleep(350);
}

async function shot(client, name) {
    const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(OUT_DIR, { recursive: true }); // 并发清理 /tmp 时自愈
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
}

/* ------------------------------------------------------------------ *
 * 页面内巡检（返回结构化问题）
 * ------------------------------------------------------------------ */
const MEASURE_FN = `(function(options){
    var opts = options || {};
    var vw = window.innerWidth, vh = window.innerHeight;
    var scope = opts.scope ? document.querySelector(opts.scope) : document.body;
    if (!scope) return { missing: true };
    function visible(el) {
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (!el.offsetParent && cs.position !== 'fixed' && cs.position !== 'absolute') return false;
        return true;
    }
    function scrollableAncestor(el) {
        var p = el.parentElement;
        while (p && p !== document.body) {
            var cs = getComputedStyle(p);
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return p;
            p = p.parentElement;
        }
        return null;
    }
    function isIntentionalOffscreen(el) {
        var selfCs = getComputedStyle(el);
        if (selfCs.display === 'none' || selfCs.visibility === 'hidden') return true;
        if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true;
        if (selfCs.position === 'fixed' || selfCs.position === 'absolute' || selfCs.transform !== 'none') {
            var selfRect = el.getBoundingClientRect();
            if (selfRect.width > 0 && (selfRect.right <= 1 || selfRect.left >= window.innerWidth - 1)) return true;
        }
        var p = el.parentElement;
        while (p && p !== document.body) {
            var cs = getComputedStyle(p);
            if (cs.display === 'none' || cs.visibility === 'hidden') return true;
            if (p.getAttribute('aria-hidden') === 'true' || p.hasAttribute('hidden')) return true;
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true;
            if (cs.position === 'fixed' || cs.position === 'absolute' || cs.transform !== 'none') {
                var rect = p.getBoundingClientRect();
                if (rect.width > 0 && (rect.right <= 1 || rect.left >= window.innerWidth - 1)) return true;
            }
            p = p.parentElement;
        }
        return false;
    }
    function describe(el) {
        var cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        var text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 42);
        return el.tagName.toLowerCase() + cls + (el.id ? '#' + el.id : '') + (text ? ' | ' + text : '');
    }
    var docRoot = document.documentElement;
    var docOverflow = docRoot.scrollWidth - docRoot.clientWidth;
    var offscreen = [], clipped = [], texts = [], tallRows = [], tagsOverflow = [], layoutOverflow = [];
    var seen = Object.create(null);
    function add(bucket, item) {
        var key = item.type + '|' + item.element + '|' + (item.text || '');
        if (seen[key]) return;
        seen[key] = true;
        if (bucket.length < 10) bucket.push(item);
    }
    // 1) 已知文本节点：是否越出视口 / 被裁切且无省略 / nowrap 溢出
    (opts.textSelectors || []).forEach(function(selector) {
        var nodes = scope.querySelectorAll(selector);
        for (var i = 0; i < nodes.length && texts.length < 10; i++) {
            var el = nodes[i];
            if (!visible(el)) continue;
            if (isIntentionalOffscreen(el)) continue;
            var cs = getComputedStyle(el);
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
            var rect = el.getBoundingClientRect();
            var sw = el.scrollWidth, cw = el.clientWidth;
            var over = sw > cw + 1;
            var outside = rect.right > vw + 1 || rect.left < -1;
            var ellipsis = /ellipsis/.test(cs.textOverflow || '');
            var hidesX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
            var hasTitle = !!(el.getAttribute('title') || el.getAttribute('aria-label'));
            if (outside) {
                add(texts, { type: 'text-outside-viewport', element: describe(el), sw: sw, cw: cw, text: (el.textContent || '').trim().slice(0, 80), title: hasTitle });
            } else if (over && !ellipsis && !scrollableAncestor(el)) {
                add(texts, { type: hidesX ? 'text-clipped' : 'text-overflow', element: describe(el), sw: sw, cw: cw, text: (el.textContent || '').trim().slice(0, 80), title: hasTitle });
            } else if (over && ellipsis && !hasTitle) {
                add(texts, { type: 'truncated-without-title', element: describe(el), sw: sw, cw: cw, text: (el.textContent || '').trim().slice(0, 80), title: false });
            }
        }
    });
    // 2) 区块越出视口（跳过横向可滚动容器 —— 那是预期交互）
    var blocks = scope.querySelectorAll('div, section, aside, nav, main, ul, li, button, a, h1, h2, h3');
    for (var b = 0; b < blocks.length && offscreen.length < 8; b++) {
        var block = blocks[b];
        if (!visible(block)) continue;
        if (isIntentionalOffscreen(block)) continue;
        var br = block.getBoundingClientRect();
        if (br.right > vw + 1 || br.left < -1) {
            if (scrollableAncestor(block)) continue;
            add(offscreen, { type: 'viewport-overflow', element: describe(block), overflow: Math.round(br.right - vw) });
        }
    }
    // 3) 操作按钮不可达 / 被祖先裁切
    var actions = scope.querySelectorAll('button, [role="button"], a[href]');
    for (var a = 0; a < actions.length && clipped.length < 8; a++) {
        var action = actions[a];
        if (!visible(action)) continue;
        if (isIntentionalOffscreen(action) || scrollableAncestor(action)) continue;
        var ar = action.getBoundingClientRect();
        if (ar.right > vw + 1 || ar.left < -1) {
            add(clipped, { type: 'action-unreachable', element: describe(action), reason: 'outside-viewport' });
            continue;
        }
        var actionCs = getComputedStyle(action);
        var floating = actionCs.position === 'absolute' || actionCs.position === 'fixed';
        var anc = action.parentElement;
        while (anc && anc !== document.body) {
            var acs = getComputedStyle(anc);
            var clipX = acs.overflowX === 'hidden' || acs.overflowX === 'clip' || acs.overflow === 'hidden';
            if (clipX && !scrollableAncestor(anc)) {
                var cr = anc.getBoundingClientRect();
                if (ar.right > cr.right + 1 || ar.left < cr.left - 1) {
                    // 浮动控件（absolute/fixed）在视口内时允许贴边/跨层：真正的错误是越出视口，前面已检查
                    if (!floating) {
                        add(clipped, { type: 'action-clipped', element: describe(action), reason: 'clipped-by-ancestor', ancestor: describe(anc) });
                    }
                }
                break;
            }
            if (scrollableAncestor(anc)) break;
            anc = anc.parentElement;
        }
    }
    // 4) 列表行高
    var rowSelector = opts.rowSelector || '.todo-item';
    var rows = scope.querySelectorAll(rowSelector);
    var heights = [];
    for (var r = 0; r < Math.min(rows.length, 80); r++) {
        var rh = rows[r].getBoundingClientRect().height;
        if (rh > 0) heights.push(rh);
    }
    heights.sort(function(x, y) { return x - y; });
    var median = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
    var maxHeight = heights.length ? heights[heights.length - 1] : 0;
    for (var r2 = 0; r2 < Math.min(rows.length, 80) && tallRows.length < 8; r2++) {
        if (isIntentionalOffscreen(rows[r2])) continue;
        var th = rows[r2].getBoundingClientRect().height;
        if (th > Math.max(88, median * 2.2)) {
            add(tallRows, { type: 'row-height', element: describe(rows[r2]), height: Math.round(th), median: Math.round(median) });
        }
    }
    // 5) 标签 chips 撑高 / 溢出
    var tagNodes = scope.querySelectorAll('.todo-item__tags, #todo-new-tags-chips, .todo-tag, .nc-chip');
    for (var t = 0; t < Math.min(tagNodes.length, 80) && tagsOverflow.length < 8; t++) {
        var te = tagNodes[t];
        if (!visible(te) || isIntentionalOffscreen(te)) continue;
        var tr = te.getBoundingClientRect();
        var tsx = te.scrollWidth - te.clientWidth;
        if (tsx > 2 || tr.height > 30) {
            add(tagsOverflow, { type: 'tags-overflow', element: describe(te), sw: te.scrollWidth, cw: te.clientWidth, height: Math.round(tr.height) });
        }
    }
    // 6) 布局容器被撑破
    var gridNodes = scope.querySelectorAll('.todo-main, .todo-layout, .chat-main, .settings-sheet__layout, .sp-profile__main, .todo-view-item, .todo-views__scroll');
    for (var g = 0; g < gridNodes.length && layoutOverflow.length < 8; g++) {
        var ge = gridNodes[g];
        if (!visible(ge) || scrollableAncestor(ge) || isIntentionalOffscreen(ge)) continue;
        var gcs = getComputedStyle(ge);
        if (gcs.overflowX === 'auto' || gcs.overflowX === 'scroll') continue;
        if (ge.scrollWidth > ge.clientWidth + 2) {
            add(layoutOverflow, { type: 'layout-overflow', element: describe(ge), sw: ge.scrollWidth, cw: ge.clientWidth });
        }
    }
    return {
        vw: vw, vh: vh, missing: false,
        docOverflow: docOverflow,
        rows: { count: rows.length, median: Math.round(median), max: Math.round(maxHeight) },
        offscreen: offscreen, clipped: clipped, texts: texts,
        tallRows: tallRows, tagsOverflow: tagsOverflow, layoutOverflow: layoutOverflow
    };
})`;

async function measure(client, options) {
    return evaluate(client, MEASURE_FN + '(' + JSON.stringify(options || {}) + ')');
}

/* ------------------------------------------------------------------ *
 * 静态 CSS 扫描（hover 门控 + 移动端规则）
 * ------------------------------------------------------------------ */
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function analyzeCssFile(file) {
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'css', file), 'utf8'));
    const lines = css.split('\n');
    const stack = [];
    let hoverGated = 0;
    let hoverUngated = 0;
    const ungatedSamples = [];
    const gatedSamples = [];
    let hasTapHighlight = false;
    let hasOverscroll = false;
    let hasTouchAction = false;
    let hasCoarseInput = false;
    let safeAreaCount = 0;
    let dvhCount = 0;
    let vhCount = 0;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (/-webkit-tap-highlight-color\s*:\s*transparent/.test(line)) hasTapHighlight = true;
        if (/overscroll-behavior/.test(line)) hasOverscroll = true;
        if (/touch-action\s*:/.test(line)) hasTouchAction = true;
        if (/env\(safe-area-inset/.test(line)) safeAreaCount += 1;
        if (/\b100dvh\b/.test(line)) dvhCount += 1;
        if (/\b100vh\b/.test(line) && !/100dvh/.test(line)) vhCount += 1;
        if (/@media[^{]*\(pointer\s*:\s*coarse\)/.test(line) && /input|textarea|select/.test(lines.slice(index, index + 6).join(' '))) {
            hasCoarseInput = true;
        }

        const openIndex = line.indexOf('{');
        if (openIndex > -1) {
            const prelude = line.slice(0, openIndex).trim();
            const media = /^@media/.test(prelude);
            const hoverGate = /\(hover\s*:\s*hover\)/.test(prelude) && /\(pointer\s*:\s*fine\)/.test(prelude);
            const selectorHover = /:hover/.test(prelude) && !/scrollbar/.test(prelude);
            if (selectorHover) {
                const gated = stack.some((item) => item.hoverGate);
                if (gated) { hoverGated += 1; if (gatedSamples.length < 3) gatedSamples.push(index + 1); }
                else { hoverUngated += 1; if (ungatedSamples.length < 8) ungatedSamples.push(index + 1 + ': ' + prelude.slice(0, 70)); }
            }
            stack.push({ media: media, hoverGate: hoverGate });
        }
        let closes = (line.match(/\}/g) || []).length;
        while (closes-- > 0 && stack.length) stack.pop();
    }
    return {
        file: file,
        hoverGated: hoverGated,
        hoverUngated: hoverUngated,
        ungatedSamples: ungatedSamples,
        hasTapHighlight: hasTapHighlight,
        hasOverscroll: hasOverscroll,
        hasTouchAction: hasTouchAction,
        hasCoarseInput: hasCoarseInput,
        safeAreaCount: safeAreaCount,
        dvhCount: dvhCount,
        vhCount: vhCount
    };
}

function scanCss() {
    const files = fs.readdirSync(path.join(ROOT, 'css')).filter((name) => /\.css$/.test(name));
    return files.map(analyzeCssFile);
}

/* ------------------------------------------------------------------ *
 * 移动端原生检查
 * ------------------------------------------------------------------ */
async function mobileChecks(client, cssReport) {
    const checks = [];
    const push = (name, status, detail) => checks.push({ name, status, detail });

    // 切到手机视口 + 触摸
    await setMetrics(client, 390, 844, true);
    await navigate(client, URL_NTOOLS);
    await waitFor(client, "!!window.NC && !!document.querySelector('.todo-item')", 12000);
    await sleep(600);

    const env = await evaluate(client, `(function(){
        var viewport = document.querySelector('meta[name="viewport"]');
        var themeMeta = document.querySelector('meta[name="theme-color"]');
        var colorScheme = document.querySelector('meta[name="color-scheme"]');
        var root = getComputedStyle(document.documentElement);
        var body = getComputedStyle(document.body);
        function fs(sel) { var el = document.querySelector(sel); return el ? getComputedStyle(el).fontSize : null; }
        function touch(sel) { var el = document.querySelector(sel); return el ? getComputedStyle(el).touchAction : null; }
        function tap() { var el = document.querySelector('button, .nc-btn'); return el ? getComputedStyle(el).webkitTapHighlightColor : null; }
        return {
            viewport: viewport ? viewport.getAttribute('content') : '',
            themeColor: themeMeta ? themeMeta.getAttribute('content') : null,
            themeColorMedia: themeMeta ? themeMeta.getAttribute('media') : null,
            colorScheme: colorScheme ? colorScheme.getAttribute('content') : null,
            htmlTapHighlight: root.webkitTapHighlightColor,
            buttonTapHighlight: tap(),
            htmlOverscroll: root.overscrollBehavior,
            bodyOverscroll: body.overscrollBehavior,
            htmlTouchAction: root.touchAction,
            sendTouchAction: touch('#send-btn'),
            todoSubmitTouchAction: touch('#todo-new-submit'),
            inputFont: fs('#todo-new-title'),
            chatInputFont: fs('#user-input'),
            textareaFont: fs('#md-input'),
            appHeight: Math.round((document.querySelector('.tools-app') || document.body).getBoundingClientRect().height),
            innerHeight: window.innerHeight,
            supportsDvh: !!(window.CSS && CSS.supports && CSS.supports('height', '100dvh')),
            coarse: !!(window.matchMedia && matchMedia('(pointer: coarse)').matches),
            hoverNone: !!(window.matchMedia && matchMedia('(hover: none)').matches),
            safeAreaSupported: !!(window.CSS && CSS.supports && CSS.supports('padding', 'env(safe-area-inset-bottom)')),
            userScalableNo: viewport ? /user-scalable\\s*=\\s*no|maximum-scale\\s*=\\s*1/.test(viewport.getAttribute('content')) : false
        };
    })()`);

    const viewportOk = /viewport-fit\s*=\s*cover/.test(env.viewport) && /width=device-width/.test(env.viewport) && !env.userScalableNo;
    push('viewport-fit / 禁止缩放检查', viewportOk ? 'pass' : 'fail', env.viewport);
    push('interactive-widget=resizes-content', /interactive-widget\s*=\s*resizes-content/.test(env.viewport) ? 'pass' : 'warn', env.viewport);
    push('color-scheme 声明', /dark/.test(env.colorScheme || '') && /light/.test(env.colorScheme || '') ? 'pass' : 'warn', env.colorScheme);
    const themeOk = !!env.themeColor;
    const beforeTheme = env.themeColor;
    const themeSwitch = await evaluate(client, `(function(){
        var before = (document.querySelector('meta[name="theme-color"]') || {}).content;
        if (window.NC && NC.theme && NC.theme.toggle) NC.theme.toggle();
        var after = (document.querySelector('meta[name="theme-color"]') || {}).content;
        return { before: before, after: after, theme: document.documentElement.getAttribute('data-theme') };
    })()`);
    push('theme-color 随主题切换', themeOk && themeSwitch.before !== themeSwitch.after ? 'pass' : (themeOk ? 'warn' : 'fail'),
        JSON.stringify(themeSwitch));
    await evaluate(client, `(function(){ if (window.NC && NC.theme && NC.theme.set) NC.theme.set('dark'); return true; })()`);

    push('tap-highlight 透明', /rgba\(0, 0, 0, 0\)|transparent/.test(String(env.htmlTapHighlight)) ? 'pass' : 'warn', String(env.htmlTapHighlight));
    push('overscroll-behavior 关闭（html/body）', env.htmlOverscroll === 'none' && env.bodyOverscroll === 'none' ? 'pass' : 'fail',
        'html=' + env.htmlOverscroll + ' body=' + env.bodyOverscroll);
    push('touch-action: manipulation（按钮）', env.sendTouchAction === 'manipulation' || env.htmlTouchAction === 'manipulation' ? 'pass' : 'warn',
        'send=' + env.sendTouchAction + ' submit=' + env.todoSubmitTouchAction);
    const coarseInputOk = env.coarse && env.inputFont === '16px' && env.chatInputFont === '16px';
    push('粗指针下输入字号 ≥16px（防 iOS 聚焦缩放）', coarseInputOk ? 'pass' : (env.coarse ? 'fail' : 'warn'),
        JSON.stringify({ coarse: env.coarse, todo: env.inputFont, chat: env.chatInputFont, md: env.textareaFont }));
    push('hover/pointer 媒体查询生效', env.coarse && env.hoverNone ? 'pass' : 'warn', JSON.stringify({ coarse: env.coarse, hoverNone: env.hoverNone }));
    push('应用壳 100dvh 回退', env.supportsDvh ? 'pass' : 'warn', 'supportsDvh=' + env.supportsDvh + ' appHeight=' + env.appHeight + ' innerHeight=' + env.innerHeight);
    push('safe-area 支持 + 使用', env.safeAreaSupported ? 'pass' : 'warn', 'supports=' + env.safeAreaSupported + ' cssEnvRules=' + cssReport.reduce((sum, f) => sum + f.safeAreaCount, 0));

    // hover 门控（静态扫描）
    const ungated = cssReport.filter((f) => f.hoverUngated > 0);
    push(':hover 能力门控（@media (hover:hover) and (pointer:fine)）', ungated.length === 0 ? 'pass' : 'fail',
        ungated.length === 0
            ? '全部 ' + cssReport.reduce((sum, f) => sum + f.hoverGated, 0) + ' 条已门控'
            : ungated.map((f) => f.file + ':' + f.hoverUngated + ' 条（' + f.ungatedSamples.slice(0, 2).join('; ') + '）').join(' / '));

    // 触控目标（≥32px 建议值，仅样本）
    const tapTargets = await evaluate(client, `(function(){
        var nodes = document.querySelectorAll('#send-btn, #todo-new-submit, .tools-nav__item, #settings-btn, .todo-item__actions button');
        var small = [];
        for (var i = 0; i < nodes.length; i++) {
            var r = nodes[i].getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && (r.width < 32 || r.height < 32)) {
                small.push((nodes[i].className || nodes[i].id || nodes[i].tagName) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
            }
        }
        return small.slice(0, 8);
    })()`);
    push('触控目标 ≥32px（样本）', tapTargets.length === 0 ? 'pass' : 'warn', tapTargets.join(' / ') || 'ok');

    const consoleErrors = client.consoleErrors.slice(-5);
    push('移动端页面无 console.error', consoleErrors.length === 0 ? 'pass' : 'warn', consoleErrors.join(' | '));

    await setMetrics(client, 1440, 900, false);
    return { env, checks };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const SEVERITY_ORDER = { Broken: 0, Ugly: 1, Fragile: 2 };

function classifyIssue(item) {
    if (item.type === 'viewport-overflow' || item.type === 'action-unreachable' || item.type === 'action-clipped' ||
        item.type === 'layout-overflow' || item.type === 'text-outside-viewport') return 'Broken';
    if (item.type === 'text-clipped' || item.type === 'text-overflow' || item.type === 'row-height' || item.type === 'tags-overflow') return 'Ugly';
    return 'Fragile';
}

function issueFix(item) {
    switch (item.type) {
        case 'viewport-overflow':
            return '给文本列 min-width:0 / overflow-wrap:anywhere；固定尺寸元素 flex-shrink:0；窄屏断点降级单列';
        case 'text-outside-viewport':
            return '该文本容器加 min-width:0 + overflow-wrap:anywhere（或内部滚动），确保右侧操作区常驻';
        case 'text-clipped':
            return '被裁切文本：允许换行（overflow-wrap:anywhere）或 ellipsis + title/详情展示';
        case 'text-overflow':
            return 'nowrap 文本溢出：加 ellipsis + title，或允许换行；数字/时间保持 tabular-nums 且不截断';
        case 'truncated-without-title':
            return '省略号截断但无 title/aria-label：补 title 或详情入口，否则信息不可读';
        case 'action-unreachable':
        case 'action-clipped':
            return '中间弹性列 min-width:0，操作区 flex-shrink:0 且常驻；避免在 nowrap 行内塞长文本';
        case 'layout-overflow':
            return 'grid 用 minmax(0,1fr)；flex 行给 min-width:0；检查 320px 断点是否已降级';
        case 'row-height':
            return '限制标题行数（line-clamp:2）+ 行最小高度；标签折叠为 +N；详情进抽屉';
        case 'tags-overflow':
            return '标签容器 flex-wrap:wrap + 单标签 max-width + 省略号，超出折叠为 +N';
        default:
            return '按 design-direction-v4 §4 待验证清单处理';
    }
}

async function main() {
    if (!fs.existsSync(CHROME)) {
        console.error('Chrome not found: ' + CHROME + '\n可用 CHROME 环境变量指定。');
        process.exit(2);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const cssReport = scanCss();
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-break-ui-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
        '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    const issues = [];
    const shots = [];
    const matrix = [];
    let mobile = null;
    let client = null;
    try {
        let ready = false;
        for (let i = 0; i < 200; i++) {
            try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); ready = true; break; }
            catch (err) { await sleep(100); }
        }
        if (!ready) throw new Error('Chrome debugging port not ready');
        client = await makePage(PORT);

        await setMetrics(client, 1440, 900, false);
        await navigate(client, URL_NTOOLS);
        // 注入最坏数据
        await evaluate(client, `(function(){
            var todo = ${JSON.stringify(buildTodoDoc())};
            var llm = ${JSON.stringify(buildLlmDoc())};
            var conv = ${JSON.stringify(buildConversationDoc())};
            localStorage.setItem('ntools.todo.v2', JSON.stringify(todo));
            localStorage.setItem('ntools.llm.v1', JSON.stringify(llm));
            localStorage.setItem('nchat-conversation.v2', JSON.stringify(conv));
            localStorage.setItem('nchat-theme', 'dark');
            localStorage.setItem('nchat-lite-mode', 'false');
            return true;
        })()`);
        await navigate(client, URL_NTOOLS);
        await waitFor(client, "document.querySelectorAll('.todo-item').length > 20", 15000);
        await sleep(600);
        const dataset = await evaluate(client, `(function(){
            var doc = window.NC && NC.store && NC.store.todo && NC.store.todo.getDoc ? NC.store.todo.getDoc() : null;
            var profiles = window.NC && NC.store && NC.store.llm ? NC.store.llm.getProfiles() : [];
            return { tasks: doc ? doc.tasks.length : -1, lists: doc ? doc.lists.length : -1, profiles: profiles.length,
                     maxTitle: doc ? Math.max.apply(null, doc.tasks.slice(0, 6).map(function(t){return (t.title||'').length;})) : -1,
                     maxTags: doc ? Math.max.apply(null, doc.tasks.slice(0, 6).map(function(t){return (t.tags||[]).length;})) : -1 };
        })()`);
        console.log('数据注入: ' + JSON.stringify(dataset));

        async function scenario(name, setupFn, options) {
            const opts = options || {};
            for (const viewport of VIEWPORTS) {
                await setMetrics(client, viewport.width, viewport.height, viewport.width <= 768);
                await setRootScale(client, 100);
                if (setupFn) await setupFn();
                await sleep(350);
                for (const zoom of [100, 200]) {
                    await setRootScale(client, zoom);
                    const result = await measure(client, {
                        scope: opts.scope || null,
                        textSelectors: opts.textSelectors || [],
                        rowSelector: opts.rowSelector || '.todo-item'
                    });
                    matrix.push({ scenario: name, width: viewport.width, zoom: zoom, result });
                    if (result.missing) {
                        console.log('SKIP  ' + name + ' @' + viewport.width + 'px（scope ' + opts.scope + ' 不存在）');
                        break;
                    }
                    const problems = [];
                    if (result.docOverflow > 1) {
                        problems.push({ type: 'viewport-overflow', element: 'document', text: '页面横向溢出 ' + result.docOverflow + 'px' });
                    }
                    ['offscreen', 'clipped', 'texts', 'tallRows', 'tagsOverflow', 'layoutOverflow'].forEach((bucket) => {
                        (result[bucket] || []).forEach((item) => problems.push(item));
                    });
                    problems.forEach((item) => {
                        issues.push({
                            severity: classifyIssue(item),
                            scenario: name,
                            width: viewport.width,
                            zoom: zoom,
                            type: item.type,
                            element: item.element || 'document',
                            worstValue: (item.text || item.ancestor || item.reason || '').slice(0, 90),
                            detail: JSON.stringify(Object.assign({}, item, { text: undefined, element: undefined })),
                            fix: issueFix(item)
                        });
                    });
                    if (zoom === 100 || viewport.width === 1440 || viewport.width === 320) {
                        const file = await shot(client, name + '-' + viewport.width + '-z' + zoom + '.png');
                        shots.push(file);
                    }
                }
                await setRootScale(client, 100);
            }
        }

        // 场景 1：Todo 列表
        await scenario('todo', async () => {
            await evaluate(client, `(function(){
                var tab = document.querySelector('[data-tab="todo"]');
                if (tab) tab.click();
                var scroll = document.getElementById('todo-scroll');
                if (scroll) scroll.scrollTop = 0;
                window.scrollTo(0, 0);
                return true;
            })()`);
            await sleep(400);
        }, {
            scope: '#page-todo',
            textSelectors: ['.todo-item__title', '.todo-item__meta', '.todo-item__tags', '.todo-item__actions',
                '.todo-view-item__name', '.todo-view-item__count', '.todo-views__scroll', '.tools-nav__label',
                '.tools-nav__item', '#todo-foot-count', '#todo-new-title', '#todo-ai-btn']
        });

        // 场景 2：聊天（长代码块 / 无空格长串 / 满宽中文）
        const chatReady = await waitFor(client, "!!(window.NC && NC.chatEmbed)", 6000);
        if (chatReady) {
            await scenario('chat', async () => {
                await evaluate(client, `(function(){
                    var tab = document.querySelector('[data-tab="nchat"]');
                    if (tab) tab.click();
                    return true;
                })()`);
                await waitFor(client, "!!(window.NC.chatEmbed && NC.chatEmbed.isReady && NC.chatEmbed.isReady())", 12000);
                await sleep(700);
            }, {
                scope: '#page-nchat',
                textSelectors: ['.chat-msg__text', '.chat-msg__content pre', '.chat-msg__bubble', '.chat-msg__actions',
                    '#chat-profile-meta', '#chat-profile-select', '#chat-profile-select option', '.chat-msg__content code']
            });
        } else {
            console.log('跳过 chat 场景（NC.chatEmbed 未加载）');
        }

        // 场景 3：设置面板（长端点名 / Base URL + 操作按钮）
        await scenario('settings', async () => {
            await evaluate(client, `(function(){
                var btn = document.getElementById('settings-btn');
                if (btn) btn.click();
                return true;
            })()`);
            await waitFor(client, "!!document.querySelector('#settings-sheet') && !document.querySelector('#settings-sheet').hidden", 6000);
            await evaluate(client, `(function(){
                var nav = document.querySelector('.sp-nav[data-section="profiles"]');
                if (nav) nav.click();
                return true;
            })()`);
            await sleep(500);
            await evaluate(client, `(function(){
                var rows = Array.prototype.slice.call(document.querySelectorAll('.sp-profile'));
                var row = rows.filter(function(item){ return item.textContent.indexOf('华东区') > -1; })[0] || rows[0];
                var edit = row && Array.prototype.slice.call(row.querySelectorAll('button')).filter(function(btn){ return /编辑/.test(btn.textContent); })[0];
                if (edit) edit.click();
                return true;
            })()`);
            await sleep(500);
        }, {
            scope: '#settings-sheet',
            textSelectors: ['.sp-profile__name', '.sp-profile__meta', '.sp-section-title', '.sp-section-desc',
                '.sp-field input', '.sp-prompt', '.sp-editor-actions', '.sp-nav__title', '.sp-nav__desc',
                '.settings-sheet__title', '.sp-profile__actions', '.sp-data-row']
        });
        // 关闭设置，避免污染后续场景
        await evaluate(client, `(function(){
            var b = document.querySelector('.settings-sheet__head button');
            if (b) b.click();
            return true;
        })()`);
        await sleep(350);

        // 场景 4：Todo AI 识别弹窗
        const aiReady = await waitFor(client, "!!(window.NC && NC.todoAi)", 4000);
        if (aiReady) {
            await scenario('todo-ai-dialog', async () => {
                await evaluate(client, `(function(){
                    var tab = document.querySelector('[data-tab="todo"]');
                    if (tab) tab.click();
                    return true;
                })()`);
                await sleep(300);
                await evaluate(client, `(function(){
                    var btn = document.getElementById('todo-ai-btn');
                    if (btn) { btn.click(); return true; }
                    try { NC.todoAi.openDialog(); } catch (err) {}
                    return true;
                })()`);
                await waitFor(client, "!!document.querySelector('.nc-modal')", 6000);
                await evaluate(client, `(function(){
                    var modal = document.querySelector('.nc-modal');
                    var area = modal && modal.querySelector('textarea');
                    if (area) {
                        area.value = '请帮我整理：' + ${JSON.stringify(LONG_URL)} + ' ' + ${JSON.stringify(LONG_TOKEN)} + ' 附件：' + ${JSON.stringify(LONG_TITLE)};
                        area.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    return true;
                })()`);
                await sleep(400);
            }, {
                scope: '.nc-modal',
                textSelectors: ['.nc-modal__title', '.nc-modal__message', '.nc-modal__body', '.todo-ai-dialog__meta',
                    '.nc-modal textarea', '.nc-modal__foot', '.nc-btn']
            });
            // 关闭弹窗
            await evaluate(client, `(function(){
                var modal = document.querySelector('.nc-modal');
                var cancel = modal && Array.prototype.slice.call(modal.querySelectorAll('button')).filter(function(b){ return /取消|关闭/.test(b.textContent); })[0];
                if (cancel) { cancel.click(); }
                var overlay = document.querySelector('.nc-modal-overlay');
                if (!cancel && overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                return true;
            })()`);
            await sleep(350);
        }

        // 移动端原生检查（代码 + 计算样式）
        mobile = await mobileChecks(client, cssReport);
        const mobileShot = await shot(client, 'mobile-native-390.png');
        shots.push(mobileShot);

        fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'dataset.json'), JSON.stringify({
            todo: buildTodoDoc().tasks.slice(0, 8), llm: buildLlmDoc(), conversation: buildConversationDoc()
        }, null, 2));
    } catch (err) {
        console.error('break-ui 运行失败: ' + (err && err.stack ? err.stack : err));
        try { chrome.kill('SIGKILL'); } catch (e) { /* ignore */ }
        process.exit(2);
    } finally {
        try { chrome.kill('SIGKILL'); } catch (err) { /* ignore */ }
        try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
        if (client) { try { client.ws.close(); } catch (err) { /* ignore */ } }
    }

    // 去重 + 排序：同一问题（场景+元素+类型）只保留最坏的一条，记录出现的宽度/缩放
    const grouped = new Map();
    issues.forEach((issue) => {
        const key = issue.scenario + '|' + issue.type + '|' + issue.element + '|' + issue.worstValue;
        if (!grouped.has(key)) {
            grouped.set(key, Object.assign({}, issue, { occurrences: [issue.width + 'px@' + issue.zoom + '%'] }));
        } else {
            grouped.get(key).occurrences.push(issue.width + 'px@' + issue.zoom + '%');
        }
    });
    const list = Array.from(grouped.values()).sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
        (a.scenario < b.scenario ? -1 : 1));

    const report = {
        generatedAt: new Date().toISOString(),
        dataset: { tasks: 500, tags: 20, longTitle: LONG_TITLE.length + ' 字', longUrl: LONG_URL.length + ' 字符' },
        viewports: VIEWPORTS.map((item) => item.width),
        zooms: [100, 200],
        problems: list,
        matrix: matrix.map((item) => ({
            scenario: item.scenario, width: item.width, zoom: item.zoom,
            docOverflow: item.result.docOverflow,
            offscreen: item.result.offscreen.length,
            clipped: item.result.clipped.length,
            texts: item.result.texts.length,
            tallRows: item.result.tallRows.length,
            tagsOverflow: item.result.tagsOverflow.length,
            layoutOverflow: item.result.layoutOverflow.length,
            rows: item.result.rows
        })),
        mobile: mobile,
        css: cssReport,
        screenshots: shots,
        consoleErrors: client ? client.consoleErrors.slice(-10) : []
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

    // 控制台问题表
    console.log('\n== break-ui 问题表（最坏但可信数据） ==');
    if (!list.length) {
        console.log('未发现横向溢出 / 裁切 / 撑破问题。');
    } else {
        console.log('Severity | 场景 | 宽度/缩放 | 元素/字段 | 现象 | 建议修复');
        console.log('--- | --- | --- | --- | --- | ---');
        list.forEach((item, index) => {
            console.log((index + 1) + '. ' + item.severity + ' | ' + item.scenario + ' | ' + item.occurrences.join(',') + ' | ' +
                item.element + ' | ' + (item.worstValue || item.type) + ' | ' + item.fix);
        });
    }
    console.log('\n== 移动端原生检查 ==');
    if (mobile) {
        mobile.checks.forEach((check) => {
            console.log((check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL') + '  ' + check.name + '  → ' + check.detail);
        });
    }
    console.log('\n截图: ' + shots.length + ' 张 → ' + OUT_DIR);
    console.log('报告: ' + path.join(OUT_DIR, 'report.json'));
    // 生成 markdown 报告（供 docs/design-break-audit.md 引用）
    const md = ['# break-ui 巡检报告（自动生成）', '', '> 生成时间: ' + report.generatedAt,
        '> 数据: 500 条待办 / 20 标签 / ' + LONG_TITLE.length + ' 字标题 / ' + LONG_URL.length + ' 字符无空格 URL / 长端点名与 Base URL', '',
        '## 问题表', '',
        '| # | Severity | 场景 | 宽度/缩放 | 元素/字段 | 最坏值/现象 | 建议修复 |',
        '| --- | --- | --- | --- | --- | --- | --- |'];
    list.forEach((item, index) => {
        md.push('| ' + (index + 1) + ' | ' + item.severity + ' | ' + item.scenario + ' | ' + item.occurrences.join(',') + ' | ' +
            (item.element || '').replace(/\|/g, '/') + ' | ' + String(item.worstValue || '').replace(/\|/g, '/').slice(0, 80) + ' | ' + item.fix + ' |');
    });
    md.push('', '## 矩阵', '', '| 场景 | 宽 | 缩放 | docOverflow | offscreen | clipped | texts | tallRows | tags | layout | rows(median/max) |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    report.matrix.forEach((row) => {
        md.push('| ' + row.scenario + ' | ' + row.width + ' | ' + row.zoom + '% | ' + row.docOverflow + ' | ' + row.offscreen + ' | ' + row.clipped + ' | ' +
            row.texts + ' | ' + row.tallRows + ' | ' + row.tagsOverflow + ' | ' + row.layoutOverflow + ' | ' + row.rows.median + '/' + row.rows.max + ' |');
    });
    md.push('', '## 移动端原生检查', '', '| 检查 | 结果 | 详情 |', '| --- | --- | --- |');
    (mobile ? mobile.checks : []).forEach((check) => {
        md.push('| ' + check.name + ' | ' + check.status + ' | ' + String(check.detail).replace(/\|/g, '/') + ' |');
    });
    md.push('', '## 截图', '');
    shots.forEach((file) => md.push('- `' + file + '`'));
    fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md.join('\n'));
    if (VERBOSE) console.log(md.join('\n'));
    process.exit(0);
}

main();
