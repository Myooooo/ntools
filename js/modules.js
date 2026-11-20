/**
 * modules.js — 五个工作台模块的唯一注册表
 * 挂载：NC.modules
 *
 * 导航 / 启动页选项 / 设置分区 / PAGE_TITLES 都从这里派生，
 * 新增或调整模块只改这一处（导航 HTML 仍需同步增加一个 <a>）。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    var LIST = [
        {
            id: 'todo', tab: 'todo', pageTitle: '待办事项',
            settingsTitle: '待办事项', settingsDesc: 'Todo AI 识别与列表行为', icon: 'check-circle'
        },
        {
            id: 'email', tab: 'email', pageTitle: '邮箱维护',
            settingsTitle: '邮箱维护', settingsDesc: '邮箱数据用量与备份入口', icon: 'mail'
        },
        {
            id: 'notes', tab: 'md', pageTitle: '笔记本',
            settingsTitle: '笔记本', settingsDesc: '笔记库状态、默认视图与导出', icon: 'notebook-text'
        },
        {
            id: 'nchat', tab: 'nchat', pageTitle: 'nChat',
            settingsTitle: 'nChat', settingsDesc: '当前端点与聊天入口', icon: 'messages-square'
        },
        {
            id: 'workshop', tab: 'workshop', pageTitle: '创意工坊',
            settingsTitle: '创意工坊', settingsDesc: '生成参数、内置工具与库用量', icon: 'wand'
        }
    ];

    function get(id) {
        for (var i = 0; i < LIST.length; i += 1) {
            if (LIST[i].id === id || LIST[i].tab === id) return LIST[i];
        }
        return null;
    }

    NC.modules = {
        list: LIST,
        get: get,
        tabIds: function () {
            return LIST.filter(function (item) { return !!item.tab; }).map(function (item) { return item.tab; });
        },
        pageTitles: function () {
            var out = {};
            LIST.forEach(function (item) { if (item.tab) out[item.tab] = item.pageTitle; });
            return out;
        },
        settingsSections: function () {
            return LIST.map(function (item) {
                return {
                    id: item.id,
                    title: item.settingsTitle,
                    desc: item.settingsDesc,
                    icon: item.icon,
                    group: 'modules'
                };
            });
        },
        startOptions: function () {
            return LIST.filter(function (item) { return !!item.tab; }).map(function (item) {
                return { id: item.tab, label: item.pageTitle };
            });
        }
    };
})(window);
