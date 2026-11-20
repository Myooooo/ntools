/**
 * event-names.js — 事件总线名称常量（挂载 NC.eventNames）
 * 约定：所有跨模块事件必须从这里取名，避免同名字符串散落导致漏监听。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    NC.eventNames = {
        themeChanged: 'theme:changed',
        liteChanged: 'lite:changed',
        llmChanged: 'llm:changed',
        llmError: 'llm:error',
        llmProfileSelected: 'llm:profile-selected',
        configSwitched: 'config:switched',
        settingsChanged: 'settings:changed',
        appError: 'app:error',
        appOpenSettings: 'app:open-settings',
        storageError: 'storage:error',
        storageCorrupt: 'storage:corrupt',
        quotaWarning: 'quota:warning',
        leaseDegraded: 'lease:degraded',
        emailImported: 'email:imported',
        notesChanged: 'notes:changed',
        notesError: 'notes:error',
        notesReadonly: 'notes:readonly',
        notesSavesate: 'notes:savestate',
        notesTrashPurged: 'notes:trash-purged',
        conversationChanged: 'conversation:changed',
        conversationSaveFailed: 'conversation:save-failed',
        conversationStorageFallback: 'conversation:storage-fallback',
        conversationTruncatedOnLoad: 'conversation:truncated-on-load',
        todoChanged: 'todo:changed',
        todoError: 'todo:error',
        todoReadonly: 'todo:readonly',
        todoSavesate: 'todo:savestate',
        todoLimit: 'todo:limit',
        todoRecurred: 'todo:recurred',
        todoTrashPurged: 'todo:trash-purged',
        todoSnapshot: 'todo:snapshot',
        todoAiFilled: 'todo:ai-filled',
        todoAiReady: 'todo-ai:ready',
        workshopChanged: 'workshop:changed'
    };
})(window);
