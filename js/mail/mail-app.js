/**
 * mail-app.js — 邮件管理页业务逻辑
 * 从 email-manager.html 抽出（v5.12）。仍是独立文档里的全局脚本：
 * 内联 onclick 依赖这些全局函数，后续改事件委托时再逐步收敛。
 */
    // 默认预设四大分组
    const DEFAULT_GROUPS = [
      { id: "g_hq", name: "总行各部门、各直属机构，驻中国银行纪检监察组" },
      { id: "g_branch", name: "各一级分行、直属分行" },
      { id: "g_overseas", name: "各境外机构" },
      { id: "g_subsidiary", name: "各综合经营公司" }
    ];

    // 初始示例数据
    const DEFAULT_EMAILS = [
    ];

    const LEVEL_NAMES = ['团队/部门', '部门/机构', '类别'];

    // 状态机
    const state = {
      groups: [],
      emails: [],
      currentGroupId: 'all',
      searchQuery: '',
      filterL1: '',       // 类别值
      filterL2: '',       // 部门/机构值
      filterL3: '',       // 团队/部门值
      selectedEmailIds: new Set(),
      exportFormat: 'full',
      recipientFormat: 'standard',
      addEditTab: 'import'   // 添加弹窗当前页签：import | single
    };

    /* ---------- 存储（v1 单一文档） ----------
     * 旧版是两个裸键（groups / emails），加载时会顺手重写、导入时不做校验。
     * 现在统一成一份带版本的文档：单键原子写、写后读回校验、导入先归一化再落盘。 */
    const STORAGE_KEY_DOC = 'ntools.email.v1';
    const LEGACY_KEY_GROUPS = 'boc_email_system_groups_v1';
    const LEGACY_KEY_EMAILS = 'boc_email_system_emails_v1';
    const DOC_VERSION = 1;
    const DOC_LIMITS = { groups: 60, emails: 5000, name: 80, email: 160, notes: 2000 };
    const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    const storageOk = (function () {
      try {
        const probe = '__nc_email_probe__';
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);
        return true;
      } catch (e) { return false; }
    })();

    function clip(v, n) {
      const text = String(v == null ? '' : v);
      return text.length > n ? text.slice(0, n) : text;
    }

    function safeId(raw, prefix) {
      const text = String(raw == null ? '' : raw).trim();
      if (ID_RE.test(text)) return text;
      return prefix + '-' + Math.random().toString(36).slice(2, 10);
    }

    /* 内联 onclick 里拼 JS 字符串时用：组 id/邮箱 id 只允许 [A-Za-z0-9_-]，
     * 从源头上消除 "id 里带引号 → 闭合字符串字面量" 的注入面。 */
    function jsArg(v) {
      return String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
    }

    function readJSON(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? null : JSON.parse(raw);
      } catch (e) { return null; }
    }

    function notifyParent(payload) {
      try {
        if (window.parent && window.parent !== window) window.parent.postMessage(payload, '*');
      } catch (e) { /* ignore */ }
    }

    /* 归一化整份文档：永远返回 {doc, dropped}，不抛错、不写盘。 */
    function normalizeDoc(raw) {
      const src = (raw && typeof raw === 'object') ? raw : {};
      const dropped = { groups: 0, emails: 0, dupes: 0 };
      const groups = [];
      const groupIds = new Set();
      (Array.isArray(src.groups) ? src.groups : []).slice(0, DOC_LIMITS.groups).forEach(function (item) {
        if (!item || typeof item !== 'object') { dropped.groups += 1; return; }
        let id = safeId(item.id, 'g');
        if (groupIds.has(id)) { id = 'g-' + Math.random().toString(36).slice(2, 10); dropped.groups += 1; }
        groupIds.add(id);
        groups.push({ id: id, name: clip(item.name || '未命名分组', DOC_LIMITS.name) });
      });
      if (!groups.length) {
        DEFAULT_GROUPS.forEach(function (g) {
          if (groupIds.has(g.id)) return;
          groupIds.add(g.id);
          groups.push({ id: g.id, name: g.name });
        });
      }

      const emails = [];
      const byAddr = new Map();
      const usedIds = new Set();
      (Array.isArray(src.emails) ? src.emails : []).slice(0, DOC_LIMITS.emails).forEach(function (item) {
        if (!item || typeof item !== 'object') { dropped.emails += 1; return; }
        const addr = String(item.email || '').trim().toLowerCase();
        if (!addr || addr.length > DOC_LIMITS.email || !EMAIL_RE.test(addr)) {
          dropped.emails += 1;
          return;
        }
        let ids = Array.isArray(item.groupIds) ? item.groupIds : [];
        if (!Array.isArray(item.groupIds) && item.groupId) ids = [item.groupId];
        ids = Array.from(new Set(ids.filter(function (id) { return groupIds.has(id); })));
        const exist = byAddr.get(addr);
        if (exist) {
          exist.groupIds = Array.from(new Set(exist.groupIds.concat(ids)));
          if (!exist.notes && item.notes) exist.notes = clip(item.notes, DOC_LIMITS.notes);
          if (!exist.description && item.description) exist.description = clip(item.description, DOC_LIMITS.notes);
          dropped.dupes += 1;
          return;
        }
        let id = safeId(item.id, 'e');
        if (usedIds.has(id)) id = 'e-' + Math.random().toString(36).slice(2, 10);
        usedIds.add(id);
        const record = {
          id: id,
          email: addr,
          groupIds: ids,
          notes: clip(item.notes || '', DOC_LIMITS.notes),
          description: clip(item.description || '', DOC_LIMITS.notes)
        };
        byAddr.set(addr, record);
        emails.push(record);
      });

      return {
        doc: {
          schemaVersion: DOC_VERSION,
          revision: (typeof src.revision === 'number' && isFinite(src.revision)) ? src.revision : 0,
          updatedAt: (typeof src.updatedAt === 'number' && isFinite(src.updatedAt)) ? src.updatedAt : Date.now(),
          groups: groups,
          emails: emails
        },
        dropped: dropped
      };
    }

    document.addEventListener('DOMContentLoaded', function () {
      // 加载界面：等本地数据解析与渲染全部完成后再淡出
      requestAnimationFrame(function () {
        try {
          loadStorageData();
          initTheme();
          renderAll();
          renderIcons();
          setupDragReorder();
        } finally {
          revealApp();
        }
      });
    });

    // 隐藏启动加载层，并让主界面缓进入场
    function revealApp() {
      const mask = document.getElementById('boot-mask');
      const shell = document.getElementById('app-shell');
      if (shell) shell.classList.add('revealed');
      if (mask) {
        mask.classList.add('done');
        setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 500);
      }
    }

    /* ==================== 数据持久化 ==================== */
    function loadStorageData() {
      const stored = readJSON(STORAGE_KEY_DOC);
      let doc = (stored && typeof stored === 'object' && stored.schemaVersion != null) ? stored : null;
      let migrated = false;

      if (!doc) {
        /* 首次升级：把两个旧键合成一份新文档；旧键原样保留，随时可回退 */
        const legacyGroups = readJSON(LEGACY_KEY_GROUPS);
        const legacyEmails = readJSON(LEGACY_KEY_EMAILS);
        if (Array.isArray(legacyGroups) || Array.isArray(legacyEmails)) {
          doc = {
            schemaVersion: DOC_VERSION,
            groups: Array.isArray(legacyGroups) ? legacyGroups : [],
            emails: Array.isArray(legacyEmails) ? legacyEmails : []
          };
          migrated = true;
        }
      }

      const result = normalizeDoc(doc);
      state.groups = result.doc.groups;
      state.emails = result.doc.emails;
      state.revision = result.doc.revision || 0;
      applyGroupOrderToEmails();

      if (migrated) {
        saveToStorage('both');
        showToast('邮件数据已迁移到新格式（旧数据保留，可回退）', 'success');
      } else if (!doc) {
        saveToStorage('both');
      } else {
        const bad = result.dropped.groups + result.dropped.emails;
        if (bad || result.dropped.dupes) {
          showToast('加载时忽略 ' + bad + ' 条非法记录、合并 ' + result.dropped.dupes + ' 条重复邮箱', 'warn');
        }
      }
      announceReady();
    }

    /* 握手要"多喊几次"：父页面可能比 iframe 晚一步挂上 message 监听，
     * 只喊一次会丢掉，进而误判成"邮件页未加载"。 */
    function announceReady() {
      let attempt = 0;
      (function tick() {
        attempt += 1;
        notifyParent({
          type: 'ntools-email-ready',
          version: DOC_VERSION,
          storage: storageOk,
          groups: state.groups.length,
          emails: state.emails.length,
          attempt: attempt
        });
        if (attempt < 5) setTimeout(tick, 300 * attempt);
      })();
    }

    /* 按“分组顺序 → 组内原有顺序”重排。只改内存，不再在加载时偷偷写盘。 */
    function applyGroupOrderToEmails() {
      state.emails = sortEmailsByGroupOrder(state.emails);
      return state.emails;
    }

    /* 兼容旧调用：就地归一化当前内存态（导入流程使用） */
    function normalizeEmails() {
      const result = normalizeDoc({
        schemaVersion: DOC_VERSION,
        revision: state.revision || 0,
        groups: state.groups,
        emails: state.emails
      });
      state.groups = result.doc.groups;
      state.emails = result.doc.emails;
      applyGroupOrderToEmails();
      return result.dropped;
    }

    // 邮箱所属分组 id 数组（去重、兼容旧单值结构）
    function getGroupIds(item) {
      if (!item || typeof item !== 'object') return [];
      if (!Array.isArray(item.groupIds)) {
        item.groupIds = (item.groupId && item.groupId !== '') ? [item.groupId] : [];
        delete item.groupId;
      }
      return item.groupIds.filter(id => state.groups.some(g => g.id === id));
    }

    // 邮箱唯一键（大小写不敏感）
    function emailKey(email) {
      return String(email || '').trim().toLowerCase();
    }

    // 按“分组顺序 → 组内原有顺序”排序；重复邮箱只保留首次出现；未分组置底
    function sortEmailsByGroupOrder(emails) {
      const groupPos = new Map();
      state.groups.forEach((g, i) => groupPos.set(g.id, i));
      const idPos = new Map();
      const seen = new Set();
      const items = [];
      emails.forEach(e => {
        if (!e) return;
        const k = emailKey(e.email);
        if (seen.has(k)) return;
        seen.add(k);
        idPos.set(e.id, items.length);
        items.push(e);
      });
      const rankOf = e => {
        const ids = getGroupIds(e);
        if (ids.length === 0) return Infinity;
        let best = Infinity;
        ids.forEach(gid => {
          const p = groupPos.has(gid) ? groupPos.get(gid) : Infinity;
          if (p < best) best = p;
        });
        return best;
      };
      return items.sort((a, b) => {
        const ra = rankOf(a), rb = rankOf(b);
        if (ra !== rb) return ra - rb;
        return (idPos.get(a.id) || 0) - (idPos.get(b.id) || 0);
      });
    }

    /* 单键原子写 + 写后读回校验。which 参数保留只为不改调用点。 */
    function saveToStorage() {
      if (!storageOk) {
        showToast('本地存储不可用，本次修改不会被保存', 'error');
        notifyParent({ type: 'ntools-email-save', ok: false, storage: false });
        return false;
      }
      // 冲突守卫：库里的 revision 比内存高，说明别的窗口写过，拒绝静默覆盖
      try {
        const storedRaw = localStorage.getItem(STORAGE_KEY_DOC);
        if (storedRaw) {
          const stored = JSON.parse(storedRaw);
          if (stored && typeof stored.revision === 'number' && stored.revision > (state.revision || 0)) {
            state.saveError = true;
            showToast('数据已被其他窗口更新，本次修改未保存。请刷新本页后再改。', 'error');
            notifyParent({ type: 'ntools-email-save', ok: false, conflict: true, revision: stored.revision });
            return false;
          }
        }
      } catch (err) { /* 读不到就按无冲突处理 */ }

      const nextRevision = (state.revision || 0) + 1;
      const doc = {
        schemaVersion: DOC_VERSION,
        revision: nextRevision,
        updatedAt: Date.now(),
        groups: state.groups,
        emails: state.emails
      };
      let raw;
      try {
        raw = JSON.stringify(doc);
      } catch (err) {
        showToast('数据序列化失败：' + err.message, 'error');
        return false;
      }
      try {
        localStorage.setItem(STORAGE_KEY_DOC, raw);
        if (localStorage.getItem(STORAGE_KEY_DOC) !== raw) throw new Error('写入校验失败');
        state.revision = nextRevision;
        state.saveError = false;
        notifyParent({ type: 'ntools-email-save', ok: true, revision: nextRevision, emails: state.emails.length });
        return true;
      } catch (err) {
        state.saveError = true;
        const quota = !!(err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014));
        showToast(
          quota ? '本地存储空间不足，本次修改未保存，请先导出备份' : '本地存储写入失败：' + err.message,
          'error'
        );
        notifyParent({ type: 'ntools-email-save', ok: false, quota: quota });
        return false;
      }
    }

    function restoreDefaultData() {
      state.groups = DEFAULT_GROUPS.map(g => ({ ...g }));
      state.emails = DEFAULT_EMAILS.map(e => ({ ...e }));
      state.currentGroupId = 'all';
      state.searchQuery = '';
      state.filterL1 = '';
      state.filterL2 = '';
      state.filterL3 = '';
      state.selectedEmailIds.clear();
      saveToStorage('both');
      renderAll();
      showToast('已恢复默认数据', 'success');
    }

    function requestResetData() {
      requestConfirm('恢复初始默认数据', '确认恢复为初始默认数据？当前所有本地数据将被清除且不可恢复。', 'danger', '确认', () => {
        restoreDefaultData();
        closeModal('modal-backup');
      });
    }

    /* ==================== 描述结构解析 ====================
     * 规范格式：角色（团队/部门/部门/机构/类别）
     * 括号内部从左至右依次为：团队/部门、部门/机构、类别
     */
    function parseDescription(desc) {
      const raw = (desc || '').trim().replace(/^"|"$/g, '');
      const openIdx = raw.search(/[（(]/);
      const closeIdx = Math.max(raw.lastIndexOf('）'), raw.lastIndexOf(')'));
      if (openIdx < 0 || closeIdx <= openIdx) {
        return { raw: raw, role: raw, segments: [] };
      }
      const role = (raw.slice(0, openIdx) + raw.slice(closeIdx + 1)).trim();
      const inner = raw.slice(openIdx + 1, closeIdx).trim();
      const parts = inner.split(/[\/\\、\-]/).map(s => s.trim()).filter(Boolean);
      const segments = parts.map((name, idx) => {
        const offset = idx - (parts.length - LEVEL_NAMES.length);
        const level = offset >= 0 && offset < LEVEL_NAMES.length ? LEVEL_NAMES[offset] : null;
        return { name: name, level: level };
      });
      return { raw: raw, role: role || '未设职位', segments: segments };
    }

    function segmentsFilterText(segments) {
      return segments.map(s => s.name).concat(segments.map(s => s.level)).join(' ');
    }

    /* ==================== 筛选与渲染 ==================== */
    function renderAll() {
      renderGroupNav();
      renderEmailList();
      updateSelectedUI();
      populateGroupSelects();
      populateDirectFilterSelects();
      renderIcons();
    }

    function renderGroupNav() {
      const nav = document.getElementById('group-nav-list');
      const total = state.emails.length;
      document.getElementById('stat-total-count').textContent = total + ' 条';

      const item = (id, label, count, icon) => {
        const active = state.currentGroupId === id;
        return `
          <button class="nav-item ${active ? 'active' : ''}" onclick="setFilterGroup('${id}')">
            <span class="l"><i data-icon="${icon}" data-w="14" data-h="14"></i><span title="${escapeHtml(label)}">${escapeHtml(label)}</span></span>
            <span class="nav-count">${count}</span>
          </button>`;
      };

      let html = item('all', '全部邮箱', total, 'layers');
      state.groups.forEach(g => {
        const count = state.emails.filter(e => getGroupIds(e).includes(g.id)).length;
        html += item(g.id, g.name, count, 'folder');
      });
      // 目录末尾固定“未分组”，始终可见
      const ungroupedCount = state.emails.filter(e => getGroupIds(e).length === 0).length;
      html += item('__ungrouped__', '未分组', ungroupedCount, 'inbox');
      nav.innerHTML = html;
      // 分组目录用 innerHTML 重建后需重新渲染行内图标
      renderIcons(nav);
    }

    // 层级分类值提取（1→一级、2→二级、3→三级）
    function extractLevelValue(parsed, level) {
      const pos = { l3: 3, l2: 2, l1: 1 }[level];
      if (!pos) return '';
      const seg = parsed.segments.length >= pos ? parsed.segments[parsed.segments.length - pos] : null;
      return seg ? seg.name : '';
    }

    function getFilteredEmails() {
      return state.emails
        .filter(item => {
          const ids = getGroupIds(item);
          // “未分组”过滤项：仅无任何分组的邮箱
          if (state.currentGroupId === '__ungrouped__') return ids.length === 0;
          if (state.currentGroupId !== 'all' && !ids.includes(state.currentGroupId)) return false;

          const q = state.searchQuery.toLowerCase();
          if (q) {
            const parsed = parseDescription(item.description);
            const groupText = ids.map(id => {
              const g = state.groups.find(x => x.id === id);
              return g ? g.name : '';
            }).join(' ');
            const searchable = [
              item.email, item.description, item.notes || '',
              parsed.role, segmentsFilterText(parsed.segments), groupText
            ].join(' ').toLowerCase();
            if (!searchable.includes(q)) return false;
          }

          // 直接三级联动筛选
          if (state.filterL1 || state.filterL2 || state.filterL3) {
            const parsed = parseDescription(item.description);
            if (state.filterL1 && extractLevelValue(parsed, 'l1') !== state.filterL1) return false;
            if (state.filterL2 && extractLevelValue(parsed, 'l2') !== state.filterL2) return false;
            if (state.filterL3 && extractLevelValue(parsed, 'l3') !== state.filterL3) return false;
          }

          return true;
        });
    }

    // 填充直接分类筛选下拉
    function populateDirectFilterSelects() {
      const populateLevel = (levelKey, selectId, placeholder) => {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const currentVal = state[levelKey === 'l1' ? 'filterL1' : (levelKey === 'l2' ? 'filterL2' : 'filterL3')];
        const seen = new Set();
        let html = `<option value="">${placeholder}</option>`;

        state.emails.forEach(item => {
          const parsed = parseDescription(item.description);
          const val = extractLevelValue(parsed, levelKey);
          if (val && !seen.has(val)) {
            seen.add(val);
            html += `<option value="${escapeHtml(val)}" ${val === currentVal ? 'selected' : ''}>${escapeHtml(val)}</option>`;
          }
        });
        sel.innerHTML = html;
        sel.classList.toggle('filter-active', !!currentVal);
        sel.title = currentVal ? '已应用此筛选，点击可调整' : '';
      };

      populateLevel('l1', 'filter-l1-select', '类别（全部）');
      populateLevel('l2', 'filter-l2-select', '部门/机构（全部）');
      populateLevel('l3', 'filter-l3-select', '团队/部门（全部）');
    }

    // 处理直接分类切换
    function handleDirectFilterChange(level, val) {
      if (level === 'l1') state.filterL1 = val || '';
      if (level === 'l2') state.filterL2 = val || '';
      if (level === 'l3') state.filterL3 = val || '';

      updateFilterSelectStyles();
      renderEmailList();
      updateSelectedUI();
    }

    // 有筛选值的下拉用品牌色边框高亮，表示当前处于筛选状态
    function updateFilterSelectStyles() {
      const map = {
        'filter-l1-select': state.filterL1,
        'filter-l2-select': state.filterL2,
        'filter-l3-select': state.filterL3
      };
      Object.keys(map).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const on = !!map[id];
        el.classList.toggle('filter-active', on);
        el.title = on ? '已应用此筛选，点击可调整' : '';
      });
    }

    function resetCategoryFilter() {
      state.filterL1 = '';
      state.filterL2 = '';
      state.filterL3 = '';

      ['filter-l1-select', 'filter-l2-select', 'filter-l3-select'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });

      updateFilterSelectStyles();
      renderEmailList();
      updateSelectedUI();
    }

    function renderEmailList() {
      const container = document.getElementById('email-list-container');
      const empty = document.getElementById('empty-state');
      const filtered = getFilteredEmails();

      const group = state.groups.find(g => g.id === state.currentGroupId);
      document.getElementById('current-group-title').textContent =
        state.currentGroupId === '__ungrouped__' ? '未分组' : (group ? group.name : '全部邮箱');
      document.getElementById('filtered-records-count').textContent = '　共 ' + filtered.length + ' 条记录';

      if (filtered.length === 0) {
        container.innerHTML = '';
        empty.classList.remove('hidden');
        renderIcons();
        return;
      }
      empty.classList.add('hidden');

      let html = '';
      filtered.forEach(item => {
        const checked = state.selectedEmailIds.has(item.id);
        const gIds = getGroupIds(item);
        const groupChips = gIds.length
          ? gIds.map(id => {
              const g = state.groups.find(x => x.id === id);
              return g ? `<span class="chip chip-group">${escapeHtml(g.name)}</span>` : '';
            }).join('')
          : '<span class="chip chip-group chip-group-none">未分组</span>';
        const parsed = parseDescription(item.description);

        let tags = '';
        if (parsed.role) {
          tags += `<span class="chip chip-role" title="点击复制角色" data-copy="${escapeHtml(parsed.role)}" onclick="copyFromEl(this)">${escapeHtml(parsed.role)}</span>`;
        }
        parsed.segments.forEach(s => {
          const lv = s.level ? `<span class="lv">${escapeHtml(s.level)}</span>` : '';
          tags += `<span class="chip chip-level" title="点击复制${escapeHtml(s.name)}" data-copy="${escapeHtml(s.name)}" onclick="copyFromEl(this)">${lv}${escapeHtml(s.name)}</span>`;
        });

        html += `
          <div class="row ${checked ? 'selected' : ''}" data-id="${escapeHtml(item.id)}">
            <span class="drag-handle" draggable="true" title="按住拖动排序"><i data-icon="grip-vertical" data-w="14" data-h="14"></i></span>
            <input type="checkbox" ${checked ? 'checked' : ''}
              onchange="toggleEmailSelection('${escapeHtml(item.id)}', this.checked)">
            <div class="row-main">
              <div class="row-top">
                <span class="row-desc click-copy" title="点击复制描述" data-copy="${escapeHtml(item.description)}" onclick="copyFromEl(this)">${escapeHtml(item.description)}</span>
                <span class="tags">${tags}</span>
              </div>
              <div class="row-meta">
                <span class="row-email click-copy" title="点击复制邮箱" data-copy="${escapeHtml(item.email)}" onclick="copyFromEl(this)"><i data-icon="mail" data-w="12" data-h="12"></i>${escapeHtml(item.email)}</span>
                <span class="dot">•</span>
                <span class="tags">${groupChips}</span>
                ${item.notes ? `<span class="dot">•</span><span>备注：${escapeHtml(item.notes)}</span>` : ''}
              </div>
            </div>
            <div class="row-actions">
              <button class="icon-btn copied" title="复制标准格式" onclick="copySingleFormat('${escapeHtml(item.id)}')"><i data-icon="copy" data-w="14" data-h="14"></i></button>
              <button class="icon-btn" title="编辑" onclick="openEditModal('${escapeHtml(item.id)}')"><i data-icon="edit-3" data-w="14" data-h="14"></i></button>
              <button class="icon-btn delete" title="删除" onclick="deleteSingleEmail('${escapeHtml(item.id)}')"><i data-icon="trash-2" data-w="14" data-h="14"></i></button>
            </div>
          </div>`;
      });
      container.innerHTML = html;
      renderIcons();
    }

    /* ==================== 拖拽排序 ==================== */
    // 通过行首手柄拖拽调整显示顺序，并持久化到本地存储
    function setupDragReorder() {
      const container = document.getElementById('email-list-container');
      if (!container) return;
      let draggedId = null;

      const clearDragOverlays = () => {
        container.querySelectorAll('.row.dragging, .row.drop-before, .row.drop-after').forEach(el => {
          el.classList.remove('dragging', 'drop-before', 'drop-after');
        });
      };

      container.addEventListener('dragstart', function (e) {
        const handle = e.target.closest('.drag-handle');
        if (!handle) { e.preventDefault(); return; }
        const row = handle.closest('.row');
        if (!row) return;
        draggedId = row.getAttribute('data-id');
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', draggedId); } catch (err) { /* ignore */ }
      });

      container.addEventListener('dragover', function (e) {
        if (!draggedId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDragOverlays();
        const row = e.target.closest('.row');
        if (!row || row.getAttribute('data-id') === draggedId) return;
        const rect = row.getBoundingClientRect();
        const insertBefore = (e.clientY - rect.top) < rect.height / 2;
        row.classList.add(insertBefore ? 'drop-before' : 'drop-after');
      });

      container.addEventListener('drop', function (e) {
        e.preventDefault();
        if (!draggedId) return;
        const row = e.target.closest('.row');
        if (row && row.getAttribute('data-id') !== draggedId) {
          const rect = row.getBoundingClientRect();
          const insertBefore = (e.clientY - rect.top) < rect.height / 2;
          moveEmail(draggedId, row.getAttribute('data-id'), insertBefore ? 'before' : 'after');
        }
        draggedId = null;
        clearDragOverlays();
      });

      container.addEventListener('dragend', function () {
        draggedId = null;
        clearDragOverlays();
      });

      container.addEventListener('dragleave', function (e) {
        if (e.target === container && !container.contains(e.relatedTarget)) clearDragOverlays();
      });
    }

    // 将 draggedId 移到 targetId 前面/后面。在具体分组视图下仅调整当前分组内顺序，
    // 通过嵌套数组 records[分组id] 记录各分组的成员次序（不改变其他分组的相对顺序）。
    function moveEmail(draggedId, targetId, position) {
      if (state.currentGroupId === 'all' || state.currentGroupId === '__ungrouped__') {
        // 全局或未分组视图：直接调整记录在 emails 中的全局顺序
        const from = state.emails.findIndex(e => e.id === draggedId);
        if (from === -1) return;
        const item = state.emails[from];
        state.emails.splice(from, 1);
        let to = state.emails.findIndex(e => e.id === targetId);
        if (to === -1) { state.emails.splice(from, 0, item); return; }
        if (position === 'after') to += 1;
        state.emails.splice(to, 0, item);
        saveToStorage('emails');
        renderEmailList();
        return;
      }

      // 组视图：仅调整该分组成员顺序，其他分组内顺序不受影响
      const gid = state.currentGroupId;
      const memberIds = getFilteredEmails().map(e => e.id);
      if (memberIds.indexOf(draggedId) === -1 || memberIds.indexOf(targetId) === -1) return;

      const oldOrder = state.emails.map(e => e.id);
      // 提取当前分组成员的现有顺序（按全局顺序读取即可保持稳定性）
      const order = [];
      oldOrder.forEach(id => { if (memberIds.includes(id)) order.push(id); });
      const fromPos = order.indexOf(draggedId);
      const toPos = order.indexOf(targetId);
      if (fromPos === -1 || toPos === -1) return;
      order.splice(fromPos, 1);
      order.splice(toPos + (position === 'after' ? 1 : 0), 0, draggedId);

      // 写回全局顺序：保持非当前分组记录位置不变，仅重排当前分组成员
      const memQueue = order.slice();
      const finalOrder = oldOrder.map(id => {
        if (!memberIds.includes(id)) return id;
        return memQueue.shift();
      });

      // 应用排序到 state.emails
      const byId = new Map(state.emails.map(e => [e.id, e]));
      state.emails = finalOrder.map(id => byId.get(id)).filter(Boolean);
      saveToStorage('emails');
      renderEmailList();
    }

    /* ==================== 勾选与收件人 ==================== */
    function toggleEmailSelection(id, checked) {
      if (checked) state.selectedEmailIds.add(id);
      else state.selectedEmailIds.delete(id);
      renderEmailList();
      updateSelectedUI();
    }

    function toggleSelectAllFiltered() {
      const filtered = getFilteredEmails();
      const allSelected = filtered.length > 0 && filtered.every(e => state.selectedEmailIds.has(e.id));
      filtered.forEach(e => {
        if (allSelected) state.selectedEmailIds.delete(e.id);
        else state.selectedEmailIds.add(e.id);
      });
      renderEmailList();
      updateSelectedUI();
    }

    function clearAllSelection() {
      state.selectedEmailIds.clear();
      renderEmailList();
      updateSelectedUI();
    }

    function updateSelectedUI() {
      const count = state.selectedEmailIds.size;
      document.getElementById('btn-selected-count').textContent = count;
      document.getElementById('header-selected-count').textContent = count;
      document.getElementById('float-selected-count').textContent = count;

      const bar = document.getElementById('floating-action-bar');
      const delBtn = document.getElementById('batch-del-btn');
      const moveBtn = document.getElementById('batch-move-btn');
      if (count > 0) {
        bar.classList.add('open');
        delBtn.classList.remove('hidden');
        moveBtn.classList.remove('hidden');
      } else {
        bar.classList.remove('open');
        delBtn.classList.add('hidden');
        moveBtn.classList.add('hidden');
      }

      const filtered = getFilteredEmails();
      const allChecked = filtered.length > 0 && filtered.every(e => state.selectedEmailIds.has(e.id));
      document.getElementById('select-all-btn-text').textContent = allChecked ? '取消全选' : '全选当前';
    }

    function formatEmailItem(item, formatType) {
      const desc = (item.description || '').replace(/^"|"$/g, '').trim();
      if (formatType === 'simple') return item.email;
      if (formatType === 'comma') return `"${desc}" <${item.email}>`;
      return `"${desc}" <${item.email}>;`;
    }

    function openRecipientModal() {
      // 清理已被删除记录的选中项，避免空选
      [...state.selectedEmailIds].forEach(id => {
        if (!state.emails.some(e => e.id === id)) state.selectedEmailIds.delete(id);
      });
      updateSelectedUI();
      const targetEmails = state.emails.filter(e => state.selectedEmailIds.has(e.id));
      if (targetEmails.length === 0) {
        showToast('当前未勾选任何邮箱', 'warning');
        return;
      }
      document.getElementById('recip-count-badge').textContent = targetEmails.length;
      updateRecipientModalContent();
      openModal('modal-recipient');
    }

    function changeRecipientFormat(fmt) {
      state.recipientFormat = fmt;
      const btnNames = { standard: 'rf-standard', simple: 'rf-simple', comma: 'rf-comma' };
      Object.keys(btnNames).forEach(key => {
        const el = document.getElementById(btnNames[key]);
        if (key === fmt) el.className = 'tab active';
        else el.className = 'tab';
      });
      updateRecipientModalContent();
    }

    function recipientResultText(targetEmails, fmt) {
      const sorted = sortEmailsByGroupOrder(targetEmails);
      if (fmt === 'standard') return sorted.map(e => formatEmailItem(e, 'standard')).join('\n');
      if (fmt === 'comma') return sorted.map(e => formatEmailItem(e, 'comma')).join(', ');
      return sorted.map(e => e.email).join('; ');
    }

    function updateRecipientModalContent() {
      const targets = sortEmailsByGroupOrder(state.emails.filter(e => state.selectedEmailIds.has(e.id)));
      document.getElementById('recipient-result-text').value = recipientResultText(targets, state.recipientFormat);
      document.getElementById('recipient-chips-list').innerHTML = targets.map(e => `
        <span class="mini-chip">
          <span class="n">${escapeHtml(e.description)}</span>
        </span>`).join('');
    }

    function copyGeneratedRecipients() {
      const text = document.getElementById('recipient-result-text').value;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        showToast('收件人列表已复制', 'success');
        const btn = document.getElementById('copy-recip-btn-text');
        btn.textContent = '已复制 ✓';
        setTimeout(() => { btn.textContent = '一键复制收件人列表'; }, 2000);
      }).catch(() => showToast('复制失败，请手动复制', 'error'));
    }

    // 收件人弹窗：另存为 .txt（复用 downloadTextFile）
    function downloadRecipientText() {
      const text = document.getElementById('recipient-result-text').value;
      if (!text) return;
      downloadTextFile(text, '收件人列表_');
    }

    function copySingleFormat(id) {
      const item = state.emails.find(e => e.id === id);
      if (!item) return;
      navigator.clipboard.writeText(formatEmailItem(item, 'standard')).then(() => {
        showToast('已复制标准格式', 'success');
      }).catch(() => showToast('复制失败', 'error'));
    }

    // 点击行内描述/邮箱/分类标签时复制对应内容
    function copyFromEl(el) {
      const text = el.getAttribute('data-copy') || el.textContent.trim();
      copyText(text);
    }

    function copyText(text, label) {
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        showToast((label ? label + '，' : '') + '已复制到剪贴板', 'success');
      }).catch(() => showToast('复制失败', 'error'));
    }

    /* ==================== 主题（深色/浅色） ====================
     * 嵌入 nTools 时主题由父页面决定（否则会出现「主应用深色、邮件页惨白」），
     * 本页不再持久化自己的主题；独立打开时才用到旧的 boc_email_system_theme。 */
    const THEME_KEY = 'boc_email_system_theme';
    const EMBEDDED = (function () {
      try { return window.parent && window.parent !== window; } catch (e) { return false; }
    })();
    let themeLockedByParent = false;

    function initTheme() {
      let theme = 'light';
      if (!EMBEDDED) {
        try {
          const saved = localStorage.getItem(THEME_KEY);
          if (saved === 'dark' || saved === 'light') theme = saved;
        } catch (e) { /* ignore */ }
        if (!localStorage.getItem(THEME_KEY) && window.matchMedia) {
          try {
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
          } catch (e) { /* ignore */ }
        }
      } else {
        /* 等父页面下发；在此之前先跟随系统，避免闪白 */
        try {
          if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
        } catch (e) { /* ignore */ }
      }
      applyTheme(theme);


      window.addEventListener('message', function (event) {
        const data = event.data;
        if (!data || typeof data !== 'object' || data.type !== 'ntools-theme') return;
        themeLockedByParent = true;
        var nextTheme = data.theme === 'light' ? 'light' : 'dark';
        var nextLite = data.lite === true;
        applyTheme(nextTheme);
        document.documentElement.setAttribute('data-lite', nextLite ? 'true' : 'false');
        /* 回报一次，便于主应用/e2e 确认主题与 Lite 都已生效 */
        notifyParent({ type: 'ntools-email-theme', theme: nextTheme, lite: nextLite });
      });

      if (EMBEDDED) {
        /* 主动报一声，父页面收到后会立刻回灌主题 */
        notifyParent({ type: 'ntools-email-theme-request' });
      }
    }

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      if (!EMBEDDED && !themeLockedByParent) {
        try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
      }

    }


    /* ==================== 记录增删改 ==================== */
    // 打开“添加邮箱”弹窗（批量文本导入 + 单条添加）
    function openAddEditModal() {
      switchAddEditTab('import');
      if (!window.__msState) window.__msState = {};
      if (!window.__msState.importMs) initMultiselect('importMs', []);
      // 新建：默认勾选当前查看的分组（未分组视图除外）
      const preset = (state.currentGroupId !== 'all' && state.currentGroupId !== '__ungrouped__')
        ? [state.currentGroupId] : [];
      initMultiselect('editMs', preset);
      populateGroupSelects();
      const form = document.getElementById('form-add-edit');
      if (form && form.reset) form.reset();
      document.getElementById('edit-email-id').value = '';
      document.getElementById('desc-parse-preview').classList.remove('show');
      openModal('modal-add-edit');
    }

    // 打开独立的“编辑邮箱”弹窗；编辑以 id 为主键，不复制/合并其他记录
    function openEditModal(id) {
      const item = state.emails.find(e => e.id === id);
      if (!item) return;
      document.getElementById('edit-email-id').value = item.id;
      document.getElementById('edit-input-email').value = item.email;
      document.getElementById('edit-input-desc').value = item.description;
      document.getElementById('edit-input-notes').value = item.notes || '';
      initMultiselect('editMs2', getGroupIds(item));
      populateGroupSelects();
      handleEditDescInputChange(item.description);
      openModal('modal-edit');
    }

    // 构建一条邮箱记录对象（统一 id 生成与字段初始化）
    function createEmailRecordItem(email, description, groupIds, notes) {
      return {
        id: 'em_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        email,
        description,
        groupIds: Array.isArray(groupIds) ? groupIds.slice() : [],
        notes: notes || ''
      };
    }

    function createEmailRecord(email, description, groupIds, notes) {
      state.emails.push(createEmailRecordItem(email, description, groupIds, notes));
    }

    function handleSaveEmail(e) {
      e.preventDefault();
      const id = document.getElementById('edit-email-id').value;
      const email = document.getElementById('input-email').value.trim();
      const description = document.getElementById('input-desc').value.trim();
      const groupIds = (window.__msState && window.__msState.editMs) ? window.__msState.editMs.slice() : [];
      const notes = document.getElementById('input-notes').value.trim();

      if (!email || !description) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast('邮箱地址格式不正确', 'warning');
        return;
      }
      if (groupIds.length === 0) {
        showToast('请至少选择一个所属分组', 'warning');
        return;
      }

      // 新增（单条添加面板）：同一邮箱并入已有记录的分组，不产生重复行
      const emailLower = email.toLowerCase();
      const existing = state.emails.find(item => item.email.toLowerCase() === emailLower);
      if (existing) {
        existing.groupIds = Array.from(new Set(getGroupIds(existing).concat(groupIds)));
        if (!existing.description) existing.description = description;
        if (!existing.notes) existing.notes = notes;
        showToast('邮箱已存在于其他分组，已并入所选分组', 'success');
      } else {
        createEmailRecord(email, description, groupIds, notes);
        showToast('添加邮箱成功', 'success');
      }
      saveToStorage('emails');
      closeModal('modal-add-edit');
      renderAll();
    }

    // 编辑独立弹窗保存：以 id 为主键，直接覆盖对应记录
    function handleEditEmail(e) {
      e.preventDefault();
      const id = document.getElementById('edit-email-id').value;
      const email = document.getElementById('edit-input-email').value.trim();
      const description = document.getElementById('edit-input-desc').value.trim();
      const groupIds = (window.__msState && window.__msState.editMs2) ? window.__msState.editMs2.slice() : [];
      const notes = document.getElementById('edit-input-notes').value.trim();

      const idx = state.emails.findIndex(item => item.id === id);
      if (idx === -1) {
        showToast('记录不存在，可能已被删除', 'warning');
        return;
      }
      if (!email || !description) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast('邮箱地址格式不正确', 'warning');
        return;
      }
      if (groupIds.length === 0) {
        showToast('请至少选择一个所属分组', 'warning');
        return;
      }

      state.emails[idx].email = email;
      state.emails[idx].description = description;
      state.emails[idx].groupIds = groupIds.slice();
      state.emails[idx].notes = notes;
      saveToStorage('emails');
      closeModal('modal-edit');
      renderAll();
      showToast('邮箱记录已更新', 'success');
    }

    // 描述结构解析预览展示在对应输入框下方的 .parse-box 内
    function handleDescInputChange(val) {
      const box = document.getElementById('desc-parse-preview');
      const tagsEl = document.getElementById('desc-parse-tags');
      if (box && tagsEl) updateDescParse(box, tagsEl, val);
    }

    // 编辑弹窗的独立解析预览
    function handleEditDescInputChange(val) {
      const box = document.getElementById('desc-parse-preview-2');
      const tagsEl = document.getElementById('desc-parse-tags-2');
      if (box && tagsEl) updateDescParse(box, tagsEl, val);
    }

    function updateDescParse(box, tagsEl, val) {
      if (val === undefined) val = '';
      if (!String(val).trim()) {
        box.classList.remove('show');
        return;
      }
      const parsed = parseDescription(val);
      if (!parsed.role && parsed.segments.length === 0) {
        box.classList.remove('show');
        return;
      }
      let html = '';
      if (parsed.role) {
        html += `<span class="chip chip-detail">角色：${escapeHtml(parsed.role)}</span>`;
      }
      parsed.segments.forEach(s => {
        html += `<span class="chip chip-detail">${s.level ? escapeHtml(s.level) + '：' : ''}${escapeHtml(s.name)}</span>`;
      });
      tagsEl.innerHTML = html;
      box.classList.add('show');
      renderIcons();
    }

    function deleteSingleEmail(id) {
      const item = state.emails.find(e => e.id === id);
      if (!item) return;
      requestConfirm('删除邮箱记录', `确定删除「${escapeHtml(item.email)}」？删除后不可恢复。`, 'danger', () => {
        state.emails = state.emails.filter(e => e.id !== id);
        state.selectedEmailIds.delete(id);
        saveToStorage('emails');
        renderAll();
        showToast('记录已删除', 'info');
      });
    }

    function batchDeleteSelected() {
      const count = state.selectedEmailIds.size;
      if (count === 0) return;
      requestConfirm('批量删除邮箱记录', `确定删除已选中的 <strong>${count}</strong> 条邮箱记录？删除后不可恢复。`, 'danger', () => {
        state.emails = state.emails.filter(e => !state.selectedEmailIds.has(e.id));
        state.selectedEmailIds.clear();
        saveToStorage('emails');
        renderAll();
        showToast('已删除 ' + count + ' 条记录', 'info');
      });
    }

    /* ==================== 批量移动 / 复制 ==================== */
    function toggleBatchMoveDropdown(ev) {
      if (ev) ev.stopPropagation();
      const menu = document.getElementById('batch-move-menu');
      if (menu.classList.contains('open')) {
        menu.classList.remove('open');
        return;
      }
      let html = '<div class="dropdown-label">目标分组</div>';
      state.groups.forEach(g => {
        html += `<button class="dropdown-item" onclick="executeBatchMove('${escapeHtml(g.id)}')">${escapeHtml(g.name)}</button>`;
      });
      html += `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--border-subtle);margin-top:4px">
          <input type="checkbox" id="batch-copy-check" onchange="event.stopPropagation()">
          <label class="hint" for="batch-copy-check" style="margin:0;cursor:pointer;color:var(--ink-primary)">复制到分组（保留原分组）</label>
        </div>`;
      menu.innerHTML = html;
      menu.classList.add('open');
      renderIcons();
    }

    document.addEventListener('click', function (ev) {
      const menu = document.getElementById('batch-move-menu');
      if (menu && menu.classList.contains('open') && !menu.parentElement.contains(ev.target)) {
        menu.classList.remove('open');
      }
      // 点击多选下拉外部时收起
      document.querySelectorAll('.multiselect.open').forEach(function (ms) {
        if (ms.contains(ev.target)) return;
        ms.classList.remove('open');
      });
    });

    function executeBatchMove(targetGroupId) {
      const count = state.selectedEmailIds.size;
      if (count === 0) return;
      const copyMode = document.getElementById('batch-copy-check') && document.getElementById('batch-copy-check').checked;
      state.emails.forEach(e => {
        if (!state.selectedEmailIds.has(e.id)) return;
        if (copyMode) {
          // 复制：保留原分组，仅追加目标分组
          const ids = getGroupIds(e);
          if (!ids.includes(targetGroupId)) ids.push(targetGroupId);
          e.groupIds = ids;
        } else {
          // 移动：仅保留目标分组
          e.groupIds = [targetGroupId];
        }
      });
      saveToStorage('emails');
      document.getElementById('batch-move-menu').classList.remove('open');
      renderAll();
      showToast('已将 ' + count + ' 条记录' + (copyMode ? '复制到' : '移动至') + '目标分组', 'success');
    }

    /* ==================== 文本导入 ==================== */
    function fillSampleText() {
      document.getElementById('batch-import-textarea').value =
        '"行政（规划团队/金融科技部/总行（本部））" <keji@email.com>;\n' +
        '"行政（办公管理团队/办公室/总行（本部））" <bangongshi@email.com>;\n' +
        '"行政文秘（规划/人力资源部/总行（本部））" <renli@email.com>;';
    }

    // 添加邮箱弹窗页签切换
    function switchAddEditTab(tab) {
      state.addEditTab = tab;
      const impPanel = document.getElementById('add-import-panel');
      const singlePanel = document.getElementById('add-single-panel');
      const impBtn = document.getElementById('tab-import-btn');
      const singleBtn = document.getElementById('tab-single-btn');
      if (tab === 'import') {
        impPanel.classList.remove('hidden');
        singlePanel.classList.add('hidden');
        impBtn.className = 'tab active';
        singleBtn.className = 'tab';
      } else {
        impPanel.classList.add('hidden');
        singlePanel.classList.remove('hidden');
        impBtn.className = 'tab';
        singleBtn.className = 'tab active';
      }
    }

    function parseEmailText(text) {
      const results = [];
      const itemRegex = /(?:"([^"]*)"|([^<;,\n\r]+))?\s*<\s*([^>\s]+)\s*>/g;
      let m;
      while ((m = itemRegex.exec(text)) !== null) {
        results.push({ desc: m[1] || m[2] || '', email: m[3] });
      }
      const bareRegex = /(?:^|[;,\s])([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})(?=[;,\s]|$)/g;
      let b;
      while ((b = bareRegex.exec(text)) !== null) {
        results.push({ desc: '', email: b[1] });
      }
      return results;
    }

    function handleExecuteImport() {
      const text = document.getElementById('batch-import-textarea').value;
      const targetIds = window.__msState ? window.__msState.importMs : [];
      const policy = document.getElementById('import-conflict-policy').value;
      const batchNotes = document.getElementById('import-notes-input').value.trim();

      if (!text.trim()) {
        showToast('请先输入或粘贴文本内容', 'warning');
        return;
      }
      if (!targetIds || targetIds.length === 0) {
        showToast('请至少选择一个目标分组', 'warning');
        return;
      }

      const items = parseEmailText(text);
      const seen = new Map();
      let added = 0, updated = 0, skipped = 0, invalid = 0;

      items.forEach(it => {
        const email = it.email.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { invalid++; return; }
        const key = email.toLowerCase();
        // 同一批次内重复的邮箱一律只保留首个（第一条优先），不做重复记录
        if (seen.has(key)) { skipped++; return; }
        seen.set(key, true);

        const desc = it.desc.trim().replace(/^"|"$/g, '') || email.split('@')[0];
        const existingIndex = state.emails.findIndex(e => e.email.toLowerCase() === key);

        if (existingIndex !== -1) {
          const existing = state.emails[existingIndex];
          if (policy === 'skip') { skipped++; return; }
          if (policy === 'update') {
            // 合并更新：合并分组、更新描述与备注（备注非空时追加）
            const currentIds = getGroupIds(existing);
            targetIds.forEach(id => { if (!currentIds.includes(id)) currentIds.push(id); });
            existing.groupIds = currentIds;
            existing.description = desc;
            if (batchNotes) {
              existing.notes = (existing.notes ? existing.notes + '；' : '') + batchNotes;
            } else if (!existing.notes) {
              existing.notes = '文本导入';
            }
            updated++;
            return;
          }
        }
        state.emails.push(createEmailRecordItem(email, desc, targetIds, batchNotes || '文本导入'));
        added++;
      });

      saveToStorage('emails');
      renderAll();
      closeModal('modal-add-edit');
      showToast(`导入完成：新增 ${added} 条，更新 ${updated} 条，跳过 ${skipped} 条` + (invalid ? `，无效 ${invalid} 条` : ''), 'success');
    }

    /* ==================== 备份恢复页签 ==================== */
    function switchBackupTab(tab) {
      const jsonPanel = document.getElementById('backup-json-panel');
      const exportPanel = document.getElementById('backup-export-panel');
      const jsonBtn = document.getElementById('tab-backup-json-btn');
      const exportBtn = document.getElementById('tab-backup-export-btn');
      if (jsonPanel) jsonPanel.classList.toggle('hidden', tab !== 'json');
      if (exportPanel) exportPanel.classList.toggle('hidden', tab !== 'export');
      if (jsonBtn) jsonBtn.className = tab === 'json' ? 'tab active' : 'tab';
      if (exportBtn) exportBtn.className = tab === 'export' ? 'tab active' : 'tab';
      if (tab === 'export') updateExportText();
    }

    function openBackupTab(tab) {
      openModal('modal-backup');
      switchBackupTab(tab || 'json');
    }

    /* ==================== 文本导出 ==================== */
    function setExportFormat(fmt, btnEl) {
      state.exportFormat = fmt;
      document.querySelectorAll('.fmt-btn').forEach(btn => btn.classList.remove('active'));
      btnEl.classList.add('active');
      updateExportText();
    }

    function updateExportText() {
      // 备份恢复中的“格式文本导出”固定导出全部邮箱（与当前界面/勾选无关）
      const targets = state.emails.slice();
      document.getElementById('export-count-hint').textContent = '当前输出 ' + targets.length + ' 条';

      let output = '';
      if (state.exportFormat === 'email-only') {
        output = targets.map(e => e.email).join('; ');
      } else if (state.exportFormat === 'comma') {
        output = targets.map(e => formatEmailItem(e, 'comma')).join(',\n');
      } else {
        output = targets.map(e => formatEmailItem(e, 'standard')).join('\n');
      }
      document.getElementById('batch-export-textarea').value = output;
    }

    function copyExportContent() {
      const text = document.getElementById('batch-export-textarea').value;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => showToast('导出文本已复制', 'success'))
        .catch(() => showToast('复制失败', 'error'));
    }

    function downloadTextFile(text, filename) {
      const content = text != null ? text : document.getElementById('batch-export-textarea').value;
      if (!content) return;
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (filename || '邮箱导出_') + dateStamp() + '.txt';
      a.click();
      URL.revokeObjectURL(url);
    }

    function dateStamp() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /* ==================== JSON 备份与恢复 ==================== */
    function exportJSONBackup() {
      const backup = {
        version: '1.1',
        exportTime: new Date().toISOString(),
        groups: state.groups,               // 顺序即分组排序（管理弹窗可拖拽调整）
        emails: applyGroupOrderToEmails()   // 按“分组顺序→组内顺序”导出，已去重
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '邮箱工具备份_' + dateStamp() + '.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('备份文件已下载', 'success');
    }

    function handleJSONFileImport(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          /* 兼容三种形状：完整文档 / {groups,emails} / 纯邮箱数组 */
          const incoming = Array.isArray(data)
            ? { groups: [], emails: data }
            : (data && typeof data === 'object' ? data : null);
          if (!incoming || (!Array.isArray(incoming.groups) && !Array.isArray(incoming.emails))) {
            showToast('JSON 备份格式不匹配', 'error');
            return;
          }
          /* 先归一化再确认：预览里显示的数字就是最终会落盘的数字 */
          const preview = normalizeDoc({
            schemaVersion: DOC_VERSION,
            groups: Array.isArray(incoming.groups) ? incoming.groups : [],
            emails: Array.isArray(incoming.emails) ? incoming.emails : []
          });
          const badCount = preview.dropped.groups + preview.dropped.emails;
          const dupCount = preview.dropped.dupes;
          const summary = '从备份恢复数据？将导入 <strong>' + preview.doc.groups.length +
            '</strong> 个分组、<strong>' + preview.doc.emails.length + '</strong> 条邮箱记录' +
            (badCount ? '（忽略 <strong>' + badCount + '</strong> 条非法记录）' : '') +
            (dupCount ? '（合并 <strong>' + dupCount + '</strong> 条重复邮箱）' : '') +
            '，并覆盖当前数据。旧数据可先导出备份。';
          requestConfirm('从备份文件还原', summary, 'danger', '确认', () => {
            state.groups = preview.doc.groups;
            state.emails = preview.doc.emails;
            applyGroupOrderToEmails();
            state.currentGroupId = 'all';
            state.searchQuery = '';
            state.filterL1 = '';
            state.filterL2 = '';
            state.filterL3 = '';
            state.selectedEmailIds.clear();
            if (!saveToStorage('both')) return;   // 写失败就不假装成功
            renderAll();
            closeModal('modal-backup');
            showToast('数据恢复成功', 'success');
          });
        } catch (err) {
          showToast('无法解析 JSON 文件：' + err.message, 'error');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    /* ==================== 分组管理 ==================== */
    function openGroupsModal() {
      renderGroupManageList();
      openModal('modal-groups');
      setupGroupDragReorder();
    }

    function renderGroupManageList() {
      const list = document.getElementById('group-manage-list');
      if (state.groups.length === 0) {
        list.innerHTML = '<div class="hint" style="text-align:center;padding:16px">暂无分组，请先创建。</div>';
        return;
      }
      list.innerHTML = state.groups.map(g => {
        const count = state.emails.filter(e => getGroupIds(e).includes(g.id)).length;
        return `
          <div class="manage-row" data-group="${escapeHtml(g.id)}">
            <span class="drag-handle" draggable="true" title="按住拖动排序"><i data-icon="grip-vertical" data-w="14" data-h="14"></i></span>
            <div class="manage-name">
              <input type="text" value="${escapeHtml(g.name)}" onchange="handleRenameGroup('${jsArg(g.id)}', this.value)">
              <div class="manage-count">关联邮箱：${count} 条</div>
            </div>
            <button class="icon-btn delete" title="删除分组" onclick="handleDeleteGroup('${jsArg(g.id)}')"><i data-icon="trash-2" data-w="14" data-h="14"></i></button>
          </div>`;
      }).join('');
      renderIcons();
    }

    // 分组管理弹窗内的分组重排序（与邮箱列表的重排序逻辑一致）
    function setupGroupDragReorder() {
      const container = document.getElementById('group-manage-list');
      if (!container) return;
      if (container.getAttribute('data-sort-ready')) return;
      container.setAttribute('data-sort-ready', '1');
      let draggedGroup = null;

      const clearDragOverlays = () => {
        container.querySelectorAll('.manage-row.dragging, .manage-row.drop-before, .manage-row.drop-after').forEach(el => {
          el.classList.remove('dragging', 'drop-before', 'drop-after');
        });
      };

      container.addEventListener('dragstart', function (e) {
        const handle = e.target.closest('.drag-handle');
        if (!handle) { e.preventDefault(); return; }
        const row = handle.closest('.manage-row');
        if (!row) return;
        draggedGroup = row.getAttribute('data-group');
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', draggedGroup); } catch (err) { /* ignore */ }
      });

      container.addEventListener('dragover', function (e) {
        if (!draggedGroup) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDragOverlays();
        const row = e.target.closest('.manage-row');
        if (!row || row.getAttribute('data-group') === draggedGroup) return;
        const rect = row.getBoundingClientRect();
        const insertBefore = (e.clientY - rect.top) < rect.height / 2;
        row.classList.add(insertBefore ? 'drop-before' : 'drop-after');
      });

      container.addEventListener('drop', function (e) {
        e.preventDefault();
        if (!draggedGroup) return;
        const row = e.target.closest('.manage-row');
        if (row && row.getAttribute('data-group') !== draggedGroup) {
          const rect = row.getBoundingClientRect();
          const insertBefore = (e.clientY - rect.top) < rect.height / 2;
          moveGroup(draggedGroup, row.getAttribute('data-group'), insertBefore ? 'before' : 'after');
        }
        draggedGroup = null;
        clearDragOverlays();
      });

      container.addEventListener('dragend', function () {
        draggedGroup = null;
        clearDragOverlays();
      });

      container.addEventListener('dragleave', function (e) {
        if (e.target === container && !container.contains(e.relatedTarget)) clearDragOverlays();
      });
    }

    // 将 draggedGroup 移动到 targetGroup 的前面或后面，并持久化
    function moveGroup(draggedGroup, targetGroup, position) {
      const from = state.groups.findIndex(g => g.id === draggedGroup);
      if (from === -1) return;
      const item = state.groups[from];
      state.groups.splice(from, 1);
      let to = state.groups.findIndex(g => g.id === targetGroup);
      if (to === -1) { state.groups.splice(from, 0, item); return; }
      if (position === 'after') to += 1;
      state.groups.splice(to, 0, item);
      saveToStorage('groups');
      // 同步刷新分组管理列表与左侧分组目录
      renderGroupManageList();
      renderGroupNav();
    }

    function handleAddNewGroup() {
      const input = document.getElementById('new-group-name-input');
      const name = input.value.trim();
      if (!name) {
        showToast('请输入分组名称', 'warning');
        return;
      }
      if (state.groups.some(g => g.name === name)) {
        showToast('已存在同名分组', 'warning');
        return;
      }
      state.groups.push({ id: 'g_' + Date.now(), name });
      saveToStorage('groups');
      input.value = '';
      renderGroupManageList();
      renderAll();
      showToast('分组已创建', 'success');
    }

    function handleRenameGroup(id, newName) {
      const name = newName.trim();
      if (!name) return;
      const g = state.groups.find(x => x.id === id);
      if (!g) return;
      g.name = name;
      saveToStorage('groups');
      renderAll();
      showToast('分组名称已更新', 'success');
    }

    function handleDeleteGroup(id) {
      const g = state.groups.find(x => x.id === id);
      const count = state.emails.filter(e => getGroupIds(e).includes(id)).length;
      const done = () => {
        removeGroupIdFromEmails(id);
        state.groups = state.groups.filter(x => x.id !== id);
        if (state.currentGroupId === id) state.currentGroupId = 'all';
        saveToStorage('both');
        renderGroupManageList();
        renderAll();
        showToast('分组已删除', 'info');
      };
      if (count > 0) {
        requestConfirm('删除分组', `分组「${escapeHtml(g ? g.name : id)}」当前关联 <strong>${count}</strong> 条邮箱记录。删除后这些记录将从该分组移除（仍保留在其他分组）。确认删除？`, 'danger', done);
      } else {
        requestConfirm('删除分组', `确认删除分组「${escapeHtml(g ? g.name : id)}」？`, 'danger', done);
      }
    }

    // 从所有邮箱的分组数组中移除指定分组 id
    function removeGroupIdFromEmails(id) {
      state.emails.forEach(e => {
        const ids = getGroupIds(e);
        const idx = ids.indexOf(id);
        if (idx !== -1) { ids.splice(idx, 1); e.groupIds = ids; }
      });
    }

    function populateGroupSelects() {
      // 按当前选中态重建三组多选框的选项（导入目标 importMs；单条添加 editMs；编辑弹窗 editMs2）
      ['importMs', 'editMs', 'editMs2'].forEach(name => {
        const ids = msIds(name);
        renderGroupOptionList(document.getElementById(ids.menu), name);
      });
    }

    /* ==================== 搜索与模态 ==================== */
    function setFilterGroup(groupId) {
      state.currentGroupId = groupId;
      renderAll();
    }

    function handleSearch(val) {
      state.searchQuery = val.trim();
      document.getElementById('search-clear-btn').classList.toggle('hidden', !state.searchQuery);
      renderEmailList();
      updateSelectedUI();
    }

    function clearSearch() {
      document.getElementById('search-input').value = '';
      handleSearch('');
    }

    function openModal(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('closed');
      el.classList.add('open');
      if (id === 'modal-groups') renderGroupManageList();
      renderIcons(el);
    }

    function closeModal(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('closed');
      el.classList.remove('open');
    }

    /* ==================== 自定义多选下拉 ==================== */
    // 初始化某个多选：值持久化在 window.__msState[name]，渲染选项与触发器回显
    function initMultiselect(name, values) {
      window.__msState = window.__msState || {};
      window.__msState[name] = Array.isArray(values) ? values.slice() : [];
      renderMultiselect(name);
      populateGroupSelects();
    }

    // 渲染某个多选的选项列表
    function renderGroupOptionList(menuEl, name) {
      if (!menuEl) return;
      const current = (window.__msState && window.__msState[name]) || [];
      if (state.groups.length === 0) {
        menuEl.innerHTML = '<div class="ms-menu-empty">暂无分组，请先创建分组</div>';
        return;
      }
      menuEl.innerHTML = state.groups.map(g => {
        const checked = current.includes(g.id);
        return `
          <button type="button" class="ms-opt ${checked ? 'checked' : ''}" data-name="${name}" data-group="${escapeHtml(g.id)}">
            <span class="ms-box"><i data-icon="check" data-w="12" data-h="12"></i></span>
            <span class="ms-label">${escapeHtml(g.name)}</span>
          </button>`;
      }).join('');
    }

    // 弹窗命名约定: importMs→import-ms* ; editMs(单条添加)→edit-ms* ; editMs2(编辑弹窗)→edit-ms-2*
    function msIds(name) {
      if (name === 'importMs') return { root: 'import-ms', menu: 'import-ms-menu', placeholder: 'import-ms-placeholder' };
      if (name === 'editMs2') return { root: 'edit-ms-2', menu: 'edit-ms-menu-2', placeholder: 'edit-ms-placeholder-2' };
      return { root: 'edit-ms', menu: 'edit-ms-menu', placeholder: 'edit-ms-placeholder' };
    }

    // 重绘某组多选框（选项、触发器占位符与勾选态）
    function renderMultiselect(name) {
      const ids = msIds(name);
      const menuEl = document.getElementById(ids.menu);
      renderGroupOptionList(menuEl, name);
      const current = (window.__msState && window.__msState[name]) || [];
      const placeholder = document.getElementById(ids.placeholder);
      const root = document.getElementById(ids.root);
      if (placeholder) {
        if (current.length === 0) {
          placeholder.textContent = name === 'importMs' ? '请选择目标分组' : '请选择所属分组';
          placeholder.classList.remove('ms-filled');
        } else if (current.length === 1) {
          // 单选：直接显示分组名
          const g = state.groups.find(x => x.id === current[0]);
          placeholder.textContent = g ? g.name : '';
          placeholder.classList.add('ms-filled');
        } else {
          // 多选：显示已选数量
          placeholder.textContent = `已选择 ${current.length} 个分组`;
          placeholder.classList.add('ms-filled');
        }
      }
      if (root) renderIcons(root);
    }

    // 触发多选下拉展开/收起（onclick 绑定在容器上）
    function toggleMultiselect(root, ev) {
      // 点击下拉内部的选项、操作元素时不切换开合状态（由选项点击处理接管）
      if (ev && ev.target.closest && (ev.target.closest('.ms-opt') || ev.target.closest('.ms-menu'))) {
        return;
      }
      if (ev && ev.target.closest) {
        const xBtn = ev.target.closest('.ms-chip-x');
        if (xBtn) {
          ev.stopPropagation();
          const name = root.getAttribute('data-name') || (root.id ? root.id.slice(0, -3) : '');
          const gid = xBtn.getAttribute('data-group');
          if (name && window.__msState && window.__msState[name]) {
            window.__msState[name] = window.__msState[name].filter(id => id !== gid);
          }
          renderMultiselect(name);
          return;
        }
      }
      root.classList.toggle('open');
      if (root.classList.contains('open')) renderIcons(root);
    }

    // 阻止点击下拉区域内部时冒泡到 document 的收起处理
    document.addEventListener('click', function (ev) {
      const ms = ev.target.closest ? ev.target.closest('.multiselect') : null;
      if (ms) ev.stopPropagation();
    });

    // 点击选项：切换选中（保持下拉打开，不收起）
    document.addEventListener('click', function (ev) {
      const opt = ev.target.closest ? ev.target.closest('.ms-opt') : null;
      if (!opt || (opt.classList && opt.classList.contains('empty-msg'))) return;
      const name = opt.getAttribute && opt.getAttribute('data-name');
      const gid = opt.getAttribute && opt.getAttribute('data-group');
      if (!name || !window.__msState || !window.__msState[name]) return;
      ev.stopPropagation();
      const arr = window.__msState[name];
      const idx = arr.indexOf(gid);
      if (idx !== -1) arr.splice(idx, 1); else arr.push(gid);
      // 重新渲染选项与触发器，但保持下拉打开
      const root = document.getElementById(msIds(name).root);
      const open = root && root.classList.contains('open');
      renderMultiselect(name);
      if (open && root) root.classList.add('open');
    });

    function showToast(msg, type) {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      const icons = { success: 'check-circle', warning: 'alert-triangle', error: 'alert-circle', info: 'info' };
      const icon = icons[type] || 'info';
      toast.className = 'toast ' + (type || 'info');
      toast.id = 'toast-' + Date.now();
      toast.innerHTML = `<i data-icon="${icon}" data-w="14" data-h="14"></i><span>${escapeHtml(msg)}</span>`;
      container.appendChild(toast);
      renderIcons(toast);
      requestAnimationFrame(() => toast.classList.add('show'));
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
      }, 3000);
    }

    /* ==================== 自定义确认弹窗 ==================== */
    let confirmCb = null;

    function requestConfirm(title, msgHtml, kind, okLabel, cb) {
      if (typeof okLabel === 'function' && cb === undefined) { cb = okLabel; okLabel = ''; }
      document.getElementById('confirm-title').textContent = title || '确认操作';
      document.getElementById('confirm-msg').innerHTML = msgHtml || '';
      const iconEl = document.getElementById('confirm-icon');
      const iconBtn = document.getElementById('confirm-ok-btn');
      const danger = kind === 'danger';
      iconEl.className = 'confirm-icon' + (danger ? ' danger' : '');
      const icon = danger ? 'trash' : 'alert-triangle';
      iconEl.innerHTML = `<i data-icon="${icon}" data-w="20" data-h="20"></i>`;
      iconBtn.className = danger ? 'btn btn-danger-ghost' : 'btn btn-primary';
      // 确认按钮文案：未指定时，仅真正“删除”类操作取“删除”，其余默认“确认”
      iconBtn.textContent = okLabel || (danger ? '删除' : '确认');
      const cancelBtn = document.getElementById('confirm-cancel-btn');
      if (cancelBtn) cancelBtn.textContent = '取消';
      confirmCb = cb;
      openModal('modal-confirm');
      renderIcons(iconEl);
    }

    function confirmCancel() {
      confirmCb = null;
      closeModal('modal-confirm');
    }

    function confirmOk() {
      const cb = confirmCb;
      confirmCb = null;
      closeModal('modal-confirm');
      if (typeof cb === 'function') cb();
    }

    function escapeHtml(string) {
      if (string === undefined || string === null) return '';
      if (typeof string !== 'string') string = String(string);
      return string
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\//g, '&#x2F;');
    }

    // 测试辅助：暴露内部状态
    window.__test = {
      state: state,
      getParsed: parseDescription,
      getFiltered: getFilteredEmails,
      getGroupIds: getGroupIds,
      reload: loadStorageData
    };
  
