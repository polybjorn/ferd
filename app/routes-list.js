import { addButtonHtml, displayRegion, escapeHtml, setActiveTab, setCrumb, state } from './core.js';
import { gpxUrlFor, isReadOnly } from './server.js';
import { collectTags, tagsIncludeAll } from './tags.js';
import { cleanupMap, deleteRouteItem, fetchGpxText, wireFilterPopover } from './map/index.js';
import { setPref, setResultCount } from './prefs.js';
import { findRouteByKey, openEditTrailMetadataModal } from './routes/route-meta.js';
import { groupAndSort, letterBucket } from './places-list.js';
import {
  drawRouteSilhouette, listView, listViewPopoverHtml, wireListViewPopover,
} from './history.js';
import { attachContextMenu } from './context-menu.js';
import { enhanceSelectsIn } from './select.js';
import { openAddModal } from './add/add.js';

export function renderTrailsIndex() {
  setActiveTab('routes');
  setCrumb('Routes');
  cleanupMap();
  const app = document.getElementById('app');
  if (!state.manifest) { app.innerHTML = '<div class="loading">Loading routes...</div>'; return; }

  const regions = state.manifest.regions;
  const allRoutes = regions.flatMap(r => r.routes);
  const total = allRoutes.length;
  const completed = allRoutes.filter(r => r.completed).length;

  const canAddTrail = state.auth.authenticated && !isReadOnly();
  const difficulties = ['easy', 'moderate', 'hard', 'expert'];
  const regionNames = regions.map(r => r.name).slice().sort((a, b) => {
    if (a === '') return 1;
    if (b === '') return -1;
    return a.localeCompare(b);
  });
  const allTags = collectTags(regions.flatMap(r => r.routes));
  let html = '<div class="index-controls">' +
    '<div class="search-wrap"><input type="text" id="search-input" placeholder="Filter routes..." value="' + escapeHtml(state.trailFilters.search) + '"><span class="result-count" id="result-count"></span></div>' +
    '<div class="filter-dropdown">' +
      '<button type="button" class="filter-btn" id="filter-btn" aria-haspopup="true" aria-expanded="false">Filters</button>' +
      '<div class="filter-popover" id="filter-popover" hidden>' +
        '<select id="filter-status">' +
          '<option value="all">Status</option>' +
          '<option value="completed"' + (state.trailFilters.status === 'completed' ? ' selected' : '') + '>Completed</option>' +
          '<option value="planned"' + (state.trailFilters.status === 'planned' ? ' selected' : '') + '>Planned</option>' +
        '</select>' +
        '<select id="filter-region">' +
          '<option value="all">Region</option>' +
          regionNames.map(n => { const v = n.toLowerCase(); return '<option value="' + escapeHtml(v) + '"' + (state.trailFilters.region === v ? ' selected' : '') + '>' + escapeHtml(displayRegion(n)) + '</option>'; }).join('') +
        '</select>' +
        '<select id="filter-difficulty">' +
          '<option value="all">Difficulty</option>' +
          difficulties.map(d => '<option value="' + d + '"' + (state.trailFilters.difficulty === d ? ' selected' : '') + '>' + d[0].toUpperCase() + d.slice(1) + '</option>').join('') +
        '</select>' +
        '<select id="filter-rating">' +
          '<option value="all">Rating</option>' +
          ['unrated','1','2','3','4','5'].map(v => '<option value="' + v + '"' + (state.trailFilters.rating === v ? ' selected' : '') + '>' + (v === 'unrated' ? 'Unrated' : (v + ' star' + (v === '1' ? '' : 's'))) + '</option>').join('') +
        '</select>' +
        (allTags.length ?
          '<button type="button" class="filter-ms-btn" id="filter-tag-ms-btn" aria-haspopup="listbox" aria-expanded="false">Tags</button>'
          : '') +
        '<div class="filter-divider"></div>' +
        '<select id="filter-group-by">' +
          '<option value="region"' + (state.trailsGroupBy === 'region' ? ' selected' : '') + '>Group by region</option>' +
          '<option value="letter"' + (state.trailsGroupBy === 'letter' ? ' selected' : '') + '>Group by first letter</option>' +
        '</select>' +
        '<button type="button" class="filter-clear" id="filter-clear">Clear filters</button>' +
      '</div>' +
    '</div>' +
    listViewPopoverHtml('routes') +
    '</div>';
  html += '<div class="region-grid" id="trails-list-mount"></div>';
  app.innerHTML = html;
  enhanceSelectsIn(document.querySelector('.index-controls'));
  const navActionsEl = document.getElementById('nav-actions');
  if (navActionsEl && canAddTrail) {
    navActionsEl.innerHTML = addButtonHtml('add-route-btn', 'Add route');
  }
  const addTrailBtn = document.getElementById('add-route-btn');
  if (addTrailBtn) addTrailBtn.addEventListener('click', function() { openAddModal(null, 'route'); });
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
  const statusSel = /** @type {HTMLSelectElement} */ (document.getElementById('filter-status'));
  const regionSel = /** @type {HTMLSelectElement} */ (document.getElementById('filter-region'));
  const diffSel = /** @type {HTMLSelectElement} */ (document.getElementById('filter-difficulty'));
  const ratingSel = /** @type {HTMLSelectElement} */ (document.getElementById('filter-rating'));
  const groupBySel = /** @type {HTMLSelectElement} */ (document.getElementById('filter-group-by'));
  const filterBtn = document.getElementById('filter-btn');
  const filterPop = document.getElementById('filter-popover');
  const filterClear = document.getElementById('filter-clear');
  const mountEl = document.getElementById('trails-list-mount');
  const filterSels = [statusSel, regionSel, diffSel, ratingSel].filter(Boolean);
  // Re-read the manifest on every render: the store replaces it, so a
  // list flattened once at mount keeps showing deleted routes.
  function flattenRoutes() {
    return state.manifest.regions.flatMap(r => r.routes.map(rt => ({route: rt, region: r.name})));
  }
  function routeMatches(entry, q, wantStatus, wantRegion, wantDiff, wantRating, wantTags) {
    const route = entry.route;
    if (q) {
      const inName = route.name.toLowerCase().includes(q);
      const inRegion = entry.region.toLowerCase().includes(q);
      if (!inName && !inRegion) return false;
    }
    if (wantStatus === 'completed' && !route.completed) return false;
    if (wantStatus === 'planned' && route.completed) return false;
    if (wantRegion !== 'all' && entry.region.toLowerCase() !== wantRegion) return false;
    if (wantDiff !== 'all' && route.difficulty !== wantDiff) return false;
    if (wantRating === 'unrated' && route.rating) return false;
    if (wantRating !== 'all' && wantRating !== 'unrated' && String(route.rating || '') !== wantRating) return false;
    if (!tagsIncludeAll(route.tags, wantTags)) return false;
    return true;
  }
  function renderTrailsList() {
    const view = listView('routes');
    const q = (searchInput && searchInput.value.trim().toLowerCase()) || '';
    const wantStatus = statusSel ? statusSel.value : 'all';
    const wantRegion = regionSel ? regionSel.value : 'all';
    const wantDiff = diffSel ? diffSel.value : 'all';
    const wantRating = ratingSel ? ratingSel.value : 'all';
    const wantTags = state.trailFilters.tags || [];
    const filtered = flattenRoutes().filter(e => routeMatches(e, q, wantStatus, wantRegion, wantDiff, wantRating, wantTags));
    setResultCount(filtered.length);
    const byLetter = state.trailsGroupBy === 'letter';
    const { grouped, keys } = groupAndSort(
      filtered,
      e => byLetter ? letterBucket(e.route.name) : e.region,
      e => e.route.name || e.route.key || '',
      byLetter,
      (a, b) => {
        if (a === '') return 1;
        if (b === '') return -1;
        return a.localeCompare(b);
      }
    );
    let inner = '';
    for (const key of keys) {
      const items = grouped[key];
      const keyCompleted = items.filter(e => e.route.completed).length;
      inner += '<div class="region-group fade-in">';
      inner += '<div class="region-label">';
      if (byLetter) {
        inner += '<span>' + escapeHtml(key) + '</span>';
      } else {
        inner += '<span class="section-link" data-filter-region="' + escapeHtml(key) + '" title="Show only this region on the map">' + escapeHtml(displayRegion(key)) + '</span>';
      }
      inner += '<span class="route-count">(' + keyCompleted + '/' + items.length + ')</span>';
      inner += '</div>';
      inner += '<div class="route-grid">';
      for (const entry of items) {
        const route = entry.route;
        const href = '#/routes/route/' + encodeURIComponent(route.key);
        const statusClass = route.completed ? 'completed' : 'planned';
        const rowInner = '<span class="status-dot ' + statusClass + '"></span>' +
          '<span class="name">' + escapeHtml(route.name) + '</span>';
        inner += '<div class="route-card" data-route-key="' + escapeHtml(route.key) + '" onclick="location.hash=\'' + href.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\'">';
        if (view !== 'grid') {
          inner += '<canvas class="card-media route-thumb" data-route-key="' + escapeHtml(route.key) + '"></canvas>';
          inner += '<div class="card-body">' + rowInner + '</div>';
        } else {
          inner += rowInner;
        }
        inner += '</div>';
      }
      inner += '</div></div>';
    }
    mountEl.className = 'region-grid' + (view !== 'grid' ? ' view-' + view : '');
    mountEl.innerHTML = inner;
    if (view !== 'grid') {
      mountEl.querySelectorAll('canvas.route-thumb').forEach(function(canvas) {
        const found = findRouteByKey(/** @type {HTMLElement} */ (canvas).dataset.routeKey);
        if (found) drawRouteSilhouette(canvas, found.route);
      });
    }
    mountEl.querySelectorAll('.route-card').forEach(function(card) {
      attachContextMenu(card, function() {
        const key = /** @type {HTMLElement} */ (card).dataset.routeKey;
        const found = findRouteByKey(key);
        if (!found) return [];
        const route = found.route;
        const regionName = found.region.name;
        const items = [];
        items.push({ label: 'Open on map', onClick: function() { location.hash = '#/?focus=route:' + encodeURIComponent(route.key); } });
        items.push({ label: 'Open detail', onClick: function() { location.hash = '#/routes/route/' + encodeURIComponent(route.key); } });
        if (route.source) {
          items.push({ label: 'Open source', onClick: function() { window.open(route.source, '_blank', 'noopener'); } });
        }
        if (!isReadOnly() && state.auth && state.auth.authenticated) {
          items.push({ label: 'Edit', onClick: function() { openEditTrailMetadataModal(route, regionName); } });
        }
        if (!isReadOnly() && state.auth && state.auth.authenticated) {
          items.push(null);
          items.push({ label: 'Delete', danger: true, onClick: function() {
            deleteRouteItem(route, regionName, renderTrailsList);
          }});
        }
        return items;
      });
    });
    mountEl.querySelectorAll('.section-link[data-filter-region]').forEach(function(label) {
      label.addEventListener('click', function() {
        const r = /** @type {HTMLElement} */ (label).dataset.filterRegion;
        const allRegions = regions.map(x => x.name);
        state.hiddenRegions = new Set(allRegions.filter(x => x !== r));
        // Strong intent: "show only this region". Hide all places too;
        // user can re-enable from the filter panel.
        const allCats = Object.keys(state.categoryColors);
        state.hiddenCategories = new Set(allCats);
        state.showCompleted = true;
        state.showPlanned = true;
        location.hash = '#/';
      });
    });
  }
  const trailFilterKeyById = { 'filter-status': 'status', 'filter-region': 'region', 'filter-difficulty': 'difficulty', 'filter-rating': 'rating' };
  if (groupBySel) groupBySel.addEventListener('change', function() {
    state.trailsGroupBy = this.value;
    setPref('trails-group-by', this.value);
    renderTrailsList();
  });
  wireFilterPopover({
    btn: filterBtn, pop: filterPop, clear: filterClear, sels: filterSels,
    keyById: trailFilterKeyById, filters: state.trailFilters,
    searchInput: searchInput, searchKey: 'search', onApply: renderTrailsList,
    tagOptions: allTags, tagsKey: 'tags',
    tagMsBtn: document.getElementById('filter-tag-ms-btn'),
  });
  renderTrailsList();
  wireListViewPopover('routes', renderTrailsList);

  // Warm the SW cache so clicking a route from the list gets an
  // already-cached GPX response and renders the polyline immediately.
  // Fire immediately (not on idle) since the most common interaction
  // is a fast click within a few hundred ms of the list rendering;
  // the 4-at-a-time limiter in fetchGpxText keeps the burst polite.
  for (const route of allRoutes) {
    fetchGpxText(gpxUrlFor(route.file)).catch(function () { /* ignore */ });
  }
}
