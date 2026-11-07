import { assignCategoryColors, displayCategory, escapeHtml, state } from './core.js';
import { popupEditHtml } from './server.js';
import { tagPopupHtml } from './tags.js';
import { getShowField } from './prefs.js';
import { syncAreasOnMap } from './areas.js';
import { refreshOpenPlacePopup } from './route-meta.js';
import { refreshFilterPanel } from './map.js';
import { applyMapFilters } from './place-layer.js';
import { wrappedRouter } from './pick-coords.js';

export const EXTERNAL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';


// Uncategorized carries no colour of its own, so its dot falls back to
// --muted and follows the theme while the popup is open.
export function popupCategoryHtml(category) {
  const colors = category
    ? ' style="--c:' + state.categoryColors[category] + ';--cl:' + state.categoryColorsLight[category] + '"' : '';
  return '<span class="popup-category"><span class="popup-category-dot"' + colors + '></span>' +
    escapeHtml(displayCategory(category)) + '</span>';
}
export function placePopupHtml(p) {
  const sourceUrl = (Array.isArray(p.sources) && p.sources.length) ? p.sources[0] : '';
  let html = '';
  if (sourceUrl) {
    html += '<a class="popup-source-link" href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer" title="Go to source" aria-label="Go to source">' + EXTERNAL_ICON_SVG + '</a>';
  }
  const showLocal = getShowField('local-name');
  html += '<div class="popup-name">' + escapeHtml(p.name) + (showLocal && p.local_name ? ' <span class="popup-local">' + escapeHtml(p.local_name) + '</span>' : '') + '</div>';
  if (p.image && getShowField('image')) {
    // Hide broken/blocked images instead of showing the empty alt frame.
    const focus = typeof p.image_focus === 'string' && /^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$/.test(p.image_focus.trim()) ? p.image_focus.trim() : '';
    const focusAttr = focus ? ' style="object-position: ' + focus + '"' : '';
    html += '<img class="popup-image" src="' + escapeHtml(p.image) + '" alt=""' + focusAttr + ' loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">';
  }
  if (p.note && getShowField('note')) html += '<div class="popup-note">' + escapeHtml(p.note) + '</div>';
  html += tagPopupHtml(p.tags);
  html += '<div class="popup-meta">' +
    popupCategoryHtml(p.category) +
    popupEditHtml() +
    '<span style="grid-column:3">' + (p.visited ? 'Visited' : 'Want to visit') + '</span>' +
  '</div>';
  return html;
}

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
export function refreshPlacesPresentation() {
  refreshCategoryColors();
  if ((location.hash || '#/').startsWith('#/places')) wrappedRouter();
}

// Sync the canvas place layer with state.places after a CRUD write.
// Skips when no map is mounted.
export function syncPlacesOnMap(_prevColors) {
  if (!state._placeClusterGroup) return;
  state._placeRecords = (state.places || []).slice();
  refreshFilterPanel();
  applyMapFilters();
  syncAreasOnMap();
  refreshOpenPlacePopup();
}
