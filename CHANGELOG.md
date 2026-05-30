# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

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
