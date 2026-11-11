import {
  addButton, displayCategory, displayRegion, setActiveTab, setCrumb, sortedCategorySlugs, state,
} from '../core.js';
import { gpxUrlFor, isReadOnly, routeStatusColor } from '../server.js';
import { collapseCreditOnPhone, MapPanel } from './map-panel.js';
import { addPhoneMapButtons } from './map-phone.js';
import {
  DEFAULT_CONFIG, getRememberView, loadStoredView, placesEnabled, routesEnabled, saveStoredView,
} from '../prefs.js';
import { enableWheelZoom } from './map-wheel.js';
import { addTileLayersToMap, applyCoverMinZoom, cleanupMap, mapScheduler } from './map-layers.js';
import {
  adjustTrailStrokes, applyNonScalingStroke, applyRouteHighlight, attachGLRoutes,
  bindTrailStrokeMotion, fetchGpxText, setSelectedRoute, simplifyRouteForZoom,
} from './route-layer.js';
import { fadeOutRoute, initAreaLayers, openAreaPopupAt } from './area-layer.js';
import { html, renderFresh } from '../view.js';
import { t } from '../i18n.js';
import { popupElement, RoutePopup } from './popups.js';
import { openPlacePopup, revealPlaceMarker } from './map-actions.js';
import { applyMapFilters, createPlaceLayerGroup, initUnifiedSearch, placeShown, routeShown } from './place-layer.js';
import { focusHash } from '../router.js';
import { getTrailWeightFactor } from '../theme.js';
import { openAddModal, openMapPlaceContextMenu, openMapRouteContextMenu } from '../lazy-open.js';

/** @typedef {import('./route-layer.js').RouteRecord} RouteRecord */
/** @typedef {import('./place-layer.js').Pt} Pt */
/** @typedef {import('../core.js').ManifestRoute} ManifestRoute */
/** @typedef {import('../core.js').ManifestRegion} ManifestRegion */
/** @typedef {{ type: string, slug?: string, name?: string }} Focus */
// One manifest route, with what its line and popup are drawn from. `sig`
// changes when any of it does.
/** @typedef {{ route: ManifestRoute, region: ManifestRegion, color: string, parent: any, gpxUrl: string, sig: string }} RouteDescriptor */

/** @param {Focus | null | undefined} focus */
export function renderUnifiedMap(focus) {
  setActiveTab('map');
  setCrumb('');
  const prevView = state.currentMap
    ? { center: state.currentMap.getCenter(), zoom: state.currentMap.getZoom() }
    : null;
  // If any filter is active, ignore the persisted "remember last view" so
  // the initial fit zooms to the filtered subset instead of restoring an
  // unrelated location.
  const anyFilterActive = (state.hiddenRegions && state.hiddenRegions.size > 0)
    || (state.hiddenCategories && state.hiddenCategories.size > 0)
    || !state.showVisited || !state.showWant
    || !state.showCompleted || !state.showPlanned;
  const storedView = (!prevView && getRememberView() && !anyFilterActive) ? loadStoredView() : null;
  cleanupMap();

  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const mapEl = document.createElement('div');
  mapEl.id = 'map';
  app.replaceChildren(mapEl);

  // An in-app place click is a "take me there" intent: initialize the map
  // already centered on the pin so it doesn't first paint the previous view
  // (e.g. Norway) and then visibly jump to the target (e.g. Japan).
  let focusInitialView = null;
  if (state._navByHash && focus && focus.type === 'place' && state.places) {
    const fp = state.places.find(p =>
      focus.slug ? focus.slug === p._slug : focus.name === p.name);
    if (fp) {
      const baseZoom = (prevView || storedView || {}).zoom;
      focusInitialView = { center: [fp.lat, fp.lon], zoom: Math.max(baseZoom || 0, 12) };
    }
  }

  const dv = focusInitialView || prevView || storedView || ((!placesEnabled() && routesEnabled())
    ? (state.config.default_view_routes || DEFAULT_CONFIG.default_view_routes)
    : (state.config.default_view || DEFAULT_CONFIG.default_view));
  const map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    maxBounds: [[-90, -200], [90, 200]],
    maxBoundsViscosity: 1.0,
    markerZoomAnimation: false,
    // enableWheelZoom animates the wheel instead of Leaflet's stepped zoom.
    scrollWheelZoom: false,
    // Default zoomSnap (integer release): zoomSnap:0 makes the touch pinch
    // re-round the tile pixel-origin every fractional frame, which vibrates
    // the map. The GL route layer follows the release animation via its own
    // zoomanim interpolation (see attachGLRoutes) so it stays glued instead.
    renderer: L.svg()
  }).setView(dv.center, dv.zoom);
  enableWheelZoom(map);
  L.control.attribution({ prefix: false }).addTo(map);
  collapseCreditOnPhone(map);
  state.currentMap = map;
  const sched = mapScheduler(map);
  applyCoverMinZoom(map);
  map.on('resize', function() { applyCoverMinZoom(map); });
  // Keep route stroke widths constant through zoom (desktop) and settle at
  // rest (all devices); see bindTrailStrokeMotion for the per-pointer split.
  bindTrailStrokeMotion(map);
  addTileLayersToMap(map);
  attachGLRoutes(map);
  initAreaLayers(map);

  if (getRememberView()) {
    map.on('moveend zoomend', function() {
      const c = map.getCenter();
      saveStoredView({ center: [c.lat, c.lng], zoom: map.getZoom() });
    });
  }

  // Re-thin loaded routes to the new zoom so the overview never re-projects
  // more vertices than the screen can resolve, then re-run stroke fixup.
  map.on('zoomend', function() {
    const layers = state._routeLayers;
    if (!layers || !layers.length) return;
    const z = map.getZoom();
    for (const rl of layers) simplifyRouteForZoom(rl.layer, z);
    adjustTrailStrokes();
  });

  // Places
  const clusterGroup = createPlaceLayerGroup();

  const placeRecords = [];
  const placeBounds = L.latLngBounds();
  let focusPlace = null;

  // Build the record list regardless of the Visible-features toggle so
  // that the toggle can flip layer visibility without a map rebuild.
  // The canvas layer is only added to the map by applyMapFilters when
  // placesEnabled() is true.
  if (state.places) {
    for (const p of state.places) {
      placeRecords.push(p);
      if (placesEnabled()) {
        const filteredOut = state.hiddenCategories.has(p.category)
          || (p.visited && !state.showVisited)
          || (!p.visited && !state.showWant);
        if (!filteredOut) placeBounds.extend([p.lat, p.lon]);
      }
      if (focus && focus.type === 'place' && (focus.slug ? focus.slug === p._slug : focus.name === p.name)) focusPlace = p;
    }
  }

  state._placeRecords = placeRecords;
  state._placeClusterGroup = clusterGroup;

  // Routes: two groups by status
  const groupCompleted = L.featureGroup();
  const groupPlanned = L.featureGroup();
  /** @type {RouteRecord[]} */
  const routeLayers = [];
  const routeBounds = L.latLngBounds();
  let focusTrailKey = (focus && focus.type === 'route' && focus.name) || null;
  let focusTrailLayer = null;
  // Arriving with a route focus (e.g. back from its detail view) highlights
  // that route on the index map too, matching the click behavior.
  state._selectedRouteKey = focusTrailKey;

  // Lazy GPX loading. Building one polyline per route up-front grows
  // linearly with the manifest; viewport-based on-demand loading keeps
  // the working set bounded regardless of total route count. The
  // manifest's per-route bbox is still used synchronously for initial
  // fit, so the map opens at the right area without waiting on any
  // GPX fetch.
  /** @type {RouteDescriptor[]} */
  const routeDescriptors = [];
  const loadedRouteKeys = new Set();
  const pendingRouteKeys = new Set();
  // The signature covers everything the line and its popup are drawn from,
  // so an edited route is loaded again rather than kept stale.
  const routeDescriptor = function(/** @type {ManifestRoute} */ route, /** @type {ManifestRegion} */ region) {
    return {
      route, region,
      color: routeStatusColor(route.completed),
      parent: route.completed ? groupCompleted : groupPlanned,
      gpxUrl: gpxUrlFor(route.file),
      sig: region.name + '\n' + JSON.stringify(route),
    };
  };
  if (state.manifest) {
    for (const region of state.manifest.regions) {
      for (const route of region.routes) {
        routeDescriptors.push(routeDescriptor(route, region));
        const visibleStatus = route.completed ? state.showCompleted : state.showPlanned;
        if (route.bbox && route.bbox.length === 4
            && !state.hiddenRegions.has(region.name)
            && visibleStatus) {
          routeBounds.extend([route.bbox[0], route.bbox[1]]);
          routeBounds.extend([route.bbox[2], route.bbox[3]]);
        }
      }
    }
  }

  state._routeLayers = routeLayers;
  state._routeGroupCompleted = groupCompleted;
  state._routeGroupPlanned = groupPlanned;

  // Map-level near-tap detector: stock Leaflet only fires polyline
  // click when the tap lands within ~1px of the stroke, which is
  // brutal on touch. Walk visible routes on every map click and
  // pick the closest segment within ~18px; if found, behave as if
  // the user had hit the polyline exactly.
  const NEAR_TAP_PX = 18;
  /** @param {Pt} p @param {Pt} a @param {Pt} b */
  function pointSegDistSq(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (!len2) { const ax = p.x - a.x, ay = p.y - a.y; return ax * ax + ay * ay; }
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = a.x + t * dx, cy = a.y + t * dy;
    return (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
  }
  /** @param {RouteRecord} record */
  function isLayerVisible(record) {
    if (state.hiddenRegions.has(record.region)) return false;
    return record.completed ? state.showCompleted : state.showPlanned;
  }
  // All visible routes whose nearest segment is within the tap zone,
  // sorted closest-first (min distance per route). Lets click handling
  // cycle through routes stacked under one spot instead of always
  // re-picking the single nearest.
  /** @param {Pt} containerPt */
  function nearTrailCandidates(containerPt) {
    if (!state._routeLayers || !state._routeLayers.length) return [];
    const thresh = NEAR_TAP_PX * NEAR_TAP_PX;
    const dists = new Map();
    const visit = function(/** @type {any} */ layer, /** @type {RouteRecord} */ record) {
      if (layer.getLatLngs && !layer.eachLayer) {
        const raw = layer.getLatLngs();
        const flat = Array.isArray(raw) && Array.isArray(raw[0]) ? [].concat.apply([], raw) : raw;
        for (let i = 0; i < flat.length - 1; i++) {
          const a = map.latLngToContainerPoint(flat[i]);
          const b = map.latLngToContainerPoint(flat[i + 1]);
          const d2 = pointSegDistSq(containerPt, a, b);
          if (d2 < thresh) {
            const prev = dists.get(record);
            if (prev === undefined || d2 < prev) dists.set(record, d2);
          }
        }
      }
      if (layer.eachLayer) layer.eachLayer(function(/** @type {any} */ sub) { visit(sub, record); });
    };
    for (const record of state._routeLayers) {
      if (!isLayerVisible(record)) continue;
      visit(record.layer, record);
    }
    return Array.from(dists.entries()).sort((a, b) => a[1] - b[1]).map(e => e[0]);
  }
  /** @param {Pt} containerPt */
  function findNearTrail(containerPt) {
    const c = nearTrailCandidates(containerPt);
    return c.length ? c[0] : null;
  }
  // Leaflet closes an open popup on preclick. That tap only dismisses it, or
  // on a large area every tap to close a popup would open the next one.
  let popupOpenOnPress = false;
  map.on('preclick', function() { popupOpenOnPress = !!(map._popup && map._popup.isOpen()); });
  map.on('click', function(/** @type {any} */ e) {
    // A tap on a place or a group is the place layer's, even where a route
    // runs under it. Its listener is added after this one, so a group's zoom
    // has not moved the map yet.
    const cg = state._placeClusterGroup;
    if (cg && typeof cg._hitTest === 'function' && cg._hitTest(e.containerPoint)) {
      setSelectedRoute(null);
      return;
    }
    const cands = nearTrailCandidates(e.containerPoint);
    if (cands.length) {
      // If the current selection is one of the routes under the cursor,
      // advance to the next so repeated clicks at one spot step through
      // the overlapping stack; otherwise take the nearest.
      let pick = cands[0];
      const idx = cands.findIndex(r => r.route.key === state._selectedRouteKey);
      if (idx !== -1 && cands.length > 1) pick = cands[(idx + 1) % cands.length];
      const slug = pick.route._slug || pick.route.key;
      history.replaceState(null, '', focusHash('route', slug));
      setSelectedRoute(pick.route.key);
      pick.layer.openPopup(e.latlng);
    } else {
      setSelectedRoute(null);
      if (!popupOpenOnPress) openAreaPopupAt(map, e);
    }
  });
  // Right-click on the map: hit-test for a place pin first (canvas
  // layer), then a route polyline (near-tap detector). The first hit
  // wins; if nothing's under the cursor the browser context menu shows.
  map.on('contextmenu', function(/** @type {any} */ e) {
    const cg = state._placeClusterGroup;
    if (cg && typeof cg._hitTest === 'function') {
      const target = cg._hitTest(e.containerPoint);
      if (target && !target.properties.cluster) {
        L.DomEvent.preventDefault(e.originalEvent);
        L.DomEvent.stopPropagation(e.originalEvent);
        openMapPlaceContextMenu(target.properties.place, e.originalEvent, map);
        return;
      }
    }
    const best = findNearTrail(e.containerPoint);
    if (best) {
      L.DomEvent.preventDefault(e.originalEvent);
      L.DomEvent.stopPropagation(e.originalEvent);
      openMapRouteContextMenu(best.route, best.region, e.originalEvent, map);
    }
  });
  // Show the pointer cursor across the full near-tap zone, not just
  // the 1-2px polyline stroke. mousemove on Leaflet fires only when
  // the cursor moves over the map, so this stays cheap.
  let _nearCursor = false;
  map.on('mousemove', function(/** @type {any} */ e) {
    const near = !!findNearTrail(e.containerPoint);
    if (near === _nearCursor) return;
    _nearCursor = near;
    map.getContainer().classList.toggle('route-near-cursor', near);
  });

  /** @param {RouteDescriptor} desc */
  function loadRouteLazy(desc) {
    if (loadedRouteKeys.has(desc.route.key) || pendingRouteKeys.has(desc.route.key)) return;
    pendingRouteKeys.add(desc.route.key);
    fetchGpxText(desc.gpxUrl).then(function(text) {
      // Dropped (deleted or edited) while the file was in flight.
      if (!routeDescriptors.includes(desc)) return;
      const gpxLayer = new L.GPX(text, {
        async: true,
        // Not interactive: a stroke that took its own clicks would open its
        // card over a place drawn on it, and the map's click handler already
        // hits every route within reach of a tap.
        polyline_options: { color: desc.color, opacity: 0.85, weight: 4 * getTrailWeightFactor(), className: 'route-line', interactive: false },
        // Waypoints hidden on the index map; revealed in detail view only.
        markers: { startIcon: null, endIcon: null, wptIcons: { '': null }, wptTypeIcons: { '': null } },
      });
      gpxLayer.on('loaded', function(/** @type {any} */ e) {
        // Thin dense tracks to the current zoom before anything reads the
        // geometry (bounds, renderer, stroke). Detail view uses full GPX.
        simplifyRouteForZoom(e.target, map.getZoom());
        const b = e.target.getBounds();
        if (b.isValid()) routeBounds.extend(b);
        if (focusTrailKey && desc.route.key === focusTrailKey) {
          focusTrailLayer = e.target;
          if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
        }
        applyNonScalingStroke(e.target);
        // A selection may already be active (route focus, or a click
        // before this route finished loading); dim/fatten this one to match.
        if (state._selectedRouteKey) applyRouteHighlight();
        // Cache the renderer the first time a route loads so
        // adjustTrailStrokes can force a re-project on smooth-zoom
        // frames. All polylines on the index map share one renderer.
        if (!state._routeRenderer) {
          const findRenderer = function(/** @type {any} */ layer) {
            if (layer._renderer) return layer._renderer;
            if (typeof layer.eachLayer === 'function') {
              let found = /** @type {any} */ (null);
              layer.eachLayer(function(/** @type {any} */ sub) { if (!found) found = findRenderer(sub); });
              return found;
            }
            return null;
          };
          state._routeRenderer = findRenderer(e.target);
        }
      }).on('error', function(/** @type {any} */ e) {
        console.warn('[ferd] gpx parse failed for', desc.gpxUrl, e && e.err);
        try { desc.parent.removeLayer(gpxLayer); } catch (_) {}
      }).bindPopup(
        () => popupElement(html`<${RoutePopup} route=${desc.route} region=${desc.region} />`),
        { closeButton: false }
      );
      routeLayers.push({ route: desc.route, region: desc.region.name, layer: gpxLayer, completed: desc.route.completed });
      loadedRouteKeys.add(desc.route.key);
      pendingRouteKeys.delete(desc.route.key);
      applyMapFilters();
    }).catch(function(err) {
      pendingRouteKeys.delete(desc.route.key);
      console.warn('[ferd] gpx fetch failed for', desc.gpxUrl, err);
    });
  }

  // Skip routes whose bbox would render smaller than this many pixels
  // at the current zoom; they'd be visual noise on a continent-zoom view.
  const MIN_ROUTE_VISIBLE_PX = 6;
  /** @param {RouteDescriptor} desc @param {any} paddedBounds @param {number} mapZoom */
  function routeShouldLoad(desc, paddedBounds, mapZoom) {
    const b = desc.route.bbox;
    if (!b || b.length !== 4) return true; // no bbox info, conservative
    const sw = L.latLng(b[0], b[1]);
    const ne = L.latLng(b[2], b[3]);
    if (!paddedBounds.intersects(L.latLngBounds(sw, ne))) return false;
    const sp = map.project(sw, mapZoom);
    const np = map.project(ne, mapZoom);
    const dx = Math.abs(np.x - sp.x);
    const dy = Math.abs(np.y - sp.y);
    return Math.sqrt(dx * dx + dy * dy) >= MIN_ROUTE_VISIBLE_PX;
  }
  function evaluateVisibleRoutes() {
    if (!map._loaded) return;
    const padded = map.getBounds().pad(0.5);
    const zoom = map.getZoom();
    for (const desc of routeDescriptors) {
      if (loadedRouteKeys.has(desc.route.key) || pendingRouteKeys.has(desc.route.key)) continue;
      if (focusTrailKey && desc.route.key === focusTrailKey) { loadRouteLazy(desc); continue; }
      if (routeShouldLoad(desc, padded, zoom)) loadRouteLazy(desc);
    }
  }
  /** @type {number | null} */
  let _routeEvalTimer = null;
  function scheduleTrailEval() {
    if (_routeEvalTimer) sched.clearTimeout(_routeEvalTimer);
    _routeEvalTimer = sched.timeout(evaluateVisibleRoutes, 150);
  }
  map.on('moveend', scheduleTrailEval);
  // Kick an initial evaluation: when the map opens at a stored or
  // focus view, no moveend fires after we register the listener, so
  // visible routes would only load on the user's first pan.
  scheduleTrailEval();

  applyMapFilters();

  // Drop one route from this map in place, pruning the lazy-load
  // bookkeeping too, so a later pan can't refetch a deleted GPX from the SW
  // cache and resurrect it. Returns the layer if it was loaded.
  /** @param {string} key */
  function dropRoute(key) {
    for (let i = routeDescriptors.length - 1; i >= 0; i--) {
      if (routeDescriptors[i].route.key === key) routeDescriptors.splice(i, 1);
    }
    loadedRouteKeys.delete(key);
    pendingRouteKeys.delete(key);
    let found = null;
    for (let i = routeLayers.length - 1; i >= 0; i--) {
      if (routeLayers[i].route.key !== key) continue;
      const layer = routeLayers[i].layer;
      try { if (layer.closePopup) layer.closePopup(); } catch (_) {}
      routeLayers.splice(i, 1);
      found = layer;
    }
    return found;
  }

  // A metadata-only edit (name, status, tags, rating) keeps the drawn line:
  // the loaded layer is restyled and its records updated in place, so the
  // GPX is neither fetched nor parsed again. A moved file or region, or a
  // line still loading, takes the drop-and-reload path.
  /** @param {RouteDescriptor} desc @param {RouteDescriptor} now */
  function restyleRoute(desc, now) {
    if (now.gpxUrl !== desc.gpxUrl || now.region.name !== desc.region.name) return false;
    const key = desc.route.key;
    if (pendingRouteKeys.has(key)) return false;
    const loaded = loadedRouteKeys.has(key);
    Object.assign(desc, now);
    if (!loaded) return true;
    for (const rec of routeLayers) {
      if (rec.route.key !== key) continue;
      rec.route = desc.route;
      rec.region = desc.region.name;
      rec.completed = desc.route.completed;
      try { rec.layer.setStyle({ color: desc.color }); } catch (_) {}
      try { const pop = rec.layer.getPopup && rec.layer.getPopup(); if (pop && pop.isOpen && pop.isOpen()) pop.update(); } catch (_) {}
    }
    return true;
  }

  // Brings this map in line with the routes signal without a rebuild (a
  // blink and a refit): a route gone from the manifest fades out, a new one
  // waits for the next viewport check, and an edited one is restyled in place, or loaded again if its file moved.
  state._syncRoutesOnMap = function() {
    const next = new Map();
    for (const region of (state.manifest && state.manifest.regions) || []) {
      for (const route of region.routes) next.set(route.key, routeDescriptor(route, region));
    }
    const fades = [];
    let changed = false;
    let restyled = false;
    for (const desc of routeDescriptors.slice()) {
      const now = next.get(desc.route.key);
      if (now && now.sig === desc.sig) { next.delete(desc.route.key); continue; }
      if (now && restyleRoute(desc, now)) { next.delete(desc.route.key); restyled = true; continue; }
      const layer = dropRoute(desc.route.key);
      if (!now && layer && map.hasLayer(layer)) fades.push(layer);
      if (!now && state._selectedRouteKey === desc.route.key) state._selectedRouteKey = null;
      changed = true;
    }
    for (const desc of next.values()) { routeDescriptors.push(desc); changed = true; }
    if (!changed && !restyled) return;
    // applyMapFilters clears and re-adds the status groups from routeLayers,
    // so a dropped layer leaves the map; applyRouteHighlight re-strokes the
    // survivors (SVG) and rebuilds the GL buffer (touch).
    applyMapFilters();
    applyRouteHighlight();
    for (const layer of fades) fadeOutRoute(map, layer);
    scheduleTrailEval();
  };

  // Initial bounds: places + routes, prefer focus
  if (focusPlace) {
    // On reload at a place URL, keep the user's prior view (prevView /
    // storedView) instead of forcing a zoom-in to the place. Opening the
    // popup is enough acknowledgement; zooming would push every other
    // marker out of the viewport, which reads as "the overlays vanished".
    // But an explicit in-app navigation (clicking a place in the list or
    // search) is a "take me there" intent, so center on the pin even when a
    // view is remembered.
    const restoredView = !state._navByHash && !!(prevView || storedView);
    sched.timeout(function() {
      if (restoredView) {
        openPlacePopup(map, focusPlace);
      } else {
        revealPlaceMarker(map, focusPlace);
      }
    }, 300);
  } else if (!focusTrailKey && !prevView && !storedView) {
    const combined = L.latLngBounds();
    if (placeBounds.isValid()) combined.extend(placeBounds);
    if (routeBounds.isValid()) combined.extend(routeBounds);
    const areaBounds = state._areaGroup.getBounds();
    if (areaBounds.isValid()) combined.extend(areaBounds);
    if (combined.isValid()) map.fitBounds(combined, { padding: [40, 40] });
  }

  // Filter panel
  const PanelControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function() {
      const div = L.DomUtil.create('div', 'map-panel');
      div.id = 'map-panel';
      renderFresh(html`<${MapPanel} />`, div);
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    }
  });
  if (placesEnabled() || routesEnabled()) {
    map.addControl(new PanelControl());
    addPhoneMapButtons(map);
    bindFilterPanel();
    refreshFilterPanel();
    initUnifiedSearch(map);
  }

  // Add action lives in the nav (left of Menu), like the list pages.
  const navActionsEl = document.getElementById('nav-actions');
  if (navActionsEl && state.auth.authenticated && !isReadOnly() && (placesEnabled() || routesEnabled())) {
    const title = placesEnabled() && routesEnabled()
      ? t('history.addEither')
      : (placesEnabled() ? t('place.add') : t('add.titleRoute'));
    const btn = addButton('map-add-btn', title);
    btn.addEventListener('click', function() { openAddModal(null); });
    navActionsEl.replaceChildren(btn);
  }
}

/** @typedef {'places' | 'routes'} FilterSection */

const checkMark = () => html`<svg class="filter-row-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

// One row per category or region, in the desktop panel and the phone's sheet
// alike. syncFilterControls fills in the count.
/** @param {string} attr @param {string} key @param {boolean} on @param {string} label */
function filterRow(attr, key, on, label) {
  return html`<button type="button" class="filter-row" ...${{ [attr]: key }} aria-pressed=${String(on)}>
    <span class="filter-row-label">${label}</span><span class="filter-row-count"></span>${checkMark()}
  </button>`;
}
/** @param {FilterSection} section */
function filterRows(section) {
  if (section === 'places') {
    return sortedCategorySlugs(Object.keys(state.categoryColors)).map(cat =>
      filterRow('data-cat', cat, !state.hiddenCategories.has(cat), displayCategory(cat)));
  }
  const regions = state.manifest && state.manifest.regions ? state.manifest.regions.map(r => r.name) : [];
  return regions.map(r => filterRow('data-region', r, !state.hiddenRegions.has(r), displayRegion(r)));
}
/** @param {FilterSection} section */
function rowList(section) {
  const rows = filterRows(section);
  if (!rows.length) return null;
  const label = section === 'places' ? t('mapFilter.categories') : t('mapFilter.regions');
  return html`<div class="filter-rows" role="group" aria-label=${label}>
    <p class="ui-list-head" aria-hidden="true">${label}</p>${rows}
  </div>`;
}

/** @param {FilterSection} section */
function statusValue(section) {
  const [done, planned] = section === 'places'
    ? [state.showVisited, state.showWant]
    : [state.showCompleted, state.showPlanned];
  return done && planned ? 'all' : done ? 'done' : planned ? 'planned' : '';
}
// Status is one choice of three rather than two switches, since switching
// both off would only empty the map. A default from Settings can still
// leave none of the three chosen.
/** @param {FilterSection} section @param {string} scope keeps the radio name apart from the other view's */
function statusChoice(section, scope) {
  const value = statusValue(section);
  const options = [
    ['all', t('mapFilter.all')],
    ['done', section === 'places' ? t('mapFilter.visited') : t('mapFilter.completed')],
    ['planned', t('mapFilter.planned')],
  ];
  return html`<div class="ui-choice-list ui-choice-segmented filter-status" role="radiogroup" aria-label=${t('mapFilter.status')} data-status=${section}>
    ${options.map(([v, label]) => html`<label class="ui-choice"><input type="radio" name=${scope + '-' + section + '-status'} value=${v} checked=${v === value} />${label}</label>`)}
  </div>`;
}

// The phone's filter button carries a dot while anything is filtered out,
// since its sheet is closed most of the time.
export function filtersActive() {
  return state.hiddenCategories.size > 0 || state.hiddenRegions.size > 0 ||
    !state.showVisited || !state.showWant || !state.showCompleted || !state.showPlanned;
}
export function syncFilterDot() {
  const btn = document.getElementById('map-filter-btn');
  if (btn) btn.classList.toggle('has-active', filtersActive());
}

// Redraws every open filter view: the desktop panel and the phone's sheet.
export function refreshFilterPanel() {
  const placesBody = document.getElementById('places-body');
  if (placesBody) renderFresh(rowList('places'), placesBody);
  const routesBody = document.getElementById('routes-body');
  if (routesBody) renderFresh(rowList('routes'), routesBody);
  renderPanelStatus();
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.filter-sheet [data-sheet-section]')).forEach(el => {
    renderFresh(sheetSection(/** @type {FilterSection} */ (el.dataset.sheetSection)), el);
  });
  syncFilterControls();
}

/** @param {FilterSection} id */
function sheetSection(id) {
  const places = id === 'places';
  return html`<div class="filter-head">
      <h3 class="filter-sheet-title" id=${'filter-sheet-' + id}>${places ? t('mapFilter.places') : t('mapFilter.routes')}<span class="filter-count" data-count=${id}></span></h3>
      <button type="button" class="filter-link" data-toggle-all=${id}></button>
    </div>
    ${statusChoice(id, 'sheet')}
    ${rowList(id)}`;
}
// The whole sheet, handle and head included, as openViewModal's views render
// theirs. refreshFilterPanel fills each section.
export function FilterSheet() {
  /** @param {string} id */
  const section = id => html`<section class="filter-sheet-section" data-sheet-section=${id} aria-labelledby=${'filter-sheet-' + id}></section>`;
  return html`<div class="ui-dialog-handle" aria-hidden="true"></div>
    <div class="ui-dialog-head">
      <h2 class="ui-dialog-title">${t('mapFilter.title')}</h2>
      <button type="button" class="filter-link" data-filter-reset>${t('mapFilter.reset')}</button>
    </div>
    <div class="ui-dialog-body"><div class="filter-sheet">
      ${placesEnabled() ? section('places') : null}
      ${routesEnabled() ? section('routes') : null}
    </div></div>`;
}

function allPlacesOn() { return state.hiddenCategories.size === 0 && state.showVisited && state.showWant; }
function allRoutesOn() { return state.hiddenRegions.size === 0 && state.showCompleted && state.showPlanned; }

// Brings every count, check and choice in line with the state, in place, so a
// tap never redraws the control under the finger. Routes count from the
// manifest, since their map layers arrive later.
function syncFilterControls() {
  const routes = state.manifest && state.manifest.regions
    ? state.manifest.regions.flatMap(r => r.routes.map(t => ({ region: r.name, completed: t.completed })))
    : [];
  const places = state._placeRecords || [];
  /** @type {Record<string, number[]>} */
  const counts = {
    places: [places.filter(placeShown).length, places.length],
    routes: [routes.filter(routeShown).length, routes.length],
  };
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-count]')).forEach(el => {
    const [shown, total] = counts[el.dataset.count || ''];
    el.textContent = total ? t('mapFilter.shown', { shown, total }) : '';
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-toggle-all]')).forEach(el => {
    const allOn = el.dataset.toggleAll === 'places' ? allPlacesOn() : allRoutesOn();
    el.textContent = allOn ? t('mapFilter.hideAll') : t('mapFilter.showAll');
  });
  // A row counts what it would show under the chosen status, whether it is
  // hidden or not, so a hidden row says what it would bring back.
  /** @type {Map<string, number>} */
  const perKey = new Map();
  if (state._placeRecords) {
    for (const p of places) if (p.visited ? state.showVisited : state.showWant) perKey.set('cat:' + p.category, (perKey.get('cat:' + p.category) || 0) + 1);
  }
  for (const r of routes) if (r.completed ? state.showCompleted : state.showPlanned) perKey.set('region:' + r.region, (perKey.get('region:' + r.region) || 0) + 1);
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.filter-row')).forEach(row => {
    const isCat = row.dataset.cat !== undefined;
    const set = isCat ? state.hiddenCategories : state.hiddenRegions;
    const key = /** @type {string} */ (isCat ? row.dataset.cat : row.dataset.region);
    row.setAttribute('aria-pressed', String(!set.has(key)));
    const count = row.querySelector('.filter-row-count');
    const n = perKey.get((isCat ? 'cat:' : 'region:') + key) || 0;
    if (count) count.textContent = isCat && !state._placeRecords ? '' : String(n);
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-status]')).forEach(group => {
    const value = statusValue(/** @type {FilterSection} */ (group.dataset.status));
    group.querySelectorAll('input').forEach(input => { input.checked = input.value === value; });
  });
  const reset = /** @type {HTMLButtonElement | null} */ (document.querySelector('[data-filter-reset]'));
  if (reset) reset.disabled = !filtersActive();
  syncFilterDot();
}

// Which section is currently open (accordion = at most one).
function activePanelSection() {
  const p = document.getElementById('places-section');
  if (p && p.classList.contains('open')) return 'places';
  const r = document.getElementById('routes-section');
  if (r && r.classList.contains('open')) return 'routes';
  return null;
}

// The status choice lives in one footer below the accordion sections, so it
// stays put across tab switches, and shows the open tab's. Hidden when both
// tabs are collapsed.
/** @param {FilterSection | null} [active] the open section, read from the DOM when not given */
function renderPanelStatus(active = activePanelSection()) {
  const el = document.getElementById('panel-status');
  if (!el) return;
  if (!active) { renderFresh(null, el); el.style.display = 'none'; return; }
  el.style.display = '';
  renderFresh(html`<div class="filter-head">
      <span class="filter-count" data-count=${active}></span>
      <button type="button" class="filter-link" data-toggle-all=${active}></button>
    </div>
    ${statusChoice(active, 'panel')}`, el);
}

// Hide all empties the list and leaves the status choice alone, since that
// has no "none" to show. Show all brings back everything.
function toggleAllPlaces() {
  if (allPlacesOn()) Object.keys(state.categoryColors).forEach(c => state.hiddenCategories.add(c));
  else {
    state.hiddenCategories.clear();
    state.showVisited = true; state.showWant = true;
  }
  applyMapFilters();
  syncFilterControls();
}

function toggleAllRoutes() {
  if (allRoutesOn()) (state.manifest ? state.manifest.regions.map(r => r.name) : []).forEach(r => state.hiddenRegions.add(r));
  else {
    state.hiddenRegions.clear();
    state.showCompleted = true; state.showPlanned = true;
  }
  applyMapFilters();
  syncFilterControls();
}

// Delegated, so the handlers survive refreshFilterPanel replacing the rows.
/** @param {MouseEvent} e */
function onFilterClick(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  const all = /** @type {HTMLElement | null} */ (target.closest('[data-toggle-all]'));
  if (all) {
    if (all.dataset.toggleAll === 'places') toggleAllPlaces(); else toggleAllRoutes();
    return;
  }
  const row = /** @type {HTMLElement | null} */ (target.closest('.filter-row'));
  if (!row) return;
  const isCat = row.dataset.cat !== undefined;
  const set = isCat ? state.hiddenCategories : state.hiddenRegions;
  const key = /** @type {string} */ (isCat ? row.dataset.cat : row.dataset.region);
  if (set.has(key)) set.delete(key); else set.add(key);
  applyMapFilters();
  syncFilterControls();
}
/** @param {Event} e */
function onStatusChange(e) {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) return;
  const group = /** @type {HTMLElement | null} */ (input.closest('[data-status]'));
  if (!group) return;
  const done = input.value !== 'planned';
  const planned = input.value !== 'done';
  if (group.dataset.status === 'places') { state.showVisited = done; state.showWant = planned; }
  else { state.showCompleted = done; state.showPlanned = planned; }
  applyMapFilters();
  syncFilterControls();
}
/** @param {HTMLElement} el */
function bindFilterControls(el) {
  el.addEventListener('click', onFilterClick);
  el.addEventListener('change', onStatusChange);
}

/** @param {HTMLElement} dialog */
export function bindFilterSheet(dialog) {
  dialog.addEventListener('click', function(/** @type {MouseEvent} */ e) {
    if (!/** @type {HTMLElement} */ (e.target).closest('[data-filter-reset]')) return;
    state.hiddenCategories.clear();
    state.hiddenRegions.clear();
    state.showVisited = state.showWant = state.showCompleted = state.showPlanned = true;
    applyMapFilters();
    syncFilterControls();
  });
  bindFilterControls(dialog);
}

export function bindFilterPanel() {
  // Section tabs: an accordion. ui.js opens or closes the clicked section
  // from its aria-controls, after this listener; this one closes the other
  // section and renders the status row for the state the click leaves.
  document.querySelectorAll('.panel-head').forEach(function(tab) {
    tab.addEventListener('click', /** @this {HTMLElement} */ function() {
      const id = this.getAttribute('aria-controls') || '';
      const section = document.getElementById(id);
      if (!section) return;
      document.querySelectorAll('.panel-head').forEach(t => {
        const other = t.getAttribute('aria-controls') || '';
        if (other === id) return;
        t.setAttribute('aria-expanded', 'false');
        const body = document.getElementById(other);
        if (body) body.classList.remove('open');
      });
      renderPanelStatus(section.classList.contains('open') ? null : /** @type {FilterSection} */ (id.replace(/-section$/, '')));
      syncFilterControls();
    });
  });
  ['places-body', 'routes-body', 'panel-status'].forEach(id => {
    const el = document.getElementById(id);
    if (el) bindFilterControls(el);
  });
}
