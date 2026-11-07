import { escapeHtml, state } from './core.js';
import { applyAuth, isReadOnly, serverBase, setBearerToken } from './server.js';
import { isLocalMode, setLocalMode } from './local-mode.js';
import { clearRecentPicks, logsEnabled } from './prefs.js';
import { TOPO_CREDIT, parseOverlays } from './map-layers.js';
import { closeTransientOverlays } from './map-actions.js';
import { openCatalogBulkUpdateModal, placesWithCatalogUpdates } from './places-list.js';
import { openSettingsModal } from './settings.js';
import { openLogsModal } from './settings-logs.js';
import { modalHeaderHtml, openConfirmModal } from './select.js';

/**
 * An Error thrown by an API call: `status` and `body` from a non-2xx reply,
 * `offline` when the request never reached the server.
 * @typedef {Error & { status?: number, body?: any, offline?: boolean }} ApiError
 */
import { openSheetModal } from './modal.js';
import { openSignInModal } from './sign-in.js';

export function apiUrl(path) {
  const apiBase = (state.config.api_base || '/api').replace(/\/$/, '');
  return serverBase() + apiBase + path;
}

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

// A phone shows Menu as a round button over the content, with only the icon.
const MENU_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/></svg>';

export function renderAuthWidget() {
  const el = document.getElementById('auth-widget');
  if (!el) return;
  if (!state.auth.authenticated) {
    el.innerHTML = '<button id="auth-signin">Sign in</button>';
    document.getElementById('auth-signin').addEventListener('click', openSignInModal);
    return;
  }
  const local = isLocalMode();
  el.innerHTML =
    '<button id="auth-menu-btn" title="Account menu" aria-haspopup="true" aria-expanded="false">' + MENU_ICON + '<span class="auth-menu-label">Menu</span></button>' +
    '<div class="auth-menu" id="auth-menu" hidden>' +
      (local
        ? '<div class="auth-menu-header">Local map<strong>No account</strong></div>'
        : '<div class="auth-menu-header">Signed in as<strong>' + escapeHtml(state.auth.username) + '</strong></div>') +
      '<button class="auth-menu-mobile" data-action="catalog-updates" id="menu-catalog-updates" hidden>Review updates</button>' +
      '<button data-action="settings">Settings</button>' +
      (local ? '' : '<button data-action="account">Account</button>') +
      (state.auth.is_admin ? '<button data-action="admin">Admin</button>' : '') +
      (logsEnabled() ? '<button data-action="logs">Logs</button>' : '') +
      '<button data-action="about">About</button>' +
      (local
        ? '<button class="auth-menu-foot" data-action="connect">Connect to server</button>'
        : '<button class="auth-menu-foot" data-action="signout">Sign out</button>') +
    '</div>';
  const btn = document.getElementById('auth-menu-btn');
  const menu = document.getElementById('auth-menu');
  // Outside-click closer is added on open and removed on close. We use the
  // capture phase because Leaflet stops propagation on map-container clicks,
  // which would otherwise leave the menu open when clicking the map.
  function outsideCloser(ev) {
    if (!el.contains(ev.target)) closeMenu();
  }
  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outsideCloser, true);
    document.removeEventListener('touchstart', outsideCloser, true);
  }
  /** @type {HTMLElement & { _close?: () => void }} */ (menu)._close = closeMenu;
  function openMenu() {
    closeTransientOverlays(menu);
    // Refresh the mobile catalog-updates entry from the live pending count.
    const updItem = /** @type {HTMLElement | null} */ (menu.querySelector('#menu-catalog-updates'));
    if (updItem) {
      const hasUpd = (state.auth.authenticated && !isReadOnly()) && placesWithCatalogUpdates().length > 0;
      updItem.hidden = !hasUpd;
    }
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outsideCloser, true);
    document.addEventListener('touchstart', outsideCloser, true);
  }
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  menu.addEventListener('click', function(e) {
    const action = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('button[data-action]'));
    if (!action) return;
    closeMenu();
    switch (action.dataset.action) {
      case 'catalog-updates': openCatalogBulkUpdateModal(); break;
      case 'settings': openSettingsModal('settings'); break;
      case 'account':  openSettingsModal('account'); break;
      case 'admin':    openSettingsModal('admin'); break;
      case 'logs':     openLogsModal(); break;
      case 'about':    openAboutModal(); break;
      case 'signout':  confirmSignOut(); break;
      case 'connect':  confirmLeaveLocal(); break;
    }
  });
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
  setLocalMode(true);
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
    setLocalMode(false);
    location.reload();
  });
}

function openAboutModal() {
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
  const overlayCredits = parseOverlays(state.config && state.config.overlays)
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
