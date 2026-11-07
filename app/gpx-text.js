// GPX text helpers shared by the store and the backup import: the manifest
// fields the server derives from a GPX file, PII stripping, and route keys.

export function _genId() {
  const b = new Uint8Array(4);
  (crypto || window.crypto).getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// Parse a GPX string for the manifest fields the server computes server-side
// (see scripts/gpx-manifest.sh): bbox [minLat,minLon,maxLat,maxLon] over all
// track/route/waypoints, whether any <ele> is present, and track count/names.
/** @param {string} text */
export function parseGpxText(text) {
  /** @type {{ bbox: number[] | null, hasElevation: boolean, trackCount: number, trackNames: string[] }} */
  const out = { bbox: null, hasElevation: false, trackCount: 0, trackNames: [] };
  let doc;
  try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
  catch { return out; }
  if (!doc || doc.getElementsByTagName('parsererror').length) return out;
  let mnLat = Infinity, mnLon = Infinity, mxLat = -Infinity, mxLon = -Infinity, found = false;
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    const els = doc.getElementsByTagNameNS('*', tag);
    for (let i = 0; i < els.length; i++) {
      const lat = parseFloat(els[i].getAttribute('lat')), lon = parseFloat(els[i].getAttribute('lon'));
      if (isNaN(lat) || isNaN(lon)) continue;
      if (lat < mnLat) mnLat = lat; if (lon < mnLon) mnLon = lon;
      if (lat > mxLat) mxLat = lat; if (lon > mxLon) mxLon = lon;
      found = true;
    }
  }
  if (found) out.bbox = [_round6(mnLat), _round6(mnLon), _round6(mxLat), _round6(mxLon)];
  out.hasElevation = doc.getElementsByTagNameNS('*', 'ele').length > 0;
  const trks = doc.getElementsByTagNameNS('*', 'trk');
  out.trackCount = trks.length;
  for (let i = 0; i < trks.length; i++) {
    const n = trks[i].getElementsByTagNameNS('*', 'name')[0];
    out.trackNames.push(n && n.textContent ? n.textContent : 'Track ' + (i + 1));
  }
  return out;
}

// Mirror the server's strip_gpx_pii: drop <time>/<author> elements and the
// root creator= attribute. Used on upload/import when the user opts in.
/** @param {string} text */
export function stripGpxPiiText(text) {
  let doc;
  try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
  catch { return text; }
  if (doc.getElementsByTagName('parsererror').length) return text;
  const root = doc.documentElement;
  if (root && root.hasAttribute('creator')) root.removeAttribute('creator');
  for (const tag of ['time', 'author']) {
    const els = doc.getElementsByTagNameNS('*', tag);
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.parentNode) e.parentNode.removeChild(e);
    }
  }
  try { return new XMLSerializer().serializeToString(doc); }
  catch { return text; }
}

// The route metadata fields, laid over a route's manifest entry.
export const ROUTE_META_FIELDS = ['source', 'date_completed', 'rating', 'notes', 'tags', 'difficulty', 'local_name'];

/** @param {string} key */
export function _splitKey(key) {
  const parts = (key || '').split('/');
  return parts.length === 2 ? { region: parts[0], name: parts[1] } : { region: '', name: parts[0] };
}

/** @param {number} n */
function _round6(n) { return Math.round(n * 1e6) / 1e6; }
