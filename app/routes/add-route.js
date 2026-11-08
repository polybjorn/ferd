import { state } from '../core.js';
import { dataLayer } from '../store.js';
import { DoneFields, FilePick, SelectOrNew, difficultyOptions } from '../form-fields.js';
import { getShowField } from '../prefs.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { ErrorBox, Field, RadioPills, Toggle, html, useState } from '../view.js';
import { gpxUploadPlan, routeMetaValues } from './route-payload.js';

/** @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.currentTarget).value;

// The Route tab of the Add dialog: a GPX file and its metadata.
export function AddRoute() {
  // Skip the synthetic no-region group ("") when listing existing regions.
  const regions = (state.manifest ? state.manifest.regions.map((/** @type {any} */ r) => r.name).filter(Boolean) : [])
    .sort((/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b));
  const [v, setV] = useState(() => routeMetaValues(null, '', regions));
  const [file, setFile] = useState(/** @type {File | null} */ (null));
  const [strip, setStrip] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** @param {Partial<typeof v>} p */
  const patch = p => setV((/** @type {any} */ prev) => ({ ...prev, ...p }));
  /** @param {keyof typeof v} k */
  const text = k => (/** @type {Event} */ e) => patch({ [k]: valueOf(e) });

  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    const plan = gpxUploadPlan(v, file, getShowField);
    if ('error' in plan) { setError(t('route.needFile')); return; }
    setBusy(true);
    dataLayer.uploadGpx({ region: plan.region, name: plan.storedName, stripPii: strip, file })
      .then(() => {
        if (Object.keys(plan.metadata).length === 0) return null;
        return dataLayer.putMetadata({ key: plan.metaKey, metadata: plan.metadata });
      })
      .then(() => {
        closeModal();
      })
      .catch((/** @type {Error} */ err) => { setBusy(false); setError(err.message); });
  };

  return html`<form id="gpx-form" onSubmit=${submit}>
    <div class="ui-section">
      <${Field} id="g-name" label=${t('form.name')} required>
        <input type="text" id="g-name" required placeholder=${t('route.namePlaceholder')} value=${v.name} onInput=${text('name')} />
      <//>
      ${getShowField('local-name') && html`<${Field} id="g-local-name" label=${t('form.localName')}>
        <input type="text" id="g-local-name" placeholder=${t('form.localNamePlaceholder')} value=${v.local_name} onInput=${text('local_name')} />
      <//>`}
      <${Field} label=${t('route.gpxFile')} required>
        <${FilePick} id="g-file" accept=".gpx,application/gpx+xml,text/xml" required file=${file} onFile=${setFile} />
      <//>
      <${Field} id="g-region" label=${t('form.region')}>
        <${SelectOrNew} id="g-region" options=${regions} value=${v.region} newPlaceholder=${t('form.newRegion')}
          onChange=${(/** @type {any} */ region) => patch({ region })} />
      <//>
      <${Field} label=${t('form.difficulty')}>
        <${RadioPills} name="g-difficulty" options=${difficultyOptions()} initial=${v.difficulty}
          onPick=${(/** @type {string} */ difficulty) => patch({ difficulty })} />
      <//>
      ${getShowField('tags') && html`<${Field} id="g-tags" label=${t('form.tagsComma')}>
        <input type="text" id="g-tags" placeholder=${t('route.tagsPlaceholder')} value=${v.tags} onInput=${text('tags')} />
      <//>`}
      ${getShowField('note') && html`<${Field} id="g-notes" label=${t('form.notes')}>
        <textarea id="g-notes" maxlength="2000" value=${v.notes} onInput=${text('notes')}></textarea>
      <//>`}
      <${Field} id="g-source" label=${t('form.sourceUrl')}>
        <input type="url" id="g-source" placeholder=${t('route.sourcePlaceholder')} value=${v.source} onInput=${text('source')} />
      <//>
      <${Toggle} id="g-strip-pii" label=${t('route.stripPii')} title=${t('route.stripPiiHint')} initial=${strip} onToggle=${setStrip} />
      <${DoneFields} ids=${{ toggle: 'g-completed', extras: 'g-completed-extras', date: 'g-date', rating: 'g-rating' }}
        label=${t('route.completed')} dateLabel=${t('route.dateCompleted')} on=${v.completed}
        onToggle=${(/** @type {boolean} */ completed) => patch({ completed })}
        date=${v.date} onDate=${(/** @type {string} */ date) => patch({ date })}
        rating=${v.rating} onRating=${(/** @type {number} */ rating) => patch({ rating })} />
    </div>
    <${ErrorBox} id="add-error" msg=${error} />
    <div class="form-actions">
      <button type="submit" class="ui-button ui-button-primary" id="gpx-submit" disabled=${busy}>${t('route.upload')}</button>
    </div>
  </form>`;
}
