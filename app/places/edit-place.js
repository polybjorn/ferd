import { displayCategory } from '../core.js';
import { dataLayer } from '../store.js';
import { CountryInput, DoneFields, SelectOrNew, categorySlugs, roundCoord } from '../form-fields.js';
import { getShowField } from '../prefs.js';
import { deletePlaceItem, enterPickCoordsMode } from '../map/index.js';
import { t } from '../i18n.js';
import { ErrorBox, DialogHead, Field, html, openViewModal, useState } from '../view.js';
import { closeModal } from '../modal.js';
import { editPlacePayload, placeSnapshot, placeValues } from './place-payload.js';

/** @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.currentTarget).value;

/** @param {{ place: any }} props */
function EditPlace({ place }) {
  const [v, setV] = useState(() => placeValues(place, categorySlugs()));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** @param {string} key */
  const text = key => (/** @type {Event} */ e) => setV((/** @type {any} */ prev) => ({ ...prev, [key]: valueOf(e) }));
  /** @param {Partial<typeof v>} patch */
  const patch = patch => setV((/** @type {any} */ prev) => ({ ...prev, ...patch }));

  // The close and reopen around the map click keeps the typed values: the
  // picked position overwrites the coordinates in the draft.
  const pick = () => {
    const draft = { ...place, ...placeSnapshot(v) };
    closeModal();
    enterPickCoordsMode((/** @type {{ lat: number, lng: number }} */ latlng) => {
      draft.lat = roundCoord(latlng.lat);
      draft.lon = roundCoord(latlng.lng);
      openEditPlaceModal(draft);
    });
  };
  const remove = () => {
    deletePlaceItem(place, {
      animate: true,
      deleted: closeModal,
      onError: (/** @type {Error} */ err) => setError(err.message),
    });
  };
  const save = (/** @type {Event} */ e) => {
    e.preventDefault();
    const r = editPlacePayload(v, place, getShowField);
    if ('error' in r) { setError(t('place.pickLocation')); return; }
    setBusy(true);
    dataLayer.updatePlace({ id: place.id, place: r.payload })
      .then(() => { closeModal(); })
      .catch((/** @type {Error} */ err) => { setBusy(false); setError(err.message); });
  };

  return html`<${DialogHead} title=${t('place.editTitle')} />
    <form id="edit-place-form" onSubmit=${save}>
      <div class="ui-dialog-body">
        <div class="ui-section">
          <${Field} id="e-name" label=${t('form.name')} required>
            <input type="text" id="e-name" required value=${v.name} onInput=${text('name')} />
          <//>
          ${getShowField('local-name') && html`<${Field} id="e-local-name" label=${t('form.localName')}>
            <input type="text" id="e-local-name" placeholder=${t('form.localNamePlaceholder')} value=${v.local_name} onInput=${text('local_name')} />
          <//>`}
          <div class="ui-field-row">
            <${Field} id="e-lat" label=${t('form.latitude')} required>
              <input type="number" id="e-lat" step="any" required value=${v.lat} onInput=${text('lat')} />
            <//>
            <${Field} id="e-lon" label=${t('form.longitude')} required>
              <input type="number" id="e-lon" step="any" required value=${v.lon} onInput=${text('lon')} />
            <//>
          </div>
          <div class="ui-control-row"><button type="button" class="primary" id="e-pick-on-map" onClick=${pick}>${t('form.pickOnMap')}</button></div>
          <${Field} id="e-category" label=${t('form.category')}>
            <${SelectOrNew} id="e-category" options=${categorySlugs()} labelOf=${displayCategory} value=${v.category}
              onChange=${(/** @type {any} */ category) => patch({ category })} newPlaceholder=${t('form.newCategory')} />
          <//>
          <${Field} id="e-country" label=${t('form.country')}>
            <${CountryInput} id="e-country" value=${v.country} onInput=${(/** @type {string} */ country) => patch({ country })} />
          <//>
          ${getShowField('tags') && html`<${Field} id="e-tags" label=${t('form.tags')}>
            <input type="text" id="e-tags" value=${v.tags} placeholder=${t('place.tagsPlaceholder')} onInput=${text('tags')} />
          <//>`}
          ${getShowField('note') && html`<${Field} id="e-note" label=${t('form.note')}>
            <textarea rows="3" id="e-note" value=${v.note} onInput=${text('note')}></textarea>
          <//>`}
          ${getShowField('image') && html`<${Field} id="e-image" label=${t('form.imageUrl')}>
            <input type="url" id="e-image" value=${v.image} placeholder=${t('form.imagePlaceholder')} onInput=${text('image')} />
          <//>`}
          <${Field} id="e-sources" label=${t('form.sources')}>
            <textarea rows="3" id="e-sources" placeholder=${t('form.sourcesPlaceholder')} value=${v.sources} onInput=${text('sources')}></textarea>
          <//>
          <${DoneFields} ids=${{ toggle: 'e-visited', extras: 'e-visited-extras', date: 'e-date-visited', rating: 'e-rating' }}
            label=${t('place.visited')} dateLabel=${t('place.dateVisited')} on=${v.visited}
            onToggle=${(/** @type {boolean} */ visited) => patch({ visited })}
            date=${v.date_visited} onDate=${(/** @type {string} */ date_visited) => patch({ date_visited })}
            rating=${v.rating} onRating=${(/** @type {number} */ rating) => patch({ rating })} />
        </div>
        <${ErrorBox} id="edit-error" msg=${error} />
      </div>
      <div class="ui-dialog-actions">
        <button type="button" class="ui-button ui-button-danger" id="e-delete" onClick=${remove}>${t('common.delete')}</button>
        <span class="action-spacer"></span>
        <button type="submit" class="ui-button ui-button-primary" id="e-submit" disabled=${busy}>${t('common.save')}</button>
      </div>
    </form>`;
}

/** @param {any} place */
export function openEditPlaceModal(place) {
  openViewModal(html`<${EditPlace} place=${place} />`, { phone: 'fullscreen' });
}
