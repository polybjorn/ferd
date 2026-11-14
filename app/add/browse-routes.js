import { state } from '../core.js';
import { dataLayer } from '../store.js';
import { api } from '../auth.js';
import { t } from '../i18n.js';
import { html } from '../view.js';
import { BrowseCatalog, fetchCatalog } from './browse-catalog.js';

/**
 * One entry of catalog-routes.json.
 * @typedef {import('./browse-catalog.js').CatalogRelation} RouteCatalogEntry
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

/** @returns {Promise<RouteCatalog>} */
const fetchRouteCatalog = () => fetchCatalog('catalog-routes.json', () => api('GET', '/catalog/routes'));

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

// The Browse routes tab of the Add dialog.
export function BrowseRoutes() {
  const strings = { empty: t('browseRoutes.empty'), hint: t('browseRoutes.hint'), noImport: t('browseRoutes.noImport') };
  return html`<${BrowseCatalog} kind="route" strings=${strings} load=${fetchRouteCatalog} have=${haveRoute} importEntry=${importRoute} />`;
}
