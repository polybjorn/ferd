import { displayCategory } from '../core.js';
import { dataLayer } from '../store.js';
import { CountryInput, DoneFields, SelectOrNew, Collapsible, categorySlugs } from '../form-fields.js';
import { getShowField } from '../prefs.js';
import { enterPickCoordsMode } from '../map/index.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { ErrorBox, Field, html, useState } from '../view.js';
import { placePayload, placeSnapshot, placeValues } from './place-payload.js';

/** @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.currentTarget).value;

// The Place tab of the Add dialog. `prefillCoords` is a map pick, `draft`
// the fields to restore around one, and `reopen` opens the dialog again
// with the picked position.
/**
 * @param {{ prefillCoords?: { lat: number, lng: number } | null, draft?: any,
 *   reopen: (coords: { lat: number, lng: number }, draft: any) => void }} props
 */
export function AddPlace({ prefillCoords, draft, reopen }) {
  const c = prefillCoords;
  const [v, setV] = useState(() => ({
    ...placeValues(draft, categorySlugs()),
    lat: c ? c.lat.toFixed(5) : '',
    lon: c ? c.lng.toFixed(5) : '',
  }));
  const [manual, setManual] = useState(!!c);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** @param {Partial<typeof v>} p */
  const patch = p => setV((/** @type {any} */ prev) => ({ ...prev, ...p }));
  /** @param {keyof typeof v} k */
  const text = k => (/** @type {Event} */ e) => patch({ [k]: valueOf(e) });

  // The dialog closes for the map click and reopens with the typed values,
  // so a pick keeps what the user entered.
  const pick = () => {
    const snapshot = placeSnapshot(v);
    closeModal();
    enterPickCoordsMode((/** @type {{ lat: number, lng: number }} */ latlng) => {
      reopen({ lat: latlng.lat, lng: latlng.lng }, snapshot);
    });
  };
  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    const r = placePayload(v, getShowField);
    if ('error' in r) { setError(t('place.pickLocation')); return; }
    setBusy(true);
    dataLayer.createPlace(r.payload)
      .then(() => { closeModal(); })
      .catch((/** @type {Error} */ err) => { setBusy(false); setError(err.message); });
  };

  return html`<form id="place-form" onSubmit=${submit}>
    <div class="ui-section">
      <${Field} id="p-name" label=${t('form.name')} required>
        <input type="text" id="p-name" required value=${v.name} onInput=${text('name')} />
      <//>
      ${getShowField('local-name') && html`<${Field} id="p-local-name" label=${t('form.localName')}>
        <input type="text" id="p-local-name" placeholder=${t('form.localNamePlaceholder')} value=${v.local_name} onInput=${text('local_name')} />
      <//>`}
      <div>
        <${Field} label=${t('form.coordinates')} required>
          <div class="ui-control-row">
            <button type="button" class="primary" id="pick-on-map" onClick=${pick}>${c ? t('place.repick') : t('form.pickOnMap')}</button>
            ${c
              ? html`<span class="ui-control-text" id="p-coords-display">${c.lat.toFixed(5) + ', ' + c.lng.toFixed(5)}</span>`
              : !manual && html`<a href="#" class="ui-control-text" id="p-coords-manual" onClick=${(/** @type {Event} */ e) => { e.preventDefault(); setManual(true); }}>${t('place.enterManually')}</a>`}
          </div>
        <//>
        <${Collapsible} id="p-coords-fields" open=${manual}>
          <div class="ui-field-row">
            <${Field} id="p-lat" label=${t('form.latitude')}>
              <input type="number" id="p-lat" step="any" value=${v.lat} onInput=${text('lat')} />
            <//>
            <${Field} id="p-lon" label=${t('form.longitude')}>
              <input type="number" id="p-lon" step="any" value=${v.lon} onInput=${text('lon')} />
            <//>
          </div>
        <//>
      </div>
      <${Field} id="p-category" label=${t('form.category')}>
        <${SelectOrNew} id="p-category" options=${categorySlugs()} labelOf=${displayCategory} value=${v.category}
          onChange=${(/** @type {any} */ category) => patch({ category })} newPlaceholder=${t('form.newCategory')} />
      <//>
      <${Field} id="p-country" label=${t('form.country')}>
        <${CountryInput} id="p-country" value=${v.country} onInput=${(/** @type {string} */ country) => patch({ country })} />
      <//>
      ${getShowField('note') && html`<${Field} id="p-note" label=${t('form.note')}>
        <textarea id="p-note" value=${v.note} onInput=${text('note')}></textarea>
      <//>`}
      ${getShowField('image') && html`<${Field} id="p-image" label=${t('form.imageUrl')}>
        <input type="url" id="p-image" placeholder=${t('form.imagePlaceholder')} value=${v.image} onInput=${text('image')} />
      <//>`}
      <${Field} id="p-sources" label=${t('form.sources')}>
        <textarea id="p-sources" placeholder=${t('form.sourcesPlaceholder')} value=${v.sources} onInput=${text('sources')}></textarea>
      <//>
      <${DoneFields} ids=${{ toggle: 'p-visited', extras: 'p-visited-extras', date: 'p-date-visited', rating: 'p-rating' }}
        label=${t('place.visited')} dateLabel=${t('place.dateVisited')} on=${v.visited}
        onToggle=${(/** @type {boolean} */ visited) => patch({ visited })}
        date=${v.date_visited} onDate=${(/** @type {string} */ date_visited) => patch({ date_visited })}
        rating=${v.rating} onRating=${(/** @type {number} */ rating) => patch({ rating })} />
    </div>
    <${ErrorBox} id="add-error" msg=${error} />
    <div class="modal-actions">
      <button type="submit" class="ui-button ui-button-primary" id="place-submit" disabled=${busy}>${t('place.add')}</button>
    </div>
  </form>`;
}
