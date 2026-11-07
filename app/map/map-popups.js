import { assignCategoryColors, state } from '../core.js';
import { syncAreasOnMap } from './area-layer.js';
import { refreshFilterPanel } from './home-map.js';
import { placePopupContent } from './map-actions.js';
import { applyMapFilters } from './place-layer.js';

export const EXTERNAL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';


export function refreshCategoryColors() {
  if (!state.places) return;
  const cc = assignCategoryColors(state.places);
  state.categoryColors = cc.dark;
  state.categoryColorsLight = cc.light;
  if (!state._placeClusterGroup) return;
  state._placeClusterGroup.redraw();
  syncAreasOnMap();
  if (typeof refreshFilterPanel === 'function') refreshFilterPanel();
  refreshOpenPlacePopup();
}

// Refresh place rendering in-place after label edits or bulk-clears.
// Avoids the full router rebuild (which blinks the map). Recomputes
// category palette then triggers a canvas redraw and filter panel update.
// The places page follows the labels signal itself.
export function refreshPlacesPresentation() {
  refreshCategoryColors();
}

// Sync the canvas place layer with state.places after a CRUD write.
// Skips when no map is mounted.
export function syncPlacesOnMap() {
  if (!state._placeClusterGroup) return;
  state._placeRecords = (state.places || []).slice();
  refreshFilterPanel();
  applyMapFilters();
  syncAreasOnMap();
  refreshOpenPlacePopup();
}

// If a place popup is currently open on the home map, re-render its
// content from the latest state. Without this the popup keeps showing
// stale data (old image, old note, old anchor) after an edit save until
// the user manually closes and reopens it.
export function refreshOpenPlacePopup() {
  const map = state.currentMap;
  if (!map || !map._popup || !map._popup.isOpen || !map._popup.isOpen()) return;
  const ll = map._popup.getLatLng();
  if (!ll) return;
  const places = state.places || [];
  const place = places.find(p =>
    Math.abs((p.lat || 0) - ll.lat) < 1e-6 && Math.abs((p.lon || 0) - ll.lng) < 1e-6
  );
  if (!place) return;
  map._popup.setContent(placePopupContent(map, place));
}
