'use strict';
// Runs mapScheduler straight out of the app modules, between the MAP-SCHEDULER
// markers, against a stand-in map whose remove() behaves like Leaflet 1.9's:
// it fires 'unload', then deletes the map pane that every position read uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const app = require('./app-source');
const m = /MAP-SCHEDULER-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ MAP-SCHEDULER-END/.exec(app);
assert.ok(m, 'MAP-SCHEDULER markers not found in app/');

function functionSource(name) {
  const fn = new RegExp('\\nfunction ' + name + '\\([^\\n]*\\n[\\s\\S]*?\\n\\}\\n').exec(app);
  assert.ok(fn, name + ' not found in app/');
  return fn[0];
}

function makeEnv() {
  let now = 0, nextId = 1;
  const pending = new Map(); // id -> { at, fn }
  const env = {
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    requestAnimationFrame: (fn) => { const id = nextId++; pending.set(id, { at: now + 16, fn: () => fn(now) }); return id; },
    cancelAnimationFrame: (id) => { pending.delete(id); },
    performance: { now: () => now },
    window: { matchMedia: () => ({ matches: false }) },
    strokeAdjusts: 0,
    adjustTrailStrokes: () => { env.strokeAdjusts++; },
    // One SVG route path, for the per-frame width hold through a zoom.
    strokeWrites: 0,
    getComputedStyle: () => ({ transform: 'matrix(2, 0, 0, 2, 0, 0)' }),
    DOMMatrixReadOnly: class { constructor(t) { this.a = parseFloat(String(t).slice(7)); } },
  };
  const style = {};
  Object.defineProperty(style, 'strokeWidth', { set() { env.strokeWrites++; }, get() { return ''; } });
  const routePath = { style, getAttribute: (name) => (name === 'stroke-width' ? '4' : null) };
  env.state = { _routeRenderer: { _container: { querySelectorAll: () => [routePath], contains: () => true } } };
  env.advance = (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, job] of pending) if (job.at <= end && (!next || job.at < next[1].at)) next = [id, job];
      if (!next) break;
      pending.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  vm.createContext(env);
  vm.runInContext(m[1] + '\n' + functionSource('bindTrailStrokeMotion') +
    '\nglobalThis.mapScheduler = mapScheduler;\nglobalThis.bindTrailStrokeMotion = bindTrailStrokeMotion;', env);
  return env;
}

function makeMap(env) {
  const handlers = {}, listeners = {};
  const map = {
    _mapPane: { _leaflet_pos: { x: 0, y: 0 } },
    _animatingZoom: false,
    once(type, fn) { (handlers[type] = handlers[type] || []).push(fn); return this; },
    on(types, fn) { types.split(' ').forEach((t) => (listeners[t] = listeners[t] || []).push(fn)); return this; },
    emit(type) { (listeners[type] || []).forEach((fn) => fn()); },
    getZoom() { return 5; },
    fire(type) { const fns = handlers[type] || []; delete handlers[type]; fns.forEach((fn) => fn()); },
    panePos() { return this._mapPane._leaflet_pos; }, // throws once removed, as Leaflet does
    // Leaflet's _animateZoom: an untracked timeout ends the animation and moves.
    animateZoom() {
      this._animatingZoom = true;
      env.setTimeout(() => { if (this._animatingZoom) { this._animatingZoom = false; this.panePos(); } }, 250);
    },
    // Leaflet's guard checks _loaded, which remove() leaves set.
    invalidateSize() { this.panePos(); return this; },
    remove() { this.fire('unload'); delete this._mapPane; },
  };
  return map;
}

test('a timeout scheduled on a removed map does not run', () => {
  const env = makeEnv();
  const map = makeMap(env);
  const sched = env.mapScheduler(map);
  let ran = 0;
  sched.timeout(() => { ran++; map.panePos(); }, 150);
  map.remove();
  env.advance(1000);
  assert.equal(ran, 0);
});

test('an animation frame scheduled on a removed map does not run', () => {
  const env = makeEnv();
  const map = makeMap(env);
  const sched = env.mapScheduler(map);
  let ran = 0;
  const tick = () => { ran++; map.panePos(); sched.frame(tick); };
  sched.frame(tick);
  env.advance(40);
  const before = ran;
  assert.ok(before > 0);
  map.remove();
  env.advance(1000);
  assert.equal(ran, before);
});

test('work scheduled after removal is refused', () => {
  const env = makeEnv();
  const map = makeMap(env);
  const sched = env.mapScheduler(map);
  map.remove();
  let ran = 0;
  assert.equal(sched.timeout(() => ran++, 10), 0);
  assert.equal(sched.frame(() => ran++), 0);
  env.advance(1000);
  assert.equal(ran, 0);
});

test('work on a live map still runs, and can be cancelled', () => {
  const env = makeEnv();
  const map = makeMap(env);
  const sched = env.mapScheduler(map);
  let ran = 0;
  sched.timeout(() => ran++, 150);
  const cancelled = sched.timeout(() => ran++, 150);
  sched.clearTimeout(cancelled);
  env.advance(200);
  assert.equal(ran, 1);
});

test("removing a map mid-zoom cancels Leaflet's zoom transition end", () => {
  const env = makeEnv();
  const map = makeMap(env);
  env.mapScheduler(map);
  map.animateZoom();
  map.remove();
  assert.doesNotThrow(() => env.advance(1000));
});

test('removing a map mid-zoom stops its stroke width frames', () => {
  const env = makeEnv();
  const map = makeMap(env);
  env.bindTrailStrokeMotion(map);
  map._animatingZoom = true;
  map.emit('zoomanim');
  env.advance(40);
  const before = env.strokeWrites;
  assert.ok(before > 1);
  map.remove();
  env.advance(1000);
  assert.equal(env.strokeWrites, before);
});

test('the route detail map has a scheduler and no frames outside it', () => {
  // A map without one keeps Leaflet's zoom transition end alive past removal.
  const detail = functionSource('renderTrailDetail');
  assert.match(detail, /mapScheduler\(map\)/);
  assert.doesNotMatch(detail, /requestAnimationFrame/);
});

test('a continuation wrapped by live() does nothing once the map is removed', () => {
  const env = makeEnv();
  const map = makeMap(env);
  const sched = env.mapScheduler(map);
  const seen = [];
  const early = sched.live((v) => seen.push(v));
  const late = sched.live((v) => seen.push(v));
  early('before');
  map.remove();
  late('after');
  early('after');
  assert.deepEqual(seen, ['before']);
});

test('every GPX load on the route detail map goes through live()', () => {
  // A fetch promise can't be cancelled, so each continuation has to check.
  for (const name of ['renderTrailDetail', 'renderSingleTrack', 'renderMultiTrack']) {
    const src = functionSource(name);
    const loads = (src.match(/fetchGpxText\(/g) || []).length;
    assert.ok(loads > 0, name + ' no longer loads a GPX');
    assert.equal((src.match(/\.then\(sched\.live\(/g) || []).length, loads, name);
  }
  // L.GPX parses in a later task, so its events can also land after removal.
  for (const name of ['renderTrailDetail', 'renderSingleTrack']) {
    const src = functionSource(name);
    assert.equal((src.match(/\.on\('(?:loaded|addline)', /g) || []).length,
      (src.match(/\.on\('(?:loaded|addline)', sched\.live\(/g) || []).length, name);
  }
});

test('a late invalidateSize on a removed map does nothing', () => {
  // leaflet-elevation's _initChart resizes the map once its chart module has
  // loaded, which can land after the route page removed the map.
  const env = makeEnv();
  const map = makeMap(env);
  env.mapScheduler(map);
  map.invalidateSize();
  map.remove();
  assert.doesNotThrow(() => map.invalidateSize());
  assert.equal(map.invalidateSize(), map);
});

test('the vendored Leaflet and leaflet-elevation still need the invalidateSize guard', () => {
  // If either changes, the override in mapScheduler's unload may be moot.
  const leaflet = fs.readFileSync(path.join(root, 'vendor', 'leaflet', 'leaflet.js'), 'utf8');
  assert.match(leaflet, /invalidateSize:function\(t\)\{if\(!this\._loaded\)return this;/);
  const elev = fs.readFileSync(path.join(root, 'vendor', 'leaflet-elevation', 'leaflet-elevation.js'), 'utf8');
  const init = /\n    _initChart\(container\) \{[\s\S]*?\n    \},\n/.exec(elev);
  assert.ok(init, '_initChart not found in leaflet-elevation.js');
  assert.match(init[0], /\.then\([\s\S]*map\.invalidateSize\(\);/);
});

test('the vendored Leaflet still gates its zoom transition end on _animatingZoom', () => {
  // The cancel above relies on this guard; a Leaflet upgrade that drops it
  // has to revisit mapScheduler.
  const leaflet = fs.readFileSync(path.join(root, 'vendor', 'leaflet', 'leaflet.js'), 'utf8');
  assert.match(leaflet, /_onZoomTransitionEnd:function\(\)\{this\._animatingZoom&&/);
});
