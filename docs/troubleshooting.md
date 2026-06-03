# Troubleshooting

## Console messages you can ignore

If you open your browser's developer console while using Ferd, you may see a few warnings. They're harmless: they don't affect the map, your data, or anyone viewing your published page. They come from the mapping libraries Ferd bundles, not from Ferd itself.

| Message | Where it comes from | What it means |
|---|---|---|
| `MouseEvent.mozPressure is deprecated` | Leaflet (the map library), Firefox only | Leaflet reads an older browser property while handling clicks and drags. Firefox flags it as dated, but it still works and nothing breaks. |
| `MouseEvent.mozInputSource is deprecated` | Leaflet, Firefox only | Same as above. |
| `Source map error: ... leaflet.js.map` (also `leaflet-elevation.js.map`) | Leaflet / leaflet-elevation | A source map is a developer aid for reading minified code. These libraries point to one that Ferd doesn't ship, so dev tools report a missing file. Only visible with dev tools open; no effect on the running app. |

These come from third-party libraries Ferd vendors as-is. Ferd keeps those copies unmodified on purpose, so they stay verifiable against and updatable from upstream, and doesn't patch them just to quiet a console message. The Firefox deprecation warnings can't be switched off from Ferd's code either: the browser emits them itself, not through anything a page can intercept. If they bother you, Firefox's own console settings can hide "deprecation" messages.
