// A modal closes on Esc and hands focus back to the control that opened it.
// On a phone, the bottom bar navigates and a modal takes its phone layout.
const { test, expect } = require('@playwright/test');
const { fence, signIn, isPhone, dialog } = require('./helpers');

test('a modal closes on Esc and returns focus to its opener', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);

  const opener = page.locator('#map-add-btn:visible, #bar-add:visible');
  await opener.focus();
  await page.keyboard.press('Enter');
  const modal = dialog(page);
  await expect(page.locator('#add-tabs')).toBeVisible();
  // showModal moves focus into the dialog (or onto it, with no autofocus).
  await expect.poll(() => modal.evaluate(el => el.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog[open]')).toHaveCount(0);
  await expect(opener).toBeFocused();

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('the bottom bar navigates between views', async ({ page, baseURL }, info) => {
  test.skip(!isPhone(info), 'the bottom bar is the phone layout');
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signIn(page);

  const current = page.locator('#bottom-bar [aria-current="page"]');
  await expect(current).toHaveId('bar-map');
  // The bar replaces the header tabs, and ui.css's tab display outranks a
  // plain display: none from the app layer.
  await expect(page.locator('.app-nav .nav-tabs')).toBeHidden();

  await page.locator('#bar-lists').click();
  await expect(current).toHaveId('bar-lists');
  await expect(page.locator('.list-tabs')).toBeVisible();
  await expect(page.locator('.leaflet-container')).toHaveCount(0);

  await page.locator('#bar-you').click();
  await expect(current).toHaveId('bar-you');
  await expect(page).toHaveURL(/#\/you$/);
  await expect(page.locator('#you-gear')).toBeVisible();

  await page.locator('#bar-map').click();
  await expect(current).toHaveId('bar-map');
  await expect(page.locator('.leaflet-container').first()).toBeVisible();

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

for (const width of [320, 412]) {
  test(`a modal takes the phone layout at ${width}px`, async ({ page, baseURL }, info) => {
    test.skip(!isPhone(info), 'the phone layout is the phone projects\' concern');
    const fenced = await fence(page, /** @type {string} */ (baseURL));
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);

    await page.locator('#bar-add').click();
    await expect(page.locator('#add-tabs')).toBeVisible();
    const modal = dialog(page);
    await expect(modal).toHaveClass(/\bui-dialog-(sheet|fullscreen|top)\b/);
    // Wait out the open animation before measuring.
    await expect.poll(() => modal.evaluate(el => el.getAnimations().length)).toBe(0);
    const box = await modal.boundingBox();
    expect(box, 'the dialog has a box').not.toBeNull();
    const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (box);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(width + 0.5);
    // Nothing inside the dialog runs wider than the dialog.
    const overflow = await modal.evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow, 'horizontal overflow inside the dialog').toBeLessThanOrEqual(0);

    expect(fenced.external).toEqual([]);
    expect(fenced.errors).toEqual([]);
  });
}
