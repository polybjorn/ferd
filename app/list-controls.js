import { addButton, state } from './core.js';
import { isReadOnly } from './server.js';
import { listKinds, setPref } from './prefs.js';
import { _selPopover, closeSelectPopover, enhanceSelectsIn, openMultiSelectList } from './select.js';
import { listView, listViewOptions } from './history.js';
import { html, usePageVisit, useEffect, useLayoutEffect, useRef, useState } from './view.js';
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
  const visit = usePageVisit();
  useEffect(() => {
    const nav = document.getElementById('nav-actions');
    if (!nav || !canAdd) return;
    const btn = addButton(id, title);
    btn.addEventListener('click', onClick);
    nav.replaceChildren(btn);
    // Only its own button: the cleanup can run after the next page has put
    // its Add in, and clearing the row would take that one too.
    return () => { btn.remove(); };
  }, [canAdd, visit]);
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
 * page. A wide screen has them in the nav. A phone hides the nav brand, the
 * wide screen's h1, so there the current tab is the page's h1. With one list
 * there is nothing to switch to, and its name alone is the h1.
 * @param {{ current: string }} props
 */
export function ListTabs({ current }) {
  const kinds = listKinds();
  if (kinds.length < 2) return html`<h1 class="phone-title">${t(LIST_LABELS[current])}</h1>`;
  return html`<nav class="list-tabs" aria-label=${t('lists.tabs')}>
    ${kinds.map(k => k === current
      ? html`<h1 key=${k} class="list-tab-heading"><a class="list-tab" href=${'#/' + k} aria-current="page">${t(LIST_LABELS[k])}</a></h1>`
      : html`<a key=${k} class="list-tab" href=${'#/' + k}>${t(LIST_LABELS[k])}</a>`)}
  </nav>`;
}

// The popover's open state lives in the DOM (hidden), because ui.js opens
// and closes it from the button's aria-controls. Preact renders hidden and
// aria-expanded once and never rewrites them.
/** @param {Record<string, any>} props */
function FilterPopover({ active, onClear, children }) {
  return html`<div class="filter-dropdown ui-menu-anchor">
    <button type="button" class=${'filter-btn' + (active ? ' has-active' : '')} id="filter-btn" aria-expanded="false" aria-controls="filter-popover">${t('lists.filters')}</button>
    <div class="filter-popover ui-popover ui-menu-end" id="filter-popover" role="group" aria-label=${t('lists.filters')} hidden>
      ${children}
      <button type="button" class="filter-clear" id="filter-clear" onClick=${onClear}>${t('lists.clearFilters')}</button>
    </div>
  </div>`;
}

// ui.js opens, closes and moves through the menu from this markup and checks
// the chosen item, so a pick only has to store the view.
/** @param {{ kind: string, onView: () => void }} props */
function ViewPopover({ kind, onView }) {
  const cur = listView(kind);
  return html`<div class="filter-dropdown ui-menu-anchor">
    <button type="button" class="filter-btn" id="view-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="view-popover">${t('lists.view')}</button>
    <div class="ui-menu ui-menu-end" id="view-popover" role="menu" aria-label=${t('lists.view')} hidden>
      ${listViewOptions(kind).map(o => html`<button type="button" key=${o[0]} class="ui-menu-item" role="menuitemradio" aria-checked=${cur === o[0] ? 'true' : 'false'} data-view=${o[0]} onClick=${() => {
        setPref(kind + '-view', o[0]);
        onView();
      }}>${o[1]}</button>`)}
    </div>
  </div>`;
}

/**
 * A filter select whose first option names the dimension and doubles as the
 * closed label. It stays out of the open list; "Clear filters" resets it.
 */
/** @param {Record<string, any>} props */
export function FilterSelect({ id, value, onChange, label, children }) {
  return html`<div class="ui-field"><select id=${id} class=${value !== 'all' ? 'filter-active' : ''} value=${value}
    onChange=${(/** @type {Event} */ e) => onChange(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
    <option value="all" hidden>${label}</option>
    ${children}
  </select></div>`;
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
