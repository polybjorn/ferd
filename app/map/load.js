// Loads the map once a viewer is past the sign-in check, so the sign-in page
// fetches neither Leaflet nor the map's modules. The rest of the app reaches
// the map through this file and index.js (tests/js/map-boundary.test.js):
// loadMap() brings it in, and loadedMap() hands it to code that only has
// something to tell a map that is already up. Nothing here may import the map
// statically, since main.js imports this file on the first load.

// Classic scripts the map modules call at evaluation, in the order they run.
const SCRIPTS = [
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet-tilelayer-nogap/L.TileLayer.NoGap.js',
  '/vendor/supercluster/supercluster.min.js',
  '/vendor/leaflet-gpx/gpx.js',
];

// The modules index.js and the router reach statically. They are fetched
// alongside the scripts, so the import below finds them all at once instead
// of one level at a time. tests/test_ui_css.py holds this list to the graph.
export const MAP_MODULES = [
  '/app/countries.js',
  '/app/router.js',
  '/app/map/area-layer.js',
  '/app/map/country-layer.js',
  '/app/map/home-map.js',
  '/app/map/index.js',
  '/app/map/map-actions.js',
  '/app/map/map-layers.js',
  '/app/map/map-markers.js',
  '/app/map/map-panel.js',
  '/app/map/map-phone.js',
  '/app/map/map-popups.js',
  '/app/map/map-wheel.js',
  '/app/map/pick-coords.js',
  '/app/map/place-layer.js',
  '/app/map/popups.js',
  '/app/map/route-layer.js',
  '/app/map/search-keys.js',
  '/app/map/sync.js',
];

/** @typedef {{ map: typeof import('./index.js'), router: typeof import('../router.js') }} LoadedMap */

/** @type {Map<string, Promise<void>>} */
const scriptLoads = new Map();

// Once per script: a retry after a failure adds only the ones that failed.
/** @param {string} src @returns {Promise<void>} */
function addScript(src) {
  const known = scriptLoads.get(src);
  if (known) return known;
  /** @type {Promise<void>} */
  const load = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    // Fetched in parallel, run in the order added.
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => { el.remove(); reject(new Error(src)); };
    document.head.appendChild(el);
  });
  scriptLoads.set(src, load);
  load.catch(() => { scriptLoads.delete(src); });
  return load;
}

/** @type {Promise<LoadedMap> | null} */
let loading = null;
/** @type {typeof import('./index.js') | null} */
let loaded = null;
let preloaded = false;

/** @returns {Promise<LoadedMap>} */
export function loadMap() {
  if (!loading) {
    if (!preloaded) {
      preloaded = true;
      for (const href of MAP_MODULES) {
        const link = document.createElement('link');
        link.rel = 'modulepreload';
        link.href = href;
        document.head.appendChild(link);
      }
    }
    // The map modules extend Leaflet as they evaluate, so the scripts run first.
    /** @type {Promise<LoadedMap>} */
    const load = Promise.all(SCRIPTS.map(addScript)).then(() => {
      const router = import('../router.js');
      return import('./index.js').then(map => router.then(r => {
        map.bindMapToStore();
        loaded = map;
        return { map, router: r };
      }));
    });
    // A failed load (offline before the worker cached it) is tried again on the next call.
    load.catch(() => { loading = null; });
    loading = load;
  }
  return loading;
}

// The map when it is up, else null: a caller with nothing to draw yet skips it.
export function loadedMap() { return loaded; }
