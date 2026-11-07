import { displayRegion, state } from '../core.js';
import { dataLayer } from '../store.js';
import { html } from '../view.js';
import { PlacePopup, popupElement } from './popups.js';
import { manifestRoutes } from '../areas.js';
import { openEditPlaceModal } from '../edit-place.js';
import { renderPlaceList } from '../places-list.js';
import { focusHash } from '../router.js';
import { getMarkerSize, getPinStyle } from '../theme.js';
import { openConfirmModal } from '../select.js';

// Pan/zoom to a place marker and open its popup. With clustering on, a plain
// setView+openPopup leaves the marker buried inside an unexpanded cluster;
// zoomToShowLayer breaks the cluster apart first.
export function goToPlace(map, place) {
  revealPlaceMarker(map, place);
  history.replaceState(null, '', '#/?focus=place:' + encodeURIComponent(place.name));
}
export function goToRoute(map, key) {
  const entry = (state._routeLayers || []).find(t => t.route.key === key);
  history.replaceState(null, '', '#/?focus=route:' + encodeURIComponent(key));
  if (entry) {
    // Route is already loaded - fit to its actual bounds and open
    // the popup directly.
    const layers = [];
    entry.layer.eachLayer(l => { if (l.getBounds) layers.push(l); });
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
export function placeMarkerRadius(size) { return Math.max(3, (size / 2) - 2); }
// Pins are canvas drawings with no Leaflet marker to anchor to, so the popup
// has to clear the pin itself. A tag starts at its coordinate, the others
// are centred on it.
// An element, not a string: update() would rewrite a string from scratch,
// dropping the listener.
export function placePopupContent(map, place) {
  return popupElement(html`<${PlacePopup} place=${place}
    onEdit=${() => { map.closePopup(); openEditPlaceModal(place); }} />`);
}
export function openPlacePopup(map, place) {
  const lift = getPinStyle() === 'tag' ? 0 : placeMarkerRadius(getMarkerSize());
  const offsetY = L.Popup.prototype.options.offset[1] - lift;
  return L.popup({ closeButton: false, offset: [0, offsetY] })
    .setLatLng([place.lat, place.lon])
    .setContent(placePopupContent(map, place))
    .openOn(map);
}
export function revealPlaceMarker(map, place) {
  const cg = state._placeClusterGroup;
  if (cg && typeof cg.revealPlace === 'function') {
    cg.revealPlace(place);
  } else {
    map.setView([place.lat, place.lon], Math.max(map.getZoom(), 12));
    openPlacePopup(map, place);
  }
}

// Close transient floating overlays (the account menu and any filter/view
// popover) so only one is open at a time. Pass the element being opened to
// keep it open.
export function closeTransientOverlays(keepEl) {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.filter-popover')).forEach(function(p) {
    if (p === keepEl || p.hidden) return;
    p.hidden = true;
    const b = p.parentElement && p.parentElement.querySelector('.filter-btn');
    if (b) b.setAttribute('aria-expanded', 'false');
  });
  const menu = /** @type {(HTMLElement & { _close?: () => void }) | null} */ (document.getElementById('auth-menu'));
  if (menu && menu !== keepEl && !menu.hidden && typeof menu._close === 'function') {
    menu._close();
  }
}

// Force a style recalc so a class change is observed as a transition start
// rather than batched away. Used for entry animations and for restarting
// a keyframe animation on repeated triggers.
function forceReflow(el) { void el.offsetWidth; }

// Append `cls` then strip it on the next tick so the element animates
// from the .cls state to its base state. Caller-controlled CSS transition.
export function playEnter(el, cls) {
  if (!el) return;
  el.classList.add(cls);
  forceReflow(el);
  el.classList.remove(cls);
}

// Add `cls` (typically a transform/opacity off state), call `done` after
// either the resulting transition ends or `fallbackMs` elapses, whichever
// is first. Guarantees `done` runs exactly once.
export function playLeave(el, cls, done, fallbackMs) {
  if (!el) { done(); return; }
  el.classList.add(cls);
  let fired = false;
  const fire = () => { if (fired) return; fired = true; done(); };
  el.addEventListener('transitionend', fire, { once: true });
  setTimeout(fire, fallbackMs || 300);
}

// Drop the card the moment the collapse finishes, not after the network
// round-trip, so there's no pause between the animation ending and the row
// closing. `failed` guards that optimistic removal against a delete that
// errors and re-renders the list. after(prevColors) runs once the refresh
// lands; callers that keep the list resync survivors there, since deleting
// one of several same-named places renumbers the rest's slugs.
function deletePlaceNow(place, { animate, deleted, after, onError }) {
  const prevColors = Object.assign({}, state.categoryColors);
  const slug = place._slug || '';
  const wasVisited = !!place.visited;
  let failed = false;
  const anim = animate
    ? animatePlaceCardOut(slug).then(function() { if (!failed) removePlaceCardFromList(slug, wasVisited); })
    : Promise.resolve();
  return dataLayer.deletePlace({ id: place.id })
    .then(() => {
      if (deleted) deleted();
      const layer = state._placeClusterGroup;
      return Promise.all([layer ? layer.fadeOutPlace(place) : null]);
    })
    .then(() => anim)
    .then(() => { if (after) after(prevColors); })
    .catch(err => {
      failed = true;
      if (animate && document.getElementById('place-list')) renderPlaceList();
      (onError || function(e) { alert('Delete failed: ' + e.message); })(err);
    });
}

export function deletePlaceItem(place, opts) {
  return openConfirmModal({
    title: 'Delete place',
    body: 'Delete "' + place.name + '"? This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  }).then(function(ok) { if (ok) return deletePlaceNow(place, opts); });
}

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

// Collapse a place card to zero height + opacity, then resolve. Lets
// following cards in the grid flow up smoothly instead of jumping when
// the list re-renders. Reduced-motion users get an immediate resolve.
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

// After a successful delete + collapse animation, drop the card from the
// DOM and patch its group's (visited/total) count. Avoids the innerHTML
// wipe of a full re-render so the rest of the list doesn't flash.
function removePlaceCardFromList(slug, wasVisited) {
  if (!slug) return;
  const card = /** @type {HTMLElement | null} */ (document.querySelector('.place-card[data-place-slug="' + slug + '"]'));
  if (!card) return;
  const grid = card.parentElement;
  const group = grid ? grid.closest('.category-group') : null;
  card.remove();
  if (group) {
    const remaining = grid.querySelectorAll('.place-card').length;
    if (remaining === 0) {
      group.remove();
    } else {
      const countEl = group.querySelector('.place-count');
      if (countEl) {
        const m = /\((\d+)\/(\d+)\)/.exec(countEl.textContent);
        if (m) {
          const v = Math.max(0, parseInt(m[1], 10) - (wasVisited ? 1 : 0));
          const t = Math.max(0, parseInt(m[2], 10) - 1);
          countEl.textContent = '(' + v + '/' + t + ')';
        }
      }
    }
  }
  const listEl = document.getElementById('place-list');
  if (listEl && !listEl.querySelector('.place-card')) {
    listEl.innerHTML = '<div class="loading">No matches</div>';
  }
}

// After a delete, deleting one of several same-named places renumbers the
// survivors' slugs (slug disambiguation is positional). The surgical card
// removal leaves those survivors' DOM slugs stale, which silently breaks
// their context menu / edit. Patch the stale slug attributes in place,
// keyed by the stable place id, instead of re-rendering the whole list
// (which flashes). Cards whose slug is unchanged are skipped, so the
// common unique-name delete does nothing here.
export function resyncPlaceCardSlugs() {
  const listEl = document.getElementById('place-list');
  if (!listEl) return;
  const byId = {};
  for (const p of (state.places || [])) if (p.id) byId[p.id] = p;
  /** @type {NodeListOf<HTMLElement>} */ (listEl.querySelectorAll('.place-card[data-place-id]')).forEach(function(card) {
    const p = byId[card.dataset.placeId];
    if (!p) return;
    const slug = p._slug || '';
    if (card.dataset.placeSlug === slug) return;
    card.dataset.placeSlug = slug;
    const href = focusHash('place', slug || p.name);
    card.setAttribute('onclick', "location.hash='" + href.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
    const mark = /** @type {HTMLElement | null} */ (card.querySelector('.catalog-mark'));
    if (mark) mark.dataset.placeSlug = slug;
  });
}

export function pulseChip(el) {
  if (!el) return;
  el.classList.remove('pulse');
  // Force reflow so the animation restarts on repeated clicks.
  forceReflow(el);
  el.classList.add('pulse');
  el.addEventListener('animationend', () => el.classList.remove('pulse'), { once: true });
}
