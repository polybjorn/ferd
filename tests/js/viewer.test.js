'use strict';
// Runs the viewer-mode detection straight out of the app modules, between the
// VIEWER markers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
const m = /VIEWER-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ VIEWER-END/.exec(app);
assert.ok(m, 'VIEWER markers not found in app/');
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
