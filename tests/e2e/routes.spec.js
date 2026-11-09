// Import a GPX route through the Add dialog, open its detail page from the
// Routes list, and check the elevation graph draws.
const { test, expect } = require('@playwright/test');
const { fence, isPhone, signUp, dialog } = require('./helpers');

/**
 * A short climb, as one track per entry in `tracks` (each a track name), and
 * with an elevation on every point unless `ele` is false.
 */
function gpx(/** @type {string[]} */ tracks, ele = true) {
  const trk = (/** @type {string} */ name, /** @type {number} */ t) => {
    const points = Array.from({ length: 20 }, (_, i) => {
      const lat = (46.46 + (t * 20 + i) * 0.002).toFixed(4);
      const lon = (9.80 + (t * 20 + i) * 0.001).toFixed(4);
      return `<trkpt lat="${lat}" lon="${lon}">${ele ? `<ele>${400 + (t * 20 + i) * 15}</ele>` : ''}</trkpt>`;
    });
    const xmlName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<trk><name>${xmlName}</name><trkseg>${points.join('')}</trkseg></trk>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ferd-e2e" xmlns="http://www.topografix.com/GPX/1/1">
  ${tracks.map(trk).join('\n  ')}
</gpx>
`;
}

/**
 * Import a route through the Add dialog and open its detail page from the
 * Routes list.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} name
 * @param {string} text the GPX
 */
async function importAndOpen(page, info, name, text) {
  await page.locator('#map-add-btn:visible, #bar-add:visible').click();
  await page.locator('#add-tabs [data-tab="route"]').click();
  await expect(page.locator('#add-tabs [data-tab="route"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#g-name').fill(name);
  await page.locator('#gpx-form input[type=file]').setInputFiles({
    name: 'e2e-route.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(text),
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
}

/** Delete the open route through the edit dialog, so the list stays the size it was. */
async function deleteOpenRoute(/** @type {import('@playwright/test').Page} */ page) {
  await page.locator('#route-edit-btn').click();
  const edit = dialog(page);
  await expect(edit.locator('h2')).toHaveText('Edit route');
  await edit.getByRole('button', { name: 'Delete' }).click();
  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);
}

test('imports a GPX route and draws its elevation graph', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const name = 'E2E route';
  await signUp(page, info);
  await importAndOpen(page, info, name, gpx([name]));

  // The detail page: the elevation graph draws a filled area from the track.
  const graph = page.locator('#elevation-container');
  await expect(graph).toBeVisible();
  await expect(graph.locator('svg path.area')).toHaveAttribute('d', /\d/);
  const stats = page.locator('#single-elev-stats');
  await expect(stats.locator('.seg-dist')).toHaveText(/\d/);
  await expect(stats.locator('.seg-gain')).toHaveText(/^\+\d/);

  // The title collapses the graph, and the expand control hides it all.
  const title = page.locator('#single-elev-title');
  await expect(title).toHaveAttribute('title', 'Show or hide the graph');
  await title.click();
  await expect(graph).toHaveClass(/collapsed/);
  await title.click();
  await expect(graph).not.toHaveClass(/collapsed/);
  const expand = page.locator('.map-expand-btn');
  await expect(expand).toHaveAttribute('aria-label', 'Expand map');
  await expect(expand.locator('svg')).toHaveCount(2);
  await expand.click();
  await expect(page.locator('.detail-layout')).toHaveClass(/map-expanded/);
  await expect(expand).toHaveAttribute('aria-label', 'Collapse map');
  await expand.click();
  await expect(expand).toHaveAttribute('aria-label', 'Expand map');

  await deleteOpenRoute(page);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a route without elevation data shows its length and no graph', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const name = 'E2E flat route';
  await signUp(page, info);
  await importAndOpen(page, info, name, gpx([name], false));

  await expect(page.locator('.no-elevation-notice')).toHaveText('No elevation data available for this route');
  await expect(page.locator('#elevation-container')).toHaveCount(0);
  const stats = page.locator('#single-elev-stats');
  await expect(stats.locator('.seg-dist')).toHaveText(/\d/);
  await expect(stats.locator('.seg-gain')).toHaveCount(0);
  await expect(page.locator('.route-meta-line')).toContainText('Planned');

  await deleteOpenRoute(page);
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a route of several tracks graphs each segment on request', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const name = 'E2E segmented route';
  await signUp(page, info);
  await importAndOpen(page, info, name, gpx(['01: First leg', 'Second leg <b>']));

  const toggle = page.locator('#elev-seg-toggle');
  await expect(toggle.locator('.elev-toggle-label')).toHaveText('Elevation by segment (2)');
  const title = page.locator('#detail-elev-title-text');
  await expect(title).toHaveText('Whole route');
  await expect(page.locator('#detail-elev-graph svg path.area')).toHaveAttribute('d', /\d/);
  const totals = page.locator('#elev-toggle-stats');
  await expect(totals).toHaveClass(/active/);
  await expect(totals.locator('.seg-gain')).toHaveText(/^\+\d/);

  const list = page.locator('#elev-seg-list');
  await expect(list).toHaveClass(/collapsed/);
  await toggle.locator('.elev-toggle-label').click();
  await expect(list).not.toHaveClass(/collapsed/);
  const rows = list.locator('.seg-row');
  await expect(rows).toHaveCount(2);
  // A leading number moves to the # column; a name without one is numbered.
  await expect(rows.nth(0).locator('.seg-num')).toHaveText('01');
  await expect(rows.nth(0).locator('.seg-name')).toHaveText('First leg');
  await expect(rows.nth(1).locator('.seg-num')).toHaveText('2');
  await expect(rows.nth(1).locator('.seg-name')).toHaveText('Second leg <b>');

  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveClass(/active/);
  await expect(totals).not.toHaveClass(/active/);
  await expect(title).toHaveText('Second leg <b>');
  await rows.nth(1).click();
  await expect(rows.nth(1)).not.toHaveClass(/active/);
  await expect(title).toHaveText('Whole route');
  await rows.nth(0).click();
  await expect(title).toHaveText('01: First leg');
  await totals.click();
  await expect(title).toHaveText('Whole route');
  await expect(totals).toHaveClass(/active/);

  await deleteOpenRoute(page);
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

// The route page and the elevation plugin load on first use, so this proves
// the worker's precache covers them: a deep link opened cold and offline
// still draws the graph.
test.describe('with the service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  test('a route page reloads on its link, also offline, and draws its elevation graph', async ({ page, context }, info) => {
    const name = 'E2E offline route';
    await signUp(page, info);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await importAndOpen(page, info, name, gpx([name]));
    const graph = page.locator('#elevation-container');
    await expect(graph.locator('svg path.area')).toHaveAttribute('d', /\d/);
    const link = new URL(page.url()).hash;
    expect(link).toMatch(/^#\/routes\/route\//);

    await page.reload();
    await expect(graph.locator('svg path.area')).toHaveAttribute('d', /\d/);

    await context.setOffline(true);
    await page.reload();
    expect(new URL(page.url()).hash).toBe(link);
    await expect(graph.locator('svg path.area')).toHaveAttribute('d', /\d/);
    await context.setOffline(false);

    await deleteOpenRoute(page);
  });
});
