// Tapping a cluster zooms and pans at once, more than a level, as a CSS
// transition the compositor runs. The pins must ride that same transition
// (redrawn from script instead, they reach the screen a frame behind the tiles
// and stutter) without growing with it: each one glides at its own size and
// has to land on its place's spot on the tiles at every step. The WebGL route
// layer a phone uses stays unscaled and redraws each frame, placing every
// point where the tiles show it, so its lines keep their width.
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
    const gl = /** @type {HTMLCanvasElement | null} */ (box.querySelector('canvas.gl-routes'));
    const probe = /** @type {any} */ (window).__zoomProbe = {
      marks: 0, steps: 0, worst: 0, moved: 0, scale: 1, canvasHidden: false,
      coarse: matchMedia('(pointer: coarse)').matches, gl: !!gl, glWorst: 0, glScale: 1, ownFrames: 0,
    };
    let stepping = false;
    // The first frame the map's own loop draws, once this probe has let go.
    map.on('zoomframe', () => {
      if (stepping || probe.ownFrames++) return;
      const runs = map.getPane('mapPane').getAnimations({ subtree: true })
        .filter((/** @type {any} */ a) => a.transitionProperty === 'transform');
      probe.ownRuns = runs.length;
      probe.ownInStep = runs.every(a => a.playState === 'paused' && a.currentTime === runs[0].currentTime);
    });
    // A slow CI runner paints only a frame or two of the quarter-second zoom, so
    // the transitions are paused and stepped through fixed points in time
    // instead. Registered after the layer's own handler, this runs once every
    // mark is built, and steps in a later task: right after zoomanim Leaflet
    // moves its zoom and centre to the zoom's end, which the frames must not
    // read. Leaflet's end-of-zoom timer waits while it runs.
    map.once('zoomanim', () => {
      const level = tiles._levels[tiles._tileZoom];
      const els = /** @type {HTMLElement[]} */ ([...box.querySelectorAll('.place-glide > canvas')]);
      const marks = els.map((el, i) => {
        const [lng, lat] = layer._visibleFeatures[i].geometry.coordinates;
        return { el, ll: L.latLng(lat, lng), start: /** @type {DOMPoint | null} */ (null) };
      });
      probe.marks = marks.length;
      probe.canvasHidden = getComputedStyle(box.querySelector('canvas.place-canvas-layer')).visibility === 'hidden';
      // The route layer's shader maps a point p at its reference zoom to
      // uHalfSize + (p - origin + uOriginDelta) * uScale, origin being the map
      // centre at its last rebuild, which is where the map still stands.
      const ctx = gl && /** @type {WebGLRenderingContext} */ (gl.getContext('webgl'));
      const prog = ctx && ctx.getParameter(ctx.CURRENT_PROGRAM);
      const uniform = (/** @type {string} */ n) => ctx.getUniform(prog, ctx.getUniformLocation(prog, n));
      const origin = map.project(map.getCenter(), 20);
      const panePos = map._getMapPanePos();
      setTimeout(() => {
        // Every transform transition in the map, as the map's own frame loop
        // steps them, the route layer's probe among them.
        for (const el of [level.el, ...els]) getComputedStyle(el).transform;
        const runs = map.getPane('mapPane').getAnimations({ subtree: true })
          .filter((/** @type {any} */ a) => a.transitionProperty === 'transform');
        const end = Math.max(0, ...runs.map(a => Number(a.effect?.getComputedTiming().endTime) || 0));
        for (const a of runs) a.pause();
        stepping = true;
        for (let i = 0; i <= 10; i++) {
          for (const a of runs) a.currentTime = end * i / 10;
          map.fire('zoomframe');
          for (const m of marks) {
            const local = map.project(m.ll, tiles._tileZoom).subtract(level.origin);
            const onTiles = matrix(level.el).transformPoint(new DOMPoint(local.x, local.y));
            const at = matrix(m.el);
            const onMark = at.transformPoint(new DOMPoint(m.el.offsetWidth / 2, m.el.offsetHeight / 2));
            m.start = m.start || onMark;
            probe.moved = Math.max(probe.moved, Math.hypot(onMark.x - m.start.x, onMark.y - m.start.y));
            probe.worst = Math.max(probe.worst, Math.hypot(onMark.x - onTiles.x, onMark.y - onTiles.y));
            probe.scale = Math.max(probe.scale, Math.abs(at.a), Math.abs(at.d));
            if (ctx) {
              const p = map.project(m.ll, 20);
              const s = uniform('uScale'), d = uniform('uOriginDelta'), h = uniform('uHalfSize');
              const onGl = { x: h[0] + (p.x - origin.x + d[0]) * s, y: h[1] + (p.y - origin.y + d[1]) * s };
              probe.glWorst = Math.max(probe.glWorst, Math.hypot(onGl.x - (onTiles.x + panePos.x), onGl.y - (onTiles.y + panePos.y)));
            }
          }
          if (gl) probe.glScale = Math.max(probe.glScale, Math.abs(matrix(gl).a));
          probe.steps++;
        }
        stepping = false;
        for (const a of runs) a.play();
      });
    });
    map.once('zoomend', () => {
      probe.after = {
        glide: box.querySelectorAll('.place-glide').length,
        canvasHidden: getComputedStyle(box.querySelector('canvas.place-canvas-layer')).visibility === 'hidden',
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
  expect(probe.moved, 'the zoom moves the marks across the screen').toBeGreaterThan(50);
  expect(probe.worst, 'mark offset from its spot on the tiles, px').toBeLessThan(1.5);
  expect(probe.scale, 'marks keep their size').toBe(1);
  // A phone draws routes on WebGL and steps the zoom itself for them; a
  // desktop browser keeps SVG routes and the browser's own transitions.
  expect(probe.gl).toBe(probe.coarse);
  expect(probe.ownFrames > 0, 'the map steps the zoom itself').toBe(probe.gl);
  if (probe.gl) {
    expect(probe.ownRuns, 'tiles, marks and probe transitions').toBeGreaterThan(2);
    expect(probe.ownInStep, 'every transition held at one time').toBe(true);
  }
  expect(probe.glWorst, 'WebGL route offset from the tiles, px').toBeLessThan(1.5);
  expect(probe.glScale, 'the WebGL route canvas stays unscaled').toBe(1);
  // Registered last, this zoomend runs after the layer has redrawn.
  expect(probe.after).toEqual({ glide: 0, canvasHidden: false });
  expect(fenced.errors).toEqual([]);
});
