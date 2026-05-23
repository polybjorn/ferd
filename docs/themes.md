# Themes

Atlas ships seven color themes, each with a light and dark variant. The active theme and mode are stored per-browser in localStorage and applied as `data-theme` / `data-mode` attributes on `<html>`.

## For users

### Available themes

| Theme | Light | Dark | Source |
|---|---|---|---|
| Catppuccin | yes | yes | [Pastel, four flavors (Latte, Frappé, Macchiato, Mocha)](https://catppuccin.com/) |
| Dracula | yes | yes | [Dark theme ported to hundreds of apps](https://draculatheme.com/) |
| Gruvbox | yes | yes | [Retro groove, warm earth tones](https://github.com/morhetz/gruvbox) |
| Nord | yes | yes | [Arctic, bluish 16-color palette](https://www.nordtheme.com/) |
| Rosé Pine | yes | yes | [Soho vibes, three variants](https://rosepinetheme.com/) |
| Solarized | yes | yes | [Precision colors for machines and people, 16-color](https://ethanschoonover.com/solarized/) |
| Tokyo Night | yes | yes | [Clean dark theme from VS Code](https://github.com/enkia/tokyo-night-vscode-theme) |

Picked from Settings (gear icon, bottom-right). Mode is "Light", "Dark", or "System" (follows the OS preference and tracks live changes).

### What the theme controls

- Page chrome: background, surfaces, borders, text, muted text.
- Accent color (links, focus rings, cluster halos).
- Semantic colors: green (visited/completed), red (planned/want to visit), yellow.
- Trail line colors (`--completed`, `--planned`) and cluster halos.

### What the theme does NOT control

- **Category colors on pins and popups.** These come from a fixed 10-color palette (`COLORS` in `index.html`) assigned by sorted category position. The palette stays the same across themes, so a category always shows the same color. In light mode, popup text uses a darker parallel palette (`COLORS_LIGHT`) for legibility; pins keep the original colors.
- **Map tiles.** Tile layers are independent. If a light tile layer feels harsh on a dark theme, use the "Tile filter" setting (Settings -> Map) to desaturate or mute it.

## For contributors

### File layout

Everything theme-related lives in `index.html`. Find by name (line numbers drift):

- CSS variable blocks: one per `[data-theme="X"][data-mode="Y"]` pair near the top of the file, plus a base `:root` block (Nord dark) as fallback.
- `THEMES` array: registered theme keys.
- `themeLabels` object: display names for the Settings dropdown.
- `applyTheme(theme, mode)`: sets the two HTML attributes, resolves "system" via `matchMedia`, and invalidates the trail-color cache.
- `COLORS` / `COLORS_LIGHT`: category palette, indexed by sorted category position. See [Category palette](#category-palette).
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
| `--yellow` | Warnings (rare) |
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

`applyTheme(theme, mode)` sets the `data-theme` and `data-mode` attributes on `<html>`. "system" mode resolves to "light" or "dark" via `window.matchMedia('(prefers-color-scheme: light)')` and re-resolves on the fly when the OS preference changes. CSS selectors target the resolved value, never "system".

### Category palette

Separate from themes. Defined in `index.html` as `COLORS` and `COLORS_LIGHT`:

```js
const COLORS       = ['#6aaeee', '#c792ea', '#ffbd2e', '#89ddff', '#f78c6c', '#c3e88d', '#ff5370', '#82b1ff', '#f07178', '#c17e70'];
const COLORS_LIGHT = ['#1e6fbf', '#7e3fb0', '#8f6200', '#0e7490', '#b34a20', '#4d7a1f', '#c41142', '#2952c4', '#b8313a', '#7a3e30'];
```

`assignCategoryColors(places)` deduplicates and sorts category names, then hands out `COLORS[i % len]` and `COLORS_LIGHT[i % len]` at matching indices. Pins and swatches always use the dark palette. Popup text uses the dark palette in dark mode and the light palette in light mode (wired via `--c` / `--cl` on `.cat-text` spans).

Implications:

- Adding a category alphabetically before existing ones reshuffles colors for everything after it. Category colors are not stable across category-set changes.
- The two palettes must stay the same length. A runtime check warns on mismatch.
- To extend the palette, append the same index to both arrays.

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
