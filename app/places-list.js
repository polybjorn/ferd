import { state } from './core.js';

/** @typedef {import('./core.js').Place} Place */
/**
 * A catalog entry: a place plus the `_source` the server tags it with.
 * @typedef {Place & { _source?: string }} CatalogEntry
 */
/**
 * @typedef {object} CatalogChange
 * @property {keyof Place} field
 * @property {any} before the place's value
 * @property {any} after the catalog's value
 */
import { fetchJson, hasServer } from './server.js';
import { dataLayer } from './store.js';
import { refreshOpenPlacePopup, redrawPlaces, refreshPlacesPresentation } from './map/index.js';
import { api } from './auth.js';
import { closeModal } from './modal.js';
import { t } from './i18n.js';
import {
  DialogHead, ErrorBox, html, openViewModal, useEffect, useRef, useState,
} from './view.js';

// Fields the catalog "owns" - personal status (visited / date_visited /
// rating / from_catalog / runtime annotations) is preserved on refresh.
/** @type {(keyof Place)[]} */
const CATALOG_TRACKED_FIELDS = ['name', 'lat', 'lon', 'category', 'country', 'local_name', 'note', 'image', 'image_focus', 'sources', 'tags'];
// The t() key that labels each field in the diff.
/** @type {Record<string, string>} */
const CATALOG_FIELD_LABELS = {
  name: 'form.name', lat: 'form.latitude', lon: 'form.longitude', category: 'form.category', country: 'form.country',
  local_name: 'form.localName', note: 'form.note', image: 'catalogUpdate.fieldImage',
  image_focus: 'catalogUpdate.fieldImageFocus', sources: 'form.sources', tags: 'form.tags',
};

// Returns { entry, changes: [{field, before, after}] } when the upstream
// catalog entry for a place's from_catalog has diverged from the local
// copy, else null. Catalog source is the client-side cache populated on
// boot; if it isn't loaded yet, returns null (no false-positive indicator).
// Resolve the catalog entry an imported place is linked to. Primary key is
// the stored name (from_catalog); falls back to matching the catalog
// entry's primary source against the place's own sources, so a catalog
// rename doesn't break the link (the source URL is stable across renames).
/**
 * @param {Place | null | undefined} place
 * @returns {CatalogEntry | null}
 */
function catalogEntryFor(place) {
  if (!place || !place.from_catalog || !Array.isArray(state._catalogCache)) return null;
  let entry = state._catalogCache.find(e => e && e.name === place.from_catalog);
  if (entry) return entry;
  const psources = Array.isArray(place.sources) ? place.sources : [];
  if (!psources.length) return null;
  return state._catalogCache.find(e =>
    e && Array.isArray(e.sources) && e.sources[0] && psources.includes(e.sources[0])
  ) || null;
}

// An imported place whose catalog entry no longer exists (removed from the
// catalog) - distinct from a rename, which re-links via catalogEntryFor.
// Only meaningful once the catalog cache has loaded.
/** @param {Place | null | undefined} place */
export function isCatalogOrphan(place) {
  return !!(place && place.from_catalog && Array.isArray(state._catalogCache) && !catalogEntryFor(place));
}

// Refetch the catalog into the cache and refresh the places list if it's
// the current view, so catalog edits (add/remove/hide/baseline) update the
// import badges and orphan markers live, without a page reload. Admin
// Catalog source facade. Server mode reads the merged catalog from
// /catalog (shipped baseline + per-instance admin-curated entries). Local
// mode has no server, so it reads the shipped baseline straight from the
// bundled static catalog.json, tagging each entry _source:'shipped' to
// match the server's shape. Admin curation has no local analogue, so the
// catalog-management UI stays hidden in local mode; browse + import +
// update-detection all work against the static file.
export function fetchCatalog() {
  if (!hasServer()) {
    return fetchJson('catalog.json', []).then(arr =>
      Array.isArray(arr) ? arr.map(e => Object.assign({ _source: 'shipped' }, e)) : []);
  }
  return api('GET', '/catalog');
}

// mutation handlers null the cache for their own modal refetch; this
// repopulates it and re-renders the list behind the modal.
export function reloadCatalogCache() {
  return fetchCatalog().then(entries => {
    state._catalogCache = Array.isArray(entries) ? entries : [];
  }).catch(() => {});
}

// Catalog fields compare as equal when they differ only by surrounding
// whitespace or by empty-vs-missing, so a cosmetic upstream edit does not
// surface as an update.
/**
 * @param {unknown} v
 * @returns {unknown}
 */
function catalogNorm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return v.length ? v.map(catalogNorm) : null;
  return v;
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function catalogEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => catalogEq(x, b[i]));
  return false;
}

/**
 * @param {Place | null | undefined} place
 * @returns {{ entry: CatalogEntry, changes: CatalogChange[] } | null}
 */
export function findCatalogUpdate(place) {
  if (!place || !place.from_catalog) return null;
  if (!Array.isArray(state._catalogCache)) return null;
  const entry = catalogEntryFor(place);
  if (!entry) return null;
  const skip = (place && place.catalog_skip) || {};
  /** @type {CatalogChange[]} */
  const changes = [];
  for (const f of CATALOG_TRACKED_FIELDS) {
    const a = catalogNorm(place[f]);
    const b = catalogNorm(entry[f]);
    if (catalogEq(a, b)) continue;
    // Skipped: hide the diff while the catalog value still matches what
    // the user dismissed. If the catalog value has moved on, surface it
    // again as a fresh update.
    if (f in skip && catalogEq(catalogNorm(skip[f]), b)) continue;
    changes.push({ field: f, before: place[f], after: entry[f] });
  }
  return changes.length ? { entry, changes } : null;
}

// A diff image that fails to load is swapped for its URL.
const FOCUS_RE = /^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$/;
/** @param {{ url: string, focus?: any }} props */
function DiffImage({ url, focus }) {
  const [failed, setFailed] = useState(false);
  if (failed) return html`<span class="catalog-diff-image-url">${url}</span>`;
  const f = focus ? String(focus).trim() : '';
  return html`<img class="catalog-diff-image" src=${url} style=${FOCUS_RE.test(f) ? 'object-position: ' + f : undefined}
    alt="" loading="lazy" referrerpolicy="no-referrer" title=${url} onError=${() => setFailed(true)} />`;
}

/** @param {{ v: any, field: string, focus?: any }} props */
function DiffValue({ v, field, focus }) {
  if (v === null || v === undefined || v === '') return html`<em class="catalog-diff-none">${t('catalogUpdate.none')}</em>`;
  if (field === 'image') return html`<${DiffImage} url=${String(v)} focus=${focus} />`;
  if (Array.isArray(v)) return v.map((x, i) => html`${i ? html`<br />` : null}${String(x)}`);
  return String(v);
}

// One checkbox per changed field; `picked` holds the ticked ones.
/**
 * @param {{ changes: CatalogChange[], place: Place, entry: CatalogEntry, picked: Set<string>,
 *   onPick: (field: string, on: boolean) => void }} props
 */
function CatalogDiff({ changes, place, entry, picked, onPick }) {
  // Pair image with its focus so the thumbnail previews the actual crop.
  // `before` focus comes from the place (current state), `after` from the catalog entry.
  const focusChange = changes.find(c => c.field === 'image_focus');
  const beforeFocus = focusChange ? focusChange.before : place.image_focus;
  const afterFocus = focusChange ? focusChange.after : entry.image_focus;
  return html`<div class="catalog-diff">${changes.map(c => {
    const isImage = c.field === 'image';
    return html`<label key=${c.field} class="catalog-diff-field selectable">
      <input type="checkbox" class="catalog-diff-check" data-field=${c.field} checked=${picked.has(c.field)}
        onChange=${(/** @type {Event} */ e) => onPick(c.field, /** @type {HTMLInputElement} */ (e.currentTarget).checked)} />
      <span class="catalog-diff-label">${CATALOG_FIELD_LABELS[c.field] ? t(CATALOG_FIELD_LABELS[c.field]) : c.field}</span>
      <span>
        <div class="catalog-diff-old"><${DiffValue} v=${c.before} field=${c.field} focus=${isImage ? beforeFocus : undefined} /></div>
        <div class="catalog-diff-new"><${DiffValue} v=${c.after} field=${c.field} focus=${isImage ? afterFocus : undefined} /></div>
      </span>
    </label>`;
  })}</div>`;
}

export function placesWithCatalogUpdates() {
  return (state.places || []).filter(p => findCatalogUpdate(p));
}

// Build the refreshed place object. `applyFields` (set of field names) is
// the user's selection from the per-field checkboxes; for fields outside
// that set we keep the local value and record the upstream value in
// `catalog_skip` so we don't re-prompt until the catalog changes again.
// When `applyFields` is omitted, every catalog-tracked field is applied
// (used by the bulk-refresh path).
/**
 * @param {Place} place
 * @param {CatalogEntry} entry
 * @param {CatalogChange[] | undefined} changes
 * @param {Set<string> | undefined} [applyFields]
 * @returns {Record<string, any>}
 */
function buildCatalogRefreshPayload(place, entry, changes, applyFields) {
  /** @type {Record<string, any>} */
  const next = {};
  const applyAll = !applyFields;
  for (const f of CATALOG_TRACKED_FIELDS) {
    const ev = entry[f];
    const apply = applyAll || applyFields.has(f);
    if (apply) {
      if (ev !== undefined && ev !== null && ev !== '') next[f] = ev;
    } else {
      // Keep local value (or absence) for this field.
      if (place[f] !== undefined && place[f] !== null && place[f] !== '') next[f] = place[f];
    }
  }
  if (place.visited) next.visited = true;
  if (place.date_visited) next.date_visited = place.date_visited;
  if (place.rating) next.rating = place.rating;
  next.from_catalog = entry.name;
  // Carry over prior skips, drop any whose catalog value is now being
  // applied (no longer needed) or where the catalog has moved away from
  // the recorded snapshot (it will surface as a fresh diff next round).
  const prevSkip = place.catalog_skip || {};
  /** @type {Record<string, any>} */
  const nextSkip = {};
  for (const f in prevSkip) {
    if (applyAll || applyFields.has(f)) continue;
    if (!catalogEq(catalogNorm(prevSkip[f]), catalogNorm(entry[/** @type {keyof Place} */ (f)]))) continue;
    nextSkip[f] = prevSkip[f];
  }
  // Add new skips for the currently-shown diff fields the user kept local.
  if (changes && !applyAll) {
    for (const c of changes) {
      if (applyFields.has(c.field)) continue;
      const v = entry[c.field];
      nextSkip[c.field] = (v === undefined ? null : v);
    }
  }
  if (Object.keys(nextSkip).length) next.catalog_skip = nextSkip;
  return next;
}

// A save can settle after its dialog was closed by hand, when closing it again
// would take the modal below.
function useLive() {
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  return live;
}

/** @typedef {{ p: Place, r: { entry: CatalogEntry, changes: CatalogChange[] } }} PendingUpdate */
/** @returns {PendingUpdate[]} */
function pendingUpdates() {
  return placesWithCatalogUpdates().flatMap(p => {
    const r = findCatalogUpdate(p);
    return r ? [{ p, r }] : [];
  });
}

// Bulk review: every pending place's field-level diff in one modal, each
// field an unchecked checkbox. Additive - Apply touches only places where
// a field was ticked (ticked applied, unticked-in-a-touched-place kept like
// the per-place modal); untouched places stay pending for a later pass.
export function openCatalogBulkUpdateModal() {
  if (!placesWithCatalogUpdates().length) { alert(t('catalogUpdate.noneAvailable')); return; }
  openViewModal(html`<${CatalogBulkUpdate} />`, { phone: 'fullscreen' });
}

function CatalogBulkUpdate() {
  const [rows, setRows] = /** @type {[PendingUpdate[], (next: PendingUpdate[]) => void]} */ (useState(pendingUpdates));
  /** @typedef {Record<string, Set<string>>} Picks */
  const [picked, setPicked] = /** @type {[Picks, (next: Picks | ((prev: Picks) => Picks)) => void]} */ (useState({}));
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const live = useLive();
  const fieldsOf = (/** @type {PendingUpdate} */ { r }) => r.changes.map(c => c.field);
  const pickedOf = (/** @type {PendingUpdate} */ { p }) => picked[String(p.id)] || new Set();
  const total = rows.reduce((n, row) => n + row.r.changes.length, 0);
  const ticked = rows.reduce((n, row) => n + pickedOf(row).size, 0);
  const allOn = total > 0 && ticked === total;
  /** @param {PendingUpdate} row @param {Set<string>} set */
  const setRow = (row, set) => setPicked(prev => ({ ...prev, [String(row.p.id)]: set }));
  /** @param {PendingUpdate} row @param {string} field @param {boolean} on */
  const pickOne = (row, field, on) => {
    const set = new Set(pickedOf(row));
    if (on) set.add(field); else set.delete(field);
    setRow(row, set);
  };
  const toggleAll = () => setPicked(Object.fromEntries(rows.map(row => [String(row.p.id), new Set(allOn ? [] : fieldsOf(row))])));

  // Runs one place at a time, so the button can count them off.
  const apply = () => {
    const items = rows.filter(row => pickedOf(row).size > 0);
    if (!items.length) return;
    setError('');
    /** @type {string[]} */
    const errors = [];
    /** @param {number} i */
    const step = i => {
      if (i >= items.length) { finish(errors); return; }
      const { p, r } = items[i];
      setProgress(t('catalogUpdate.applying', { i: i + 1, n: items.length }));
      dataLayer.updatePlace({ id: String(p.id), place: buildCatalogRefreshPayload(p, r.entry, r.changes, pickedOf(items[i])) })
        .catch((/** @type {Error} */ err) => { errors.push(t('catalogUpdate.placeError', { name: p.name, message: err.message })); })
        .then(() => step(i + 1));
    };
    step(0);
  };
  // The places that failed are still pending, so the list is rebuilt from what
  // is left and the errors stay on screen above the actions.
  /** @param {string[]} errors */
  const finish = errors => {
    try {
      refreshPlacesPresentation();
    } catch (err) {
      setProgress('');
      setError(t('common.failed', { message: /** @type {Error} */ (err).message }));
      return;
    }
    if (!live.current) return;
    if (!errors.length) { closeModal(); return; }
    setRows(pendingUpdates());
    setPicked({});
    setProgress('');
    setError(t('catalogUpdate.appliedWithErrors', { errors: errors.join('\n') }));
  };

  return html`
    <${DialogHead} title=${t('catalogUpdate.bulkTitle', { n: rows.length })} />
    <div class="ui-dialog-body">
      <div id="catalog-bulk-list">
        ${rows.map(row => {
          const set = pickedOf(row);
          return html`<div class="catalog-bulk-place" key=${String(row.p.id)} data-place-id=${String(row.p.id)}>
            <h3 class="settings-h" style="display:flex;align-items:baseline;gap:var(--ui-space-2)">
              <span>${row.p.name}</span>
              <button type="button" class="sessions-revoke-others catalog-bulk-place-toggle" style="margin-left:auto"
                onClick=${() => setRow(row, new Set(set.size ? [] : fieldsOf(row)))}>${set.size ? t('catalogUpdate.clear') : t('catalog.selectAll')}</button>
            </h3>
            <${CatalogDiff} changes=${row.r.changes} place=${row.p} entry=${row.r.entry} picked=${set}
              onPick=${(/** @type {string} */ f, /** @type {boolean} */ on) => pickOne(row, f, on)} />
          </div>`;
        })}
      </div>
      <${ErrorBox} id="catalog-bulk-error" msg=${error} />
    </div>
    <div class="ui-dialog-actions">
      <button type="button" class="ui-button" id="catalog-bulk-toggle-all" disabled=${!!progress} onClick=${toggleAll}>${allOn ? t('catalogUpdate.uncheckAll') : t('catalogUpdate.checkAll')}</button>
      <span class="action-spacer"></span>
      <button type="button" class="ui-button ui-button-primary" id="catalog-bulk-apply" disabled=${!!progress || !ticked} onClick=${apply}>${progress || t('catalogUpdate.apply')}</button>
    </div>`;
}

/** @param {Place} place */
export function openCatalogUpdateModal(place) {
  const result = findCatalogUpdate(place);
  if (!result) {
    // Badge was tagged update-available but the cache shifted (admin
    // toggled baseline off, or another tab refreshed). Treat as no-op.
    alert(t('catalogUpdate.noneForPlace'));
    return;
  }
  openViewModal(html`<${CatalogUpdate} place=${place} entry=${result.entry} changes=${result.changes} />`, { phone: 'fullscreen' });
}

/** @param {{ place: Place, entry: CatalogEntry, changes: CatalogChange[] }} props */
function CatalogUpdate({ place, entry, changes }) {
  const [picked, setPicked] = /** @type {[Set<string>, (next: (prev: Set<string>) => Set<string>) => void]} */ (useState(() => new Set()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useLive();
  const any = picked.size > 0;
  /** @param {string} field @param {boolean} on */
  const pickOne = (field, on) => setPicked(prev => {
    const next = new Set(prev);
    if (on) next.add(field); else next.delete(field);
    return next;
  });
  /** @param {Set<string>} applyFields */
  const submit = applyFields => {
    setBusy(true);
    setError('');
    dataLayer.updatePlace({ id: String(place.id), place: buildCatalogRefreshPayload(place, entry, changes, applyFields) })
      .then(() => {
        if (live.current) closeModal();
        redrawPlaces();
        refreshOpenPlacePopup();
      })
      .catch((/** @type {Error} */ err) => { setBusy(false); setError(t('common.failed', { message: err.message })); });
  };
  // No selection means "Apply all" - apply every shown change.
  const applyClick = () => submit(any ? picked : new Set(changes.map(c => c.field)));
  return html`
    <${DialogHead} title=${t('catalogUpdate.title')} />
    <div class="ui-dialog-body">
      <${CatalogDiff} changes=${changes} place=${place} entry=${entry} picked=${picked} onPick=${pickOne} />
      <${ErrorBox} id="catalog-update-error" msg=${error} />
    </div>
    <div class="ui-dialog-actions">
      <button type="button" class=${'ui-button' + (any ? '' : ' ui-button-primary')} id="catalog-update-skip" disabled=${any || busy} onClick=${() => submit(new Set())}>${t('catalogUpdate.keepAll')}</button>
      <span class="action-spacer"></span>
      <button type="button" class=${'ui-button ui-button-primary' + (any ? ' has-selection' : '')} id="catalog-update-confirm" disabled=${busy} onClick=${applyClick}>
        <span class="lbl-default">${t('catalogUpdate.applyAll')}</span>
        <span class="lbl-alt">${t('catalogUpdate.apply')}</span>
      </button>
    </div>`;
}

// Bucket key for "Group by letter". Keep the first character as-is for any
// Unicode letter (no folding) so non-Latin scripts get their own buckets
// alongside Latin ones. Non-letter starts (digits, punctuation) go in "#".
/** @param {string | null | undefined} name */
export function letterBucket(name) {
  const raw = (name || '').charAt(0);
  if (!raw) return '#';
  return /\p{L}/u.test(raw) ? raw.toUpperCase() : '#';
}
// Locale-agnostic sort. Browser-default locale gives each user the
// ordering they expect (Norwegian: Æ Ø Å after Z; Swedish: Å Ä Ö; etc.).
// "#" bucket always last.
export const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
/**
 * @param {string} a
 * @param {string} b
 */
function compareLetterKeys(a, b) {
  if (a === '#' && b === '#') return 0;
  if (a === '#') return 1;
  if (b === '#') return -1;
  return NAME_COLLATOR.compare(a, b);
}

// Bucket items by keyFn, sort each bucket's items by nameFn (locale-aware),
// and return the bucket keys sorted. byLetter sorts keys with compareLetterKeys
// (the "#" bucket lands last); otherwise sortKeyFn if given, else default order.
// Shared by the Places and Routes list groupers.
/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} keyFn
 * @param {(item: T) => string} nameFn
 * @param {boolean} [byLetter]
 * @param {((a: string, b: string) => number) | null} [sortKeyFn]
 * @returns {{ grouped: Record<string, T[]>, keys: string[] }}
 */
export function groupAndSort(items, keyFn, nameFn, byLetter, sortKeyFn) {
  /** @type {Record<string, T[]>} */
  const grouped = {};
  for (const item of items) {
    const key = keyFn(item);
    (grouped[key] = grouped[key] || []).push(item);
  }
  for (const key in grouped) {
    grouped[key].sort((a, b) => NAME_COLLATOR.compare(nameFn(a), nameFn(b)));
  }
  const keys = byLetter
    ? Object.keys(grouped).sort(compareLetterKeys)
    : Object.keys(grouped).sort(sortKeyFn || undefined);
  return { grouped, keys };
}
