import { detectViewer, isReadOnly } from './server.js';
import { dataLayer, syncSettled } from './store.js';
import { DEFAULT_CONFIG, isImperial } from './prefs.js';

// Tableau 20 categorical palette, reordered: indices 0-9 are the saturated
// hues in hue-spread order (blue, orange, green, red, teal, purple, gold,
// pink, brown, gray) so the first N categories get maximally different
// colors. Indices 10-19 are the paler siblings of the same hues in the
// same order, used as fallback once 10+ categories accumulate.
// COLORS_LIGHT are HSL-darkened to L=30% for legibility on light surfaces;
// saturation preserved so gray stays gray.
export const COLORS       = ['#3e78b7', '#ff8e1f', '#4eaf41', '#f93f42', '#3ba6a0', '#b971a5', '#cea715', '#e46190', '#a87355', '#7b6f6c', '#93cdf5', '#ffbe7d', '#83e06e', '#ff9d9a', '#7dc5bd', '#dc9ecc', '#ffd555', '#ffbad0', '#e0b29d', '#bdafa8'];
const COLORS_LIGHT = ['#274c72', '#994c00', '#327029', '#950407', '#29706e', '#673258', '#8b700e', '#83163d', '#654534', '#514948', '#0e598b', '#994c00', '#2d7e1b', '#990500', '#2f6a64', '#70295d', '#997400', '#990031', '#743d25', '#574942'];
if (COLORS.length !== COLORS_LIGHT.length) console.warn('COLORS and COLORS_LIGHT length mismatch');
export const TRACK_COLORS = COLORS;
export const ROUTE_COLOR = '#6aaeee';
export const GPX_NS = 'http://www.topografix.com/GPX/1/1';
export const DATA_FILES = { siteConfig: 'site-config.json' };

/**
 * The `/api/state` response (docs/api.md), and the stand-in local mode sets.
 * @typedef {object} AuthState
 * @property {boolean} authenticated
 * @property {string | null} username
 * @property {boolean} is_admin
 * @property {boolean} [published]
 * @property {boolean} [registration_open]
 * @property {boolean} [publishing_open]
 * @property {boolean} [catalog_baseline_open]
 * @property {boolean} [has_users]
 * @property {boolean} [requires_setup_token]
 * @property {string} [version]
 * @property {boolean} [local] set by local mode, never by the server
 */

/**
 * A place from `/api/places` (docs/api.md, Common shapes).
 * @typedef {object} Place
 * @property {string} [id] assigned by the server, absent on a place not yet saved
 * @property {string} name
 * @property {number} lat
 * @property {number} lon
 * @property {string} [category]
 * @property {string} [country]
 * @property {string} [country_code] set by the server from `country`
 * @property {boolean} [visited]
 * @property {string} [note]
 * @property {string[]} [sources]
 * @property {string} [image]
 * @property {string} [image_focus]
 * @property {string} [local_name]
 * @property {string[]} [tags]
 * @property {string} [date_visited] YYYY-MM-DD
 * @property {number} [rating] 1-5
 * @property {string} [from_catalog]
 * @property {Object<string, any>} [catalog_skip]
 * @property {string} [_slug] set by assignPlaceSlugs, never by the server
 */

/**
 * An area from `/api/areas` (docs/api.md, Common shapes).
 * @typedef {object} Area
 * @property {string} [id]
 * @property {string} name
 * @property {{ type: 'Polygon' | 'MultiPolygon', coordinates: any[] }} geometry
 * @property {string} [category]
 * @property {boolean} [visited]
 * @property {string} [note]
 * @property {string} [local_name]
 * @property {string} [source] 'osm' for an OpenStreetMap boundary
 */

/**
 * One route in the `/api/routes` manifest, as scripts/gpx-manifest.sh writes
 * it, with the metadata.json fields merged in.
 * @typedef {object} ManifestRoute
 * @property {string} key `Region/Route`, or `Route` with no region
 * @property {string} file the walked GPX, or the planned one when not completed
 * @property {string} name
 * @property {boolean} hasElevation
 * @property {boolean} completed
 * @property {number[]} [bbox] [minLat, minLon, maxLat, maxLon]
 * @property {string} [plannedFile]
 * @property {number} [trackCount] only when the GPX holds more than one track
 * @property {string[]} [trackNames] beside trackCount
 * @property {string} [source]
 * @property {string} [date_completed] YYYY-MM-DD
 * @property {number} [rating] 1-5
 * @property {string} [notes]
 * @property {string[]} [tags]
 * @property {'easy' | 'moderate' | 'hard' | 'expert'} [difficulty]
 * @property {string} [local_name]
 * @property {string} [_slug] set by assignTrailSlugs, never by the server
 */

/**
 * @typedef {object} ManifestRegion
 * @property {string} name empty for routes with no region
 * @property {ManifestRoute[]} routes
 * @property {string} [_slug] set by assignTrailSlugs
 */

/**
 * The `/api/routes` response.
 * @typedef {object} Manifest
 * @property {ManifestRegion[]} regions
 */

export const state = {
  config: DEFAULT_CONFIG,
  /** @type {AuthState} */
  auth: { authenticated: false, username: null, is_admin: false, published: false, registration_open: true, publishing_open: true, catalog_baseline_open: true, has_users: false, requires_setup_token: false },
  viewer: detectViewer(),
  currentMap: null,
  currentElevation: null,
  // Each overlay requests tiles from a third party, so none is on at load.
  // One the user turns on keeps its level across map rebuilds for this page
  // load. Keyed by overlay name, with no entry meaning off.
  overlayLevels: new Map(),
  // data
  /** @type {Place[] | null} */
  places: null,
  /** @type {Area[] | null} */
  areas: null,
  /** @type {Manifest | null} */
  manifest: null,
  categoryColors: {},
  categoryColorsLight: {},
  // browse-list state
  groupBy: (function(){ try { return localStorage.getItem('places-group-by') || 'category'; } catch { return 'category'; } })(),
  trailsGroupBy: (function(){ try { return localStorage.getItem('trails-group-by') || 'region'; } catch { return 'region'; } })(),
  // Filter values are kept in memory only — they survive in-page re-renders
  // (catalog refresh, CRUD writes) but reset on a full page reload.
  placeFilters: { search: '', status: 'all', category: 'all', country: 'all', tags: [], catalog: 'all' },
  trailFilters: { search: '', status: 'all', region: 'all', difficulty: 'all', rating: 'all', tags: [] },
  historyFilters: { search: '', kind: 'all', year: 'all', rating: 'all' },
  areaFilters: { search: '', status: 'all', category: 'all' },
  // unified-map filter state
  hiddenCategories: new Set(),
  hiddenRegions: new Set(),
  showVisited: true,
  showWant: true,
  showCompleted: true,
  showPlanned: true,
  showPlaces: true,
  showTrails: true,
  // unified-map layer refs
  _placeRecords: null,
  _placeClusterGroup: null,
  _routeLayers: null,        // [{ route, layer, completed }]
  _selectedRouteKey: null,   // index-map: highlighted route (click-to-distinguish overlaps)
  _routeGroupCompleted: null,
  _routeGroupPlanned: null,
  _syncRoutesOnMap: /** @type {(() => void) | null} */ (null), // index-map: applies the routes signal (home-map.js)
  // Mirrors the catalogCache signal (store.js bindCatalogCache), null until fetched.
  _catalogCache: /** @type {import('./places-list.js').CatalogEntry[] | null} */ (null),
  _areaGroup: /** @type {any} */ (null),
  _areaLayers: /** @type {any[] | null} */ (null), // [{ area, visited, layer }]
  // Set by the map modules: Leaflet renderers and the route highlight and GL hooks.
  _areaRenderer: /** @type {any} */ (null),
  _routeRenderer: /** @type {any} */ (null),
  _countryRenderer: /** @type {any} */ (null),
  _detailRenderer: /** @type {any} */ (null),
  _detailPolylines: /** @type {any[] | null} */ (null),
  // Set by route-detail.js for the open route's map.
  _currentMapResizeObserver: /** @type {ResizeObserver | null} */ (null),
  _lastTrailBounds: /** @type {any} */ (null),
  // Highlight animation: undefined _hlFrom/_hlTo mean "follow the selection".
  _hlFrom: /** @type {string | null | undefined} */ (undefined),
  _hlTo: /** @type {string | null | undefined} */ (undefined),
  _hlT: /** @type {number | undefined} */ (undefined),
  _glRoutesDirty: /** @type {(() => void) | null} */ (null),
  _glRoutesRebuild: /** @type {(() => void) | null} */ (null),
  _glRoutesDraw: /** @type {(() => void) | null} */ (null),
};

export function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function categoryFallbackLabel(slug) {
  return slug.replace(/-/g, ' ').replace(/^./, function(c) { return c.toUpperCase(); });
}

export function displayCategory(cat) {
  if (!cat) return 'Uncategorized';
  const labels = (state.config && state.config.category_labels) || {};
  const entry = labels[cat];
  if (entry && entry.label) return entry.label;
  return categoryFallbackLabel(cat);
}

export function displayRegion(name) {
  return name || 'No region';
}

export function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function slugify(s) {
  if (!s) return '';
  const cleaned = s
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || encodeURIComponent(s.toLowerCase());
}

export function assignPlaceSlugs(places) {
  if (!places) return;
  const used = new Set();
  for (const p of places) {
    const base = slugify(p.name);
    let slug = base;
    let n = 2;
    while (used.has(slug)) { slug = base + '-' + n; n++; }
    used.add(slug);
    p._slug = slug;
  }
}

export function assignTrailSlugs(manifest) {
  if (!manifest || !manifest.regions) return;
  const used = new Set();
  for (const region of manifest.regions) {
    region._slug = slugify(region.name);
    for (const route of region.routes) {
      const base = region._slug + '/' + slugify(route.name);
      let slug = base;
      let n = 2;
      while (used.has(slug)) { slug = base + '-' + n; n++; }
      used.add(slug);
      route._slug = slug;
    }
  }
}

function renderSources(sources) {
  if (!sources || sources.length === 0) return '';
  return sources.map(s => {
    let url;
    try { url = new URL(s, location.href); } catch { return escapeHtml(s); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return escapeHtml(s);
    return '<a href="' + escapeHtml(url.href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(domainFromUrl(s)) + '</a>';
  }).join(' &middot; ');
}

// Sort category slugs alphabetically, but always push uncategorized ('') last
// so legends/filters don't lead with the fallback bucket.
export function sortedCategorySlugs(slugs) {
  return [...slugs].sort((a, b) => {
    if (a === '') return 1;
    if (b === '') return -1;
    return a.localeCompare(b);
  });
}

export function assignCategoryColors(places) {
  // Colors are stable per slug: stored alongside the label in
  // category-labels.json. Unstored slugs get the next free index
  // (highest stored + 1, mod palette length) so adding a new category
  // never reshuffles the existing ones.
  const cats = [...new Set(places.concat(state.areas || []).map(p => p.category))]
    .filter(c => c !== '').sort();
  const labels = (state.config && state.config.category_labels) || {};
  let nextIdx = 0;
  for (const slug in labels) {
    const c = labels[slug] && labels[slug].color;
    if (typeof c === 'number' && c + 1 > nextIdx) nextIdx = c + 1;
  }
  const dark = {}, light = {};
  const newAssignments = {};
  for (const c of cats) {
    const entry = labels[c];
    let idx;
    if (entry && typeof entry.color === 'number') {
      idx = entry.color;
    } else {
      idx = nextIdx % COLORS.length;
      nextIdx += 1;
      newAssignments[c] = idx;
    }
    dark[c] = COLORS[idx];
    light[c] = COLORS_LIGHT[idx];
  }
  const mutedDark = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
  dark[''] = mutedDark;
  light[''] = mutedDark;
  if (Object.keys(newAssignments).length) persistAssignedCategoryColors(newAssignments);
  return { dark, light };
}

function persistAssignedCategoryColors(newAssignments) {
  if (isReadOnly()) return;
  if (!state.auth || !state.auth.authenticated) return;
  // Until a sync has brought the whole set, the owner's labels may still be
  // on their way; select.js recolours again once it has.
  if (!syncSettled.peek()) return;
  const labels = state.config.category_labels = state.config.category_labels || {};
  const payload = {};
  for (const slug in labels) {
    const lbl = (labels[slug] && labels[slug].label) || categoryFallbackLabel(slug);
    payload[slug] = { label: lbl };
    if (typeof labels[slug].color === 'number') payload[slug].color = labels[slug].color;
    if (typeof labels[slug].order === 'number') payload[slug].order = labels[slug].order;
  }
  for (const slug in newAssignments) {
    const existing = labels[slug] || {};
    const existingLabel = existing.label || categoryFallbackLabel(slug);
    const merged = { label: existingLabel, color: newAssignments[slug] };
    if (typeof existing.order === 'number') merged.order = existing.order;
    labels[slug] = merged;
    payload[slug] = { ...merged };
  }
  dataLayer.putCategoryLabels({ category_labels: payload }).catch(function() {
    // Best-effort: if the write fails, the same indices will be re-assigned
    // (deterministically) the next time assignCategoryColors runs.
  });
}

// Thousand-separated number formatting (en-US grouping: 7,340.9 / 101,424).
export function grpNum(n, decimals) {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals || 0, maximumFractionDigits: decimals || 0 });
}
export function formatDistance(m) {
  if (isImperial()) {
    const mi = m / 1609.344;
    return mi >= 0.1 ? grpNum(mi, 1) + ' mi' : grpNum(Math.round(m * 3.28084)) + ' ft';
  }
  return m >= 1000 ? grpNum(m / 1000, 1) + ' km' : grpNum(Math.round(m)) + ' m';
}
export function formatElevation(m) {
  if (isImperial()) return grpNum(Math.round(m * 3.28084)) + ' ft';
  return grpNum(Math.round(m)) + ' m';
}

// screen names a page below a view, such as one route under Routes. The
// phone keeps a header bar only there, where the page has no title of its own.
export function setActiveTab(view, screen) {
  document.body.dataset.view = screen || view;
  ['places', 'routes', 'history'].forEach(v => {
    const el = document.getElementById('tab-' + v);
    if (!el) return;
    if (v === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  const item = BAR_ITEM[view];
  ['map', 'lists', 'you'].forEach(v => {
    const el = document.getElementById('bar-' + v);
    if (!el) return;
    if (v === item) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}
// The phone bar has one Lists item for the three lists, and History is the
// You page's content.
const BAR_ITEM = /** @type {Record<string, string>} */ ({
  map: 'map', places: 'lists', routes: 'lists', areas: 'lists', history: 'you', you: 'you',
});

// A wide screen's Add, in the nav. A phone adds from the bar instead.
export function addButtonHtml(id, title) {
  return '<button type="button" id="' + id + '" class="nav-action-btn nav-action-add"' +
    (title ? ' title="' + escapeHtml(title) + '"' : '') + '>Add</button>';
}

let _crumbText = '';
let _crumbAlways = false;
export function setCrumb(text, alwaysShow) {
  _crumbText = text || '';
  _crumbAlways = !!alwaysShow;
  const crumbEl = document.getElementById('nav-crumb');
  const brandEl = document.querySelector('.nav-brand');
  if (!crumbEl) return;
  // List pages (Places/Routes/History) show the crumb only on mobile, where
  // the nav tabs are hidden; route detail (no tab) shows it everywhere.
  crumbEl.classList.toggle('crumb-mobile-only', !_crumbAlways);
  if (!_crumbText) { crumbEl.textContent = ''; return; }
  crumbEl.textContent = ' / ' + _crumbText;
  if (!brandEl || !brandEl.getClientRects().length) return;
  // Truncate the crumb char-by-char until the brand stops colliding with the
  // nav's center tabs (desktop) or, when those are hidden, the right-side
  // controls (mobile). Cheaper than it looks: stops as soon as it fits.
  const tabsEl = document.querySelector('.nav-tabs');
  const rightEl = document.querySelector('.nav-right');
  const boundary = (tabsEl && tabsEl.getBoundingClientRect().width > 0) ? tabsEl : rightEl;
  if (!boundary) return;
  const gap = 8; // breathing room before the boundary
  let len = _crumbText.length;
  while (len > 0 && brandEl.getBoundingClientRect().right > boundary.getBoundingClientRect().left - gap) {
    len--;
    crumbEl.textContent = ' / ' + _crumbText.slice(0, len).trimEnd() + '…';
  }
}
window.addEventListener('resize', function() {
  if (_crumbText) setCrumb(_crumbText, _crumbAlways);
});

export function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
export function manifestRoutes() {
  return ((state.manifest && state.manifest.regions) || []).flatMap(region => region.routes);
}
