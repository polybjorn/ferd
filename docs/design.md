# Design conventions

Atlas is a single-file frontend (`index.html`) with no framework, plus a small Python API. The patterns below are repo-wide; when adding UI, reuse existing selectors and behaviors rather than inventing new ones.

## Modal anatomy

- Title row: `<h2>Title<button class="modal-close">&times;</button></h2>`. The X in the corner (and Esc) closes the modal. Modals do not have a second "Close" button at the bottom.
- Tabs: `<div class="modal-tabs">` with `<button data-tab="X">` children. Panels are `<div data-panel="X">` toggled via the `hidden` attribute. Render all panel content at openModal time so wired event handlers stay attached across tab switches.
- Section headers inside a modal: `<h3 class="settings-h">`. Always noun phrases ("Sharing", "Backup", "Password") - never verb phrases ("Publish my map").
- Section descriptions: `<div class="modal-desc">` (regular text color, 0.85rem). Do not use `.hint` (muted gray) inside settings; reserve `.hint` for low-priority asides outside the settings flow.

## Buttons

| Class | Use for |
|---|---|
| `.primary` | The main action of a section (Export, Import, Change password). Filled accent background. |
| (default modal `<button>`) | Secondary actions (Choose file, Manage categories). Outlined. |
| `.sessions-revoke-others`-style | Inline text-link buttons next to a section header. Transparent, no border, underline on hover. |

Placement:

- Form-bottom submits live in `<div class="modal-actions">` (right-aligned, top margin).
- Description+button or input+button pairs use inline flex rows. `.modal-actions` is for standalone form-end submits, not for everything.

## Forms and inputs

- Standard inputs use a `<label>` block above the input. Helper text goes in `.modal-desc` below the input.
- File pickers: hide the native input with `.file-input-hidden`, render a `<button>Choose file</button>` plus a `.file-name` span (muted "No file selected" -> text-colored filename on selection). See Backup -> Import in the Account tab for the canonical example.
- Settings input types:
  - Pills (`.feature-pill`) for binary on/off toggles where the active state needs to read at a glance.
  - Radios for small fixed sets (2-3 options).
  - Dropdowns for growing or many-option selects.

## Status feedback

- `.modal-error` for failures: red box, toggled by adding the `.visible` class.
- `.modal-success` for confirmations: green text, toggled by the `hidden` attribute. Pair with clearing the relevant inputs so the message reads as the new resting state.
- Don't put transient confirmation in a button label alone (e.g. flashing "Saved" for 2s) - easy to miss.

## Specificity gotcha

The generic rule `.modal button:not(h2 .modal-close)` has specificity (0,2,2) because `:not()` takes the highest specificity of its argument. When styling nested buttons (tab buttons, primary buttons, inline link buttons) you need a matching or higher-specificity selector. The established trick is to repeat the `:not(h2 .modal-close)` clause on your selector. Examples:

```css
.modal .modal-tabs button:not(h2 .modal-close) { ... }
.modal button.primary:not(h2 .modal-close) { ... }
.modal button.sessions-revoke-others:not(h2 .modal-close) { ... }
```

Without this, your styles will silently lose to the generic outlined-button look.

## Themes and colors

Atlas supports multiple color themes x light/dark modes (see [themes.md](themes.md)). Always reference colors through CSS variables (`--text`, `--muted`, `--accent`, `--border`, `--surface`, `--surface2`, `--red`, `--green`, etc.) - never hardcode hex values in component CSS.

## UI copy

- Section headers: short noun phrases. "Sharing", not "Sharing settings".
- Buttons: imperative verbs. "Export", "Import", "Change password".
- Descriptions: state what the section contains, not what the button does. Skip "Click to..." prefixes.
- Avoid em dashes (`-`), en dashes (`-`), and unicode arrows (`->`, `<-`); use plain hyphens and `->`.

## Settings modal specifics

- Tabs: General, Appearance, Account, Admin (operator-only).
- Each panel has `min-height: 500px` so switching tabs doesn't shift the modal vertically.
- The backdrop reserves `padding-top: 3rem; padding-bottom: 3rem` so the centered modal has breathing room on both edges.

## Where to extend this guide

When a new repeating pattern emerges - a new modal section type, a new feedback style, a new button variant - capture it here in the same shape (selector, when to use, example). The goal is to keep `index.html` consistent over time without re-deriving conventions every session.
