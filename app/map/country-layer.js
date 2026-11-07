import { state } from '../core.js';
import { countriesEnabled, loadCountryData, placeCountryCode } from '../countries.js';

// Visited countries as one fill under the areas, drawn from the places.
export function syncCountriesOnMap() {
  const group = state._countryGroup;
  if (!group) return;
  if (!countriesEnabled()) {
    group.clearLayers();
    group._key = null;
    return;
  }
  loadCountryData().then(({ shapes, names }) => {
    if (state._countryGroup !== group || !countriesEnabled()) return;
    const codes = new Set();
    for (const p of state.places || []) {
      if (!p.visited) continue;
      const code = placeCountryCode(p, names);
      if (code) codes.add(code);
    }
    const color = getComputedStyle(document.body).getPropertyValue('--completed').trim() || '#2ea043';
    const key = color + '|' + [...codes].sort().join(',');
    if (group._key === key) return;
    group._key = key;
    group.clearLayers();
    if (!codes.size) return;
    group.addLayer(L.geoJSON(shapes, {
      renderer: state._countryRenderer,
      pane: 'countriesPane',
      interactive: false,
      filter: f => codes.has(f.properties.code),
      // No outline: a fill scales with the pinch correctly, but an SVG stroke
      // thickens and shakes through it, and the GL layer that holds route and
      // area widths would have to carry every country's coast.
      style: { stroke: false, fillColor: color, fillOpacity: 0.28 },
    }));
  }).catch(err => console.warn('[ferd] visited countries:', err.message));
}
