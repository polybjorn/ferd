# Changelog

All notable changes to Ferd are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Shipped catalog: 54 new entries.
- `GET /api/health` for liveness checks; returns `{status: "ok", version}`.
- Install docs and installer output now point at the source clone as the place to re-run `install.sh` from on updates.
- Places list: new "Group by first letter" filter option. Letter buckets follow the browser's locale collation, so each user sees their own alphabetical order; non-Latin scripts get their own buckets; digit/punctuation starts go in "#".
- Routes list: new "Group by first letter" filter option, alongside the existing region grouping. Same locale-aware ordering as places.
- Right-click (or long-press on touch) a place or route card to open a context menu with Open on map, Edit, Open source (when present), Apply catalog update (places only, when applicable), and Delete.
- Catalog update modal: pick per-field which catalog values to apply (Apply), or dismiss the diff so the entry stops showing as Update available (Keep all). Skipped fields reappear only if the catalog later moves to a new value.
- Right-click (or long-press on touch) a place pin or route on the home map opens a context menu with Open, Go to source, Edit, Apply catalog update (places, when applicable), Copy link, and Delete. Mirrors the list-view right-click menu.
- Manage categories: drag rows up or down to reorder; the order persists. "Reset colors" now assigns palette indices in the displayed order, so reordering lets you pick which category gets which color.
- Places list (Group by category): each section header is prefixed with a small dot in the category's palette color.

### Changed
- Places list groups (by category, country, or letter) now list items alphabetically within each group instead of in insertion order. The chosen grouping is persisted across page reloads.
- Routes list now lists routes alphabetically within each region (or letter). The chosen grouping is persisted across page reloads.
- Routes list re-renders on filter changes instead of hiding cards with CSS. Empty groups disappear from the list rather than collapsing to zero height.
- Shipped catalog: non-Latin `local_name` values switched from native script to Latin transliteration (Iran, Russia, Greece) so labels are readable to Latin-alphabet users. Two Iran entries renamed to English: Arg-e Bam -> Bam Citadel, Gonbad-e Qabus -> Qabus Tower. The seven entries whose romanization equaled `name` (Ali Qapu, Chefchaouen, Chogha Zanbil, Fes el-Bali, Fira, Ribat-i Sharaf, Skaros) now have `local_name` omitted entirely instead of keeping the native script.
- Catalog mark on place cards: open-book icon (was bookmark), with an accent dot in the corner to mark "update available" (replacing the previous color-swap behavior).
- Accepting a catalog update no longer triggers a full list re-render; only the affected card updates in place.
- "Add place" / "Add route" relabeled to "Add" so the button doesn't change width when switching tabs.
- Filter popover "Clear filters" restyled as an accent-colored outline button.
- Map popups for places and routes: removed the inline "Edit" link and the top-right copy-link icon (both now reachable via right-click). Top-right is now a "go to source" arrow that opens the entry's first source URL. The separate source line in the popup body is gone.
- Native name in popups aligns to the right of the title on a single line and wraps to a separate left-aligned line when it doesn't fit. Middot separator removed.
- Right-click context menus rendered with a tighter minimum width.
- Catalog update modal: strikethrough on a diff row now appears only when the field is checked (about to be replaced). Unchecked rows show both values without strikethrough, with the catalog value dimmed. The previous behavior struck whichever value "wouldn't survive" the action, which inverted the visual when toggling.
- Category color palette: boosted saturation for higher contrast against dark surfaces. Hues are preserved, so existing per-category color assignments look the same as before, just denser.
- Manage categories rows: removed the always-on "N places" tag. The "edited" indicator is now a small chip inside the name input and hides while you're typing.
- Manage categories and Manage regions modals now cap at viewport height; the row list scrolls internally and the scrollbar anchors to the modal's right edge.

### Fixed
- Places and routes list filter selections no longer reset when the list re-renders (e.g. after accepting a catalog update).
- Right-click context menu and catalog-mark click on place cards now resolve the correct entry when multiple places share a name (looked up by slug instead of name).
- Places list now refreshes immediately after a place is deleted, edited, or saved, instead of waiting for a page reload.
- Backup import now silently skips archiver junk entries (`__MACOSX/`, `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.bak`, `*~`) instead of rejecting the whole zip. Zips made by macOS Finder, Windows Explorer, and editor backups now import without manual cleanup.
- Install docs: python.md LAN-bind port corrected from 8090 to 8091.
- PWA "Reload" button is no longer a no-op when the waiting service worker reference goes stale. The handler re-resolves the worker at click time and falls back to a plain page reload after 2 seconds if the worker never takes over.
- Places and Routes list "Clear filters" no longer re-renders the list when no filters are active. The button is now a no-op in that state instead of causing a visible blink. It also clears the search input now, not just the filter dropdowns.
- Places list: applying the last catalog update inside a group now fades the empty group header out alongside the card. Previously the header (with its `(0/N)` count) stayed visible until the next full re-render.

### Security
- API handlers that touch the filesystem now verify the resolved path stays under the expected directory. The static handler also catches symlink escapes that the prior lexical check could not see.
- GPX uploads reject DOCTYPE and entity declarations, blocking XML-bomb expansion (uploads remain admin-only).
- Place and route list rows escape backslashes when building inline click handlers.
- The tests workflow runs with explicit read-only token permissions.

## [1.0.0] - 2026-05-25

Initial release. Ferd is a self-hosted Leaflet map for travel places and GPX routes: a single-file static frontend served alongside a stdlib-only Python API. Per-user data isolation, in-browser editing, optional public read-only sharing at `/u/<username>/`, themed UI, and zip import/export. Two install paths: bare-metal (systemd / launchd + reverse proxy) or Docker Compose.
