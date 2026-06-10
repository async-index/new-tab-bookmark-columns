# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.3.1] — 2026-06-10

### Fixed
- **Turning sync on no longer risks overwriting your saved layout with the default.** On a freshly-opened tab, the account's layout may not have downloaded yet; enabling sync could misread that as "nothing saved" and push this device's default over it. Enabling now waits for the synced copy to arrive and only ever seeds when the account is genuinely empty — otherwise it loads your saved layout.
- **Synced devices no longer fight over the layout.** Because each device records folder references with some device-local detail, two devices could repeatedly rewrite and re-adopt the same layout — flickering and burning through the sync write quota. An adopted layout is now treated as already-saved, so it settles instead of bouncing back and forth.
- **A layout still replicating in is no longer overwritten.** Sync delivers a layout's pieces independently; arriving mid-transfer could make a device seed defaults over, or save a truncated copy of, the real layout. Incomplete reads are now left alone until the rest arrives.
- **Edits are no longer lost when a sync write is rejected** (e.g. a very large column hitting Chrome's per-item size limit). The layout is mirrored to local storage as a fallback and recovered on the next open, instead of reverting to defaults.
- **A folder that changes bookmark ID** (from bookmark sync or Chrome's account-bookmarks migration) is now re-matched by its reference and kept, instead of being dropped from the column and that loss syncing everywhere.
- **The sync toggle now updates every open new-tab page**, so a second tab can't keep writing to the store you just switched away from.
- A corrupted or future-version synced layout can no longer blank the page, and an older version of the extension won't overwrite a layout saved by a newer one.
- A remotely-removed column no longer leaves stale hidden-item data behind.

### Changed
- The Sync info tooltip now notes that turning sync on adopts the layout your other synced devices already share, replacing what's on this device.

### Internal
- Removed redundant work and an extra storage write on every save; deleted dead code (and a stray null byte) introduced during 1.3.0.

## [1.3.0] — 2026-06-03

### Added
- **Cross-device layout & settings sync (opt-in).** A new **Sync** section in Settings with a **Sync layout & settings** toggle (off by default). When you turn it on, your column layout and display settings (theme, dividers, hidden items) are shared across the devices where sync is activated, using Chrome's built-in `chrome.storage.sync` (your Google account). No new permission is required.
- Sync is **per-device and opt-in by design**, so a work and a personal device can keep different layouts — the toggle's on/off state is itself never synced. Edits on any synced device update the others, applied live on open tabs.
- **Turning sync off prompts you to keep the current layout on this device or reset it to default** — either way your other devices stay synced. The cloud copy is left intact.
- An ⓘ info glyph in the Sync section explains what's shared.

### Changed
- The saved layout now identifies each folder by a **re-resolvable reference** (root type, account/local subtree, and title path) instead of a raw bookmark node ID. Bookmark node IDs aren't stable across devices — or even across restarts — so this makes the layout robust cross-device and more resilient locally. Existing layouts migrate automatically on first launch.
- Layout storage is **sharded** (one key per column) to stay under the sync per-item size limit.
- A folder referenced in a column that can't be found on the current device now shows a dimmed **"needs re-link"** placeholder instead of silently disappearing — it resolves automatically on a device that has the folder.

## [1.2.0] — 2026-06-03

### Added
- **Drill-down "+ Add item" menu.** The flat dropdown is replaced by an iOS-Settings-style menu that lets you browse the whole bookmark tree — including nested subfolders at any depth — to add any folder to a column. Each folder with subfolders opens a page with a `‹ Back` header, an `Add <folder>` action, and its subfolders.
- **Drag a subfolder onto a column** (edit mode) to add it there as a top-level item — the drag equivalent of "+ Add item".
- **Move a bookmark or folder between folders across columns.** Folders can now be dragged from one open folder into another (a real bookmark-tree move), matching bookmarks; guarded against dropping a folder into its own descendant.
- **Drop into an empty folder.** Empty folders are now valid drop targets, shown with the same horizontal indicator as reordering.
- **Cmd/Ctrl+E** toggles column edit mode.
- The **+ Add item** button reads **Cancel** while its menu is open.

### Changed
- The "+ Add item" menu lives inside its column and **scrolls with the column** instead of floating as a fixed overlay; a small spacer keeps it off the browser's bottom edge.
- Top-level containers (Bookmarks bar, Other bookmarks) always appear as collapsible rows in the menu, regardless of what's already placed.

### Fixed
- Dragging a column to the last position threw an `insertBefore` error and aborted the reorder.
- Cmd/Ctrl+E no longer fires while typing in a rename or search field.
- Esc closes an open "+ Add item" menu without also exiting edit mode.

## [1.1.1] — 2026-05-31

### Fixed
- **Done editing** button could be hidden behind the **+ Add column** button once the columns overflowed the viewport — the floating top-right button is replaced by a stacked action group (**+ Add column** over **Done editing**) anchored at the end of the columns row, so they can never overlap at any scroll position.

### Changed
- Horizontal columns scrollbar is now hidden until you scroll (then fades out), matching the thin per-column scrollbars, instead of being permanently visible.
- **Done editing** restyled to match the theme-toggle track (filled background, muted text, matching outline); its spacing from **+ Add column** now matches the in-column **+ Add item** / **× Remove column** gap.
- Settings toggle icon uses a tighter margin and an even-padding rounded-rectangle hover target.
- Settings panel close control is now a thin SF-Symbols-style ✕ in the header (replacing the duplicate sidebar glyph); panel top padding tightened slightly.

## [1.1.0] — 2026-05-29

### Added
- Inline column edit mode with per-column drag handle, `+ Add item` dropdown, `× Remove column`, and floating **Done editing** button.
- Widget system sharing `col.folderIds`: **Recently added**, **Status**, and **Search** widgets.
- Per-column hidden state — hiding a folder in one column no longer affects it in other columns.
- Drag-and-drop reordering for bookmarks and subfolders inside a folder, with horizontal drop indicators (macOS Finder style).
- Tall-folder cap during drag (preview limited to first N children to keep the drag image manageable).
- Inline confirmation modals for destructive actions (delete folder, delete bookmark) — replaces native `window.confirm`.
- Display settings: bookmark dividers, folder title dividers, column dividers, show hidden items.
- Esc closes the settings panel or exits edit mode.
- Custom thin column scrollbar that appears on hover/scroll.

### Changed
- Folder and column reorder use FLIP animations with stable snapshot-based swap thresholds.
- Drag image suppressed for folder-group and column drags; bookmark/subfolder drags keep the OS cursor-follower.
- Bookmark dividers re-implemented as a pseudo-element line that hides on hover (no double border with the hover ring).
- Search widget removed its bottom divider; status widget "duplicate URLs" relabeled to **Duplicate bookmarks**.
- First-install default simplified to a single column containing the Bookmarks bar plus the Search widget.
- Container drag handlers attached once at boot rather than re-attached on every render.

### Fixed
- Drop at last position in a folder now correctly appends instead of landing one slot before the end.
- Cross-column folder-pill drag and cross-column bookmark drag both work reliably.
- Column reorder no longer leaves a doubled-up resize handle next to the previous column.
- Globe drag-image icon suppressed via empty `dataTransfer` payload.
- Sidebar icon no longer keeps focus after closing via Esc.
- `+ Add column` button anchors correctly so a dragged column cannot slip past it.
- Drop indicator no longer flickers when the cursor passes the midpoint of a sibling.

## [1.0.1] — 2026-04-17

### Changed
- Sidebar color and type size adjustments.

## [1.0.0] — 2026-04-16

### Added
- Initial release: bookmark folders rendered as resizable columns on the new tab page, with theme switching, favicon caching, and per-folder collapsible subfolders.
