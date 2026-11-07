import {
  assignCategoryColors, assignPlaceSlugs, assignTrailSlugs, escapeHtml, state,
} from './core.js';
import { effect, untracked } from '@preact/signals';
import * as store from './store.js';
import { areaHasGeometry } from './area-geo.js';
import { syncAreasOnMap } from './areas.js';
import { closeTopModal, modalStack, openSheetModal, popoverHost } from './modal.js';

// The native option list is OS-rendered and can't take the app's theme, so
// we keep the real <select> as the trigger and render our own listbox over
// it. The <select> stays the source of truth: choosing an option writes its
// value and fires `change`, so every existing reader (selectOrNew, settings,
// filters) is unaffected.
export const _selectCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
export let _selPopover = null;
let _selPopoverTeardown = null;

export function closeSelectPopover() {
  if (_selPopover && _selPopover.parentElement) _selPopover.parentElement.removeChild(_selPopover);
  _selPopover = null;
  if (_selPopoverTeardown) { _selPopoverTeardown(); _selPopoverTeardown = null; }
}

// Focusing a <select> opens the native picker on iOS, and on touch the list
// needs the room an open keyboard takes.
function focusSelectTrigger(sel) {
  if (!_selectCoarsePointer) { sel.focus(); return; }
  if (document.activeElement) /** @type {HTMLElement} */ (document.activeElement).blur();
}
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

export function enhanceSelectsIn(container) {
  if (!container) return;
  // Filter popovers use the dimension noun as the first ("all") option,
  // which doubles as the closed-state label. Hide it from the open list so
  // it isn't offered as a pickable value (reset a filter via "Clear
  // filters"); keep it selected so it still shows as the closed label.
  container.querySelectorAll('.filter-popover select').forEach(function(s) {
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
function makeListCursor(optEls, start, skip) {
  let activeIdx = start;
  const setActive = i => {
    if (i < 0 || i >= optEls.length) return;
    if (optEls[activeIdx]) optEls[activeIdx].classList.remove('active');
    activeIdx = i;
    optEls[activeIdx].classList.add('active');
    optEls[activeIdx].scrollIntoView({ block: 'nearest' });
  };
  const moveActive = dir => {
    let i = activeIdx;
    for (let n = 0; n < optEls.length; n++) {
      i = (i + dir + optEls.length) % optEls.length;
      if (!skip || !skip(i)) { setActive(i); return; }
    }
  };
  return { setActive, moveActive, index: () => activeIdx };
}

// Anchor a popover under its control, flipping above when there's no room.
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
function armSelectPopover(pop, anchor, onKey, onClose) {
  const onOutside = e => { if (_selPopover && !_selPopover.contains(e.target) && e.target !== anchor) closeSelectPopover(); };
  const onScroll = e => { if (_selPopover && _selPopover.contains(e.target)) return; closeSelectPopover(); };
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
export function openMultiSelectList(anchor, options, getSelected, onToggle) {
  closeSelectPopover();
  if (!options || !options.length) return;
  const pop = document.createElement('div');
  pop.className = 'select-popover';
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-multiselectable', 'true');
  const chosen = new Set((getSelected() || []).map(String));
  const optEls = [];
  const { setActive, moveActive, index: activeIdx } = makeListCursor(optEls, 0);
  const toggle = i => {
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
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSelectPopover(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveActive(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(activeIdx()); }
    else if (e.key === 'Tab') { e.stopPropagation(); closeSelectPopover(); }
  };
  armSelectPopover(pop, anchor, onKey, () => anchor.setAttribute('aria-expanded', 'false'));
}

function openSelectList(sel) {
  closeSelectPopover();
  if (sel.disabled) return;
  const options = Array.from(sel.options).filter(o => !o.hidden);
  if (!options.length) return;
  const pop = document.createElement('div');
  pop.className = 'select-popover';
  pop.setAttribute('role', 'listbox');
  const optEls = [];
  let start = options.findIndex(o => o.value === sel.value);
  if (start < 0) start = options.findIndex(o => !o.disabled);
  if (start < 0) start = 0;
  const { setActive, moveActive, index: activeIdx } = makeListCursor(optEls, start, i => options[i].disabled);
  const choose = i => {
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

  let typeBuf = '', typeTimer = null;
  const onKey = e => {
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
export function modalHeaderHtml(title, opts) {
  const o = opts || {};
  const lead = o.tabsHtml
    ? o.tabsHtml
    : '<h2 class="ui-dialog-title">' + (o.titleHtml != null ? o.titleHtml : escapeHtml(title)) + '</h2>';
  return '<div class="ui-dialog-head">' + lead +
    '<button type="button" class="ui-button ui-button-quiet ui-dialog-close modal-close" aria-label="Close">&times;</button>' +
  '</div>';
}

// The empty error box every form modal toggles via `.visible`.
export function modalErrorHtml(id) {
  return '<div class="modal-error" id="' + id + '"></div>';
}

// A null id labels a group of controls, which a <label for> can't point at.
export function uiFieldHtml(id, label, control, opts) {
  const labelClass = 'ui-field-label' + (opts && opts.required ? ' ui-required' : '');
  const labelHtml = id
    ? '<label class="' + labelClass + '" for="' + id + '">' + label + '</label>'
    : '<span class="' + labelClass + '">' + label + '</span>';
  return '<div class="ui-field">' + labelHtml + control + '</div>';
}

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
    let onEnter = null;
    const finish = ok => {
      if (settled) return;
      settled = true;
      if (onEnter) document.removeEventListener('keydown', onEnter, true);
      closeTopModal();
      resolve(ok);
    };
    const html =
      modalHeaderHtml(title) +
      '<div class="confirm-row">' +
        (body ? '<div class="modal-desc">' + escapeHtml(body) + '</div>' : '') +
        '<button type="button" class="ui-button ' + (danger ? 'ui-button-danger' : 'ui-button-primary') + '" data-role="ok">' + escapeHtml(confirmLabel || 'Confirm') + '</button>' +
      '</div>';
    openSheetModal(html, backdrop => {
      backdrop.classList.add('narrow-dialog');
      backdrop.querySelector('[data-role="ok"]').addEventListener('click', () => finish(true));
      // Enter to confirm: only while this confirm is the topmost modal.
      onEnter = e => {
        if (e.key !== 'Enter') return;
        if (modalStack[modalStack.length - 1] && modalStack[modalStack.length - 1].backdrop !== backdrop) return;
        e.preventDefault();
        finish(true);
      };
      document.addEventListener('keydown', onEnter, true);
    }, () => finish(false));
  });
}

// The store's signals are the data; state holds the copies the views read,
// with the slugs, colours and defaults they hang on them. These effects
// keep the two in step, so a write (or a sync) updates state before the
// promise it returns resolves, with no re-fetch.
export function bindStoreToState() {
  store.bindAuth();
  // Place colours come from the labels, so this one reads both.
  effect(() => {
    const data = store.places.value;
    const labels = store.labels.value;
    untracked(() => {
      if (state.config) state.config.category_labels = labels;
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
      for (const a of state.areas) { if (a.category == null) a.category = ''; }
      recolor();
      // The layers hold the area objects, so they are rebuilt from the new ones.
      syncAreasOnMap();
    });
  });
  effect(() => {
    const data = store.routes.value;
    untracked(() => {
      for (const region of data.regions) region.routes.sort((a, b) => a.name.localeCompare(b.name));
      data.regions.sort((a, b) => a.name.localeCompare(b.name));
      state.manifest = data;
      assignTrailSlugs(state.manifest);
      syncAreasOnMap();
    });
  });
}
function recolor() {
  const cc = assignCategoryColors(state.places || []);
  state.categoryColors = cc.dark;
  state.categoryColorsLight = cc.light;
}
