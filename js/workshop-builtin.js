/**
 * workshop-builtin.js — 创意工坊内置工具注册表（纯数据）
 * 挂载：NC.workshopBuiltin
 *
 * 内置工具随包发布，只读：不可编辑/删除，可排序、可置顶。
 * file 指向 js/workshop/builtin/*.html，由 iframe 直接加载（file:// 下最稳）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    var CATEGORIES = [
        { id: 'office', label: '办公实用' },
        { id: 'fun', label: '效率趣味' },
        { id: 'custom', label: '自定义' }
    ];

    var ITEMS = [
        {
            id: 'builtin-pomodoro', category: 'builtin', title: '番茄钟',
            desc: '25 分钟专注 + 5 分钟休息的循环，结束提示音', icon: 'clock',
            file: 'js/workshop/builtin/pomodoro.html', order: 10
        },
        {
            id: 'builtin-timer', category: 'builtin', title: '计时器',
            desc: '倒计时提醒与秒表计次，支持自定义时长', icon: 'clock',
            file: 'js/workshop/builtin/timer.html', order: 20
        },
        {
            id: 'builtin-salary', category: 'builtin', title: '实时薪资',
            desc: '按作息把时间换算成收入，支持倍率', icon: 'sparkles',
            file: 'js/workshop/builtin/salary.html', order: 30
        },
        {
            id: 'builtin-worldclock', category: 'builtin', title: '世界时钟',
            desc: '北京 / 纽约 / 伦敦 / 悉尼，可添加全球主要城市', icon: 'globe',
            file: 'js/workshop/builtin/world-clock.html', order: 40
        },
        {
            id: 'builtin-json', category: 'builtin', title: 'JSON 助手',
            desc: '格式化、压缩、校验与错误定位', icon: 'braces',
            file: 'js/workshop/builtin/json-tool.html', order: 50
        },
        {
            id: 'builtin-countdown', category: 'builtin', title: '倒数日',
            desc: '目标日期倒计时，可管理多个日子', icon: 'calendar-range',
            file: 'js/workshop/builtin/countdown.html', order: 60
        },
        {
            id: 'builtin-picker', category: 'builtin', title: '随机抽签',
            desc: '名单抽签与随机数字，支持导入导出名单', icon: 'users',
            file: 'js/workshop/builtin/picker.html', order: 70
        },
        {
            id: 'builtin-unit', category: 'builtin', title: '单位换算',
            desc: '长度 / 面积 / 重量 / 温度 / 存储', icon: 'ruler',
            file: 'js/workshop/builtin/unit-convert.html', order: 80
        },
        {
            id: 'builtin-color', category: 'builtin', title: '颜色与对比度',
            desc: '取色、调色板与 WCAG 对比度检查', icon: 'palette',
            file: 'js/workshop/builtin/color-contrast.html', order: 90
        },
        {
            id: 'builtin-qr', category: 'builtin', title: '二维码生成',
            desc: '本地生成二维码并下载 PNG', icon: 'qr-code',
            file: 'js/workshop/builtin/qr.html', order: 100
        },
        {
            id: 'builtin-image', category: 'builtin', title: '图片处理',
            desc: '图片 ⇄ Base64、缩放与还原', icon: 'image',
            file: 'js/workshop/builtin/image.html', order: 110
        },
        {
            id: 'builtin-web', category: 'builtin', title: 'Web 助手',
            desc: '构造并发送 HTTP 请求，格式化查看响应', icon: 'send',
            file: 'js/workshop/builtin/web.html', order: 120
        }
    ];

    NC.workshopBuiltin = {
        CATEGORIES: CATEGORIES,
        ITEMS: ITEMS,
        byId: function (id) {
            for (var i = 0; i < ITEMS.length; i += 1) {
                if (ITEMS[i].id === id) return ITEMS[i];
            }
            return null;
        }
    };
})(window);
