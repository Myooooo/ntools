#!/usr/bin/env node
/**
 * tools/e2e-v41.js — v4.1 交互与 Todo 新功能验收（CDP 无头 Chrome，file://，无网络）
 *
 * 覆盖：
 *  - Todo 右上菜单重复点击不叠放（含全局 ui.openMenu 单例）
 *  - 设置改为居中弹窗（几何居中、非右侧滑出）
 *  - 侧边栏可收起：宽度、底部只留设置、持久化、可展开
 *  - 新建按钮不再含 N，快捷键提示移到底部
 *  - 置顶：排序/分组/持久化
 *  - 循环任务：完成后 due 前移且仍为 open
 *  - 三天内到期热区渐变（24h/48h/72h/更远；完成项不染色）
 *  - 列表/全景模式切换（时间线 mount/unmount、横向模式）
 *
 * 用法：node tools/e2e-v41.js
 * 退出码：0 全部通过；1 有失败。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = path.resolve(__dirname, '..');
const URL_NTOOLS = 'file://' + path.join(ROOT, 'ntools.html').split(path.sep).join('/') + '?demo=1';
const PORT = 9881 + (process.pid % 100);
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

async function main() {
    if (!fs.existsSync(CHROME)) {
        console.error('Chrome not found: ' + CHROME);
        process.exit(2);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-e2e41-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    const results = [];
    const errors = [];

    function assert(name, pass, detail) {
        results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
        return !!pass;
    }

    let client = null;
    try {
        for (let i = 0; i < 150; i++) {
            try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch (err) { await sleep(100); }
        }
        const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        client = new Client(ws);
        client.handlers.push((message) => {
            if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                errors.push('exception: ' + ((details.exception && details.exception.description) || details.text));
            }
            if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
                errors.push('console.error: ' + (message.params.args || []).map((arg) => arg.value || arg.description || '').join(' ').slice(0, 200));
            }
        });
        await client.send('Runtime.enable');
        await client.send('Page.enable');
        await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

        async function evaluate(expression) {
            const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
            if (result.exceptionDetails) {
                throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text);
            }
            return result.result.value;
        }

        async function navigate(url) {
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
            await sleep(1100);
        }

        async function reload() {
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
            await client.send('Page.reload', { ignoreCache: true });
            await loaded;
            await sleep(1000);
        }

        await navigate(URL_NTOOLS);

        /* ---------------- 1. 菜单重复点击 ---------------- */
        await evaluate(`(function(){ var b=document.getElementById('todo-menu-btn'); for (var i=0;i<3;i++) b.click(); return true; })()`);
        await sleep(350);
        const menuState = await evaluate(`(function(){
            return {
                menus: document.querySelectorAll('.nc-menu').length,
                visible: Array.prototype.filter.call(document.querySelectorAll('.nc-menu'), function(m){ return !m.classList.contains('is-closing'); }).length
            };
        })()`);
        assert('Todo 菜单重复点击不叠放', menuState.visible <= 1, JSON.stringify(menuState));
        await evaluate(`(function(){ document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
        await sleep(300);
        assert('菜单可关闭', (await evaluate("document.querySelectorAll('.nc-menu').length")) === 0);

        /* ---------------- 2. 设置居中弹窗 ---------------- */
        await evaluate(`(function(){ NC.settingsPanel.open('profiles'); return true; })()`);
        await sleep(500);
        const settingsGeom = await evaluate(`(function(){
            var p=document.querySelector('.settings-sheet__panel');
            var r=p.getBoundingClientRect();
            return {
                w: Math.round(r.width), h: Math.round(r.height),
                cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2),
                vw: innerWidth, vh: innerHeight,
                transform: getComputedStyle(p).transform
            };
        })()`);
        assert('设置为居中弹窗', Math.abs(settingsGeom.cx - settingsGeom.vw / 2) <= 6 && Math.abs(settingsGeom.cy - settingsGeom.vh / 2) <= 6, JSON.stringify(settingsGeom));
        assert('设置窗口非右侧贴边', settingsGeom.w < settingsGeom.vw - 40 && settingsGeom.h < settingsGeom.vh - 20, settingsGeom.w + '×' + settingsGeom.h);
        await evaluate(`(function(){ NC.settingsPanel.close(); return true; })()`);
        await sleep(400);

        /* ---------------- 3. 侧边栏收起 ---------------- */
        await evaluate(`(function(){ document.getElementById('rail-toggle-btn').click(); return true; })()`);
        await sleep(500);
        await sleep(500);
        const rail = await evaluate(`(function(){
            var rail=document.querySelector('.tools-rail');
            var foot=document.querySelector('.tools-rail__foot');
            var visible = Array.prototype.filter.call(foot.querySelectorAll(':scope > *'), function(el){ var s=getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; });
            return { w: Math.round(rail.getBoundingClientRect().width), cls: document.getElementById('tools-app').className,
                     visibleFoot: visible.map(function(el){return el.id||el.className;}) };
        })()`);
        assert('侧边栏可收起为图标', rail.w < 100 && rail.cls.indexOf('is-rail-collapsed') > -1, JSON.stringify(rail));
        assert('收起后底部只保留设置按钮', rail.visibleFoot.length === 1 && rail.visibleFoot[0] === 'settings-btn', JSON.stringify(rail.visibleFoot));
        await reload();
        const railPersist = await evaluate(`(function(){
            return { collapsed: document.getElementById('tools-app').classList.contains('is-rail-collapsed'),
                     w: Math.round(document.querySelector('.tools-rail').getBoundingClientRect().width) };
        })()`);
        assert('侧边栏状态持久化', railPersist.collapsed && railPersist.w < 100, JSON.stringify(railPersist));
        await evaluate(`(function(){ document.getElementById('rail-toggle-btn').click(); return true; })()`);
        await sleep(400);

        /* ---------------- 4. 新建按钮 / 快捷键提示 ---------------- */
        const addBtn = await evaluate(`(function(){
            var b=document.getElementById('todo-add-btn');
            return { text: b.textContent.trim(), hasKbd: !!b.querySelector('.nc-kbd') };
        })()`);
        assert('新建按钮去掉 N 快捷键', !addBtn.hasKbd && addBtn.text.indexOf('N') === -1, JSON.stringify(addBtn));
        const footer = await evaluate("(document.querySelector('.todo-foot__hints')||{}).textContent||''");
        assert('底部提示包含 N 新建与 / 搜索', footer.indexOf('N') > -1 && footer.indexOf('新建') > -1 && footer.indexOf('/') > -1, footer.replace(/\s+/g, ' ').slice(0, 100));

        /* ---------------- 5. 置顶 ---------------- */
        const pinResult = await evaluate(`(function(){
            var store = NC.store.todo;
            var tasks = store.getDoc().tasks.filter(function(t){ return !t.deletedAt && t.status !== 'done'; });
            if (!tasks.length) return { error: 'no tasks' };
            var target = tasks[tasks.length - 1];
            store.togglePin(target.id);
            var visible = store.selectVisible(Date.now()).tasks;
            return {
                pinned: store.getTask(target.id).pinned,
                targetId: target.id,
                firstId: visible[0] ? visible[0].id : null,
                firstPinned: visible[0] ? visible[0].pinned === true : false,
                groupPinned: !!document.querySelector('.todo-group[data-group="pinned"]'),
                firstRowPinned: !!document.querySelector('.todo-item.is-pinned')
            };
        })()`);
        assert('置顶后排序到置顶组', pinResult.pinned === true && pinResult.firstPinned === true && pinResult.groupPinned === true, JSON.stringify(pinResult));
        assert('置顶分组 / 行标识', pinResult.groupPinned && pinResult.firstRowPinned, JSON.stringify({ g: pinResult.groupPinned, r: pinResult.firstRowPinned }));

        /* ---------------- 6. 循环任务 ---------------- */
        const recurResult = await evaluate(`(function(){
            var store = NC.store.todo;
            var due = Date.now() - 3600000;
            var task = store.addTask({ title: 'E2E 循环任务', due: due, recurrence: { freq: 'daily', interval: 1 } });
            if (!task) return { error: 'add failed' };
            store.toggleTask(task.id);
            var after = store.getTask(task.id);
            return { status: after.status, dueBefore: due, dueAfter: after.due, advanced: after.due > due,
                     lastAt: after.recurrence && after.recurrence.lastMaterializedAt };
        })()`);
        assert('循环任务完成后前移且重置未完成', recurResult.status === 'open' && recurResult.advanced && recurResult.lastAt, JSON.stringify(recurResult));

        /* ---------------- 7. 三天内热区渐变 ---------------- */
        const heatResult = await evaluate(`(function(){
            var store = NC.store.todo;
            var now = Date.now();
            function add(title, offset, completed) {
                var t = store.addTask({ title: title, due: now + offset });
                if (completed) store.toggleTask(t.id);
                return t.id;
            }
            add('E2E 热区 1h', 3600000, false);
            add('E2E 热区 30h', 30 * 3600000, false);
            add('E2E 热区 60h', 60 * 3600000, false);
            add('E2E 热区 100h', 100 * 3600000, false);
            add('E2E 热区完成', 3600000, true);
            var rows = Array.prototype.map.call(document.querySelectorAll('.todo-item'), function(row){
                var title=(row.querySelector('.todo-item__title')||{}).textContent||'';
                if (title.indexOf('E2E 热区') === -1) return null;
                var before = getComputedStyle(row, '::before');
                return { title: title, cls: row.className, bg: before.backgroundImage.slice(0, 40) };
            }).filter(Boolean);
            return { rows: rows };
        })()`);
        const heatMap = {};
        (heatResult.rows || []).forEach((row) => { heatMap[row.title] = row; });
        const heat1 = heatMap['E2E 热区 1h'] || {};
        const heat2 = heatMap['E2E 热区 30h'] || {};
        const heat3 = heatMap['E2E 热区 60h'] || {};
        const heat4 = heatMap['E2E 热区 100h'] || {};
        const heatDone = heatMap['E2E 热区完成'] || {};
        assert('23h 内热区最深（heat-3）', /heat-3/.test(heat1.cls || '') && /gradient/.test(heat1.bg || ''), JSON.stringify(heat1));
        assert('48h 内热区（heat-2）', /heat-2/.test(heat2.cls || '') && /gradient/.test(heat2.bg || ''), JSON.stringify(heat2));
        assert('72h 内热区（heat-1）', /heat-1/.test(heat3.cls || '') && /gradient/.test(heat3.bg || ''), JSON.stringify(heat3));
        assert('72h 外无热区', !/heat-/.test(heat4.cls || ''), JSON.stringify(heat4));
        assert('完成项不染色', !/heat-/.test(heatDone.cls || ''), JSON.stringify(heatDone));

        /* ---------------- 8. 全景模式 ---------------- */
        await evaluate(`(function(){ var b=document.querySelector('#todo-mode-seg [data-mode="timeline"]'); if (b) b.click(); return true; })()`);
        await sleep(1200);
        const timeline = await evaluate(`(function(){
            var c=document.getElementById('todo-timeline');
            var root=c ? c.querySelector('.tl-root') : null;
            return { mode: NC.store.todo.getDoc().settings.viewMode,
                     mounted: !!(NC.timeline && NC.timeline.isMounted && NC.timeline.isMounted()),
                     visible: !!c && !c.hidden,
                     root: root ? root.className : null,
                     shell: (document.querySelector('.todo-shell')||{}).className,
                     detailHidden: !document.querySelector('.todo-detail') || document.querySelector('.todo-detail').offsetParent === null };
        })()`);
        assert('全景模式挂载时间线', timeline.mode === 'timeline' && timeline.mounted && timeline.visible, JSON.stringify(timeline));
        assert('桌面横向时间轴 + 隐藏检查器', /tl--horizontal/.test(timeline.root || '') && timeline.detailHidden && /is-timeline/.test(timeline.shell || ''), JSON.stringify(timeline));
        await evaluate(`(function(){ var b=document.querySelector('#todo-mode-seg [data-mode="list"]'); if (b) b.click(); return true; })()`);
        await sleep(600);
        assert('切回列表卸载时间线', (await evaluate("NC.store.todo.getDoc().settings.viewMode")) === 'list' && (await evaluate("!!(NC.timeline && NC.timeline.isMounted && NC.timeline.isMounted())")) === false);

        await evaluate('localStorage.clear(); true;');
    } finally {
        if (client) { try { client.ws.close(); } catch (err) { /* ignore */ } }
        try { chrome.kill('SIGKILL'); } catch (err) { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }

    console.log('\n===== v4.1 E2E 结果 =====');
    let failed = 0;
    results.forEach((item) => {
        if (!item.pass) failed++;
        console.log('  ' + (item.pass ? 'PASS' : 'FAIL') + '  ' + item.name + (item.detail ? '  → ' + item.detail : ''));
    });
    if (errors.length) {
        failed += errors.length;
        errors.slice(0, 5).forEach((error) => console.log('  FAIL  页面错误 → ' + error));
    }
    console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(3);
});
