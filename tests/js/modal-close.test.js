'use strict';
// Runs the real closeOnBackdropClick and showErrorBox out of index.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
function fn(name) {
  const m = new RegExp(`^( {4}function ${name}\\([\\s\\S]*?^ {4}\\})$`, 'm').exec(html);
  assert.ok(m, `${name} not found in index.html`);
  return m[1];
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${fn('closeOnBackdropClick')}\n${fn('showErrorBox')}\nglobalThis.__g = { closeOnBackdropClick, showErrorBox };`, ctx);
const { closeOnBackdropClick, showErrorBox } = ctx.__g;

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

test('an error box shows its message and scrolls into view', () => {
  const calls = [];
  const el = {
    textContent: '',
    classList: { add: c => calls.push(c) },
    scrollIntoView: o => calls.push(o.block),
  };
  showErrorBox(el, 'Save failed');
  assert.equal(el.textContent, 'Save failed');
  assert.deepEqual(calls, ['visible', 'nearest']);
});
