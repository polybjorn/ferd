'use strict';
// Runs the viewer-mode detection straight out of index.html, between the
// VIEWER markers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const m = /VIEWER-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ VIEWER-END/.exec(html);
assert.ok(m, 'VIEWER markers not found in index.html');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[1] + '\nglobalThis.__viewerOf = viewerOf;', ctx);
const viewerOf = p => JSON.parse(JSON.stringify(ctx.__viewerOf(p)));

test('a /u/<name>/ path is a public view', () => {
  assert.deepEqual(viewerOf('/u/demo/'), { mode: 'public', username: 'demo' });
  assert.deepEqual(viewerOf('/u/demo'), { mode: 'public', username: 'demo' });
});

test('a doubled leading slash is still a public view', () => {
  assert.deepEqual(viewerOf('//u/demo/'), { mode: 'public', username: 'demo' });
});

test('other paths are the owner view', () => {
  for (const p of ['/', '/index.html', '', '/user/demo/', '/x/u/demo/', '/u/']) {
    assert.deepEqual(viewerOf(p), { mode: 'owner', username: null }, p);
  }
});
