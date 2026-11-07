import { escapeHtml, state } from './core.js';
import { applyAuth, isReadOnly } from './server.js';
import { isLocalMode } from './local-mode.js';
import { radioPillsHtml } from './form-fields.js';
import { rebuildMapFilterPanel } from './map-panel.js';
import {
  BASE_LAYER_NAMES, applyControlVisibility, bindRadioPref, featureVisible, getClusterPlaces,
  getDefaultShow, getDefaultTileLayer, getRememberView, getShowExpandButton, getShowField,
  getShowFilterPanel, getShowTilePicker, getShowZoomControls, getUnits, logsAvailable,
  placesAvailable, placesEnabled, refreshTabVisibility, routesAvailable, routesEnabled,
  setFeatureHidden, setFeatureVisible, setPref, zoomControlsKey,
} from './prefs.js';
import { addTilePicker } from './map-layers.js';
import { refreshPlaceMarkerIcons } from './map-markers.js';
import { refreshTrailWeights } from './route-layer.js';
import { syncCountriesOnMap } from './countries.js';
import { refreshOpenPlacePopup } from './route-meta.js';
import { playEnter, playLeave } from './map-actions.js';
import { applyMapFilters, swapPlaceClusterGroup } from './place-layer.js';
import { reloadCatalogCache } from './places-list.js';
import {
  MODES, THEMES, applyTheme, applyTileFilter, getMarkerSizeKey, getPinStyle, getStoredMode,
  getStoredTheme, getTileFilter, getTrailWeightKey,
} from './theme.js';
import { api, apiUrl, refreshAuthState, renderAuthWidget, wireLocalBackup } from './auth.js';
import { openManageCategoriesModal } from './settings-categories.js';
import { openManageRegionsModal } from './settings-regions.js';
import {
  renderAdminCatalog, renderAdminStats, renderAdminUsers, renderSessions, renderTokens,
} from './settings-account.js';
import {
  modalErrorHtml, modalHeaderHtml, openConfirmModal, refreshAreas, refreshPlaces, refreshRoutes,
  uiFieldHtml, uiToggleHtml,
} from './select.js';
import { openFullScreenModal } from './modal.js';
import { wrappedRouter } from './pick-coords.js';

export function deviceLabel(ua) {
  if (!ua) return 'Unknown device';
  const s = ua.toLowerCase();
  if (s.includes('iphone')) return 'iPhone';
  if (s.includes('ipad')) return 'iPad';
  if (s.includes('android')) return 'Android';
  if (s.includes('mac os x') || s.includes('macintosh')) return 'macOS';
  if (s.includes('windows')) return 'Windows';
  if (s.includes('linux')) return 'Linux';
  if (s.startsWith('curl/')) return 'curl';
  return ua.slice(0, 32) + (ua.length > 32 ? '…' : '');
}
export function timeAgo(unixSec) {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 86400 * 30) return Math.floor(d / 86400) + 'd ago';
  const dt = new Date(unixSec * 1000);
  return dt.toISOString().slice(0, 10);
}

const EXPORT_FORMATS = {
  zip: {
    path: '/me/export',
    fallbackName: 'ferd-export.zip',
    mimeType: 'application/zip',
    desc: 'Download your data as a zip.',
  },
  geojson: {
    path: '/me/export.geojson',
    fallbackName: 'ferd.geojson',
    mimeType: 'application/geo+json',
    desc: 'Download places, areas and routes for QGIS and other map tools.',
  },
};

export function openSettingsModal(initialTab) {
  const isAdmin = state.auth.is_admin;
  const local = isLocalMode();
  const regOpen = state.auth.registration_open;
  const theme = getStoredTheme();
  const mode = getStoredMode();
  const pinStyle = getPinStyle();
  const markerSize = getMarkerSizeKey();
  const routeWeight = getTrailWeightKey();
  const tileFilter = getTileFilter();
  const themeLabels = {
    nord: 'Nord',
    solarized: 'Solarized',
    gruvbox: 'Gruvbox',
    catppuccin: 'Catppuccin',
    'rose-pine': 'Rosé Pine',
    'tokyo-night': 'Tokyo Night',
    dracula: 'Dracula'
  };
  openFullScreenModal(
    modalHeaderHtml('Settings') +
    '<div class="modal-tabs" id="settings-tabs">' +
      '<button data-tab="general" class="active">General</button>' +
      '<button data-tab="appearance">Appearance</button>' +
      // Backup lives on its own tab in local-only mode (no server to publish
      // to, so the map's only durable copy is the export zip).
      (local ? '<button data-tab="backup">Backup</button>' : '') +
      // Account (publish/sharing) and Security (sessions/tokens) require a
      // server account; hidden in local-only mode.
      (local ? '' : '<button data-tab="account">Account</button>') +
      (local ? '' : '<button data-tab="security">Security</button>') +
      (isAdmin ? '<button data-tab="admin">Admin</button>' : '') +
    '</div>' +
    '<div data-panel="general">' +
    ((placesAvailable() || routesAvailable()) ?
      '<h3 class="settings-h">Visible features</h3>' +
      '<div class="feature-pills">' +
        (placesAvailable() ?
          '<label class="feature-pill' + (placesEnabled() ? ' active' : '') + '"><input type="checkbox" id="s-feat-places"' + (placesEnabled() ? ' checked' : '') + '>Places</label>'
          : '') +
        (routesAvailable() ?
          '<label class="feature-pill' + (routesEnabled() ? ' active' : '') + '"><input type="checkbox" id="s-feat-routes"' + (routesEnabled() ? ' checked' : '') + '>Routes</label>'
          : '') +
      '</div>' +
      // Secondary surfaces on their own forced second row.
      ((placesEnabled() || routesEnabled() || logsAvailable()) ?
        '<div class="feature-pills">' +
          ((placesEnabled() || routesEnabled()) ?
            '<label class="feature-pill' + (featureVisible('history') ? ' active' : '') + '"><input type="checkbox" id="s-feat-history"' + (featureVisible('history') ? ' checked' : '') + '>History</label>'
            : '') +
          (placesEnabled() ?
            '<label class="feature-pill' + (featureVisible('catalog') ? ' active' : '') + '"><input type="checkbox" id="s-feat-catalog"' + (featureVisible('catalog') ? ' checked' : '') + '>Catalog</label>'
            : '') +
          (logsAvailable() ?
            '<label class="feature-pill' + (featureVisible('logs') ? ' active' : '') + '"><input type="checkbox" id="s-feat-logs"' + (featureVisible('logs') ? ' checked' : '') + '>Logs</label>'
            : '') +
          (placesEnabled() ?
            '<label class="feature-pill' + (featureVisible('countries') ? ' active' : '') + '"><input type="checkbox" id="s-feat-countries"' + (featureVisible('countries') ? ' checked' : '') + '>Visited countries</label>'
            : '') +
        '</div>' +
        // The fill fades out past COUNTRY_MAX_ZOOM, so say why it can look off.
        (placesEnabled() ? '<div class="hint">Visited countries show when zoomed out.</div>' : '')
      : '')
    : '') +
    (!isReadOnly() ?
      '<h3 class="settings-h">Optional fields</h3>' +
      '<div class="feature-pills optional-fields">' +
        [['date', 'Date'], ['image', 'Image'], ['local-name', 'Local name'], ['note', 'Note'], ['rating', 'Rating'], ['tags', 'Tags']]
          .map(([key, label]) =>
            '<label class="feature-pill' + (getShowField(key) ? ' active' : '') + '"><input type="checkbox" data-field="' + key + '"' + (getShowField(key) ? ' checked' : '') + '>' + label + '</label>'
          ).join('') +
      '</div>'
    : '') +
    '<h3 class="settings-h">Units</h3>' +
    radioPillsHtml('units', [['imperial', 'Imperial (mi, ft)'], ['metric', 'Metric (km, m)']], getUnits(), 'radio-segmented') +
    '<h3 class="settings-h">Language</h3>' +
    '<div class="ui-field"><select id="s-language" aria-label="Language" disabled>' +
      '<option value="en" selected>English</option>' +
    '</select></div>' +
    (placesAvailable() && !isReadOnly() ?
      '<h3 class="settings-h">Categories</h3>' +
      '<div class="ui-control-row">' +
        '<p class="ui-hint">Group your places on the map and in the list.</p>' +
        '<button type="button" class="primary" id="s-manage-cats">Manage</button>' +
      '</div>'
    : '') +
    (routesAvailable() && !isReadOnly() ?
      '<h3 class="settings-h">Regions</h3>' +
      '<div class="ui-control-row">' +
        '<p class="ui-hint">Group your routes on the map and in the list.</p>' +
        '<button type="button" class="primary" id="s-manage-regions">Manage</button>' +
      '</div>'
    : '') +
    '</div>' +
    (local ?
      '<div data-panel="backup" hidden>' +
      '<h3 class="settings-h">Export</h3>' +
      '<div class="ui-control-row">' +
        '<p class="ui-hint">Download your data as a zip.</p>' +
        '<button type="button" class="primary" id="s-local-export">Export</button>' +
      '</div>' +
      modalErrorHtml('s-local-export-error') +
      '<h3 class="settings-h">Import</h3>' +
    '<div class="ui-section">' +
    '<p class="ui-hint">Restore from a previous export.</p>' +
    '<div class="radio-row radio-segmented">' +
        '<label><input type="radio" name="local-import-mode" value="merge" checked>Merge</label>' +
        '<label><input type="radio" name="local-import-mode" value="replace">Replace all</label>' +
      '</div>' +
      '<div class="ui-control-row settings-file-row">' +
        '<div class="file-picker">' +
          '<input type="file" id="s-local-import-file" tabindex="-1" accept=".zip,application/zip" class="file-input-hidden">' +
          '<button type="button" class="primary" id="s-local-import-pick">Choose file</button>' +
          '<span class="file-name" id="s-local-import-name">No file selected</span>' +
        '</div>' +
        '<button type="button" class="primary" id="s-local-import-btn">Import</button>' +
      '</div>' +
      modalErrorHtml('s-local-import-error') +
      '<div class="modal-success-box" id="s-local-import-success" hidden></div>' +
      '</div>' +
      '</div>'
      : '') +
    '<div data-panel="appearance" hidden>' +
    '<div class="ui-field-row">' +
      uiFieldHtml('s-theme', 'Theme', '<select id="s-theme">' +
        THEMES.map(v =>
          '<option value="' + v + '"' + (theme === v ? ' selected' : '') + '>' + (themeLabels[v] || v) + '</option>'
        ).join('') +
      '</select>') +
      uiFieldHtml('s-mode', 'Mode', '<select id="s-mode">' +
        MODES.map(v =>
          '<option value="' + v + '"' + (mode === v ? ' selected' : '') + '>' + v.charAt(0).toUpperCase() + v.slice(1) + '</option>'
        ).join('') +
      '</select>') +
    '</div>' +
    '<h3 class="settings-h">Markers and routes</h3>' +
    '<div class="ui-section">' +
      uiFieldHtml('s-pin-style', 'Pin style', '<select id="s-pin-style">' +
        [['dot', 'Dot'], ['tag', 'Flag'], ['pin', 'Pin'], ['ring', 'Ring']].map(([v, l]) =>
          '<option value="' + v + '"' + (pinStyle === v ? ' selected' : '') + '>' + l + '</option>'
        ).join('') +
      '</select>') +
      uiFieldHtml(null, 'Marker size', radioPillsHtml('marker-size', [['small', 'Small'], ['default', 'Default'], ['large', 'Large']], markerSize, 'radio-segmented')) +
      uiFieldHtml(null, 'Route line thickness', radioPillsHtml('route-weight', [['thin', 'Thin'], ['default', 'Default'], ['thick', 'Thick']], routeWeight, 'radio-segmented')) +
      (placesAvailable() ? uiToggleHtml('s-cluster', 'Cluster places', { checked: getClusterPlaces() }) : '') +
    '</div>' +
    '<h3 class="settings-h">Default map visibility</h3>' +
    '<div class="toggle-grid">' +
      uiToggleHtml('s-def-visited', 'Visited places', { checked: getDefaultShow('visited') }) +
      uiToggleHtml('s-def-want', 'Planned places', { checked: getDefaultShow('want') }) +
      uiToggleHtml('s-def-completed', 'Completed routes', { checked: getDefaultShow('completed') }) +
      uiToggleHtml('s-def-planned', 'Planned routes', { checked: getDefaultShow('planned') }) +
    '</div>' +
    '<h3 class="settings-h">Map</h3>' +
    '<div class="ui-section">' +
      '<div class="ui-field-row">' +
        uiFieldHtml('s-tile', 'Default tile layer', '<select id="s-tile">' +
          BASE_LAYER_NAMES.map(n =>
          '<option value="' + n + '"' + (getDefaultTileLayer() === n ? ' selected' : '') + '>' + n + '</option>'
        ).join('') +
        '</select>') +
        uiFieldHtml('s-tile-filter', 'Tile style', '<select id="s-tile-filter">' +
          [['none', 'None'], ['contrast', 'Contrast'], ['grayscale', 'Grayscale'], ['muted', 'Muted'], ['sepia', 'Sepia']].map(([v, l]) =>
          '<option value="' + v + '"' + (tileFilter === v ? ' selected' : '') + '>' + l + '</option>'
        ).join('') +
        '</select>') +
      '</div>' +
      uiToggleHtml('s-remember-view', 'Remember last view', { checked: getRememberView() }) +
    '</div>' +
    '<h3 class="settings-h">On-map controls</h3>' +
    '<div class="toggle-grid">' +
      uiToggleHtml('s-tile-picker', 'Tile-layer picker', { checked: getShowTilePicker() }) +
      uiToggleHtml('s-map-filter', 'Filter panel', { checked: getShowFilterPanel() }) +
      uiToggleHtml('s-map-zoom', 'Zoom buttons', { checked: getShowZoomControls() }) +
      uiToggleHtml('s-map-expand', 'Expand button', { checked: getShowExpandButton() }) +
    '</div>' +
    '</div>' +
    '<div data-panel="account" hidden>' +
    ((state.auth.publishing_open || isAdmin) ?
      '<h3 class="settings-h">Public sharing</h3>' +
      '<div>' +
        uiToggleHtml('s-publish', 'Make my map public', { checked: state.auth.published }) +
        '<div id="s-publish-link" class="collapsible' + (state.auth.published ? ' expanded' : '') + '">' +
          '<div class="collapsible-inner">' +
            uiFieldHtml('s-publish-url', 'Public link',
              '<div class="ui-control-row">' +
                '<input type="text" id="s-publish-url" readonly value="' + escapeHtml(location.origin + '/u/' + (state.auth.username || '') + '/') + '">' +
                '<button type="button" class="primary" id="s-publish-copy">Copy</button>' +
              '</div>' +
              '<p class="ui-hint">Anyone with the link gets read-only access.</p>') +
          '</div>' +
        '</div>' +
      '</div>'
    : '') +
    '<h3 class="settings-h">Export</h3>' +
    '<div class="ui-section">' +
    '<div class="radio-row radio-segmented">' +
      '<label><input type="radio" name="export-format" value="zip" checked>Zip</label>' +
      '<label><input type="radio" name="export-format" value="geojson">GeoJSON</label>' +
    '</div>' +
    '<div class="ui-control-row">' +
        '<p class="ui-hint" id="s-export-desc">' + EXPORT_FORMATS.zip.desc + '</p>' +
      '<button type="button" class="primary" id="s-export">Export</button>' +
    '</div>' +
    modalErrorHtml('s-export-error') +
    '</div>' +
    '<h3 class="settings-h">Import</h3>' +
    '<div class="ui-section">' +
    '<p class="ui-hint">Restore from a previous export.</p>' +
    '<div class="radio-row radio-segmented">' +
      '<label><input type="radio" name="import-mode" value="merge" checked>Merge</label>' +
      '<label><input type="radio" name="import-mode" value="replace">Replace all</label>' +
      '<label><input type="radio" name="import-mode" value="prefs">Preferences only</label>' +
    '</div>' +
    '<div class="ui-control-row settings-file-row">' +
        '<div class="file-picker">' +
        '<input type="file" id="s-import-file" tabindex="-1" accept=".zip,application/zip" class="file-input-hidden">' +
        '<button type="button" class="primary" id="s-import-pick">Choose file</button>' +
        '<span class="file-name" id="s-import-name">No file selected</span>' +
      '</div>' +
      '<button type="button" class="primary" id="s-import">Import</button>' +
    '</div>' +
    modalErrorHtml('s-import-error') +
    '<div id="s-import-success" class="modal-success-box" hidden></div>' +
    '</div>' +
    '<h3 class="settings-h">Password</h3>' +
    '<form id="settings-pw-form" class="ui-section">' +
      uiFieldHtml('s-current', 'Current password', '<input type="password" id="s-current" autocomplete="current-password" required>') +
      uiFieldHtml('s-new', 'New password',
        '<input type="password" id="s-new" autocomplete="new-password" required>' +
        '<p class="ui-hint">At least 12 characters.</p>') +
      '<div class="ui-control-row">' +
        '<button type="submit" class="primary" id="s-submit">Change password</button>' +
      '</div>' +
      modalErrorHtml('s-error') +
      '<div class="modal-success" id="s-pw-success" hidden></div>' +
    '</form>' +
    '</div>' +
    '<div data-panel="security" hidden>' +
    '<h3 class="settings-h sessions-h">Active sessions<button type="button" class="sessions-revoke-others" id="s-revoke-others" hidden>Sign out others</button></h3>' +
    '<div id="s-sessions">Loading&hellip;</div>' +
    '<h3 class="settings-h">API tokens</h3>' +
    '<form id="s-token-form" class="ui-section">' +
      '<p class="ui-hint">Bearer tokens for scripts and non-browser clients.</p>' +
      uiFieldHtml('s-token-name', 'Name', '<input type="text" id="s-token-name" maxlength="100" placeholder="e.g. backup script" required>') +
      uiFieldHtml(null, 'Scope', radioPillsHtml('s-token-scope', [['full', 'Full access'], ['readonly', 'Read-only']], 'full', 'radio-segmented')) +
      uiFieldHtml(null, 'Expires', radioPillsHtml('s-token-expiry', [['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['', 'Never']], '365', 'radio-segmented')) +
      '<div class="ui-control-row">' +
        '<button type="submit" class="primary" id="s-token-create">Create token</button>' +
      '</div>' +
      modalErrorHtml('s-token-error') +
      '<div id="s-token-new" class="modal-success-box" hidden></div>' +
    '</form>' +
    '<h3 class="settings-h">Your tokens</h3>' +
    '<div id="s-tokens">Loading&hellip;</div>' +
    '</div>' +
    (isAdmin ?
      '<div data-panel="admin" hidden>' +
      '<h3 class="settings-h">Instance</h3>' +
      '<div class="stats-grid" id="s-admin-stats"><div class="hint" style="grid-column:1/-1">Loading&hellip;</div></div>' +
      '<h3 class="settings-h">Access</h3>' +
      uiToggleHtml('s-reg', 'Allow new users to register', { checked: regOpen }) +
      uiToggleHtml('s-publishing', 'Allow users to publish public maps', { checked: state.auth.publishing_open }) +
      '<h3 class="settings-h">Catalog</h3>' +
      uiToggleHtml('s-catalog-baseline', 'Include shipped catalog', { checked: state.auth.catalog_baseline_open }) +
      '<div id="s-admin-catalog"><div class="hint">Loading&hellip;</div></div>' +
      '<h3 class="settings-h">Users</h3>' +
      '<div id="s-admin-users"><div class="hint">Loading&hellip;</div></div>' +
      '</div>' +
      ''
    : ''),
    function() {
      document.getElementById('settings-pw-form').addEventListener('submit', function(e) {
        e.preventDefault();
        const cur = document.getElementById('s-current').value;
        const nw = document.getElementById('s-new').value;
        const submit = document.getElementById('s-submit');
        submit.disabled = true;
        api('POST', '/change-password', { current_password: cur, new_password: nw })
          .then(() => {
            document.getElementById('s-current').value = '';
            document.getElementById('s-new').value = '';
            submit.disabled = false;
            const okBox = document.getElementById('s-pw-success');
            okBox.textContent = 'Password changed. Other sessions on this account have been signed out.';
            okBox.hidden = false;
            document.getElementById('s-error').classList.remove('visible');
            renderSessions();
          })
          .catch(err => {
            submit.disabled = false;
            const errEl = document.getElementById('s-error');
            errEl.textContent = err.message;
            errEl.classList.add('visible');
            document.getElementById('s-pw-success').hidden = true;
          });
      });
      const reg = document.getElementById('s-reg');
      if (reg) {
        reg.addEventListener('change', function() {
          api('POST', '/settings/registration', { mode: this.checked ? 'open' : 'closed' })
            .then(() => refreshAuthState())
            .catch(err => { alert('Failed: ' + err.message); this.checked = !this.checked; });
        });
      }
      const pubGlobal = document.getElementById('s-publishing');
      if (pubGlobal) {
        pubGlobal.addEventListener('change', function() {
          const wanted = this.checked;
          const apply = () => api('POST', '/admin/settings/publishing', { mode: wanted ? 'open' : 'closed' })
            .then(() => refreshAuthState())
            .then(() => { renderAdminUsers(); renderAdminStats(); })
            .catch(err => { alert('Failed: ' + err.message); this.checked = !wanted; });
          if (wanted) return apply();
          // Closing the gate also force-unpublishes anyone currently public.
          openConfirmModal({
            title: 'Disable publishing',
            body: 'Any currently public maps will be set back to private, and users will not be able to publish new ones. Continue?',
            confirmLabel: 'Disable publishing',
            danger: true,
          }).then(ok => {
            if (!ok) { this.checked = true; return; }
            api('POST', '/admin/unpublish-all').then(apply).catch(err => {
              alert('Failed: ' + err.message);
              this.checked = true;
            });
          });
        });
      }
      if (isAdmin) {
        renderAdminStats();
        renderAdminUsers();
        renderAdminCatalog();
        const baseline = document.getElementById('s-catalog-baseline');
        if (baseline) {
          baseline.addEventListener('change', function() {
            const wanted = this.checked;
            api('POST', '/admin/settings/catalog-baseline', { mode: wanted ? 'open' : 'closed' })
              .then(() => { state.auth.catalog_baseline_open = wanted; state._catalogCache = null; renderAdminCatalog(); reloadCatalogCache(); })
              .catch(err => { alert('Failed: ' + err.message); this.checked = !wanted; });
          });
        }
      }
      const pub = document.getElementById('s-publish');
      const pubLink = document.getElementById('s-publish-link');
      if (pub) {
        pub.addEventListener('change', function() {
          const wanted = this.checked;
          api('POST', '/me/publish', { published: wanted })
            .then(() => {
              if (pubLink) pubLink.classList.toggle('expanded', wanted);
              return refreshAuthState();
            })
            .catch(err => { alert('Failed: ' + err.message); this.checked = !wanted; });
        });
      }
      const pubCopy = document.getElementById('s-publish-copy');
      if (pubCopy) {
        pubCopy.addEventListener('click', function() {
          const input = document.getElementById('s-publish-url');
          if (!input) return;
          const original = this.textContent;
          navigator.clipboard.writeText(input.value).then(() => {
            this.textContent = 'Copied';
            setTimeout(() => { this.textContent = original; }, 1500);
          }).catch(() => {
            input.select();
            document.execCommand('copy');
            this.textContent = 'Copied';
            setTimeout(() => { this.textContent = original; }, 1500);
          });
        });
      }
      if (!isLocalMode()) { renderSessions(); renderTokens(); }
      if (isLocalMode()) wireLocalBackup();
      const tokenForm = document.getElementById('s-token-form');
      if (tokenForm) {
        tokenForm.addEventListener('submit', function(e) {
          e.preventDefault();
          const name = document.getElementById('s-token-name').value.trim();
          const scopeEl = document.querySelector('input[name="s-token-scope"]:checked');
          const scope = scopeEl ? scopeEl.value : 'full';
          const expiryEl = document.querySelector('input[name="s-token-expiry"]:checked');
          const expiryVal = expiryEl ? expiryEl.value : '365';
          const btn = document.getElementById('s-token-create');
          const errEl = document.getElementById('s-token-error');
          const reqBody = { name: name, scope: scope };
          if (expiryVal) reqBody.expires_in_days = parseInt(expiryVal, 10);
          btn.disabled = true;
          errEl.classList.remove('visible');
          api('POST', '/me/tokens', reqBody).then(res => {
            btn.disabled = false;
            document.getElementById('s-token-name').value = '';
            const box = document.getElementById('s-token-new');
            box.innerHTML = '<div style="margin-bottom:var(--ui-space-2)">Token created. Copy it now, you won\'t see it again.</div>' +
              '<div style="display:flex;align-items:center;gap:var(--ui-space-2)">' +
                '<input type="text" id="s-token-value" readonly value="' + escapeHtml(res.token) + '" style="flex:1;font-size:var(--ui-text-xs)">' +
                '<button type="button" class="primary" id="s-token-copy" style="flex:0 0 auto">Copy</button>' +
              '</div>';
            box.hidden = false;
            document.getElementById('s-token-copy').addEventListener('click', function() {
              const input = document.getElementById('s-token-value');
              const original = this.textContent;
              const done = () => { this.textContent = 'Copied'; setTimeout(() => { this.textContent = original; }, 1500); };
              navigator.clipboard.writeText(input.value).then(done).catch(() => { input.select(); document.execCommand('copy'); done(); });
            });
            renderTokens();
          }).catch(err => {
            btn.disabled = false;
            errEl.textContent = err.message;
            errEl.classList.add('visible');
          });
        });
      }
      const themeSel = document.getElementById('s-theme');
      if (themeSel) themeSel.addEventListener('change', function() {
        setPref('theme', this.value);
        applyTheme(this.value, getStoredMode());
      });
      const modeSel = document.getElementById('s-mode');
      if (modeSel) modeSel.addEventListener('change', function() {
        setPref('mode', this.value);
        applyTheme(getStoredTheme(), this.value);
      });
      const pinSel = document.getElementById('s-pin-style');
      if (pinSel) pinSel.addEventListener('change', function() {
        setPref('pin-style', this.value);
        refreshPlaceMarkerIcons();
      });
      bindRadioPref('marker-size', 'marker-size', refreshPlaceMarkerIcons);
      bindRadioPref('route-weight', 'route-weight', refreshTrailWeights);
      const tfSel = document.getElementById('s-tile-filter');
      if (tfSel) tfSel.addEventListener('change', function() {
        setPref('tile-filter', this.value);
        applyTileFilter(this.value);
      });
      ['places', 'routes'].forEach(function(feat) {
        const cb = document.getElementById('s-feat-' + feat);
        if (!cb) return;
        cb.addEventListener('change', function() {
          setFeatureHidden(feat, !this.checked);
          const pill = this.closest('.feature-pill');
          if (pill) pill.classList.toggle('active', this.checked);
          refreshTabVisibility();
          // Keep the menu's mobile Places/Routes section in sync.
          renderAuthWidget();
          // Layer groups are pre-built; apply visibility in place to avoid
          // tearing down the map (which would blink while Settings is open).
          // Also rebuild the filter panel so its tab row drops/adds the
          // feature.
          if (state.currentMap) { applyMapFilters(); rebuildMapFilterPanel(); }
          else wrappedRouter();
        });
      });
      // Secondary surfaces (menu items + the Add modal's Browse tab). These
      // don't touch the map, so just persist, refresh the menu so History/
      // Logs appear/disappear, and bail out of History if it's being hidden
      // while open.
      ['history', 'catalog', 'logs', 'countries'].forEach(function(feat) {
        const cb = document.getElementById('s-feat-' + feat);
        if (!cb) return;
        cb.addEventListener('change', function() {
          setFeatureVisible(feat, this.checked);
          const pill = this.closest('.feature-pill');
          if (pill) pill.classList.toggle('active', this.checked);
          renderAuthWidget();
          if (feat === 'history') refreshTabVisibility();
          if (feat === 'countries') syncCountriesOnMap();
          if (feat === 'history' && !this.checked && (location.hash || '').startsWith('#/history')) {
            location.hash = '#/';
          }
        });
      });
      const tileSel = document.getElementById('s-tile');
      if (tileSel) tileSel.addEventListener('change', function() {
        setPref('tile-layer', this.value);
        wrappedRouter();
      });
      [['s-cluster', 'cluster-places'], ['s-remember-view', 'remember-view'], ['s-tile-picker', 'tile-picker'], ['s-map-filter', 'map-filter'], ['s-map-zoom', zoomControlsKey()], ['s-map-expand', 'map-expand']].forEach(function([id, key]) {
        const cb = document.getElementById(id);
        if (!cb) return;
        cb.addEventListener('change', function() {
          setPref(key, this.checked ? 'true' : 'false');
          const pill = this.closest('.feature-pill');
          if (pill) pill.classList.toggle('active', this.checked);
          if (key === 'remember-view') {
            // Pure persistence preference: only affects save/load on the
            // next navigation, no current-view rebuild needed.
            if (!this.checked) {
              try { localStorage.removeItem('last-view'); } catch {}
            }
            return;
          }
          if (key === 'cluster-places') {
            swapPlaceClusterGroup();
            return;
          }
          // Tile-picker is a pure on-map control add/remove; no need to
          // rebuild the map (which causes a visible blink).
          if (key === 'tile-picker') {
            if (state.currentMap && state.tilePickerLayers) {
              if (this.checked && !state.tilePickerCtrl) {
                const ctrl = addTilePicker(state.currentMap);
                state.tilePickerCtrl = ctrl;
                playEnter(ctrl.getContainer(), 'tile-pick-enter');
              } else if (!this.checked && state.tilePickerCtrl) {
                const ctrl = state.tilePickerCtrl;
                state.tilePickerCtrl = null;
                playLeave(ctrl.getContainer(), 'tile-pick-leave', () => state.currentMap.removeControl(ctrl));
              }
            }
            return;
          }
          // Filter panel + zoom + expand controls hide via body classes; no map work.
          if (key === 'map-filter' || key === zoomControlsKey() || key === 'map-expand') {
            applyControlVisibility();
            return;
          }
          wrappedRouter();
        });
      });
      // Units only affect formatting (distance/elevation in popups + detail view).
      // No need to tear down the map — the next render naturally picks up the
      // new units. Avoiding wrappedRouter here removes the modal-open blink.
      // Status default toggles: persist the durable default + update the
      // in-session state so the next map navigation reflects it.
      [['s-def-visited', 'visited', 'showVisited'], ['s-def-want', 'want', 'showWant'],
       ['s-def-completed', 'completed', 'showCompleted'], ['s-def-planned', 'planned', 'showPlanned']
      ].forEach(function([id, status, stateKey]) {
        const cb = document.getElementById(id);
        if (!cb) return;
        cb.addEventListener('change', function() {
          setPref('default-show-' + status, this.checked ? 'true' : 'false');
          state[stateKey] = this.checked;
        });
      });
      bindRadioPref('units', 'units');
      const manageCats = document.getElementById('s-manage-cats');
      if (manageCats) manageCats.addEventListener('click', openManageCategoriesModal);
      const manageRegions = document.getElementById('s-manage-regions');
      if (manageRegions) manageRegions.addEventListener('click', openManageRegionsModal);
      document.querySelectorAll('.feature-pill input[data-field]').forEach(cb => {
        cb.addEventListener('change', function() {
          setPref('show-' + this.dataset.field, this.checked ? 'true' : 'false');
          const pill = this.closest('.feature-pill');
          if (pill) pill.classList.toggle('active', this.checked);
          // The toggle affects displayed cards (place + route lists), map
          // popups, and the route detail page. Refresh the view under the
          // settings modal so the change is visible immediately. Skip the
          // home-map case: rebuilding the map for a popup-only effect is
          // wasted work, and refreshOpenPlacePopup catches any open one.
          const hash = location.hash || '#/';
          if (hash.startsWith('#/places') || hash.startsWith('#/routes')) {
            if (typeof wrappedRouter === 'function') wrappedRouter();
          } else {
            if (typeof refreshOpenPlacePopup === 'function') refreshOpenPlacePopup();
          }
        });
      });
      const exportFormat = () =>
        EXPORT_FORMATS[document.querySelector('input[name="export-format"]:checked').value];
      document.querySelectorAll('input[name="export-format"]').forEach(input => {
        input.addEventListener('change', function() {
          document.getElementById('s-export-desc').textContent = exportFormat().desc;
        });
      });
      const exportBtn = document.getElementById('s-export');
      if (exportBtn) exportBtn.addEventListener('click', function() {
        const format = exportFormat();
        const errBox = document.getElementById('s-export-error');
        errBox.classList.remove('visible');
        exportBtn.disabled = true;
        fetch(apiUrl(format.path), applyAuth({})).then(async r => {
          if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
            throw new Error(msg);
          }
          const disp = r.headers.get('Content-Disposition') || '';
          const m = /filename="([^"]+)"/.exec(disp);
          const fname = m ? m[1] : format.fallbackName;
          const blob = await r.blob();
          // In the Android shell, hand the bytes to native (which opens the
          // system "Save to..." picker); WebView silently drops blob/anchor
          // downloads. The bridge is absent in browsers/PWA, which keep the
          // anchor-download path below.
          if (window.FerdAndroid && typeof window.FerdAndroid.exportFile === 'function') {
            await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error('Could not read export'));
              reader.onloadend = () => {
                const b64 = String(reader.result).split(',')[1] || '';
                window.FerdAndroid.exportFile(fname, blob.type || format.mimeType, b64);
                resolve();
              };
              reader.readAsDataURL(blob);
            });
            return;
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fname;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        }).catch(err => {
          errBox.textContent = err.message;
          errBox.classList.add('visible');
        }).finally(() => {
          exportBtn.disabled = false;
        });
      });
      const revokeOthersBtn = document.getElementById('s-revoke-others');
      if (revokeOthersBtn) revokeOthersBtn.addEventListener('click', function() {
        const btn = this;
        openConfirmModal({
          title: 'Sign out other sessions?',
          body: 'This signs out every other browser and device signed in to this account. Your current session stays active, and any API tokens are unaffected.',
          confirmLabel: 'Sign out others',
          danger: true,
        }).then(ok => {
          if (!ok) return;
          btn.disabled = true;
          api('POST', '/sessions/revoke-others')
            .then(renderSessions)
            .catch(err => { alert('Failed: ' + err.message); })
            .finally(() => { btn.disabled = false; });
        });
      });
      const pickBtn = document.getElementById('s-import-pick');
      const fileInputEl = document.getElementById('s-import-file');
      const fileNameEl = document.getElementById('s-import-name');
      if (pickBtn) pickBtn.addEventListener('click', function() { fileInputEl.click(); });
      if (fileInputEl) fileInputEl.addEventListener('change', function() {
        const f = this.files && this.files[0];
        if (f) {
          fileNameEl.textContent = f.name;
          fileNameEl.classList.add('has-file');
        } else {
          fileNameEl.textContent = 'No file selected';
          fileNameEl.classList.remove('has-file');
        }
        const successEl = document.getElementById('s-import-success');
        if (successEl) successEl.hidden = true;
      });
      const importBtn = document.getElementById('s-import');
      if (importBtn) importBtn.addEventListener('click', function() {
        const fileInput = document.getElementById('s-import-file');
        const errBox = document.getElementById('s-import-error');
        const file = fileInput.files && fileInput.files[0];
        errBox.classList.remove('visible');
        if (!file) {
          errBox.textContent = 'Choose a zip file first.';
          errBox.classList.add('visible');
          return;
        }
        const mode = document.querySelector('input[name="import-mode"]:checked').value;
        const runImport = function() {
        const originalLabel = importBtn.textContent;
        importBtn.disabled = true;
        importBtn.textContent = 'Importing…';
        fetch(apiUrl('/me/import?mode=' + mode), applyAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        })).then(async r => {
          const data = await r.json().catch(() => null);
          if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
          return data;
        }).then(data => {
          const c = data.imported || {};
          const successEl = document.getElementById('s-import-success');
          const parts = [];
          if (c.places) parts.push(c.places + ' places');
          if (c.areas)  parts.push(c.areas  + ' areas');
          if (c.gpx)    parts.push(c.gpx    + ' routes');
          successEl.textContent = parts.length
            ? 'Imported ' + parts.join(', ') + '.'
            : 'Nothing was imported.';
          successEl.hidden = false;
          fileInputEl.value = '';
          fileNameEl.textContent = 'No file selected';
          fileNameEl.classList.remove('has-file');
          Promise.all([refreshPlaces(), refreshAreas(), refreshRoutes()]).then(() => { wrappedRouter(); });
          importBtn.disabled = false;
          importBtn.textContent = originalLabel;
        }).catch(err => {
          importBtn.disabled = false;
          importBtn.textContent = originalLabel;
          errBox.textContent = err.message;
          errBox.classList.add('visible');
        });
        };
        if (mode === 'replace') {
          openConfirmModal({
            title: 'Replace all?',
            body: 'This replaces all of your current places, routes, and preferences with the contents of the zip. It cannot be undone.',
            confirmLabel: 'Replace', danger: true,
          }).then(ok => { if (ok) runImport(); });
        } else {
          runImport();
        }
      });
      document.querySelectorAll('#settings-tabs button[data-tab]').forEach(b => {
        b.addEventListener('click', function() {
          const tab = this.dataset.tab;
          document.querySelectorAll('#settings-tabs button[data-tab]').forEach(x =>
            x.classList.toggle('active', x.dataset.tab === tab));
          document.querySelectorAll('.modal [data-panel]').forEach(p => {
            p.hidden = p.dataset.panel !== tab;
          });
        });
      });
      if (initialTab) {
        const target = document.querySelector('#settings-tabs button[data-tab="' + initialTab + '"]');
        if (target) target.click();
      }
    }
  );
}
