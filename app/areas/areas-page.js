import { displayCategory, manifestRoutes, setActiveTab, setCrumb, state } from '../core.js';
import { isReadOnly } from '../server.js';
import { areas, labels, places, routes } from '../store.js';
import { areaStatText, placesInArea } from '../area-geo.js';
import { cleanupMap, routesInArea, showResultOnMap } from '../map/index.js';
import { routesEnabled, setPref } from '../prefs.js';
import { groupAndSort } from '../places-list.js';
import { attachContextMenu } from '../context-menu.js';
import { openEditAreaModal } from './edit-area.js';
import { CategoryDot, FilterSelect, IndexControls, ListTabs, useFilters, withCurrent } from '../list-controls.js';
import { Fragment, html, mountPage, useEffect, useRef, useState } from '../view.js';

export function renderAreasIndex() {
  setActiveTab('areas');
  setCrumb('Areas');
  cleanupMap();
  setPref('lists-tab', 'areas');
  mountPage(html`<${AreasPage} />`);
}

/**
 * @typedef {{ count: number, done: number }} RouteCount
 */

// The same hand-off as a search pick: the map shows the area and opens its
// popup once it is up.
/** @param {any} area */
const showOnMap = area => showResultOnMap({ type: 'area', id: String(area.id) });

/** @param {any} area */
function menuItems(area) {
  const items = /** @type {any[]} */ ([{ label: 'Open on map', onClick: () => showOnMap(area) }]);
  if (!isReadOnly() && state.auth && state.auth.authenticated) items.push({ label: 'Edit', onClick: () => openEditAreaModal(area) });
  return items;
}

/** @param {{ a: any, visited: boolean, note: string }} props */
function AreaCard({ a, visited, note }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const area = useRef(a);
  area.current = a;
  useEffect(() => { if (ref.current) attachContextMenu(ref.current, () => menuItems(area.current)); }, []);
  return html`<div class="place-card area-card" ref=${ref} data-area-id=${a.id} onClick=${() => showOnMap(a)}>
    <span class=${'ui-dot ' + (visited ? 'dot-visited' : 'dot-want')}></span>
    <div class="place-text">
      <div class="name">${a.name}</div>
      ${note && html`<div class="note">${note}</div>`}
    </div>
  </div>`;
}

function AreasPage() {
  // Read for the subscription; state.areas, state.places and state.manifest
  // are the store's copies.
  areas.value; places.value; routes.value; labels.value;
  const [f, patch] = useFilters(state.areaFilters);
  const withRoutes = routesEnabled();
  // Only a route's track can tell whether it crosses an area, and tracks load
  // one by one, so route counts fill in after the list has drawn.
  const [routeCounts, setRouteCounts] = useState(/** @type {Map<string, RouteCount | null>} */ (new Map()));
  useEffect(() => {
    if (!withRoutes) return;
    let live = true;
    const all = manifestRoutes();
    for (const a of state.areas || []) {
      routesInArea(a, all).then(found => {
        if (!live) return;
        const done = found.filter((/** @type {any} */ r) => r.completed).length;
        setRouteCounts((/** @type {Map<any, any>} */ m) => new Map(m).set(a.id, { count: found.length, done }));
      }, () => {
        // A partial count would read as the real one, so a track that cannot
        // be read leaves the area without one, as its popup does.
        if (live) setRouteCounts((/** @type {Map<any, any>} */ m) => new Map(m).set(a.id, null));
      });
    }
    return () => { live = false; };
  }, [areas.value, routes.value, withRoutes]);

  const rows = (state.areas || []).map((/** @type {any} */ a) => {
    const inside = placesInArea(a.geometry, state.places || []);
    const placesDone = inside.filter((/** @type {any} */ p) => p.visited).length;
    const rc = routeCounts.get(a.id);
    return {
      a,
      visited: !!a.visited || placesDone > 0 || !!(rc && rc.done),
      // Only what the area holds: a list of "No places. No routes" says
      // less than the bare names.
      note: [
        inside.length ? areaStatText(inside.length, 'place', placesDone, 'visited') : '',
        withRoutes && rc && rc.count ? areaStatText(rc.count, 'route', rc.done, 'completed') : '',
      ].filter(Boolean).join('. '),
    };
  });

  const q = (f.search || '').toLowerCase().trim();
  const filtered = rows.filter(r => {
    if (q && !(r.a.name.toLowerCase().includes(q) || (r.a.local_name && r.a.local_name.toLowerCase().includes(q)))) return false;
    if (f.status === 'visited' && !r.visited) return false;
    if (f.status === 'want' && r.visited) return false;
    if (f.category !== 'all' && r.a.category !== f.category) return false;
    return true;
  });
  const cats = withCurrent([...new Set(rows.map(r => r.a.category).filter(Boolean))].sort(), f.category);
  const { grouped, keys } = groupAndSort(filtered, (/** @type {any} */ r) => r.a.category, (/** @type {any} */ r) => r.a.name, false);

  const filterCount = /** @type {string[]} */ (['status', 'category']).filter(k => /** @type {Record<string, any>} */ (f)[k] !== 'all').length;
  const clear = () => {
    if (!f.search && !filterCount) return;
    patch({ search: '', status: 'all', category: 'all' });
  };

  return html`<${ListTabs} current="areas" />
    <${IndexControls} placeholder="Filter areas..." search=${f.search} onSearch=${(/** @type {string} */ v) => patch({ search: v })}
      count=${filtered.length} kind="" active=${filterCount > 0} onClear=${clear}
      filterChildren=${html`<${Fragment}>
        <${FilterSelect} id="filter-status" value=${f.status} label="Status" onChange=${(/** @type {string} */ v) => patch({ status: v })}>
          <option value="visited">Visited</option>
          <option value="want">Want to visit</option>
        <//>
        <${FilterSelect} id="filter-category" value=${f.category} label="Category" onChange=${(/** @type {string} */ v) => patch({ category: v })}>
          ${cats.map((/** @type {string} */ c) => html`<option key=${c} value=${c}>${displayCategory(c)}</option>`)}
        <//>
      <//>`} />
    <div class="category-grid" id="area-list">
      ${!rows.length && html`<div class="loading">No areas yet.</div>`}
      ${rows.length > 0 && keys.length === 0 && html`<div class="loading">No matches</div>`}
      ${keys.map(key => {
        const items = /** @type {Record<string, any[]>} */ (grouped)[key];
        const visited = items.filter(r => r.visited).length;
        return html`<div class="category-group fade-in" key=${key}>
          <div class="category-label">
            <${CategoryDot} category=${key} />
            <span>${displayCategory(key)}</span>
            <span class="place-count">${'(' + visited + '/' + items.length + ')'}</span>
          </div>
          <div class="place-grid">
            ${items.map(r => html`<${AreaCard} key=${r.a.id} a=${r.a} visited=${r.visited} note=${r.note} />`)}
          </div>
        </div>`;
      })}
    </div>`;
}
