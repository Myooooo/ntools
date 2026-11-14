/**
 * markdown-enhance.js — nChat Markdown 增强
 * - 数学：marked 扩展输出占位 span，按需加载本地 KaTeX 后渲染（$...$ / $$...$$ / \(...\) / \[...\]）
 * - 代码块复制按钮
 * 经典脚本，挂载 NC.mdEnhance；不引入构建链，不联网（KaTeX 本地 vendor）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};
    var installed = false;
    var katexPromise = null;
    var cssInjected = false;

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function mathSpan(tex, display) {
        var cls = display ? 'math-block' : 'math-inline';
        return '<span class="' + cls + '" data-tex="' + escapeHtml(tex) + '">' + escapeHtml(tex) + '</span>';
    }

    function installMarked() {
        if (installed) return;
        var marked = global.marked;
        if (!marked || typeof marked.use !== 'function') return;
        installed = true;

        marked.use({
            extensions: [
                {
                    name: 'blockMathDollar',
                    level: 'block',
                    start: function (src) { var i = src.indexOf('$$'); return i < 0 ? undefined : i; },
                    tokenizer: function (src) {
                        var match = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/.exec(src);
                        if (!match) return undefined;
                        return { type: 'blockMathDollar', raw: match[0], text: match[1].trim() };
                    },
                    renderer: function (token) { return mathSpan(token.text, true); }
                },
                {
                    name: 'inlineMathDollar',
                    level: 'inline',
                    start: function (src) {
                        var a = src.indexOf('$');
                        var b = src.indexOf('\\(');
                        if (a === -1 && b === -1) return undefined;
                        if (a === -1) return b;
                        if (b === -1) return a;
                        return Math.min(a, b);
                    },
                    tokenizer: function (src) {
                        var dollar = /^\$([^$\n]+?)\$(?!\d)/.exec(src);
                        if (dollar) return { type: 'inlineMathDollar', raw: dollar[0], text: dollar[1] };
                        var paren = /^\\\(([\s\S]+?)\\\)/.exec(src);
                        if (paren) return { type: 'inlineMathParen', raw: paren[0], text: paren[1] };
                        return undefined;
                    },
                    renderer: function (token) { return mathSpan(token.text, false); }
                },
                {
                    name: 'blockMathBracket',
                    level: 'block',
                    start: function (src) { var i = src.indexOf('\\['); return i < 0 ? undefined : i; },
                    tokenizer: function (src) {
                        var match = /^\\\[([\s\S]+?)\\\](?:\n+|$)/.exec(src);
                        if (!match) return undefined;
                        return { type: 'blockMathBracket', raw: match[0], text: match[1].trim() };
                    },
                    renderer: function (token) { return mathSpan(token.text, true); }
                }
            ]
        });
    }

    function ensureKatex() {
        if (katexPromise) return katexPromise;
        katexPromise = new Promise(function (resolve, reject) {
            if (global.katex) { resolve(global.katex); return; }
            if (!cssInjected) {
                cssInjected = true;
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = 'css/katex.min.css';
                document.head.appendChild(link);
            }
            var script = document.createElement('script');
            script.src = 'js/katex.min.js';
            script.async = true;
            script.onload = function () {
                if (global.katex) resolve(global.katex);
                else reject(new Error('KaTeX unavailable'));
            };
            script.onerror = function () { reject(new Error('KaTeX load failed')); };
            document.head.appendChild(script);
        }).catch(function (err) {
            katexPromise = null;
            throw err;
        });
        return katexPromise;
    }

    function renderMath(root) {
        if (!root || !root.querySelectorAll) return;
        var nodes = root.querySelectorAll('.math-inline:not(.is-rendered), .math-block:not(.is-rendered)');
        if (!nodes.length) return;
        ensureKatex().then(function (katex) {
            Array.prototype.forEach.call(nodes, function (node) {
                if (!node.parentNode || node.classList.contains('is-rendered')) return;
                var tex = node.getAttribute('data-tex') || node.textContent || '';
                try {
                    node.textContent = '';
                    katex.render(tex, node, {
                        displayMode: node.classList.contains('math-block'),
                        throwOnError: false,
                        strict: 'ignore',
                        trust: false
                    });
                    node.classList.add('is-rendered');
                } catch (err) {
                    node.classList.add('is-error');
                    node.textContent = tex;
                }
            });
        }).catch(function () {
            /* KaTeX 不可用时保留原始 TeX 文本 */
        });
    }

    function copyText(text) {
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
            return global.navigator.clipboard.writeText(text);
        }
        return new Promise(function (resolve, reject) {
            try {
                var area = document.createElement('textarea');
                area.value = text;
                area.className = 'nc-sr-only';
                document.body.appendChild(area);
                area.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(area);
                ok ? resolve() : reject(new Error('copy failed'));
            } catch (err) { reject(err); }
        });
    }

    function enhanceCodeBlocks(root) {
        if (!root || !root.querySelectorAll) return;
        var blocks = root.querySelectorAll('pre > code');
        Array.prototype.forEach.call(blocks, function (code) {
            var pre = code.parentNode;
            if (!pre || pre.classList.contains('chat-code')) return;
            pre.classList.add('chat-code');
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'chat-code__copy';
            button.textContent = '复制';
            button.setAttribute('aria-label', '复制代码');
            button.addEventListener('click', function () {
                copyText(code.textContent || '').then(function () {
                    button.textContent = '已复制';
                    button.classList.add('is-copied');
                    global.setTimeout(function () {
                        button.textContent = '复制';
                        button.classList.remove('is-copied');
                    }, 1400);
                }).catch(function () { button.textContent = '复制失败'; });
            });
            pre.appendChild(button);
        });
    }

    function enhance(root) {
        installMarked();
        enhanceCodeBlocks(root);
        renderMath(root);
    }

    // 尽早安装扩展，保证之后所有 marked.parse 都认识数学语法
    installMarked();

    NC.mdEnhance = {
        install: installMarked,
        enhance: enhance,
        renderMath: renderMath,
        enhanceCodeBlocks: enhanceCodeBlocks,
        ensureKatex: ensureKatex
    };
})(window);
