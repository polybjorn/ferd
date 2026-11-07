// WHEEL-ZOOM-BEGIN
// A mouse sends sparse notches whose pixel size depends on browser and OS,
// on some setups too small for a distance-based step to move the map, so a
// notch moves a fixed step. A trackpad streams pixels, where distance is
// the right measure.
const WHEEL_ZOOM_PER_NOTCH = 0.5;
const WHEEL_ZOOM_PER_UNIT = 0.0045;
const WHEEL_EASE_MS = 46;
const WHEEL_IDLE_MS = 200;

function isWheelNotch(e) {
  // deltaMode comes first: Firefox reports a line-based wheel as pixels to
  // a page that reads deltaY before it.
  if (e.deltaMode !== 0) return true;
  // Chromium and WebKit give a trackpad wheelDeltaY = -3 * deltaY, which
  // can land on a multiple of 120 mid-stream.
  return !!e.wheelDeltaY && e.wheelDeltaY % 120 === 0 && e.wheelDeltaY !== -3 * e.deltaY;
}

function wheelZoomStep(e) {
  if (isWheelNotch(e)) return -Math.sign(e.deltaY) * WHEEL_ZOOM_PER_NOTCH;
  return L.DomEvent.getWheelDelta(e) * WHEEL_ZOOM_PER_UNIT;
}

export function enableWheelZoom(map) {
  const container = map.getContainer();
  let frameId = 0;
  let moved = false;
  let goalZoom, anchorLatLng, anchorOffset, lastFrame, lastWheel, ownZoom, ownCenter;

  function finish() {
    frameId = 0;
    if (moved) {
      moved = false;
      map._moveEnd(true);
    }
  }

  function onFrame(now) {
    const zoom = map.getZoom();
    // Another mover (flyTo, a route focus) took the view: stop fighting it.
    if (zoom !== ownZoom || !map.getCenter().equals(ownCenter)) return finish();
    const eased = zoom + (goalZoom - zoom) * (1 - Math.exp(-Math.max(now - lastFrame, 0) / WHEEL_EASE_MS));
    const next = Math.abs(goalZoom - eased) < 0.005 ? goalZoom : eased;
    lastFrame = now;
    if (next !== zoom) {
      if (!moved) {
        map._moveStart(true, false);
        moved = true;
      }
      map._move(map.unproject(map.project(anchorLatLng, next).subtract(anchorOffset), next), next);
      ownZoom = map.getZoom();
      ownCenter = map.getCenter();
    }
    if (next === goalZoom && now - lastWheel >= WHEEL_IDLE_MS) return finish();
    frameId = requestAnimationFrame(onFrame);
  }

  function onWheel(e) {
    const step = wheelZoomStep(e);
    L.DomEvent.stop(e);
    if (!frameId) {
      // Not map.stop(): it snaps the fractional zoom a gesture rests on.
      map._stop();
      goalZoom = ownZoom = map.getZoom();
      ownCenter = map.getCenter();
      lastFrame = performance.now();
      frameId = requestAnimationFrame(onFrame);
    }
    goalZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), goalZoom + step));
    const point = map.mouseEventToContainerPoint(e);
    anchorLatLng = map.containerPointToLatLng(point);
    anchorOffset = point.subtract(map.getSize().divideBy(2));
    lastWheel = performance.now();
  }

  container.addEventListener('wheel', onWheel, { passive: false });
  // The next map reuses this element, so a listener left behind would
  // drive a removed map.
  map.once('unload', () => {
    cancelAnimationFrame(frameId);
    container.removeEventListener('wheel', onWheel);
  });
}
// WHEEL-ZOOM-END
