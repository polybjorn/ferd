import { state } from '../core.js';
import { dataLayer } from '../store.js';
import { DoneFields, SelectOrNew, difficultyOptions } from '../form-fields.js';
import { getShowField } from '../prefs.js';
import { deleteRouteItem } from '../map/index.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { DialogHead, ErrorBox, Field, RadioPills, html, openViewModal, useState } from '../view.js';
import { editRoutePlan, routeMetaValues } from './route-payload.js';

export const DIFFICULTY_LABELS = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard', expert: 'Expert' };

/** @param {any} route */
function routeMetadataKey(route) {
  // The manifest keys metadata by the on-disk region directory, not the
  // display name. For a route in a region, route.file is "Region/Route.gpx"
  // and we use the first segment. For a no-region (root-level) route,
  // route.file is just "Route.gpx" and the key omits the region prefix.
  const file = route.file || '';
  if (!file.includes('/')) return route.name;
  return file.split('/')[0] + '/' + route.name;
}

/** @param {number} rating */
export function ratingStars(rating) {
  // The empty stars are faded filled ones rather than ☆, so they stay
  // glyph-identical (☆ and ★ render at different widths in most fonts).
  if (!rating) return null;
  const empty = 5 - rating;
  return html`${'★'.repeat(rating)}${empty > 0 && html`<span class="stars-empty">${'★'.repeat(empty)}</span>`}`;
}

// Keys of routes mid-move. The old key leaves the store before the new one
// is known, and the open detail page must not read that as a delete.
const moving = new Set();
/** @param {string} key */
export function routeIsMoving(key) { return moving.has(key); }

/** @param {string} key */
export function findRouteByKey(key) {
  if (!state.manifest) return null;
  for (const region of state.manifest.regions) {
    for (const route of region.routes) {
      if (route.key === key) return { route, region };
    }
  }
  return null;
}

/** @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.currentTarget).value;

/** @param {{ route: any, regionName: string }} props */
function EditRoute({ route, regionName }) {
  const key = routeMetadataKey(route);
  const regions = ((state.manifest && state.manifest.regions) || [])
    .map((/** @type {any} */ r) => r.name).filter(Boolean).sort((/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b));
  const [v, setV] = useState(() => routeMetaValues(route, regionName, regions));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** @param {Partial<typeof v>} p */
  const patch = p => setV((/** @type {any} */ prev) => ({ ...prev, ...p }));
  /** @param {keyof typeof v} k */
  const text = k => (/** @type {Event} */ e) => patch({ [k]: valueOf(e) });

  const remove = () => {
    deleteRouteItem(route, regionName, () => { closeModal(); });
  };
  const save = (/** @type {Event} */ e) => {
    e.preventDefault();
    const plan = editRoutePlan(v, route, regionName, getShowField);
    if ('error' in plan) {
      setError(plan.error === 'name' ? t('route.nameRequired') : t('route.regionRequired'));
      return;
    }
    const { metadata, newName, targetRegion, newCompleted, needsMove, needsCompletedFlip } = plan;
    setBusy(true);
    if (needsMove) moving.add(route.key);
    /** @type {Promise<string>} */
    let chain = Promise.resolve(key);
    if (needsCompletedFlip) {
      chain = chain.then(k => dataLayer.setGpxCompleted({ key: k, completed: newCompleted }).then(() => k));
    }
    if (needsMove) {
      chain = chain.then(k => dataLayer.moveGpx({ key: k, new_region: targetRegion, new_name: newName }).then((/** @type {any} */ r) => r.new_key));
    }
    let movedKey = key;
    chain
      .then(finalKey => { movedKey = finalKey; return dataLayer.putMetadata({ key: finalKey, metadata }); })
      .then(() => {
        closeModal();
        // If this route's detail view is open and it moved (region or
        // name changed), its URL key is now stale; reroute to the new
        // key instead of leaving a dead link behind.
        const seg = location.hash.split('/routes/route/')[1];
        const onThisDetail = seg && decodeURIComponent(seg) === route.key;
        if (needsMove && onThisDetail && movedKey && movedKey !== route.key) {
          location.hash = '#/routes/route/' + encodeURIComponent(movedKey);
        }
      })
      .catch((/** @type {Error} */ err) => {
        setBusy(false);
        setError(err.message);
        const seg = location.hash.split('/routes/route/')[1];
        if (movedKey !== route.key && seg && decodeURIComponent(seg) === route.key) {
          location.hash = '#/routes/route/' + encodeURIComponent(movedKey);
        }
      })
      .finally(() => { moving.delete(route.key); });
  };

  return html`<${DialogHead} title=${t('route.editTitle')} />
    <form id="route-meta-form" onSubmit=${save}>
      <div class="ui-dialog-body">
        <div class="ui-section">
          <${Field} id="tm-name" label=${t('form.name')} required>
            <input type="text" id="tm-name" required maxlength="64" value=${v.name} onInput=${text('name')} />
          <//>
          ${getShowField('local-name') && html`<${Field} id="tm-local-name" label=${t('form.localName')}>
            <input type="text" id="tm-local-name" placeholder=${t('form.localNamePlaceholder')} value=${v.local_name} onInput=${text('local_name')} />
          <//>`}
          <${Field} id="tm-region" label=${t('form.region')}>
            <${SelectOrNew} id="tm-region" options=${regions} value=${v.region} emptyLabel=${t('route.noRegion')}
              addLabel=${t('route.addRegion')} newPlaceholder=${t('form.newRegion')} focusNew maxLength=${64}
              onChange=${(/** @type {any} */ region) => patch({ region })} />
          <//>
          <${Field} label=${t('form.difficulty')}>
            <${RadioPills} name="tm-difficulty" options=${difficultyOptions()} initial=${v.difficulty}
              onPick=${(/** @type {string} */ difficulty) => patch({ difficulty })} />
          <//>
          ${getShowField('tags') && html`<${Field} id="tm-tags" label=${t('form.tagsComma')}>
            <input type="text" id="tm-tags" value=${v.tags} placeholder=${t('route.tagsPlaceholder')} onInput=${text('tags')} />
          <//>`}
          ${getShowField('note') && html`<${Field} id="tm-notes" label=${t('form.notes')}>
            <textarea id="tm-notes" maxlength="2000" value=${v.notes} onInput=${text('notes')}></textarea>
          <//>`}
          <${Field} id="tm-source" label=${t('form.sourceUrl')}>
            <input type="url" id="tm-source" value=${v.source} placeholder=${t('route.sourcePlaceholder')} onInput=${text('source')} />
          <//>
          <${DoneFields} ids=${{ toggle: 'tm-completed', extras: 'tm-completed-extras', date: 'tm-date', rating: 'tm-rating' }}
            label=${t('route.completed')} dateLabel=${t('route.dateCompleted')} on=${v.completed}
            onToggle=${(/** @type {boolean} */ completed) => patch({ completed })}
            date=${v.date} onDate=${(/** @type {string} */ date) => patch({ date })}
            rating=${v.rating} onRating=${(/** @type {number} */ rating) => patch({ rating })} />
        </div>
        <${ErrorBox} id="tm-error" msg=${error} />
      </div>
      <div class="ui-dialog-actions">
        <button type="button" class="ui-button ui-button-danger" id="tm-delete" onClick=${remove}>${t('common.delete')}</button>
        <span class="action-spacer"></span>
        <button type="submit" class="ui-button ui-button-primary" id="tm-submit" disabled=${busy}>${t('common.save')}</button>
      </div>
    </form>`;
}

/** @param {any} route @param {string} regionName */
export function openEditTrailMetadataModal(route, regionName) {
  openViewModal(html`<${EditRoute} route=${route} regionName=${regionName || ''} />`, { phone: 'fullscreen' });
}
