import {
  DATA_FILES, assignCategoryColors, assignPlaceSlugs, assignTrailSlugs, state,
} from './core.js';
import { applyAuth, fetchJson, isReadOnly, serverBase, serverFileUrl } from './server.js';
import { authCacheKey, idbGet, idbSet } from './device-cache.js';
import { isLocalMode } from './local-mode.js';
import { dataLayer, drainOutbox, updateOfflineBanner } from './offline-queue.js';
import {
  DEFAULT_CONFIG, applyControlVisibility, catalogEnabled, getDefaultShow, getJsonListPref,
  loadSyncedPrefs, placesAvailable, refreshTabVisibility, routesAvailable,
} from './prefs.js';
import { fetchCatalog } from './places-list.js';
import {
  applyTheme, applyTileFilter, getStoredMode, getStoredTheme, getTileFilter,
} from './theme.js';
import { apiUrl, renderAuthWidget } from './auth.js';
import { setAreas } from './select.js';
import { renderServerPicker, renderSignInPage } from './sign-in.js';
import { wrappedRouter } from './pick-coords.js';
import './backup.js';
import './area-geo.js';
import './form-fields.js';
import './tags.js';
import './map-panel.js';
import './map-wheel.js';
import './map-layers.js';
import './map-markers.js';
import './route-layer.js';
import './map-popups.js';
import './areas.js';
import './countries.js';
import './route-meta.js';
import './map.js';
import './edit-place.js';
import './map-actions.js';
import './place-layer.js';
import './history.js';
import './routes-list.js';
import './route-detail.js';
import './router.js';
import './settings.js';
import './settings-logs.js';
import './settings-categories.js';
import './settings-regions.js';
import './settings-account.js';
import './settings-catalog.js';
import './context-menu.js';
import './modal.js';
import './add.js';

applyTheme(getStoredTheme(), getStoredMode());
applyControlVisibility();
applyTileFilter(getTileFilter());
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getStoredMode() === 'system') applyTheme(getStoredTheme(), 'system');
  });
}
function applyConfig(cfg) {
  state.config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
  state.config.features = Object.assign({}, DEFAULT_CONFIG.features, (cfg && cfg.features) || {});
  document.title = state.config.brand || 'Ferd';
  const brandEl = document.getElementById('nav-brand-text');
  if (brandEl) brandEl.textContent = state.config.brand || 'Ferd';
  refreshTabVisibility();
}

export function loadDataAndRender() {
  const v = state.viewer;
  const placesP = placesAvailable()
    ? dataLayer.fetchPlaces(null).catch(() => null)
    : Promise.resolve(null);
  const routesP = routesAvailable()
    ? dataLayer.fetchRoutes(null).catch(() => null)
    : Promise.resolve(null);
  const labelsP = placesAvailable()
    ? dataLayer.fetchCategoryLabels(null).catch(() => null)
    : Promise.resolve(null);
  const areasP = placesAvailable()
    ? dataLayer.fetchAreas([]).catch(() => [])
    : Promise.resolve([]);
  return Promise.all([placesP, routesP, labelsP, areasP]).then(function([places, routes, labels, areas]) {
    if (labels && labels.category_labels) {
      state.config.category_labels = labels.category_labels;
    }
    setAreas(areas);
    if (Array.isArray(places)) {
      // Normalize: missing/empty category is the "uncategorized" bucket
      // (key ''), so the rest of the UI can treat p.category as a plain
      // string without sprinkling null checks everywhere.
      for (const p of places) { if (p.category == null) p.category = ''; }
      state.places = places;
      assignPlaceSlugs(state.places);
      const cc = assignCategoryColors(places);
      state.categoryColors = cc.dark;
      state.categoryColorsLight = cc.light;
    }
    if (routes && Array.isArray(routes.regions)) {
      routes.regions.sort((a, b) => a.name.localeCompare(b.name));
      for (const region of routes.regions) region.routes.sort((a, b) => a.name.localeCompare(b.name));
      state.manifest = routes;
      assignTrailSlugs(state.manifest);
    }
    refreshTabVisibility();
    if ((placesAvailable() && !state.places) && (routesAvailable() && !state.manifest)) {
      document.body.classList.remove('app-booting', 'signin-only');
      if (v.mode === 'public') {
        document.getElementById('app').innerHTML = '<div class="loading">Map not found, or owner has not published it.</div>';
        return;
      }
      document.getElementById('app').innerHTML = '<div class="loading">Failed to load data</div>';
      return;
    }
    // Apply the (now-synced) theme and reveal the app chrome in the same
    // synchronous tick as the first render, so neither the theme nor the
    // nav visibly changes on the sign-in screen beforehand.
    try { applyTheme(getStoredTheme(), getStoredMode()); } catch {}
    // Seed the session's map visibility from the saved defaults. The filter
    // panel overrides these in-session without touching the stored defaults.
    state.hiddenCategories = new Set(getJsonListPref('default-hidden-categories'));
    state.hiddenRegions = new Set(getJsonListPref('default-hidden-regions'));
    state.showVisited = getDefaultShow('visited');
    state.showWant = getDefaultShow('want');
    state.showCompleted = getDefaultShow('completed');
    state.showPlanned = getDefaultShow('planned');
    document.body.classList.remove('app-booting', 'signin-only');
    wrappedRouter();
    updateOfflineBanner();
    // Flush any writes queued during a previous offline session, then
    // reconcile state with the server. No-op when offline or local-only.
    drainOutbox();
    // Warm the catalog cache in the background so the Browse tab in the
    // Add modal renders instantly the first time it's opened, instead of
    // flashing the Loading placeholder. Authed users only.
    if (state.auth && state.auth.authenticated && !isReadOnly() && catalogEnabled() && state._catalogCache == null) {
      fetchCatalog().then(entries => {
        state._catalogCache = Array.isArray(entries) ? entries : [];
        // If the user is sitting on the Places list when this lands,
        // re-render so the "update available" badges reflect the cache.
        if ((location.hash || '#/').startsWith('#/places')) wrappedRouter();
      }).catch(() => {});
    }
  });
}

export function bootApp() {
  // Local-only mode: no server, no auth. Run as a read-write owner whose
  // data lives entirely in IndexedDB. Config falls back to defaults.
  if (isLocalMode()) {
    applyConfig(null);
    state.auth = { authenticated: true, username: null, is_admin: false, local: true };
    renderAuthWidget();
    return loadDataAndRender();
  }
  return fetchJson(serverFileUrl(DATA_FILES.siteConfig), null)
    .then(function(cfg) {
      applyConfig(cfg);
      // Cache the auth state on success; on a network failure (offline
      // cold boot) restore the last-known session so the PWA opens into
      // the map instead of bouncing to the sign-in screen. A definitive
      // non-ok response (e.g. expired session) still yields null.
      return fetch(apiUrl('/state'), applyAuth({})).then(
        r => {
          if (!r.ok) return null;
          return r.json().then(s => { idbSet('cache', authCacheKey(), { data: s, ts: Date.now() }); return s; }, () => null);
        },
        () => idbGet('cache', authCacheKey()).then(rec => rec ? rec.data : null)
      );
    })
    .then(function(authState) {
      if (authState) state.auth = authState;
      renderAuthWidget();
      const v = state.viewer;
      if (v.mode === 'owner' && !state.auth.authenticated) {
        renderSignInPage();
        return;
      }
      return loadSyncedPrefs().then(() => loadDataAndRender());
    });
}

// Confirm a base actually hosts a Ferd API before we commit to it. Empty
// base = probe same-origin. Short timeout so a dead address fails fast.
export function probeServer(base, timeoutMs) {
  const root = (base || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(function() { ctrl.abort(); }, timeoutMs || 4000);
  return fetch(root + '/api/health', { credentials: 'omit', signal: ctrl.signal })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(j) { return !!(j && j.status === 'ok'); })
    .catch(function() { return false; })
    .finally(function() { clearTimeout(t); });
}

// True when this server has an on-device cache from a prior successful
// load, so a failed probe (offline, flaky link, server down) can boot
// into the last-known map read-only instead of dead-ending at the picker.
function hasOfflineCache() {
  return idbGet('cache', authCacheKey()).then(rec => !!(rec && rec.data));
}

// Boot trigger. A stored server is probed and used (re-prompts on failure).
// With no stored server we probe same-origin: an API there means a normal
// web/PWA deploy (boot silently, picker never seen); none means a bundled
// shell with no local API, so ask which server to connect to. When the
// probe fails but we hold a cache for this server, boot anyway; bootApp
// restores the session and data from IndexedDB and the offline banner
// signals read-only mode.
function startup() {
  // Local-only mode skips the server probe entirely.
  if (isLocalMode()) return bootApp();
  const base = serverBase();
  if (base) {
    return probeServer(base, 6000).then(function(ok) {
      if (ok) return bootApp();
      return hasOfflineCache().then(function(cached) {
        if (cached) return bootApp();
        return renderServerPicker({ error: "Can't reach " + base + ". Check the address or your connection." });
      });
    });
  }
  return probeServer('', 3500).then(function(ok) {
    if (ok) return bootApp();
    return hasOfflineCache().then(function(cached) {
      return cached ? bootApp() : renderServerPicker({});
    });
  });
}

startup();

// PWA: offline indicator + service worker registration + update toast.
(function() {
  const updateBanner = document.getElementById('pwa-update-banner');
  const updateBtn = document.getElementById('pwa-update-btn');

  window.addEventListener('online', () => { updateOfflineBanner(); drainOutbox(); });
  window.addEventListener('offline', updateOfflineBanner);
  updateOfflineBanner();

  if (!('serviceWorker' in navigator)) return;

  // After a hard-refresh the browser loads without an SW controller,
  // and the worker then takes over a moment later. That first
  // takeover fires 'controllerchange' too, but it's not an update -
  // reloading on it caused a spurious second refresh.
  let hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (!hadController) { hadController = true; return; }
    refreshing = true;
    window.location.reload();
  });

  let pendingReg = null;
  function promptUpdate(reg) {
    pendingReg = reg;
    updateBanner.classList.add('visible');
  }
  updateBtn.onclick = () => {
    // Re-resolve the waiting worker at click time. A captured worker
    // reference goes stale if the browser swapped or terminated it,
    // which left Reload doing nothing.
    const worker = (pendingReg && (pendingReg.waiting || pendingReg.installing)) || null;
    if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
    // Safety net: if no controllerchange fires within 2s (no waiting
    // worker, message ignored, etc.), reload anyway - the user asked.
    setTimeout(() => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    }, 2000);
  };

  navigator.serviceWorker.register('/sw.js').then((reg) => {
    if (reg.waiting) promptUpdate(reg);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          promptUpdate(reg);
        }
      });
    });
    // Force an update check on every page load. Firefox especially is
    // lazy about checking for new SW versions otherwise, and our
    // content-hash CACHE_VERSION means sw.js bytes can change on any
    // shell-file edit; users shouldn't have to unregister manually.
    try { reg.update(); } catch (_) {}
  }).catch(() => { /* registration failed; app still works online */ });
})();
