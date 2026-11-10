import { DATA_FILES, state } from './core.js';
import { applyAuth, fetchJson, hasServer, isReadOnly, serverBase, serverFileUrl } from './server.js';
import { effect } from '@preact/signals';
import {
  authCacheKey, discardOp, dismissKept, issueText, loadPublic, metaGet, metaSet,
  open as openStore, sync, syncIssues, synced as storeSynced, updateOfflineBanner, showUpdatePrompt,
} from './store.js';
import { AppError, DialogHead, html, mountPage, openViewModal, useState } from './view.js';
import { t } from './i18n.js';
import {
  DEFAULT_CONFIG, applyControlVisibility, catalogEnabled, getDefaultShow, getJsonListPref,
  applyLanguage, loadSyncedPrefs, refreshTabVisibility,
} from './prefs.js';
import { fetchCatalog } from './places-list.js';
import {
  applyTheme, applyTileFilter, getStoredMode, getStoredTheme, getTileFilter,
} from './theme.js';
import { apiUrl, renderAuthWidget } from './auth.js';
import { bindStoreToState } from './select.js';
import { bindMapToStore } from './map/index.js';
import { renderServerPicker, renderSignInPage } from './sign-in.js';
import { wrappedRouter } from './router.js';
import './area-geo.js';
import './tags.js';
import './countries.js';
import './router.js';
import { saveDownload } from './download.js';
import './modal.js';
import './bottom-bar.js';
import './bar-motion.js';

applyTheme(getStoredTheme(), getStoredMode());
applyControlVisibility();
applyTileFilter(getTileFilter());
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getStoredMode() === 'system') applyTheme(getStoredTheme(), 'system');
  });
}
/** @param {Record<string, any> | null} [cfg] */
function applyConfig(cfg) {
  state.config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
  state.config.features = Object.assign({}, DEFAULT_CONFIG.features, (cfg && cfg.features) || {});
  document.title = state.config.brand || DEFAULT_CONFIG.brand;
  const brandEl = document.getElementById('nav-brand-text');
  if (brandEl) brandEl.textContent = state.config.brand || DEFAULT_CONFIG.brand;
  refreshTabVisibility();
}

// Open this viewer's copy of the map and bring it up to date: an owner on a
// server syncs (waiting for it only when this device has never synced
// that map), a public map is fetched whole, and with no server the device
// copy is all there is. The signals in store.js then hold the data, and
// select.js mirrors them into state.
function loadData() {
  if (!hasServer()) return openStore();
  if (isReadOnly()) return loadPublic();
  return openStore().then(had => {
    if (had) { sync(); return true; }
    return sync().then(() => storeSynced());
  });
}

export function loadDataAndRender() {
  const v = state.viewer;
  return loadData().then(function(loaded) {
    loadSyncedPrefs();
    applyLanguage();
    refreshTabVisibility();
    if (!loaded) {
      document.body.classList.remove('app-booting', 'signin-only');
      if (v.mode === 'public') {
        mountPage(html`<${AppError} msg=${t(loaded === null ? 'app.unreachable' : 'app.notPublished')} />`);
        return;
      }
      mountPage(html`<${AppError} msg=${t('app.loadFailed')} />`);
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
    // Warm the catalog cache in the background so the Browse tab in the
    // Add modal renders instantly the first time it's opened, instead of
    // flashing the Loading placeholder. Authed users only.
    if (state.auth && state.auth.authenticated && !isReadOnly() && catalogEnabled() && state._catalogCache == null) {
      fetchCatalog().then(entries => {
        state._catalogCache = Array.isArray(entries) ? entries : [];
      }).catch(() => {});
    }
  });
}

export function bootApp() {
  // No server: no auth, a read-write owner whose data lives entirely in
  // IndexedDB. Config falls back to defaults.
  if (!hasServer()) {
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
          return r.json().then(s => { metaSet(authCacheKey(), s); return s; }, /** @returns {null} */ () => null);
        },
        () => metaGet(authCacheKey()).then(s => s || null)
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
      return loadDataAndRender();
    });
}

// Confirm a base actually hosts a Ferd API before we commit to it. Empty
// base = probe same-origin. Short timeout so a dead address fails fast.
/**
 * The `/api/health` response.
 * @typedef {object} HealthData
 * @property {'ok'} status
 * @property {string} version
 */
/** @param {string} base @param {number} [timeoutMs] */
export function probeServer(base, timeoutMs) {
  const root = (base || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(function() { ctrl.abort(); }, timeoutMs || 4000);
  return fetch(root + '/api/health', { credentials: 'omit', signal: ctrl.signal })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(/** @type {HealthData | null} */ j) { return !!(j && j.status === 'ok'); })
    .catch(function() { return false; })
    .finally(function() { clearTimeout(t); });
}

// True when this server has an on-device cache from a prior successful
// load, so a failed probe (offline, flaky link, server down) can boot
// into the last-known map read-only instead of dead-ending at the picker.
function hasOfflineCache() {
  return metaGet(authCacheKey()).then(s => !!s);
}

// Boot trigger. A stored server is probed and used (re-prompts on failure).
// With no stored server we probe same-origin: an API there means a normal
// web/PWA deploy (boot silently, picker never seen); none means a bundled
// shell with no local API, so ask which server to connect to. When the
// probe fails but we hold a cache for this server, boot anyway; bootApp
// restores the session and data from IndexedDB and the offline banner
// signals read-only mode.
function startup() {
  // With no server there is nothing to probe.
  if (!hasServer()) return bootApp();
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

applyLanguage();
bindStoreToState();
bindMapToStore();
startup();

// PWA: offline indicator + service worker registration + update toast.
(function() {
  const updateBtn = /** @type {HTMLElement} */ (document.getElementById('pwa-update-btn'));

  window.addEventListener('online', () => { updateOfflineBanner(); sync(); });
  window.addEventListener('offline', updateOfflineBanner);
  updateOfflineBanner();

  const issuesBanner = /** @type {HTMLElement} */ (document.getElementById('pwa-sync-issues'));
  const issuesText = /** @type {HTMLElement} */ (document.getElementById('pwa-sync-issues-text'));
  effect(() => {
    const { stuck, kept } = syncIssues.value;
    const parts = [];
    if (stuck.length) parts.push(t('syncIssues.bannerStuck', { count: stuck.length }));
    if (kept.length) parts.push(t('syncIssues.bannerKept', { count: kept.length }));
    issuesBanner.hidden = parts.length === 0;
    issuesText.textContent = parts.join(' ');
  });
  /** @type {HTMLElement} */ (document.getElementById('pwa-sync-issues-btn')).addEventListener('click', () => openViewModal(html`<${SyncIssues} />`));

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

  let pendingReg = /** @type {ServiceWorkerRegistration | null} */ (null);
  /** @param {ServiceWorkerRegistration} reg */
  function promptUpdate(reg) {
    pendingReg = reg;
    showUpdatePrompt();
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
    // update() returns a promise that rejects offline; a try/catch misses it
    // and WebKit reports the rejection as a page error.
    reg.update().catch(() => { /* offline; the next load checks again */ });
  }).catch(() => { /* registration failed; app still works online */ });
})();

/** @type {Record<string, string>} */
const OP_TEXT = {
  uploadGpx: 'syncIssues.op.upload', deleteGpx: 'syncIssues.op.delete', moveGpx: 'syncIssues.op.move',
  setGpxCompleted: 'syncIssues.op.completed', renameRegion: 'syncIssues.op.region', deleteRegion: 'syncIssues.op.region',
  clearRegion: 'syncIssues.op.region',
};
// GPX calls the server keeps failing, each with Retry and Discard, and
// uploads it refused, kept here to save. Nothing leaves the queue unseen.
/** @typedef {import('./store.js').SyncIssue} SyncIssue */
function SyncIssues() {
  const { stuck, kept } = /** @type {{ stuck: SyncIssue[], kept: SyncIssue[] }} */ (syncIssues.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (/** @type {() => any} */ fn) => {
    setBusy(true); setError('');
    Promise.resolve().then(fn).catch(e => setError(t('common.failed', { message: (e && e.message) || String(e) }))).finally(() => setBusy(false));
  };
  const save = (/** @type {SyncIssue} */ it) => run(() => issueText(it).then(text => {
    if (text == null) throw new Error(t('syncIssues.noText'));
    return saveDownload(new Blob([text], { type: 'application/gpx+xml' }), it.name.split('/').pop() || it.name, 'application/gpx+xml');
  }));
  return html`<${DialogHead} title=${t('syncIssues.title')} />
  <div class="ui-dialog-body">
    ${!stuck.length && !kept.length ? html`<p>${t('syncIssues.none')}</p>` : null}
    ${stuck.length ? html`<p>${t('syncIssues.stuckLead')}</p>
    <ul class="sync-issues">${stuck.map(it => html`<li key=${'s' + it.id}>
      <div><div>${t(OP_TEXT[it.method || ''] || 'syncIssues.op.change', { name: it.name })}</div><div class="sync-issue-error">${it.error}</div></div>
      <div class="sync-issue-actions">
        <button type="button" class="ui-button ui-button-primary" disabled=${busy} onClick=${() => run(sync)}>${t('syncIssues.retry')}</button>
        ${it.upload ? html`<button type="button" class="ui-button" disabled=${busy} onClick=${() => save(it)}>${t('syncIssues.save')}</button>` : null}
        <button type="button" class="ui-button" disabled=${busy} onClick=${() => run(() => discardOp(Number(it.id)))}>${t('syncIssues.discard')}</button>
      </div>
    </li>`)}</ul>` : null}
    ${kept.length ? html`<p>${t('syncIssues.keptLead')}</p>
    <ul class="sync-issues">${kept.map(it => html`<li key=${it.key}>
      <div><div>${it.name}</div><div class="sync-issue-error">${it.error}</div></div>
      <div class="sync-issue-actions">
        <button type="button" class="ui-button ui-button-primary" disabled=${busy} onClick=${() => save(it)}>${t('syncIssues.save')}</button>
        <button type="button" class="ui-button" disabled=${busy} onClick=${() => run(() => dismissKept(String(it.key)))}>${t('syncIssues.dismiss')}</button>
      </div>
    </li>`)}</ul>` : null}
    <div class=${'form-error' + (error ? ' visible' : '')}><p class="ui-hint ui-hint-error">${error}</p></div>
  </div>`;
}
