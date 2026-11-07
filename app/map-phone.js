import { closeModal, openFullScreenModal, openSheetModal } from './modal.js';
import { bindFilterSheet, filterSheetHtml, refreshFilterPanel, syncFilterDot } from './map.js';
import { goToSearchResult, searchMatches, searchResultsHtml } from './place-layer.js';
import { placesEnabled, routesEnabled } from './prefs.js';
import { state } from './core.js';

const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5h20"/><path d="M6 12h12"/><path d="M9 19h6"/></svg>';

// A phone has no room for the filter panel beside the credit, so filters
// become a button under the tile picker that opens a sheet, and search moves
// to the bottom bar. CSS shows the button or the panel by width, so a resize
// needs no rebuild.
export function addPhoneMapButtons(map) {
  const Ctrl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      const div = L.DomUtil.create('div', 'leaflet-control map-phone-buttons');
      div.id = 'map-phone-buttons';
      div.innerHTML =
        '<button type="button" class="map-phone-btn" id="map-filter-btn" aria-label="Filters">' + FILTER_ICON + '</button>';
      L.DomEvent.disableClickPropagation(div);
      return div;
    }
  });
  map.addControl(new Ctrl());
  document.getElementById('map-filter-btn').addEventListener('click', openFilterSheet);
  syncFilterDot();
  if (state._searchOnMapReady) {
    state._searchOnMapReady = false;
    openMapSearchView();
  }
}

// The bar's Search finds things on the map. A list page has its own search
// for what it lists, so there it goes to that field; any other page goes to
// the map first.
function openBarSearch() {
  const listInput = document.querySelector('#app .index-controls input[type="text"]');
  if (listInput) {
    document.getElementById('app').scrollTo({ top: 0 });
    listInput.focus();
    return;
  }
  if (document.getElementById('map-phone-buttons')) {
    openMapSearchView();
    return;
  }
  state._searchOnMapReady = true;
  location.hash = '#/';
}
const barSearch = document.getElementById('bar-search');
if (barSearch) barSearch.addEventListener('click', openBarSearch);

export function openMapSearchView() {
  const map = state.currentMap;
  if (!map) return;
  openFullScreenModal(
    '<div class="ui-dialog-head map-search-head">' +
      '<div class="ui-field map-search-field"><input type="search" id="map-search-view-input" aria-label="Search" placeholder="Search places, areas and routes" enterkeyhint="search" autocomplete="off"></div>' +
      '<button type="button" class="ui-button ui-button-quiet ui-dialog-close modal-close" aria-label="Close">&times;</button>' +
    '</div>' +
    '<div class="map-search-list" id="map-search-view-list"></div>',
    function(dialog) {
      const input = dialog.querySelector('#map-search-view-input');
      const list = dialog.querySelector('#map-search-view-list');
      input.addEventListener('input', function() {
        const q = this.value.trim();
        const html = q ? searchResultsHtml(searchMatches(q)) : '';
        list.innerHTML = html || (q ? '<p class="map-search-empty">No matches</p>' : '');
      });
      list.addEventListener('click', function(e) {
        const row = e.target.closest('.map-search-result');
        if (!row) return;
        closeModal();
        goToSearchResult(map, row);
      });
      input.focus();
    }
  );
}

export function openFilterSheet() {
  if (!placesEnabled() && !routesEnabled()) return;
  // Reset takes the close button's place in the head: a swipe down, Back,
  // Escape or a tap on the dimmed map still closes the sheet.
  openSheetModal(
    filterSheetHtml(),
    function(dialog) { bindFilterSheet(dialog); refreshFilterPanel(); },
    // The sheet flips its toggles in place, so the desktop panel catches up
    // on close in case the window widens later.
    function() { closeModal(); refreshFilterPanel(); }
  );
}
