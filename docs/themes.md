# Themes

Each theme runs in Light, Dark, or System mode. Theme and mode are picked from Settings, stored per-browser in localStorage, and applied as `data-theme` / `data-mode` attributes on `<html>`.

## For users

### Available themes

| Theme | Light | Dark | Source |
|---|---|---|---|
| Catppuccin | yes | yes | [catppuccin.com](https://catppuccin.com/) |
| Dracula | yes | yes | [draculatheme.com](https://draculatheme.com/) |
| Gruvbox | yes | yes | [github.com/morhetz/gruvbox](https://github.com/morhetz/gruvbox) |
| Nord | yes | yes | [nordtheme.com](https://www.nordtheme.com/) |
| Rosé Pine | yes | yes | [rosepinetheme.com](https://rosepinetheme.com/) |
| Solarized | yes | yes | [ethanschoonover.com/solarized](https://ethanschoonover.com/solarized/) |
| Tokyo Night | yes | yes | [github.com/enkia/tokyo-night-vscode-theme](https://github.com/enkia/tokyo-night-vscode-theme) |

### What the theme controls

- Page chrome: background, surfaces, borders, text, muted text.
- Accent color (links, focus rings, cluster halos).
- Semantic colors: green (visited/completed), red (planned/want to visit).
- Trail line colors (`--completed`, `--planned`) and cluster halos.

### What the theme does NOT control

- **Category colors on pins and popups.** These come from a fixed palette (`COLORS` in `index.html`); each category is assigned a slot the first time it's seen and remembers its color across edits. The palette stays the same across themes, so a category always shows the same color. In light mode, popup text uses a darker parallel palette (`COLORS_LIGHT`) for legibility; pins keep the original colors.
- **Map tiles.** Tile layers are independent. If a light tile layer feels harsh on a dark theme, use the "Tile filter" setting (Settings -> Map) to desaturate or mute it.

## For contributors

### File layout

Everything theme-related lives in `index.html`. Find by name:

- CSS variable blocks: one per `[data-theme="X"][data-mode="Y"]` pair near the top of the file, plus a base `:root` block (Nord dark) as fallback.
- `THEMES` array: registered theme keys.
- `themeLabels` object: display names for the Settings dropdown.
- `applyTheme(theme, mode)`: sets the two HTML attributes, resolves "system" via `matchMedia`, and invalidates the trail-color cache.
- `COLORS` / `COLORS_LIGHT`: category palette. Each category's index is stored alongside its label in `category-labels.json`; see [Category palette](#category-palette).
- `trailStatusColor(completed)`: returns the resolved `--completed` / `--planned` color for the active theme. Cached after the first read and invalidated in `applyTheme`, so a `getComputedStyle` runs once per theme change instead of once per polyline. Legend dots and search-result lines reference the same vars directly via `.completed` / `.planned` CSS classes.

### CSS variable contract

Each `[data-theme][data-mode]` block must define:

| Variable | Used for |
|---|---|
| `--bg` | Page background |
| `--surface` | Cards, panels, modals |
| `--surface2` | Nested surfaces (modal sections, code blocks) |
| `--border` | Default border color |
| `--border-hover` | Border on hover/focus |
| `--text` | Primary text |
| `--muted` | Secondary text, captions |
| `--accent` | Links, focus rings, interactive accent |
| `--red` | "Want to visit", errors, planned status |
| `--green` | "Visited", completed status, success |
| `--completed` | Completed trail polylines |
| `--planned` | Planned trail polylines |
| `--cluster-fill` | Marker cluster fill (rgba with alpha) |
| `--cluster-halo` | Marker cluster halo (rgba with alpha) |
| `--shadow` * | Popup/card shadow |
| `--backdrop` | Modal backdrop overlay |
| `--fab-text` | Text/icon color on the FAB button |

\* `--shadow` is conventionally the same in every theme: `rgba(0, 0, 0, 0.4)` in dark blocks, `rgba(0, 0, 0, 0.12)` in light blocks. It varies by mode, not by theme. New themes should match those values unless there's a specific reason to deviate.

Two more variables live outside the per-theme blocks:

- `--radius` is defined once in `:root` (6px). Theme blocks don't override it.
- `--attribution-bg` only appears in light blocks. Light themes need a different translucent fill behind the tile attribution so it stays legible on bright tiles. Dark themes inherit the `:root` placeholder.

### Mode switching

System mode resolves to `light` or `dark` via `window.matchMedia('(prefers-color-scheme: light)')` and re-resolves when the OS preference flips. CSS selectors target the resolved value, never `system`.

### Category palette

Separate from themes. Defined in `index.html` as `COLORS` (dark, used everywhere except popup text on light backgrounds) and `COLORS_LIGHT` (HSL-darkened siblings, used for popup text in light mode via `--cl` on `.cat-text` spans). Pins and swatches always use the dark palette.

Source: Tableau 20, reordered so indices 0-9 are the saturated/distinguishable set in hue-spread order (blue, orange, green, red, teal, purple, gold, pink, brown, gray). Indices 10-19 are the paler siblings of the same hues in the same order, used as fallback once 10+ categories accumulate.

`assignCategoryColors(places)` looks up each category's color from `category-labels.json` (per-user, `{slug: {label, color}}`). Categories not yet assigned a color get `(max stored color + 1) mod COLORS.length` and are persisted back via `PUT /me/category-labels`, so the first N categories you create get the most-distinct N slots and adding or removing categories never reshuffles existing ones.

Implications:

- Colors are stable per slug. Editing the category list (add, rename, remove) doesn't reshuffle previously-assigned colors.
- The two palettes must stay the same length. A runtime check warns on mismatch.
- To extend the palette, append the same index to both arrays. Keep the "saturated first, paler siblings second" order intact so the first-N-most-distinct property holds.
- With more than `COLORS.length` categories, new ones wrap and reuse early indices (predictable collision, not random reshuffle).

### Adding a new theme

1. Pick a key (lowercase, hyphenated), e.g. `my-theme`.
2. In `index.html`, add two CSS blocks (dark first, then light), each filling out the full variable contract above. Light blocks also need `--attribution-bg`.
   ```css
   [data-theme="my-theme"][data-mode="dark"]  { --bg: #...; /* ... */ }
   [data-theme="my-theme"][data-mode="light"] { --bg: #...; /* ...; --attribution-bg: rgba(...); */ }
   ```
3. Append the key to the `THEMES` array.
4. Add a display label to `themeLabels`.
5. Hard-reload and verify in Settings.

Sanity checks before shipping:

- Body text on `--bg` and `--surface` hits at least 4.5:1 contrast (WCAG AA); aim for 7:1 (AAA).
- `--muted` hits at least 4.5:1 on `--surface`.
- `--accent` on `--bg` is legible as a link color.
- `--green` and `--red` are distinguishable to the most common forms of color blindness (check in a simulator).
- The marker cluster halo is visible against both light and dark tile layers.
