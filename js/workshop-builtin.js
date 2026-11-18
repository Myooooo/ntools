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
            id: 'builtin-pomodoro', category: 'office', title: '番茄钟 / 计时器',
            desc: '25/5 专注循环、自定义时长、结束提示音', icon: 'clock',
            file: 'js/workshop/builtin/pomodoro.html', order: 10
        },
        {
            id: 'builtin-salary', category: 'office', title: '实时薪资累计',
            desc: '按薪资与作息秒级累计「今天已赚」，支持午休与加班', icon: 'sparkles',
            file: 'js/workshop/builtin/salary.html', order: 20
        },
        {
            id: 'builtin-worldclock', category: 'office', title: '全球时间',
            desc: '默认北京时间，可添加纽约、伦敦、东京等主要城市', icon: 'globe',
            file: 'js/workshop/builtin/world-clock.html', order: 30
        },
        {
            id: 'builtin-json', category: 'office', title: 'JSON 格式化 / 校验',
            desc: '格式化、压缩、错误定位与转义', icon: 'braces',
            file: 'js/workshop/builtin/json-tool.html', order: 40
        },
        {
            id: 'builtin-countdown', category: 'fun', title: '倒数日 / 纪念日',
            desc: '目标日期倒计时，可管理多个日子', icon: 'calendar',
            file: 'js/workshop/builtin/countdown.html', order: 50
        },
        {
            id: 'builtin-picker', category: 'fun', title: '随机点名 / 抽签',
            desc: '手动维护或导入候选名单，随机抽取不重复', icon: 'users',
            file: 'js/workshop/builtin/picker.html', order: 60
        },
        {
            id: 'builtin-unit', category: 'fun', title: '单位换算',
            desc: '长度 / 面积 / 重量 / 温度 / 存储', icon: 'ruler',
            file: 'js/workshop/builtin/unit-convert.html', order: 70
        },
        {
            id: 'builtin-color', category: 'fun', title: '颜色与对比度',
            desc: '取色、调色板与 WCAG 对比度检查', icon: 'palette',
            file: 'js/workshop/builtin/color-contrast.html', order: 80
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
