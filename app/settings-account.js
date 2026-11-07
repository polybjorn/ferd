import { escapeHtml, state } from './core.js';
import { localLogPage } from './device-cache.js';
import { isLocalMode } from './local-mode.js';
import { api } from './auth.js';
import { deviceLabel, timeAgo } from './settings.js';
import { openCatalogManager, openCatalogPicker } from './settings-catalog.js';
import { openConfirmModal } from './select.js';
import { html, useEffect, useFetch, useState } from './view.js';

const failAlert = err => alert('Failed: ' + err.message);

// `version` comes from Settings, which bumps it after a password change.
export function Sessions({ version }) {
  const [own, setOwn] = useState(0);
  const reload = () => setOwn(n => n + 1);
  const res = useFetch(() => api('GET', '/sessions'), [version, own]);
  const [revoking, setRevoking] = useState(false);
  const sessions = res.status === 'ok' ? res.data.sessions || [] : [];
  const others = sessions.filter(s => !s.current);
  const revokeOthers = () => {
    openConfirmModal({
      title: 'Sign out other sessions?',
      body: 'This signs out every other browser and device signed in to this account. Your current session stays active, and any API tokens are unaffected.',
      confirmLabel: 'Sign out others',
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
  let body = 'Loading…';
  if (res.status === 'error') body = html`<div class="hint">Could not load sessions.</div>`;
  else if (res.status === 'ok' && !sessions.length) body = html`<div class="hint">No sessions.</div>`;
  else if (res.status === 'ok') body = html`<ul class="session-list">${sessions.map(s => html`<${SessionRow} key=${s.id} s=${s} onRevoked=${reload} />`)}</ul>`;
  return html`
    <h3 class="settings-h sessions-h">Active sessions<button type="button" class="sessions-revoke-others" id="s-revoke-others" hidden=${!others.length} disabled=${revoking} onClick=${revokeOthers}>Sign out others</button></h3>
    <div id="s-sessions">${body}</div>`;
}

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
      <div class="session-device">${deviceLabel(s.user_agent)} ${s.current ? html`<span class="session-current">This device</span>` : ''}</div>
      <div class="session-sub">${s.current ? ip : ip + ' · ' + timeAgo(s.last_seen_at || s.created_at)}</div>
    </div>
    ${s.current ? '' : html`<button class="session-revoke" data-id=${s.id} disabled=${busy} onClick=${revoke}>Revoke</button>`}
  </li>`;
}

// `version` comes from the create form, which bumps it for each new token.
export function Tokens({ version }) {
  const [own, setOwn] = useState(0);
  const reload = () => setOwn(n => n + 1);
  const res = useFetch(() => api('GET', '/me/tokens'), [version, own]);
  if (res.status === 'loading') return html`<div id="s-tokens">Loading…</div>`;
  if (res.status === 'error') return html`<div id="s-tokens"><div class="hint">Could not load tokens.</div></div>`;
  const tokens = res.data.tokens || [];
  if (!tokens.length) return html`<div id="s-tokens"><div class="hint">No tokens.</div></div>`;
  return html`<div id="s-tokens"><ul class="session-list">${tokens.map(t => html`<${TokenRow} key=${t.id} t=${t} onRevoked=${reload} />`)}</ul></div>`;
}

function TokenRow({ t, onRevoked }) {
  const [busy, setBusy] = useState(false);
  const used = t.last_used_at ? 'used ' + timeAgo(t.last_used_at) : 'never used';
  const exp = t.expires_at
    ? ' · expires ' + new Date(t.expires_at * 1000).toISOString().slice(0, 10)
    : ' · no expiry';
  const revoke = () => {
    openConfirmModal({
      title: 'Revoke token',
      body: 'Any client using this token stops working immediately.',
      confirmLabel: 'Revoke',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      setBusy(true);
      api('POST', '/me/tokens/revoke', { id: t.id })
        .then(onRevoked)
        .catch(err => { setBusy(false); failAlert(err); });
    });
  };
  return html`<li class="session-row">
    <div class="session-meta">
      <div class="session-device">${t.name}</div>
      <div class="session-sub">${(t.scope === 'readonly' ? 'Read-only' : 'Full access') + ' · ' + used + exp}</div>
    </div>
    <button class="session-revoke" data-id=${t.id} disabled=${busy} onClick=${revoke}>Revoke</button>
  </li>`;
}

function formatBytes(n) {
  if (!n || n < 1024) return (n || 0) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

export function AdminStats({ version }) {
  const res = useFetch(() => api('GET', '/admin/stats'), [version]);
  let body;
  // Keyed apart from the cards, so the first card is not built from this
  // placeholder and left with its style.
  if (res.status === 'loading') body = html`<div key="hint" class="hint" style="grid-column:1/-1">Loading…</div>`;
  else if (res.status === 'error') body = html`<div key="hint" class="hint" style="grid-column:1/-1">Could not load stats.</div>`;
  else {
    const s = res.data;
    body = [
      ['Users', s.users],
      ['Published', s.published_users],
      ['Places', s.places],
      ['Routes', s.routes],
      ['Files', formatBytes(s.data_bytes)],
      ['Database', formatBytes(s.db_bytes)],
    ].map(([lbl, v]) => html`<div key=${lbl} class="stat-card"><div class="stat-val">${String(v)}</div><div class="stat-lbl">${lbl}</div></div>`);
  }
  return html`<div class="stats-grid" id="s-admin-stats">${body}</div>`;
}

// `onChanged` reloads the users and the stats, which count them.
export function AdminUsers({ version, onChanged }) {
  const res = useFetch(() => api('GET', '/admin/users'), [version]);
  let body;
  if (res.status === 'loading') body = html`<div class="hint">Loading…</div>`;
  else if (res.status === 'error') body = html`<div class="hint">Could not load users.</div>`;
  else if (!(res.data.users || []).length) body = html`<div class="hint">No users.</div>`;
  else {
    const meName = state.auth.username;
    // Current user first, then other admins, then everyone else by id.
    const users = [...res.data.users].sort((a, b) => {
      if (a.username === meName) return -1;
      if (b.username === meName) return 1;
      if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1;
      return a.id - b.id;
    });
    const group = (title, list) => list.length ? html`
      <div class="user-group-h">${title}</div>
      <ul class="user-list">${list.map(u => html`<${UserRow} key=${u.id} u=${u} isSelf=${u.username === meName} onChanged=${onChanged} />`)}</ul>` : null;
    body = [group('Admins', users.filter(u => u.is_admin)), group('Members', users.filter(u => !u.is_admin))];
  }
  return html`<div id="s-admin-users">${body}</div>`;
}

// The confirm for each row action, and the call it makes.
const USER_ACTIONS = {
  unpublish: (u) => ({
    title: 'Force unpublish ' + u.username,
    body: u.username + '\'s map will no longer be reachable at the public URL. They can republish if global publishing is on.',
    confirmLabel: 'Unpublish',
    run: () => api('POST', '/admin/users/' + u.id + '/unpublish'),
  }),
  revoke: (u) => ({
    title: 'Revoke sessions for ' + u.username,
    body: 'Signs ' + u.username + ' out on every device they are currently signed in on.',
    confirmLabel: 'Revoke',
    run: () => api('POST', '/admin/users/' + u.id + '/revoke-sessions'),
  }),
  role: (u) => {
    const promote = !u.is_admin;
    return {
      title: (promote ? 'Promote ' : 'Demote ') + u.username,
      body: promote
        ? u.username + ' will get full admin access, including Admin in the menu and the ability to delete other users.'
        : u.username + ' will lose admin access on their next request.',
      confirmLabel: promote ? 'Promote' : 'Demote',
      run: () => api('POST', '/admin/users/' + u.id + '/role', { is_admin: promote }),
    };
  },
  delete: (u) => ({
    title: 'Delete user ' + u.username,
    body: 'Permanently removes ' + u.username + ', all their sessions, and their data folder (places, routes, preferences). This cannot be undone.',
    confirmLabel: 'Delete user',
    danger: true,
    run: () => api('DELETE', '/admin/users/' + u.id).then(resp => {
      if (resp && resp.cleanup_warning) {
        alert('User deleted, but data folder cleanup incomplete: ' + resp.cleanup_warning);
      }
    }),
  }),
};

function UserRow({ u, isSelf, onChanged }) {
  // A failed action leaves its button disabled until the list reloads.
  const [busy, setBusy] = useState(null);
  useEffect(() => setBusy(null), [u]);
  const act = name => {
    const { run, ...confirm } = USER_ACTIONS[name](u);
    openConfirmModal(confirm).then(ok => {
      if (!ok) return;
      setBusy(name);
      run().then(onChanged).catch(failAlert);
    });
  };
  const button = (name, label, extra) =>
    html`<button data-act=${name} disabled=${busy === name} onClick=${() => act(name)} ...${extra}>${label}</button>`;
  return html`<li class=${'user-row' + (isSelf ? ' self' : '')} data-uid=${u.id} data-uname=${u.username}>
    <span class="user-name">${u.username}${u.published ? html`<span class="user-flag on">Public</span>` : ''}</span>
    <div class="user-actions">
      ${u.published ? button('unpublish', 'Unpublish') : ''}
      ${u.sessions ? button('revoke', 'Revoke') : ''}
      ${isSelf ? '' : button('role', u.is_admin ? 'Demote' : 'Promote', { 'data-promote': u.is_admin ? '0' : '1' })}
      ${isSelf ? '' : button('delete', 'Delete', { class: 'danger-btn' })}
    </div>
    <div class="user-counts">
      <span><b>${u.sessions}</b>sessions</span>
      <span><b>${u.places}</b>places</span>
      <span><b>${u.routes}</b>routes</span>
    </div>
  </li>`;
}

function formatLogRow(r) {
  const d = r.details || {};
  const actor = r.actor ? '<span class="log-name">' + escapeHtml(r.actor) + '</span>' : '<span class="log-name muted">anon</span>';
  const target = r.target ? '<span class="log-name">' + escapeHtml(r.target) + '</span>' : '';
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const reason = d.reason === 'no_such_user' ? 'unknown user'
               : d.reason === 'bad_password' ? 'wrong password'
               : (d.reason || '').replace(/_/g, ' ');
  let msg, detail = '';
  switch (r.action) {
    case 'auth.login_success':
      msg = actor + ' signed in';
      detail = d.ip || '';
      break;
    case 'auth.login_failure':
      msg = 'Failed sign-in for ' + (target || '<span class="log-name muted">unknown</span>');
      detail = [reason, d.ip].filter(Boolean).join(' · ');
      break;
    case 'auth.register':
      msg = actor + ' registered' + (d.first_user ? ' (first user)' : '');
      detail = d.ip || '';
      break;
    case 'user.publish_toggle':
      msg = actor + (d.published ? ' made map public' : ' made map private');
      break;
    case 'user.import':
      msg = actor + ' imported ' + (d.places || 0) + ' places, ' + (d.gpx || 0) + ' routes';
      detail = d.mode + ' mode';
      break;
    case 'admin.user_role_change':
      msg = actor + ' ' + (d.is_admin ? 'promoted ' : 'demoted ') + target;
      break;
    case 'admin.user_force_unpublish':
      msg = actor + ' force-unpublished ' + target;
      break;
    case 'admin.user_revoke_sessions':
      msg = actor + ' revoked ' + plural(d.removed || 0, 'session') + ' for ' + target;
      break;
    case 'admin.user_delete':
      msg = actor + ' deleted ' + target;
      detail = d.cleanup_warning || '';
      break;
    case 'admin.unpublish_all':
      msg = actor + ' force-unpublished all users';
      detail = plural(d.affected || 0, 'user') + ' affected';
      break;
    case 'admin.publishing_gate':
      msg = actor + ' ' + (d.mode === 'open' ? 'opened' : 'closed') + ' publishing';
      break;
    case 'admin.registration_gate':
      msg = actor + ' ' + (d.mode === 'open' ? 'opened' : 'closed') + ' registration';
      break;
    case 'admin.logs_clear':
      msg = actor + ' cleared the audit log';
      break;
    // Local-mode activity log (single device, no actor).
    case 'place.create': msg = 'Added place ' + target; break;
    case 'place.update': msg = 'Edited place ' + target; break;
    case 'place.delete': msg = 'Deleted place ' + target; break;
    case 'place.clear_category': msg = 'Cleared category ' + target; break;
    case 'area.create': msg = 'Added area ' + target; break;
    case 'area.update': msg = 'Edited area ' + target; break;
    case 'area.delete': msg = 'Deleted area ' + target; break;
    case 'route.create': msg = 'Added route ' + target; detail = d.region ? 'in ' + d.region : ''; break;
    case 'route.update': msg = 'Edited route ' + target; break;
    case 'route.delete': msg = 'Deleted route ' + target; break;
    case 'route.complete': msg = 'Marked ' + target + ' completed'; break;
    case 'route.plan': msg = 'Marked ' + target + ' planned'; break;
    case 'route.move': msg = 'Moved route ' + target; detail = d.from ? 'from ' + d.from : ''; break;
    case 'region.rename': msg = 'Renamed region ' + (d.from ? '<span class="log-name">' + escapeHtml(d.from) + '</span> to ' : '') + target; break;
    case 'region.clear': msg = 'Cleared region ' + target; break;
    case 'local.import': msg = 'Imported ' + (d.places || 0) + ' places, ' + (d.gpx || 0) + ' routes'; detail = d.mode ? d.mode + ' mode' : ''; break;
    default:
      msg = escapeHtml(r.action) + (r.actor ? ' by ' + actor : '');
      try { detail = JSON.stringify(d); } catch (_) {}
  }
  return { msg, detail };
}

export function renderAdminLogs(beforeId) {
  const el = document.getElementById('s-admin-logs');
  if (!el) return;
  const append = beforeId != null;
  const qs = '?limit=100' + (beforeId != null ? '&before_id=' + beforeId : '');
  const source = isLocalMode() ? localLogPage(beforeId) : api('GET', '/admin/logs' + qs);
  source.then(data => {
    const logs = data.logs || [];
    if (!append && !logs.length) {
      el.innerHTML = '<div class="hint">No events recorded yet.</div>';
      return;
    }
    const rowHtml = logs.map(r => {
      const isFail = r.action === 'auth.login_failure';
      const parts = formatLogRow(r);
      return '<li class="log-row' + (isFail ? ' log-fail' : '') + '">' +
        '<div class="log-head">' +
          '<span class="log-msg">' + parts.msg + '</span>' +
          '<span class="log-time" title="' + new Date(r.ts * 1000).toISOString() + '">' + timeAgo(r.ts) + '</span>' +
        '</div>' +
        (parts.detail ? '<div class="log-details">' + escapeHtml(parts.detail) + '</div>' : '') +
      '</li>';
    }).join('');
    if (append) {
      const list = el.querySelector('.log-list');
      if (list) list.insertAdjacentHTML('beforeend', rowHtml);
    } else {
      el.innerHTML = '<ul class="log-list">' + rowHtml + '</ul>';
    }
    const oldBtn = el.querySelector('.log-more');
    if (oldBtn) oldBtn.remove();
    if (data.next_before_id) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'log-more';
      btn.textContent = 'Load older';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        renderAdminLogs(data.next_before_id);
      });
      el.appendChild(btn);
    }
  }).catch(() => {
    if (!append) el.innerHTML = '<div class="hint">Could not load logs.</div>';
  });
}

// The catalog editors in settings-catalog.js call renderAdminCatalog after a
// change, so the Admin row reloads under them.
let reloadAdminCatalog = null;
export function renderAdminCatalog() {
  if (reloadAdminCatalog) reloadAdminCatalog();
}

export function AdminCatalog() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const reload = () => setVersion(n => n + 1);
    reloadAdminCatalog = reload;
    return () => { if (reloadAdminCatalog === reload) reloadAdminCatalog = null; };
  }, []);
  const res = useFetch(() => api('GET', '/catalog'), [version]);
  let body;
  if (res.status === 'loading') body = html`<div class="hint">Loading…</div>`;
  else if (res.status === 'error') body = html`<div class="hint">Could not load catalog.</div>`;
  else {
    const n = Array.isArray(res.data) ? res.data.length : 0;
    body = html`<div style="display:flex;align-items:center;gap:var(--ui-space-2)">
      <span class="modal-desc" style="margin:0;flex:1">Places users can import.</span>
      ${n ? html`<button type="button" class="primary" id="s-catalog-manage" onClick=${openCatalogManager}>Manage</button>` : ''}
      <button type="button" class="primary" id="s-catalog-add" onClick=${openCatalogPicker}>Add</button>
    </div>`;
  }
  return html`<div id="s-admin-catalog">${body}</div>`;
}
