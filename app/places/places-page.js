import { displayCategory, setActiveTab, setCrumb, sortedCategorySlugs, state } from '../core.js';
import { isReadOnly } from '../server.js';
import { catalogCache, labels, places } from '../store.js';
import { collectTags, tagsIncludeAll } from '../tags.js';
import { cleanupMap, deletePlaceItem } from '../map/index.js';
import { getShowField, setPref } from '../prefs.js';
import { openEditPlaceModal } from './edit-place.js';
import { focusHash } from '../router.js';
import { attachContextMenu } from '../context-menu.js';
import { openAddModal } from '../lazy-open.js';
import {
  findCatalogUpdate, groupAndSort, isCatalogOrphan, letterBucket, openCatalogBulkUpdateModal,
  openCatalogUpdateModal, placesWithCatalogUpdates,
} from '../places-list.js';
import { CategoryDot, IndexControls, FilterSelect, ListTabs, TagFilterButton, useFilters, useNavAdd, withCurrent } from '../list-controls.js';
import { listView } from '../history.js';
import { Fragment, html, mountPage, useEffect, useRef } from '../view.js';
import { t } from '../i18n.js';

// PLACE-LIST-BEGIN (tests/js/list-filter.test.js runs this block)
/**
 * Whether a place passes the page's search and filters.
 * @param {any} p
 * @param {any} f The page's filters: search, status, category, country, catalog, tags.
 * @param {(p: any) => unknown} hasUpdate
 */
function placeMatches(p, f, hasUpdate) {
  const q = (f.search || '').toLowerCase().trim();
  if (q && !(
    p.name.toLowerCase().includes(q) ||
    (p.note && p.note.toLowerCase().includes(q)) ||
    p.category.toLowerCase().includes(q) ||
    (p.country && p.country.toLowerCase().includes(q)) ||
    (Array.isArray(p.tags) && p.tags.some((/** @type {string} */ t) => t.toLowerCase().includes(q)))
  )) return false;
  if (f.status === 'visited' && !p.visited) return false;
  if (f.status === 'want' && p.visited) return false;
  if (f.category !== 'all' && p.category !== f.category) return false;
  if (f.country !== 'all' && p.country !== f.country) return false;
  if (!tagsIncludeAll(p.tags, f.tags || [])) return false;
  if (f.catalog === 'from-catalog' && !p.from_catalog) return false;
  if (f.catalog === 'not-from-catalog' && p.from_catalog) return false;
  if (f.catalog === 'updates-available' && !hasUpdate(p)) return false;
  return true;
}
// PLACE-LIST-END

const FOCUS_RE = /^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$/;

export function renderPlacesIndex() {
  setActiveTab('places');
  setCrumb(t('lists.places'));
  cleanupMap();
  setPref('lists-tab', 'places');
  mountPage(html`<${PlacesPage} />`, 'places');
}

/** @param {any} place */
function updateTitle(place) {
  const upd = findCatalogUpdate(place);
  return upd
    ? t('places.catalogUpdated', { count: upd.changes.length })
    : t('places.fromSiteCatalog');
}

const ICON_ORPHAN = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/></svg>`;
const ICON_BOOK = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;

/** @param {any} p */
function menuItems(p) {
  const items = /** @type {any[]} */ ([]);
  items.push({ label: t('lists.openOnMap'), onClick: () => { location.hash = '#/?focus=place:' + encodeURIComponent(p.name); } });
  if (Array.isArray(p.sources) && p.sources.length) {
    items.push({ label: t('lists.openSource'), onClick: () => { window.open(p.sources[0], '_blank', 'noopener'); } });
  }
  const canEdit = !isReadOnly() && state.auth && state.auth.authenticated;
  if (canEdit) items.push({ label: t('lists.edit'), onClick: () => { openEditPlaceModal(p); } });
  if (p.from_catalog && findCatalogUpdate(p)) {
    items.push({ label: t('lists.applyCatalogUpdate'), onClick: () => { openCatalogUpdateModal(p); } });
  }
  if (canEdit) {
    items.push(null);
    items.push({ label: t('common.delete'), danger: true, onClick: () => { deletePlaceItem(p, { animate: true }); } });
  }
  return items;
}

/** @param {{ p: any, view: string, showImage: boolean, showNote: boolean }} props */
function PlaceCard({ p, view, showImage, showNote }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const place = useRef(p);
  place.current = p;
  useEffect(() => { if (ref.current) attachContextMenu(ref.current, () => menuItems(place.current)); }, []);
  const orphan = !!p.from_catalog && isCatalogOrphan(p);
  const upd = p.from_catalog && !orphan ? findCatalogUpdate(p) : null;
  /** @param {Event} ev */
  const openUpdate = ev => {
    ev.stopPropagation();
    ev.preventDefault();
    if (findCatalogUpdate(p)) openCatalogUpdateModal(p);
  };
  const focus = typeof p.image_focus === 'string' && FOCUS_RE.test(p.image_focus.trim()) ? p.image_focus.trim() : '';
  const tags = getShowField('tags') && Array.isArray(p.tags) && p.tags.length ? p.tags : null;
  const row = html`<span class=${'ui-dot ' + (p.visited ? 'dot-visited' : 'dot-want')}></span>
    <div class="place-text">
      <div class="name">${p.name}</div>
      ${p.note && showNote && html`<div class="note">${p.note}</div>`}
      ${tags && html`<div class="place-tags">${tags.map((/** @type {string} */ t) => html`<span class="ui-badge ui-badge-pill tag" key=${t}>${'#' + t}</span>`)}</div>`}
    </div>
    ${p.from_catalog && html`<button type="button" class=${'catalog-mark' + (orphan ? ' orphan' : (upd ? ' update-available' : ''))}
      data-place-slug=${p._slug || ''} onClick=${openUpdate}
      title=${orphan ? t('places.orphan') : updateTitle(p)}>${orphan ? ICON_ORPHAN : ICON_BOOK}</button>`}`;
  return html`<div class="place-card" ref=${ref} data-place-id=${p.id || ''} data-place-name=${p.name} data-place-slug=${p._slug || ''}
    onClick=${() => { location.hash = focusHash('place', p._slug || p.name); }}>
    ${view === 'grid' ? row : html`
      ${p.image && showImage
        ? html`<img class="card-media" src=${p.image} alt="" style=${focus ? 'object-position:' + focus : undefined} loading="lazy" decoding="async"
            fetchpriority="low" referrerpolicy="no-referrer" onError=${(/** @type {Event} */ e) => { /** @type {HTMLElement} */ (e.currentTarget).style.display = 'none'; }} />`
        : view === 'compact' && html`<div class="card-media-spacer"></div>`}
      <div class="card-body">${row}</div>`}
  </div>`;
}

/** @param {string} cat */
function showOnlyCategory(cat) {
  state.hiddenCategories = new Set(Object.keys(state.categoryColors).filter(c => c !== cat));
  // Strong intent: "show only this category". Hide all routes too;
  // user can re-enable from the filter panel.
  state.hiddenRegions = new Set(state.manifest ? state.manifest.regions.map((/** @type {any} */ r) => r.name) : []);
  state.showVisited = true;
  state.showWant = true;
  location.hash = '#/';
}

// Cards are centered within each section, so a section's leftmost card is
// indented from the section edge. Pure CSS can't put the header above that
// moving edge, so shift each header to share the leftmost card's left (and,
// by symmetry, right) inset, measured from the actual card.
//
// An IntersectionObserver tracks which sections are on screen; only those are
// measured per resize frame, and a section gets aligned as it scrolls into
// view. Reads are batched ahead of writes to keep it to about one reflow.
/** @param {{ current: HTMLElement | null }} listRef */
function useHeaderAlignment(listRef) {
  const visible = useRef(/** @type {Set<HTMLElement>} */ (new Set()));
  const align = () => {
    const list = listRef.current;
    if (!list) return;
    const skip = list.classList.contains('view-compact') || list.classList.contains('view-gallery');
    const pads = /** @type {Array<[HTMLElement, number]>} */ ([]);
    visible.current.forEach((/** @type {HTMLElement} */ g) => {
      const label = /** @type {HTMLElement | null} */ (g.querySelector('.category-label'));
      if (!label) return;
      const grid = g.querySelector('.place-grid');
      const first = grid && grid.querySelector('.place-card');
      if (skip || !grid || !first) { pads.push([label, 0]); return; }
      pads.push([label, Math.max(0, Math.round(first.getBoundingClientRect().left - grid.getBoundingClientRect().left))]);
    });
    pads.forEach(([label, pad]) => {
      label.style.marginLeft = pad ? pad + 'px' : '';
      label.style.marginRight = pad ? pad + 'px' : '';
    });
  };
  const alignRef = useRef(align);
  alignRef.current = align;
  // Per frame while resizing; only the visible few are measured.
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; alignRef.current(); });
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); if (raf) cancelAnimationFrame(raf); };
  }, []);
  // Sections come and go with the data, so the observer follows the DOM.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const groups = /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('.category-group'));
    visible.current.clear();
    if (typeof IntersectionObserver === 'undefined') {
      // Without the observer there is nothing to track, so align every section.
      groups.forEach(g => visible.current.add(g));
      align();
      return;
    }
    const io = new IntersectionObserver(entries => {
      let changed = false;
      entries.forEach(e => {
        const g = /** @type {HTMLElement} */ (e.target);
        if (e.isIntersecting) {
          if (!visible.current.has(g)) { visible.current.add(g); changed = true; }
        } else {
          visible.current.delete(g);
        }
      });
      if (changed) align();
    }, { root: document.getElementById('app'), rootMargin: '200px 0px' });
    groups.forEach(g => io.observe(g));
    return () => io.disconnect();
  });
}

function PlacesPage() {
  // Read for the subscription: the page follows the places, their labels
  // (category colours) and the catalogue; state.places is their copy.
  places.value; labels.value; catalogCache.value;
  const [f, patch] = useFilters(state.placeFilters);
  const listRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  useHeaderAlignment(listRef);
  const canAdd = useNavAdd('add-place-btn', t('place.add'), () => openAddModal(null, 'place'));
  if (!state.places) return html`<div class="app-state" aria-busy="true"><p class="ui-hint" role="status">${t('places.loading')}</p></div>`;

  const all = state.places;
  const view = listView('places');
  const showImage = getShowField('image');
  const showNote = getShowField('note');
  const cats = withCurrent(sortedCategorySlugs(Object.keys(state.categoryColors)), f.category);
  const countries = withCurrent([...new Set(all.map((/** @type {any} */ p) => p.country).filter(Boolean))].sort((a, b) => a.localeCompare(b)), f.country);
  const tagOptions = collectTags(all);
  // Editors only, and only while catalog updates are pending.
  const pending = canAdd ? placesWithCatalogUpdates().length : 0;

  const filtered = all.filter((/** @type {any} */ p) => placeMatches(p, f, findCatalogUpdate));
  const mode = state.groupBy;
  const byCategory = mode === 'category';
  const byLetter = mode === 'letter';
  const { grouped, keys } = groupAndSort(
    filtered,
    (/** @type {any} */ p) => byCategory ? p.category : byLetter ? letterBucket(p.name) : (p.country || t('places.noCountry')),
    (/** @type {any} */ p) => p.name,
    byLetter
  );

  const filterCount = /** @type {string[]} */ (['status', 'country', 'category', 'catalog']).filter(k => /** @type {Record<string, any>} */ (f)[k] !== 'all').length
    + (f.tags && f.tags.length ? 1 : 0);
  const clear = () => {
    if (!f.search && !filterCount) return;
    patch({ search: '', status: 'all', country: 'all', category: 'all', catalog: 'all', tags: [] });
  };

  const controls = html`<${IndexControls} placeholder=${t('places.filter')} search=${f.search} onSearch=${(/** @type {string} */ v) => patch({ search: v })}
    count=${filtered.length} kind="places" onView=${() => patch({})} active=${filterCount > 0} onClear=${clear}
    filterChildren=${html`<${Fragment}>
      <${FilterSelect} id="filter-status" value=${f.status} label=${t('lists.status')} onChange=${(/** @type {string} */ v) => patch({ status: v })}>
        <option value="visited">${t('lists.visited')}</option>
        <option value="want">${t('lists.want')}</option>
      <//>
      ${countries.length > 0 && html`<${FilterSelect} id="filter-country" value=${f.country} label=${t('lists.country')} onChange=${(/** @type {string} */ v) => patch({ country: v })}>
        ${countries.map((/** @type {string} */ c) => html`<option key=${c} value=${c}>${c}</option>`)}
      <//>`}
      <${FilterSelect} id="filter-category" value=${f.category} label=${t('lists.category')} onChange=${(/** @type {string} */ v) => patch({ category: v })}>
        ${cats.map((/** @type {string} */ c) => html`<option key=${c} value=${c}>${displayCategory(c)}</option>`)}
      <//>
      ${tagOptions.length > 0 && html`<${TagFilterButton} options=${tagOptions} filters=${f} onChange=${(/** @type {string[]} */ arr) => patch({ tags: arr })} />`}
      <${FilterSelect} id="filter-catalog" value=${f.catalog} label=${t('places.catalog')} onChange=${(/** @type {string} */ v) => patch({ catalog: v })}>
        <option value="from-catalog">${t('places.fromCatalog')}</option>
        <option value="not-from-catalog">${t('places.notFromCatalog')}</option>
        <option value="updates-available">${t('places.updatesAvailable')}</option>
      <//>
      <div class="filter-divider"></div>
      <div class="ui-field"><select id="filter-group-by" value=${mode} onChange=${(/** @type {Event} */ e) => {
        const v = /** @type {HTMLSelectElement} */ (e.currentTarget).value;
        state.groupBy = v;
        setPref('places-group-by', v);
        patch({});
      }}>
        <option value="category">${t('places.groupByCategory')}</option>
        <option value="country">${t('places.groupByCountry')}</option>
        <option value="letter">${t('lists.groupByLetter')}</option>
      </select></div>
    <//>`}>
    ${pending > 0 && html`<div class="filter-dropdown catalog-update-chip-wrap"><button type="button" class="filter-btn catalog-update-chip" id="catalog-update-review" onClick=${openCatalogBulkUpdateModal}>${t('places.reviewUpdates')}</button></div>`}
  </${IndexControls}>`;

  return html`<${ListTabs} current="places" />${controls}
    <div class=${'category-grid' + (view !== 'grid' ? ' view-' + view : '')} id="place-list" ref=${listRef}>
      ${keys.length === 0 && html`<div class="ui-empty" role="status"><p>${t('lists.noMatches')}</p></div>`}
      ${keys.map(key => {
        const items = /** @type {Record<string, any[]>} */ (grouped)[key];
        const visited = items.filter((/** @type {any} */ p) => p.visited).length;
        return html`<div class="category-group fade-in" key=${key}>
          <div class="category-label">
            ${byCategory && html`<${CategoryDot} category=${key} />`}
            ${byCategory
              ? html`<span class="section-link" data-filter-cat=${key} title=${t('places.showOnlyCategory')} onClick=${() => showOnlyCategory(key)}>${displayCategory(key)}</span>`
              : html`<span>${key}</span>`}
            <span class="place-count">${'(' + visited + '/' + items.length + ')'}</span>
          </div>
          <div class="place-grid">
            ${items.map((/** @type {any} */ p) => html`<${PlaceCard} key=${p.id || p._slug} p=${p} view=${view} showImage=${showImage} showNote=${showNote} />`)}
          </div>
        </div>`;
      })}
    </div>`;
}
