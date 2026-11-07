import {
  displayCategory, displayRegion, escapeHtml, setActiveTab, setCrumb, sortedCategorySlugs, state,
} from './core.js';
import { gpxUrlFor, isReadOnly, routeStatusColor } from './server.js';
import { applyCoverMinZoom } from './form-fields.js';
import { collapseCreditOnPhone, panelInnerHtml } from './map-panel.js';
import { addPhoneMapButtons } from './map-phone.js';
import {
  DEFAULT_CONFIG, getRememberView, loadStoredView, placesEnabled, routesEnabled, saveStoredView,
} from './prefs.js';
import { enableWheelZoom } from './map-wheel.js';
import { addTileLayersToMap, cleanupMap, mapScheduler } from './map-layers.js';
import {
  adjustTrailStrokes, applyNonScalingStroke, applyRouteHighlight, attachGLRoutes,
  bindTrailStrokeMotion, fetchGpxText, setSelectedRoute, simplifyRouteForZoom,
} from './route-layer.js';
import { fadeOutRoute, initAreaLayers, openAreaPopupAt } from './areas.js';
import { routePopupHtml } from './route-meta.js';
import { openPlacePopup, pulseChip, revealPlaceMarker } from './map-actions.js';
import { applyMapFilters, createPlaceLayerGroup, initUnifiedSearch } from './place-layer.js';
import { focusHash } from './router.js';
import { getTrailWeightFactor } from './theme.js';
import { openMapPlaceContextMenu, openMapRouteContextMenu } from './context-menu.js';
import { openAddModal } from './add.js';

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

  const app = document.getElementById('app');
  app.innerHTML = '<div id="map"></div>';

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
  const routeLayers = [];
  const routeBounds = L.latLngBounds();
  let focusTrailKey = (focus && focus.type === 'route') ? focus.name : null;
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
  const routeDescriptors = [];
  const loadedRouteKeys = new Set();
  const pendingRouteKeys = new Set();
  if (state.manifest) {
    for (const region of state.manifest.regions) {
      for (const route of region.routes) {
        const color = routeStatusColor(route.completed);
        const parent = route.completed ? groupCompleted : groupPlanned;
        const gpxUrl = gpxUrlFor(route.file);
        routeDescriptors.push({ route, region, color, parent, gpxUrl });
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
  function pointSegDistSq(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (!len2) { const ax = p.x - a.x, ay = p.y - a.y; return ax * ax + ay * ay; }
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = a.x + t * dx, cy = a.y + t * dy;
    return (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
  }
  function isLayerVisible(record) {
    if (state.hiddenRegions.has(record.region)) return false;
    return record.completed ? state.showCompleted : state.showPlanned;
  }
  // All visible routes whose nearest segment is within the tap zone,
  // sorted closest-first (min distance per route). Lets click handling
  // cycle through routes stacked under one spot instead of always
  // re-picking the single nearest.
  function nearTrailCandidates(containerPt) {
    if (!state._routeLayers || !state._routeLayers.length) return [];
    const thresh = NEAR_TAP_PX * NEAR_TAP_PX;
    const dists = new Map();
    const visit = function(layer, record) {
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
      if (layer.eachLayer) layer.eachLayer(function(sub) { visit(sub, record); });
    };
    for (const record of state._routeLayers) {
      if (!isLayerVisible(record)) continue;
      visit(record.layer, record);
    }
    return Array.from(dists.entries()).sort((a, b) => a[1] - b[1]).map(e => e[0]);
  }
  function findNearTrail(containerPt) {
    const c = nearTrailCandidates(containerPt);
    return c.length ? c[0] : null;
  }
  // Leaflet closes an open popup on preclick. That tap only dismisses it, or
  // on a large area every tap to close a popup would open the next one.
  let popupOpenOnPress = false;
  map.on('preclick', function() { popupOpenOnPress = !!(map._popup && map._popup.isOpen()); });
  map.on('click', function(e) {
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
  map.on('contextmenu', function(e) {
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
  map.on('mousemove', function(e) {
    const near = !!findNearTrail(e.containerPoint);
    if (near === _nearCursor) return;
    _nearCursor = near;
    map.getContainer().classList.toggle('route-near-cursor', near);
  });

  function loadRouteLazy(desc) {
    if (loadedRouteKeys.has(desc.route.key) || pendingRouteKeys.has(desc.route.key)) return;
    pendingRouteKeys.add(desc.route.key);
    fetchGpxText(desc.gpxUrl).then(function(text) {
      const gpxLayer = new L.GPX(text, {
        async: true,
        polyline_options: { color: desc.color, opacity: 0.85, weight: 4 * getTrailWeightFactor(), className: 'route-line' },
        // Waypoints hidden on the index map; revealed in detail view only.
        markers: { startIcon: null, endIcon: null, wptIcons: { '': null }, wptTypeIcons: { '': null } },
      });
      gpxLayer.on('loaded', function(e) {
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
          const findRenderer = function(layer) {
            if (layer._renderer) return layer._renderer;
            if (typeof layer.eachLayer === 'function') {
              let found = null;
              layer.eachLayer(function(sub) { if (!found) found = findRenderer(sub); });
              return found;
            }
            return null;
          };
          state._routeRenderer = findRenderer(e.target);
        }
      }).on('error', function(e) {
        console.warn('[ferd] gpx parse failed for', desc.gpxUrl, e && e.err);
        try { desc.parent.removeLayer(gpxLayer); } catch (_) {}
      }).bindPopup(
        routePopupHtml(desc.route, desc.region, desc.color),
        { closeButton: false }
      ).on('click', (function(slug, key) {
        return function(ev) {
          // Stop propagation so the map-level near-tap handler
          // doesn't fire a duplicate replaceState + popup toggle.
          if (ev && ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
          history.replaceState(null, '', focusHash('route', slug));
          // Direct stroke hits skip the map handler, so set the
          // highlight here too, otherwise it stays on the prior route.
          setSelectedRoute(key);
        };
      })(desc.route._slug || desc.route.key, desc.route.key));
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

  // Remove a single route from this map in place (after a delete) without a
  // full rebuild. Prunes the lazy-load bookkeeping too, so a later pan can't
  // refetch the now-deleted GPX from the SW cache and resurrect it. Returns
  // true if the route was known to this map.
  state._removeRouteFromMap = function(key) {
    for (let i = routeDescriptors.length - 1; i >= 0; i--) {
      if (routeDescriptors[i].route.key === key) routeDescriptors.splice(i, 1);
    }
    loadedRouteKeys.delete(key);
    pendingRouteKeys.delete(key);
    let found = false;
    for (let i = routeLayers.length - 1; i >= 0; i--) {
      if (routeLayers[i].route.key !== key) continue;
      const layer = routeLayers[i].layer;
      try { if (layer.closePopup) layer.closePopup(); } catch (_) {}
      routeLayers.splice(i, 1);
      found = layer;
    }
    if (state._selectedRouteKey === key) state._selectedRouteKey = null;
    // applyMapFilters clears + re-adds the status groups from routeLayers,
    // so the spliced layer leaves the map; applyRouteHighlight re-strokes
    // the survivors (SVG) and rebuilds the GL buffer (touch).
    const wasShown = found && map.hasLayer(found);
    applyMapFilters();
    applyRouteHighlight();
    if (wasShown) fadeOutRoute(map, found);
    return !!found;
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
      div.innerHTML = panelInnerHtml();
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
      ? 'Add place or route'
      : (placesEnabled() ? 'Add place' : 'Add route');
    navActionsEl.innerHTML = '<button type="button" id="map-add-btn" class="nav-action-btn" title="' + title + '">Add</button>';
    document.getElementById('map-add-btn').addEventListener('click', function() { openAddModal(null); });
  }
}

function placesLegendHtml() {
  const cats = sortedCategorySlugs(Object.keys(state.categoryColors));
  let html = '<div class="legend-cats">';
  for (const cat of cats) {
    const color = state.categoryColors[cat];
    const hidden = state.hiddenCategories.has(cat);
    html += '<div class="legend-item' + (hidden ? ' disabled' : '') + '" data-cat="' + escapeHtml(cat) + '">';
    html += '<span class="legend-dot" style="background:' + color + '"></span>';
    html += escapeHtml(displayCategory(cat));
    html += '</div>';
  }
  return html + '</div>';
}

function routesLegendHtml() {
  const regions = state.manifest && state.manifest.regions ? state.manifest.regions.map(r => r.name) : [];
  if (!regions.length) return '';
  let html = '<div class="legend-cats">';
  for (const r of regions) {
    const hidden = state.hiddenRegions.has(r);
    html += '<div class="legend-item' + (hidden ? ' disabled' : '') + '" data-region="' + escapeHtml(r) + '">';
    html += escapeHtml(displayRegion(r));
    html += '</div>';
  }
  return html + '</div>';
}

function statusChipsHtml(section) {
  if (section === 'places') {
    return '<div class="status-chip' + (state.showVisited ? ' active' : '') + '" data-filter="visited"><span class="status-dot visited"></span>Visited</div>' +
      '<div class="status-chip' + (state.showWant ? ' active' : '') + '" data-filter="want"><span class="status-dot want"></span>Planned</div>' +
      '<div class="status-chip panel-toggle-all" data-toggle-all="places">Toggle all</div>';
  }
  return '<div class="status-chip' + (state.showCompleted ? ' active' : '') + '" data-route-status="completed"><span class="status-dot completed"></span>Completed</div>' +
    '<div class="status-chip' + (state.showPlanned ? ' active' : '') + '" data-route-status="planned"><span class="status-dot planned"></span>Planned</div>' +
    '<div class="status-chip panel-toggle-all" data-toggle-all="routes">Toggle all</div>';
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
  if (placesBody) placesBody.innerHTML = placesLegendHtml();
  const routesBody = document.getElementById('routes-body');
  if (routesBody) routesBody.innerHTML = routesLegendHtml();
  renderPanelStatus();
  document.querySelectorAll('.filter-sheet [data-legend]').forEach(el => {
    el.innerHTML = el.dataset.legend === 'places' ? placesLegendHtml() : routesLegendHtml();
  });
  document.querySelectorAll('.filter-sheet [data-status]').forEach(el => {
    el.innerHTML = statusChipsHtml(el.dataset.status);
  });
  syncFilterDot();
}

// The phone's filter sheet shows both sections open, each with its chips.
export function filterSheetHtml() {
  const section = (id, title) =>
    '<section class="filter-sheet-section">' +
      '<h3 class="filter-sheet-title">' + title + '</h3>' +
      '<div class="legend-status" data-status="' + id + '">' + statusChipsHtml(id) + '</div>' +
      '<div class="panel-section-body" data-legend="' + id + '">' +
        (id === 'places' ? placesLegendHtml() : routesLegendHtml()) + '</div>' +
    '</section>';
  return '<div class="filter-sheet">' +
    (placesEnabled() ? section('places', 'Places') : '') +
    (routesEnabled() ? section('routes', 'Routes') : '') +
    '</div>';
}

// Which section is currently open (accordion = at most one).
function activePanelSection() {
  const p = document.getElementById('places-section');
  if (p && !p.classList.contains('collapsed')) return 'places';
  const r = document.getElementById('routes-section');
  if (r && !r.classList.contains('collapsed')) return 'routes';
  return null;
}

// The status chips live in one persistent footer (not inside the animated
// section bodies) so they stay put across tab switches; only the leading
// chip's label swaps Visited<->Completed for the active tab. Hidden when
// both tabs are collapsed.
function renderPanelStatus() {
  const el = document.getElementById('panel-status');
  if (!el) return;
  const active = activePanelSection();
  if (!active) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = statusChipsHtml(active);
}

// Toggle-all handlers, called from the delegated body click handlers (the
// controls live inside the section bodies, which refreshFilterPanel rebuilds).
function toggleAllPlaces() {
  const cats = Object.keys(state.categoryColors);
  const allOn = state.hiddenCategories.size === 0 && state.showVisited && state.showWant;
  if (allOn) {
    cats.forEach(c => state.hiddenCategories.add(c));
    state.showVisited = false; state.showWant = false;
  } else {
    state.hiddenCategories.clear();
    state.showVisited = true; state.showWant = true;
  }
  refreshFilterPanel();
  applyMapFilters();
}

function toggleAllRoutes() {
  const regions = state.manifest ? state.manifest.regions.map(r => r.name) : [];
  const allOn = state.hiddenRegions.size === 0 && state.showCompleted && state.showPlanned;
  if (allOn) {
    regions.forEach(r => state.hiddenRegions.add(r));
    state.showCompleted = false; state.showPlanned = false;
  } else {
    state.hiddenRegions.clear();
    state.showCompleted = true; state.showPlanned = true;
  }
  refreshFilterPanel();
  applyMapFilters();
}

// Delegated, so the handler survives refreshFilterPanel replacing the items.
// Toggles flip in place rather than re-render, which would cut the pulse.
export function bindFilterClicks(el) {
  el.addEventListener('click', function(e) {
    const item = e.target.closest('.legend-item[data-cat], .legend-item[data-region]');
    if (item) {
      const isCat = item.dataset.cat !== undefined;
      const set = isCat ? state.hiddenCategories : state.hiddenRegions;
      const key = isCat ? item.dataset.cat : item.dataset.region;
      if (set.has(key)) set.delete(key); else set.add(key);
      item.classList.toggle('disabled', set.has(key));
      pulseChip(item);
      applyMapFilters();
      syncFilterDot();
      return;
    }
    const chip = e.target.closest('.status-chip');
    if (!chip) return;
    if (chip.classList.contains('panel-toggle-all')) {
      if (chip.dataset.toggleAll === 'places') toggleAllPlaces();
      else toggleAllRoutes();
      return;
    }
    if (chip.dataset.filter === 'visited') state.showVisited = !state.showVisited;
    else if (chip.dataset.filter === 'want') state.showWant = !state.showWant;
    else if (chip.dataset.routeStatus === 'completed') state.showCompleted = !state.showCompleted;
    else if (chip.dataset.routeStatus === 'planned') state.showPlanned = !state.showPlanned;
    chip.classList.toggle('active');
    pulseChip(chip);
    applyMapFilters();
    syncFilterDot();
  });
}

export function bindFilterPanel() {
  // Section tabs: accordion. Clicking a collapsed tab expands it and
  // collapses the other; clicking the open tab collapses everything.
  document.querySelectorAll('.panel-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      const section = document.getElementById(this.dataset.section);
      if (!section) return;
      const wasCollapsed = section.classList.contains('collapsed');
      document.querySelectorAll('.panel-section').forEach(s => s.classList.add('collapsed'));
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('expanded'));
      if (wasCollapsed) {
        section.classList.remove('collapsed');
        this.classList.add('expanded');
      }
      renderPanelStatus();
    });
  });
  ['places-body', 'routes-body', 'panel-status'].forEach(id => {
    const el = document.getElementById(id);
    if (el) bindFilterClicks(el);
  });
}
