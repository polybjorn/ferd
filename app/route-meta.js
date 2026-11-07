import { escapeHtml, state } from './core.js';
import { dataLayer } from './store.js';
import {
  radioPillsHtml, readRouteMetaFields, readStarRating, starRatingHtml, wireStarRating,
} from './form-fields.js';
import { getShowField } from './prefs.js';
import { deleteRouteItem, homeMapMounted } from './map/index.js';
import {
  modalErrorHtml, modalHeaderHtml, uiFieldHtml, uiToggleHtml,
} from './select.js';
import { closeModal, openFullScreenModal, showModalError } from './modal.js';
import { wrappedRouter } from './router.js';

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

// After a route delete. The index map drops the route itself when the
// store's routes signal changes; any other page re-renders.
export function afterRouteDeleted() {
  if (!homeMapMounted()) wrappedRouter();
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
  openFullScreenModal(
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
      const regionSel = /** @type {HTMLSelectElement} */ (document.getElementById('tm-region'));
      const regionNewInput = /** @type {HTMLInputElement} */ (document.getElementById('tm-region-new'));
      regionSel.addEventListener('change', function() {
        const adding = this.value === '__new__';
        regionNewInput.hidden = !adding;
        if (adding) regionNewInput.focus();
      });
      const tmCompletedCb = /** @type {HTMLInputElement} */ (document.getElementById('tm-completed'));
      const tmCompletedExtras = document.getElementById('tm-completed-extras');
      if (tmCompletedCb && tmCompletedExtras) {
        tmCompletedCb.addEventListener('change', function() {
          tmCompletedExtras.classList.toggle('expanded', this.checked);
        });
      }
      document.getElementById('tm-delete').addEventListener('click', function() {
        deleteRouteItem(route, regionName, function() { closeModal(); afterRouteDeleted(); });
      });
      document.getElementById('route-meta-form').addEventListener('submit', function(e) {
        e.preventDefault();
        const get = id => { const el = /** @type {HTMLInputElement} */ (document.getElementById(id)); return el ? el.value : ''; };
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
        const submit = /** @type {HTMLButtonElement} */ (document.getElementById('tm-submit'));
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
