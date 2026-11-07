import { choiceFrom, choiceValue, roundCoord, sourcesFromText } from '../form-fields.js';
import { parseTagInput } from '../tags.js';

// What the place forms (edit and add) hold while open, and the payload they
// save. Pure, so the field rules are testable without a DOM.

// PLACE-PAYLOAD-BEGIN
/**
 * @typedef {{ name: string, local_name: string, lat: string, lon: string,
 *   category: import('../form-fields.js').Choice, country: string, tags: string, note: string,
 *   image: string, sources: string, visited: boolean, date_visited: string, rating: number }} PlaceValues
 */

/**
 * The form's starting values from a place, or from the draft a pick-on-map
 * round trip carries.
 * @param {any} place
 * @param {string[]} categories
 * @returns {PlaceValues}
 */
export function placeValues(place, categories) {
  const p = place || {};
  return {
    name: p.name || '',
    local_name: p.local_name || '',
    lat: p.lat == null ? '' : String(p.lat),
    lon: p.lon == null ? '' : String(p.lon),
    category: choiceFrom(p.category, categories),
    country: p.country || '',
    tags: (p.tags || []).join(', '),
    note: p.note || '',
    image: p.image || '',
    sources: (p.sources || []).join('\n'),
    visited: !!p.visited,
    date_visited: p.date_visited || '',
    rating: Number(p.rating) || 0,
  };
}

/**
 * The fields to carry across closing the form for a map click. It does not
 * need coordinates, since picking them is the point.
 * @param {PlaceValues} v
 */
export function placeSnapshot(v) {
  return {
    name: v.name.trim(),
    local_name: v.local_name.trim(),
    category: choiceValue(v.category),
    country: v.country.trim(),
    tags: parseTagInput(v.tags) || [],
    note: v.note.trim(),
    image: v.image.trim(),
    sources: sourcesFromText(v.sources),
    visited: v.visited,
    date_visited: v.date_visited.trim(),
    rating: v.rating,
  };
}

/**
 * The payload to save, or `{ error: 'coords' }` without a position. A field
 * the user has hidden in Settings > Optional fields is not read.
 * @param {PlaceValues} v
 * @param {(field: string) => boolean} show
 * @returns {{ error: string } | { payload: any }}
 */
export function placePayload(v, show) {
  const rawLat = parseFloat(v.lat);
  const rawLon = parseFloat(v.lon);
  if (Number.isNaN(rawLat) || Number.isNaN(rawLon)) return { error: 'coords' };
  const payload = /** @type {any} */ ({
    name: v.name.trim(),
    lat: roundCoord(rawLat),
    lon: roundCoord(rawLon),
    visited: v.visited,
  });
  const category = choiceValue(v.category);
  const country = v.country.trim();
  const sources = sourcesFromText(v.sources);
  if (category) payload.category = category;
  if (country) payload.country = country;
  if (show('note') && v.note.trim()) payload.note = v.note.trim();
  if (show('local-name') && v.local_name.trim()) payload.local_name = v.local_name.trim();
  if (show('image') && v.image.trim()) payload.image = v.image.trim();
  if (sources.length) payload.sources = sources;
  const tags = show('tags') ? parseTagInput(v.tags) : null;
  if (tags) payload.tags = tags;
  // Visit-only metadata: ignored while the visited toggle is off.
  if (payload.visited) {
    if (show('date') && v.date_visited.trim()) payload.date_visited = v.date_visited.trim();
    if (show('rating') && v.rating) payload.rating = v.rating;
  }
  return { payload };
}

/**
 * The payload of an edit. The form has no input for the catalog lineage or
 * the image focus, and a field hidden in Settings is not read, so a save
 * would erase them; the stored values are carried over instead. For a
 * catalog-linked place that erasure would also resurface a bogus "Update
 * from catalog". The server clears the focus on a genuine image swap.
 * @param {PlaceValues} v
 * @param {any} place
 * @param {(field: string) => boolean} show
 * @returns {{ error: string } | { payload: any }}
 */
export function editPlacePayload(v, place, show) {
  const r = placePayload(v, show);
  if ('error' in r) return r;
  const out = r.payload;
  if (place.from_catalog) out.from_catalog = place.from_catalog;
  if (!show('local-name') && place.local_name) out.local_name = place.local_name;
  if (!show('note') && place.note) out.note = place.note;
  if (!show('image') && place.image) out.image = place.image;
  if (!show('tags') && place.tags && place.tags.length) out.tags = place.tags;
  if (place.image_focus && out.image === place.image) out.image_focus = place.image_focus;
  if (out.visited) {
    if (!show('date') && place.date_visited) out.date_visited = place.date_visited;
    if (!show('rating') && place.rating) out.rating = place.rating;
  }
  return { payload: out };
}
// PLACE-PAYLOAD-END
