import { closeModal, openModal, openSheetModal } from '../modal.js';
import { bindFilterSheet, filterSheetHtml, refreshFilterPanel, syncFilterDot } from './home-map.js';
import { goToSearchResult, recentResultsHtml, searchMatches, searchResultsHtml } from './place-layer.js';
import { addRecentPick, clearRecentPicks, getRecentPicks, placesEnabled, routesEnabled } from '../prefs.js';
import { state } from '../core.js';

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
  if (state._pendingSearchResult) {
    const row = state._pendingSearchResult;
    state._pendingSearchResult = null;
    goToSearchResult(map, row);
  }
}

/**
 * Shows a search result, or anything shaped like one, on the main map,
 * opening the map first when another tab is showing.
 * @param {Record<string, string | undefined>} dataset
 */
export function showResultOnMap(dataset) {
  if (state.currentMap && document.getElementById('map-phone-buttons')) {
    goToSearchResult(state.currentMap, { dataset });
    return;
  }
  state._pendingSearchResult = { dataset };
  location.hash = '#/';
}

const barSearch = document.getElementById('bar-search');
if (barSearch) barSearch.addEventListener('click', openSearchView);

// The same search on every tab, and a pick always shows on the map. A list's
// own field filters what it lists, which is a different job. The route page
// has a map too, so the main map is told apart by its filter button.
export function openSearchView() {
  openModal(
    '<div class="ui-dialog-head map-search-head">' +
      '<div class="ui-field map-search-field"><input type="search" id="map-search-view-input" aria-label="Search" placeholder="Search places, areas and routes" enterkeyhint="search" autocomplete="off"></div>' +
      '<button type="button" class="ui-button ui-button-quiet ui-dialog-close" aria-label="Close">&times;</button>' +
    '</div>' +
    '<div class="map-search-list" id="map-search-view-list"></div>',
    function(dialog) {
      const input = dialog.querySelector('#map-search-view-input');
      const list = dialog.querySelector('#map-search-view-list');
      const render = function() {
        const q = input.value.trim();
        if (q) {
          list.innerHTML = searchResultsHtml(searchMatches(q), true) || '<p class="map-search-empty">No matches</p>';
          return;
        }
        const recent = recentResultsHtml(getRecentPicks());
        list.innerHTML = recent
          ? '<div class="map-search-heading-row"><h3 class="map-search-heading">Recent</h3>' +
            '<button type="button" class="map-search-clear" data-clear-recent>Clear</button></div>' + recent
          : '<p class="map-search-empty">Find a place, area or route by name</p>';
      };
      input.addEventListener('input', render);
      render();
      list.addEventListener('click', function(e) {
        if (e.target.closest('[data-clear-recent]')) {
          clearRecentPicks();
          render();
          input.focus();
          return;
        }
        const row = e.target.closest('.map-search-result');
        if (!row) return;
        addRecentPick({ ...row.dataset });
        closeModal();
        showResultOnMap({ ...row.dataset });
      });
      input.focus();
      // The keyboard going down shows as the visible height growing back.
      // The layout height can't tell, since an app WebView resizes it with
      // the keyboard. With nothing typed the panel has nothing left to show.
      const vv = window.visualViewport;
      if (!vv) return;
      let low = vv.height;
      const onResize = function() {
        if (!dialog.isConnected) { vv.removeEventListener('resize', onResize); return; }
        if (vv.scale > 1.01) return;
        low = Math.min(low, vv.height);
        if (vv.height - low < 120) return;
        low = vv.height;
        if (!input.value.trim()) closeModal();
      };
      vv.addEventListener('resize', onResize);
    },
    null,
    { phone: 'top' }
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
