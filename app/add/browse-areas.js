import { state } from '../core.js';
import { dataLayer } from '../store.js';
import { api } from '../auth.js';
import { fetchJson, hasServer } from '../server.js';
import { fitAddedAreas } from '../map/index.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { ErrorBox, html, useEffect, useState } from '../view.js';

/**
 * One entry of catalog-areas.json: an OpenStreetMap relation and the
 * metadata written for it. The geometry is not in the file.
 * @typedef {object} AreaCatalogEntry
 * @property {string} name
 * @property {number} relation OSM relation ID
 * @property {string} country
 * @property {string} [local_name]
 * @property {string} [note]
 * @property {string} [image]
 * @property {string[]} [sources]
 */
/**
 * @typedef {object} AreaCatalog
 * @property {AreaCatalogEntry[]} entries
 * @property {boolean} importable false when the server has no Overpass endpoint
 */
/**
 * The server's answer for one relation: the outline to store and what it kept.
 * @typedef {object} AreaImport
 * @property {{ type: 'Polygon' | 'MultiPolygon', coordinates: any[] }} geometry
 * @property {number} points
 * @property {number} polygons
 * @property {number} tolerance_m
 * @property {string} source the relation's openstreetmap.org URL
 * @property {string} credit
 */

/** @returns {Promise<AreaCatalog>} */
function fetchAreaCatalog() {
  // Without a server nothing can fetch the geometry, so the entries are
  // listed from the bundled file with no import action.
  if (!hasServer()) {
    return fetchJson('catalog-areas.json', []).then(arr => ({ entries: Array.isArray(arr) ? arr : [], importable: false }));
  }
  return api('GET', '/catalog/areas');
}

/** @param {string} name */
const haveArea = name => (state.areas || []).some(a => a.name === name);

/** @param {AreaCatalogEntry} e */
async function importArea(e) {
  /** @type {AreaImport} */
  const res = await api('POST', '/catalog/areas/geometry', { relation: e.relation });
  // Stored as an ordinary area, so it syncs like one. `source: 'osm'` is how
  // an area carries its OpenStreetMap credit, as a searched boundary does.
  /** @type {any} */
  const area = { name: e.name, geometry: res.geometry, visited: false, source: 'osm' };
  if (e.local_name) area.local_name = e.local_name;
  await dataLayer.createArea(area);
}

// The Browse areas tab of the Add dialog: catalog areas that are
// OpenStreetMap relations, imported one at a time.
export function BrowseAreas() {
  const [res, setRes] = useState(/** @type {{ cat?: AreaCatalog, error?: string }} */ ({}));
  const [busy, setBusy] = useState(/** @type {number | null} */ (null));
  const [error, setError] = useState('');
  useEffect(() => {
    fetchAreaCatalog()
      .then(cat => setRes({ cat }))
      .catch((/** @type {Error} */ err) => setRes({ error: err.message }));
  }, []);
  if (res.error) return html`<div id="browse-areas-body"><${ErrorBox} id="add-error" msg=${res.error} /></div>`;
  if (!res.cat) return html`<div id="browse-areas-body"><div class="route-browse-hint">${t('browse.loading')}</div></div>`;
  const { entries, importable } = res.cat;
  if (!entries.length) return html`<div id="browse-areas-body"><div class="route-browse-hint">${t('browseAreas.empty')}</div></div>`;

  /** @param {AreaCatalogEntry} e */
  const run = e => {
    setError('');
    setBusy(e.relation);
    const before = new Set((state.areas || []).map(a => a.id));
    importArea(e)
      .then(() => {
        closeModal();
        fitAddedAreas(/** @type {Set<string>} */ (before));
      })
      .catch((/** @type {Error} */ err) => { setBusy(null); setError(e.name + ': ' + err.message); });
  };

  return html`<div id="browse-areas-body">
    <div class="route-browse-hint">${importable ? t('browseAreas.hint') : t('browseAreas.noImport')}</div>
    <div id="browse-areas-list">
      ${entries.map((/** @type {AreaCatalogEntry} */ e) => {
        const have = haveArea(e.name);
        const src = Array.isArray(e.sources) ? e.sources[0] : null;
        return html`<div class="browse-row route-browse-row" key=${e.relation} data-relation=${e.relation}>
          <span class="route-browse-text">
            <span class="route-browse-head">
              <span title=${e.name} class="route-browse-name">${e.name}</span>
              ${src && html`<a href=${src} target="_blank" rel="noopener" class="row-src">${t('browse.source')}</a>`}
            </span>
            <span class="route-browse-meta">${e.country}</span>
            ${e.note && html`<span class="row-note">${e.note}</span>`}
          </span>
          ${importable && html`<button type="button" class="ui-button browse-area-import" disabled=${have || busy !== null}
            onClick=${() => run(e)}>${have ? t('browseRoutes.imported') : busy === e.relation ? t('browseRoutes.importing') : t('browseRoutes.import')}</button>`}
        </div>`;
      })}
    </div>
    <${ErrorBox} id="add-error" msg=${error} />
  </div>`;
}
