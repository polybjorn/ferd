// Tapping a cluster zooms and pans at once, more than a level, as a CSS
// transition the compositor runs. The pins must ride that same transition
// (redrawn from script instead, they reach the screen a frame behind the tiles
// and stutter) without growing with it: each one glides at its own size and
// has to land on its place's spot on the tiles at every step. The route lines,
// which would grow too, stay hidden until the zoom ends.
const { test, expect } = require('@playwright/test');
const { fence, signIn } = require('./helpers');

test('pins glide with the tiles at their own size through a cluster zoom', async ({ page, baseURL }) => {
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
    const layer = /** @type {any} */ (state._placeClusterGroup);
    const map = layer._map;
    const tiles = /** @type {any} */ (Object.values(map._layers).find((/** @type {any} */ l) => l._levels));
    const box = map.getContainer();
    const matrix = (/** @type {Element} */ el) => new DOMMatrixReadOnly(getComputedStyle(el).transform);
    // A test browser draws routes as SVG, so the WebGL route pane a phone uses
    // is made here to check that the hiding reaches it under its real name.
    const linePanes = ['overlayPane', 'glRoutesPane', 'areasPane'].map(n => map.getPane(n) || map.createPane(n));
    const probe = /** @type {any} */ (window).__zoomProbe = {
      marks: 0, steps: 0, worst: 0, moved: 0, scale: 1, canvasHidden: false, linesHidden: true,
    };
    // A slow CI runner paints only a frame or two of the quarter-second zoom, so
    // the transitions are paused and stepped through fixed points in time
    // instead. Registered after the layer's own handler, this runs once every
    // mark is built; Leaflet's end-of-zoom timer waits while it runs.
    map.once('zoomanim', () => {
      const level = tiles._levels[tiles._tileZoom];
      const els = /** @type {HTMLElement[]} */ ([...box.querySelectorAll('.place-glide > canvas')]);
      const marks = els.map((el, i) => {
        const [lng, lat] = layer._visibleFeatures[i].geometry.coordinates;
        return { el, ll: L.latLng(lat, lng), start: /** @type {DOMPoint | null} */ (null) };
      });
      probe.marks = marks.length;
      probe.canvasHidden = getComputedStyle(box.querySelector('canvas.place-canvas-layer')).visibility === 'hidden';
      for (const pane of linePanes) {
        if (getComputedStyle(pane).opacity !== '0') probe.linesHidden = false;
      }
      const watched = [level.el, ...els];
      for (const el of watched) getComputedStyle(el).transform;
      const runs = document.getAnimations().filter(a => watched.includes(/** @type {any} */ (a.effect)?.target));
      const end = Math.max(0, ...runs.map(a => Number(a.effect?.getComputedTiming().endTime) || 0));
      for (const a of runs) a.pause();
      for (let i = 0; i <= 10; i++) {
        for (const a of runs) a.currentTime = end * i / 10;
        for (const m of marks) {
          const local = map.project(m.ll, tiles._tileZoom).subtract(level.origin);
          const onTiles = matrix(level.el).transformPoint(new DOMPoint(local.x, local.y));
          const at = matrix(m.el);
          const onMark = at.transformPoint(new DOMPoint(m.el.offsetWidth / 2, m.el.offsetHeight / 2));
          m.start = m.start || onMark;
          probe.moved = Math.max(probe.moved, Math.hypot(onMark.x - m.start.x, onMark.y - m.start.y));
          probe.worst = Math.max(probe.worst, Math.hypot(onMark.x - onTiles.x, onMark.y - onTiles.y));
          probe.scale = Math.max(probe.scale, Math.abs(at.a), Math.abs(at.d));
        }
        probe.steps++;
      }
      for (const a of runs) a.play();
    });
    map.once('zoomend', () => {
      probe.after = {
        glide: box.querySelectorAll('.place-glide').length,
        canvasHidden: getComputedStyle(box.querySelector('canvas.place-canvas-layer')).visibility === 'hidden',
        jump: box.classList.contains('map-zoom-jump'),
      };
      probe.done = true;
    });
  });
  // Through the layer's own handler: a demo route runs under the cluster and
  // would take a real tap.
  await page.evaluate(async (/** @type {{ x: number, y: number }} */ at) => {
    const { state } = await import('/app/core.js');
    /** @type {any} */ (state._placeClusterGroup)._onClick({ containerPoint: L.point(at.x, at.y), originalEvent: new MouseEvent('click') });
  }, /** @type {{ x: number, y: number }} */ (tap));
  await page.waitForFunction(() => /** @type {any} */ (window).__zoomProbe.done);

  const probe = await page.evaluate(() => /** @type {any} */ (window).__zoomProbe);
  expect(probe.marks, 'marks on screen glide as their own elements').toBeGreaterThan(0);
  expect(probe.steps).toBe(11);
  expect(probe.canvasHidden, 'the scaled layer canvas hides').toBe(true);
  expect(probe.linesHidden, 'route lines hide').toBe(true);
  expect(probe.moved, 'the zoom moves the marks across the screen').toBeGreaterThan(50);
  expect(probe.worst, 'mark offset from its spot on the tiles, px').toBeLessThan(1.5);
  expect(probe.scale, 'marks keep their size').toBe(1);
  // Registered last, this zoomend runs after the layer has redrawn.
  expect(probe.after).toEqual({ glide: 0, canvasHidden: false, jump: false });
  expect(fenced.errors).toEqual([]);
});
