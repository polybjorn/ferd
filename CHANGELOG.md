# Changelog

All notable changes to Ferd are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Place cards show an "unlinked" marker (replacing the catalog book icon) when an imported place's catalog entry has been removed from the catalog, so a dead catalog link is visually distinct from a live one. Renamed entries re-link instead of orphaning, so this only appears for genuine removals.
- Place schema: optional `image_focus` field controls the popup image's crop anchor (`top`, `bottom`, `left`, `right`, `center`, or `"X% Y%"`). Lets portrait photos render in the landscape popup frame without the meaningful subject getting cropped out. Flows through the catalog: catalog entries can set it, the "Update from catalog" diff tracks it, and the server clears it automatically when `image` changes so it always tracks a specific photo.
- Catalog test: optional fields cannot be present with empty values (e.g. `"image": ""`). Omit the field instead.
- Shipped catalog: `local_name` reverted to native script across 40 entries (Iran, Russia, Greece, Morocco). Romanizations like `Takht-e Jamshid` provided no signal to readers who don't know the language while obscuring the actual name for those who do; native script (`تخت جمشید`) is more useful to both audiences. Latin-script languages (German, Italian, French, Spanish, Turkish) were already native and are unchanged.
- Shipped catalog: 104 new entries.
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
- Manage regions modal no longer shows a per-region route count, matching Manage categories. Empty regions still read "empty" and a row being renamed reads "edited".
- Status colors are now a fixed, balanced red/green pair across all themes (planned/want `#d23f3f`, visited/completed `#2ea043`), instead of inheriting each theme's palette red/green (which read pinkish and pastel in Nord). Applies to status dots, filter chips, route lines, and place popups; danger/error keep `--red` and success keeps `--green`.
- Map filter panel redesigned. Places and Routes are now a single accordion tab row pinned at the panel bottom (opening one collapses the other, list expands upward with a height + fade animation, so the tab row itself never moves on click), and the collapsed panel is two rows instead of three. The status filters (Visited/Planned for places, Completed/Planned for routes) plus "Toggle all" sit in one persistent footer below the lists, as boxed chips with a green (done) or red-outlined (planned) dot; switching tabs only swaps the leading chip's label (Visited<->Completed) without the row moving. The place status filter "Want" is renamed "Planned". Categories and chips read white with a full-color dot when on, grey with a faded dot when off. The tab open/close indicator is a thin stroke chevron matching the app's other icons (was a filled triangle). Search box placeholder simplified to "Search...".
- "Native name" relabeled to "Local name" everywhere in the UI (edit and add modals, settings field-toggle, popups) to match the underlying `local_name` field. The per-browser "show local name" toggle key migrates from `show-native-name` to `show-local-name` on first load; the old key is removed.
- Settings > Optional fields toggles now apply to display, not just Add/Edit forms. Turning off Image, Local name, Note, Date, or Rating hides that field in place cards, map popups, and the route detail page as well. The toggle takes effect immediately; map and list views refresh in place without a page reload.
- Places list groups (by category, country, or letter) now list items alphabetically within each group instead of in insertion order. The chosen grouping is persisted across page reloads.
- Routes list now lists routes alphabetically within each region (or letter). The chosen grouping is persisted across page reloads.
- Routes list re-renders on filter changes instead of hiding cards with CSS. Empty groups disappear from the list rather than collapsing to zero height.
- Shipped catalog: non-Latin `local_name` values switched from native script to Latin transliteration (Iran, Russia, Greece) so labels are readable to Latin-alphabet users. Two Iran entries renamed to English: Arg-e Bam -> Bam Citadel, Gonbad-e Qabus -> Qabus Tower. The seven entries whose romanization equaled `name` (Ali Qapu, Chefchaouen, Chogha Zanbil, Fes el-Bali, Fira, Ribat-i Sharaf, Skaros) now have `local_name` omitted entirely instead of keeping the native script.
- Catalog mark on place cards: open-book icon (was bookmark), with an accent dot in the corner to mark "update available" (replacing the previous color-swap behavior).
- Accepting a catalog update no longer triggers a full list re-render; only the affected card updates in place.
- "Add place" / "Add route" relabeled to "Add" so the button doesn't change width when switching tabs.
- Filter popover "Clear filters" restyled as an accent-colored outline button.
- Map popups for places and routes: removed the inline "Edit" link and the top-right copy-link icon (both now reachable via right-click). Top-right is now a "go to source" arrow that opens the entry's first source URL. The separate source line in the popup body is gone.
- Local name in popups aligns to the right of the title on a single line and wraps to a separate left-aligned line when it doesn't fit. Middot separator removed.
- Right-click context menus rendered with a tighter minimum width.
- Catalog update modal: strikethrough on a diff row now appears only when the field is checked (about to be replaced). Unchecked rows show both values without strikethrough, with the catalog value dimmed. The previous behavior struck whichever value "wouldn't survive" the action, which inverted the visual when toggling.
- Category color palette: boosted saturation for higher contrast against dark surfaces. Hues are preserved, so existing per-category color assignments look the same as before, just denser.
- Manage categories rows: removed the always-on "N places" tag. The "edited" indicator is now a small chip inside the name input and hides while you're typing.
- Manage categories and Manage regions modals now cap at viewport height; the row list scrolls internally and the scrollbar anchors to the modal's right edge.

### Fixed
- Editing a place from the list (e.g. toggling visited) no longer flashes the whole list. The affected card is patched in place (status dot, note, catalog badge, group count); a full re-render happens only when the edit moves the card between groups or in/out of an active filter (name/category/country change, or a status filter).
- Editing a place or route while one of its optional fields is hidden (Settings > Optional fields) no longer wipes that field's stored value on save. The hidden field has no form input, so the read came back empty and overwrote the stored value; the stored value is now carried over. For catalog-linked places this also stops a phantom "Update from catalog" offering to restore the value the edit had just erased. `image_focus` (which has no form input at all) is likewise preserved across edits unless the image itself changes.
- Deleting one of several places that share a name no longer leaves the other card unresponsive (its right-click menu, Edit, and Delete silently doing nothing) until a page reload. The deletion renumbers the survivors' slugs, and the surgical card removal left their DOM slugs stale; the stale slugs are now patched in place (keyed by place id), so the card stays responsive without re-rendering the list.
- Clicking a place in the list (or a search result) now centers the map on that pin, even when "remember last view" is on. Previously a remembered view suppressed the centering, leaving the pin off-screen; the preserve-view behavior now applies only to page reloads, not in-app navigation.
- Admin catalog edits (add/remove/hide an entry, toggle the shipped baseline) now refresh the places list's catalog badges and orphan markers live, instead of leaving them stale until a page reload.
- Adding places to the local catalog now skips duplicates by primary source URL as well as by name, matching how imports are linked, so the same place can't be added twice under different names.
- Applying a catalog update that changes the place's name now refreshes the list (name and update badge), instead of leaving the old card untouched because the surgical in-place update keyed on a slug the rename had already changed.
- Catalog imports stay linked when a catalog entry is renamed. The link now falls back from the stored name to matching the catalog entry's primary source URL (which is stable across renames), so a rename surfaces as an applicable "name changed" update instead of orphaning the import and offering the renamed entry as a duplicate. Sourceless entries keep name-only matching.
- Toggling a visible feature (Places/Routes) off in Settings now also drops its tab from the map filter panel, instead of leaving a dead tab behind; re-enabling adds it back.
- Backup replace-import no longer fails with "Cannot call rmtree on a symbolic link" when the user's GPX directory is a symlink; the link is replaced rather than its target deleted.
- Places and routes list filter selections no longer reset when the list re-renders (e.g. after accepting a catalog update).
- Right-click context menu and catalog-mark click on place cards now resolve the correct entry when multiple places share a name (looked up by slug instead of name).
- Clicking a place card in the list now opens the correct entry when multiple places share a name. The card link and the map's focus lookup both go through the slug instead of falling back to the first name match.
- Places list now refreshes immediately after a place is deleted, edited, or saved, instead of waiting for a page reload.
- Deleting a place from the list animates the card collapsing to zero height; remaining cards flow up smoothly instead of the whole list flashing as it re-renders.
- Backup import now silently skips archiver junk entries (`__MACOSX/`, `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.bak`, `*~`) instead of rejecting the whole zip. Zips made by macOS Finder, Windows Explorer, and editor backups now import without manual cleanup.
- Install docs: python.md LAN-bind port corrected from 8090 to 8091.
- PWA "Reload" button is no longer a no-op when the waiting service worker reference goes stale. The handler re-resolves the worker at click time and falls back to a plain page reload after 2 seconds if the worker never takes over.
- Places and Routes list "Clear filters" no longer re-renders the list when no filters are active. The button is now a no-op in that state instead of causing a visible blink. It also clears the search input now, not just the filter dropdowns.
- Places list: applying the last catalog update inside a group now fades the empty group header out alongside the card. Previously the header (with its `(0/N)` count) stayed visible until the next full re-render.
- Map popup now refreshes in place after editing a place or applying a catalog update. Previously the popup kept showing the old image / note / fields until manually closed and reopened.
- `image_focus` was silently dropped by `validate_place` (left out of the normalized output it builds). PUT /places looked successful but the field never landed on disk, so catalog updates that only touched `image_focus` kept showing "Update available" forever. Now preserved; whitespace-only / empty values are stripped as a no-op instead of erroring.
- Places and Routes list empty state ("No matches") now spans both columns of the index grid instead of being trapped in one column of the CSS multi-column layout, which made it look off-center.

### Security
- API handlers that touch the filesystem now verify the resolved path stays under the expected directory. The static handler also catches symlink escapes that the prior lexical check could not see.
- GPX uploads reject DOCTYPE and entity declarations, blocking XML-bomb expansion (uploads remain admin-only).
- Place and route list rows escape backslashes when building inline click handlers.
- The tests workflow runs with explicit read-only token permissions.

## [1.0.0] - 2026-05-25

Initial release. Ferd is a self-hosted Leaflet map for travel places and GPX routes: a single-file static frontend served alongside a stdlib-only Python API. Per-user data isolation, in-browser editing, optional public read-only sharing at `/u/<username>/`, themed UI, and zip import/export. Two install paths: bare-metal (systemd / launchd + reverse proxy) or Docker Compose.
