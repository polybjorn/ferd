import { displayRegion, setActiveTab, setCrumb, state } from '../core.js';
import { gpxUrlFor, isReadOnly } from '../server.js';
import { routes } from '../store.js';
import { collectTags, tagsIncludeAll } from '../tags.js';
import { cleanupMap, deleteRouteItem, fetchGpxText } from '../map/index.js';
import { setPref } from '../prefs.js';
import { openEditTrailMetadataModal } from './route-meta.js';
import { groupAndSort, letterBucket } from '../places-list.js';
import { drawRouteSilhouette, listView } from '../history.js';
import { attachContextMenu } from '../context-menu.js';
import { openAddModal } from '../add/add.js';
import { IndexControls, FilterSelect, ListTabs, TagFilterButton, useFilters, useNavAdd, withCurrent } from '../list-controls.js';
import { Fragment, html, mountPage, useEffect, useRef } from '../view.js';

// ROUTE-LIST-BEGIN (tests/js/list-filter.test.js runs this block)
/**
 * Whether a route passes the page's search and filters.
 * @param {{ route: any, region: string }} entry
 * @param {any} f The page's filters: search, status, region (lowercased), difficulty, rating, tags.
 */
function routeMatches(entry, f) {
  const route = entry.route;
  const q = (f.search || '').trim().toLowerCase();
  if (q && !route.name.toLowerCase().includes(q) && !entry.region.toLowerCase().includes(q)) return false;
  if (f.status === 'completed' && !route.completed) return false;
  if (f.status === 'planned' && route.completed) return false;
  if (f.region !== 'all' && entry.region.toLowerCase() !== f.region) return false;
  if (f.difficulty !== 'all' && route.difficulty !== f.difficulty) return false;
  if (f.rating === 'unrated' && route.rating) return false;
  if (f.rating !== 'all' && f.rating !== 'unrated' && String(route.rating || '') !== f.rating) return false;
  if (!tagsIncludeAll(route.tags, f.tags || [])) return false;
  return true;
}
// ROUTE-LIST-END

const DIFFICULTIES = ['easy', 'moderate', 'hard', 'expert'];
const RATINGS = ['unrated', '1', '2', '3', '4', '5'];

export function renderTrailsIndex() {
  setActiveTab('routes');
  setCrumb('Routes');
  cleanupMap();
  setPref('lists-tab', 'routes');
  mountPage(html`<${RoutesPage} />`);
}

/** @param {any} route @param {string} regionName */
function menuItems(route, regionName) {
  const items = /** @type {any[]} */ ([]);
  const canEdit = !isReadOnly() && state.auth && state.auth.authenticated;
  items.push({ label: 'Open on map', onClick: () => { location.hash = '#/?focus=route:' + encodeURIComponent(route.key); } });
  items.push({ label: 'Open detail', onClick: () => { location.hash = '#/routes/route/' + encodeURIComponent(route.key); } });
  if (route.source) items.push({ label: 'Open source', onClick: () => { window.open(route.source, '_blank', 'noopener'); } });
  if (canEdit) items.push({ label: 'Edit', onClick: () => { openEditTrailMetadataModal(route, regionName); } });
  if (canEdit) {
    items.push(null);
    items.push({ label: 'Delete', danger: true, onClick: () => { deleteRouteItem(route, regionName, () => {}); } });
  }
  return items;
}

/** @param {{ route: any, region: string, view: string }} props */
function RouteCard({ route, region, view }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const canvas = useRef(/** @type {HTMLCanvasElement | null} */ (null));
  const cur = useRef({ route, region });
  cur.current = { route, region };
  useEffect(() => { if (ref.current) attachContextMenu(ref.current, () => menuItems(cur.current.route, cur.current.region)); }, []);
  // The silhouette comes from the GPX, so it is redrawn only when the card
  // shows another file (or the view brings the canvas back), not on every
  // metadata change.
  useEffect(() => {
    if (view !== 'grid' && canvas.current) drawRouteSilhouette(canvas.current, route);
  }, [view, route.file, route.key]);
  const row = html`<span class=${'ui-dot ' + (route.completed ? 'dot-completed' : 'dot-planned')}></span>
    <span class="name">${route.name}</span>`;
  return html`<div class="route-card" ref=${ref} data-route-key=${route.key}
    onClick=${() => { location.hash = '#/routes/route/' + encodeURIComponent(route.key); }}>
    ${view === 'grid' ? row : html`<canvas class="card-media route-thumb" ref=${canvas} data-route-key=${route.key}></canvas>
      <div class="card-body">${row}</div>`}
  </div>`;
}

/** @param {string} region */
function showOnlyRegion(region) {
  const regions = state.manifest ? state.manifest.regions : [];
  state.hiddenRegions = new Set(regions.map((/** @type {any} */ x) => x.name).filter((/** @type {string} */ x) => x !== region));
  // Strong intent: "show only this region". Hide all places too;
  // user can re-enable from the filter panel.
  state.hiddenCategories = new Set(Object.keys(state.categoryColors));
  state.showCompleted = true;
  state.showPlanned = true;
  location.hash = '#/';
}

function RoutesPage() {
  // Read for the subscription; state.manifest is the store's copy.
  routes.value;
  const [f, patch] = useFilters(state.trailFilters);
  useNavAdd('add-route-btn', 'Add route', () => openAddModal(null, 'route'));
  const all = state.manifest ? state.manifest.regions.flatMap((/** @type {any} */ r) => r.routes) : [];
  // The GPX cache is warmed once per route file, so a click from the list
  // finds the response already cached; the limiter in fetchGpxText keeps the
  // burst polite.
  const files = all.map((/** @type {any} */ r) => r.file).join('\n');
  useEffect(() => {
    for (const file of files ? files.split('\n') : []) fetchGpxText(gpxUrlFor(file)).catch(() => { /* ignore */ });
  }, [files]);
  if (!state.manifest) return html`<div class="app-state" aria-busy="true"><p class="ui-hint" role="status">Loading routes...</p></div>`;

  const regions = state.manifest.regions;
  const view = listView('routes');
  const regionNames = regions.map((/** @type {any} */ r) => r.name).slice().sort((/** @type {string} */ a, /** @type {string} */ b) => {
    if (a === '') return 1;
    if (b === '') return -1;
    return a.localeCompare(b);
  });
  const regionValues = withCurrent(regionNames.map((/** @type {string} */ n) => n.toLowerCase()), f.region);
  const regionLabel = new Map(regionNames.map((/** @type {string} */ n) => [n.toLowerCase(), displayRegion(n)]));
  const tagOptions = collectTags(all);
  const entries = regions.flatMap((/** @type {any} */ r) => r.routes.map((/** @type {any} */ rt) => ({ route: rt, region: r.name })));
  const filtered = entries.filter((/** @type {any} */ e) => routeMatches(e, f));
  const byLetter = state.trailsGroupBy === 'letter';
  const { grouped, keys } = groupAndSort(
    filtered,
    (/** @type {any} */ e) => byLetter ? letterBucket(e.route.name) : e.region,
    (/** @type {any} */ e) => e.route.name || e.route.key || '',
    byLetter,
    (/** @type {string} */ a, /** @type {string} */ b) => {
      if (a === '') return 1;
      if (b === '') return -1;
      return a.localeCompare(b);
    }
  );
  const filterCount = /** @type {string[]} */ (['status', 'region', 'difficulty', 'rating']).filter(k => /** @type {Record<string, any>} */ (f)[k] !== 'all').length
    + (f.tags && f.tags.length ? 1 : 0);
  const clear = () => {
    if (!f.search && !filterCount) return;
    patch({ search: '', status: 'all', region: 'all', difficulty: 'all', rating: 'all', tags: [] });
  };

  return html`<${ListTabs} current="routes" /><${IndexControls} placeholder="Filter routes..." search=${f.search} onSearch=${(/** @type {string} */ v) => patch({ search: v })}
    count=${filtered.length} kind="routes" onView=${() => patch({})} active=${filterCount > 0} onClear=${clear}
    filterChildren=${html`<${Fragment}>
      <${FilterSelect} id="filter-status" value=${f.status} label="Status" onChange=${(/** @type {string} */ v) => patch({ status: v })}>
        <option value="completed">Completed</option>
        <option value="planned">Planned</option>
      <//>
      <${FilterSelect} id="filter-region" value=${f.region} label="Region" onChange=${(/** @type {string} */ v) => patch({ region: v })}>
        ${regionValues.map((/** @type {string} */ v) => html`<option key=${v} value=${v}>${regionLabel.get(v) || v}</option>`)}
      <//>
      <${FilterSelect} id="filter-difficulty" value=${f.difficulty} label="Difficulty" onChange=${(/** @type {string} */ v) => patch({ difficulty: v })}>
        ${DIFFICULTIES.map(d => html`<option key=${d} value=${d}>${d[0].toUpperCase() + d.slice(1)}</option>`)}
      <//>
      <${FilterSelect} id="filter-rating" value=${f.rating} label="Rating" onChange=${(/** @type {string} */ v) => patch({ rating: v })}>
        ${RATINGS.map(v => html`<option key=${v} value=${v}>${v === 'unrated' ? 'Unrated' : v + ' star' + (v === '1' ? '' : 's')}</option>`)}
      <//>
      ${tagOptions.length > 0 && html`<${TagFilterButton} options=${tagOptions} filters=${f} onChange=${(/** @type {string[]} */ arr) => patch({ tags: arr })} />`}
      <div class="filter-divider"></div>
      <select id="filter-group-by" value=${state.trailsGroupBy} onChange=${(/** @type {Event} */ e) => {
        const v = /** @type {HTMLSelectElement} */ (e.currentTarget).value;
        state.trailsGroupBy = v;
        setPref('trails-group-by', v);
        patch({});
      }}>
        <option value="region">Group by region</option>
        <option value="letter">Group by first letter</option>
      </select>
    <//>`} />
    <div class=${'region-grid' + (view !== 'grid' ? ' view-' + view : '')} id="trails-list-mount">
      ${keys.map(key => {
        const items = /** @type {Record<string, any[]>} */ (grouped)[key];
        const done = items.filter((/** @type {any} */ e) => e.route.completed).length;
        return html`<div class="region-group fade-in" key=${key}>
          <div class="region-label">
            ${byLetter
              ? html`<span>${key}</span>`
              : html`<span class="section-link" data-filter-region=${key} title="Show only this region on the map" onClick=${() => showOnlyRegion(key)}>${displayRegion(key)}</span>`}
            <span class="route-count">${'(' + done + '/' + items.length + ')'}</span>
          </div>
          <div class="route-grid">
            ${items.map((/** @type {any} */ e) => html`<${RouteCard} key=${e.route.key} route=${e.route} region=${e.region} view=${view} />`)}
          </div>
        </div>`;
      })}
    </div>`;
}
