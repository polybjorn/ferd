// Import a route from the route catalog. The list comes from the real server
// and catalog-routes.json; the Overpass fetch behind the import is answered
// here, so no test reaches OpenStreetMap.
const { test, expect } = require('@playwright/test');
const { fence, isPhone, signUp } = require('./helpers');

const WHW = 16287;
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Ferd">
  <metadata><name>West Highland Way</name><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/1-0/</license></copyright></metadata>
  <trk><name>West Highland Way</name><trkseg>
    <trkpt lat="55.94100" lon="-4.31700"/><trkpt lat="56.10000" lon="-4.50000"/><trkpt lat="56.81900" lon="-5.10500"/>
  </trkseg></trk>
</gpx>
`;

test('imports a catalog route through the server', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  /** @type {any[]} */
  const asked = [];
  await page.route('**/api/catalog/routes/gpx', route => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      gpx: GPX, points: 3, segments: 1, tolerance_m: 5,
      source: `https://www.openstreetmap.org/relation/${WHW}`, credit: 'Route data (c) OpenStreetMap contributors, ODbL',
    } });
  });
  await signUp(page, info);

  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await page.locator('#add-tabs [data-tab="routes"]').click();
  const row = page.locator(`#browse-routes-list [data-relation="${WHW}"]`);
  await expect(row).toContainText('West Highland Way');
  await row.locator('.browse-route-import').click();
  await expect(page.locator('#add-tabs')).toBeHidden();
  expect(asked).toEqual([{ relation: WHW }]);

  if (isPhone(info)) {
    await page.locator('#bar-lists').click();
    await page.locator('.list-tab[href="#/routes"]').click();
  } else {
    await page.locator('#tab-routes').click();
  }
  await page.locator('#search-input').fill('West Highland Way');
  await expect(page.locator('.route-card').filter({ hasText: 'West Highland Way' })).toHaveCount(1);

  // Opened again from the Routes list, the entry says it is already there.
  await page.locator('#add-route-btn:visible, #bar-add:visible').click();
  await page.locator('#add-tabs [data-tab="routes"]').click();
  await expect(row.locator('.browse-route-import')).toBeDisabled();
  await expect(row.locator('.browse-route-import')).toHaveText('Imported');

  expect(fenced.external).toEqual([]);
});
