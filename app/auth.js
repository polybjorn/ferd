import { escapeHtml, state } from './core.js';
import { applyAuth, hasServer, isReadOnly, serverBase, setBearerToken, setServerless } from './server.js';
import { clearRecentPicks, logsEnabled, refreshTabVisibility } from './prefs.js';
import { closeTransientOverlays, parseOverlays, TOPO_CREDIT } from './map/index.js';
import { openCatalogBulkUpdateModal, placesWithCatalogUpdates } from './places-list.js';
import { openSettingsModal } from './settings/settings.js';
import { openLogsModal } from './settings/logs.js';
import { modalHeaderHtml, openConfirmModal } from './select.js';
import { closeModal, openSheetModal } from './modal.js';
import { openSignInModal } from './sign-in.js';


/**
 * An Error thrown by an API call: `status` and `body` from a non-2xx reply,
 * `offline` when the request never reached the server.
 * @typedef {Error & { status?: number, body?: any, offline?: boolean }} ApiError
 */

/** @param {string} path */
export function apiUrl(path) {
  const apiBase = (state.config.api_base || '/api').replace(/\/$/, '');
  return serverBase() + apiBase + path;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
export function api(method, path, body) {
  const opts = applyAuth({ method });
  if (body !== undefined && !(body instanceof Blob)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof Blob) {
    opts.body = body;
  }
  return fetch(apiUrl(path), opts).then(async r => {
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      const err = /** @type {ApiError} */ (new Error((data && data.error) || ('HTTP ' + r.status)));
      err.status = r.status;
      err.body = data;
      throw err;
    }
    return data;
  }, (netErr) => {
    const err = /** @type {ApiError} */ (new Error(navigator.onLine ? 'Network error' : "You're offline. Changes not saved."));
    err.offline = !navigator.onLine;
    err.cause = netErr;
    throw err;
  });
}

export function refreshAuthState() {
  return fetch(apiUrl('/state'), applyAuth({}))
    .then(r => r.ok ? r.json() : null)
    .then(s => { if (s) state.auth = s; renderAuthWidget(); })
    .catch(() => { renderAuthWidget(); });
}

export function renderAuthWidget() {
  // Add in the phone's bar is for someone who can edit.
  refreshTabVisibility();
  const el = document.getElementById('auth-widget');
  if (!el) return;
  if (!state.auth.authenticated) {
    el.innerHTML = '<button id="auth-signin">Sign in</button>';
    document.getElementById('auth-signin').addEventListener('click', openSignInModal);
    return;
  }
  const local = !hasServer();
  // ui.js opens, closes and moves focus through the menu from this markup.
  el.innerHTML =
    '<div class="ui-menu-anchor">' +
      '<button type="button" id="auth-menu-btn" title="Account menu" aria-haspopup="menu" aria-expanded="false" aria-controls="auth-menu">Menu</button>' +
      '<div class="ui-menu ui-menu-end" id="auth-menu" role="menu" aria-labelledby="auth-menu-head" hidden>' +
        (local
          ? '<p class="ui-menu-head" id="auth-menu-head">Local map</p>'
          : '<p class="ui-menu-head" id="auth-menu-head">Signed in as <strong>' + escapeHtml(state.auth.username) + '</strong></p>') +
        menuEntriesHtml(local, true) +
      '</div>' +
    '</div>';
  // Only one floating overlay at a time: opening the menu closes a filter popover.
  /** @type {HTMLElement} */ (document.getElementById('auth-menu-btn')).addEventListener('click', function() {
    closeTransientOverlays();
  });
  /** @type {HTMLElement} */ (document.getElementById('auth-menu')).addEventListener('click', function(e) {
    const action = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('button[data-action]'));
    if (action) runMenuAction(action.dataset.action);
  });
}

// The wide screen's menu and the phone's You sheet list the same entries.
/**
 * @param {boolean} local
 * @param {boolean} [menu] the wide screen's menu, whose entries are menu items
 */
function menuEntriesHtml(local, menu) {
  /** @param {string} action @param {string} label @param {string} [cls] */
  const entry = (action, label, cls) => menu
    ? '<button type="button" class="ui-menu-item' + (cls ? ' ' + cls : '') + '" role="menuitem" data-action="' + action + '">' + label + '</button>'
    : '<button' + (cls ? ' class="' + cls + '"' : '') + ' data-action="' + action + '">' + label + '</button>';
  // Sign out ends the session, so it sits apart from the rest.
  const foot = local
    ? entry('connect', 'Connect to server', menu ? '' : 'auth-menu-foot')
    : entry('signout', 'Sign out', menu ? 'ui-menu-item-danger' : 'auth-menu-foot');
  return entry('settings', 'Settings') +
    (local ? '' : entry('account', 'Account')) +
    (state.auth.is_admin ? entry('admin', 'Admin') : '') +
    (logsEnabled() ? entry('logs', 'Logs') : '') +
    entry('about', 'About') +
    (menu ? '<hr class="ui-menu-sep">' : '') +
    foot;
}

/** @param {string | undefined} action */
function runMenuAction(action) {
  switch (action) {
    case 'catalog-updates': openCatalogBulkUpdateModal(); break;
    case 'settings': openSettingsModal('settings'); break;
    case 'account':  openSettingsModal('account'); break;
    case 'admin':    openSettingsModal('admin'); break;
    case 'logs':     openLogsModal(); break;
    case 'about':    openAboutModal(); break;
    case 'signout':  confirmSignOut(); break;
    case 'connect':  confirmLeaveLocal(); break;
  }
}

/** Whether catalog updates wait for review by someone who can apply them. */
export function catalogUpdatesPending() {
  return !!(state.auth && state.auth.authenticated) && !isReadOnly() && placesWithCatalogUpdates().length > 0;
}

// The You page's gear. A wide screen reviews catalog updates from the chip on
// Places, which a phone has no room for, so the sheet lists them first.
export function openAccountSheet() {
  const local = !hasServer();
  openSheetModal(
    modalHeaderHtml('Settings and account') +
    '<div class="account-sheet">' +
      (catalogUpdatesPending() ? '<button data-action="catalog-updates">Review updates</button>' : '') +
      menuEntriesHtml(local) +
    '</div>',
    function(/** @type {HTMLElement} */ backdrop) {
      backdrop.classList.add('narrow-dialog');
      /** @type {HTMLElement} */ (backdrop.querySelector('.account-sheet')).addEventListener('click', function(e) {
        const action = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('button[data-action]'));
        if (!action) return;
        closeModal();
        runMenuAction(action.dataset.action);
      });
    }
  );
}

function confirmSignOut() {
  return openConfirmModal({
    title: 'Sign out?',
    body: 'You will need to sign in again to edit places, routes, or settings.',
    confirmLabel: 'Sign out',
    danger: true,
  }).then(ok => {
    if (!ok) return;
    const done = function() { setBearerToken(''); clearRecentPicks(); location.reload(); };
    api('POST', '/logout').then(done, done);
  });
}

export function enterLocalMode() {
  setServerless(true);
  // A fresh load takes the local-only branch in startup()/bootApp().
  document.body.classList.remove('signin-only');
  location.reload();
}

function confirmLeaveLocal() {
  return openConfirmModal({
    title: 'Connect to a server?',
    body: 'This leaves local-only mode and returns to the sign-in screen. Your on-device map stays saved and is restored if you switch back to local mode.',
    confirmLabel: 'Connect to a server',
  }).then(ok => {
    if (!ok) return;
    setServerless(false);
    location.reload();
  });
}

export function openAboutModal() {
  const baked = FERD_BAKED_VERSION.indexOf('__FERD') === 0 ? '' : FERD_BAKED_VERSION;
  const version = state.auth.version || baked || 'unknown';
  // In the Android shell the bundled build version (e.g. "1.0.1-dev+177")
  // is the relevant one; split it into a clean version + a muted build line.
  let appVersion = '';
  try {
    if (window.FerdAndroid && typeof window.FerdAndroid.appVersion === 'function') {
      appVersion = window.FerdAndroid.appVersion();
    }
  } catch (e) {}
  let displayVersion = version;
  let buildLabel = '';
  if (appVersion) {
    const plus = appVersion.indexOf('+');
    displayVersion = plus >= 0 ? appVersion.slice(0, plus) : appVersion;
    if (plus >= 0) buildLabel = 'build ' + appVersion.slice(plus + 1);
  }
  const brand = (state.config && state.config.brand) || 'Ferd';
  const overlayCredits = parseOverlays(state.config && /** @type {typeof state.config & { overlays?: unknown }} */ (state.config).overlays)
    .map(ov => ov.attribution).filter(Boolean);
  openSheetModal(
    modalHeaderHtml('About') +
    '<div class="about-body">' +
      '<img class="about-logo" src="/icons/favicon.svg" alt="">' +
      '<div class="about-brand">' + escapeHtml(brand) + '</div>' +
      '<div class="about-version">' + escapeHtml(displayVersion) + '</div>' +
      (buildLabel ? '<div class="about-build">' + escapeHtml(buildLabel) + '</div>' : '') +
      '<div class="about-tagline">Your own map of where you&rsquo;ve been, where you want to go, and the journeys between them.</div>' +
      '<div class="about-links">' +
        '<a href="https://github.com/polybjorn/ferd" target="_blank" rel="noopener">Source</a>' +
        '<span class="about-sep">&middot;</span>' +
        '<a href="https://github.com/polybjorn/ferd/blob/main/LICENSE" target="_blank" rel="noopener">GPL-3.0 license</a>' +
        '<span class="about-sep">&middot;</span>' +
        '<a href="https://github.com/polybjorn/ferd/blob/main/vendor/NOTICES.md" target="_blank" rel="noopener">Third-party notices</a>' +
      '</div>' +
      '<div class="about-credits">' + [TOPO_CREDIT].concat(overlayCredits).join('<br>') + '</div>' +
    '</div>',
    function(backdrop) {
      backdrop.classList.add('narrow-dialog');
    }
  );
}
