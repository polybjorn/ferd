import { manifestRoutes, reduceMotion, state } from '../core.js';
import { gpxUrlFor } from '../server.js';
import {
  areaBbox, areaContains, areaSize, bboxesOverlap, placesInArea, tracksTouchArea,
} from '../area-geo.js';
import { placesEnabled } from '../prefs.js';
import { openEditAreaModal } from '../areas/edit-area.js';
import { fetchGpxText } from './route-layer.js';
import { html } from '../view.js';
import { AreaPopup, popupElement } from './popups.js';
import { COUNTRY_MAX_ZOOM } from '../countries.js';
import { syncCountriesOnMap } from './country-layer.js';
import { goToPlace, goToRoute } from './map-actions.js';
import { parseGpxTracks } from './route-detail.js';

// Areas get their own pane under the route layers, with no pointer events:
// a filled polygon must never swallow a click meant for a route, a pin or
// the map. Clicks are matched in openAreaPopupAt instead.
export function initAreaLayers(map) {
  const pane = map.createPane('areasPane');
  pane.style.zIndex = 390;
  pane.style.pointerEvents = 'none';
  state._areaRenderer = L.svg({ pane: 'areasPane' });
  state._areaGroup = L.featureGroup().addTo(map);
  const countryPane = map.createPane('countriesPane');
  countryPane.style.zIndex = 380;
  countryPane.style.pointerEvents = 'none';
  state._countryRenderer = L.svg({ pane: 'countriesPane' });
  state._countryGroup = L.featureGroup().addTo(map);
  state._countryGroup._key = null;
  // Natural Earth is a world-scale dataset: past this zoom its coast visibly
  // misses the imagery at any detail level, so the fill is an overview only.
  // Rounded because zoom settles on a whole number: the raw value would
  // fade the fill out mid-pinch and back in when the map snaps.
  const syncCountryPane = e => {
    const zoom = e && e.zoom !== undefined ? e.zoom : map.getZoom();
    countryPane.classList.toggle('zoomed-past', Math.round(zoom) > COUNTRY_MAX_ZOOM);
  };
  map.on('zoomanim zoom zoomend', syncCountryPane);
  syncCountryPane();
  syncAreasOnMap();
}
export function areaStyle(a, visited) {
  const color = state.categoryColors[a.category] || state.categoryColors[''];
  return visited
    ? { color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.22, dashArray: null }
    : { color, weight: 2, opacity: 0.7, fillColor: color, fillOpacity: 0.08, dashArray: '6 6' };
}
export const MAP_FADE_MS = 300;
// Routes and area outlines can sit in the WebGL buffer, where one line can't
// fade alone, so an SVG copy fades in the place of the removed shape.
function fadeOutShape(map, shape) {
  if (reduceMotion()) return;
  shape.addTo(map);
  shape.eachLayer(function(part) {
    part.getElement().animate([{ opacity: 1 }, { opacity: 0 }], { duration: MAP_FADE_MS, easing: 'ease', fill: 'forwards' });
  });
  setTimeout(function() { shape.remove(); }, MAP_FADE_MS);
}
// Captured before a delete, while the area's layer still says whether it
// shows: the store's write rebuilds the layers before the delete resolves.
export function areaFadeOut(area) {
  const entry = (state._areaLayers || []).find(x => x.area.id === area.id);
  const shown = !!entry && !!state._areaGroup && state._areaGroup.hasLayer(entry.layer);
  return function() { if (shown) fadeOutArea(area, entry.visited); };
}
function fadeOutArea(area, visited) {
  if (!state.currentMap || !state._areaRenderer) return;
  fadeOutShape(state.currentMap, L.geoJSON(area.geometry, {
    renderer: state._areaRenderer,
    pane: 'areasPane',
    interactive: false,
    style: areaStyle(area, visited),
  }));
}
export function fadeOutRoute(map, layer) {
  if (!state._areaRenderer) return;
  const shape = L.featureGroup();
  const visit = function(part) {
    if (part.getLatLngs && !part.eachLayer) {
      const { color, weight, opacity } = part.options;
      shape.addLayer(L.polyline(part.getLatLngs(), {
        color, weight, opacity,
        renderer: state._areaRenderer,
        pane: 'areasPane',
        interactive: false,
      }));
    }
    if (part.eachLayer) part.eachLayer(visit);
  };
  visit(layer);
  fadeOutShape(map, shape);
}
export function syncAreasOnMap() {
  const group = state._areaGroup;
  if (!group) return;
  group.clearLayers();
  state._areaLayers = (state.areas || []).map(area => {
    const visited = !!area.visited || placesInArea(area.geometry, state.places || []).some(p => p.visited);
    return {
      area,
      visited,
      layer: L.geoJSON(area.geometry, {
        renderer: state._areaRenderer,
        pane: 'areasPane',
        className: 'area-shape',
        interactive: false,
        style: areaStyle(area, visited),
      }),
    };
  });
  applyAreaFilters();
  markAreasByRoute();
}
// A completed route also makes an area visited, but its track has to load
// first, so that answer lands after the map has drawn.
function markAreasByRoute() {
  const completed = manifestRoutes().filter(route => route.completed);
  for (const entry of state._areaLayers || []) {
    if (entry.visited) continue;
    routesInArea(entry.area, completed).then(function(routes) {
      if (!routes.length) return;
      entry.visited = true;
      entry.layer.setStyle(areaStyle(entry.area, true));
      applyAreaFilters();
    }, function() {});
  }
}
export function applyAreaFilters() {
  const group = state._areaGroup;
  if (!group) return;
  for (const { area, layer, visited } of state._areaLayers || []) {
    const show = placesEnabled()
      && !state.hiddenCategories.has(area.category)
      && (visited ? state.showVisited : state.showWant);
    if (show && !group.hasLayer(layer)) group.addLayer(layer);
    else if (!show && group.hasLayer(layer)) group.removeLayer(layer);
  }
  if (state._glRoutesDirty) state._glRoutesDirty();
  syncCountriesOnMap();
}

// The bbox is in the key so a replaced track gets read again.
const areaTouchCache = new Map();
function routeTouchesArea(area, route) {
  const key = area.id + '|' + route.file + '|' + route.bbox;
  let touch = areaTouchCache.get(key);
  if (!touch) {
    touch = fetchGpxText(gpxUrlFor(route.file))
      .then(text => tracksTouchArea(area.geometry, parseGpxTracks(text)));
    touch.catch(() => areaTouchCache.delete(key));
    areaTouchCache.set(key, touch);
  }
  return touch;
}
// The manifest bbox narrows the candidates, but only the track can answer,
// and it may not be loaded yet.
function routesInArea(area, routes) {
  const box = areaBbox(area.geometry);
  const candidates = routes.filter(route => !route.bbox || bboxesOverlap(box, route.bbox));
  return Promise.all(candidates.map(route => routeTouchesArea(area, route)))
    .then(touches => candidates.filter((_, i) => touches[i]));
}
/** @param {any} map @param {any} area @param {any} latlng */
function openAreaPopup(map, area, latlng) {
  const entry = (state._areaLayers || []).find(x => x.area.id === area.id);
  const byLabel = (x, y) => x.label.localeCompare(y.label);
  const places = placesInArea(area.geometry, state.places || [])
    .map(p => ({ label: p.name, done: p.visited, go: () => goToPlace(map, p) })).sort(byLabel);
  const routes = routesInArea(area, manifestRoutes()).then(found => found
    .map(r => ({ label: r.name, done: r.completed, route: true, go: () => goToRoute(map, r.key) })).sort(byLabel));
  /** @type {any} */
  let popup = null;
  const content = popupElement(html`<${AreaPopup} area=${area} visited=${entry ? entry.visited : !!area.visited}
    places=${places} routes=${routes}
    onEdit=${() => { map.closePopup(); openEditAreaModal(area); }}
    close=${() => map.closePopup()}
    relayout=${() => { if (popup && popup.isOpen()) popup.update(); }} />`);
  popup = L.popup({ closeButton: false }).setLatLng(latlng).setContent(content).openOn(map);
}
// Smallest first, so a park inside a county stays reachable.
export function openAreaPopupAt(map, e) {
  if (document.querySelector('.pick-coords-banner')) return;
  const cg = state._placeClusterGroup;
  if (cg && typeof cg._hitTest === 'function' && cg._hitTest(e.containerPoint)) return;
  const hits = (state._areaLayers || [])
    .filter(({ area, layer }) => state._areaGroup.hasLayer(layer)
      && layer.getBounds().contains(e.latlng)
      && areaContains(area.geometry, e.latlng.lng, e.latlng.lat))
    .map(x => x.area)
    .sort((a, b) => areaSize(a.geometry) - areaSize(b.geometry));
  if (hits.length) openAreaPopup(map, hits[0], e.latlng);
}
export function revealArea(map, id) {
  const entry = (state._areaLayers || []).find(x => x.area.id === id);
  if (!entry) return;
  const b = entry.layer.getBounds();
  if (!b.isValid()) return;
  map.fitBounds(b, { padding: [40, 40] });
  openAreaPopup(map, entry.area, b.getCenter());
}
