import { state } from '../core.js';
import { dataLayer } from '../store.js';
import { api } from '../auth.js';
import { fitAddedAreas } from '../map/index.js';
import { t } from '../i18n.js';
import { html } from '../view.js';
import { BrowseCatalog, fetchCatalog } from './browse-catalog.js';

/**
 * One entry of catalog-areas.json.
 * @typedef {import('./browse-catalog.js').CatalogRelation} AreaCatalogEntry
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
const fetchAreaCatalog = () => fetchCatalog('catalog-areas.json', () => api('GET', '/catalog/areas'));

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

// Zoom to the new area once the dialog has closed: the ids from before the
// import tell it apart.
const fitImported = () => {
  const before = new Set((state.areas || []).map(a => a.id));
  return () => fitAddedAreas(/** @type {Set<string>} */ (before));
};

// The Browse areas tab of the Add dialog.
export function BrowseAreas() {
  const strings = { empty: t('browseAreas.empty'), hint: t('browseAreas.hint'), noImport: t('browseAreas.noImport') };
  return html`<${BrowseCatalog} kind="area" strings=${strings} load=${fetchAreaCatalog} have=${haveArea} importEntry=${importArea} after=${fitImported} />`;
}
