import { clearRouteColorCache } from './server.js';
import { refreshCategoryColors } from './map/index.js';

export const THEMES = ['catppuccin', 'dracula', 'gruvbox', 'nord', 'rose-pine', 'solarized', 'tokyo-night'];
export const MODES = ['dark', 'light', 'system'];
(function migrateTheme() {
  try {
    const old = localStorage.getItem('theme');
    if (old && MODES.includes(old)) {
      localStorage.setItem('mode', old);
      localStorage.setItem('theme', 'nord');
    } else if (old && !THEMES.includes(old)) {
      localStorage.setItem('theme', 'nord');
    }
  } catch {}
})();
export function getStoredTheme() {
  try {
    const v = localStorage.getItem('theme') || '';
    return THEMES.includes(v) ? v : 'nord';
  } catch { return 'nord'; }
}
export function getStoredMode() {
  try {
    const v = localStorage.getItem('mode') || '';
    return MODES.includes(v) ? v : 'system';
  } catch { return 'system'; }
}
/** @param {string} theme @param {string} mode */
export function applyTheme(theme, mode) {
  const eff = mode === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-mode', eff);
  clearRouteColorCache();
  // The uncategorized bucket copies --muted, and canvas clusters read theme
  // variables on each draw, so both need the new theme's values now.
  refreshCategoryColors();
}
const PIN_STYLES = ['ring', 'pin', 'dot', 'tag'];
export function getPinStyle() {
  try {
    const v = localStorage.getItem('pin-style') || '';
    return PIN_STYLES.includes(v) ? v : 'ring';
  } catch { return 'ring'; }
}
const MARKER_SIZES = /** @type {Record<string, number>} */ ({ small: 14, default: 18, large: 24 });
const ROUTE_WEIGHT_FACTORS = /** @type {Record<string, number>} */ ({ thin: 0.7, default: 1, thick: 1.4 });
const TILE_FILTERS = ['none', 'muted', 'grayscale', 'sepia', 'contrast'];
export function getMarkerSizeKey() {
  try {
    const v = localStorage.getItem('marker-size') || '';
    return MARKER_SIZES[v] ? v : 'default';
  } catch { return 'default'; }
}
export function getMarkerSize() { return MARKER_SIZES[getMarkerSizeKey()]; }
export function getTrailWeightKey() {
  try {
    const v = localStorage.getItem('route-weight') || '';
    return ROUTE_WEIGHT_FACTORS[v] ? v : 'default';
  } catch { return 'default'; }
}
export function getTrailWeightFactor() { return ROUTE_WEIGHT_FACTORS[getTrailWeightKey()]; }
export function getTileFilter() {
  try {
    const v = localStorage.getItem('tile-filter') || '';
    return TILE_FILTERS.includes(v) ? v : 'none';
  } catch { return 'none'; }
}
/** @param {string} v */
export function applyTileFilter(v) { document.documentElement.setAttribute('data-tile-filter', v); }
