import {
  assignCategoryColors, assignPlaceSlugs, assignTrailSlugs, escapeHtml, state,
} from './core.js';
import { areaHasGeometry } from './area-geo.js';
import { closeTopModal, modalStack, popoverHost } from './modal.js';
import { DialogHead, html, openViewModal } from './view.js';
import { t } from './i18n.js';
import { effect, untracked } from '@preact/signals';
import * as store from './store.js';

// The native option list is OS-rendered and can't take the app's theme, so
// we keep the real <select> as the trigger and render our own listbox over
// it. The <select> stays the source of truth: choosing an option writes its
// value and fires `change`, so every existing reader (selectOrNew, settings,
// filters) is unaffected.
export const _selectCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
export let _selPopover = /** @type {HTMLElement | null} */ (null);
let _selPopoverTeardown = /** @type {(() => void) | null} */ (null);

export function closeSelectPopover() {
  if (_selPopover && _selPopover.parentElement) _selPopover.parentElement.removeChild(_selPopover);
  _selPopover = null;
  if (_selPopoverTeardown) { _selPopoverTeardown(); _selPopoverTeardown = null; }
}

// Focusing a <select> opens the native picker on iOS, and on touch the list
// needs the room an open keyboard takes.
/** @param {HTMLSelectElement} sel */
function focusSelectTrigger(sel) {
  if (!_selectCoarsePointer) { sel.focus(); return; }
  if (document.activeElement) /** @type {HTMLElement} */ (document.activeElement).blur();
}
/** @param {HTMLSelectElement} sel */
function enhanceSelect(sel) {
  if (sel.dataset.enhanced === '1' || sel.disabled) return;
  sel.dataset.enhanced = '1';
  sel.addEventListener('mousedown', e => {
    e.preventDefault();
    if (_selPopover) { closeSelectPopover(); return; }
    focusSelectTrigger(sel);
    openSelectList(sel);
  });
  sel.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) {
      e.preventDefault();
      if (!_selPopover) openSelectList(sel);
    }
  });
}

/** @param {ParentNode | null | undefined} container */
export function enhanceSelectsIn(container) {
  if (!container) return;
  // Filter popovers use the dimension noun as the first ("all") option,
  // which doubles as the closed-state label. Hide it from the open list so
  // it isn't offered as a pickable value (reset a filter via "Clear
  // filters"); keep it selected so it still shows as the closed label.
  /** @type {NodeListOf<HTMLSelectElement>} */ (container.querySelectorAll('.filter-popover select')).forEach(function(s) {
    const first = s.options[0];
    if (first && first.value === 'all') {
      first.hidden = true;
      if (s.value === 'all') first.selected = true;
    }
  });
  container.querySelectorAll('select').forEach(enhanceSelect);
}

// Keyboard cursor over a themed list's option elements. `skip(i)` marks
// options that can be hovered but not landed on by the arrow keys.
/**
 * @param {HTMLElement[]} optEls
 * @param {number} start
 * @param {(i: number) => boolean} [skip]
 */
function makeListCursor(optEls, start, skip) {
  let activeIdx = start;
  const setActive = (/** @type {number} */ i) => {
    if (i < 0 || i >= optEls.length) return;
    if (optEls[activeIdx]) optEls[activeIdx].classList.remove('active');
    activeIdx = i;
    optEls[activeIdx].classList.add('active');
    optEls[activeIdx].scrollIntoView({ block: 'nearest' });
  };
  const moveActive = (/** @type {number} */ dir) => {
    let i = activeIdx;
    for (let n = 0; n < optEls.length; n++) {
      i = (i + dir + optEls.length) % optEls.length;
      if (!skip || !skip(i)) { setActive(i); return; }
    }
  };
  return { setActive, moveActive, index: () => activeIdx };
}

// Anchor a popover under its control, flipping above when there's no room.
/**
 * @param {HTMLElement} pop
 * @param {HTMLElement} anchor
 */
function positionSelectPopover(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  pop.style.minWidth = r.width + 'px';
  const ph = pop.getBoundingClientRect().height;
  let top = r.bottom + 4;
  if (top + ph > vh - 8 && r.top - ph - 4 >= 8) top = r.top - ph - 4;
  pop.style.top = Math.max(8, Math.min(top, vh - ph - 8)) + 'px';
  const pw = pop.getBoundingClientRect().width;
  pop.style.left = Math.max(8, Math.min(r.left, vw - pw - 8)) + 'px';
}

// Claim the single popover slot and close it on outside press, scroll
// outside it or blur. A resize only moves it, since a phone keyboard closing
// or the URL bar sliding away resizes the page. The listeners attach on the
// next tick so the press that opened it doesn't close it. onKey runs
// capture-phase.
/**
 * @param {HTMLElement} pop
 * @param {HTMLElement} anchor
 * @param {(e: KeyboardEvent) => void} onKey
 * @param {() => void} [onClose]
 */
function armSelectPopover(pop, anchor, onKey, onClose) {
  const onOutside = (/** @type {Event} */ e) => { if (_selPopover && !_selPopover.contains(/** @type {Node} */ (e.target)) && e.target !== anchor) closeSelectPopover(); };
  const onScroll = (/** @type {Event} */ e) => { if (_selPopover && _selPopover.contains(/** @type {Node} */ (e.target))) return; closeSelectPopover(); };
  const onResize = () => positionSelectPopover(pop, anchor);
  _selPopover = pop;
  setTimeout(() => {
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', closeSelectPopover);
  }, 0);
  _selPopoverTeardown = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', closeSelectPopover);
    if (onClose) onClose();
  };
}

// Multi-pick variant of the themed listbox: options toggle a checkbox and
// the popover stays open. `anchor` is the trigger button; `onToggle` gets
// the new selected-array after each toggle. Reuses the single-popover slot
// so only one themed list is ever open.
/**
 * @param {HTMLElement} anchor
 * @param {string[]} options
 * @param {() => string[] | null | undefined} getSelected
 * @param {(selected: string[]) => void} onToggle
 */
export function openMultiSelectList(anchor, options, getSelected, onToggle) {
  closeSelectPopover();
  if (!options || !options.length) return;
  const pop = document.createElement('div');
  pop.className = 'select-popover';
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-multiselectable', 'true');
  const chosen = new Set((getSelected() || []).map(String));
  /** @type {HTMLElement[]} */
  const optEls = [];
  const { setActive, moveActive, index: activeIdx } = makeListCursor(optEls, 0);
  const toggle = (/** @type {number} */ i) => {
    const v = options[i];
    if (chosen.has(v)) chosen.delete(v); else chosen.add(v);
    const on = chosen.has(v);
    optEls[i].classList.toggle('checked', on);
    optEls[i].setAttribute('aria-selected', on ? 'true' : 'false');
    onToggle(options.filter(o => chosen.has(o)));
  };
  options.forEach((o, i) => {
    const el = document.createElement('div');
    el.className = 'select-option select-option-multi' + (chosen.has(o) ? ' checked' : '');
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', chosen.has(o) ? 'true' : 'false');
    el.textContent = o;
    el.addEventListener('mousemove', () => { if (activeIdx() !== i) setActive(i); });
    el.addEventListener('click', ev => { ev.stopPropagation(); toggle(i); });
    pop.appendChild(el);
    optEls.push(el);
  });
  popoverHost().appendChild(pop);
  positionSelectPopover(pop, anchor);
  if (optEls[0]) optEls[0].classList.add('active');
  anchor.setAttribute('aria-expanded', 'true');
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSelectPopover(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveActive(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(activeIdx()); }
    else if (e.key === 'Tab') { e.stopPropagation(); closeSelectPopover(); }
  };
  armSelectPopover(pop, anchor, onKey, () => anchor.setAttribute('aria-expanded', 'false'));
}

/** @param {HTMLSelectElement} sel */
function openSelectList(sel) {
  closeSelectPopover();
  if (sel.disabled) return;
  const options = Array.from(sel.options).filter(o => !o.hidden);
  if (!options.length) return;
  const pop = document.createElement('div');
  pop.className = 'select-popover';
  pop.setAttribute('role', 'listbox');
  /** @type {HTMLElement[]} */
  const optEls = [];
  let start = options.findIndex(o => o.value === sel.value);
  if (start < 0) start = options.findIndex(o => !o.disabled);
  if (start < 0) start = 0;
  const { setActive, moveActive, index: activeIdx } = makeListCursor(optEls, start, i => options[i].disabled);
  const choose = (/** @type {number} */ i) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (sel.value !== o.value) {
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeSelectPopover();
    focusSelectTrigger(sel);
  };

  options.forEach((o, i) => {
    const el = document.createElement('div');
    el.className = 'select-option';
    el.setAttribute('role', 'option');
    el.textContent = o.dataset.listLabel || o.textContent;
    if (o.disabled) el.classList.add('disabled');
    if (o.value === sel.value) el.setAttribute('aria-selected', 'true');
    el.addEventListener('mousemove', () => { if (activeIdx() !== i) setActive(i); });
    // Stop the click from bubbling to document, where an enclosing popover's
    // outside-click closer (e.g. the Filters popover) would otherwise close.
    el.addEventListener('click', (ev) => { ev.stopPropagation(); choose(i); });
    pop.appendChild(el);
    optEls.push(el);
  });

  popoverHost().appendChild(pop);
  positionSelectPopover(pop, sel);

  optEls[activeIdx()].classList.add('active');
  optEls[activeIdx()].scrollIntoView({ block: 'nearest' });

  let typeBuf = '', typeTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    // Capture-phase: own the keyboard while open and stop propagation so the
    // handled key never reaches the select's own keydown (which would reopen).
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSelectPopover(); sel.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveActive(-1); }
    else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); setActive(0); if (options[activeIdx()].disabled) moveActive(1); }
    else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); setActive(optEls.length - 1); if (options[activeIdx()].disabled) moveActive(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); choose(activeIdx()); }
    else if (e.key === 'Tab') { e.stopPropagation(); closeSelectPopover(); }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.stopPropagation();
      typeBuf += e.key.toLowerCase();
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { typeBuf = ''; }, 600);
      for (let n = 1; n <= optEls.length; n++) {
        const i = (activeIdx() + n) % optEls.length;
        const lbl = (options[i].dataset.listLabel || options[i].textContent).toLowerCase();
        if (!options[i].disabled && lbl.startsWith(typeBuf)) { setActive(i); break; }
      }
    }
  };
  armSelectPopover(pop, sel, onKey);
}

// Every modal's head row: the title, or the Add modal's tabs, and the
// close button. The title is escaped; opts.titleHtml is markup for a title
// that carries more than text (the catalog manager's count).
/**
 * @param {string} title
 * @param {{ tabsHtml?: string, titleHtml?: string | null }} [opts]
 */
export function modalHeaderHtml(title, opts) {
  const o = opts || {};
  const lead = o.tabsHtml
    ? o.tabsHtml
    : '<h2 class="ui-dialog-title">' + (o.titleHtml != null ? o.titleHtml : escapeHtml(title)) + '</h2>';
  return '<div class="ui-dialog-head">' + lead +
    '<button type="button" class="ui-button ui-button-quiet ui-dialog-close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>' +
  '</div>';
}

// The empty error box every form modal toggles via `.visible`.
/** @param {string} id */
export function modalErrorHtml(id) {
  return '<div class="form-error" id="' + id + '"></div>';
}

// A null id labels a group of controls, which a <label for> can't point at.
/**
 * @param {string | null} id
 * @param {string} label
 * @param {string} control
 * @param {{ required?: boolean }} [opts]
 */
export function uiFieldHtml(id, label, control, opts) {
  const labelClass = 'ui-field-label' + (opts && opts.required ? ' ui-required' : '');
  const labelHtml = id
    ? '<label class="' + labelClass + '" for="' + id + '">' + label + '</label>'
    : '<span class="' + labelClass + '">' + label + '</span>';
  return '<div class="ui-field">' + labelHtml + control + '</div>';
}

/**
 * @param {string} id
 * @param {string} label
 * @param {{ title?: string, checked?: boolean }} [opts]
 */
export function uiToggleHtml(id, label, opts) {
  const o = opts || {};
  return '<label class="ui-toggle-row"' + (o.title ? ' title="' + escapeHtml(o.title) + '"' : '') + '>' +
    '<span class="ui-toggle-text">' + label + '</span>' +
    '<input type="checkbox" id="' + id + '"' + (o.checked ? ' checked' : '') + '>' +
  '</label>';
}

/**
 * @param {{ title: string, body?: string, confirmLabel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function openConfirmModal({ title, body, confirmLabel, danger }) {
  return new Promise(resolve => {
    let settled = false;
    let onEnter = /** @type {((e: KeyboardEvent) => void) | null} */ (null);
    const finish = (/** @type {boolean} */ ok) => {
      if (settled) return;
      settled = true;
      if (onEnter) document.removeEventListener('keydown', onEnter, true);
      closeTopModal();
      resolve(ok);
    };
    // A sheet's handle is the dialog's first child, which a view renders itself.
    const dialog = openViewModal(html`
      <div class="ui-dialog-handle" aria-hidden="true"></div>
      <${DialogHead} title=${title} />
      <div class="ui-dialog-body"><div class="confirm-row">
        ${body ? html`<div class="dialog-desc">${body}</div>` : null}
        <button type="button" class=${'ui-button ' + (danger ? 'ui-button-danger' : 'ui-button-primary')} data-role="ok" onClick=${() => finish(true)}>${confirmLabel || t('common.confirm')}</button>
      </div></div>`, { phone: 'sheet' }, () => finish(false));
    dialog.classList.add('narrow-dialog');
    // Enter to confirm: only while this confirm is the topmost modal.
    onEnter = (/** @type {KeyboardEvent} */ e) => {
      if (e.key !== 'Enter') return;
      if (modalStack[modalStack.length - 1] && modalStack[modalStack.length - 1].backdrop !== dialog) return;
      e.preventDefault();
      finish(true);
    };
    document.addEventListener('keydown', onEnter, true);
  });
}

// The store's signals are the data; state holds the copies the views read,
// with the slugs, colours and defaults they hang on them. These effects
// keep the two in step, so a write (or a sync) updates state before the
// promise it returns resolves, with no re-fetch.
export function bindStoreToState() {
  store.bindAuth();
  store.bindCatalogCache();
  // Place colours come from the labels, so this one reads both, and runs
  // again when a sync settles so the colours assigned meanwhile are saved.
  effect(() => {
    const data = store.places.value;
    store.labels.value;
    store.syncSettled.value;
    untracked(() => {
      // A missing category is the "uncategorized" bucket (key ''), so the
      // rest of the UI can treat p.category as a plain string.
      for (const p of data) { if (p.category == null) p.category = ''; }
      state.places = data;
      assignPlaceSlugs(state.places);
      recolor();
    });
  });
  effect(() => {
    const data = store.areas.value;
    untracked(() => {
      state.areas = data.filter(areaHasGeometry);
      for (const a of /** @type {import('./core.js').Area[]} */ (state.areas)) { if (a.category == null) a.category = ''; }
      recolor();
    });
  });
  effect(() => {
    const data = /** @type {import('./core.js').Manifest} */ (store.routes.value);
    untracked(() => {
      for (const region of data.regions) region.routes.sort((a, b) => a.name.localeCompare(b.name));
      data.regions.sort((a, b) => a.name.localeCompare(b.name));
      state.manifest = data;
      assignTrailSlugs(state.manifest);
    });
  });
}
function recolor() {
  // Read here, not in the places effect: the areas effect can run first in
  // the same batch, and a colour assigned against a stale copy is saved as
  // the whole label map, deleting every label it lacks.
  if (state.config) state.config.category_labels = store.labels.peek();
  const cc = assignCategoryColors(state.places || []);
  state.categoryColors = cc.dark;
  state.categoryColorsLight = cc.light;
}
