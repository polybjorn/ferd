import { state } from '../core.js';
import { reloadCatalogCache } from '../places-list.js';
import { api } from '../auth.js';
import { t } from '../i18n.js';
import { renderAdminCatalog } from './account.js';
import { openConfirmModal } from '../select.js';
import { closeModal } from '../modal.js';
import {
  DialogHead, ErrorBox, html, openViewModal, useEffect, useFetch, useState,
} from '../view.js';

/** @typedef {import('../core.js').Place} Place */
/** @typedef {import('../places-list.js').CatalogEntry} CatalogEntry */
/** `GET /catalog?include_hidden=1` marks the shipped entries an admin hid. @typedef {CatalogEntry & { _hidden?: boolean }} AdminCatalogEntry */
/** The `POST /admin/catalog/add` response. @typedef {{ ok: true, added: number, skipped: number, total: number }} CatalogAddResult */

const EYE_ON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`;

const failAlert = (/** @type {Error} */ err) => alert(t('common.failed', { message: err.message }));
const metaOf = (/** @type {{ category?: string, country?: string }} */ e) => [e.category, e.country].filter(Boolean).join(' · ');
/** @param {string[]} parts @param {string} q */
const matches = (parts, q) => !q || parts.join('').toLowerCase().includes(q);

// After any change the shared cache and the Admin row go stale.
function catalogChanged() {
  state._catalogCache = null;
  renderAdminCatalog();
  reloadCatalogCache();
}

/** @param {{ note: string }} props */
function Notes({ note }) {
  return note ? html`<span class="row-note">${note}</span>` : '';
}

// Source is conveyed by the action button (eye for shipped, Remove for
// local) and hidden state by the row opacity and the crossed eye.
/** @param {{ e: AdminCatalogEntry, shown: boolean, onChanged: () => void }} props */
function CatalogRow({ e, shown, onChanged }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [e]);
  const name = e.name || t('common.unnamed');
  const meta = metaOf(e);
  const note = (e.note || '').trim();
  const hidden = !!e._hidden;
  const hide = () => {
    setBusy(true);
    api('POST', '/admin/catalog/hide', { name: e.name, hidden: !hidden })
      .then(onChanged)
      .catch((/** @type {Error} */ err) => { setBusy(false); failAlert(err); });
  };
  const remove = () => {
    openConfirmModal({
      title: t('catalog.removeTitle'),
      body: t('catalog.removeBody', { name: e.name || '' }),
      confirmLabel: t('common.remove'),
      danger: true,
    }).then(ok => {
      if (!ok) return;
      setBusy(true);
      api('POST', '/admin/catalog/delete', { names: [e.name] })
        .then(onChanged)
        .catch((/** @type {Error} */ err) => { setBusy(false); failAlert(err); });
    });
  };
  const action = e._source === 'shipped'
    ? html`<button data-act="catalog-hide" data-hidden=${hidden ? '1' : '0'} class="ui-button ui-button-icon catalog-eye-btn" disabled=${busy}
        title=${t(hidden ? 'catalog.unhideTitle' : 'catalog.hideTitle')} aria-label=${t(hidden ? 'catalog.unhide' : 'catalog.hide')} onClick=${hide}>${hidden ? EYE_OFF : EYE_ON}</button>`
    : html`<button data-act="catalog-delete" class="ui-button ui-button-danger" disabled=${busy} onClick=${remove}>${t('common.remove')}</button>`;
  return html`<li class="user-row" data-name=${e.name || ''} style=${(hidden ? 'opacity:0.6;' : '') + (shown ? '' : 'display:none')}>
    <span class="user-name" style="min-width:0">
      <span title=${name} style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
      ${meta && html`<span style="display:block;font-size:var(--ui-text-xs);color:var(--muted);font-weight:400">${meta}</span>`}
      <${Notes} note=${note} />
    </span>
    <div class="user-actions">${action}</div>
  </li>`;
}

function CatalogManager() {
  const [version, setVersion] = useState(0);
  const [filter, setFilter] = useState('');
  const [notes, setNotes] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [busy, setBusy] = useState(false);
  // `include_hidden` brings back the shipped entries the admin has
  // suppressed, so they can be unhidden here.
  const res = useFetch(() => api('GET', '/catalog?include_hidden=1'), [version]);
  const changed = () => { catalogChanged(); setVersion((/** @type {number} */ n) => n + 1); };
  const q = filter.trim().toLowerCase();
  const items = res.status === 'ok' && Array.isArray(res.data)
    ? /** @type {AdminCatalogEntry[]} */ (res.data).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')) : [];
  const clear = () => {
    openConfirmModal({
      title: t('catalog.removeAllTitle'),
      body: t('catalog.removeAllBody'),
      confirmLabel: t('catalog.removeAll'),
      danger: true,
    }).then(ok => {
      if (!ok) return;
      setBusy(true);
      api('POST', '/admin/catalog/clear')
        .then(changed)
        .catch(failAlert)
        .then(() => setBusy(false));
    });
  };
  let body = '';
  if (res.status === 'error') body = html`<div class="hint">${t('catalog.couldNotLoad')}</div>`;
  else if (res.status === 'ok') {
    body = items.length
      ? html`<ul class="user-list">${items.map(e => html`<${CatalogRow} key=${e.name} e=${e} onChanged=${changed}
          shown=${matches([e.name || t('common.unnamed'), metaOf(e), (e.note || '').trim()], q)} />`)}</ul>`
      : html`<div class="hint">${t('catalog.empty')}</div>`;
  }
  const lead = html`<h2 class="ui-dialog-title">${t('catalog.manageTitle')}<span id="cat-mgr-count" class="title-count">${items.length ? '(' + items.length + ')' : ''}</span></h2>`;
  return html`
    <${DialogHead} lead=${lead} />
    <div class="ui-dialog-body">
      <div class="ui-field" style="margin-bottom:var(--ui-space-2)"><input type="text" id="cat-mgr-filter" placeholder=${t('common.filter')} value=${filter} onInput=${(/** @type {Event} */ e) => setFilter(/** @type {HTMLInputElement} */ (e.currentTarget).value)} /></div>
      <div id="cat-mgr-list" class=${(animated ? 'notes-anim' : '') + (notes ? ' show-notes' : '') || undefined}>${body}</div>
    </div>
    <div class="ui-dialog-actions">
      <button type="button" class="ui-button ui-button-quiet" id="cat-mgr-notes-toggle" onClick=${() => { setAnimated(true); setNotes(!notes); }}>${t(notes ? 'common.hideNotes' : 'common.showNotes')}</button>
      <span class="action-spacer"></span>
      <button type="button" id="cat-mgr-clear" class="ui-button ui-button-danger" disabled=${busy} onClick=${clear}>${t('catalog.removeAll')}</button>
    </div>`;
}

export function openCatalogManager() {
  openViewModal(html`<${CatalogManager} />`, { phone: 'fullscreen' });
}

export function openCatalogPicker() {
  const own = Array.isArray(state.places) ? state.places : [];
  if (!own.length) {
    alert(t('catalog.noPlaces'));
    return;
  }
  api('GET', '/catalog').then(catalog => {
    const inCatalog = new Set((Array.isArray(catalog) ? /** @type {CatalogEntry[]} */ (catalog) : []).map(e => e && e.name).filter(Boolean));
    const places = own.filter(p => !inCatalog.has(p.name));
    if (!places.length) {
      alert(t('catalog.allIn'));
      return;
    }
    places.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    openViewModal(html`<${CatalogPicker} places=${places} />`, { phone: 'fullscreen' });
  }).catch((/** @type {Error} */ err) => alert(t('catalog.pickerLoadFailed', { message: err.message })));
}

// state.places carries runtime annotations (`_slug`, a normalised empty
// `category`) that are not part of the server's place schema, so only the
// documented fields are sent.
/** @type {(keyof Place)[]} */
const ALLOWED = ['name', 'lat', 'lon', 'category', 'country', 'visited', 'note', 'sources', 'local_name', 'date_visited', 'rating'];
/**
 * @param {Place} p
 * @returns {Record<string, unknown>}
 */
function cleanPlace(p) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of ALLOWED) {
    if (p[k] === '' && k === 'category') continue;
    if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  }
  return out;
}

/** @param {{ p: Place, shown: boolean, checked: boolean, onPick: (on: boolean) => void }} props */
function PickRow({ p, shown, checked, onPick }) {
  const name = p.name || t('common.unnamed');
  const meta = metaOf(p);
  const note = (p.note || '').trim();
  return html`<label class="browse-row" style=${'display:' + (shown ? 'flex' : 'none') + ';align-items:flex-start;gap:var(--ui-space-2);padding:var(--ui-space-2) 0;border-bottom:1px solid var(--border);cursor:pointer'}>
    <input type="checkbox" class="ui-check cat-pick" checked=${checked} style="margin-top:var(--ui-space-1)" onChange=${(/** @type {Event} */ e) => onPick(/** @type {HTMLInputElement} */ (e.currentTarget).checked)} />
    <span style="flex:1;min-width:0">
      <span title=${name} style="display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
      ${meta && html`<span style="display:block;font-size:var(--ui-text-xs);color:var(--muted)">${meta}</span>`}
      <${Notes} note=${note} />
    </span>
  </label>`;
}

/** @param {{ places: Place[] }} props */
function CatalogPicker({ places }) {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = /** @type {[Set<number>, (next: (prev: Set<number>) => Set<number>) => void]} */ (useState(() => new Set()));
  const [notes, setNotes] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const q = filter.trim().toLowerCase();
  const shown = places.map(p => matches([p.name || t('common.unnamed'), metaOf(p), (p.note || '').trim()], q));
  const visible = places.map((_, i) => i).filter(i => shown[i]);
  const allVisible = visible.length > 0 && visible.every(i => picked.has(i));
  /** @param {number} i @param {boolean} on */
  const setOne = (i, on) => setPicked(prev => {
    const next = new Set(prev);
    if (on) next.add(i); else next.delete(i);
    return next;
  });
  const toggleAll = () => setPicked(prev => {
    const next = new Set(prev);
    visible.forEach(i => { if (allVisible) next.delete(i); else next.add(i); });
    return next;
  });
  /** @param {Record<string, unknown>[]} picks */
  const doSubmit = picks => {
    setAdding(true);
    setError('');
    api('POST', '/admin/catalog/add', { entries: picks }).then((/** @type {CatalogAddResult} */ r) => {
      closeModal();
      catalogChanged();
      // The skip count tells the admin that dedup happened.
      if (r.skipped) alert(t('catalog.skipped', { added: r.added, skipped: r.skipped }));
    }).catch((/** @type {Error} */ err) => { setAdding(false); setError(err.message); });
  };
  const submit = () => {
    const picks = [...picked].sort((a, b) => a - b).map(i => cleanPlace(places[i]));
    if (!picks.length) return;
    openConfirmModal({
      title: t('catalog.addTitle'),
      body: t('catalog.addBody', { count: picks.length }),
      confirmLabel: t('catalog.addConfirm', { n: picks.length }),
    }).then(ok => { if (ok) doSubmit(picks); });
  };
  return html`
    <${DialogHead} title=${t('catalog.pickerTitle')} />
    <div class="ui-dialog-body">
      <div class="ui-field" style="margin-bottom:var(--ui-space-2)"><input type="text" id="cat-filter" placeholder=${t('common.filter')} value=${filter} onInput=${(/** @type {Event} */ e) => setFilter(/** @type {HTMLInputElement} */ (e.currentTarget).value)} /></div>
      <div id="cat-list" class=${(animated ? 'notes-anim' : '') + (notes ? ' show-notes' : '') || undefined}>
        ${places.map((p, i) => html`<${PickRow} key=${i} p=${p} shown=${shown[i]} checked=${picked.has(i)} onPick=${(/** @type {boolean} */ on) => setOne(i, on)} />`)}
      </div>
      <${ErrorBox} id="add-error" msg=${error} />
    </div>
    <div class="ui-dialog-actions">
      <button type="button" class="ui-button ui-button-quiet" id="cat-notes-toggle" onClick=${() => { setAnimated(true); setNotes(!notes); }}>${t(notes ? 'common.hideNotes' : 'common.showNotes')}</button>
      <span id="cat-status" style="font-size:var(--ui-text-xs);color:var(--muted);flex:1">${adding ? t('catalog.adding') : ''}</span>
      <button type="button" class="ui-button" id="cat-select-all" disabled=${adding || !visible.length} onClick=${toggleAll}>${t(allVisible ? 'catalog.deselectAll' : 'catalog.selectAll')}</button>
      <button type="button" class="ui-button ui-button-primary" id="cat-submit" disabled=${adding || !picked.size} onClick=${submit}>${picked.size ? t('catalog.addCount', { n: picked.size }) : t('catalog.addSelected')}</button>
    </div>`;
}
