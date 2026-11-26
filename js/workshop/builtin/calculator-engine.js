/**
 * calculator-engine.js — 算式解析与分步求值引擎（经典脚本，零 eval）
 * 挂载：window.NCCalcEngine
 *
 * 特性：
 *  - 中英文/全角符号、货币符号、千分位逗号、隐式乘法、未闭合右括号容错规范化；
 *  - 支持 + - * / ^ () %（含数值 % 与增减 % 两种语义）；
 *  - 基于可变 AST 按真实运算优先级逐步归约并产出每步表达式、中间值与归约后完整算式。
 */
(function (global) {
    'use strict';

    var OPS_LABEL = {
        '+': '+',
        '-': '-',
        '*': '×',
        '/': '÷',
        '^': '^'
    };

    var OP_PREC = {
        '+': 1,
        '-': 1,
        '*': 2,
        '/': 2,
        '^': 3,
        'unary': 4,
        'pct': 5
    };

    var OP_RULE = {
        '+': '加法运算',
        '-': '减法运算',
        '*': '乘法运算',
        '/': '除法运算',
        '^': '乘方运算'
    };

    function cleanNumber(n) {
        if (typeof n !== 'number' || !isFinite(n)) return n;
        if (n === 0 || Math.abs(n) < 1e-15) return 0;
        var rounded = Number(n.toPrecision(12));
        return rounded === 0 ? 0 : rounded;
    }

    function formatNumber(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '无效数值';
        var c = cleanNumber(n);
        if (c === 0) return '0';
        var abs = Math.abs(c);
        if (abs >= 1e15 || (abs > 0 && abs < 1e-9)) {
            return c.toExponential(8).replace(/(\.\d*?[1-9])0+e/, '$1e').replace(/\.0+e/, 'e');
        }
        return String(c);
    }

    function formatGrouped(n) {
        var s = formatNumber(n);
        if (s === '无效数值' || s.indexOf('e') > -1 || s.indexOf('E') > -1) return s;
        var parts = s.split('.');
        var neg = parts[0].charAt(0) === '-' ? '-' : '';
        var intDigits = neg ? parts[0].slice(1) : parts[0];
        if (intDigits.length < 4) return s;
        var grouped = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return neg + grouped + (parts.length > 1 ? '.' + parts[1] : '');
    }

    function pushUnique(list, item) {
        if (list.indexOf(item) === -1) list.push(item);
    }

    /**
     * 规范化输入字符串，记录容错修正项
     */
    function normalizeExpression(raw) {
        var str = String(raw == null ? '' : raw);
        var changes = [];

        str = str.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

        var fullDigitReplaced = str.replace(/[０-９]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
        });
        if (fullDigitReplaced !== str) {
            pushUnique(changes, '全角数字转为半角');
            str = fullDigitReplaced;
        }

        var bracketReplaced = str
            .replace(/[（【［｛\[{]/g, '(')
            .replace(/[）】］｝\]}]/g, ')');
        if (bracketReplaced !== str) {
            pushUnique(changes, '统一中英文/全角括号');
            str = bracketReplaced;
        }

        var opReplaced = str
            .replace(/＋/g, '+')
            .replace(/[－—–−﹣]/g, '-')
            .replace(/[×✕✖＊·•⋅]/g, '*')
            .replace(/\*\*/g, '^')
            .replace(/＾/g, '^')
            .replace(/[÷／∶]/g, '/')
            .replace(/％/g, '%')
            .replace(/[。．]/g, '.')
            .replace(/＝/g, '=')
            .replace(/？/g, '?');
        if (opReplaced !== str) {
            pushUnique(changes, '统一全角或中文运算符号');
            str = opReplaced;
        }

        /* 形如 2x3、2 x (3+4)、(1+2)x3 中的字母 x/X 视为乘号 */
        var xMulReplaced = str.replace(/([\d)%])\s*[xX]\s*(?=[+\-]?(?:[\d.(]))/g, '$1 * ');
        if (xMulReplaced !== str) {
            pushUnique(changes, '将字母 x 识别为乘号');
            str = xMulReplaced;
        }

        var currencyStripped = str.replace(/[¥￥$＄€£]+/g, '');
        if (currencyStripped !== str) {
            pushUnique(changes, '去除货币符号');
            str = currencyStripped;
        }

        var beforeComma = str;
        var nextComma = str.replace(/(\d)[,，](\d{3})(?!\d)/g, '$1$2');
        while (nextComma !== str) {
            str = nextComma;
            nextComma = str.replace(/(\d)[,，](\d{3})(?!\d)/g, '$1$2');
        }
        if (str !== beforeComma) {
            pushUnique(changes, '去除千分位逗号');
        }

        var noTrailEq = str.replace(/[\s=?]+$/g, '').trim();
        if (noTrailEq !== str) {
            pushUnique(changes, '去除末尾等号或问号');
            str = noTrailEq;
        }

        str = str.replace(/\s+/g, ' ').trim();
        return { normalized: str, changes: changes };
    }

    function tokenize(normalized, changes) {
        var tokens = [];
        var i = 0;
        var len = normalized.length;
        var depth = 0;
        var implicitInserted = false;

        function prev() {
            return tokens.length ? tokens[tokens.length - 1] : null;
        }

        while (i < len) {
            var ch = normalized.charAt(i);
            if (ch === ' ') {
                i += 1;
                continue;
            }
            if ((ch >= '0' && ch <= '9') || ch === '.') {
                var slice = normalized.slice(i);
                var numMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(slice);
                if (!numMatch) {
                    throw new Error('第 ' + (i + 1) + ' 列数字格式无效（请检查小数点）');
                }
                var rawNum = numMatch[0];
                var afterPos = i + rawNum.length;
                if (afterPos < len && normalized.charAt(afterPos) === '.') {
                    throw new Error('数字「' + rawNum + '.」包含多余的小数点');
                }
                var val = Number(rawNum);
                if (!isFinite(val)) {
                    throw new Error('数字「' + rawNum + '」超出有效数值范围');
                }
                var p = prev();
                if (p && p.type === 'num') {
                    throw new Error('两个数字之间缺少运算符');
                }
                if (p && (p.type === 'rparen' || p.type === 'pct')) {
                    tokens.push({ type: 'op', value: '*' });
                    implicitInserted = true;
                }
                if (rawNum.charAt(0) === '.') {
                    pushUnique(changes, '小数点前自动补 0');
                }
                tokens.push({ type: 'num', value: cleanNumber(val), raw: rawNum });
                i = afterPos;
                continue;
            }
            if (ch === '(') {
                var beforeOpen = prev();
                if (beforeOpen && (beforeOpen.type === 'num' || beforeOpen.type === 'rparen' || beforeOpen.type === 'pct')) {
                    tokens.push({ type: 'op', value: '*' });
                    implicitInserted = true;
                }
                tokens.push({ type: 'lparen', value: '(' });
                depth += 1;
                i += 1;
                continue;
            }
            if (ch === ')') {
                if (depth <= 0) {
                    throw new Error('多余的右括号 ")"，请检查括号配对');
                }
                tokens.push({ type: 'rparen', value: ')' });
                depth -= 1;
                i += 1;
                continue;
            }
            if (ch === '%') {
                tokens.push({ type: 'pct', value: '%' });
                i += 1;
                continue;
            }
            if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^') {
                tokens.push({ type: 'op', value: ch });
                i += 1;
                continue;
            }
            throw new Error('存在不支持的字符「' + ch + '」');
        }

        if (!tokens.length) {
            throw new Error('请输入算式');
        }

        var autoClosed = 0;
        if (depth > 0) {
            var tail = prev();
            if (!tail || tail.type === 'op' || tail.type === 'lparen') {
                throw new Error('括号尚未闭合，且结尾缺少操作数');
            }
            while (depth > 0) {
                tokens.push({ type: 'rparen', value: ')' });
                depth -= 1;
                autoClosed += 1;
            }
            pushUnique(changes, '自动补全 ' + autoClosed + ' 个右括号 )');
        }
        if (implicitInserted) {
            pushUnique(changes, '补全隐式乘号');
        }

        return { tokens: tokens, autoClosed: autoClosed };
    }

    function parseTokens(tokens) {
        var pos = 0;

        function peek() { return pos < tokens.length ? tokens[pos] : null; }
        function consume() { return tokens[pos++]; }

        function parseExpr() {
            var left = parseTerm();
            while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
                var op = consume().value;
                var right = parseTerm();
                left = { kind: 'bin', op: op, left: left, right: right };
            }
            return left;
        }

        function parseTerm() {
            var left = parseUnary();
            while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
                var op = consume().value;
                var right = parseUnary();
                left = { kind: 'bin', op: op, left: left, right: right };
            }
            return left;
        }

        function parseUnary() {
            var tok = peek();
            if (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
                consume();
                var arg = parseUnary();
                if (tok.value === '+') return arg;
                return { kind: 'unary', op: '-', arg: arg };
            }
            return parsePower();
        }

        function parsePower() {
            var base = parsePostfix();
            var tok = peek();
            if (tok && tok.type === 'op' && tok.value === '^') {
                consume();
                var exp = parseUnary();
                return { kind: 'bin', op: '^', left: base, right: exp };
            }
            return base;
        }

        function parsePostfix() {
            var node = parsePrimary();
            while (peek() && peek().type === 'pct') {
                consume();
                node = { kind: 'pct', arg: node };
            }
            return node;
        }

        function parsePrimary() {
            var tok = peek();
            if (!tok) {
                throw new Error('算式不完整，缺少数字或表达式');
            }
            if (tok.type === 'num') {
                consume();
                return { kind: 'num', value: tok.value };
            }
            if (tok.type === 'lparen') {
                consume();
                if (peek() && peek().type === 'rparen') {
                    throw new Error('存在空括号 ()，请在括号内填入数字或算式');
                }
                var inner = parseExpr();
                if (!peek() || peek().type !== 'rparen') {
                    throw new Error('括号匹配异常，请检查括号');
                }
                consume();
                return { kind: 'group', inner: inner };
            }
            if (tok.type === 'op') {
                throw new Error('运算符「' + (OPS_LABEL[tok.value] || tok.value) + '」前缺少数字');
            }
            if (tok.type === 'pct') {
                throw new Error('百分号「%」前缺少数字');
            }
            throw new Error('算式语法错误');
        }

        var ast = parseExpr();
        if (pos < tokens.length) {
            throw new Error('算式在「' + tokens[pos].value + '」处无法继续解析');
        }
        return ast;
    }

    function precOf(node) {
        if (!node) return 99;
        if (node.kind === 'num' || node.kind === 'group') return 99;
        if (node.kind === 'pct') return OP_PREC.pct;
        if (node.kind === 'unary') return OP_PREC.unary;
        if (node.kind === 'bin') return OP_PREC[node.op] || 0;
        return 0;
    }

    function renderAst(node, parentPrec, isRightChild, parentOp) {
        if (!node) return '';
        if (node.kind === 'num') {
            var s = formatNumber(node.value);
            if (node.value < 0 && parentPrec != null && (parentOp === '^' || parentPrec >= OP_PREC.unary || isRightChild)) {
                return '(' + s + ')';
            }
            return s;
        }
        if (node.kind === 'group') {
            if (parentPrec == null && node.inner.kind === 'num') {
                return renderAst(node.inner, null);
            }
            return '(' + renderAst(node.inner, 0) + ')';
        }
        if (node.kind === 'pct') {
            var argStr = renderAst(node.arg, OP_PREC.pct, false, '%');
            return argStr + '%';
        }
        if (node.kind === 'unary') {
            var uStr = renderAst(node.arg, OP_PREC.unary, true, 'unary');
            return '-' + uStr;
        }
        if (node.kind === 'bin') {
            var p = OP_PREC[node.op];
            var leftStr = renderAst(node.left, node.op === '^' ? p + 1 : p, false, node.op);
            var rightPrec = (node.op === '-' || node.op === '/') ? p + 1 : p;
            var rightStr = renderAst(node.right, rightPrec, true, node.op);
            var sym = OPS_LABEL[node.op] || node.op;
            return leftStr + ' ' + sym + ' ' + rightStr;
        }
        return '';
    }

    function becomeNum(node, val) {
        var clean = cleanNumber(val);
        delete node.op;
        delete node.left;
        delete node.right;
        delete node.arg;
        delete node.inner;
        node.kind = 'num';
        node.value = clean;
        return clean;
    }

    function applyBinary(op, a, b) {
        if (op === '+') return cleanNumber(a + b);
        if (op === '-') return cleanNumber(a - b);
        if (op === '*') return cleanNumber(a * b);
        if (op === '/') {
            if (b === 0) throw new Error('除数不能为 0');
            return cleanNumber(a / b);
        }
        if (op === '^') {
            var res = Math.pow(a, b);
            if (!isFinite(res) || isNaN(res)) {
                throw new Error('乘方结果无实数解或超出计算范围（' + formatNumber(a) + ' ^ ' + formatNumber(b) + '）');
            }
            return cleanNumber(res);
        }
        throw new Error('不支持的运算符：' + op);
    }

    /**
     * 执行分步计算并返回结果与每一步中间快照
     * @param {string} raw
     * @param {{percentMode?: 'value'|'relative'}} [options]
     */
    function evaluate(raw, options) {
        var opts = options || {};
        var percentMode = opts.percentMode === 'relative' ? 'relative' : 'value';
        var norm = normalizeExpression(raw);

        if (!norm.normalized) {
            return {
                ok: false,
                error: '请输入算式',
                normalized: '',
                changes: norm.changes
            };
        }

        var tokRes;
        var root;
        try {
            tokRes = tokenize(norm.normalized, norm.changes);
            root = parseTokens(tokRes.tokens);
        } catch (err) {
            return {
                ok: false,
                error: err && err.message ? err.message : String(err),
                normalized: norm.normalized,
                changes: norm.changes
            };
        }

        var displayExpr = renderAst(root, null);
        var steps = [];

        function record(rule, exprText, val, inGroup) {
            var cleanVal = cleanNumber(val);
            steps.push({
                index: steps.length + 1,
                rule: (inGroup ? '括号内' : '') + rule,
                expr: exprText,
                value: formatNumber(cleanVal),
                valueNum: cleanVal,
                fullAfter: renderAst(root, null)
            });
            return cleanVal;
        }

        function evalNode(node, inGroup) {
            if (node.kind === 'num') return node.value;

            if (node.kind === 'group') {
                var val = evalNode(node.inner, true);
                return becomeNum(node, val);
            }

            if (node.kind === 'pct') {
                var baseVal = evalNode(node.arg, inGroup);
                var exprText = renderAst(node, null);
                var pctVal = cleanNumber(baseVal / 100);
                becomeNum(node, pctVal);
                return record('百分比换算', exprText, pctVal, inGroup);
            }

            if (node.kind === 'unary') {
                var hadCompound = node.arg.kind !== 'num';
                var innerVal = evalNode(node.arg, inGroup);
                var negVal = cleanNumber(-innerVal);
                if (hadCompound) {
                    var exprText = '-' + (innerVal < 0 ? '(' + formatNumber(innerVal) + ')' : formatNumber(innerVal));
                    becomeNum(node, negVal);
                    return record('取负运算', exprText, negVal, inGroup);
                }
                return becomeNum(node, negVal);
            }

            if (node.kind === 'bin') {
                if (percentMode === 'relative' && (node.op === '+' || node.op === '-') && node.right.kind === 'pct') {
                    var leftVal = evalNode(node.left, inGroup);
                    var pctArgVal = evalNode(node.right.arg, inGroup);
                    var pctAmount = cleanNumber(leftVal * (pctArgVal / 100));
                    var pctExpr = formatNumber(leftVal) + ' × ' + formatNumber(pctArgVal) + '%';
                    becomeNum(node.right, pctAmount);
                    record('相对百分比', pctExpr, pctAmount, inGroup);

                    var binRule = OP_RULE[node.op] || '运算';
                    var binExpr = formatNumber(leftVal) + ' ' + OPS_LABEL[node.op] + ' ' + formatNumber(pctAmount);
                    var combined = applyBinary(node.op, leftVal, pctAmount);
                    becomeNum(node, combined);
                    return record(binRule, binExpr, combined, inGroup);
                }

                var l = evalNode(node.left, inGroup);
                var r = evalNode(node.right, inGroup);
                var opSym = OPS_LABEL[node.op] || node.op;
                var ruleName = OP_RULE[node.op] || '运算';
                var exprStr = formatNumber(l) + ' ' + opSym + ' ' + formatNumber(r);
                var out = applyBinary(node.op, l, r);
                becomeNum(node, out);
                return record(ruleName, exprStr, out, inGroup);
            }

            throw new Error('未知表达式节点');
        }

        try {
            var finalVal = cleanNumber(evalNode(root, false));
            return {
                ok: true,
                raw: String(raw == null ? '' : raw),
                normalized: norm.normalized,
                displayExpr: displayExpr,
                changes: norm.changes,
                autoClosed: tokRes.autoClosed,
                percentMode: percentMode,
                value: finalVal,
                formatted: formatNumber(finalVal),
                grouped: formatGrouped(finalVal),
                steps: steps
            };
        } catch (err) {
            return {
                ok: false,
                error: err && err.message ? err.message : String(err),
                normalized: norm.normalized,
                displayExpr: displayExpr,
                changes: norm.changes
            };
        }
    }

    global.NCCalcEngine = {
        normalizeExpression: normalizeExpression,
        evaluate: evaluate,
        cleanNumber: cleanNumber,
        formatNumber: formatNumber,
        formatGrouped: formatGrouped
    };
})(window);
