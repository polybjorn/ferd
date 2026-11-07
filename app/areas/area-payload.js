import { choiceFrom, choiceValue } from '../form-fields.js';
import { buildAreaGeometry } from '../area-geo.js';

// What the area forms hold while open, and the payloads they save. Pure, so
// the field rules are testable without a DOM.

// AREA-PAYLOAD-BEGIN
/**
 * @typedef {{ name: string, local_name: string, category: import('../form-fields.js').Choice,
 *   note: string, visited: boolean }} AreaValues
 */

/**
 * @param {any} area A stored area, or null for a new one.
 * @param {string[]} categories
 * @returns {AreaValues}
 */
export function areaValues(area, categories) {
  const a = area || {};
  return {
    name: a.name || '',
    local_name: a.local_name || '',
    category: choiceFrom(a.category, categories),
    note: a.note || '',
    visited: !!a.visited,
  };
}

/**
 * The fields the Add and Edit forms share. A note hidden in Settings >
 * Optional fields is left out.
 * @param {AreaValues} v
 * @param {(field: string) => boolean} show
 */
export function areaFormPayload(v, show) {
  /** @type {{ visited: boolean, category?: string, note?: string }} */
  const payload = { visited: v.visited };
  const category = choiceValue(v.category);
  if (category) payload.category = category;
  if (show('note') && v.note.trim()) payload.note = v.note.trim();
  return payload;
}

// A save replaces the whole area, and a hidden input is not in the form, so
// `kept` is what survives it.
/**
 * @param {AreaValues} v
 * @param {(field: string) => boolean} show
 * @param {string} kept
 */
export function areaLocalName(v, show, kept) {
  return show('local-name') ? v.local_name.trim() : (kept || '');
}

/**
 * @param {AreaValues} v
 * @param {any} area
 * @param {(field: string) => boolean} show
 */
export function editAreaPayload(v, area, show) {
  /** @type {any} */
  const payload = Object.assign(areaFormPayload(v, show), {
    name: v.name.trim(),
    geometry: area.geometry,
  });
  if (!show('note') && area.note) payload.note = area.note;
  const local = areaLocalName(v, show, area.local_name);
  if (local) payload.local_name = local;
  if (area.source) payload.source = area.source;
  return payload;
}

/**
 * The areas an Add form creates: one per polygon group when split, else a
 * single merged area named by the form.
 * @param {AreaValues} v
 * @param {{ parsed: { features: { name?: string, polygons: any[] }[], osm?: boolean },
 *   split: boolean, pickedLocal: string, show: (field: string) => boolean,
 *   fallbackName: (n: number) => string }} opts
 */
export function newAreaItems(v, { parsed, split, pickedLocal, show, fallbackName }) {
  const shared = areaFormPayload(v, show);
  /** @type {any[]} */
  const items = split
    ? parsed.features.map((x, i) => Object.assign({}, shared, { name: x.name || fallbackName(i + 1), geometry: buildAreaGeometry(x.polygons) }))
    : [Object.assign({}, shared, { name: v.name.trim(), geometry: buildAreaGeometry(parsed.features.flatMap(x => x.polygons)) })];
  const local = areaLocalName(v, show, pickedLocal);
  if (local && items.length === 1 && !split) items[0].local_name = local;
  if (parsed.osm) for (const item of items) item.source = 'osm';
  return items;
}
// AREA-PAYLOAD-END
