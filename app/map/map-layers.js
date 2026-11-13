import { state } from '../core.js';
import { t } from '../i18n.js';
import { BASE_LAYER_NAMES, getDefaultTileLayer, getShowTilePicker } from '../prefs.js';

/** @typedef {import('./route-layer.js').LeafletMap} LeafletMap */
/** @typedef {import('./route-layer.js').LeafletLayer} LeafletLayer */
/**
 * One overlay from site-config.json `overlays`, after parseOverlays.
 * @typedef {object} OverlayConfig
 * @property {string} name
 * @property {'xyz' | 'wms'} type
 * @property {string} url
 * @property {string} attribution
 * @property {number} [maxZoom]
 * @property {string} [subdomains] xyz only
 * @property {string} [layers] wms only, as are format, styles, version and transparent
 * @property {string} [format]
 * @property {string} [styles]
 * @property {string} [version]
 * @property {boolean} [transparent]
 */

// Raise the map's minimum zoom to the smallest level whose Web Mercator
// world (a 256*2^z px square) still covers the larger viewport dimension,
// so the map can never zoom out into the empty background (the dark bands
// above/below the world on tall screens). Re-run on resize/rotation.
/** @param {LeafletMap} map */
export function applyCoverMinZoom(map) {
  const size = map.getSize();
  const px = Math.max(size.x, size.y);
  if (!px) return;
  const cover = Math.max(0, Math.ceil(Math.log2(px / 256)));
  if (map.getMinZoom() !== cover) {
    map.setMinZoom(cover); // clamps the current zoom up if it was below.
  }
}


// Skip tile loads during zoom animations. Default true is wasteful:
// each zoom level transition requests its own batch of tiles while
// the gesture is still in flight, competing with the animation.
if (window.L && L.TileLayer && L.TileLayer.mergeOptions) {
  // NoGap (dumpToCanvas) fixes Android tile seams, which the 2D transform
  // below does not on a real device, but causes a small visible reshuffle
  // at zoomend on desktop. So touch gets the canvas and desktop the transform.
  const _isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  L.TileLayer.mergeOptions({
    // On touch, load tiles during the pinch so the new level is painted
    // before the integer-snap at release (otherwise the snap reloads tiles
    // and briefly flashes seams). Desktop smooth-wheel keeps it off to avoid
    // requesting a batch per fractional level mid-gesture.
    updateWhenZooming: _isTouch,
    dumpToCanvas: _isTouch,
    // Leaflet's mobile default fetches only once a gesture ends, so the edges
    // a pinch or a drag reveals stay empty until the fingers lift. Fetching
    // every updateInterval during it fills them while the map moves.
    updateWhenIdle: false,
  });

  // Leaflet 1.9 places each tile with translate3d, which gives it its own
  // compositor layer. Those layers' antialiased edges show as light lines
  // between tiles at fractional pixel ratios and zooms. With a 2D transform
  // a level's tiles paint into one layer, which is Leaflet 2's fix.
  if (!_isTouch) {
    const addTile = L.GridLayer.prototype._addTile;
    L.GridLayer.include({
      /**
       * @param {any} coords
       * @param {any} container
       */
      _addTile(coords, container) {
        addTile.call(this, coords, container);
        const tile = this._tiles[this._tileCoordsToKey(coords)].el;
        const pos = L.DomUtil.getPosition(tile);
        tile.style.transform = `translate(${pos.x}px,${pos.y}px)`;
      },
    });
  } else {
    // NoGap copies a tile to the canvas only after its fade, and until then
    // the tiles show the same lines as plain Leaflet. Copying on load skips that.
    const tileReady = L.TileLayer.prototype._tileReady;
    const onOpaqueTile = L.TileLayer.prototype._onOpaqueTile;
    L.TileLayer.include({
      /**
       * @param {any} coords
       * @param {any} err
       * @param {any} el
       */
      _tileReady(coords, err, el) {
        tileReady.call(this, coords, err, el);
        const tile = this._map && this._tiles[this._tileCoordsToKey(coords)];
        if (tile && !err) this._onOpaqueTile(tile);
      },
      /** @param {any} tile */
      _onOpaqueTile(tile) {
        if (tile.dumped) return;
        tile.dumped = true;
        onOpaqueTile.call(this, tile);
      },
    });

    // Leaflet places a new zoom level for the current view before animating it
    // to the target, but NoGap creates the level's canvas after that, so the
    // canvas animates from the pane's corner at full size: on a double-tap the
    // new tiles slide in from one side. Placing the canvas the same way first
    // makes it zoom with the old level. The zoom animation is already running
    // when the canvas is created, so the placement itself would animate from
    // that corner unless the transition is off while it is committed.
    const onCreateLevel = L.TileLayer.prototype._onCreateLevel;
    L.TileLayer.include({
      /** @param {any} level */
      _onCreateLevel(level) {
        onCreateLevel.call(this, level);
        if (!level.canvas) return;
        level.canvas.style.transition = 'none';
        this._setCanvasZoomTransform(level, this._map.getCenter(), this._map.getZoom());
        L.Util.falseFn(level.canvas.offsetWidth);
        level.canvas.style.transition = '';
      },
    });
  }

  // Leaflet loads only the tiles on screen, so a zoom-out or a pan shows the
  // map's background at the edges until the next tiles arrive. A layer with
  // edgeBufferTiles also loads that many rings of tiles beyond the edge.
  // NoGap sizes its canvas from these bounds too, so the ring has room there.
  const tiledPixelBounds = L.GridLayer.prototype._getTiledPixelBounds;
  L.GridLayer.include({
    /** @param {any} center */
    _getTiledPixelBounds(center) {
      const bounds = tiledPixelBounds.call(this, center);
      const pad = (this.options.edgeBufferTiles || 0) * this.getTileSize().x;
      return pad ? L.bounds(bounds.min.subtract([pad, pad]), bounds.max.add([pad, pad])) : bounds;
    },
  });
}


const OSM_CREDIT = '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';
// One entry per source, which About lists a line each.
export const TOPO_CREDITS = [OSM_CREDIT,
  '<a href="https://www.earthdata.nasa.gov/data/instruments/srtm">NASA SRTM</a>',
  '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> ' +
  '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)'];
const TOPO_CREDIT = TOPO_CREDITS[0] + ', ' + TOPO_CREDITS[1] + ' | ' + TOPO_CREDITS[2];

// One ring of tiles beyond the screen on each base map. No more: the
// OpenStreetMap tile policy allows only modest, short-range look-ahead.
const EDGE_BUFFER = 1;

/** @returns {Record<string, LeafletLayer>} */
function createTileLayers() {
  return {
    'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, subdomains: 'abc',
      edgeBufferTiles: EDGE_BUFFER,
      attribution: TOPO_CREDIT,
    }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, edgeBufferTiles: EDGE_BUFFER,
      attribution: OSM_CREDIT,
    }),
    // OpenStreetMap's tiles drawn dark by the .tiles-dark filter: CARTO's
    // dark tiles now need a key, and Esri's terms do not cover Leaflet.
    'Dark': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'tiles-dark', edgeBufferTiles: EDGE_BUFFER,
      attribution: OSM_CREDIT,
    }),
  };
}

// OVERLAY-CFG-BEGIN (tests/js/overlays.test.js runs this block)
// Overlays from site-config.json `overlays`. An entry without a name or an
// http(s) URL, a repeated name, an unknown type, or a WMS entry without
// `layers` is dropped rather than failing the map.
/**
 * @param {unknown} list
 * @returns {OverlayConfig[]}
 */
export function parseOverlays(list) {
  if (!Array.isArray(list)) return [];
  /** @type {OverlayConfig[]} */
  const out = [];
  const seen = new Set();
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    const type = o.type == null ? 'xyz' : String(o.type).toLowerCase();
    if (!name || seen.has(name) || !/^https?:\/\/[^/]/i.test(url)) continue;
    if (type !== 'xyz' && type !== 'wms') continue;
    if (type === 'wms' && !(typeof o.layers === 'string' && o.layers.trim())) continue;
    /** @type {OverlayConfig} */
    const ov = {
      name, type, url,
      attribution: typeof o.attribution === 'string' ? o.attribution : '',
    };
    if (Number.isInteger(o.max_zoom) && o.max_zoom > 0) ov.maxZoom = o.max_zoom;
    if (type === 'xyz' && typeof o.subdomains === 'string' && o.subdomains) ov.subdomains = o.subdomains;
    if (type === 'wms') {
      ov.layers = o.layers.trim();
      ov.format = typeof o.format === 'string' && o.format ? o.format : 'image/png';
      ov.styles = typeof o.styles === 'string' ? o.styles : '';
      ov.version = typeof o.version === 'string' && o.version ? o.version : '1.1.1';
      ov.transparent = o.transparent !== false;
    }
    seen.add(name);
    out.push(ov);
  }
  return out;
}
// OVERLAY-CFG-END

// Leaflet's layers control parses each name as HTML, so a name from the
// site config is escaped here.
/** @param {string} s */
function leafletLabel(s) {
  return s.replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
}

function createOverlayLayers() {
  /** @type {Record<string, LeafletLayer>} */
  const out = {};
  // `overlays` is not in DEFAULT_CONFIG; it only arrives with site-config.json.
  const config = /** @type {typeof state.config & { overlays?: unknown }} */ (state.config);
  for (const ov of parseOverlays(config && config.overlays)) {
    /** @type {Record<string, any>} */
    const opts = {
      attribution: ov.attribution,
      opacity: state.overlayLevels.get(ov.name) || 0,
      // Above every base layer, including one the picker adds later.
      zIndex: 10,
    };
    if (ov.maxZoom) opts.maxZoom = ov.maxZoom;
    let layer;
    if (ov.type === 'wms') {
      layer = L.tileLayer.wms(ov.url, Object.assign(opts, {
        layers: ov.layers, format: ov.format, styles: ov.styles,
        version: ov.version, transparent: ov.transparent,
      }));
    } else {
      if (ov.subdomains) opts.subdomains = ov.subdomains;
      layer = L.tileLayer(ov.url, opts);
    }
    layer._ferdOverlay = ov.name;
    out[leafletLabel(ov.name)] = layer;
  }
  return out;
}

// The layers control with an opacity slider under each overlay, where 0 is
// off. The control already stops touch and click from reaching the map.
/** @type {any} */
let OverlayLayersControl = null;
function overlayLayersControlClass() {
  if (OverlayLayersControl) return OverlayLayersControl;
  return OverlayLayersControl = L.Control.Layers.extend({
    /** @param {any} obj */
    _addItem(obj) {
      const label = L.Control.Layers.prototype._addItem.call(this, obj);
      const name = obj.overlay && obj.layer._ferdOverlay;
      if (!name) return label;
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '100';
      range.step = '5';
      range.className = 'overlay-opacity';
      range.value = String(Math.round(obj.layer.options.opacity * 100));
      range.setAttribute('aria-label', t('map.overlayOpacity', { name }));
      range.title = t('map.opacity');
      const input = label.querySelector('input');
      input._ferdRange = range;
      range.addEventListener('input', function() {
        const v = Number(range.value) / 100;
        obj.layer.setOpacity(v);
        if (v > 0) state.overlayLevels.set(name, v);
        else state.overlayLevels.delete(name);
        // Through the checkbox, since adding the layer directly makes
        // Leaflet rebuild the list and drop the slider mid-drag.
        if ((v > 0) !== input.checked) input.click();
      });
      label.parentNode.insertBefore(range, label.nextSibling);
      return label;
    },
    // Leaflet disables an overlay's checkbox past the layer's zoom range,
    // and a click on it then does nothing.
    _checkDisabledLayers() {
      L.Control.Layers.prototype._checkDisabledLayers.call(this);
      for (const input of this._layerControlInputs) {
        if (input._ferdRange) input._ferdRange.disabled = input.disabled;
      }
    },
  });
}

/** @param {LeafletMap} map */
export function addTilePicker(map) {
  const overlays = state.tilePickerOverlays;
  const Ctrl = overlayLayersControlClass();
  const ctrl = new Ctrl(state.tilePickerLayers,
    overlays && Object.keys(overlays).length ? overlays : null,
    { position: 'topright' }).addTo(map);
  // Leaflet stacks a top corner in the order controls arrive, and a picker
  // turned back on in Settings arrives after the phone's map buttons.
  const el = ctrl.getContainer();
  el.parentNode.prepend(el);
  return ctrl;
}

/** @param {LeafletMap} map */
export function addTileLayersToMap(map) {
  const layers = createTileLayers();
  // app.css colours the gaps a zoom-out leaves to match the base map.
  for (const [name, layer] of Object.entries(layers)) {
    layer.on('add', () => { map.getContainer().dataset.tiles = name; });
  }
  const def = getDefaultTileLayer();
  (layers[def] || layers[BASE_LAYER_NAMES[0]]).addTo(map);
  const overlays = createOverlayLayers();
  for (const key in overlays) {
    if (state.overlayLevels.has(overlays[key]._ferdOverlay)) overlays[key].addTo(map);
  }
  state.tilePickerLayers = layers;
  state.tilePickerOverlays = overlays;
  state.tilePickerCtrl = null;
  if (getShowTilePicker()) {
    state.tilePickerCtrl = addTilePicker(map);
  }
}

// MAP-SCHEDULER-BEGIN
// Timers and animation frames scheduled against one map. Removing the map
// deletes its panes, after which Leaflet throws on any position read, so
// its 'unload' cancels everything still pending and refuses new work.
// A promise can't be cancelled, so live() wraps its continuation instead.
/** @param {LeafletMap} map */
export function mapScheduler(map) {
  const timers = new Set(), frames = new Set();
  let removed = false;
  map.once('unload', function () {
    removed = true;
    timers.forEach(function (id) { clearTimeout(id); });
    frames.forEach(function (id) { cancelAnimationFrame(id); });
    timers.clear(); frames.clear();
    // Leaflet 1.9 ends a zoom animation from an untracked 250ms timeout
    // that only runs while this flag is set, so clearing it cancels that.
    map._animatingZoom = false;
    // remove() leaves _loaded set, so Leaflet's own guard lets a late
    // invalidateSize read the deleted panes. leaflet-elevation calls it from
    // promise continuations that live() can't reach, such as _initChart's.
    map.invalidateSize = function () { return map; };
  });
  return {
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    timeout: function (fn, ms) {
      if (removed) return 0;
      const id = setTimeout(function () { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    },
    /** @param {number} id */
    clearTimeout: function (id) { timers.delete(id); clearTimeout(id); },
    /** @param {(t: number) => void} fn */
    frame: function (fn) {
      if (removed) return 0;
      const id = requestAnimationFrame(function (t) { frames.delete(id); fn(t); });
      frames.add(id);
      return id;
    },
    /** @param {number} id */
    cancelFrame: function (id) { frames.delete(id); cancelAnimationFrame(id); },
    /** @param {Function} fn */
    live: function (fn) {
      return /** @this {unknown} */ function () { if (!removed) return fn.apply(this, arguments); };
    },
  };
}
// MAP-SCHEDULER-END

export function cleanupMap() {
  if (state.currentElevation) {
    const controls = Array.isArray(state.currentElevation) ? state.currentElevation : [state.currentElevation];
    for (const ctrl of controls) { try { ctrl.remove(); } catch (e) {} }
    state.currentElevation = null;
  }
  if (state._currentMapResizeObserver) {
    try { state._currentMapResizeObserver.disconnect(); } catch (e) {}
    state._currentMapResizeObserver = null;
  }
  state._lastTrailBounds = null;
  if (state.currentMap) {
    state.currentMap.remove();
    // remove() leaves a resize's debounced moveend armed (Leaflet 1.9.4), and
    // a listener reading the view would then throw on the removed map.
    state.currentMap.off();
    state.currentMap = null;
  }
  state.tilePickerCtrl = null;
  state.tilePickerLayers = null;
  state.tilePickerOverlays = null;
  state._placeRecords = null;
  state._placeClusterGroup = null;
  state._areaGroup = null;
  state._areaLayers = null;
  state._areaRenderer = null;
  state._routeLayers = null;
  state._selectedRouteKey = null;
  state._routeGroupCompleted = null;
  state._routeGroupPlanned = null;
  state._syncRoutesOnMap = null;
  state._routeRenderer = null;
  state._detailPolylines = null;
  state._detailRenderer = null;
  state._glRoutesDirty = null;
  state._glRoutesRebuild = null;
  state._glRoutesDraw = null;
}

// Leaflet's tile transition is CSS cubic-bezier(0, 0, 0.25, 1). Match it
// exactly via Newton's method so pins and routes track the tiles through a
// zoom animation; a polynomial ease-out diverges ~5% mid-animation, visible
// as drift then snap.
/** @param {number} t */
export function easeLeaflet(t) {
  let s = t;
  for (let i = 0; i < 6; i++) {
    const sm = 1 - s;
    const x = 0.75 * sm * s * s + s * s * s;
    const dx = 1.5 * s + 0.75 * s * s;
    if (Math.abs(dx) < 1e-6) break;
    s -= (x - t) / dx;
    if (s < 0) s = 0; else if (s > 1) s = 1;
  }
  const sm = 1 - s;
  return 3 * sm * s * s + s * s * s;
}
