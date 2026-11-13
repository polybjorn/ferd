// Tapping a cluster zooms and pans at once, more than a level. Ridden as a CSS
// transition, pins and lines would scale with the tiles, and a layer redrawn
// from script alongside the compositor shakes on a phone. The map instead
// moves itself each frame, as a pinch does: every layer redraws at its own
// size in the same frame as the tiles, and none of them is scaled.
const { test, expect } = require('@playwright/test');
const { fence, signIn } = require('./helpers');

test('a cluster zoom moves the map frame by frame with every layer at its own size', async ({ page, baseURL }) => {
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
    return { x: target.x, y: target.y, lat, lng };
  });
  expect(tap, 'the demo places cluster at zoom 6').not.toBeNull();

  await page.evaluate(async (/** @type {{ lat: number, lng: number }} */ tap) => {
    const { state } = await import('/app/core.js');
    const map = /** @type {any} */ (state._placeClusterGroup)._map;
    const box = map.getContainer();
    const scaleOf = (/** @type {Element | null} */ el) => el ? Math.abs(new DOMMatrixReadOnly(getComputedStyle(el).transform).a) : 1;
    const probe = /** @type {any} */ (window).__zoomProbe = {
      from: map.getZoom(), zooms: /** @type {number[]} */ ([]), zoomanim: 0, scale: 1,
    };
    map.on('zoomanim', () => probe.zoomanim++);
    const onZoom = () => {
      probe.zooms.push(map.getZoom());
      probe.scale = Math.max(probe.scale,
        scaleOf(box.querySelector('canvas.place-canvas-layer')), scaleOf(box.querySelector('canvas.gl-routes')));
    };
    map.on('zoom', onZoom);
    map.once('zoomend', () => {
      map.off('zoom', onZoom);
      probe.to = map.getZoom();
      probe.offCentre = map.latLngToContainerPoint([tap.lat, tap.lng]).distanceTo(map.getSize().divideBy(2));
      probe.done = true;
    });
  }, /** @type {{ lat: number, lng: number }} */ (tap));
  // Through the layer's own handler: a demo route runs under the cluster and
  // would take a real tap.
  await page.evaluate(async (/** @type {{ x: number, y: number }} */ at) => {
    const { state } = await import('/app/core.js');
    /** @type {any} */ (state._placeClusterGroup)._onClick({ containerPoint: L.point(at.x, at.y), originalEvent: new MouseEvent('click') });
  }, /** @type {{ x: number, y: number }} */ (tap));
  await page.waitForFunction(() => /** @type {any} */ (window).__zoomProbe.done);

  const probe = await page.evaluate(() => /** @type {any} */ (window).__zoomProbe);
  expect(probe.to - probe.from, 'the tap zooms a level or more').toBeGreaterThanOrEqual(1);
  expect(probe.zoomanim, 'no CSS zoom transition').toBe(0);
  // A slow CI runner paints only a frame or two of the quarter second.
  const between = probe.zooms.filter((/** @type {number} */ z) => z > probe.from && z < probe.to);
  expect(between.length, 'frames at a zoom between start and end').toBeGreaterThan(0);
  expect(probe.zooms, 'the zoom only grows').toEqual([...probe.zooms].sort((a, b) => a - b));
  expect(probe.scale, 'place and route canvases stay unscaled').toBe(1);
  expect(probe.offCentre, 'the cluster ends at the centre, px').toBeLessThan(1);
  expect(fenced.errors).toEqual([]);
});
