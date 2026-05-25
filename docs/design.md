# Design conventions

Single-file frontend (`index.html`), no framework, plus a Python API. Reuse existing selectors and behaviors rather than inventing new ones.

## Platform targets

These are minimums. Don't drop below them without a real reason.

- **Browsers:** Baseline Widely Available (caniuse.com / web-platform-dx).
- **Viewport:** desktop first (>=1024 px). Mobile portrait works down to 320 px. Installable as a PWA (own home-screen icon, standalone window), no native wrapper.
- **JavaScript:** baseline. No transpilation step.
- **CSS:** baseline only. In: `:has()`, `:is()`, `:where()`, grid, flex, custom properties, logical properties, `aspect-ratio`, `prefers-*`. Wait for baseline: container queries, subgrid, `color-mix()`, anchor positioning.
- **Build pipeline:** none. A bundler is allowed if it earns its keep; default answer is no.
- **Accessibility:** required. Semantic HTML, labels on every input, Esc closes modals, `prefers-reduced-motion` is respected, WCAG AA contrast on every theme.
- **Network:** edits require network and fail loudly when offline. Reads are offline-capable through a hand-rolled service worker (`sw.js`) that precaches the app shell and vendored deps, runs `stale-while-revalidate` on JSON data, and cache-firsts map tiles with an LRU cap. See [pwa.md](pwa.md).
- **Performance:** soft target under 1s first paint on a 5-year-old laptop, under 500 KB of JS+CSS+HTML on first load (tiles and GPX excluded).
- **i18n:** English UI today. Keep the language `<select>` in place so localization can be added later. Data round-trips arbitrary Unicode.
- **Third-party at runtime:** none, except map tile providers. No analytics, no third-party fonts, no external APIs from the page.

## Modal anatomy

- Title row: `<h2>Title<button class="modal-close">&times;</button></h2>`. The X (and Esc) closes. No bottom Close button. Exception: the Add modal uses a floating `.modal-close-floating` in the corner so the Place/Trail tabs can sit at the top.
- Tabs: `<div class="modal-tabs">` containing `<button data-tab="X">`. Panels are `<div data-panel="X">` toggled with the `hidden` attribute. Render every panel up front so click handlers stay attached when the user switches tabs.
- Section headers: `<h3 class="settings-h">`. Use noun phrases ("Sharing", "Backup"), not verb phrases ("Publish my map").
- Section descriptions: `<div class="modal-desc">`. Don't use `.hint` (muted gray) inside settings.
- Settings modal: tabs are General / Appearance / Account / Admin / Logs (the last two only for admins). The backdrop is pinned to the top (`align-items: flex-start`) with 3rem of top and bottom padding so the modal doesn't jump vertically as the user switches between tabs of different heights.
- Pin-to-top convention: any modal whose contents can change height during interaction (tab switches, filter narrowing a list, adding/removing rows, color pickers expanding) must pin to the top instead of vertically centering. Otherwise the modal jumps as content shrinks/grows, which is disorienting. Add the modal's unique inner id to the `.modal-backdrop:has(...)` selector in `index.html` (`#settings-tabs`, `#cat-rows`, `#cat-list`, `#cat-mgr-list`, `#rgn-rows`, ...) which applies `align-items: flex-start` + 3rem vertical padding. Lists inside such modals should scroll internally via `max-height: 60vh; overflow-y: auto` rather than fighting the modal's height.
- Sticky footer toolbar: a panel can pin a row of actions to the bottom of the modal viewport (see `.log-toolbar` on the Logs tab) using `position: sticky; bottom: -1.25rem` plus negative horizontal margins to cancel the modal's own padding. Use sparingly, only for actions that must stay reachable while a long list scrolls.
- Stacking: open modals form a stack (`modalStack`). `openModal` appends a backdrop; `closeTopModal()` removes the topmost one. Each modal gets `z-index: 2000 + 10*depth` so nested confirm dialogs sit above the modal that opened them. Closing animates for 100ms before the backdrop is removed from the DOM.
- Confirm dialogs: use `openConfirmModal({ title, body, confirmLabel, danger })`. Returns a `Promise<boolean>`. Pair destructive actions (delete, force-unpublish, demote, revoke sessions) with `danger: true` so the confirm button picks up `.danger-btn` styling. Enter confirms; Esc / Cancel / X / backdrop click cancels.

## Buttons

| Class | When | Look |
|---|---|---|
| `.primary` | Main action of a section | Filled accent |
| (default) | Secondary actions | Outlined |
| `.sessions-revoke-others` style | Inline text-link next to a header | Transparent, underline on hover |

Placement: the submit button at the bottom of a form lives in `<div class="modal-actions">`. Description-plus-button and input-plus-button pairs use inline flex rows. When the description wraps to multiple lines, set `align-items: flex-start` so the text starts at the top instead of being pulled down to match the button's height.

`.primary` works in both modal and non-modal contexts (e.g. the Add buttons on list pages). The modal-scoped rule wins inside modals via specificity; the bare `button.primary` rule covers everywhere else.

Specificity gotcha: the generic rule `.modal button:not(.modal-close)` is (0,2,2) because `:not()` takes the highest specificity of its argument. To beat it, repeat the `:not()` on your selector (e.g. `.modal button.primary:not(.modal-close)`).

Source-order gotcha (media queries): a rule inside `@media (max-width: ...)` does NOT automatically beat a same-specificity rule placed later in the stylesheet. The cascade resolves identical specificity by source order, and the media-query block is just a wrapper, not a tiebreaker. If a mobile override appears earlier in the file than the desktop default, the default wins on mobile too. Either move the override to after the default, or bump its selector specificity (e.g. `nav .auth-widget button { ... }`).

## Forms and inputs

- `<label>` sits on its own line above the input. Helper text goes in `.modal-desc` below.
- File pickers: hide the native input with `.file-input-hidden` and render a styled `<button>Choose file</button>` next to a `.file-name` span. The Backup -> Import row is the canonical example.
- Input types by purpose:
  - `.settings-toggle` (styled checkbox) for binary on/off.
  - `.radio-row.radio-pills` for small fixed single-select sets (use `radioPillsHtml`).
  - `.star-rating` for 1-5 ratings (use `starRatingHtml` + `wireStarRating` + `readStarRating`).
  - `<select>` for longer single-select lists.
  - `.feature-pill` for multi-select toggle groups (Visible features, Optional fields).
  - `.btn-x` for the small × that removes a row in the categories/regions managers.
- Layout primitives:
  - `.settings-grid-2` pairs two short selects side-by-side (label row above, control row below).
  - `.settings-inline-row` puts the label on the left and the control on the right. The label column is fixed at 9rem so pill groups line up across rows. When the row contains a `.settings-toggle`, it switches to flex with `order: -1` on the toggle so the slider sits to the left of its label.
  - `.toggle-grid` stacks toggle rows in a 2-column grid to save vertical space.
- Collapsible reveal: wrap content in `<div class="collapsible"><div class="collapsible-inner">...</div></div>`. Toggle the `.expanded` class on the outer div to animate height (250ms grid-rows + opacity). Used for conditional fields like Visited -> date/rating and Completed -> date/rating.

## Toggle switch

Markup: `<input type="checkbox" class="settings-toggle" id="…">`. The input itself becomes the styled toggle: `appearance: none` strips the native checkbox and a `::after` pseudo-element draws the knob. The rule is scoped to `.modal input[type="checkbox"].settings-toggle` so it wins over the generic `.modal label`. The track uses `var(--border)` when off and `var(--accent)` when on; the knob stays `var(--surface)` in both states. The slider should sit to the left of its `<label for="…">`; `.settings-inline-row` does this automatically.

## Status feedback

- `.modal-error` for failures: red box, toggled via `.visible`.
- `.modal-success` for confirmations: green text, toggled via `hidden`. Clear the inputs so the message reads as the new resting state, not as feedback on a still-filled form.
- `.modal-success-box` when a confirmation needs the same visual weight as an error (e.g. a multi-line post-import summary). Same shape as `.modal-error` but green; toggled via `hidden`.
- Don't put transient confirmations in a button label - they're easy to miss.
- Disabled `<select>` gets muted opacity and a not-allowed cursor (`.modal select:disabled`). Use this when an input is reserved for future functionality (e.g. the language picker) so it looks intentional rather than broken.

## Themes and colors

Multiple themes x light/dark (see [themes.md](themes.md)). Always use CSS variables (`--text`, `--muted`, `--accent`, `--border`, `--surface`, `--surface2`, `--red`, `--green`). Never hardcode hex values.

## List-page index controls

`.index-controls` is the top row on the Places and Trails list pages: search input (flex:1), optional Filters popover, primary Add button. Keep this row to three slots on mobile. New controls (grouping, secondary filters) belong in the popover, not as a fourth widget next to the Add button.

Filters popover: `.filter-dropdown` wraps a `.filter-btn` and a `.filter-popover` anchored to the button's right edge. The popover holds a vertical stack of compact `<select>`s whose first option names the dimension as a bare noun ("Status", "Category", "Country", "Region", "Difficulty", "Rating", "Catalog"), so no per-select labels are needed. The bare noun reads as a header at rest and a hint about what changes when the user picks another option; "All X" / "Any X" prefixes were dropped because they implied the default was actively filtering. View-mode controls like "Group by" sit below a `.filter-divider` line. A `.filter-clear` text-link button at the bottom resets every select. When one or more narrowing filters are active, the button shows a `Filters (N)` badge with an accent border.

## UI copy

- Section headers: short noun phrases.
- Buttons: imperative verbs.
- Descriptions: state what the section contains, not what the button does. No "Click to..." prefixes.
- No em dashes, en dashes, or unicode arrows. Plain hyphens and `->`.

## Animations

Durations are 100-180ms. Easing is `ease-out` for entry, `ease-in` for exit. Every animation is wrapped in `@media (prefers-reduced-motion: reduce) { ... animation: none !important; transition: none !important; }` so reduced-motion users get instant transitions.

Patterns:
- **Entry from a class** (FAB appearing, tile picker opening): add the class when you create the element, then call `playEnter(el, cls)`. It forces a reflow and then strips the class, so the transition runs from the class state back to the base state. Without the reflow, the browser collapses both class changes into one paint and the transition never fires.
- **Leave to a class** (FAB disappearing, tile picker closing): call `playLeave(el, cls, done)`. It adds the class, listens for `transitionend`, and falls back to a 300ms timer in case the transition is suppressed (reduced motion, or a `display: none` ancestor).
- **One-shot keyframe pulse** (chip toggle feedback): `pulseChip(el)` removes any existing pulse class, forces a reflow via `forceReflow(el)`, then re-adds the class. It cleans up on `animationend`.
- **Modal open/close**: handled by CSS keyframes on `.modal-backdrop` (fade) and `.modal-backdrop > .modal` (scale from 0.96 to 1). Close adds `.closing`, which fills forward to the leaving state.
- **Tab fade**: `.modal [data-panel]:not([hidden]) { animation: tab-fade-in 160ms; }`. Runs whenever a panel becomes visible.

Don't animate map view changes that come from settings - those are explicit user actions, not UI flourishes.

## App-level banners

Two sticky banners sit between the nav and the app content, both styled by `.pwa-banner`:
- **Offline banner** (`#pwa-offline-banner`, `.offline`): visible whenever `!navigator.onLine`. Read-only mode is implicit; mutating API calls surface `You're offline. Changes not saved.` from the `api()` helper.
- **Update banner** (`#pwa-update-banner`): visible when a new service worker is waiting. The Reload button posts `SKIP_WAITING` to the worker; once it activates, `controllerchange` triggers a single page reload.

Banners use `position: sticky; top: 50px` so they sit directly under the nav and stay pinned while scrolling. Use this pattern (not a modal) for ambient state the user should be aware of without it interrupting their flow.
