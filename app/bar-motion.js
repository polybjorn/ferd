// The phone bar gets out of the way while the content moves: it slides down
// when the map is dragged or zoomed and when a list scrolls down, and comes
// back when the map settles, a list scrolls up or a new view opens. CSS acts
// on the class only at phone width, so a wider screen ignores it.

const SETTLE_MS = 1000;
// A finger at rest still reports a few pixels of scroll, which would make the
// bar flicker on and off.
const SCROLL_SLACK = 8;

const body = document.body;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let settle;

/** @param {boolean} away */
function setAway(away) {
  clearTimeout(settle);
  body.classList.toggle('bar-away', away);
}

/** @param {import('./map/route-layer.js').LeafletMap} map */
export function tuckBarWhileMoving(map) {
  map.on('movestart', () => setAway(true));
  // Waiting a moment keeps the bar from bobbing between short pans.
  map.on('moveend', () => {
    clearTimeout(settle);
    settle = setTimeout(() => setAway(false), SETTLE_MS);
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
