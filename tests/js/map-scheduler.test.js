'use strict';
// Runs mapScheduler straight out of index.html, between the MAP-SCHEDULER
// markers, against a stand-in map whose remove() behaves like Leaflet 1.9's:
// it fires 'unload', then deletes the map pane that every position read uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const m = /MAP-SCHEDULER-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ MAP-SCHEDULER-END/.exec(html);
assert.ok(m, 'MAP-SCHEDULER markers not found in index.html');

function makeEnv() {
  let now = 0, nextId = 1;
  const pending = new Map(); // id -> { at, fn }
  const env = {
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    requestAnimationFrame: (fn) => { const id = nextId++; pending.set(id, { at: now + 16, fn: () => fn(now) }); return id; },
    cancelAnimationFrame: (id) => { pending.delete(id); },
  };
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
  vm.runInContext(m[1] + '\nglobalThis.mapScheduler = mapScheduler;', env);
  return env;
}

function makeMap(env) {
  const handlers = {};
  const map = {
    _mapPane: { _leaflet_pos: { x: 0, y: 0 } },
    _animatingZoom: false,
    once(type, fn) { (handlers[type] = handlers[type] || []).push(fn); return this; },
    fire(type) { const fns = handlers[type] || []; delete handlers[type]; fns.forEach((fn) => fn()); },
    panePos() { return this._mapPane._leaflet_pos; }, // throws once removed, as Leaflet does
    // Leaflet's _animateZoom: an untracked timeout ends the animation and moves.
    animateZoom() {
      this._animatingZoom = true;
      env.setTimeout(() => { if (this._animatingZoom) { this._animatingZoom = false; this.panePos(); } }, 250);
    },
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

test('the vendored Leaflet still gates its zoom transition end on _animatingZoom', () => {
  // The cancel above relies on this guard; a Leaflet upgrade that drops it
  // has to revisit mapScheduler.
  const leaflet = fs.readFileSync(path.join(root, 'vendor', 'leaflet', 'leaflet.js'), 'utf8');
  assert.match(leaflet, /_onZoomTransitionEnd:function\(\)\{this\._animatingZoom&&/);
});
