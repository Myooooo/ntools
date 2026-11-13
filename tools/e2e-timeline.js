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
 *  7. 范围外计数 / 无日期区 / 显示已完成开关 / 暂停渲染计数
 *  8. 截图：标准/浅色/Lite × 1440/390 → /tmp/nc-shots/v4/timeline/
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
const SHOT_DIR = process.env.TIMELINE_SHOT_DIR || '/tmp/nc-shots/v4/timeline';
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
        base.tasks.push(Object.assign({
            id: 'tl-' + seq,
            listId: 'list_default',
            title: '时间线任务 ' + seq,
            notes: '',
            status: 'open',
            priority: 'normal',
            due: null,
            dueAllDay: false,
            tags: [],
            subtasks: [],
            recurrence: null,
            reminder: null,
            order: seq * 1024,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            deletedAt: null,
            source: 'e2e-timeline'
        }, patch));
        return base.tasks[base.tasks.length - 1];
    };

    // 范围内：置顶 + 高优先级 + 多标签 + 长标题（59 字）
    push({
        id: 'tl-pin', title: '与华东区域三家供应商确认第四季度交付排期，并同步采购、法务、财务三个部门的审批节点与应急预案（含备选供应商与到货缓冲）',
        pinned: true, priority: 'urgent', due: round(now + 2 * HOUR), tags: ['采购', '法务', '财务', '交付', '供应商', '审批', '例会', '季度'],
        listId: 'list_work'
    });
    // 循环任务
    push({
        id: 'tl-repeat', title: '每周合规巡检复盘', status: 'open', priority: 'high', due: round(now + 6 * HOUR),
        recurrence: { freq: 'weekly', interval: 1, byWeekday: [(new Date(now).getDay() + 1) % 7], until: null, count: null, lastMaterializedAt: now },
        tags: ['合规']
    });
    // 逾期（open）
    push({ id: 'tl-overdue', title: '处理逾期安全巡检整改', priority: 'urgent', due: round(now - 2 * HOUR) });
    // 已完成 / 已取消（范围内，弱化）
    push({ id: 'tl-done', title: '提交上周周报', status: 'done', completedAt: now - HOUR, due: round(now + 4 * HOUR) });
    push({ id: 'tl-canceled', title: '取消的供应商拜访', status: 'canceled', due: round(now + 26 * HOUR) });
    // 未来 7 天其余任务（每隔两小时一条，共 20 条）
    for (let i = 0; i < 20; i += 1) {
        push({
            title: '时间线样例任务 ' + (i + 1),
            due: round(now + (3 + i * 3) * HOUR),
            priority: i % 4 === 0 ? 'high' : (i % 5 === 0 ? 'low' : 'normal'),
            tags: i % 3 === 0 ? ['工作'] : [],
            listId: i % 2 ? 'list_work' : 'list_default'
        });
    }
    // 无日期任务（3 条）
    for (let i = 0; i < 3; i += 1) push({ title: '无日期任务 ' + (i + 1), due: null });
    // 范围外：过去/未来较远（用于范围外计数）
    push({ id: 'tl-out-past', title: '上季度归档复盘', due: round(now - 40 * DAY) });
    push({ id: 'tl-out-future', title: '下季度供应商招标', due: round(now + 20 * DAY) });
    push({ id: 'tl-out-future2', title: '年度审计准备', due: round(now + 60 * DAY) });
    // 500 条总量：其余为远期任务（范围外，不进入时间线）
    while (base.tasks.length < 500) {
        push({
            title: '远期任务 ' + (base.tasks.length + 1),
            due: round(now + (90 + (base.tasks.length % 240)) * DAY),
            listId: 'list_default'
        });
    }
    return base;
}

function expectedCounts(doc, now) {
    const range = { start: now, end: now + 7 * DAY };
    const withDue = doc.tasks.filter((task) => typeof task.due === 'number');
    const inRange = withDue.filter((task) => task.due >= range.start && task.due <= range.end);
    const edge = withDue.filter((task) => task.due < range.start && task.status === 'open').slice(0, 12);
    return {
        total: doc.tasks.length,
        withDue: withDue.length,
        inRange: inRange.length,
        edgeOverdue: edge.length,
        visible: inRange.length + edge.length,
        outRange: withDue.length - inRange.length - edge.length,
        noDue: doc.tasks.filter((task) => task.due == null && task.status === 'open').length
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
            return {
                mode: state.mode,
                range: state.range,
                rootMode: root ? root.getAttribute('data-mode') : null,
                hasAxis: !!document.querySelector('.tl-axis'),
                hasBrush: !!document.querySelector('.tl-brush-layer'),
                startInput: (document.querySelector('.tl-field__input') || {}).value || null,
                chips: document.querySelectorAll('.tl-task').length,
                noDueChips: document.querySelectorAll('.tl-nodue__chip').length,
                noDueText: (document.querySelector('.tl-nodue') || {}).textContent || '',
                statsText: (document.querySelector('.tl-stats') || {}).textContent || '',
                nowHidden: (document.querySelector('.tl-now') || {}).hidden,
                counts: state.counts
            };
        })()`);
        report.assert('横向模式（1440 容器）', shape.mode === 'h' && shape.rootMode === 'h', JSON.stringify(shape));
        report.assert('默认范围约未来 7 天', shape.range && Math.abs((shape.range.end - shape.range.start) - 7 * DAY) < 60000,
            JSON.stringify(shape.range));
        report.assert('刻度区/框选层存在', shape.hasAxis && shape.hasBrush);
        report.assert('范围内任务渲染', shape.chips === Math.min(expected.visible, 220) && shape.chips === shape.counts.visible,
            JSON.stringify({ chips: shape.chips, expected: expected.visible, stateVisible: shape.counts.visible }));
        report.assert('顶部输入与范围同步', !!shape.startInput, shape.startInput);
        report.assert('范围外计数已显示', shape.statsText.indexOf(String(expected.outRange)) > -1, shape.statsText.slice(0, 120));
        report.assert('无日期区显示', shape.noDueChips >= 3 && shape.noDueText.indexOf('无日期') > -1, JSON.stringify({ chips: shape.noDueChips, text: shape.noDueText.slice(0, 80) }));
        report.assert('“现在”指示线可见', shape.nowHidden === false);

        const badges = await evaluate(client, `(function(){
            return {
                pinned: document.querySelectorAll('.tl-task.is-pinned').length,
                recurring: document.querySelectorAll('.tl-task.is-recurring').length,
                overdue: document.querySelectorAll('.tl-task.is-overdue').length,
                done: document.querySelectorAll('.tl-task.is-done').length,
                canceled: document.querySelectorAll('.tl-task.is-canceled').length,
                highPrio: document.querySelectorAll('.tl-task.is-prio-high, .tl-task.is-prio-urgent').length,
                edge: document.querySelectorAll('.tl-task.is-edge-overdue').length
            };
        })()`);
        report.assert('置顶标识', badges.pinned >= 1, JSON.stringify(badges));
        report.assert('循环标识', badges.recurring >= 1, JSON.stringify(badges));
        report.assert('逾期标识（范围左缘固定）', badges.overdue >= 1 && badges.edge >= 1, JSON.stringify(badges));
        report.assert('已完成/取消弱化', badges.done >= 1 && badges.canceled >= 1, JSON.stringify(badges));

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

        // ---------- 预设 ----------
        for (const preset of [{ id: 'next3', days: 3 }, { id: 'month', minDays: 27 }]) {
            await evaluate(client, `(function(){
                var btn = document.querySelector('.tl-preset[data-preset="${preset.id}"]');
                if (btn) btn.click();
                return true;
            })()`);
            await sleep(500);
            const presetState = await evaluate(client, 'JSON.stringify(NC.timeline.getState().range)');
            const range = JSON.parse(presetState);
            const span = (range.end - range.start) / DAY;
            if (preset.days) report.assert('预设「未来 3 天」', Math.abs(span - preset.days) < 0.02, 'span=' + span.toFixed(2));
            else report.assert('预设「本月」', span >= preset.minDays, 'span=' + span.toFixed(2));
        }
        await evaluate(client, `(function(){ var btn = document.querySelector('.tl-preset[data-preset="reset"]'); if (btn) btn.click(); return true; })()`);
        await sleep(500);
        const resetRange = JSON.parse(await evaluate(client, 'JSON.stringify(NC.timeline.getState().range)'));
        report.assert('重置回未来 7 天', Math.abs((resetRange.end - resetRange.start) / DAY - 7) < 0.02,
            ((resetRange.end - resetRange.start) / DAY).toFixed(2));

        // ---------- 框选（真实指针拖拽） ----------
        const brushRect = JSON.parse(await evaluate(client, `(function(){
            var layer = document.querySelector('.tl-brush-layer');
            var rect = layer.getBoundingClientRect();
            return JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        })()`));
        const x1 = brushRect.left + brushRect.width * 0.25;
        const x2 = brushRect.left + brushRect.width * 0.55;
        const y = brushRect.top + brushRect.height * 0.6;
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
        const brushedRange = JSON.parse(await evaluate(client, 'JSON.stringify(NC.timeline.getState().range)'));
        const brushSpan = (brushedRange.end - brushedRange.start) / (7 * DAY);
        report.assert('框选松开生效（范围变窄）', brushSpan > 0.05 && brushSpan < 0.95, 'span=' + (brushSpan * 7 * 24).toFixed(1) + 'h');
        const liveHidden = await evaluate(client, "(function(){ var el = document.querySelector('.tl-brush-live'); return !el || el.hidden; })()");
        report.assert('框选完成后高亮隐藏', liveHidden);

        // 双击重置
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: brushRect.left + brushRect.width * 0.5, y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: brushRect.left + brushRect.width * 0.5, y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: brushRect.left + brushRect.width * 0.5, y, button: 'left', clickCount: 2 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: brushRect.left + brushRect.width * 0.5, y, button: 'left', clickCount: 2 });
        await sleep(500);
        const dblRange = JSON.parse(await evaluate(client, 'JSON.stringify(NC.timeline.getState().range)'));
        report.assert('双击刻度区重置范围', Math.abs((dblRange.end - dblRange.start) / DAY - 7) < 0.02,
            ((dblRange.end - dblRange.start) / DAY).toFixed(2) + ' 天');

        // ---------- 显示已完成开关 ----------
        const doneBefore = await evaluate(client, "document.querySelectorAll('.tl-task.is-done').length");
        await evaluate(client, `(function(){ var input = document.querySelector('.tl-switch input'); if (input) { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
        await sleep(500);
        const doneAfterHide = await evaluate(client, "document.querySelectorAll('.tl-task.is-done').length");
        report.assert('隐藏已完成开关', doneBefore >= 1 && doneAfterHide === 0, JSON.stringify({ before: doneBefore, after: doneAfterHide }));
        await evaluate(client, `(function(){ var input = document.querySelector('.tl-switch input'); if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
        await sleep(300);

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

        // 纵向任务点击
        await evaluate(client, `(function(){ var row = document.querySelector('.tl-agenda__row'); if (row) row.click(); return true; })()`);
        await sleep(400);
        const agendaSelected = await evaluate(client, 'JSON.stringify(NC.store.todo.getUi().selectedId)');
        report.assert('纵向任务点击 → selectTask', JSON.parse(agendaSelected) != null, agendaSelected);
        await evaluate(client, 'NC.store.todo.clearSelection(); true;');

        // ---------- 截图：标准/浅色/Lite × 1440/390 ----------
        for (const theme of ['standard', 'light', 'lite']) {
            for (const viewport of [{ width: 1440, height: 900, mobile: false, label: '1440' }, { width: 390, height: 844, mobile: true, label: '390' }]) {
                await setMetrics(client, viewport.width, viewport.height, viewport.mobile);
                await navigate(client, URL_NTOOLS);
                await waitFor(client, "!!(window.NC && NC.store && NC.store.todo)", 10000);
                await seedStore(client, buildMockDoc(Date.now()));
                await sleep(500);
                await evaluate(client, `(function(){
                    var doc = NC.store.todo.getDoc();
                    var pin = doc.tasks.filter(function(t){ return t.id === 'tl-pin'; })[0];
                    if (pin) pin.pinned = true;
                    return true;
                })()`);
                await loadTimelineAssets(client);
                await setTheme(client, theme);
                await mountTimeline(client);
                await sleep(900);
                const file = await shot(client, 'timeline-' + theme + '-' + viewport.label + '.png');
                shots.push(file);
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
