# Design conventions

Atlas is a single-file frontend (`index.html`), no framework, plus a Python API. Reuse existing selectors and behaviors rather than inventing new ones.

## Platform targets

Floors, not stretch goals. Drift from these needs a real reason.

- **Browsers:** Baseline Widely Available (caniuse.com / web-platform-dx).
- **Viewport:** desktop primary (>=1024 px), mobile portrait works down to 320 px. No PWA, no native wrapper.
- **JavaScript:** track baseline. No transpilation step.
- **CSS:** baseline only. `:has()`, `:is()`, `:where()`, grid, flex, custom properties, logical properties, `aspect-ratio`, `prefers-*` are in. Container queries, subgrid, `color-mix()`, anchor positioning - wait for baseline.
- **Build pipeline:** none today. A bundler is allowed if it earns its keep; default answer is no.
- **Accessibility:** required. Semantic HTML, labels on every input, Esc closes modals, `prefers-reduced-motion` respected, WCAG AA contrast on every theme.
- **Network:** online-only. API unreachable -> visible error. No service worker, no offline cache.
- **Performance:** soft target <1s first paint on a 5-year-old laptop, <500 KB initial JS+CSS+HTML (excluding tiles/GPX).
- **i18n:** English UI today. Keep the language `<select>` infrastructure so localization can be added later. Data round-trips arbitrary Unicode.
- **Third-party at runtime:** none except map tile providers. No analytics, no third-party fonts, no external APIs from the page.

## Modal anatomy

- Title row: `<h2>Title<button class="modal-close">&times;</button></h2>`. X (and Esc) closes. No bottom Close button.
- Tabs: `<div class="modal-tabs">` + `<button data-tab="X">` children. Panels are `<div data-panel="X">` toggled via `hidden`. Render all panels at openModal time so handlers stay wired across switches.
- Section headers: `<h3 class="settings-h">`. Noun phrases ("Sharing", "Backup") - never verb phrases ("Publish my map").
- Section descriptions: `<div class="modal-desc">`. Don't use `.hint` (muted gray) inside settings.
- Settings modal: tabs are General / Appearance / Account / Admin. Each panel has `min-height: 500px` so tab switches don't shift the modal vertically. Backdrop reserves 3rem top + 3rem bottom.

## Buttons

| Class | When | Look |
|---|---|---|
| `.primary` | Main action of a section | Filled accent |
| (default) | Secondary actions | Outlined |
| `.sessions-revoke-others` style | Inline text-link next to a header | Transparent, underline on hover |

Placement: form-bottom submits in `<div class="modal-actions">`. Description+button or input+button pairs use inline flex rows. When the row pairs a wrapped description with a button, set `align-items: flex-start` so the description sits at the top of the row instead of being pulled down to match the button height.

`.primary` is themed for both modal and non-modal contexts (e.g. list-page Add buttons): the modal selector wins inside modals via specificity, the bare `button.primary` rule covers everywhere else.

## Forms and inputs

- `<label>` block above the input. Helper text in `.modal-desc` below.
- File pickers: hide native input with `.file-input-hidden`, render a styled `<button>Choose file</button>` + `.file-name` span. Canonical example: Backup -> Import.
- Settings input types: `.settings-toggle` (styled checkbox) for binary on/off, `.radio-row.radio-pills` for small fixed single-select sets (use `radioPillsHtml`), `.star-rating` for 1-5 ratings (use `starRatingHtml` + `wireStarRating` + `readStarRating`), `<select>` for many-option selects. `.feature-pill` is for multi-select toggle groups (Visible features, Optional fields). `.btn-x` is the small × icon button for row-level removes (categories/regions managers).
- Settings layout primitives: `.settings-grid-2` pairs two short selects side-by-side (label row above, control row below). `.settings-inline-row` puts label left, control right on one row (fixed 9rem label column so pill groups align across rows; switches to flex with `order: -1` on the toggle so slider sits left of label). `.toggle-grid` stacks toggle rows in a 2-column grid to save vertical space.
- Collapsible reveal: `<div class="collapsible">` wraps an inner `<div class="collapsible-inner">`. Toggle the `.expanded` class on the outer to animate height (250ms grid-rows + opacity). Used for conditional fields (Visited -> date/rating, Completed -> date/rating).

## Toggle switch

Markup: `<input type="checkbox" class="settings-toggle" id="…">`. The input itself becomes the styled toggle via `appearance: none` + a `::after` knob, scoped with `.modal input[type="checkbox"].settings-toggle` so it wins over `.modal label`. The track uses `var(--border)` (off) and `var(--accent)` (on); the knob is `var(--surface)` in both states. Convention: slider sits to the left of its `<label for="…">`. `.settings-inline-row` handles this automatically (rule: when the row contains a `.settings-toggle`, switch to flex with `order: -1` on the toggle).

## Status feedback

- `.modal-error` for failures (red box, toggle `.visible`).
- `.modal-success` for confirmations (green text, toggle `hidden`). Clear the inputs so the message reads as the new resting state.
- `.modal-success-box` for confirmations that need the same visual weight as an error (multi-line counts, post-import summary). Mirrors `.modal-error` shape in green; toggle `hidden`.
- Don't put transient confirmation in a button label - easy to miss.
- Disabled `<select>` shows muted opacity and a not-allowed cursor (`.modal select:disabled`). Use when an input is reserved for future functionality (e.g. the language picker) so it looks intentional, not broken.

## Themes and colors

Multiple themes x light/dark (see [themes.md](themes.md)). Always use CSS variables (`--text`, `--muted`, `--accent`, `--border`, `--surface`, `--surface2`, `--red`, `--green`). Never hardcode hex values.

## List-page index controls

`.index-controls` is the top row on the Places and Trails list pages: search input (flex:1), optional Filters popover, primary Add button. Keep the row to three slots on mobile by folding additional controls (grouping, secondary filters) into the popover rather than adding side-by-side widgets.

Filters popover: `.filter-dropdown` wraps a `.filter-btn` and a `.filter-popover` anchored to the button's right edge. The popover holds a vertical stack of compact `<select>`s with their first option naming the dimension ("All statuses", "Any difficulty"), so no per-select labels are needed. View-mode controls (e.g. Group by) sit below a `.filter-divider` line. A `.filter-clear` text-link button at the bottom resets every select. The button shows a `Filters (N)` badge with accent border when one or more narrowing filters are active.

## UI copy

- Section headers: short noun phrases.
- Buttons: imperative verbs.
- Descriptions: state what the section contains, not what the button does. No "Click to..." prefixes.
- No em dashes, en dashes, or unicode arrows. Plain hyphens and `->`.

## CSS specificity gotcha

The generic rule `.modal button:not(h2 .modal-close)` is (0,2,2) because `:not()` takes the highest specificity of its argument. To win, repeat the `:not()` on your selector:

```css
.modal .modal-tabs button:not(h2 .modal-close) { ... }
.modal button.primary:not(h2 .modal-close) { ... }
```

## Future upgrades

Parked items - intentionally out of current scope, captured so they don't get re-litigated from scratch.

| Item | What it adds | Why not now / cost |
|---|---|---|
| Print / PDF | Print stylesheet so `Ctrl-P` of a trail detail or places list produces something readable. | Map-heavy content doesn't print well. Maintaining print CSS is a tarpit for small payoff. Revisit if a specific use case appears. |
| Auth hardening | Optional TOTP 2FA, HIBP k-anonymity password-breach check at register / change-password. (Per-IP login rate-limiting already ships - 10 failures per 15-minute window.) | Current threat model is "stranger guesses a password" against a 12-char minimum on a self-hosted app with login rate-limiting in place. HIBP would introduce a third-party request (currently zero). 2FA needs setup flow + recovery codes + schema. Revisit when the threat model expands. |
| Photo attachments | Photos on places / trails (thumbnails + originals), shown in popups and detail pages. | Picks a storage strategy (per-user dir alongside `gpx/`, or object store), server-side thumbnailing pipeline, EXIF stripping mirror of the GPX-trkpt PII stripping, backup/import format gains a photos arc. Real scope; not a small evening. |
| PWA / installable | Installable shell, app-like icon, would unlock service-worker offline cache. | Conflicts with the online-only network policy (a useful PWA needs the service worker and a cached shell). Service workers carry their own staleness / cache-invalidation maintenance. Stays rejected unless offline read-only becomes a real requirement. |
