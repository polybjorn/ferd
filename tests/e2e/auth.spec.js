// Sign in through the form, and sign out through the account menu (the You
// page's sheet on a phone).
const { test, expect } = require('@playwright/test');
const { USER, PASSWORD, fence, dialog } = require('./helpers');

test('signs in through the form and out through the menu', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await page.goto('/');

  await page.locator('#auth-username').fill(USER);
  await page.locator('#auth-password').fill(PASSWORD);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible();
  await expect(page.locator('.leaflet-container').first()).toBeVisible();

  await page.locator('#auth-menu-btn:visible, #bar-you:visible').click();
  await page.locator('#auth-menu [data-action=signout]:visible, #you-gear:visible').click();
  await page.locator('.account-sheet [data-action=signout]:visible, .ui-dialog h2:has-text("Sign out?")').first().click();
  const confirm = dialog(page);
  await expect(confirm.locator('h2')).toHaveText('Sign out?');
  await confirm.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.locator('#auth-username')).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.authenticated, 'the session is gone on the server too').toBe(false);
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
