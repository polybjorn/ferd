import { closeModal, openFullScreenModal, openSheetModal } from './modal.js';
import { bindFilterClicks, filterSheetHtml, refreshFilterPanel, syncFilterDot } from './map.js';
import { goToSearchResult, searchMatches, searchResultsHtml } from './place-layer.js';
import { placesEnabled, routesEnabled } from './prefs.js';
import { modalHeaderHtml } from './select.js';
import { state } from './core.js';

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>';
const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5h20"/><path d="M6 12h12"/><path d="M9 19h6"/></svg>';

// A phone has no room for the filter panel beside the credit, so search and
// filters become two buttons under the tile picker, each opening its own
// view. CSS shows them or the panel by width, so a resize needs no rebuild.
export function addPhoneMapButtons(map) {
  const Ctrl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      const div = L.DomUtil.create('div', 'leaflet-control map-phone-buttons');
      div.id = 'map-phone-buttons';
      div.innerHTML =
        '<button type="button" class="map-phone-btn" id="map-search-btn" aria-label="Search">' + SEARCH_ICON + '</button>' +
        '<button type="button" class="map-phone-btn" id="map-filter-btn" aria-label="Filters">' + FILTER_ICON + '</button>';
      L.DomEvent.disableClickPropagation(div);
      return div;
    }
  });
  map.addControl(new Ctrl());
  document.getElementById('map-search-btn').addEventListener('click', openMapSearchView);
  document.getElementById('map-filter-btn').addEventListener('click', openFilterSheet);
  syncFilterDot();
}

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
  openSheetModal(
    modalHeaderHtml('Filters') + filterSheetHtml(),
    function(dialog) { bindFilterClicks(dialog.querySelector('.filter-sheet')); },
    // The sheet flips its toggles in place, so the desktop panel catches up
    // on close in case the window widens later.
    function() { closeModal(); refreshFilterPanel(); }
  );
}
