import { escapeHtml } from './core.js';
import { parseTagInput } from './tags.js';

// Raise the map's minimum zoom to the smallest level whose Web Mercator
// world (a 256*2^z px square) still covers the larger viewport dimension,
// so the map can never zoom out into the empty background (the dark bands
// above/below the world on tall screens). Re-run on resize/rotation.
export function applyCoverMinZoom(map) {
  const size = map.getSize();
  const px = Math.max(size.x, size.y);
  if (!px) return;
  const cover = Math.max(0, Math.ceil(Math.log2(px / 256)));
  if (map.getMinZoom() !== cover) {
    map.setMinZoom(cover); // clamps the current zoom up if it was below.
  }
}

// Pill-style radio group: each option renders as a single-select pill.
export function radioPillsHtml(name, options, selected, variant) {
  return '<div class="radio-row ' + (variant || 'radio-pills') + '">' +
    options.map(([v, l]) =>
      '<label><input type="radio" name="' + name + '" value="' + v + '"' + (selected === v ? ' checked' : '') + '>' + l + '</label>'
    ).join('') + '</div>';
}

// Clickable 1-5 star widget. Reads/writes value via dataset on the wrapper.
export function starRatingHtml(name, current) {
  const val = current ? String(current) : '';
  let html = '<div class="star-rating" data-name="' + name + '" data-value="' + escapeHtml(val) + '">';
  for (let i = 1; i <= 5; i++) {
    const filled = current && i <= current;
    // ★ for filled, ☆ for empty — distinct glyphs make the state obvious
    // regardless of color contrast in the active theme.
    html += '<span class="star' + (filled ? ' filled' : '') + '" data-v="' + i + '">' + (filled ? '&#9733;' : '&#9734;') + '</span>';
  }
  html += '<a href="#" class="star-clear">clear</a>';
  html += '</div>';
  return html;
}
export function wireStarRating(name) {
  const wrap = document.querySelector('.star-rating[data-name="' + name + '"]');
  if (!wrap) return;
  const stars = wrap.querySelectorAll('.star');
  const FILLED = '★';
  const EMPTY = '☆';
  // Set both class and glyph so the state is unmistakable.
  const setStar = (s, on, preview) => {
    s.classList.toggle('filled', on && !preview);
    s.classList.toggle('preview', !!preview);
    s.innerHTML = (on || preview) ? FILLED : EMPTY;
  };
  const paint = (n, preview) => stars.forEach(s => {
    setStar(s, !preview && (+s.dataset.v) <= n, preview && (+s.dataset.v) <= n);
  });
  const repaint = () => {
    const cur = parseInt(wrap.dataset.value, 10) || 0;
    stars.forEach(s => setStar(s, (+s.dataset.v) <= cur, false));
  };
  stars.forEach(star => {
    star.addEventListener('mouseenter', function() { paint(+this.dataset.v, true); });
    star.addEventListener('mouseleave', repaint);
    star.addEventListener('click', function() {
      const v = +this.dataset.v;
      wrap.dataset.value = (wrap.dataset.value == String(v) ? '' : String(v));
      repaint();
    });
  });
  const clear = wrap.querySelector('.star-clear');
  if (clear) clear.addEventListener('click', function(e) {
    e.preventDefault();
    wrap.dataset.value = '';
    repaint();
  });
}
export function readStarRating(name) {
  const wrap = document.querySelector('.star-rating[data-name="' + name + '"]');
  return wrap ? wrap.dataset.value : '';
}

export function selectOrNewHtml(id, options, current, labelFn, emptyLabel, newPlaceholder) {
  const labelOf = labelFn || (v => v);
  // When emptyLabel is set, an empty-string option is allowed at the top
  // and `required` is dropped from the select (the field is optional).
  const hasEmpty = emptyLabel != null;
  const isEmpty = current == null || current === '';
  const inList = !isEmpty && options.includes(current);
  const opts = options.map(v =>
    '<option value="' + escapeHtml(v) + '"' + (v === current ? ' selected' : '') + '>' + escapeHtml(labelOf(v)) + '</option>'
  ).join('');
  const newSelected = (!isEmpty && !inList) ? ' selected' : '';
  const inputValue = (!isEmpty && !inList) ? escapeHtml(current) : '';
  const inputHidden = isEmpty || inList;
  // The empty option exists so "no selection" is a valid state, but it's
  // hidden from the dropdown list — the select just shows blank when it's
  // selected. Picking a real option replaces the placeholder.
  const emptyOpt = hasEmpty
    ? '<option value="" hidden' + (isEmpty ? ' selected' : '') + '>' + escapeHtml(emptyLabel) + '</option>'
    : '';
  const requiredAttr = hasEmpty ? '' : ' required';
  return '<div class="select-or-new" data-id="' + id + '">' +
    '<select id="' + id + '"' + requiredAttr + '>' + emptyOpt + opts +
      '<option value="__new__"' + newSelected + '>+ Add new</option>' +
    '</select>' +
    '<input type="text" class="new-input" id="' + id + '-new" placeholder="' + escapeHtml(newPlaceholder || 'New value') + '" value="' + inputValue + '"' + (inputHidden ? ' hidden' : '') + '>' +
  '</div>';
}

export function wireSelectOrNew(id) {
  const sel = document.getElementById(id);
  const input = document.getElementById(id + '-new');
  if (!sel || !input) return;
  const sync = () => {
    input.hidden = sel.value !== '__new__';
    input.required = sel.value === '__new__';
  };
  sel.addEventListener('change', sync);
  sync();
}

export function readSelectOrNew(id) {
  const sel = document.getElementById(id);
  const input = document.getElementById(id + '-new');
  if (!sel) return '';
  if (sel.value === '__new__') return (input.value || '').trim();
  return sel.value;
}

export function readPlaceFormFields(prefix) {
  const $ = id => document.getElementById(prefix + '-' + id);
  const val = id => { const el = $(id); return el ? el.value : ''; };
  const category = readSelectOrNew(prefix + '-category');
  const sourcesRaw = val('sources').trim();
  const sources = sourcesRaw ? sourcesRaw.split('\n').map(s => s.trim()).filter(Boolean) : null;
  const tags = parseTagInput(val('tags'));
  const rawLat = parseFloat(val('lat'));
  const rawLon = parseFloat(val('lon'));
  if (Number.isNaN(rawLat) || Number.isNaN(rawLon)) {
    return { error: 'Pick a location on the map (or enter coordinates manually).' };
  }
  // Round to 5 decimals (~1 m). Anything beyond is JS float noise and
  // pollutes the stored JSON; the marker is a 30-px dot anyway.
  const lat = Math.round(rawLat * 1e5) / 1e5;
  const lon = Math.round(rawLon * 1e5) / 1e5;
  const payload = {
    name: val('name').trim(),
    lat,
    lon,
    visited: $('visited').checked,
  };
  if (category) payload.category = category;
  const country = val('country').trim();
  const note = val('note').trim();
  const localName = val('local-name').trim();
  const image = val('image').trim();
  const dateVisited = val('date-visited').trim();
  const ratingRaw = readStarRating(prefix + '-rating');
  if (country) payload.country = country;
  if (note) payload.note = note;
  if (localName) payload.local_name = localName;
  if (image) payload.image = image;
  if (sources && sources.length) payload.sources = sources;
  if (tags) payload.tags = tags;
  // Visit-only metadata: ignore if the visited toggle is off.
  if (payload.visited) {
    if (dateVisited) payload.date_visited = dateVisited;
    if (ratingRaw) payload.rating = parseInt(ratingRaw, 10);
  }
  return { payload };
}

// Read the route-metadata fields shared by the route editor and GPX upload
// (source/notes/local_name/difficulty/tags) from a form by id prefix.
// date_completed/rating are caller-specific (the editor always reads them,
// GPX upload only when "completed"), so they stay at the call sites.
export function readRouteMetaFields(prefix) {
  const get = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const metadata = {};
  const source = get(prefix + '-source').trim();
  const notes = get(prefix + '-notes');
  const localName = get(prefix + '-local-name').trim();
  const difficulty = (document.querySelector('input[name="' + prefix + '-difficulty"]:checked') || {}).value || '';
  const tags = parseTagInput(get(prefix + '-tags'));
  if (source) metadata.source = source;
  if (notes.trim()) metadata.notes = notes;
  if (localName) metadata.local_name = localName;
  if (difficulty) metadata.difficulty = difficulty;
  if (tags) metadata.tags = tags;
  return metadata;
}
