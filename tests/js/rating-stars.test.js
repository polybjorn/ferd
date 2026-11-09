'use strict';
// ratingStars returns a view, so the empty stars are a real span rather than
// markup set as HTML, and no caller needs dangerouslySetInnerHTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
const VENDOR = path.join(__dirname, '..', '..', 'vendor');
const m = /function ratingStars\([\s\S]*?\n}/.exec(app);
assert.ok(m, 'ratingStars not found in app/');

// htm bound to an h that builds the markup string, which is enough for a
// template of plain elements and text.
const flat = c => (Array.isArray(c) ? c.map(flat).join('') : c == null || c === false ? '' : String(c));
const h = (type, props, ...children) => {
  const attrs = Object.entries(props || {}).map(([k, v]) => ` ${k}="${v}"`).join('');
  return `<${type}${attrs}>${flat(children)}</${type}>`;
};

async function stars() {
  const { default: htm } = await import(path.join(VENDOR, 'htm', 'htm.js'));
  const ctx = { html: htm.bind(h) };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nglobalThis.__stars = ratingStars;', ctx);
  return r => flat(ctx.__stars(r));
}

test('a partial rating fades the empty stars', async () => {
  const s = await stars();
  assert.equal(s(3), '★★★<span class="stars-empty">★★</span>');
  assert.equal(s(4), '★★★★<span class="stars-empty">★</span>');
  assert.equal(s(5), '★★★★★');
  assert.equal(s(0), '');
});

test('no caller sets the stars as HTML', () => {
  const dir = path.join(__dirname, '..', '..', 'app');
  const calls = [];
  for (const f of fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (/ratingStars\(/.test(line) && !/function ratingStars/.test(line)) calls.push([f, line]);
    }
  }
  assert.ok(calls.length >= 2);
  for (const [f, line] of calls) assert.doesNotMatch(line, /dangerouslySetInnerHTML/, f);
});
