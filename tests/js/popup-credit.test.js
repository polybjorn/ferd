'use strict';
// The place popup shows an image's credit under it, linked to the Commons
// file page when the image is a Commons upload.
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPopupViews } = require('./popup-views');

async function placePopup(place) {
  const r = await loadPopupViews({
    state: { viewer: { mode: 'public' }, auth: {}, categoryColors: {}, categoryColorsLight: {} },
    getShowField: () => true,
    displayCategory: s => String(s),
    displayRegion: s => String(s),
    canEditPopup: () => false,
  });
  return r.place(Object.assign({ name: 'Rome', category: 'city', visited: false }, place));
}

const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/1280px-Colosseo_2020.jpg';

test('a Commons image credit links to its file page', async () => {
  const out = await placePopup({ image: THUMB, image_credit: 'Jane Doe, CC BY-SA 4.0' });
  assert.match(out, /class="popup-credit"/);
  assert.ok(out.includes('href="https://commons.wikimedia.org/wiki/File:Colosseo_2020.jpg"'));
  assert.ok(out.includes('Jane Doe, CC BY-SA 4.0'));
});

test('a credit for a non-Commons image is plain text', async () => {
  const out = await placePopup({ image: 'https://example.org/rome.jpg', image_credit: 'Jane Doe, CC BY 4.0' });
  assert.match(out, /<div class="popup-credit">Jane Doe, CC BY 4.0<\/div>/);
});

test('no credit line without a credit or without an image', async () => {
  assert.doesNotMatch(await placePopup({ image: THUMB }), /popup-credit/);
  assert.doesNotMatch(await placePopup({ image_credit: 'Jane Doe, CC0' }), /popup-credit/);
});
