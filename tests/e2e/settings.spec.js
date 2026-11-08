// Settings: a radio preference is still set after a reload, and a theme
// picked in Appearance applies to the page at once and after a reload.
// Both preferences sync to the account, so each test signs up its own.
const { test, expect } = require('@playwright/test');
const { fence, signUp } = require('./helpers');

/** Open Settings on its General tab, from the menu or the You page's sheet. */
async function openSettings(/** @type {import('@playwright/test').Page} */ page) {
  await page.locator('#auth-menu-btn:visible, #bar-you:visible').click();
  await page.locator('#auth-menu [data-action=settings]:visible, #you-gear:visible').click();
  await page.locator('.account-sheet [data-action=settings]:visible, #settings-tabs [aria-pressed="true"]').first().click();
  await expect(page.locator('#settings-tabs [data-tab="general"]')).toHaveAttribute('aria-pressed', 'true');
}

test('a radio preference survives a reload', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signUp(page, info);

  await openSettings(page);
  const imperial = page.getByRole('radio', { name: 'Imperial' });
  await expect(imperial).not.toBeChecked();
  await imperial.check();
  await expect(imperial).toBeChecked();

  await page.reload();
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible();
  await openSettings(page);
  await expect(page.getByRole('radio', { name: 'Imperial' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Metric' })).not.toBeChecked();

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a theme switch applies at once and after a reload', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signUp(page, info);
  const root = page.locator('html');
  const theme = 'dracula';

  await openSettings(page);
  await page.locator('#settings-tabs [data-tab="appearance"]').click();
  await expect(page.locator('#settings-tabs [data-tab="appearance"]')).toHaveAttribute('aria-pressed', 'true');
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await background();
  await expect(root).not.toHaveAttribute('data-theme', theme);
  await page.locator('#s-theme').selectOption(theme, { force: true });
  await expect(root).toHaveAttribute('data-theme', theme);
  await expect.poll(background).not.toBe(before);

  await page.reload();
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', theme);

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a language switch redraws open views at once and survives a reload', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await signUp(page, info);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('lang', 'en');

  await openSettings(page);
  await page.locator('#s-language').selectOption('nb', { force: true });
  await expect(root).toHaveAttribute('lang', 'nb');
  await expect(page.locator('#settings-tabs [data-tab="general"]')).toHaveText('Generelt');
  await expect(page.getByRole('heading', { name: 'Språk' })).toBeVisible();
  // The English heading is gone, and no key shows in place of its text.
  await expect(page.getByRole('heading', { name: 'Language' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('settings.general.');

  await page.reload();
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible();
  await expect(root).toHaveAttribute('lang', 'nb');

  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
