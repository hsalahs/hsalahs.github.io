const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

// A weak phone signal can drop one of the page's own script files. The page
// used to open half-working with no message (a dashboard with no invite link,
// a login button that did nothing); now a red bar offers a reload.
const PAGES = [
  ['app.html', 'utils.js'],
  ['event.html?id=e1', 'format.js'],
  ['invite.html?event=e1', 'utils.js'],
  ['scan.html?event=e1', 'icons.js'],
];

for (const [url, dropped] of PAGES) {
  test(`${url.split('?')[0]}: if ${dropped} fails to download, a reload bar appears and reloads the page`, async ({ page }) => {
    await stubFirebase(page);
    await seedFakeFirebase(page, {
      user: { uid: 'u1', email: 'customer@example.com' },
      store: { events: { e1: { name: 'حفل', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
    });
    let drop = true;
    await page.route('**/' + dropped, (route) => (drop ? route.abort() : route.continue()));
    await page.goto('/' + url);
    const bar = page.locator('#load-fail');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('اضغط هنا لإعادة التحميل');
    drop = false;
    await Promise.all([page.waitForEvent('load'), bar.click()]);
    await expect(page.locator('#load-fail')).toHaveCount(0);
  });
}

test('a page whose files all load shows no reload bar', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: {} } });
  await page.goto('/app.html');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#load-fail')).toHaveCount(0);
});
