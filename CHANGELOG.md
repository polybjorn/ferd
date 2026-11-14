# Changelog

All notable changes to Ferd are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-11-14

2.0 keeps a copy of your map on the device and syncs it in the background, adds areas, a language setting with a Norwegian interface, and on a phone a layout built around a bar along the bottom of the screen. **Upgrading from 1.x:** 2.0 does not read the data 1.x kept on the server or on the device. Before updating, open 1.x online so any queued edits sync, then export a zip from it and import that zip into 2.0. See Storage and sync under Changed.

### Added
- Areas. Add a park, county or other boundary with Add > Area, by searching OpenStreetMap by name or from a GeoJSON file. A search fills in the English name, keeps the local one beside it and sets the category from a common boundary type such as city or county, or from one of your own that matches, and the map credits OpenStreetMap while such an area shows, as it does for a file that states an OpenStreetMap licence. An area shows on the map as a polygon in its category colour, filled when visited and dashed when on the wishlist. It counts as visited when you tick it, or when a place inside is visited or a route inside is completed. Files with many points are simplified on save. Areas follow the category and visit filters, appear in search, public maps and data exports, and work offline and in local-only mode.
- An area's popup shows how many places and routes it holds, and how many of those are visited or completed. Opening a count lists them, and picking one goes to it on the map. A route counts when any part of its track is inside.
- A language setting under Settings > General. It starts from the browser's language and falls back to English, syncs to your account, and applies at once without a reload. Numbers group in that language's style (7 340,9 in Norwegian) and lists sort in its alphabetical order. Norwegian bokmål is offered with the whole interface translated. What you entered yourself, such as names, notes and categories, and catalog entries keep their own wording, and dates show as 2026-11-08 in every language.
- Visited countries. Turn on Settings > Visible features > Visited countries to shade every country that holds a visited place. It is off by default and set per browser, and the outlines (about 650 KB) download only once it is on, then stay cached for offline use. The shading shows at zoom 6 and further out, and fades as you zoom past that. Borders are Natural Earth's de facto lines. A note under the switch says it shows when zoomed out.
- Map overlays. `site-config.json` can list XYZ or WMS layers, such as topo maps or hillshade, to draw over the base map. Each shows in the layer picker as an opacity slider, starts at 0 (off) on every load so no third-party host is contacted until you drag it up, and keeps tiles offline only when its entry sets `offline: true`, for providers whose terms allow it. The picker's base map options use the app's theme.
- GeoJSON export of places, areas and routes, from Account in the menu, at `/api/me/export.geojson` when signed in and at `/api/u/<username>/export.geojson` for a public map, so QGIS and other map tools can load a Ferd map from a URL. Routes keep their full track and elevation, and no GPX timestamps or author names are included.
- Link previews and opt-in search indexing. Every page now carries a canonical link and an image for link previews, built from the address the instance is reached at, so a shared link to a published map shows a preview, titled with the map owner's name as stored. A `/u/` link to a name that does not exist or has not published previews as the front page, so the address cannot put its own text in a preview. The API serves `/robots.txt`, which keeps search engines out by default; set `FERD_SEARCH_INDEXING=1` (or `search_indexing` in `tools/config.json`) to let them in, which also serves `/sitemap.xml` listing the front page and the published maps. Behind nginx or Caddy, proxy `/`, `/u/`, `/robots.txt` and `/sitemap.xml` to the API as the updated examples in `deploy/` do.
- The Country field on the place forms is now a searchable list, so a name always matches. It finds common alternatives too, such as Norge or USA. An older place keeps its existing name until you change it.
- Places carry a `country_code` (ISO 3166-1 alpha-2) that the server sets from the Country field on every save. Existing places get one when the server starts.
- A place's popup has an Edit button, so editing no longer depends on finding the right-click or long-press menu. It shows when you're signed in, and never on a public map.
- A Skip to content link, the first stop when moving through the page with Tab. Screen readers now find the page's main area as a landmark and the sign-in page's name as its heading, search results show a short description of Ferd, and a published map's browser tab carries its owner's name.
- Sync endpoints `GET /api/sync/changes` and `POST /api/sync/batch` for a client that keeps its own copy: items carry a per-user revision, deletions are kept as tombstones, and a batch of changes applies all or nothing with last-writer-wins per item. See [docs/api.md](docs/api.md#sync).
- `HEAD` requests for static files, so `curl -I` shows their headers.

### Changed

#### Storage and sync
- Places, areas, route metadata, preferences and category labels are stored in `app.db`, one row per item, instead of JSON files. 2.0 does not read the JSON files 1.x kept them in, so an account upgraded in place opens empty: export a zip from 1.x before updating and import it into 2.0. The zip format is unchanged, and going back to 1.x works the same way in reverse. Back up `app.db` with SQLite's `.backup` or with the service stopped.
- The app keeps one copy of your map on the device and works from it, with or without a server. Edits show at once and sync in the background through the new sync endpoints, offline edits included, and a start reads the device copy first, so the map opens without waiting on the network once it has synced. Local-only mode is the same app with no server configured. Data saved on the device by 1.x is not carried over, so open 1.x online before updating to let its queued edits sync, and in local-only mode export from 1.x and import into 2.0. A change the server keeps failing, such as an upload while its disk is full, stays queued under a banner with Retry and Discard, and only changes to the same routes wait behind it. An upload the server refuses is kept on the device, named in the sync notice and listed under the banner to save as GPX.

#### Phone layout
- A bar along the bottom of the screen holds Map, Lists, Search, Add and You, with a pill behind the current item's icon. It slides away when you pan or zoom the map or tap an empty spot on it, and stays away until you tap the map again, so the map you are looking at fills the screen; on a list it hides while you scroll down and comes back when you scroll up. The top bar is gone: a route's page shows the route's name in a label over the map, with a Back button beside it and Edit on the right. Lists has a tab each for Places, Routes and Areas and opens on the last one used on this device; a list turned off in Settings loses its tab, and with one left there are no tabs. Areas lists every area by category with how many places and routes it holds, and tapping one shows it on the map. Add opens the form for the list on screen, or every kind from the map and You, and shows only for someone who can edit. You shows who is signed in, with History below and a gear for Settings, Account, Admin, Logs, About and Sign out; on a shared map it offers Sign in and About instead. A dot on You and on the gear shows while catalog updates wait for review. Lists, Add and Search go when Places and Routes are both off.
- The map's search and filters replace the panel at the bottom. Search in the bottom bar opens the same search for places, areas and routes from every tab, also with the S key on the map, and picking a result shows it on the map. It drops from the top of the screen and is only as tall as its results, so the map shows below it once the keyboard is down, and hiding the keyboard with nothing typed closes it. With the field empty it lists your last five picks on this device, which Clear or signing out removes, and results are grouped under Places, Areas and Routes. The filter field on Places, Routes and History still filters that list. A Filters button above the layer picker opens the map's filters in a sheet from the bottom of the screen, with Reset; drag the sheet down by its handle or title to close it. A dot on the Filters button shows while something is filtered out.
- Forms, Settings and the catalog lists fill the screen, and confirm dialogs and About rise from the bottom of the screen. Both stay above the on-screen keyboard.
- On a touch screen the map's zoom buttons start hidden, since a pinch zooms. Settings > Appearance > On-map controls > Zoom buttons brings them back on touch screens only, for zooming out with one finger.
- On a touch screen, menu entries, dialog tabs, the map's buttons, the rows of the layer picker, the filter controls, the Filters and View buttons on the list pages and search results are at least 48px tall, and a place popup's Edit link takes a tap anywhere around it in the footer.

#### Map
- On a wide screen the map runs to the top of the window, with the Places, Routes and History tabs, and Add and Menu floating over its top edge; the list pages keep a slimmer bar. Add and Menu are icons, a plus and three lines, named in a tooltip.
- The map's filters list each category or region as a row with how many it holds, in two columns where they fit, instead of chips, with Hide all and Show all in place of Toggle all. Status is one choice of All, Visited (Completed for routes) or Planned instead of two switches.
- Place marks and clusters sit on a white halo, so they stand out on every base map.
- Pins, routes and areas move with the map while it zooms in from a cluster tap, a double tap or the zoom buttons, and pins and routes keep their size through the zoom. The places inside a tapped cluster spread out from it as the map zooms in, and zooming out gathers them into their clusters, instead of popping in once the zoom ends.
- With no remembered view, a map holding only places, all at one spot, opens at zoom 12, the zoom a place click uses, instead of the deepest zoom.
- The map credit has no box on any theme, and the spacebar or a long-press hides it with the other map controls. On a phone it collapses to an (i) button after five seconds or on the first touch of the map, and tapping the button shows it again. On a wide screen a long credit wraps beside the search panel instead of lifting it. About lists every credit.
- The layers button opens on a click, not when the pointer passes over it on its way to Add or Menu. Dark comes last in the layer list and in Settings > Map.
- The OpenStreetMap and Dark base maps no longer keep tiles for offline use, since OpenStreetMap's tile policy does not permit it; the browser's normal cache still serves recently viewed tiles. OpenTopoMap still works offline. Tiles cached before this update are cleared once.
- The Android app identifies itself to tile servers as `Ferd/<version>` instead of the WebView default.

#### Pages, dialogs and forms
- Places, Routes, Areas and History stay as you left them when you switch to another page: coming back from another list, the map or a route's page finds the list at the same scroll position, with its pictures and route outlines in place and without the groups fading in again.
- The sign-in page drops the logo and takes less room on a phone, where the form starts at the top. While the keyboard is open, the page fits the part of the screen above it, so the Sign in button stays reachable. Continue without signing in is now a Local map button beside Sign in, and in the Android app, Change server is a link beside the server address under them. The heading over the form is left out when the Sign in and Register tabs show. The sign-in and server picker pages use the same form styles as the dialogs, with the server picker's hint under its address field, and the Android app's server picker has the same layout.
- The menu has Account and, for admins, Admin beside Settings. Account holds the Account and Security tabs that were in Settings, Admin holds the server's settings, and the tabs take the place of the dialog's title. The menu, the dialog tabs and the close button are larger, with a wider gap above Sign out.
- Dialogs keep their title and buttons in view while the rest scrolls. Add, Settings and the catalog lists are only as tall as their content, up to the height of the screen, and keep their top edge in place, so switching a tab moves neither the tabs nor the filter box. Switching tabs on the Add form is instant.
- Forms share one layout: labels above their controls, switches at the right of their row, flipped by a tap anywhere on it, and Pick on map, Change password and Create token at the left. Required fields carry an asterisk instead of the rest being labelled optional. Name fields no longer show example names, and the local name field says what goes in it.
- Buttons, fields, chips, tabs and badges share one look from ui-foundation. Dialog buttons have slightly larger, darker text and take the theme's accent the same way everywhere. The filter boxes, the region name, new category and new token fields are as tall as the other form controls, and the note and sources boxes open three lines tall. A chip that is on is filled with the accent colour, and the main tabs and dialog tabs are underlined and scroll sideways on a narrow screen instead of wrapping. Category colour dots are round again, the This device label is a rounded pill in the theme's green, and a long username in the admin list keeps its Public badge in view.
- Banners are white cards with a warning edge instead of a yellow bar, and toasts clear the phone's bottom bar and a rounded screen corner. On the map the update prompt stays at the bottom, above the search panel on a mid-size screen, instead of jumping to the top. Empty lists show a centred message, loading screens say they are busy, and a failed load shows in the error colour.
- Catalog updates report a failed save inside their dialog instead of a browser alert. A bulk review that applies with errors stays open, names each place that failed, and lists the places still waiting.
- The About dialog is titled with the app's name and lists the version, license, source, the main libraries Ferd is built with and the map's data sources as labelled rows, with a link to the notices for every library. The logo and the description are gone.
- Text is 0.75rem or larger everywhere, and sizes, spacing, corners, animation speeds and stacking follow the scales in `ui.css`. Spacing moves slightly in places, and a long category in a map popup wraps instead of pushing the status out.

#### Speed
- The sign-in page opens sooner: it no longer fetches the map, Leaflet or the router, which load once you are signed in or open a published map, so it downloads about 400 KB less.
- The list pages, the route page and its elevation chart, the edit dialogs, the route details form, the map's right-click menu, their styles and the Norwegian interface text load the first time they are needed instead of at startup, so the first load is about 280 KB smaller. All of it stays cached, and every page still opens offline.

#### Accessibility
- The map names itself in a heading for screen readers, and on a phone so do the list pages: the current tab on Places, Routes and Areas (or the list's name when only one is on), and on the You page the name you are signed in as, or that you are viewing a shared map. A single list, or History opened from a link, now shows its name above it. A published map shows its owner's name in a label at the top of the map, while it loads too.
- Screen readers announce the offline banner, the sync issues banner and the sync notice when they change, the sync issues banner as an alert since it asks for action, and read the update prompt as a status line with its Reload button. They also hear which chip is pressed, which tab is current and whether a section is open, and the public link and language picker have labels.
- The page behind an open dialog can no longer be reached with the keyboard or a screen reader.
- Placeholder and secondary text, and the hint under a form field with an error, meet WCAG AA contrast in every theme, so several themes' muted text and error red are lighter or darker than before.

#### Self-hosting
- The frontend's styles and scripts now load from `app/`. A self-hosted web server needs to serve that directory, with `Cache-Control: no-cache` so a browser never mixes old and new modules. The nginx and Caddy examples show how.
- Ferd needs Chrome 99 or newer, or Android System WebView 99 in the Android app. An older one shows a notice asking to update it instead of a broken page.

### Fixed

#### Map
- The Dark base map works again. CARTO began stamping its dark tiles with "API KEY REQUIRED", so Dark now shows OpenStreetMap's map in dark colours and no longer contacts CARTO.
- The base maps credit their providers: OpenTopoMap names OpenStreetMap, NASA SRTM (the elevation data, linked to NASA's page) and its CC-BY-SA licence, and OpenStreetMap and Dark credit OpenStreetMap.
- Zooming out or panning the map no longer shows empty edges while the next tiles load: each base map also loads one ring of tiles just beyond the screen, and on a phone the tiles load while you pinch or drag instead of only when you let go. While wider tiles load, the gap takes a colour close to the base map's own and follows the tile filter, instead of a dark frame.
- On a phone, double-tapping the map to zoom no longer slides the new map tiles in from one side before they settle; they zoom in place with the rest of the map.
- On phones, the map fits the visible screen instead of reaching under the header.
- A place's popup opens just above its pin instead of covering the top of it.
- Category names and local names in popups are readable on every theme, with the category colour moved to a dot beside the name. Uncategorized entries now follow a theme or mode change straight away.
- A route's popup shows Completed or Planned in the text colour instead of the route's red or green, which was hard to read on a dark map, and the grid lines on its elevation chart follow the theme instead of staying near-white in dark mode.
- A deleted place, route or area fades off the map instead of disappearing at once.
- A public map opened with a doubled slash in its address, such as `//u/name/`, shows the map instead of the sign-in prompt.
- Leaving a route's page while its map is zooming, or before its track or elevation chart has loaded, and redrawing the map while it is still zooming, such as at sign-in, no longer leave the old map's work running and logging errors.

#### Pages, dialogs and forms
- Confirm dialogs show their text above the button, with a full-width button on a phone, and deleting from the place or route edit form uses them instead of the system dialog.
- Dragging out of a text field no longer closes the dialog and loses what was typed: a click outside closes it only when the press starts outside.
- Dropdowns on phones, the Filters dropdowns on an iPhone included, use the app's theme and full height instead of the system picker, and so do those on the Add form's Route and Area tabs on desktop.
- Scrollbars and the checkboxes in the Browse and Add to catalog lists use the app's theme.
- On phones, Settings fits the screen: every tab and every option in a segmented row shows in full, and the dialog no longer scrolls sideways.
- On phones, tall forms and lists keep their margin at the bottom of the screen instead of running down to the edge, and on a 320px-wide screen place cards keep the page margin.
- The cursor in the Note and Sources fields sits level with the other form fields, and the x on close buttons and on the search clear button sits in the middle of the button instead of a few pixels low.
- In the Android app, the back gesture closes an open modal instead of leaving the page or the app.

#### Keyboard, contrast and themes
- Every control is at least 24px each way and shows a visible focus ring, including text fields, selects and filled buttons. A switch toggles from anywhere on its row, the colour palette fits a narrow window, and hidden file inputs, closed palettes and collapsed sections no longer take a keyboard stop.
- Map search results can be picked by keyboard, on the desktop panel and in the phone's search view: the arrow keys move through the results, Enter opens the highlighted one and Escape closes the list. Screen readers announce the field as a combobox and each result as an option.
- The account menu on a wide screen works from the keyboard: Enter or the down arrow opens it, the arrow keys, Home, End and typing a name move through its entries, and Escape closes it and returns to the Menu button. Screen readers announce it as a menu. Sign out shows in the danger colour below a divider, and a local map's menu heading reads "Local map".
- Inputs, dropdowns and unfilled buttons have a clearer edge in every theme, and links, errors, success messages and button labels read better in the themes where they were too faint. Accent and green moved slightly lighter or darker in those themes. Route status dots and legend lines use a brighter red and green in dark mode and a darker pair in light mode, so they stand out on every panel. Place status dots are now filled or hollow in the text colour, so colour on a place only ever means its category, and the Visited and Want to visit labels use the normal text colour.
- Switches that are off are easier to see in every theme: an outlined track with a solid knob instead of a faint filled one.
- A filled button in a dialog keeps its label readable on hover in every theme, and shows hover with an inner ring instead of fading.

#### Server and sync
- A route uploaded or imported from a Mac or iPhone no longer shows up twice. The server now stores every route and region name in composed Unicode (NFC), whatever form the device sent, and an import merges each route stored under both spellings into one, keeping one GPX file and the metadata from both. A pair whose GPX files differ, or whose metadata holds two different values for the same field, is left as it is and named in the server log. Metadata written through `POST /api/sync/batch` is stored under the composed name too, and a GPX file asked for by its decomposed name is served from the composed one, so a link or offline copy saved before the merge still opens.
- Deleting a route also deletes its notes, rating, tags and completed date, so a route uploaded later under the same name starts blank. Entries left behind by routes deleted earlier are removed on the next route delete.
- In local-only mode, and for a server map edited offline, removing a region that still holds routes moves them to No region, as the dialog says and the server does, instead of deleting them.
- A sign-in or save no longer fails with a dropped connection when the server is busy writing. Each request waited at most 5 seconds for another one's write to finish, which a burst of saves on a slow disk can outlast; it now waits up to 30 seconds.
- The server no longer resets connections when many requests arrive at once, such as a client syncing after time offline. Its listen queue held only 5 waiting connections, so on a busy or slow host some were dropped before they were read.
- The app no longer stays on Loading when its sign-in check stalls on a poor connection: it asks once more after 4 seconds, then opens the way it does offline. On a first visit, the copy of the app kept for offline use now downloads once the app has opened, not alongside it.
- `deploy/nginx.example.conf` now passes `nginx -t`: the login rate-limit zone sits outside the server blocks, where nginx accepts it.
- `deploy/nginx.example.conf` turns on HTTP/2 with the `http2 on;` directive, so `nginx -t` on nginx 1.25.1 or newer no longer warns that `listen ... http2` is deprecated. A comment in the file gives the old form for an older nginx.
- The Docker image's licence label says GPL-3.0 instead of MIT.

### Removed
- The upgrade steps from 1.x. The server no longer copies a user's JSON files into `app.db` or moves data from before accounts on start, and the app no longer reads the device database 1.x left. See Storage and sync under Changed for how to bring 1.x data over.
- `POST /api/places/clear-category` and `PUT /api/metadata`, which only a 1.x offline queue still called. Clearing a category and editing route metadata go through `POST /api/sync/batch`.
- The owner write endpoints `POST`, `PUT` and `DELETE /api/places` and `/api/areas`, `PUT /api/me/prefs` and `PUT /api/me/category-labels`. Places, areas, preferences and category labels are written through `POST /api/sync/batch`, where the client picks a place or area's id and a category label is replaced whole, colour included. The `GET` paths stay.
- The CyclOSM base map. Its host's conditions cover public, non-profit sites, which Ferd cannot vouch for on every install, so it is now a documented overlay example in `docs/configure.md` that an install can add if it fits them. A map that defaulted to CyclOSM now opens on OpenTopoMap.
- The Satellite base map. Its imagery's terms do not allow it in an app like Ferd, or its offline caching, so it is gone until a free imagery source with fitting terms turns up. A map that defaulted to Satellite now opens on OpenTopoMap, and the default can be changed in Settings > Map.

### Security
- The server no longer hands out the files under `users/`, every user's GPX tracks among them, to anyone who asks for their path: it serves a GPX file only through the API, to its owner or on a published map. The `deploy/` nginx and Caddy examples now refuse all of `tools/`, `users/`, `deploy/` and `.git/` too; before, the nginx one named an old database file and the Caddy one blocked only the database itself, so a backup made beside it could be downloaded. An install built from either example should take the new rule.
- The server sends a Content-Security-Policy on the page and the service worker, and `X-Content-Type-Options: nosniff` on every static file, so the Docker image carries them with no proxy in front. It ships report-only: browsers, Safari included, report what it would block to the new `POST /api/csp-report`, which logs one line per violation, and block nothing until `FERD_CSP_MODE=enforce` is set. `FERD_CSP` replaces the policy, for example to list only your own tile hosts. A proxy that serves `index.html` and `sw.js` from disk drops the header, so the nginx and Caddy examples now send those two through the API. The Android app applies the same policy to its bundled page. See [docs/configure.md](docs/configure.md#content-security-policy).
- The default Content-Security-Policy drops `'unsafe-inline'` from `style-src`, so it allows only the app's own stylesheets, in the server's policy and the Android app's alike. The app no longer needs inline styles: the update notice for old browsers takes its styles from `/webview-notice.css`, and category dots, rating stars and the map's WebGL route layer use classes. The policy still ships report-only, so nothing is blocked until `FERD_CSP_MODE=enforce`; a `FERD_CSP` set by hand keeps its own `style-src`. A setup that serves the files from a proxy or installs them by hand needs the new `webview-notice.css` beside `webview-check.js`.

## [1.5.0] - 2026-11-05

### Added
- Beta releases. The Android beta installs as a separate "Ferd beta" app beside the stable one, with its own data, and the Docker image ships as `:beta`. The stable app, `:latest` and the version tags never receive a beta.

- `HEAD` requests for static files, so `curl -I` shows their headers.

### Changed
- The Android app targets Android 16 (API 36) and draws edge-to-edge: the system bars are transparent over a dark frame, and the page is kept clear of the bars, the camera cutout and the keyboard. Building it needs the Android SDK platform 37.
- Running Ferd with Python now needs 3.11 or newer. Python 3.10 reached end of life in October 2026 and is no longer tested. The Docker image is unaffected.
- The elevation chart runs on leaflet-elevation 2.9.2, which draws without d3, so the app no longer downloads or caches d3 (about 280 KB).

### Fixed
- Thin light lines between map tiles no longer show on desktop at fractional display scaling or while zooming.
- Thin light lines no longer flash between map tiles on Android while tiles load.
- Zooming with a mouse wheel barely moved the map on setups that report small wheel steps. Each notch now moves half a zoom level, and trackpad zoom keeps its speed. Scrolling with the cursor at the exact center of the map no longer stops the zoom.
- A route's elevation chart drew no profile on any single-track route long enough to be thinned for the map, which is most of them. It reads the full track again.
- Deleting a route from the routes list left its card on screen until a reload. The list now drops it right away.
- Zip import stored each place exactly as the archive had it, so `places.json` could hold untrimmed names, integer coordinates, duplicate tags, or empty fields that adding or editing a place never writes. Imported places are now stored in the same normalized form, and merge mode matches existing places on the trimmed name.
- Importing a zip with a corrupt entry returned `failed reading places.json: failed reading places.json: ...`; the entry name now appears once.

### Security
- Vulnerabilities can be reported privately through GitHub's private vulnerability reporting. SECURITY.md links the form.
- The vendored leaflet-gpx ISO duration formatter stripped only the first quote mark of each kind. It now strips them all, which closes two CodeQL alerts.

## [1.4.0] - 2026-10-10

### Added
- `trusted_proxies` config field (env `FERD_TRUSTED_PROXIES`). When set to the reverse proxy's address, the API resolves the real client IP from `X-Real-IP` / `X-Forwarded-For` for the login rate limit, session records, audit log, and access log. Without it, every request behind a proxy counts as the proxy's own IP, so all clients share a single rate-limit bucket and the audit trail carries no per-client information. Off by default; forwarded headers from unlisted peers are ignored as before.

- `HEAD` requests for static files, so `curl -I` shows their headers.

### Changed
- Deleting a route from the index map removes just that route in place instead of rebuilding the whole map (no blink or refit).
- Vendored supercluster bumped to 9.1.0 and leaflet-elevation to 2.6.1. Map clusters are the same as before at every zoom level.

### Fixed
- The API reference documented `PUT` and `DELETE /places` as addressing places by name (`{original_name, place}` and `{name}`). They take `{id, place}` and `{id}`, so any client written from the reference got a `400`. The place schema now also lists the `id`, `image_focus`, `from_catalog`, and `catalog_skip` fields, and `GET /public-maps` is documented instead of missing.
- The post-update smoke check in the Python install guide curled port 8092; the shipped socket unit and config default are both 8091, so the command as written could not connect.
- The API reference documented `/me/category-labels` without the `order` field, so a client written from it would drop category ordering on every write. The payload shape now lists `order`, the accepted ranges for both optional fields, and that only `color` is re-attached when a `PUT` omits it.
- Expired sessions are deleted on login instead of accumulating forever. Expiry was already enforced at lookup; only the dead rows lingered.
- Enabling `require_setup_token` on an empty database crashed at startup: the user-count check ran on an already-closed DB connection.
- Editing or deleting a route from the index-map right-click menu used the wrong region, so routes in a region couldn't be deleted that way.
- The About dialog reported a stale version after a release; the server now re-reads the VERSION file instead of caching it at startup, so the displayed version tracks the deployed code without an API restart.
- Data export failed with an empty response when the data directory held an unreadable or stray backup file; export now skips backup and OS-metadata files (matching import) and no longer aborts the whole archive on a single unreadable file.

### Security
- With `require_setup_token` on, an instance whose user table emptied while it ran (a wipe, a restore from an empty backup, or an instance that started with users and so never made a token) let the next registration become admin without any token. That attempt is now refused, and a fresh token is printed to the log for the next one.
- Zip import checked its 200 MiB uncompressed limit against the sizes the archive declares, so an archive with a false header was decompressed in full: a 611 KB upload drove the API to about 1.2 GiB of memory. Entries are now read in chunks and counted as they decompress.
- A GPX nested a few thousand elements deep, uploaded with PII stripping on, closed the connection without a response. GPX deeper than 64 elements is now rejected with a `400`.
- Vendored leaflet-elevation bumped to 2.6.0, which strips every space and quote from waypoint marker class names instead of only the first of each. Clears the CodeQL incomplete-sanitization alerts. Ferd was not exposed: it draws GPX waypoints with its own marker code and never reaches leaflet-elevation's waypoint-icon path.

## [1.3.0] - 2026-06-05

### Added
- 140 new shipped catalog entries.
- 198 catalog entries tagged UNESCO (World Heritage sites), filterable in Browse.
- Catalog entries carry natural-feature tags (e.g. Volcano, Waterfall, Cave) and Type tags (e.g. Amphitheatre, Bridge, Tower), filterable in Browse; a Type tag collects the same kind of place from any category.
- Catalog entries tagged by civilization (e.g. Roman, Greek, Egyptian, Maya), filterable in Browse. Shipped catalog tags are now a controlled vocabulary.
- Catalog Browse filters by category, country, and tag alongside search.
- A "Review updates" chip opens all pending catalog updates in one modal, with per-field diffs and a single Apply.
- Places carry free-form tags (e.g. `UNESCO`), shown on popups and cards and filterable on both lists (pick several to match all); tags keep their casing, dedupe case-insensitively, and toggle via Settings > Optional fields.
- Offline editing. Place, route, GPX, region, and category-label changes work offline, apply immediately, survive a reload, and sync when the connection returns. The offline banner shows pending changes; a toast reports the sync result.
- Clicking a route on the index map highlights it (it thickens, others dim) so overlapping routes stand apart; clicking the same spot steps through stacked routes, and empty space clears it.
- The route highlight animates over ~150ms instead of snapping (respects reduced-motion).
- Categories, regions, and place/route statuses can be hidden by default (eye toggles in Manage categories/regions, status defaults in Settings > Appearance); the filter panel still shows them for the session.
- Settings > Appearance > On-map controls can hide the route detail view's expand button.

- `HEAD` requests for static files, so `curl -I` shows their headers.

### Changed
- The multi-segment route detail view is now one whole-route elevation graph above a collapsible "Elevation by segment" list; pick a segment from the list or the map for its own profile, or click again for the whole route. Replaces the old per-track accordion.
- Distances and elevations show thousand separators (e.g. `7,340.9 km`, `+101,424 m`).
- The route detail top stats bar is gone; length and climb sit on the elevation header, and the rough estimated-time figure was dropped.
- The index and detail maps thin each route's geometry to the current zoom, so dense GPX tracks (100k+ points) stay smooth; detail returns as you zoom in.
- The filter panel fades a toggled-off category or region's row and hides its color dot, so the off state reads clearly.
- Confirmation dialogs drop the Cancel button; dismiss with Esc, the X, or a click outside.
- Route tags keep their casing (e.g. `UNESCO`) instead of being lowercased; matching stays case-insensitive.
- Catalog imports confirm only when adding 10 or more; smaller selections import without a prompt.
- Catalog categories reworked from 18 to 10 broad buckets, with finer detail moved to tags.
- Active list filters now tint the Filters button and the affected dropdowns instead of showing a count badge.
- Places list sections stack as one full-width column of uniform capped-width cards (up to 3 per row, centered), replacing the two-column masonry that stretched partial rows.
- The nav tabs, Add, and Menu buttons keep one size at every width instead of shrinking on narrow screens, and the space above content no longer jumps at breakpoints.

### Fixed
- On touch, route lines hold a constant width through pinch-zoom and panning stays smooth with many routes, via a GPU (WebGL) layer. Desktop is unchanged; touch without WebGL falls back to standard rendering.
- Index map place pins no longer vanish on the right after the window is widened; the marker canvas now resizes with the map.
- Opening a large multi-segment route no longer flashes and re-fits the map, since the elevation area reserves its height up front.
- Very large routes (tens of thousands of points) open and pan smoothly in the detail view instead of stalling; geometry and elevation thin to the current zoom.
- Editing a route's name or region from its detail view follows it to the new address instead of leaving a dead "route not found" link.
- Places added from the catalog or Add form appear in the list immediately, not only after a reload.
- Routes list cards no longer stretch to fill a row; single-route regions and partial last rows keep normal-sized tiles.

### Removed
- The one-shot `show-native-name` to `show-local-name` localStorage migration (pre-1.1.0); browsers have long since booted through it.

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

- `HEAD` requests for static files, so `curl -I` shows their headers.

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

- `HEAD` requests for static files, so `curl -I` shows their headers.

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
