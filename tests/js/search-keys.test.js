'use strict';
// Drives bindSearchKeys, which both map search views use, by keyboard over a
// small stand-in for the DOM, in the shape each view renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('./app-source');
const src = /^(function bindSearchKeys\([\s\S]*?^\})$/m.exec(app);
assert.ok(src, 'bindSearchKeys not found in app/');

class El {
  constructor(attrs = {}, children = []) {
    this.attrs = { ...attrs };
    this.children = children;
    this.id = attrs.id || '';
    this.classes = new Set();
    this.listeners = {};
    this.classList = {
      add: c => this.classes.add(c),
      remove: c => this.classes.delete(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  scrollIntoView() {}
  querySelectorAll(sel) {
    assert.equal(sel, '[role="option"]');
    const out = [];
    const walk = el => el.children.forEach(c => { if (c.attrs.role === 'option') out.push(c); walk(c); });
    walk(this);
    return out;
  }
  key(key) {
    const e = { key, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    (this.listeners.keydown || []).forEach(fn => fn(e));
    return e;
  }
}

function bind(listbox, on) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src[1]}\nglobalThis.bindSearchKeys = bindSearchKeys;`, ctx);
  const input = new El();
  const keys = ctx.bindSearchKeys(input, listbox, on);
  return { input, keys };
}
const option = name => new El({ role: 'option', 'data-name': name });

// The panel's list holds its rows directly.
function desktop() {
  const rows = ['Louvre', 'Preikestolen', 'Hardangervidda'].map(option);
  return { rows, listbox: new El({ id: 'map-search-results', role: 'listbox' }, rows) };
}
// The phone's list holds the Recent heading and Clear button, then a listbox
// of headed groups.
function phone() {
  const places = ['Louvre', 'Preikestolen'].map(option);
  const routes = [option('Coast path')];
  const box = new El({ id: 'map-search-view-options', role: 'listbox' },
    [new El({ role: 'group' }, [new El(), ...places]), new El({ role: 'group' }, [new El(), ...routes])]);
  const list = new El({ id: 'map-search-view-list' }, [new El({}, [new El({ role: 'button' })]), box]);
  return { rows: [...places, ...routes], listbox: list };
}

for (const [view, make, controls] of [['desktop', desktop, 'map-search-results'], ['phone', phone, 'map-search-view-options']]) {
  test(`${view}: the field is a combobox that names its listbox`, () => {
    const { listbox } = make();
    const { input, keys } = bind(listbox, { pick() {}, controls: view === 'phone' ? controls : undefined });
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-controls'), controls);
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    keys.refresh(true);
    assert.equal(input.getAttribute('aria-expanded'), 'true');
  });

  test(`${view}: arrow keys walk the rows and Enter picks the active one`, () => {
    const { rows, listbox } = make();
    const picked = [];
    const { input, keys } = bind(listbox, { pick: r => picked.push(r) });
    keys.refresh(true);
    assert.ok(rows.every((r, i) => r.id === listbox.id + '-' + i), 'every row has its own id');
    assert.equal(input.key('ArrowDown').defaultPrevented, true);
    input.key('ArrowDown');
    assert.equal(input.getAttribute('aria-activedescendant'), rows[1].id);
    assert.deepEqual(rows.map(r => r.classes.has('active')), rows.map((_, i) => i === 1));
    assert.equal(input.key('Enter').defaultPrevented, true);
    assert.deepEqual(picked, [rows[1]]);
  });

  test(`${view}: ArrowUp from the field wraps to the last row`, () => {
    const { rows, listbox } = make();
    const { input, keys } = bind(listbox, { pick() {} });
    keys.refresh(true);
    input.key('ArrowUp');
    assert.equal(input.getAttribute('aria-activedescendant'), rows[rows.length - 1].id);
    input.key('ArrowDown');
    assert.equal(input.getAttribute('aria-activedescendant'), rows[0].id);
  });

  test(`${view}: Enter with no active row and keys on a closed list do nothing`, () => {
    const { rows, listbox } = make();
    const picked = [];
    const { input, keys } = bind(listbox, { pick: r => picked.push(r) });
    keys.refresh(true);
    assert.equal(input.key('Enter').defaultPrevented, false);
    keys.refresh(false);
    assert.equal(input.key('ArrowDown').defaultPrevented, false);
    assert.equal(input.getAttribute('aria-activedescendant'), null);
    assert.equal(rows.some(r => r.classes.has('active')), false);
    assert.deepEqual(picked, []);
  });
}

test('Escape closes an open list and stops there', () => {
  const { listbox } = desktop();
  let closed = 0;
  const { input, keys } = bind(listbox, { pick() {}, close: () => { closed++; } });
  keys.refresh(true);
  const e = input.key('Escape');
  assert.equal(closed, 1);
  assert.ok(e.defaultPrevented && e.stopped);
});

test('with no close of its own, Escape is left to the modal', () => {
  const { listbox } = phone();
  const { input, keys } = bind(listbox, { pick() {} });
  keys.refresh(true);
  const e = input.key('Escape');
  assert.ok(!e.defaultPrevented && !e.stopped);
});

test('a new render starts again from the field', () => {
  const { rows, listbox } = desktop();
  const { input, keys } = bind(listbox, { pick() {} });
  keys.refresh(true);
  input.key('ArrowDown');
  keys.refresh(true);
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  input.key('ArrowDown');
  assert.equal(input.getAttribute('aria-activedescendant'), rows[0].id);
});
