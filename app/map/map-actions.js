import { displayRegion, manifestRoutes, state } from '../core.js';
import { dataLayer } from '../store.js';
import { html } from '../view.js';
import { PlacePopup, popupElement } from './popups.js';
import { openEditPlaceModal } from '../places/edit-place.js';
import { getMarkerSize, getPinStyle } from '../theme.js';
import { openConfirmModal } from '../select.js';

/** @typedef {import('../core.js').Place} Place */
/** @typedef {import('../core.js').ManifestRoute} ManifestRoute */
/** @typedef {import('./route-layer.js').LeafletMap} LeafletMap */
/** @typedef {import('./route-layer.js').LeafletLayer} LeafletLayer */
/** @typedef {import('./route-layer.js').RouteRecord} RouteRecord */
/**
 * @typedef {object} DeletePlaceOptions
 * @property {boolean} [animate] collapse the place's card while the delete runs
 * @property {() => void} [deleted] runs once the server has deleted it
 * @property {(prevColors: Object<string, string>) => void} [after] runs once the refresh lands
 * @property {(err: Error) => void} [onError] replaces the default alert
 */

// Pan/zoom to a place marker and open its popup. With clustering on, a plain
// setView+openPopup leaves the marker buried inside an unexpanded cluster;
// zoomToShowLayer breaks the cluster apart first.
/**
 * @param {LeafletMap} map
 * @param {Place} place
 */
export function goToPlace(map, place) {
  revealPlaceMarker(map, place);
  history.replaceState(null, '', '#/?focus=place:' + encodeURIComponent(place.name));
}
/**
 * @param {LeafletMap} map
 * @param {string} key
 */
export function goToRoute(map, key) {
  const entry = (state._routeLayers || []).find((/** @type {RouteRecord} */ t) => t.route.key === key);
  history.replaceState(null, '', '#/?focus=route:' + encodeURIComponent(key));
  if (entry) {
    // Route is already loaded - fit to its actual bounds and open
    // the popup directly.
    /** @type {LeafletLayer[]} */
    const layers = [];
    entry.layer.eachLayer((/** @type {LeafletLayer} */ l) => { if (l.getBounds) layers.push(l); });
    if (layers.length) {
      const b = layers[0].getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
      if (entry.layer.openPopup) entry.layer.openPopup(b.getCenter());
    }
    return;
  }
  // Not loaded yet (lazy-loaded by viewport intersection). Fit to the
  // manifest bbox so the viewport intersects the route, which kicks off
  // the load.
  const route = manifestRoutes().find(rt => rt.key === key);
  if (route && route.bbox && route.bbox.length === 4) {
    const b = L.latLngBounds([route.bbox[0], route.bbox[1]], [route.bbox[2], route.bbox[3]]);
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
  }
}
/** @param {number} size */
export function placeMarkerRadius(size) { return Math.max(3, (size / 2) - 2); }
// Pins are canvas drawings with no Leaflet marker to anchor to, so the popup
// has to clear the pin itself. A tag starts at its coordinate, the others
// are centred on it.
// An element, not a string: update() would rewrite a string from scratch,
// dropping the listener.
/**
 * @param {LeafletMap} map
 * @param {Place} place
 */
export function placePopupContent(map, place) {
  return popupElement(html`<${PlacePopup} place=${place}
    onEdit=${() => { map.closePopup(); openEditPlaceModal(place); }} />`);
}
/**
 * @param {LeafletMap} map
 * @param {Place} place
 */
export function openPlacePopup(map, place) {
  const lift = getPinStyle() === 'tag' ? 0 : placeMarkerRadius(getMarkerSize());
  const offsetY = L.Popup.prototype.options.offset[1] - lift;
  return L.popup({ closeButton: false, offset: [0, offsetY] })
    .setLatLng([place.lat, place.lon])
    .setContent(placePopupContent(map, place))
    .openOn(map);
}
/**
 * @param {LeafletMap} map
 * @param {Place} place
 */
export function revealPlaceMarker(map, place) {
  const cg = state._placeClusterGroup;
  if (cg && typeof cg.revealPlace === 'function') {
    cg.revealPlace(place);
  } else {
    map.setView([place.lat, place.lon], Math.max(map.getZoom(), 12));
    openPlacePopup(map, place);
  }
}

// Close any open filter or view popover, so only one is open at a time. Pass
// the popover being opened to keep it open. The account menu closes itself
// (ui.js) on a click outside it.
/** @param {HTMLElement} [keepEl] */
export function closeTransientOverlays(keepEl) {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.filter-popover')).forEach(function(p) {
    if (p === keepEl || p.hidden) return;
    p.hidden = true;
    const b = p.parentElement && p.parentElement.querySelector('.filter-btn');
    if (b) b.setAttribute('aria-expanded', 'false');
  });
}

// Force a style recalc so a class change is observed as a transition start
// rather than batched away. Used for entry animations and for restarting
// a keyframe animation on repeated triggers.
/** @param {HTMLElement} el */
function forceReflow(el) { void el.offsetWidth; }

// Append `cls` then strip it on the next tick so the element animates
// from the .cls state to its base state. Caller-controlled CSS transition.
/**
 * @param {HTMLElement | null | undefined} el
 * @param {string} cls
 */
export function playEnter(el, cls) {
  if (!el) return;
  el.classList.add(cls);
  forceReflow(el);
  el.classList.remove(cls);
}

// Add `cls` (typically a transform/opacity off state), call `done` after
// either the resulting transition ends or `fallbackMs` elapses, whichever
// is first. Guarantees `done` runs exactly once.
/**
 * @param {HTMLElement | null | undefined} el
 * @param {string} cls
 * @param {() => void} done
 * @param {number} [fallbackMs]
 */
export function playLeave(el, cls, done, fallbackMs) {
  if (!el) { done(); return; }
  el.classList.add(cls);
  let fired = false;
  const fire = () => { if (fired) return; fired = true; done(); };
  el.addEventListener('transitionend', fire, { once: true });
  setTimeout(fire, fallbackMs || 300);
}

// The list follows the store, so the card leaves when the delete lands; the
// collapse plays meanwhile. A failed delete restores the card. after(prevColors)
// runs once the refresh lands.
/**
 * @param {Place} place
 * @param {DeletePlaceOptions} opts
 */
function deletePlaceNow(place, { animate, deleted, after, onError }) {
  const prevColors = Object.assign({}, state.categoryColors);
  const slug = place._slug || '';
  const anim = animate ? animatePlaceCardOut(slug) : Promise.resolve();
  return dataLayer.deletePlace({ id: place.id })
    .then(() => {
      if (deleted) deleted();
      const layer = state._placeClusterGroup;
      return Promise.all([layer ? layer.fadeOutPlace(place) : null]);
    })
    .then(() => anim)
    .then(() => { if (after) after(prevColors); })
    .catch(err => {
      if (animate) restorePlaceCard(slug);
      (onError || function(/** @type {Error} */ e) { alert('Delete failed: ' + e.message); })(err);
    });
}

/**
 * @param {Place} place
 * @param {DeletePlaceOptions} opts
 */
export function deletePlaceItem(place, opts) {
  return openConfirmModal({
    title: 'Delete place',
    body: 'Delete "' + place.name + '"? This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  }).then(function(ok) { if (ok) return deletePlaceNow(place, opts); });
}

/**
 * @param {ManifestRoute} route
 * @param {string} regionName
 * @param {() => void} after
 */
export function deleteRouteItem(route, regionName, after) {
  return openConfirmModal({
    title: 'Delete route',
    body: 'Delete "' + route.name + '" (' + displayRegion(regionName) + ')? This removes the GPX file.',
    confirmLabel: 'Delete',
    danger: true,
  }).then(function(ok) {
    if (!ok) return;
    return dataLayer.deleteGpx({ region: regionName, name: route.name })
      .then(() => after())
      .catch(err => alert('Delete failed: ' + err.message));
  });
}

// Undo animatePlaceCardOut after a delete that failed.
/** @param {string} slug */
function restorePlaceCard(slug) {
  const card = /** @type {HTMLElement | null} */ (document.querySelector('.place-card[data-place-slug="' + slug + '"]'));
  if (card) card.removeAttribute('style');
}

// Collapse a place card to zero height + opacity, then resolve. Lets
// following cards in the grid flow up smoothly instead of jumping when
// the list re-renders. Reduced-motion users get an immediate resolve.
/**
 * @param {string} slug
 * @returns {Promise<void>}
 */
function animatePlaceCardOut(slug) {
  return new Promise(function(resolve) {
    if (!slug) { resolve(); return; }
    const card = /** @type {HTMLElement | null} */ (document.querySelector('.place-card[data-place-slug="' + slug + '"]'));
    if (!card) { resolve(); return; }
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { resolve(); return; }
    const h = card.offsetHeight;
    card.style.height = h + 'px';
    card.style.overflow = 'hidden';
    forceReflow(card);
    card.style.transition = 'height 180ms ease-in, opacity 180ms ease-in, padding 180ms ease-in, border-width 180ms ease-in, margin 180ms ease-in';
    card.style.height = '0';
    card.style.opacity = '0';
    card.style.paddingTop = '0';
    card.style.paddingBottom = '0';
    card.style.marginTop = '0';
    card.style.marginBottom = '0';
    card.style.borderTopWidth = '0';
    card.style.borderBottomWidth = '0';
    setTimeout(resolve, 190);
  });
}

/** @param {HTMLElement | null | undefined} el */
export function pulseChip(el) {
  if (!el) return;
  el.classList.remove('pulse');
  // Force reflow so the animation restarts on repeated clicks.
  forceReflow(el);
  el.classList.add('pulse');
  el.addEventListener('animationend', () => el.classList.remove('pulse'), { once: true });
}
