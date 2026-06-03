'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 260;

// Widgets share `col.folderIds` with regular folders — special sentinel IDs.
const RECENT_WIDGET_ID = '__widget:recent__';
const STATUS_WIDGET_ID = '__widget:status__';
const SEARCH_WIDGET_ID = '__widget:search__';
const WIDGET_TITLES = {
  [RECENT_WIDGET_ID]: 'Recently added',
  [STATUS_WIDGET_ID]: 'Status',
  [SEARCH_WIDGET_ID]: 'Search',
};
const RECENT_LIMIT = 15;
const SEARCH_LIMIT = 15;

let state = {
  theme: 'system',
  dividers: false,
  hideHandles: false,
  showHidden: false,
  hideFolderDividers: false,
  columns: [],   // [{ id: string, width: number, folderIds: string[] }]
};

let allFolders = [];   // flat list of all BookmarkTreeNode folders
let allBookmarks = []; // flat list of all URL bookmarks (for stats widget)
let recentBookmarks = []; // most-recently-added URL bookmarks (for the widget)
let faviconCache = {}; // { [domain]: url | "chrome" | "none" }
let hiddenIds = {}; // { [colId: string]: Set<string> } — per-column hidden IDs
let draggedItem = null;  // { node, folderId } during drag (bookmark or subfolder)
// Snapshotted by container.dragover; used as a fallback in source.dragend if
// the drop event didn't fire for some reason (e.g. cursor moved at the last
// moment). Cleared on a successful drop.
let pendingItemDrop = null;  // { container, folderId } or null
// Main-view top-level folder drag (move folder between columns / reorder within).
let mainDragFid = null;
let mainDragDropped = false;
let mainDragSnapshot = null; // { columns: [{colId, left, right}], groups: { [colId]: [{fid, mid}] } }
// Column reorder (edit-mode only) — drag entire columns left/right.
let colDragId = null;
let colDragSnapshot = null;   // [{colId, left, right, mid}]
let colDragDropped = false;
let ctxMenu = null;    // singleton context menu element
let addMenuEl = null;     // open "+ Add item" flyout (portaled to body), or null
let addMenuCleanup = null; // tears down the flyout's document listeners
let folderOpen = {};   // { [folderId]: boolean } subfolder open state
let searchQuery = '';  // session-only — persists across re-renders, not across reloads
let editMode = false;  // session-only — column-view inline edit overlay
// Layout persistence uses folder *references* (see folderRef); in memory we keep
// node-id strings. Unresolved refs (folder absent on this device) become
// `__unresolved__:N` markers whose ref is stashed here for re-link/re-persist.
let unresolvedRefs = new Map(); // marker -> reference object
let unresolvedSeq = 0;
let migratedOldFormat = false;  // set during hydrate when old node-id data was upgraded
let lastPersistedLayout = null; // JSON of last write, to skip redundant persists
let lastColIds = [];            // col ids last written, to remove stale col:* shards
let migratedToSharded = false;  // set on load when a legacy single-`columns` key was read
// Optional, per-device cross-device sync (see sync-design.md §4.7). The layout
// bundle (settings + columns) lives in chrome.storage.sync when the user opts
// in, otherwise chrome.storage.local. faviconCache, folderOpen, hiddenIds, and
// this flag itself are ALWAYS device-local (the flag must never sync, or it'd
// propagate the choice to other devices). Default OFF.
const SYNC_ENABLED_KEY = 'layoutSyncEnabled';
let layoutSyncEnabled = false;
function layoutStore() {
  return layoutSyncEnabled && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Device-local keys first — including the sync toggle, which decides where the
  // layout bundle lives.
  const local = await chrome.storage.local.get([SYNC_ENABLED_KEY, 'faviconCache', 'folderOpen', 'hiddenIds']);
  layoutSyncEnabled = !!local[SYNC_ENABLED_KEY];
  if (local.faviconCache)        faviconCache      = local.faviconCache;
  if (local.folderOpen)          folderOpen        = local.folderOpen;
  if (local.hiddenIds && !Array.isArray(local.hiddenIds)) {
    for (const [colId, ids] of Object.entries(local.hiddenIds)) {
      hiddenIds[colId] = new Set(ids);
    }
  }

  // The layout bundle (settings + sharded columns) from the active store (sync
  // if the user opted in, otherwise local).
  const { settings, rawColumns, legacy, colIds } = await readLayout(layoutStore());
  Object.assign(state, settings);
  lastColIds = colIds;
  migratedToSharded = legacy;
  state.columns = rawColumns; // raw refs; hydrated to live node ids after the tree loads

  applyTheme(state.theme);
  applyDividers(state.dividers);
  applyHideHandles(state.hideHandles);
  applyHideFolderDividers(state.hideFolderDividers);

  const tree = await chrome.bookmarks.getTree();
  allFolders = collectFolders(tree[0]);
  allBookmarks = collectBookmarks(tree[0]);
  await loadRecent();

  // Resolve the stored layout (folder references) to live node ids now that the
  // bookmark tree is loaded. Old node-id-based layouts are upgraded in place.
  if (state.columns.length) {
    state.columns = hydrateColumns(state.columns);
    if (migratedOldFormat || migratedToSharded) persist(); // upgrade to sharded refs
  }

  if (!state.columns.length) {
    state.columns = defaultColumns(tree[0]);
    await persist();
  }

  pruneHiddenIds();
  renderColumns();
  setupContainerDragHandlers();
  setupSettings();

  // Live updates: refresh when bookmarks change anywhere in the browser (other
  // tabs, bookmark manager, sync). Debounced so bulk operations don't thrash.
  const debouncedRefresh = debounce(refresh, 300);
  chrome.bookmarks.onCreated.addListener(debouncedRefresh);
  chrome.bookmarks.onChanged.addListener(debouncedRefresh);
  chrome.bookmarks.onRemoved.addListener(debouncedRefresh);
  chrome.bookmarks.onMoved.addListener(debouncedRefresh);

  // Cross-device sync: adopt a layout pushed from another device. Only acts when
  // synced and the change is a genuine remote one (not the echo of our own
  // write — guarded by comparing against our current serialized columns).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (!layoutSyncEnabled || area !== 'sync') return;
    const settingsChanged = SETTINGS_KEYS.some(k => k in changes);
    const columnsChanged = 'colOrder' in changes
      || Object.keys(changes).some(k => k.startsWith('col:'));
    if (!settingsChanged && !columnsChanged) return;
    // Snapshot our current layout BEFORE reading/hydrating the incoming one
    // (hydrateColumns resets the shared unresolved-ref map).
    const currentSer = JSON.stringify(serializeColumns());
    const { settings, rawColumns, colIds } = await readLayout(chrome.storage.sync);
    // Apply incoming settings live, independent of the column echo-guard below —
    // a pure settings change from another device still has columns unchanged.
    if (settingsChanged) {
      Object.assign(state, settings);
      applyTheme(state.theme);
      applyDividers(state.dividers);
      applyHideHandles(state.hideHandles);
      applyHideFolderDividers(state.hideFolderDividers);
      syncSettingsControls();
    }
    if (columnsChanged) {
      const hydrated = hydrateColumns(rawColumns);
      const incomingSer = JSON.stringify(hydrated.map(c =>
        ({ id: c.id, width: c.width, folderIds: serializeFolderIds(c.folderIds) })));
      lastColIds = colIds;
      if (incomingSer !== currentSer) {     // not our own echo / already current
        state.columns = hydrated;
        renderColumns();
      }
    }
  });
});

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function loadRecent() {
  // getRecent can include folder nodes — filter to URL bookmarks.
  const items = await chrome.bookmarks.getRecent(RECENT_LIMIT * 2);
  recentBookmarks = items.filter(b => b.url).slice(0, RECENT_LIMIT);
}

// ─── Bookmarks ────────────────────────────────────────────────────────────────

function collectFolders(node, acc = []) {
  if (!node.children) return acc;
  // Skip the invisible root (id "0", empty title)
  if (node.id !== '0') acc.push(node);
  for (const child of node.children) collectFolders(child, acc);
  return acc;
}

function collectBookmarks(node, acc = []) {
  if (node.url) acc.push(node);
  if (node.children) for (const child of node.children) collectBookmarks(child, acc);
  return acc;
}

// Find the "Bookmarks bar" top-level container without relying on its node id.
// Chrome's id "1" is not guaranteed: the 2025+ account/local bookmark-subtree
// split can change it, and an account can have TWO bookmarks-bar containers (one
// syncing/account, one device-local). Prefer the account (syncing) subtree so
// the seed is sync-friendly; fall back to folderType, then the legacy id "1",
// then the first container. `folderType`/`syncing` are undefined on Chrome <134,
// where the id/first-container fallbacks apply.
function bookmarksBar(containers) {
  const bars = containers.filter(c => c.folderType === 'bookmarks-bar');
  return bars.find(c => c.syncing) || bars[0]
      || containers.find(c => c.id === '1') || containers[0] || null;
}

function defaultColumns(root) {
  // First-install default: a single column with the Bookmarks bar + Search
  // widget. Simple, immediately useful, and demonstrates both concepts.
  const containers = root.children ?? [];
  const bar = bookmarksBar(containers);
  const folderIds = bar ? [bar.id, SEARCH_WIDGET_ID] : [SEARCH_WIDGET_ID];
  return [{
    id: `col-0-${Date.now()}`,
    width: DEFAULT_WIDTH,
    folderIds,
  }];
}

function folderById(id) {
  return allFolders.find(f => f.id === id);
}

const childrenFolders = id => allFolders.filter(f => f.parentId === id);

// ─── Folder references (cross-session / cross-device identity) ────────────────
// Bookmark node IDs aren't stable across devices or even across restarts (see
// sync-design.md), so the persisted layout identifies a folder by a
// re-resolvable reference instead of a raw id: the special root it lives under
// (`folderType`), the subtree (`syncing`: account vs local), the legacy root id
// as an old-Chrome fallback, and the title path from that root down to the
// folder. In memory we still use live node ids; references exist only at the
// persist/load boundary.

// Build a reference from a live folder node.
function folderRef(node) {
  const path = [];
  let n = node;
  while (n && n.parentId && n.parentId !== '0') {
    path.unshift(n.title || '');
    n = folderById(n.parentId);
  }
  const container = n; // the top-level container (parentId '0'), or null
  return {
    root: container?.folderType ?? null,   // 'bookmarks-bar' | 'other' | 'mobile' | 'managed' | null
    syncing: container?.syncing ?? null,    // true (account) | false (local) | null (old Chrome)
    rootId: container?.id ?? null,          // fallback when folderType is unavailable
    path,                                    // titles, container→folder; [] if node IS the container
  };
}

// Resolve a reference to a live node id on THIS device, or null if it no longer
// matches (folder renamed/moved/deleted, or a sync-only folder absent here).
function resolveRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const containers = childrenFolders('0');
  let container = null;
  if (ref.root) {
    const m = containers.filter(c => c.folderType === ref.root);
    container = (ref.syncing == null ? null : m.find(c => c.syncing === ref.syncing)) || m[0] || null;
  }
  if (!container && ref.rootId != null) container = containers.find(c => c.id === ref.rootId) || null;
  if (!container) return null;
  let node = container;
  for (const title of ref.path) {
    const kids = childrenFolders(node.id).filter(c => c.title === title);
    if (!kids.length) return null;
    node = kids[0]; // best-effort among same-named siblings (index hint: TODO)
  }
  return node.id;
}

// Stable string key for a reference (for dedup / future folderOpen·hiddenIds use).
function refKey(ref) {
  return `${ref.root || ref.rootId || '?'}#${ref.syncing ?? '?'}#${ref.path.join(' ')}`;
}

// True when `folderId` is `ancestorId` itself or nested anywhere beneath it.
// Used to forbid dropping a folder into its own subtree (chrome.bookmarks.move
// rejects such cycles).
const WIDGET_PREFIX = '__widget:';
const UNRESOLVED_PREFIX = '__unresolved__:';
const isWidgetId = id => typeof id === 'string' && id.startsWith(WIDGET_PREFIX);
const isUnresolved = id => typeof id === 'string' && id.startsWith(UNRESOLVED_PREFIX);

// LOAD: a stored column item -> an in-memory string (node id | widget | unresolved
// marker), or null to drop. Handles BOTH the old format (raw node-id strings) and
// the new format (reference objects). Requires `allFolders` to be populated.
function hydrateItem(item) {
  if (typeof item === 'string') {
    if (item.startsWith(WIDGET_PREFIX)) return item;        // widget sentinel
    migratedOldFormat = true;                                // old raw node id
    return folderById(item) ? item : null;                  // keep if still here
  }
  if (item && typeof item === 'object') {                    // new: a reference
    const id = resolveRef(item);
    if (id) return id;
    const marker = `${UNRESOLVED_PREFIX}${unresolvedSeq++}`; // can't resolve here
    unresolvedRefs.set(marker, item);
    return marker;
  }
  return null;
}

function hydrateColumns(rawColumns) {
  unresolvedRefs.clear();
  unresolvedSeq = 0;
  migratedOldFormat = false;
  return (rawColumns || []).map(col => ({
    id: col.id,
    width: col.width,
    folderIds: (col.folderIds || []).map(hydrateItem).filter(x => x != null),
  }));
}

// PERSIST: an in-memory item -> its stored form (reference | widget | preserved ref).
function serializeItem(item) {
  if (isWidgetId(item)) return item;
  if (isUnresolved(item)) return unresolvedRefs.get(item) || null;
  const node = folderById(item);
  return node ? folderRef(node) : null;                     // folder gone -> dropped
}

const SETTINGS_KEYS = ['theme', 'dividers', 'hideHandles', 'showHidden', 'hideFolderDividers'];
const serializeFolderIds = folderIds => folderIds.map(serializeItem).filter(x => x != null);

function serializeColumns() {
  return state.columns.map(col => ({
    id: col.id,
    width: col.width,
    folderIds: serializeFolderIds(col.folderIds),
  }));
}

// REFRESH (bookmark event): drop folders deleted since last render, and re-resolve
// any unresolved markers whose folder has (re)appeared.
function rehydrateColumns() {
  state.columns.forEach(col => {
    col.folderIds = col.folderIds.map(item => {
      if (isWidgetId(item)) return item;
      if (isUnresolved(item)) {
        const id = resolveRef(unresolvedRefs.get(item));
        if (id) { unresolvedRefs.delete(item); return id; }
        return item;
      }
      return folderById(item) ? item : null;                 // node id; drop if gone
    }).filter(x => x != null);
  });
}

function isDescendantOrSelf(folderId, ancestorId) {
  let id = folderId;
  while (id) {
    if (id === ancestorId) return true;
    const f = folderById(id);
    if (!f) break;
    id = f.parentId;
  }
  return false;
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

// FLIP animation via CSS transitions: snapshot visual rects, mutate the DOM, then
// apply an inverse transform with transitions disabled before clearing it on the
// next frame so the CSS `transition: transform` on the target elements animates them
// back to identity. Using CSS transitions (vs. WAAPI cancel/re-animate) interrupts
// in-flight motion smoothly when dragover fires repeatedly.
// Clears the drop-position indicators inside a scope (Element or Document).
// Also clears the column "add here" highlight document-wide, so entering any
// in-folder reorder region drops a stale highlight left by a column hover.
function clearDropIndicators(scope) {
  scope.querySelectorAll('.drop-before, .drop-after').forEach(el =>
    el.classList.remove('drop-before', 'drop-after')
  );
  scope.querySelectorAll('.drop-line').forEach(el => el.remove());
  document.querySelectorAll('.col-drop-target').forEach(el =>
    el.classList.remove('col-drop-target')
  );
}

// Processes a bookmark/subfolder reorder using the indicator state captured by
// the most recent container.dragover. Called from dragend as a fallback when
// the drop event didn't process (or didn't fire). No-op if there's nothing to
// commit.
async function flushPendingItemDrop() {
  if (!pendingItemDrop || !draggedItem) return;
  const { container: cont, folderId } = pendingItemDrop;
  pendingItemDrop = null;

  const beforeEl = cont.querySelector(':scope > .drop-before');
  const afterEl  = cont.querySelector(':scope > .drop-after');
  const into     = !!cont.querySelector(':scope > .drop-line');
  if (!beforeEl && !afterEl && !into) return;

  const allSiblings = [...cont.querySelectorAll(':scope > .bookmark-item, :scope > .subfolder-group')];
  let targetIdx = beforeEl ? allSiblings.indexOf(beforeEl)
                : afterEl  ? allSiblings.indexOf(afterEl) + 1
                : 0; // dropped into an empty folder

  const draggedEl = cont.querySelector(`:scope > [data-id="${draggedItem.node.id}"]`);
  if (draggedEl && beforeEl) {
    const draggedIdx = allSiblings.indexOf(draggedEl);
    if (draggedIdx < targetIdx) targetIdx -= 1;
  }

  const nodeId = draggedItem.node.id;
  clearDropIndicators(cont);
  await chrome.bookmarks.move(nodeId, { parentId: folderId, index: targetIdx });
  refresh();
}

// Suppresses the browser's default cursor-following drag image. Used by every
// custom drag (folder-group / column) so the in-place dimmed element is the
// only visual. Bookmark + subfolder reorder keep the default drag image
// (cursor-follower) and use a horizontal drop-indicator line instead.
function suppressDragImage(e) {
  const empty = document.createElement('canvas');
  empty.width = 1; empty.height = 1;
  empty.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(empty);
  e.dataTransfer.setDragImage(empty, 0, 0);
  requestAnimationFrame(() => empty.remove());
}

function flipElements(els, mutate, afterMutate) {
  const before = new Map();
  els.forEach(el => before.set(el, el.getBoundingClientRect()));

  // Kill any in-flight transition and clear residual transform so the next
  // measurement reflects the element's natural (untransformed) DOM position.
  els.forEach(el => {
    el.style.transition = 'none';
    el.style.transform = '';
  });

  mutate();

  // Hook for callers that need to read post-mutate layout positions before
  // we apply inverse transforms (which would put visual rects back to pre-mutate).
  if (afterMutate) afterMutate();

  els.forEach(el => {
    const a = before.get(el);
    if (!a) return;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  });

  // Next frame: re-enable transition and clear transform → CSS animates to identity.
  requestAnimationFrame(() => {
    els.forEach(el => {
      el.style.transition = '';
      el.style.transform = '';
    });
  });
}

function snapshotMainLayout() {
  const cols = [...document.querySelectorAll('#columns-container .column')];
  const snap = { columns: [], groups: {} };
  cols.forEach(col => {
    const r = col.getBoundingClientRect();
    snap.columns.push({ colId: col.dataset.colId, left: r.left, right: r.right });
    snap.groups[col.dataset.colId] = [...col.querySelectorAll(':scope > .folder-group')].map(g => {
      const gr = g.getBoundingClientRect();
      return { fid: g.dataset.fid, mid: gr.top + gr.height / 2 };
    });
  });
  return snap;
}

function flipFolderGroups(mutate) {
  flipElements([...document.querySelectorAll('#columns-container .folder-group')], mutate);
}

function commitMainDragToState() {
  const cols = [...document.querySelectorAll('#columns-container .column')];
  cols.forEach(colEl => {
    const stateCol = state.columns.find(c => c.id === colEl.dataset.colId);
    if (!stateCol) return;
    stateCol.folderIds = [...colEl.querySelectorAll(':scope > .folder-group')].map(g => g.dataset.fid);
  });
  persist();
  renderColumns();
}

function snapshotColumns() {
  return [...document.querySelectorAll('#columns-container .column')].map(c => {
    const r = c.getBoundingClientRect();
    return {
      colId: c.dataset.colId,
      left:  r.left,
      right: r.right,
      mid:   r.left + r.width / 2,
    };
  });
}

function commitColumnDragToState() {
  // Read post-drag DOM order; same pattern as commitMainDragToState.
  const cols = [...document.querySelectorAll('#columns-container .column')];
  const byId = new Map(state.columns.map(c => [c.id, c]));
  state.columns = cols.map(c => byId.get(c.dataset.colId)).filter(Boolean);
  persist();
  renderColumns();
}

function flipColumns(mutate) {
  // Include both columns and the resize handles between them — handles travel
  // with their adjacent column during a reorder, so they need to FLIP too.
  flipElements([
    ...document.querySelectorAll('#columns-container .column'),
    ...document.querySelectorAll('#columns-container .resize-handle'),
  ], mutate);
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

// SF-Symbols-style stroked chevron (chevron.left / chevron.right). An SVG, not
// a guillemet glyph, so it sizes to currentColor and flex-centers cleanly with
// adjacent text.
function makeChevron(direction) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('fill', 'none');
  svg.classList.add('add-chevron-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', direction === 'left' ? 'M7.5 3 L4 6 L7.5 9' : 'M4.5 3 L8 6 L4.5 9');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

// ─── Render columns ───────────────────────────────────────────────────────────

function renderColumns() {
  closeAddMenu();
  const container = document.getElementById('columns-container');
  // Grab the "Done editing" button before clearing — after the first render it
  // lives inside the container (in the edit-actions stack), so we re-home the
  // same element each time to keep its click listener intact.
  const exitBtn = document.getElementById('exit-edit-mode');
  container.innerHTML = '';

  state.columns.forEach((col, i) => {
    if (i > 0) {
      container.appendChild(makeHandle(i - 1));
    }
    container.appendChild(makeColumn(col, i));
  });

  // Handle + spacer after the last column so it's also resizable
  if (state.columns.length > 0) {
    container.appendChild(makeHandle(state.columns.length - 1));
  }

  // Edit-mode action stack at the right end (CSS-hidden unless body.edit-mode):
  // "+ Add column" on top, "Done editing" directly beneath it.
  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const addColBtn = document.createElement('button');
  addColBtn.className = 'edit-add-column';
  addColBtn.textContent = '+ Add column';
  addColBtn.addEventListener('click', () => {
    state.columns.push({ id: `col-${Date.now()}`, width: DEFAULT_WIDTH, folderIds: [] });
    persist();
    renderColumns();
  });
  actions.appendChild(addColBtn);
  actions.appendChild(exitBtn);   // re-home the static "Done editing" button
  container.appendChild(actions);

  if (state.columns.length > 0) {
    const spacer = document.createElement('div');
    spacer.className = 'column-spacer';
    container.appendChild(spacer);
  }

}

// Attach the main-view drag handlers once. They reference module-level state
// (mainDragFid/Snapshot, colDragId/Snapshot/TargetIdx) so they survive any
// number of column re-renders without reattachment.
function setupContainerDragHandlers() {
  const container = document.getElementById('columns-container');

  // Reveal the horizontal scrollbar only while actively scrolling, then fade it
  // back out after a short idle — the bar spans the whole viewport, so a hover
  // trigger would keep it permanently visible. See #columns-container.scrolling.
  let scrollIdleTimer;
  container.addEventListener('scroll', () => {
    container.classList.add('scrolling');
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => container.classList.remove('scrolling'), 700);
  });

  container.ondragover = e => {
    // Column reorder (edit-mode drag) — FLIP-animates the columns around the
    // dragged one. Resize handles are hidden via the `cols-dragging` class.
    if (colDragId !== null && colDragSnapshot) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const nonDragged = colDragSnapshot.filter(c => c.colId !== colDragId);
      let idx = nonDragged.length;
      for (let i = 0; i < nonDragged.length; i++) {
        if (e.clientX < nonDragged[i].mid) { idx = i; break; }
      }

      const draggedCol = container.querySelector(`.column[data-col-id="${colDragId}"]`);
      if (!draggedCol) return;
      const currentNonDragged = [...container.querySelectorAll('.column')]
        .filter(c => c.dataset.colId !== colDragId);
      // Anchor against the edit-actions stack (which holds "+ Add column") when
      // inserting at the end. Must be a DIRECT child of the container — the
      // button itself is nested inside .edit-actions, so insertBefore() against
      // it would throw "not a child of this node".
      const refCol = currentNonDragged[idx]
        || container.querySelector(':scope > .edit-actions');

      // The handle immediately to the dragged column's right travels with it,
      // so reordering doesn't leave a doubled-up handle next to the previous
      // column's handle.
      const handleRight = draggedCol.nextElementSibling;
      const movingHandle = handleRight?.classList.contains('resize-handle') ? handleRight : null;

      if (movingHandle
            ? movingHandle.nextSibling === refCol
            : draggedCol.nextSibling === refCol) return; // already in place

      flipColumns(() => {
        container.insertBefore(draggedCol, refCol);
        if (movingHandle) container.insertBefore(movingHandle, draggedCol.nextSibling);
      });
      return;
    }

    // Edit mode only: a subfolder dragged out of its parent onto a column →
    // offer to add it there as a top-level item (display only, like
    // "+ Add item"). In regular view, folders/bookmarks keep their original
    // drag-to-location behaviour (handled by the in-folder listeners below).
    // dropEffect must be 'move' to match the subfolder's effectAllowed='move' —
    // a mismatched 'copy' makes Chrome silently refuse the drop.
    if (editMode && draggedItem && draggedItem.node.children != null) {
      const colEl = e.target.closest('.column');
      clearDropIndicators(document);
      if (!colEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      colEl.classList.add('col-drop-target');
      return;
    }

    if (mainDragFid === null || !mainDragSnapshot) return;

    // Target column by cursor.x — only preventDefault (and thus accept a drop)
    // when the cursor is actually over a column. Releasing in dead space
    // (resize handles / spacer) cancels and dragend restores the original.
    const targetCol = mainDragSnapshot.columns.find(c => e.clientX >= c.left && e.clientX <= c.right);
    if (!targetCol) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Insertion index by cursor.y vs snapshotted folder-group mids (excluding dragged)
    const groupsInCol = (mainDragSnapshot.groups[targetCol.colId] || []).filter(g => g.fid !== mainDragFid);
    let idx = groupsInCol.length;
    for (let i = 0; i < groupsInCol.length; i++) {
      if (e.clientY < groupsInCol[i].mid) { idx = i; break; }
    }

    const targetColEl = container.querySelector(`.column[data-col-id="${targetCol.colId}"]`);
    if (!targetColEl) return;
    const draggedGroup = container.querySelector(`.folder-group[data-fid="${mainDragFid}"]`);
    if (!draggedGroup) return;
    const currentNonDragged = [...targetColEl.querySelectorAll(':scope > .folder-group')]
      .filter(g => g.dataset.fid !== mainDragFid);
    // When inserting at the end of the folder list, anchor against the +Add /
    // ×Remove edit-mode controls so the dragged folder doesn't slip past them.
    const refGroup = currentNonDragged[idx]
      || targetColEl.querySelector(':scope > .edit-add-folder');
    if (draggedGroup.parentElement === targetColEl && draggedGroup.nextSibling === refGroup) return;
    flipFolderGroups(() => targetColEl.insertBefore(draggedGroup, refGroup));
  };

  container.ondrop = e => {
    if (colDragId !== null) {
      e.preventDefault();
      colDragDropped = true;
      commitColumnDragToState();
      return;
    }
    // Edit mode only: subfolder dropped onto a column → add as a top-level item.
    if (editMode && draggedItem && draggedItem.node.children != null) {
      const colEl = e.target.closest('.column');
      clearDropIndicators(document);
      if (!colEl) return;
      e.preventDefault();
      const targetCol = state.columns.find(c => c.id === colEl.dataset.colId);
      const fid = draggedItem.node.id;
      draggedItem = null;
      pendingItemDrop = null; // this drop is column-add, not an in-folder move
      // Display only — never touches the bookmark tree. Keep a folder to at
      // most one standalone column slot, matching the "+ Add item" menu.
      if (targetCol && !targetCol.folderIds.includes(fid)) {
        state.columns.forEach(c => { c.folderIds = c.folderIds.filter(id => id !== fid); });
        targetCol.folderIds.push(fid);
        persist();
      }
      renderColumns();
      return;
    }

    if (mainDragFid === null) return;
    e.preventDefault();
    mainDragDropped = true;
    commitMainDragToState();
  };
}

async function refresh() {
  const tree = await chrome.bookmarks.getTree();
  allFolders = collectFolders(tree[0]);
  allBookmarks = collectBookmarks(tree[0]);
  await loadRecent();
  rehydrateColumns(); // drop deleted folders; re-resolve markers that reappeared
  pruneHiddenIds();
  renderColumns();
  persist();          // capture renames/moves into stored refs (no-op if unchanged)
}

// Drop hidden-ID entries that refer to deleted bookmarks/folders or removed
// columns so storage doesn't accumulate stale data over time.
function pruneHiddenIds() {
  const validIds = new Set();
  allFolders.forEach(f => validIds.add(f.id));
  allBookmarks.forEach(b => validIds.add(b.id));
  const validColIds = new Set(state.columns.map(c => c.id));

  let changed = false;
  for (const colId of Object.keys(hiddenIds)) {
    if (!validColIds.has(colId)) {
      delete hiddenIds[colId];
      changed = true;
      continue;
    }
    const ids = hiddenIds[colId];
    for (const id of ids) {
      if (!validIds.has(id)) { ids.delete(id); changed = true; }
    }
    if (ids.size === 0) { delete hiddenIds[colId]; changed = true; }
  }
  if (changed) persistHiddenIds();
}

// Placeholder for a synced layout slot whose folder isn't resolvable on this
// device (renamed/moved while closed, deleted, or a sync-only folder absent
// here). It's a real `.folder-group` with a `data-fid` so column/folder drags
// preserve it; edit-mode × removes it. (Re-link-via-picker is a later polish.)
function makeUnresolvedGroup(marker) {
  const ref = unresolvedRefs.get(marker);
  const lastTitle = ref?.path?.[ref.path.length - 1] || ref?.root || 'Folder';

  const group = document.createElement('div');
  group.className = 'folder-group unresolved-group';
  group.dataset.fid = marker;

  const label = document.createElement('div');
  label.className = 'folder-label unresolved-label';
  label.textContent = lastTitle;
  label.title = "This folder isn't on this device — it may have been renamed, moved, or removed.";
  group.appendChild(label);

  const note = document.createElement('div');
  note.className = 'unresolved-note';
  note.textContent = 'Not found on this device';
  group.appendChild(note);

  group.appendChild(makeEditFolderRemove(marker)); // edit-mode × removes the slot
  return group;
}

function makeColumn(col, idx) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.colId = col.id;
  el.style.flexBasis = `${col.width}px`;

  // Edit-mode drag handle at the top of each column (CSS-hidden unless edit-mode).
  // mousedown flips el.draggable on so only the grip — not folders/widgets —
  // initiates a column drag.
  const grip = document.createElement('div');
  grip.className = 'edit-col-grip';
  grip.textContent = `⠿  Column ${idx + 1}`;
  grip.title = 'Drag to reorder column';
  grip.addEventListener('mousedown', () => {
    el.draggable = true;
    const reset = () => {
      el.draggable = false;
      document.removeEventListener('mouseup', reset);
    };
    document.addEventListener('mouseup', reset);
  });
  el.appendChild(grip);

  el.addEventListener('dragstart', e => {
    if (!el.draggable) { e.preventDefault(); return; }
    e.stopPropagation();
    colDragId = col.id;
    colDragDropped = false;
    colDragSnapshot = snapshotColumns();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    suppressDragImage(e);

    el.classList.add('col-dragging');
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('col-dragging');
    el.draggable = false;
    colDragId = null;
    colDragSnapshot = null;
    if (!colDragDropped) renderColumns();
    colDragDropped = false;
  });

  col.folderIds.forEach(fid => {
    if (fid === RECENT_WIDGET_ID) {
      el.appendChild(makeRecentlyAddedGroup(col.id));
      return;
    }
    if (fid === STATUS_WIDGET_ID) {
      el.appendChild(makeStatusGroup(col.id));
      return;
    }
    if (fid === SEARCH_WIDGET_ID) {
      el.appendChild(makeSearchGroup());
      return;
    }
    if (isUnresolved(fid)) {
      el.appendChild(makeUnresolvedGroup(fid));
      return;
    }
    const folder = folderById(fid);
    if (folder) el.appendChild(makeFolderGroup(folder, 0, null, 0, col.id));
  });

  // Edit-mode controls (CSS-hidden unless body.edit-mode)
  el.appendChild(makeEditAddFolderControl(col));
  el.appendChild(makeEditColumnRemove(col));

  return el;
}

function makeEditColumnRemove(col) {
  // Wrapper hosts either the trigger button or, after click, an inline
  // Yes / Cancel confirmation (instead of a native confirm() dialog).
  const wrap = document.createElement('div');
  wrap.className = 'edit-col-remove';

  const trigger = document.createElement('button');
  trigger.className = 'edit-col-remove-trigger';
  trigger.title = 'Remove column';
  trigger.textContent = '× Remove column';

  const confirm = document.createElement('div');
  confirm.className = 'edit-col-remove-confirm';

  const yesBtn = document.createElement('button');
  yesBtn.className = 'edit-col-remove-yes';
  yesBtn.textContent = 'Yes';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'edit-col-remove-cancel';
  cancelBtn.textContent = 'Cancel';

  confirm.appendChild(yesBtn);
  confirm.appendChild(cancelBtn);

  const doDelete = () => {
    state.columns = state.columns.filter(c => c.id !== col.id);
    persist();
    renderColumns();
  };

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    // Empty columns don't need confirmation.
    if (col.folderIds.length === 0) { doDelete(); return; }
    wrap.classList.add('confirming');
  });
  yesBtn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    doDelete();
  });
  cancelBtn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    wrap.classList.remove('confirming');
  });

  wrap.appendChild(trigger);
  wrap.appendChild(confirm);
  return wrap;
}

function makeEditAddFolderControl(col) {
  const wrap = document.createElement('div');
  wrap.className = 'edit-add-folder';

  const trigger = document.createElement('button');
  trigger.className = 'add-trigger';
  trigger.textContent = '+ Add item';
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    // Clicking this column's own trigger toggles it closed; clicking a different
    // column's trigger while one is open switches to it in a single click.
    const mine = addMenuEl && wrap.contains(addMenuEl);
    closeAddMenu();
    if (!mine) openAddMenu(trigger, col);
  });

  wrap.appendChild(trigger);
  return wrap;
}

function closeAddMenu() {
  if (addMenuCleanup) { addMenuCleanup(); addMenuCleanup = null; }
  if (addMenuEl) { addMenuEl.remove(); addMenuEl = null; }
}

// The "+ Add item" menu: an iOS-Settings-style drill-down. The root lists
// widgets + top-level folders; tapping a folder with subfolders pushes a new
// page (‹ Back header + "Add <folder>" + its subfolders), recursing to any
// depth. Lives inside the column (absolutely positioned under the trigger) so it
// scrolls with the column rather than floating over it.
function openAddMenu(trigger, col) {
  closeAddMenu();

  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const elText = (tag, cls, text) => { const e = el(tag, cls); e.textContent = text; return e; };

  const assigned = new Set(state.columns.flatMap(c => c.folderIds));

  // parentId → child folders (pre-order within each bucket, as allFolders is).
  const childrenOf = new Map();
  allFolders.forEach(f => {
    if (!childrenOf.has(f.parentId)) childrenOf.set(f.parentId, []);
    childrenOf.get(f.parentId).push(f);
  });

  // A folder is worth showing if it can be added (not already placed) or has a
  // descendant that can — prunes fully-placed/empty branches.
  const usefulCache = new Map();
  function isUseful(f) {
    if (usefulCache.has(f.id)) return usefulCache.get(f.id);
    let useful = !assigned.has(f.id);
    if (!useful) useful = (childrenOf.get(f.id) || []).some(isUseful);
    usefulCache.set(f.id, useful);
    return useful;
  }
  const usefulChildren = f => (childrenOf.get(f.id) || []).filter(isUseful);

  const add = id => {
    col.folderIds.push(id);
    persist();
    renderColumns(); // also closes the menu (renderColumns → closeAddMenu)
  };

  // Top-level containers (Bookmarks bar, Other bookmarks, …) appear as their own
  // collapsed rows — a chevron to drill into, or a plain row if empty/leaf. No
  // hoisting, so the menu's shape is predictable and a container is never shown
  // pre-opened at the root.
  const rootImplied = null;
  const rootFolders = (childrenOf.get('0') || []).filter(isUseful);

  const path = []; // stack of folder nodes; [] = root page

  // A folder row: leaf adds on click, parent pushes a page (chevron affordance).
  function folderRow(f) {
    if (usefulChildren(f).length === 0) {
      const btn = el('button', 'add-item');
      btn.append(elText('span', 'add-item-name', f.title || 'Untitled'));
      btn.addEventListener('click', e => { e.stopPropagation(); add(f.id); });
      return btn;
    }
    const btn = el('button', 'add-item');
    const chev = makeChevron('right');
    chev.classList.add('add-chevron');
    btn.append(elText('span', 'add-item-name', f.title || 'Untitled'), chev);
    btn.addEventListener('click', e => { e.stopPropagation(); path.push(f); navigate('push'); });
    return btn;
  }

  function buildPage() {
    const page = el('div', 'add-page');
    const cur = path[path.length - 1] || null;

    // Only sub-pages get a header — just a back button. The current folder is
    // named by its "Add … folder" row below, so no separate title line.
    if (cur) {
      const dest = path.length >= 2 ? path[path.length - 2].title
                 : (rootImplied ? rootImplied.title : 'Back');
      const nav = el('div', 'add-nav');
      const back = el('button', 'add-back');
      back.append(makeChevron('left'), document.createTextNode(dest || 'Back'));
      back.addEventListener('click', e => { e.stopPropagation(); path.pop(); navigate('pop'); });
      nav.append(back);
      page.append(nav);
    }

    if (!cur) {
      // Root page.
      const widgets = Object.keys(WIDGET_TITLES).filter(id => !assigned.has(id));
      if (widgets.length) {
        page.append(elText('div', 'add-group-label', 'Widgets'));
        widgets.forEach(wid => {
          const btn = el('button', 'add-item');
          btn.append(elText('span', 'add-item-name', WIDGET_TITLES[wid]));
          btn.addEventListener('click', e => { e.stopPropagation(); add(wid); });
          page.append(btn);
        });
      }
      if (rootFolders.length) {
        page.append(elText('div', 'add-group-label', 'Folders'));
        if (rootImplied) {
          const btn = el('button', 'add-item add-item-strong');
          btn.disabled = assigned.has(rootImplied.id);
          btn.append(elText('span', 'add-item-name', `Add ${rootImplied.title} folder`));
          btn.addEventListener('click', e => { e.stopPropagation(); add(rootImplied.id); });
          page.append(btn, el('div', 'add-sep'));
        }
        rootFolders.forEach(f => page.append(folderRow(f)));
      }
      if (!widgets.length && !rootFolders.length) {
        page.append(elText('div', 'add-group-label', 'Nothing left to add'));
      }
    } else {
      // Inside a folder.
      const addSelf = el('button', 'add-item add-item-strong');
      addSelf.disabled = assigned.has(cur.id);
      addSelf.append(elText('span', 'add-item-name', `Add ${cur.title || 'Untitled'} folder`));
      addSelf.addEventListener('click', e => { e.stopPropagation(); add(cur.id); });
      page.append(addSelf, el('div', 'add-sep'));
      usefulChildren(cur).forEach(f => page.append(folderRow(f)));
    }

    return page;
  }

  const menu = el('div', 'add-menu');
  const stage = el('div', 'add-stage');
  menu.appendChild(stage);

  // The menu lives INSIDE the column, absolutely positioned just under the
  // trigger, so it scrolls with the column instead of floating over it. A small
  // absolute spacer parked just below the menu lets the column scroll a little
  // past it, so the menu never sits flush against the browser edge.
  const wrapper = trigger.closest('.edit-add-folder') || document.body;
  const pad = el('div', 'add-scroll-pad');
  const syncPad = () => { pad.style.top = `${menu.offsetTop + menu.offsetHeight}px`; };

  function navigate(direction) {
    const page = buildPage();
    page.classList.add(direction === 'pop' ? 'slide-from-left' : 'slide-from-right');
    stage.replaceChildren(page);
    syncPad();
  }

  navigate('push'); // initial root render
  wrapper.appendChild(menu);
  wrapper.appendChild(pad);
  syncPad();
  trigger.textContent = 'Cancel';   // toggle affordance while the menu is open
  // Reveal it if the trigger sits below the fold in a scrolled column.
  menu.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const onDocClick = e => {
    if (!menu.contains(e.target) && e.target !== trigger) closeAddMenu();
  };
  const onKey = e => { if (e.key === 'Escape') closeAddMenu(); };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);

  addMenuEl = menu;
  addMenuCleanup = () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
    pad.remove();
    trigger.textContent = '+ Add item';
  };
}

// Edit-mode "remove from column" × — visible only when body.edit-mode is on.
function makeEditFolderRemove(fid) {
  const btn = document.createElement('button');
  btn.className = 'edit-folder-remove';
  btn.title = 'Remove from column';
  btn.textContent = '×';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    const col = state.columns.find(c => c.folderIds.includes(fid));
    if (!col) return;
    col.folderIds = col.folderIds.filter(id => id !== fid);
    persist();
    renderColumns();
  });
  return btn;
}

function attachTopLevelDragHandlers(group) {
  // Default false; only the label flips it true on mousedown so interactive
  // children (search input, bookmarks) don't initiate a folder drag.
  group.draggable = false;

  const label = group.querySelector('.folder-label');
  if (label) {
    label.addEventListener('mousedown', () => {
      group.draggable = true;
      const reset = () => {
        group.draggable = false;
        document.removeEventListener('mouseup', reset);
      };
      document.addEventListener('mouseup', reset);
    });
  }

  group.addEventListener('dragstart', e => {
    e.stopPropagation();
    mainDragFid = group.dataset.fid;
    mainDragDropped = false;
    e.dataTransfer.effectAllowed = 'move';

    // Chrome infers a "link drag" when the source contains <a href> children
    // (our bookmark items) and decorates the cursor with a globe icon.
    // Setting non-link drag data shuts that off.
    e.dataTransfer.setData('text/plain', '');

    // Suppress the cursor-following drag image — the in-place dimmed folder
    // (which FLIP-animates to wherever it would land) is the only visual
    // representation.
    suppressDragImage(e);

    // For tall folders, show only the first SHOWN direct items in the in-place
    // ghost — the rest are hidden and a "+ N more" placeholder takes their
    // place. Short folders keep their full ghost.
    const SHOWN = 13;
    const directItems = [...group.querySelectorAll(
      ':scope > .bookmark-item, :scope > .subfolder-group'
    )];
    const overflow = directItems.slice(SHOWN);

    if (overflow.length) {
      // Surrounding folder-groups FLIP-animate up into the freed space.
      // Snapshot inside the FLIP hook (post-mutate, pre-inverse-transform) so
      // getBoundingClientRect returns the truncated layout positions.
      const others = [...document.querySelectorAll('#columns-container .folder-group')]
        .filter(g => g !== group);
      flipElements(
        others,
        () => {
          group.classList.add('dragging');
          overflow.forEach(it => it.style.display = 'none');
          const more = document.createElement('div');
          more.className = 'drag-more-indicator';
          more.textContent = `+ ${overflow.length} more`;
          group.appendChild(more);
        },
        () => { mainDragSnapshot = snapshotMainLayout(); }
      );
    } else {
      group.classList.add('dragging');
      mainDragSnapshot = snapshotMainLayout();
    }
  });
  group.addEventListener('dragend', () => {
    group.classList.remove('dragging');
    group.draggable = false; // safety reset (in case mouseup didn't fire)
    mainDragFid = null;
    mainDragSnapshot = null;
    if (!mainDragDropped) renderColumns(); // user cancelled — restore from state
    mainDragDropped = false;
  });
}


function makeRecentlyAddedGroup(colId) {
  const group = document.createElement('div');
  group.className = 'folder-group';
  group.dataset.fid = RECENT_WIDGET_ID;

  const label = document.createElement('div');
  label.className = 'folder-label';
  label.textContent = WIDGET_TITLES[RECENT_WIDGET_ID];
  group.appendChild(label);

  recentBookmarks.forEach(bm => {
    if (!state.showHidden && isHidden(bm.id, colId)) return;
    const a = document.createElement('a');
    a.className = 'bookmark-item';
    if (isHidden(bm.id, colId)) a.classList.add('item-hidden');
    a.href = bm.url;
    a.title = bm.title || bm.url;
    a.dataset.id = bm.id;

    const img = makeFavicon(bm.url);
    if (img) a.appendChild(img);

    const span = document.createElement('span');
    span.className = 'bookmark-title';
    span.textContent = bm.title || bm.url;
    a.appendChild(span);

    a.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: isHidden(bm.id, colId) ? 'Show' : 'Hide', action: () => toggleHidden(bm.id, colId) },
      ]);
    });

    group.appendChild(a);
  });

  group.appendChild(makeEditFolderRemove(RECENT_WIDGET_ID));
  attachTopLevelDragHandlers(group);
  return group;
}

function computeStats() {
  const totalBookmarks = allBookmarks.length;
  const totalFolders   = allFolders.length;

  // Bookmarks reachable from any configured (non-widget, non-hidden) folder.
  const shown = new Set();
  state.columns.forEach(col => {
    const hiddenSet = hiddenIds[col.id] || new Set();
    col.folderIds.forEach(fid => {
      if (WIDGET_TITLES[fid] !== undefined) return;
      if (hiddenSet.has(fid)) return;
      const folder = folderById(fid);
      if (folder) collectVisibleBookmarkIds(folder, shown, hiddenSet);
    });
  });

  // Hidden items across all columns (folders + bookmarks)
  let hiddenCount = 0;
  for (const ids of Object.values(hiddenIds)) hiddenCount += ids.size;

  // Unique domains — strip leading "www." so apex/www aren't split.
  const domains = new Set();
  allBookmarks.forEach(bm => {
    try {
      domains.add(new URL(bm.url).hostname.replace(/^www\./, ''));
    } catch {}
  });

  // Duplicates = total - unique-URL count
  const uniqueUrls = new Set(allBookmarks.map(b => b.url));
  const duplicateCount = totalBookmarks - uniqueUrls.size;

  const emptyFolders = allFolders.filter(f => !f.children || f.children.length === 0).length;

  return {
    totalBookmarks,
    totalFolders,
    shownCount: shown.size,
    hiddenCount,
    uniqueDomains: domains.size,
    duplicateCount,
    emptyFolders,
  };
}

function collectVisibleBookmarkIds(node, acc, hiddenSet) {
  if (!node.children) return;
  for (const c of node.children) {
    if (hiddenSet.has(c.id)) continue;
    if (c.url) acc.add(c.id);
    else collectVisibleBookmarkIds(c, acc, hiddenSet);
  }
}

function makeStatusGroup(/* colId */) {
  const group = document.createElement('div');
  group.className = 'folder-group';
  group.dataset.fid = STATUS_WIDGET_ID;

  const label = document.createElement('div');
  label.className = 'folder-label';
  label.textContent = WIDGET_TITLES[STATUS_WIDGET_ID];
  group.appendChild(label);

  const stats = computeStats();

  const row = (text, value) => {
    const r = document.createElement('div');
    r.className = 'status-row';
    const l = document.createElement('span');
    l.className = 'status-row-label';
    l.textContent = text;
    const v = document.createElement('span');
    v.className = 'status-row-value';
    v.textContent = value;
    r.appendChild(l);
    r.appendChild(v);
    return r;
  };

  const fmt = n => n.toLocaleString();
  group.appendChild(row('Bookmarks',      fmt(stats.totalBookmarks)));
  group.appendChild(row('Folders',        fmt(stats.totalFolders)));
  group.appendChild(row('Shown',          `${fmt(stats.shownCount)} / ${fmt(stats.totalBookmarks)}`));
  if (stats.hiddenCount > 0) group.appendChild(row('Hidden', fmt(stats.hiddenCount)));
  group.appendChild(row('Unique domains', fmt(stats.uniqueDomains)));

  const healthRows = [];
  if (stats.duplicateCount > 0) healthRows.push(['Duplicate bookmarks', stats.duplicateCount]);
  if (stats.emptyFolders > 0)   healthRows.push(['Empty folders',  stats.emptyFolders]);
  if (healthRows.length) {
    const sub = document.createElement('div');
    sub.className = 'status-subheader';
    sub.textContent = 'Health';
    group.appendChild(sub);
    healthRows.forEach(([t, v]) => group.appendChild(row(t, fmt(v))));
  }

  group.appendChild(makeEditFolderRemove(STATUS_WIDGET_ID));
  attachTopLevelDragHandlers(group);
  return group;
}

function makeSearchGroup() {
  const group = document.createElement('div');
  group.className = 'folder-group';
  group.dataset.fid = SEARCH_WIDGET_ID;

  const label = document.createElement('div');
  label.className = 'folder-label';
  label.textContent = WIDGET_TITLES[SEARCH_WIDGET_ID];
  group.appendChild(label);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'search-input-wrap';

  const input = document.createElement('input');
  input.className = 'search-input';
  input.type = 'search';
  input.placeholder = 'Search bookmarks…';
  input.value = searchQuery;
  // Don't let cmd/ctrl-A inside the input bubble to anything global.
  input.addEventListener('keydown', e => e.stopPropagation());
  inputWrap.appendChild(input);

  const clear = document.createElement('button');
  clear.className = 'search-clear';
  clear.type = 'button';
  clear.textContent = '×';
  clear.title = 'Clear';
  clear.addEventListener('click', () => {
    input.value = '';
    searchQuery = '';
    renderResults();
    input.focus();
  });
  inputWrap.appendChild(clear);

  group.appendChild(inputWrap);

  const results = document.createElement('div');
  results.className = 'search-results';
  group.appendChild(results);

  const renderResults = () => {
    results.innerHTML = '';
    const q = searchQuery.trim().toLowerCase();
    if (!q) return;

    const matches = [];
    for (const bm of allBookmarks) {
      if ((bm.title || '').toLowerCase().includes(q) || bm.url.toLowerCase().includes(q)) {
        matches.push(bm);
        if (matches.length >= SEARCH_LIMIT) break;
      }
    }

    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'No results';
      results.appendChild(empty);
      return;
    }

    matches.forEach(bm => {
      const a = document.createElement('a');
      a.className = 'bookmark-item';
      a.href = bm.url;
      a.title = bm.title || bm.url;
      a.dataset.id = bm.id;

      const img = makeFavicon(bm.url);
      if (img) a.appendChild(img);

      const span = document.createElement('span');
      span.className = 'bookmark-title';
      span.textContent = bm.title || bm.url;
      a.appendChild(span);

      results.appendChild(a);
    });
  };

  // Debounce so each keystroke doesn't iterate allBookmarks
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      searchQuery = input.value;
      renderResults();
    }, 80);
  });

  renderResults();

  group.appendChild(makeEditFolderRemove(SEARCH_WIDGET_ID));
  attachTopLevelDragHandlers(group);
  return group;
}

function makeFolderGroup(folder, depth = 0, siblings = null, idx = 0, colId = null) {
  const group = document.createElement('div');
  group.className = depth === 0 ? 'folder-group' : 'subfolder-group';

  if (depth === 0) {
    // Top-level: always-visible label, no toggle. Whole group is draggable so
    // it can be moved between columns or reordered within one.
    group.dataset.fid = folder.id;

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

    group.appendChild(makeEditFolderRemove(folder.id));
    attachTopLevelDragHandlers(group);
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
          label: 'Delete', danger: true, confirm: true, action: async () => {
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

  // Container-level dragover/drop for reorder. The browser shows its default
  // drag image (the bookmark element follows the cursor) and we render a
  // horizontal accent-coloured line on the nearest sibling to indicate the
  // drop position — same as macOS Finder / Safari bookmark reorder.
  container.addEventListener('dragover', e => {
    if (!draggedItem) return;
    // Bookmarks move freely across folders. A subfolder can reorder within its
    // own parent in any mode, and in regular view also move into a *different*
    // folder (a real tree move) — but never into itself or its own descendant.
    // In edit mode the cross-folder drag is reserved for adding the folder to a
    // column, so it falls through to the column-level handler.
    const isBookmark = draggedItem.node.url != null;
    if (!isBookmark && draggedItem.folderId !== folder.id &&
        (editMode || isDescendantOrSelf(folder.id, draggedItem.node.id))) return;

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    clearDropIndicators(container);

    const draggedEl = container.querySelector(`:scope > [data-id="${draggedItem.node.id}"]`);
    const siblings = [...container.querySelectorAll(':scope > .bookmark-item, :scope > .subfolder-group')]
      .filter(el => el !== draggedEl);
    if (!siblings.length) {
      // Empty folder — no sibling to anchor on. Show the same horizontal line
      // inside the folder (the drop lands at index 0).
      const line = document.createElement('div');
      line.className = 'drop-line';
      container.appendChild(line);
      pendingItemDrop = { container, folderId: folder.id };
      return;
    }

    for (const sib of siblings) {
      const rect = sib.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        sib.classList.add('drop-before');
        pendingItemDrop = { container, folderId: folder.id };
        return;
      }
    }
    // Past last sibling — indicator on the bottom edge of the last one.
    siblings[siblings.length - 1].classList.add('drop-after');
    pendingItemDrop = { container, folderId: folder.id };
  });

  container.addEventListener('drop', async e => {
    if (!draggedItem) return;
    const isBookmark = draggedItem.node.url != null;
    if (!isBookmark && draggedItem.folderId !== folder.id &&
        (editMode || isDescendantOrSelf(folder.id, draggedItem.node.id))) return;

    e.preventDefault();
    e.stopPropagation();

    const beforeEl = container.querySelector(':scope > .drop-before');
    const afterEl  = container.querySelector(':scope > .drop-after');
    const into     = !!container.querySelector(':scope > .drop-line');
    clearDropIndicators(container);
    if (!beforeEl && !afterEl && !into) return;

    const allSiblings = [...container.querySelectorAll(':scope > .bookmark-item, :scope > .subfolder-group')];
    let targetIdx = beforeEl ? allSiblings.indexOf(beforeEl)
                  : afterEl  ? allSiblings.indexOf(afterEl) + 1
                  : 0; // dropped into an empty folder

    // Same-folder drop-before adjustment: when the source is earlier in the
    // list than the target, removing the source first shifts the target down
    // by one. drop-after at the end does NOT need this adjustment — Chrome
    // already treats `index >= length` as "append".
    const draggedEl = container.querySelector(`:scope > [data-id="${draggedItem.node.id}"]`);
    if (draggedEl && beforeEl) {
      const draggedIdx = allSiblings.indexOf(draggedEl);
      if (draggedIdx < targetIdx) targetIdx -= 1;
    }

    pendingItemDrop = null; // drop fired and is processing — no dragend fallback needed
    await chrome.bookmarks.move(draggedItem.node.id, { parentId: folder.id, index: targetIdx });
    refresh();
  });

  children.forEach((child, idx) => {
    if (child.children != null) {
      if (!state.showHidden && isHidden(child.id, colId)) return;
      const group = makeFolderGroup(child, depth + 1, children, idx, colId);
      if (isHidden(child.id, colId)) group.classList.add('item-hidden');

      group.draggable = true;
      group.dataset.id = child.id;

      group.addEventListener('dragstart', e => {
        e.stopPropagation();
        draggedItem = { node: child, folderId: folder.id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', child.id);
        requestAnimationFrame(() => group.classList.add('dragging'));
      });

      group.addEventListener('dragend', async () => {
        // If the drop event didn't process (e.g. cursor moved at the last
        // moment), commit the move from the indicator state we saved.
        await flushPendingItemDrop();
        group.classList.remove('dragging');
        draggedItem = null;
        clearDropIndicators(document);
      });

      container.appendChild(group);
    } else if (child.url) {
      if (!state.showHidden && isHidden(child.id, colId)) return;
      container.appendChild(makeBookmarkItem(child, folder, children, idx, colId));
    }
  });
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
        label: 'Delete', danger: true, confirm: true, action: async () => {
          await chrome.bookmarks.remove(bm.id);
          refresh();
        },
      },
    ]);
  });

  // ── Drag to reorder (positional logic in renderFolderContents container) ──
  a.addEventListener('dragstart', e => {
    e.stopPropagation(); // don't trigger folder-group drag
    draggedItem = { node: bm, folderId: folder.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', bm.id);
    requestAnimationFrame(() => a.classList.add('dragging'));
  });

  a.addEventListener('dragend', async () => {
    await flushPendingItemDrop();
    a.classList.remove('dragging');
    draggedItem = null;
    clearDropIndicators(document);
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

    // Items flagged `confirm: true` transform in place into an inline
    // Yes / Cancel pair on click instead of firing immediately. Same pattern
    // as the column-remove confirm in edit mode.
    if (item.confirm) {
      const wrap = document.createElement('div');
      wrap.className = 'ctx-confirm-wrap';

      const trigger = document.createElement('button');
      trigger.className = 'ctx-item' + (item.danger ? ' danger' : '');
      trigger.textContent = item.label;
      trigger.disabled = item.disabled ?? false;

      const row = document.createElement('div');
      row.className = 'ctx-confirm';

      const yes = document.createElement('button');
      yes.className = 'ctx-confirm-yes' + (item.danger ? ' danger' : '');
      yes.textContent = 'Yes';
      yes.addEventListener('click', e => {
        e.stopPropagation();
        ctxMenu.classList.add('hidden');
        item.action();
      });

      const cancel = document.createElement('button');
      cancel.className = 'ctx-confirm-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', e => {
        e.stopPropagation();
        wrap.classList.remove('confirming');
      });

      row.appendChild(yes);
      row.appendChild(cancel);

      trigger.addEventListener('click', e => {
        e.stopPropagation();
        wrap.classList.add('confirming');
      });

      wrap.appendChild(trigger);
      wrap.appendChild(row);
      ctxMenu.appendChild(wrap);
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
  document.getElementById('version-number').textContent = chrome.runtime.getManifest().version;

  document.getElementById('exit-edit-mode').addEventListener('click', () => toggleEditMode(false));

  // Esc closes the panel or exits edit mode (panel takes priority if both open).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (addMenuEl) return; // the open add-menu handles its own Escape
    const panel = document.getElementById('settings-panel');
    if (!panel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (editMode) toggleEditMode(false);
  });

  // Cmd/Ctrl+E toggles column edit mode — but not while typing (e.g. renaming a
  // bookmark/folder), where it would re-render and discard the in-progress edit.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
        (e.key === 'e' || e.key === 'E')) {
      const t = e.target;
      if (t && (t.matches?.('input, textarea, select') || t.isContentEditable)) return;
      e.preventDefault();
      if (!editMode) closeSettings();
      toggleEditMode(!editMode);
    }
  });

  // Outside click closes — `click` (not mousedown) so initiating a drag from
  // outside the panel doesn't fire and close it mid-drag.
  document.addEventListener('click', e => {
    const panel = document.getElementById('settings-panel');
    if (panel.classList.contains('hidden')) return;
    if (panel.contains(e.target)) return;
    if (e.target.closest('#settings-toggle')) return;
    if (e.target.closest('.ctx-menu')) return;
    closeSettings();
  });
}

function toggleEditMode(on) {
  editMode = on;
  document.body.classList.toggle('edit-mode', editMode);
  renderColumns();
}

function openSettings() {
  document.getElementById('settings-panel').classList.remove('hidden');
  renderSettingsPanel();
}

function closeSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
  // Drop focus so the (transparent) settings-toggle doesn't keep its :focus
  // outline visible after Esc/outside-click closes the panel.
  document.getElementById('settings-toggle').blur();
}

// Refresh the settings panel's control states from `state` (e.g. after a live
// remote sync change updates theme/dividers). No-op when the panel isn't open.
function syncSettingsControls() {
  const panel = document.getElementById('settings-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  document.querySelectorAll('.theme-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.value === state.theme));
  const set = (id, checked) => { const el = document.getElementById(id); if (el) el.checked = checked; };
  set('dividers-toggle', state.dividers);
  set('hide-handles-toggle', !state.hideHandles);
  set('hide-folder-dividers-toggle', !state.hideFolderDividers);
  set('show-hidden-toggle', state.showHidden);
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
  // "Column dividers" — checkbox semantics are "visible when checked", so we
  // invert against the underlying `hideHandles` storage key for compatibility.
  const hideHandlesToggle = document.getElementById('hide-handles-toggle');
  hideHandlesToggle.checked = !state.hideHandles;
  hideHandlesToggle.onchange = () => {
    state.hideHandles = !hideHandlesToggle.checked;
    applyHideHandles(state.hideHandles);
    persist();
  };

  // Hide folder title dividers
  // "Folder title dividers" — same pattern as Column dividers above.
  const hideFolderDividersToggle = document.getElementById('hide-folder-dividers-toggle');
  hideFolderDividersToggle.checked = !state.hideFolderDividers;
  hideFolderDividersToggle.onchange = () => {
    state.hideFolderDividers = !hideFolderDividersToggle.checked;
    applyHideFolderDividers(state.hideFolderDividers);
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

  const editViewBtn = document.getElementById('edit-view-toggle');
  editViewBtn.onclick = () => {
    closeSettings();
    toggleEditMode(true);
  };

  // Optional cross-device layout sync — per-device, opt-in (see sync-design.md).
  const syncToggle = document.getElementById('sync-toggle');
  const syncOffConfirm = document.getElementById('sync-off-confirm');
  syncToggle.checked = layoutSyncEnabled;
  syncOffConfirm.classList.add('hidden'); // start collapsed each time the panel opens
  syncToggle.onchange = async () => {
    if (syncToggle.checked) {
      syncOffConfirm.classList.add('hidden');
      await enableSync();
    } else {
      // Don't disable yet — let the user choose what happens to this device's
      // layout (keep it, or reset to default). Cancel re-enables the toggle.
      syncOffConfirm.classList.remove('hidden');
    }
  };
  document.getElementById('sync-off-keep').onclick = async () => {
    syncOffConfirm.classList.add('hidden');
    await disableSync(false);
  };
  document.getElementById('sync-off-reset').onclick = async () => {
    syncOffConfirm.classList.add('hidden');
    await disableSync(true);
  };
  document.getElementById('sync-off-cancel').onclick = () => {
    syncOffConfirm.classList.add('hidden');
    syncToggle.checked = true; // stay synced
  };
  // The ⓘ glyph shows its description on hover/focus; clicking it must not
  // toggle the label-wrapped checkbox.
  document.getElementById('sync-info')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
  });
}

async function enableSync() {
  if (!chrome.storage.sync) { layoutSyncEnabled = false; return; }
  layoutSyncEnabled = true; // active store is now sync
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: true });

  const { rawColumns: cloudCols } = await readLayout(chrome.storage.sync);
  if (!cloudCols.length) {
    // Cloud empty → this device seeds the shared baseline (layout + settings).
    lastPersistedLayout = null;
    await persist();
  } else {
    // Cloud already has a layout → adopt it (and its settings). The first device
    // you enable seeds the shared copy; others adopt it. To change the shared
    // layout, just edit on any synced device — changes propagate.
    await reloadFromActiveStore();
  }
}

async function disableSync(reset) {
  layoutSyncEnabled = false; // active store is now local again
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: false });
  if (reset) {
    // Reset this device's columns to the first-install default. Only this device
    // is affected — the cloud copy is left intact, so synced devices keep theirs.
    const tree = await chrome.bookmarks.getTree();
    state.columns = defaultColumns(tree[0]);
    pruneHiddenIds();
    renderColumns();
  }
  lastPersistedLayout = null;
  await persist(); // snapshot the (kept or reset) layout to local; cloud left for others
}

// Re-read the layout bundle from the active store and re-render.
async function reloadFromActiveStore() {
  const { settings, rawColumns, colIds } = await readLayout(layoutStore());
  Object.assign(state, settings);
  lastColIds = colIds;
  applyTheme(state.theme);
  applyDividers(state.dividers);
  applyHideHandles(state.hideHandles);
  applyHideFolderDividers(state.hideFolderDividers);
  state.columns = hydrateColumns(rawColumns);
  lastPersistedLayout = null;
  renderColumns();
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

function applyHideFolderDividers(on) {
  document.getElementById('columns-container').classList.toggle('hide-folder-dividers', on);
}


// ─── Persistence ──────────────────────────────────────────────────────────────

// The layout is sharded across keys so no single key approaches storage.sync's
// 8 KB/item limit: settings keys + `colOrder` (column id list) + one `col:<id>`
// per column. Used for both stores (harmless in local). readLayout also reads
// the legacy single-`columns` key so pre-3 layouts migrate to shards on load.
async function writeLayout(store) {
  const payload = { layoutSchema: 3, colOrder: state.columns.map(c => c.id) };
  SETTINGS_KEYS.forEach(k => { payload[k] = state[k]; });
  state.columns.forEach(c => {
    payload[`col:${c.id}`] = { width: c.width, folderIds: serializeFolderIds(c.folderIds) };
  });
  await store.set(payload);
  // Drop shards for removed columns + the legacy single-key blob, if present.
  const stale = lastColIds.filter(id => !payload.colOrder.includes(id)).map(id => `col:${id}`);
  stale.push('columns');
  await store.remove(stale).catch(() => {});
  lastColIds = payload.colOrder.slice();
}

async function readLayout(store) {
  const head = await store.get([...SETTINGS_KEYS, 'colOrder', 'columns']);
  const settings = {};
  SETTINGS_KEYS.forEach(k => { if (head[k] != null) settings[k] = head[k]; });
  let rawColumns = [], legacy = false, colIds = [];
  if (Array.isArray(head.colOrder)) {                       // sharded (schema 3)
    const cd = head.colOrder.length ? await store.get(head.colOrder.map(id => `col:${id}`)) : {};
    rawColumns = head.colOrder
      .map(id => { const c = cd[`col:${id}`]; return c ? { id, width: c.width, folderIds: c.folderIds } : null; })
      .filter(Boolean);
    colIds = head.colOrder.slice();
  } else if (Array.isArray(head.columns)) {                 // legacy single key
    rawColumns = head.columns;
    legacy = true;
    colIds = head.columns.map(c => c.id);
  }
  return { settings, rawColumns, legacy, colIds };
}

function persist() {
  // Format-independent signature, so identical layouts skip the write (avoids
  // churn from refresh() re-persists and respects sync's write-rate limits).
  const sig = JSON.stringify({ s: SETTINGS_KEYS.map(k => state[k]), c: serializeColumns() });
  if (sig === lastPersistedLayout) return Promise.resolve();
  lastPersistedLayout = sig;
  return writeLayout(layoutStore()).catch(err => {
    // e.g. storage.sync per-item / quota / rate limit. Don't lose the change:
    // allow the next edit to retry; the layout stays correct in memory.
    console.warn('[layout] persist failed:', err?.message || err);
    lastPersistedLayout = null;
  });
}
