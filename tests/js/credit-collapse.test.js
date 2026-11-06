'use strict';
// Runs the real collapseCreditOnPhone out of index.html against a fake map.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const source = /^ {4}function collapseCreditOnPhone\([\s\S]*?^ {4}\}$/m.exec(html)[0];

function element(extra) {
  return {
    on: {},
    addEventListener(type, f) { this.on[type] = f; },
    setAttribute() {},
    ...extra,
  };
}

function setup() {
  const classes = new Set();
  const link = element({ focused: false, focus() { this.focused = true; } });
  const credit = element({
    parentElement: {},
    contains: t => t === credit || t === link,
    querySelector: () => link,
  });
  const toggle = element();
  const container = element({
    querySelector: () => credit,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
  });
  const timers = [];
  const ctx = {
    L: {
      DomUtil: { create: () => toggle },
      DomEvent: { disableClickPropagation() {} },
    },
    setTimeout: (f, ms) => { timers.push({ f, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: id => { timers[id].cleared = true; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${source}\nglobalThis.run = collapseCreditOnPhone;`, ctx);
  const unload = [];
  ctx.run({ getContainer: () => container, on: (type, f) => unload.push(f) });
  return {
    container, credit, link, toggle, timers, unload,
    collapsed: () => classes.has('credit-collapsed'),
  };
}

test('the credit stays open on load and collapses after five seconds', () => {
  const s = setup();
  assert.equal(s.collapsed(), false);
  assert.equal(s.timers[0].ms, 5000);
  s.timers[0].f();
  assert.equal(s.collapsed(), true);
});

test('touching the map collapses the credit and stops the timer', () => {
  const s = setup();
  s.container.on.pointerdown({ target: {} });
  assert.equal(s.collapsed(), true);
  assert.equal(s.timers[0].cleared, true);
});

test('touching the credit leaves it open, so its links work', () => {
  const s = setup();
  s.container.on.pointerdown({ target: s.link });
  assert.equal(s.collapsed(), false);
});

test('the button reopens the credit until the next touch of the map', () => {
  const s = setup();
  s.container.on.pointerdown({ target: {} });
  s.container.on.pointerdown({ target: s.toggle });
  s.toggle.on.click();
  assert.equal(s.collapsed(), false);
  assert.equal(s.link.focused, true);
  assert.equal(s.timers.length, 1);
  s.container.on.pointerdown({ target: {} });
  assert.equal(s.collapsed(), true);
});

test('leaving the map stops the timer', () => {
  const s = setup();
  s.unload[0]();
  assert.equal(s.timers[0].cleared, true);
});
