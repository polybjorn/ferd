// Add area: a search result that is a whole country offers to mark the
// country visited instead. Nominatim is answered here, so no test reaches
// OpenStreetMap.
const { test, expect } = require('@playwright/test');
const { fence, signUp } = require('./helpers');

const RING = [[12, 42], [13, 42], [13, 43], [12, 42]];
const ITALY = { type: 'FeatureCollection', features: [{
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [RING] },
  properties: { name: 'Italy', display_name: 'Italy', addresstype: 'country', address: { country_code: 'it' } },
}] };

/** Open the Area tab of the Add dialog and search for Italy. */
async function searchItaly(/** @type {import('@playwright/test').Page} */ page) {
  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await page.locator('#add-tabs [data-tab="area"]').click();
  await page.locator('#a-search').fill('Italy');
  await page.locator('#a-search-go').click();
}

test('a country found in Add area can be marked visited instead', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ json: ITALY }));
  await signUp(page, info);

  await searchItaly(page);
  const offer = page.locator('#a-country-offer');
  await expect(offer).toContainText('Italy is a country');
  await page.locator('#a-country-mark').click();
  await expect(page.locator('#add-tabs')).toBeHidden();

  await searchItaly(page);
  await expect(offer).toContainText('Italy is already marked as visited.');
  await expect(page.locator('#a-country-mark')).toHaveCount(0);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
