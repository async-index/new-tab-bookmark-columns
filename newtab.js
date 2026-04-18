'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 260;

let state = {
  theme: 'system',
  dividers: false,
  hideHandles: false,
  showHidden: false,
  columns: [],   // [{ id: string, width: number, folderIds: string[] }]
};

let allFolders = [];   // flat list of all BookmarkTreeNode folders
let faviconCache = {}; // { [domain]: url | "chrome" | "none" }
let hiddenIds = {}; // { [colId: string]: Set<string> } — per-column hidden IDs
let draggedItem = null;  // { node, folderId } during drag (bookmark or subfolder)
let ctxMenu = null;    // singleton context menu element
let folderOpen = {};   // { [folderId]: boolean } subfolder open state

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(['theme', 'dividers', 'hideHandles', 'showHidden', 'columns', 'faviconCache', 'folderOpen', 'hiddenIds']);
  if (stored.theme)               state.theme       = stored.theme;
  if (stored.dividers != null)    state.dividers    = stored.dividers;
  if (stored.hideHandles != null) state.hideHandles = stored.hideHandles;
  if (stored.showHidden != null)  state.showHidden  = stored.showHidden;
  if (stored.columns?.length)     state.columns     = stored.columns;
  if (stored.faviconCache)        faviconCache      = stored.faviconCache;
  if (stored.folderOpen)          folderOpen        = stored.folderOpen;
  if (stored.hiddenIds && !Array.isArray(stored.hiddenIds)) {
    for (const [colId, ids] of Object.entries(stored.hiddenIds)) {
      hiddenIds[colId] = new Set(ids);
    }
  }

  applyTheme(state.theme);
  applyDividers(state.dividers);
  applyHideHandles(state.hideHandles);

  const tree = await chrome.bookmarks.getTree();
  allFolders = collectFolders(tree[0]);

  if (!state.columns.length) {
    state.columns = defaultColumns(tree[0]);
    await persist();
  }

  renderColumns();
  setupSettings();
});

// ─── Bookmarks ────────────────────────────────────────────────────────────────

function collectFolders(node, acc = []) {
  if (!node.children) return acc;
  // Skip the invisible root (id "0", empty title)
  if (node.id !== '0') acc.push(node);
  for (const child of node.children) collectFolders(child, acc);
  return acc;
}

function defaultColumns(root) {
  // The bookmark tree root has two standard children:
  //   id "1" = Bookmarks bar
  //   id "2" = Other bookmarks
  // (some profiles also have "3" = Mobile bookmarks)
  const containers = root.children ?? [];

  const bar = containers.find(n => n.id === '1');

  const cols = [];

  // Try subfolders of the bookmarks bar first (one column each)
  const barFolders = (bar?.children ?? []).filter(n => n.children);
  if (barFolders.length) {
    barFolders.forEach((f, i) => {
      cols.push({ id: `col-${i}-${Date.now()}`, width: DEFAULT_WIDTH, folderIds: [f.id] });
    });
    return cols;
  }

  // No subfolders — treat the bar itself as one column
  if (bar) cols.push({ id: `col-0-${Date.now()}`, width: DEFAULT_WIDTH, folderIds: [bar.id] });

  // Last resort: one column per top-level container
  if (!cols.length) {
    containers.forEach((n, i) => {
      if (n.children) cols.push({ id: `col-${i}-${Date.now()}`, width: DEFAULT_WIDTH, folderIds: [n.id] });
    });
  }

  return cols;
}

function folderById(id) {
  return allFolders.find(f => f.id === id);
}

function makeFavicon(url) {
  let domain;
  try { domain = new URL(url).hostname; } catch { return null; }

  const img = document.createElement('img');
  img.className = 'bookmark-favicon';
  img.alt = '';

  const chromeUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
  const appleUrl  = `https://${domain}/apple-touch-icon.png`;

  const cached = faviconCache[domain];

  if (cached === 'none') {
    img.classList.add('hidden');
  } else if (cached === 'chrome') {
    img.src = chromeUrl;
    img.addEventListener('error', () => img.classList.add('hidden'), { once: true });
  } else if (cached) {
    // Cached apple-touch-icon URL
    img.src = cached;
    img.addEventListener('error', () => img.classList.add('hidden'), { once: true });
  } else {
    // Not yet cached — probe apple-touch-icon first
    img.src = appleUrl;
    img.addEventListener('load', () => {
      faviconCache[domain] = appleUrl;
      persistFaviconCache();
    }, { once: true });
    img.addEventListener('error', () => {
      // Fall back to Chrome favicon cache
      img.src = chromeUrl;
      img.addEventListener('load', () => {
        faviconCache[domain] = 'chrome';
        persistFaviconCache();
      }, { once: true });
      img.addEventListener('error', () => {
        faviconCache[domain] = 'none';
        persistFaviconCache();
        img.classList.add('hidden');
      }, { once: true });
    }, { once: true });
  }

  return img;
}

function persistFaviconCache() {
  chrome.storage.local.set({ faviconCache });
}

function persistHiddenIds() {
  const serialized = {};
  for (const [colId, ids] of Object.entries(hiddenIds)) {
    serialized[colId] = [...ids];
  }
  chrome.storage.local.set({ hiddenIds: serialized });
}

function isHidden(id, colId) {
  return hiddenIds[colId]?.has(id) ?? false;
}

function toggleHidden(id, colId) {
  if (!hiddenIds[colId]) hiddenIds[colId] = new Set();
  if (hiddenIds[colId].has(id)) hiddenIds[colId].delete(id);
  else hiddenIds[colId].add(id);
  persistHiddenIds();
  refresh();
}

function makeFolderIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 18 15');
  svg.setAttribute('fill', 'none');
  svg.classList.add('subfolder-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2.49023 14.1602H15.3027C16.6895 14.1602 17.5098 13.3398 17.5098 11.6992V3.84766C17.5098 2.20703 16.6797 1.39648 15.0195 1.39648H7.70508C7.22656 1.39648 6.91406 1.25977 6.54297 0.957031L6.05469 0.566406C5.54688 0.146484 5.12695 0 4.38477 0H2.19727C0.820312 0 0 0.800781 0 2.43164V11.6992C0 13.3398 0.830078 14.1602 2.49023 14.1602ZM2.50977 12.7441C1.80664 12.7441 1.40625 12.373 1.40625 11.6309V2.5C1.40625 1.77734 1.79688 1.40625 2.5 1.40625H4.01367C4.49219 1.40625 4.80469 1.54297 5.17578 1.8457L5.66406 2.23633C6.16211 2.64648 6.5918 2.80273 7.33398 2.80273H15C15.7031 2.80273 16.1035 3.18359 16.1035 3.92578V11.6406C16.1035 12.373 15.7031 12.7441 15 12.7441H2.50977ZM2.45117 5.2832H15.0586V4.72656C15.0586 4.25781 14.834 4.05273 14.375 4.05273H3.13477C2.68555 4.05273 2.45117 4.25781 2.45117 4.72656V5.2832Z');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('fill-opacity', '0.85');
  svg.appendChild(path);
  return svg;
}

// ─── Render columns ───────────────────────────────────────────────────────────

function renderColumns() {
  const container = document.getElementById('columns-container');
  container.innerHTML = '';

  state.columns.forEach((col, i) => {
    if (i > 0) {
      container.appendChild(makeHandle(i - 1));
    }
    container.appendChild(makeColumn(col));
  });

  // Handle + spacer after the last column so it's also resizable
  if (state.columns.length > 0) {
    container.appendChild(makeHandle(state.columns.length - 1));
    const spacer = document.createElement('div');
    spacer.className = 'column-spacer';
    container.appendChild(spacer);
  }
}

async function refresh() {
  const tree = await chrome.bookmarks.getTree();
  allFolders = collectFolders(tree[0]);
  renderColumns();
  if (!document.getElementById('settings-panel').classList.contains('hidden')) {
    renderColumnsConfig();
  }
}

function makeColumn(col) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.colId = col.id;
  el.style.flexBasis = `${col.width}px`;

  col.folderIds.forEach(fid => {
    const folder = folderById(fid);
    if (folder) el.appendChild(makeFolderGroup(folder, 0, null, 0, col.id));
  });

  return el;
}

function makeFolderGroup(folder, depth = 0, siblings = null, idx = 0, colId = null) {
  const group = document.createElement('div');
  group.className = depth === 0 ? 'folder-group' : 'subfolder-group';

  if (depth === 0) {
    // Top-level: always-visible label, no toggle
    const label = document.createElement('div');
    label.className = 'folder-label';
    label.textContent = folder.title;

    label.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: 'Rename', action: () => startFolderRename(folder, label) },
      ]);
    });

    group.appendChild(label);
  } else {
    // Subfolder: collapsible header
    const isOpen = folderOpen[folder.id] ?? false;

    const header = document.createElement('button');
    header.className = 'subfolder-header';

    const icon = makeFolderIcon();
    header.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'subfolder-name';
    name.textContent = folder.title;
    header.appendChild(name);

    const arrow = document.createElement('span');
    arrow.className = 'subfolder-arrow' + (isOpen ? ' open' : '');
    header.appendChild(arrow);

    group.appendChild(header);

    const content = document.createElement('div');
    content.className = 'subfolder-content';
    content.hidden = !isOpen;
    renderFolderContents(folder, content, depth, colId);
    group.appendChild(content);

    header.addEventListener('click', () => {
      const open = content.hidden;
      content.hidden = !open;
      arrow.classList.toggle('open', open);
      folderOpen[folder.id] = open;
      chrome.storage.local.set({ folderOpen });
    });

    header.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: 'Rename', action: () => startFolderRename(folder, name) },
        null,
        {
          label: 'Move up',
          disabled: idx === 0,
          action: async () => {
            await chrome.bookmarks.move(folder.id, { index: siblings[idx - 1].index });
            refresh();
          },
        },
        {
          label: 'Move down',
          disabled: idx === siblings.length - 1,
          action: async () => {
            await chrome.bookmarks.move(folder.id, { index: siblings[idx + 1].index + 1 });
            refresh();
          },
        },
        null,
        { label: isHidden(folder.id, colId) ? 'Show' : 'Hide', action: () => toggleHidden(folder.id, colId) },
        null,
        {
          label: 'Delete', danger: true, action: async () => {
            await chrome.bookmarks.removeTree(folder.id);
            refresh();
          },
        },
      ]);
    });

    return group;
  }

  renderFolderContents(folder, group, depth, colId);
  return group;
}

function renderFolderContents(folder, container, depth, colId) {
  const children = folder.children ?? [];
  children.forEach((child, idx) => {
    if (child.children != null) {
      if (!state.showHidden && isHidden(child.id, colId)) return;
      const group = makeFolderGroup(child, depth + 1, children, idx, colId);
      if (isHidden(child.id, colId)) group.classList.add('item-hidden');

      // ── Subfolder drag to reorder (same system as bookmarks) ──
      group.draggable = true;
      group.dataset.id = child.id;

      group.addEventListener('dragstart', e => {
        e.stopPropagation();
        draggedItem = { node: child, folderId: folder.id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', child.id);
        requestAnimationFrame(() => group.classList.add('dragging'));
      });

      group.addEventListener('dragend', () => {
        group.classList.remove('dragging');
        draggedItem = null;
        clearDropIndicators(container);
      });

      group.addEventListener('dragover', e => {
        if (!draggedItem || draggedItem.node.id === child.id) return;
        if (draggedItem.folderId !== folder.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        clearDropIndicators(container);
        const rect = group.getBoundingClientRect();
        group.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
      });

      group.addEventListener('dragleave', () => group.classList.remove('drop-before', 'drop-after'));

      group.addEventListener('drop', async e => {
        e.preventDefault();
        e.stopPropagation();
        const isAfter = group.classList.contains('drop-after');
        group.classList.remove('drop-before', 'drop-after');
        if (!draggedItem || draggedItem.node.id === child.id) return;
        if (draggedItem.folderId !== folder.id) return;

        let targetIndex;
        const draggedBefore = draggedItem.node.index < child.index;
        if (isAfter) {
          targetIndex = draggedBefore ? child.index : child.index + 1;
        } else {
          targetIndex = draggedBefore ? child.index - 1 : child.index;
        }
        await chrome.bookmarks.move(draggedItem.node.id, { parentId: folder.id, index: targetIndex });
        refresh();
      });

      container.appendChild(group);
    } else if (child.url) {
      if (!state.showHidden && isHidden(child.id, colId)) return;
      container.appendChild(makeBookmarkItem(child, folder, children, idx, colId));
    }
  });
}

function clearDropIndicators(container) {
  container.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
}

function makeBookmarkItem(bm, folder, siblings, idx, colId) {
  const a = document.createElement('a');
  a.className = 'bookmark-item';
  if (isHidden(bm.id, colId)) a.classList.add('item-hidden');
  a.href = bm.url;
  a.title = bm.title || bm.url;
  a.dataset.id = bm.id;
  a.draggable = true;

  const img = makeFavicon(bm.url);
  if (img) a.appendChild(img);

  const span = document.createElement('span');
  span.className = 'bookmark-title';
  span.textContent = bm.title || bm.url;
  a.appendChild(span);

  // ── Context menu ──
  a.addEventListener('contextmenu', e => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: 'Rename', action: () => startRename(bm, a) },
      null,
      {
        label: 'Move up',
        disabled: idx === 0,
        action: async () => {
          await chrome.bookmarks.move(bm.id, { index: siblings[idx - 1].index });
          refresh();
        },
      },
      {
        label: 'Move down',
        disabled: idx === siblings.length - 1,
        action: async () => {
          await chrome.bookmarks.move(bm.id, { index: siblings[idx + 1].index + 1 });
          refresh();
        },
      },
      null,
      { label: isHidden(bm.id, colId) ? 'Show' : 'Hide', action: () => toggleHidden(bm.id, colId) },
      null,
      {
        label: 'Delete', danger: true, action: async () => {
          await chrome.bookmarks.remove(bm.id);
          refresh();
        },
      },
    ]);
  });

  // ── Drag to reorder ──
  a.addEventListener('dragstart', e => {
    e.stopPropagation(); // don't trigger folder-group drag
    draggedItem = { node: bm, folderId: folder.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', bm.id);
    requestAnimationFrame(() => a.classList.add('dragging'));
  });

  a.addEventListener('dragend', () => {
    a.classList.remove('dragging');
    draggedItem = null;
    document.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  });

  a.addEventListener('dragover', e => {
    if (!draggedItem || draggedItem.node.id === bm.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    const rect = a.getBoundingClientRect();
    a.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
  });

  a.addEventListener('dragleave', () => a.classList.remove('drop-before', 'drop-after'));

  a.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    const isAfter = a.classList.contains('drop-after');
    a.classList.remove('drop-before', 'drop-after');
    if (!draggedItem || draggedItem.node.id === bm.id) return;

    let targetIndex;
    const sameFolder = draggedItem.folderId === folder.id;
    const draggedBefore = sameFolder && draggedItem.node.index < bm.index;
    if (isAfter) {
      targetIndex = draggedBefore ? bm.index : bm.index + 1;
    } else {
      targetIndex = draggedBefore ? bm.index - 1 : bm.index;
    }
    await chrome.bookmarks.move(draggedItem.node.id, { parentId: folder.id, index: targetIndex });
    refresh();
  });

  return a;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

function showCtxMenu(x, y, items) {
  if (!ctxMenu) {
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ctx-menu';
    document.body.appendChild(ctxMenu);
    document.addEventListener('click', () => ctxMenu.classList.add('hidden'));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') ctxMenu.classList.add('hidden'); });
  }

  ctxMenu.innerHTML = '';
  items.forEach(item => {
    if (item === null) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
    btn.textContent = item.label;
    btn.disabled = item.disabled ?? false;
    btn.addEventListener('click', e => { e.stopPropagation(); ctxMenu.classList.add('hidden'); item.action(); });
    ctxMenu.appendChild(btn);
  });

  // Measure before final placement
  ctxMenu.style.visibility = 'hidden';
  ctxMenu.classList.remove('hidden');
  const { offsetWidth: w, offsetHeight: h } = ctxMenu;
  ctxMenu.style.visibility = '';
  ctxMenu.style.left = `${Math.min(x, window.innerWidth  - w - 8)}px`;
  ctxMenu.style.top  = `${Math.min(y, window.innerHeight - h - 8)}px`;
}

function startRename(bm, linkEl) {
  const titleEl = linkEl.querySelector('.bookmark-title');
  const original = titleEl.textContent;

  const input = document.createElement('input');
  input.className = 'bookmark-rename-input';
  input.value = original;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const newTitle = input.value.trim() || original;
    await chrome.bookmarks.update(bm.id, { title: newTitle });
    refresh();
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; input.replaceWith(titleEl); }
  });
  input.addEventListener('blur', commit);
}

function startFolderRename(folder, nameEl) {
  const original = nameEl.textContent;

  const input = document.createElement('input');
  input.className = 'bookmark-rename-input';
  input.value = original;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const newTitle = input.value.trim() || original;
    await chrome.bookmarks.update(folder.id, { title: newTitle });
    refresh();
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; input.replaceWith(nameEl); }
  });
  input.addEventListener('blur', commit);
}

// ─── Resize handles ───────────────────────────────────────────────────────────

function makeHandle(leftColIdx) {
  const handle = document.createElement('div');
  handle.className = 'resize-handle';

  let startX, startWidth, colEl;

  function onMove(e) {
    const dx = e.clientX - startX;
    const next = Math.max(150, startWidth + dx);
    colEl.style.flexBasis = `${next}px`;
  }

  function onUp() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    const w = colEl.getBoundingClientRect().width;
    state.columns[leftColIdx].width = w;
    persist();
  }

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    // Find the left column element by position in DOM
    const cols = document.querySelectorAll('#columns-container .column');
    colEl = cols[leftColIdx];
    startWidth = colEl.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return handle;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function setupSettings() {
  document.getElementById('settings-toggle').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
}

function openSettings() {
  document.getElementById('settings-panel').classList.remove('hidden');
  renderSettingsPanel();
}

function closeSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
}

function renderSettingsPanel() {
  // Theme
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === state.theme);
    btn.onclick = () => {
      state.theme = btn.dataset.value;
      applyTheme(state.theme);
      persist();
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b === btn));
    };
  });

  // Dividers
  const dividersToggle = document.getElementById('dividers-toggle');
  dividersToggle.checked = state.dividers;
  dividersToggle.onchange = () => {
    state.dividers = dividersToggle.checked;
    applyDividers(state.dividers);
    persist();
  };

  // Hide column handles
  const hideHandlesToggle = document.getElementById('hide-handles-toggle');
  hideHandlesToggle.checked = state.hideHandles;
  hideHandlesToggle.onchange = () => {
    state.hideHandles = hideHandlesToggle.checked;
    applyHideHandles(state.hideHandles);
    persist();
  };

  // Show hidden items
  const showHiddenToggle = document.getElementById('show-hidden-toggle');
  showHiddenToggle.checked = state.showHidden;
  showHiddenToggle.onchange = () => {
    state.showHidden = showHiddenToggle.checked;
    persist();
    refresh();
  };

  renderColumnsConfig();
}

function renderColumnsConfig() {
  const container = document.getElementById('columns-config');
  container.innerHTML = '';

  let dragSrcIdx = null;
  let dragSrcFid = null;
  let dragSrcFidColIdx = null;

  state.columns.forEach((col, colIdx) => {
    const card = document.createElement('div');
    card.className = 'col-card';
    card.draggable = true;
    card.dataset.idx = colIdx;

    // ── Drag events ──
    card.addEventListener('dragstart', e => {
      dragSrcIdx = colIdx;
      e.dataTransfer.effectAllowed = 'move';
      // slight delay so the card isn't ghosted in its dragging state
      requestAnimationFrame(() => card.classList.add('dragging'));
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      container.querySelectorAll('.col-card').forEach(c => c.classList.remove('drag-over'));
      dragSrcIdx = null;
    });

    card.addEventListener('dragover', e => {
      if (dragSrcIdx === null) return; // chip drag in progress, not a card drag
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcIdx !== colIdx) {
        container.querySelectorAll('.col-card').forEach(c => c.classList.remove('drag-over'));
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (dragSrcIdx === null || dragSrcIdx === colIdx) return;
      // Reorder state.columns
      const moved = state.columns.splice(dragSrcIdx, 1)[0];
      state.columns.splice(colIdx, 0, moved);
      persist();
      renderColumns();
      renderColumnsConfig();
    });

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'col-card-header';

    const left = document.createElement('div');
    left.className = 'col-card-left';

    const grip = document.createElement('span');
    grip.className = 'drag-grip';
    grip.textContent = '⠿';
    grip.title = 'Drag to reorder';

    const title = document.createElement('span');
    title.className = 'col-card-title';
    title.textContent = `Column ${colIdx + 1}`;

    left.appendChild(grip);
    left.appendChild(title);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon';
    removeBtn.title = 'Remove column';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      state.columns.splice(colIdx, 1);
      persist();
      renderColumns();
      renderColumnsConfig();
    });

    header.appendChild(left);
    header.appendChild(removeBtn);
    card.appendChild(header);

    // Folder chips
    const chips = document.createElement('div');
    chips.className = 'folder-chips';

    col.folderIds.forEach(fid => {
      const folder = folderById(fid);
      if (!folder) return;

      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.draggable = true;

      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = folder.title;

      const x = document.createElement('button');
      x.className = 'chip-remove';
      x.textContent = '×';
      x.title = 'Remove from column';
      x.addEventListener('click', () => {
        col.folderIds = col.folderIds.filter(id => id !== fid);
        persist();
        renderColumns();
        renderColumnsConfig();
      });

      // ── Chip drag-to-reorder ──
      chip.addEventListener('dragstart', e => {
        e.stopPropagation(); // don't trigger card drag
        dragSrcFid = fid;
        dragSrcFidColIdx = colIdx;
        e.dataTransfer.effectAllowed = 'move';

        // Canvas-based drag image so rounded corners are truly transparent
        const rect = chip.getBoundingClientRect();
        const dpr  = devicePixelRatio;
        const cvs  = document.createElement('canvas');
        cvs.width  = rect.width  * dpr;
        cvs.height = rect.height * dpr;
        const ctx  = cvs.getContext('2d');
        ctx.scale(dpr, dpr);
        const cs = getComputedStyle(chip);
        const r  = parseFloat(cs.borderRadius);
        // draw rounded rect
        ctx.beginPath();
        ctx.roundRect(0, 0, rect.width, rect.height, r);
        ctx.fillStyle = cs.backgroundColor;
        ctx.fill();
        // draw text
        ctx.fillStyle = cs.color;
        ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
        ctx.textBaseline = 'middle';
        const pad = parseFloat(cs.paddingLeft);
        ctx.fillText(chip.querySelector('.chip-name').textContent, pad, rect.height / 2);
        // CSS size keeps drag image at 1x; canvas pixels give retina sharpness
        cvs.style.cssText = `position:fixed;left:-9999px;width:${rect.width}px;height:${rect.height}px`;
        document.body.appendChild(cvs);
        e.dataTransfer.setDragImage(cvs, e.clientX - rect.left, e.clientY - rect.top);
        requestAnimationFrame(() => { cvs.remove(); chip.classList.add('dragging'); });
      });

      chip.addEventListener('dragend', e => {
        e.stopPropagation();
        chip.classList.remove('dragging');
        chips.querySelectorAll('.chip').forEach(c => c.classList.remove('drag-over'));
        dragSrcFid = null;
        dragSrcFidColIdx = null;
      });

      chip.addEventListener('dragover', e => {
        if (dragSrcFid === null || dragSrcFid === fid || dragSrcFidColIdx !== colIdx) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        chips.querySelectorAll('.chip').forEach(c => c.classList.remove('drag-over'));
        chip.classList.add('drag-over');
      });

      chip.addEventListener('dragleave', e => {
        e.stopPropagation();
        chip.classList.remove('drag-over');
      });

      chip.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        chip.classList.remove('drag-over');
        if (dragSrcFid === null || dragSrcFid === fid || dragSrcFidColIdx !== colIdx) return;
        const fromIdx = col.folderIds.indexOf(dragSrcFid);
        const toIdx   = col.folderIds.indexOf(fid);
        if (fromIdx === -1 || toIdx === -1) return;
        col.folderIds.splice(fromIdx, 1);
        col.folderIds.splice(toIdx, 0, dragSrcFid);
        persist();
        renderColumns();
        renderColumnsConfig();
      });

      chip.appendChild(name);
      chip.appendChild(x);
      chips.appendChild(chip);
    });

    card.appendChild(chips);

    // Add-folder dropdown — only show folders not already assigned
    const assigned = new Set(state.columns.flatMap(c => c.folderIds));
    const available = allFolders.filter(f => !assigned.has(f.id));

    if (available.length) {
      const sel = document.createElement('select');
      sel.className = 'folder-select';

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '+ Add folder…';
      sel.appendChild(placeholder);

      available.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id;
        // Show path hint if folder is nested (title only is often ambiguous)
        opt.textContent = f.title;
        sel.appendChild(opt);
      });

      sel.addEventListener('change', () => {
        if (!sel.value) return;
        col.folderIds.push(sel.value);
        persist();
        renderColumns();
        renderColumnsConfig();
      });

      card.appendChild(sel);
    }

    container.appendChild(card);
  });

  // Add column button
  const addBtn = document.getElementById('add-column');
  // Replace onclick to avoid stale closures
  const fresh = addBtn.cloneNode(true);
  addBtn.replaceWith(fresh);
  fresh.addEventListener('click', () => {
    state.columns.push({ id: `col-${Date.now()}`, width: DEFAULT_WIDTH, folderIds: [] });
    persist();
    renderColumns();
    renderColumnsConfig();
  });
}

// ─── Theme ────────────────────────────────────────────────────────────────────

let _systemThemeMq = window.matchMedia('(prefers-color-scheme: dark)');
let _systemThemeListener = null;

function applyTheme(theme) {
  // Remove any previous system listener
  if (_systemThemeListener) {
    _systemThemeMq.removeEventListener('change', _systemThemeListener);
    _systemThemeListener = null;
  }

  if (theme === 'system') {
    const apply = () => {
      document.documentElement.setAttribute('data-theme', _systemThemeMq.matches ? 'dark' : 'light');
    };
    apply();
    _systemThemeListener = apply;
    _systemThemeMq.addEventListener('change', _systemThemeListener);
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function applyDividers(on) {
  document.getElementById('columns-container').classList.toggle('dividers', on);
}

function applyHideHandles(on) {
  document.getElementById('columns-container').classList.toggle('hide-handles', on);
}


// ─── Persistence ──────────────────────────────────────────────────────────────

function persist() {
  return chrome.storage.local.set({ theme: state.theme, dividers: state.dividers, hideHandles: state.hideHandles, showHidden: state.showHidden, columns: state.columns });
}
