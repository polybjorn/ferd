import { closeModal, openModal, openSheetModal } from '../modal.js';
import { bindFilterSheet, filterSheetHtml, refreshFilterPanel, syncFilterDot } from './home-map.js';
import { goToSearchResult, recentResultsHtml, searchMatches, searchResultsHtml } from './place-layer.js';
import { bindSearchKeys } from './search-keys.js';
import { addRecentPick, clearRecentPicks, getRecentPicks, placesEnabled, routesEnabled } from '../prefs.js';
import { state } from '../core.js';

const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5h20"/><path d="M6 12h12"/><path d="M9 19h6"/></svg>';

// A phone has no room for the filter panel beside the credit, so filters
// become a button under the tile picker that opens a sheet, and search moves
// to the bottom bar. CSS shows the button or the panel by width, so a resize
// needs no rebuild.
/** @param {import('./route-layer.js').LeafletMap} map */
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
  /** @type {HTMLElement} */ (document.getElementById('map-filter-btn')).addEventListener('click', openFilterSheet);
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
      '<div class="ui-field map-search-field"><form class="ui-search" id="map-search-view-form" method="dialog">' +
        '<input type="search" id="map-search-view-input" aria-label="Search" placeholder="Search places, areas and routes" enterkeyhint="search" autocomplete="off">' +
        '<button class="ui-button ui-button-quiet ui-search-clear" type="reset" aria-label="Clear"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>' +
      '</form></div>' +
      '<button type="button" class="ui-button ui-button-quiet ui-dialog-close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>' +
    '</div>' +
    '<div class="map-search-list" id="map-search-view-list"></div>',
    function(dialog) {
      const input = /** @type {HTMLInputElement} */ (dialog.querySelector('#map-search-view-input'));
      const list = /** @type {HTMLElement} */ (dialog.querySelector('#map-search-view-list'));
      /** @param {HTMLElement} row */
      const pick = function(row) {
        addRecentPick({ ...row.dataset });
        closeModal();
        showResultOnMap({ ...row.dataset });
      };
      // Escape is left to the modal, which closes the whole view.
      const keys = bindSearchKeys(input, list, { pick, controls: 'map-search-view-options' });
      // The rows sit in a listbox of their own, as the Clear button and the
      // hints beside them are not options.
      /** @param {string} rows */
      const options = function(rows) {
        return '<div role="listbox" id="map-search-view-options" aria-label="Results">' + rows + '</div>';
      };
      const render = function() {
        const q = input.value.trim();
        const found = q ? searchResultsHtml(searchMatches(q), true) : '';
        const recent = q ? '' : recentResultsHtml(getRecentPicks());
        if (found) {
          list.innerHTML = options(found);
        } else if (recent) {
          list.innerHTML = '<div class="map-search-heading-row"><h3 class="map-search-heading">Recent</h3>' +
            '<button type="button" class="map-search-clear" data-clear-recent>Clear</button></div>' + options(recent);
        } else {
          list.innerHTML = '<p class="map-search-empty">' + (q ? 'No matches' : 'Find a place, area or route by name') + '</p>';
        }
        keys.refresh(!!(found || recent));
      };
      input.addEventListener('input', render);
      // method="dialog" would close this dialog on Enter with no row active.
      /** @type {HTMLElement} */ (dialog.querySelector('#map-search-view-form')).addEventListener('submit', (/** @type {Event} */ e) => e.preventDefault());
      render();
      list.addEventListener('click', function(e) {
        const target = /** @type {Element} */ (e.target);
        if (target.closest('[data-clear-recent]')) {
          clearRecentPicks();
          render();
          input.focus();
          return;
        }
        const row = /** @type {HTMLElement | null} */ (target.closest('.map-search-result'));
        if (row) pick(row);
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
