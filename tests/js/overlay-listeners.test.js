'use strict';
// Runs the real filter popover out of the app modules against a fake document
// and window that count listeners, and checks that every way of closing it
// leaves none behind. The context menu closes through ui.js, which adds its
// listeners once for the page.
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
const outsideEl = element();

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

function filterPopover() {
  const ctx = env();
  Object.assign(ctx, {
    closeTransientOverlays() {}, _selPopover: null, closeSelectPopover() {}, openMultiSelectList() {},
    btn: element(), pop: element(),
  });
  vm.runInContext(`${fn('wirePopover')}
${fn('wireFilterPopover')}
globalThis.cleanup = wireFilterPopover({ btn, pop, clear: null, sels: [], keyById: {}, filters: {}, onApply() {} });`, ctx);
  return ctx;
}

test('the filter popover returns a cleanup that removes its document listener', () => {
  const ctx = filterPopover();
  assert.equal(typeof ctx.cleanup, 'function');
  assert.equal(ctx.document.ls.length, 2);
  ctx.btn.fire('click', { stopPropagation() {} });
  assert.equal(ctx.pop.hidden, false);
  ctx.btn.fire('click', { stopPropagation() {} });
  assert.equal(ctx.pop.hidden, true);
  ctx.btn.fire('click', { stopPropagation() {} });
  ctx.document.fire('click', { target: outsideEl });
  assert.equal(ctx.pop.hidden, true);
  ctx.cleanup();
  assert.equal(count(ctx), 0);
});

test('the Browse tab returns the filter popover cleanup from its effect', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'add', 'browse.js'), 'utf8');
  assert.match(src, /return wireFilterPopover\(\{/);
});

test('Escape closes the filter popover and hands focus back', () => {
  const ctx = filterPopover();
  ctx.btn.focus = function() { this.focused = true; };
  ctx.btn.fire('click', { stopPropagation() {} });
  assert.equal(ctx.pop.hidden, false);
  let stopped = false;
  ctx.document.fire('keydown', { key: 'Escape', stopPropagation() { stopped = true; } });
  assert.equal(ctx.pop.hidden, true);
  assert.equal(stopped, true);
  assert.equal(ctx.btn.focused, true);
  // An open themed select list takes the key and leaves the popover open.
  ctx.btn.fire('click', { stopPropagation() {} });
  ctx._selPopover = {};
  ctx.document.fire('keydown', { key: 'Escape', stopPropagation() {} });
  assert.equal(ctx.pop.hidden, false);
  ctx._selPopover = null;
  ctx.document.fire('keydown', { key: 'ArrowDown', stopPropagation() {} });
  assert.equal(ctx.pop.hidden, false);
});
