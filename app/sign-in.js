import { state } from './core.js';
import { fetchJson, isCrossOrigin, serverBase, setBearerToken, setServerBase } from './server.js';
import { loadSyncedPrefs } from './prefs.js';
import { api, apiUrl, enterLocalMode, refreshAuthState } from './auth.js';
import { closeModal } from './modal.js';
import { bootApp, loadDataAndRender, probeServer } from './main.js';
import { t } from './i18n.js';
import { DialogHead, ErrorBox, Field, html, mountPage, openViewModal, useEffect, useRef, useState } from './view.js';

/**
 * The `/api/public-maps` response.
 * @typedef {object} PublicMaps
 * @property {string[]} usernames
 */

/**
 * The `POST /api/login` and `/api/register` response. The token fields come
 * only when the request asked for `token: true`.
 * @typedef {object} SignInResult
 * @property {string} username
 * @property {boolean} is_admin
 * @property {string} [session_token]
 * @property {'Bearer'} [token_type]
 */

/** @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.target).value;

// The sign-in form, in a dialog (inDialog) or on the sign-in page. On the
// page, a cross-origin client also gets a way to change server.
/** @param {{ inDialog?: boolean, onSuccess: () => unknown }} props */
function SignInForm({ inDialog, onSuccess }) {
  const canRegister = !!state.auth.registration_open;
  const [mode, setMode] = useState(state.auth.has_users ? 'login' : 'register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** @type {{current: HTMLInputElement | null}} */
  const usernameRef = useRef(null);
  useEffect(() => { if (usernameRef.current) usernameRef.current.focus(); }, []);

  const register = mode === 'register';
  const needsToken = register && !!state.auth.requires_setup_token;
  const title = register ? t('signIn.register') : t('signIn.signIn');

  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    const payload = /** @type {{ username: string, password: string, setup_token?: string, token?: boolean }} */ ({ username: username.trim(), password });
    if (needsToken) payload.setup_token = setupToken.trim();
    // Cross-origin clients can't use the session cookie, so ask for the
    // session token in the response body and store it for bearer auth.
    if (isCrossOrigin()) payload.token = true;
    setBusy(true);
    setError('');
    api('POST', '/' + mode, payload)
      .then((/** @type {SignInResult} */ res) => { if (res && res.session_token) setBearerToken(res.session_token); })
      .then(() => refreshAuthState())
      .then(() => loadSyncedPrefs())
      .then(() => onSuccess())
      .catch(err => { setBusy(false); setError(err.message); });
  };

  const tabs = canRegister && html`<div class="ui-tabs" id="auth-tabs">
      ${['login', 'register'].map(m => html`<button type="button" class="ui-tab" data-mode=${m} aria-pressed=${String(mode === m)}
        onClick=${() => setMode(m)}>${m === 'register' ? t('signIn.register') : t('signIn.signIn')}</button>`)}
    </div>`;
  const fields = html`<div class="ui-section">
      <${Field} id="auth-username" label=${t('signIn.username')}>
        <input type="text" id="auth-username" autocomplete="username" required ref=${usernameRef}
          value=${username} onInput=${(/** @type {Event} */ e) => setUsername(valueOf(e))} />
      <//>
      <${Field} id="auth-password" label=${t('signIn.password')}>
        <input type="password" id="auth-password" autocomplete=${register ? 'new-password' : 'current-password'} required
          value=${password} onInput=${(/** @type {Event} */ e) => setPassword(valueOf(e))} />
        <p class="ui-hint" id="auth-hint" hidden=${!register}>${register ? t('signIn.passwordHint') : ''}</p>
      <//>
      <div id="setup-token-row" hidden=${!needsToken}>
        <${Field} id="auth-setup-token" label=${t('signIn.setupToken')}>
          <input type="text" id="auth-setup-token" autocomplete="off" required=${needsToken}
            value=${setupToken} onInput=${(/** @type {Event} */ e) => setSetupToken(valueOf(e))} />
          <p class="ui-hint">${t('signIn.setupTokenHint')}</p>
        <//>
      </div>
    </div>
    <${ErrorBox} id="auth-error" msg=${error} />`;
  const submitButton = html`<button type="submit" class="ui-button ui-button-primary" id="auth-submit" disabled=${busy}>${title}</button>`;

  if (inDialog) {
    return html`<${DialogHead} title=${title} />
      <form id="auth-form" onSubmit=${submit}>
        <div class="ui-dialog-body">${tabs}${fields}</div>
        <div class="ui-dialog-actions">${submitButton}</div>
      </form>`;
  }
  // In cross-origin mode (native/bundled shell) let the user retarget the
  // server from the sign-in screen: Change server sits left of Sign in, and
  // the host on its own centered row below, so it reads as a status footnote.
  const cross = isCrossOrigin();
  return html`<h2>${title}</h2>
    ${tabs}
    <form id="auth-form" onSubmit=${submit}>
      ${fields}
      <div class="form-actions">
        ${cross && html`<button type="button" id="signin-change-server" class="ui-button signin-change-server"
          onClick=${() => { document.body.classList.remove('signin-only'); renderServerPicker({}); }}>${t('signIn.changeServer')}</button>`}
        ${submitButton}
      </div>
      ${cross && html`<div class="signin-server-host" title=${serverBase()}>${serverBase().replace(/^https?:\/\//, '')}</div>`}
    </form>`;
}

export function openSignInModal() {
  openViewModal(html`<${SignInForm} inDialog onSuccess=${() => { closeModal(); return loadDataAndRender(); }} />`, { phone: 'fullscreen' });
}

// Normalize a user-entered server address into an origin (+ optional path)
// base with no trailing slash, or null if it isn't a usable address. https
// is assumed when no scheme is typed; plain http is allowed (common for LAN
// self-hosting) but the picker warns that the session token then travels
// unencrypted. Only http(s) schemes are accepted.
/** @param {string | null | undefined} raw */
function normalizeServerUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** @param {{ brand: string, localId: string, children?: any }} props */
function SignInShell({ brand, localId, children }) {
  return html`<div class="signin-page">
    <img class="signin-logo" src="/icons/favicon.svg" alt="" width="64" height="64" />
    <h1 class="signin-brand">${brand}</h1>
    <div class="signin-card">
      ${children}
      <div class="signin-alt"><button type="button" id=${localId} onClick=${enterLocalMode}>${t('signIn.continueLocal')}</button></div>
    </div>
  </div>`;
}

/** @param {{ error: string }} props */
function ServerPicker({ error: initialError }) {
  const current = serverBase();
  const [url, setUrl] = useState(current);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  /** @type {{current: HTMLInputElement | null}} */
  const inputRef = useRef(null);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  const parsed = normalizeServerUrl(url);
  const insecure = !!parsed && parsed.slice(0, 7) === 'http://';

  const connect = () => {
    const base = normalizeServerUrl(url);
    if (!base) { setError(t('server.invalid')); return; }
    setBusy(true);
    setError('');
    probeServer(base, 8000).then(function(ok) {
      if (!ok) { setBusy(false); setError(t('server.unreachable')); return; }
      // A new target invalidates any token minted by the old one.
      if (base !== current) setBearerToken('');
      setServerBase(base);
      document.body.classList.remove('signin-only');
      bootApp();
    });
  };

  return html`<h2>${t('server.title')}</h2>
    <div class="ui-section">
      <${Field} id="srv-url" label=${t('server.address')}>
        <input type="url" id="srv-url" inputmode="url" autocomplete="url" placeholder=${t('server.addressPlaceholder')} ref=${inputRef}
          value=${url} onInput=${(/** @type {Event} */ e) => setUrl(valueOf(e))}
          onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') connect(); }} />
        <p class="ui-hint">${t('server.addressHint')}</p>
        <p class="srv-warn" id="srv-warn" hidden=${!insecure}>${t('server.insecure')}</p>
      <//>
    </div>
    <${ErrorBox} id="srv-error" msg=${error} />
    <div class="form-actions">
      <button type="button" class="ui-button ui-button-primary" id="srv-connect" disabled=${busy} onClick=${connect}>
        ${busy ? t('server.connecting') : t('server.connect')}</button>
    </div>`;
}

// A key per render, so a page shown again starts from fresh state rather
// than keeping a busy button or an old error.
let mounts = 0;

// First-run / reconnect screen for picking which Ferd server to talk to.
// Shown when there's no same-origin API (bundled/native shell) or the
// configured server is unreachable. opts.error preseeds an error message.
/** @param {{ error?: string }} [opts] */
export function renderServerPicker(opts) {
  document.body.classList.add('signin-only');
  mountPage(html`<${SignInShell} brand="Ferd" localId="srv-local" key=${++mounts}>
    <${ServerPicker} error=${(opts && opts.error) || ''} />
  <//>`);
}

// Published maps as a collapsible list inside the sign-in card. Starts
// collapsed so the card stays compact even with a long roster; the toggle
// shows the count.
function PublicMaps() {
  const [names, setNames] = useState(/** @type {string[]} */ ([]));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fetchJson(apiUrl('/public-maps'), /** @type {PublicMaps} */ ({ usernames: [] }))
      .then(resp => setNames((resp && resp.usernames) || []));
  }, []);
  return html`<div id="signin-public-maps" hidden=${!names.length}>
    ${names.length > 0 && html`<button type="button" class="signin-public-toggle" aria-expanded=${open ? 'true' : 'false'}
        aria-controls="signin-public-collapsible" onClick=${() => setOpen(!open)}>
        <span>${t('signIn.publicMaps', { count: names.length })}</span>
        <span class="signin-public-chevron" aria-hidden="true">▼</span>
      </button>
      <div class=${'ui-collapse' + (open ? ' open' : '')} id="signin-public-collapsible">
        <div class="ui-collapse-body"><div class="collapse-inner">
          <div class="public-maps-list">
            ${names.map((/** @type {string} */ u) => html`<a class="ui-list-item public-maps-item" href=${'/u/' + encodeURIComponent(u) + '/'}>${u}</a>`)}
          </div>
        </div></div>
      </div>`}
  </div>`;
}

export function renderSignInPage() {
  document.body.classList.add('signin-only');
  const brand = (state.config && state.config.brand) || 'Ferd';
  const onSuccess = () => {
    document.body.classList.remove('signin-only');
    return loadDataAndRender();
  };
  mountPage(html`<${SignInShell} brand=${brand} localId="signin-local" key=${++mounts}>
    <${SignInForm} onSuccess=${onSuccess} />
    <${PublicMaps} />
  <//>`);
}
