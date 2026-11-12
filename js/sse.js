/**
 * sse.js — Server-Sent Events 增量解析器（纯状态机，无 DOM / 无 fetch）
 * 经典脚本，无外部依赖。挂载到 NC.sse。
 *
 * 特性：
 * - 支持 LF / CRLF / 裸 CR 行尾，且行尾被 chunk 边界截断时可续接；
 * - 支持多行 data: 字段（按规范以 \n 拼接后派发一个事件）；
 * - 空行分隔事件；注释行（:）忽略；event/id/retry 字段忽略；
 * - `[DONE]`（trim 后比较）触发 onDone 并停止后续解析；
 * - end() 会 flush 缓冲区中最后一条未换行的事件，并保证 onDone 只触发一次。
 *
 * 测试接口：
 *   NC.sse.parseSSE(text) → {events: String[], done: Boolean}
 *   NC.sse.createParser({onEvent,onDone}) → {feed(text), end(), isDone()}
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    var DONE_TOKEN = '[DONE]';

    function createParser(handlers) {
        var h = handlers || {};
        var buffer = '';
        var dataLines = [];
        var finished = false;
        var ended = false;

        function emitDone(reason) {
            if (finished) return;
            finished = true;
            if (typeof h.onDone === 'function') h.onDone({ reason: reason || 'done' });
        }

        function dispatchEvent() {
            if (!dataLines.length) return;
            var data = dataLines.join('\n');
            dataLines = [];
            var trimmed = data.trim();
            if (!trimmed) return;
            if (trimmed === DONE_TOKEN) {
                emitDone('done');
                return;
            }
            if (typeof h.onEvent === 'function') {
                try {
                    h.onEvent(data);
                } catch (err) {
                    if (typeof h.onError === 'function') h.onError(err);
                    else console.error('[NC] sse event handler error:', err);
                }
            }
        }

        function handleLine(line) {
            if (line === '') {
                dispatchEvent();
                return;
            }
            if (line.charAt(0) === ':') return; // 注释 / keep-alive
            var sep = line.indexOf(':');
            var field = sep === -1 ? line : line.slice(0, sep);
            var value = sep === -1 ? '' : line.slice(sep + 1);
            if (value.charAt(0) === ' ') value = value.slice(1);
            if (field === 'data') {
                dataLines.push(value);
            }
            // event: / id: / retry: / 未知字段按规范忽略
        }

        function processBuffer() {
            var guard = 0;
            while (buffer.length && guard < 10000) {
                guard += 1;
                var lf = buffer.indexOf('\n');
                var cr = buffer.indexOf('\r');
                var index;
                if (lf === -1 && cr === -1) break;
                if (lf === -1) index = cr;
                else if (cr === -1) index = lf;
                else index = Math.min(lf, cr);

                // 末尾单独一个 \r：可能是被 chunk 截断的 CRLF，等下一个 chunk
                if (buffer.charAt(index) === '\r' && index === buffer.length - 1) break;

                var line = buffer.slice(0, index);
                if (buffer.charAt(index) === '\r' && buffer.charAt(index + 1) === '\n') {
                    buffer = buffer.slice(index + 2);
                } else {
                    buffer = buffer.slice(index + 1);
                }
                handleLine(line);
                if (finished) {
                    buffer = '';
                    dataLines = [];
                    return;
                }
            }
        }

        return {
            feed: function (text) {
                if (finished || ended) return;
                if (text == null) return;
                buffer += String(text);
                processBuffer();
            },
            end: function () {
                if (ended) return;
                ended = true;
                if (finished) return;
                if (buffer.length) {
                    var line = buffer;
                    buffer = '';
                    if (/\r$/.test(line)) line = line.slice(0, -1);
                    handleLine(line);
                }
                dispatchEvent();
                emitDone('eof');
            },
            isDone: function () { return finished; }
        };
    }

    /**
     * 一次性解析（测试/非流式回退使用）。
     * @returns {{events: String[], done: Boolean}}
     */
    function parseSSE(text) {
        var events = [];
        var done = false;
        var parser = createParser({
            onEvent: function (data) { events.push(data); },
            onDone: function () { done = true; }
        });
        parser.feed(String(text == null ? '' : text));
        parser.end();
        return { events: events, done: done };
    }

    NC.sse = {
        DONE_TOKEN: DONE_TOKEN,
        createParser: createParser,
        parseSSE: parseSSE
    };
})(window);
