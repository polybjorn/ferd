import { render } from 'preact';
import { displayCategory, displayRegion, state } from '../core.js';
import { canEditPopup } from '../server.js';
import { getShowField } from '../prefs.js';
import { t } from '../i18n.js';
import { html, useEffect, useState } from '../view.js';

// The map's popups as Preact views. Leaflet takes a popup's content as an
// element, so each one renders into a fresh div; a popup whose layout
// changes after it opens is handed `relayout`, which re-measures it.
/** @param {any} vnode */
export function popupElement(vnode) {
  const el = document.createElement('div');
  render(vnode, el);
  return el;
}

// POPUP-VIEWS-BEGIN (tests/js/popup-edit.test.js runs this block)
function ExternalIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
}

/** @param {{ href?: string }} props */
function SourceLink({ href }) {
  return href
    ? html`<a class="popup-source-link" href=${href} target="_blank" rel="noopener noreferrer" title=${t('popup.source')} aria-label=${t('popup.source')}><${ExternalIcon} /></a>`
    : null;
}

/** @param {{ name?: string }} props */
function LocalName({ name }) {
  return getShowField('local-name') && name ? html` <span class="popup-local">${name}</span>` : null;
}

/** @param {{ tags?: string[] }} props */
function Tags({ tags }) {
  return getShowField('tags') && Array.isArray(tags) && tags.length
    ? html`<div class="popup-tags">${tags.map(t => '#' + t).join(' ')}</div>` : null;
}

/** @param {{ text?: string }} props */
function Note({ text }) {
  return text && getShowField('note') ? html`<div class="popup-note">${text}</div>` : null;
}

// Uncategorized carries no colour of its own, so its dot falls back to
// --muted and follows the theme while the popup is open.
/** @param {{ category: string }} props */
function PopupCategory({ category }) {
  /** @type {Record<string, string>} */
  const dark = state.categoryColors;
  /** @type {Record<string, string>} */
  const light = state.categoryColorsLight;
  const colors = category ? { '--c': dark[category], '--cl': light[category] } : null;
  return html`<span class="popup-category"><span class="popup-category-dot" style=${colors}></span>${displayCategory(category)}</span>`;
}

/** @param {{ onEdit: () => void }} props */
function PopupEdit({ onEdit }) {
  return canEditPopup() ? html`<button type="button" class="popup-edit" onClick=${onEdit}>${t('popup.edit')}</button>` : null;
}

const IMAGE_FOCUS = /^(top|bottom|center|left|right|\d{1,3}%\s+\d{1,3}%)$/;

/** @param {{ place: any, onEdit: () => void }} props */
export function PlacePopup({ place: p, onEdit }) {
  // A broken or blocked image is hidden rather than left as an empty frame.
  const [imageFailed, setImageFailed] = useState(false);
  const focus = typeof p.image_focus === 'string' && IMAGE_FOCUS.test(p.image_focus.trim()) ? p.image_focus.trim() : '';
  return html`
    <${SourceLink} href=${Array.isArray(p.sources) && p.sources.length ? p.sources[0] : ''} />
    <div class="popup-name">${p.name}<${LocalName} name=${p.local_name} /></div>
    ${p.image && getShowField('image') && !imageFailed ? html`<img class="popup-image" src=${p.image} alt=""
      style=${focus ? { objectPosition: focus } : null} loading="lazy" referrerpolicy="no-referrer"
      onError=${() => setImageFailed(true)} />` : null}
    <${Note} text=${p.note} />
    <${Tags} tags=${p.tags} />
    <div class="popup-meta">
      <${PopupCategory} category=${p.category} />
      <${PopupEdit} onEdit=${onEdit} />
      <span class="popup-status">${t(p.visited ? 'popup.visited' : 'popup.want')}</span>
    </div>`;
}

// The empty stars are the same glyph, dimmed, since ☆ and ★ render at
// different widths in most fonts.
/** @param {{ rating: number }} props */
function Stars({ rating }) {
  return html`<span title=${rating + '/5'}>${'★'.repeat(rating)}${rating < 5
    ? html`<span class="popup-stars-dim">${'★'.repeat(5 - rating)}</span>` : null}</span>`;
}

const DIFFICULTIES = /** @type {Record<string, string>} */ ({
  easy: 'form.diffEasy', moderate: 'form.diffModerate', hard: 'form.diffHard', expert: 'form.diffExpert',
});

/** @param {{ route: any, region: { name: string } }} props */
export function RoutePopup({ route, region }) {
  // Difficulty, rating and date sit left, centre and right, so each slot
  // renders even when empty.
  const difficulty = route.difficulty ? (DIFFICULTIES[route.difficulty] ? t(DIFFICULTIES[route.difficulty]) : route.difficulty) : '';
  const rating = route.rating && getShowField('rating') ? html`<${Stars} rating=${route.rating} />` : null;
  const date = route.date_completed && getShowField('date') ? route.date_completed : '';
  return html`
    <${SourceLink} href=${route.source} />
    <a class="popup-name popup-name-link" href=${'#/routes/route/' + encodeURIComponent(route.key)}>${route.name}<${LocalName} name=${route.local_name} /></a>
    ${difficulty || rating || date ? html`<div class="popup-summary">
      <span>${difficulty}</span><span>${rating}</span><span>${date}</span>
    </div>` : null}
    <${Tags} tags=${route.tags} />
    <${Note} text=${route.notes} />
    <div class="popup-meta">
      <span>${t(route.completed ? 'popup.completed' : 'popup.planned')}</span>
      <span>${displayRegion(region.name)}</span>
    </div>`;
}

/** @typedef {{ label: string, done: boolean, route?: boolean, go: () => void }} AreaItem */

// A count that opens its list. Items are {label, done, route, go}; with none
// there is nothing to open, so the count stays plain text.
/** @param {{ text: string, items: AreaItem[], open: boolean, onToggle: () => void }} props */
function AreaCount({ text, items, open, onToggle }) {
  if (!items.length) return text;
  return html`<button type="button" class="popup-area-count" aria-expanded=${String(open)} onClick=${onToggle}>${text}</button>`;
}

// places: the places inside, now. routes: a promise of the routes inside,
// since only their tracks can answer and those may not be loaded yet.
/**
 * @param {{ area: any, visited: boolean, places: AreaItem[], routes: Promise<AreaItem[]>,
 *   onEdit: () => void, close: () => void, relayout: () => void }} props
 */
export function AreaPopup({ area, visited, places, routes, onEdit, close, relayout }) {
  // undefined while counting, null when a track could not be read: a
  // partial count would read as the real one, so then there is none.
  const [routeItems, setRouteItems] = /** @type {[AreaItem[] | null | undefined, (v: AreaItem[] | null) => void]} */ (useState(undefined));
  const [open, setOpen] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    let live = true;
    routes.then(r => { if (live) setRouteItems(r); }, () => { if (live) setRouteItems(null); });
    return () => { live = false; };
  }, []);
  useEffect(() => { relayout(); }, [routeItems, open]);
  const toggle = (/** @type {string} */ id) => () => setOpen(open === id ? null : id);
  const placeCount = places.length
    ? t('popup.areaPlaces', { count: places.length, done: places.filter(p => p.done).length }) : t('popup.noPlaces');
  const completed = routeItems ? routeItems.filter(r => r.done).length : 0;
  const listed = open === 'places' ? places : open === 'routes' ? routeItems || [] : [];
  return html`
    <div class="popup-name">${area.name}<${LocalName} name=${area.local_name} /></div>
    <${Note} text=${area.note} />
    <div class="popup-area-counts">
      <span class="popup-area-places"><${AreaCount} text=${placeCount} items=${places} open=${open === 'places'} onToggle=${toggle('places')} /></span>
      ${routeItems === null ? null : html`<span class="popup-area-routes">${routeItems === undefined ? t('popup.countingRoutes')
        : html`<${AreaCount} text=${routeItems.length ? t('popup.areaRoutes', { count: routeItems.length, done: completed }) : t('popup.noRoutes')}
            items=${routeItems} open=${open === 'routes'} onToggle=${toggle('routes')} />`}</span>`}
    </div>
    <div class="popup-area-list" hidden=${!listed.length}>
      ${listed.map(item => html`<button type="button"
        class=${'popup-area-item' + (item.route ? ' route' : '') + (item.done ? ' done' : '')}
        onClick=${(/** @type {MouseEvent} */ e) => {
          // Closing detaches the popup, and Leaflet would take this for a map click.
          e.stopPropagation();
          close();
          item.go();
        }}>${item.label}</button>`)}
    </div>
    <div class="popup-meta">
      <${PopupCategory} category=${area.category} />
      <${PopupEdit} onEdit=${onEdit} />
      <span class="popup-status popup-area-status">${t(visited || completed ? 'popup.visited' : 'popup.want')}</span>
    </div>`;
}
// POPUP-VIEWS-END
