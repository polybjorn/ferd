import { escapeHtml, reduceMotion, state } from '../core.js';
import { easeLeaflet } from './map-layers.js';
import { getClusterPlaces, placesEnabled, routesEnabled } from '../prefs.js';
import { applyAreaFilters, MAP_FADE_MS, revealArea } from './area-layer.js';
import { goToPlace, goToRoute, openPlacePopup, placeMarkerRadius } from './map-actions.js';
import { focusHash } from '../router.js';
import { getMarkerSize, getPinStyle } from '../theme.js';
import { bindSearchKeys } from './search-keys.js';

/** @typedef {import('./route-layer.js').LeafletMap} LeafletMap */
/** @typedef {import('../core.js').Place} Place */
/** @typedef {import('../core.js').Area} Area */
/** @typedef {import('../core.js').ManifestRoute} ManifestRoute */
/** @typedef {{ x: number, y: number }} Pt */
// A supercluster feature: a cluster carries cluster_id and point_count, a
// single place carries the place itself.
/** @typedef {{ type: string, geometry: { type: string, coordinates: number[] }, properties: { place?: Place, cluster?: boolean, cluster_id?: number, point_count?: number, _idx?: number } }} PlaceFeature */
/** @typedef {{ places: Place[], areas: Area[], routes: Array<{ route: ManifestRoute, region: string }> }} SearchMatches */
/** @typedef {{ type: string, name?: string, id?: string, key?: string }} RecentPick */

// Canvas-rendered place layer. Owns clustering via supercluster, draws
// all places and clusters to a single <canvas>, hit-tests clicks and
// hovers. Replaces the L.markerClusterGroup + L.marker DOM model so
// pinch-zoom doesn't pay per-element compositing cost.
const PlaceCanvasLayer = L.Layer.extend({
  options: {
    pane: 'placeCanvasPane',
    clusterRadius: 40,
    clickHitRadius: 14,
  },

  /** @param {any} options */
  initialize: function(options) {
    L.setOptions(this, options);
    this._places = [];
    this._supercluster = null;
    this._visibleFeatures = null;
    this._useClusters = true;
  },

  /** @param {Place[] | null} places */
  setPlaces: function(places) {
    this._fadingPlaceId = null;
    this._places = (places || []).slice();
    this._rebuildIndex();
    this._redraw();
    return this;
  },

  /** @param {boolean} useClusters */
  setUseClusters: function(useClusters) {
    if (this._useClusters === useClusters) return this;
    this._useClusters = useClusters;
    this._rebuildIndex();
    this._redraw();
    return this;
  },

  redraw: function() { this._redraw(); return this; },

  // The pin stays at the end of the fade until setPlaces drops it. The timer,
  // not the frames, ends the wait: a hidden tab gets no frames.
  /** @param {Place} place @returns {Promise<void>} */
  fadeOutPlace: function(place) {
    const shown = (this._visibleFeatures || []).some((/** @type {PlaceFeature} */ f) => !f.properties.cluster && f.properties.place.id === place.id);
    if (!shown || reduceMotion()) return Promise.resolve();
    return new Promise(resolve => {
      const start = performance.now();
      this._fadingPlaceId = place.id;
      this._fadeAlpha = 1;
      const step = (/** @type {number} */ now) => {
        if (this._fadingPlaceId !== place.id) return;
        this._fadeAlpha = Math.min(1, Math.max(0, 1 - (now - start) / MAP_FADE_MS));
        this._redraw();
        if (this._fadeAlpha > 0) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setTimeout(resolve, MAP_FADE_MS);
    });
  },

  // Open a popup at the given place. If currently clustered, zoom in
  // first via supercluster's expansion zoom so the popup makes sense.
  /** @param {Place} place @param {() => void} [onShown] */
  revealPlace: function(place, onShown) {
    const map = this._map;
    if (!map) return;
    const zoom = Math.floor(map.getZoom());
    let targetZoom = Math.max(zoom, 12);
    if (this._supercluster && this._useClusters) {
      const features = this._getCurrentFeatures();
      for (const f of features) {
        if (!f.properties.cluster) continue;
        const id = f.properties.cluster_id;
        try {
          const leaves = this._supercluster.getLeaves(id, Infinity);
          if (leaves.some((/** @type {PlaceFeature} */ l) => l.properties.place === place
              || l.properties.place.name === place.name)) {
            targetZoom = Math.min(map.getMaxZoom() || 18,
              this._supercluster.getClusterExpansionZoom(id));
            break;
          }
        } catch (_) { /* ignore */ }
      }
    }
    const open = () => {
      openPlacePopup(map, place);
      if (typeof onShown === 'function') onShown();
    };
    if (Math.floor(map.getZoom()) !== targetZoom) {
      map.once('moveend', open);
      map.setView([place.lat, place.lon], targetZoom);
    } else {
      map.setView([place.lat, place.lon], targetZoom);
      setTimeout(open, 60);
    }
  },

  /** @param {LeafletMap} map */
  onAdd: function(map) {
    this._map = map;
    if (!map.getPane(this.options.pane)) {
      const p = map.createPane(this.options.pane);
      p.style.zIndex = 450; // above tile pane (200), below marker pane (600)
    }
    this._canvas = L.DomUtil.create('canvas',
      'place-canvas-layer',
      map.getPane(this.options.pane));
    // setTransform math (offset + scale) assumes a top-left transform
    // origin; default of 50% 50% would scale around the canvas center
    // and miscalculate every pin position during pinch/zoom.
    this._canvas.style.transformOrigin = '0 0';
    // Canvas sits above the SVG overlay pane (zIndex 450 vs 400) so it
    // would swallow clicks intended for route polylines underneath.
    // Hit detection happens against map clicks in _onClick, not the
    // canvas itself, so pointer events on the canvas are unnecessary.
    this._canvas.style.pointerEvents = 'none';
    this._sizeCanvas();
    // Mobile pinch + pan fire 'move' continuously and we redraw each
    // frame at the current zoom (pins at fixed size, positions track).
    // Desktop wheel zoom is a 250ms CSS animation during which 'move'
    // does not fire; _onZoomAnim drives a rAF loop that redraws at
    // interpolated zoom/center for the same effect.
    map.on('move', this._redraw, this);
    map.on('zoomanim', this._onZoomAnim, this);
    map.on('zoomend', this._stopZoomAnim, this);
    // Must resize the canvas bitmap (not just repaint) when the map grows,
    // else pins past the old width are clipped off a stale-width canvas.
    map.on('resize', this._onResize, this);
    map.on('click', this._onClick, this);
    map.on('mousemove', this._onMouseMove, this);
    this._redraw();
    return this;
  },

  /** @param {LeafletMap} map */
  onRemove: function(map) {
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    map.off('move', this._redraw, this);
    map.off('zoomanim', this._onZoomAnim, this);
    map.off('zoomend', this._stopZoomAnim, this);
    map.off('resize', this._onResize, this);
    map.off('click', this._onClick, this);
    map.off('mousemove', this._onMouseMove, this);
    this._stopZoomAnim();
    this._map = null;
    return this;
  },


  _sizeCanvas: function() {
    const map = this._map;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = size.x * dpr;
    this._canvas.height = size.y * dpr;
    this._canvas.style.width = size.x + 'px';
    this._canvas.style.height = size.y + 'px';
    this._dpr = dpr;
  },

  _onResize: function() { this._sizeCanvas(); this._redraw(); },

  _rebuildIndex: function() {
    if (!this._places.length || !this._useClusters || typeof Supercluster === 'undefined') {
      this._supercluster = null;
      return;
    }
    const features = this._places.map((/** @type {Place} */ p, /** @type {number} */ i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { place: p, _idx: i }
    }));
    this._supercluster = new Supercluster({
      radius: this.options.clusterRadius,
      maxZoom: 18,
    });
    this._supercluster.load(features);
  },

  _getCurrentFeatures: function() {
    const map = this._map;
    if (!map) return [];
    const bounds = map.getBounds();
    if (this._supercluster && this._useClusters) {
      const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      return this._supercluster.getClusters(bbox, Math.floor(map.getZoom()));
    }
    return this._places
      .filter((/** @type {Place} */ p) => bounds.contains([p.lat, p.lon]))
      .map((/** @type {Place} */ p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { place: p }
      }));
  },

  _redraw: function() {
    this._drawAt(null, null);
  },

  // Draw at a specific zoom/center, or null/null to use the map's
  // current state. Used by _onZoomAnim's rAF loop to render at
  // interpolated zoom during the 250ms desktop animation.
  /** @param {number | null} zoom @param {LeafletMap | null} center */
  _drawAt: function(zoom, center) {
    const map = this._map;
    if (!map || !this._canvas) return;
    const useInterp = (zoom != null && center != null);
    const z = useInterp ? zoom : map.getZoom();
    const c = useInterp ? center : map.getCenter();

    const ctx = this._canvas.getContext('2d');
    const dpr = this._dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);

    // Position the canvas at viewport top-left in layer coords.
    // During interpolation we hold the canvas at the current map's
    // layer origin; pin positions are computed at the interpolated
    // zoom/center via project().
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);

    // Compute pixel origin for the (possibly interpolated) zoom/center.
    const crs = map.options.crs;
    const projCenter = crs.latLngToPoint(c, z);
    const halfSize = size.divideBy(2);
    const pixelOrigin = projCenter.subtract(halfSize)._round();

    const features = this._getCurrentFeatures();
    this._visibleFeatures = features;
    const markerSize = (typeof getMarkerSize === 'function') ? getMarkerSize() : 18;
    const pinStyle = (typeof getPinStyle === 'function') ? getPinStyle() : 'ring';
    const catColors = /** @type {Record<string, string>} */ ((state && state.categoryColors) || {});
    for (const f of features) {
      const coords = f.geometry.coordinates;
      const projected = crs.latLngToPoint(L.latLng(coords[1], coords[0]), z);
      const pt = projected.subtract(pixelOrigin);
      if (f.properties.cluster) {
        this._drawCluster(ctx, pt, f.properties.point_count);
      } else {
        const place = f.properties.place;
        const color = catColors[place.category] || '#888';
        ctx.globalAlpha = place.id === this._fadingPlaceId ? this._fadeAlpha : 1;
        this._drawMarker(ctx, pt, place, color, markerSize, pinStyle);
        ctx.globalAlpha = 1;
      }
    }
  },

  // Desktop wheel zoom: zoomanim fires once with the target zoom and
  // center. The map then CSS-animates over 250ms. 'move' doesn't fire
  // during that window, so we manually interpolate and redraw the
  // canvas each frame to keep pins tracking at constant size.
  /** @param {{ zoom: number, center: any }} e */
  _onZoomAnim: function(e) {
    if (!this._map) return;
    this._stopZoomAnim();
    const startZoom = this._map.getZoom();
    const startCenter = this._map.getCenter();
    const targetZoom = e.zoom;
    const targetCenter = L.latLng(e.center);
    const startTime = performance.now();
    const duration = 250;
    // Leaflet's tile transform interpolates SCALE linearly between
    // 1 and the target scale (CSS transition on the transform
    // property). Mapping that to zoom is logarithmic, not linear:
    // at progress 0.5 of a +1 zoom step the visual scale is 1.5,
    // not 2^0.5 = 1.414. Interpolating zoom linearly here put pins
    // at the wrong fractional zoom relative to the tiles, which
    // showed up as the drift-during-zoom you saw.
    const targetScale = Math.pow(2, targetZoom - startZoom);
    const tick = () => {
      if (!this._map) return;
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = easeLeaflet(t);
      const scaleAtP = 1 + eased * (targetScale - 1);
      const interpZoom = startZoom + Math.log2(scaleAtP);
      const interpCenter = L.latLng(
        startCenter.lat + (targetCenter.lat - startCenter.lat) * eased,
        startCenter.lng + (targetCenter.lng - startCenter.lng) * eased
      );
      this._drawAt(interpZoom, interpCenter);
      if (t < 1) {
        this._zoomAnimRaf = requestAnimationFrame(tick);
      } else {
        this._zoomAnimRaf = null;
      }
    };
    this._zoomAnimRaf = requestAnimationFrame(tick);
  },

  _stopZoomAnim: function() {
    if (this._zoomAnimRaf) {
      cancelAnimationFrame(this._zoomAnimRaf);
      this._zoomAnimRaf = null;
    }
  },

  /** @param {CanvasRenderingContext2D} ctx @param {Pt} pt @param {number} count */
  _drawCluster: function(ctx, pt, count) {
    let r;
    if (count >= 100) r = 22;
    else if (count >= 10) r = 18;
    else r = 15;
    const cs = getComputedStyle(document.documentElement);
    const fill = cs.getPropertyValue('--cluster-fill').trim() || 'rgba(136,192,208,0.6)';
    const halo = cs.getPropertyValue('--cluster-halo').trim() || 'rgba(136,192,208,0.25)';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r + 5, 0, 2 * Math.PI);
    ctx.fillStyle = halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(count), pt.x, pt.y);
  },

  /** @param {CanvasRenderingContext2D} ctx @param {Pt} pt @param {Place} place @param {string} color @param {number} size @param {string} style */
  _drawMarker: function(ctx, pt, place, color, size, style) {
    const r = placeMarkerRadius(size);
    const visited = !!place.visited;
    if (style === 'dot') {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = visited ? color : this._withAlpha(color, 0.5);
      ctx.fill();
    } else if (style === 'pin') {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.x, pt.y + size);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
      if (visited) { ctx.fillStyle = color; ctx.fill(); }
      else { ctx.fillStyle = this._withAlpha(color, 0.25); ctx.fill(); ctx.stroke(); }
    } else if (style === 'tag') {
      const w = size;
      const h = size * 1.1;
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.x, pt.y + h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.rect(pt.x, pt.y, w, size * 0.55);
      if (visited) { ctx.fillStyle = color; ctx.fill(); }
      else {
        ctx.fillStyle = this._withAlpha(color, 0.25);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else {
      // 'ring' (default)
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
      if (visited) {
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * 0.6;
        ctx.stroke();
        ctx.globalAlpha = alpha;
      } else {
        ctx.fillStyle = this._withAlpha(color, 0.25);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  },

  /** @param {string} hex @param {number} alpha */
  _withAlpha: function(hex, alpha) {
    if (!hex || hex[0] !== '#') return hex;
    let r, g, b;
    if (hex.length === 4) {
      r = parseInt(hex[1] + hex[1], 16);
      g = parseInt(hex[2] + hex[2], 16);
      b = parseInt(hex[3] + hex[3], 16);
    } else {
      r = parseInt(hex.slice(1, 3), 16);
      g = parseInt(hex.slice(3, 5), 16);
      b = parseInt(hex.slice(5, 7), 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  },

  /** @param {Pt} point @returns {PlaceFeature | null} */
  _hitTest: function(point) {
    if (!this._visibleFeatures) return null;
    const map = this._map;
    let best = null;
    let bestDist = Infinity;
    for (const f of this._visibleFeatures) {
      const coords = f.geometry.coordinates;
      const pt = map.latLngToContainerPoint([coords[1], coords[0]]);
      const dx = point.x - pt.x;
      const dy = point.y - pt.y;
      const distSq = dx * dx + dy * dy;
      const r = f.properties.cluster
        ? this.options.clickHitRadius * 1.6
        : this.options.clickHitRadius;
      if (distSq <= r * r && distSq < bestDist) {
        best = f;
        bestDist = distSq;
      }
    }
    return best;
  },

  /** @param {{ containerPoint: Pt, originalEvent: Event }} e */
  _onClick: function(e) {
    const target = this._hitTest(e.containerPoint);
    if (!target) return;
    L.DomEvent.stopPropagation(e.originalEvent);
    if (target.properties.cluster) {
      const id = target.properties.cluster_id;
      const expandZoom = this._supercluster.getClusterExpansionZoom(id);
      const coords = target.geometry.coordinates;
      this._map.setView([coords[1], coords[0]],
        Math.min(this._map.getMaxZoom() || 18, expandZoom));
    } else {
      const place = target.properties.place;
      history.replaceState(null, '', focusHash('place', place._slug || place.name));
      openPlacePopup(this._map, place);
    }
  },

  /** @param {{ containerPoint: Pt }} e */
  _onMouseMove: function(e) {
    // Skip on touch devices (no real hover).
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
    const target = this._hitTest(e.containerPoint);
    this._map.getContainer().style.cursor = target ? 'pointer' : '';
  },

});

export function createPlaceLayerGroup() {
  const layer = new PlaceCanvasLayer();
  layer.setUseClusters(getClusterPlaces());
  return layer;
}

// Apply the clustering preference to the live canvas layer; no map rebuild.
export function swapPlaceClusterGroup() {
  const cg = state._placeClusterGroup;
  if (!cg || typeof cg.setUseClusters !== 'function') return;
  cg.setUseClusters(getClusterPlaces());
}

// The filter sheet counts what these let through, so the count and the map
// cannot disagree.
/** @param {Place} p */
export function placeShown(p) {
  if (state.hiddenCategories.has(p.category)) return false;
  return p.visited ? state.showVisited : state.showWant;
}
/** @param {{ region: string, completed: boolean }} t */
export function routeShown(t) {
  if (state.hiddenRegions.has(t.region)) return false;
  return t.completed ? state.showCompleted : state.showPlanned;
}

export function applyMapFilters() {
  const map = state.currentMap;
  if (!map) return;

  // Places
  const cg = state._placeClusterGroup;
  if (cg) {
    const filtered = [];
    if (placesEnabled() && state._placeRecords) {
      for (const p of state._placeRecords) {
        if (placeShown(p)) filtered.push(p);
      }
    }
    cg.setPlaces(filtered);
    if (placesEnabled()) {
      if (!map.hasLayer(cg)) map.addLayer(cg);
    } else if (map.hasLayer(cg)) {
      map.removeLayer(cg);
    }
  }
  applyAreaFilters();

  // Routes
  const gc = state._routeGroupCompleted;
  const gp = state._routeGroupPlanned;
  if (gc && gp && state._routeLayers) {
    gc.clearLayers();
    gp.clearLayers();
    if (routesEnabled()) {
      for (const t of state._routeLayers) {
        if (routeShown(t)) (t.completed ? gc : gp).addLayer(t.layer);
      }
      if (!map.hasLayer(gc)) map.addLayer(gc);
      if (!map.hasLayer(gp)) map.addLayer(gp);
    } else {
      if (map.hasLayer(gc)) map.removeLayer(gc);
      if (map.hasLayer(gp)) map.removeLayer(gp);
    }
  }
}

// Up to six of each kind, matched on the words a person would type for it.
/** @param {string} q @returns {SearchMatches} */
export function searchMatches(q) {
  const lower = q.toLowerCase();
  const places = state.places ? state.places.filter(p =>
    p.name.toLowerCase().includes(lower)
    || (p.note && p.note.toLowerCase().includes(lower))
    || p.category.toLowerCase().includes(lower)
    || (p.country && p.country.toLowerCase().includes(lower))
  ).slice(0, 6) : [];
  const areas = (state.areas && placesEnabled()) ? state.areas.filter(a =>
    a.name.toLowerCase().includes(lower)
    || (a.local_name && a.local_name.toLowerCase().includes(lower))
    || (a.note && a.note.toLowerCase().includes(lower))
    || a.category.toLowerCase().includes(lower)
  ).slice(0, 6) : [];
  const routes = state.manifest ? state.manifest.regions.flatMap(r =>
    r.routes.filter(route => route.name.toLowerCase().includes(lower) || r.name.toLowerCase().includes(lower)).map(route => ({ route, region: r.name }))
  ).slice(0, 6) : [];
  return { places, areas, routes };
}

/** @param {string} data @param {string} marker @param {string} name @param {string} meta */
function resultRow(data, marker, name, meta) {
  return '<div class="map-search-result" role="option" ' + data + '>' + marker +
    '<span class="result-name">' + escapeHtml(name) + '</span>' +
    '<span class="result-meta">' + escapeHtml(meta) + '</span></div>';
}
/** @param {string} category */
function dotMarker(category) {
  return '<span class="result-dot" style="background:' + /** @type {Record<string, string>} */ (state.categoryColors)[category] + '"></span>';
}
/** @param {Place} p */
function placeRow(p) {
  return resultRow('data-type="place" data-name="' + escapeHtml(p.name) + '"', dotMarker(p.category), p.name, p.country || '');
}
/** @param {Area} a */
function areaRow(a) {
  return resultRow('data-type="area" data-id="' + escapeHtml(a.id) + '"', dotMarker(a.category), a.name, 'Area');
}
/** @param {ManifestRoute} route @param {string} region */
function routeRow(route, region) {
  const marker = '<span class="result-line ' + (route.completed ? 'completed' : 'planned') + '"></span>';
  return resultRow('data-type="route" data-key="' + escapeHtml(route.key) + '"', marker, route.name, region);
}

// Rows for searchMatches' result, or '' when nothing matched. The phone's
// search view passes headed, as it has the room to name each group.
/** @param {SearchMatches} m @param {boolean} [headed] */
export function searchResultsHtml(m, headed) {
  /** @param {string} title @param {string[]} rows */
  const group = function(title, rows) {
    if (!rows.length) return '';
    if (!headed) return rows.join('');
    // A listbox holds options and groups only, so the heading names its group.
    return '<div role="group" aria-label="' + title + '"><h3 class="map-search-heading" aria-hidden="true">' + title + '</h3>' +
      rows.join('') + '</div>';
  };
  return group('Places', m.places.map(placeRow)) +
    group('Areas', m.areas.map(areaRow)) +
    group('Routes', m.routes.map(t => routeRow(t.route, t.region)));
}

// Rows for remembered picks in pick order, leaving out any that were deleted
// or hidden since.
/** @param {RecentPick[]} picks */
export function recentResultsHtml(picks) {
  return picks.map(function(/** @type {RecentPick} */ r) {
    if (r.type === 'place') {
      const p = (state.places || []).find(x => x.name === r.name);
      return p ? placeRow(p) : '';
    }
    if (r.type === 'area' && placesEnabled()) {
      const a = (state.areas || []).find(x => String(x.id) === r.id);
      return a ? areaRow(a) : '';
    }
    if (r.type === 'route' && state.manifest) {
      for (const g of state.manifest.regions) {
        const route = g.routes.find(x => x.key === r.key);
        if (route) return routeRow(route, g.name);
      }
    }
    return '';
  }).join('');
}

/** @param {LeafletMap} map @param {{ dataset: DOMStringMap }} row */
export function goToSearchResult(map, row) {
  if (row.dataset.type === 'place') {
    const name = row.dataset.name;
    const place = (state._placeRecords || []).find((/** @type {Place} */ p) => p.name === name);
    if (place) goToPlace(map, place);
  } else if (row.dataset.type === 'area') {
    revealArea(map, row.dataset.id);
  } else {
    goToRoute(map, row.dataset.key);
  }
}

/** @param {LeafletMap} map */
export function initUnifiedSearch(map) {
  const input = /** @type {HTMLInputElement} */ (document.getElementById('map-search-input'));
  const results = document.getElementById('map-search-results');
  const close = function() {
    results.classList.remove('visible');
    keys.refresh(false);
  };
  /** @param {HTMLElement} row */
  const pick = function(row) {
    goToSearchResult(map, row);
    input.value = '';
    results.innerHTML = '';
    close();
  };
  const keys = bindSearchKeys(input, results, { pick, close });

  /** @param {string} q */
  function render(q) {
    const html = q ? searchResultsHtml(searchMatches(q)) : '';
    results.innerHTML = html;
    results.classList.toggle('visible', html !== '');
    keys.refresh(html !== '');
  }

  input.addEventListener('input', function() { render(this.value.trim()); });

  results.addEventListener('click', function(e) {
    const row = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('.map-search-result'));
    if (!row) return;
    // Emptying the list below detaches the row from the panel, so Leaflet
    // no longer sees the panel's click guard and takes this for a map
    // click, which closes the popup just opened.
    e.stopPropagation();
    pick(row);
  });

  // Bind the outside-click dismiss once; it looks up the current results
  // element by id so it survives panel rebuilds (feature toggles).
  if (!state._searchDocClickBound) {
    state._searchDocClickBound = true;
    document.addEventListener('click', function(e) {
      const r = document.getElementById('map-search-results');
      if (!r || /** @type {Element} */ (e.target).closest('#map-search')) return;
      r.classList.remove('visible');
      const input = document.getElementById('map-search-input');
      if (input) input.setAttribute('aria-expanded', 'false');
    });
  }
}
