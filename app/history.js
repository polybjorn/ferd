import { GPX_NS, setActiveTab, setCrumb, state } from './core.js';
import { gpxUrlFor, isReadOnly } from './server.js';
import { places, routes } from './store.js';
import { cleanupMap, deletePlaceItem, deleteRouteItem, fetchGpxText } from './map/index.js';
import { getPref, getShowField, placesEnabled, routesEnabled } from './prefs.js';
import { openEditTrailMetadataModal, ratingStars } from './routes/route-meta.js';
import { openEditPlaceModal } from './places/edit-place.js';
import { nameCollator, findCatalogUpdate, openCatalogUpdateModal } from './places-list.js';
import { focusHash } from './router.js';
import { attachContextMenu } from './context-menu.js';
import { openAddModal } from './lazy-open.js';
import { FilterSelect, IndexControls, useFilters, useNavAdd, withCurrent } from './list-controls.js';
import { Fragment, html, mountPage, useEffect, useRef } from './view.js';
import { t } from './i18n.js';

const FOCUS_RE = /^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$/;
const RATINGS = ['unrated', '1', '2', '3', '4', '5'];

export function renderHistoryIndex() {
  setActiveTab('history');
  setCrumb(t('history.title'));
  cleanupMap();
  mountPage(html`<${HistoryIndex} />`, 'history');
}

// A phone hides the nav brand, the wide screen's h1, and holds History on the
// You page, so this title only shows on a phone that opens #/history. The
// props carry mountPage's visit count down, which makes each visit render.
/** @param {Record<string, any>} props */
function HistoryIndex(props) {
  return html`<h1 class="phone-title">${t('history.title')}</h1><${HistoryPage} ...${props} />`;
}

/**
 * Visited places and completed routes as history entries.
 * @param {boolean} wantPlaces @param {boolean} wantRoutes
 */
function historyEntries(wantPlaces, wantRoutes) {
  const all = /** @type {any[]} */ ([]);
  if (wantPlaces) {
    for (const p of (state.places || [])) {
      if (!p.visited) continue;
      all.push({
        kind: 'place',
        key: 'place:' + (p.id || p._slug || p.name),
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
          key: 'route:' + r.key,
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
  return all;
}

/**
 * Whether an entry passes the page's search and filters.
 * @param {any} e
 * @param {any} f The page's filters: search, kind, year, rating.
 * @param {boolean} byKind Whether the Type filter is offered; without it a
 *   kind remembered from before applies nowhere.
 */
function entryMatches(e, f, byKind) {
  const q = f.search.trim().toLowerCase();
  if (q && !e.name.toLowerCase().includes(q) && !(e.note && e.note.toLowerCase().includes(q))) return false;
  if (byKind && f.kind !== 'all' && e.kind !== f.kind) return false;
  if (f.year === 'none' && e.date) return false;
  if (f.year !== 'all' && f.year !== 'none' && e.date.slice(0, 4) !== f.year) return false;
  if (f.rating === 'unrated' && e.rating) return false;
  if (f.rating !== 'all' && f.rating !== 'unrated' && String(e.rating || '') !== f.rating) return false;
  return true;
}

/** The right-click / long-press menu, matching the Places and Routes cards. */
/** @param {any} e */
function menuItems(e) {
  const items = /** @type {any[]} */ ([]);
  const canEdit = !isReadOnly() && state.auth && state.auth.authenticated;
  if (e.kind === 'place') {
    const place = e.place;
    items.push({ label: t('lists.openOnMap'), onClick: () => { location.hash = '#/?focus=place:' + encodeURIComponent(place.name); } });
    if (Array.isArray(place.sources) && place.sources.length) {
      items.push({ label: t('lists.openSource'), onClick: () => { window.open(place.sources[0], '_blank', 'noopener'); } });
    }
    if (canEdit) items.push({ label: t('lists.edit'), onClick: () => { openEditPlaceModal(place); } });
    if (place.from_catalog && findCatalogUpdate(place)) {
      items.push({ label: t('lists.applyCatalogUpdate'), onClick: () => { openCatalogUpdateModal(place); } });
    }
    if (canEdit) {
      items.push(null);
      items.push({ label: t('common.delete'), danger: true, onClick: () => { deletePlaceItem(place, {}); } });
    }
  } else {
    const route = e.route;
    items.push({ label: t('lists.openOnMap'), onClick: () => { location.hash = '#/?focus=route:' + encodeURIComponent(route.key); } });
    items.push({ label: t('lists.openDetail'), onClick: () => { location.hash = '#/routes/route/' + encodeURIComponent(route.key); } });
    if (route.source) items.push({ label: t('lists.openSource'), onClick: () => { window.open(route.source, '_blank', 'noopener'); } });
    if (canEdit) items.push({ label: t('lists.edit'), onClick: () => { openEditTrailMetadataModal(route, e.region); } });
    if (canEdit) {
      items.push(null);
      items.push({ label: t('common.delete'), danger: true, onClick: () => { deleteRouteItem(route, e.region, () => {}); } });
    }
  }
  return items;
}

/** @param {{ e: any, view: string, show: Record<string, boolean> }} props */
function HistoryCard({ e, view, show }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const canvas = useRef(/** @type {HTMLCanvasElement | null} */ (null));
  const cur = useRef(e);
  cur.current = e;
  useEffect(() => { if (ref.current) attachContextMenu(ref.current, () => menuItems(cur.current)); }, []);
  const route = e.route;
  // The silhouette comes from the GPX and is sized to the canvas, so it is
  // redrawn for another file or another view, not on every metadata change.
  useEffect(() => {
    if (route && canvas.current) drawRouteSilhouette(canvas.current, route);
  }, [view, route && route.file, route && route.key]);
  let media;
  if (e.kind === 'place' && e.image && show.image) {
    const focus = typeof e.image_focus === 'string' && FOCUS_RE.test(e.image_focus.trim()) ? e.image_focus.trim() : '';
    media = html`<img class="history-image" src=${e.image} alt="" style=${focus ? 'object-position:' + focus : undefined} loading="lazy"
      decoding="async" fetchpriority="low" referrerpolicy="no-referrer"
      onError=${(/** @type {Event} */ ev) => { /** @type {HTMLElement} */ (ev.currentTarget).style.display = 'none'; }} />`;
  } else if (route) {
    // Routes have no photo; draw the GPX track silhouette, like the Routes list.
    media = html`<canvas class="history-image route-thumb" ref=${canvas} data-route-key=${route.key}></canvas>`;
  } else {
    // Reserves the thumbnail's width (compact only) so the text lines up
    // with entries that have one.
    media = html`<div class="history-image-spacer"></div>`;
  }
  const date = !!e.date && show.date;
  const stars = !!e.rating && show.rating;
  return html`<div class="history-card" ref=${ref} onClick=${() => { location.hash = e.href; }}>
    ${media}
    <div class="history-body">
      <div class="history-head">
        <span class="history-name">${e.name}</span>
        <span class="ui-badge ui-badge-pill history-kind">${e.kind === 'place' ? t('history.place') : t('history.route')}</span>
      </div>
      ${(date || stars) && html`<div class="history-meta">
        ${date && html`<span>${e.date}</span>`}
        ${stars && html`<span class="history-stars" title=${e.rating + '/5'}>${ratingStars(e.rating)}</span>`}
      </div>`}
      ${!!e.note && show.note && html`<div class="history-note">${e.note}</div>`}
    </div>
  </div>`;
}

export function HistoryPage() {
  // Read for the subscription; state.places and state.manifest are the
  // store's copies.
  places.value; routes.value;
  const [f, patch] = useFilters(state.historyFilters);
  const wantPlaces = placesEnabled();
  const wantRoutes = routesEnabled();
  const byKind = wantPlaces && wantRoutes;
  useNavAdd('hist-add-btn', byKind ? t('history.addEither') : (wantPlaces ? t('place.add') : t('add.titleRoute')), () => openAddModal(null));
  if ((wantPlaces && !state.places) || (wantRoutes && !state.manifest)) return html`<div class="app-state" aria-busy="true"><p class="ui-hint" role="status">${t('history.loading')}</p></div>`;

  const all = historyEntries(wantPlaces, wantRoutes);
  if (!all.length) return html`<div class="history-list"><div class="ui-empty" role="status"><p>${t('history.empty')}</p></div></div>`;

  const view = listView('history');
  const show = { image: getShowField('image'), note: getShowField('note'), rating: getShowField('rating'), date: getShowField('date') };
  const years = withCurrent(
    [...new Set(all.filter(e => e.date).map(e => e.date.slice(0, 4)))].sort((a, b) => b.localeCompare(a)),
    f.year === 'none' ? 'all' : f.year
  );
  const undated = f.year === 'none' || all.some(e => !e.date);

  const shown = all.filter(e => entryMatches(e, f, byKind));
  const dated = shown.filter(e => e.date).sort((a, b) => b.date.localeCompare(a.date));
  const groups = /** @type {{ label: string, items: any[] }[]} */ ([]);
  for (const e of dated) {
    const year = e.date.slice(0, 4);
    if (!groups.length || groups[groups.length - 1].label !== year) groups.push({ label: year, items: [] });
    groups[groups.length - 1].items.push(e);
  }
  const noDate = shown.filter(e => !e.date).sort((a, b) => nameCollator().compare(a.name, b.name));
  if (noDate.length) groups.push({ label: t('history.noDate'), items: noDate });

  const filterCount = (byKind && f.kind !== 'all' ? 1 : 0) + (f.year !== 'all' ? 1 : 0) + (f.rating !== 'all' ? 1 : 0);
  const clear = () => {
    if (!f.search && !filterCount) return;
    patch({ search: '', kind: 'all', year: 'all', rating: 'all' });
  };

  return html`<${IndexControls} placeholder=${t('history.filter')} search=${f.search} onSearch=${(/** @type {string} */ v) => patch({ search: v })}
    count=${shown.length} kind="history" onView=${() => patch({})} active=${filterCount > 0} onClear=${clear}
    filterChildren=${html`<${Fragment}>
      ${byKind && html`<${FilterSelect} id="filter-kind" value=${f.kind} label=${t('history.type')} onChange=${(/** @type {string} */ v) => patch({ kind: v })}>
        <option value="place">${t('lists.places')}</option>
        <option value="route">${t('lists.routes')}</option>
      <//>`}
      <${FilterSelect} id="filter-year" value=${f.year} label=${t('history.year')} onChange=${(/** @type {string} */ v) => patch({ year: v })}>
        ${years.map((/** @type {string} */ y) => html`<option key=${y} value=${y}>${y}</option>`)}
        ${undated && html`<option value="none">${t('history.noDate')}</option>`}
      <//>
      <${FilterSelect} id="filter-rating" value=${f.rating} label=${t('lists.rating')} onChange=${(/** @type {string} */ v) => patch({ rating: v })}>
        ${RATINGS.map(v => html`<option key=${v} value=${v}>${v === 'unrated' ? t('lists.unrated') : t('lists.stars', { count: Number(v) })}</option>`)}
      <//>
    <//>`} />
    ${groups.length
      ? html`<div class=${'history-list ' + view}>
          ${groups.map(g => html`<div class="history-group fade-in" key=${g.label}>
            <div class="history-year">${g.label}</div>
            <div class="history-cards">
              ${g.items.map(e => html`<${HistoryCard} key=${e.key} e=${e} view=${view} show=${show} />`)}
            </div>
          </div>`)}
        </div>`
      : html`<div class="history-list"><div class="ui-empty" role="status"><p>${t('history.noMatches')}</p></div></div>`}`;
}

// [value, label key]; the labels are looked up when asked for.
const LIST_VIEWS = [['grid', 'lists.viewGrid'], ['compact', 'lists.viewCompact'], ['gallery', 'lists.viewGallery']];
const HISTORY_VIEWS = [['compact', 'lists.viewCompact'], ['gallery', 'lists.viewGallery']];
/** The layouts a list page offers as [value, label], its default first. @param {string} kind */
export function listViewOptions(kind) {
  return (kind === 'history' ? HISTORY_VIEWS : LIST_VIEWS).map(([v, key]) => [v, t(key)]);
}

// Layout for a list page, from its `<kind>-view` pref: 'grid' (multi-column
// cards, Places and Routes only), 'compact' (single-column cards) or
// 'gallery' (single column, media on top).
/** @param {string} kind 'places', 'routes' or 'history' */
export function listView(kind) {
  const opts = listViewOptions(kind);
  const v = getPref(kind + '-view', opts[0][0]);
  return opts.some(o => o[0] === v) ? v : opts[0][0];
}

// Split a GPX into separate point arrays, one per track segment (and per
// track when a track has no <trkseg>). Keeping segments apart stops the
// silhouette from drawing a straight line between disjoint paths.
/** @param {string} text */
function gpxSegments(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const tags = function(/** @type {Document | Element} */ parent, /** @type {string} */ name) {
    let els = parent.getElementsByTagNameNS(GPX_NS, name);
    if (!els.length) els = parent.getElementsByTagName(name);
    return els;
  };
  const readPts = function(/** @type {Element} */ parent) {
    const arr = [];
    const pts = tags(parent, 'trkpt');
    for (let i = 0; i < pts.length; i++) {
      const lat = parseFloat(pts[i].getAttribute('lat') || '');
      const lon = parseFloat(pts[i].getAttribute('lon') || '');
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
/** @param {HTMLCanvasElement} canvas @param {import('./core.js').ManifestRoute} route */
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
    if (!ctx) return;
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
