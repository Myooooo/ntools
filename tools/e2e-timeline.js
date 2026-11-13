#!/usr/bin/env node
/**
 * tools/e2e-timeline.js — Todo「全景时间线」独立模块 E2E（CDP 无头 Chrome，不联网）
 *
 * 覆盖（task-16 验收）：
 *  1. 动态加载 js/todo-timeline.js + css/timeline.css（模拟 Lead 在 ntools.html 的接线）
 *  2. mock 数据（500 条，含置顶/循环/逾期/完成/取消/无日期/范围外/长标题）
 *  3. mount / unmount / refresh API；横向模式 ≥900、纵向时间流水 <900
 *  4. 默认未来 7 天范围；起止输入、预设（未来 3 天/本周/本月/重置）
 *  5. 刻度区指针拖拽框选（实时高亮 + 松开生效）与双击重置
 *  6. 任务点击 → NC.store.todo.selectTask（选中态 + 详情抽屉）
 *  7. 范围外计数 / 无日期任务完全不显示 / 显示已完成开关与 settings 同步
 *  8. 截图：标准/浅色/Lite × 1440/390（默认 / 最右 / 未来 3 天 / 本周）→ /tmp/nc-shots/v48/timeline/
 *  9. 全程无 console.error / 未捕获异常
 *
 * 用法：node tools/e2e-timeline.js [--verbose]
 * 退出码：0 全部通过；1 有失败；2 环境错误。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = path.resolve(__dirname, '..');
const PORT = 9720 + (process.pid % 160);
const URL_NTOOLS = 'file://' + path.join(ROOT, 'ntools.html').split(path.sep).join('/');
const SHOT_DIR = process.env.TIMELINE_SHOT_DIR || '/tmp/nc-shots/v48/timeline';
const VERBOSE = process.argv.indexOf('--verbose') > -1;
const DAY = 86400000;
const HOUR = 3600000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
                this.consoleErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' ').slice(0, 400));
            }
            if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                this.consoleErrors.push('exception: ' + ((details.exception && details.exception.description) || details.text || '').slice(0, 400));
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

async function waitFor(client, expression, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 6000)) {
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
        setTimeout(resolve, 15000);
    });
    await client.send('Page.navigate', { url });
    await loaded;
    await waitFor(client, "typeof window.NC !== 'undefined'", 10000);
    await sleep(400);
}

async function setMetrics(client, width, height, mobile) {
    await client.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: !!mobile, screenWidth: width, screenHeight: height
    });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 });
    await sleep(300);
}

async function shot(client, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const file = path.join(SHOT_DIR, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
}

/* ------------------------------------------------------------------ *
 * Mock 数据（500 条任务；范围仅未来 7 天，其余为范围外/无日期）
 * ------------------------------------------------------------------ */
function buildMockDoc(now) {
    const round = (ts) => Math.round(ts / (15 * 60000)) * 15 * 60000;
    const base = {
        schemaVersion: 2,
        revision: 1,
        updatedAt: now,
        lists: [
            { id: 'list_default', name: '待办', color: '#6EA8FE', order: 0, archived: false, createdAt: now, updatedAt: now },
            { id: 'list_work', name: '本周重点', color: '#D8B06A', order: 1, archived: false, createdAt: now, updatedAt: now }
        ],
        tasks: [],
        settings: {
            defaultListId: 'list_default', view: 'all', sort: 'smart',
            showCompleted: true, reminderLeadMinutes: 15, compact: false
        },
        meta: { app: 'nTools', appVersion: '4.0.0', migratedFrom: null, migratedAt: null, quarantine: [] }
    };
    let seq = 0;
    const push = (patch) => {
        seq += 1;
        const defaultDue = patch && typeof patch.due === 'number' ? patch.due : null;
        const defaults = {
            id: 'tl-' + seq,
            listId: 'list_default',
            title: '时间线任务 ' + seq,
            notes: '',
            status: 'open',
            priority: 'normal',
            due: defaultDue,
            dueAllDay: false,
            tags: [],
            subtasks: [],
            recurrence: null,
            reminder: null,
            order: seq * 1024,
            // 默认给 2 小时时长（createdAt → due）
            createdAt: defaultDue != null ? defaultDue - 2 * HOUR : now,
            updatedAt: now,
            completedAt: null,
            deletedAt: null,
            source: 'e2e-timeline'
        };
        base.tasks.push(Object.assign(defaults, patch, { createdAt: patch && patch.createdAt != null ? patch.createdAt : defaults.createdAt }));
        return base.tasks[base.tasks.length - 1];
    };

    // ① 置顶 + 高优先级 + 多标签 + 长标题；创建于 10 天前 → 左端溢出，到期在范围内
    push({
        id: 'tl-pin', title: '与华东区域三家供应商确认第四季度交付排期，并同步采购、法务、财务三个部门的审批节点与应急预案（含备选供应商与到货缓冲）',
        pinned: true, priority: 'urgent', due: round(now + 2 * HOUR), createdAt: now - 10 * DAY,
        tags: ['采购', '法务', '财务', '交付', '供应商', '审批', '例会', '季度'],
        listId: 'list_work'
    });
    // ② 循环任务：创建于 1 天前
    push({
        id: 'tl-repeat', title: '每周合规巡检复盘', status: 'open', priority: 'high', due: round(now + 6 * HOUR),
        createdAt: round(now + 6 * HOUR) - 4 * HOUR,
        recurrence: { freq: 'weekly', interval: 1, byWeekday: [(new Date(now).getDay() + 1) % 7], until: null, count: null, lastMaterializedAt: now },
        tags: ['合规']
    });
    // ③ 逾期（创建/到期都早于范围 → 固定左缘）
    push({ id: 'tl-overdue', title: '处理逾期安全巡检整改', priority: 'urgent', due: round(now - 2 * HOUR), createdAt: now - 2 * DAY });
    // ④ 已完成 / 已取消（范围内，弱化）
    push({ id: 'tl-done', title: '提交上周周报', status: 'done', completedAt: now - HOUR, due: round(now + 4 * HOUR), createdAt: round(now + 4 * HOUR) - 3 * HOUR });
    push({ id: 'tl-canceled', title: '取消的供应商拜访', status: 'canceled', due: round(now + 26 * HOUR), createdAt: round(now + 26 * HOUR) - 5 * HOUR });
    // ⑤ 时长条专用任务（用于宽度比例断言）
    push({ id: 'tl-dur-long', title: '时长条·两天任务', due: now + 2 * DAY + 2 * HOUR, createdAt: now + 2 * HOUR, priority: 'high' });
    push({ id: 'tl-dur-mid', title: '时长条·半天任务', due: now + 1 * DAY + 12 * HOUR, createdAt: now + 1 * DAY });
    push({ id: 'tl-dur-short', title: '时长条·四十分钟任务', due: now + 1 * DAY + 2 * HOUR, createdAt: now + 1 * DAY + 2 * HOUR - 40 * 60000 });
    // ⑥ 右端溢出：创建于范围内，到期远晚于范围
    push({ id: 'tl-clip-end', title: '跨范围长任务（右端裁剪）', due: round(now + 10 * DAY), createdAt: now + 1 * DAY });
    // ⑦ 左侧清单/搜索筛选专用任务
    push({ id: 'tl-filter-work', title: 'E2E 专属筛选任务', listId: 'list_work', due: round(now + 3 * HOUR), createdAt: round(now + 3 * HOUR) - 2 * HOUR });
    // ⑧ 未来 7 天其余任务（20 条，时长 1–5 小时不等）
    for (let i = 0; i < 20; i += 1) {
        const due = round(now + (1.2 + i * 0.27) * DAY);
        push({
            title: '时间线样例任务 ' + (i + 1),
            due: due,
            createdAt: due - (24 + i * 9.6) * HOUR,
            priority: i % 4 === 0 ? 'high' : (i % 5 === 0 ? 'low' : 'normal'),
            tags: i % 3 === 0 ? ['工作'] : [],
            listId: i % 2 ? 'list_work' : 'list_default'
        });
    }
    // ⑧b 超老逾期：due 早于默认范围起点（now-45d 上限）→ 固定左缘
    push({ id: 'tl-edge-old', title: '超期很久的旧整改项', due: round(now - 60 * DAY), createdAt: now - 61 * DAY, priority: 'high' });
    // ⑨ 无日期任务（3 条）：时间线必须完全不显示
    for (let i = 0; i < 3; i += 1) push({ title: '无日期任务 ' + (i + 1), due: null, createdAt: now - DAY });
    // ⑩ 范围外：过去/未来较远（用于范围外计数）
    push({ id: 'tl-out-past', title: '上季度归档复盘', due: round(now - 40 * DAY), createdAt: now - 41 * DAY });
    push({ id: 'tl-out-future', title: '下季度供应商招标', due: round(now + 20 * DAY), createdAt: now + 20 * DAY - 2 * HOUR });
    push({ id: 'tl-out-future2', title: '年度审计准备', due: round(now + 60 * DAY), createdAt: now + 60 * DAY - 2 * HOUR });
    // ⑪ 500 条总量：其余为远期任务（范围外，不进入时间线）
    while (base.tasks.length < 500) {
        const due = round(now + (90 + (base.tasks.length % 240)) * DAY);
        push({ title: '远期任务 ' + (base.tasks.length + 1), due: due, createdAt: due - 2 * HOUR, listId: 'list_default' });
    }
    return base;
}

/** 与模块 defaultRange() 同口径：今天 00:00 → +5 天 */
function defaultRangeNode(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const start = d.getTime();
    return { start, end: start + 5 * DAY };
}

/** 与模块 collect() 同口径：默认 view=all / 无搜索 / 无清单过滤 / showCompleted=false */
function expectedCounts(doc, now) {
    const range = defaultRangeNode(now);
    const tasks = doc.tasks.filter((task) => !task.deletedAt && typeof task.due === 'number');
    const visible = tasks.filter((task) => task.status !== 'done' && task.status !== 'canceled');
    const inRange = visible.filter((task) => task.due >= range.start && task.due <= range.end);
    const edgeAll = visible.filter((task) => task.due < range.start && task.status === 'open')
        .sort((a, b) => a.due - b.due);
    const edge = edgeAll.slice(0, 12);
    const outRange = visible.filter((task) => task.due < range.start || task.due > range.end).length;
    let latestDue = null;
    visible.forEach((task) => { if (latestDue == null || task.due > latestDue) latestDue = task.due; });
    const hiddenDone = tasks.filter((task) => {
        return task.due >= range.start && task.due <= range.end &&
            (task.status === 'done' || task.status === 'canceled');
    }).length;
    return {
        range: range,
        total: doc.tasks.length,
        withDue: tasks.length,
        visible: visible.length,
        inRange: inRange.length,
        edge: edge.length,
        outRange: outRange,
        latestDue: latestDue,
        hiddenDone: hiddenDone
    };
}

/* ------------------------------------------------------------------ *
 * 页面装/卸载辅助
 * ------------------------------------------------------------------ */
async function loadTimelineAssets(client) {
    await evaluate(client, `(function(){
        if (window.NC && NC.timeline) return 'ready';
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'css/timeline.css';
        document.head.appendChild(link);
        return new Promise(function(resolve) {
            var script = document.createElement('script');
            script.src = 'js/todo-timeline.js';
            script.onload = function(){ resolve('loaded'); };
            script.onerror = function(){ resolve('error'); };
            document.head.appendChild(script);
        });
    })()`);
    return waitFor(client, "!!(window.NC && NC.timeline && typeof NC.timeline.mount === 'function')", 8000);
}

async function seedStore(client, doc) {
    return evaluate(client, `(function(){
        var store = window.NC && NC.store && NC.store.todo;
        if (!store) return 'no-store';
        var result = store.importDoc(${JSON.stringify(doc)}, 'replace');
        return result ? 'ok' : 'failed';
    })()`);
}

async function mountTimeline(client, options) {
    return evaluate(client, `(function(){
        var existing = document.getElementById('timeline-e2e-root');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        var host = document.createElement('div');
        host.id = 'timeline-e2e-root';
        host.style.cssText = 'position:fixed;inset:0;z-index:9000;background:var(--nc-bg);display:flex;flex-direction:column;';
        document.body.appendChild(host);
        var container = document.createElement('div');
        container.id = 'timeline-e2e-container';
        container.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';
        host.appendChild(container);
        var ok = NC.timeline.mount(container, ${JSON.stringify(options || {})});
        return { ok: ok, state: NC.timeline.getState() };
    })()`);
}

async function setTheme(client, theme) {
    return evaluate(client, `(function(){
        try {
            if (window.NC && NC.theme) {
                NC.theme.set(${JSON.stringify(theme === 'light' ? 'light' : 'dark')});
                NC.theme.setLite(${JSON.stringify(theme === 'lite')});
            }
        } catch (err) {}
        document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme === 'light' ? 'light' : 'dark')});
        document.documentElement.setAttribute('data-lite', ${JSON.stringify(theme === 'lite' ? 'true' : 'false')});
        window.scrollTo(0, 0);
        return true;
    })()`);
}

/* ------------------------------------------------------------------ *
 * 主流程
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
                if (!item.pass || VERBOSE) console.log('  ' + (item.pass ? 'PASS' : 'FAIL') + '  ' + item.name + (item.detail ? '  → ' + item.detail : ''));
            });
            return failed.length;
        }
    };
}

async function main() {
    if (!fs.existsSync(CHROME)) {
        console.error('Chrome not found: ' + CHROME + '\n可用 CHROME 环境变量指定。');
        process.exit(2);
    }
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-e2e-timeline-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
        '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let client = null;
    const report = makeReport();
    const shots = [];
    const startedAt = Date.now();
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
        await waitFor(client, "!!(window.NC && NC.store && NC.store.todo && NC.store.todo.getDoc)", 10000);
        await evaluate(client, 'localStorage.clear(); true;');
        await navigate(client, URL_NTOOLS);
        await waitFor(client, "!!(window.NC && NC.store && NC.store.todo)", 10000);

        // ---------- 加载模块资源 ----------
        const assets = await loadTimelineAssets(client);
        report.assert('动态加载 timeline.js/css', assets);

        const now = Date.now();
        const doc = buildMockDoc(now);
        const expected = expectedCounts(doc, now);
        const seeded = await seedStore(client, doc);
        report.assert('mock 数据导入（500 条）', seeded === 'ok', String(seeded));
        await sleep(500);

        // pinned 字段可能尚未被 schema 归一化：测试前直接补到任务对象（e2e 测试数据准备，不涉及模块实现）
        await evaluate(client, `(function(){
            var doc = NC.store.todo.getDoc();
            var pin = doc.tasks.filter(function(t){ return t.id === 'tl-pin'; })[0];
            if (pin) pin.pinned = true;
            var repeat = doc.tasks.filter(function(t){ return t.id === 'tl-repeat'; })[0];
            if (repeat) repeat.recurrence = repeat.recurrence || { freq: 'weekly', interval: 1, byWeekday: [], until: null, count: null, lastMaterializedAt: Date.now() };
            return true;
        })()`);

        // ---------- mount ----------
        const mounted = await mountTimeline(client);
        report.assert('mount 成功', mounted && mounted.ok === true, JSON.stringify(mounted));
        await waitFor(client, "!!document.querySelector('.tl-root')", 5000);
        await sleep(700);

        const shape = await evaluate(client, `(function(){
            var root = document.querySelector('.tl-root');
            var state = NC.timeline.getState();
            var scroll = document.querySelector('.tl-scroll');
            var canvas = document.querySelector('.tl-canvas');
            var input = document.querySelector('.tl-switch input');
            return {
                mode: state.mode,
                range: state.range,
                rangeDays: state.rangeDays,
                dayWidth: state.dayWidth,
                displayStart: state.displayStart,
                displayEnd: state.displayEnd,
                rootMode: root ? root.getAttribute('data-mode') : null,
                hasAxis: !!document.querySelector('.tl-axis'),
                hasBrush: !!document.querySelector('.tl-brush-layer'),
                startInput: (document.querySelector('.tl-field__input') || {}).value || null,
                viewportWidth: scroll ? scroll.clientWidth : 0,
                scrollLeft: scroll ? Math.round(scroll.scrollLeft) : null,
                scrollWidth: scroll ? scroll.scrollWidth : null,
                canvasWidth: canvas ? canvas.offsetWidth : null,
                chips: document.querySelectorAll('.tl-task').length,
                doneBars: document.querySelectorAll('.tl-task.is-done').length,
                canceledBars: document.querySelectorAll('.tl-task.is-canceled').length,
                switchChecked: input ? input.checked : null,
                noDueBlocks: document.querySelectorAll('.tl-nodue').length,
                noDueChips: document.querySelectorAll('[data-id^="tl-nodue"], .tl-nodue__chip').length,
                statsText: (document.querySelector('.tl-stats') || {}).textContent || '',
                nowHidden: (document.querySelector('.tl-now') || {}).hidden,
                counts: state.counts
            };
        })()`);
        report.assert('横向模式（1440 容器）', shape.mode === 'h' && shape.rootMode === 'h', JSON.stringify(shape));
        report.assert('默认范围约 5 天（今天 00:00 起）',
            !!shape.range &&
            Math.abs(shape.range.start - expected.range.start) <= 1000 &&
            Math.abs((shape.range.end - shape.range.start) - 5 * DAY) <= 60000 &&
            Math.abs(shape.rangeDays - 5) < 0.01,
            JSON.stringify({ actual: shape.range, expected: expected.range, rangeDays: shape.rangeDays }));
        report.assert('默认视口约 5 天（选中天数铺满视口）',
            Math.abs(shape.dayWidth - shape.viewportWidth / 5) <= 2,
            JSON.stringify({ dayWidth: shape.dayWidth, viewportWidth: shape.viewportWidth }));
        report.assert('初始定位到范围开始（现在可见）', shape.scrollLeft <= 1 && shape.nowHidden === false,
            JSON.stringify({ scrollLeft: shape.scrollLeft, nowHidden: shape.nowHidden }));
        report.assert('刻度区/框选层存在', shape.hasAxis && shape.hasBrush);
        report.assert('可见任务全部渲染（画布覆盖到最晚任务）',
            shape.chips === Math.min(expected.visible, 600) && shape.chips === shape.counts.visible && shape.chips === shape.counts.rendered,
            JSON.stringify({ chips: shape.chips, rendered: shape.counts.rendered, visible: shape.counts.visible, expected: expected.visible }));
        report.assert('顶部输入与范围同步', !!shape.startInput, shape.startInput);
        report.assert('范围内/范围外统计正确',
            shape.statsText.indexOf(String(expected.inRange)) > -1 && shape.statsText.indexOf(String(expected.outRange)) > -1,
            shape.statsText.slice(0, 120));
        report.assert('默认隐藏已完成/已取消（开关默认关闭）',
            shape.doneBars === 0 && shape.canceledBars === 0 && shape.switchChecked === false &&
            shape.counts.hiddenDone === expected.hiddenDone,
            JSON.stringify({ done: shape.doneBars, canceled: shape.canceledBars, switchChecked: shape.switchChecked, hiddenDone: shape.counts.hiddenDone, expectedHidden: expected.hiddenDone }));
        report.assert('不再显示无日期区/无日期计数',
            shape.noDueBlocks === 0 && shape.noDueChips === 0 && shape.statsText.indexOf('无日期') === -1 &&
            !(shape.counts && 'noDue' in shape.counts),
            JSON.stringify({ blocks: shape.noDueBlocks, chips: shape.noDueChips, stats: shape.statsText.slice(0, 120) }));
        report.assert('“现在”指示线可见', shape.nowHidden === false);

        const badges = await evaluate(client, `(function(){
            return {
                pinned: document.querySelectorAll('.tl-task.is-pinned').length,
                recurring: document.querySelectorAll('.tl-task.is-recurring').length,
                overdue: document.querySelectorAll('.tl-task.is-overdue').length,
                edge: document.querySelectorAll('.tl-task.is-edge-overdue').length
            };
        })()`);
        report.assert('置顶标识', badges.pinned >= 1, JSON.stringify(badges));
        report.assert('循环标识', badges.recurring >= 1, JSON.stringify(badges));
        report.assert('逾期标识（范围左缘固定）', badges.overdue >= 1 && badges.edge >= 1, JSON.stringify(badges));

        // ---------- 时长条 / 画布右端 / 右滚到最晚任务 ----------
        const barState = await evaluate(client, `(function(){
            var canvas = document.querySelector('.tl-canvas');
            var cr = canvas.getBoundingClientRect();
            var state = NC.timeline.getState();
            var result = {};
            var maxDue = -Infinity;
            var maxId = null;
            document.querySelectorAll('.tl-task').forEach(function(chip){
                var r = chip.getBoundingClientRect();
                var due = Number(chip.getAttribute('data-due'));
                result[chip.getAttribute('data-id')] = {
                    left: r.left, right: r.right, width: r.width,
                    offsetLeft: chip.offsetLeft, offsetWidth: chip.offsetWidth,
                    duration: Number(chip.getAttribute('data-duration')),
                    due: due,
                    start: Number(chip.getAttribute('data-start')),
                    clipStart: chip.getAttribute('data-clip-start') === 'true',
                    clipEnd: chip.getAttribute('data-clip-end') === 'true',
                    short: chip.getAttribute('data-short') === 'true'
                };
                if (due > maxDue) { maxDue = due; maxId = chip.getAttribute('data-id'); }
            });
            return {
                bars: result,
                canvas: { left: cr.left, width: canvas.offsetWidth },
                state: { dayWidth: state.dayWidth, displayStart: state.displayStart, displayEnd: state.displayEnd, latestDue: state.counts.latestDue },
                maxDue: maxDue === -Infinity ? null : maxDue,
                maxId: maxId
            };
        })()`);
        const longBar = barState.bars['tl-dur-long'];
        const midBar = barState.bars['tl-dur-mid'];
        const shortBar = barState.bars['tl-dur-short'];
        const pinBar = barState.bars['tl-pin'];
        const clipEndBar = barState.bars['tl-clip-end'];
        report.assert('时长条数据齐全', !!(longBar && midBar && shortBar && pinBar && clipEndBar),
            Object.keys(barState.bars).slice(0, 12).join(','));
        if (longBar && midBar && shortBar) {
            report.assert('不同时长宽度不同且大于最小宽度',
                longBar.width > midBar.width + 20 && midBar.width > 44 && longBar.width > 44,
                JSON.stringify({ long: Math.round(longBar.width), mid: Math.round(midBar.width), short: Math.round(shortBar.width) }));
            const ratio = longBar.width / Math.max(1, midBar.width);
            const clipDuration = (bar) => {
                const start = Math.max(bar.start, barState.state.displayStart);
                const end = Math.min(bar.due, barState.state.displayEnd);
                return Math.max(1, end - start);
            };
            const durationRatio = clipDuration(longBar) / clipDuration(midBar);
            report.assert('宽度与创建→到期时长成比例',
                Math.abs(ratio - durationRatio) / durationRatio < 0.25,
                JSON.stringify({ ratio: ratio.toFixed(2), durationRatio: durationRatio.toFixed(2) }));
            const pxPerDay = barState.state.dayWidth;
            const expectedRight = barState.canvas.left + ((shortBar.due - barState.state.displayStart) / DAY) * pxPerDay;
            report.assert('极短任务有最小可视宽度（44–60px，右端锚定 due）',
                shortBar.width >= 43 && shortBar.width <= 60 && shortBar.short === true &&
                Math.abs(shortBar.right - expectedRight) <= 5,
                JSON.stringify({ width: Math.round(shortBar.width), short: shortBar.short, right: Math.round(shortBar.right), expectedRight: Math.round(expectedRight) }));
        }
        report.assert('默认窗口内时长条不裁剪（long/mid 完整）',
            !!longBar && !!midBar &&
            longBar.clipStart === false && longBar.clipEnd === false &&
            midBar.clipStart === false && midBar.clipEnd === false,
            JSON.stringify({ long: longBar && [longBar.clipStart, longBar.clipEnd], mid: midBar && [midBar.clipStart, midBar.clipEnd] }));
        report.assert('画布右端≈最晚任务（16px padding，无多余空白）',
            !!barState.maxId &&
            barState.maxDue === barState.state.latestDue &&
            (barState.canvas.width - (barState.bars[barState.maxId].offsetLeft + barState.bars[barState.maxId].offsetWidth)) >= 8 &&
            (barState.canvas.width - (barState.bars[barState.maxId].offsetLeft + barState.bars[barState.maxId].offsetWidth)) <= 20,
            JSON.stringify({ maxId: barState.maxId, maxDue: barState.maxDue, canvasWidth: barState.canvas.width, lastRight: barState.maxId ? Math.round(barState.bars[barState.maxId].offsetLeft + barState.bars[barState.maxId].offsetWidth) : null }));

        const scrolledRight = await evaluate(client, `(function(){
            var scroll = document.querySelector('.tl-scroll');
            scroll.scrollLeft = scroll.scrollWidth;
            var canvas = document.querySelector('.tl-canvas');
            var state = NC.timeline.getState();
            var chips = document.querySelectorAll('.tl-task');
            var maxId = null, maxDue = -Infinity;
            chips.forEach(function(chip){
                var due = Number(chip.getAttribute('data-due'));
                if (due > maxDue) { maxDue = due; maxId = chip.getAttribute('data-id'); }
            });
            var target = document.querySelector('.tl-task[data-id="' + maxId + '"]');
            var r = target ? target.getBoundingClientRect() : null;
            var sr = scroll.getBoundingClientRect();
            return {
                scrollLeft: Math.round(scroll.scrollLeft),
                maxScroll: Math.round(scroll.scrollWidth - scroll.clientWidth),
                visible: !!r && r.right <= sr.right + 1 && r.right >= sr.left,
                rightGap: r ? Math.round(sr.right - r.right) : null,
                viewportWidth: sr.width,
                canvasRightGap: canvas ? (canvas.offsetWidth - (target ? target.offsetLeft + target.offsetWidth : 0)) : null
            };
        })()`);
        report.assert('滚动到最右可见最晚任务（无超限空白）',
            scrolledRight.scrollLeft >= scrolledRight.maxScroll - 2 &&
            scrolledRight.visible === true &&
            scrolledRight.canvasRightGap != null && scrolledRight.canvasRightGap >= 8 && scrolledRight.canvasRightGap <= 20,
            JSON.stringify(scrolledRight));
        await evaluate(client, "(function(){ document.querySelector('.tl-scroll').scrollLeft = 0; return true; })()");
        await sleep(200);

        // 手动缩小范围：左端裁剪保留；画布仍延伸到最晚任务（无右端裁剪）
        await evaluate(client, `(function(){ NC.timeline.setRange(Date.now() + 1 * 86400000, Date.now() + 2 * 86400000); return true; })()`);
        await sleep(700);
        const narrowed = await evaluate(client, `(function(){
            var canvas = document.querySelector('.tl-canvas');
            var cr = canvas.getBoundingClientRect();
            var chip = document.querySelector('.tl-task[data-id="tl-dur-long"]');
            var r = chip ? chip.getBoundingClientRect() : null;
            var state = NC.timeline.getState();
            return {
                clipStart: chip ? chip.getAttribute('data-clip-start') === 'true' : null,
                clipEnd: chip ? chip.getAttribute('data-clip-end') === 'true' : null,
                left: r ? r.left : null, canvasLeft: cr.left,
                canvasWidth: canvas.offsetWidth,
                viewportWidth: document.querySelector('.tl-scroll').clientWidth,
                scrollLeft: Math.round(document.querySelector('.tl-scroll').scrollLeft),
                scrollWidth: document.querySelector('.tl-scroll').scrollWidth
            };
        })()`);
        report.assert('手动缩小范围：左端裁剪标记保留',
            narrowed.clipStart === true && Math.abs(narrowed.left - narrowed.canvasLeft) <= 3,
            JSON.stringify({ clipStart: narrowed.clipStart, left: narrowed.left && Math.round(narrowed.left), canvasLeft: Math.round(narrowed.canvasLeft) }));
        report.assert('手动缩小范围：画布仍延伸到最晚任务（可向右滚动）',
            narrowed.canvasWidth > narrowed.viewportWidth && narrowed.scrollWidth > narrowed.viewportWidth,
            JSON.stringify({ canvasWidth: narrowed.canvasWidth, viewport: narrowed.viewportWidth, scrollWidth: narrowed.scrollWidth }));
        await evaluate(client, `(function(){ NC.timeline.presetRange('reset'); return true; })()`);
        await sleep(700);

        // ---------- 范围控件对齐（横向） ----------
        const alignH = await evaluate(client, `(function(){
            function rect(sel){ var el = document.querySelector(sel); if (!el) return null; var r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }
            return {
                start: rect('.tl-field__input'),
                end: rect(document.querySelectorAll('.tl-field__input').length > 1 ? '.tl-field__input:nth-of-type(1)' : '.tl-field__input'),
                inputs: Array.prototype.map.call(document.querySelectorAll('.tl-field__input'), function(el){ var r = el.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }),
                labels: Array.prototype.map.call(document.querySelectorAll('.tl-field__label'), function(el){ var r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }),
                presets: rect('.tl-presets'),
                switchRow: rect('.tl-extra'),
                fitBtn: rect('.tl-extra .nc-btn')
            };
        })()`);
        const inputA = alignH.inputs[0];
        const inputB = alignH.inputs[1];
        report.assert('范围输入等宽等高',
            alignH.inputs.length === 2 && Math.abs(inputA.width - inputB.width) <= 1 && Math.abs(inputA.height - inputB.height) <= 1,
            JSON.stringify({ a: inputA && { w: inputA.width, h: inputA.height }, b: inputB && { w: inputB.width, h: inputB.height } }));
        report.assert('输入标签同一基线',
            alignH.labels.length === 2 && Math.abs(alignH.labels[0].bottom - alignH.labels[1].bottom) <= 1,
            JSON.stringify(alignH.labels));
        report.assert('预设/开关/扩展按钮与输入同基线',
            Math.abs(inputA.bottom - alignH.presets.bottom) <= 2 &&
            Math.abs(inputA.bottom - alignH.switchRow.bottom) <= 2 &&
            Math.abs(inputA.bottom - alignH.fitBtn.bottom) <= 2,
            JSON.stringify({ inputBottom: inputA.bottom, presets: alignH.presets.bottom, extra: alignH.switchRow.bottom, fit: alignH.fitBtn.bottom }));

        // ---------- 任务点击 → selectTask ----------
        await evaluate(client, `(function(){
            var chip = document.querySelector('.tl-task[data-id="tl-pin"]') || document.querySelector('.tl-task');
            if (chip) chip.click();
            return true;
        })()`);
        await sleep(500);
        const selected = await evaluate(client, `(function(){
            var ui = NC.store.todo.getUi();
            return { id: ui.selectedId, drawer: ui.drawerOpen, selectedChips: document.querySelectorAll('.tl-task.is-selected').length };
        })()`);
        report.assert('任务点击 → selectTask', selected.id === 'tl-pin' && selected.drawer === true, JSON.stringify(selected));
        report.assert('选中态回流到 chip', selected.selectedChips >= 1, JSON.stringify(selected));
        await evaluate(client, 'NC.store.todo.clearSelection(); true;');

        // ---------- 范围输入 ----------
        const narrowStart = now + 2 * HOUR;
        const narrowEnd = now + 30 * HOUR;
        await evaluate(client, `(function(){
            function fmt(ts){ var d = new Date(ts); function p(n){ return n<10?'0'+n:String(n); } return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes()); }
            var inputs = document.querySelectorAll('.tl-field__input');
            inputs[0].value = fmt(${narrowStart});
            inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
            inputs[1].value = fmt(${narrowEnd});
            inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        await sleep(600);
        const afterInputs = await evaluate(client, `(function(){
            var state = NC.timeline.getState();
            return { range: state.range, chips: document.querySelectorAll('.tl-task').length, label: (document.querySelector('.tl-range-label') || {}).textContent || '' };
        })()`);
        report.assert('起止输入生效', afterInputs.range && Math.abs(afterInputs.range.start - narrowStart) < 60000 &&
            Math.abs(afterInputs.range.end - narrowEnd) < 60000, JSON.stringify(afterInputs));
        report.assert('范围变化后标签更新', afterInputs.label.length > 6, afterInputs.label);

        // ---------- 预设：按选择天数缩放，仍可滚到最晚任务 ----------
        async function presetInfo() {
            return evaluate(client, `(function(){
                var state = NC.timeline.getState();
                var scroll = document.querySelector('.tl-scroll');
                var viewportWidth = scroll.clientWidth;
                var initialScrollLeft = Math.round(scroll.scrollLeft);
                scroll.scrollLeft = scroll.scrollWidth;
                var chips = document.querySelectorAll('.tl-task');
                var maxId = null, maxDue = -Infinity;
                chips.forEach(function(chip){
                    var due = Number(chip.getAttribute('data-due'));
                    if (due > maxDue) { maxDue = due; maxId = chip.getAttribute('data-id'); }
                });
                var target = document.querySelector('.tl-task[data-id="' + maxId + '"]');
                var sr = scroll.getBoundingClientRect();
                var tr = target ? target.getBoundingClientRect() : null;
                var result = {
                    range: state.range,
                    rangeDays: state.rangeDays,
                    dayWidth: state.dayWidth,
                    viewportWidth: viewportWidth,
                    initialScrollLeft: initialScrollLeft,
                    maxVisible: !!tr && tr.right <= sr.right + 1 && tr.right >= sr.left,
                    maxRightGap: tr ? Math.round(sr.right - tr.right) : null,
                    scrollMax: Math.round(scroll.scrollWidth - scroll.clientWidth)
                };
                scroll.scrollLeft = 0;
                return result;
            })()`);
        }
        for (const preset of [
            { id: 'next3', label: '未来 3 天', expectDays: 3 },
            { id: 'week', label: '本周', expectDays: 7 },
            { id: 'month', label: '本月', minDays: 27 }
        ]) {
            await evaluate(client, `(function(){ var btn = document.querySelector('.tl-preset[data-preset="${preset.id}"]'); if (btn) btn.click(); return true; })()`);
            await sleep(650);
            const info = await presetInfo();
            const span = info.rangeDays;
            if (preset.expectDays) {
                report.assert('预设「' + preset.label + '」按选择天数缩放',
                    Math.abs(span - preset.expectDays) < 0.02 &&
                    Math.abs(info.dayWidth - info.viewportWidth / span) <= 2 &&
                    info.initialScrollLeft <= 1,
                    JSON.stringify({ span: span.toFixed(2), dayWidth: Math.round(info.dayWidth), initialScrollLeft: info.initialScrollLeft }));
            } else {
                report.assert('预设「' + preset.label + '」按选择天数缩放',
                    span >= preset.minDays &&
                    Math.abs(info.dayWidth - info.viewportWidth / span) <= 2 &&
                    info.initialScrollLeft <= 1,
                    JSON.stringify({ span: span.toFixed(2), dayWidth: Math.round(info.dayWidth), initialScrollLeft: info.initialScrollLeft }));
            }
            report.assert('预设「' + preset.label + '」后仍可滚到最晚任务',
                info.maxVisible === true && info.maxRightGap != null && info.maxRightGap >= 0 && info.maxRightGap <= info.viewportWidth,
                JSON.stringify({ maxVisible: info.maxVisible, maxRightGap: info.maxRightGap, scrollMax: info.scrollMax }));
        }
        await evaluate(client, `(function(){ var btn = document.querySelector('.tl-preset[data-preset="reset"]'); if (btn) btn.click(); return true; })()`);
        await sleep(600);
        const resetState = await evaluate(client, '(function(){ var s = NC.timeline.getState(); return { range: s.range, rangeDays: s.rangeDays, scrollLeft: Math.round(document.querySelector(".tl-scroll").scrollLeft) }; })()');
        report.assert('重置回默认 5 天窗口（今天 00:00 起）',
            Math.abs(resetState.range.start - expected.range.start) <= 120000 &&
            Math.abs(resetState.rangeDays - 5) < 0.01 &&
            resetState.scrollLeft <= 1,
            JSON.stringify(resetState));

        // ---------- 左侧筛选联动：视图 / 清单 / 搜索 ----------
        const chipsAll = await evaluate(client, "document.querySelectorAll('.tl-task').length");
        const filterProbe = await evaluate(client, `(function(){
            NC.store.todo.setView('today');
            return true;
        })()`);
        await sleep(600);
        const todayFiltered = await evaluate(client, `(function(){
            var now = Date.now();
            var sel = NC.store.todo.selectVisible(now).tasks || [];
            function startOfDay(ts){ var d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
            var ids = Array.prototype.map.call(document.querySelectorAll('.tl-task'), function(el){ return el.getAttribute('data-id'); });
            function startOfDay(ts){ var d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
            var byId = Object.create(null);
            NC.store.todo.getDoc().tasks.forEach(function(t){ byId[t.id] = t; });
            var mismatched = ids.filter(function(id){
                var t = byId[id];
                return !t || typeof t.due !== 'number' || startOfDay(t.due) !== startOfDay(now);
            });
            return { chips: ids.length, mismatched: mismatched.length, view: NC.store.todo.getUi().view };
        })()`);
        report.assert('视图筛选「今天」生效',
            todayFiltered.view === 'today' && todayFiltered.chips >= 1 && todayFiltered.chips <= chipsAll && todayFiltered.mismatched === 0,
            JSON.stringify({ chips: todayFiltered.chips, mismatched: todayFiltered.mismatched, all: chipsAll }));
        await evaluate(client, 'NC.store.todo.setView("all"); true;');
        await sleep(500);
        await evaluate(client, 'NC.store.todo.setListFilter("list_work"); true;');
        await sleep(500);
        const listFiltered = await evaluate(client, `(function(){
            var ids = Array.prototype.map.call(document.querySelectorAll('.tl-task'), function(el){ return el.getAttribute('data-id'); });
            var doc = NC.store.todo.getDoc();
            var byId = Object.create(null);
            doc.tasks.forEach(function(t){ byId[t.id] = t; });
            var mismatched = ids.filter(function(id){ return !byId[id] || byId[id].listId !== 'list_work'; });
            return { chips: ids.length, mismatched: mismatched.length, list: NC.store.todo.getUi().listId };
        })()`);
        report.assert('清单筛选生效', listFiltered.list === 'list_work' && listFiltered.chips >= 1 && listFiltered.mismatched === 0,
            JSON.stringify(listFiltered));
        await evaluate(client, 'NC.store.todo.setListFilter(null); true;');
        await sleep(400);
        await evaluate(client, 'NC.store.todo.setSearch("E2E 专属"); true;');
        await sleep(500);
        const searchFiltered = await evaluate(client, `(function(){
            var ids = Array.prototype.map.call(document.querySelectorAll('.tl-task'), function(el){ return el.getAttribute('data-id'); });
            return { chips: ids.length, ids: ids, search: NC.store.todo.getUi().search };
        })()`);
        report.assert('搜索筛选生效', searchFiltered.search === 'E2E 专属' && searchFiltered.chips === 1 && searchFiltered.ids[0] === 'tl-filter-work',
            JSON.stringify(searchFiltered));
        await evaluate(client, 'NC.store.todo.setSearch(""); true;');
        await sleep(500);
        report.assert('筛选复位后恢复全量', (await evaluate(client, "document.querySelectorAll('.tl-task').length")) === chipsAll,
            'all=' + chipsAll);

        // ---------- 框选（真实指针拖拽） ----------
        const resetSpan = await evaluate(client, '(function(){ var r = NC.timeline.getState().range; return r.end - r.start; })()');
        const brushRect = JSON.parse(await evaluate(client, `(function(){
            var layer = document.querySelector('.tl-brush-layer');
            var rect = layer.getBoundingClientRect();
            return JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        })()`));
        // 长范围时画布可能宽于视口且已滚动到「现在」附近：只在可见区内框选
        const visibleLeft = Math.max(brushRect.left, 0) + 20;
        const visibleRight = Math.min(brushRect.left + brushRect.width, 1440) - 20;
        const x1 = visibleLeft + (visibleRight - visibleLeft) * 0.25;
        const x2 = visibleLeft + (visibleRight - visibleLeft) * 0.55;
        const y = Math.max(brushRect.top + brushRect.height * 0.6, 60);
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x1 + x2) / 2, y, button: 'left', buttons: 1 });
        await sleep(120);
        const duringBrush = await evaluate(client, `(function(){
            var live = document.querySelector('.tl-brush-live');
            var tip = document.querySelector('.tl-brush-tip');
            return { live: !!live && !live.hidden, tip: !!tip && !tip.hidden, tipText: tip ? tip.textContent : '' };
        })()`);
        report.assert('框选拖动实时高亮', duringBrush.live && duringBrush.tip, JSON.stringify(duringBrush));
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x2, y, button: 'left', buttons: 1 });
        await sleep(120);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y, button: 'left', clickCount: 1 });
        await sleep(600);
        const brushedInfo = JSON.parse(await evaluate(client, '(function(){ var s = NC.timeline.getState(); return JSON.stringify({ range: s.range, rangeDays: s.rangeDays, scrollLeft: Math.round(document.querySelector(".tl-scroll").scrollLeft) }); })()'));
        const brushFraction = (brushedInfo.range.end - brushedInfo.range.start) / resetSpan;
        report.assert('框选松开生效（范围变窄并回到范围开始）',
            brushFraction > 0.05 && brushFraction < 0.95 && brushedInfo.scrollLeft <= 1,
            JSON.stringify({ fraction: Number(brushFraction.toFixed(2)), scrollLeft: brushedInfo.scrollLeft, x1: x1, x2: x2 }));
        const liveHidden = await evaluate(client, "(function(){ var el = document.querySelector('.tl-brush-live'); return !el || el.hidden; })()");
        report.assert('框选完成后高亮隐藏', liveHidden);

        // 双击重置（使用可见区中心，画布可能远宽于视口）
        const dblX = visibleLeft + (visibleRight - visibleLeft) * 0.5;
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblX, y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblX, y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblX, y, button: 'left', clickCount: 2 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblX, y, button: 'left', clickCount: 2 });
        await sleep(500);
        const dblInfo = JSON.parse(await evaluate(client, '(function(){ var s = NC.timeline.getState(); return JSON.stringify({ range: s.range, rangeDays: s.rangeDays, scrollLeft: Math.round(document.querySelector(".tl-scroll").scrollLeft) }); })()'));
        report.assert('双击刻度区重置为默认 5 天窗口',
            Math.abs(dblInfo.range.start - expected.range.start) <= 120000 &&
            Math.abs(dblInfo.rangeDays - 5) < 0.01 && dblInfo.scrollLeft <= 1,
            JSON.stringify(dblInfo));

        // ---------- 显示已完成开关：默认隐藏 → 打开出现 → 关闭消失 ----------
        const doneBefore = await evaluate(client, "document.querySelectorAll('.tl-task.is-done').length");
        const canceledBefore = await evaluate(client, "document.querySelectorAll('.tl-task.is-canceled').length");
        await evaluate(client, `(function(){ var input = document.querySelector('.tl-switch input'); if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
        await sleep(600);
        const shown = await evaluate(client, "(function(){ return { done: document.querySelectorAll('.tl-task.is-done').length, canceled: document.querySelectorAll('.tl-task.is-canceled').length }; })()");
        report.assert('打开「显示已完成」后出现已完成/取消条',
            doneBefore === 0 && canceledBefore === 0 && shown.done >= 1 && shown.canceled >= 1,
            JSON.stringify({ before: { done: doneBefore, canceled: canceledBefore }, after: shown }));
        await evaluate(client, `(function(){ var input = document.querySelector('.tl-switch input'); if (input) { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
        await sleep(500);
        const hiddenAgain = await evaluate(client, "(function(){ return { done: document.querySelectorAll('.tl-task.is-done').length, canceled: document.querySelectorAll('.tl-task.is-canceled').length }; })()");
        report.assert('关闭开关后已完成/取消条消失', hiddenAgain.done === 0 && hiddenAgain.canceled === 0, JSON.stringify(hiddenAgain));

        // ---------- refresh / 数据更新 ----------
        const chipsBeforeRefresh = await evaluate(client, "document.querySelectorAll('.tl-task').length");
        await evaluate(client, `(function(){
            NC.store.todo.addTask({ title: 'E2E 新增时间线任务', due: Date.now() + 3600000, priority: 'high' });
            return true;
        })()`);
        await sleep(700);
        const chipsAfterRefresh = await evaluate(client, `(function(){
            NC.timeline.refresh();
            return document.querySelectorAll('.tl-task').length;
        })()`);
        report.assert('数据更新后 refresh 增加渲染', chipsAfterRefresh > chipsBeforeRefresh,
            JSON.stringify({ before: chipsBeforeRefresh, after: chipsAfterRefresh }));

        // ---------- 性能 ----------
        const perf = await evaluate(client, `(function(){
            var t0 = performance.now();
            NC.timeline.refresh();
            return { elapsed: Math.round(performance.now() - t0), chips: document.querySelectorAll('.tl-task').length,
                     tasks: NC.store.todo.getDoc().tasks.length };
        })()`);
        report.assert('500 条数据下渲染可用', perf.tasks >= 500 && perf.chips > 0 && perf.elapsed < 1200,
            JSON.stringify(perf));

        // ---------- 响应式：390 纵向时间流水 ----------
        await setMetrics(client, 390, 844, true);
        await sleep(700);
        const vertical = await evaluate(client, `(function(){
            var state = NC.timeline.getState();
            var groups = document.querySelectorAll('.tl-agenda__group');
            return {
                mode: state.mode,
                rootMode: document.querySelector('.tl-root').getAttribute('data-mode'),
                groups: groups.length,
                rows: document.querySelectorAll('.tl-agenda__row').length,
                agendaVisible: (function(){ var el = document.querySelector('.tl-agenda'); return el && !el.hidden; })(),
                hncHidden: (function(){ var el = document.querySelector('.tl-hnc'); return el && el.hidden; })(),
                docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                inputsVisible: !!document.querySelector('.tl-field__input')
            };
        })()`);
        report.assert('390 宽切换纵向时间流水', vertical.mode === 'v' && vertical.rootMode === 'v' && vertical.agendaVisible,
            JSON.stringify(vertical));
        report.assert('纵向按天分组', vertical.groups >= 1 && vertical.rows >= 1, JSON.stringify(vertical));
        report.assert('纵向模式无横向溢出', vertical.docOverflow <= 1, String(vertical.docOverflow));
        report.assert('纵向保留范围控件', vertical.inputsVisible);

        const verticalDetail = await evaluate(client, `(function(){
            var rows = document.querySelectorAll('.tl-agenda__row');
            var first = rows[0];
            var rangeText = first ? (first.querySelector('.tl-agenda__range') || {}).textContent : '';
            var inputs = Array.prototype.map.call(document.querySelectorAll('.tl-field__input'), function(el){
                var r = el.getBoundingClientRect();
                return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
            });
            var container = document.querySelector('.tl-root').getBoundingClientRect();
            var presets = document.querySelector('.tl-presets');
            var extra = document.querySelector('.tl-extra');
            return {
                rows: rows.length,
                rangeText: rangeText || '',
                aria: first ? first.getAttribute('aria-label') : '',
                inputs: inputs,
                containerWidth: container.width,
                presetsWidth: presets ? presets.getBoundingClientRect().width : 0,
                extraWidth: extra ? extra.getBoundingClientRect().width : 0,
                docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                noDueBlocks: document.querySelectorAll('.tl-nodue').length,
                noDueText: (document.querySelector('.tl-root') || document.body).textContent.indexOf('无日期') > -1
            };
        })()`);
        report.assert('纵向行包含创建→到期区间信息',
            verticalDetail.rows >= 1 && verticalDetail.rangeText.indexOf('→') > -1 &&
            /创建 .* → 到期 .*（时长/.test(verticalDetail.aria),
            JSON.stringify({ range: verticalDetail.rangeText, aria: verticalDetail.aria.slice(0, 80) }));
        report.assert('纵向无日期任务不出现', verticalDetail.noDueBlocks === 0 && verticalDetail.noDueText === false,
            JSON.stringify({ blocks: verticalDetail.noDueBlocks, text: verticalDetail.noDueText }));
        report.assert('纵向范围输入等宽（堆叠整齐）',
            verticalDetail.inputs.length === 2 &&
            Math.abs(verticalDetail.inputs[0].width - verticalDetail.inputs[1].width) <= 1 &&
            verticalDetail.inputs[0].width > verticalDetail.containerWidth * 0.35 &&
            verticalDetail.inputs[0].top !== verticalDetail.inputs[1].top,
            JSON.stringify(verticalDetail.inputs));
        report.assert('纵向预设/开关行等宽铺满且无横向溢出',
            Math.abs(verticalDetail.presetsWidth - verticalDetail.extraWidth) <= 2 &&
            verticalDetail.presetsWidth > verticalDetail.containerWidth * 0.6 &&
            verticalDetail.docOverflow <= 1,
            JSON.stringify({ presets: Math.round(verticalDetail.presetsWidth), extra: Math.round(verticalDetail.extraWidth), container: Math.round(verticalDetail.containerWidth), overflow: verticalDetail.docOverflow }));

        // 纵向任务点击
        await evaluate(client, `(function(){ var row = document.querySelector('.tl-agenda__row'); if (row) row.click(); return true; })()`);
        await sleep(400);
        const agendaSelected = await evaluate(client, 'JSON.stringify(NC.store.todo.getUi().selectedId)');
        report.assert('纵向任务点击 → selectTask', JSON.parse(agendaSelected) != null, agendaSelected);
        await evaluate(client, 'NC.store.todo.clearSelection(); true;');

        // ---------- 截图：标准/浅色/Lite × 1440/390（默认 / 最右 / 未来 3 天 / 本周） ----------
        const shotModes = [
            { theme: 'standard', label: 'standard' },
            { theme: 'light', label: 'light' },
            { theme: 'lite', label: 'lite' }
        ];
        for (const shotMode of shotModes) {
            for (const viewport of [{ width: 1440, height: 900, mobile: false, label: '1440' }, { width: 390, height: 844, mobile: true, label: '390' }]) {
                await setMetrics(client, viewport.width, viewport.height, viewport.mobile);
                await navigate(client, URL_NTOOLS);
                await waitFor(client, "!!(window.NC && NC.store && NC.store.todo)", 10000);
                await seedStore(client, buildMockDoc(Date.now()));
                await sleep(500);
                await loadTimelineAssets(client);
                await setTheme(client, shotMode.theme);
                await mountTimeline(client);
                await sleep(900);
                // 默认（范围开始）
                await evaluate(client, "(function(){ var s = document.querySelector('.tl-scroll'); if (s) s.scrollLeft = 0; return true; })()");
                await sleep(200);
                shots.push(await shot(client, 'timeline-' + shotMode.label + '-' + viewport.label + '-default.png'));
                // 滚到最右（最晚任务）
                await evaluate(client, "(function(){ var s = document.querySelector('.tl-scroll'); if (s) s.scrollLeft = s.scrollWidth; return true; })()");
                await sleep(260);
                shots.push(await shot(client, 'timeline-' + shotMode.label + '-' + viewport.label + '-rightmost.png'));
                // 未来 3 天
                await evaluate(client, "(function(){ var b = document.querySelector('.tl-preset[data-preset=next3]'); if (b) b.click(); return true; })()");
                await sleep(650);
                shots.push(await shot(client, 'timeline-' + shotMode.label + '-' + viewport.label + '-next3.png'));
                // 本周
                await evaluate(client, "(function(){ var b = document.querySelector('.tl-preset[data-preset=week]'); if (b) b.click(); return true; })()");
                await sleep(650);
                shots.push(await shot(client, 'timeline-' + shotMode.label + '-' + viewport.label + '-week.png'));
            }
        }

        // ---------- 页面内集成（A/Lead 已接线：列表/全景切换） ----------
        await setMetrics(client, 1440, 900, false);
        await navigate(client, URL_NTOOLS);
        await waitFor(client, "!!(window.NC && NC.store && NC.store.todo)", 10000);
        await evaluate(client, 'localStorage.clear(); true;');
        await navigate(client, URL_NTOOLS);
        await waitFor(client, "!!(window.NC && NC.store && NC.store.todo)", 10000);
        const integrationDoc = buildMockDoc(Date.now());
        integrationDoc.tasks = integrationDoc.tasks.slice(0, 24);
        await seedStore(client, integrationDoc);
        await sleep(500);
        const modeBtn = await evaluate(client, `(function(){
            var btn = document.querySelector('[data-mode="timeline"]');
            if (!btn) return 'missing';
            btn.click();
            return 'clicked';
        })()`);
        report.assert('页面内「全景」模式入口存在', modeBtn === 'clicked', String(modeBtn));
        const inPageReady = await waitFor(client, "!!document.querySelector('#todo-timeline .tl-root')", 8000);
        report.assert('切换到全景后挂载时间线', inPageReady);
        await sleep(700);
        const inPage = await evaluate(client, `(function(){
            var container = document.getElementById('todo-timeline');
            var root = document.querySelector('#todo-timeline .tl-root');
            return {
                container: !!container,
                hidden: container ? container.hidden : null,
                root: !!root,
                mode: window.NC.timeline.getState().mode,
                chips: document.querySelectorAll('#todo-timeline .tl-task').length,
                viewMode: NC.store.todo.getDoc().settings.viewMode,
                rect: container ? { w: Math.round(container.getBoundingClientRect().width), h: Math.round(container.getBoundingClientRect().height) } : null
            };
        })()`);
        report.assert('页面内时间线渲染（#todo-timeline）',
            inPage.container && inPage.hidden === false && inPage.root && inPage.chips > 0 && inPage.viewMode === 'timeline',
            JSON.stringify(inPage));
        const inPageShot = await shot(client, 'inpage-timeline-standard-1440.png');
        shots.push(inPageShot);
        await setMetrics(client, 390, 844, true);
        await sleep(800);
        const inPageMobile = await evaluate(client, `(function(){
            return {
                mode: window.NC.timeline.getState().mode,
                agenda: document.querySelectorAll('#todo-timeline .tl-agenda__group').length,
                docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
            };
        })()`);
        report.assert('页面内 390 纵向流水', inPageMobile.mode === 'v' && inPageMobile.agenda >= 1 && inPageMobile.docOverflow <= 1,
            JSON.stringify(inPageMobile));
        const inPageMobileShot = await shot(client, 'inpage-timeline-standard-390.png');
        shots.push(inPageMobileShot);
        // 切回列表 → unmount
        await evaluate(client, `(function(){ var btn = document.querySelector('[data-mode="list"]'); if (btn) btn.click(); return true; })()`);
        await sleep(700);
        const backToList = await evaluate(client, `(function(){
            return {
                root: document.querySelectorAll('#todo-timeline .tl-root').length,
                viewMode: NC.store.todo.getDoc().settings.viewMode,
                mounted: NC.timeline.isMounted()
            };
        })()`);
        report.assert('切回列表自动 unmount', backToList.root === 0 && backToList.viewMode === 'list' && backToList.mounted === false,
            JSON.stringify(backToList));

        // ---------- unmount ----------
        await setMetrics(client, 1440, 900, false);
        await navigate(client, URL_NTOOLS);
        await waitFor(client, "!!(window.NC && NC.store && NC.store.todo)", 10000);
        await loadTimelineAssets(client);
        await mountTimeline(client);
        await sleep(500);
        const mountedBefore = await evaluate(client, "document.querySelectorAll('.tl-root').length");
        await evaluate(client, 'NC.timeline.unmount(); true;');
        await sleep(300);
        const mountedAfter = await evaluate(client, "document.querySelectorAll('.tl-root').length");
        report.assert('unmount 清理 DOM', mountedBefore === 1 && mountedAfter === 0, JSON.stringify({ before: mountedBefore, after: mountedAfter }));
    } catch (err) {
        report.assert('E2E 运行未抛异常', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
    } finally {
        const elapsed = Date.now() - startedAt;
        const failed = report.summary();
        const consoleErrors = client ? client.consoleErrors : [];
        if (consoleErrors.length) {
            console.log('\n页面 console.error / 未捕获异常（' + consoleErrors.length + '）：');
            consoleErrors.slice(0, 8).forEach((item) => console.log('  - ' + item));
        } else {
            console.log('\n页面 console.error：0');
        }
        if (shots.length) console.log('截图：' + shots.length + ' 张 → ' + SHOT_DIR);
        const total = report.results.length;
        console.log('\n结果: ' + (total - failed) + '/' + total + ' 通过，' + failed + ' 失败，耗时 ' + elapsed + 'ms' +
            (consoleErrors.length ? '，console.error ' + consoleErrors.length + ' 条' : ''));
        try { chrome.kill('SIGKILL'); } catch (err) { /* ignore */ }
        try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
        if (client) { try { client.ws.close(); } catch (err) { /* ignore */ } }
        process.exit(failed === 0 && consoleErrors.length === 0 ? 0 : 1);
    }
}

main();
