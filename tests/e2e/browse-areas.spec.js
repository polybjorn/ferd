// Import an area from the area catalog. The list comes from the real server
// and catalog-areas.json; the Overpass fetch behind the import is answered
// here, so no test reaches OpenStreetMap.
const { test, expect } = require('@playwright/test');
const { fence, isPhone, signUp } = require('./helpers');

const JOTUNHEIMEN = 269939;
const GEOMETRY = {
  type: 'Polygon',
  coordinates: [[[8.0, 61.4], [8.9, 61.4], [8.9, 61.8], [8.0, 61.8], [8.0, 61.4]]],
};

test('imports a catalog area through the server', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  /** @type {any[]} */
  const asked = [];
  await page.route('**/api/catalog/areas/geometry', route => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      geometry: GEOMETRY, points: 5, polygons: 1, tolerance_m: 5,
      source: `https://www.openstreetmap.org/relation/${JOTUNHEIMEN}`, credit: 'Area data (c) OpenStreetMap contributors, ODbL',
    } });
  });
  await signUp(page, info);

  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await page.locator('#add-tabs [data-tab="areas"]').click();
  const row = page.locator(`#browse-areas-list [data-relation="${JOTUNHEIMEN}"]`);
  await expect(row).toContainText('Jotunheimen National Park');
  await row.locator('.browse-area-import').click();
  await expect(page.locator('#add-tabs')).toBeHidden();
  expect(asked).toEqual([{ relation: JOTUNHEIMEN }]);

  // The map fits the new area, and on a phone that move tucks the bar away
  // (bar-motion.js) until the map is tapped.
  if (isPhone(info)) {
    await expect(page.locator('body')).toHaveClass(/\bbar-away\b/);
    const map = page.locator('.leaflet-container').first();
    const box = await map.boundingBox();
    if (!box) throw new Error('the map has no box');
    await map.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(page.locator('body')).not.toHaveClass(/\bbar-away\b/);
  }

  // Opened again, the entry says it is already there.
  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await page.locator('#add-tabs [data-tab="areas"]').click();
  await expect(row.locator('.browse-area-import')).toBeDisabled();
  await expect(row.locator('.browse-area-import')).toHaveText('Imported');
  await page.keyboard.press('Escape');
  await expect(page.locator('#add-tabs')).toBeHidden();

  await page.evaluate(() => { location.hash = '#/areas'; });
  await expect(page.locator('.area-card').filter({ hasText: 'Jotunheimen National Park' })).toHaveCount(1);

  expect(fenced.external).toEqual([]);
});
