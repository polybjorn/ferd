// The map's boundary. Every module under app/map/ may call Leaflet; nothing
// outside it does, and the rest of the app reaches the map only through this
// file (tests/js/map-boundary.test.js holds both rules). The data reaches the
// map through the store's signals (sync.js), so a write never has to tell
// the map about itself.
import { state } from '../core.js';
import { DIALOG_STYLES, loadStyle } from '../lazy-open.js';
import { t } from '../i18n.js';
import { AppError, html as vhtml, mountPage } from '../view.js';
import { addTilePicker } from './map-layers.js';
import { playEnter, playLeave } from './map-actions.js';
import { rebuildMapFilterPanel } from './map-panel.js';
import { applyMapFilters } from './place-layer.js';
import { flushMapSync } from './sync.js';
export { areaFadeOut, routesInArea } from './area-layer.js';
export { showResultOnMap } from './map-phone.js';
export { syncCountriesOnMap } from './country-layer.js';
export { renderUnifiedMap } from './home-map.js';
export {
  deletePlaceItem,
  deleteRouteItem,
  openPlacePopup,
} from './map-actions.js';
export { applyCoverMinZoom, cleanupMap, parseOverlays, TOPO_CREDIT } from './map-layers.js';
export { refreshPlaceMarkerIcons } from './map-markers.js';
export { wireFilterPopover } from './map-panel.js';
export {
  refreshCategoryColors,
  refreshOpenPlacePopup,
  refreshPlacesPresentation,
} from './map-popups.js';
export { enterPickCoordsMode } from './pick-coords.js';
export { swapPlaceClusterGroup } from './place-layer.js';
export { fetchGpxText, refreshTrailWeights } from './route-layer.js';
export { bindMapToStore, homeMapMounted } from './sync.js';

/** @param {string} src */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => { el.remove(); reject(new Error(src)); };
    document.head.appendChild(el);
  });
}

// route-detail.js and the elevation plugin are only needed on a route's page,
// so they load on the first one, with the page's own rules and the dialog
// rules its Edit form needs. The plugin's stylesheet goes in the vendor
// layer through a wrapper file; a plain link would be unlayered and beat the
// app and ui layers. The promise is shared so a second click doesn't load
// twice, and cleared on failure so a later visit retries.
/** @type {Promise<typeof import('./route-detail.js')> | null} */
let routeDetailLoad = null;
function loadRouteDetail() {
  if (!routeDetailLoad) {
    routeDetailLoad = Promise.all([
      import('./route-detail.js'),
      loadStyle('/app/map/elevation.css'),
      loadStyle('/app/map/route-detail.css'),
      loadStyle(DIALOG_STYLES),
      loadScript('/vendor/leaflet-elevation/leaflet-elevation.js'),
    ]).then(([mod]) => mod);
    routeDetailLoad.catch(() => { routeDetailLoad = null; });
  }
  return routeDetailLoad;
}

// Only the latest call renders, and only if the hash is still the one it was
// asked for, since the router has already moved on otherwise.
let trailDetailCall = 0;
/** @param {string} routeKey */
export function showTrailDetail(routeKey) {
  const call = ++trailDetailCall;
  const hash = location.hash;
  return loadRouteDetail().then(mod => {
    if (call !== trailDetailCall || location.hash !== hash) return;
    mod.renderTrailDetail(routeKey);
  }, () => {
    if (call !== trailDetailCall || location.hash !== hash) return;
    mountPage(vhtml`<${AppError} msg=${t('routeDetail.loadFailed')} />`);
  });
}

// Settings toggled Places or Routes: apply it in place, since a rebuild would
// blink behind the open dialog. False when no map is on screen.
export function refreshMapFeatures() {
  if (!state.currentMap) return false;
  applyMapFilters();
  rebuildMapFilterPanel();
  return true;
}

/** @param {boolean} on */
export function setTilePicker(on) {
  if (!state.currentMap || !state.tilePickerLayers) return;
  if (on && !state.tilePickerCtrl) {
    const ctrl = addTilePicker(state.currentMap);
    state.tilePickerCtrl = ctrl;
    playEnter(ctrl.getContainer(), 'tile-pick-enter');
  } else if (!on && state.tilePickerCtrl) {
    const ctrl = state.tilePickerCtrl;
    state.tilePickerCtrl = null;
    playLeave(ctrl.getContainer(), 'tile-pick-leave', () => state.currentMap.removeControl(ctrl));
  }
}

// A catalog change restyles places without changing the store's copy.
export function redrawPlaces() {
  if (state._placeClusterGroup) state._placeClusterGroup.redraw();
}

// Fit the index map to the areas just added: those not in `before`, a set of ids.
/** @param {Set<string>} before */
export function fitAddedAreas(before) {
  flushMapSync();
  const map = state.currentMap;
  const added = (state._areaLayers || []).filter(x => !before.has(x.area.id));
  if (!map || !added.length) return;
  const bounds = L.latLngBounds();
  for (const x of added) bounds.extend(x.layer.getBounds());
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
}
