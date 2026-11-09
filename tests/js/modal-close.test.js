'use strict';
// Runs the real closeOnBackdropClick and requestCloseTopModal out of the app
// modules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
function fn(name) {
  const m = new RegExp(`^(function ${name}\\([\\s\\S]*?^\\})$`, 'm').exec(app);
  assert.ok(m, `${name} not found in app/`);
  return m[1];
}
const ctx = { modalStack: [] };
vm.createContext(ctx);
vm.runInContext(`${fn('closeOnBackdropClick')}\n${fn('requestCloseTopModal')}\n${fn('escClose')}\nglobalThis.__g = { requestCloseTopModal, closeOnBackdropClick, escClose };`, ctx);
const { closeOnBackdropClick, requestCloseTopModal, escClose } = ctx.__g;

function dialog() {
  const d = { closes: 0, on: {}, addEventListener(type, f) { this.on[type] = f; } };
  closeOnBackdropClick(d, () => { d.closes += 1; });
  return d;
}
const inside = { tagName: 'INPUT' };

test('a press and release on the backdrop closes', () => {
  const d = dialog();
  d.on.pointerdown({ target: d });
  d.on.click({ target: d });
  assert.equal(d.closes, 1);
});

test('a drag from a control that ends on the dialog does not close', () => {
  const d = dialog();
  d.on.pointerdown({ target: inside });
  d.on.click({ target: d });
  assert.equal(d.closes, 0);
});

test('a click on a control does not close', () => {
  const d = dialog();
  d.on.pointerdown({ target: inside });
  d.on.click({ target: inside });
  assert.equal(d.closes, 0);
});

test('a backdrop press does not arm a later drag', () => {
  const d = dialog();
  d.on.pointerdown({ target: d });
  d.on.pointerdown({ target: inside });
  d.on.click({ target: d });
  assert.equal(d.closes, 0);
});

test('a close request goes to the top modal and reports that it did', () => {
  const closed = [];
  ctx.modalStack.push({ onClose: () => closed.push('below') }, { onClose: () => closed.push('top') });
  assert.equal(requestCloseTopModal(), true);
  assert.deepEqual(closed, ['top']);
  ctx.modalStack.length = 0;
});

test('Escape a popover in the dialog already took leaves the dialog open', () => {
  const closed = [];
  ctx.modalStack.push({ onClose: () => closed.push('top') });
  try {
    let prevented = false;
    escClose({ key: 'Escape', defaultPrevented: true, preventDefault() { prevented = true; } });
    assert.deepEqual(closed, []);
    escClose({ key: 'Escape', defaultPrevented: false, preventDefault() { prevented = true; } });
    assert.deepEqual(closed, ['top']);
    assert.equal(prevented, true);
  } finally {
    ctx.modalStack.length = 0;
  }
});

test('a close request with no modal open reports false, so the app can go back', () => {
  assert.equal(requestCloseTopModal(), false);
});

test('the Android app calls the name the page exposes', () => {
  const activity = fs.readFileSync(path.join(__dirname, '..', '..',
    'android/app/src/main/java/io/github/polybjorn/ferd/MainActivity.kt'), 'utf8');
  assert.match(app, /window\.ferdCloseTopModal = requestCloseTopModal;/);
  assert.match(activity, /window\.ferdCloseTopModal\(\)/);
});
