import { state } from '../core.js';
import { dataLayer } from '../store.js';
import { api } from '../auth.js';
import { fetchJson, hasServer } from '../server.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { ErrorBox, html, useEffect, useState } from '../view.js';

/**
 * One entry of catalog-routes.json: an OpenStreetMap relation and the
 * metadata written for it. The geometry is not in the file.
 * @typedef {object} RouteCatalogEntry
 * @property {string} name
 * @property {number} relation OSM relation ID
 * @property {string} country
 * @property {string} [local_name]
 * @property {string} [note]
 * @property {string} [image]
 * @property {string[]} [sources]
 */
/**
 * @typedef {object} RouteCatalog
 * @property {RouteCatalogEntry[]} entries
 * @property {boolean} importable false when the server has no Overpass endpoint
 */
/**
 * The server's answer for one relation: the GPX to store and what it kept.
 * @typedef {object} RouteImport
 * @property {string} gpx
 * @property {number} points
 * @property {number} segments
 * @property {number} tolerance_m
 * @property {string} source the relation's openstreetmap.org URL
 * @property {string} credit
 */

const HINT_STYLE = 'font-size:var(--ui-text-xs);color:var(--muted);padding:var(--ui-space-2) 0';

/** @returns {Promise<RouteCatalog>} */
function fetchRouteCatalog() {
  // Without a server nothing can fetch the geometry, so the entries are
  // listed from the bundled file with no import action.
  if (!hasServer()) {
    return fetchJson('catalog-routes.json', []).then(arr => ({ entries: Array.isArray(arr) ? arr : [], importable: false }));
  }
  return api('GET', '/catalog/routes');
}

/** @param {string} name */
function haveRoute(name) {
  const regions = state.manifest ? state.manifest.regions : [];
  return regions.some(r => r.routes.some(x => x.name === name));
}

/** @param {RouteCatalogEntry} e */
async function importRoute(e) {
  /** @type {RouteImport} */
  const res = await api('POST', '/catalog/routes/gpx', { relation: e.relation });
  // Stored through the ordinary upload, so the offline store and the server
  // hold the same route. The credit goes in the notes, where it shows.
  await dataLayer.uploadGpx({ region: '', name: e.name, stripPii: false, file: new Blob([res.gpx], { type: 'application/gpx+xml' }) });
  /** @type {Record<string, string>} */
  const metadata = { source: res.source, notes: res.credit };
  if (e.local_name) metadata.local_name = e.local_name;
  await dataLayer.putMetadata({ key: e.name, metadata });
}

// The Browse routes tab of the Add dialog: catalog routes that are
// OpenStreetMap relations, imported one at a time.
export function BrowseRoutes() {
  const [res, setRes] = useState(/** @type {{ cat?: RouteCatalog, error?: string }} */ ({}));
  const [busy, setBusy] = useState(/** @type {number | null} */ (null));
  const [error, setError] = useState('');
  useEffect(() => {
    fetchRouteCatalog()
      .then(cat => setRes({ cat }))
      .catch((/** @type {Error} */ err) => setRes({ error: err.message }));
  }, []);
  if (res.error) return html`<div id="browse-routes-body"><${ErrorBox} id="add-error" msg=${res.error} /></div>`;
  if (!res.cat) return html`<div id="browse-routes-body"><div style=${HINT_STYLE}>${t('browse.loading')}</div></div>`;
  const { entries, importable } = res.cat;
  if (!entries.length) return html`<div id="browse-routes-body"><div style=${HINT_STYLE}>${t('browseRoutes.empty')}</div></div>`;

  /** @param {RouteCatalogEntry} e */
  const run = e => {
    setError('');
    setBusy(e.relation);
    importRoute(e)
      .then(() => closeModal())
      .catch((/** @type {Error} */ err) => { setBusy(null); setError(e.name + ': ' + err.message); });
  };

  return html`<div id="browse-routes-body">
    <div style=${HINT_STYLE}>${importable ? t('browseRoutes.hint') : t('browseRoutes.noImport')}</div>
    <div id="browse-routes-list">
      ${entries.map((/** @type {RouteCatalogEntry} */ e) => {
        const have = haveRoute(e.name);
        const src = Array.isArray(e.sources) ? e.sources[0] : null;
        return html`<div class="browse-row" key=${e.relation} data-relation=${e.relation} style="display:flex;align-items:flex-start;gap:var(--ui-space-2);padding:var(--ui-space-2) 0;border-bottom:1px solid var(--border)">
          <span style="flex:1;min-width:0;display:block">
            <span style="display:flex;align-items:center;gap:var(--ui-space-2);width:100%">
              <span title=${e.name} style="flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.name}</span>
              ${src && html`<a href=${src} target="_blank" rel="noopener" class="row-src">${t('browse.source')}</a>`}
            </span>
            <span style="display:block;font-size:var(--ui-text-xs);color:var(--muted)">${e.country}</span>
            ${e.note && html`<span class="row-note">${e.note}</span>`}
          </span>
          ${importable && html`<button type="button" class="ui-button browse-route-import" disabled=${have || busy !== null}
            onClick=${() => run(e)}>${have ? t('browseRoutes.imported') : busy === e.relation ? t('browseRoutes.importing') : t('browseRoutes.import')}</button>`}
        </div>`;
      })}
    </div>
    <${ErrorBox} id="add-error" msg=${error} />
  </div>`;
}
