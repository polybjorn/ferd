import { state } from '../core.js';
import { wrappedRouter } from '../router.js';

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
/** @param {import('./route-layer.js').LeafletLayer} gpxLayer */
export function attachWaypointHandlers(gpxLayer) {
  gpxLayer.on('addpoint', function(/** @type {any} */ e) {
    if (e.point_type !== 'waypoint') return;
    const m = e.point;
    const symEl = e.element && (e.element.getElementsByTagName('sym')[0]);
    m._ferdSym = symEl ? symEl.textContent.trim() : '';
    try { m.setIcon(makeWaypointIcon()); } catch (_) {}
    try { m.closePopup(); } catch (_) {}
  });
}
