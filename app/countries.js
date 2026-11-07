import { state } from './core.js';
import { featureVisible, placesEnabled } from './prefs.js';
import { _selectCoarsePointer } from './select.js';

// Visited countries: an opt-in fill under the areas for each country that
// holds a visited place. The boundaries (Natural Earth, about 650 KB
// gzipped) are fetched only once the layer is on; the service worker then
// keeps them like any other /vendor/ file. The country comes from the
// place's own country field, never from where its pin falls.
const COUNTRY_DATA_URL = '/vendor/natural-earth/';
export const COUNTRY_MAX_ZOOM = 6;
function countriesEnabled() { return placesEnabled() && featureVisible('countries'); }
// COUNTRY-MATCH-BEGIN
// Mirrors normalise_country_name in tools/ferd_api/places.py.
function normCountryName(name) {
  let s = String(name).normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/[.'\u2019]/g, '').replace(/,/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  return s.startsWith('the ') ? s.slice(4) : s;
}
// Aliases rank below every name match, so the rows read as names first,
// yet "Norge" or "USA" still find their country.
function countryMatches(query, countries, names) {
  const q = normCountryName(query);
  if (!q) return countries;
  const rank = new Map();
  const note = (code, r) => { if (!(rank.get(code) <= r)) rank.set(code, r); };
  if (names[q]) note(names[q], 0);
  for (const c of countries) {
    const n = normCountryName(c.name);
    if (n.startsWith(q)) note(c.code, 1);
    else if (n.includes(' ' + q)) note(c.code, 2);
    else if (n.includes(q)) note(c.code, 3);
  }
  for (const key in names) if (key.startsWith(q)) note(names[key], 4);
  return countries.filter(c => rank.has(c.code)).sort((a, b) => rank.get(a.code) - rank.get(b.code));
}
function canonicalCountry(value, countries, names) {
  const q = normCountryName(value);
  const hit = countries.find(c => c.code === names[q] || normCountryName(c.name) === q);
  return hit ? hit.name : null;
}
// COUNTRY-MATCH-END
function fetchCountryFile(f) {
  return fetch(COUNTRY_DATA_URL + f).then(r => {
    if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
    return r.json();
  });
}
function loadCountryPick() {
  if (!state._countryPick) {
    state._countryPick = Promise.all(['country-list.json', 'country-names.json'].map(fetchCountryFile))
      .then(([list, names]) => ({
        names,
        countries: Object.entries(list).map(([code, name]) => ({ code, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }));
    state._countryPick.catch(() => { state._countryPick = null; });
  }
  return state._countryPick;
}
// A field whose list cannot load stays plain text, since the server takes
// any country and a failed fetch must not block saving a place.
export function wireCountryPicker(id) {
  const input = document.getElementById(id);
  if (!input) return;
  loadCountryPick().then(pick => { if (input.isConnected) mountCountryPicker(input, pick); })
    .catch(err => console.warn('[ferd] country list:', err.message));
}
function mountCountryPicker(input, { countries, names }) {
  // An older place can hold a name off the list; it stays until replaced.
  let accepted = input.value.trim();
  let rows = [];
  let active = -1;
  const list = document.createElement('div');
  list.id = input.id + '-list';
  list.className = 'select-popover country-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.after(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  const setActive = i => {
    const els = list.querySelectorAll('[role="option"]');
    if (els[active]) els[active].classList.remove('active');
    active = i;
    if (els[i]) {
      els[i].classList.add('active');
      els[i].scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', els[i].id);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };
  const optionEl = (c, i, typed) => {
    const el = document.createElement('div');
    el.id = list.id + '-' + c.code;
    el.className = 'select-option';
    el.setAttribute('role', 'option');
    el.dataset.index = i;
    const at = typed ? c.name.toLowerCase().indexOf(typed) : -1;
    if (at < 0) {
      el.textContent = c.name;
    } else {
      const strong = document.createElement('strong');
      strong.textContent = c.name.slice(at, at + typed.length);
      el.append(c.name.slice(0, at), strong, c.name.slice(at + typed.length));
    }
    return el;
  };
  const render = browse => {
    const typed = input.value.trim().toLowerCase();
    rows = browse ? countries : countryMatches(input.value, countries, names);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    if (rows.length) {
      list.replaceChildren(...rows.map((c, i) => optionEl(c, i, rows === countries ? '' : typed)));
    } else {
      const none = document.createElement('div');
      none.className = 'select-option disabled';
      none.textContent = 'No matching country';
      list.replaceChildren(none);
    }
  };
  const open = browse => {
    const opening = list.hidden;
    render(browse);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (!_selectCoarsePointer) list.scrollIntoView({ block: 'nearest' });
    else if (opening) lift();
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const accept = name => {
    const changed = input.value !== name;
    input.value = name;
    accepted = name;
    if (changed) input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // Text that names no country reverts, so a form never holds an unlisted
  // name the user typed, and saving needs no extra check.
  const commit = () => {
    const typed = input.value.trim();
    if (typed === accepted) { input.value = accepted; return; }
    accept(typed ? canonicalCountry(typed, countries, names) ?? accepted : '');
  };
  // scrollIntoView would pan the whole page, map included, since a modal
  // is fixed to the viewport. Only the modal's own scroll moves here.
  const lift = () => {
    const modal = input.closest('.ui-dialog-body');
    modal.scrollTop += input.getBoundingClientRect().top - modal.getBoundingClientRect().top - 40;
  };
  input.addEventListener('focus', () => { if (_selectCoarsePointer) lift(); });
  // The browser's own focus pans the page to reveal a field the keyboard
  // will cover. Lifting the field first leaves it nothing to reveal.
  let touchY = 0;
  input.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
  input.addEventListener('touchend', e => {
    if (document.activeElement === input || Math.abs(e.changedTouches[0].clientY - touchY) > 10) return;
    e.preventDefault();
    input.focus({ preventScroll: true });
  });
  input.addEventListener('input', e => {
    if (!e.isTrusted) return;
    if (input.value.trim()) open(false);
    else close();
  });
  input.addEventListener('blur', () => { commit(); close(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // A saved name would filter the list down to itself; show every choice.
      if (list.hidden) open(input.value.trim() === accepted);
      if (rows.length) setActive((active + (e.key === 'ArrowDown' ? 1 : rows.length - 1 + (active < 0 ? 1 : 0))) % rows.length);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter') {
      // While the list is open Enter answers the list, not the form.
      if (!list.hidden) e.preventDefault();
      if (!list.hidden && rows[active]) accept(rows[active].name);
      else commit();
      close();
    }
  });
  // Keeps focus in the input, so a tap on a row is not a blur first.
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => {
    const el = e.target.closest('[role="option"]');
    if (!el) return;
    accept(rows[Number(el.dataset.index)].name);
    close();
  });
  if (document.activeElement === input && input.value.trim()) open(false);
}
function loadCountryData() {
  if (!state._countryData) {
    state._countryData = Promise.all(['countries.geo.json', 'country-names.json'].map(fetchCountryFile))
      .then(([shapes, names]) => ({ shapes, names }));
    state._countryData.catch(() => { state._countryData = null; });
  }
  return state._countryData;
}
// The server stores country_code; the name lookup covers local mode and
// edits still queued offline, which have not been through the server.
function placeCountryCode(p, names) {
  return p.country_code || (p.country ? names[normCountryName(p.country)] : null) || null;
}
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
