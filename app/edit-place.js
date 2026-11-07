import { displayCategory, escapeHtml, sortedCategorySlugs, state } from './core.js';
import { dataLayer } from './offline-queue.js';
import {
  readPlaceFormFields, selectOrNewHtml, starRatingHtml, wireSelectOrNew, wireStarRating,
} from './form-fields.js';
import { getShowField } from './prefs.js';
import { syncPlacesOnMap } from './map-popups.js';
import { wireCountryPicker } from './countries.js';
import { deletePlaceItem, resyncPlaceCardSlugs } from './map-actions.js';
import { renderPlaceList, updatePlaceCardAfterEdit } from './places-list.js';
import {
  modalErrorHtml, modalHeaderHtml, refreshPlaces, uiFieldHtml, uiToggleHtml,
} from './select.js';
import { closeModal, openFullScreenModal, showModalError } from './modal.js';
import { enterPickCoordsMode } from './pick-coords.js';

export function openEditPlaceModal(place) {
  // Exclude the uncategorized bucket ('') from the picker — "no category"
  // is the default state of the empty option, not a pickable category.
  const cats = sortedCategorySlugs(Object.keys(state.categoryColors).filter(c => c !== ''));
  const sourcesText = (place.sources || []).join('\n');
  openFullScreenModal(
    modalHeaderHtml('Edit place') +
    '<form id="edit-place-form">' +
      '<div class="ui-section">' +
        uiFieldHtml('e-name', 'Name',
          '<input type="text" id="e-name" required value="' + escapeHtml(place.name) + '">', { required: true }) +
        (getShowField('local-name') ?
          uiFieldHtml('e-local-name', 'Local name',
            '<input type="text" id="e-local-name" placeholder="In the local language" value="' + escapeHtml(place.local_name || '') + '">')
        : '') +
        '<div class="ui-field-row">' +
          uiFieldHtml('e-lat', 'Latitude', '<input type="number" id="e-lat" step="any" required value="' + place.lat + '">', { required: true }) +
          uiFieldHtml('e-lon', 'Longitude', '<input type="number" id="e-lon" step="any" required value="' + place.lon + '">', { required: true }) +
        '</div>' +
        '<div class="ui-control-row"><button type="button" class="primary" id="e-pick-on-map">Pick on map</button></div>' +
        uiFieldHtml('e-category', 'Category',
          selectOrNewHtml('e-category', cats, place.category, displayCategory, '', 'New category name')) +
        uiFieldHtml('e-country', 'Country',
          '<input type="text" id="e-country" value="' + escapeHtml(place.country || '') + '">') +
        (getShowField('tags') ?
          uiFieldHtml('e-tags', 'Tags (comma-separated)',
            '<input type="text" id="e-tags" value="' + escapeHtml((place.tags || []).join(', ')) + '" placeholder="UNESCO, free-entry">')
        : '') +
        (getShowField('note') ?
          uiFieldHtml('e-note', 'Note',
            '<textarea id="e-note">' + escapeHtml(place.note || '') + '</textarea>')
        : '') +
        (getShowField('image') ?
          uiFieldHtml('e-image', 'Image URL',
            '<input type="url" id="e-image" value="' + escapeHtml(place.image || '') + '" placeholder="https://example.com/photo.jpg">')
        : '') +
        uiFieldHtml('e-sources', 'Sources',
          '<textarea id="e-sources" placeholder="One URL per line">' + escapeHtml(sourcesText) + '</textarea>') +
        '<div>' +
          uiToggleHtml('e-visited', 'I&rsquo;ve visited this place', { checked: place.visited }) +
          ((getShowField('date') || getShowField('rating')) ?
            '<div class="collapsible' + (place.visited ? ' expanded' : '') + '" id="e-visited-extras">' +
              '<div class="collapsible-inner">' +
                '<div class="ui-section">' +
                  (getShowField('date') ?
                    uiFieldHtml('e-date-visited', 'Date visited',
                      '<input type="date" id="e-date-visited" value="' + escapeHtml(place.date_visited || '') + '">')
                  : '') +
                  (getShowField('rating') ?
                    uiFieldHtml(null, 'Rating',
                      starRatingHtml('e-rating', place.rating || ''))
                  : '') +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +
        '</div>' +
      '</div>' +
      modalErrorHtml('edit-error') +
      '<div class="ui-dialog-actions">' +
        '<button type="button" class="ui-button ui-button-danger" id="e-delete">Delete</button>' +
        '<span class="action-spacer"></span>' +
        '<button type="submit" class="ui-button ui-button-primary" id="e-submit">Save</button>' +
      '</div>' +
    '</form>',
    function() {
      wireSelectOrNew('e-category');
      wireCountryPicker('e-country');
      wireStarRating('e-rating');
      const eVisitedCb = document.getElementById('e-visited');
      const eVisitedExtras = document.getElementById('e-visited-extras');
      if (eVisitedCb && eVisitedExtras) {
        eVisitedCb.addEventListener('change', function() {
          eVisitedExtras.classList.toggle('expanded', this.checked);
        });
      }
      document.getElementById('e-pick-on-map').addEventListener('click', function() {
        // Snapshot current form values so they survive the close+reopen
        // around the map click. Lat/lon get overwritten with the pick.
        const snapshot = readPlaceFormFields('e');
        const draft = Object.assign({}, place, snapshot.payload || {});
        closeModal();
        enterPickCoordsMode(function(latlng) {
          // Same rounding as readPlaceFormFields on save, so the form
          // shows the value that will actually be stored.
          draft.lat = Math.round(latlng.lat * 1e5) / 1e5;
          draft.lon = Math.round(latlng.lng * 1e5) / 1e5;
          openEditPlaceModal(draft);
        });
      });
      document.getElementById('e-delete').addEventListener('click', function() {
        deletePlaceItem(place, {
          animate: true,
          deleted: closeModal,
          after: function(prevColors) { syncPlacesOnMap(prevColors); resyncPlaceCardSlugs(); },
          onError: function(err) { showModalError(err.message); },
        });
      });
      document.getElementById('edit-place-form').addEventListener('submit', function(e) {
        e.preventDefault();
        const r = readPlaceFormFields('e');
        if (r.error) { showModalError(r.error); return; }
        // Preserve the catalog lineage tag across edits; the form has no
        // input for it, but it shouldn't disappear on a rename/note change.
        if (place.from_catalog) r.payload.from_catalog = place.from_catalog;
        // Optional fields hidden via Settings > Optional fields aren't
        // rendered in the form, so readPlaceFormFields reads them as empty.
        // Carry over the stored value so a hidden field isn't silently
        // wiped on save (which, for catalog-linked places, also resurfaces
        // a bogus "Update from catalog" to restore what the edit erased).
        if (!getShowField('local-name') && place.local_name) r.payload.local_name = place.local_name;
        if (!getShowField('note') && place.note) r.payload.note = place.note;
        if (!getShowField('image') && place.image) r.payload.image = place.image;
        if (!getShowField('tags') && place.tags && place.tags.length) r.payload.tags = place.tags;
        // image_focus has no form input at all, so keep it whenever the
        // image is unchanged; the server clears it on a genuine image swap.
        if (place.image_focus && r.payload.image === place.image) r.payload.image_focus = place.image_focus;
        if (r.payload.visited) {
          if (!getShowField('date') && place.date_visited) r.payload.date_visited = place.date_visited;
          if (!getShowField('rating') && place.rating) r.payload.rating = place.rating;
        }
        const submit = document.getElementById('e-submit');
        submit.disabled = true;
        const prevColors = Object.assign({}, state.categoryColors);
        dataLayer.updatePlace({ id: place.id, place: r.payload })
          .then(() => refreshPlaces())
          .then(() => {
            closeModal();
            syncPlacesOnMap(prevColors);
            // Patch the card in place when the edit doesn't move/reorder it
            // (e.g. toggling visited), so the list doesn't flash; otherwise
            // fall back to a full re-render.
            if (document.getElementById('place-list')) {
              const fresh = (state.places || []).find(p => p.id === place.id);
              if (!(fresh && updatePlaceCardAfterEdit(place, fresh))) renderPlaceList();
            }
          })
          .catch(err => { submit.disabled = false; showModalError(err.message); });
      });
    }
  );
}
