import { state } from './core.js';
import { applyAuth } from './server.js';
import { isLocalMode } from './local-mode.js';
import { apiUrl } from './auth.js';

export const DEFAULT_CONFIG = {
  brand: 'Ferd',
  features: { places: true, routes: true },
  default_view: { center: [45, 10], zoom: 4 },
  default_view_routes: { center: [59.5, 6.5], zoom: 10 },
  category_labels: {},
  api_base: '/api',
};

export function placesAvailable() { return state.config.features.places !== false; }
export function routesAvailable() { return state.config.features.routes !== false; }
function getHiddenFeatures() {
  try {
    const raw = localStorage.getItem('hidden-features');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
export function setFeatureHidden(name, hidden) {
  const s = getHiddenFeatures();
  if (hidden) s.add(name); else s.delete(name);
  try { localStorage.setItem('hidden-features', JSON.stringify([...s])); } catch {}
}
export function placesEnabled() { return placesAvailable() && !getHiddenFeatures().has('places'); }
export function routesEnabled() { return routesAvailable() && !getHiddenFeatures().has('routes'); }

// Secondary surfaces toggled under Settings > Visible features. They reuse
// the same `hidden-features` set, but Logs defaults to hidden where the
// others default to shown. To express both with one set, a key listed in
// FEATURE_DEFAULT_HIDDEN reads inverted: present-in-set means SHOWN.
const FEATURE_DEFAULT_HIDDEN = new Set(['logs', 'countries']);
export function featureVisible(key) {
  const inSet = getHiddenFeatures().has(key);
  return FEATURE_DEFAULT_HIDDEN.has(key) ? inSet : !inSet;
}
export function setFeatureVisible(key, visible) {
  // setFeatureHidden's flag is "present in the set"; that's `visible` for a
  // default-hidden key and `!visible` for a default-shown one.
  setFeatureHidden(key, FEATURE_DEFAULT_HIDDEN.has(key) ? visible : !visible);
}
// History reads places+routes, Catalog imports places, Logs needs a place
// to log to (admin audit on a server, or local mode). Each surface is shown
// only when reachable AND not toggled off.
export function historyEnabled() { return (placesEnabled() || routesEnabled()) && featureVisible('history'); }
export function catalogEnabled() { return placesEnabled() && featureVisible('catalog'); }
export function logsAvailable() { return isLocalMode() || !!(state.auth && state.auth.is_admin); }
export function logsEnabled() { return logsAvailable() && featureVisible('logs'); }

export function getPref(key, def) {
  try { const v = localStorage.getItem(key); return v === null ? def : v; }
  catch { return def; }
}
// Every user-facing setting syncs per-user (server prefs.json), so a fresh
// browser or a new install inherits them after sign-in instead of starting
// at defaults. Per-device state (last-view, hidden-features) stays local.
const SYNCED_PREF_KEYS = new Set([
  'theme', 'mode', 'pin-style', 'marker-size', 'route-weight', 'tile-filter',
  'tile-layer', 'units', 'show-local-name',
  'cluster-places', 'tile-picker', 'map-filter', 'map-zoom', 'map-expand', 'remember-view',
  'places-group-by', 'trails-group-by', 'history-view',
  'places-view', 'routes-view',
  'default-hidden-categories', 'default-hidden-regions',
  'default-show-visited', 'default-show-want',
  'default-show-completed', 'default-show-planned',
]);
export function setPref(key, val) {
  try { localStorage.setItem(key, val); } catch {}
  if (SYNCED_PREF_KEYS.has(key) && state.auth && state.auth.authenticated) {
    state.serverPrefs[key] = val;
    fetch(apiUrl('/me/prefs'), applyAuth({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.serverPrefs),
    })).catch(() => {});
  }
}
export function loadSyncedPrefs() {
  if (isLocalMode()) return Promise.resolve();
  if (!state.auth || !state.auth.authenticated) return Promise.resolve();
  return fetch(apiUrl('/me/prefs'), applyAuth({}))
    .then(r => r.ok ? r.json() : null)
    .then(prefs => {
      if (!prefs || typeof prefs !== 'object') return;
      state.serverPrefs = Object.assign({}, prefs);
      for (const key of SYNCED_PREF_KEYS) {
        if (key in prefs) {
          try { localStorage.setItem(key, prefs[key]); } catch {}
        }
      }
      // Theme is applied at app render (loadDataAndRender), not here, so the
      // synced theme appears with the map rather than recoloring the
      // sign-in screen first.
    })
    .catch(() => {});
}
export function bindRadioPref(name, prefKey, onChange) {
  document.querySelectorAll('input[name="' + name + '"]').forEach(r => {
    r.addEventListener('change', function() {
      if (!this.checked) return;
      setPref(prefKey, this.value);
      if (onChange) onChange(this.value);
    });
  });
}
// Base map names, in the order the layer picker lists them. A saved name
// that is no longer here (Satellite, removed for Esri's terms, or CyclOSM,
// whose host's conditions an install must meet itself) falls back to the
// first, so the map and the Settings select agree.
export const BASE_LAYER_NAMES = ['OpenTopoMap', 'OpenStreetMap', 'Dark'];
export function getDefaultTileLayer() {
  const v = getPref('tile-layer', BASE_LAYER_NAMES[0]);
  return BASE_LAYER_NAMES.includes(v) ? v : BASE_LAYER_NAMES[0];
}
export function getShowTilePicker() { return getPref('tile-picker', 'true') !== 'false'; }
export function getShowFilterPanel() { return getPref('map-filter', 'true') !== 'false'; }
export function getShowZoomControls() { return getPref('map-zoom', 'true') !== 'false'; }
export function getShowExpandButton() { return getPref('map-expand', 'true') !== 'false'; }
export function applyControlVisibility() {
  document.body.classList.toggle('hide-map-filter', !getShowFilterPanel());
  document.body.classList.toggle('hide-map-zoom', !getShowZoomControls());
  document.body.classList.toggle('hide-map-expand', !getShowExpandButton());
}
export function getRememberView() { return getPref('remember-view', 'true') !== 'false'; }
// Per-category / per-region durable "hidden by default on the map" lists, and
// the four status defaults. Set in Manage categories/regions and Settings; the
// map filter panel overrides them per-session without changing the default.
export function getJsonListPref(key) {
  try { const a = JSON.parse(getPref(key, '[]')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
export function isDefaultHidden(key, id) { return getJsonListPref(key).includes(id); }
export function setDefaultHidden(key, id, hidden) {
  const set = new Set(getJsonListPref(key));
  if (hidden) set.add(id); else set.delete(id);
  setPref(key, JSON.stringify([...set]));
}
export function getDefaultShow(status) { return getPref('default-show-' + status, 'true') !== 'false'; }
// Inline eye icon; open when shown, slashed when hidden-by-default.
export function eyeIconHtml(hidden) {
  const svg = hidden
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  // Wrap in a span so the SVG isn't a direct flex child of the btn-x button
  // (a direct SVG flex item collapses to 0 width here).
  return '<span class="eye-wrap">' + svg + '</span>';
}
export function getUnits() { return getPref('units', 'metric'); }
export function getClusterPlaces() { return getPref('cluster-places', 'true') !== 'false'; }
// Optional form fields — let the user hide ones they never use. All default ON.
export function getShowField(name) { return getPref('show-' + name, 'true') !== 'false'; }
export function isImperial() { return getUnits() === 'imperial'; }
export function loadStoredView() {
  try {
    const raw = localStorage.getItem('last-view');
    if (!raw) return null;
    const v = JSON.parse(raw);
    return (v && Array.isArray(v.center) && typeof v.zoom === 'number') ? v : null;
  } catch { return null; }
}
export function saveStoredView(view) {
  try { localStorage.setItem('last-view', JSON.stringify(view)); } catch {}
}

export function refreshTabVisibility() {
  const tabPlaces = document.getElementById('tab-places');
  const tabTrails = document.getElementById('tab-routes');
  // The count moved to the list-page search box (see setResultCount); tabs
  // are just the plain labels now.
  if (tabPlaces) { tabPlaces.style.display = placesEnabled() ? '' : 'none'; tabPlaces.textContent = 'Places'; }
  if (tabTrails) { tabTrails.style.display = routesEnabled() ? '' : 'none'; tabTrails.textContent = 'Routes'; }
  const tabHistory = document.getElementById('tab-history');
  if (tabHistory) tabHistory.style.display = historyEnabled() ? '' : 'none';
}

// Set the live count pinned inside a list page's search box.
export function setResultCount(n) {
  const el = document.getElementById('result-count');
  if (el) el.textContent = n;
}

// Skip tile loads during zoom animations. Default true is wasteful:
// each zoom level transition requests its own batch of tiles while
// the gesture is still in flight, competing with the animation.
if (window.L && L.TileLayer && L.TileLayer.mergeOptions) {
  // NoGap (dumpToCanvas) fixes Android tile seams, which the 2D transform
  // below does not on a real device, but causes a small visible reshuffle
  // at zoomend on desktop. So touch gets the canvas and desktop the transform.
  const _isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  L.TileLayer.mergeOptions({
    // On touch, load tiles during the pinch so the new level is painted
    // before the integer-snap at release (otherwise the snap reloads tiles
    // and briefly flashes seams). Desktop smooth-wheel keeps it off to avoid
    // requesting a batch per fractional level mid-gesture.
    updateWhenZooming: _isTouch,
    dumpToCanvas: _isTouch,
  });

  // Leaflet 1.9 places each tile with translate3d, which gives it its own
  // compositor layer. Those layers' antialiased edges show as light lines
  // between tiles at fractional pixel ratios and zooms. With a 2D transform
  // a level's tiles paint into one layer, which is Leaflet 2's fix.
  if (!_isTouch) {
    const addTile = L.GridLayer.prototype._addTile;
    L.GridLayer.include({
      _addTile(coords, container) {
        addTile.call(this, coords, container);
        const tile = this._tiles[this._tileCoordsToKey(coords)].el;
        const pos = L.DomUtil.getPosition(tile);
        tile.style.transform = `translate(${pos.x}px,${pos.y}px)`;
      },
    });
  } else {
    // NoGap copies a tile to the canvas only after its fade, and until then
    // the tiles show the same lines as plain Leaflet. Copying on load skips that.
    const tileReady = L.TileLayer.prototype._tileReady;
    const onOpaqueTile = L.TileLayer.prototype._onOpaqueTile;
    L.TileLayer.include({
      _tileReady(coords, err, el) {
        tileReady.call(this, coords, err, el);
        const tile = this._map && this._tiles[this._tileCoordsToKey(coords)];
        if (tile && !err) this._onOpaqueTile(tile);
      },
      _onOpaqueTile(tile) {
        if (tile.dumped) return;
        tile.dumped = true;
        onOpaqueTile.call(this, tile);
      },
    });
  }
}
