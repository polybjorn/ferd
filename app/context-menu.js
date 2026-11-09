import { state } from './core.js';
import { isReadOnly } from './server.js';
import { deletePlaceItem, deleteRouteItem, openPlacePopup } from './map/index.js';
import { openEditTrailMetadataModal } from './routes/route-meta.js';
import { openEditPlaceModal } from './places/edit-place.js';
import { findCatalogUpdate, openCatalogUpdateModal } from './places-list.js';
import { focusHash } from './router.js';
import { popoverHost } from './modal.js';
import { t } from './i18n.js';
import { html } from './view.js';
import { render } from 'preact';

/** @typedef {import('./core.js').Place} Place */
/** @typedef {import('./core.js').ManifestRoute} ManifestRoute */
/** @typedef {import('./map/route-layer.js').LeafletMap} LeafletMap */
/** A menu entry, or `null` for a divider. @typedef {{ label: string, onClick: () => void, danger?: boolean } | null} ContextMenuItem */

/** @param {string} type @param {string} slug */
function copyShareLink(type, slug) {
  const url = location.origin + location.pathname + focusHash(type, slug);
  const fallback = () => prompt(t('menu.copyPrompt'), url);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).catch(fallback);
  } else {
    fallback();
  }
}

// Place pin right-click on the home map.
/** @param {Place} place @param {MouseEvent} oe @param {LeafletMap} map */
export function openMapPlaceContextMenu(place, oe, map) {
  /** @type {ContextMenuItem[]} */
  const items = [];
  items.push({ label: t('menu.open'), onClick: function() {
    openPlacePopup(map, place);
    history.replaceState(null, '', focusHash('place', place._slug || place.name));
  } });
  if (Array.isArray(place.sources) && place.sources.length) {
    items.push({ label: t('popup.source'), onClick: function() { window.open(/** @type {string[]} */ (place.sources)[0], '_blank', 'noopener'); } });
  }
  if (!isReadOnly() && state.auth && state.auth.authenticated) {
    items.push({ label: t('lists.edit'), onClick: function() { openEditPlaceModal(place); } });
  }
  if (place.from_catalog && findCatalogUpdate(place)) {
    items.push({ label: t('lists.applyCatalogUpdate'), onClick: function() { openCatalogUpdateModal(place); } });
  }
  items.push({ label: t('menu.copyLink'), onClick: function() { copyShareLink('place', place._slug || place.name); } });
  if (!isReadOnly() && state.auth && state.auth.authenticated) {
    items.push(null);
    items.push({ label: t('common.delete'), danger: true, onClick: function() {
      deletePlaceItem(place, {});
    }});
  }
  openContextMenu({ x: oe.clientX, y: oe.clientY, items });
}

// Route polyline right-click on the home map. regionName is the route's
// region as a plain string ('' for no-region); routeLayers records carry
// region as the name, not the manifest region object.
/** @param {ManifestRoute} route @param {string} regionName @param {MouseEvent} oe @param {LeafletMap} map */
export function openMapRouteContextMenu(route, regionName, oe, map) {
  /** @type {ContextMenuItem[]} */
  const items = [];
  const slug = route._slug || route.key;
  items.push({ label: t('menu.open'), onClick: function() { location.hash = '#/routes/route/' + encodeURIComponent(route.key); } });
  if (route.source) {
    items.push({ label: t('popup.source'), onClick: function() { window.open(route.source, '_blank', 'noopener'); } });
  }
  if (!isReadOnly() && state.auth && state.auth.authenticated) {
    items.push({ label: t('lists.edit'), onClick: function() { openEditTrailMetadataModal(route, regionName); } });
  }
  items.push({ label: t('menu.copyLink'), onClick: function() { copyShareLink('route', slug); } });
  if (!isReadOnly() && state.auth && state.auth.authenticated) {
    items.push(null);
    items.push({ label: t('common.delete'), danger: true, onClick: function() {
      deleteRouteItem(route, regionName, function() { /* the map follows the store */ });
    }});
  }
  openContextMenu({ x: oe.clientX, y: oe.clientY, items });
}

// Generic floating context menu. Pass `items` as an array of
// { label, onClick, danger? } objects, or `null` to insert a divider. ui.js
// places it at the point and closes it on a click outside, Escape, scroll,
// resize or a choice, so nothing here listens for any of those.
/** @param {{ x: number, y: number, items: ContextMenuItem[] }} opts */
function openContextMenu({ x, y, items }) {
  const menu = document.createElement('div');
  menu.className = 'ui-menu context-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  popoverHost().appendChild(menu);
  render(html`<${ContextMenu} items=${items} />`, menu);
  // ui.js hides the menu on every way out and never removes it. The removal
  // waits a task so a choice's own click handler still reaches its item.
  const closed = new MutationObserver(() => {
    if (!menu.hidden) return;
    closed.disconnect();
    setTimeout(() => { render(null, menu); menu.remove(); }, 0);
  });
  closed.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  /** @type {NonNullable<Window['uiFoundation']>} */ (window.uiFoundation).openMenuAt(menu, x, y);
}
/** @param {{ items: ContextMenuItem[] }} props */
function ContextMenu({ items }) {
  return items.map((item, i) => item === null
    ? html`<hr key=${i} class="ui-menu-sep" />`
    : html`<button key=${i} type="button" role="menuitem" class=${'ui-menu-item' + (item.danger ? ' ui-menu-item-danger' : '')} onClick=${() => {
      try { item.onClick(); } catch (e) { console.error(e); }
    }}>${item.label}</button>`);
}

// Wire contextmenu (desktop right-click) and long-press (touch) on an
// element to invoke `buildItems(event)` and open a context menu.
/**
 * @param {HTMLElement} el
 * @param {(e: MouseEvent | TouchEvent) => ContextMenuItem[] | null | undefined} buildItems
 */
export function attachContextMenu(el, buildItems) {
  el.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    const items = buildItems(e);
    if (items && items.length) openContextMenu({ x: e.clientX, y: e.clientY, items });
  });
  // Touch long-press (~400ms). Suppress the click that follows.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pressTimer = null;
  let pressX = 0, pressY = 0;
  let firedLongPress = false;
  el.addEventListener('touchstart', function(e) {
    if (!e.touches || !e.touches[0]) return;
    firedLongPress = false;
    pressX = e.touches[0].clientX;
    pressY = e.touches[0].clientY;
    pressTimer = setTimeout(function() {
      firedLongPress = true;
      const items = buildItems(e);
      if (items && items.length) openContextMenu({ x: pressX, y: pressY, items });
    }, 400);
  }, { passive: true });
  const cancelLongPress = function() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };
  el.addEventListener('touchmove', cancelLongPress, { passive: true });
  el.addEventListener('touchend', cancelLongPress);
  el.addEventListener('touchcancel', cancelLongPress);
  // Swallow the synthetic click that follows a long-press.
  el.addEventListener('click', function(e) {
    if (firedLongPress) { e.preventDefault(); e.stopPropagation(); firedLongPress = false; }
  }, true);
}
