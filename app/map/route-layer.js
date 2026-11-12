import { GPX_NS, state } from '../core.js';
import { applyAuth, routeStatusColor } from '../server.js';
import { gpxText } from '../store.js';
import { _geometryPolygons } from '../area-geo.js';
import { followZoomAnim, mapScheduler } from './map-layers.js';
import { areaStyle } from './area-layer.js';
import { getTrailWeightFactor } from '../theme.js';
import { wrappedRouter } from '../router.js';
import { t } from '../i18n.js';

// Leaflet is declared `any` in types/globals.d.ts (the vendored build ships no
// declarations), so its maps, layers and renderers have no narrower type here.
/** @typedef {any} LeafletMap */
/** @typedef {any} LeafletLayer */
/** @typedef {{ lat: number, lon: number, ele: number | null }} GpxPoint */
/** @typedef {{ name: string, points: GpxPoint[] }} GpxTrack */
/** @typedef {{ route: import('../core.js').ManifestRoute, layer: LeafletLayer, completed: boolean, region: string }} RouteRecord */

// Concurrency-limited GPX text fetcher. The index map can have dozens
// of routes, and bursting that many parallel XHRs caused leaflet-gpx
// to occasionally see a null responseXML (Firefox's XML parser
// failing under load). Fetch + text + limited concurrency avoids the
// XHR path entirely and keeps the network polite.
const GPX_CONCURRENCY = 4;
/** @type {Array<() => Promise<unknown>>} */
const _gpxQueue = [];
let _gpxActive = 0;
function _gpxPump() {
  while (_gpxActive < GPX_CONCURRENCY && _gpxQueue.length > 0) {
    _gpxActive++;
    const task = /** @type {() => Promise<unknown>} */ (_gpxQueue.shift());
    task().finally(function() { _gpxActive--; _gpxPump(); });
  }
}
/** @param {string} url @returns {Promise<string>} */
export function fetchGpxText(url) {
  // Local mode: `local:<file>` resolves to the GPX text held in IndexedDB,
  // no network and no concurrency queue needed.
  if (url && url.indexOf('local:') === 0) {
    return gpxText(url.slice(6)).then(function(text) {
      if (text == null) throw new Error('not found: ' + url);
      return text;
    });
  }
  return new Promise(function(resolve, reject) {
    _gpxQueue.push(function() {
      return fetch(url, applyAuth({})).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(resolve, function(err) {
        // Network failure: a GPX uploaded offline isn't on the server yet,
        // so serve the bytes the store keeps until the upload replays. The
        // file path is everything after '/gpx/' in the URL.
        const i = url.indexOf('/gpx/');
        const file = i >= 0 ? url.slice(i + 5).split('?')[0] : null;
        if (!file) return reject(err);
        gpxText(file).then(function(text) {
          if (text != null) resolve(text); else reject(err);
        }, function() { reject(err); });
      });
    });
    _gpxPump();
  });
}

// Defensive backstop: leaflet-gpx 2.1.2 calls _parse_gpx_data on
// responseXML without null-checking. We now feed it pre-fetched text
// (DOMParser-backed, never null), but keep the patch for any legacy
// call sites that still pass URLs directly.
if (window.L && L.GPX && L.GPX.prototype && !L.GPX.prototype._parse_gpx_data._ferdPatched) {
  const orig = L.GPX.prototype._parse_gpx_data;
  /** @this {unknown} @param {Document | null} xml @param {any} options */
  const patched = function(xml, options) {
    if (!xml) return null;
    return orig.call(this, xml, options);
  };
  patched._ferdPatched = true;
  L.GPX.prototype._parse_gpx_data = patched;
}

/** @param {LeafletLayer} layer */
export function applyNonScalingStroke(layer) {
  if (layer && layer._path && layer._path.setAttribute) {
    // Stamp from layer.options.weight (the intended weight) rather
    // than the path's current stroke-width attribute. If a route
    // happens to load while the SVG is mid-CSS-scale (stepped zoom
    // anim or fitBounds), getAttribute returns the counter-scaled
    // value, which then becomes the frozen "orig" - and every later
    // adjustTrailStrokes call restores it to that wrong width.
    if (layer.options && typeof layer.options.weight === 'number'
        && !layer._path.dataset.origStrokeWidth) {
      layer._path.dataset.origStrokeWidth = String(layer.options.weight);
    }
  }
  if (layer && typeof layer.eachLayer === 'function') {
    layer.eachLayer(applyNonScalingStroke);
  }
}

// Index-map route simplification. Dense GPX tracks make the overview map
// sluggish because adjustTrailStrokes re-projects every polyline vertex on
// each pan/zoom frame. Douglas-Peucker (Leaflet's L.LineUtil.simplify) at a
// high reference zoom + tiny tolerance drops only redundant points (GPS
// jitter, collinear straightaways) while preserving the route's shape at
// every usable zoom. Applied to the overview polylines only; the route
// detail view loads the full GPX separately.
// Tolerance in pixels at the *current* zoom, so the overview keeps only as
// many vertices as the screen can resolve there. Zoomed out to a whole
// continental route that's a few hundred points; zoomed in it restores detail.
const SIMPLIFY_TOLERANCE = 1.3;
// Detail-view elevation series are strided to at most this many samples;
// the profile is unchanged at chart resolution.
export const MAX_ELEV_POINTS = 3000;
// Uniform-stride decimation keeping the first and last sample.
/**
 * @template T
 * @param {T[]} coords
 * @param {number} max
 * @returns {T[]}
 */
export function decimateCoords(coords, max) {
  if (!Array.isArray(coords) || coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}
/** @param {any[]} latlngs @param {number} zoom */
function simplifyRouteLatLngs(latlngs, zoom) {
  if (!Array.isArray(latlngs) || latlngs.length < 50) return latlngs;
  const crs = L.CRS.EPSG3857;
  const pts = latlngs.map(ll => crs.latLngToPoint(ll, zoom));
  /** @type {any[]} */
  const simp = L.LineUtil.simplify(pts, SIMPLIFY_TOLERANCE);
  if (simp.length >= pts.length) return latlngs;
  return simp.map(p => crs.pointToLatLng(p, zoom));
}
// Thin each leaf polyline of a route to the given zoom. The full geometry is
// cached on first touch so later (higher) zooms can restore detail.
/** @param {LeafletLayer} layer @param {number} zoom */
export function simplifyRouteForZoom(layer, zoom) {
  if (layer.getLatLngs && layer.setLatLngs && typeof layer.eachLayer !== 'function') {
    let full = layer._fullLatLngs;
    if (!full) {
      full = layer.getLatLngs();
      if (!Array.isArray(full) || !full.length || Array.isArray(full[0])) return;
      layer._fullLatLngs = full;
    }
    layer.setLatLngs(simplifyRouteLatLngs(full, zoom));
    return;
  }
  if (typeof layer.eachLayer === 'function') layer.eachLayer((/** @type {LeafletLayer} */ sub) => simplifyRouteForZoom(sub, zoom));
}

// Counter-scale route stroke widths against the SVG's current CSS
// transform scale, so routes appear at constant pixel width even
// while Leaflet CSS-scales the SVG container during zoom animation.
export function adjustTrailStrokes() {
  // Re-project each polyline at the current zoom, then call the
  // renderer's _update so the SVG container's viewBox, position,
  // and child path d's all reflect the new map state with CSS
  // scale held at 1. Bypasses the compositor-vs-main-thread race
  // that smooth-wheel zoom causes when counter-scaling stroke-width
  // against the SVG's CSS transform (the transform updates on the
  // compositor while stroke-width goes through main-thread paint,
  // briefly diverging mid-gesture). Costs more CPU than CSS-only
  // but keeps strokes constant and positions sticky.
  if (!state.currentMap) return;
  const visit = (/** @type {LeafletLayer} */ layer) => {
    if (layer._renderer && typeof layer._project === 'function') {
      try { layer._project(); } catch (e) { /* ignore */ }
    }
    if (typeof layer.eachLayer === 'function') {
      layer.eachLayer(visit);
    }
  };
  // Index-map overview layers and (in the route detail view) the detail
  // polylines both need re-projecting so their strokes stay constant.
  if (state._routeLayers) for (const t of state._routeLayers) visit(t.layer);
  if (state._detailPolylines) for (const pl of state._detailPolylines) visit(pl);
  if (state._areaGroup) visit(state._areaGroup);
  const renderers = [];
  if (state._areaRenderer) renderers.push(state._areaRenderer);
  if (state._routeRenderer) renderers.push(state._routeRenderer);
  if (state._detailRenderer && state._detailRenderer !== state._routeRenderer) renderers.push(state._detailRenderer);
  for (const r of renderers) {
    if (r && r._update) { try { r._update(); } catch (e) { /* ignore */ } }
  }
}

// Bind stroke-fixup to map motion.
//
// The per-frame reprojection (hold the SVG at CSS scale 1, reproject every
// route vertex, re-_update the renderer) exists only to keep stroke widths
// pinned during desktop *smooth-wheel* zoom, where Leaflet feeds fractional
// zooms through _move/zoomanim and counter-scaling stroke-width against the
// CSS transform races the compositor. It is expensive: it reprojects the
// whole visible route geometry each frame.
//
// Touch devices have no smooth-wheel zoom. Their pan is a native pane
// translate and their pinch / double-tap zoom is a native compositor CSS
// animation that scales the whole map pane (routes included) for free, then
// settles at zoomend (where simplifyRouteForZoom also re-thins). So on
// coarse pointers we skip all per-frame work and only fix up at rest -
// otherwise reprojecting per frame stalls the gesture when many routes show.
//
// Desktop keeps the per-frame path, gated on an actual zoom change so a
// pure pan still uses Leaflet's cheap native translate.

// The index map can show many routes; per-frame SVG reprojection (the
// desktop path) stalls a touch pinch, and the browser balloons SVG stroke
// width during the zoom CSS-transform. So on coarse pointers we draw the
// routes and area outlines on a WebGL canvas in the map container: geometry uploaded once
// (Web-Mercator px at a fixed reference zoom, local-origin relative for
// float32 precision); each frame only a cheap uniform changes. The vertex
// shader expands the line to a constant pixel width in screen space, so
// width stays constant through zoom with no per-frame geometry work.
// Desktop and any touch device without WebGL keep the SVG path (fallback).
const _glColCanvas = document.createElement('canvas');
_glColCanvas.width = _glColCanvas.height = 1;
// A fresh canvas always yields a 2d context.
const _glColCtx = /** @type {CanvasRenderingContext2D} */ (_glColCanvas.getContext('2d'));
/** @type {Record<string, number[]>} */
const _glColCache = {};
/** @param {string} c */
function glParseColor(c) {
  if (_glColCache[c]) return _glColCache[c];
  _glColCtx.fillStyle = '#000'; _glColCtx.fillStyle = c; _glColCtx.fillRect(0, 0, 1, 1);
  const d = _glColCtx.getImageData(0, 0, 1, 1).data;
  const rgb = [d[0] / 255, d[1] / 255, d[2] / 255];
  _glColCache[c] = rgb; return rgb;
}
const GL_ROUTE_REFZOOM = 20;
const GL_ROUTE_STRIDE = 14; // segA(2) segB(2) end(1) side(1) rgb(3) opFrom(1) opTo(1) wFrom(1) wTo(1) dist(1)
/** @param {LeafletMap} map */
export function attachGLRoutes(map) {
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!coarse) return; // desktop keeps SVG + per-frame reprojection (no WebGL dependency)

  /** @type {WebGLRenderingContext} */
  let gl;
  /** @type {WebGLProgram} */
  let program;
  /** @type {WebGLBuffer} */
  let buffer;
  let vertCount = 0;
  /** @type {{ x: number, y: number } | null} */
  let originRef = null;
  /** @type {Record<string, number>} */
  const attrLoc = {};
  /** @type {Record<string, WebGLUniformLocation | null>} */
  const uniLoc = {};
  const sched = mapScheduler(map);
  const canvas = document.createElement('canvas');
  canvas.className = 'gl-routes';
  canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
  // Own pane below the place-canvas (450), markers (600) and popups (700),
  // above the tile pane (200). draw() counters the map-pane pan offset each
  // frame, and an animated zoom scales it with the tiles until it ends.
  const pane = map.getPane('glRoutesPane') || map.createPane('glRoutesPane');
  pane.style.zIndex = 410;
  pane.style.pointerEvents = 'none';
  pane.appendChild(canvas);

  const VS = [
    'attribute vec2 aSegA; attribute vec2 aSegB; attribute float aEnd; attribute float aSide;',
    'attribute vec3 aColor; attribute float aOpFrom; attribute float aOpTo; attribute float aWFrom; attribute float aWTo; attribute float aDist;',
    'uniform float uScale; uniform vec2 uOriginDelta; uniform vec2 uHalfSize; uniform vec2 uViewport; uniform float uHlT;',
    'varying vec4 vColor; varying float vDash;',
    'vec2 toC(vec2 v){ return uHalfSize + (v + uOriginDelta) * uScale; }',
    'vec2 toClip(vec2 c){ return vec2(c.x / uViewport.x * 2.0 - 1.0, 1.0 - c.y / uViewport.y * 2.0); }',
    'void main(){',
    '  vColor = vec4(aColor, mix(aOpFrom, aOpTo, uHlT));', // highlight opacity interpolated
    '  float hw = mix(aWFrom, aWTo, uHlT);',              // and half-width
    '  vec2 cA = toC(aSegA); vec2 cB = toC(aSegB);',
    '  vec2 self = mix(cA, cB, aEnd);',
    '  vec2 d = cB - cA; float l = length(d);',
    '  vec2 t = l > 0.0 ? d / l : vec2(1.0, 0.0);',
    '  vec2 perp = vec2(-t.y, t.x);',
    '  vDash = aDist < 0.0 ? -1.0 : mod(aDist * uScale, 12.0) + aEnd * l;', // screen px along the line; -1 is solid
    '  gl_Position = vec4(toClip(self + perp * aSide * hw), 0.0, 1.0);',
    '}'
  ].join('\n');
  // highp where the device has it: vDash runs to the screen length of a
  // segment, past what mediump holds. 6 on, 6 off, as areaStyle's dashArray.
  const FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec4 vColor; varying float vDash;',
    'void main(){',
    '  if (vDash >= 0.0 && mod(vDash, 12.0) >= 6.0) discard;',
    '  gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);',
    '}'
  ].join('\n');

  /** @param {number} type @param {string} src */
  function compile(type, src) {
    const s = /** @type {WebGLShader} */ (gl.createShader(type));
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn('[gl-routes] shader', gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  function init() {
    // Null on failure; the check below handles it.
    gl = /** @type {WebGLRenderingContext} */ (canvas.getContext('webgl', { antialias: true, premultipliedAlpha: true }));
    if (!gl) return false;
    const vs = compile(gl.VERTEX_SHADER, VS), fs = compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return false;
    program = /** @type {WebGLProgram} */ (gl.createProgram());
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.warn('[gl-routes] link', gl.getProgramInfoLog(program)); return false; }
    gl.useProgram(program);
    ['aSegA', 'aSegB', 'aEnd', 'aSide', 'aColor', 'aOpFrom', 'aOpTo', 'aWFrom', 'aWTo', 'aDist'].forEach(a => attrLoc[a] = gl.getAttribLocation(program, a));
    ['uScale', 'uOriginDelta', 'uHalfSize', 'uViewport', 'uHlT'].forEach(u => uniLoc[u] = gl.getUniformLocation(program, u));
    buffer = gl.createBuffer();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
    resize();
    return true;
  }
  function resize() {
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
    canvas.style.width = size.x + 'px'; canvas.style.height = size.y + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  const V6 = [[0, 1], [0, -1], [1, 1], [0, -1], [1, -1], [1, 1]];
  function rebuild() {
    if (!gl) return;
    const origin = map.project(map.getCenter(), GL_ROUTE_REFZOOM);
    originRef = origin;
    const base4 = 4 * getTrailWeightFactor();
    const sel = state._selectedRouteKey;
    // From/to selection keys for the highlight animation. The shader lerps
    // opacity/width between the two by the uHlT uniform, so a selection
    // change uploads geometry once and animates with no further rebuilds.
    const hlFrom = (state._hlFrom === undefined) ? sel : state._hlFrom;
    const hlTo = (state._hlTo === undefined) ? sel : state._hlTo;
    /** @type {number[]} */
    const baseArr = [];
    /** @type {number[]} */
    const topArr = []; // the (incoming) selected route appended last so it draws on top
    /**
     * @param {number[]} arr
     * @param {number} ax @param {number} ay @param {number} bx @param {number} by
     * @param {number[]} rgb
     * @param {number} opF @param {number} opT @param {number} wF @param {number} wT
     * @param {number} [dist]
     */
    const pushSeg = (arr, ax, ay, bx, by, rgb, opF, opT, wF, wT, dist = -1) => {
      for (const [end, side] of V6) arr.push(ax, ay, bx, by, end, side, rgb[0], rgb[1], rgb[2], opF, opT, wF, wT, dist);
    };
    // Only the outline: an area's fill stays in SVG, where scaling with the
    // pinch is correct, and only a stroke's width has to hold constant.
    /** @type {number[]} */
    const areaArr = [];
    /** @param {import('../core.js').Area} area @param {boolean} visited */
    const drawArea = (area, visited) => {
      const style = areaStyle(area, visited);
      const rgb = glParseColor(style.color), hw = style.weight / 2;
      for (const rings of _geometryPolygons(area.geometry)) {
        for (const ring of rings) {
          let prev = null, dist = 0;
          for (const [lon, lat] of ring) {
            const p = map.project([lat, lon], GL_ROUTE_REFZOOM);
            const x = p.x - origin.x, y = p.y - origin.y;
            if (prev) {
              pushSeg(areaArr, prev[0], prev[1], x, y, rgb, style.opacity, style.opacity, hw, hw, style.dashArray ? dist : -1);
              dist += Math.hypot(x - prev[0], y - prev[1]);
            }
            prev = [x, y];
          }
        }
      }
    };
    for (const { area, layer, visited } of state._areaLayers || []) {
      if (state._areaGroup.hasLayer(layer)) drawArea(area, visited);
    }
    /** @param {RouteRecord} record */
    const drawRoute = (record) => {
      const f = routeHighlightStyle(record.route.key, hlFrom, base4);
      const g = routeHighlightStyle(record.route.key, hlTo, base4);
      const rgb = glParseColor(routeStatusColor(record.completed));
      const opF = f.opacity, opT = g.opacity, wF = f.weight / 2, wT = g.weight / 2;
      const arr = (hlTo && record.route.key === hlTo) ? topArr : baseArr;
      const visit = (/** @type {LeafletLayer} */ layer) => {
        if (layer.getLatLngs && !layer.eachLayer) {
          const raw = layer.getLatLngs();
          const flat = Array.isArray(raw) && Array.isArray(raw[0]) ? [].concat.apply([], raw) : raw;
          let prev = null;
          for (const ll of flat) {
            const p = map.project(ll, GL_ROUTE_REFZOOM);
            const x = p.x - origin.x, y = p.y - origin.y;
            if (prev) pushSeg(arr, prev[0], prev[1], x, y, rgb, opF, opT, wF, wT);
            prev = [x, y];
          }
        }
        if (layer.eachLayer) layer.eachLayer(visit);
      };
      visit(record.layer);
    };
    for (const record of state._routeLayers || []) {
      if (state.hiddenRegions.has(record.region)) continue;
      if (!(record.completed ? state.showCompleted : state.showPlanned)) continue;
      drawRoute(record);
    }
    const data = areaArr.concat(baseArr, topArr);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    vertCount = data.length / GL_ROUTE_STRIDE;
  }
  function draw() {
    if (!gl) return;
    // Keep the canvas pinned to the viewport (counter the map-pane pan offset),
    // except while it rides a zoom transition.
    if (!map._animatingZoom) L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!vertCount || !originRef) return;
    const size = map.getSize();
    const scale = map.getZoomScale(map.getZoom(), GL_ROUTE_REFZOOM);
    const cNow = map.project(map.getCenter(), GL_ROUTE_REFZOOM);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const S = GL_ROUTE_STRIDE * 4;
    gl.enableVertexAttribArray(attrLoc.aSegA); gl.vertexAttribPointer(attrLoc.aSegA, 2, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(attrLoc.aSegB); gl.vertexAttribPointer(attrLoc.aSegB, 2, gl.FLOAT, false, S, 8);
    gl.enableVertexAttribArray(attrLoc.aEnd); gl.vertexAttribPointer(attrLoc.aEnd, 1, gl.FLOAT, false, S, 16);
    gl.enableVertexAttribArray(attrLoc.aSide); gl.vertexAttribPointer(attrLoc.aSide, 1, gl.FLOAT, false, S, 20);
    gl.enableVertexAttribArray(attrLoc.aColor); gl.vertexAttribPointer(attrLoc.aColor, 3, gl.FLOAT, false, S, 24);
    gl.enableVertexAttribArray(attrLoc.aOpFrom); gl.vertexAttribPointer(attrLoc.aOpFrom, 1, gl.FLOAT, false, S, 36);
    gl.enableVertexAttribArray(attrLoc.aOpTo); gl.vertexAttribPointer(attrLoc.aOpTo, 1, gl.FLOAT, false, S, 40);
    gl.enableVertexAttribArray(attrLoc.aWFrom); gl.vertexAttribPointer(attrLoc.aWFrom, 1, gl.FLOAT, false, S, 44);
    gl.enableVertexAttribArray(attrLoc.aWTo); gl.vertexAttribPointer(attrLoc.aWTo, 1, gl.FLOAT, false, S, 48);
    gl.enableVertexAttribArray(attrLoc.aDist); gl.vertexAttribPointer(attrLoc.aDist, 1, gl.FLOAT, false, S, 52);
    gl.uniform1f(uniLoc.uScale, scale);
    gl.uniform2f(uniLoc.uOriginDelta, originRef.x - cNow.x, originRef.y - cNow.y);
    gl.uniform2f(uniLoc.uHalfSize, size.x / 2, size.y / 2);
    gl.uniform2f(uniLoc.uViewport, size.x, size.y);
    gl.uniform1f(uniLoc.uHlT, (state._hlT == null) ? 1 : state._hlT);
    gl.drawArrays(gl.TRIANGLES, 0, vertCount);
  }
  let rebuildTimer = 0;
  function rebuildSoon() {
    if (rebuildTimer) return;
    rebuildTimer = sched.timeout(function () { rebuildTimer = 0; rebuild(); draw(); }, 150);
  }

  if (!init()) { canvas.remove(); return; } // no WebGL: keep SVG routes (fallback)
  // GL is up: hide the SVG route lines so only the GL layer shows on this map.
  map.getContainer().classList.add('gl-routes-active');
  rebuild(); draw();
  // Selection/highlight + weight-pref changes go through applyRouteHighlight.
  state._glRoutesDirty = function () { rebuildSoon(); };
  state._glRoutesRebuild = function () { rebuild(); draw(); }; // selection change: upload from/to buffer once
  state._glRoutesDraw = function () { draw(); };               // animation frame: cheap uniform update only
  map.on('move zoom', draw); // synchronous: lockstep with the tiles, no one-frame lag
  followZoomAnim(map, canvas); // an animated zoom fires no move/zoom until it ends
  map.on('moveend zoomend', function () { rebuild(); draw(); });
  map.on('resize', function () { resize(); draw(); });
  map.on('layeradd', rebuildSoon); // routes load lazily (async GPX)
}

/** @param {LeafletMap} map */
export function bindTrailStrokeMotion(map) {
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  let lastZoom = map.getZoom();
  map.on('zoomend moveend', function () {
    lastZoom = map.getZoom();
    adjustTrailStrokes();
  });
  if (coarse) return;
  const sched = mapScheduler(map);
  map.on('move', function () {
    const z = map.getZoom();
    if (z === lastZoom) return;
    lastZoom = z;
    adjustTrailStrokes();
  });
  // Stepped desktop zoom (250ms CSS anim) doesn't fire 'move' per frame;
  // a short rAF loop keeps strokes constant across the animation.
  map.on('zoomanim', function () {
    const start = performance.now();
    const tick = () => {
      adjustTrailStrokes();
      if (performance.now() - start < 270) sched.frame(tick);
    };
    sched.frame(tick);
  });
}

// Index-map route highlight. Clicking a route flags it as selected: it
// fattens, goes fully opaque, and jumps to the front while the rest dim
// back, so it stands out where several routes overlap. Style-based, so it
// survives zoom/pan re-projection; re-applied on weight-pref change and
// after each lazy route load so the selection sticks.
// A route's style under a selection key: selected fattens + opaque; others
// dim when something is selected, full when nothing is.
/** @param {string} routeKey @param {string | null | undefined} selKey @param {number} base */
function routeHighlightStyle(routeKey, selKey, base) {
  const on = selKey && routeKey === selKey;
  return { weight: on ? base + 2 : base, opacity: on ? 1 : (selKey ? 0.4 : 0.85) };
}
// SVG (desktop) highlight at an interpolated point between two selection states.
/** @param {string | null | undefined} fromKey @param {string | null | undefined} toKey @param {number} t */
function svgHighlight(fromKey, toKey, t) {
  if (!state._routeLayers) return;
  const base = 4 * getTrailWeightFactor();
  for (const r of state._routeLayers) {
    const f = routeHighlightStyle(r.route.key, fromKey, base);
    const g = routeHighlightStyle(r.route.key, toKey, base);
    try {
      r.layer.setStyle({ weight: f.weight + (g.weight - f.weight) * t, opacity: f.opacity + (g.opacity - f.opacity) * t });
      if (t >= 1 && toKey && r.route.key === toKey && typeof r.layer.bringToFront === 'function') r.layer.bringToFront();
    } catch (e) {}
  }
}
// Instant apply (no animation): route loads, weight-pref changes.
export function applyRouteHighlight() {
  if (!state._routeLayers) return;
  const sel = state._selectedRouteKey;
  state._hlFrom = state._hlTo = sel; state._hlT = 1;
  svgHighlight(sel, sel, 1);
  if (state._glRoutesRebuild) state._glRoutesRebuild();
}

let _hlRaf = 0;
// Selection change from a click: animate from the previous selection to the
// new one (~150ms ease-out). The GL buffer is rebuilt once with both end
// states; the animation only advances the uHlT uniform (no per-frame
// rebuild). SVG interpolates via setStyle. Respects reduced-motion.
/** @param {string | null | undefined} key */
export function setSelectedRoute(key) {
  const from = state._selectedRouteKey;
  const to = key || null;
  state._selectedRouteKey = to;
  if (_hlRaf) { cancelAnimationFrame(_hlRaf); _hlRaf = 0; }
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (from === to || reduce || !state._routeLayers) { applyRouteHighlight(); return; }
  state._hlFrom = from; state._hlTo = to; state._hlT = 0;
  svgHighlight(from, to, 0);
  if (state._glRoutesRebuild) state._glRoutesRebuild(); // upload from/to buffer once
  const start = performance.now(), dur = 150;
  const tick = (/** @type {number} */ now) => {
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - (1 - p) * (1 - p); // ease-out quad
    state._hlT = e;
    svgHighlight(from, to, e);
    if (state._glRoutesDraw) state._glRoutesDraw();
    if (p < 1) { _hlRaf = requestAnimationFrame(tick); }
    else { _hlRaf = 0; state._hlT = 1; state._hlFrom = state._hlTo = to; }
  };
  _hlRaf = requestAnimationFrame(tick);
}

export function refreshTrailWeights() {
  if (!state._routeLayers) { wrappedRouter(); return; }
  applyRouteHighlight();
}

// Here rather than in route-detail.js, which loads on the first route page and
// would otherwise be pulled in by the area layer.
/**
 * @param {string} xmlText
 * @returns {GpxTrack[]}
 */
export function parseGpxTracks(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  let tracks = doc.getElementsByTagNameNS(GPX_NS, 'trk');
  if (tracks.length === 0) tracks = doc.getElementsByTagName('trk');
  /** @type {GpxTrack[]} */
  const result = [];
  for (let i = 0; i < tracks.length; i++) {
    const trk = tracks[i];
    const nameEl = trk.getElementsByTagNameNS(GPX_NS, 'name')[0] || trk.getElementsByTagName('name')[0];
    const name = nameEl ? nameEl.textContent || '' : t('routeDetail.track', { n: i + 1 });
    /** @type {GpxPoint[]} */
    const points = [];
    let trkpts = trk.getElementsByTagNameNS(GPX_NS, 'trkpt');
    if (trkpts.length === 0) trkpts = trk.getElementsByTagName('trkpt');
    for (let j = 0; j < trkpts.length; j++) {
      const pt = trkpts[j];
      const lat = parseFloat(pt.getAttribute('lat') || '');
      const lon = parseFloat(pt.getAttribute('lon') || '');
      const eleEl = pt.getElementsByTagNameNS(GPX_NS, 'ele')[0] || pt.getElementsByTagName('ele')[0];
      const ele = eleEl ? parseFloat(eleEl.textContent || '') : null;
      points.push({ lat, lon, ele });
    }
    result.push({ name, points });
  }
  return result;
}
