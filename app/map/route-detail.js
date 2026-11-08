import {
  GPX_NS, ROUTE_COLOR, TRACK_COLORS, displayRegion, domainFromUrl, escapeHtml, formatDistance,
  formatElevation, setActiveTab, setCrumb, state,
} from '../core.js';
import { gpxUrlFor, isReadOnly } from '../server.js';
import { collapseCreditOnPhone } from './map-panel.js';
import { DEFAULT_CONFIG, getShowField, isImperial } from '../prefs.js';
import { enableWheelZoom } from './map-wheel.js';
import { addTileLayersToMap, applyCoverMinZoom, cleanupMap, mapScheduler } from './map-layers.js';
import {
  WAYPOINT_PLACEHOLDER_ICON, attachWaypointHandlers, makeWaypointIcon,
} from './map-markers.js';
import {
  MAX_ELEV_POINTS, adjustTrailStrokes, applyNonScalingStroke, bindTrailStrokeMotion,
  decimateCoords, fetchGpxText, simplifyRouteForZoom,
} from './route-layer.js';
import { EXTERNAL_ICON_SVG } from './map-popups.js';
import { DIFFICULTY_LABELS, findRouteByKey, openEditTrailMetadataModal, ratingStarsText, routeIsMoving } from '../routes/route-meta.js';
import { getTrailWeightFactor } from '../theme.js';
import { wrappedRouter } from '../router.js';
import { routes } from '../store.js';
import { html as vhtml, mountExtra, useEffect, useRef } from '../view.js';

export function parseGpxTracks(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  let tracks = doc.getElementsByTagNameNS(GPX_NS, 'trk');
  if (tracks.length === 0) tracks = doc.getElementsByTagName('trk');
  const result = [];
  for (let i = 0; i < tracks.length; i++) {
    const trk = tracks[i];
    const nameEl = trk.getElementsByTagNameNS(GPX_NS, 'name')[0] || trk.getElementsByTagName('name')[0];
    const name = nameEl ? nameEl.textContent : 'Track ' + (i + 1);
    const points = [];
    let trkpts = trk.getElementsByTagNameNS(GPX_NS, 'trkpt');
    if (trkpts.length === 0) trkpts = trk.getElementsByTagName('trkpt');
    for (let j = 0; j < trkpts.length; j++) {
      const pt = trkpts[j];
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      const eleEl = pt.getElementsByTagNameNS(GPX_NS, 'ele')[0] || pt.getElementsByTagName('ele')[0];
      const ele = eleEl ? parseFloat(eleEl.textContent) : null;
      points.push({ lat, lon, ele });
    }
    result.push({ name, points });
  }
  return result;
}

function parseGpxWaypoints(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  let wpts = doc.getElementsByTagNameNS(GPX_NS, 'wpt');
  if (wpts.length === 0) wpts = doc.getElementsByTagName('wpt');
  const out = [];
  for (let i = 0; i < wpts.length; i++) {
    const w = wpts[i];
    const lat = parseFloat(w.getAttribute('lat'));
    const lon = parseFloat(w.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    // Only render waypoints with an explicit <sym>; waypoints without
    // are typically routing artifacts from tools like gpx.studio or
    // Google Maps (geocoded via-points), not user-marked POIs.
    const symEl = w.getElementsByTagNameNS(GPX_NS, 'sym')[0] || w.getElementsByTagName('sym')[0];
    const sym = symEl ? symEl.textContent.trim() : '';
    if (!sym) continue;
    const nameEl = w.getElementsByTagNameNS(GPX_NS, 'name')[0] || w.getElementsByTagName('name')[0];
    const descEl = w.getElementsByTagNameNS(GPX_NS, 'desc')[0] || w.getElementsByTagName('desc')[0];
    out.push({
      lat, lon, sym,
      name: nameEl ? nameEl.textContent : '',
      desc: descEl ? descEl.textContent : '',
    });
  }
  return out;
}

// Skip waypoints within this radius (m) of the route's start/end so
// they don't visually collide with the start/end markers (common for
// loop routes where the GPX records the start point as a waypoint).
const WAYPOINT_ENDPOINT_SUPPRESS_M = 75;
function addGpxWaypoints(map, waypoints, startLatLng, endLatLng) {
  for (const w of waypoints) {
    const ll = L.latLng(w.lat, w.lon);
    if (startLatLng && ll.distanceTo(startLatLng) < WAYPOINT_ENDPOINT_SUPPRESS_M) continue;
    if (endLatLng && ll.distanceTo(endLatLng) < WAYPOINT_ENDPOINT_SUPPRESS_M) continue;
    const m = L.marker(ll, { icon: makeWaypointIcon() });
    const body = '<b>' + escapeHtml(w.name) + '</b>' + (w.desc ? '<br>' + escapeHtml(w.desc) : '');
    m.bindPopup(body, { closeButton: false });
    m.addTo(map);
  }
}

function computeTrackStats(points) {
  let distance = 0, gain = 0, loss = 0, maxEle = -Infinity;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], curr = points[i];
    distance += L.latLng(prev.lat, prev.lon).distanceTo(L.latLng(curr.lat, curr.lon));
    if (curr.ele !== null && prev.ele !== null) {
      const diff = curr.ele - prev.ele;
      if (diff > 0) gain += diff; else loss -= diff;
      if (curr.ele > maxEle) maxEle = curr.ele;
    }
  }
  if (points.length > 0 && points[0].ele !== null && points[0].ele > maxEle) maxEle = points[0].ele;
  return { distance, gain, loss, maxEle };
}

function trackToGeoJSON(track) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: track.points.map(p => [p.lon, p.lat, p.ele]) },
    properties: {},
  };
}

export function renderTrailDetail(routeKey) {
  setActiveTab('routes', 'route');
  cleanupMap();
  const app = document.getElementById('app');
  if (!state.manifest) { app.innerHTML = '<div class="app-state" aria-busy="true"><p class="ui-hint" role="status">Loading routes...</p></div>'; return; }

  let route = null, regionName = '';
  for (const region of state.manifest.regions) {
    for (const r of region.routes) {
      if (r.key === routeKey) { route = r; regionName = region.name; break; }
    }
    if (route) break;
  }
  if (!route) { setCrumb('Not found', true); app.innerHTML = '<div class="app-state"><p class="app-error" role="alert">Route not found</p></div>'; return; }
  setCrumb(route.name, true);

  const color = ROUTE_COLOR;

  // The meta panel, crumb and Edit button follow the store (RouteMeta, below);
  // the map and graphs are built once for this route's GPX.
  // The old top stats bar is gone; stats live on the elevation header now.
  const navStatsEl = document.getElementById('nav-stats-dynamic');
  if (navStatsEl) navStatsEl.innerHTML = '';

  const isMultiTrack = route.trackCount && route.trackCount > 1;

  let html = '<div class="detail-layout">';
  html += '<div id="map"></div>';
  if (isMultiTrack) {
    // Any multi-segment route: a fixed graph on top (whole route by
    // default) over a collapsible segment list. renderMultiTrack fills this
    // in after the GPX parses, so render a same-height shell now (title +
    // 174px graph + toggle bar). Otherwise the container is 0-height until
    // the parse lands, the flex-grow map fills the gap, and populating it
    // shrinks + re-fits the map - a jarring "reload" a second or two in.
    html += '<div id="multi-elevation-container" class="elev-dropdown-host">' +
      '<div class="detail-elev-title"><span class="detail-elev-title-text">Whole route</span></div>' +
      '<div class="detail-elev-graph"></div>' +
      '<div class="elev-segments"><button type="button" class="elev-segments-toggle collapsed"><span class="elev-toggle-label">Elevation by segment</span></button></div>' +
    '</div>';
  } else if (route.hasElevation) {
    // Single-track: same collapsible graph-title + graph as the
    // many-segment view, so single and multi look and behave alike.
    html += '<div class="detail-elev-title" id="single-elev-title" role="button" tabindex="0" title="Show or hide the graph"><span class="detail-elev-title-text">Elevation</span><span class="seg-stat" id="single-elev-stats"></span></div>';
    html += '<div class="detail-elev-graph" id="elevation-container" style="--track-color:' + color + '"></div>';
  } else {
    html += '<div class="detail-elev-statbar"><span class="seg-stat" id="single-elev-stats"></span></div>';
    html += '<div class="no-elevation-notice">No elevation data available for this route</div>';
  }
  html += '<div id="route-meta-mount"></div>';
  html += '</div>';
  app.innerHTML = html;
  mountExtra(vhtml`<${RouteMeta} routeKey=${routeKey} />`, document.getElementById('route-meta-mount'));

  const dvt = state.config.default_view_routes || DEFAULT_CONFIG.default_view_routes;
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
    // the map. The detail view's routes are SVG (zoom-animated overlay pane),
    // so they ride the release animation with the tiles.
    renderer: L.svg()
  });
  enableWheelZoom(map);
  // Fit to the route's bbox up-front so the initial tile load is near
  // the route instead of the routes-default view (Norway), avoiding a
  // visible jump when GPX-driven fitBounds settles a moment later.
  // Also stashes the bbox as state._lastTrailBounds so the GPX-load
  // handlers and the ResizeObserver skip their own fitBounds (the
  // manifest bbox includes waypoints, while gpx.getBounds() doesn't,
  // and reconciling produces a perceptible re-zoom).
  if (route.bbox && route.bbox.length === 4) {
    const bb = L.latLngBounds([route.bbox[0], route.bbox[1]], [route.bbox[2], route.bbox[3]]);
    map.fitBounds(bb, { padding: [40, 40] });
    state._lastTrailBounds = bb;
  } else {
    map.setView(dvt.center, dvt.zoom);
  }
  L.control.attribution({ prefix: false }).addTo(map);
  collapseCreditOnPhone(map);
  state.currentMap = map;
  const sched = mapScheduler(map);
  applyCoverMinZoom(map);
  // Map container shrinks asynchronously as the elevation chart and
  // other detail-view widgets settle. Sync Leaflet's known size and
  // force a polyline repaint so the route stays drawn, but leave the
  // viewport alone — refitting against the new size would zoom-jump
  // a moment after the initial bbox fit, which is jarring.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(function() {
      map.invalidateSize();
      // Repaint vector layers only. Redrawing the tile layer here forces a
      // full tile reload (a visible flash) on every resize - e.g. when the
      // graph section is collapsed - which invalidateSize already handles.
      map.eachLayer(function(l) { if (typeof l.redraw === 'function' && !(l instanceof L.TileLayer)) l.redraw(); });
      adjustTrailStrokes();
    });
    ro.observe(map.getContainer());
    state._currentMapResizeObserver = ro;
  }
  // Keep route stroke widths constant through zoom (desktop) and settle at
  // rest (all devices); see bindTrailStrokeMotion for the per-pointer split.
  bindTrailStrokeMotion(map);
  addTileLayersToMap(map);

  // Show the on-map elevation position marker only while an elevation
  // chart is hovered or touched. Uses pointer events so a single code
  // path covers mouse, touch, and pen; the corresponding CSS rule
  // hides .height-focus when .elev-hover is absent.
  const mapEl = map.getContainer();
  ['elevation-container', 'multi-elevation-container'].forEach(function(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const show = function() { mapEl.classList.add('elev-hover'); };
    const hide = function() { mapEl.classList.remove('elev-hover'); };
    el.addEventListener('pointerenter', show);
    el.addEventListener('pointerdown', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('pointerup', hide);
    el.addEventListener('pointercancel', hide);
  });

  // Expand-map toggle: hides the elevation chart and metadata panel.
  const layoutEl = document.querySelector('.detail-layout');
  const ExpandControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      const btn = L.DomUtil.create('a', 'leaflet-bar leaflet-control map-expand-btn');
      btn.href = '#';
      btn.title = 'Expand map';
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-label', 'Expand map');
      btn.innerHTML =
        '<svg class="icon-expand" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<polyline points="2,6 2,2 6,2"/><polyline points="14,6 14,2 10,2"/><polyline points="2,10 2,14 6,14"/><polyline points="14,10 14,14 10,14"/>'
        + '</svg>'
        + '<svg class="icon-collapse" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<polyline points="6,2 6,6 2,6"/><polyline points="10,2 10,6 14,6"/><polyline points="6,14 6,10 2,10"/><polyline points="10,14 10,10 14,10"/>'
        + '</svg>';
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', function(e) {
        L.DomEvent.preventDefault(e);
        const expanded = layoutEl.classList.toggle('map-expanded');
        btn.title = expanded ? 'Collapse map' : 'Expand map';
        btn.setAttribute('aria-label', btn.title);
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce) {
          map.invalidateSize();
        } else {
          const start = performance.now();
          const tick = function(now) {
            map.invalidateSize({ animate: false, pan: false });
            if (now - start < 320) sched.frame(tick);
          };
          sched.frame(tick);
        }
      });
      return btn;
    }
  });
  map.addControl(new ExpandControl());

  if (route.plannedFile && route.completed) {
    fetchGpxText(gpxUrlFor(route.plannedFile)).then(sched.live(function(plannedText) {
      const plannedLayer = new L.GPX(plannedText, {
        async: true,
        polyline_options: { color: ROUTE_COLOR, opacity: 0.35, weight: 4 * getTrailWeightFactor(), dashArray: '8 6' },
        markers: { startIcon: null, endIcon: null, wptIcons: { '': WAYPOINT_PLACEHOLDER_ICON } },
      });
      attachWaypointHandlers(plannedLayer);
      plannedLayer.on('loaded', sched.live(function(e) {
        applyNonScalingStroke(e.target);
      })).addTo(map);
    })).catch(function() {});
  }

  if (isMultiTrack) renderMultiTrack(map, route, sched);
  else renderSingleTrack(map, route, color, sched);
}

function renderSingleTrack(map, route, color, sched) {
  // Collapsible graph title, mirroring the multi-segment view: clicking it
  // hides the chart and the map grows to fill the space.
  const sTitle = document.getElementById('single-elev-title');
  const sGraph = document.getElementById('elevation-container');
  if (sTitle && sGraph) {
    const toggleGraph = function() {
      const c = sTitle.classList.toggle('collapsed');
      sGraph.classList.toggle('collapsed', c);
    };
    sTitle.addEventListener('click', toggleGraph);
    sTitle.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGraph(); }
    });
  }
  let elevationControl = null;
  if (route.hasElevation) {
    elevationControl = L.control.elevation({
      theme: 'custom-theme',
      detached: true,
      elevationDiv: '#elevation-container',
      height: 200,
      imperial: isImperial(),
      slope: false, speed: false, acceleration: false, time: false,
      legend: false, summary: false, ruler: false, downloadLink: false,
      almostOver: false, distanceMarkers: false, autofitBounds: false, fitBounds: false,
      polyline: { color: color, opacity: 0.9, weight: 5 * getTrailWeightFactor() },
    }).addTo(map);
    state.currentElevation = elevationControl;
  }

  // Pre-fetch the GPX text (auth-aware, SW-cached) rather than handing
  // L.GPX a URL: its internal XHR can't carry the bearer token a
  // cross-origin client needs.
  fetchGpxText(gpxUrlFor(route.file)).then(sched.live(function(gpxText) {
  const singleGpx = new L.GPX(gpxText, {
    async: true,
    polyline_options: { color: color, opacity: 0.9, weight: 5 * getTrailWeightFactor() },
    markers: { startIcon: null, endIcon: null, wptIcons: { '': WAYPOINT_PLACEHOLDER_ICON } },
  });
  attachWaypointHandlers(singleGpx);
  singleGpx.on('loaded', sched.live(function(e) {
    const gpx = e.target;
    const bounds = gpx.getBounds();
    if (bounds.isValid() && !state._lastTrailBounds) {
      state._lastTrailBounds = bounds;
      map.fitBounds(bounds, { padding: [40, 40] });
    }
    applyNonScalingStroke(gpx);
    // Register the GPX polylines for per-frame re-projection so their
    // stroke stays a constant width through zoom (see adjustTrailStrokes).
    state._detailPolylines = [gpx];
    gpx.eachLayer(function(l) { if (!state._detailRenderer && l._renderer) state._detailRenderer = l._renderer; });
    // Polylines may be in the SVG DOM with correct coords but unpainted
    // until the renderer next ticks. Force a redraw, then renormalize
    // stroke widths in case adjustTrailStrokes ran mid-zoom-animation
    // and left them counter-scaled against a now-stale scale value.
    gpx.eachLayer(function(l) { if (typeof l.redraw === 'function') l.redraw(); });
    adjustTrailStrokes();

    const layers = [];
    gpx.eachLayer(function(layer) { if (layer.getLatLngs) layers.push(layer); });
    if (layers.length > 0) {
      const latlngs = layers[0].getLatLngs();
      const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
      if (flat.length > 1) {
        const startLL = flat[0];
        const endLL = flat[flat.length - 1];
        addStartEndMarkers(map, startLL, endLL);
        // Drop waypoints that are routing artifacts (no <sym>) or sit
        // on top of the start/end markers.
        gpx.eachLayer(function(layer) {
          if (!layer.options || layer.options.type !== 'waypoint' || !layer.getLatLng) return;
          if (!layer._ferdSym) { gpx.removeLayer(layer); return; }
          const ll = layer.getLatLng();
          if (ll.distanceTo(startLL) < WAYPOINT_ENDPOINT_SUPPRESS_M
              || ll.distanceTo(endLL) < WAYPOINT_ENDPOINT_SUPPRESS_M) {
            gpx.removeLayer(layer);
          }
        });
      }
    }

    // Thin the track to screen resolution at the current zoom and re-thin
    // on zoomend (matches the index map and multi-segment view), so a very
    // large single-track import stays responsive. Douglas-Peucker keeps the
    // endpoints, and the elevation data was already captured from the full
    // line via addline, so striding stays independent.
    simplifyRouteForZoom(gpx, map.getZoom());
    map.on('zoomend', function() { simplifyRouteForZoom(gpx, map.getZoom()); });

    const dist = gpx.get_distance();
    const stats = { dist: dist, status: route.completed ? 'Completed' : 'Planned', completed: route.completed, region: route.key.split('/')[0] };
    if (route.hasElevation) {
      stats.gain = gpx.get_elevation_gain();
    }
    // Length + climb columns, matching the multi-segment header format.
    const sStatsEl = document.getElementById('single-elev-stats');
    if (sStatsEl) {
      sStatsEl.innerHTML = '<span class="seg-dist">' + formatDistance(stats.dist) + '</span>'
        + (stats.gain != null ? '<span class="seg-gain">+' + formatElevation(stats.gain) + '</span>' : '');
    }
  })).on('addline', sched.live(function(e) {
    if (!elevationControl) return;
    // For a very large track, stride the elevation series the same way the
    // multi-segment view does, so the chart stays cheap. leaflet-gpx
    // stores elevation in each latlng's meta.ele.
    const raw = e.line.getLatLngs();
    const flat = Array.isArray(raw) && Array.isArray(raw[0]) ? [].concat.apply([], raw) : raw;
    // Snapshot the coordinates now: addData defers until the chart's
    // modules load, and by then simplifyRouteForZoom has swapped the
    // line's latlngs for thinned copies that carry no meta.ele.
    const coords = flat.map(function(ll) { return [ll.lng, ll.lat, (ll.meta && ll.meta.ele != null) ? ll.meta.ele : 0]; });
    elevationControl.addData({ type: 'Feature', geometry: { type: 'LineString', coordinates: flat.length > MAX_ELEV_POINTS ? decimateCoords(coords, MAX_ELEV_POINTS) : coords }, properties: {} });
  })).addTo(map);
  })).catch(function(err) { console.warn('[ferd] gpx load failed', err); });
}

function renderMultiTrack(map, route, sched) {
  fetchGpxText(gpxUrlFor(route.file))
    .then(sched.live(function(xmlText) {
      const tracks = parseGpxTracks(xmlText);
      if (tracks.length === 0) return;
      {
        const firstPt = tracks[0].points[0];
        const last = tracks[tracks.length - 1];
        const lastPt = last.points[last.points.length - 1];
        const startLL = firstPt ? L.latLng(firstPt.lat, firstPt.lon) : null;
        const endLL = lastPt ? L.latLng(lastPt.lat, lastPt.lon) : null;
        addGpxWaypoints(map, parseGpxWaypoints(xmlText), startLL, endLL);
      }

      const elevHeight = 200;
      const elevControls = [];
      const allStats = [];
      const bounds = L.latLngBounds();
      const detailPolylines = [];

      const container = document.getElementById('multi-elevation-container');

      function makeElevationControl(divSel) {
        return L.control.elevation({
          theme: 'custom-theme', detached: true,
          elevationDiv: divSel,
          height: elevHeight,
          imperial: isImperial(),
          slope: false, speed: false, acceleration: false, time: false,
          legend: false, summary: false, ruler: false, downloadLink: false,
          almostOver: false, distanceMarkers: false, autofitBounds: false, fitBounds: false,
          polyline: false,
        }).addTo(map);
      }

      // Map polylines + per-segment stats for every track.
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        const tc = TRACK_COLORS[i % TRACK_COLORS.length];
        allStats.push(computeTrackStats(track.points));
        for (const p of track.points) bounds.extend([p.lat, p.lon]);
        const latlngs = track.points.map(p => [p.lat, p.lon]);
        detailPolylines.push(L.polyline(latlngs, { color: tc, opacity: 0.9, weight: 5 * getTrailWeightFactor() }).addTo(map));
      }

      if (container) {
        // A fixed graph on top (default: the whole route) plus a
        // collapsible list of segments below. Clicking a segment swaps the
        // graph in place, marks the row active, and highlights that segment
        // on the map; clicking it again returns to the whole-route profile.
        const segStatHtml = function(s) {
          return '<span class="seg-stat"><span class="seg-dist">' + formatDistance(s.distance) + '</span>'
            + (s.gain > 0 ? '<span class="seg-gain">+' + formatElevation(s.gain) + '</span>' : '') + '</span>';
        };
        const totalDist = allStats.reduce(function(a, s) { return a + s.distance; }, 0);
        const totalGain = allStats.reduce(function(a, s) { return a + (s.gain > 0 ? s.gain : 0); }, 0);
        // GPX track names often carry their own leading number ("001: ...").
        // Pull it into a dedicated # column and strip it from the name;
        // fall back to the row index when a name has no number prefix.
        const padW = String(tracks.length).length;
        const segNumName = function(raw, idx) {
          const m = /^\s*(\d{1,3})[:.)]\s+(.+)$/.exec(raw || '');
          if (m) return { num: m[1], name: m[2] };
          return { num: String(idx + 1).padStart(padW, '0'), name: raw || ('Segment ' + (idx + 1)) };
        };
        let rowsHtml = '';
        for (let i = 0; i < tracks.length; i++) {
          const tc = TRACK_COLORS[i % TRACK_COLORS.length];
          const nn = segNumName(tracks[i].name, i);
          rowsHtml += '<div class="seg-row" data-seg="' + i + '" style="--track-color:' + tc + '">';
          rowsHtml += '<span class="seg-num">' + escapeHtml(nn.num) + '</span>';
          rowsHtml += '<span class="color-dot" style="background:' + tc + '"></span>';
          rowsHtml += '<span class="seg-name">' + escapeHtml(nn.name) + '</span>';
          rowsHtml += segStatHtml(allStats[i]);
          rowsHtml += '</div>';
        }
        // The segment list is an absolute dropdown (out of flow) so opening
        // it never changes the container height: that would resize the
        // flex-grow map (a visible tile reload) and overflow the 70vh cap.
        // The whole-route totals live on the toggle bar (right side) and act
        // as the click-to-show-whole-route control.
        container.classList.add('elev-dropdown-host');
        container.innerHTML =
          '<div class="detail-elev-title" id="detail-elev-title" role="button" tabindex="0" title="Show or hide the graph"><span class="detail-elev-title-text" id="detail-elev-title-text">Whole route</span></div>'
          + '<div class="detail-elev-graph" id="detail-elev-graph" style="--track-color:' + ROUTE_COLOR + '"></div>'
          + '<div class="elev-segments">'
          + '<button type="button" class="elev-segments-toggle collapsed" id="elev-seg-toggle">'
          + '<span class="elev-toggle-label">Elevation by segment (' + tracks.length + ')</span>'
          + '<span class="seg-stat elev-toggle-stats" id="elev-toggle-stats" title="Show whole route">'
          + '<span class="seg-dist">' + formatDistance(totalDist) + '</span>'
          + (totalGain > 0 ? '<span class="seg-gain">+' + formatElevation(totalGain) + '</span>' : '')
          + '</span></button>'
          + '<div class="elev-segments-list collapsed" id="elev-seg-list">' + rowsHtml + '</div>'
          + '</div>';

        // Whole-route and per-segment elevation features (strided).
        const wholeCoords = [];
        for (const tr of tracks) for (const p of tr.points) if (p.ele !== null) wholeCoords.push([p.lon, p.lat, p.ele]);
        const wholeFeat = wholeCoords.length > 1
          ? { type: 'Feature', geometry: { type: 'LineString', coordinates: decimateCoords(wholeCoords, MAX_ELEV_POINTS) }, properties: {} }
          : null;
        function segFeat(i) {
          const f = trackToGeoJSON(tracks[i]);
          f.geometry.coordinates = decimateCoords(f.geometry.coordinates, MAX_ELEV_POINTS);
          return f;
        }

        const graphCtrl = makeElevationControl('#detail-elev-graph');
        state.currentElevation = graphCtrl;
        function setGraph(feat, color, title) {
          const div = document.getElementById('detail-elev-graph');
          if (div) div.style.setProperty('--track-color', color);
          const titleEl = document.getElementById('detail-elev-title-text');
          if (titleEl) titleEl.textContent = title;
          try { graphCtrl.clear(); } catch (e) {}
          if (feat) graphCtrl.addData(feat);
        }
        function highlightSeg(active) {
          for (let k = 0; k < detailPolylines.length; k++) {
            const on = k === active;
            try {
              detailPolylines[k].setStyle({
                weight: (on ? 7 : 5) * getTrailWeightFactor(),
                opacity: active === null ? 0.9 : (on ? 1 : 0.4),
              });
              if (on && detailPolylines[k].bringToFront) detailPolylines[k].bringToFront();
            } catch (e) {}
          }
        }

        const listEl = document.getElementById('elev-seg-list');
        const toggleStatsEl = document.getElementById('elev-toggle-stats');
        let activeSeg = null;
        function selectSeg(i) {
          if (i === activeSeg) i = null;   // click the active row to clear
          activeSeg = i;
          if (listEl) listEl.querySelectorAll('.seg-row').forEach(function(r) {
            r.classList.toggle('active', parseInt(r.getAttribute('data-seg'), 10) === activeSeg);
          });
          // Whole-route state is reflected on the toggle-bar totals.
          if (toggleStatsEl) toggleStatsEl.classList.toggle('active', activeSeg === null);
          if (activeSeg === null) { setGraph(wholeFeat, ROUTE_COLOR, 'Whole route'); highlightSeg(null); }
          else {
            setGraph(segFeat(activeSeg), TRACK_COLORS[activeSeg % TRACK_COLORS.length], tracks[activeSeg].name);
            highlightSeg(activeSeg);
          }
        }
        if (listEl) listEl.querySelectorAll('.seg-row').forEach(function(row) {
          row.addEventListener('click', function() { selectSeg(parseInt(row.getAttribute('data-seg'), 10)); });
        });
        // Default: whole-route profile.
        selectSeg(null);

        const toggle = document.getElementById('elev-seg-toggle');
        toggle.addEventListener('click', function() {
          const opening = toggle.classList.contains('collapsed');
          toggle.classList.toggle('collapsed', !opening);
          if (listEl) listEl.classList.toggle('collapsed', !opening);
        });
        // Clicking the totals shows the whole route without toggling the list.
        if (toggleStatsEl) toggleStatsEl.addEventListener('click', function(e) {
          e.stopPropagation();
          selectSeg(null);
        });

        // The title bar collapses the graph itself; the map grows to fill
        // the reclaimed space. Instant (not animated) so the map resizes
        // once instead of thrashing tiles through a height transition.
        const titleBar = document.getElementById('detail-elev-title');
        const graphDiv = document.getElementById('detail-elev-graph');
        const expandGraph = function() {
          if (titleBar) titleBar.classList.remove('collapsed');
          if (graphDiv) graphDiv.classList.remove('collapsed');
        };
        if (titleBar && graphDiv) {
          const toggleGraph = function() {
            const collapsed = titleBar.classList.toggle('collapsed');
            graphDiv.classList.toggle('collapsed', collapsed);
          };
          titleBar.addEventListener('click', toggleGraph);
          titleBar.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGraph(); }
          });
        }

        // Clicking a segment on the map selects it (same as its list row),
        // revealing the graph if it was collapsed.
        detailPolylines.forEach(function(pl, i) {
          pl.on('click', function(e) {
            if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
            expandGraph();
            selectSeg(i);
          });
        });
      }
      if (bounds.isValid() && !state._lastTrailBounds) {
        state._lastTrailBounds = bounds;
        map.fitBounds(bounds, { padding: [40, 40] });
      }
      // Thin each segment to the screen resolution at the current zoom and
      // re-thin on zoomend, so pan/zoom re-projects only as many vertices
      // as are visible (mirrors the index map). The cached full geometry
      // restores detail as you zoom in.
      for (const pl of detailPolylines) simplifyRouteForZoom(pl, map.getZoom());
      map.on('zoomend', function() {
        for (const pl of detailPolylines) simplifyRouteForZoom(pl, map.getZoom());
      });
      // Register the polylines so adjustTrailStrokes re-projects them every
      // zoom/pan frame, keeping the stroke a constant pixel width instead of
      // scaling with the SVG transform mid-zoom (matches the index map).
      state._detailPolylines = detailPolylines;
      state._detailRenderer = detailPolylines.length ? detailPolylines[0]._renderer : null;
      map.eachLayer(function(l) { if (typeof l.redraw === 'function') l.redraw(); });
      adjustTrailStrokes();
      const firstTrack = tracks[0];
      const lastTrack = tracks[tracks.length - 1];
      if (firstTrack.points.length > 0 && lastTrack.points.length > 0) {
        const sp = firstTrack.points[0];
        const ep = lastTrack.points[lastTrack.points.length - 1];
        addStartEndMarkers(map, L.latLng(sp.lat, sp.lon), L.latLng(ep.lat, ep.lon));
      }
    }));
}

export function addStartEndMarkers(map, startLatLng, endLatLng) {
  const startIcon = L.divIcon({ className: 'marker-start', html: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#00e05a" stroke="#fff" stroke-width="2"/></svg>', iconSize: [24, 24], iconAnchor: [12, 12] });
  const endIcon = L.divIcon({ className: 'marker-end', html: '<svg viewBox="0 0 32 32" width="32" height="32"><rect x="4" y="2" width="2" height="28" rx="1" fill="#fff" stroke="#2d333b" stroke-width="0.5"/><path d="M6 3h12c1 0 1.5.5 1 1.5L17 8l2 3.5c.5 1 0 1.5-1 1.5H6V3z" fill="#fff" stroke="#2d333b" stroke-width="0.5"/><rect x="7" y="4" width="4.5" height="4" fill="#2d333b"/><rect x="11.5" y="4" width="4.5" height="4" fill="#fff"/><rect x="7" y="8" width="4.5" height="4" fill="#fff"/><rect x="11.5" y="8" width="4.5" height="4" fill="#2d333b"/></svg>', iconSize: [32, 32], iconAnchor: [5, 30] });
  L.marker(startLatLng, { icon: startIcon }).bindPopup('Start').addTo(map);
  L.marker(endLatLng, { icon: endIcon }).bindPopup('End').addTo(map);
}

function detailKeyInHash() {
  const seg = (location.hash || '').split('?')[0].split('/routes/route/')[1];
  return seg === undefined ? null : decodeURIComponent(seg);
}

// The router unmounts this view, so calling it from one of the view's own
// effects would tear the view down mid-flush and lose the new page's effects
// (its Edit button). Rebuild once the flush is done.
const rebuildLater = () => setTimeout(wrappedRouter, 0);

const metaHtml = (/** @type {string} */ h) => ({ __html: h });

// The detail page's metadata: the facts, tags and notes panel, the crumb and
// the nav Edit button. They follow the store, so an edit redraws these and
// leaves the map and graphs (built from the GPX) alone.
/** @param {{ routeKey: string }} props */
function RouteMeta({ routeKey }) {
  routes.value;
  const found = findRouteByKey(routeKey);
  const last = useRef(found);
  if (found) last.current = found;
  const shown = found || last.current;
  const canEdit = !!(state.auth && state.auth.authenticated) && !isReadOnly();
  const cur = useRef(shown);
  cur.current = shown;
  useEffect(() => { setCrumb(shown.route.name, true); }, [shown.route.name]);
  useEffect(() => {
    const nav = document.getElementById('nav-actions');
    if (!nav || !canEdit) return;
    nav.innerHTML = '<button type="button" id="route-edit-btn" class="nav-action-btn">Edit</button>';
    const btn = nav.querySelector('#route-edit-btn');
    if (btn) btn.addEventListener('click', e => {
      e.preventDefault();
      openEditTrailMetadataModal(cur.current.route, cur.current.region.name);
    });
    return () => { nav.innerHTML = ''; };
  }, [canEdit]);
  // Gone for good (deleted, or removed by a pull): leave the way the delete
  // flow always has, through the router's not-found view. A move is not that,
  // the edit form redirects to the new key.
  // A move can finish before this runs and have pointed the hash at the new
  // key already; rerouting then would build that page twice.
  useEffect(() => {
    if (!found && !routeIsMoving(routeKey) && detailKeyInHash() === routeKey) rebuildLater();
  }, [!!found]);
  // The map and graphs are drawn from the files the page was built with, and
  // a completed flip swaps the walked and planned files under the same key.
  const files = found ? found.route.file + '|' + (found.route.plannedFile || '') : null;
  const builtFiles = useRef(files);
  useEffect(() => {
    if (files && files !== builtFiles.current) rebuildLater();
  }, [files]);
  if (!found) return null;

  const { route, region } = found;
  let href = '';
  if (route.source) {
    try {
      const u = new URL(route.source, location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href;
    } catch {}
  }
  const tagsOn = getShowField('tags') && Array.isArray(route.tags) && route.tags.length > 0;
  const notes = !!route.notes && getShowField('note');
  const facts = [
    vhtml`<span class="fact"><span class="dot" style=${'background:' + (route.completed ? 'var(--status-completed)' : 'var(--status-planned)')}></span>${route.completed ? 'Completed' : 'Planned'}</span>`,
    vhtml`<span class="fact">${displayRegion(region.name)}</span>`,
  ];
  if (route.difficulty) facts.push(vhtml`<span class="fact">${DIFFICULTY_LABELS[route.difficulty] || route.difficulty}</span>`);
  if (route.rating && getShowField('rating')) facts.push(vhtml`<span class="fact" title=${route.rating + '/5'} dangerouslySetInnerHTML=${metaHtml(ratingStarsText(route.rating))}></span>`);
  if (route.date_completed && getShowField('date')) facts.push(vhtml`<span class="fact">${route.date_completed}</span>`);
  // Source link moved here from the removed top stats bar.
  if (href) facts.push(vhtml`<a class="fact fact-source" href=${href} target="_blank" rel="noopener noreferrer">${domainFromUrl(route.source) + ' '}<span dangerouslySetInnerHTML=${metaHtml(EXTERNAL_ICON_SVG)}></span></a>`);
  return vhtml`<div class="route-meta-panel">
    <div class="route-meta-header">
      <div class="route-meta-line">${facts.map((f, i) => vhtml`${i > 0 && vhtml`<span class="sep">\u00b7</span>`}${f}`)}</div>
      ${tagsOn && vhtml`<div class="route-meta-tags">${route.tags.map((/** @type {string} */ t) => vhtml`<span class="tag" key=${t}>${'#' + t}</span>`)}</div>`}
    </div>
    ${notes && vhtml`<div class="route-meta-notes"><span class="route-meta-notes-label">Notes</span>${route.notes}</div>`}
  </div>`;
}
