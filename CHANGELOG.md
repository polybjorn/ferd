# Changelog

All notable changes to Ferd are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Shipped catalog: 117 new entries.
- Places and Routes lists: a View popover (next to Filters) switches between Grid (the multi-column cards, default), Compact (single column with a small left thumbnail), and Gallery (single column with large media on top). Compact and Gallery cap their width and center like the History page. Places show the place image; routes draw the GPX track-shape silhouette. The choice is saved per list and syncs across devices.
- History page: a chronological journal of visited places and completed routes, reachable from the History tab in the top nav (or the Menu on narrow screens). Entries are merged into one stream, newest first, grouped by year, showing the date, rating, note, and a thumbnail (the place photo, or a silhouette of the route's GPX track). Filter by text, type, year, and rating; switch between a compact layout and a gallery layout with larger images on top. Click an entry to open the place on the map or the route's detail, or right-click (long-press on touch) for the same context menu as the list cards.
- Offline read access: places, routes, and category data are cached on-device (IndexedDB) on each successful load and served when the server is unreachable, so an installed PWA opens into the last-known map (read-only) instead of dead-ending at the sign-in or server-picker screen. The offline banner signals read-only mode; the cache is namespaced per server and account.
- Local-only mode: a "Continue without signing in" option on the sign-in screen and server picker runs the app with no server and no account, storing places and routes entirely on-device (IndexedDB). GPX tracks are parsed and the route manifest built client-side. Back up or move a local map with the Export/Import zip in Settings (same format as the server, so a local map transfers to a server and back). Leave with "Connect to a server" in the menu; local and server data stay separate and switching never destroys either.
- Local mode activity log: Menu > Logs records on-device edits (adding, editing, deleting, completing, and moving places and routes; region changes; imports), newest first, and can be cleared. The local analogue of the server audit log.
- Local mode catalog: the Add modal's Browse tab now works in local mode, sourced from the bundled shipped catalog (catalog.json, precached for offline use). Browse and import catalog places into an on-device map, with the same "update available" detection when a new app version ships a changed catalog. Catalog curation stays server-only.
- Visible features: Settings > General gained per-device toggles to show or hide History, Catalog (the Add modal's Browse tab), and Logs. Each appears only when reachable (History needs Places or Routes; Catalog needs Places; Logs needs admin or local mode). Logs defaults to hidden.

### Changed
- History is now a top-nav tab alongside Places and Routes (it was a Menu item).
- Narrow screens: the Places/Routes/History nav tabs move into the Menu as their own section (just below the account header), freeing space in the top bar.
- History: the search box now shows a live count of matching entries, matching the Places and Routes lists.
- The index map's Add button moved from a floating button on the map into the top nav, just left of the Menu button.
- The "Ferd" brand no longer shows a back arrow on the route detail page, so it sits in the same position on every page (it still links home).
- Places and Routes lists: the Add button moved from the search row into the top nav, just left of the Menu button, leaving the search row to the filter input and Filters popover.
- Places and Routes lists: the item count moved from the nav tab into the search box, where it updates live to the matching count as you type or apply filters.
- Add to catalog: the "Add all" button is now a "Select all" / "Deselect all" toggle that ticks the visible entries, so you confirm with "Add selected" rather than adding everything in one click.
- Destructive and bulk actions now use the in-app confirm dialog with action-specific wording instead of a native browser prompt (or, where there was none, a new prompt): server import "Replace all", "Sign out others", saving the category manager when a removed category is still in use, and bulk-adding entries to the catalog or to your map.
- Tightened the category/region managers and the admin Catalog setting: the in-use warning text is shorter, "Reset colors" sits at the left of the manager footer, and the shipped-catalog toggle label dropped "baseline".

### Removed
- Settings > Appearance > On-map controls: the "Add button" show/hide toggle. The map's Add action now lives in the top nav, always available to editors.

### Fixed
- Mobile nav breadcrumb: shows the current page name (Places, Routes, History, or the route name on detail) instead of collapsing to "Ferd / ..", truncating with an ellipsis only when it would reach the Add button. On desktop the list-page crumb is dropped (the active tab already indicates the page); route detail still shows the route name.
- Long-pressing a place, route, or History card on a touch device no longer selects/highlights the card text before the context menu opens.
- History cards: the date and rating on the meta line now align on the same baseline (the stars no longer sit lower than the date in some mobile fonts).
- The remove (×) button on category and region rows draws its X with CSS instead of a font character, so it centers consistently across operating systems (it sat off-center in some mobile system fonts).
- The Filters dropdowns on the Places, Routes, and History lists now use the themed option list (matching Settings) instead of the browser's native popup on desktop. The dimension's default option (which labels the closed dropdown, e.g. "Type") is hidden from the open list so only real values are offered; reset a single filter via "Clear filters".
- The account menu and the list/History filter (and View) popovers are now mutually exclusive: opening one closes any other that was open, instead of leaving two overlapping.
- Opening a place from the list now lands the map directly on the pin instead of briefly showing the previous location and then panning to the new one.
- Settings > General feature pills no longer snap to a rigid 2-column grid at an arbitrary window width. The layout now responds to the modal's own width (container query), keeping the flexible row until the modal itself is narrow, then dropping to two columns - matching how it already looked on mobile.
- Adding a place: clicking "Pick on map" no longer clears the name, category, and other entered fields. The form now keeps its contents across the map pick.
- Modal dropdowns (category, region, settings) are now fully themed. The closed control matches the surrounding inputs instead of the browser's lighter native fill, and on desktop the open option list renders in the active theme rather than the OS-native popup (which CSS can't restyle). Keyboard navigation and type-ahead are preserved; touch devices keep the native full-screen picker.
- Settings pill groups no longer leave a lone pill stretched across the full width when they wrap on narrow screens. Visible features lays out in an even two-column grid; the five Optional fields pills fit on one row at the modal's width and fall to a filled 3/2 (not a 4/1 wrap) when narrow.
- About: shows the app version in local-only mode instead of "unknown". The version is baked into the served page, so it no longer depends on a server `/api/state` response.

## [1.1.0] - 2026-05-29

### Added
- Shipped catalog: 104 new entries.
- Configurable server target: clients that bundle the frontend (native/WebView) show a server-picker to enter the Ferd address and authenticate with a bearer token (`{"token": true}` on login returns the token in the body instead of a cookie). Browser/PWA cookie auth is unchanged.
- CORS support via the new `cors_origins` config key (default `"*"`); cross-origin clients use bearer tokens, never cookies.
- Bearer-token API auth: mint named tokens (full or read-only, with an expiry) under Settings > Security and use `Authorization: Bearer <token>`. New endpoints `GET`/`POST /api/me/tokens` and `POST /api/me/tokens/revoke`.
- Place cards show an "unlinked" marker when an imported place's catalog entry was removed (renames re-link instead of orphaning).
- Place schema: optional `image_focus` field sets the popup image's crop anchor so portrait photos aren't badly cropped; flows through the catalog and clears when `image` changes.
- Catalog test: optional fields can't be present with empty values; omit them instead.
- `GET /api/health` liveness endpoint; returns `{status, version}`.
- Install docs and installer point at the source clone for re-running `install.sh` on updates.
- Places list: "Group by first letter" option, with locale-aware bucketing.
- Routes list: "Group by first letter" option alongside region grouping.
- Right-click (or long-press) a place or route card for a context menu: Open on map, Edit, Open source, Apply catalog update, Delete.
- Catalog update modal: choose per-field which values to apply, or dismiss the diff so it stops showing as Update available.
- Right-click (or long-press) a place pin or route on the map for the same context menu as the list.
- Manage categories: drag to reorder (persisted); "Reset colors" assigns palette colors in display order.
- Places list (Group by category): section headers show a dot in the category color.

### Changed
- All user-facing settings now sync per-user across devices, not just theme: map toggles, tile layer, units, local-name display, and grouping follow you to a new browser or install. Per-device state (last view, feature hiding) stays local.
- Active sessions moved to a new Settings > Security tab, alongside API tokens.
- Settings pickers restyled: single-select groups render as a segmented bar, multi-select as equal-width cells.
- Manage regions modal drops the per-region route count, matching Manage categories.
- Status colors are now a fixed red/green pair across all themes (was each theme's palette red/green), for status dots, filter chips, route lines, and popups.
- Map filter panel redesigned: Places/Routes as a bottom accordion (two rows collapsed), status filters in a persistent footer, "Want" renamed "Planned", and a stroke chevron indicator.
- "Native name" relabeled "Local name" throughout to match the `local_name` field; the `show-native-name` toggle key migrates to `show-local-name`.
- Settings > Optional fields toggles now also hide fields in cards, popups, and route detail (not just the Add/Edit forms), applied without a reload.
- Places list groups sort items alphabetically within each group; grouping persists across reloads.
- Routes list sorts alphabetically within each region/letter; grouping persists across reloads.
- Routes list re-renders on filter changes (empty groups disappear) instead of CSS-hiding cards.
- Shipped catalog: two entries renamed to English (Arg-e Bam -> Bam Citadel, Gonbad-e Qabus -> Qabus Tower).
- Catalog mark on place cards is now an open-book icon with an accent dot for "update available".
- Accepting a catalog update updates only the affected card, not the whole list.
- "Add place" / "Add route" relabeled "Add" so the button width is stable across tabs.
- Filter popover "Clear filters" restyled as an accent outline button.
- Map popups: removed the inline Edit link and copy-link icon (now via right-click); the top-right is a "go to source" arrow.
- Local name in popups aligns right of the title and wraps to its own line when it doesn't fit.
- Right-click context menus use a tighter minimum width.
- Catalog update modal: a diff row is struck through only when checked (about to be replaced); unchecked rows show both values with the catalog value dimmed.
- Category color palette: higher saturation for contrast on dark surfaces; hues unchanged, so existing assignments look the same.
- Manage categories rows drop the "N places" tag; the "edited" indicator is a chip inside the name input.
- Manage categories and Manage regions modals cap at viewport height with the row list scrolling internally.

### Fixed
- Map no longer opens zoomed out with empty bands above/below the world on tall screens; minimum zoom now fills the viewport (recomputed on resize).
- Editing a place from the list no longer flashes the whole list; the card is patched in place unless the edit moves it between groups or filters.
- Editing a place or route with a hidden optional field no longer wipes that field's value on save (and stops a phantom catalog "update"); `image_focus` is likewise preserved unless the image changes.
- Deleting one of several same-named places no longer leaves the others' menu/Edit/Delete dead until reload (stale slugs are patched in place).
- Clicking a place in the list or search now centers the map on its pin even with "remember last view" on (preserve-view now applies only to reloads).
- Admin catalog edits now refresh the list's catalog badges and orphan markers live, not on next reload.
- Adding to the local catalog skips duplicates by source URL as well as name.
- Applying a catalog update that renames the place now refreshes the list instead of leaving the old card.
- Catalog imports stay linked when a catalog entry is renamed (matched by source URL), surfacing a "name changed" update instead of orphaning.
- Toggling a feature (Places/Routes) off now also drops its tab from the map filter panel.
- Backup replace-import no longer fails when the GPX directory is a symlink.
- List filter selections no longer reset when the list re-renders.
- Right-click menu and catalog-mark click on cards resolve the correct entry when places share a name (by slug).
- Clicking a card opens the correct entry when places share a name (by slug).
- Places list refreshes immediately after a place is deleted, edited, or saved.
- Deleting a place animates the card collapsing; remaining cards flow up instead of the list flashing.
- Backup import skips archiver junk (`__MACOSX/`, `.DS_Store`, etc.) instead of rejecting the whole zip.
- Install docs: python.md LAN-bind port corrected from 8090 to 8091.
- PWA "Reload" button no longer no-ops on a stale waiting-worker reference; it re-resolves the worker and falls back to a plain reload.
- "Clear filters" is a no-op when no filters are active (no blink) and now also clears the search input.
- Applying the last catalog update in a group fades the empty group header out with the card.
- Map popup refreshes in place after an edit or catalog update instead of showing stale content until reopened.
- `image_focus` is no longer dropped by `validate_place`, so catalog updates touching only it persist instead of showing "Update available" forever.
- List empty state ("No matches") spans the full width instead of being trapped in one column.

### Security
- Session and API tokens are stored as SHA-256 hashes, not plaintext, so a database read can't be replayed as a credential. Existing sessions are invalidated on upgrade (one re-login).
- Filesystem handlers verify the resolved path stays under the expected directory, catching symlink escapes the prior lexical check missed.
- GPX uploads reject DOCTYPE and entity declarations, blocking XML-bomb expansion.
- Place and route list rows escape backslashes in inline click handlers.
- The tests workflow runs with read-only token permissions.

## [1.0.0] - 2026-05-25

Initial release. Ferd is a self-hosted Leaflet map for travel places and GPX routes: a single-file static frontend served alongside a stdlib-only Python API. Per-user data isolation, in-browser editing, optional public read-only sharing at `/u/<username>/`, themed UI, and zip import/export. Two install paths: bare-metal (systemd / launchd + reverse proxy) or Docker Compose.
