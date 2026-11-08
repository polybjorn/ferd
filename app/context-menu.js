import { state } from './core.js';
import { isReadOnly } from './server.js';
import { deletePlaceItem, deleteRouteItem, openPlacePopup } from './map/index.js';
import { openEditTrailMetadataModal } from './routes/route-meta.js';
import { openEditPlaceModal } from './places/edit-place.js';
import { findCatalogUpdate, openCatalogUpdateModal } from './places-list.js';
import { focusHash } from './router.js';
import { popoverHost } from './modal.js';

/** @typedef {import('./core.js').Place} Place */
/** @typedef {import('./core.js').ManifestRoute} ManifestRoute */
/** @typedef {import('./map/route-layer.js').LeafletMap} LeafletMap */
/** A menu entry, or `null` for a divider. @typedef {{ label: string, onClick: () => void, danger?: boolean } | null} ContextMenuItem */

// Generic floating context menu. Pass `items` as an array of
// { label, onClick, danger? } objects, or `null` to insert a divider.
// Auto-closes on click outside, Escape, scroll, or window blur.
/** @type {HTMLDivElement | null} */
let _ctxMenuEl = null;
// Every way the menu closes comes through here, so every one of them takes the
// dismissal listeners with it.
function closeContextMenu() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
  _ctxTeardown();
}
/** @param {string} type @param {string} slug */
function copyShareLink(type, slug) {
  const url = location.origin + location.pathname + focusHash(type, slug);
  const fallback = () => prompt('Copy this link:', url);
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
  items.push({ label: 'Open', onClick: function() {
    openPlacePopup(map, place);
    history.replaceState(null, '', focusHash('place', place._slug || place.name));
  } });
  if (Array.isArray(place.sources) && place.sources.length) {
    items.push({ label: 'Go to source', onClick: function() { window.open(/** @type {string[]} */ (place.sources)[0], '_blank', 'noopener'); } });
  }
  if (!isReadOnly() && state.auth && state.auth.authenticated) {
    items.push({ label: 'Edit', onClick: function() { openEditPlaceModal(place); } });
  }
  if (place.from_catalog && findCatalogUpdate(place)) {
    items.push({ label: 'Apply catalog update', onClick: function() { openCatalogUpdateModal(place); } });
  }
  items.push({ label: 'Copy link', onClick: function() { copyShareLink('place', place._slug || place.name); } });
  if (!isReadOnly() && state.auth && state.auth.authenticated) {
    items.push(null);
    items.push({ label: 'Delete', danger: true, onClick: function() {
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
  items.push({ label: 'Open', onClick: function() { location.hash = '#/routes/route/' + encodeURIComponent(route.key); } });
  if (route.source) {
    items.push({ label: 'Go to source', onClick: function() { window.open(route.source, '_blank', 'noopener'); } });
  }
  if (!isReadOnly() && state.auth && state.auth.authenticated) {
    items.push({ label: 'Edit', onClick: function() { openEditTrailMetadataModal(route, regionName); } });
  }
  items.push({ label: 'Copy link', onClick: function() { copyShareLink('route', slug); } });
  if (!isReadOnly() && state.auth && state.auth.authenticated) {
    items.push(null);
    items.push({ label: 'Delete', danger: true, onClick: function() {
      deleteRouteItem(route, regionName, function() { /* the map follows the store */ });
    }});
  }
  openContextMenu({ x: oe.clientX, y: oe.clientY, items });
}

/** @param {{ x: number, y: number, items: ContextMenuItem[] }} opts */
function openContextMenu({ x, y, items }) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  for (const item of items) {
    if (item === null) {
      const sep = document.createElement('div');
      sep.className = 'ctx-divider';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    if (item.danger) btn.className = 'danger';
    btn.addEventListener('click', function() {
      closeContextMenu();
      try { item.onClick(); } catch (e) { console.error(e); }
    });
    menu.appendChild(btn);
  }
  popoverHost().appendChild(menu);
  // Clamp to viewport (measure after mount).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, vw - rect.width - 8);
  const top  = Math.min(y, vh - rect.height - 8);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top  = Math.max(8, top) + 'px';
  _ctxMenuEl = menu;
  // Dismissal listeners (next tick so the opening click doesn't fire them).
  setTimeout(function() {
    // Closed (or replaced) before this tick: nothing left to dismiss.
    if (_ctxMenuEl !== menu) return;
    document.addEventListener('click', _ctxOutsideClick, true);
    document.addEventListener('contextmenu', _ctxOutsideClick, true);
    document.addEventListener('keydown', _ctxKey, true);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('blur', closeContextMenu);
  }, 0);
}
/** @param {Event} e */
function _ctxOutsideClick(e) {
  if (!_ctxMenuEl) return;
  if (_ctxMenuEl.contains(/** @type {Node | null} */ (e.target))) return;
  closeContextMenu();
}
/** @param {KeyboardEvent} e */
function _ctxKey(e) {
  if (e.key === 'Escape') closeContextMenu();
}
function _ctxTeardown() {
  document.removeEventListener('click', _ctxOutsideClick, true);
  document.removeEventListener('contextmenu', _ctxOutsideClick, true);
  document.removeEventListener('keydown', _ctxKey, true);
  window.removeEventListener('scroll', closeContextMenu, true);
  window.removeEventListener('blur', closeContextMenu);
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
