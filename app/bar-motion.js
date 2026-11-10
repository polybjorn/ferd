// The phone bar gets out of the way while the content moves. Panning or
// zooming the map sends it down until the map is tapped, so a map being looked
// at stays fullscreen, and a tap on the bare map sends it down too; a list
// sends it down while scrolling down and brings it back on scrolling up. A new
// view always brings it back. CSS acts on the class only at phone width, so a
// wider screen ignores it.

// A finger at rest still reports a few pixels of scroll, which would make the
// bar flicker on and off.
const SCROLL_SLACK = 8;
// Android's double-tap timeout (ViewConfiguration.DOUBLE_TAP_TIMEOUT). A tap is
// known to be single only once this has passed: bringing the bar back sooner
// shows it on the first tap of a double-tap zoom, and the zoom hides it again.
const DOUBLE_TAP_MS = 300;

const body = document.body;

/** @param {boolean} away */
function setAway(away) {
  body.classList.toggle('bar-away', away);
}

/** @param {import('./map/route-layer.js').LeafletMap} map */
export function tuckBarWhileMoving(map) {
  let moved = false;
  let popupOpen = false;
  let popupAtPress = false;
  let reveal = 0;
  map.on('movestart', () => { moved = true; clearTimeout(reveal); setAway(true); });
  map.on('popupopen', () => { popupOpen = true; });
  map.on('popupclose', () => { popupOpen = false; });
  const el = map.getContainer();
  el.addEventListener('pointerdown', () => { moved = false; popupAtPress = popupOpen; }, { passive: true });
  // A mouse drag ends in a click too; only a press that left the map where it
  // was counts as a tap. Listening on the element rather than Leaflet's click
  // catches taps on markers and controls as well as on the map itself.
  el.addEventListener('click', (/** @type {MouseEvent} */ e) => {
    if (moved) return;
    // A tap on a control was aimed at that control, and leaves the bar as it is.
    if (e.target instanceof Element && e.target.closest('.leaflet-control, .leaflet-popup')) return;
    // Routes, pins and areas are found by the map's own click handlers, so a
    // tap reads as bare map only if it opened no popup. One that closed a popup
    // was aimed at that, and leaves the bar showing.
    clearTimeout(reveal);
    reveal = setTimeout(() => {
      if (body.classList.contains('bar-away')) setAway(false);
      else if (!popupAtPress && !popupOpen) setAway(true);
    }, DOUBLE_TAP_MS);
  });
}

const app = document.getElementById('app');
if (app) {
  let lastY = 0;
  app.addEventListener('scroll', () => {
    const y = app.scrollTop;
    if (Math.abs(y - lastY) < SCROLL_SLACK) return;
    // At the top, or in iOS's overscroll above it, the bar always shows.
    setAway(y > lastY && y > 0);
    lastY = y;
  }, { passive: true });
  // A list page comes back where it was left (view.js), which is not a scroll.
  // The router can have put it back before this runs, or after.
  window.addEventListener('hashchange', () => { lastY = app.scrollTop; setAway(false); });
  app.addEventListener('scrollrestore', () => { lastY = app.scrollTop; });
}
// A keyboard user tabbing into the hidden bar must see where focus went.
document.getElementById('bottom-bar')?.addEventListener('focusin', () => setAway(false));
