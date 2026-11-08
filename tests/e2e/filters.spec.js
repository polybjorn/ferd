// The map's filter panel (its Places and Routes tabs and a category toggle),
// the phone's Filters sheet in its place, and a list page's filter popover
// with "Clear filters".
const { test, expect } = require('@playwright/test');
const { fence, signIn, isPhone, dialog } = require('./helpers');

test('the map filter panel switches tabs and toggles a category', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);
  test.skip(isPhone(info), 'a phone has the Filters sheet instead, tested below');

  const placesHead = page.locator('.panel-head[aria-controls="places-section"]');
  const routesHead = page.locator('.panel-head[aria-controls="routes-section"]');
  await placesHead.click();
  await expect(placesHead).toHaveAttribute('aria-expanded', 'true');
  const castle = page.locator('#places-body .legend-item[data-cat="castle"]');
  await expect(castle).toBeVisible();

  await routesHead.click();
  await expect(routesHead).toHaveAttribute('aria-expanded', 'true');
  await expect(placesHead).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#routes-body .legend-item[data-region]').first()).toBeVisible();

  await placesHead.click();
  await castle.click();
  await expect(castle).toHaveClass(/\bdisabled\b/);
  await castle.click();
  await expect(castle).not.toHaveClass(/\bdisabled\b/);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('the phone Filters sheet toggles a category and resets', async ({ page, baseURL }, info) => {
  test.skip(!isPhone(info), 'the sheet is the phone layout');
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);

  await page.locator('#map-filter-btn').click();
  const sheet = dialog(page);
  await expect(sheet.locator('h2')).toHaveText('Filters');
  const places = sheet.getByRole('region', { name: /^Places/ });
  const allShown = /(\d+) of \1 shown/;
  await expect(places).toContainText(allShown);
  const castles = places.getByRole('button', { name: 'Castles' });
  await expect(castles).toHaveAttribute('aria-pressed', 'true');
  const reset = sheet.getByRole('button', { name: 'Reset' });
  await expect(reset).toBeDisabled();

  await castles.click();
  await expect(castles).toHaveAttribute('aria-pressed', 'false');
  await expect(places).not.toContainText(allShown);
  await expect(reset).toBeEnabled();

  await reset.click();
  await expect(castles).toHaveAttribute('aria-pressed', 'true');
  await expect(places).toContainText(allShown);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a list filter narrows the list and "Clear filters" restores it', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  // Straight to the list: getting there is the navigation tests' business.
  await signIn(page, '#/places');

  const cards = page.locator('.place-card');
  await expect(cards.first()).toBeVisible();
  const all = await cards.count();

  await page.locator('#filter-btn').click();
  await expect(page.locator('#filter-popover')).toBeVisible();
  await page.locator('#filter-category').selectOption('castle', { force: true });
  await expect(page.locator('#filter-btn')).toHaveClass(/\bhas-active\b/);
  await expect(cards.first()).toBeVisible();
  const castles = await cards.count();
  expect(castles).toBeLessThan(all);
  await expect(page.locator('#result-count')).toHaveText(String(castles));

  await page.locator('#filter-clear').click();
  await expect(page.locator('#filter-btn')).not.toHaveClass(/\bhas-active\b/);
  await expect(cards).toHaveCount(all);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

// Typing right after the list mounts re-renders its sections while their fade-in
// runs, the case that left a section's cards hidden in WebKit (see
// .category-group.fade-in in app.css), so this takes no wait for the fade.
test('searching while the list is still fading in keeps the match visible', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page, '#/places');

  await expect(page.locator('.place-card').first()).toBeVisible();
  await page.locator('#search-input').fill('castle');
  await expect(page.locator('#result-count')).toHaveText('1');
  await expect(page.locator('.place-card').first()).toBeVisible();

  expect(fenced.errors).toEqual([]);
});
