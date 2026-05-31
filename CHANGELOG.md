# Changelog

All notable changes to Ferd are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- 25 new shipped catalog entries.

### Changed
- Importing places from the catalog confirms only when adding 10 or more at once; smaller selections import without a prompt.

## [1.2.0] - 2026-05-31

### Added
- 117 new shipped catalog entries.
- Grid, Compact, and Gallery views for the Places and Routes lists, saved per list. Route thumbnails draw the GPX track shape.
- A History page (own tab) of visited places and completed routes by year, filterable, with compact and gallery layouts.
- Installed PWAs open into the last-known map, read-only, when the server is unreachable instead of dead-ending at sign-in.
- Local-only mode runs with no server or account, all on-device. Back up or move a map as a zip from Settings.
- An on-device activity log for local mode (Menu > Logs).
- The Add modal's Browse tab works offline from the bundled catalog in local mode; curating stays server-only.
- Per-device toggles in Settings > General to show or hide History, Catalog, and Logs.

### Changed
- History moved from the Menu to a top-nav tab beside Places and Routes.
- On narrow screens the Places, Routes, and History tabs collapse into the Menu.
- The Add button moved off the map and out of the list search rows into the top nav.
- The Places and Routes item count moved into the search box and updates live.
- The History search box shows the same live match count as the lists.
- The "Ferd" wordmark dropped its route-detail back arrow, so it stays put on every page.
- "Add all" when adding to the catalog is now a Select all / Deselect all toggle.
- Destructive and bulk actions confirm with the in-app dialog instead of a browser prompt.
- Tidied the category/region managers and admin Catalog setting with shorter warnings and simpler labels.

### Removed
- The "Add button" show/hide toggle in Settings > Appearance, now that Add lives in the nav.

### Fixed
- Top-bar controls and tabs now sit vertically centered.
- On mobile the breadcrumb shows the page name instead of collapsing to "Ferd / ..".
- Long-pressing a card on touch no longer selects its text.
- A History card's date and rating share a baseline, so the stars no longer sit low.
- The remove (×) button on category and region rows is drawn in CSS, centering the same on every OS.
- Filters dropdowns use the themed list on desktop, with the dimension-name default hidden (reset with "Clear filters").
- The account menu and the filter/View popovers no longer stay open at once.
- Opening a place from the list lands the map on the pin without flashing the previous location.
- Settings feature pills respond to the modal width, not a fixed window width.
- "Pick on map" no longer clears the other place fields.
- Modal dropdowns (category, region, settings) are fully themed, including the open list on desktop.
- Settings pill groups no longer leave a lone full-width pill when they wrap.
- About shows the app version in local-only mode instead of "unknown".

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
