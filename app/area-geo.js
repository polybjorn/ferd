// AREA-GEO-BEGIN (tests/js/area-geo.test.js runs the code between these markers)
// Administrative and park boundaries arrive with hundreds of thousands of
// vertices. The target keeps one area well inside the API's body cap and
// cheap to re-project on every zoom frame.
export const AREA_TARGET_POINTS = 5000;
export const AREA_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const AREA_CATEGORY_KINDS = new Set([
  'city', 'country', 'county', 'island', 'municipality', 'national-park', 'nature-reserve',
  'park', 'province', 'region', 'state', 'town', 'village',
]);
const AREA_PROJECTED_MSG = 'Coordinates are outside the lon/lat range, so the file is probably in a projected system such as UTM33 (EPSG:25833). Reproject it to WGS84.';

/**
 * [lon, lat] in degrees, GeoJSON's order.
 * @typedef {number[]} Position
 */
/**
 * A closed ring: the first and last positions are the same.
 * @typedef {Position[]} Ring
 */
/**
 * An outer ring followed by its holes.
 * @typedef {Ring[]} PolygonRings
 */
/**
 * @typedef {{ type: 'Polygon', coordinates: PolygonRings }
 *   | { type: 'MultiPolygon', coordinates: PolygonRings[] }} AreaGeometry
 */
/**
 * A geometry as read from a file or the API, before it is checked.
 * @typedef {{ type?: unknown, coordinates?: unknown }} GeometryInput
 */
/**
 * The properties `nominatimAreas` reads from a Nominatim GeoJSON feature.
 * @typedef {object} NominatimProperties
 * @property {string} [name]
 * @property {{ name?: string }} [namedetails]
 * @property {string} [addresstype]
 * @property {string} [type]
 * @property {string} [display_name]
 */
/**
 * [south, west, north, east].
 * @typedef {number[]} Bbox
 */

/**
 * @param {unknown} pos
 * @returns {Position}
 */
function _areaPosition(pos) {
  if (!Array.isArray(pos) || pos.length < 2) throw new Error('The file has a malformed coordinate.');
  const lon = pos[0], lat = pos[1];
  if (typeof lon !== 'number' || typeof lat !== 'number') throw new Error('The file has a malformed coordinate.');
  if (!(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) throw new Error(AREA_PROJECTED_MSG);
  return [lon, lat];
}
/**
 * @param {unknown} ring
 * @returns {Ring}
 */
function _areaRing(ring) {
  if (!Array.isArray(ring)) throw new Error('The file has a malformed polygon.');
  const out = ring.map(_areaPosition);
  if (!out.length) return out;
  const a = out[0], b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out;
}
// A polygon whose outer ring can't enclose anything is dropped; so is a hole.
/**
 * @param {unknown} rings
 * @returns {PolygonRings | null}
 */
function _areaPolygon(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const clean = rings.map(_areaRing);
  if (clean[0].length < 4) return null;
  return [clean[0]].concat(clean.slice(1).filter(r => r.length >= 4));
}
/**
 * @param {GeometryInput | null | undefined} g
 * @returns {PolygonRings[]}
 */
function _areaPolygons(g) {
  if (!g || !Array.isArray(g.coordinates)) return [];
  const raw = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return /** @type {PolygonRings[]} */ (raw.map(_areaPolygon).filter(Boolean));
}
// A local-only import has no server to refuse a malformed area, and one
// that reaches the map stops every area from drawing.
/** @param {{ geometry?: GeometryInput } | null | undefined} area */
export function areaHasGeometry(area) {
  try { return !!area && _areaPolygons(area.geometry).length > 0; } catch { return false; }
}
// Returns { features: [{ name, polygons }], ignored }, where `polygons` is a
// list of ring lists and `ignored` counts features with no polygon in them.
/** @param {string} text */
export function parseAreaGeoJson(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('This file is not valid GeoJSON.'); }
  if (!doc || typeof doc !== 'object') throw new Error('This file is not valid GeoJSON.');
  const crs = doc.crs && doc.crs.properties && doc.crs.properties.name;
  if (typeof crs === 'string' && !/CRS84|EPSG:+4326/i.test(crs)) {
    throw new Error('The file is in ' + crs + '. Reproject it to WGS84.');
  }
  let items;
  if (doc.type === 'FeatureCollection' && Array.isArray(doc.features)) items = doc.features;
  else if (doc.type === 'Feature') items = [doc];
  else if (typeof doc.type === 'string' && Array.isArray(doc.coordinates)) items = [{ geometry: doc }];
  else throw new Error('This file is not valid GeoJSON.');
  const features = [];
  let ignored = 0;
  for (const item of items) {
    const polygons = _areaPolygons(item && item.geometry);
    if (!polygons.length) { ignored++; continue; }
    const name = item.properties && item.properties.name;
    features.push({ name: typeof name === 'string' ? name.trim().slice(0, 200) : '', polygons });
  }
  if (!features.length) throw new Error('The file has no polygons.');
  // Nominatim states its licence in `licence`, Overpass in `copyright`.
  const osm = /openstreetmap/i.test(String(doc.licence || doc.copyright || ''));
  return { features, ignored, osm };
}
// `name` follows accept-language, namedetails.name is the name on the ground.
/**
 * @param {{ features?: Array<{ geometry?: GeometryInput, properties?: NominatimProperties } | null> }
 *   | null | undefined} doc
 */
export function nominatimAreas(doc) {
  const out = [];
  for (const item of (doc && doc.features) || []) {
    const polygons = _areaPolygons(item && item.geometry);
    const p = (item && item.properties) || /** @type {NominatimProperties} */ ({});
    const local = (p.namedetails && p.namedetails.name) || '';
    const name = p.name || local;
    if (!polygons.length || !name) continue;
    const kind = (p.addresstype || p.type || '').replace(/_/g, ' ');
    out.push({
      name: name.slice(0, 200),
      localName: local === name ? '' : local.slice(0, 200),
      kind,
      detail: (p.display_name || '').split(', ').slice(1).join(', '),
      polygons,
    });
  }
  return out;
}
/** @param {PolygonRings[]} polygons */
export function _areaPointCount(polygons) {
  let n = 0;
  for (const rings of polygons) for (const r of rings) n += r.length;
  return n;
}
/**
 * @param {Position} p
 * @param {Position} a
 * @param {Position} b
 */
function _segDistSq(p, a, b) {
  let x = a[0], y = a[1];
  const dx = b[0] - x, dy = b[1] - y;
  if (dx || dy) {
    const t = Math.max(0, Math.min(1, ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)));
    x += t * dx; y += t * dy;
  }
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}
// Douglas-Peucker with an explicit stack: a boundary ring can be long enough
// to overflow the call stack if this recursed.
/**
 * @param {Position[]} points
 * @param {number} tolSq
 */
function _simplifyLine(points, tolSq) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = /** @type {number[]} */ (stack.pop());
    let worst = 0, at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = _segDistSq(points[i], points[lo], points[hi]);
      if (d > worst) { worst = d; at = i; }
    }
    if (at !== -1 && worst > tolSq) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
// A closed ring has identical end points, which gives Douglas-Peucker no
// baseline, so it is split at the vertex farthest from the start.
/**
 * @param {Ring} ring
 * @param {number} tolSq
 * @param {boolean} mustSurvive
 * @returns {Ring | null}
 */
function _simplifyRing(ring, tolSq, mustSurvive) {
  let far = 1, worst = -1;
  for (let i = 1; i < ring.length - 1; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > worst) { worst = d; far = i; }
  }
  const out = _simplifyLine(ring.slice(0, far + 1), tolSq).concat(_simplifyLine(ring.slice(far), tolSq).slice(1));
  if (out.length >= 4) return out;
  if (!mustSurvive) return null;
  const third = ring[far > 1 ? 1 : ring.length - 2];
  return [ring[0], ring[far], third, ring[0]];
}
/** @param {Ring} ring */
function _ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(sum) / 2;
}
/**
 * @param {PolygonRings[]} polygons
 * @param {number} tolSq
 * @param {PolygonRings} largest
 * @returns {PolygonRings[]}
 */
function _simplifyPolygons(polygons, tolSq, largest) {
  const out = [];
  for (const rings of polygons) {
    const outer = _simplifyRing(rings[0], tolSq, rings === largest);
    if (!outer) continue;
    const holes = /** @type {Position[][]} */ (rings.slice(1).map(r => _simplifyRing(r, tolSq, false)).filter(Boolean));
    out.push([outer].concat(holes));
  }
  return out;
}
/**
 * @param {Ring} ring
 * @returns {Ring}
 */
function _roundRing(ring) { return ring.map(p => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]); }
// Simplify to the target and wrap as GeoJSON. Tolerance doubles from about a
// metre, so a file that already fits comes through unchanged. The largest
// polygon always survives; islets and holes fall away as the tolerance grows.
/**
 * @param {PolygonRings[]} polygons
 * @param {number} [target]
 * @returns {AreaGeometry}
 */
export function buildAreaGeometry(polygons, target) {
  const limit = target || AREA_TARGET_POINTS;
  let out = polygons;
  if (_areaPointCount(polygons) > limit) {
    let largest = polygons[0];
    for (const rings of polygons) if (_ringArea(rings[0]) > _ringArea(largest[0])) largest = rings;
    let tol = 1e-5;
    do {
      out = _simplifyPolygons(polygons, tol * tol, largest);
      tol *= 2;
    } while (_areaPointCount(out) > limit && tol < 360);
  }
  const rounded = out.map(rings => rings.map(_roundRing));
  return rounded.length === 1
    ? { type: 'Polygon', coordinates: rounded[0] }
    : { type: 'MultiPolygon', coordinates: rounded };
}
/**
 * @param {AreaGeometry} g
 * @returns {PolygonRings[]}
 */
export function _geometryPolygons(g) { return g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }
/**
 * @param {Ring} ring
 * @param {number} x
 * @param {number} y
 */
function _ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
/**
 * @param {AreaGeometry} geometry
 * @param {number} lon
 * @param {number} lat
 */
export function areaContains(geometry, lon, lat) {
  return _geometryPolygons(geometry).some(rings =>
    _ringContains(rings[0], lon, lat) && !rings.slice(1).some(h => _ringContains(h, lon, lat)));
}
// In squared degrees: only good for ranking one area against another.
/** @param {AreaGeometry} geometry */
export function areaSize(geometry) {
  let sum = 0;
  for (const rings of _geometryPolygons(geometry)) {
    sum += _ringArea(rings[0]);
    for (const hole of rings.slice(1)) sum -= _ringArea(hole);
  }
  return sum;
}
// [south, west, north, east], the order of a route's bbox in the manifest.
/**
 * @param {AreaGeometry} geometry
 * @returns {Bbox}
 */
export function areaBbox(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rings of _geometryPolygons(geometry)) {
    for (const [lon, lat] of rings[0]) {
      if (lat < box[0]) box[0] = lat;
      if (lon < box[1]) box[1] = lon;
      if (lat > box[2]) box[2] = lat;
      if (lon > box[3]) box[3] = lon;
    }
  }
  return box;
}
/**
 * @param {Bbox} a
 * @param {Bbox} b
 */
export function bboxesOverlap(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
/**
 * @param {AreaGeometry} geometry
 * @param {Bbox} box
 * @param {number} lon
 * @param {number} lat
 */
function _inArea(geometry, box, lon, lat) {
  return lat >= box[0] && lat <= box[2] && lon >= box[1] && lon <= box[3]
    && areaContains(geometry, lon, lat);
}
/**
 * @template {{ lon: number, lat: number }} T
 * @param {AreaGeometry} geometry
 * @param {T[]} places
 * @returns {T[]}
 */
export function placesInArea(geometry, places) {
  const box = areaBbox(geometry);
  return places.filter(p => _inArea(geometry, box, p.lon, p.lat));
}
// A route counts as soon as one track point falls inside, so a route that
// only crosses the area is still part of what the area holds.
/**
 * @param {AreaGeometry} geometry
 * @param {Array<{ points: Array<{ lon: number, lat: number }> }>} tracks
 */
export function tracksTouchArea(geometry, tracks) {
  const box = areaBbox(geometry);
  return tracks.some(t => t.points.some(pt => _inArea(geometry, box, pt.lon, pt.lat)));
}
// AREA-GEO-END
