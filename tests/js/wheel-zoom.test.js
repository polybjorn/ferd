'use strict';
// Runs the wheel classification straight out of the app modules, between the
// WHEEL-ZOOM markers, since the zoom loop itself needs a real map.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
const m = /WHEEL-ZOOM-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ WHEEL-ZOOM-END/.exec(app);
assert.ok(m, 'WHEEL-ZOOM markers not found in app/');

const env = { L: { DomEvent: { getWheelDelta: (e) => -e.deltaY / 6 } } };
vm.createContext(env);
vm.runInContext(m[1] + '\nglobalThis.w = { isWheelNotch, wheelZoomStep };', env);
const { isWheelNotch, wheelZoomStep } = env.w;

test('line-mode wheel is a notch whatever its size', () => {
  assert.equal(wheelZoomStep({ deltaMode: 1, deltaY: 3 }), -0.5);
  assert.equal(wheelZoomStep({ deltaMode: 1, deltaY: -1 }), 0.5);
});

test('Chromium mouse notch in pixel mode is a notch', () => {
  assert.equal(isWheelNotch({ deltaMode: 0, deltaY: 100, wheelDeltaY: -120 }), true);
});

test('trackpad landing on a multiple of 120 stays a trackpad', () => {
  assert.equal(isWheelNotch({ deltaMode: 0, deltaY: 40, wheelDeltaY: -120 }), false);
});

test('trackpad zoom scales with distance', () => {
  assert.equal(wheelZoomStep({ deltaMode: 0, deltaY: 12, wheelDeltaY: -36 }), -12 / 6 * 0.0045);
});

test('a horizontal line-mode scroll does not zoom', () => {
  assert.equal(Math.abs(wheelZoomStep({ deltaMode: 1, deltaY: 0 })), 0);
});
