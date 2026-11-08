import { state } from '../core.js';
import { placesEnabled, routesEnabled } from '../prefs.js';
import { bindFilterPanel, refreshFilterPanel } from './home-map.js';
import { closeTransientOverlays } from './map-actions.js';
import { initUnifiedSearch } from './place-layer.js';
import { _selPopover, closeSelectPopover, openMultiSelectList } from '../select.js';
import { wrappedRouter } from '../router.js';

// Toggle a popover open/closed; close on outside click or when another
// transient overlay opens. Clicks inside are swallowed so selecting a control
// doesn't dismiss it. Shared by the filter and list-view popovers.
export function wirePopover(btn, pop) {
  if (!btn || !pop) return () => {};
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    const open = pop.hidden;
    if (open) closeTransientOverlays(pop);
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  const outside = function(/** @type {MouseEvent} */ e) {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('click', outside);
  pop.addEventListener('click', function(e) { e.stopPropagation(); });
  // The document outlives the page; a page that unmounts must take its
  // listener with it.
  return () => document.removeEventListener('click', outside);
}

// Wire a list-page filter popover end to end: open/close, the "Filters (N)"
// count on the button, per-select change handlers that write into
// filters[keyById[id]], the search box, and a Clear button that resets every
// select + the search. onApply re-renders the list after any change/clear.
// Shared by the Places, Routes, and History list pages. Returns the cleanup
// from wirePopover, which a page that unmounts must call.
export function wireFilterPopover(opts) {
  const { btn, pop, clear, sels, keyById, filters, searchInput, searchKey, onApply, tagOptions, tagsKey, tagMsBtn } = opts;
  function tagsActive() { return !!(tagsKey && filters[tagsKey] && filters[tagsKey].length); }
  function syncTagLabel() {
    if (!tagMsBtn) return;
    const sel = (tagsKey && filters[tagsKey]) || [];
    tagMsBtn.textContent = sel.length ? sel.join(', ') : 'Tags';
    tagMsBtn.classList.toggle('filter-active', sel.length > 0);
  }
  function updateLabel() {
    let n = sels.reduce((acc, s) => acc + (s.value !== 'all' ? 1 : 0), 0);
    if (tagsActive()) n += 1;
    if (btn) btn.classList.toggle('has-active', n > 0);
    // Tint each select that holds a non-default value, so an applied filter
    // reads as applied even with the popover closed.
    sels.forEach(s => s.classList.toggle('filter-active', s.value !== 'all'));
    syncTagLabel();
  }
  function apply() { onApply(); updateLabel(); }
  if (searchInput && searchKey) searchInput.addEventListener('input', function() {
    filters[searchKey] = this.value;
    apply();
  });
  sels.forEach(s => s.addEventListener('change', function() {
    const k = keyById[s.id];
    if (k) filters[k] = s.value;
    apply();
  }));
  if (tagMsBtn && tagsKey && tagOptions && tagOptions.length) tagMsBtn.addEventListener('mousedown', function(e) {
    e.preventDefault();
    if (_selPopover) { closeSelectPopover(); return; }
    openMultiSelectList(tagMsBtn, tagOptions, () => filters[tagsKey] || [], function(arr) { filters[tagsKey] = arr; apply(); });
  });
  const cleanup = wirePopover(btn, pop);
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
  return cleanup;
}

function panelTabsHtml() {
  const chevron = '<span class="section-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>';
  /** @param {string} id @param {string} label */
  const head = (id, label) => '<button type="button" class="ui-button ui-button-quiet panel-head" aria-expanded="false" aria-controls="' + id + '-section">' + label + chevron + '</button>';
  let h = '<div class="panel-heads">';
  if (placesEnabled()) h += head('places', 'Places');
  if (routesEnabled()) h += head('routes', 'Routes');
  h += '</div>';
  return h;
}

function panelBodyHtml(id) {
  return '<div class="ui-collapse" id="' + id + '-section">' +
    '<div class="ui-collapse-body"><div class="panel-section-body" id="' + id + '-body"></div></div>' +
    '</div>';
}

// Full inner markup of the filter panel. Used both when the control is
// first added and when a feature is toggled (which adds/removes a tab).
export function panelInnerHtml() {
  return '<div class="panel-search" id="map-search">' +
    '<div class="ui-field"><form class="ui-search" method="dialog">' +
      '<input type="search" id="map-search-input" aria-label="Search" placeholder="Search..." autocomplete="off">' +
      '<button class="ui-button ui-button-quiet ui-search-clear" type="reset" aria-label="Clear"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>' +
    '</form></div>' +
    '<div class="map-search-results" id="map-search-results" role="listbox" aria-label="Results"></div>' +
    '</div>' +
    (placesEnabled() ? panelBodyHtml('places') : '') +
    (routesEnabled() ? panelBodyHtml('routes') : '') +
    '<div class="legend-status panel-status" id="panel-status"></div>' +
    panelTabsHtml();
}

// A credit across a phone's map covers more than it needs to. OpenStreetMap's
// guidelines let it collapse on map interaction or after five seconds, so
// long as a corner button still finds it. Zooming is left to the pointer
// listener because fitBounds fires the same zoom events as a pinch, and would
// collapse the credit before anyone saw it. Only the phone rule acts on the
// class, so a wider window keeps the credit.
export function collapseCreditOnPhone(map) {
  const container = map.getContainer();
  const credit = container.querySelector('.leaflet-control-attribution');
  const toggle = L.DomUtil.create('button', 'leaflet-control map-credit-toggle', credit.parentElement);
  toggle.type = 'button';
  toggle.textContent = 'i';
  toggle.setAttribute('aria-label', 'Map credits');
  L.DomEvent.disableClickPropagation(toggle);
  const collapse = function() {
    clearTimeout(timer);
    container.classList.add('credit-collapsed');
  };
  const timer = setTimeout(collapse, 5000);
  map.on('unload', function() { clearTimeout(timer); });
  container.addEventListener('pointerdown', function(e) {
    if (e.target !== toggle && !credit.contains(e.target)) collapse();
  });
  toggle.addEventListener('click', function() {
    container.classList.remove('credit-collapsed');
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
  div.innerHTML = panelInnerHtml();
  bindFilterPanel();
  refreshFilterPanel();
  if (state.currentMap) initUnifiedSearch(state.currentMap);
}
