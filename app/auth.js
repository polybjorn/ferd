import { render } from 'preact';
import { state } from './core.js';
import { applyAuth, hasServer, isReadOnly, serverBase, setBearerToken, setServerless } from './server.js';
import { clearRecentPicks, logsEnabled, refreshTabVisibility } from './prefs.js';
import { loadMap } from './map/load.js';
import { openCatalogBulkUpdateModal, placesWithCatalogUpdates } from './places-list.js';
import { openLogsModal, openSettingsModal } from './lazy-open.js';
import { openConfirmModal } from './select.js';
import { closeModal } from './modal.js';
import { openSignInModal } from './sign-in.js';
import { t, tx } from './i18n.js';
import { DialogHead, html, openViewModal } from './view.js';


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
    /** @type {Record<string, string>} */ (opts.headers)['Content-Type'] = 'application/json';
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
    const err = /** @type {ApiError} */ (new Error(t(navigator.onLine ? 'auth.networkError' : 'auth.offline')));
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
  render(html`<${AuthWidget} />`, el);
}

function AuthWidget() {
  if (!state.auth.authenticated) {
    return html`<button id="auth-signin" onClick=${() => openSignInModal()}>${t('auth.signIn')}</button>`;
  }
  const local = !hasServer();
  // ui.js opens, closes and moves focus through the menu from this markup.
  // Opening the menu also closes an open filter popover (ui.js).
  return html`<div class="ui-menu-anchor">
    <button type="button" id="auth-menu-btn" title=${t('auth.menu')} aria-haspopup="menu" aria-expanded="false" aria-controls="auth-menu">${t('auth.menuButton')}</button>
    <div class="ui-menu ui-menu-end" id="auth-menu" role="menu" aria-labelledby="auth-menu-head" hidden>
      <p class="ui-menu-head" id="auth-menu-head">${local
        ? t('auth.localMap')
        : tx('auth.signedInAs', { name: html`<strong>${state.auth.username}</strong>` })}</p>
      <${MenuEntries} local=${local} menu onPick=${runMenuAction} />
    </div>
  </div>`;
}

// The wide screen's menu and the phone's You sheet list the same entries.
// menu is the wide screen's menu, whose entries are menu items.
/** @param {{ local: boolean, menu?: boolean, onPick: (action: string) => void }} props */
function MenuEntries({ local, menu, onPick }) {
  /** @param {string} action @param {string} label @param {string} [cls] */
  const entry = (action, label, cls) => menu
    ? html`<button type="button" class=${'ui-menu-item' + (cls ? ' ' + cls : '')} role="menuitem" data-action=${action} onClick=${() => onPick(action)}>${label}</button>`
    : html`<button type="button" class=${cls || undefined} data-action=${action} onClick=${() => onPick(action)}>${label}</button>`;
  // Sign out ends the session, so it sits apart from the rest.
  const foot = local
    ? entry('connect', t('auth.connect'), menu ? '' : 'auth-menu-foot')
    : entry('signout', t('auth.signOut'), menu ? 'ui-menu-item-danger' : 'auth-menu-foot');
  return html`${entry('settings', t('auth.settings'))}
    ${!local && entry('account', t('auth.account'))}
    ${state.auth.is_admin && entry('admin', t('auth.admin'))}
    ${logsEnabled() && entry('logs', t('auth.logs'))}
    ${entry('about', t('auth.about'))}
    ${menu && html`<hr class="ui-menu-sep" />`}
    ${foot}`;
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
  const pick = (/** @type {string} */ action) => { closeModal(); runMenuAction(action); };
  const dialog = openViewModal(html`<div class="ui-dialog-handle" aria-hidden="true"></div>
    <${DialogHead} title=${t('auth.sheetTitle')} />
    <div class="ui-dialog-body">
      <div class="account-sheet">
        ${catalogUpdatesPending() && html`<button type="button" data-action="catalog-updates" onClick=${() => pick('catalog-updates')}>${t('auth.reviewUpdates')}</button>`}
        <${MenuEntries} local=${!hasServer()} onPick=${pick} />
      </div>
    </div>`, { phone: 'sheet' });
  dialog.classList.add('narrow-dialog');
}

function confirmSignOut() {
  return openConfirmModal({
    title: t('auth.signOutTitle'),
    body: t('auth.signOutBody'),
    confirmLabel: t('auth.signOut'),
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
    title: t('auth.connectTitle'),
    body: t('auth.connectBody'),
    confirmLabel: t('auth.connectConfirm'),
  }).then(ok => {
    if (!ok) return;
    setServerless(false);
    location.reload();
  });
}

// Names, not wording, so they stay out of the translation tables.
const REPO = 'https://github.com/polybjorn/ferd';
const REPO_HOST = 'GitHub';
const LICENSE = 'GPL-3.0-or-later';
// The libraries a user meets on screen; vendor/NOTICES.md lists every one.
const BUILT_WITH = [
  ['Leaflet', 'https://leafletjs.com'],
  ['Preact', 'https://preactjs.com'],
  ['supercluster', 'https://github.com/mapbox/supercluster'],
  ['leaflet-elevation', 'https://github.com/Raruto/leaflet-elevation'],
  ['Natural Earth', 'https://www.naturalearthdata.com'],
];

export function openAboutModal() {
  // index.html's ferd-version meta, filled in by the static handler; still the
  // placeholder when served without the API.
  const meta = /** @type {HTMLMetaElement | null} */ (document.querySelector('meta[name="ferd-version"]'));
  const metaVersion = meta ? meta.content : '';
  const baked = metaVersion.indexOf('__FERD') === 0 ? '' : metaVersion;
  const version = state.auth.version || baked || t('about.unknownVersion');
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
    if (plus >= 0) buildLabel = t('about.build', { build: appVersion.slice(plus + 1) });
  }
  const brand = (state.config && state.config.brand) || 'Ferd';
  // Map credits are attribution markup from the layers and the site config.
  // The map is already up wherever About is offered; failing that the dialog
  // still opens, without them.
  return loadMap().then(({ map }) => map, () => null).then(map => {
    const overlayCredits = map ? map.parseOverlays(state.config && /** @type {typeof state.config & { overlays?: unknown }} */ (state.config).overlays)
      .map(ov => ov.attribution).filter(Boolean) : [];
    const credits = map ? [map.TOPO_CREDIT].concat(overlayCredits).join('<br>') : '';
    const dialog = openViewModal(html`<div class="ui-dialog-handle" aria-hidden="true"></div>
      <${DialogHead} title=${brand} />
      <div class="ui-dialog-body">
        <dl class="ui-kv about-kv">
          <div class="ui-kv-item">
            <dt class="ui-kv-label">${t('about.version')}</dt>
            <dd class="ui-kv-value">${displayVersion}${buildLabel && html` <span class="about-muted">(${buildLabel})</span>`}</dd>
          </div>
          <div class="ui-kv-item">
            <dt class="ui-kv-label">${t('about.license')}</dt>
            <dd class="ui-kv-value"><a href=${REPO + '/blob/main/LICENSE'} target="_blank" rel="noopener">${LICENSE}</a></dd>
          </div>
          <div class="ui-kv-item">
            <dt class="ui-kv-label">${t('about.source')}</dt>
            <dd class="ui-kv-value"><a href=${REPO} target="_blank" rel="noopener">${REPO_HOST}</a></dd>
          </div>
          <div class="ui-kv-item">
            <dt class="ui-kv-label">${t('about.builtWith')}</dt>
            <dd class="ui-kv-value">
              <ul class="about-list">${BUILT_WITH.map(([name, url]) => html`<li><a href=${url} target="_blank" rel="noopener">${name}</a></li>`)}</ul>
              <a class="about-more" href=${REPO + '/blob/main/vendor/NOTICES.md'} target="_blank" rel="noopener">${t('about.notices')}</a>
            </dd>
          </div>
          ${credits && html`<div class="ui-kv-item">
            <dt class="ui-kv-label">${t('about.mapData')}</dt>
            <dd class="ui-kv-value about-credits" dangerouslySetInnerHTML=${{ __html: credits }}></dd>
          </div>`}
        </dl>
      </div>`, { phone: 'sheet' });
    dialog.classList.add('narrow-dialog');
  });
}
