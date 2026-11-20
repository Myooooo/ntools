/**
 * todo-timeline-host.js — 待办「全景视图」挂载编排
 * 从 todo-view.js 拆出：容器、懒加载、mount/unmount、失败兜底。
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    function create(deps) {
        var els = deps.els;
        var node = deps.node;
        var toggleClass = deps.toggleClass;
        var store = deps.store;

        var mounted = false;
        var tried = false;
        var assetsRequested = false;
        var assetsFailed = false;

        function ensure() {
            if (!els.mainpane) return;
            var container = document.getElementById('todo-timeline');
            if (!container) {
                container = node('div', 'todo-timeline');
                container.id = 'todo-timeline';
                container.hidden = true;
                els.mainpane.appendChild(container);
            }
            els.timeline = container;
        }

        function isMode(doc) {
            return !!(doc && doc.settings && doc.settings.viewMode === 'timeline');
        }

        function clearFallback() {
            if (!els.timeline) return;
            var note = els.timeline.querySelector('.todo-timeline-note');
            if (note && note.parentNode) note.parentNode.removeChild(note);
        }

        function notice(text) {
            if (!els.timeline) return;
            var note = els.timeline.querySelector('.todo-timeline-note');
            if (!note) {
                note = node('div', 'todo-timeline-note');
                els.timeline.appendChild(note);
            }
            note.textContent = text;
        }

        function fallback(failed) {
            notice(failed
                ? '全景视图加载失败，可切回列表继续使用。'
                : '全景视图组件尚未加载（js/todo-timeline.js），可切回列表继续使用。');
        }

        function loadAssets() {
            if (assetsRequested) return;
            assetsRequested = true;
            var util = NC.util;
            if (!util || typeof util.loadScript !== 'function') {
                fallback(true);
                return;
            }
            notice('正在加载全景视图…');
            var jobs = [util.loadScript('js/todo-timeline.js')];
            if (typeof util.loadStyle === 'function') {
                jobs.push(util.loadStyle('css/timeline.css').catch(function () { return null; }));
            }
            Promise.all(jobs).then(function () {
                assetsFailed = false;
                sync(store.getDoc(), store.getUi());
            }).catch(function () {
                assetsFailed = true;
                assetsRequested = false;
                fallback(true);
            });
        }

        function sync(doc, ui) {
            if (!els.mainpane) return;
            var timeline = doc.settings.viewMode === 'timeline';
            toggleClass(els.mainpane, 'is-timeline', timeline);
            if (els.shell) toggleClass(els.shell, 'is-timeline', timeline);
            if (!els.timeline) ensure();
            if (!els.timeline) return;
            els.timeline.hidden = !timeline;
            if (!timeline) {
                if (mounted) {
                    mounted = false;
                    try {
                        if (NC.timeline && typeof NC.timeline.unmount === 'function') NC.timeline.unmount();
                    } catch (err) { /* ignore */ }
                }
                return;
            }
            if (mounted) return;
            var hasApi = !!(NC.timeline && typeof NC.timeline.mount === 'function');
            if (hasApi) {
                mounted = true;
                tried = true;
                try {
                    NC.timeline.mount(els.timeline);
                    clearFallback();
                } catch (err) {
                    mounted = false;
                    fallback(true);
                }
            } else if (!assetsFailed) {
                loadAssets();
            } else {
                fallback(true);
            }
        }

        return {
            ensure: ensure,
            sync: sync,
            isMode: isMode,
            clearFallback: clearFallback,
            notice: notice
        };
    }

    NC.todoTimelineHost = { create: create };
})(window);
