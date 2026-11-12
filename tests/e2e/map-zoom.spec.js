// Tapping a cluster zooms and pans at once, as a CSS transition the
// compositor runs. The pin and route canvases must ride that same transition:
// redrawn from script instead, they reach the screen a frame behind the tiles
// and stutter. Every frame of the animation, a point near the corner has to
// land on the same screen spot through the tiles and through each canvas.
const { test, expect } = require('@playwright/test');
const { fence, signIn } = require('./helpers');

test('pins and routes move with the tiles through a cluster zoom', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);
  await expect(page.locator('canvas.place-canvas-layer')).toBeAttached();

  const tap = await page.evaluate(async () => {
    const { state } = await import('/app/core.js');
    const layer = /** @type {any} */ (state._placeClusterGroup);
    const map = layer._map;
    map.setZoom(6, { animate: false });
    await new Promise(r => setTimeout(r, 300));
    const cluster = layer._getCurrentFeatures().find((/** @type {any} */ f) => f.properties.cluster);
    if (!cluster) return null;
    const [lng, lat] = cluster.geometry.coordinates;
    const at = map.latLngToContainerPoint([lat, lng]);
    // Off centre, so the zoom also pans.
    map.panBy(at.subtract(map.getSize().multiplyBy(0.3)), { animate: false });
    await new Promise(r => setTimeout(r, 300));
    const target = map.latLngToContainerPoint([lat, lng]);
    return { x: target.x, y: target.y };
  });
  expect(tap, 'the demo places cluster at zoom 6').not.toBeNull();

  await page.evaluate(async () => {
    const { state } = await import('/app/core.js');
    const map = /** @type {any} */ (state._placeClusterGroup)._map;
    const tiles = /** @type {any} */ (Object.values(map._layers).find((/** @type {any} */ l) => l._levels));
    const canvases = [...map.getContainer().querySelectorAll('canvas.place-canvas-layer, canvas.gl-routes')];
    const corner = { x: 40, y: 60 };
    const ll = map.containerPointToLatLng([corner.x, corner.y]);
    const matrix = (/** @type {Element} */ el) => new DOMMatrixReadOnly(getComputedStyle(el).transform);
    const probe = /** @type {any} */ (window).__zoomProbe = { frames: 0, worst: 0, moved: 0, start: /** @type {any} */ (null) };
    const sample = () => {
      if (map._animatingZoom) {
        const level = tiles._levels[tiles._tileZoom];
        const local = map.project(ll, tiles._tileZoom).subtract(level.origin);
        const onTiles = matrix(level.el).transformPoint(new DOMPoint(local.x, local.y));
        probe.start = probe.start || onTiles;
        probe.moved = Math.max(probe.moved, Math.hypot(onTiles.x - probe.start.x, onTiles.y - probe.start.y));
        for (const canvas of canvases) {
          const onCanvas = matrix(canvas).transformPoint(new DOMPoint(corner.x, corner.y));
          probe.worst = Math.max(probe.worst, Math.hypot(onCanvas.x - onTiles.x, onCanvas.y - onTiles.y));
        }
        probe.frames++;
      }
      if (probe.frames && !map._animatingZoom) probe.done = true;
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // Through the layer's own handler: a demo route runs under the cluster and
  // would take a real tap.
  await page.evaluate(async (/** @type {{ x: number, y: number }} */ at) => {
    const { state } = await import('/app/core.js');
    /** @type {any} */ (state._placeClusterGroup)._onClick({ containerPoint: L.point(at.x, at.y), originalEvent: new MouseEvent('click') });
  }, /** @type {{ x: number, y: number }} */ (tap));
  await page.waitForFunction(() => /** @type {any} */ (window).__zoomProbe.done);

  const probe = await page.evaluate(() => /** @type {any} */ (window).__zoomProbe);
  expect(probe.frames).toBeGreaterThan(3);
  expect(probe.moved, 'the zoom pans the corner across the screen').toBeGreaterThan(50);
  expect(probe.worst, 'canvas offset from the tiles, px').toBeLessThan(1.5);
  expect(fenced.errors).toEqual([]);
});
