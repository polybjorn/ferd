import { state } from './core.js';
import { hasServer, isReadOnly } from './server.js';
import { dataLayer, prefs } from './store.js';

export const DEFAULT_CONFIG = {
  brand: 'Ferd',
  features: { places: true, routes: true },
  default_view: { center: [45, 10], zoom: 4 },
  default_view_routes: { center: [59.5, 6.5], zoom: 10 },
  category_labels: /** @type {import('./core.js').CategoryLabels} */ ({}),
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
/**
 * @param {string} name
 * @param {boolean} hidden
 */
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
/** @param {string} key */
export function featureVisible(key) {
  const inSet = getHiddenFeatures().has(key);
  return FEATURE_DEFAULT_HIDDEN.has(key) ? inSet : !inSet;
}
/**
 * @param {string} key
 * @param {boolean} visible
 */
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
export function logsAvailable() { return !hasServer() || !!(state.auth && state.auth.is_admin); }
export function logsEnabled() { return logsAvailable() && featureVisible('logs'); }

/**
 * @param {string} key
 * @param {string} def
 */
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
  'cluster-places', 'tile-picker', 'map-filter', 'map-zoom', 'map-zoom-touch', 'map-expand', 'remember-view',
  'places-group-by', 'trails-group-by', 'history-view',
  'places-view', 'routes-view',
  'default-hidden-categories', 'default-hidden-regions',
  'default-show-visited', 'default-show-want',
  'default-show-completed', 'default-show-planned',
]);
/**
 * @param {string} key
 * @param {string} val
 */
export function setPref(key, val) {
  try { localStorage.setItem(key, val); } catch {}
  if (SYNCED_PREF_KEYS.has(key) && hasServer() && !isReadOnly() && state.auth && state.auth.authenticated) {
    dataLayer.putPref(key, val).catch(() => {});
  }
}
// Copy the account's synced preferences from the store into localStorage,
// where the readers look. Theme is applied at app render
// (loadDataAndRender), not here, so the synced theme appears with the map
// rather than recoloring the sign-in screen first.
export function loadSyncedPrefs() {
  if (!hasServer() || isReadOnly()) return;
  const p = prefs.value;
  for (const key of SYNCED_PREF_KEYS) {
    if (key in p) {
      try { localStorage.setItem(key, p[key]); } catch {}
    }
  }
}
/**
 * @param {string} name
 * @param {string} prefKey
 * @param {(value: string) => void} [onChange]
 */
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
// A touch screen zooms with a pinch, so there the buttons are a choice of
// their own that starts off, and turning them on for the phone leaves the
// desktop as it was. They stay one switch away because double-tap only zooms
// in: the buttons are the one-finger way out (WCAG 2.5.1).
const coarsePointer = matchMedia('(pointer: coarse)');
export function zoomControlsKey() { return coarsePointer.matches ? 'map-zoom-touch' : 'map-zoom'; }
export function getShowZoomControls() { return getPref(zoomControlsKey(), coarsePointer.matches ? 'false' : 'true') !== 'false'; }
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
/** @param {string} key */
export function getJsonListPref(key) {
  try { const a = JSON.parse(getPref(key, '[]')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
/**
 * @param {string} key
 * @param {unknown} id
 */
export function isDefaultHidden(key, id) { return getJsonListPref(key).includes(id); }
/**
 * @param {string} key
 * @param {unknown} id
 * @param {boolean} hidden
 */
export function setDefaultHidden(key, id, hidden) {
  const set = new Set(getJsonListPref(key));
  if (hidden) set.add(id); else set.delete(id);
  setPref(key, JSON.stringify([...set]));
}
/** @param {string} status */
export function getDefaultShow(status) { return getPref('default-show-' + status, 'true') !== 'false'; }
export function getUnits() { return getPref('units', 'metric'); }
export function getClusterPlaces() { return getPref('cluster-places', 'true') !== 'false'; }
// Optional form fields — let the user hide ones they never use. All default ON.
/** @param {string} name */
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
/** @param {unknown} view */
export function saveStoredView(view) {
  try { localStorage.setItem('last-view', JSON.stringify(view)); } catch {}
}
// Picks from Search, newest first, each the result row's data-* fields.
// Kept on the device rather than synced, and cleared on sign out, because
// a shared browser would otherwise show one user's picks to the next.
const RECENT_PICKS_KEY = 'search-recent';
const RECENT_PICKS_MAX = 5;
export function getRecentPicks() {
  try {
    const v = JSON.parse(/** @type {string} */ (localStorage.getItem(RECENT_PICKS_KEY)));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
/** @param {unknown} pick */
export function addRecentPick(pick) {
  const id = JSON.stringify(pick);
  const list = [pick].concat(getRecentPicks().filter(p => JSON.stringify(p) !== id)).slice(0, RECENT_PICKS_MAX);
  try { localStorage.setItem(RECENT_PICKS_KEY, JSON.stringify(list)); } catch {}
}
export function clearRecentPicks() {
  try { localStorage.removeItem(RECENT_PICKS_KEY); } catch {}
}

export function refreshTabVisibility() {
  const tabPlaces = document.getElementById('tab-places');
  const tabTrails = document.getElementById('tab-routes');
  // The count sits in the list page's search box, so a tab is its label.
  if (tabPlaces) { tabPlaces.style.display = placesEnabled() ? '' : 'none'; tabPlaces.textContent = 'Places'; }
  if (tabTrails) { tabTrails.style.display = routesEnabled() ? '' : 'none'; tabTrails.textContent = 'Routes'; }
  const tabHistory = document.getElementById('tab-history');
  if (tabHistory) tabHistory.style.display = historyEnabled() ? '' : 'none';
  // Lists and Search both cover places, areas and routes, so they go with
  // the last of them, and Add with them for someone who can edit. You holds
  // Settings, so the bar always has it.
  const any = placesEnabled() || routesEnabled();
  const canAdd = any && !isReadOnly() && !!(state.auth && state.auth.authenticated);
  /** @type {Record<string, boolean>} */
  const shown = { lists: any, search: any, add: canAdd };
  Object.keys(shown).forEach(v => {
    const item = document.getElementById('bar-' + v);
    if (item) item.hidden = !shown[v];
  });
}

// The Lists page's tabs, in order. Areas are drawn and filtered with the
// places, so they go with them.
export function listKinds() {
  return /** @type {string[]} */ ([placesEnabled() && 'places', routesEnabled() && 'routes', placesEnabled() && 'areas'].filter(Boolean));
}
// Lists opens on the tab last picked on this device.
export function listsHash() {
  const kinds = listKinds();
  if (!kinds.length) return '#/';
  const last = getPref('lists-tab', '');
  return '#/' + (kinds.includes(last) ? last : kinds[0]);
}
