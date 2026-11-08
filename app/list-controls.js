import { addButton, state } from './core.js';
import { isReadOnly } from './server.js';
import { listKinds, setPref } from './prefs.js';
import { wirePopover } from './map/index.js';
import { _selPopover, closeSelectPopover, enhanceSelectsIn, openMultiSelectList } from './select.js';
import { listView, listViewOptions } from './history.js';
import { html, useEffect, useLayoutEffect, useRef, useState } from './view.js';
import { t } from './i18n.js';

// Controls the list pages share: the search box, the filter and view
// popovers, the Add button in the nav, and the phone's Lists tabs.

/**
 * A filters object kept on `state`, so the page remembers it when it is left
 * and opened again. Patching it re-renders the page.
 * @template T
 * @param {T} filters
 * @returns {[T, (patch: Partial<T>) => void]}
 */
export function useFilters(filters) {
  const [, bump] = useState(0);
  return [filters, patch => { Object.assign(/** @type {any} */ (filters), patch); bump((/** @type {number} */ n) => n + 1); }];
}

/** The list-page Add button, in the nav while the signed-in user can edit. */
/** @param {string} id @param {string} title @param {() => void} onClick */
export function useNavAdd(id, title, onClick) {
  const canAdd = !!(state.auth && state.auth.authenticated) && !isReadOnly();
  useEffect(() => {
    const nav = document.getElementById('nav-actions');
    if (!nav || !canAdd) return;
    const btn = addButton(id, title);
    btn.addEventListener('click', onClick);
    nav.replaceChildren(btn);
    return () => { nav.replaceChildren(); };
  }, [canAdd]);
  return canAdd;
}

/**
 * The index-controls row. Children are the search wrap's neighbours (a
 * chip, say); the filter and view popovers follow.
 */
/** @param {Record<string, any>} props */
export function IndexControls({ placeholder, search, onSearch, count, kind, onView, active, onClear, filterChildren, children }) {
  const root = useRef(/** @type {HTMLDivElement | null} */ (null));
  // The themed select list is attached to each native select once; a select
  // that appears later (a country first used) gets it on the render it shows.
  useLayoutEffect(() => { enhanceSelectsIn(root.current); });
  return html`<div class="index-controls" ref=${root}>
    <div class="search-wrap">
      <input type="text" id="search-input" placeholder=${placeholder} value=${search} onInput=${(/** @type {Event} */ e) => onSearch(/** @type {HTMLInputElement} */ (e.currentTarget).value)} />
      <span class="result-count" id="result-count">${count}</span>
    </div>
    ${children}
    <${FilterPopover} active=${active} onClear=${onClear}>${filterChildren}<//>
    ${kind && html`<${ViewPopover} kind=${kind} onView=${onView} />`}
  </div>`;
}

/** A list group's category colour, which only the data knows. @param {{ category: string }} props */
export function CategoryDot({ category }) {
  const colour = (category && /** @type {Record<string, string>} */ (state.categoryColors)[category]) || 'var(--muted)';
  return html`<span class="group-color-dot" style=${'background:' + colour}></span>`;
}

const LIST_LABELS = /** @type {Record<string, string>} */ ({ places: 'lists.places', routes: 'lists.routes', areas: 'lists.areas' });
/**
 * A phone's bar has one Lists item, so the lists it holds are tabs on the
 * page. A wide screen has them in the nav. With one list there is nothing to
 * switch to.
 * @param {{ current: string }} props
 */
export function ListTabs({ current }) {
  const kinds = listKinds();
  if (kinds.length < 2) return null;
  return html`<nav class="list-tabs" aria-label=${t('lists.tabs')}>
    ${kinds.map(k => html`<a key=${k} class="list-tab" href=${'#/' + k} aria-current=${k === current ? 'page' : undefined}>${t(LIST_LABELS[k])}</a>`)}
  </nav>`;
}

// The popover's open state lives in the DOM (hidden), because wirePopover and
// the map's overlay closer toggle it there. Preact renders hidden and
// aria-expanded once and never rewrites them.
/** @param {Record<string, any>} props */
function FilterPopover({ active, onClear, children }) {
  const btn = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const pop = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => wirePopover(btn.current, pop.current), []);
  return html`<div class="filter-dropdown">
    <button type="button" class=${'filter-btn' + (active ? ' has-active' : '')} id="filter-btn" aria-haspopup="true" aria-expanded="false" ref=${btn}>${t('lists.filters')}</button>
    <div class="filter-popover" id="filter-popover" hidden ref=${pop}>
      ${children}
      <button type="button" class="filter-clear" id="filter-clear" onClick=${onClear}>${t('lists.clearFilters')}</button>
    </div>
  </div>`;
}

/** @param {{ kind: string, onView: () => void }} props */
function ViewPopover({ kind, onView }) {
  const btn = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const pop = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => wirePopover(btn.current, pop.current), []);
  const cur = listView(kind);
  /** @param {string} v */
  const pick = v => {
    setPref(kind + '-view', v);
    if (pop.current) pop.current.hidden = true;
    if (btn.current) btn.current.setAttribute('aria-expanded', 'false');
    onView();
  };
  return html`<div class="filter-dropdown">
    <button type="button" class="filter-btn" id="view-btn" aria-haspopup="true" aria-expanded="false" ref=${btn}>${t('lists.view')}</button>
    <div class="filter-popover" id="view-popover" hidden ref=${pop}>
      ${listViewOptions(kind).map(o => html`<button type="button" key=${o[0]} class=${'view-option' + (cur === o[0] ? ' active' : '')} data-view=${o[0]} onClick=${() => pick(o[0])}>${o[1]}</button>`)}
    </div>
  </div>`;
}

/**
 * A filter select whose first option names the dimension and doubles as the
 * closed label. It stays out of the open list; "Clear filters" resets it.
 */
/** @param {Record<string, any>} props */
export function FilterSelect({ id, value, onChange, label, children }) {
  return html`<select id=${id} class=${value !== 'all' ? 'filter-active' : ''} value=${value}
    onChange=${(/** @type {Event} */ e) => onChange(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
    <option value="all" hidden>${label}</option>
    ${children}
  </select>`;
}

/** The tag multi-select button; the list itself is the themed popover. */
/** @param {{ options: string[], filters: any, onChange: (tags: string[]) => void }} props */
export function TagFilterButton({ options, filters, onChange }) {
  const sel = filters.tags || [];
  /** @param {MouseEvent} e */
  const open = e => {
    e.preventDefault();
    if (_selPopover) { closeSelectPopover(); return; }
    openMultiSelectList(/** @type {HTMLElement} */ (e.currentTarget), options, () => filters.tags || [], onChange);
  };
  return html`<button type="button" class=${'filter-ms-btn' + (sel.length ? ' filter-active' : '')} id="filter-tag-ms-btn"
    aria-haspopup="listbox" aria-expanded="false" onMouseDown=${open}>${sel.length ? sel.join(', ') : t('lists.tags')}</button>`;
}

/**
 * The options a select offers: the values in the data, plus the one the
 * filter holds when the data no longer has it, so the select never shows a
 * label that disagrees with the filter.
 * @param {string[]} values
 * @param {string} current
 */
export function withCurrent(values, current) {
  return current !== 'all' && !values.includes(current) ? values.concat([current]) : values;
}
