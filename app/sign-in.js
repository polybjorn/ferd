import { escapeHtml, state } from './core.js';
import { fetchJson, isCrossOrigin, serverBase, setBearerToken, setServerBase } from './server.js';
import { loadSyncedPrefs } from './prefs.js';
import { api, apiUrl, enterLocalMode, refreshAuthState } from './auth.js';
import { modalErrorHtml, modalHeaderHtml, uiFieldHtml } from './select.js';
import { closeModal, openFullScreenModal, showModalError } from './modal.js';
import { bootApp, loadDataAndRender, probeServer } from './main.js';

function signInFormHtml(includeClose) {
  const canRegister = state.auth.registration_open;
  return (includeClose
      ? modalHeaderHtml(null, {titleHtml: '<span id="modal-title">Sign in</span>'})
      : '<h2><span id="modal-title">Sign in</span></h2>') +
    (canRegister
      ? '<div class="modal-tabs" id="auth-tabs">' +
          '<button data-mode="login" class="active">Sign in</button>' +
          '<button data-mode="register">Register</button>' +
        '</div>'
      : '') +
    '<form id="auth-form">' +
      '<div class="ui-section">' +
        uiFieldHtml('auth-username', 'Username',
          '<input type="text" id="auth-username" autocomplete="username" required>') +
        uiFieldHtml('auth-password', 'Password',
          '<input type="password" id="auth-password" autocomplete="current-password" required>' +
          '<p class="ui-hint" id="auth-hint"></p>') +
        '<div id="setup-token-row" hidden>' +
          uiFieldHtml('auth-setup-token', 'Setup token',
            '<input type="text" id="auth-setup-token" autocomplete="off">' +
            '<p class="ui-hint">Required for first registration. Check the API server logs.</p>') +
        '</div>' +
      '</div>' +
      modalErrorHtml('auth-error') +
      '<div class="' + (includeClose ? 'ui-dialog-actions' : 'modal-actions') + '">' +
        '<button type="submit" class="ui-button ui-button-primary" id="auth-submit">Sign in</button>' +
      '</div>' +
    '</form>';
}

function bindSignInForm(opts) {
  let mode = state.auth.has_users ? 'login' : 'register';
  setMode(mode);
  document.querySelectorAll('#auth-tabs button[data-mode]').forEach(b => {
    b.addEventListener('click', function() { setMode(this.dataset.mode); });
  });
  document.getElementById('auth-form').addEventListener('submit', function(e) {
    e.preventDefault();
    submit();
  });
  document.getElementById('auth-username').focus();

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#auth-tabs button[data-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === m);
    });
    document.getElementById('modal-title').textContent = m === 'register' ? 'Register' : 'Sign in';
    document.getElementById('auth-submit').textContent = m === 'register' ? 'Register' : 'Sign in';
    document.getElementById('auth-password').setAttribute('autocomplete', m === 'register' ? 'new-password' : 'current-password');
    const hint = document.getElementById('auth-hint');
    hint.textContent = m === 'register' ? 'Password must be at least 12 characters.' : '';
    hint.hidden = m !== 'register';
    const tokenRow = document.getElementById('setup-token-row');
    const tokenInput = document.getElementById('auth-setup-token');
    const needsToken = m === 'register' && state.auth.requires_setup_token;
    tokenRow.hidden = !needsToken;
    if (tokenInput) tokenInput.required = needsToken;
  }
  function submit() {
    const u = document.getElementById('auth-username').value.trim();
    const p = document.getElementById('auth-password').value;
    const payload = { username: u, password: p };
    if (mode === 'register' && state.auth.requires_setup_token) {
      payload.setup_token = document.getElementById('auth-setup-token').value.trim();
    }
    // Cross-origin clients can't use the session cookie, so ask for the
    // session token in the response body and store it for bearer auth.
    if (isCrossOrigin()) payload.token = true;
    const submitBtn = document.getElementById('auth-submit');
    submitBtn.disabled = true;
    api('POST', '/' + mode, payload)
      .then(res => { if (res && res.session_token) setBearerToken(res.session_token); })
      .then(() => refreshAuthState())
      .then(() => loadSyncedPrefs())
      .then(() => { if (opts.onSuccess) return opts.onSuccess(); })
      .catch(err => { submitBtn.disabled = false; showModalError(err.message); });
  }
}

export function openSignInModal() {
  openFullScreenModal(signInFormHtml(true), function() {
    bindSignInForm({ onSuccess: () => { closeModal(); return loadDataAndRender(); } });
  });
}

// Normalize a user-entered server address into an origin (+ optional path)
// base with no trailing slash, or null if it isn't a usable address. https
// is assumed when no scheme is typed; plain http is allowed (common for LAN
// self-hosting) but the picker warns that the session token then travels
// unencrypted. Only http(s) schemes are accepted.
function normalizeServerUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

// First-run / reconnect screen for picking which Ferd server to talk to.
// Shown when there's no same-origin API (bundled/native shell) or the
// configured server is unreachable. opts.error preseeds an error message.
export function renderServerPicker(opts) {
  opts = opts || {};
  const app = document.getElementById('app');
  document.body.classList.add('signin-only');
  const current = serverBase();
  app.innerHTML =
    '<div class="signin-page">' +
      '<img class="signin-logo" src="/icons/favicon.svg" alt="">' +
      '<div class="signin-brand">Ferd</div>' +
      '<div class="modal">' +
        '<h2>Connect to a server</h2>' +
        '<div class="modal-desc">Enter the address of your Ferd server.</div>' +
        '<div class="modal-error' + (opts.error ? ' visible' : '') + '" id="srv-error">' + escapeHtml(opts.error || '') + '</div>' +
        uiFieldHtml('srv-url', 'Server address',
          '<input type="url" id="srv-url" inputmode="url" autocomplete="url" placeholder="https://ferd.example.com" value="' + escapeHtml(current) + '">') +
        '<div class="srv-warn" id="srv-warn" hidden>Unencrypted connection (http). Your sign-in token will be sent in clear text. Only connect over a network you trust.</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="primary" id="srv-connect">Connect</button>' +
        '</div>' +
        '<div class="signin-alt"><button type="button" id="srv-local">Continue without signing in</button></div>' +
      '</div>' +
    '</div>';
  const localBtn = document.getElementById('srv-local');
  if (localBtn) localBtn.addEventListener('click', enterLocalMode);
  const input = document.getElementById('srv-url');
  const errBox = document.getElementById('srv-error');
  const warn = document.getElementById('srv-warn');
  const btn = document.getElementById('srv-connect');
  function fail(msg) {
    errBox.textContent = msg;
    errBox.classList.add('visible');
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
  function syncWarn() {
    const base = normalizeServerUrl(input.value);
    warn.hidden = !(base && base.slice(0, 7) === 'http://');
  }
  function connect() {
    const base = normalizeServerUrl(input.value);
    if (!base) return fail('Enter a valid server address.');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    errBox.classList.remove('visible');
    probeServer(base, 8000).then(function(ok) {
      if (!ok) return fail("Couldn't reach a Ferd server at that address.");
      // A new target invalidates any token minted by the old one.
      if (base !== current) setBearerToken('');
      setServerBase(base);
      document.body.classList.remove('signin-only');
      bootApp();
    });
  }
  btn.addEventListener('click', connect);
  input.addEventListener('keydown', function(e) { if (e.key === 'Enter') connect(); });
  input.addEventListener('input', syncWarn);
  syncWarn();
  input.focus();
}

export function renderSignInPage() {
  const app = document.getElementById('app');
  document.body.classList.add('signin-only');
  const brand = (state.config && state.config.brand) || 'Ferd';
  app.innerHTML =
    '<div class="signin-page">' +
      '<img class="signin-logo" src="/icons/favicon.svg" alt="">' +
      '<div class="signin-brand">' + escapeHtml(brand) + '</div>' +
      '<div class="modal">' +
        signInFormHtml(false) +
        '<div id="signin-public-maps" hidden></div>' +
        '<div class="signin-alt"><button type="button" id="signin-local">Continue without signing in</button></div>' +
      '</div>' +
    '</div>';
  const signinLocalBtn = document.getElementById('signin-local');
  if (signinLocalBtn) signinLocalBtn.addEventListener('click', enterLocalMode);
  // In cross-origin mode (native/bundled shell) let the user retarget the
  // server from the sign-in screen. Tucked into the Sign in button row so
  // it reads as a status footnote, not a competing action.
  if (isCrossOrigin()) {
    const actions = app.querySelector('#auth-form .modal-actions');
    if (actions) {
      // Host on its own centered row below the buttons.
      const host = document.createElement('div');
      host.className = 'signin-server-host';
      host.title = serverBase();
      host.textContent = serverBase().replace(/^https?:\/\//, '');
      actions.parentNode.insertBefore(host, actions.nextSibling);
      // Change server pushed left of the actions row; Sign in stays right.
      const changeBtn = document.createElement('button');
      changeBtn.type = 'button';
      changeBtn.id = 'signin-change-server';
      changeBtn.className = 'signin-change-server';
      changeBtn.textContent = 'Change server';
      changeBtn.addEventListener('click', function() {
        document.body.classList.remove('signin-only');
        renderServerPicker({});
      });
      actions.insertBefore(changeBtn, actions.firstChild);
    }
  }
  bindSignInForm({ onSuccess: () => {
    document.body.classList.remove('signin-only');
    return loadDataAndRender();
  } });
  // Surface any published maps as a collapsible list inside the
  // sign-in card. Starts collapsed so the card stays compact even
  // with a long roster; the toggle button shows the count.
  fetchJson(apiUrl('/public-maps'), { usernames: [] }).then(function(resp) {
    const names = (resp && resp.usernames) || [];
    if (!names.length) return;
    const box = document.getElementById('signin-public-maps');
    if (!box) return;
    box.hidden = false;
    box.innerHTML =
      '<button type="button" class="signin-public-toggle" aria-expanded="false">' +
        '<span>Public maps (' + names.length + ')</span>' +
        '<span class="signin-public-chevron" aria-hidden="true">&#x25BC;</span>' +
      '</button>' +
      '<div class="collapsible" id="signin-public-collapsible">' +
        '<div class="collapsible-inner">' +
          '<div class="public-maps-list">' +
            names.map(u =>
              '<a class="public-maps-item" href="/u/' + encodeURIComponent(u) + '/">' + escapeHtml(u) + '</a>'
            ).join('') +
          '</div>' +
        '</div>' +
      '</div>';
    const toggle = box.querySelector('.signin-public-toggle');
    const list = document.getElementById('signin-public-collapsible');
    toggle.addEventListener('click', function() {
      const expanded = list.classList.toggle('expanded');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.classList.toggle('expanded', expanded);
    });
  });
}
