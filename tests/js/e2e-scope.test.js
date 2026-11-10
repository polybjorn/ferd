'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../../scripts/e2e-scope.js');

const main = 'refs/heads/main';
const code = ['app/bar-motion.js', 'CHANGELOG.md'];

test('a merge skips a commit that passed on its pull request', () => {
  assert.equal(decide({ event: 'push', ref: main, changed: code, prState: 'success' }).run, false);
});

test('a merge runs when the pull request result is missing, failed or still pending', () => {
  for (const prState of [null, 'failure', 'pending', 'cancelled']) {
    assert.equal(decide({ event: 'push', ref: main, changed: code, prState }).run, true, String(prState));
  }
});

test('a change to Markdown alone skips, on a pull request or a push', () => {
  for (const event of ['pull_request', 'push']) {
    assert.equal(decide({ event, ref: main, changed: ['CHANGELOG.md', 'docs/pwa.md'], prState: null }).run, false);
  }
});

test('any other change, an empty range or an unreadable one runs', () => {
  for (const changed of [code, ['playwright.config.js'], [], null]) {
    assert.equal(decide({ event: 'pull_request', ref: main, changed, prState: null }).run, true, String(changed));
  }
});

test('a tag always runs', () => {
  const ref = 'refs/tags/v2.0.0';
  assert.equal(decide({ event: 'push', ref, changed: ['CHANGELOG.md'], prState: 'success' }).run, true);
});
