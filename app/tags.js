import { escapeHtml } from './core.js';
import { getShowField } from './prefs.js';

// Parse a comma-separated input into a trimmed, de-blanked array, or null if empty.
export function parseTagInput(str) {
  const t = (str || '').split(',').map(s => s.trim()).filter(Boolean);
  return t.length ? t : null;
}
const TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/;
// Mirror of the server's normalize_tags (tools/ferd_api/common.py): trim, drop blanks,
// format-check, case-insensitive dedup (first-seen casing kept), cap at 10.
// Throws on a non-array, non-string item, or bad format. The local-only write
// path has no server to validate, so it runs this to match server behavior.
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new Error('tags must be a list of strings');
  const out = [], seen = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') throw new Error('each tag must be a string');
    const tn = t.trim();
    if (!tn) continue;
    if (!TAG_RE.test(tn)) throw new Error('invalid tag: "' + tn + '" (alphanumerics + hyphen, 1-32 chars, starts with alphanumeric)');
    const k = tn.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(tn); }
  }
  if (out.length > 10) throw new Error('too many tags (max 10)');
  return out;
}
// Normalize a place object's tags in place (local-only writes). Drops the key
// when empty so we don't persist "tags": [].
export function normalizePlaceTags(place) {
  if (place && 'tags' in place) {
    const t = normalizeTags(place.tags);
    if (t.length) place.tags = t; else delete place.tags;
  }
  return place;
}
// Pill badges for list cards; cls is the wrapper class (place-tags / route-meta-tags).
export function tagPillsHtml(tags, cls) {
  return (getShowField('tags') && Array.isArray(tags) && tags.length)
    ? '<div class="' + cls + '">' + tags.map(t => '<span class="tag">#' + escapeHtml(t) + '</span>').join('') + '</div>' : '';
}
// Unique tags across items (case-insensitive, first-seen casing kept), sorted.
export function collectTags(items) {
  const m = new Map();
  for (const it of (items || [])) if (Array.isArray(it.tags)) for (const t of it.tags) {
    if (!t) continue;
    const k = t.toLowerCase();
    if (!m.has(k)) m.set(k, t);
  }
  return [...m.values()].sort((a, b) => a.localeCompare(b));
}
// Case-insensitive membership test for a filter value ('all' always matches).
export function tagsInclude(tags, want) {
  if (want === 'all') return true;
  const w = String(want).toLowerCase();
  return Array.isArray(tags) && tags.some(t => t.toLowerCase() === w);
}
// Multi-select AND match: the entry must carry every wanted tag
// (case-insensitive). An empty/absent want list matches everything.
export function tagsIncludeAll(tags, wants) {
  if (!Array.isArray(wants) || !wants.length) return true;
  const have = new Set((Array.isArray(tags) ? tags : []).map(t => t.toLowerCase()));
  return wants.every(w => have.has(String(w).toLowerCase()));
}
