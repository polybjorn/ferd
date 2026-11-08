import { displayCategory, state } from '../core.js';
import { dataLayer } from '../store.js';
import { collectTags, tagsInclude } from '../tags.js';
import { wireFilterPopover } from '../map/index.js';
import { fetchCatalog } from '../places-list.js';
import { enhanceSelectsIn, openConfirmModal } from '../select.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { ErrorBox, html, useEffect, useRef, useState } from '../view.js';

// The catalogue cache is a loose field on the shared state. Read at call
// time: this module loads inside an import cycle with core.js, before
// `state` is initialised.
const catalogState = () => /** @type {any} */ (state);

const HINT_STYLE = 'font-size:var(--ui-text-xs);color:var(--muted);padding:var(--ui-space-2) 0';

// Hide entries the user has already imported. Tracked by from_catalog name
// and by primary source URL, so a catalog entry that was renamed since
// import (name changed, source stable) isn't offered again as a duplicate.
/** @param {any[]} raw */
function notYetImported(raw) {
  const names = new Set();
  const sources = new Set();
  (state.places || []).forEach((/** @type {any} */ p) => {
    if (!p || !p.from_catalog) return;
    names.add(p.from_catalog);
    (Array.isArray(p.sources) ? p.sources : []).forEach((/** @type {any} */ s) => {
      if (typeof s === 'string' && s.trim()) sources.add(s);
    });
  });
  return (raw || []).filter(e => {
    if (!e) return false;
    if (names.has(e.name)) return false;
    const primary = Array.isArray(e.sources) && e.sources[0];
    return !(primary && sources.has(primary));
  });
}

/** @typedef {{ q: string, category: string, country: string, tag: string }} BrowseFilters */

/** @param {{ entries: any[] }} props */
function BrowseList({ entries }) {
  const meta = (/** @type {any} */ e) => [e.category, e.country].filter(Boolean).join(' · ');
  // Filter dimensions drawn from the entries actually on offer (after
  // dedup), so the dropdowns never list a value with no matching row.
  // Categories are slugs; label them via displayCategory. Tags are empty
  // until catalog entries ship them, so that select self-hides.
  const fCats = [...new Set(entries.map(e => e.category).filter(Boolean))]
    .sort((a, b) => displayCategory(a).localeCompare(displayCategory(b)));
  const fCountries = [...new Set(entries.map(e => e.country).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const fTags = collectTags(entries);
  const hasFilters = fCats.length > 1 || fCountries.length > 1 || fTags.length > 0;

  const [f, setF] = useState(/** @type {BrowseFilters} */ ({ q: '', category: 'all', country: 'all', tag: 'all' }));
  const [checked, setChecked] = useState(/** @type {Set<number>} */ (new Set()));
  const [notes, setNotes] = useState(/** @type {boolean | null} */ (null));
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const filters = useRef(/** @type {any} */ ({}));
  const controls = useRef(/** @type {HTMLDivElement | null} */ (null));

  useEffect(() => {
    if (!hasFilters || !controls.current) return;
    const root = controls.current;
    enhanceSelectsIn(root);
    /** @param {string} id */
    const el = id => /** @type {HTMLElement | null} */ (document.getElementById(id));
    wireFilterPopover({
      btn: el('browse-filter-btn'),
      pop: el('browse-filter-popover'),
      clear: el('browse-clear'),
      sels: ['bf-category', 'bf-country', 'bf-tag'].map(el).filter(Boolean),
      keyById: { 'bf-category': 'category', 'bf-country': 'country', 'bf-tag': 'tag' },
      filters: filters.current, searchInput: el('browse-filter'), searchKey: 'q',
      onApply: () => setF((/** @type {any} */ prev) => ({ ...prev, ...filters.current })),
    });
  }, []);

  const visible = entries.map((e, i) => ({ e, i })).filter(({ e }) => {
    const q = f.q.trim().toLowerCase();
    if (q && ![e.name || t('common.unnamed'), meta(e), (e.note || '').trim()].join(' ').toLowerCase().includes(q)) return false;
    if (f.category !== 'all' && e.category !== f.category) return false;
    if (f.country !== 'all' && e.country !== f.country) return false;
    if (f.tag !== 'all' && !tagsInclude(e.tags, f.tag)) return false;
    return true;
  });
  const visChecked = visible.filter(({ i }) => checked.has(i)).length;
  const allVisible = visible.length > 0 && visChecked === visible.length;

  /** @param {number} i */
  const toggle = i => setChecked((/** @type {any} */ prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  const selectAll = () => setChecked((/** @type {any} */ prev) => {
    const next = new Set(prev);
    visible.forEach(({ i }) => { if (allVisible) next.delete(i); else next.add(i); });
    return next;
  });

  const runImport = () => {
    const picked = [...checked].sort((a, b) => a - b).map(i => entries[i]).filter(Boolean)
      // _source is a server-side UI tag; the place schema rejects it.
      // Tag the imported place with its catalog source so Browse can hide
      // it on re-open and a future "Update from catalog" knows the lineage.
      .map(e => { const { _source, ...rest } = e; return Object.assign({}, rest, { from_catalog: e.name }); });
    if (!picked.length) return;
    const go = () => {
      setError('');
      const errors = /** @type {string[]} */ ([]);
      let done = 0;
      const next = () => {
        if (done >= picked.length) {
          setProgress(0);
          if (errors.length) setError(t('browse.someFailed', { failed: errors.length, total: picked.length, errors: errors.join('; ') }));
          else closeModal();
          return;
        }
        setProgress(done + 1);
        dataLayer.createPlace(picked[done])
          .catch((/** @type {Error} */ err) => errors.push((picked[done].name || '?') + ': ' + err.message))
          .then(() => { done++; next(); });
      };
      next();
    };
    // Small selections import straight away; only guard large batches.
    if (picked.length < 10) { go(); return; }
    openConfirmModal({ title: t('browse.confirmTitle', { count: picked.length }), confirmLabel: t('common.add') })
      .then(ok => { if (ok) go(); });
  };

  /** @param {Event} e */
  const onSearch = e => { const q = /** @type {HTMLInputElement} */ (e.currentTarget).value; setF((/** @type {any} */ prev) => ({ ...prev, q })); };

  return html`<div>
    <div style="display:flex;gap:var(--ui-space-2);align-items:center;margin-bottom:var(--ui-space-2)" id="browse-controls" ref=${controls}>
      <input type="text" id="browse-filter" placeholder=${t('common.filter')} style="flex:1;margin:0" onInput=${hasFilters ? undefined : onSearch} />
      ${hasFilters && html`<div class="filter-dropdown">
        <button type="button" class="filter-btn" id="browse-filter-btn" aria-haspopup="true" aria-expanded="false">${t('browse.filters')}</button>
        <div class="filter-popover" id="browse-filter-popover" hidden>
          ${fCats.length > 1 && html`<select id="bf-category"><option value="all">${t('form.category')}</option>
            ${fCats.map(c => html`<option key=${c} value=${c}>${displayCategory(c)}</option>`)}</select>`}
          ${fCountries.length > 1 && html`<select id="bf-country"><option value="all">${t('form.country')}</option>
            ${fCountries.map(c => html`<option key=${c} value=${c}>${c}</option>`)}</select>`}
          ${fTags.length > 0 && html`<select id="bf-tag"><option value="all">${t('browse.tag')}</option>
            ${fTags.map(x => html`<option key=${x} value=${x}>${x}</option>`)}</select>`}
          <button type="button" class="filter-clear" id="browse-clear">${t('browse.clearFilters')}</button>
        </div>
      </div>`}
    </div>
    <div id="browse-list" class=${notes === null ? '' : 'notes-anim' + (notes ? ' show-notes' : '')} style="max-height:50vh;overflow-y:auto">
      ${visible.map(({ e, i }) => {
        const m = meta(e);
        const note = (e.note || '').trim();
        const src = Array.isArray(e.sources) ? e.sources.find((/** @type {any} */ s) => typeof s === 'string' && s.trim()) : null;
        const name = e.name || t('common.unnamed');
        return html`<label class="browse-row" key=${i} data-idx=${i} style="display:flex;align-items:flex-start;gap:var(--ui-space-2);padding:var(--ui-space-2) 0;border-bottom:1px solid var(--border);cursor:pointer">
          <input type="checkbox" class="ui-check browse-pick" data-idx=${i} style="margin-top:var(--ui-space-1)" checked=${checked.has(i)} onChange=${() => toggle(i)} />
          <span style="flex:1;min-width:0;display:block">
            <span style="display:flex;align-items:center;gap:var(--ui-space-2);width:100%">
              <span title=${name} style="flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
              ${src && html`<a href=${src} target="_blank" rel="noopener" class="row-src" onClick=${(/** @type {Event} */ ev) => ev.stopPropagation()}>${t('browse.source')}</a>`}
            </span>
            ${m && html`<span style="display:block;font-size:var(--ui-text-xs);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m}</span>`}
            ${note && html`<span class="row-note">${note}</span>`}
          </span>
        </label>`;
      })}
    </div>
    <${ErrorBox} id="add-error" msg=${error} />
    <div class="form-actions" style="display:flex;align-items:center;gap:var(--ui-space-2)">
      <button type="button" class="ui-button ui-button-quiet" id="browse-notes-toggle" onClick=${() => setNotes(!notes)}>${notes ? t('common.hideNotes') : t('common.showNotes')}</button>
      <button type="button" class="ui-button ui-button-quiet" id="browse-select-all" disabled=${visible.length === 0} onClick=${selectAll}>${allVisible ? t('browse.clearSelection') : t('browse.selectAll')}</button>
      <span class="action-spacer"></span>
      <button type="button" class="ui-button ui-button-primary" id="browse-add" disabled=${checked.size === 0 || progress > 0} onClick=${runImport}>${
        progress ? t('browse.adding', { n: progress, total: checked.size }) : checked.size ? t('browse.addCount', { count: checked.size }) : t('browse.addSelected')}</button>
    </div>
  </div>`;
}

export function Browse() {
  // The catalogue is cached across tab switches so reopening Browse renders
  // at once instead of flashing "Loading..." then content. Admin mutations
  // invalidate `catalogState()._catalogCache` in renderAdminCatalog / picker / mgr.
  const [res, setRes] = useState(/** @type {{ entries?: any[], error?: string }} */ (
    Array.isArray(catalogState()._catalogCache) ? { entries: notYetImported(catalogState()._catalogCache) } : {}));
  useEffect(() => {
    if (res.entries || res.error) return;
    fetchCatalog()
      .then((/** @type {any} */ entries) => {
        catalogState()._catalogCache = Array.isArray(entries) ? entries : [];
        setRes({ entries: notYetImported(catalogState()._catalogCache) });
      })
      .catch((/** @type {Error} */ err) => setRes({ error: err.message }));
  }, []);
  if (res.error) return html`<div id="browse-body"><${ErrorBox} id="add-error" msg=${res.error} /></div>`;
  if (!res.entries) return html`<div id="browse-body"><div style=${HINT_STYLE}>${t('browse.loading')}</div></div>`;
  if (!res.entries.length) {
    return html`<div id="browse-body"><div style=${HINT_STYLE}>${
      (catalogState()._catalogCache || []).length ? t('browse.allImported') : t('browse.empty')}</div></div>`;
  }
  return html`<div id="browse-body"><${BrowseList} entries=${res.entries} /></div>`;
}
