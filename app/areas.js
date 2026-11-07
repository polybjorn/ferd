import { displayCategory, escapeHtml, sortedCategorySlugs, state } from './core.js';
import { dataLayer } from './store.js';
import { readSelectOrNew, selectOrNewHtml, wireSelectOrNew } from './form-fields.js';
import { getShowField } from './prefs.js';
import { areaFadeOut, refreshPlacesPresentation } from './map/index.js';
import {
  modalErrorHtml, modalHeaderHtml, openConfirmModal, uiFieldHtml, uiToggleHtml,
} from './select.js';
import { closeModal, openFullScreenModal, showModalError } from './modal.js';

export function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
export function manifestRoutes() {
  return ((state.manifest && state.manifest.regions) || []).flatMap(region => region.routes);
}
// The fields the Add and Edit forms share, read from the given id prefix.
export function readAreaFormFields(prefix) {
  const payload = { visited: /** @type {HTMLInputElement} */ (document.getElementById(prefix + '-visited')).checked };
  const category = readSelectOrNew(prefix + '-category');
  if (category) payload.category = category;
  const noteEl = /** @type {HTMLTextAreaElement} */ (document.getElementById(prefix + '-note'));
  const note = noteEl ? noteEl.value.trim() : '';
  if (note) payload.note = note;
  return payload;
}
// Settings > Optional fields can leave the input out of the form, and a
// save replaces the whole area, so `kept` is what survives it.
export function readAreaLocalName(prefix, kept) {
  const el = /** @type {HTMLInputElement} */ (document.getElementById(prefix + '-local-name'));
  return el ? el.value.trim() : (kept || '');
}
function areaLocalNameHtml(prefix, value) {
  return getShowField('local-name') ?
    uiFieldHtml(prefix + '-local-name', 'Local name',
      '<input type="text" id="' + prefix + '-local-name" maxlength="200" placeholder="In the local language" value="' + escapeHtml(value || '') + '">')
  : '';
}
function areaFieldsHtml(prefix, area) {
  const cats = sortedCategorySlugs(Object.keys(state.categoryColors).filter(c => c !== ''));
  return uiFieldHtml(prefix + '-category', 'Category',
      selectOrNewHtml(prefix + '-category', cats, (area && area.category) || null, displayCategory, '', 'New category name')) +
    (getShowField('note') ?
      uiFieldHtml(prefix + '-note', 'Note',
        '<textarea id="' + prefix + '-note">' + escapeHtml((area && area.note) || '') + '</textarea>')
    : '') +
    '<div>' +
      uiToggleHtml(prefix + '-visited', 'I&rsquo;ve visited this area', { checked: area && area.visited }) +
      '<p class="ui-hint">A visited place or completed route inside also makes it visited.</p>' +
    '</div>';
}
export function openEditAreaModal(area) {
  openFullScreenModal(
    modalHeaderHtml('Edit area') +
    '<form id="edit-area-form">' +
      '<div class="ui-section">' +
        uiFieldHtml('ea-name', 'Name',
          '<input type="text" id="ea-name" required maxlength="200" value="' + escapeHtml(area.name) + '">', { required: true }) +
        areaLocalNameHtml('ea', area.local_name) +
        areaFieldsHtml('ea', area) +
      '</div>' +
      modalErrorHtml('edit-area-error') +
      '<div class="ui-dialog-actions">' +
        '<button type="button" class="ui-button ui-button-danger" id="ea-delete">Delete</button>' +
        '<span class="action-spacer"></span>' +
        '<button type="submit" class="ui-button ui-button-primary" id="ea-submit">Save</button>' +
      '</div>' +
    '</form>',
    function() {
      wireSelectOrNew('ea-category');
      const done = () => Promise.resolve().then(() => { closeModal(); refreshPlacesPresentation(); });
      document.getElementById('ea-delete').addEventListener('click', function() {
        const btn = /** @type {HTMLButtonElement} */ (this);
        openConfirmModal({ title: 'Delete area?', body: 'Delete "' + area.name + '"?', confirmLabel: 'Delete', danger: true }).then(ok => {
          if (!ok) return;
          btn.disabled = true;
          const fadeOut = areaFadeOut(area);
          dataLayer.deleteArea({ id: area.id }).then(
            () => {
              closeModal();
              return Promise.resolve().then(() => {
                fadeOut();
                refreshPlacesPresentation();
              }).catch(err => alert('Failed: ' + err.message));
            },
            err => { btn.disabled = false; showModalError(err.message); }
          );
        });
      });
      document.getElementById('edit-area-form').addEventListener('submit', function(e) {
        e.preventDefault();
        const payload = Object.assign(readAreaFormFields('ea'), {
          name: /** @type {HTMLInputElement} */ (document.getElementById('ea-name')).value.trim(),
          geometry: area.geometry,
        });
        // A note hidden via Settings > Optional fields isn't in the form,
        // and a save replaces the whole area.
        if (!getShowField('note') && area.note) payload.note = area.note;
        const local = readAreaLocalName('ea', area.local_name);
        if (local) payload.local_name = local;
        if (area.source) payload.source = area.source;
        const submit = /** @type {HTMLButtonElement} */ (document.getElementById('ea-submit'));
        submit.disabled = true;
        dataLayer.updateArea({ id: area.id, area: payload }).then(done)
          .catch(err => { submit.disabled = false; showModalError(err.message); });
      });
    }
  );
}
