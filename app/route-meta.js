import { displayRegion, escapeHtml, state } from './core.js';
import { dataLayer } from './offline-queue.js';
import {
  radioPillsHtml, readRouteMetaFields, readStarRating, starRatingHtml, wireStarRating,
} from './form-fields.js';
import { tagPopupHtml } from './tags.js';
import { getShowField } from './prefs.js';
import { EXTERNAL_ICON_SVG } from './map-popups.js';
import { deleteRouteItem, placePopupContent } from './map-actions.js';
import {
  modalErrorHtml, modalHeaderHtml, refreshRoutes, uiFieldHtml, uiToggleHtml,
} from './select.js';
import { closeModal, openModal, showModalError } from './modal.js';
import { wrappedRouter } from './pick-coords.js';

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

export const DIFFICULTY_LABELS = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard', expert: 'Expert' };

function routeMetadataKey(route, regionName) {
  // The manifest keys metadata by the on-disk region directory, not the
  // display name. For a route in a region, route.file is "Region/Route.gpx"
  // and we use the first segment. For a no-region (root-level) route,
  // route.file is just "Route.gpx" and the key omits the region prefix.
  const file = route.file || '';
  if (!file.includes('/')) return route.name;
  return file.split('/')[0] + '/' + route.name;
}

export function ratingStarsText(rating) {
  // Returns HTML, not plain text, so the empty stars stay glyph-identical
  // to the filled ones (☆ and ★ render at different widths in most fonts).
  if (!rating) return '';
  const filled = '★'.repeat(rating);
  const empty = 5 - rating;
  if (!empty) return filled;
  return filled + '<span style="opacity:0.35">' + '★'.repeat(empty) + '</span>';
}

export function routePopupHtml(route, region, color) {
  const regionName = region.name;
  let html = '';
  if (route.source) {
    html += '<a class="popup-source-link" href="' + escapeHtml(route.source) + '" target="_blank" rel="noopener noreferrer" title="Go to source" aria-label="Go to source">' + EXTERNAL_ICON_SVG + '</a>';
  }
  const showLocal = getShowField('local-name');
  html += '<a class="popup-name popup-name-link" href="#/routes/route/' + encodeURIComponent(route.key) + '">' + escapeHtml(route.name) + (showLocal && route.local_name ? ' <span class="popup-local">' + escapeHtml(route.local_name) + '</span>' : '') + '</a>';
  // First meta line: difficulty / rating / date arranged left / center / right.
  // Render each slot even if empty so the columns hold their position.
  const diffSlot = route.difficulty ? escapeHtml(DIFFICULTY_LABELS[route.difficulty] || route.difficulty) : '';
  const rateSlot = (route.rating && getShowField('rating')) ? '<span title="' + route.rating + '/5">' + ratingStarsText(route.rating) + '</span>' : '';
  const dateSlot = (route.date_completed && getShowField('date')) ? escapeHtml(route.date_completed) : '';
  if (diffSlot || rateSlot || dateSlot) {
    html += '<div class="popup-summary">' +
      '<span>' + diffSlot + '</span>' +
      '<span>' + rateSlot + '</span>' +
      '<span>' + dateSlot + '</span>' +
    '</div>';
  }
  html += tagPopupHtml(route.tags);
  if (route.notes && getShowField('note')) html += '<div class="popup-note">' + escapeHtml(route.notes) + '</div>';
  html += '<div class="popup-meta">' +
    '<span style="color:' + color + '">' + (route.completed ? 'Completed' : 'Planned') + '</span>' +
    '<span>' + escapeHtml(displayRegion(regionName)) + '</span>' +
    '</div>';
  return html;
}

// After a route delete, drop it from the live index map in place so the map
// doesn't fully rebuild (blink + refit). state._removeRouteFromMap is a
// per-render closure installed by renderHomeMap (it owns the lazy-load
// bookkeeping); when no index map is mounted (list, history, detail) fall
// back to a router re-render.
export function afterRouteDeleted(key) {
  if (state._removeRouteFromMap && state._removeRouteFromMap(key)) return;
  if (typeof wrappedRouter === 'function') wrappedRouter();
}

export function findRouteByKey(key) {
  if (!state.manifest) return null;
  for (const region of state.manifest.regions) {
    for (const route of region.routes) {
      if (route.key === key) return { route, region };
    }
  }
  return null;
}

export function openEditTrailMetadataModal(route, regionName) {
  const key = routeMetadataKey(route, regionName);
  const currentRegion = regionName || '';
  const allRegions = ((state.manifest && state.manifest.regions) || [])
    .map(r => r.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const regionOptions = [
    '<option value=""' + (currentRegion === '' ? ' selected' : '') + '>(No region)</option>',
    ...allRegions.map(r =>
      '<option value="' + escapeHtml(r) + '"' + (r === currentRegion ? ' selected' : '') + '>' + escapeHtml(r) + '</option>'
    ),
    '<option value="__new__">(Add new region&hellip;)</option>',
  ].join('');
  openModal(
    modalHeaderHtml('Edit route') +
    '<form id="route-meta-form">' +
      '<div class="ui-section">' +
        uiFieldHtml('tm-name', 'Name',
          '<input type="text" id="tm-name" required maxlength="64" value="' + escapeHtml(route.name) + '">', { required: true }) +
        (getShowField('local-name') ?
          uiFieldHtml('tm-local-name', 'Local name',
            '<input type="text" id="tm-local-name" placeholder="In the local language" value="' + escapeHtml(route.local_name || '') + '">')
        : '') +
        uiFieldHtml('tm-region', 'Region',
          '<select id="tm-region">' + regionOptions + '</select>' +
          '<input type="text" id="tm-region-new" placeholder="New region name" maxlength="64" hidden>') +
        uiFieldHtml(null, 'Difficulty',
          radioPillsHtml('tm-difficulty', [['', 'None'], ['easy', 'Easy'], ['moderate', 'Moderate'], ['hard', 'Hard'], ['expert', 'Expert']], route.difficulty || '')) +
        (getShowField('tags') ?
          uiFieldHtml('tm-tags', 'Tags (comma-separated)',
            '<input type="text" id="tm-tags" value="' + escapeHtml((route.tags || []).join(', ')) + '" placeholder="summit, panorama, via-ferrata">')
        : '') +
        (getShowField('note') ?
          uiFieldHtml('tm-notes', 'Notes',
            '<textarea id="tm-notes" maxlength="2000">' + escapeHtml(route.notes || '') + '</textarea>')
        : '') +
        uiFieldHtml('tm-source', 'Source URL',
          '<input type="url" id="tm-source" value="' + escapeHtml(route.source || '') + '" placeholder="https://example.com/route">') +
        '<div>' +
          uiToggleHtml('tm-completed', 'I&rsquo;ve completed this route', { checked: route.completed }) +
          ((getShowField('date') || getShowField('rating')) ?
            '<div class="collapsible' + (route.completed ? ' expanded' : '') + '" id="tm-completed-extras">' +
              '<div class="collapsible-inner">' +
                '<div class="ui-section">' +
                  (getShowField('date') ?
                    uiFieldHtml('tm-date', 'Date completed',
                      '<input type="date" id="tm-date" value="' + escapeHtml(route.date_completed || '') + '">')
                  : '') +
                  (getShowField('rating') ?
                    uiFieldHtml(null, 'Rating',
                      starRatingHtml('tm-rating', route.rating || ''))
                  : '') +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +
        '</div>' +
      '</div>' +
      modalErrorHtml('tm-error') +
      '<div class="ui-dialog-actions">' +
        '<button type="button" class="ui-button ui-button-danger" id="tm-delete">Delete</button>' +
        '<span class="action-spacer"></span>' +
        '<button type="submit" class="ui-button ui-button-primary" id="tm-submit">Save</button>' +
      '</div>' +
    '</form>',
    function() {
      wireStarRating('tm-rating');
      const regionSel = document.getElementById('tm-region');
      const regionNewInput = document.getElementById('tm-region-new');
      regionSel.addEventListener('change', function() {
        const adding = this.value === '__new__';
        regionNewInput.hidden = !adding;
        if (adding) regionNewInput.focus();
      });
      const tmCompletedCb = document.getElementById('tm-completed');
      const tmCompletedExtras = document.getElementById('tm-completed-extras');
      if (tmCompletedCb && tmCompletedExtras) {
        tmCompletedCb.addEventListener('change', function() {
          tmCompletedExtras.classList.toggle('expanded', this.checked);
        });
      }
      document.getElementById('tm-delete').addEventListener('click', function() {
        deleteRouteItem(route, regionName, function() { closeModal(); afterRouteDeleted(route.key); });
      });
      document.getElementById('route-meta-form').addEventListener('submit', function(e) {
        e.preventDefault();
        const get = id => { const el = document.getElementById(id); return el ? el.value : ''; };
        const metadata = readRouteMetaFields('tm');
        const dateVal = get('tm-date').trim();
        const ratingRaw = readStarRating('tm-rating');
        if (dateVal) metadata.date_completed = dateVal;
        if (ratingRaw) metadata.rating = parseInt(ratingRaw, 10);
        const newName = get('tm-name').trim();
        if (!newName) {
          showModalError('Name is required');
          return;
        }
        const targetRegion = regionSel.value === '__new__'
          ? regionNewInput.value.trim()
          : regionSel.value;
        if (regionSel.value === '__new__' && !targetRegion) {
          showModalError('Enter a new region name');
          return;
        }
        const needsMove = targetRegion !== currentRegion || newName !== route.name;
        const newCompleted = tmCompletedCb ? tmCompletedCb.checked : !!route.completed;
        const needsCompletedFlip = newCompleted !== !!route.completed;
        // Optional fields hidden via Settings > Optional fields aren't
        // rendered in the form, so the reads above come back empty. Carry
        // over the stored values so a hidden field isn't wiped on save.
        if (!getShowField('local-name') && route.local_name) metadata.local_name = route.local_name;
        if (!getShowField('note') && route.notes) metadata.notes = route.notes;
        if (!getShowField('tags') && route.tags && route.tags.length) metadata.tags = route.tags;
        if (newCompleted) {
          if (!getShowField('date') && route.date_completed) metadata.date_completed = route.date_completed;
          if (!getShowField('rating') && route.rating) metadata.rating = route.rating;
        }
        const submit = document.getElementById('tm-submit');
        submit.disabled = true;
        let chain = Promise.resolve(key);
        if (needsCompletedFlip) {
          chain = chain.then(k => dataLayer.setGpxCompleted({ key: k, completed: newCompleted }).then(() => k));
        }
        if (needsMove) {
          chain = chain.then(k => dataLayer.moveGpx({ key: k, new_region: targetRegion, new_name: newName }).then(r => r.new_key));
        }
        let movedKey = key;
        chain
          .then(finalKey => { movedKey = finalKey; return dataLayer.putMetadata({ key: finalKey, metadata: metadata }); })
          .then(() => refreshRoutes())
          .then(() => {
            closeModal();
            // If this route's detail view is open and it moved (region or
            // name changed), its URL key is now stale; reroute to the new
            // key instead of leaving a dead link behind.
            const seg = location.hash.split('/routes/route/')[1];
            const onThisDetail = seg && decodeURIComponent(seg) === route.key;
            if (needsMove && onThisDetail && movedKey && movedKey !== route.key) {
              location.hash = '#/routes/route/' + encodeURIComponent(movedKey);
            } else {
              wrappedRouter();
            }
          })
          .catch(err => { submit.disabled = false; showModalError(err.message); });
      });
    }
  );
}

export function addStartEndMarkers(map, startLatLng, endLatLng) {
  const startIcon = L.divIcon({ className: 'marker-start', html: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#00e05a" stroke="#fff" stroke-width="2"/></svg>', iconSize: [24, 24], iconAnchor: [12, 12] });
  const endIcon = L.divIcon({ className: 'marker-end', html: '<svg viewBox="0 0 32 32" width="32" height="32"><rect x="4" y="2" width="2" height="28" rx="1" fill="#fff" stroke="#2d333b" stroke-width="0.5"/><path d="M6 3h12c1 0 1.5.5 1 1.5L17 8l2 3.5c.5 1 0 1.5-1 1.5H6V3z" fill="#fff" stroke="#2d333b" stroke-width="0.5"/><rect x="7" y="4" width="4.5" height="4" fill="#2d333b"/><rect x="11.5" y="4" width="4.5" height="4" fill="#fff"/><rect x="7" y="8" width="4.5" height="4" fill="#fff"/><rect x="11.5" y="8" width="4.5" height="4" fill="#2d333b"/></svg>', iconSize: [32, 32], iconAnchor: [5, 30] });
  L.marker(startLatLng, { icon: startIcon }).bindPopup('Start').addTo(map);
  L.marker(endLatLng, { icon: endIcon }).bindPopup('End').addTo(map);
}
