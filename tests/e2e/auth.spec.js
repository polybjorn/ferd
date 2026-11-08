// Sign in through the form, and sign out through the account menu (the You
// page's sheet on a phone).
const { test, expect } = require('@playwright/test');
const { USER, PASSWORD, fence, isPhone, dialog } = require('./helpers');

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

test('registers through the form and shows the new name', async ({ page, baseURL }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await page.goto('/');

  const username = `e2e-reg-${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.locator('#auth-tabs [data-mode=register]').click();
  await expect(page.locator('#auth-submit')).toHaveText('Register');
  await expect(page.locator('#auth-hint')).toBeVisible();
  await expect(page.locator('#auth-password')).toHaveAttribute('autocomplete', 'new-password');
  await page.locator('#auth-username').fill(username);
  await page.locator('#auth-password').fill(PASSWORD);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-menu-btn:visible, #bar-add:visible')).toBeVisible();

  if (isPhone(info)) {
    await page.locator('#bar-you').click();
    await expect(page.locator('.you-name strong')).toHaveText(username);
  } else {
    await page.locator('#auth-menu-btn').click();
    await expect(page.locator('#auth-menu-head')).toHaveText(`Signed in as ${username}`);
    await expect(page.locator('#auth-menu-head strong')).toHaveText(username);
  }
  const state = await (await page.request.get('/api/state')).json();
  expect(state.username).toBe(username);
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('a failed sign-in shows the error and leaves the form usable', async ({ page, baseURL }) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  await page.goto('/');
  await page.locator('#auth-username').fill('e2e-no-such-user');
  await page.locator('#auth-password').fill('not-the-password');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-error')).toBeVisible();
  await expect(page.locator('#auth-submit')).toBeEnabled();
  expect(fenced.errors).toEqual([]);
});
