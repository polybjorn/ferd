// The add dialog loads on first use. Two quick clicks on its opener while that
// import is in flight must open one dialog, not two.
const { test, expect } = require('@playwright/test');
const { fence, signIn } = require('./helpers');

test('a double click on Add while the module loads opens one dialog', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);

  // Widen the window: the module answers only after both clicks have landed.
  await page.route('**/app/add/add.js', async route => {
    await new Promise(r => setTimeout(r, 800));
    await route.fallback();
  });
  const opener = page.locator('#map-add-btn:visible, #bar-add:visible');
  await opener.click();
  await opener.click();
  await expect(page.locator('#add-tabs')).toBeVisible();
  // A second dialog would open right after the first.
  await page.waitForTimeout(500);
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(1);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
