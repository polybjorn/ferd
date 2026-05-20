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

Placement: form-bottom submits in `<div class="modal-actions">`. Description+button or input+button pairs use inline flex rows.

## Forms and inputs

- `<label>` block above the input. Helper text in `.modal-desc` below.
- File pickers: hide native input with `.file-input-hidden`, render a styled `<button>Choose file</button>` + `.file-name` span. Canonical example: Backup -> Import.
- Settings input types: pills (`.feature-pill`) for binary toggles, radios for small fixed sets, `<select>` for growing or many-option selects.

## Status feedback

- `.modal-error` for failures (red box, toggle `.visible`).
- `.modal-success` for confirmations (green text, toggle `hidden`). Clear the inputs so the message reads as the new resting state.
- Don't put transient confirmation in a button label - easy to miss.

## Themes and colors

Multiple themes x light/dark (see [themes.md](themes.md)). Always use CSS variables (`--text`, `--muted`, `--accent`, `--border`, `--surface`, `--surface2`, `--red`, `--green`). Never hardcode hex values.

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
