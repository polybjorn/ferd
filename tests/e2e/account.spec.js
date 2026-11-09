// Account: changing the password and revoking sessions. A second session is
// a separate API request context signed in as the same account, so the
// browser page stays the one the test drives and the server's view of the
// other session is what the assertions read. Each test signs up its own
// account, since a password change and a revoke act on every session of it.
const { test, expect } = require('@playwright/test');
const { PASSWORD, fence, isPhone, signUp, dialog } = require('./helpers');

const NEW_PASSWORD = 'a-different-password-2';

/** Open Settings on its Account group, from the menu or the You page's sheet. */
async function openAccount(/** @type {import('@playwright/test').Page} */ page, /** @type {boolean} */ phone) {
  if (phone) {
    await page.locator('#bar-you').click();
    await page.locator('#you-gear').click();
    await page.getByRole('button', { name: 'Account', exact: true }).click();
  } else {
    await page.locator('#auth-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Account' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Password' })).toBeVisible();
}

/** Sign in as the account in a request context of its own, as another device. */
async function otherSession(
  /** @type {import('@playwright/test').PlaywrightWorker | any} */ playwright,
  /** @type {string} */ baseURL,
  /** @type {string} */ username,
  /** @type {string} */ password,
  /** @type {string} */ agent,
) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'User-Agent': agent } });
  const res = await ctx.post('/api/login', { data: { username, password } });
  expect(res.ok(), `second login answered ${res.status()}`).toBe(true);
  return ctx;
}

async function authenticated(/** @type {import('@playwright/test').APIRequestContext} */ ctx) {
  return (await (await ctx.get('/api/state')).json()).authenticated;
}

test('changing the password signs out other sessions and keeps this one', async ({ page, baseURL, playwright }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const phone = isPhone(info);
  const username = await signUp(page, info);
  const other = await otherSession(playwright, /** @type {string} */ (baseURL), username, PASSWORD, 'E2E-other-device');
  expect(await authenticated(other)).toBe(true);

  await openAccount(page, phone);
  const current = page.getByLabel('Current password');
  const next = page.getByLabel('New password');
  const submit = page.getByRole('button', { name: 'Change password' });

  // A wrong current password is refused and nothing is signed out.
  await current.fill('not-the-password-1');
  await next.fill(NEW_PASSWORD);
  await submit.click();
  // The error first, so the server has answered before the note's absence counts.
  await expect(page.locator('.form-error.visible .ui-hint-error')).not.toBeEmpty();
  await expect(page.getByText('Password changed')).toBeHidden();
  expect(await authenticated(other), 'a refused change signs nobody out').toBe(true);

  await current.fill(PASSWORD);
  await next.fill(NEW_PASSWORD);
  await submit.click();
  await expect(page.getByText(/Password changed\. Other sessions on this account have been signed out/)).toBeVisible();
  await expect(current).toHaveValue('');
  await expect(next).toHaveValue('');

  expect(await authenticated(other), 'the other session is signed out').toBe(false);
  expect(await authenticated(page.request), 'this session stays signed in').toBe(true);

  // The old password no longer opens a session; the new one does.
  const old = await page.request.post('/api/login', { data: { username, password: PASSWORD } });
  expect(old.ok()).toBe(false);
  const fresh = await playwright.request.newContext({ baseURL });
  const login = await fresh.post('/api/login', { data: { username, password: NEW_PASSWORD } });
  expect(login.ok(), `login with the new password answered ${login.status()}`).toBe(true);

  await other.dispose();
  await fresh.dispose();
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('revoking one session signs that device out and drops its row', async ({ page, baseURL, playwright }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const phone = isPhone(info);
  const username = await signUp(page, info);
  const other = await otherSession(playwright, /** @type {string} */ (baseURL), username, PASSWORD, 'E2E-other-device');

  await openAccount(page, phone);
  await page.getByRole('button', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Active sessions' })).toBeVisible();
  const rows = page.locator('.session-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'This device' })).toHaveCount(1);
  // The current session offers no Revoke button, so one button is the other device's.
  const revoke = page.getByRole('button', { name: 'Revoke', exact: true });
  await expect(revoke).toHaveCount(1);

  await revoke.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('This device');
  expect(await authenticated(other), 'the revoked device is signed out').toBe(false);
  expect(await authenticated(page.request), 'this device is not').toBe(true);

  await other.dispose();
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});

test('signing out others keeps this session after a confirmation', async ({ page, baseURL, playwright }, info) => {
  const fenced = await fence(page, /** @type {string} */ (baseURL));
  const phone = isPhone(info);
  const username = await signUp(page, info);
  const first = await otherSession(playwright, /** @type {string} */ (baseURL), username, PASSWORD, 'E2E-first-device');
  const second = await otherSession(playwright, /** @type {string} */ (baseURL), username, PASSWORD, 'E2E-second-device');

  await openAccount(page, phone);
  await page.getByRole('button', { name: 'Security' }).click();
  await expect(page.locator('.session-row')).toHaveCount(3);

  await page.getByRole('button', { name: 'Sign out others' }).click();
  const confirm = dialog(page);
  await expect(confirm.locator('h2')).toHaveText('Sign out other sessions?');
  // Cancelling leaves every session in place.
  await confirm.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.ui-dialog[open]').filter({ hasText: 'Sign out other sessions?' })).toHaveCount(0);
  expect(await authenticated(first)).toBe(true);

  await page.getByRole('button', { name: 'Sign out others' }).click();
  await dialog(page).getByRole('button', { name: 'Sign out others' }).click();
  await expect(page.locator('.session-row')).toHaveCount(1);
  expect(await authenticated(first)).toBe(false);
  expect(await authenticated(second)).toBe(false);
  expect(await authenticated(page.request)).toBe(true);

  await first.dispose();
  await second.dispose();
  expect(fenced.external).toEqual([]);
  expect(fenced.errors).toEqual([]);
});
