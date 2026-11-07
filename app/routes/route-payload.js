import { choiceFrom, choiceValue } from '../form-fields.js';
import { parseTagInput } from '../tags.js';

// What the route forms (edit metadata and GPX upload) hold while open, and
// what they save. Pure, so the field rules are testable without a DOM.

// ROUTE-PAYLOAD-BEGIN
/**
 * @typedef {{ name: string, local_name: string, region: import('../form-fields.js').Choice,
 *   difficulty: string, tags: string, notes: string, source: string,
 *   completed: boolean, date: string, rating: number }} RouteValues
 */

/**
 * @param {any} route A stored route, or null for an upload.
 * @param {string} regionName The region it is in now.
 * @param {string[]} regions
 * @returns {RouteValues}
 */
export function routeMetaValues(route, regionName, regions) {
  const r = route || {};
  return {
    name: r.name || '',
    local_name: r.local_name || '',
    region: choiceFrom(regionName || '', regions),
    difficulty: r.difficulty || '',
    tags: (r.tags || []).join(', '),
    notes: r.notes || '',
    source: r.source || '',
    completed: !!r.completed,
    date: r.date_completed || '',
    rating: Number(r.rating) || 0,
  };
}

/**
 * The metadata the editor and the upload share. A field hidden in Settings >
 * Optional fields is not read.
 * @param {RouteValues} v
 * @param {(field: string) => boolean} show
 */
export function routeMetaFields(v, show) {
  /** @type {any} */
  const metadata = {};
  const source = v.source.trim();
  const tags = show('tags') ? parseTagInput(v.tags) : null;
  if (source) metadata.source = source;
  if (show('note') && v.notes.trim()) metadata.notes = v.notes;
  if (show('local-name') && v.local_name.trim()) metadata.local_name = v.local_name.trim();
  if (v.difficulty) metadata.difficulty = v.difficulty;
  if (tags) metadata.tags = tags;
  return metadata;
}

/**
 * What saving the editor does: the metadata to write, and whether the file
 * has to change region, name or planned/completed state first.
 * @param {RouteValues} v
 * @param {any} route
 * @param {string} regionName
 * @param {(field: string) => boolean} show
 * @returns {{ error: string } | { metadata: any, newName: string, targetRegion: string,
 *   newCompleted: boolean, needsMove: boolean, needsCompletedFlip: boolean }}
 */
export function editRoutePlan(v, route, regionName, show) {
  const metadata = routeMetaFields(v, show);
  if (show('date') && v.date.trim()) metadata.date_completed = v.date.trim();
  if (show('rating') && v.rating) metadata.rating = v.rating;
  const newName = v.name.trim();
  if (!newName) return { error: 'name' };
  const targetRegion = choiceValue(v.region);
  if (v.region.sel === '__new__' && !targetRegion) return { error: 'region' };
  const needsMove = targetRegion !== (regionName || '') || newName !== route.name;
  const newCompleted = v.completed;
  const needsCompletedFlip = newCompleted !== !!route.completed;
  // A hidden field is not in the form, and a save replaces the stored
  // metadata, so what was stored carries over.
  if (!show('local-name') && route.local_name) metadata.local_name = route.local_name;
  if (!show('note') && route.notes) metadata.notes = route.notes;
  if (!show('tags') && route.tags && route.tags.length) metadata.tags = route.tags;
  if (newCompleted) {
    if (!show('date') && route.date_completed) metadata.date_completed = route.date_completed;
    if (!show('rating') && route.rating) metadata.rating = route.rating;
  }
  return { metadata, newName, targetRegion, newCompleted, needsMove, needsCompletedFlip };
}

/**
 * What an upload sends. A planned route is stored as `<name>.planned` and
 * drawn dashed; the metadata is keyed by the route's name without that.
 * @param {RouteValues} v
 * @param {File | null} file
 * @param {(field: string) => boolean} show
 * @returns {{ error: string } | { region: string, name: string, storedName: string, metaKey: string, metadata: any }}
 */
export function gpxUploadPlan(v, file, show) {
  if (!file) return { error: 'file' };
  const region = choiceValue(v.region);
  const name = v.name.trim();
  const metadata = routeMetaFields(v, show);
  if (v.completed) {
    if (show('date') && v.date.trim()) metadata.date_completed = v.date.trim();
    if (show('rating') && v.rating) metadata.rating = v.rating;
  }
  return {
    region, name,
    storedName: v.completed ? name : name + '.planned',
    metaKey: region ? region + '/' + name : name,
    metadata,
  };
}
// ROUTE-PAYLOAD-END
