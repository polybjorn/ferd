import { localLogClear, localLogPage } from '../store.js';
import { hasServer } from '../server.js';
import { api } from '../auth.js';
import { t, tx } from '../i18n.js';
import { openConfirmModal } from '../select.js';
import { DialogHead, html, openViewModal, useEffect, useState } from '../view.js';
import { timeAgo } from './settings.js';

const name = text => html`<span class="log-name">${text}</span>`;

// What a log row says and its detail line. Server events have an actor;
// the local activity log is one device and has none.
function formatLogRow(r) {
  const d = r.details || {};
  const actor = r.actor ? name(r.actor) : html`<span class="log-name muted">${t('logs.anon')}</span>`;
  const target = r.target ? name(r.target) : '';
  const reason = d.reason === 'no_such_user' ? t('logs.unknownUser')
               : d.reason === 'bad_password' ? t('logs.wrongPassword')
               : (d.reason || '').replace(/_/g, ' ');
  const open = mode => mode === 'open';
  let msg, detail = '';
  switch (r.action) {
    case 'auth.login_success':
      msg = tx('logs.signedIn', { actor });
      detail = d.ip || '';
      break;
    case 'auth.login_failure':
      msg = tx('logs.failedSignIn', { target: target || html`<span class="log-name muted">${t('logs.unknown')}</span>` });
      detail = [reason, d.ip].filter(Boolean).join(' · ');
      break;
    case 'auth.register':
      msg = tx(d.first_user ? 'logs.registeredFirst' : 'logs.registered', { actor });
      detail = d.ip || '';
      break;
    case 'user.publish_toggle':
      msg = tx(d.published ? 'logs.madePublic' : 'logs.madePrivate', { actor });
      break;
    case 'user.import':
      msg = tx('logs.imported', { actor, places: d.places || 0, gpx: d.gpx || 0 });
      detail = t('logs.mode', { mode: d.mode });
      break;
    case 'admin.user_role_change':
      msg = tx(d.is_admin ? 'logs.promoted' : 'logs.demoted', { actor, target });
      break;
    case 'admin.user_force_unpublish':
      msg = tx('logs.forceUnpublished', { actor, target });
      break;
    case 'admin.user_revoke_sessions':
      msg = tx('logs.revokedSessions', { actor, target, count: d.removed || 0 });
      break;
    case 'admin.user_delete':
      msg = tx('logs.userDeleted', { actor, target });
      detail = d.cleanup_warning || '';
      break;
    case 'admin.unpublish_all':
      msg = tx('logs.unpublishedAll', { actor });
      detail = t('logs.usersAffected', { count: d.affected || 0 });
      break;
    case 'admin.publishing_gate':
      msg = tx(open(d.mode) ? 'logs.publishingOpened' : 'logs.publishingClosed', { actor });
      break;
    case 'admin.registration_gate':
      msg = tx(open(d.mode) ? 'logs.registrationOpened' : 'logs.registrationClosed', { actor });
      break;
    case 'admin.logs_clear':
      msg = tx('logs.logsCleared', { actor });
      break;
    case 'place.create': msg = tx('logs.placeCreated', { target }); break;
    case 'place.update': msg = tx('logs.placeUpdated', { target }); break;
    case 'place.delete': msg = tx('logs.placeDeleted', { target }); break;
    case 'place.clear_category': msg = tx('logs.categoryCleared', { target }); break;
    case 'area.create': msg = tx('logs.areaCreated', { target }); break;
    case 'area.update': msg = tx('logs.areaUpdated', { target }); break;
    case 'area.delete': msg = tx('logs.areaDeleted', { target }); break;
    case 'route.create':
      msg = tx('logs.routeCreated', { target });
      detail = d.region ? t('logs.inRegion', { region: d.region }) : '';
      break;
    case 'route.update': msg = tx('logs.routeUpdated', { target }); break;
    case 'route.delete': msg = tx('logs.routeDeleted', { target }); break;
    case 'route.complete': msg = tx('logs.routeCompleted', { target }); break;
    case 'route.plan': msg = tx('logs.routePlanned', { target }); break;
    case 'route.move':
      msg = tx('logs.routeMoved', { target });
      detail = d.from ? t('logs.fromRegion', { region: d.from }) : '';
      break;
    case 'region.rename':
      msg = d.from ? tx('logs.regionRenamed', { from: name(d.from), target }) : tx('logs.regionRenamedTo', { target });
      break;
    case 'region.clear': msg = tx('logs.regionCleared', { target }); break;
    case 'local.import':
      msg = tx('logs.localImported', { places: d.places || 0, gpx: d.gpx || 0 });
      detail = d.mode ? t('logs.mode', { mode: d.mode }) : '';
      break;
    default:
      msg = r.actor ? tx('logs.otherBy', { action: r.action, actor }) : r.action;
      try { detail = JSON.stringify(d); } catch (_) {}
  }
  return { msg, detail };
}

function LogRow({ r }) {
  const { msg, detail } = formatLogRow(r);
  return html`<li class=${'log-row' + (r.action === 'auth.login_failure' ? ' log-fail' : '')}>
    <div class="log-head">
      <span class="log-msg">${msg}</span>
      <span class="log-time" title=${new Date(r.ts * 1000).toISOString()}>${timeAgo(r.ts)}</span>
    </div>
    ${detail && html`<div class="log-details">${detail}</div>`}
  </li>`;
}

// `version` reloads from the newest event, which the Clear button bumps.
// "Load older" adds the next page below.
function LogList({ local, version }) {
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [status, setStatus] = useState('loading');
  const [more, setMore] = useState(false);
  const load = beforeId => {
    const append = beforeId != null;
    const source = local ? localLogPage(beforeId)
      : api('GET', '/admin/logs?limit=100' + (append ? '&before_id=' + beforeId : ''));
    return source.then(data => {
      setRows(prev => (append ? (prev || []) : []).concat(data.logs || []));
      setNext(data.next_before_id || null);
      setStatus('ok');
    }).catch(() => { if (!append) setStatus('error'); })
      .finally(() => setMore(false));
  };
  useEffect(() => { load(null); }, [version]);
  const loadOlder = () => { setMore(true); load(next); };
  let body;
  if (status === 'loading') body = html`<div class="hint">${t('common.loading')}</div>`;
  else if (status === 'error') body = html`<div class="hint">${t('logs.couldNotLoad')}</div>`;
  else if (!rows.length) body = html`<div class="hint">${t('logs.none')}</div>`;
  else body = html`
    <ul class="log-list">${rows.map(r => html`<${LogRow} key=${r.id} r=${r} />`)}</ul>
    ${next && html`<button type="button" class="log-more" disabled=${more} onClick=${loadOlder}>${t('logs.loadOlder')}</button>`}`;
  return html`<div id="s-admin-logs">${body}</div>`;
}

function LogsView({ local }) {
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const clear = () => {
    openConfirmModal({
      title: t(local ? 'logs.clearActivity' : 'logs.clearAudit'),
      body: t('logs.clearBody'),
      confirmLabel: t('logs.clearAll'),
      danger: true,
    }).then(ok => {
      if (!ok) return;
      setBusy(true);
      (local ? localLogClear() : api('DELETE', '/admin/logs'))
        .then(() => setVersion(n => n + 1))
        .catch(err => alert(t('common.failed', { message: err.message })))
        .then(() => setBusy(false));
    });
  };
  return html`
    <${DialogHead} title=${t(local ? 'logs.activityTitle' : 'logs.auditTitle')} />
    <div class="ui-dialog-body">
      <${LogList} local=${local} version=${version} />
    </div>
    <div class="ui-dialog-actions">
      <button type="button" id="s-logs-clear" class="ui-button ui-button-danger" disabled=${busy} onClick=${clear}>${t('logs.clearAll')}</button>
    </div>`;
}

export function openLogsModal() {
  openViewModal(html`<${LogsView} local=${!hasServer()} />`, { phone: 'fullscreen' });
}
