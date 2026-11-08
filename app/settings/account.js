import { state } from '../core.js';
import { api } from '../auth.js';
import { t } from '../i18n.js';
import { deviceLabel, timeAgo } from './settings.js';
import { openCatalogManager, openCatalogPicker } from './catalog.js';
import { openConfirmModal } from '../select.js';
import { html, useEffect, useFetch, useState } from '../view.js';

/**
 * One entry of `GET /sessions`.
 * @typedef {object} SessionData
 * @property {string} id the session's 12-character prefix, for revoking
 * @property {boolean} current
 * @property {string | null} ip
 * @property {string | null} user_agent
 * @property {number} last_seen_at 0 before the first request after login
 * @property {number} created_at
 * @property {number} expires_at
 */

/**
 * One entry of `GET /me/tokens`. Never carries the secret.
 * @typedef {object} TokenData
 * @property {string} id the token's 12-character prefix, for revoking
 * @property {string} name
 * @property {string} scope
 * @property {number} created_at
 * @property {number | null} last_used_at
 * @property {number | null} expires_at
 */

/**
 * One entry of `GET /admin/users`.
 * @typedef {object} AdminUserData
 * @property {number} id
 * @property {string} username
 * @property {boolean} is_admin
 * @property {boolean} published
 * @property {number} created_at
 * @property {number} sessions
 * @property {number} places
 * @property {number} routes
 */

/**
 * The `GET /admin/stats` response.
 * @typedef {object} AdminStats
 * @property {number} users
 * @property {number} published_users
 * @property {number} places
 * @property {number} routes
 * @property {number} db_bytes
 * @property {number} data_bytes
 */

/**
 * What a row action shows in its confirm dialog, and the call it makes.
 * @typedef {object} UserAction
 * @property {string} title
 * @property {string} body
 * @property {string} confirmLabel
 * @property {boolean} [danger]
 * @property {() => Promise<unknown>} run
 */

/** @param {Error} err */
const failAlert = err => alert(t('common.failed', { message: err.message }));

// `version` comes from Settings, which bumps it after a password change.
/** @param {{ version: number }} props */
export function Sessions({ version }) {
  /** @type {[number, (next: number | ((n: number) => number)) => void]} */
  const [own, setOwn] = useState(0);
  const reload = () => setOwn(n => n + 1);
  const res = useFetch(() => api('GET', '/sessions'), [version, own]);
  const [revoking, setRevoking] = useState(false);
  const sessions = res.status === 'ok' ? res.data.sessions || [] : [];
  const others = sessions.filter((/** @type {SessionData} */ s) => !s.current);
  const revokeOthers = () => {
    openConfirmModal({
      title: t('security.signOutOthersTitle'),
      body: t('security.signOutOthersBody'),
      confirmLabel: t('security.signOutOthers'),
      danger: true,
    }).then(ok => {
      if (!ok) return;
      setRevoking(true);
      api('POST', '/sessions/revoke-others')
        .then(reload)
        .catch(failAlert)
        .finally(() => setRevoking(false));
    });
  };
  let body = t('common.loading');
  if (res.status === 'error') body = html`<div class="hint">${t('security.couldNotLoadSessions')}</div>`;
  else if (res.status === 'ok' && !sessions.length) body = html`<div class="hint">${t('security.noSessions')}</div>`;
  else if (res.status === 'ok') body = html`<ul class="session-list">${sessions.map((/** @type {SessionData} */ s) => html`<${SessionRow} key=${s.id} s=${s} onRevoked=${reload} />`)}</ul>`;
  return html`
    <h3 class="settings-h sessions-h">${t('security.sessions')}<button type="button" class="sessions-revoke-others" id="s-revoke-others" hidden=${!others.length} disabled=${revoking} onClick=${revokeOthers}>${t('security.signOutOthers')}</button></h3>
    <div id="s-sessions">${body}</div>`;
}

/** @param {{ s: SessionData, onRevoked: () => void }} props */
function SessionRow({ s, onRevoked }) {
  const [busy, setBusy] = useState(false);
  const ip = s.ip || '?';
  const revoke = () => {
    setBusy(true);
    api('POST', '/sessions/revoke', { id: s.id })
      .then(onRevoked)
      .catch(err => { setBusy(false); failAlert(err); });
  };
  return html`<li class="session-row">
    <div class="session-meta">
      <div class="session-device">${deviceLabel(s.user_agent)} ${s.current ? html`<span class="session-current">${t('security.thisDevice')}</span>` : ''}</div>
      <div class="session-sub">${s.current ? ip : ip + ' · ' + timeAgo(s.last_seen_at || s.created_at)}</div>
    </div>
    ${s.current ? '' : html`<button class="session-revoke" data-id=${s.id} disabled=${busy} onClick=${revoke}>${t('security.revoke')}</button>`}
  </li>`;
}

// `version` comes from the create form, which bumps it for each new token.
/** @param {{ version: number }} props */
export function Tokens({ version }) {
  /** @type {[number, (next: number | ((n: number) => number)) => void]} */
  const [own, setOwn] = useState(0);
  const reload = () => setOwn(n => n + 1);
  const res = useFetch(() => api('GET', '/me/tokens'), [version, own]);
  if (res.status === 'loading') return html`<div id="s-tokens">${t('common.loading')}</div>`;
  if (res.status === 'error') return html`<div id="s-tokens"><div class="hint">${t('security.couldNotLoadTokens')}</div></div>`;
  const tokens = res.data.tokens || [];
  if (!tokens.length) return html`<div id="s-tokens"><div class="hint">${t('security.noTokens')}</div></div>`;
  return html`<div id="s-tokens"><ul class="session-list">${tokens.map((/** @type {TokenData} */ tok) => html`<${TokenRow} key=${tok.id} tok=${tok} onRevoked=${reload} />`)}</ul></div>`;
}

/** @param {{ tok: TokenData, onRevoked: () => void }} props */
function TokenRow({ tok, onRevoked }) {
  const [busy, setBusy] = useState(false);
  const used = tok.last_used_at ? t('security.used', { ago: timeAgo(tok.last_used_at) }) : t('security.neverUsed');
  const exp = tok.expires_at
    ? t('security.expiresOn', { date: new Date(tok.expires_at * 1000).toISOString().slice(0, 10) })
    : t('security.noExpiry');
  const revoke = () => {
    openConfirmModal({
      title: t('security.revokeTokenTitle'),
      body: t('security.revokeTokenBody'),
      confirmLabel: t('security.revoke'),
      danger: true,
    }).then(ok => {
      if (!ok) return;
      setBusy(true);
      api('POST', '/me/tokens/revoke', { id: tok.id })
        .then(onRevoked)
        .catch(err => { setBusy(false); failAlert(err); });
    });
  };
  return html`<li class="session-row">
    <div class="session-meta">
      <div class="session-device">${tok.name}</div>
      <div class="session-sub">${[t(tok.scope === 'readonly' ? 'security.scopeReadonly' : 'security.scopeFull'), used, exp].join(' · ')}</div>
    </div>
    <button class="session-revoke" data-id=${tok.id} disabled=${busy} onClick=${revoke}>${t('security.revoke')}</button>
  </li>`;
}

/** @param {number | null | undefined} n */
function formatBytes(n) {
  if (!n || n < 1024) return (n || 0) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

/** @param {{ version: number }} props */
export function AdminStats({ version }) {
  const res = useFetch(() => api('GET', '/admin/stats'), [version]);
  let body;
  // Keyed apart from the cards, so the first card is not built from this
  // placeholder and left with its style.
  if (res.status === 'loading') body = html`<div key="hint" class="hint" style="grid-column:1/-1">${t('common.loading')}</div>`;
  else if (res.status === 'error') body = html`<div key="hint" class="hint" style="grid-column:1/-1">${t('admin.couldNotLoadStats')}</div>`;
  else {
    const s = /** @type {AdminStats} */ (res.data);
    body = [
      [t('admin.statUsers'), s.users],
      [t('admin.statPublished'), s.published_users],
      [t('admin.statPlaces'), s.places],
      [t('admin.statRoutes'), s.routes],
      [t('admin.statFiles'), formatBytes(s.data_bytes)],
      [t('admin.statDatabase'), formatBytes(s.db_bytes)],
    ].map(([lbl, v]) => html`<div key=${lbl} class="stat-card"><div class="stat-val">${String(v)}</div><div class="stat-lbl">${lbl}</div></div>`);
  }
  return html`<div class="stats-grid" id="s-admin-stats">${body}</div>`;
}

// `onChanged` reloads the users and the stats, which count them.
/** @param {{ version: number, onChanged: () => void }} props */
export function AdminUsers({ version, onChanged }) {
  const res = useFetch(() => api('GET', '/admin/users'), [version]);
  let body;
  if (res.status === 'loading') body = html`<div class="hint">${t('common.loading')}</div>`;
  else if (res.status === 'error') body = html`<div class="hint">${t('admin.couldNotLoadUsers')}</div>`;
  else if (!(res.data.users || []).length) body = html`<div class="hint">${t('admin.noUsers')}</div>`;
  else {
    const meName = state.auth.username;
    // Current user first, then other admins, then everyone else by id.
    /** @type {AdminUserData[]} */
    const users = [...res.data.users].sort((a, b) => {
      if (a.username === meName) return -1;
      if (b.username === meName) return 1;
      if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1;
      return a.id - b.id;
    });
    /**
     * @param {string} title
     * @param {AdminUserData[]} list
     */
    const group = (title, list) => list.length ? html`
      <div class="user-group-h">${title}</div>
      <ul class="user-list">${list.map(u => html`<${UserRow} key=${u.id} u=${u} isSelf=${u.username === meName} onChanged=${onChanged} />`)}</ul>` : null;
    body = [group(t('admin.admins'), users.filter(u => u.is_admin)), group(t('admin.members'), users.filter(u => !u.is_admin))];
  }
  return html`<div id="s-admin-users">${body}</div>`;
}

// The confirm for each row action, and the call it makes.
/** @type {Record<string, (u: AdminUserData) => UserAction>} */
const USER_ACTIONS = {
  unpublish: u => ({
    title: t('admin.unpublishTitle', { name: u.username }),
    body: t('admin.unpublishBody', { name: u.username }),
    confirmLabel: t('admin.unpublish'),
    run: () => api('POST', '/admin/users/' + u.id + '/unpublish'),
  }),
  revoke: u => ({
    title: t('admin.revokeTitle', { name: u.username }),
    body: t('admin.revokeBody', { name: u.username }),
    confirmLabel: t('admin.revoke'),
    run: () => api('POST', '/admin/users/' + u.id + '/revoke-sessions'),
  }),
  role: u => {
    const promote = !u.is_admin;
    return {
      title: t(promote ? 'admin.promoteTitle' : 'admin.demoteTitle', { name: u.username }),
      body: t(promote ? 'admin.promoteBody' : 'admin.demoteBody', { name: u.username }),
      confirmLabel: t(promote ? 'admin.promote' : 'admin.demote'),
      run: () => api('POST', '/admin/users/' + u.id + '/role', { is_admin: promote }),
    };
  },
  delete: u => ({
    title: t('admin.deleteTitle', { name: u.username }),
    body: t('admin.deleteBody', { name: u.username }),
    confirmLabel: t('admin.deleteConfirm'),
    danger: true,
    run: () => api('DELETE', '/admin/users/' + u.id).then(resp => {
      if (resp && resp.cleanup_warning) {
        alert(t('admin.cleanupWarning', { warning: resp.cleanup_warning }));
      }
    }),
  }),
};

/** @param {{ u: AdminUserData, isSelf: boolean, onChanged: () => void }} props */
function UserRow({ u, isSelf, onChanged }) {
  // A failed action leaves its button disabled until the list reloads.
  /** @type {[string | null, (next: string | null) => void]} */
  const [busy, setBusy] = useState(null);
  useEffect(() => setBusy(null), [u]);
  /** @param {string} name */
  const act = name => {
    const { run, ...confirm } = USER_ACTIONS[name](u);
    openConfirmModal(confirm).then(ok => {
      if (!ok) return;
      setBusy(name);
      run().then(onChanged).catch(failAlert);
    });
  };
  /**
   * @param {string} name
   * @param {string} label
   * @param {Record<string, string>} [extra]
   */
  const button = (name, label, extra) =>
    html`<button data-act=${name} disabled=${busy === name} onClick=${() => act(name)} ...${extra}>${label}</button>`;
  return html`<li class=${'user-row' + (isSelf ? ' self' : '')} data-uid=${u.id} data-uname=${u.username}>
    <span class="user-name">${u.username}${u.published ? html`<span class="user-flag on">${t('admin.public')}</span>` : ''}</span>
    <div class="user-actions">
      ${u.published ? button('unpublish', t('admin.unpublish')) : ''}
      ${u.sessions ? button('revoke', t('admin.revoke')) : ''}
      ${isSelf ? '' : button('role', t(u.is_admin ? 'admin.demote' : 'admin.promote'), { 'data-promote': u.is_admin ? '0' : '1' })}
      ${isSelf ? '' : button('delete', t('admin.delete'), { class: 'danger-btn' })}
    </div>
    <div class="user-counts">
      <span><b>${u.sessions}</b>${t('admin.sessions')}</span>
      <span><b>${u.places}</b>${t('admin.places')}</span>
      <span><b>${u.routes}</b>${t('admin.routes')}</span>
    </div>
  </li>`;
}

// The catalog editors in catalog.js call renderAdminCatalog after a
// change, so the Admin row reloads under them.
/** @type {(() => void) | null} */
let reloadAdminCatalog = null;
export function renderAdminCatalog() {
  if (reloadAdminCatalog) reloadAdminCatalog();
}

export function AdminCatalog() {
  /** @type {[number, (next: number | ((n: number) => number)) => void]} */
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const reload = () => setVersion(n => n + 1);
    reloadAdminCatalog = reload;
    return () => { if (reloadAdminCatalog === reload) reloadAdminCatalog = null; };
  }, []);
  const res = useFetch(() => api('GET', '/catalog'), [version]);
  let body;
  if (res.status === 'loading') body = html`<div class="hint">${t('common.loading')}</div>`;
  else if (res.status === 'error') body = html`<div class="hint">${t('admin.couldNotLoadCatalog')}</div>`;
  else {
    const n = Array.isArray(res.data) ? res.data.length : 0;
    body = html`<div style="display:flex;align-items:center;gap:var(--ui-space-2)">
      <span class="dialog-desc" style="margin:0;flex:1">${t('admin.catalogHint')}</span>
      ${n ? html`<button type="button" class="primary" id="s-catalog-manage" onClick=${openCatalogManager}>${t('common.manage')}</button>` : ''}
      <button type="button" class="primary" id="s-catalog-add" onClick=${openCatalogPicker}>${t('common.add')}</button>
    </div>`;
  }
  return html`<div id="s-admin-catalog">${body}</div>`;
}
