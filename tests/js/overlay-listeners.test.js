'use strict';
// Runs the filter popover and the map panel's accordion out of the app
// modules against a fake document. ui.js opens and closes both from their
// buttons' aria-controls, and adds its listeners once for the page, so the
// app's part adds none and leaves the clicked panel to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('./app-source');
function fn(name) {
  const m = new RegExp(`^(function ${name}\\([\\s\\S]*?^\\})$`, 'm').exec(app);
  assert.ok(m, `${name} not found in app/`);
  return m[1];
}

// An event target whose listeners can be counted and fired. Removal matches on
// type, function and capture, as the DOM does.
function target(extra) {
  const ls = [];
  const cap = o => !!(typeof o === 'object' && o ? o.capture : o);
  return Object.assign({
    ls,
    addEventListener(type, f, o) {
      if (!ls.some(l => l.type === type && l.f === f && l.cap === cap(o))) ls.push({ type, f, cap: cap(o) });
    },
    removeEventListener(type, f, o) {
      const i = ls.findIndex(l => l.type === type && l.f === f && l.cap === cap(o));
      if (i >= 0) ls.splice(i, 1);
    },
    fire(type, e) { for (const l of ls.slice()) if (l.type === type) l.f(e); },
  }, extra);
}
function element() {
  const kids = [];
  const el = target({
    kids, style: {}, hidden: true, removed: false, attrs: {},
    appendChild(k) { kids.push(k); k.parent = el; return k; },
    remove() { el.removed = true; },
    contains(t) { return t === el || kids.some(k => k.contains(t)); },
    setAttribute(k, v) { el.attrs[k] = v; },
    getBoundingClientRect() { return { width: 100, height: 100 }; },
    classList: { toggle() {} },
  });
  return el;
}

function env() {
  const timers = [];
  const ctx = {
    document: target({ createElement: () => element() }),
    window: target({ innerWidth: 1000, innerHeight: 800 }),
    setTimeout: f => { timers.push(f); },
    console,
    flush() { while (timers.length) timers.shift()(); },
  };
  vm.createContext(ctx);
  return ctx;
}
const count = ctx => ctx.document.ls.length + ctx.window.ls.length;

test('the filter popover adds no document or window listener and leaves the toggle to ui.js', () => {
  const ctx = env();
  const btn = element(), pop = element();
  Object.assign(ctx, { _selPopover: null, closeSelectPopover() {}, openMultiSelectList() {}, t: k => k, btn });
  vm.runInContext(`${fn('wireFilterPopover')}
globalThis.result = wireFilterPopover({ btn, clear: null, sels: [], keyById: {}, filters: {}, onApply() {} });`, ctx);
  assert.equal(ctx.result, undefined);
  ctx.flush();
  assert.equal(count(ctx), 0);
  assert.equal(btn.ls.length, 0);
  assert.equal(pop.hidden, true);
});

// A panel head and the section its aria-controls names.
function panelPart(id) {
  const section = { id, open: false, classList: {
    contains: c => c === 'open' && section.open,
    remove: c => { if (c === 'open') section.open = false; },
  } };
  const head = target({ attrs: { 'aria-controls': id, 'aria-expanded': 'false' },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } });
  return { head, section };
}

function mapPanel() {
  const places = panelPart('places-section'), routes = panelPart('routes-section');
  const status = [];
  const ctx = {
    document: {
      querySelectorAll: sel => (sel === '.panel-head' ? [places.head, routes.head] : []),
      getElementById: id => [places.section, routes.section].find(s => s.id === id) || null,
    },
    renderPanelStatus: a => status.push(a),
    bindFilterClicks() {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${fn('bindFilterPanel')}\nbindFilterPanel();`, ctx);
  return { places, routes, status, click: part => { for (const l of part.head.ls) l.f.call(part.head); } };
}

test('a panel head closes the other section and leaves its own to ui.js', () => {
  const { places, routes, status, click } = mapPanel();
  routes.section.open = true;
  routes.head.attrs['aria-expanded'] = 'true';
  click(places);
  assert.equal(routes.section.open, false);
  assert.equal(routes.head.attrs['aria-expanded'], 'false');
  assert.equal(places.section.open, false, 'ui.js opens it after this listener');
  assert.deepEqual(status, ['places']);
  // The open section's head: the click closes it, so no status row.
  places.section.open = true;
  click(places);
  assert.equal(places.section.open, true, 'ui.js closes it after this listener');
  assert.deepEqual(status, ['places', null]);
});
