// Import a GPX route through the Add dialog, open its detail page from the
// Routes list, and check the elevation graph draws.
const { test, expect } = require('@playwright/test');
const { fence, isPhone, signUp, dialog } = require('./helpers');

/** A short climb with an elevation on every point, so the graph has data. */
function gpx(/** @type {string} */ name) {
  const points = Array.from({ length: 20 }, (_, i) =>
    `<trkpt lat="${(46.46 + i * 0.002).toFixed(4)}" lon="${(9.80 + i * 0.001).toFixed(4)}"><ele>${400 + i * 15}</ele></trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ferd-e2e" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name}</name><trkseg>${points.join('')}</trkseg></trk>
</gpx>
`;
}

test('imports a GPX route and draws its elevation graph', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const name = 'E2E route';
  await signUp(page, info);

  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await page.locator('#add-tabs [data-tab="route"]').click();
  await expect(page.locator('#add-tabs [data-tab="route"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#g-name').fill(name);
  await page.locator('#gpx-form input[type=file]').setInputFiles({
    name: 'e2e-route.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx(name)),
  });
  await page.locator('#gpx-submit').click();
  await expect(page.locator('#add-tabs')).toBeHidden();

  if (isPhone(info)) {
    await page.locator('#bar-lists').click();
    await page.locator('.list-tab[href="#/routes"]').click();
  } else {
    await page.locator('#tab-routes').click();
  }
  await page.locator('#search-input').fill(name);
  const card = page.locator('.route-card').filter({ hasText: name });
  await expect(card).toHaveCount(1);
  await card.click();

  // The detail page: the elevation graph draws a filled area from the track.
  const graph = page.locator('#elevation-container');
  await expect(graph).toBeVisible();
  await expect(graph.locator('svg path.area')).toHaveAttribute('d', /\d/);
  await expect(page.locator('#single-elev-stats').first()).not.toBeEmpty();

  // Clean up through the edit dialog, so the list stays the size it was.
  await page.locator('#route-edit-btn').click();
  const edit = dialog(page);
  await expect(edit.locator('h2')).toHaveText('Edit route');
  await edit.getByRole('button', { name: 'Delete' }).click();
  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
