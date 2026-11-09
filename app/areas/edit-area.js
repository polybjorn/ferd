import { displayCategory } from '../core.js';
import { dataLayer } from '../store.js';
import { SelectOrNew, categorySlugs } from '../form-fields.js';
import { getShowField } from '../prefs.js';
import { areaFadeOut } from '../map/index.js';
import { openConfirmModal } from '../select.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { DialogHead, ErrorBox, Field, Fragment, Toggle, html, openViewModal, useState } from '../view.js';
import { areaValues, editAreaPayload } from './area-payload.js';

/** @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.currentTarget).value;

/**
 * The fields an area has in the Edit and Add forms: local name, category,
 * note and the visited toggle. The id prefix keeps the two forms' ids apart.
 * @param {{ prefix: string, v: import('./area-payload.js').AreaValues,
 *   patch: (p: Partial<import('./area-payload.js').AreaValues>) => void, extraCategories?: string[] }} props
 */
export function AreaFields({ prefix, v, patch, extraCategories }) {
  const options = categorySlugs().concat((extraCategories || []).filter(c => !categorySlugs().includes(c)));
  return html`<${Fragment}>
    <${Field} id=${prefix + '-category'} label=${t('form.category')}>
      <${SelectOrNew} id=${prefix + '-category'} options=${options} labelOf=${displayCategory} value=${v.category}
        onChange=${(/** @type {any} */ category) => patch({ category })} newPlaceholder=${t('form.newCategory')} />
    <//>
    ${getShowField('note') && html`<${Field} id=${prefix + '-note'} label=${t('form.note')}>
      <textarea rows="3" id=${prefix + '-note'} value=${v.note} onInput=${(/** @type {Event} */ e) => patch({ note: valueOf(e) })}></textarea>
    <//>`}
    <div>
      <${Toggle} id=${prefix + '-visited'} label=${t('area.visited')} initial=${v.visited} onToggle=${(/** @type {boolean} */ visited) => patch({ visited })} />
      <p class="ui-hint">${t('area.visitedHint')}</p>
    </div>
  </${Fragment}>`;
}

/**
 * The local name input, when Settings > Optional fields shows it.
 * @param {{ prefix: string, v: import('./area-payload.js').AreaValues,
 *   patch: (p: Partial<import('./area-payload.js').AreaValues>) => void }} props
 */
export function AreaLocalName({ prefix, v, patch }) {
  if (!getShowField('local-name')) return null;
  return html`<${Field} id=${prefix + '-local-name'} label=${t('form.localName')}>
    <input type="text" id=${prefix + '-local-name'} maxlength="200" placeholder=${t('form.localNamePlaceholder')}
      value=${v.local_name} onInput=${(/** @type {Event} */ e) => patch({ local_name: valueOf(e) })} />
  </${Field}>`;
}

/** @param {{ area: any }} props */
function EditArea({ area }) {
  const [v, setV] = useState(() => areaValues(area, categorySlugs()));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** @param {Partial<typeof v>} p */
  const patch = p => setV((/** @type {any} */ prev) => ({ ...prev, ...p }));

  const remove = () => {
    openConfirmModal({
      title: t('area.deleteTitle'), body: t('area.deleteBody', { name: area.name }),
      confirmLabel: t('common.delete'), danger: true,
    }).then(ok => {
      if (!ok) return;
      setBusy(true);
      const fadeOut = areaFadeOut(area);
      dataLayer.deleteArea({ id: area.id }).then(
        () => { closeModal(); Promise.resolve().then(fadeOut); },
        (/** @type {Error} */ err) => { setBusy(false); setError(err.message); },
      );
    });
  };
  const save = (/** @type {Event} */ e) => {
    e.preventDefault();
    setBusy(true);
    dataLayer.updateArea({ id: area.id, area: editAreaPayload(v, area, getShowField) })
      .then(() => closeModal())
      .catch((/** @type {Error} */ err) => { setBusy(false); setError(err.message); });
  };

  return html`<${DialogHead} title=${t('area.editTitle')} />
    <form id="edit-area-form" onSubmit=${save}>
      <div class="ui-dialog-body">
        <div class="ui-section">
          <${Field} id="ea-name" label=${t('form.name')} required>
            <input type="text" id="ea-name" required maxlength="200" value=${v.name} onInput=${(/** @type {Event} */ e) => patch({ name: valueOf(e) })} />
          <//>
          <${AreaLocalName} prefix="ea" v=${v} patch=${patch} />
          <${AreaFields} prefix="ea" v=${v} patch=${patch} />
        </div>
        <${ErrorBox} id="edit-area-error" msg=${error} />
      </div>
      <div class="ui-dialog-actions">
        <button type="button" class="ui-button ui-button-danger" id="ea-delete" disabled=${busy} onClick=${remove}>${t('common.delete')}</button>
        <span class="action-spacer"></span>
        <button type="submit" class="ui-button ui-button-primary" id="ea-submit" disabled=${busy}>${t('common.save')}</button>
      </div>
    </form>`;
}

/** @param {any} area */
export function openEditAreaModal(area) {
  openViewModal(html`<${EditArea} area=${area} />`, { phone: 'fullscreen' });
}
