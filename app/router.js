import { state } from './core.js';
import { historyEnabled, listsHash, placesEnabled, routesEnabled } from './prefs.js';
import { renderUnifiedMap, showTrailDetail } from './map/index.js';
import { DIALOG_STYLES, LIST_STYLES, withStyles } from './lazy-open.js';
import { unmountPage } from './view.js';

/** @param {string} type @param {string} slug */
export function focusHash(type, slug) { return '#/' + type + '/' + slug; }

/** @param {string} hash */
function parseFocus(hash) {
  const base = hash.split('?')[0];
  if (base.startsWith('#/place/')) {
    const slug = decodeURIComponent(base.slice('#/place/'.length));
    const place = (state.places || []).find(p => p._slug === slug || p.name === slug);
    return { type: 'place', name: place ? place.name : slug, slug: (place && place._slug) || slug };
  }
  if (base.startsWith('#/route/')) {
    const slug = decodeURIComponent(base.slice('#/route/'.length));
    if (state.manifest && state.manifest.regions) {
      for (const r of state.manifest.regions) {
        for (const route of r.routes) {
          if (route._slug === slug || route.key === slug) return { type: 'route', name: route.key };
        }
      }
    }
    return { type: 'route', name: slug };
  }
  // Legacy: #/?focus=type:id
  const q = hash.split('?')[1];
  if (q) {
    const params = new URLSearchParams(q);
    const focus = params.get('focus');
    if (focus) {
      const colon = focus.indexOf(':');
      if (colon !== -1) return { type: focus.slice(0, colon), name: decodeURIComponent(focus.slice(colon + 1)) };
    }
  }
  return null;
}

// Bumped on every navigation. A list page arrives through import(), so a
// second hash change can land before the first page's code does; without this
// the late page would mount over the one the user is on.
let navSeq = 0;

/**
 * Mounts a list page once its module is in, unless another navigation began meanwhile.
 * @param {() => Promise<any>} load @param {number} seq
 * @param {(mod: any) => any} mount
 */
async function mountLazy(load, seq, mount) {
  const mod = await load();
  if (seq !== navSeq) return;
  return mount(mod);
}

export function router() {
  const seq = ++navSeq;
  unmountPage();
  const navActions = document.getElementById('nav-actions');
  if (navActions) navActions.replaceChildren();
  const hash = location.hash || '#/';
  const base = hash.split('?')[0];
  if (base.startsWith('#/place/') || base.startsWith('#/route/')) return renderUnifiedMap(parseFocus(hash));
  if (base === '#/' || base === '#' || base === '#/map') return renderUnifiedMap(parseFocus(hash));
  // Replaced rather than pushed, so Back skips the step to the tab.
  if (base === '#/lists') { location.replace(listsHash()); return; }
  if (base === '#/places') {
    if (!placesEnabled()) { location.hash = '#/'; return; }
    return mountLazy(() => withStyles(import('./places/places-page.js'), LIST_STYLES, DIALOG_STYLES), seq, m => m.renderPlacesIndex());
  }
  if (base === '#/routes') {
    if (!routesEnabled()) { location.hash = '#/'; return; }
    return mountLazy(() => withStyles(import('./routes/routes-page.js'), LIST_STYLES, DIALOG_STYLES), seq, m => m.renderTrailsIndex());
  }
  if (base.startsWith('#/routes/route/')) {
    if (!routesEnabled()) { location.hash = '#/'; return; }
    const key = decodeURIComponent(base.replace('#/routes/route/', ''));
    return showTrailDetail(key);
  }
  if (base === '#/areas') {
    if (!placesEnabled()) { location.hash = '#/'; return; }
    return mountLazy(() => withStyles(import('./areas/areas-page.js'), LIST_STYLES, DIALOG_STYLES), seq, m => m.renderAreasIndex());
  }
  if (base === '#/you') return mountLazy(() => withStyles(import('./you.js'), LIST_STYLES, DIALOG_STYLES), seq, m => m.renderYouPage());
  if (base === '#/history') {
    if (!historyEnabled()) { location.hash = '#/'; return; }
    return mountLazy(() => withStyles(import('./history.js'), LIST_STYLES, DIALOG_STYLES), seq, m => m.renderHistoryIndex());
  }
  renderUnifiedMap(null);
}

// Kept as a thin wrapper: callers use wrappedRouter() to re-render the
// current view. The map's Add action now lives in the nav (renderUnifiedMap
// populates #nav-actions), so there's no floating button to re-mount.
export function wrappedRouter() {
  const out = router();
  // A page whose code cannot be fetched (offline before its first visit) must not surface as an unhandled rejection.
  if (out && typeof out.catch === 'function') out.catch(err => console.error('Could not open page', err));
}
// Flag in-app hash navigations (clicks) vs the initial load (reload), so a
// place focus from a click centers the map on the pin, while a reload at a
// place URL keeps the user's prior/remembered view.
window.addEventListener('hashchange', function() {
  state._navByHash = true;
  try { wrappedRouter(); } finally { state._navByHash = false; }
});
