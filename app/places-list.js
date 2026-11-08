import { escapeHtml, state } from './core.js';

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
import { modalHeaderHtml } from './select.js';
import { closeModal, openFullScreenModal } from './modal.js';

// Fields the catalog "owns" - personal status (visited / date_visited /
// rating / from_catalog / runtime annotations) is preserved on refresh.
/** @type {(keyof Place)[]} */
const CATALOG_TRACKED_FIELDS = ['name', 'lat', 'lon', 'category', 'country', 'local_name', 'note', 'image', 'image_focus', 'sources', 'tags'];
/** @type {Record<string, string>} */
const CATALOG_FIELD_LABELS = { name: 'Name', lat: 'Latitude', lon: 'Longitude', category: 'Category', country: 'Country', local_name: 'Local name', note: 'Note', image: 'Image', image_focus: 'Image focus', sources: 'Sources', tags: 'Tags' };

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

/**
 * @param {any} v
 * @param {string} field
 * @param {any} [focus]
 */
function formatCatalogDiffValue(v, field, focus) {
  if (v === null || v === undefined || v === '') return '<em style="color:var(--muted)">(none)</em>';
  if (field === 'image') {
    const url = String(v);
    const focusAttr = focus && /^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$/.test(String(focus).trim())
      ? ' style="object-position: ' + String(focus).trim() + '"'
      : '';
    return '<img class="catalog-diff-image" src="' + escapeHtml(url) + '"' + focusAttr +
      ' alt="" loading="lazy" referrerpolicy="no-referrer" title="' + escapeHtml(url) +
      '" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{textContent:this.title,style:\'color:var(--muted);font-size:var(--ui-text-xs);word-break:break-all\'}))">';
  }
  if (Array.isArray(v)) return v.map(x => escapeHtml(String(x))).join('<br>');
  return escapeHtml(String(v));
}

/**
 * @param {CatalogChange[]} changes
 * @param {{ selectable?: boolean, place?: Place, entry?: CatalogEntry }} [opts]
 */
function renderCatalogDiff(changes, opts) {
  const selectable = !!(opts && opts.selectable);
  // Pair image with its focus so the thumbnail previews the actual crop.
  // `before` focus comes from the place (current state), `after` from the catalog entry.
  const focusChange = changes.find(c => c.field === 'image_focus');
  const place = opts && opts.place;
  const entry = opts && opts.entry;
  const beforeFocus = focusChange ? focusChange.before : (place ? place.image_focus : undefined);
  const afterFocus = focusChange ? focusChange.after : (entry ? entry.image_focus : undefined);
  return '<div class="catalog-diff">' + changes.map(c => {
    const check = selectable
      ? '<input type="checkbox" class="catalog-diff-check" data-field="' + escapeHtml(c.field) + '">'
      : '';
    const bf = c.field === 'image' ? beforeFocus : undefined;
    const af = c.field === 'image' ? afterFocus : undefined;
    return '<label class="catalog-diff-field' + (selectable ? ' selectable' : '') + '">' +
      check +
      '<span class="catalog-diff-label">' + escapeHtml(CATALOG_FIELD_LABELS[c.field] || c.field) + '</span>' +
      '<span>' +
        '<div class="catalog-diff-old">' + formatCatalogDiffValue(c.before, c.field, bf) + '</div>' +
        '<div class="catalog-diff-new">' + formatCatalogDiffValue(c.after, c.field, af) + '</div>' +
      '</span>' +
    '</label>';
  }).join('') + '</div>';
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

// Bulk review: every pending place's field-level diff in one modal, each
// field an unchecked checkbox. Additive - Apply touches only places where
// a field was ticked (ticked applied, unticked-in-a-touched-place kept like
// the per-place modal); untouched places stay pending for a later pass.
export function openCatalogBulkUpdateModal() {
  const pending = placesWithCatalogUpdates();
  if (!pending.length) { alert('No catalog updates available.'); return; }
  const sections = pending.map(p => {
    const r = findCatalogUpdate(p);
    if (!r) return '';
    return '<div class="catalog-bulk-place" data-place-id="' + escapeHtml(String(p.id)) + '">' +
      '<h3 class="settings-h" style="display:flex;align-items:baseline;gap:var(--ui-space-2)">' +
        '<span>' + escapeHtml(p.name) + '</span>' +
        '<button type="button" class="sessions-revoke-others catalog-bulk-place-toggle" style="margin-left:auto">Select all</button>' +
      '</h3>' +
      renderCatalogDiff(r.changes, { selectable: true, place: p, entry: r.entry }) +
    '</div>';
  }).join('');
  openFullScreenModal(
    modalHeaderHtml('Catalog updates (' + pending.length + ')') +
    '<div id="catalog-bulk-list">' + sections + '</div>' +
    '<div class="ui-dialog-actions">' +
      '<button type="button" class="ui-button" id="catalog-bulk-toggle-all">Check all</button>' +
      '<span class="action-spacer"></span>' +
      '<button type="button" class="ui-button ui-button-primary" id="catalog-bulk-apply" disabled>Apply</button>' +
    '</div>',
    /** @param {HTMLDialogElement} backdrop */
    function(backdrop) {
      const list = /** @type {HTMLElement} */ (document.getElementById('catalog-bulk-list'));
      const toggleAllBtn = /** @type {HTMLButtonElement} */ (document.getElementById('catalog-bulk-toggle-all'));
      const applyBtn = /** @type {HTMLButtonElement} */ (document.getElementById('catalog-bulk-apply'));
      const allChecks = () => /** @type {HTMLInputElement[]} */ (Array.from(backdrop.querySelectorAll('.catalog-diff-check')));
      /** @param {Element} sec */
      function syncPlaceToggle(sec) {
        const btn = sec.querySelector('.catalog-bulk-place-toggle');
        if (!btn) return;
        const anyOn = /** @type {HTMLInputElement[]} */ (Array.from(sec.querySelectorAll('.catalog-diff-check'))).some(c => c.checked);
        btn.textContent = anyOn ? 'Clear' : 'Select all';
      }
      // Check-all label reflects state; Apply enables only with a selection
      // (matches the catalog import flow, which gates its Add button too).
      function syncActions() {
        const checks = allChecks();
        const allOn = checks.length && checks.every(c => c.checked);
        toggleAllBtn.textContent = allOn ? 'Uncheck all' : 'Check all';
        applyBtn.disabled = !checks.some(c => c.checked);
      }
      backdrop.querySelectorAll('.catalog-bulk-place-toggle').forEach(btn => {
        btn.addEventListener('click', /** @this {HTMLElement} */ function() {
          const sec = /** @type {Element} */ (this.closest('.catalog-bulk-place'));
          const checks = /** @type {NodeListOf<HTMLInputElement>} */ (sec.querySelectorAll('.catalog-diff-check'));
          const anyOn = Array.from(checks).some(c => c.checked);
          checks.forEach(c => { c.checked = !anyOn; });
          syncPlaceToggle(sec); syncActions();
        });
      });
      toggleAllBtn.addEventListener('click', function() {
        const checks = allChecks();
        const allOn = checks.length && checks.every(c => c.checked);
        checks.forEach(c => { c.checked = !allOn; });
        backdrop.querySelectorAll('.catalog-bulk-place').forEach(syncPlaceToggle);
        syncActions();
      });
      list.addEventListener('change', function(e) {
        const tgt = /** @type {HTMLElement} */ (e.target);
        if (!tgt.classList || !tgt.classList.contains('catalog-diff-check')) return;
        const sec = tgt.closest('.catalog-bulk-place');
        if (sec) syncPlaceToggle(sec);
        syncActions();
      });
      backdrop.querySelectorAll('.catalog-bulk-place').forEach(syncPlaceToggle);
      syncActions();
      applyBtn.addEventListener('click', function() {
        const btn = this;
        // Snapshot selections so the still-open modal DOM isn't re-queried
        // per place (and ids needn't be selector-escaped).
        /** @type {Record<string, Set<string>>} */
        const selByPlace = {};
        backdrop.querySelectorAll('.catalog-bulk-place').forEach(el => {
          const sec = /** @type {HTMLElement} */ (el);
          /** @type {Set<string>} */
          const set = new Set();
          /** @type {NodeListOf<HTMLInputElement>} */ (sec.querySelectorAll('.catalog-diff-check:checked')).forEach(cb => { if (cb.dataset.field) set.add(cb.dataset.field); });
          selByPlace[sec.dataset.placeId || ''] = set;
        });
        const items = pending
          .flatMap(p => {
            const r = findCatalogUpdate(p);
            const fields = selByPlace[String(p.id)] || new Set();
            return r && fields.size > 0 ? [{ p, r, fields }] : [];
          });
        if (!items.length) return;
        btn.disabled = true;
        toggleAllBtn.disabled = true;
        /** @type {string[]} */
        const errors = [];
        let i = 0;
        (function next() {
          if (i >= items.length) {
            Promise.resolve().then(() => {
              refreshPlacesPresentation();
              closeModal();
              if (errors.length) alert('Applied with errors:\n' + errors.join('\n'));
            }).catch(err => { btn.disabled = false; toggleAllBtn.disabled = false; btn.textContent = 'Apply'; alert('Failed: ' + err.message); });
            return;
          }
          const { p, r, fields } = items[i];
          btn.textContent = 'Applying ' + (i + 1) + ' of ' + items.length + '…';
          dataLayer.updatePlace({ id: String(p.id), place: buildCatalogRefreshPayload(p, r.entry, r.changes, fields) })
            .catch(err => errors.push(p.name + ': ' + err.message))
            .then(() => { i++; next(); });
        })();
      });
    }
  );
}

/** @param {Place} place */
export function openCatalogUpdateModal(place) {
  const result = findCatalogUpdate(place);
  if (!result) {
    // Badge was tagged update-available but the cache shifted (admin
    // toggled baseline off, or another tab refreshed). Treat as no-op.
    alert('No catalog updates for this place.');
    return;
  }
  const { entry, changes } = result;
  openFullScreenModal(
    modalHeaderHtml('Update from catalog') +
    renderCatalogDiff(changes, { selectable: true, place, entry }) +
    '<div class="ui-dialog-actions">' +
      '<button type="button" class="ui-button ui-button-primary" id="catalog-update-skip">Keep all</button>' +
      '<span class="action-spacer"></span>' +
      '<button type="button" class="ui-button ui-button-primary" id="catalog-update-confirm">' +
        '<span class="lbl-default">Apply all</span>' +
        '<span class="lbl-alt">Apply</span>' +
      '</button>' +
    '</div>',
    /** @param {HTMLDialogElement} backdrop */
    function(backdrop) {
      const applyBtn = /** @type {HTMLButtonElement} */ (document.getElementById('catalog-update-confirm'));
      const skipBtn = /** @type {HTMLButtonElement} */ (document.getElementById('catalog-update-skip'));
      function selectedFields() {
        /** @type {Set<string>} */
        const set = new Set();
        /** @type {NodeListOf<HTMLInputElement>} */ (backdrop.querySelectorAll('.catalog-diff-check')).forEach(cb => {
          if (cb.checked && cb.dataset.field) set.add(cb.dataset.field);
        });
        return set;
      }
      function syncButtons() {
        const any = selectedFields().size > 0;
        applyBtn.classList.add('ui-button-primary');
        applyBtn.classList.toggle('has-selection', any);
        skipBtn.classList.toggle('ui-button-primary', !any);
        skipBtn.disabled = any;
      }
      backdrop.querySelectorAll('.catalog-diff-check').forEach(cb => cb.addEventListener('change', syncButtons));
      /**
       * @param {Set<string>} applyFields
       * @param {HTMLButtonElement} btn
       */
      function submit(applyFields, btn) {
        btn.disabled = true;
        dataLayer.updatePlace({ id: String(place.id), place: buildCatalogRefreshPayload(place, entry, changes, applyFields) })
          .then(() => {
            closeModal();
            redrawPlaces();
            refreshOpenPlacePopup();
          })
          .catch(err => { btn.disabled = false; alert('Failed: ' + err.message); });
      }
      applyBtn.addEventListener('click', function() {
        // No selection means "Apply all" - apply every shown change.
        const sel = selectedFields();
        const fields = sel.size ? sel : new Set(changes.map(c => c.field));
        submit(fields, this);
      });
      skipBtn.addEventListener('click', function() { submit(new Set(), this); });
    }
  );
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
