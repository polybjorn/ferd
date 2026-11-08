'use strict';
// ratingStarsText returns markup, so a caller that drops it into a template
// as a child prints the tags as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
const m = /function ratingStarsText[\s\S]*?\n}/.exec(app);
assert.ok(m, 'ratingStarsText not found in app/');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[0] + '\nglobalThis.__stars = ratingStarsText;', ctx);

test('a partial rating fades the empty stars', () => {
  assert.equal(ctx.__stars(3), '★★★<span class="stars-empty">★★</span>');
  assert.equal(ctx.__stars(5), '★★★★★');
  assert.equal(ctx.__stars(0), '');
});

test('every caller sets the stars as HTML', () => {
  const dir = path.join(__dirname, '..', '..', 'app');
  const calls = [];
  for (const f of fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (/ratingStarsText\(/.test(line) && !/function ratingStarsText/.test(line)) calls.push([f, line]);
    }
  }
  assert.ok(calls.length >= 2);
  for (const [f, line] of calls) assert.match(line, /dangerouslySetInnerHTML/, f);
});
