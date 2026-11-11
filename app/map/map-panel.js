import { state } from '../core.js';
import { placesEnabled, routesEnabled } from '../prefs.js';
import { bindFilterPanel, refreshFilterPanel } from './home-map.js';
import { initUnifiedSearch } from './place-layer.js';
import { _selPopover, closeSelectPopover, openMultiSelectList } from '../select.js';
import { wrappedRouter } from '../router.js';
import { html, renderFresh } from '../view.js';
import { t } from '../i18n.js';

/** @typedef {import('./route-layer.js').LeafletMap} LeafletMap */
/** @typedef {Record<string, any>} FilterState */
// The Browse page hands over plain HTMLElements, so `value` stays optional.
/** @typedef {HTMLElement & { value?: string }} ValueElement */
/**
 * @typedef {object} FilterPopoverOptions
 * @property {HTMLElement | null} [btn]
 * @property {HTMLElement | null} [clear]
 * @property {ValueElement[]} sels
 * @property {Record<string, string>} keyById
 * @property {FilterState} filters
 * @property {ValueElement | null} [searchInput]
 * @property {string} [searchKey]
 * @property {() => void} onApply
 * @property {string[]} [tagOptions]
 * @property {string} [tagsKey]
 * @property {HTMLElement | null} [tagMsBtn]
 */

// Wire a filter popover's contents: the active tint on the button,
// per-select change handlers that write into filters[keyById[id]], the
// search box, and a Clear button that resets every select + the search.
// onApply re-renders the list after any change/clear. ui.js opens and closes
// the popover itself from the button's aria-controls, and closes it on a
// press outside or Escape, so nothing here outlives the page.
/** @param {FilterPopoverOptions} opts */
export function wireFilterPopover(opts) {
  const { btn, clear, sels, keyById, filters, searchInput, searchKey, onApply, tagOptions, tagsKey, tagMsBtn } = opts;
  function tagsActive() { return !!(tagsKey && filters[tagsKey] && filters[tagsKey].length); }
  function syncTagLabel() {
    if (!tagMsBtn) return;
    const sel = (tagsKey && filters[tagsKey]) || [];
    tagMsBtn.textContent = sel.length ? sel.join(', ') : t('lists.tags');
    tagMsBtn.classList.toggle('filter-active', sel.length > 0);
  }
  function updateLabel() {
    let n = sels.reduce((/** @type {number} */ acc, s) => acc + (s.value !== 'all' ? 1 : 0), 0);
    if (tagsActive()) n += 1;
    if (btn) btn.classList.toggle('has-active', n > 0);
    // Tint each select that holds a non-default value, so an applied filter
    // reads as applied even with the popover closed.
    sels.forEach(s => s.classList.toggle('filter-active', s.value !== 'all'));
    syncTagLabel();
  }
  function apply() { onApply(); updateLabel(); }
  if (searchInput && searchKey) searchInput.addEventListener('input', /** @this {ValueElement} */ function() {
    filters[searchKey] = this.value;
    apply();
  });
  sels.forEach(s => s.addEventListener('change', function() {
    const k = keyById[s.id];
    if (k) filters[k] = s.value;
    apply();
  }));
  if (tagMsBtn && tagsKey && tagOptions && tagOptions.length) tagMsBtn.addEventListener('mousedown', function(/** @type {MouseEvent} */ e) {
    e.preventDefault();
    if (_selPopover) { closeSelectPopover(); return; }
    openMultiSelectList(tagMsBtn, tagOptions, () => filters[tagsKey] || [], function(arr) { filters[tagsKey] = arr; apply(); });
  });
  if (clear) clear.addEventListener('click', function() {
    const hasSearch = searchInput && searchInput.value !== '';
    const hasFilter = sels.some(s => s.value !== 'all') || tagsActive();
    if (!hasSearch && !hasFilter) return;
    sels.forEach(s => { s.value = 'all'; });
    for (const k of Object.values(keyById)) filters[k] = 'all';
    if (tagsKey) { filters[tagsKey] = []; closeSelectPopover(); }
    if (searchInput && searchKey) { searchInput.value = ''; filters[searchKey] = ''; }
    apply();
  });
  updateLabel();
}

const chevron = () => html`<span class="section-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>`;
const clearIcon = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

/** @param {string} id @param {string} label */
const panelHead = (id, label) =>
  html`<button type="button" class="ui-button ui-button-quiet panel-head" aria-expanded="false" aria-controls=${id + '-section'}>${label}${chevron()}</button>`;

/** @param {string} id */
const panelBody = id =>
  html`<div class="ui-collapse" id=${id + '-section'}><div class="ui-collapse-body"><div class="panel-section-body" id=${id + '-body'}></div></div></div>`;

// The filter panel's markup. The section bodies and the status row stay
// empty here: refreshFilterPanel fills them, ui.js opens and closes the
// sections from their heads, and bindFilterPanel keeps them an accordion.
// Rendered fresh when the control is first added and when a feature is
// toggled (which adds or removes a tab).
export function MapPanel() {
  return html`<div class="panel-search" id="map-search">
      <div class="ui-field"><form class="ui-search" method="dialog">
        <input type="search" id="map-search-input" aria-label=${t('mapSearch.label')} placeholder=${t('mapSearch.placeholder')} autocomplete="off" />
        <button class="ui-button ui-button-quiet ui-search-clear" type="reset" aria-label=${t('mapSearch.clear')}>${clearIcon()}</button>
      </form></div>
      <div class="map-search-results" id="map-search-results" role="listbox" aria-label=${t('mapSearch.results')}></div>
    </div>
    ${placesEnabled() ? panelBody('places') : null}
    ${routesEnabled() ? panelBody('routes') : null}
    <div class="panel-status" id="panel-status"></div>
    <div class="panel-heads">
      ${placesEnabled() ? panelHead('places', t('mapFilter.places')) : null}
      ${routesEnabled() ? panelHead('routes', t('mapFilter.routes')) : null}
    </div>`;
}

// A credit across a phone's map covers more than it needs to. OpenStreetMap's
// guidelines let it collapse on map interaction or after five seconds, so
// long as a corner button still finds it. Zooming is left to the pointer
// listener because fitBounds fires the same zoom events as a pinch, and would
// collapse the credit before anyone saw it. Only the phone rule acts on the
// class, so a wider window keeps the credit.
/** @param {LeafletMap} map */
export function collapseCreditOnPhone(map) {
  const container = map.getContainer();
  const credit = container.querySelector('.leaflet-control-attribution');
  const toggle = L.DomUtil.create('button', 'leaflet-control map-credit-toggle', credit.parentElement);
  toggle.type = 'button';
  toggle.textContent = 'i';
  toggle.setAttribute('aria-label', t('mapFilter.credits'));
  L.DomEvent.disableClickPropagation(toggle);
  const collapse = function() {
    clearTimeout(timer);
    container.classList.add('credit-collapsed');
    container.classList.remove('credit-opened');
  };
  const timer = setTimeout(collapse, 5000);
  map.on('unload', function() { clearTimeout(timer); });
  container.addEventListener('pointerdown', function(/** @type {PointerEvent} */ e) {
    if (e.target !== toggle && !credit.contains(/** @type {Node | null} */ (e.target))) collapse();
  });
  toggle.addEventListener('click', function() {
    container.classList.remove('credit-collapsed');
    // Unlike the credit shown at load, one opened here was asked for, so the
    // tap that closes it leaves the bottom bar alone (bar-motion.js).
    container.classList.add('credit-opened');
    const link = credit.querySelector('a');
    if (link) link.focus();
  });
}

// Rebuild the filter panel DOM in place after a feature is toggled, so the
// tab row reflects which features are enabled. Falls back to a full map
// re-render if the panel isn't present yet (e.g. enabling from none).
export function rebuildMapFilterPanel() {
  const div = document.getElementById('map-panel');
  if (!div) {
    if (state.currentMap && (placesEnabled() || routesEnabled())) wrappedRouter();
    return;
  }
  const buttons = document.getElementById('map-phone-buttons');
  const on = placesEnabled() || routesEnabled();
  div.style.display = on ? '' : 'none';
  if (buttons) buttons.style.display = on ? '' : 'none';
  if (!on) return;
  renderFresh(html`<${MapPanel} />`, div);
  bindFilterPanel();
  refreshFilterPanel();
  if (state.currentMap) initUnifiedSearch(state.currentMap);
}
