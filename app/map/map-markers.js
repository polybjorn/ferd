import { state } from '../core.js';
import { getMarkerSize, getPinStyle } from '../theme.js';
import { wrappedRouter } from '../router.js';

function createMarkerIcon(color, visited) {
  const size = getMarkerSize(), cx = size / 2, cy = size / 2;
  const style = getPinStyle();
  let svg, iconSize, iconAnchor;
  if (style === 'pin') {
    const w = size + 4;
    const h = Math.round(w * 33 / 24);
    if (visited) {
      svg = '<svg viewBox="0 0 24 33" width="' + w + '" height="' + h + '">' +
        '<line x1="12" y1="14" x2="12" y2="33" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round"/>' +
        '<circle cx="12" cy="9" r="7" fill="' + color + '"/>' +
        '</svg>';
    } else {
      svg = '<svg viewBox="-1.5 -1.5 27 36" width="' + w + '" height="' + h + '">' +
        '<line x1="12" y1="14" x2="12" y2="33" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round"/>' +
        '<circle cx="12" cy="9" r="7" fill="' + color + '" fill-opacity="0.25" stroke="' + color + '" stroke-width="2"/>' +
        '</svg>';
    }
    iconSize = [w, h];
    iconAnchor = [w / 2, h];
  } else if (style === 'dot') {
    const r = Math.max(3, Math.round(size * 0.35));
    svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + color + '"' + (visited ? '' : ' fill-opacity="0.5"') + '/>' +
      '</svg>';
    iconSize = [size, size];
    iconAnchor = [size / 2, size / 2];
  } else if (style === 'tag') {
    const w = size + 6;
    const h = Math.round(w * 24 / 22);
    const flagPath = 'M0 0 L22 0 L22 10 L2 10 L2 24 L0 24 Z';
    if (visited) {
      svg = '<svg viewBox="0 0 22 24" width="' + w + '" height="' + h + '">' +
        '<path d="' + flagPath + '" fill="' + color + '"/>' +
        '</svg>';
    } else {
      svg = '<svg viewBox="-1.5 -1.5 25 27" width="' + w + '" height="' + h + '">' +
        '<path d="' + flagPath + '" fill="' + color + '" fill-opacity="0.25" stroke="' + color + '" stroke-width="2"/>' +
        '</svg>';
    }
    iconSize = [w, h];
    iconAnchor = [1, h];
  } else if (visited) {
    svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (size/2 - 1) + '" fill="' + color + '"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (size/2 - 1) + '" fill="none" stroke="#fff" stroke-width="1" opacity="0.6"/>' +
      '</svg>';
    iconSize = [size, size];
    iconAnchor = [size / 2, size / 2];
  } else {
    svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (size/2 - 2) + '" fill="' + color + '" fill-opacity="0.25"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (size/2 - 2) + '" fill="none" stroke="' + color + '" stroke-width="2"/>' +
      '</svg>';
    iconSize = [size, size];
    iconAnchor = [size / 2, size / 2];
  }
  return L.divIcon({ className: '', html: svg, iconSize: iconSize, iconAnchor: iconAnchor });
}

// Apply current pin-style + marker-size to all live places without
// rebuilding the map. Falls back to a full router pass if no map.
export function refreshPlaceMarkerIcons() {
  if (!state._placeClusterGroup) { wrappedRouter(); return; }
  state._placeClusterGroup.redraw();
}

// Apply current route-weight to all live route polylines without rebuilding.
// Stamp the original stroke-width on first observation so later
// adjustments can divide back without losing precision.
// Waypoint rendering helpers. leaflet-gpx skips creating a marker if
// wptIcons[''] is null (just logs a warning), so we feed it a
// placeholder icon to trigger its 'addpoint' event, then replace the
// icon with a fresh per-waypoint instance and close the popup it
// auto-opens during construction. Sharing one L.divIcon across many
// markers caused stale popup content (rendered as "[object Object]"
// for waypoints past the first) when we tried supplying it directly.
export function makeWaypointIcon() {
  return L.divIcon({
    className: 'gpx-waypoint-icon',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
    html: '',
  });
}
export const WAYPOINT_PLACEHOLDER_ICON = makeWaypointIcon();
export function attachWaypointHandlers(gpxLayer) {
  gpxLayer.on('addpoint', function(e) {
    if (e.point_type !== 'waypoint') return;
    const m = e.point;
    const symEl = e.element && (e.element.getElementsByTagName('sym')[0]);
    m._ferdSym = symEl ? symEl.textContent.trim() : '';
    try { m.setIcon(makeWaypointIcon()); } catch (_) {}
    try { m.closePopup(); } catch (_) {}
  });
}
