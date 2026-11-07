import { state } from './core.js';
import { historyEnabled, placesEnabled, routesEnabled } from './prefs.js';
import { renderTrailDetail, renderUnifiedMap } from './map/index.js';
import { renderPlacesIndex } from './places/places-page.js';
import { renderHistoryIndex } from './history.js';
import { renderTrailsIndex } from './routes/routes-page.js';
import { unmountPage } from './view.js';

export function focusHash(type, slug) { return '#/' + type + '/' + slug; }

function parseFocus(hash) {
  const base = hash.split('?')[0];
  if (base.startsWith('#/place/')) {
    const slug = decodeURIComponent(base.slice('#/place/'.length));
    const place = (state.places || []).find(p => p._slug === slug || p.name === slug);
    return { type: 'place', name: place ? place.name : slug, slug: place ? place._slug : slug };
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

export function router() {
  unmountPage();
  const navActions = document.getElementById('nav-actions');
  if (navActions) navActions.innerHTML = '';
  const hash = location.hash || '#/';
  const base = hash.split('?')[0];
  if (base.startsWith('#/place/') || base.startsWith('#/route/')) return renderUnifiedMap(parseFocus(hash));
  if (base === '#/' || base === '#' || base === '#/map') return renderUnifiedMap(parseFocus(hash));
  if (base === '#/places') {
    if (!placesEnabled()) { location.hash = '#/'; return; }
    return renderPlacesIndex();
  }
  if (base === '#/routes') {
    if (!routesEnabled()) { location.hash = '#/'; return; }
    return renderTrailsIndex();
  }
  if (base.startsWith('#/routes/route/')) {
    if (!routesEnabled()) { location.hash = '#/'; return; }
    const key = decodeURIComponent(base.replace('#/routes/route/', ''));
    return renderTrailDetail(key);
  }
  if (base === '#/history') {
    if (!historyEnabled()) { location.hash = '#/'; return; }
    return renderHistoryIndex();
  }
  renderUnifiedMap(null);
}

// Kept as a thin wrapper: callers use wrappedRouter() to re-render the
// current view. The map's Add action now lives in the nav (renderUnifiedMap
// populates #nav-actions), so there's no floating button to re-mount.
export function wrappedRouter() { router(); }
// Flag in-app hash navigations (clicks) vs the initial load (reload), so a
// place focus from a click centers the map on the pin, while a reload at a
// place URL keeps the user's prior/remembered view.
window.addEventListener('hashchange', function() {
  state._navByHash = true;
  try { wrappedRouter(); } finally { state._navByHash = false; }
});
