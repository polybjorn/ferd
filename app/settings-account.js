import { escapeHtml, state } from './core.js';
import { localLogPage } from './device-cache.js';
import { isLocalMode } from './local-mode.js';
import { api } from './auth.js';
import { deviceLabel, timeAgo } from './settings.js';
import { openCatalogManager, openCatalogPicker } from './settings-catalog.js';
import { openConfirmModal } from './select.js';

export function renderSessions() {
  const el = document.getElementById('s-sessions');
  if (!el) return;
  api('GET', '/sessions').then(data => {
    const others = data.sessions ? data.sessions.filter(s => !s.current) : [];
    const revokeOthersBtn = document.getElementById('s-revoke-others');
    if (revokeOthersBtn) revokeOthersBtn.hidden = others.length === 0;
    if (!data.sessions || !data.sessions.length) {
      el.innerHTML = '<div class="hint">No sessions.</div>';
      return;
    }
    el.innerHTML = '<ul class="session-list">' + data.sessions.map(s => {
      const label = escapeHtml(deviceLabel(s.user_agent));
      const ip = s.ip ? escapeHtml(s.ip) : '?';
      const ago = escapeHtml(timeAgo(s.last_seen_at || s.created_at));
      const current = s.current ? '<span class="session-current">This device</span>' : '';
      const revoke = s.current ? '' : '<button class="session-revoke" data-id="' + escapeHtml(s.id) + '">Revoke</button>';
      const sub = s.current ? ip : (ip + ' &middot; ' + ago);
      return '<li class="session-row">' +
        '<div class="session-meta">' +
          '<div class="session-device">' + label + ' ' + current + '</div>' +
          '<div class="session-sub">' + sub + '</div>' +
        '</div>' +
        revoke +
      '</li>';
    }).join('') + '</ul>';
    el.querySelectorAll('.session-revoke').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        this.disabled = true;
        api('POST', '/sessions/revoke', { id: id })
          .then(renderSessions)
          .catch(err => { this.disabled = false; alert('Failed: ' + err.message); });
      });
    });
  }).catch(() => {
    el.innerHTML = '<div class="hint">Could not load sessions.</div>';
  });
}

export function renderTokens() {
  const el = document.getElementById('s-tokens');
  if (!el) return;
  api('GET', '/me/tokens').then(data => {
    const tokens = data.tokens || [];
    if (!tokens.length) {
      el.innerHTML = '<div class="hint">No tokens.</div>';
      return;
    }
    el.innerHTML = '<ul class="session-list">' + tokens.map(t => {
      const name = escapeHtml(t.name);
      const scope = t.scope === 'readonly' ? 'Read-only' : 'Full access';
      const used = t.last_used_at ? ('used ' + escapeHtml(timeAgo(t.last_used_at))) : 'never used';
      const exp = t.expires_at
        ? (' &middot; expires ' + new Date(t.expires_at * 1000).toISOString().slice(0, 10))
        : ' &middot; no expiry';
      return '<li class="session-row">' +
        '<div class="session-meta">' +
          '<div class="session-device">' + name + '</div>' +
          '<div class="session-sub">' + scope + ' &middot; ' + used + exp + '</div>' +
        '</div>' +
        '<button class="session-revoke" data-id="' + escapeHtml(t.id) + '">Revoke</button>' +
      '</li>';
    }).join('') + '</ul>';
    el.querySelectorAll('.session-revoke').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const self = this;
        openConfirmModal({
          title: 'Revoke token',
          body: 'Any client using this token stops working immediately.',
          confirmLabel: 'Revoke',
          danger: true,
        }).then(ok => {
          if (!ok) return;
          self.disabled = true;
          api('POST', '/me/tokens/revoke', { id: id })
            .then(renderTokens)
            .catch(err => { self.disabled = false; alert('Failed: ' + err.message); });
        });
      });
    });
  }).catch(() => {
    el.innerHTML = '<div class="hint">Could not load tokens.</div>';
  });
}

function formatBytes(n) {
  if (!n || n < 1024) return (n || 0) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

export function renderAdminStats() {
  const el = document.getElementById('s-admin-stats');
  if (!el) return;
  api('GET', '/admin/stats').then(s => {
    const tiles = [
      ['Users', s.users],
      ['Published', s.published_users],
      ['Places', s.places],
      ['Routes', s.routes],
      ['Files', formatBytes(s.data_bytes)],
      ['Database', formatBytes(s.db_bytes)],
    ];
    el.innerHTML = tiles.map(([lbl, v]) =>
      '<div class="stat-card"><div class="stat-val">' + escapeHtml(String(v)) + '</div>' +
      '<div class="stat-lbl">' + escapeHtml(lbl) + '</div></div>'
    ).join('');
  }).catch(() => {
    el.innerHTML = '<div class="hint" style="grid-column:1/-1">Could not load stats.</div>';
  });
}

export function renderAdminUsers() {
  const el = document.getElementById('s-admin-users');
  if (!el) return;
  api('GET', '/admin/users').then(data => {
    const users = data.users || [];
    if (!users.length) {
      el.innerHTML = '<div class="hint">No users.</div>';
      return;
    }
    const meName = state.auth.username;
    // Sort: current user first, then other admins, then everyone else by id.
    users.sort((a, b) => {
      if (a.username === meName) return -1;
      if (b.username === meName) return 1;
      if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1;
      return a.id - b.id;
    });
    const admins = users.filter(u => u.is_admin);
    const members = users.filter(u => !u.is_admin);
    const renderRow = u => {
      const isSelf = u.username === meName;
      return '<li class="user-row' + (isSelf ? ' self' : '') + '" data-uid="' + u.id + '" data-uname="' + escapeHtml(u.username) + '">' +
        '<span class="user-name">' +
          escapeHtml(u.username) +
          (u.published ? '<span class="user-flag on">Public</span>' : '') +
        '</span>' +
        '<div class="user-actions">' +
          (u.published ? '<button data-act="unpublish">Unpublish</button>' : '') +
          (u.sessions ? '<button data-act="revoke">Revoke</button>' : '') +
          (isSelf ? '' : '<button data-act="role" data-promote="' + (u.is_admin ? '0' : '1') + '">' + (u.is_admin ? 'Demote' : 'Promote') + '</button>') +
          (isSelf ? '' : '<button data-act="delete" class="danger-btn">Delete</button>') +
        '</div>' +
        '<div class="user-counts">' +
          '<span><b>' + u.sessions + '</b>sessions</span>' +
          '<span><b>' + u.places + '</b>places</span>' +
          '<span><b>' + u.routes + '</b>routes</span>' +
        '</div>' +
      '</li>';
    };
    let html = '';
    if (admins.length) {
      html += '<div class="user-group-h">Admins</div>' +
        '<ul class="user-list">' + admins.map(renderRow).join('') + '</ul>';
    }
    if (members.length) {
      html += '<div class="user-group-h">Members</div>' +
        '<ul class="user-list">' + members.map(renderRow).join('') + '</ul>';
    }
    el.innerHTML = html;
    el.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleAdminUserAction(btn));
    });
  }).catch(() => {
    el.innerHTML = '<div class="hint">Could not load users.</div>';
  });
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

export function renderAdminCatalog() {
  const el = document.getElementById('s-admin-catalog');
  if (!el) return;
  api('GET', '/catalog').then(entries => {
    const list = Array.isArray(entries) ? entries : [];
    const n = list.length;
    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:var(--ui-space-2)">' +
        '<span class="modal-desc" style="margin:0;flex:1">Places users can import.</span>' +
        (n ? '<button type="button" class="primary" id="s-catalog-manage">Manage</button>' : '') +
        '<button type="button" class="primary" id="s-catalog-add">Add</button>' +
      '</div>';
    const manage = document.getElementById('s-catalog-manage');
    if (manage) manage.addEventListener('click', openCatalogManager);
    const add = document.getElementById('s-catalog-add');
    if (add) add.addEventListener('click', openCatalogPicker);
  }).catch(() => {
    el.innerHTML = '<div class="hint">Could not load catalog.</div>';
  });
}

function handleAdminUserAction(btn) {
  const row = btn.closest('.user-row');
  const uid = row.dataset.uid;
  const uname = row.dataset.uname;
  const act = btn.dataset.act;
  const refresh = () => { renderAdminUsers(); renderAdminStats(); };
  const fail = err => alert('Failed: ' + err.message);
  if (act === 'unpublish') {
    openConfirmModal({
      title: 'Force unpublish ' + uname,
      body: uname + '\'s map will no longer be reachable at the public URL. They can republish if global publishing is on.',
      confirmLabel: 'Unpublish',
    }).then(ok => {
      if (!ok) return;
      btn.disabled = true;
      api('POST', '/admin/users/' + uid + '/unpublish').then(refresh).catch(fail);
    });
  } else if (act === 'revoke') {
    openConfirmModal({
      title: 'Revoke sessions for ' + uname,
      body: 'Signs ' + uname + ' out on every device they are currently signed in on.',
      confirmLabel: 'Revoke',
    }).then(ok => {
      if (!ok) return;
      btn.disabled = true;
      api('POST', '/admin/users/' + uid + '/revoke-sessions').then(refresh).catch(fail);
    });
  } else if (act === 'role') {
    const promote = btn.dataset.promote === '1';
    openConfirmModal({
      title: (promote ? 'Promote ' : 'Demote ') + uname,
      body: promote
        ? uname + ' will get full admin access, including this Admin tab and the ability to delete other users.'
        : uname + ' will lose admin access on their next request.',
      confirmLabel: promote ? 'Promote' : 'Demote',
    }).then(ok => {
      if (!ok) return;
      btn.disabled = true;
      api('POST', '/admin/users/' + uid + '/role', { is_admin: promote }).then(refresh).catch(fail);
    });
  } else if (act === 'delete') {
    openConfirmModal({
      title: 'Delete user ' + uname,
      body: 'Permanently removes ' + uname + ', all their sessions, and their data folder (places, routes, preferences). This cannot be undone.',
      confirmLabel: 'Delete user',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      btn.disabled = true;
      api('DELETE', '/admin/users/' + uid).then(resp => {
        if (resp && resp.cleanup_warning) {
          alert('User deleted, but data folder cleanup incomplete: ' + resp.cleanup_warning);
        }
        refresh();
      }).catch(fail);
    });
  }
}
