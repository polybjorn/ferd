import { GPX_NS, addButtonHtml, escapeHtml, setActiveTab, setCrumb, state } from './core.js';
import { gpxUrlFor, isReadOnly } from './server.js';
import { wireFilterPopover, wirePopover } from './map-panel.js';
import {
  getPref, getShowField, placesEnabled, routesEnabled, setPref, setResultCount,
} from './prefs.js';
import { cleanupMap } from './map-layers.js';
import { fetchGpxText } from './route-layer.js';
import { findRouteByKey, openEditTrailMetadataModal, ratingStarsText } from './route-meta.js';
import { openEditPlaceModal } from './edit-place.js';
import { deletePlaceItem, deleteRouteItem } from './map-actions.js';
import { NAME_COLLATOR, findCatalogUpdate, openCatalogUpdateModal } from './places-list.js';
import { focusHash } from './router.js';
import { attachContextMenu } from './context-menu.js';
import { enhanceSelectsIn } from './select.js';
import { openAddModal } from './add.js';

export function renderHistoryIndex() {
  setActiveTab('history');
  setCrumb('History');
  cleanupMap();
  const app = document.getElementById('app');
  const wantPlaces = placesEnabled();
  const wantRoutes = routesEnabled();
  if ((wantPlaces && !state.places) || (wantRoutes && !state.manifest)) {
    app.innerHTML = '<div class="loading">Loading history...</div>';
    return;
  }

  const all = [];
  if (wantPlaces) {
    for (const p of (state.places || [])) {
      if (!p.visited) continue;
      all.push({
        kind: 'place',
        date: p.date_visited || '',
        name: p.name,
        image: p.image || '',
        image_focus: p.image_focus,
        note: p.note || '',
        rating: p.rating,
        href: focusHash('place', p._slug || p.name),
        place: p,
      });
    }
  }
  if (wantRoutes && state.manifest) {
    for (const region of state.manifest.regions) {
      for (const r of region.routes) {
        if (!r.completed) continue;
        all.push({
          kind: 'route',
          date: r.date_completed || '',
          name: r.name,
          image: '',
          note: r.notes || '',
          rating: r.rating,
          href: '#/routes/route/' + encodeURIComponent(r.key),
          route: r,
          region: region.name,
        });
      }
    }
  }

  if (!all.length) {
    app.innerHTML = '<div class="history-list"><div class="loading">No visited places or completed routes yet.</div></div>';
    return;
  }

  const years = [...new Set(all.filter(e => e.date).map(e => e.date.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const hasUndated = all.some(e => !e.date);
  const hf = state.historyFilters;

  app.innerHTML =
    '<h1 class="view-title">History</h1>' +
    '<div class="index-controls">' +
    '<div class="search-wrap"><input type="text" id="hist-search" placeholder="Filter history..." value="' + escapeHtml(hf.search) + '"><span class="result-count" id="result-count"></span></div>' +
    '<div class="filter-dropdown">' +
      '<button type="button" class="filter-btn" id="hist-filter-btn" aria-haspopup="true" aria-expanded="false">Filters</button>' +
      '<div class="filter-popover" id="hist-filter-popover" hidden>' +
        ((wantPlaces && wantRoutes) ?
          '<select id="hist-filter-kind">' +
            '<option value="all">Type</option>' +
            '<option value="place"' + (hf.kind === 'place' ? ' selected' : '') + '>Places</option>' +
            '<option value="route"' + (hf.kind === 'route' ? ' selected' : '') + '>Routes</option>' +
          '</select>'
          : '') +
        '<select id="hist-filter-year">' +
          '<option value="all">Year</option>' +
          years.map(y => '<option value="' + y + '"' + (hf.year === y ? ' selected' : '') + '>' + y + '</option>').join('') +
          (hasUndated ? '<option value="none"' + (hf.year === 'none' ? ' selected' : '') + '>No date</option>' : '') +
        '</select>' +
        '<select id="hist-filter-rating">' +
          '<option value="all">Rating</option>' +
          ['unrated','1','2','3','4','5'].map(v => '<option value="' + v + '"' + (hf.rating === v ? ' selected' : '') + '>' + (v === 'unrated' ? 'Unrated' : (v + ' star' + (v === '1' ? '' : 's'))) + '</option>').join('') +
        '</select>' +
        '<button type="button" class="filter-clear" id="hist-filter-clear">Clear filters</button>' +
      '</div>' +
    '</div>' +
    '<div class="filter-dropdown">' +
      '<button type="button" class="filter-btn" id="hist-view-btn" aria-haspopup="true" aria-expanded="false">View</button>' +
      '<div class="filter-popover" id="hist-view-popover" hidden>' +
        ['compact', 'gallery'].map(v =>
          '<button type="button" class="view-option' + (getHistoryView() === v ? ' active' : '') + '" data-view="' + v + '">' +
            (v === 'compact' ? 'Compact' : 'Gallery') +
          '</button>'
        ).join('') +
      '</div>' +
    '</div>' +
    '</div>' +
    '<div id="history-mount"></div>';
  enhanceSelectsIn(document.querySelector('.index-controls'));

  // Add action in the nav (left of Menu), matching the other pages.
  const navActionsEl = document.getElementById('nav-actions');
  if (navActionsEl && state.auth.authenticated && !isReadOnly() && (placesEnabled() || routesEnabled())) {
    const title = placesEnabled() && routesEnabled()
      ? 'Add place or route'
      : (placesEnabled() ? 'Add place' : 'Add route');
    navActionsEl.innerHTML = addButtonHtml('hist-add-btn', title);
    document.getElementById('hist-add-btn').addEventListener('click', function() { openAddModal(null); });
  }

  const showImage = getShowField('image');
  const showNote = getShowField('note');
  const showRating = getShowField('rating');
  const showDate = getShowField('date');
  const FOCUS_RE = /^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$/;
  const canEdit = !isReadOnly() && state.auth && state.auth.authenticated;

  function entryHtml(e) {
    let inner = '';
    if (e.kind === 'place' && e.image && showImage) {
      const focus = typeof e.image_focus === 'string' && FOCUS_RE.test(e.image_focus.trim()) ? e.image_focus.trim() : '';
      const styleAttr = focus ? ' style="object-position:' + focus + '"' : '';
      inner += '<img class="history-image" src="' + escapeHtml(e.image) + '" alt=""' + styleAttr + ' loading="lazy" decoding="async" fetchpriority="low" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">';
    } else if (e.kind === 'route' && e.route) {
      // Routes have no photo; draw the GPX track silhouette, like the Routes list.
      inner += '<canvas class="history-image route-thumb" data-route-key="' + escapeHtml(e.route.key) + '"></canvas>';
    } else {
      // No media: reserve the thumbnail's width (compact only) so the body
      // text lines up with entries that do have one.
      inner += '<div class="history-image-spacer"></div>';
    }
    inner += '<div class="history-body">';
    inner += '<div class="history-head">' +
      '<span class="history-name">' + escapeHtml(e.name) + '</span>' +
      '<span class="history-kind">' + (e.kind === 'place' ? 'Place' : 'Route') + '</span>' +
      '</div>';
    const metaBits = [];
    if (e.date && showDate) metaBits.push('<span>' + escapeHtml(e.date) + '</span>');
    if (e.rating && showRating) metaBits.push('<span class="history-stars" title="' + e.rating + '/5">' + ratingStarsText(e.rating) + '</span>');
    if (metaBits.length) inner += '<div class="history-meta">' + metaBits.join('') + '</div>';
    if (e.note && showNote) inner += '<div class="history-note">' + escapeHtml(e.note) + '</div>';
    inner += '</div>';
    const href = e.href.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return '<div class="history-card" data-idx="' + e._idx + '" onclick="location.hash=\'' + href + '\'">' + inner + '</div>';
  }

  // Builds the right-click / long-press menu for one entry, mirroring the
  // Places and Routes list cards. Delete refreshes state, then repaints.
  function menuFor(e) {
    const items = [];
    if (e.kind === 'place') {
      const place = e.place;
      items.push({ label: 'Open on map', onClick: function() { location.hash = '#/?focus=place:' + encodeURIComponent(place.name); } });
      if (Array.isArray(place.sources) && place.sources.length) {
        items.push({ label: 'Open source', onClick: function() { window.open(place.sources[0], '_blank', 'noopener'); } });
      }
      if (canEdit) items.push({ label: 'Edit', onClick: function() { openEditPlaceModal(place); } });
      if (place.from_catalog && findCatalogUpdate(place)) {
        items.push({ label: 'Apply catalog update', onClick: function() { openCatalogUpdateModal(place); } });
      }
      if (canEdit) {
        items.push(null);
        items.push({ label: 'Delete', danger: true, onClick: function() {
          deletePlaceItem(place, { after: renderHistoryIndex });
        }});
      }
    } else {
      const route = e.route;
      const regionName = e.region;
      items.push({ label: 'Open on map', onClick: function() { location.hash = '#/?focus=route:' + encodeURIComponent(route.key); } });
      items.push({ label: 'Open detail', onClick: function() { location.hash = '#/routes/route/' + encodeURIComponent(route.key); } });
      if (route.source) {
        items.push({ label: 'Open source', onClick: function() { window.open(route.source, '_blank', 'noopener'); } });
      }
      if (canEdit) items.push({ label: 'Edit', onClick: function() { openEditTrailMetadataModal(route, regionName); } });
      if (canEdit) {
        items.push(null);
        items.push({ label: 'Delete', danger: true, onClick: function() {
          deleteRouteItem(route, regionName, renderHistoryIndex);
        }});
      }
    }
    return items;
  }

  const mount = document.getElementById('history-mount');
  function paint() {
    const q = hf.search.trim().toLowerCase();
    const filtered = all.filter(e => {
      if (q && !e.name.toLowerCase().includes(q) && !(e.note && e.note.toLowerCase().includes(q))) return false;
      if (hf.kind !== 'all' && e.kind !== hf.kind) return false;
      if (hf.year === 'none' && e.date) return false;
      if (hf.year !== 'all' && hf.year !== 'none' && e.date.slice(0, 4) !== hf.year) return false;
      if (hf.rating === 'unrated' && e.rating) return false;
      if (hf.rating !== 'all' && hf.rating !== 'unrated' && String(e.rating || '') !== hf.rating) return false;
      return true;
    });
    const dated = filtered.filter(e => e.date).sort((a, b) => b.date.localeCompare(a.date));
    const undated = filtered.filter(e => !e.date).sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
    const groups = [];
    let curYear = null;
    for (const e of dated) {
      const year = e.date.slice(0, 4);
      if (year !== curYear) { groups.push({ label: year, items: [] }); curYear = year; }
      groups[groups.length - 1].items.push(e);
    }
    if (undated.length) groups.push({ label: 'No date', items: undated });
    // Flatten in render order so context-menu handlers find their entry by
    // the card's data-idx.
    const flat = groups.flatMap(g => g.items);
    flat.forEach((e, i) => { e._idx = i; });
    setResultCount(flat.length);

    if (!groups.length) {
      mount.innerHTML = '<div class="history-list"><div class="loading">No matching history.</div></div>';
      return;
    }
    let html = '<div class="history-list ' + getHistoryView() + '">';
    for (const g of groups) {
      html += '<div class="history-group fade-in">' +
        '<div class="history-year">' + escapeHtml(g.label) + '</div>' +
        '<div class="history-cards">' + g.items.map(entryHtml).join('') + '</div>' +
        '</div>';
    }
    html += '</div>';
    mount.innerHTML = html;
    mount.querySelectorAll('canvas.route-thumb').forEach(function(canvas) {
      const found = findRouteByKey(canvas.dataset.routeKey);
      if (found) drawRouteSilhouette(canvas, found.route);
    });
    mount.querySelectorAll('.history-card').forEach(function(card) {
      attachContextMenu(card, function() {
        const e = flat[+card.dataset.idx];
        return e ? menuFor(e) : [];
      });
    });
  }

  const searchInput = document.getElementById('hist-search');
  const kindSel = document.getElementById('hist-filter-kind');
  const yearSel = document.getElementById('hist-filter-year');
  const ratingSel = document.getElementById('hist-filter-rating');
  const filterBtn = document.getElementById('hist-filter-btn');
  const filterPop = document.getElementById('hist-filter-popover');
  const filterClear = document.getElementById('hist-filter-clear');
  const viewBtn = document.getElementById('hist-view-btn');
  const viewPop = document.getElementById('hist-view-popover');
  const filterSels = [kindSel, yearSel, ratingSel].filter(Boolean);
  wirePopover(viewBtn, viewPop);
  viewPop.querySelectorAll('.view-option').forEach(opt => opt.addEventListener('click', function() {
    const v = this.dataset.view;
    setPref('history-view', v);
    viewPop.querySelectorAll('.view-option').forEach(o => o.classList.toggle('active', o === this));
    viewPop.hidden = true;
    viewBtn.setAttribute('aria-expanded', 'false');
    paint();
  }));
  wireFilterPopover({
    btn: filterBtn, pop: filterPop, clear: filterClear, sels: filterSels,
    keyById: { 'hist-filter-kind': 'kind', 'hist-filter-year': 'year', 'hist-filter-rating': 'rating' },
    filters: hf, searchInput: searchInput, searchKey: 'search', onApply: paint,
  });
  const viewSel = document.getElementById('hist-view-select');
  if (viewSel) viewSel.addEventListener('change', function() { setPref('history-view', this.value); paint(); });
  paint();
}

function getHistoryView() {
  return getPref('history-view', 'compact') === 'gallery' ? 'gallery' : 'compact';
}

// Layout for the Places/Routes lists: 'grid' (multi-column cards, default),
// 'compact' (single-column cards), or 'gallery' (single column, media on
// top). kind is 'places' or 'routes'.
export function listView(kind) {
  const v = getPref(kind + '-view', 'grid');
  return (v === 'compact' || v === 'gallery') ? v : 'grid';
}
const LIST_VIEW_OPTIONS = [['grid', 'Grid'], ['compact', 'Compact'], ['gallery', 'Gallery']];
export function listViewPopoverHtml(kind) {
  const cur = listView(kind);
  return '<div class="filter-dropdown">' +
    '<button type="button" class="filter-btn" id="view-btn" aria-haspopup="true" aria-expanded="false">View</button>' +
    '<div class="filter-popover" id="view-popover" hidden>' +
      LIST_VIEW_OPTIONS.map(o =>
        '<button type="button" class="view-option' + (cur === o[0] ? ' active' : '') + '" data-view="' + o[0] + '">' + o[1] + '</button>'
      ).join('') +
    '</div>' +
  '</div>';
}
// Wire the View popover: toggle open/close (mutually exclusive with other
// overlays) and apply a chosen view. onApply repaints the list.
export function wireListViewPopover(kind, onApply) {
  const btn = document.getElementById('view-btn');
  const pop = document.getElementById('view-popover');
  if (!btn || !pop) return;
  wirePopover(btn, pop);
  pop.querySelectorAll('.view-option').forEach(opt => opt.addEventListener('click', function() {
    const v = this.dataset.view;
    setPref(kind + '-view', v);
    pop.querySelectorAll('.view-option').forEach(o => o.classList.toggle('active', o === this));
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    onApply();
  }));
}

// Split a GPX into separate point arrays, one per track segment (and per
// track when a track has no <trkseg>). Keeping segments apart stops the
// silhouette from drawing a straight line between disjoint paths.
function gpxSegments(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const tags = function(parent, name) {
    let els = parent.getElementsByTagNameNS(GPX_NS, name);
    if (!els.length) els = parent.getElementsByTagName(name);
    return els;
  };
  const readPts = function(parent) {
    const arr = [];
    const pts = tags(parent, 'trkpt');
    for (let i = 0; i < pts.length; i++) {
      const lat = parseFloat(pts[i].getAttribute('lat'));
      const lon = parseFloat(pts[i].getAttribute('lon'));
      if (isFinite(lat) && isFinite(lon)) arr.push({ lat, lon });
    }
    return arr;
  };
  const segments = [];
  const trks = tags(doc, 'trk');
  for (let i = 0; i < trks.length; i++) {
    const segs = tags(trks[i], 'trkseg');
    if (segs.length) {
      for (let j = 0; j < segs.length; j++) {
        const arr = readPts(segs[j]);
        if (arr.length) segments.push(arr);
      }
    } else {
      const arr = readPts(trks[i]);
      if (arr.length) segments.push(arr);
    }
  }
  return segments;
}

// Shared silhouette renderer: draw a route's GPX track shape onto a canvas,
// normalized to fill the box with padding. Each segment is its own subpath.
export function drawRouteSilhouette(canvas, route) {
  if (!canvas || !route || !route.file) return;
  fetchGpxText(gpxUrlFor(route.file)).then(function(text) {
    const segments = gpxSegments(text);
    const allPts = segments.flat();
    if (allPts.length < 2) return;
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue('--accent').trim() || '#88c0d0';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 240, h = canvas.clientHeight || 135;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of allPts) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    const lonScale = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
    // Correct for longitude convergence so the shape isn't stretched E-W.
    const latSpan = Math.max(maxLat - minLat, 1e-6);
    const lonSpan = Math.max((maxLon - minLon) * lonScale, 1e-6);
    const pad = 10;
    const scale = Math.min((w - 2 * pad) / lonSpan, (h - 2 * pad) / latSpan);
    const offX = (w - lonSpan * scale) / 2, offY = (h - latSpan * scale) / 2;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const seg of segments) {
      seg.forEach(function(p, i) {
        const x = offX + (p.lon - minLon) * lonScale * scale;
        const y = offY + (maxLat - p.lat) * scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
    }
    ctx.stroke();
  }).catch(function() { /* leave the empty box */ });
}
