// The phone bar gets out of the way while the content moves. Panning or
// zooming the map sends it down until the map is tapped, so a map being looked
// at stays fullscreen; a list sends it down while scrolling down and brings it
// back on scrolling up. A new view always brings it back. CSS acts on the class
// only at phone width, so a wider screen ignores it.

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
  let reveal = 0;
  map.on('movestart', () => { moved = true; clearTimeout(reveal); setAway(true); });
  const el = map.getContainer();
  el.addEventListener('pointerdown', () => { moved = false; }, { passive: true });
  // A mouse drag ends in a click too; only a press that left the map where it
  // was counts as a tap. Listening on the element rather than Leaflet's click
  // catches taps on markers and controls as well as on the map itself.
  el.addEventListener('click', () => {
    if (moved) return;
    clearTimeout(reveal);
    reveal = setTimeout(() => setAway(false), DOUBLE_TAP_MS);
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
  window.addEventListener('hashchange', () => { lastY = 0; setAway(false); });
}
// A keyboard user tabbing into the hidden bar must see where focus went.
document.getElementById('bottom-bar')?.addEventListener('focusin', () => setAway(false));
