# Themes

Atlas ships seven color themes, each with a light and dark variant. The active theme and mode are stored per-browser in localStorage and applied as `data-theme` / `data-mode` attributes on `<html>`.

## For users

### Available themes

| Theme | Light | Dark |
|---|---|---|
| Catppuccin | yes | yes |
| Dracula | yes | yes |
| Gruvbox | yes | yes |
| Nord | yes | yes |
| Rosé Pine | yes | yes |
| Solarized | yes | yes |
| Tokyo Night | yes | yes |

Picked from Settings (gear icon, bottom-right). Mode can be "Light", "Dark", or "System" (follows the OS preference and updates live when it changes).

### What the theme controls

- Page chrome: background, surfaces, borders, text, muted text.
- Accent color (links, focus rings, cluster halos).
- Semantic colors: green (visited/completed), red (planned/want to visit), yellow.
- Trail line colors (`--completed`, `--planned`) and cluster halos.

### What the theme does NOT control

- **Category colors on pins and popups.** Those come from a fixed palette of 10 colors (`COLORS` in `index.html`) assigned by sorted category position. The palette is constant across themes so a given category looks the same regardless of which theme you pick. In light mode, popup text uses a darker parallel palette (`COLORS_LIGHT`) for legibility; pins keep the original colors.
- **Map tiles.** Tile layers are independent. Use the "Tile filter" setting (Settings -> Map) to desaturate/mute tiles if a light tile layer feels harsh on a dark theme.

## For contributors

### File layout

Everything theme-related lives in `index.html`:

- CSS variable blocks (lines ~20-370): one block per `[data-theme="X"][data-mode="Y"]` pair, plus a base `:root` block (Nord dark) as fallback.
- `THEMES` array (~line 2828): registered theme keys.
- `themeLabels` object (~line 3006): display names for the Settings dropdown.
- `applyTheme(theme, mode)` (~line 2842): sets the two HTML attributes and resolves "system" via `matchMedia`.
- `COLORS` / `COLORS_LIGHT` (~line 1475): category palette, indexed by sorted category position. See [Category palette](#category-palette).
- `COMPLETED_COLOR` / `PLANNED_COLOR` (~line 1478): hardcoded trail status colors used in popup text. **Not theme-aware** (see [known gaps](#known-gaps)).

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
| `--shadow` | Popup/card shadow |
| `--backdrop` | Modal backdrop overlay |
| `--fab-text` | Text/icon color on the FAB button |

The base `:root` block (~line 17) also defines `--radius` and `--attribution-bg`. New themes inherit those unless they override.

Light blocks additionally define `--attribution-bg` (light themes use a different translucent fill behind tile attribution to stay legible on light tiles).

### Mode switching

`applyTheme(theme, mode)` writes two HTML attributes:

```html
<html data-theme="tokyo-night" data-mode="light">
```

"system" mode resolves via `window.matchMedia('(prefers-color-scheme: light)')` and re-resolves live via the `change` listener registered at startup. Selectors throughout the CSS key off the resolved value, not "system".

### Category palette

Separate from themes. Defined at index.html:1475:

```js
const COLORS       = ['#6aaeee', '#c792ea', '#ffbd2e', '#89ddff', '#f78c6c', '#c3e88d', '#ff5370', '#82b1ff', '#f07178', '#c17e70'];
const COLORS_LIGHT = ['#1e6fbf', '#7e3fb0', '#8f6200', '#0e7490', '#b34a20', '#4d7a1f', '#c41142', '#2952c4', '#b8313a', '#7a3e30'];
```

`assignCategoryColors(places)` deduplicates and sorts category names, then assigns `COLORS[i % len]` and `COLORS_LIGHT[i % len]` at matching indices. The dark palette is used for pins/swatches in both modes; the light palette is used only for popup text in light mode (via `--c` / `--cl` CSS vars on `.cat-text` spans).

Implications:

- Adding a new category alphabetically before existing ones reshuffles colors for everything after it. Colors are not stable across category-set changes.
- Both palettes must stay the same length. A runtime check warns on mismatch.
- To extend the palette, append to both arrays at the same index.

### Adding a new theme

1. Pick a key (lowercase, hyphenated): `my-theme`.
2. Add two CSS blocks in `index.html`, dark first, light second:
   ```css
   [data-theme="my-theme"][data-mode="dark"] {
     --bg: #...;
     /* full contract above */
   }
   [data-theme="my-theme"][data-mode="light"] {
     --bg: #...;
     /* full contract above, plus --attribution-bg */
   }
   ```
3. Append the key to `THEMES` (index.html:2828).
4. Add a display label to `themeLabels` (index.html:3006).
5. Hard-reload and verify in Settings.

Recommended sanity checks:

- Body text on `--bg` and `--surface` hits ~7:1 contrast (WCAG AAA for normal text), ~4.5:1 minimum.
- `--muted` hits ~4.5:1 on `--surface` (AA).
- `--accent` on `--bg` is legible as a link color.
- `--green` and `--red` are distinguishable for the most common forms of color blindness (compare in a simulator).
- Marker cluster halo is visible against both light and dark tile layers.

### Open theme-related TODOs

Tracked in the [main README TODO](../README.md#todo). Currently: trail-status colors are not theme-aware, and category-color assignment isn't stable across category-set changes.
