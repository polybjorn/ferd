'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { grade } = require('../../scripts/lighthouse-gate.js');

const HOME = 'http://127.0.0.1:1/';
const MAP = 'http://127.0.0.1:1/u/demo';
const full = { accessibility: 100, 'best-practices': 100, seo: 100, performance: 60 };
const page = (scores = full, findings = []) => ({
  findings,
  lighthouse: { mobile: { scores, failed: [] }, desktop: { scores: full, failed: [] } },
});

test('passes when every page holds 100 and has nothing else to report', () => {
  const r = grade({ pages: { [HOME]: page(), [MAP]: page() } }, [HOME, MAP]);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.notes, []);
});

test('any other finding fails, on a named page or on one the crawl found', () => {
  const OTHER = 'http://127.0.0.1:1/robots.txt';
  const r = grade({ pages: {
    [HOME]: page(),
    [MAP]: page(full, [{ kind: 'structure', detail: 'no h1' }]),
    [OTHER]: { findings: [{ kind: 'crawl', detail: 'a missing address answers 200, needs 404' }], lighthouse: null },
  } }, [HOME, MAP]);
  assert.deepEqual(r.failures, [`${MAP}: structure: no h1`, `${OTHER}: crawl: a missing address answers 200, needs 404`]);
});

test('a line to check by eye is a note, not a failure', () => {
  const r = grade({ pages: { [HOME]: page(full, [{ kind: 'check by eye', detail: 'focus moves up the page: a then b' }]) } }, [HOME]);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.notes, [`${HOME}: focus moves up the page: a then b`]);
});

test('fails a category under its floor and names the audit', () => {
  const report = { pages: { [HOME]: page() } };
  report.pages[HOME].lighthouse.mobile = { scores: { ...full, seo: 92 }, failed: ['seo: Document has a meta description'] };
  const r = grade(report, [HOME]);
  assert.deepEqual(r.failures, [`${HOME}: seo 92 on mobile, needs 100: Document has a meta description`]);
});

test('performance has no floor', () => {
  assert.deepEqual(grade({ pages: { [HOME]: page({ ...full, performance: 10 }) } }, [HOME]).failures, []);
});

test('a page, a form or a score that is missing fails rather than passes', () => {
  assert.deepEqual(grade({ pages: {} }, [HOME]).failures, [`${HOME}: not in the report`]);
  assert.deepEqual(grade({ pages: { [HOME]: { findings: [], lighthouse: null } } }, [HOME]).failures,
    [`${HOME}: no Lighthouse result on mobile`, `${HOME}: no Lighthouse result on desktop`]);
  const noSeo = { ...full };
  delete noSeo.seo;
  assert.deepEqual(grade({ pages: { [HOME]: page(noSeo) } }, [HOME]).failures, [`${HOME}: no seo score on mobile`]);
});

test('a failed Lighthouse run is a failure and the scores line is not a note', () => {
  const r = grade({ pages: { [HOME]: page(full, [
    { kind: 'lighthouse scores', detail: 'mobile accessibility 100' },
    { kind: 'lighthouse', detail: 'desktop run failed: tab lost' },
  ]) } }, [HOME]);
  assert.deepEqual(r.failures, [`${HOME}: desktop run failed: tab lost`]);
  assert.deepEqual(r.notes, []);
});
