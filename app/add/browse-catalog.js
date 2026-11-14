import { fetchJson, hasServer } from '../server.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { ErrorBox, html, useEffect, useState } from '../view.js';

/**
 * What a catalog tab lists: entries of catalog-routes.json or
 * catalog-areas.json, each an OpenStreetMap relation and the metadata written
 * for it. The geometry is not in the file.
 * @typedef {object} CatalogRelation
 * @property {string} name
 * @property {number} relation OSM relation ID
 * @property {string} country
 * @property {string} [local_name]
 * @property {string} [note]
 * @property {string} [image]
 * @property {string[]} [sources]
 */
/**
 * @typedef {object} RelationCatalog
 * @property {CatalogRelation[]} entries
 * @property {boolean} importable false when the server has no Overpass endpoint
 */

/**
 * The catalog from the server, or without one the bundled file listed with
 * no import action, since nothing can fetch the geometry.
 * @param {string} file the bundled catalog, read when there is no server
 * @param {() => Promise<RelationCatalog>} get the server's list
 * @returns {Promise<RelationCatalog>}
 */
export function fetchCatalog(file, get) {
  if (!hasServer()) {
    return fetchJson(file, []).then(arr => ({ entries: Array.isArray(arr) ? arr : [], importable: false }));
  }
  return get();
}

/**
 * A Browse tab of the Add dialog: catalog entries that are OpenStreetMap
 * relations, imported one at a time. `kind` names the element ids and the
 * import button's class.
 * @param {{ kind: 'route' | 'area',
 *   strings: { empty: string, hint: string, noImport: string },
 *   load: () => Promise<RelationCatalog>,
 *   have: (name: string) => boolean,
 *   importEntry: (e: CatalogRelation) => Promise<void>,
 *   after?: () => () => void }} props `after` runs before the import and
 *   returns the step to take once it has landed and the dialog closed.
 */
export function BrowseCatalog({ kind, strings, load, have, importEntry, after }) {
  const [res, setRes] = useState(/** @type {{ cat?: RelationCatalog, error?: string }} */ ({}));
  const [busy, setBusy] = useState(/** @type {number | null} */ (null));
  const [error, setError] = useState('');
  useEffect(() => {
    load()
      .then(cat => setRes({ cat }))
      .catch((/** @type {Error} */ err) => setRes({ error: err.message }));
  }, []);
  const bodyId = `browse-${kind}s-body`;
  if (res.error) return html`<div id=${bodyId}><${ErrorBox} id="add-error" msg=${res.error} /></div>`;
  if (!res.cat) return html`<div id=${bodyId}><div class="route-browse-hint">${t('browse.loading')}</div></div>`;
  const { entries, importable } = res.cat;
  if (!entries.length) return html`<div id=${bodyId}><div class="route-browse-hint">${strings.empty}</div></div>`;

  /** @param {CatalogRelation} e */
  const run = e => {
    setError('');
    setBusy(e.relation);
    const done = after ? after() : null;
    importEntry(e)
      .then(() => {
        closeModal();
        if (done) done();
      })
      .catch((/** @type {Error} */ err) => { setBusy(null); setError(e.name + ': ' + err.message); });
  };

  return html`<div id=${bodyId}>
    <div class="route-browse-hint">${importable ? strings.hint : strings.noImport}</div>
    <div id=${`browse-${kind}s-list`}>
      ${entries.map((/** @type {CatalogRelation} */ e) => {
        const had = have(e.name);
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
          ${importable && html`<button type="button" class=${`ui-button browse-${kind}-import`} disabled=${had || busy !== null}
            onClick=${() => run(e)}>${had ? t('browseCatalog.imported') : busy === e.relation ? t('browseCatalog.importing') : t('browseCatalog.import')}</button>`}
        </div>`;
      })}
    </div>
    <${ErrorBox} id="add-error" msg=${error} />
  </div>`;
}
