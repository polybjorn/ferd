import { state } from '../core.js';
import { applyAuth, hasServer, isReadOnly } from '../server.js';
import { rebuildMapFilterPanel } from '../map-panel.js';
import {
  BASE_LAYER_NAMES, applyControlVisibility, featureVisible, getClusterPlaces,
  getDefaultShow, getDefaultTileLayer, getRememberView, getShowExpandButton, getShowField,
  getShowFilterPanel, getShowTilePicker, getShowZoomControls, getUnits, logsAvailable,
  placesAvailable, placesEnabled, refreshTabVisibility, routesAvailable, routesEnabled,
  setFeatureHidden, setFeatureVisible, setPref, zoomControlsKey,
} from '../prefs.js';
import { addTilePicker } from '../map-layers.js';
import { refreshPlaceMarkerIcons } from '../map-markers.js';
import { refreshTrailWeights } from '../route-layer.js';
import { syncCountriesOnMap } from '../countries.js';
import { refreshOpenPlacePopup } from '../route-meta.js';
import { playEnter, playLeave } from '../map-actions.js';
import { applyMapFilters, swapPlaceClusterGroup } from '../place-layer.js';
import { reloadCatalogCache } from '../places-list.js';
import {
  MODES, THEMES, applyTheme, applyTileFilter, getMarkerSizeKey, getPinStyle, getStoredMode,
  getStoredTheme, getTileFilter, getTrailWeightKey,
} from '../theme.js';
import { api, apiUrl, refreshAuthState, renderAuthWidget } from '../auth.js';
import { t } from '../i18n.js';
import { localBackup } from '../backup.js';
import { openManageCategoriesModal } from './categories.js';
import { openManageRegionsModal } from './regions.js';
import {
  AdminCatalog, AdminStats, AdminUsers, Sessions, Tokens, renderAdminCatalog,
} from './account.js';
import { openConfirmModal } from '../select.js';
import { sync } from '../store.js';
import {
  CopyButton, DialogHead, ErrorBox, Field, RadioPills, Toggle, html, openViewModal, useRef, useState,
} from '../view.js';
import { wrappedRouter } from '../pick-coords.js';

export function deviceLabel(ua) {
  if (!ua) return t('device.unknown');
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
  if (d < 60) return t('time.seconds', { n: d });
  if (d < 3600) return t('time.minutes', { n: Math.floor(d / 60) });
  if (d < 86400) return t('time.hours', { n: Math.floor(d / 3600) });
  if (d < 86400 * 30) return t('time.days', { n: Math.floor(d / 86400) });
  const dt = new Date(unixSec * 1000);
  return dt.toISOString().slice(0, 10);
}

const EXPORT_FORMATS = {
  zip: {
    path: '/me/export',
    fallbackName: 'ferd-export.zip',
    mimeType: 'application/zip',
    desc: 'account.zipDesc',
  },
  geojson: {
    path: '/me/export.geojson',
    fallbackName: 'ferd.geojson',
    mimeType: 'application/geo+json',
    desc: 'account.geojsonDesc',
  },
};

// Settings, Account and Admin are separate menu items, each showing only its
// own tabs.
const SETTINGS_GROUPS = {
  settings: ['general', 'appearance', 'backup'],
  account: ['account', 'security'],
  admin: ['admin'],
};
const SETTINGS_TAB_LABELS = {
  general: 'settings.tab.general', appearance: 'settings.tab.appearance', backup: 'settings.tab.backup',
  account: 'settings.tab.account', security: 'settings.tab.security', admin: 'settings.tab.admin',
};
const MODE_LABELS = {
  dark: 'settings.appearance.modeDark', light: 'settings.appearance.modeLight', system: 'settings.appearance.modeSystem',
};
const THEME_LABELS = {
  nord: 'Nord',
  solarized: 'Solarized',
  gruvbox: 'Gruvbox',
  catppuccin: 'Catppuccin',
  'rose-pine': 'Rosé Pine',
  'tokyo-night': 'Tokyo Night',
  dracula: 'Dracula',
};

export function openSettingsModal(group) {
  const isAdmin = !!state.auth.is_admin;
  const local = !hasServer();
  // Backup is the only durable copy without a server; Account and Security
  // need a server account.
  const offered = { backup: local, account: !local, security: !local, admin: isAdmin };
  const tabs = SETTINGS_GROUPS[group || 'settings'].filter(name => offered[name] !== false);
  // Read once, as the dialog opens: a toggle inside it changes some of these,
  // and the rows they decide stay put until it is opened again.
  const env = {
    readOnly: isReadOnly(),
    placesAvailable: placesAvailable(),
    routesAvailable: routesAvailable(),
    placesEnabled: placesEnabled(),
    routesEnabled: routesEnabled(),
    logsAvailable: logsAvailable(),
    sharing: !!(state.auth.publishing_open || isAdmin),
  };
  openViewModal(html`<${SettingsView} tabs=${tabs} env=${env} />`, { phone: 'fullscreen' });
}

function SettingsView({ tabs, env }) {
  const [tab, setTab] = useState(tabs[0]);
  // The password form is on Account and the session list on Security.
  const [sessionsVersion, setSessionsVersion] = useState(0);
  // The menu item already named the dialog, so tabs take the title's place.
  const lead = tabs.length > 1 && html`<div class="modal-tabs" id="settings-tabs">
    ${tabs.map(name => html`<button key=${name} data-tab=${name} class=${name === tab ? 'active' : undefined} onClick=${() => setTab(name)}>${t(SETTINGS_TAB_LABELS[name])}</button>`)}
  </div>`;
  const panel = (name, body) => tabs.includes(name) &&
    html`<div data-panel=${name} hidden=${name !== tab}>${body}</div>`;
  return html`
    <${DialogHead} title=${t(SETTINGS_TAB_LABELS[tabs[0]])} lead=${lead} />
    <div class="ui-dialog-body">
      ${panel('general', html`<${GeneralPanel} env=${env} />`)}
      ${panel('backup', html`<${BackupPanel} />`)}
      ${panel('appearance', html`<${AppearancePanel} env=${env} />`)}
      ${panel('account', html`<${AccountPanel} env=${env} onPasswordChanged=${() => setSessionsVersion(n => n + 1)} />`)}
      ${panel('security', html`<${SecurityPanel} sessionsVersion=${sessionsVersion} />`)}
      ${panel('admin', html`<${AdminPanel} />`)}
    </div>`;
}

function FeaturePill({ id, field, label, initial, onToggle }) {
  const [on, setOn] = useState(!!initial);
  const change = e => {
    setOn(e.currentTarget.checked);
    onToggle(e.currentTarget.checked);
  };
  return html`<label class=${'feature-pill' + (on ? ' active' : '')}><input type="checkbox" id=${id} data-field=${field} checked=${on} onChange=${change} />${label}</label>`;
}

function Select({ id, options, initial, onPick }) {
  return html`<select id=${id} onChange=${e => onPick(e.currentTarget.value)}>
    ${options.map(([v, l]) => html`<option key=${v} value=${v} selected=${v === initial}>${l}</option>`)}
  </select>`;
}

function ManageRow({ id, hint, onOpen }) {
  return html`<div class="ui-control-row">
    <p class="ui-hint">${hint}</p>
    <button type="button" class="primary" id=${id} onClick=${onOpen}>${t('common.manage')}</button>
  </div>`;
}

// Places and Routes. Layer groups are pre-built, so visibility applies in
// place instead of tearing down the map, which would blink while Settings is
// open. The filter panel is rebuilt so its tab row drops or adds the feature.
function setMainFeature(feat, on) {
  setFeatureHidden(feat, !on);
  refreshTabVisibility();
  // Keeps the menu's phone Places/Routes section in sync.
  renderAuthWidget();
  if (state.currentMap) { applyMapFilters(); rebuildMapFilterPanel(); }
  else wrappedRouter();
}

// Menu items and the Add modal's Browse tab, none of which touch the map.
function setSecondaryFeature(feat, on) {
  setFeatureVisible(feat, on);
  renderAuthWidget();
  if (feat === 'history') refreshTabVisibility();
  if (feat === 'countries') syncCountriesOnMap();
  if (feat === 'history' && !on && (location.hash || '').startsWith('#/history')) {
    location.hash = '#/';
  }
}

// An optional field shows on place and route cards, map popups and the route
// detail page. The lists are redrawn so the change shows under Settings; the
// home map is not, since only its popups change and refreshOpenPlacePopup
// catches an open one.
function setOptionalField(key, on) {
  setPref('show-' + key, on ? 'true' : 'false');
  const hash = location.hash || '#/';
  if (hash.startsWith('#/places') || hash.startsWith('#/routes')) wrappedRouter();
  else refreshOpenPlacePopup();
}

const OPTIONAL_FIELDS = [
  ['date', 'settings.general.fieldDate'], ['image', 'settings.general.fieldImage'],
  ['local-name', 'settings.general.fieldLocalName'], ['note', 'settings.general.fieldNote'],
  ['rating', 'settings.general.fieldRating'], ['tags', 'settings.general.fieldTags'],
];

function GeneralPanel({ env }) {
  const pill = (feat, label, set, isOn) => html`<${FeaturePill} id=${'s-feat-' + feat} label=${label} initial=${isOn} onToggle=${on => set(feat, on)} />`;
  const pe = env.placesEnabled, re = env.routesEnabled;
  return html`
    ${(env.placesAvailable || env.routesAvailable) && html`
      <h3 class="settings-h">${t('settings.general.visibleFeatures')}</h3>
      <div class="feature-pills">
        ${env.placesAvailable && pill('places', t('settings.general.places'), setMainFeature, pe)}
        ${env.routesAvailable && pill('routes', t('settings.general.routes'), setMainFeature, re)}
      </div>
      ${(pe || re || env.logsAvailable) && html`
        <div class="feature-pills">
          ${(pe || re) && pill('history', t('settings.general.history'), setSecondaryFeature, featureVisible('history'))}
          ${pe && pill('catalog', t('settings.general.catalog'), setSecondaryFeature, featureVisible('catalog'))}
          ${env.logsAvailable && pill('logs', t('settings.general.logs'), setSecondaryFeature, featureVisible('logs'))}
          ${pe && pill('countries', t('settings.general.countries'), setSecondaryFeature, featureVisible('countries'))}
        </div>
        ${pe && html`<div class="hint">${t('settings.general.countriesHint')}</div>`}`}`}
    ${!env.readOnly && html`
      <h3 class="settings-h">${t('settings.general.optionalFields')}</h3>
      <div class="feature-pills optional-fields">
        ${OPTIONAL_FIELDS.map(([key, label]) => html`<${FeaturePill} key=${key} field=${key} label=${t(label)} initial=${getShowField(key)} onToggle=${on => setOptionalField(key, on)} />`)}
      </div>`}
    <h3 class="settings-h">${t('settings.general.units')}</h3>
    <${RadioPills} name="units" options=${[['imperial', t('settings.general.imperial')], ['metric', t('settings.general.metric')]]} initial=${getUnits()} variant="radio-segmented" onPick=${v => setPref('units', v)} />
    <h3 class="settings-h">${t('settings.general.language')}</h3>
    <div class="ui-field"><select id="s-language" aria-label=${t('settings.general.language')} disabled><option value="en" selected>${t('settings.general.english')}</option></select></div>
    ${env.placesAvailable && !env.readOnly && html`
      <h3 class="settings-h">${t('settings.general.categories')}</h3>
      <${ManageRow} id="s-manage-cats" hint=${t('settings.general.categoriesHint')} onOpen=${openManageCategoriesModal} />`}
    ${env.routesAvailable && !env.readOnly && html`
      <h3 class="settings-h">${t('settings.general.regions')}</h3>
      <${ManageRow} id="s-manage-regions" hint=${t('settings.general.regionsHint')} onOpen=${openManageRegionsModal} />`}`;
}

// The on/off preferences on Appearance, and what each changes right away.
// Only the default tile layer needs the map rebuilt, which blinks it.
function setSwitchPref(key, on) {
  setPref(key, on ? 'true' : 'false');
  if (key === 'remember-view') {
    // Read on the next navigation only.
    if (!on) {
      try { localStorage.removeItem('last-view'); } catch {}
    }
    return;
  }
  if (key === 'cluster-places') {
    swapPlaceClusterGroup();
    return;
  }
  if (key === 'tile-picker') {
    if (state.currentMap && state.tilePickerLayers) {
      if (on && !state.tilePickerCtrl) {
        const ctrl = addTilePicker(state.currentMap);
        state.tilePickerCtrl = ctrl;
        playEnter(ctrl.getContainer(), 'tile-pick-enter');
      } else if (!on && state.tilePickerCtrl) {
        const ctrl = state.tilePickerCtrl;
        state.tilePickerCtrl = null;
        playLeave(ctrl.getContainer(), 'tile-pick-leave', () => state.currentMap.removeControl(ctrl));
      }
    }
    return;
  }
  // The filter panel, zoom and expand controls hide through body classes.
  applyControlVisibility();
}

// The durable default, plus the session's state so the next map navigation
// follows it.
const DEFAULT_SHOW = [
  ['s-def-visited', 'visited', 'showVisited', 'settings.appearance.visited'],
  ['s-def-want', 'want', 'showWant', 'settings.appearance.want'],
  ['s-def-completed', 'completed', 'showCompleted', 'settings.appearance.completed'],
  ['s-def-planned', 'planned', 'showPlanned', 'settings.appearance.planned'],
];

function AppearancePanel({ env }) {
  const theme = getStoredTheme();
  const mode = getStoredMode();
  const switchToggle = (id, key, label, initial) =>
    html`<${Toggle} id=${id} label=${label} initial=${initial} onToggle=${on => setSwitchPref(key, on)} />`;
  return html`
    <div class="ui-field-row">
      <${Field} id="s-theme" label=${t('settings.appearance.theme')}>
        <${Select} id="s-theme" options=${THEMES.map(v => [v, THEME_LABELS[v] || v])} initial=${theme}
          onPick=${v => { setPref('theme', v); applyTheme(v, getStoredMode()); }} />
      <//>
      <${Field} id="s-mode" label=${t('settings.appearance.mode')}>
        <${Select} id="s-mode" options=${MODES.map(v => [v, t(MODE_LABELS[v])])} initial=${mode}
          onPick=${v => { setPref('mode', v); applyTheme(getStoredTheme(), v); }} />
      <//>
    </div>
    <h3 class="settings-h">${t('settings.appearance.markers')}</h3>
    <div class="ui-section">
      <${Field} id="s-pin-style" label=${t('settings.appearance.pinStyle')}>
        <${Select} id="s-pin-style" options=${[['dot', t('settings.appearance.pinDot')], ['tag', t('settings.appearance.pinFlag')], ['pin', t('settings.appearance.pinPin')], ['ring', t('settings.appearance.pinRing')]]} initial=${getPinStyle()}
          onPick=${v => { setPref('pin-style', v); refreshPlaceMarkerIcons(); }} />
      <//>
      <${Field} label=${t('settings.appearance.markerSize')}>
        <${RadioPills} name="marker-size" options=${[['small', t('settings.appearance.small')], ['default', t('settings.appearance.default')], ['large', t('settings.appearance.large')]]} initial=${getMarkerSizeKey()} variant="radio-segmented"
          onPick=${v => { setPref('marker-size', v); refreshPlaceMarkerIcons(); }} />
      <//>
      <${Field} label=${t('settings.appearance.routeWeight')}>
        <${RadioPills} name="route-weight" options=${[['thin', t('settings.appearance.thin')], ['default', t('settings.appearance.default')], ['thick', t('settings.appearance.thick')]]} initial=${getTrailWeightKey()} variant="radio-segmented"
          onPick=${v => { setPref('route-weight', v); refreshTrailWeights(); }} />
      <//>
      ${env.placesAvailable && switchToggle('s-cluster', 'cluster-places', t('settings.appearance.cluster'), getClusterPlaces())}
    </div>
    <h3 class="settings-h">${t('settings.appearance.defaultVisibility')}</h3>
    <div class="toggle-grid">
      ${DEFAULT_SHOW.map(([id, status, stateKey, label]) => html`<${Toggle} key=${id} id=${id} label=${t(label)} initial=${getDefaultShow(status)}
        onToggle=${on => { setPref('default-show-' + status, on ? 'true' : 'false'); state[stateKey] = on; }} />`)}
    </div>
    <h3 class="settings-h">${t('settings.appearance.map')}</h3>
    <div class="ui-section">
      <div class="ui-field-row">
        <${Field} id="s-tile" label=${t('settings.appearance.tileLayer')}>
          <${Select} id="s-tile" options=${BASE_LAYER_NAMES.map(n => [n, n])} initial=${getDefaultTileLayer()}
            onPick=${v => { setPref('tile-layer', v); wrappedRouter(); }} />
        <//>
        <${Field} id="s-tile-filter" label=${t('settings.appearance.tileStyle')}>
          <${Select} id="s-tile-filter" options=${[['none', t('settings.appearance.tileNone')], ['contrast', t('settings.appearance.tileContrast')], ['grayscale', t('settings.appearance.tileGrayscale')], ['muted', t('settings.appearance.tileMuted')], ['sepia', t('settings.appearance.tileSepia')]]} initial=${getTileFilter()}
            onPick=${v => { setPref('tile-filter', v); applyTileFilter(v); }} />
        <//>
      </div>
      ${switchToggle('s-remember-view', 'remember-view', t('settings.appearance.rememberView'), getRememberView())}
    </div>
    <h3 class="settings-h">${t('settings.appearance.controls')}</h3>
    <div class="toggle-grid">
      ${switchToggle('s-tile-picker', 'tile-picker', t('settings.appearance.tilePicker'), getShowTilePicker())}
      ${switchToggle('s-map-filter', 'map-filter', t('settings.appearance.filterPanel'), getShowFilterPanel())}
      ${switchToggle('s-map-zoom', zoomControlsKey(), t('settings.appearance.zoomButtons'), getShowZoomControls())}
      ${switchToggle('s-map-expand', 'map-expand', t('settings.appearance.expandButton'), getShowExpandButton())}
    </div>`;
}

// A zip import. `run` resolves to the message to show and whether the page is
// about to reload, in which case the button stays busy.
function ImportSection({ ids, modeName, modes, replaceBody, run }) {
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState('merge');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const picked = () => {
    const f = fileRef.current.files && fileRef.current.files[0];
    setFileName(f ? f.name : '');
    setDone('');
  };
  const start = () => {
    const file = fileRef.current.files && fileRef.current.files[0];
    setError('');
    if (!file) { setError(t('transfer.chooseFirst')); return; }
    const go = () => {
      setBusy(true);
      run(file, mode).then(res => {
        setDone(res.message);
        if (res.reloading) return;
        fileRef.current.value = '';
        setFileName('');
        setBusy(false);
      }).catch(err => {
        setBusy(false);
        setError(err.message);
      });
    };
    if (mode !== 'replace') { go(); return; }
    openConfirmModal({ title: t('transfer.replaceTitle'), body: replaceBody, confirmLabel: t('transfer.replace'), danger: true })
      .then(ok => { if (ok) go(); });
  };
  return html`<div class="ui-section">
    <p class="ui-hint">${t('transfer.restore')}</p>
    <${RadioPills} name=${modeName} options=${modes} initial="merge" variant="radio-segmented" onPick=${setMode} />
    <div class="ui-control-row settings-file-row">
      <div class="file-picker">
        <input type="file" id=${ids.file} tabindex="-1" accept=".zip,application/zip" class="file-input-hidden" ref=${fileRef} onChange=${picked} />
        <button type="button" class="primary" id=${ids.pick} onClick=${() => fileRef.current.click()}>${t('transfer.chooseFile')}</button>
        <span class=${'file-name' + (fileName ? ' has-file' : '')} id=${ids.name}>${fileName || t('transfer.noFile')}</span>
      </div>
      <button type="button" class="primary" id=${ids.start} disabled=${busy} onClick=${start}>${busy ? t('transfer.importing') : t('transfer.import')}</button>
    </div>
    <${ErrorBox} id=${ids.error} msg=${error} />
    <div class="modal-success-box" id=${ids.success} hidden=${!done}>${done}</div>
  </div>`;
}

// Hands a downloaded file to the user. The Android shell's WebView drops
// blob and anchor downloads, so there the bytes go to native, which opens the
// system "Save to..." picker.
async function saveDownload(blob, fname, mimeType) {
  if (window.FerdAndroid && typeof window.FerdAndroid.exportFile === 'function') {
    await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(t('backup.exportRead')));
      reader.onloadend = () => {
        const b64 = String(reader.result).split(',')[1] || '';
        window.FerdAndroid.exportFile(fname, blob.type || mimeType, b64);
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
}

// Without a server, the export is the only durable copy.
function BackupPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const exportZip = () => {
    setError('');
    setBusy(true);
    localBackup.exportZip().then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'ferd-local-export.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }).catch(e => setError(t('backup.exportFailed', { message: e.message })))
      .finally(() => setBusy(false));
  };
  const runImport = (file, mode) => localBackup.importZip(file, mode).then(res => {
    setTimeout(() => location.reload(), 900);
    return {
      message: res.areas
        ? t('backup.importedAreas', { places: res.places, areas: res.areas, routes: res.routes })
        : t('backup.imported', { places: res.places, routes: res.routes }),
      reloading: true,
    };
  }, e => { throw new Error(t('backup.importFailed', { message: e.message })); });
  return html`
    <h3 class="settings-h">${t('backup.export')}</h3>
    <div class="ui-control-row">
      <p class="ui-hint">${t('backup.exportHint')}</p>
      <button type="button" class="primary" id="s-local-export" disabled=${busy} onClick=${exportZip}>${busy ? t('backup.exporting') : t('transfer.export')}</button>
    </div>
    <${ErrorBox} id="s-local-export-error" msg=${error} />
    <h3 class="settings-h">${t('backup.import')}</h3>
    <${ImportSection}
      ids=${{ file: 's-local-import-file', pick: 's-local-import-pick', name: 's-local-import-name', start: 's-local-import-btn', error: 's-local-import-error', success: 's-local-import-success' }}
      modeName="local-import-mode" modes=${[['merge', t('transfer.merge')], ['replace', t('transfer.replaceAll')]]}
      replaceBody=${t('backup.replaceBody')}
      run=${runImport} />`;
}

function PublicSharing() {
  const [linkOpen, setLinkOpen] = useState(!!state.auth.published);
  const urlRef = useRef(null);
  const toggle = (wanted, set) => {
    api('POST', '/me/publish', { published: wanted })
      .then(() => { setLinkOpen(wanted); return refreshAuthState(); })
      .catch(err => { alert(t('common.failed', { message: err.message })); set(!wanted); });
  };
  return html`
    <h3 class="settings-h">${t('account.publicSharing')}</h3>
    <div>
      <${Toggle} id="s-publish" label=${t('account.makePublic')} initial=${state.auth.published} onToggle=${toggle} />
      <div id="s-publish-link" class=${'collapsible' + (linkOpen ? ' expanded' : '')}>
        <div class="collapsible-inner">
          <${Field} id="s-publish-url" label=${t('account.publicLink')}>
            <div class="ui-control-row">
              <input type="text" id="s-publish-url" readonly value=${location.origin + '/u/' + (state.auth.username || '') + '/'} ref=${urlRef} />
              <${CopyButton} id="s-publish-copy" target=${urlRef} />
            </div>
            <p class="ui-hint">${t('account.publicLinkHint')}</p>
          <//>
        </div>
      </div>
    </div>`;
}

function ExportSection() {
  const [format, setFormat] = useState('zip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = () => {
    const f = EXPORT_FORMATS[format];
    setError('');
    setBusy(true);
    fetch(apiUrl(f.path), applyAuth({})).then(async r => {
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
        throw new Error(msg);
      }
      const m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
      await saveDownload(await r.blob(), m ? m[1] : f.fallbackName, f.mimeType);
    }).catch(err => setError(err.message))
      .finally(() => setBusy(false));
  };
  return html`
    <h3 class="settings-h">${t('account.export')}</h3>
    <div class="ui-section">
      <${RadioPills} name="export-format" options=${[['zip', t('account.formatZip')], ['geojson', t('account.formatGeojson')]]} initial="zip" variant="radio-segmented" onPick=${setFormat} />
      <div class="ui-control-row">
        <p class="ui-hint" id="s-export-desc">${t(EXPORT_FORMATS[format].desc)}</p>
        <button type="button" class="primary" id="s-export" disabled=${busy} onClick=${start}>${t('transfer.export')}</button>
      </div>
      <${ErrorBox} id="s-export-error" msg=${error} />
    </div>`;
}

function runServerImport(file, mode) {
  return fetch(apiUrl('/me/import?mode=' + mode), applyAuth({
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  })).then(async r => {
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    const c = data.imported || {};
    const parts = [];
    if (c.places) parts.push(t('account.importedPlaces', { n: c.places }));
    if (c.areas) parts.push(t('account.importedAreas', { n: c.areas }));
    if (c.gpx) parts.push(t('account.importedRoutes', { n: c.gpx }));
    sync().then(() => { wrappedRouter(); });
    return { message: parts.length ? t('account.imported', { list: parts.join(', ') }) : t('account.nothingImported') };
  });
}

function PasswordForm({ onChanged }) {
  const current = useRef(null);
  const next = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const submit = e => {
    e.preventDefault();
    setBusy(true);
    api('POST', '/change-password', { current_password: current.current.value, new_password: next.current.value })
      .then(() => {
        current.current.value = '';
        next.current.value = '';
        setBusy(false);
        setDone(t('account.passwordChanged'));
        setError('');
        onChanged();
      })
      .catch(err => {
        setBusy(false);
        setError(err.message);
        setDone('');
      });
  };
  return html`<form id="settings-pw-form" class="ui-section" onSubmit=${submit}>
    <${Field} id="s-current" label=${t('account.currentPassword')}>
      <input type="password" id="s-current" autocomplete="current-password" required ref=${current} />
    <//>
    <${Field} id="s-new" label=${t('account.newPassword')}>
      <input type="password" id="s-new" autocomplete="new-password" required ref=${next} />
      <p class="ui-hint">${t('account.passwordHint')}</p>
    <//>
    <div class="ui-control-row">
      <button type="submit" class="primary" id="s-submit" disabled=${busy}>${t('account.changePassword')}</button>
    </div>
    <${ErrorBox} id="s-error" msg=${error} />
    <div class="modal-success" id="s-pw-success" hidden=${!done}>${done}</div>
  </form>`;
}

function AccountPanel({ env, onPasswordChanged }) {
  return html`
    ${env.sharing && html`<${PublicSharing} />`}
    <${ExportSection} />
    <h3 class="settings-h">${t('account.import')}</h3>
    <${ImportSection}
      ids=${{ file: 's-import-file', pick: 's-import-pick', name: 's-import-name', start: 's-import', error: 's-import-error', success: 's-import-success' }}
      modeName="import-mode" modes=${[['merge', t('transfer.merge')], ['replace', t('transfer.replaceAll')], ['prefs', t('transfer.prefsOnly')]]}
      replaceBody=${t('account.replaceBody')}
      run=${runServerImport} />
    <h3 class="settings-h">${t('account.password')}</h3>
    <${PasswordForm} onChanged=${onPasswordChanged} />`;
}

function TokenForm({ onCreated }) {
  const nameRef = useRef(null);
  const valueRef = useRef(null);
  const [scope, setScope] = useState('full');
  const [expiry, setExpiry] = useState('365');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const submit = e => {
    e.preventDefault();
    const body = { name: nameRef.current.value.trim(), scope };
    if (expiry) body.expires_in_days = parseInt(expiry, 10);
    setBusy(true);
    setError('');
    api('POST', '/me/tokens', body).then(res => {
      setBusy(false);
      nameRef.current.value = '';
      setToken(res.token);
      onCreated();
    }).catch(err => {
      setBusy(false);
      setError(err.message);
    });
  };
  return html`<form id="s-token-form" class="ui-section" onSubmit=${submit}>
    <p class="ui-hint">${t('security.tokenHint')}</p>
    <${Field} id="s-token-name" label=${t('security.tokenName')}>
      <input type="text" id="s-token-name" maxlength="100" placeholder=${t('security.tokenNamePlaceholder')} required ref=${nameRef} />
    <//>
    <${Field} label=${t('security.scope')}>
      <${RadioPills} name="s-token-scope" options=${[['full', t('security.scopeFull')], ['readonly', t('security.scopeReadonly')]]} initial="full" variant="radio-segmented" onPick=${setScope} />
    <//>
    <${Field} label=${t('security.expires')}>
      <${RadioPills} name="s-token-expiry" options=${[['30', t('security.days30')], ['90', t('security.days90')], ['365', t('security.year1')], ['', t('security.never')]]} initial="365" variant="radio-segmented" onPick=${setExpiry} />
    <//>
    <div class="ui-control-row">
      <button type="submit" class="primary" id="s-token-create" disabled=${busy}>${t('security.createToken')}</button>
    </div>
    <${ErrorBox} id="s-token-error" msg=${error} />
    <div id="s-token-new" class="modal-success-box" hidden=${!token}>
      ${token && html`
        <div style="margin-bottom:var(--ui-space-2)">${t('security.tokenCreated')}</div>
        <div style="display:flex;align-items:center;gap:var(--ui-space-2)">
          <input type="text" id="s-token-value" readonly value=${token} ref=${valueRef} style="flex:1;font-size:var(--ui-text-xs)" />
          <${CopyButton} id="s-token-copy" target=${valueRef} style="flex:0 0 auto" />
        </div>`}
    </div>
  </form>`;
}

function SecurityPanel({ sessionsVersion }) {
  const [tokensVersion, setTokensVersion] = useState(0);
  return html`
    <${Sessions} version=${sessionsVersion} />
    <h3 class="settings-h">${t('security.apiTokens')}</h3>
    <${TokenForm} onCreated=${() => setTokensVersion(n => n + 1)} />
    <h3 class="settings-h">${t('security.yourTokens')}</h3>
    <${Tokens} version=${tokensVersion} />`;
}

function AdminPanel() {
  // Bumped after a change that the user list and the stats both count.
  const [version, setVersion] = useState(0);
  const changed = () => setVersion(n => n + 1);
  const setRegistration = (wanted, set) => {
    api('POST', '/settings/registration', { mode: wanted ? 'open' : 'closed' })
      .then(() => refreshAuthState())
      .catch(err => { alert(t('common.failed', { message: err.message })); set(!wanted); });
  };
  const setPublishing = (wanted, set) => {
    const apply = () => api('POST', '/admin/settings/publishing', { mode: wanted ? 'open' : 'closed' })
      .then(() => refreshAuthState())
      .then(changed)
      .catch(err => { alert(t('common.failed', { message: err.message })); set(!wanted); });
    if (wanted) { apply(); return; }
    // Closing the gate also force-unpublishes anyone currently public.
    openConfirmModal({
      title: t('admin.disablePublishingTitle'),
      body: t('admin.disablePublishingBody'),
      confirmLabel: t('admin.disablePublishingTitle'),
      danger: true,
    }).then(ok => {
      if (!ok) { set(true); return; }
      api('POST', '/admin/unpublish-all').then(apply).catch(err => {
        alert(t('common.failed', { message: err.message }));
        set(true);
      });
    });
  };
  const setBaseline = (wanted, set) => {
    api('POST', '/admin/settings/catalog-baseline', { mode: wanted ? 'open' : 'closed' })
      .then(() => { state.auth.catalog_baseline_open = wanted; state._catalogCache = null; renderAdminCatalog(); reloadCatalogCache(); })
      .catch(err => { alert(t('common.failed', { message: err.message })); set(!wanted); });
  };
  return html`
    <h3 class="settings-h">${t('admin.instance')}</h3>
    <${AdminStats} version=${version} />
    <h3 class="settings-h">${t('admin.access')}</h3>
    <${Toggle} id="s-reg" label=${t('admin.allowRegistration')} initial=${state.auth.registration_open} onToggle=${setRegistration} />
    <${Toggle} id="s-publishing" label=${t('admin.allowPublishing')} initial=${state.auth.publishing_open} onToggle=${setPublishing} />
    <h3 class="settings-h">${t('admin.catalog')}</h3>
    <${Toggle} id="s-catalog-baseline" label=${t('admin.includeShipped')} initial=${state.auth.catalog_baseline_open} onToggle=${setBaseline} />
    <${AdminCatalog} />
    <h3 class="settings-h">${t('admin.users')}</h3>
    <${AdminUsers} version=${version} onChanged=${changed} />`;
}
