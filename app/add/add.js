import { catalogEnabled, placesEnabled, routesEnabled } from '../prefs.js';
import { AddArea } from '../areas/add-area.js';
import { AddPlace } from '../places/add-place.js';
import { AddRoute } from '../routes/add-route.js';
import { enhanceSelectsIn } from '../select.js';
import { t } from '../i18n.js';
import { DialogHead, html, openViewModal, useEffect, useRef, useState } from '../view.js';
import { Browse } from './browse.js';

/**
 * @typedef {'place' | 'route' | 'area' | 'browse'} AddTab
 * @typedef {{ lat: number, lng: number }} Coords
 */

/** @param {AddTab} tab */
const tabLabel = tab => ({
  place: t('add.tabPlace'), route: t('add.tabRoute'), area: t('add.tabArea'), browse: t('add.tabBrowse'),
})[tab];
/** @param {AddTab} tab */
const tabTitle = tab => ({
  place: t('add.titlePlace'), route: t('add.titleRoute'), area: t('add.titleArea'), browse: t('add.titleBrowse'),
})[tab];

/**
 * @param {{ tabs: AddTab[], prefillCoords?: Coords | null, draft?: any,
 *   reopen: (coords: Coords, draft: any) => void }} props
 */
function AddDialog({ tabs, prefillCoords, draft, reopen }) {
  const [tab, setTab] = useState(tabs[0]);
  const body = useRef(/** @type {HTMLDivElement | null} */ (null));
  // A tab's selects appear after the dialog opened, so they get the themed
  // list here.
  useEffect(() => { enhanceSelectsIn(body.current); }, [tab]);
  // With one tab there is no tab row, so the head names the form instead.
  const lead = tabs.length > 1
    ? html`<div class="modal-tabs" id="add-tabs">
        ${tabs.map(x => html`<button type="button" key=${x} data-tab=${x} class=${x === tab ? 'active' : ''} onClick=${() => setTab(x)}>${tabLabel(x)}</button>`)}
      </div>`
    : null;
  return html`<${DialogHead} title=${tabTitle(tabs[0])} lead=${lead} />
    <div class="ui-dialog-body">
      <div id="add-body" ref=${body}>
        ${tab === 'place' ? html`<${AddPlace} key="place" prefillCoords=${prefillCoords} draft=${draft} reopen=${reopen} />`
          : tab === 'route' ? html`<${AddRoute} key="route" />`
          : tab === 'area' ? html`<${AddArea} key="area" />`
          : html`<${Browse} key="browse" />`}
      </div>
    </div>`;
}

/**
 * @param {Coords | null | undefined} prefillCoords A map pick to start from.
 * @param {'place' | 'route' | 'area' | null} [initialTab]
 * @param {any} [draft] Place fields to restore after a pick on the map.
 */
export function openAddModal(prefillCoords, initialTab = null, draft = undefined) {
  const showPlaces = placesEnabled();
  const showTrails = routesEnabled();
  if (!showPlaces && !showTrails) return;
  // Entry-point determines which tabs the modal exposes:
  //   'place' (Places list Add)  -> [Place, Browse]
  //   'route' (Routes list Add)  -> just the GPX form, no tabs
  //   'area'  (Areas list Add)   -> just the area form, no tabs
  //   null    (map Add button)   -> [Place, Route, Area, Browse], filtered by enabled features
  // Browse reads the merged catalog in server mode and the bundled shipped
  // catalog.json in local mode (see fetchCatalog); hidden when the Catalog
  // feature is toggled off.
  const showBrowse = catalogEnabled();
  /** @type {AddTab[]} */
  let tabs;
  if (initialTab === 'route') {
    tabs = ['route'];
  } else if (initialTab === 'area' && showPlaces) {
    tabs = ['area'];
  } else if (initialTab === 'place') {
    tabs = showPlaces ? (showBrowse ? ['place', 'browse'] : ['place']) : ['route'];
  } else {
    tabs = [];
    if (showPlaces) tabs.push('place');
    if (showTrails) tabs.push('route');
    if (showPlaces) tabs.push('area');
    if (showPlaces && showBrowse) tabs.push('browse');
  }
  const reopen = (/** @type {Coords} */ coords, /** @type {any} */ snapshot) => openAddModal(coords, 'place', snapshot);
  openViewModal(html`<${AddDialog} tabs=${tabs} prefillCoords=${prefillCoords} draft=${draft} reopen=${reopen} />`, { phone: 'fullscreen' });
}
