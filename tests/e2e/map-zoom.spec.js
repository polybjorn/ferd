// Tapping a cluster zooms and pans at once, more than a level. The zoom is
// Leaflet's CSS transition, which the phone runs on its compositor; a layer
// redrawn from script each frame would trail it. Each mark glides on that same
// transition as its own small canvas, at its own size, and lands where the
// redrawn canvas puts it.
const { test, expect } = require('@playwright/test');
const { fence, signIn } = require('./helpers');

test('a cluster zoom glides each mark on the tiles\' own transition at its own size', async ({ page, baseURL }) => {
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
      from: map.getZoom(), zoomanim: 0, gliders: 0, scale: 1, hidden: false, ends: /** @type {number[][]} */ ([]),
    };
    const glCanvas = /** @type {HTMLCanvasElement | null} */ (box.querySelector('canvas.gl-routes'));
    // WebGL draws the routes on phones only; desktop keeps them in SVG.
    const gl = box.classList.contains('gl-routes-active') && glCanvas && glCanvas.getContext('webgl');
    /** @param {string} name */
    const uniform = name => {
      if (!gl) return 1;
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      return program ? gl.getUniform(program, gl.getUniformLocation(program, name)) : 1;
    };
    const lineWidth = () => uniform('uWidth');
    probe.gl = !!gl;
    probe.scaleBefore = uniform('uScale');
    probe.widths = /** @type {number[]} */ ([]);
    probe.scales = /** @type {number[]} */ ([]);
    // Desktop draws routes in SVG, which the transition scales with the tiles.
    const svgPath = /** @type {SVGPathElement | null} */ (gl ? null : box.querySelector('.leaflet-overlay-pane svg path[stroke-width]'));
    probe.svgWidth = svgPath ? parseFloat(svgPath.getAttribute('stroke-width') || '') : 0;
    probe.svgShown = /** @type {number[]} */ ([]);
    const sample = () => {
      if (map._animatingZoom) { probe.widths.push(lineWidth()); probe.scales.push(uniform('uScale')); }
      if (map._animatingZoom && svgPath) {
        const svg = /** @type {Element} */ (svgPath.ownerSVGElement);
        probe.svgShown.push(new DOMMatrixReadOnly(getComputedStyle(svg).transform).a * parseFloat(getComputedStyle(svgPath).strokeWidth));
      }
      if (!probe.done) requestAnimationFrame(sample);
    };
    // Registered after the place layer's own handler, so its gliders are out.
    map.on('zoomanim', () => {
      requestAnimationFrame(sample);
      probe.zoomanim++;
      const gliders = [...box.querySelectorAll('canvas.place-glider')];
      probe.gliders = gliders.length;
      probe.scale = Math.max(1, ...gliders.map(scaleOf));
      probe.glides = gliders.every(el => getComputedStyle(el).transitionDuration === '0.25s');
      probe.hidden = getComputedStyle(/** @type {Element} */ (box.querySelector('canvas.place-canvas-layer'))).visibility === 'hidden';
      // At the transition's first instant a glider still shows where it starts.
      const from = map.latLngToContainerPoint([tap.lat, tap.lng]);
      const mapBox = box.getBoundingClientRect();
      probe.started = gliders.some(el => {
        const r = el.getBoundingClientRect();
        const dx = from.x - (r.left - mapBox.left), dy = from.y - (r.top - mapBox.top);
        return Math.abs(dx - dy) < 0.5 && dx > 10 && dx < 60;
      });
      probe.ends = gliders.map(el => { const m = new DOMMatrixReadOnly(/** @type {HTMLElement} */ (el).style.transform); return [m.e, m.f]; });
    });
    map.once('zoomend', () => {
      probe.to = map.getZoom();
      probe.widthAfter = lineWidth();
      const end = map.latLngToLayerPoint([tap.lat, tap.lng]);
      // A glider's corner sits the same distance up and left of its mark.
      probe.landed = probe.ends.some((/** @type {number[]} */ [x, y]) => Math.abs((end.x - x) - (end.y - y)) < 0.5 && end.x - x > 10 && end.x - x < 60);
      probe.left = box.querySelectorAll('canvas.place-glider').length;
      probe.shown = getComputedStyle(/** @type {Element} */ (box.querySelector('canvas.place-canvas-layer'))).visibility !== 'hidden';
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
  expect(probe.zoomanim, 'one CSS zoom transition').toBe(1);
  expect(probe.gliders, 'a glider per mark in view').toBeGreaterThan(0);
  expect(probe.scale, 'gliders stay unscaled').toBe(1);
  expect(probe.glides, 'gliders take the tiles\' transition').toBe(true);
  expect(probe.hidden, 'the place canvas hides while the marks glide').toBe(true);
  expect(probe.started, 'the tapped cluster glides from where it was drawn').toBe(true);
  expect(probe.landed, 'the tapped cluster glides to where it ends').toBe(true);
  if (probe.gl) {
    expect(Math.min(...probe.widths), 'route lines are drawn thinner as the canvas grows').toBeLessThan(1);
    expect(probe.widthAfter, 'and at their own width once the zoom ends').toBe(1);
    // The canvas transition scales the lines, so a redraw must not scale them again.
    expect(probe.scales.every((/** @type {number} */ s) => s === probe.scaleBefore), 'mid-zoom redraws keep the starting view').toBe(true);
  }
  if (probe.svgShown.length) {
    expect(Math.max(...probe.svgShown.map((/** @type {number} */ w) => Math.abs(w - probe.svgWidth))), 'SVG route lines keep their width on screen through the zoom').toBeLessThan(0.5);
  }
  expect(probe.left, 'gliders are gone once the zoom ends').toBe(0);
  expect(probe.shown, 'the place canvas is back').toBe(true);
  expect(probe.offCentre, 'the cluster ends at the centre, px').toBeLessThan(1);
  expect(fenced.errors).toEqual([]);
});
