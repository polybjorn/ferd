import { displayCategory, escapeHtml, sortedCategorySlugs, state } from './core.js';
import { gpxUrlFor, popupEditHtml } from './server.js';
import { dataLayer } from './offline-queue.js';
import {
  areaBbox, areaContains, areaSize, areaStatText, bboxesOverlap, placesInArea, tracksTouchArea,
} from './area-geo.js';
import { readSelectOrNew, selectOrNewHtml, wireSelectOrNew } from './form-fields.js';
import { getShowField, placesEnabled } from './prefs.js';
import { fetchGpxText } from './route-layer.js';
import { popupCategoryHtml, refreshPlacesPresentation } from './map-popups.js';
import { COUNTRY_MAX_ZOOM, syncCountriesOnMap } from './countries.js';
import { goToPlace, goToRoute } from './map-actions.js';
import { parseGpxTracks } from './route-detail.js';
import {
  modalErrorHtml, modalHeaderHtml, openConfirmModal, refreshAreas, uiFieldHtml, uiToggleHtml,
} from './select.js';
import { closeModal, openModal, showModalError } from './modal.js';

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
export function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
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

function areaStatusHtml(visited) {
  return '<span class="popup-area-status" style="grid-column:3">' + (visited ? 'Visited' : 'Want to visit') + '</span>';
}
function areaPopupHtml(a, visited) {
  const local = getShowField('local-name') && a.local_name
    ? ' <span class="popup-local">' + escapeHtml(a.local_name) + '</span>' : '';
  let html = '<div class="popup-name">' + escapeHtml(a.name) + local + '</div>';
  if (a.note && getShowField('note')) html += '<div class="popup-note">' + escapeHtml(a.note) + '</div>';
  html += '<div class="popup-area-counts"><span class="popup-area-places"></span><span class="popup-area-routes">Counting routes&hellip;</span></div>' +
    '<div class="popup-area-list" hidden></div>' +
    '<div class="popup-meta">' +
      popupCategoryHtml(a.category) +
      popupEditHtml() +
      areaStatusHtml(visited) +
    '</div>';
  return html;
}
export function manifestRoutes() {
  return ((state.manifest && state.manifest.regions) || []).flatMap(region => region.routes);
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
function openAreaPopup(map, area, latlng) {
  const entry = (state._areaLayers || []).find(x => x.area.id === area.id);
  // An element, not a string: update() would rewrite a string from scratch,
  // dropping the route count and the listeners.
  const content = document.createElement('div');
  content.innerHTML = areaPopupHtml(area, entry ? entry.visited : !!area.visited);
  const popup = L.popup({ closeButton: false }).setLatLng(latlng).setContent(content).openOn(map);
  const edit = content.querySelector('.popup-edit');
  if (edit) edit.addEventListener('click', function() { map.closePopup(); openEditAreaModal(area); });
  const list = content.querySelector('.popup-area-list');
  // Items are {label, done, go}. No items leaves plain text: nothing to open.
  const fillCount = function(slot, text, items) {
    if (!items.length) { slot.textContent = text; return; }
    const count = document.createElement('button');
    count.type = 'button';
    count.className = 'popup-area-count';
    count.textContent = text;
    count.setAttribute('aria-expanded', 'false');
    count.addEventListener('click', function() {
      const open = count.getAttribute('aria-expanded') !== 'true';
      content.querySelectorAll('.popup-area-count').forEach(b => b.setAttribute('aria-expanded', 'false'));
      count.setAttribute('aria-expanded', String(open));
      list.hidden = !open;
      list.replaceChildren(...(open ? items.map(areaListItem) : []));
      popup.update();
    });
    slot.replaceChildren(count);
  };
  const areaListItem = function(item) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'popup-area-item' + (item.route ? ' route' : '') + (item.done ? ' done' : '');
    row.textContent = item.label;
    row.addEventListener('click', function(e) {
      // Closing detaches the popup, and Leaflet would take this for a map click.
      e.stopPropagation();
      map.closePopup();
      item.go();
    });
    return row;
  };
  const byLabel = (x, y) => x.label.localeCompare(y.label);
  const places = placesInArea(area.geometry, state.places || []);
  fillCount(content.querySelector('.popup-area-places'),
    areaStatText(places.length, 'place', places.filter(p => p.visited).length, 'visited'),
    places.map(p => ({ label: p.name, done: p.visited, go: () => goToPlace(map, p) })).sort(byLabel));
  popup.update();
  const routesSlot = content.querySelector('.popup-area-routes');
  routesInArea(area, manifestRoutes()).then(function(routes) {
    const completed = routes.filter(r => r.completed);
    fillCount(routesSlot, areaStatText(routes.length, 'route', completed.length, 'completed'),
      routes.map(r => ({ label: r.name, done: r.completed, route: true, go: () => goToRoute(map, r.key) })).sort(byLabel));
    if (completed.length) content.querySelector('.popup-area-status').outerHTML = areaStatusHtml(true);
  }, function() {
    // An unreadable track, typically offline: a partial count would read as the real one.
    routesSlot.remove();
  }).then(function() { if (popup.isOpen()) popup.update(); });
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
// The fields the Add and Edit forms share, read from the given id prefix.
export function readAreaFormFields(prefix) {
  const payload = { visited: document.getElementById(prefix + '-visited').checked };
  const category = readSelectOrNew(prefix + '-category');
  if (category) payload.category = category;
  const noteEl = document.getElementById(prefix + '-note');
  const note = noteEl ? noteEl.value.trim() : '';
  if (note) payload.note = note;
  return payload;
}
// Settings > Optional fields can leave the input out of the form, and a
// save replaces the whole area, so `kept` is what survives it.
export function readAreaLocalName(prefix, kept) {
  const el = document.getElementById(prefix + '-local-name');
  return el ? el.value.trim() : (kept || '');
}
function areaLocalNameHtml(prefix, value) {
  return getShowField('local-name') ?
    uiFieldHtml(prefix + '-local-name', 'Local name',
      '<input type="text" id="' + prefix + '-local-name" maxlength="200" placeholder="In the local language" value="' + escapeHtml(value || '') + '">')
  : '';
}
function areaFieldsHtml(prefix, area) {
  const cats = sortedCategorySlugs(Object.keys(state.categoryColors).filter(c => c !== ''));
  return uiFieldHtml(prefix + '-category', 'Category',
      selectOrNewHtml(prefix + '-category', cats, (area && area.category) || null, displayCategory, '', 'New category name')) +
    (getShowField('note') ?
      uiFieldHtml(prefix + '-note', 'Note',
        '<textarea id="' + prefix + '-note">' + escapeHtml((area && area.note) || '') + '</textarea>')
    : '') +
    '<div>' +
      uiToggleHtml(prefix + '-visited', 'I&rsquo;ve visited this area', { checked: area && area.visited }) +
      '<p class="ui-hint">A visited place or completed route inside also makes it visited.</p>' +
    '</div>';
}
function openEditAreaModal(area) {
  openModal(
    modalHeaderHtml('Edit area') +
    '<form id="edit-area-form">' +
      '<div class="ui-section">' +
        uiFieldHtml('ea-name', 'Name',
          '<input type="text" id="ea-name" required maxlength="200" value="' + escapeHtml(area.name) + '">', { required: true }) +
        areaLocalNameHtml('ea', area.local_name) +
        areaFieldsHtml('ea', area) +
      '</div>' +
      modalErrorHtml('edit-area-error') +
      '<div class="ui-dialog-actions">' +
        '<button type="button" class="ui-button ui-button-danger" id="ea-delete">Delete</button>' +
        '<span class="action-spacer"></span>' +
        '<button type="submit" class="ui-button ui-button-primary" id="ea-submit">Save</button>' +
      '</div>' +
    '</form>',
    function() {
      wireSelectOrNew('ea-category');
      const done = () => refreshAreas().then(() => { closeModal(); refreshPlacesPresentation(); });
      document.getElementById('ea-delete').addEventListener('click', function() {
        const btn = this;
        openConfirmModal({ title: 'Delete area?', body: 'Delete "' + area.name + '"?', confirmLabel: 'Delete', danger: true }).then(ok => {
          if (!ok) return;
          btn.disabled = true;
          const entry = (state._areaLayers || []).find(x => x.area.id === area.id);
          const shown = entry && state._areaGroup.hasLayer(entry.layer);
          dataLayer.deleteArea({ id: area.id }).then(
            () => {
              closeModal();
              return refreshAreas().then(() => {
                if (shown) fadeOutArea(area, entry.visited);
                refreshPlacesPresentation();
              }).catch(err => alert('Failed: ' + err.message));
            },
            err => { btn.disabled = false; showModalError(err.message); }
          );
        });
      });
      document.getElementById('edit-area-form').addEventListener('submit', function(e) {
        e.preventDefault();
        const payload = Object.assign(readAreaFormFields('ea'), {
          name: document.getElementById('ea-name').value.trim(),
          geometry: area.geometry,
        });
        // A note hidden via Settings > Optional fields isn't in the form,
        // and a save replaces the whole area.
        if (!getShowField('note') && area.note) payload.note = area.note;
        const local = readAreaLocalName('ea', area.local_name);
        if (local) payload.local_name = local;
        if (area.source) payload.source = area.source;
        const submit = document.getElementById('ea-submit');
        submit.disabled = true;
        dataLayer.updateArea({ id: area.id, area: payload }).then(done)
          .catch(err => { submit.disabled = false; showModalError(err.message); });
      });
    }
  );
}
