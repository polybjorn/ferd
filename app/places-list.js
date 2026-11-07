import {
  displayCategory, escapeHtml, setActiveTab, setCrumb, sortedCategorySlugs, state,
} from './core.js';
import { fetchJson, isReadOnly } from './server.js';
import { isLocalMode } from './local-mode.js';
import { dataLayer } from './offline-queue.js';
import { collectTags, tagPillsHtml, tagsIncludeAll } from './tags.js';
import { wireFilterPopover } from './map-panel.js';
import { getShowField, setPref, setResultCount } from './prefs.js';
import { cleanupMap } from './map-layers.js';
import { refreshPlacesPresentation, syncPlacesOnMap } from './map-popups.js';
import { refreshOpenPlacePopup } from './route-meta.js';
import { openEditPlaceModal } from './edit-place.js';
import { deletePlaceItem, resyncPlaceCardSlugs } from './map-actions.js';
import { listView, listViewPopoverHtml, wireListViewPopover } from './history.js';
import { focusHash } from './router.js';
import { api } from './auth.js';
import { attachContextMenu } from './context-menu.js';
import { enhanceSelectsIn, modalHeaderHtml, refreshPlaces } from './select.js';
import { closeModal, openFullScreenModal } from './modal.js';
import { openAddModal } from './add.js';
import { wrappedRouter } from './pick-coords.js';

// Fields the catalog "owns" - personal status (visited / date_visited /
// rating / from_catalog / runtime annotations) is preserved on refresh.
const CATALOG_TRACKED_FIELDS = ['name', 'lat', 'lon', 'category', 'country', 'local_name', 'note', 'image', 'image_focus', 'sources', 'tags'];
const CATALOG_FIELD_LABELS = { name: 'Name', lat: 'Latitude', lon: 'Longitude', category: 'Category', country: 'Country', local_name: 'Local name', note: 'Note', image: 'Image', image_focus: 'Image focus', sources: 'Sources', tags: 'Tags' };

// Returns { entry, changes: [{field, before, after}] } when the upstream
// catalog entry for a place's from_catalog has diverged from the local
// copy, else null. Catalog source is the client-side cache populated on
// boot; if it isn't loaded yet, returns null (no false-positive indicator).
// Resolve the catalog entry an imported place is linked to. Primary key is
// the stored name (from_catalog); falls back to matching the catalog
// entry's primary source against the place's own sources, so a catalog
// rename doesn't break the link (the source URL is stable across renames).
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
function isCatalogOrphan(place) {
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
  if (isLocalMode()) {
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
    // Re-render the current view so badges/orphan markers reflect the fresh
    // cache (mirrors the boot-time catalog warm-up refresh).
    if ((location.hash || '#/').startsWith('#/places')) wrappedRouter();
  }).catch(() => {});
}

// Catalog fields compare as equal when they differ only by surrounding
// whitespace or by empty-vs-missing, so a cosmetic upstream edit does not
// surface as an update.
function catalogNorm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return v.length ? v.map(catalogNorm) : null;
  return v;
}
function catalogEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => catalogEq(x, b[i]));
  return false;
}

export function findCatalogUpdate(place) {
  if (!place || !place.from_catalog) return null;
  if (!Array.isArray(state._catalogCache)) return null;
  const entry = catalogEntryFor(place);
  if (!entry) return null;
  const skip = (place && place.catalog_skip) || {};
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

// Update a single rendered place card in place: name, note, badge state.
// Used after Apply / Keep so the list doesn't visibly re-render.
function updatePlaceCardAfterCatalogChange(place) {
  if (!place) return;
  const card = document.querySelector('.place-card[data-place-slug="' + (place._slug || '') + '"]');
  if (!card) return;
  const nameEl = card.querySelector('.name');
  if (nameEl) nameEl.textContent = place.name;
  const placeText = card.querySelector('.place-text');
  if (placeText) {
    let noteEl = placeText.querySelector('.note');
    if (place.note) {
      if (!noteEl) {
        noteEl = document.createElement('div');
        noteEl.className = 'note';
        placeText.appendChild(noteEl);
      }
      noteEl.textContent = place.note;
    } else if (noteEl) {
      noteEl.remove();
    }
  }
  const upd = findCatalogUpdate(place);
  const badge = card.querySelector('.catalog-mark');
  if (badge) {
    badge.classList.toggle('update-available', !!upd);
    badge.title = upd
      ? 'Catalog updated this entry (' + upd.changes.length + ' field' + (upd.changes.length === 1 ? '' : 's') + '). Click to review.'
      : 'Imported from the site catalog';
  }
  // If the user is filtered to "Updates available" and this place no longer
  // has any, fade the card out so the list reflects the filter. If that
  // leaves the group empty, fade the group header out too.
  if (state.placeFilters && state.placeFilters.catalog === 'updates-available' && !upd) {
    const group = card.closest('.category-group');
    card.style.transition = 'opacity 0.2s ease';
    card.style.opacity = '0';
    setTimeout(() => {
      card.remove();
      if (group && !group.querySelector('.place-card')) {
        group.style.transition = 'opacity 0.2s ease';
        group.style.opacity = '0';
        setTimeout(() => group.remove(), 220);
      }
    }, 220);
  }
}

// Update a single rendered place card in place after an edit, avoiding a
// full list re-render (which flashes). Returns false when the edit changes
// the card's group, sort position, or filter membership - the caller then
// falls back to renderPlaceList. The common case (toggling visited, tweaking
// the note) is patched in place with no flash.
export function updatePlaceCardAfterEdit(oldPlace, newPlace) {
  if (!newPlace) return false;
  const listEl = document.getElementById('place-list');
  if (!listEl) return false;
  // Changes that move the card or reorder it need a real re-render.
  if (oldPlace.name !== newPlace.name) return false;
  if ((oldPlace.category || '') !== (newPlace.category || '')) return false;
  if (state.groupBy === 'country' && (oldPlace.country || '') !== (newPlace.country || '')) return false;
  const statusEl = document.getElementById('filter-status');
  const wantStatus = statusEl ? statusEl.value : 'all';
  const visitedChanged = !!oldPlace.visited !== !!newPlace.visited;
  if (visitedChanged && wantStatus !== 'all') return false;
  const catalogEl = document.getElementById('filter-catalog');
  if (catalogEl && catalogEl.value === 'updates-available' && !findCatalogUpdate(newPlace)) return false;
  const card = listEl.querySelector('.place-card[data-place-slug="' + (newPlace._slug || '') + '"]');
  if (!card) return false;
  const dot = card.querySelector('.status-dot');
  if (dot) dot.className = 'status-dot ' + (newPlace.visited ? 'visited' : 'want');
  const placeText = card.querySelector('.place-text');
  if (placeText) {
    let noteEl = placeText.querySelector('.note');
    if (newPlace.note && getShowField('note')) {
      if (!noteEl) { noteEl = document.createElement('div'); noteEl.className = 'note'; placeText.appendChild(noteEl); }
      noteEl.textContent = newPlace.note;
    } else if (noteEl) { noteEl.remove(); }
  }
  const badge = card.querySelector('.catalog-mark');
  if (badge && !badge.classList.contains('orphan')) {
    const upd = findCatalogUpdate(newPlace);
    badge.classList.toggle('update-available', !!upd);
    badge.title = upd
      ? 'Catalog updated this entry (' + upd.changes.length + ' field' + (upd.changes.length === 1 ? '' : 's') + '). Click to review.'
      : 'Imported from the site catalog';
  }
  if (visitedChanged) {
    const group = card.closest('.category-group');
    const countEl = group ? group.querySelector('.place-count') : null;
    if (countEl) {
      const m = /\((\d+)\/(\d+)\)/.exec(countEl.textContent);
      if (m) {
        const v = Math.max(0, parseInt(m[1], 10) + (newPlace.visited ? 1 : -1));
        countEl.textContent = '(' + v + '/' + m[2] + ')';
      }
    }
  }
  return true;
}

// Build the refreshed place object. `applyFields` (set of field names) is
// the user's selection from the per-field checkboxes; for fields outside
// that set we keep the local value and record the upstream value in
// `catalog_skip` so we don't re-prompt until the catalog changes again.
// When `applyFields` is omitted, every catalog-tracked field is applied
// (used by the bulk-refresh path).
function buildCatalogRefreshPayload(place, entry, changes, applyFields) {
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
  const nextSkip = {};
  for (const f in prevSkip) {
    if (applyAll || applyFields.has(f)) continue;
    if (!catalogEq(catalogNorm(prevSkip[f]), catalogNorm(entry[f]))) continue;
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
    function(backdrop) {
      const list = document.getElementById('catalog-bulk-list');
      const toggleAllBtn = document.getElementById('catalog-bulk-toggle-all');
      const applyBtn = document.getElementById('catalog-bulk-apply');
      const allChecks = () => Array.from(backdrop.querySelectorAll('.catalog-diff-check'));
      function syncPlaceToggle(sec) {
        const btn = sec.querySelector('.catalog-bulk-place-toggle');
        if (!btn) return;
        const anyOn = Array.from(sec.querySelectorAll('.catalog-diff-check')).some(c => c.checked);
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
        btn.addEventListener('click', function() {
          const sec = this.closest('.catalog-bulk-place');
          const checks = sec.querySelectorAll('.catalog-diff-check');
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
        if (!e.target.classList || !e.target.classList.contains('catalog-diff-check')) return;
        const sec = e.target.closest('.catalog-bulk-place');
        if (sec) syncPlaceToggle(sec);
        syncActions();
      });
      backdrop.querySelectorAll('.catalog-bulk-place').forEach(syncPlaceToggle);
      syncActions();
      applyBtn.addEventListener('click', function() {
        const btn = this;
        // Snapshot selections so the still-open modal DOM isn't re-queried
        // per place (and ids needn't be selector-escaped).
        const selByPlace = {};
        backdrop.querySelectorAll('.catalog-bulk-place').forEach(sec => {
          const set = new Set();
          sec.querySelectorAll('.catalog-diff-check:checked').forEach(cb => set.add(cb.dataset.field));
          selByPlace[sec.dataset.placeId] = set;
        });
        const items = pending
          .map(p => ({ p, r: findCatalogUpdate(p), fields: selByPlace[String(p.id)] || new Set() }))
          .filter(x => x.r && x.fields.size > 0);
        if (!items.length) return;
        btn.disabled = true;
        toggleAllBtn.disabled = true;
        const errors = [];
        let i = 0;
        (function next() {
          if (i >= items.length) {
            refreshPlaces().then(() => {
              refreshPlacesPresentation();
              closeModal();
              if (document.getElementById('place-list')) renderPlacesIndex();
              if (errors.length) alert('Applied with errors:\n' + errors.join('\n'));
            }).catch(err => { btn.disabled = false; toggleAllBtn.disabled = false; btn.textContent = 'Apply'; alert('Failed: ' + err.message); });
            return;
          }
          const { p, r, fields } = items[i];
          btn.textContent = 'Applying ' + (i + 1) + ' of ' + items.length + '…';
          dataLayer.updatePlace({ id: p.id, place: buildCatalogRefreshPayload(p, r.entry, r.changes, fields) })
            .catch(err => errors.push(p.name + ': ' + err.message))
            .then(() => { i++; next(); });
        })();
      });
    }
  );
}

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
    function(backdrop) {
      const applyBtn = document.getElementById('catalog-update-confirm');
      const skipBtn = document.getElementById('catalog-update-skip');
      function selectedFields() {
        const set = new Set();
        backdrop.querySelectorAll('.catalog-diff-check').forEach(cb => {
          if (cb.checked) set.add(cb.dataset.field);
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
      function submit(applyFields, btn) {
        btn.disabled = true;
        dataLayer.updatePlace({ id: place.id, place: buildCatalogRefreshPayload(place, entry, changes, applyFields) })
          .then(() => refreshPlaces())
          .then(() => {
            closeModal();
            const fresh = (state.places || []).find(p => p.id === place.id) || place;
            // A name change reassigns the place's slug, so the rendered
            // card's data-place-slug key is now stale and a surgical lookup
            // would miss. Re-render the list in that (rare) case; otherwise
            // do the in-place card update (no blink) for the common case.
            if (fresh.name !== place.name) {
              if (document.getElementById('place-list')) renderPlaceList();
            } else {
              updatePlaceCardAfterCatalogChange(fresh);
            }
            if (state._placeClusterGroup) state._placeClusterGroup.redraw();
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

export function renderPlacesIndex() {
  setActiveTab('places');
  setCrumb('Places');
  cleanupMap();
  const app = document.getElementById('app');
  if (!state.places) { app.innerHTML = '<div class="loading">Loading places...</div>'; return; }

  const places = state.places;
  const visited = places.filter(p => p.visited).length;
  const total = places.length;
  const cats = sortedCategorySlugs(Object.keys(state.categoryColors));
  // The uncategorized bucket isn't a real category — exclude from the count.
  const realCatsCount = cats.filter(c => c !== '').length;

  const canAdd = state.auth.authenticated && !isReadOnly();
  const countries = [...new Set(places.map(p => p.country).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const placeTags = collectTags(places);
  // Self-retiring chip in the controls row: editors only, only while
  // catalog updates are pending. Gone once the backlog clears.
  const pendingUpdCount = canAdd ? placesWithCatalogUpdates().length : 0;
  const updChip = pendingUpdCount > 0
    ? '<div class="filter-dropdown catalog-update-chip-wrap"><button type="button" class="filter-btn catalog-update-chip" id="catalog-update-review">Review updates</button></div>'
    : '';
  app.innerHTML =
    '<div class="index-controls">' +
    '<div class="search-wrap"><input type="text" id="search-input" placeholder="Filter places..." value="' + escapeHtml(state.placeFilters.search) + '"><span class="result-count" id="result-count"></span></div>' +
    updChip +
    '<div class="filter-dropdown">' +
      '<button type="button" class="filter-btn" id="filter-btn" aria-haspopup="true" aria-expanded="false">Filters</button>' +
      '<div class="filter-popover" id="filter-popover" hidden>' +
        '<select id="filter-status">' +
          '<option value="all">Status</option>' +
          '<option value="visited"' + (state.placeFilters.status === 'visited' ? ' selected' : '') + '>Visited</option>' +
          '<option value="want"' + (state.placeFilters.status === 'want' ? ' selected' : '') + '>Want to visit</option>' +
        '</select>' +
        (countries.length ?
          '<select id="filter-country">' +
            '<option value="all">Country</option>' +
            countries.map(c => '<option value="' + escapeHtml(c) + '"' + (state.placeFilters.country === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>').join('') +
          '</select>'
          : '') +
        '<select id="filter-category">' +
          '<option value="all">Category</option>' +
          cats.map(c => '<option value="' + escapeHtml(c) + '"' + (state.placeFilters.category === c ? ' selected' : '') + '>' + escapeHtml(displayCategory(c)) + '</option>').join('') +
        '</select>' +
        (placeTags.length ?
          '<button type="button" class="filter-ms-btn" id="filter-tag-ms-btn" aria-haspopup="listbox" aria-expanded="false">Tags</button>'
          : '') +
        '<select id="filter-catalog">' +
          '<option value="all">Catalog</option>' +
          '<option value="from-catalog"' + (state.placeFilters.catalog === 'from-catalog' ? ' selected' : '') + '>From catalog</option>' +
          '<option value="not-from-catalog"' + (state.placeFilters.catalog === 'not-from-catalog' ? ' selected' : '') + '>Not from catalog</option>' +
          '<option value="updates-available"' + (state.placeFilters.catalog === 'updates-available' ? ' selected' : '') + '>Updates available</option>' +
        '</select>' +
        '<div class="filter-divider"></div>' +
        '<select id="filter-group-by">' +
          '<option value="category"' + (state.groupBy === 'category' ? ' selected' : '') + '>Group by category</option>' +
          '<option value="country"' + (state.groupBy === 'country' ? ' selected' : '') + '>Group by country</option>' +
          '<option value="letter"' + (state.groupBy === 'letter' ? ' selected' : '') + '>Group by first letter</option>' +
        '</select>' +
        '<button type="button" class="filter-clear" id="filter-clear">Clear filters</button>' +
      '</div>' +
    '</div>' +
    listViewPopoverHtml('places') +
    '</div>' +
    '<div class="category-grid" id="place-list"></div>';
  renderPlaceList('');
  wireListViewPopover('places', function() { renderPlaceList(); });
  enhanceSelectsIn(document.querySelector('.index-controls'));

  const updReviewBtn = document.getElementById('catalog-update-review');
  if (updReviewBtn) updReviewBtn.addEventListener('click', function() { openCatalogBulkUpdateModal(); });

  const navActionsEl = document.getElementById('nav-actions');
  if (navActionsEl && canAdd) {
    navActionsEl.innerHTML = '<button type="button" id="add-place-btn" class="nav-action-btn">Add</button>';
  }
  const addBtn = document.getElementById('add-place-btn');
  if (addBtn) addBtn.addEventListener('click', function() { openAddModal(null, 'place'); });
  const placesSearchInput = document.getElementById('search-input');
  const statusSel = document.getElementById('filter-status');
  const catSel = document.getElementById('filter-category');
  const countrySel = document.getElementById('filter-country');
  const catalogSel = document.getElementById('filter-catalog');
  const filterBtn = document.getElementById('filter-btn');
  const filterPop = document.getElementById('filter-popover');
  const filterClear = document.getElementById('filter-clear');
  const filterSels = [statusSel, catSel, countrySel, catalogSel].filter(Boolean);
  function rerender() {
    renderPlaceList(placesSearchInput ? placesSearchInput.value : '');
  }
  const filterKeyById = { 'filter-status': 'status', 'filter-category': 'category', 'filter-country': 'country', 'filter-catalog': 'catalog' };
  const groupBySel = document.getElementById('filter-group-by');
  if (groupBySel) groupBySel.addEventListener('change', function() {
    state.groupBy = this.value;
    setPref('places-group-by', this.value);
    rerender();
  });
  wireFilterPopover({
    btn: filterBtn, pop: filterPop, clear: filterClear, sels: filterSels,
    keyById: filterKeyById, filters: state.placeFilters,
    searchInput: placesSearchInput, searchKey: 'search', onApply: rerender,
    tagOptions: placeTags, tagsKey: 'tags',
    tagMsBtn: document.getElementById('filter-tag-ms-btn'),
  });
}

// Bucket key for "Group by letter". Keep the first character as-is for any
// Unicode letter (no folding) so non-Latin scripts get their own buckets
// alongside Latin ones. Non-letter starts (digits, punctuation) go in "#".
export function letterBucket(name) {
  const raw = (name || '').charAt(0);
  if (!raw) return '#';
  return /\p{L}/u.test(raw) ? raw.toUpperCase() : '#';
}
// Locale-agnostic sort. Browser-default locale gives each user the
// ordering they expect (Norwegian: Æ Ø Å after Z; Swedish: Å Ä Ö; etc.).
// "#" bucket always last.
export const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
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
export function groupAndSort(items, keyFn, nameFn, byLetter, sortKeyFn) {
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

export function renderPlaceList(query) {
  if (query === undefined) {
    const si = document.getElementById('search-input');
    query = si ? si.value : '';
  }
  const q = query.toLowerCase().trim();
  const view = listView('places');
  const showImage = getShowField('image');
  const FOCUS_RE = /^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$/;
  const groupMode = state.groupBy;
  const byCategory = groupMode === 'category';
  const byLetter = groupMode === 'letter';
  const statusEl = document.getElementById('filter-status');
  const catEl = document.getElementById('filter-category');
  const countryEl = document.getElementById('filter-country');
  const wantStatus = statusEl ? statusEl.value : 'all';
  const wantCat = catEl ? catEl.value : 'all';
  const wantCountry = countryEl ? countryEl.value : 'all';
  const wantTags = state.placeFilters.tags || [];
  const catalogEl = document.getElementById('filter-catalog');
  const wantCatalog = catalogEl ? catalogEl.value : 'all';
  const filtered = state.places.filter(p => {
    if (q && !(
      p.name.toLowerCase().includes(q) ||
      (p.note && p.note.toLowerCase().includes(q)) ||
      p.category.toLowerCase().includes(q) ||
      (p.country && p.country.toLowerCase().includes(q)) ||
      (Array.isArray(p.tags) && p.tags.some(t => t.toLowerCase().includes(q)))
    )) return false;
    if (wantStatus === 'visited' && !p.visited) return false;
    if (wantStatus === 'want' && p.visited) return false;
    if (wantCat !== 'all' && p.category !== wantCat) return false;
    if (wantCountry !== 'all' && p.country !== wantCountry) return false;
    if (!tagsIncludeAll(p.tags, wantTags)) return false;
    if (wantCatalog === 'from-catalog' && !p.from_catalog) return false;
    if (wantCatalog === 'not-from-catalog' && p.from_catalog) return false;
    if (wantCatalog === 'updates-available' && !findCatalogUpdate(p)) return false;
    return true;
  });
  setResultCount(filtered.length);
  // Alphabetical within each bucket (Norwegian locale: Æ/Ø/Å after Z).
  const { grouped, keys } = groupAndSort(
    filtered,
    p => byCategory ? p.category : byLetter ? letterBucket(p.name) : (p.country || 'Other'),
    p => p.name,
    byLetter
  );
  let html = '';
  for (const key of keys) {
    const items = grouped[key];
    const keyVisited = items.filter(p => p.visited).length;
    html += '<div class="category-group fade-in">';
    // Only category grouping wires the label as a map filter today; country
    // grouping isn't a filterable axis yet.
    const nameHtml = escapeHtml(byCategory ? displayCategory(key) : key);
    const nameSpan = byCategory
      ? '<span class="section-link" data-filter-cat="' + escapeHtml(key) + '" title="Show only this category on the map">' + nameHtml + '</span>'
      : '<span>' + nameHtml + '</span>';
    html += '<div class="category-label">';
    if (byCategory) {
      const dotColor = (key && state.categoryColors[key]) || 'var(--muted)';
      html += '<span class="group-color-dot" style="background:' + dotColor + '"></span>';
    }
    html += nameSpan;
    html += '<span class="place-count">(' + keyVisited + '/' + items.length + ')</span>';
    html += '</div>';
    html += '<div class="place-grid">';
    for (const p of items) {
      const statusClass = p.visited ? 'visited' : 'want';
      const href = focusHash('place', p._slug || p.name);
      let rowInner = '<span class="status-dot ' + statusClass + '"></span>';
      rowInner += '<div class="place-text">';
      rowInner += '<div class="name">' + escapeHtml(p.name) + '</div>';
      if (p.note && getShowField('note')) rowInner += '<div class="note">' + escapeHtml(p.note) + '</div>';
      rowInner += tagPillsHtml(p.tags, 'place-tags');
      rowInner += '</div>';
      if (p.from_catalog) {
        const orphan = isCatalogOrphan(p);
        const upd = orphan ? null : findCatalogUpdate(p);
        const cls = 'catalog-mark' + (orphan ? ' orphan' : (upd ? ' update-available' : ''));
        const title = orphan
          ? 'No longer in the site catalog (the linked entry was removed)'
          : (upd
            ? 'Catalog updated this entry (' + upd.changes.length + ' field' + (upd.changes.length === 1 ? '' : 's') + '). Click to review.'
            : 'Imported from the site catalog');
        const icon = orphan
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
        rowInner += '<button type="button" class="' + cls + '" data-place-slug="' + escapeHtml(p._slug || '') + '" title="' + escapeHtml(title) + '">' +
          icon +
          '</button>';
      }
      html += '<div class="place-card" data-place-id="' + escapeHtml(p.id || '') + '" data-place-name="' + escapeHtml(p.name) + '" data-place-slug="' + escapeHtml(p._slug || '') + '" onclick="location.hash=\'' + href.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\'">';
      if (view !== 'grid') {
        if (p.image && showImage) {
          const focus = typeof p.image_focus === 'string' && FOCUS_RE.test(p.image_focus.trim()) ? p.image_focus.trim() : '';
          const styleAttr = focus ? ' style="object-position:' + focus + '"' : '';
          html += '<img class="card-media" src="' + escapeHtml(p.image) + '" alt=""' + styleAttr + ' loading="lazy" decoding="async" fetchpriority="low" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">';
        } else if (view === 'compact') {
          // Reserve the thumbnail's width (not height) so text in image-less
          // rows starts at the same x as rows with an image.
          html += '<div class="card-media-spacer"></div>';
        }
        html += '<div class="card-body">' + rowInner + '</div>';
      } else {
        html += rowInner;
      }
      html += '</div>';
    }
    html += '</div></div>';
  }
  if (!html) html = '<div class="loading">No matches</div>';
  const listEl = document.getElementById('place-list');
  listEl.className = 'category-grid' + (view !== 'grid' ? ' view-' + view : '');
  listEl.innerHTML = html;
  // Catalog badge clicks stay on the place-card (which navigates to the
  // map via inline onclick); stop propagation and open the update modal
  // instead.
  listEl.querySelectorAll('.catalog-mark').forEach(btn => {
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      ev.preventDefault();
      const slug = this.dataset.placeSlug;
      const place = (state.places || []).find(p => p._slug === slug);
      if (!place) return;
      if (findCatalogUpdate(place)) openCatalogUpdateModal(place);
    });
  });
  listEl.querySelectorAll('.place-card').forEach(function(card) {
    attachContextMenu(card, function() {
      const slug = card.dataset.placeSlug;
      const place = (state.places || []).find(p => p._slug === slug);
      if (!place) return [];
      const items = [];
      items.push({ label: 'Open on map', onClick: function() { location.hash = '#/?focus=place:' + encodeURIComponent(place.name); } });
      if (Array.isArray(place.sources) && place.sources.length) {
        items.push({ label: 'Open source', onClick: function() { window.open(place.sources[0], '_blank', 'noopener'); } });
      }
      if (!isReadOnly() && state.auth && state.auth.authenticated) {
        items.push({ label: 'Edit', onClick: function() { openEditPlaceModal(place); } });
      }
      if (place.from_catalog && findCatalogUpdate(place)) {
        items.push({ label: 'Apply catalog update', onClick: function() { openCatalogUpdateModal(place); } });
      }
      if (!isReadOnly() && state.auth && state.auth.authenticated) {
        items.push(null);
        items.push({ label: 'Delete', danger: true, onClick: function() {
          deletePlaceItem(place, { animate: true, after: function(prevColors) { syncPlacesOnMap(prevColors); resyncPlaceCardSlugs(); } });
        }});
      }
      return items;
    });
  });
  listEl.querySelectorAll('.section-link[data-filter-cat]').forEach(function(label) {
    label.addEventListener('click', function() {
      const cat = label.dataset.filterCat;
      const allCats = Object.keys(state.categoryColors);
      state.hiddenCategories = new Set(allCats.filter(c => c !== cat));
      // Strong intent: "show only this category". Hide all routes too;
      // user can re-enable from the filter panel.
      const allRegions = state.manifest ? state.manifest.regions.map(r => r.name) : [];
      state.hiddenRegions = new Set(allRegions);
      state.showVisited = true;
      state.showWant = true;
      location.hash = '#/';
    });
  });
  alignPlaceHeaders();
}

// Cards are centered within each section, so a section's leftmost card is
// indented from the section edge. Pure CSS can't put the header above that
// moving edge, so shift each header to share the leftmost card's left (and,
// by symmetry, right) inset, measured from the actual card.
//
// Sections use content-visibility, so measuring an off-screen one would
// force it to render and undo the resize savings. An IntersectionObserver
// tracks which sections are on screen; we only ever measure those, and a
// section gets aligned as it scrolls into view. The label's own margin
// doesn't move the cards, so reads need no clear-first pass; reads are still
// batched ahead of writes to keep it to ~one reflow.
let _placeHeaderObserver = null;
const _visiblePlaceSections = new Set();
function alignVisibleHeaders() {
  const listEl = document.getElementById('place-list');
  if (!listEl) return;
  const skip = listEl.classList.contains('view-compact') || listEl.classList.contains('view-gallery');
  const pads = [];
  _visiblePlaceSections.forEach(function(g) {
    const label = g.querySelector('.category-label');
    if (!label) return;
    if (skip) { pads.push([label, 0]); return; }
    const grid = g.querySelector('.place-grid');
    const first = grid && grid.querySelector('.place-card');
    if (!first) { pads.push([label, 0]); return; }
    pads.push([label, Math.max(0, Math.round(first.getBoundingClientRect().left - grid.getBoundingClientRect().left))]);
  });
  pads.forEach(function(p) {
    p[0].style.marginLeft = p[1] ? p[1] + 'px' : '';
    p[0].style.marginRight = p[1] ? p[1] + 'px' : '';
  });
}
// (Re)build the observer for the current list render. Called at the end of
// renderPlaceList; replaces any prior observer.
function alignPlaceHeaders() {
  const listEl = document.getElementById('place-list');
  if (!listEl) return;
  if (_placeHeaderObserver) { _placeHeaderObserver.disconnect(); }
  _visiblePlaceSections.clear();
  const groups = listEl.querySelectorAll('.category-group');
  if (typeof IntersectionObserver === 'undefined') {
    // Fallback: no observer, treat all sections as visible (older browsers
    // also lack content-visibility, so there's nothing to defeat).
    groups.forEach(function(g) { _visiblePlaceSections.add(g); });
    alignVisibleHeaders();
    return;
  }
  _placeHeaderObserver = new IntersectionObserver(function(entries) {
    let changed = false;
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        if (!_visiblePlaceSections.has(e.target)) { _visiblePlaceSections.add(e.target); changed = true; }
      } else {
        _visiblePlaceSections.delete(e.target);
      }
    });
    if (changed) alignVisibleHeaders();
  }, { root: document.getElementById('app'), rootMargin: '200px 0px' });
  groups.forEach(function(g) { _placeHeaderObserver.observe(g); });
}
// Re-align the on-screen sections per frame while resizing. Only the visible
// few are measured, so this is cheap and never forces an off-screen
// content-visibility section to render.
let _alignHeadersRaf = 0;
window.addEventListener('resize', function() {
  if (_alignHeadersRaf) return;
  _alignHeadersRaf = requestAnimationFrame(function() {
    _alignHeadersRaf = 0;
    alignVisibleHeaders();
  });
});
