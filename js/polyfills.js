/**
 * polyfills.js — 极小兼容垫片（经典脚本，无依赖，必须最先加载）
 * 目标环境：奇安信可信浏览器（Chromium 102 基线，见 docs/refactor-and-optimization-plan.md）
 * 说明：仅补项目实际使用、且低版本内核可能缺失的能力；不引入任何构建链。
 */
(function () {
    'use strict';

    if (!Array.prototype.at) {
        Object.defineProperty(Array.prototype, 'at', {
            value: function at(index) {
                var len = this.length >>> 0;
                var k = Math.trunc(index) || 0;
                if (k < 0) k += len;
                return (k < 0 || k >= len) ? undefined : this[k];
            },
            writable: true,
            configurable: true
        });
    }

    if (!String.prototype.at) {
        Object.defineProperty(String.prototype, 'at', {
            value: function at(index) {
                var str = String(this);
                var len = str.length;
                var k = Math.trunc(index) || 0;
                if (k < 0) k += len;
                return (k < 0 || k >= len) ? undefined : str.charAt(k);
            },
            writable: true,
            configurable: true
        });
    }

    // Chromium 102 已内置，保留兜底仅用于极端裁剪内核
    if (!Object.hasOwn) {
        Object.hasOwn = function hasOwn(obj, key) {
            return Object.prototype.hasOwnProperty.call(obj, key);
        };
    }
})();
