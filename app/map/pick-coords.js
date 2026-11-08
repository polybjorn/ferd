import { state } from '../core.js';
import { openAddModal } from '../add/add.js';
import { openSearchView } from './map-phone.js';

// onPick is called with the chosen latlng. If omitted, the default
// behavior opens the Add modal pre-filled with those coordinates.
/** @param {(latlng: { lat: number, lng: number }) => void} [onPick] */
export function enterPickCoordsMode(onPick) {
  // Make sure we're on the unified map. If not, navigate there first.
  const base = (location.hash || '#/').split('?')[0];
  const onMapView = base === '#/' || base === '#/map' || base === '#'
    || base.startsWith('#/place/') || base.startsWith('#/route/');
  if (!onMapView) {
    location.hash = '#/';
    setTimeout(function() { enterPickCoordsMode(onPick); }, 250);
    return;
  }
  const banner = document.createElement('div');
  banner.className = 'pick-coords-banner';
  banner.textContent = 'Click on the map to set coordinates (or click here to cancel)';
  banner.addEventListener('click', cleanup);
  document.body.appendChild(banner);
  const map = state.currentMap;
  if (!map) { cleanup(); return; }
  function onClick(/** @type {{ latlng: { lat: number, lng: number } }} */ e) {
    cleanup();
    if (typeof onPick === 'function') onPick(e.latlng);
    else openAddModal(e.latlng);
  }
  function cleanup() {
    map.off('click', onClick);
    if (banner.parentNode) banner.parentNode.removeChild(banner);
    if (map.getContainer()) map.getContainer().style.cursor = '';
  }
  map.getContainer().style.cursor = 'crosshair';
  map.once('click', onClick);
}

// Spacebar: toggle map chrome (filter panel, leaflet controls).
document.addEventListener('keydown', function(e) {
  if (e.key !== ' ' && e.code !== 'Space') return;
  if (!state.currentMap) return;
  if (/** @type {HTMLElement} */ (document.getElementById('modal-root')).children.length) return;
  const t = /** @type {HTMLElement} */ (e.target);
  const tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  e.preventDefault();
  document.body.classList.toggle('map-chrome-hidden');
});

// 'S': focus the search input on list pages, or the map search on the
// index map. If the map filter panel is hidden by user preference, the
// panel is force-shown while the search input is focused and restored
// on blur.
document.addEventListener('keydown', function(e) {
  if (e.key !== 's' && e.key !== 'S') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/** @type {HTMLElement} */ (document.getElementById('modal-root')).children.length) return;
  const t = /** @type {HTMLElement} */ (e.target);
  const tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  const listInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
  if (listInput && listInput.offsetParent !== null) {
    e.preventDefault();
    listInput.focus();
    listInput.select();
    return;
  }
  const mapInput = /** @type {HTMLInputElement} */ (document.getElementById('map-search-input'));
  // A narrow window swaps the panel, and with it the input, for the search
  // view the bottom bar opens.
  const phoneButtons = document.getElementById('map-phone-buttons');
  if (phoneButtons && phoneButtons.offsetParent !== null) {
    e.preventDefault();
    openSearchView();
    return;
  }
  if (mapInput) {
    e.preventDefault();
    const wasForced = !document.body.classList.contains('force-show-map-filter');
    if (wasForced) document.body.classList.add('force-show-map-filter');
    mapInput.focus();
    mapInput.select();
    if (!wasForced) return;
    // Restore on click outside the panel or on Escape. Using input
    // 'blur' would fire as soon as the user mousedowns a search
    // result (which takes focus from the input), hiding the panel
    // before the click actually registers on the row.
    const restore = function() {
      document.body.classList.remove('force-show-map-filter');
      document.removeEventListener('mousedown', onOutside, true);
      mapInput.removeEventListener('keydown', onEsc);
    };
    const onOutside = function(/** @type {MouseEvent} */ ev) {
      const target = /** @type {Element} */ (ev.target);
      if (target.closest && target.closest('.map-panel')) return;
      restore();
    };
    const onEsc = function(/** @type {KeyboardEvent} */ ev) {
      if (ev.key === 'Escape') { mapInput.blur(); restore(); }
    };
    document.addEventListener('mousedown', onOutside, true);
    mapInput.addEventListener('keydown', onEsc);
  }
});

// Long-press on the map (touch only): same toggle as spacebar.
let lastPointerType = 'mouse';
document.addEventListener('pointerdown', function(e) { lastPointerType = e.pointerType; }, true);
document.addEventListener('contextmenu', function(e) {
  if (lastPointerType !== 'touch' && lastPointerType !== 'pen') return;
  if (!state.currentMap) return;
  if (/** @type {HTMLElement} */ (document.getElementById('modal-root')).children.length) return;
  const t = /** @type {HTMLElement} */ (e.target);
  if (!t.closest('.leaflet-container')) return;
  if (t.closest('.leaflet-marker-icon, .leaflet-control, .leaflet-popup, .map-panel')) return;
  e.preventDefault();
  document.body.classList.toggle('map-chrome-hidden');
  if (navigator.vibrate) navigator.vibrate(15);
});
